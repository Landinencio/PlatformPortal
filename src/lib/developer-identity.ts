const UNKNOWN_EMAIL = "unknown@unknown.local";

export type DeveloperIdentityInput = {
    email?: string | null;
    name?: string | null;
    team?: string | null;
    teams?: string[] | null;
    projectId?: number | string | null;
    projectIds?: Array<number | string> | null;
    commits?: number | string | null;
    linesAdded?: number | string | null;
    linesRemoved?: number | string | null;
    mrsOpened?: number | string | null;
    mrsMerged?: number | string | null;
    reviewsGiven?: number | string | null;
    firstActivity?: string | Date | null;
    lastActivity?: string | Date | null;
};

export type MergedDeveloperIdentity = {
    canonicalKey: string;
    email: string;
    name: string;
    allEmails: string[];
    teams: string[];
    commits: number;
    linesAdded: number;
    linesRemoved: number;
    mrsOpened: number;
    mrsMerged: number;
    reviewsGiven: number;
    projectsActive: number;
    firstActivity: string | null;
    lastActivity: string | null;
};

type IdentitySignals = {
    email: string;
    name: string;
    localPart: string;
    isUnknownEmail: boolean;
    compacts: Set<string>;
    tokens: Set<string>;
};

type IdentityBucket = {
    key: string;
    emails: Set<string>;
    teams: Set<string>;
    projectIds: Set<number>;
    compacts: Set<string>;
    tokens: Set<string>;
    commits: number;
    linesAdded: number;
    linesRemoved: number;
    mrsOpened: number;
    mrsMerged: number;
    reviewsGiven: number;
    firstActivity: Date | null;
    lastActivity: Date | null;
    preferredEmail: string;
    preferredEmailScore: number;
    preferredName: string;
    preferredNameScore: number;
    hasUnknownEmail: boolean;
};

const normalizeBase = (value: string): string =>
    value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim();

const compactValue = (value: string): string => normalizeBase(value).replace(/[^a-z0-9]/g, "");

const tokenizeValue = (value: string): string[] => {
    const normalized = normalizeBase(value).replace(/[^a-z0-9._\-\s]/g, " ");
    return normalized
        .split(/[._\-\s]+/)
        .map((part) => part.trim())
        .filter((part) => part.length >= 3);
};

const numberValue = (value: number | string | null | undefined): number => {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
};

const parseDate = (value: string | Date | null | undefined): Date | null => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

const sanitizeEmail = (value: string | null | undefined): string => {
    const raw = (value || "").trim().toLowerCase();
    if (!raw) return UNKNOWN_EMAIL;
    if (raw.includes("@")) return raw;
    return `${raw}@unknown.local`;
};

const localPart = (email: string): string => email.split("@")[0] || "unknown";
const emailDomain = (email: string): string => email.split("@")[1] || "";

const nameScore = (name: string): number => {
    const normalized = normalizeBase(name);
    if (!normalized || normalized === "unknown") return 0;
    if (/\s/.test(name)) return 4;
    if (/[._-]/.test(name)) return 3;
    if (name.length >= 6) return 2;
    return 1;
};

const emailScore = (email: string): number => {
    const domain = emailDomain(email);
    if (!domain || domain === "unknown.local") return 1;
    return 3;
};

const buildSignals = (input: DeveloperIdentityInput): IdentitySignals => {
    const email = sanitizeEmail(input.email);
    const local = localPart(email);
    const fallbackName = (input.name || "").trim() || local;
    const compacts = new Set<string>([compactValue(local), compactValue(fallbackName)]);
    compacts.delete("");

    const tokens = new Set<string>([
        ...tokenizeValue(local),
        ...tokenizeValue(fallbackName),
    ]);

    return {
        email,
        name: fallbackName,
        localPart: local,
        isUnknownEmail: emailDomain(email) === "unknown.local",
        compacts,
        tokens,
    };
};

const overlapCount = (a: Set<string>, b: Set<string>): number => {
    let count = 0;
    for (const value of a) {
        if (b.has(value)) count += 1;
    }
    return count;
};

const hasLongPrefixMatch = (candidateCompacts: Set<string>, bucketCompacts: Set<string>): boolean => {
    for (const left of candidateCompacts) {
        if (left.length < 8) continue;
        for (const right of bucketCompacts) {
            if (right.length < 8) continue;
            if (left.startsWith(right) || right.startsWith(left)) {
                return true;
            }
        }
    }
    return false;
};

