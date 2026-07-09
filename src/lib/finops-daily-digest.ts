/**
 * Daily FinOps digest.
 *
 * Generates a concise, DETERMINISTIC daily FinOps summary (no Bedrock / no heavy
 * advisor) and publishes it to a dedicated Teams channel via FINOPS_TEAMS_WEBHOOK_URL.
 *
 * What it reports (req: "lo que se gastó ayer, lo que va de mes, y la comparativa con
 * los mismos días del mes anterior, destacando subidas fuertes / cargos grandes"):
 *  - Yesterday's spend.
 *  - Month-to-date spend.
 *  - Same-days-last-month comparison (day 1..today-of-prev-month) with % delta.
 *  - Highlights: top movers (services that jumped vs the previous period) and anomalous
 *    days (μ+2σ). Big one-off charges like the Grafana marketplace bill surface here.
 *  - AWS news of the last 24h (reused from aws-health.ts).
 *
 * Data source: the existing FinOps Lambda relay (`callFinOpsLambda`, path 1) which
 * already returns dailyCosts, topMovers, anomalies and monthlyTrend — same source the
 * Costs tab uses. No new AWS plumbing.
 *
 * Contract (design Correctness Properties):
 *  - Property 9: NEVER throws on a partial failure. Every external call is wrapped;
 *    failures accumulate in `errors[]`. If the cost summary fails but there are AWS
 *    news, it still sends the news and returns { finopsSent:false, newsSent:true }.
 *  - Property 10: sent EXCLUSIVELY to FINOPS_TEAMS_WEBHOOK_URL (req 6.1: from env,
 *    never hardcoded; never the SRE TEAMS_WEBHOOK_URL).
 *
 * Pure shaping helpers (resolveDigestMode, costWindows, buildFinopsSummary, card
 * builders) have no I/O so they can be unit/property tested in isolation; the
 * orchestration takes an injectable dependency bag for the same reason.
 */

import { getAwsNews, type AwsNewsItem } from "@/lib/aws-health";
import { sendTeamsCard, buildDigestCard, type DigestFact } from "@/lib/teams-notify";
import { fetchAwsAccountCatalog, filterLiveAwsAccounts } from "@/lib/aws-account-catalog";

/** FinOps dashboard the digest links back to. Overridable via env. */
const DEFAULT_FINOPS_DASHBOARD_URL = "https://portal.today.tooling.dp.iskaypet.com/finops";

/** Portal home — where the admin AWS news sidebar lives. The news card links here. */
const PORTAL_HOME_URL = "https://portal.today.tooling.dp.iskaypet.com";

/** FinOps Lambda relay (path 1) — same default as the rest of the portal. */
const FINOPS_ATHENA_LAMBDA_URL =
  process.env.FINOPS_ATHENA_LAMBDA_URL ||
  "https://jzcrsycqa2plblvxdeck37r6am0kxeqw.lambda-url.eu-north-1.on.aws/";

/** A service jump above this absolute USD delta is always highlighted (catches big
 *  one-off charges like the Grafana marketplace bill). */
const BIG_CHARGE_USD = 5_000;

export type DigestMode = "single" | "split";

export interface DigestResult {
  finopsSent: boolean;
  newsSent: boolean;
  mode: DigestMode;
  errors: string[];
}

/** Normalised cost figures the card is built from (computed, deterministic). */
export interface FinopsSummary {
  yesterday: { date: string; cost: number };
  monthToDate: { startDate: string; endDate: string; cost: number };
  prevMonthSameDays: { startDate: string; endDate: string; cost: number };
  momDeltaAbs: number;          // monthToDate - prevMonthSameDays (total)
  momDeltaPct: number | null;   // null when prev is 0
  /** Run-rate projection to the end of the current month (MTD extrapolated). */
  projection: { daysElapsed: number; daysInMonth: number; runRateDaily: number; monthEnd: number };
  /** Infrastructure cost (total minus marketplace/contract prepays), with its own
   *  clean MoM — this is the headline figure, undistorted by the day-1 annual bill. */
  infra: { mtd: number; prev: number; deltaAbs: number; deltaPct: number | null };
  /** Marketplace / annual-contract prepays, separated so they never distort the MoM. */
  marketplace: { mtd: number; prev: number; deltaAbs: number };
  /** Top accounts by month-to-date spend (where the money concentrates). */
  topAccounts: Array<{ label: string; cost: number }>;
  topMovers: Array<{ label: string; deltaAbs: number; deltaPct: number | null }>;
  anomalies: Array<{ date: string; cost: number; deviation: number }>;
}

