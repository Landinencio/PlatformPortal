/**
 * Shared, pure helpers for the engineering-metrics dashboards (DORA + Gestión).
 *
 * Two cross-cutting concerns were previously re-implemented inline in every
 * time-windowed endpoint (`dora-core`, `manager-dashboard`, `team-activity`,
 * `mr-details`), which is exactly how the "custom range is ignored" and "author
 * filter does nothing" bugs crept in: each copy drifted. These helpers make the
 * contract explicit and unit-testable so all surfaces resolve windows and
 * author filters identically.
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidIsoDate(value: string | null | undefined): value is string {
  return !!value && DATE_RE.test(value);
}

export interface ResolvedDateWindow {
  startDate: Date;
  endDate: Date;
  /** true when an explicit from/to range was honoured, false for the rolling window. */
  usedRange: boolean;
}

/**
 * Resolve the [startDate, endDate] window for a dashboard query.
 *
 * Contract:
 *   - When BOTH `from` and `to` are valid YYYY-MM-DD strings they WIN over
 *     `days` (custom range / period comparison): start at 00:00:00.000Z of
 *     `from`, end at 23:59:59.999Z of `to`.
 *   - Otherwise fall back to the rolling window of the last `days` days ending
 *     now.
 *
 * Both branches are inclusive of the boundary days.
 */
export function resolveDateWindow(opts: {
  from?: string | null;
  to?: string | null;
  days: number;
  now?: Date;
}): ResolvedDateWindow {
  if (isValidIsoDate(opts.from) && isValidIsoDate(opts.to)) {
    return {
      startDate: new Date(`${opts.from}T00:00:00.000Z`),
      endDate: new Date(`${opts.to}T23:59:59.999Z`),
      usedRange: true,
    };
  }
  const endDate = opts.now ? new Date(opts.now) : new Date();
  const startDate = new Date(endDate.getTime() - opts.days * 24 * 60 * 60 * 1000);
  return { startDate, endDate, usedRange: false };
}

/**
 * Expand a set of selected canonical author keys into the GitLab usernames that
 * the per-username endpoints (team-activity, mr-details) actually store.
 *
 * The canonical key is seeded by the manager dashboard's population-wide
 * identity merge, so it CANNOT be re-derived from a smaller row population. The
 * manager dashboard therefore publishes `options.authors[].usernames`, and every
 * other surface translates a canonical filter through this map. Returns a
 * de-duplicated username list (empty ⇒ no author filter).
 */
export function expandAuthorUsernames(
  selectedCanonicalKeys: string[],
  authorOptions: Array<{ key: string; usernames: string[] }>
): string[] {
  if (selectedCanonicalKeys.length === 0) return [];
  const wanted = new Set(selectedCanonicalKeys);
  const usernames = new Set<string>();
  for (const option of authorOptions) {
    if (!wanted.has(option.key)) continue;
    for (const username of option.usernames || []) {
      const trimmed = (username || "").trim();
      if (trimmed) usernames.add(trimmed);
    }
  }
  return [...usernames];
}
