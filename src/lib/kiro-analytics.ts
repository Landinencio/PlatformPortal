/**
 * Kiro Analytics Athena client.
 *
 * Queries the `kiro_analytics` Athena database (workgroup `kiro-analytics`) that
 * holds Kiro IDE usage data: `user_activity_view`, `classified_prompts`,
 * `classified_sessions`, `chat_logs_raw` and the optional `user_metadata` table.
 *
 * The dataset lives in the tooling account (444455556666) in eu-central-1
 * (Frankfurt, same region as the Kiro logs bucket). Because the portal already
 * runs in that account with the `portal-inventory-irsa` role, the client uses
 * the ambient IRSA credentials by default and only performs an AssumeRole when
 * `KIRO_ATHENA_ROLE_ARN` is configured.
 *
 * Mirrors the patterns in `athena-cur.ts` / `kiro-licenses.ts`:
 *  - top-level server module import (compatible with Next.js `standalone`)
 *  - never leaks role ARNs, credentials or raw query internals to callers
 *
 * Identity resolution: when the `user_metadata` table is present it is joined
 * directly (origin behaviour). When it is absent the Kiro `user_id` is resolved
 * to a display name/email via the IAM Identity Store, reusing the pattern from
 * `kiro-licenses.ts`.
 */

import {
  AthenaClient,
  StartQueryExecutionCommand,
  GetQueryExecutionCommand,
  GetQueryResultsCommand,
} from "@aws-sdk/client-athena";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  IdentitystoreClient,
  DescribeUserCommand,
  ListGroupMembershipsForMemberCommand,
  DescribeGroupCommand,
} from "@aws-sdk/client-identitystore";

// ─── Configuration (env-driven, Requirement 3.2) ───────────────────────────

const ATHENA_REGION = process.env.KIRO_ATHENA_REGION?.trim() || "eu-central-1";
const ATHENA_DATABASE = process.env.KIRO_ATHENA_DATABASE?.trim() || "kiro_analytics";
const ATHENA_WORKGROUP = process.env.KIRO_ATHENA_WORKGROUP?.trim() || "kiro-analytics";
/** Optional. When empty, the workgroup's enforced OutputLocation is used. */
const ATHENA_OUTPUT = process.env.KIRO_ATHENA_OUTPUT?.trim() || "";
/** Optional AssumeRole ARN. When empty, ambient IRSA credentials are used. */
const ATHENA_ROLE_ARN = process.env.KIRO_ATHENA_ROLE_ARN?.trim() || "";

const IDENTITY_STORE_ID = process.env.KIRO_IDENTITY_STORE_ID?.trim() || "d-93670801b4";
const IDENTITY_STORE_REGION = "eu-west-1";
const IDENTITY_STORE_ROLE_ARN =
  process.env.IDENTITY_STORE_ROLE_ARN?.trim() ||
  "arn:aws:iam::600700800900:role/Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur";

/** Hourly rate (€) used to value the estimated time saved. */
export const HOURLY_RATE_EUR = Number(process.env.KIRO_HOURLY_RATE) || 26;
/** Heuristic: AI-accepted code lines per developer-hour, used to estimate hours saved. */
const LINES_PER_HOUR = Number(process.env.KIRO_LINES_PER_HOUR) || 50;

const POLL_INTERVAL_MS = 1500;
const MAX_POLL_ATTEMPTS = 80; // 2 min max

// ─── Validation helpers (Requirement 4) ─────────────────────────────────────

const SAFE_ID = /^[0-9a-fA-F-]+$/;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidUserId(value: string): boolean {
  return SAFE_ID.test(value);
}

export function isValidDate(value: string): boolean {
  return SAFE_DATE.test(value);
}

/**
 * Parse and validate a comma-separated `users` filter. Returns the list of
 * valid user ids. Throws `ValidationError` if any supplied value is malformed.
 */
export function parseUserFilter(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const parts = raw.split(",").map((u) => u.trim()).filter(Boolean);
  for (const p of parts) {
    if (!isValidUserId(p)) throw new ValidationError(`Invalid user identifier: ${p}`);
  }
  return parts;
}

export function assertValidDate(value: string | null | undefined, field: string): void {
  if (value && !isValidDate(value)) {
    throw new ValidationError(`Invalid ${field}; expected YYYY-MM-DD`);
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

// ─── Athena client + query execution ─────────────────────────────────────────

let cachedAthena: AthenaClient | null = null;
let athenaCredsExpireAt = 0;

async function getAthenaClient(): Promise<AthenaClient> {
  // No AssumeRole configured → use ambient credentials (portal IRSA, same account).
  if (!ATHENA_ROLE_ARN) {
    if (!cachedAthena) cachedAthena = new AthenaClient({ region: ATHENA_REGION });
    return cachedAthena;
  }

  if (cachedAthena && Date.now() < athenaCredsExpireAt - 60_000) return cachedAthena;

  const sts = new STSClient({ region: ATHENA_REGION });
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: ATHENA_ROLE_ARN,
      RoleSessionName: "portal-kiro-analytics",
      DurationSeconds: 900,
    }),
  );
  cachedAthena = new AthenaClient({
    region: ATHENA_REGION,
    credentials: {
      accessKeyId: assumed.Credentials!.AccessKeyId!,
      secretAccessKey: assumed.Credentials!.SecretAccessKey!,
      sessionToken: assumed.Credentials!.SessionToken!,
    },
  });
  athenaCredsExpireAt = assumed.Credentials!.Expiration!.getTime();
  return cachedAthena;
}

/**
 * Run a query against the `kiro_analytics` database and return rows keyed by
 * column name. Never surfaces credentials or role ARNs on failure.
 */