/** Label used to group marketplace/annual-contract spend (see `prettyService`). */
const MARKETPLACE_LABEL = "Marketplace (contrato)";

/* ------------------------------------------------------------------ */
/*  Pure helpers (no I/O)                                              */
/* ------------------------------------------------------------------ */

/** Resolves the digest mode from a raw env value. TOTAL: anything other than the exact
 *  string "single" (case-insensitive) maps to the default "split". */
export function resolveDigestMode(raw: string | undefined | null): DigestMode {
  return String(raw ?? "").trim().toLowerCase() === "single" ? "single" : "split";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function ymd(d: Date): string {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * Computes the date windows the digest needs, from "now":
 *  - yesterday (single day),
 *  - month-to-date (1st .. yesterday of the current month),
 *  - same days of the previous month (1st .. same day-of-month as yesterday),
 *    clamped to the previous month's length.
 * Pure and deterministic for a given `now`.
 */
export function costWindows(now: Date): {
  yesterday: string;
  mtdStart: string;
  mtdEnd: string;
  prevStart: string;
  prevEnd: string;
} {
  // Yesterday (UTC).
  const y = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = ymd(y);

  const mtdStart = `${y.getUTCFullYear()}-${pad2(y.getUTCMonth() + 1)}-01`;
  const mtdEnd = yesterday;

  // Previous month, same day-of-month span (clamped to prev month length).
  const dayOfMonth = y.getUTCDate();
  const prevMonthDate = new Date(Date.UTC(y.getUTCFullYear(), y.getUTCMonth(), 1));
  prevMonthDate.setUTCMonth(prevMonthDate.getUTCMonth() - 1);
  const prevYear = prevMonthDate.getUTCFullYear();
  const prevMonth = prevMonthDate.getUTCMonth(); // 0-based
  const prevMonthLen = new Date(Date.UTC(prevYear, prevMonth + 1, 0)).getUTCDate();
  const prevEndDay = Math.min(dayOfMonth, prevMonthLen);
  const prevStart = `${prevYear}-${pad2(prevMonth + 1)}-01`;
  const prevEnd = `${prevYear}-${pad2(prevMonth + 1)}-${pad2(prevEndDay)}`;

  return { yesterday, mtdStart, mtdEnd, prevStart, prevEnd };
}

/** Formats a USD amount, compact for big numbers. */
export function fmtUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 1000) return `${sign}$${(abs / 1000).toLocaleString("es-ES", { maximumFractionDigits: 1 })}k`;
  return `${sign}$${abs.toLocaleString("es-ES", { maximumFractionDigits: 2 })}`;
}