const tokenSetContainedInCompacts = (tokens: Set<string>, compacts: Set<string>): boolean => {
    const list = [...tokens].filter((token) => token.length >= 3);
    if (list.length < 2) return false;
    return list.every((token) => {
        for (const compact of compacts) {
            if (compact.includes(token)) {
                return true;
            }
        }
        return false;
    });
};

const shouldMerge = (signals: IdentitySignals, bucket: IdentityBucket): boolean => {
    // Guard: If both have real corporate emails with DIFFERENT local parts,
    // require email-based evidence (not just name matching).
    // This prevents merging "Álvaro García <alvaro.garcia@corp.com>" with
    // "Álvaro García <facundo.arenas@corp.com>" — clearly different people
    // who happen to share a display name (misconfiguration).
    const bothHaveRealEmails = !signals.isUnknownEmail && !bucket.hasUnknownEmail;
    const localPartsMatch = bucket.emails.has(signals.email) ||
        [...bucket.emails].some((e) => localPart(e) === signals.localPart);

    if (bothHaveRealEmails && !localPartsMatch) {
        // Only allow merge if the email local part matches a bucket email local part.
        // Name-only matches are NOT sufficient when emails clearly differ.
        return false;
    }

    // Rule 1: Exact compact match (e.g. "pablocarabantes" === "pablocarabantes")
    for (const compact of signals.compacts) {
        if (bucket.compacts.has(compact)) {
            return true;
        }
    }

    // Rule 2: Long prefix match (8+ chars, e.g. "pablocarab..." matches "pablocarabantes")
    if (hasLongPrefixMatch(signals.compacts, bucket.compacts)) {
        return true;
    }

    // Rule 3: 3+ shared tokens (raised from 2 to avoid merging common first names)
    const sharedTokens = overlapCount(signals.tokens, bucket.tokens);
    if (sharedTokens >= 3) {
        return true;
    }

    // Rule 4: Exactly 2 shared tokens, but ONLY if neither is a very common first name
    if (sharedTokens === 2) {
        const shared = [...signals.tokens].filter((t) => bucket.tokens.has(t));
        const allSubstantive = shared.every((t) => t.length >= 5);
        if (allSubstantive) return true;
    }

    // Rule 5: All tokens contained in a compact (e.g. tokens ["pablo","carabantes"] in compact "pablocarabantes")
    if (tokenSetContainedInCompacts(signals.tokens, bucket.compacts)) {
        return true;
    }
    if (tokenSetContainedInCompacts(bucket.tokens, signals.compacts)) {
        return true;
    }

    // Rule 6: Same email local part with unknown domain
    // Only merge unknown emails if the LOCAL PART matches exactly (not just shared tokens)
    if (signals.isUnknownEmail || bucket.hasUnknownEmail) {
        const signalLocal = signals.localPart;
        for (const bucketEmail of bucket.emails) {
            if (localPart(bucketEmail) === signalLocal) {
                return true;
            }
        }
    }

    return false;
};

const betterEmail = (current: { value: string; score: number }, nextEmail: string) => {
    const nextScore = emailScore(nextEmail);
    if (nextScore > current.score) {
        return { value: nextEmail, score: nextScore };
    }
    if (nextScore === current.score && nextEmail.length < current.value.length) {
        return { value: nextEmail, score: nextScore };
    }
    return current;
};

const betterName = (current: { value: string; score: number }, nextName: string) => {
    const nextScore = nameScore(nextName);
    if (nextScore > current.score) {
        return { value: nextName, score: nextScore };
    }
    if (nextScore === current.score && nextName.length < current.value.length) {
        return { value: nextName, score: nextScore };
    }
    return current;
};