async function runQuery(sql: string): Promise<Record<string, string>[]> {
  const client = await getAthenaClient();

  const start = await client.send(
    new StartQueryExecutionCommand({
      QueryString: sql,
      QueryExecutionContext: { Database: ATHENA_DATABASE },
      WorkGroup: ATHENA_WORKGROUP,
      // Only set ResultConfiguration when an explicit output is provided;
      // otherwise the workgroup's enforced OutputLocation is used.
      ...(ATHENA_OUTPUT ? { ResultConfiguration: { OutputLocation: ATHENA_OUTPUT } } : {}),
    }),
  );

  const executionId = start.QueryExecutionId!;

  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    const status = await client.send(new GetQueryExecutionCommand({ QueryExecutionId: executionId }));
    const state = status.QueryExecution?.Status?.State;
    if (state === "SUCCEEDED") break;
    if (state === "FAILED" || state === "CANCELLED") {
      // Surface a generic reason — do not echo SQL / internals to the caller layer.
      const reason = status.QueryExecution?.Status?.StateChangeReason || state;
      throw new AthenaQueryError(`Athena query ${state}: ${reason}`);
    }
    if (i === MAX_POLL_ATTEMPTS - 1) {
      throw new AthenaQueryError("Athena query timed out");
    }
  }

  const rows: Record<string, string>[] = [];
  let columns: string[] = [];
  let nextToken: string | undefined;
  let isFirstPage = true;

  do {
    const results = await client.send(
      new GetQueryResultsCommand({
        QueryExecutionId: executionId,
        MaxResults: 1000,
        ...(nextToken ? { NextToken: nextToken } : {}),
      }),
    );
    const resultRows = results.ResultSet?.Rows || [];
    for (let i = 0; i < resultRows.length; i++) {
      const data = resultRows[i].Data || [];
      if (isFirstPage && i === 0) {
        columns = data.map((d, idx) => d.VarCharValue || `col_${idx}`);
        continue; // header row
      }
      const row: Record<string, string> = {};
      for (let j = 0; j < columns.length && j < data.length; j++) {
        row[columns[j]] = data[j].VarCharValue ?? "";
      }
      rows.push(row);
    }
    isFirstPage = false;
    nextToken = results.NextToken;
  } while (nextToken);

  return rows;
}

export class AthenaQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AthenaQueryError";
  }
}

// ─── user_metadata detection ────────────────────────────────────────────────

let userMetaPresence: boolean | null = null;
let userMetaCheckedAt = 0;
const USER_META_TTL = 30 * 60 * 1000; // 30 min

/**
 * Detect whether the optional `user_metadata` table exists. Cached for 30 min.
 * Uses a lightweight probe query instead of a Glue GetTable call to avoid an
 * extra SDK dependency.
 */
async function hasUserMetadata(): Promise<boolean> {
  if (userMetaPresence !== null && Date.now() - userMetaCheckedAt < USER_META_TTL) {
    return userMetaPresence;
  }
  try {
    await runQuery(`SELECT 1 FROM user_metadata LIMIT 1`);
    userMetaPresence = true;
  } catch {
    userMetaPresence = false;
  }
  userMetaCheckedAt = Date.now();
  return userMetaPresence;
}

// ─── Identity Store resolution (fallback when user_metadata is absent) ───────

export interface ResolvedIdentity {
  email: string | null;
  displayName: string | null;
  group: string | null;
}

let cachedIdentityClient: IdentitystoreClient | null = null;
let identityCredsExpireAt = 0;

async function getIdentitystoreClient(): Promise<IdentitystoreClient> {
  if (cachedIdentityClient && Date.now() < identityCredsExpireAt - 60_000) return cachedIdentityClient;
  const sts = new STSClient({ region: IDENTITY_STORE_REGION });
  const assumed = await sts.send(
    new AssumeRoleCommand({
      RoleArn: IDENTITY_STORE_ROLE_ARN,
      RoleSessionName: "portal-kiro-analytics-identity",
      DurationSeconds: 900,
    }),
  );
  cachedIdentityClient = new IdentitystoreClient({
    region: IDENTITY_STORE_REGION,
    credentials: {
      accessKeyId: assumed.Credentials!.AccessKeyId!,
      secretAccessKey: assumed.Credentials!.SecretAccessKey!,
      sessionToken: assumed.Credentials!.SessionToken!,
    },
  });
  identityCredsExpireAt = assumed.Credentials!.Expiration!.getTime();
  return cachedIdentityClient;
}

const identityCache = new Map<string, ResolvedIdentity>();
const groupNameCache = new Map<string, string>();

/** Extract the bare Identity Store UUID from a Kiro user_id (`d-xxx.uuid` or raw). */
function toIdentityStoreUserId(userId: string): string {
  if (userId.includes(".")) return userId.split(".").pop() || userId;
  return userId;
}

async function resolveIdentity(userId: string): Promise<ResolvedIdentity> {
  const cached = identityCache.get(userId);
  if (cached) return cached;

  const client = await getIdentitystoreClient();
  const isUserId = toIdentityStoreUserId(userId);
  let email: string | null = null;
  let displayName: string | null = null;
  let group: string | null = null;

  try {
    const desc = await client.send(
      new DescribeUserCommand({ IdentityStoreId: IDENTITY_STORE_ID, UserId: isUserId }),
    );
    email = desc.UserName || desc.Emails?.[0]?.Value || null;
    displayName =
      desc.DisplayName ||
      (desc.Name?.GivenName ? `${desc.Name.GivenName} ${desc.Name.FamilyName || ""}`.trim() : null);
  } catch {
    // best-effort
  }

  try {
    const memberships = await client.send(
      new ListGroupMembershipsForMemberCommand({
        IdentityStoreId: IDENTITY_STORE_ID,
        MemberId: { UserId: isUserId },
      }),
    );
    const first = memberships.GroupMemberships?.[0];
    if (first?.GroupId) {
      let name = groupNameCache.get(first.GroupId);
      if (!name) {
        try {
          const g = await client.send(
            new DescribeGroupCommand({ IdentityStoreId: IDENTITY_STORE_ID, GroupId: first.GroupId }),
          );
          name = g.DisplayName || first.GroupId;
          groupNameCache.set(first.GroupId, name);
        } catch {
          name = first.GroupId;
        }
      }
      group = name || null;
    }
  } catch {
    // best-effort
  }

  const resolved: ResolvedIdentity = { email, displayName, group };
  identityCache.set(userId, resolved);
  return resolved;
}