function fmtPct(pct: number | null): string {
  if (pct === null || !Number.isFinite(pct)) return "n/d";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function arrow(delta: number): string {
  if (delta > 0) return "🔺";
  if (delta < 0) return "🔻";
  return "▪️";
}

/** Builds the Spanish markdown body for the FinOps summary. Pure. */
export function buildFinopsMarkdown(s: FinopsSummary): string {
  const lines: string[] = [];

  lines.push(`**💸 Ayer (${s.yesterday.date}):** ${fmtUsd(s.yesterday.cost)}`);
  lines.push(
    `**📅 Mes a fecha:** ${fmtUsd(s.monthToDate.cost)} · ` +
      `**proyección fin de mes ≈ ${fmtUsd(s.projection.monthEnd)}** ` +
      `(ritmo ${fmtUsd(s.projection.runRateDaily)}/día · ${s.projection.daysElapsed}/${s.projection.daysInMonth} días)`,
  );

  // Infra-led MoM (clean). Marketplace/annual contracts are shown apart so the
  // day-1 prepay never turns the headline into a misleading −100%.
  lines.push("");
  lines.push(
    `**🏗️ Infraestructura (sin contratos):** ${fmtUsd(s.infra.mtd)} ` +
      `(${arrow(s.infra.deltaAbs)} ${fmtUsd(s.infra.deltaAbs)} · ${fmtPct(s.infra.deltaPct)} vs mismos días mes anterior)`,
  );
  if (s.marketplace.mtd !== 0 || s.marketplace.prev !== 0) {
    lines.push(
      `**🛒 Marketplace/contratos:** ${fmtUsd(s.marketplace.mtd)} ` +
        `(mes anterior ${fmtUsd(s.marketplace.prev)} — prepago anual el día 1, no es ahorro real)`,
    );
  }

  if (s.topAccounts.length > 0) {
    lines.push("");
    lines.push("**🏦 Dónde se concentra (top cuentas, mes a fecha):**");
    for (const a of s.topAccounts) lines.push(`- ${a.label}: ${fmtUsd(a.cost)}`);
  }

  if (s.topMovers.length > 0) {
    lines.push("");
    lines.push("**📈 Mayores variaciones vs el mes anterior (mismos días):**");
    for (const m of s.topMovers) {
      const note = m.label === MARKETPLACE_LABEL ? " _(contrato anual, no infra)_" : "";
      lines.push(`- ${arrow(m.deltaAbs)} ${m.label}: ${fmtUsd(m.deltaAbs)} (${fmtPct(m.deltaPct)})${note}`);
    }
  }

  if (s.anomalies.length > 0) {
    lines.push("");
    lines.push("**⚠️ Días con coste anómalo (μ+2σ):**");
    for (const a of s.anomalies) {
      lines.push(`- ${a.date}: ${fmtUsd(a.cost)} (${a.deviation.toFixed(1)}σ sobre la media)`);
    }
  }

  return lines.join("\n");
}

/** Builds the FactSet for the FinOps summary card — a non-redundant TL;DR of the
 *  rate view (the headline numbers already live in the markdown body). Pure. */
export function buildFinopsFacts(s: FinopsSummary): DigestFact[] {
  return [{ name: "Ritmo diario", value: `${fmtUsd(s.projection.runRateDaily)}/día` }];
}

const SEVERITY_LABEL: Record<AwsNewsItem["severity"], string> = {
  alta: "🔴 Alta",
  media: "🟠 Media",
  baja: "🟢 Baja",
};

const CATEGORY_LABEL: Record<AwsNewsItem["category"], string> = {
  issue: "incidencia",
  scheduledChange: "cambio programado",
  accountNotification: "notificación",
};

/** Builds the Spanish markdown body listing AWS news (or an explicit "no news" line).
 *  Groups repeated events (same service+category+severity+accounts) into one line with
 *  a ×N counter, so floods of identical VPN/notification events don't bury the card. */
export function buildNewsMarkdown(news: AwsNewsItem[], maxItems = 12): string {
  if (!Array.isArray(news) || news.length === 0) {
    return "**Sin novedades de AWS en las últimas 24h.**";
  }

  // Group by (severity, service, category, accounts) preserving first-seen order.
  const groups: Array<{ item: AwsNewsItem; accounts: string; count: number }> = [];
  const index = new Map<string, number>();
  for (const item of news) {
    const accounts =
      item.affectedAccounts.length > 0 ? item.affectedAccounts.map((a) => a.accountName).join(", ") : "—";
    const key = `${item.severity}|${item.service}|${item.category}|${accounts}`;
    const existing = index.get(key);
    if (existing !== undefined) {
      groups[existing].count += 1;
    } else {
      index.set(key, groups.length);
      groups.push({ item, accounts, count: 1 });
    }
  }

  // Order by severity (alta → media → baja), then by group size — so high-impact
  // events lead and floods of identical low-severity notices sink to the bottom.
  const SEV_RANK: Record<AwsNewsItem["severity"], number> = { alta: 0, media: 1, baja: 2 };
  groups.sort(
    (a, b) => (SEV_RANK[a.item.severity] - SEV_RANK[b.item.severity]) || b.count - a.count,
  );

  const lines = groups.slice(0, maxItems).map(({ item, accounts, count }) => {
    const sev = SEVERITY_LABEL[item.severity] ?? item.severity;
    const cat = CATEGORY_LABEL[item.category] ?? item.category;
    const region = item.region ? ` · ${item.region}` : "";
    const multiplier = count > 1 ? ` **×${count}**` : "";
    return `- **${sev}** ${item.service} (${cat})${region} · ${accounts}${multiplier}`;
  });

  const header = `**${news.length} novedades AWS (últimas 24h):**`;
  // Lead with an attention line when any high-severity event is present.
  const altaCount = news.filter((n) => n.severity === "alta").length;
  const attention =
    altaCount > 0
      ? `**🔴 ${altaCount} novedad(es) de severidad ALTA — requieren atención.**\n\n`
      : "";
  const overflow =
    groups.length > maxItems ? `\n\n_…y ${groups.length - maxItems} grupo(s) más. Ver el detalle en el portal._` : "";
  return `${attention}${header}\n\n${lines.join("\n")}${overflow}`;
}

/** Builds the FactSet for the AWS news card (counts by severity). Pure. */
export function buildNewsFacts(news: AwsNewsItem[]): DigestFact[] {
  if (!Array.isArray(news) || news.length === 0) return [];
  const counts: Record<AwsNewsItem["severity"], number> = { alta: 0, media: 0, baja: 0 };
  for (const item of news) if (item.severity in counts) counts[item.severity] += 1;
  return [
    { name: "Total novedades", value: String(news.length) },
    { name: "Por severidad", value: `${counts.alta} alta · ${counts.media} media · ${counts.baja} baja` },
  ];
}

/* ------------------------------------------------------------------ */
/*  Card assembly (pure)                                               */
/* ------------------------------------------------------------------ */

export function buildFinopsCard(
  summary: FinopsSummary,
  newsCount: number,
  dashboardUrl: string,
): Record<string, unknown> {
  const facts = buildFinopsFacts(summary);
  facts.push({
    name: "Novedades AWS",
    value: newsCount > 0 ? `${newsCount} en las últimas 24h` : "Sin novedades (24h)",
  });
  return buildDigestCard({
    title: "📊 Resumen FinOps diario",
    markdownSummary: buildFinopsMarkdown(summary),
    facts,
    linkUrl: dashboardUrl,
  });
}

export function buildNewsCard(news: AwsNewsItem[], homeUrl: string): Record<string, unknown> {
  return buildDigestCard({
    title: "☁️ Novedades AWS (últimas 24h)",
    markdownSummary: buildNewsMarkdown(news),
    facts: buildNewsFacts(news),
    linkUrl: homeUrl,
    linkLabel: "Ver en el portal",
  });
}

export function buildSingleCard(
  summary: FinopsSummary | null,
  news: AwsNewsItem[],
  dashboardUrl: string,
): Record<string, unknown> {
  const parts: string[] = [];
  let facts: DigestFact[] = [];
  if (summary) {
    parts.push(buildFinopsMarkdown(summary));
    facts = buildFinopsFacts(summary);
  }
  parts.push(`### ☁️ Novedades AWS (24h)\n\n${buildNewsMarkdown(news)}`);
  return buildDigestCard({
    title: "📊 Resumen FinOps diario",
    markdownSummary: parts.join("\n\n---\n\n"),
    facts,
    linkUrl: dashboardUrl,
  });
}

/* ------------------------------------------------------------------ */
/*  Summary computation from Lambda responses (pure given the inputs)  */
/* ------------------------------------------------------------------ */

/** Maps a raw CUR/Lambda service code to a friendly label. The Lambda leaves some
 *  values as opaque ids: marketplace contracts come as `cg…` product codes, and Bedrock
 *  inference profiles as random 25-char ids. Pure. */
export function prettyService(raw: string): string {
  const name = String(raw || "").trim();
  if (!name) return "Otros";
  // Marketplace contracts (annual prepaid, e.g. Grafana) — product codes start with "cg".
  if (/^cg[a-z0-9]{10,}$/i.test(name)) return "Marketplace (contrato)";
  // Bedrock inference-profile ids: 25-ish lowercase alphanumerics, no AWS prefix.
  if (/^[a-z0-9]{20,}$/i.test(name) && !/^amazon|^aws/i.test(name)) return "Bedrock (GenAI)";
  // Tidy the common AWS prefixes.
  return name.replace(/^Amazon/, "").replace(/^AWS/, "").trim() || name;
}

/** Sums per-service costs from a Lambda `costs` response into a map. */
function serviceTotals(payload: any): Map<string, number> {
  const map = new Map<string, number>();
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  for (const a of accounts) {
    for (const s of Array.isArray(a?.services) ? a.services : []) {
      const name = String(s?.name || "Unknown");
      const cost = Number(s?.cost || 0);
      if (Number.isFinite(cost)) map.set(name, (map.get(name) || 0) + cost);
    }
  }
  return map;
}

function totalOf(payload: any): number {
  const t = Number(payload?.summary?.totalCost || 0);
  return Number.isFinite(t) ? t : 0;
}

/** Sums per-account totals from a Lambda `costs` response into a label→cost map.
 *  Account total = sum of its services (robust to a missing `totalCost`). */
function accountTotals(payload: any): Map<string, number> {
  const map = new Map<string, number>();
  const accounts = Array.isArray(payload?.accounts) ? payload.accounts : [];
  for (const a of accounts) {
    const label = String(a?.accountName || a?.name || a?.accountId || "Cuenta");
    const explicit = Number(a?.totalCost);
    const cost = Number.isFinite(explicit) && explicit !== 0
      ? explicit
      : (Array.isArray(a?.services) ? a.services : []).reduce(
          (s: number, x: any) => s + (Number(x?.cost) || 0),
          0,
        );
    if (Number.isFinite(cost)) map.set(label, (map.get(label) || 0) + cost);
  }
  return map;
}

/** Total marketplace/annual-contract spend in a payload (grouped via `prettyService`). */
function marketplaceTotal(payload: any): number {
  let sum = 0;
  for (const [svc, cost] of serviceTotals(payload)) {
    if (prettyService(svc) === MARKETPLACE_LABEL) sum += cost;
  }
  return Math.round(sum * 100) / 100;
}

/**
 * Run-rate projection of the current month from the MTD spend. `daysElapsed` is the
 * day-of-month of the MTD end (yesterday); `daysInMonth` the length of that month.
 * Pure. `daysElapsed` is always >= 1 (costWindows never yields an empty MTD).
 */
export function monthProjection(
  windows: ReturnType<typeof costWindows>,
  mtdCost: number,
): { daysElapsed: number; daysInMonth: number; runRateDaily: number; monthEnd: number } {
  const [yStr, mStr, dStr] = windows.mtdEnd.split("-");
  const year = Number(yStr);
  const month = Number(mStr); // 1-12
  const daysElapsed = Math.max(1, Number(dStr));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const runRateDaily = Math.round((mtdCost / daysElapsed) * 100) / 100;
  const monthEnd = Math.round(runRateDaily * daysInMonth * 100) / 100;
  return { daysElapsed, daysInMonth, runRateDaily, monthEnd };
}

/**
 * Computes the deterministic FinOps summary from the three Lambda responses
 * (yesterday, month-to-date, previous-month-same-days) and the MTD anomalies.
 * Pure: no I/O. Highlights services with the biggest absolute jump vs the previous
 * period, always surfacing jumps above BIG_CHARGE_USD (e.g. the Grafana bill).
 */
export function buildFinopsSummary(
  windows: ReturnType<typeof costWindows>,
  yesterdayPayload: any,
  mtdPayload: any,
  prevPayload: any,
): FinopsSummary {
  const mtdCost = totalOf(mtdPayload);
  const prevCost = totalOf(prevPayload);
  const momDeltaAbs = Math.round((mtdCost - prevCost) * 100) / 100;
  const momDeltaPct = prevCost > 0 ? (momDeltaAbs / prevCost) * 100 : null;

  // Top movers by friendly service: MTD vs previous-month-same-days. Grouping by the
  // pretty label folds the opaque Bedrock/marketplace ids into a single readable row.
  const cur = new Map<string, number>();
  const prev = new Map<string, number>();
  for (const [svc, cost] of serviceTotals(mtdPayload)) {
    const k = prettyService(svc);
    cur.set(k, (cur.get(k) || 0) + cost);
  }
  for (const [svc, cost] of serviceTotals(prevPayload)) {
    const k = prettyService(svc);
    prev.set(k, (prev.get(k) || 0) + cost);
  }
  const allServices = new Set<string>([...cur.keys(), ...prev.keys()]);
  const movers = [...allServices]
    .map((label) => {
      const c = cur.get(label) || 0;
      const p = prev.get(label) || 0;
      const deltaAbs = Math.round((c - p) * 100) / 100;
      const deltaPct = p > 0 ? (deltaAbs / p) * 100 : null;
      return { label, deltaAbs, deltaPct };
    })
    // Keep meaningful moves (up or down): a big absolute swing, or a notable relative one.
    .filter(
      (m) =>
        Math.abs(m.deltaAbs) >= BIG_CHARGE_USD ||
        (Math.abs(m.deltaAbs) >= 500 && (m.deltaPct === null || Math.abs(m.deltaPct) >= 30)),
    )
    .sort((a, b) => Math.abs(b.deltaAbs) - Math.abs(a.deltaAbs))
    .slice(0, 6);

  // Anomalies: prefer the Lambda's flagged days for the MTD window.
  const flagged = Array.isArray(mtdPayload?.anomalies?.flaggedDays) ? mtdPayload.anomalies.flaggedDays : [];
  const anomalies = flagged
    .map((a: any) => ({
      date: String(a?.day || a?.date || ""),
      cost: Number(a?.cost || 0),
      deviation: Number(a?.deviation || 0),
    }))
    .filter((a: any) => a.date)
    .slice(0, 5);

  // Infra vs marketplace split — the headline MoM uses infra so the day-1 annual
  // contract prepay (e.g. Grafana) never distorts it.
  const mktMtd = marketplaceTotal(mtdPayload);
  const mktPrev = marketplaceTotal(prevPayload);
  const infraMtd = Math.round((mtdCost - mktMtd) * 100) / 100;
  const infraPrev = Math.round((prevCost - mktPrev) * 100) / 100;
  const infraDeltaAbs = Math.round((infraMtd - infraPrev) * 100) / 100;
  const infraDeltaPct = infraPrev > 0 ? (infraDeltaAbs / infraPrev) * 100 : null;

  // Top accounts by MTD spend — "where the money concentrates".
  const topAccounts = [...accountTotals(mtdPayload).entries()]
    .map(([label, cost]) => ({ label, cost: Math.round(cost * 100) / 100 }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 3);

  const projection = monthProjection(windows, mtdCost);

  return {
    yesterday: { date: windows.yesterday, cost: totalOf(yesterdayPayload) },
    monthToDate: { startDate: windows.mtdStart, endDate: windows.mtdEnd, cost: mtdCost },
    prevMonthSameDays: { startDate: windows.prevStart, endDate: windows.prevEnd, cost: prevCost },
    momDeltaAbs,
    momDeltaPct,
    projection,
    infra: { mtd: infraMtd, prev: infraPrev, deltaAbs: infraDeltaAbs, deltaPct: infraDeltaPct },
    marketplace: { mtd: mktMtd, prev: mktPrev, deltaAbs: Math.round((mktMtd - mktPrev) * 100) / 100 },
    topAccounts,
    topMovers: movers,
    anomalies,
  };
}

/* ------------------------------------------------------------------ */
/*  Orchestration (I/O, with an injectable dependency seam)            */
/* ------------------------------------------------------------------ */

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Unwraps a Lambda URL payload that may be `{ statusCode, body }` (body as JSON string
 *  or object), matching parseLambdaPayload in finops-tools.ts. */
function parseLambdaPayload(payload: unknown): any {
  if (typeof payload !== "object" || payload === null) return {};
  const wrapped = payload as { body?: unknown };
  if (typeof wrapped.body === "string") {
    try {
      return JSON.parse(wrapped.body);
    } catch {
      return {};
    }
  }
  if (typeof wrapped.body === "object" && wrapped.body !== null) return wrapped.body;
  return payload;
}

/** Calls the FinOps Lambda relay (path 1) for a cost window over the given accounts. */
async function callFinOpsLambda(startDate: string, endDate: string, accountIds: string[]): Promise<any> {
  const res = await fetch(FINOPS_ATHENA_LAMBDA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "costs",
      query: { accountIds: accountIds.join(","), startDate, endDate, includeTrends: true },
    }),
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`FinOps lambda ${res.status}: ${text.slice(0, 200)}`);
  }
  return parseLambdaPayload(await res.json());
}

