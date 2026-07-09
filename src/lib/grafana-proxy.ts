/**
 * Grafana Cloud unified client.
 *
 * Uses the Grafana service account token (GRAFANA_TOKEN) to access:
 *  - Prometheus / Mimir metrics (via the existing direct endpoint or the proxy)
 *  - Loki logs
 *  - Tempo traces
 *  - Cloudwatch (multi-account)
 *
 * For Loki/Tempo we proxy through `${stack}/api/datasources/proxy/uid/<uid>`,
 * which lets the same token reach all backends without storing per-datasource
 * credentials.
 */

const STACK_URL = process.env.GRAFANA_STACK_URL?.trim().replace(/\/$/, "") || "";
const TOKEN = process.env.GRAFANA_TOKEN?.trim() || "";

// Cached datasource list (uid + name + type)
let dsCache: { at: number; list: GrafanaDatasource[] } | null = null;
const DS_CACHE_MS = 30 * 60 * 1000;

export interface GrafanaDatasource {
  uid: string;
  name: string;
  type: string;
}

export interface GrafanaProxyStatus {
  ready: boolean;
  stackUrl: string | null;
  hasToken: boolean;
  missing: string[];
}

export function getGrafanaProxyStatus(): GrafanaProxyStatus {
  return {
    ready: Boolean(STACK_URL && TOKEN),
    stackUrl: STACK_URL || null,
    hasToken: Boolean(TOKEN),
    missing: [
      ...(STACK_URL ? [] : ["GRAFANA_STACK_URL"]),
      ...(TOKEN ? [] : ["GRAFANA_TOKEN"]),
    ],
  };
}