/**
 * Resolve a batch of user ids via Identity Store with limited concurrency.
 * Throws if the Identity Store client itself cannot be initialised, so callers
 * that strictly need identity can fail (Requirement 13.4).
 */
async function resolveIdentities(userIds: string[]): Promise<Map<string, ResolvedIdentity>> {
  const out = new Map<string, ResolvedIdentity>();
  if (userIds.length === 0) return out;
  // Fail fast if we cannot assume the role at all.
  await getIdentitystoreClient();

  const concurrency = 8;
  for (let i = 0; i < userIds.length; i += concurrency) {
    const batch = userIds.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map((id) => resolveIdentity(id)));
    for (let j = 0; j < settled.length; j++) {
      if (settled[j].status === "fulfilled") {
        out.set(batch[j], (settled[j] as PromiseFulfilledResult<ResolvedIdentity>).value);
      } else {
        out.set(batch[j], { email: null, displayName: null, group: null });
      }
    }
  }
  return out;
}

// ─── SQL building helpers ─────────────────────────────────────────────────

const UID_REGEXP = "^[0-9a-f]{8}-";

/**
 * Source for per-user activity. Points to `user_activity_view`, a compatibility
 * view (ops/kiro-user-activity-view.sql) over the multi-account, single-schema
 * table `user_activity_multi` (ops/kiro-user-activity-multi-account.sql).
 *
 * This replaces the crawler-generated `user_activity_raw`, which targeted the
 * AWSLogs/ root with recurse and mixed TWO incompatible CSV schemas
 * (by_user_analytic + user_report), corrupting the user_id column. The view
 * reads ONLY by_user_analytic across all accounts with quotes stripped, so the
 * UUID filter is now a safety belt rather than the only thing hiding garbage.
 */
const ACTIVITY_TABLE = process.env.KIRO_ACTIVITY_TABLE?.trim() || "user_activity_view";

/**
 * Source for per-user usage/licence reports (`user_report_multi`,
 * ops/kiro-user-report-multi-account.sql). Multi-account (incl. EKS Tooling),
 * OpenCSVSerde, columns aligned to the real CSV header. Far richer coverage than
 * by_user_analytic: email, subscription tier, total/auto messages, conversations,
 * per-Claude-model messages. Used to break down activity by team/group.
 */
const REPORT_TABLE = process.env.KIRO_REPORT_TABLE?.trim() || "user_report_multi";

function usersClause(users: string[], col: string, prefix: "WHERE" | "AND"): string {
  if (users.length === 0) return "";
  const quoted = users.map((u) => `'${u}'`).join(","); // already validated against SAFE_ID
  return `${prefix} ${col} IN (${quoted})`;
}

function num(v: string | undefined): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ─── Public types ─────────────────────────────────────────────────────────

export interface OverviewStats {
  totalUniqueUsers: number;
  totalPrompts: number;
  totalAiCodeLines: number;
  totalChatMessages: number;
  weeklyActiveUsers: number;
  estimatedHoursSaved: number;
  estimatedSavingsEur: number;
}

export interface TrendPoint {
  date: string;
  value: number;
}

export interface Distribution {
  name: string;
  value: number;
}

export interface UserRanking {
  displayName: string;
  value: number;
}

export interface UserOption {
  id: string;
  label: string;
}

export interface ClassifiedPromptRow {
  userId: string;
  displayName: string;
  email: string;
  timestamp: string;
  promptLength: number;
  responseLength: number;
  workType: string;
  intent: string;
  category: string;
  complexity: string;
  specificity: string;
  reportDate: string;
}

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface SessionStats {
  totalSessions: number;
  avgSessionDuration: number;
}

export interface LicenseUsageRow {
  userId: string;
  displayName: string;
  email: string;
  group: string;
  tier: string;
  clients: string[];
  totalMessages: number;
  autoMessages: number;
  conversations: number;
  creditsUsed: number;
  days: number;
}

export interface LicenseUsageSummary {
  rows: LicenseUsageRow[];
  totalUsers: number;
  byTier: Array<{ tier: string; users: number; messages: number }>;
  totalMessages: number;
  totalCreditsUsed: number;
}

export interface UserActivityRow {
  userId: string;
  displayName: string;
  email: string;
  userGroup: string;
  reportDate: string;
  chatAiCodeLines: number;
  chatMessagesSent: number;
  inlineAiCodeLines: number;
  inlineAcceptanceCount: number;
  inlineSuggestionsCount: number;
  devAcceptedLines: number;
  testsAccepted: number;
  totalAiCodeAccepted: number;
}

// ─── Date filter helpers (Requirement 5.3) ──────────────────────────────────

/** Build a report_date (%m-%d-%Y) range clause for the activity view. */
function activityDateClause(startDate?: string, endDate?: string): string {
  const parts: string[] = [];
  if (startDate) parts.push(`date_parse(report_date, '%m-%d-%Y') >= date_parse('${startDate}', '%Y-%m-%d')`);
  if (endDate) parts.push(`date_parse(report_date, '%m-%d-%Y') <= date_parse('${endDate}', '%Y-%m-%d')`);
  return parts.length ? `AND ${parts.join(" AND ")}` : "";
}

/** Build a year||month||day range clause for classified_prompts. */
function promptsDateClause(startDate?: string, endDate?: string): string {
  const parts: string[] = [];
  if (startDate)
    parts.push(`date_parse(year || '-' || month || '-' || day, '%Y-%m-%d') >= date_parse('${startDate}', '%Y-%m-%d')`);
  if (endDate)
    parts.push(`date_parse(year || '-' || month || '-' || day, '%Y-%m-%d') <= date_parse('${endDate}', '%Y-%m-%d')`);
  return parts.length ? `AND ${parts.join(" AND ")}` : "";
}