/** Resolves the scope: ids of all live AWS accounts (same default as the Costs tab). */
async function resolveLiveAccountIds(): Promise<string[]> {
  const catalog = await fetchAwsAccountCatalog();
  return filterLiveAwsAccounts(catalog).map((a) => a.id);
}

export interface DigestDependencies {
  /** Resolves the scope: ids of all live AWS accounts. */
  resolveAccountIds: () => Promise<string[]>;
  /** Fetches a cost window from the FinOps source for the given accounts. Raw payload. */
  fetchCosts: (startDate: string, endDate: string, accountIds: string[]) => Promise<any>;
  /** Fetches recent AWS news. */
  fetchNews: (opts: { sinceHours: number; includeClosed: boolean }) => Promise<AwsNewsItem[]>;
  /** Sends an Adaptive Card to a webhook (must never throw). */
  sendCard: (card: Record<string, unknown>, webhookUrl: string | undefined) => Promise<boolean>;
  /** The ONLY webhook the digest is allowed to use (FINOPS_TEAMS_WEBHOOK_URL). */
  webhookUrl: string | undefined;
  mode: DigestMode;
  dashboardUrl: string;
  /** Portal home URL — the AWS news card links here (sidebar lives on the home). */
  homeUrl: string;
  now: () => Date;
}