export function mergeDevelopersByIdentity(rows: DeveloperIdentityInput[]): MergedDeveloperIdentity[] {
    const buckets: IdentityBucket[] = [];

    const ordered = [...rows].sort((a, b) => {
        const aSignals = buildSignals(a);
        const bSignals = buildSignals(b);
        const aQuality = emailScore(aSignals.email);
        const bQuality = emailScore(bSignals.email);
        if (aQuality !== bQuality) return bQuality - aQuality;
        return numberValue(b.commits) - numberValue(a.commits);
    });

    for (const row of ordered) {
        const signals = buildSignals(row);
        let bucket = buckets.find((entry) => shouldMerge(signals, entry));

        if (!bucket) {
            const initialEmail = signals.email;
            const initialName = signals.name || signals.localPart;
            bucket = {
                key: [...signals.compacts][0] || compactValue(initialName) || "unknown",
                emails: new Set<string>(),
                teams: new Set<string>(),
                projectIds: new Set<number>(),
                compacts: new Set<string>(),
                tokens: new Set<string>(),
                commits: 0,
                linesAdded: 0,
                linesRemoved: 0,
                mrsOpened: 0,
                mrsMerged: 0,
                reviewsGiven: 0,
                firstActivity: null,
                lastActivity: null,
                preferredEmail: initialEmail,
                preferredEmailScore: emailScore(initialEmail),
                preferredName: initialName,
                preferredNameScore: nameScore(initialName),
                hasUnknownEmail: signals.isUnknownEmail,
            };
            buckets.push(bucket);
        }

        bucket.emails.add(signals.email);
        bucket.hasUnknownEmail = bucket.hasUnknownEmail || signals.isUnknownEmail;
        for (const compact of signals.compacts) bucket.compacts.add(compact);
        for (const token of signals.tokens) bucket.tokens.add(token);

        const nextEmail = betterEmail(
            { value: bucket.preferredEmail, score: bucket.preferredEmailScore },
            signals.email
        );
        bucket.preferredEmail = nextEmail.value;
        bucket.preferredEmailScore = nextEmail.score;

        const nextName = betterName(
            { value: bucket.preferredName, score: bucket.preferredNameScore },
            signals.name
        );
        bucket.preferredName = nextName.value;
        bucket.preferredNameScore = nextName.score;

        if (row.team) bucket.teams.add(row.team);
        for (const team of row.teams || []) {
            if (team) bucket.teams.add(team);
        }

        if (row.projectId !== undefined && row.projectId !== null) {
            const projectId = numberValue(row.projectId);
            if (projectId > 0) bucket.projectIds.add(projectId);
        }
        for (const projectIdRaw of row.projectIds || []) {
            const projectId = numberValue(projectIdRaw);
            if (projectId > 0) bucket.projectIds.add(projectId);
        }

        bucket.commits += numberValue(row.commits);
        bucket.linesAdded += numberValue(row.linesAdded);
        bucket.linesRemoved += numberValue(row.linesRemoved);
        bucket.mrsOpened += numberValue(row.mrsOpened);
        bucket.mrsMerged += numberValue(row.mrsMerged);
        bucket.reviewsGiven += numberValue(row.reviewsGiven);

        const firstDate = parseDate(row.firstActivity);
        if (firstDate && (!bucket.firstActivity || firstDate < bucket.firstActivity)) {
            bucket.firstActivity = firstDate;
        }

        const lastDate = parseDate(row.lastActivity);
        if (lastDate && (!bucket.lastActivity || lastDate > bucket.lastActivity)) {
            bucket.lastActivity = lastDate;
        }
    }

    return buckets.map((bucket) => {
        const sortedEmails = [...bucket.emails].sort((left, right) => {
            const byQuality = emailScore(right) - emailScore(left);
            if (byQuality !== 0) return byQuality;
            return left.localeCompare(right);
        });

        const preferredEmail = bucket.preferredEmail || sortedEmails[0] || UNKNOWN_EMAIL;
        const fallbackName = localPart(preferredEmail);
        const chosenName = bucket.preferredNameScore > 0 ? bucket.preferredName : fallbackName;

        return {
            canonicalKey: bucket.key,
            email: preferredEmail,
            name: chosenName,
            allEmails: sortedEmails,
            teams: [...bucket.teams].sort(),
            commits: bucket.commits,
            linesAdded: bucket.linesAdded,
            linesRemoved: bucket.linesRemoved,
            mrsOpened: bucket.mrsOpened,
            mrsMerged: bucket.mrsMerged,
            reviewsGiven: bucket.reviewsGiven,
            projectsActive: bucket.projectIds.size,
            firstActivity: bucket.firstActivity ? bucket.firstActivity.toISOString() : null,
            lastActivity: bucket.lastActivity ? bucket.lastActivity.toISOString() : null,
        };
    });
}