/**
 * Build a report_date range clause for user_report (REPORT_TABLE), whose date
 * column is already in '%Y-%m-%d' form. Column reference is parameterised so it
 * can be aliased (e.g. `ur.report_date`).
 */
function reportDateClause(startDate?: string, endDate?: string, col = "report_date"): string {
  const parts: string[] = [];
  if (startDate) parts.push(`${col} >= '${startDate}'`);
  if (endDate) parts.push(`${col} <= '${endDate}'`);
  return parts.length ? `AND ${parts.join(" AND ")}` : "";
}

// ─── Query functions ────────────────────────────────────────────────────────

export async function getOverview(startDate?: string, endDate?: string): Promise<OverviewStats> {
  const actDate = activityDateClause(startDate, endDate);
  const prmDate = promptsDateClause(startDate, endDate);
  const rows = await runQuery(`
    WITH ua AS (
      SELECT COUNT(DISTINCT user_id) as users,
        SUM(CAST(TRY_CAST(chat_messagessent AS DOUBLE) AS BIGINT)) as messages,
        SUM(CAST(TRY_CAST(chat_aicodelines AS DOUBLE) AS BIGINT) + CAST(TRY_CAST(inline_aicodelines AS DOUBLE) AS BIGINT) + CAST(TRY_CAST(dev_acceptedlines AS DOUBLE) AS BIGINT)) as ai_code
      FROM ${ACTIVITY_TABLE} WHERE regexp_like(user_id, '${UID_REGEXP}') ${actDate}
    ),
    cp AS (
      SELECT COUNT(*) as prompts FROM classified_prompts WHERE 1=1 ${prmDate}
    ),
    wau AS (
      SELECT COUNT(DISTINCT user_id) as wau FROM classified_prompts
      WHERE user_id IS NOT NULL AND year || '-' || month || '-' || day >= date_format(current_date - interval '7' day, '%Y-%m-%d')
    )
    SELECT ua.users, ua.messages, ua.ai_code, cp.prompts, wau.wau
    FROM ua, cp, wau
  `);
  const r = rows[0] || {};
  const totalAiCodeLines = Math.round(num(r.ai_code));
  const estimatedHoursSaved = Math.round(totalAiCodeLines / LINES_PER_HOUR);
  return {
    totalUniqueUsers: Math.round(num(r.users)),
    totalPrompts: Math.round(num(r.prompts)),
    totalAiCodeLines,
    totalChatMessages: Math.round(num(r.messages)),
    weeklyActiveUsers: Math.round(num(r.wau)),
    estimatedHoursSaved,
    estimatedSavingsEur: Math.round(estimatedHoursSaved * HOURLY_RATE_EUR),
  };
}

export async function getWauTrend(users: string[]): Promise<TrendPoint[]> {
  const uw = usersClause(users, "user_id", "AND");
  const rows = await runQuery(
    `SELECT date_format(date_trunc('week', date_parse(year || '-' || month || '-' || day, '%Y-%m-%d')), '%Y-%m-%d') as date, COUNT(DISTINCT user_id) as value FROM classified_prompts WHERE user_id IS NOT NULL ${uw} GROUP BY date_trunc('week', date_parse(year || '-' || month || '-' || day, '%Y-%m-%d')) ORDER BY date`,
  );
  return rows.map((r) => ({ date: r.date, value: Math.round(num(r.value)) }));
}

export async function getFeatureAdoption(users: string[]): Promise<Distribution[]> {
  const uw = usersClause(users, "user_id", "AND");
  const features: Array<[string, string]> = [
    ["Chat", "chat_messagessent"],
    ["Inline Suggestions", "inline_suggestionscount"],
    ["Inline Chat", "inlinechat_totaleventcount"],
    ["/dev", "dev_generationeventcount"],
    ["/test", "testgeneration_eventcount"],
    ["/doc", "docgeneration_eventcount"],
    ["Code Review", "codereview_findingscount"],
    ["/transform", "transformation_eventcount"],
  ];
  const unions = features
    .map(
      ([name, col]) =>
        `SELECT '${name}' as name, COUNT(DISTINCT CASE WHEN CAST(TRY_CAST(COALESCE(${col},'0') AS DOUBLE) AS BIGINT) > 0 THEN user_id END) as value FROM ${ACTIVITY_TABLE} WHERE regexp_like(user_id, '${UID_REGEXP}') ${uw}`,
    )
    .join("\nUNION ALL ");
  const rows = await runQuery(unions);
  return rows.map((r) => ({ name: r.name, value: Math.round(num(r.value)) })).filter((r) => r.value > 0);
}

export async function getAvgPromptsPerSession(users: string[]): Promise<TrendPoint[]> {
  const uw = usersClause(users, "user_id", "AND");
  const rows = await runQuery(
    `SELECT date_format(date_parse(substr(session_start, 1, 10), '%Y-%m-%d'), '%Y-%m-%d') as date, ROUND(AVG(CAST(message_count AS DOUBLE)), 1) as value FROM classified_sessions WHERE session_start IS NOT NULL AND session_start != '' ${uw} GROUP BY substr(session_start, 1, 10) ORDER BY date`,
  );
  return rows.map((r) => ({ date: r.date, value: round2(num(r.value)) }));
}

export async function getDailyUsage(users: string[]): Promise<TrendPoint[]> {
  const uw = usersClause(users, "user_id", "AND");
  const rows = await runQuery(
    `SELECT year || '-' || month || '-' || day as date, COUNT(*) as value FROM classified_prompts WHERE user_id IS NOT NULL AND date_parse(year || '-' || month || '-' || day, '%Y-%m-%d') >= current_date - interval '90' day ${uw} GROUP BY year, month, day ORDER BY date`,
  );
  return rows.map((r) => ({ date: r.date, value: Math.round(num(r.value)) }));
}