function defaultDependencies(): DigestDependencies {
  return {
    resolveAccountIds: () => resolveLiveAccountIds(),
    fetchCosts: (startDate, endDate, accountIds) => callFinOpsLambda(startDate, endDate, accountIds),
    fetchNews: (opts) => getAwsNews(opts),
    sendCard: (card, webhookUrl) => sendTeamsCard(card, webhookUrl),
    webhookUrl: process.env.FINOPS_TEAMS_WEBHOOK_URL,
    mode: resolveDigestMode(process.env.FINOPS_DIGEST_MODE),
    dashboardUrl: process.env.FINOPS_DASHBOARD_URL || DEFAULT_FINOPS_DASHBOARD_URL,
    homeUrl: process.env.PORTAL_HOME_URL || PORTAL_HOME_URL,
    now: () => new Date(),
  };
}

async function safeSend(
  deps: DigestDependencies,
  card: Record<string, unknown>,
  errors: string[],
  label: string,
): Promise<boolean> {
  try {
    const ok = await deps.sendCard(card, deps.webhookUrl);
    if (!ok) errors.push(`teams: ${label} not delivered`);
    return ok;
  } catch (err) {
    errors.push(`teams: ${label} send error: ${errMessage(err)}`);
    return false;
  }
}

/**
 * Generates and publishes the daily FinOps digest. Deterministic (no Bedrock).
 * Never throws on a partial failure (Property 9); sent only to FINOPS_TEAMS_WEBHOOK_URL
 * (Property 10). `deps` is for testing; production callers invoke it with no arguments.
 */