async function authedFetch(url: string, init?: RequestInit, timeoutMs = 20_000) {
  if (!STACK_URL || !TOKEN) {
    throw new Error("Grafana proxy not configured (GRAFANA_STACK_URL / GRAFANA_TOKEN)");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      headers: {
        ...(init?.headers || {}),
        Authorization: `Bearer ${TOKEN}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

export async function listDatasources(): Promise<GrafanaDatasource[]> {
  const now = Date.now();
  if (dsCache && now - dsCache.at < DS_CACHE_MS) return dsCache.list;
  const res = await authedFetch(`${STACK_URL}/api/datasources`);
  if (!res.ok) throw new Error(`Grafana datasources failed: ${res.status}`);
  const raw = (await res.json()) as Array<{ uid: string; name: string; type: string }>;
  const list = raw.map((d) => ({ uid: d.uid, name: d.name, type: d.type }));
  dsCache = { at: now, list };
  return list;
}

/** Resolve a datasource UID by type (uses the first matching org-scoped DS). */
export async function findDatasourceUid(type: string, namePattern?: RegExp): Promise<string | null> {
  const list = await listDatasources();
  // Prefer iskaylog org-scoped over demoinfra
  const candidates = list.filter((d) => d.type === type && (!namePattern || namePattern.test(d.name)));
  if (candidates.length === 0) return null;
  // Prefer "iskaylog" name and avoid "demoinfra"
  const preferred = candidates.find((d) => /iskaylog/i.test(d.name) && !/demoinfra/i.test(d.name));
  if (preferred) return preferred.uid;
  const nonDemo = candidates.find((d) => !/demoinfra/i.test(d.name));
  if (nonDemo) return nonDemo.uid;
  return candidates[0].uid;
}

// ──────────────────────────────────────────────────────────────────────────
// Loki
// ──────────────────────────────────────────────────────────────────────────

export interface LokiQueryResult {
  resultType: "streams" | "matrix" | "vector";
  result: Array<{ stream?: Record<string, string>; metric?: Record<string, string>; values: [string, string][] }>;
}

let lokiUidCache: { at: number; uid: string } | null = null;

export async function getLokiUid(): Promise<string> {
  const now = Date.now();
  if (lokiUidCache && now - lokiUidCache.at < DS_CACHE_MS) return lokiUidCache.uid;
  const uid = await findDatasourceUid("loki", /iskaylog-logs/i);
  if (!uid) throw new Error("Loki datasource not found in Grafana");
  lokiUidCache = { at: now, uid };
  return uid;
}

/** Run a Loki LogQL query (range). Returns raw streams. */
export async function lokiQueryRange(
  query: string,
  options: { start?: Date; end?: Date; limit?: number; direction?: "forward" | "backward" } = {},
): Promise<LokiQueryResult> {
  const uid = await getLokiUid();
  const end = options.end || new Date();
  const start = options.start || new Date(end.getTime() - 60 * 60 * 1000);
  const limit = Math.max(1, Math.min(5000, options.limit || 1000));
  const params = new URLSearchParams({
    query,
    start: String(start.getTime() * 1_000_000), // ns
    end: String(end.getTime() * 1_000_000),
    limit: String(limit),
    direction: options.direction || "backward",
  });

  const url = `${STACK_URL}/api/datasources/proxy/uid/${uid}/loki/api/v1/query_range?${params}`;
  const res = await authedFetch(url, undefined, 30_000);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Loki query failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { status: string; data: LokiQueryResult; error?: string };
  if (json.status !== "success") throw new Error(json.error || "Loki query did not succeed");
  return json.data;
}

/** Loki instant query (current value, useful for metric queries on logs). */
export async function lokiQuery(
  query: string,
  options: { time?: Date; limit?: number } = {},
): Promise<LokiQueryResult> {
  const uid = await getLokiUid();
  const params = new URLSearchParams({
    query,
    limit: String(options.limit || 100),
  });
  if (options.time) params.set("time", String(options.time.getTime() * 1_000_000));

  const url = `${STACK_URL}/api/datasources/proxy/uid/${uid}/loki/api/v1/query?${params}`;
  const res = await authedFetch(url, undefined, 30_000);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Loki query failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { status: string; data: LokiQueryResult; error?: string };
  if (json.status !== "success") throw new Error(json.error || "Loki query did not succeed");
  return json.data;
}

export async function lokiLabelValues(label: string, options: { start?: Date; end?: Date } = {}): Promise<string[]> {
  const uid = await getLokiUid();
  const end = options.end || new Date();
  const start = options.start || new Date(end.getTime() - 6 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    start: String(Math.floor(start.getTime() / 1000)),
    end: String(Math.floor(end.getTime() / 1000)),
  });
  const url = `${STACK_URL}/api/datasources/proxy/uid/${uid}/loki/api/v1/label/${encodeURIComponent(label)}/values?${params}`;
  const res = await authedFetch(url);
  if (!res.ok) throw new Error(`Loki label values failed: ${res.status}`);
  const json = (await res.json()) as { status: string; data?: string[] };
  return json.data || [];
}

// ──────────────────────────────────────────────────────────────────────────
// Tempo
// ──────────────────────────────────────────────────────────────────────────

let tempoUidCache: { at: number; uid: string } | null = null;

export async function getTempoUid(): Promise<string> {
  const now = Date.now();
  if (tempoUidCache && now - tempoUidCache.at < DS_CACHE_MS) return tempoUidCache.uid;
  const uid = await findDatasourceUid("tempo", /iskaylog-traces/i);
  if (!uid) throw new Error("Tempo datasource not found in Grafana");
  tempoUidCache = { at: now, uid };
  return uid;
}

export interface TempoTraceSummary {
  traceID: string;
  rootServiceName: string;
  rootTraceName: string;
  startTimeUnixNano: string;
  durationMs: number;
  spanCount?: number;
}

/** Search traces via Tempo using TraceQL. */
export async function tempoSearch(
  q: string,
  options: { start?: Date; end?: Date; limit?: number } = {},
): Promise<TempoTraceSummary[]> {
  const uid = await getTempoUid();
  const end = options.end || new Date();
  const start = options.start || new Date(end.getTime() - 60 * 60 * 1000);
  const params = new URLSearchParams({
    q,
    start: String(Math.floor(start.getTime() / 1000)),
    end: String(Math.floor(end.getTime() / 1000)),
    limit: String(Math.max(1, Math.min(100, options.limit || 20))),
  });

  const url = `${STACK_URL}/api/datasources/proxy/uid/${uid}/api/search?${params}`;
  const res = await authedFetch(url, undefined, 30_000);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tempo search failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { traces?: any[] };
  return (json.traces || []).map((t) => ({
    traceID: t.traceID,
    rootServiceName: t.rootServiceName,
    rootTraceName: t.rootTraceName,
    startTimeUnixNano: t.startTimeUnixNano,
    durationMs: Number(t.durationMs ?? 0),
    spanCount: t.spanCount,
  }));
}

export async function tempoGetTrace(traceId: string): Promise<unknown> {
  const uid = await getTempoUid();
  const url = `${STACK_URL}/api/datasources/proxy/uid/${uid}/api/traces/${encodeURIComponent(traceId)}`;
  const res = await authedFetch(url, undefined, 30_000);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Tempo trace fetch failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.json();
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

export interface LogStreamHit {
  labels: Record<string, string>;
  timestampNs: string;
  line: string;
}

/** Flatten Loki streams into a chronological array of log lines. */
export function flattenLokiStreams(result: LokiQueryResult): LogStreamHit[] {
  if (result.resultType !== "streams") return [];
  const out: LogStreamHit[] = [];
  for (const stream of result.result) {
    const labels = stream.stream || {};
    for (const [ts, line] of stream.values) {
      out.push({ labels, timestampNs: ts, line });
    }
  }
  out.sort((a, b) => (a.timestampNs > b.timestampNs ? 1 : -1));
  return out;
}