export async function getWeeklyAiLinesTrend(users: string[]): Promise<TrendPoint[]> {
  const uw =
    users.length > 0
      ? `AND r.generateAssistantResponseEventRequest.userId IN (${users.map((u) => `'${u}'`).join(",")})`
      : "";
  const rows = await runQuery(`
    SELECT date_format(date_trunc('week', date_parse(substr(r.generateAssistantResponseEventRequest.timeStamp, 1, 19), '%Y-%m-%dT%H:%i:%s')), '%Y-%m-%d') as date,
      SUM(cardinality(split(r.generateAssistantResponseEventResponse.assistantResponse, chr(10)))) as value
    FROM chat_logs_raw
    CROSS JOIN UNNEST(records) AS t(r)
    WHERE r.generateAssistantResponseEventRequest.userId IS NOT NULL
      AND r.generateAssistantResponseEventResponse.assistantResponse IS NOT NULL
      AND r.generateAssistantResponseEventResponse.assistantResponse != ''
      ${uw}
    GROUP BY date_trunc('week', date_parse(substr(r.generateAssistantResponseEventRequest.timeStamp, 1, 19), '%Y-%m-%dT%H:%i:%s'))
    ORDER BY date
  `);
  return rows.map((r) => ({ date: r.date, value: Math.round(num(r.value)) }));
}

export async function getActivityTrend(users: string[], startDate?: string, endDate?: string): Promise<TrendPoint[]> {
  const uw = usersClause(users, "user_id", "AND");
  const dw = activityDateClause(startDate, endDate);
  const rows = await runQuery(
    `SELECT date_format(date_parse(report_date, '%m-%d-%Y'), '%Y-%m-%d') as date, SUM(CAST(TRY_CAST(COALESCE(chat_aicodelines,'0') AS DOUBLE) AS BIGINT) + CAST(TRY_CAST(COALESCE(inline_aicodelines,'0') AS DOUBLE) AS BIGINT) + CAST(TRY_CAST(COALESCE(dev_acceptedlines,'0') AS DOUBLE) AS BIGINT)) as value FROM ${ACTIVITY_TABLE} WHERE regexp_like(user_id, '${UID_REGEXP}') ${uw} ${dw} GROUP BY date_format(date_parse(report_date, '%m-%d-%Y'), '%Y-%m-%d') ORDER BY date`,
  );
  return rows.map((r) => ({ date: r.date, value: Math.round(num(r.value)) }));
}

export async function getActivityByGroup(users: string[] = []): Promise<Distribution[]> {
  // Uses user_report (total_messages) for real multi-account coverage; by_user_analytic
  // (code lines) is almost empty in the source ETL so it would collapse to one group.
  const uw = usersClause(users, "ur.user_id", "AND");
  if (await hasUserMetadata()) {
    const rows = await runQuery(
      `SELECT COALESCE(um.primary_group, 'No Group') as name, SUM(CAST(TRY_CAST(COALESCE(ur.total_messages,'0') AS DOUBLE) AS BIGINT)) as value FROM ${REPORT_TABLE} ur LEFT JOIN user_metadata um ON ur.user_id = um.identity_store_user_id WHERE regexp_like(ur.user_id, '${UID_REGEXP}') ${uw} GROUP BY COALESCE(um.primary_group, 'No Group') ORDER BY value DESC LIMIT 15`,
    );
    return rows.map((r) => ({ name: r.name, value: Math.round(num(r.value)) }));
  }
  const rows = await runQuery(
    `SELECT 'No Group' as name, SUM(CAST(TRY_CAST(COALESCE(ur.total_messages,'0') AS DOUBLE) AS BIGINT)) as value FROM ${REPORT_TABLE} ur WHERE regexp_like(ur.user_id, '${UID_REGEXP}') ${uw}`,
  );
  return rows.map((r) => ({ name: r.name, value: Math.round(num(r.value)) }));
}

export async function getTopByCode(users: string[] = []): Promise<UserRanking[]> {
  // Ranks by user_report total_messages (rich, multi-account) — by_user_analytic
  // code lines are almost empty so they would show a single user.
  const uw = usersClause(users, "ur.user_id", "AND");
  if (await hasUserMetadata()) {
    const rows = await runQuery(
      `SELECT COALESCE(um.email, um.display_name, ur.user_email, ur.user_id) as displayName, SUM(CAST(TRY_CAST(COALESCE(ur.total_messages,'0') AS DOUBLE) AS BIGINT)) as value FROM ${REPORT_TABLE} ur LEFT JOIN user_metadata um ON ur.user_id = um.identity_store_user_id WHERE regexp_like(ur.user_id, '${UID_REGEXP}') ${uw} GROUP BY COALESCE(um.email, um.display_name, ur.user_email, ur.user_id) ORDER BY value DESC LIMIT 10`,
    );
    return rows.map((r) => ({ displayName: r.displayName, value: Math.round(num(r.value)) }));
  }
  const rows = await runQuery(
    `SELECT COALESCE(NULLIF(ur.user_email,''), ur.user_id) as displayName, SUM(CAST(TRY_CAST(COALESCE(ur.total_messages,'0') AS DOUBLE) AS BIGINT)) as value FROM ${REPORT_TABLE} ur WHERE regexp_like(ur.user_id, '${UID_REGEXP}') ${uw} GROUP BY COALESCE(NULLIF(ur.user_email,''), ur.user_id) ORDER BY value DESC LIMIT 10`,
  );
  return rows.map((r) => ({ displayName: r.displayName, value: Math.round(num(r.value)) }));
}