export async function runDailyFinOpsDigest(
  deps: Partial<DigestDependencies> = {},
): Promise<DigestResult> {
  const d: DigestDependencies = { ...defaultDependencies(), ...deps };
  const errors: string[] = [];
  const w = costWindows(d.now());

  // 1. Cost summary (deterministic, from the Lambda relay). Failure is non-fatal.
  let summary: FinopsSummary | null = null;
  try {
    const accountIds = await d.resolveAccountIds();
    if (accountIds.length === 0) throw new Error("no live accounts resolved");
    const [yesterdayPayload, mtdPayload, prevPayload] = await Promise.all([
      d.fetchCosts(w.yesterday, w.yesterday, accountIds),
      d.fetchCosts(w.mtdStart, w.mtdEnd, accountIds),
      d.fetchCosts(w.prevStart, w.prevEnd, accountIds),
    ]);
    summary = buildFinopsSummary(w, yesterdayPayload, mtdPayload, prevPayload);
  } catch (err) {
    errors.push(`finops summary: ${errMessage(err)}`);
  }

  // 2. AWS news (last 24h, excluding closed).
  let news: AwsNewsItem[] = [];
  try {
    news = await d.fetchNews({ sinceHours: 24, includeClosed: false });
  } catch (err) {
    errors.push(`aws news: ${errMessage(err)}`);
  }

  const hasSummary = summary !== null;
  const hasNews = news.length > 0;

  let finopsSent = false;
  let newsSent = false;

  if (!d.webhookUrl) {
    errors.push("FINOPS_TEAMS_WEBHOOK_URL not configured; nothing sent");
    return { finopsSent, newsSent, mode: d.mode, errors };
  }

  if (d.mode === "single") {
    if (hasSummary || hasNews) {
      const card = buildSingleCard(summary, news, d.dashboardUrl);
      const ok = await safeSend(d, card, errors, "digest card");
      finopsSent = ok && hasSummary;
      newsSent = ok && hasNews;
    }
  } else {
    if (hasSummary) {
      const card = buildFinopsCard(summary as FinopsSummary, news.length, d.dashboardUrl);
      finopsSent = await safeSend(d, card, errors, "finops card");
    }
    if (hasNews) {
      const card = buildNewsCard(news, d.homeUrl);
      newsSent = await safeSend(d, card, errors, "news card");
    }
  }

  return { finopsSent, newsSent, mode: d.mode, errors };
}