export async function getTopByPrompts(): Promise<UserRanking[]> {
  if (await hasUserMetadata()) {
    const rows = await runQuery(
      `SELECT COALESCE(um.email, um.display_name, cp.user_id) as displayName, COUNT(*) as value FROM classified_prompts cp LEFT JOIN user_metadata um ON cp.user_id = um.user_id GROUP BY COALESCE(um.email, um.display_name, cp.user_id) ORDER BY value DESC LIMIT 10`,
    );
    return rows.map((r) => ({ displayName: r.displayName, value: Math.round(num(r.value)) }));
  }
  const rows = await runQuery(
    `SELECT cp.user_id as displayName, COUNT(*) as value FROM classified_prompts cp GROUP BY cp.user_id ORDER BY value DESC LIMIT 10`,
  );
  const resolved = await resolveIdentities(rows.map((r) => r.displayName));
  return rows.map((r) => ({
    displayName: resolved.get(r.displayName)?.email || resolved.get(r.displayName)?.displayName || r.displayName,
    value: Math.round(num(r.value)),
  }));
}

export async function getUserActivity(users: string[], startDate?: string, endDate?: string): Promise<UserActivityRow[]> {
  const uw = usersClause(users, "ua.user_id", "AND");
  const dw = activityDateClause(startDate, endDate);
  const cols = `
    CAST(TRY_CAST(COALESCE(chat_aicodelines,'0') AS DOUBLE) AS BIGINT) as chatAiCodeLines,
    CAST(TRY_CAST(COALESCE(chat_messagessent,'0') AS DOUBLE) AS BIGINT) as chatMessagesSent,
    CAST(TRY_CAST(COALESCE(inline_aicodelines,'0') AS DOUBLE) AS BIGINT) as inlineAiCodeLines,
    CAST(TRY_CAST(COALESCE(inline_acceptancecount,'0') AS DOUBLE) AS BIGINT) as inlineAcceptanceCount,
    CAST(TRY_CAST(COALESCE(inline_suggestionscount,'0') AS DOUBLE) AS BIGINT) as inlineSuggestionsCount,
    CAST(TRY_CAST(COALESCE(dev_acceptedlines,'0') AS DOUBLE) AS BIGINT) as devAcceptedLines,
    CAST(TRY_CAST(COALESCE(testgeneration_acceptedtests,'0') AS DOUBLE) AS BIGINT) as testsAccepted,
    CAST(TRY_CAST(COALESCE(chat_aicodelines,'0') AS DOUBLE) AS BIGINT) + CAST(TRY_CAST(COALESCE(inline_aicodelines,'0') AS DOUBLE) AS BIGINT) + CAST(TRY_CAST(COALESCE(dev_acceptedlines,'0') AS DOUBLE) AS BIGINT) as totalAiCodeAccepted`;

  let rows: Record<string, string>[];
  let useIdentityFallback = false;
  if (await hasUserMetadata()) {
    rows = await runQuery(`
      SELECT ua.user_id as userId, COALESCE(um.email, um.display_name, ua.user_id) as displayName,
        COALESCE(um.email, '') as email, COALESCE(um.primary_group, '') as userGroup,
        date_format(date_parse(ua.report_date, '%m-%d-%Y'), '%Y-%m-%d') as reportDate,
        ${cols}
      FROM ${ACTIVITY_TABLE} ua
      LEFT JOIN user_metadata um ON ua.user_id = um.identity_store_user_id
      WHERE regexp_like(ua.user_id, '${UID_REGEXP}') ${uw} ${dw} ORDER BY date_parse(ua.report_date, '%m-%d-%Y') DESC LIMIT 500
    `);
  } else {
    useIdentityFallback = true;
    rows = await runQuery(`
      SELECT ua.user_id as userId, ua.user_id as displayName, '' as email, '' as userGroup,
        date_format(date_parse(ua.report_date, '%m-%d-%Y'), '%Y-%m-%d') as reportDate,
        ${cols}
      FROM ${ACTIVITY_TABLE} ua
      WHERE regexp_like(ua.user_id, '${UID_REGEXP}') ${uw} ${dw} ORDER BY date_parse(ua.report_date, '%m-%d-%Y') DESC LIMIT 500
    `);
  }

  let resolved: Map<string, ResolvedIdentity> | null = null;
  if (useIdentityFallback) {
    resolved = await resolveIdentities([...new Set(rows.map((r) => r.userId))]);
  }

  return rows.map((r) => {
    const ident = resolved?.get(r.userId);
    return {
      userId: r.userId,
      displayName: ident?.email || ident?.displayName || r.displayName,
      email: ident?.email || r.email,
      userGroup: ident?.group || r.userGroup,
      reportDate: r.reportDate,
      chatAiCodeLines: Math.round(num(r.chatAiCodeLines)),
      chatMessagesSent: Math.round(num(r.chatMessagesSent)),
      inlineAiCodeLines: Math.round(num(r.inlineAiCodeLines)),
      inlineAcceptanceCount: Math.round(num(r.inlineAcceptanceCount)),
      inlineSuggestionsCount: Math.round(num(r.inlineSuggestionsCount)),
      devAcceptedLines: Math.round(num(r.devAcceptedLines)),
      testsAccepted: Math.round(num(r.testsAccepted)),
      totalAiCodeAccepted: Math.round(num(r.totalAiCodeAccepted)),
    };
  });
}

export async function getClassifiedPrompts(
  users: string[],
  limit: number,
  offset: number,
): Promise<PaginatedResponse<ClassifiedPromptRow>> {
  const uw = usersClause(users, "cp.user_id", "WHERE");
  const safeLimit = Math.min(Math.max(limit, 1), 200);
  const safeOffset = Math.max(offset, 0);

  const countRows = await runQuery(`SELECT COUNT(*) as total FROM classified_prompts cp ${uw}`);
  const total = Math.round(num(countRows[0]?.total));

  // Note: raw prompt text is intentionally NOT selected — only classification
  // metadata is exposed (Requirement 12, prompt-content privacy = hidden).
  let rows: Record<string, string>[];
  let useIdentityFallback = false;
  if (await hasUserMetadata()) {
    rows = await runQuery(`
      SELECT cp.user_id as userId, COALESCE(um.email, um.display_name, cp.user_id) as displayName,
        COALESCE(um.email, '') as email, cp.timestamp,
        cp.prompt_length as promptLength, cp.response_length as responseLength,
        cp.work_type as workType, cp.intent, cp.category, cp.complexity, cp.specificity,
        cp.year || '-' || cp.month || '-' || cp.day as reportDate
      FROM classified_prompts cp
      LEFT JOIN user_metadata um ON cp.user_id = um.user_id
      ${uw} ORDER BY cp.timestamp DESC
      OFFSET ${safeOffset} LIMIT ${safeLimit}
    `);
  } else {
    useIdentityFallback = true;
    rows = await runQuery(`
      SELECT cp.user_id as userId, cp.user_id as displayName, '' as email, cp.timestamp,
        cp.prompt_length as promptLength, cp.response_length as responseLength,
        cp.work_type as workType, cp.intent, cp.category, cp.complexity, cp.specificity,
        cp.year || '-' || cp.month || '-' || cp.day as reportDate
      FROM classified_prompts cp
      ${uw} ORDER BY cp.timestamp DESC
      OFFSET ${safeOffset} LIMIT ${safeLimit}
    `);
  }

  let resolved: Map<string, ResolvedIdentity> | null = null;
  if (useIdentityFallback) {
    resolved = await resolveIdentities([...new Set(rows.map((r) => r.userId))]);
  }

  const data: ClassifiedPromptRow[] = rows.map((r) => {
    const ident = resolved?.get(r.userId);
    return {
      userId: r.userId,
      displayName: ident?.email || ident?.displayName || r.displayName,
      email: ident?.email || r.email,
      timestamp: r.timestamp,
      promptLength: Math.round(num(r.promptLength)),
      responseLength: Math.round(num(r.responseLength)),
      workType: r.workType,
      intent: r.intent,
      category: r.category,
      complexity: r.complexity,
      specificity: r.specificity,
      reportDate: r.reportDate,
    };
  });

  return { data, total, limit: safeLimit, offset: safeOffset };
}

export async function getSessionStats(users: string[]): Promise<SessionStats> {
  const uw = usersClause(users, "user_id", "WHERE");
  const rows = await runQuery(
    `SELECT COUNT(DISTINCT session_id) as totalSessions, ROUND(AVG(CAST(session_duration_minutes AS DOUBLE)), 1) as avgDuration FROM classified_sessions ${uw}`,
  );
  const r = rows[0] || {};
  return { totalSessions: Math.round(num(r.totalSessions)), avgSessionDuration: round2(num(r.avgDuration)) };
}

const DISTRIBUTION_FIELDS = ["work_type", "intent", "category", "complexity", "specificity"] as const;
export type DistributionField = (typeof DISTRIBUTION_FIELDS)[number];

export function isDistributionField(field: string): field is DistributionField {
  return (DISTRIBUTION_FIELDS as readonly string[]).includes(field);
}

export async function getDistribution(field: DistributionField, users: string[]): Promise<Distribution[]> {
  const uw = usersClause(users, "user_id", "WHERE");
  const rows = await runQuery(
    `SELECT ${field} as name, COUNT(*) as value FROM classified_sessions ${uw} ${uw ? "AND" : "WHERE"} ${field} IS NOT NULL GROUP BY ${field} ORDER BY value DESC`,
  );
  return rows.map((r) => ({ name: r.name, value: Math.round(num(r.value)) }));
}

export async function getPromptsTrend(users: string[]): Promise<TrendPoint[]> {
  const uw = usersClause(users, "user_id", "WHERE");
  const rows = await runQuery(
    `SELECT year || '-' || month || '-' || day as date, COUNT(*) as value FROM classified_prompts ${uw} GROUP BY year, month, day ORDER BY date`,
  );
  return rows.map((r) => ({ date: r.date, value: Math.round(num(r.value)) }));
}

export async function listUsers(source: string): Promise<UserOption[]> {
  const hasMeta = await hasUserMetadata();
  let rows: Record<string, string>[];

  if (source === "activity") {
    rows = hasMeta
      ? await runQuery(
          `SELECT DISTINCT ua.user_id, COALESCE(um.email, ua.user_id) as label FROM ${ACTIVITY_TABLE} ua LEFT JOIN user_metadata um ON ua.user_id = um.identity_store_user_id WHERE regexp_like(ua.user_id, '${UID_REGEXP}') ORDER BY label LIMIT 200`,
        )
      : await runQuery(
          `SELECT DISTINCT ua.user_id, ua.user_id as label FROM ${ACTIVITY_TABLE} ua WHERE regexp_like(ua.user_id, '${UID_REGEXP}') ORDER BY label LIMIT 200`,
        );
  } else if (source === "prompts") {
    rows = hasMeta
      ? await runQuery(
          `SELECT DISTINCT cp.user_id, COALESCE(um.email, cp.user_id) as label FROM classified_prompts cp LEFT JOIN user_metadata um ON cp.user_id = um.user_id WHERE cp.user_id IS NOT NULL ORDER BY label LIMIT 200`,
        )
      : await runQuery(
          `SELECT DISTINCT cp.user_id, cp.user_id as label FROM classified_prompts cp WHERE cp.user_id IS NOT NULL ORDER BY label LIMIT 200`,
        );
  } else {
    rows = hasMeta
      ? await runQuery(
          `SELECT DISTINCT u.user_id, COALESCE(um.email, u.user_id) as label FROM (SELECT user_id FROM ${ACTIVITY_TABLE} WHERE regexp_like(user_id, '${UID_REGEXP}') UNION SELECT user_id FROM classified_prompts WHERE user_id IS NOT NULL) u LEFT JOIN user_metadata um ON u.user_id = um.identity_store_user_id ORDER BY label LIMIT 200`,
        )
      : await runQuery(
          `SELECT DISTINCT u.user_id, u.user_id as label FROM (SELECT user_id FROM ${ACTIVITY_TABLE} WHERE regexp_like(user_id, '${UID_REGEXP}') UNION SELECT user_id FROM classified_prompts WHERE user_id IS NOT NULL) u ORDER BY label LIMIT 200`,
        );
  }

  if (!hasMeta) {
    // Best-effort identity resolution for friendly labels (Requirement 8.2/8.3).
    const ids = rows.map((r) => r.user_id);
    const resolved = await resolveIdentities(ids).catch(() => new Map<string, ResolvedIdentity>());
    return rows.map((r) => {
      const ident = resolved.get(r.user_id);
      return { id: r.user_id, label: ident?.email || ident?.displayName || r.label };
    });
  }

  return rows.map((r) => ({ id: r.user_id, label: r.label }));
}

// ─── License usage (from user_report — rich multi-account usage signal) ──────

/** Rank tiers so we can keep the "highest" one per user when aggregating. */
function tierRank(tier: string): number {
  const t = (tier || "").toUpperCase();
  if (t.includes("POWER")) return 3;
  if (t.includes("PLUS")) return 2;
  if (t.includes("PRO")) return 1;
  return 0;
}

/**
 * Per-user usage/licence summary from the `user_report` dataset (REPORT_TABLE):
 * subscription tier, clients used, total/auto messages, conversations, credits.
 *
 * This is the rich, multi-account signal (incl. EKS Tooling) that complements the
 * sparse by_user_analytic code metrics. Identity is resolved via user_metadata
 * (preferred), then the report's own user_email, then the raw id.
 */
export async function getLicenseUsage(users: string[] = [], startDate?: string, endDate?: string): Promise<LicenseUsageSummary> {
  const hasMeta = await hasUserMetadata();
  const nameExpr = hasMeta
    ? "COALESCE(um.email, um.display_name, ur.user_email, ur.user_id)"
    : "COALESCE(NULLIF(ur.user_email,''), ur.user_id)";
  const groupExpr = hasMeta ? "COALESCE(um.primary_group, '')" : "''";
  const join = hasMeta
    ? "LEFT JOIN user_metadata um ON ur.user_id = um.identity_store_user_id"
    : "";
  const uw = usersClause(users, "ur.user_id", "AND");
  const dw = reportDateClause(startDate, endDate, "ur.report_date");

  const rows = await runQuery(`
    SELECT
      ur.user_id as user_id,
      ${nameExpr} as display_name,
      COALESCE(MAX(ur.user_email), '') as email,
      ${groupExpr} as user_group,
      ur.subscription_tier as tier,
      array_join(array_agg(DISTINCT ur.client_type), ',') as clients,
      SUM(CAST(TRY_CAST(COALESCE(ur.total_messages,'0') AS DOUBLE) AS BIGINT)) as total_messages,
      SUM(CAST(TRY_CAST(COALESCE(ur.auto_messages,'0') AS DOUBLE) AS BIGINT)) as auto_messages,
      SUM(CAST(TRY_CAST(COALESCE(ur.chat_conversations,'0') AS DOUBLE) AS BIGINT)) as conversations,
      SUM(TRY_CAST(COALESCE(ur.credits_used,'0') AS DOUBLE)) as credits_used,
      COUNT(DISTINCT ur.report_date) as days
    FROM ${REPORT_TABLE} ur
    ${join}
    WHERE regexp_like(ur.user_id, '${UID_REGEXP}') ${uw} ${dw}
    GROUP BY ur.user_id, ${nameExpr}, ${groupExpr}, ur.subscription_tier
    ORDER BY total_messages DESC
  `);

  // A user can appear with several tiers across days/clients; fold to one row,
  // keeping the highest tier and summing the numeric metrics.
  const byUser = new Map<string, LicenseUsageRow>();
  for (const r of rows) {
    const userId = String(r.user_id || "");
    const existing = byUser.get(userId);
    const clients = String(r.clients || "").split(",").map((c) => c.trim()).filter(Boolean);
    const row: LicenseUsageRow = {
      userId,
      displayName: r.display_name || userId,
      email: r.email || "",
      group: r.user_group || "",
      tier: r.tier || "",
      clients,
      totalMessages: Math.round(num(r.total_messages)),
      autoMessages: Math.round(num(r.auto_messages)),
      conversations: Math.round(num(r.conversations)),
      creditsUsed: Math.round(num(r.credits_used) * 100) / 100,
      days: Math.round(num(r.days)),
    };
    if (!existing) {
      byUser.set(userId, row);
    } else {
      existing.totalMessages += row.totalMessages;
      existing.autoMessages += row.autoMessages;
      existing.conversations += row.conversations;
      existing.creditsUsed = Math.round((existing.creditsUsed + row.creditsUsed) * 100) / 100;
      existing.days = Math.max(existing.days, row.days);
      existing.clients = [...new Set([...existing.clients, ...clients])];
      if (tierRank(row.tier) > tierRank(existing.tier)) existing.tier = row.tier;
      if (!existing.email && row.email) existing.email = row.email;
    }
  }

  const result = [...byUser.values()].sort((a, b) => b.totalMessages - a.totalMessages);

  const tierMap = new Map<string, { tier: string; users: number; messages: number }>();
  let totalMessages = 0;
  let totalCreditsUsed = 0;
  for (const u of result) {
    totalMessages += u.totalMessages;
    totalCreditsUsed += u.creditsUsed;
    const key = u.tier || "—";
    const t = tierMap.get(key) || { tier: key, users: 0, messages: 0 };
    t.users += 1;
    t.messages += u.totalMessages;
    tierMap.set(key, t);
  }

  return {
    rows: result,
    totalUsers: result.length,
    byTier: [...tierMap.values()].sort((a, b) => b.messages - a.messages),
    totalMessages,
    totalCreditsUsed: Math.round(totalCreditsUsed * 100) / 100,
  };
}
