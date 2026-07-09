/**
 * AWS news ingestion (AWS Health events via EventBridge -> SQS).
 *
 * The org is on Basic Support, so the paid AWS Health API is NOT used. Instead,
 * `aws.health` events are emitted to EventBridge in every account (free, no support
 * plan required), fanned-in cross-account to a central bus in dp-tooling, and routed
 * to the `portal-aws-health-events` SQS queue. This module polls that queue, upserts
 * the events into `aws_health_events` (idempotent by `arn`), and serves the admin-only
 * "AWS news" sidebar / the daily FinOps digest from the cache.
 *
 * Data sources (reused, not reinvented):
 *  - SQS: AWS_HEALTH_QUEUE_URL, read with the portal IRSA (queue lives in the portal's
 *    own dp-tooling account, no AssumeRole needed).
 *  - Account names: buildAwsAccountNameMap(fetchAwsAccountCatalog()) from
 *    aws-account-catalog.ts.
 *
 * Persistence: aws_health_events, upsert by `arn` (preserves `first_seen`, merges
 * `affected_accounts`).
 *
 * The shaping helpers (inferSeverity, normalizeHealthEvent) are pure (no I/O) so they
 * can be unit/property tested in isolation against the design's correctness properties
 * (5: severity is deterministic and total; 6/8 cover the I/O upsert/degradation).
 *
 * Gotcha #5: AWS SDK clients are top-level imports (Next standalone), never lazy
 * require().
 */

import { createHash } from "node:crypto";
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageBatchCommand,
  type Message,
} from "@aws-sdk/client-sqs";

import pool from "@/lib/db";
import { fetchAwsAccountCatalog, buildAwsAccountNameMap } from "@/lib/aws-account-catalog";

const REGION = "eu-west-1";

/** Default cap of messages drained per sync run. */
const DEFAULT_MAX_MESSAGES = 100;

type Severity = "alta" | "media" | "baja";
type Category = "issue" | "scheduledChange" | "accountNotification";
type StatusCode = "open" | "upcoming" | "closed";

const KNOWN_CATEGORIES: ReadonlySet<string> = new Set([
  "issue",
  "scheduledChange",
  "accountNotification",
]);

export interface AwsNewsItem {
  /** Event ARN from the aws.health payload (stable). Falls back to a deterministic
   *  hash of (service + account + startTime + eventTypeCode) when absent. */
  arn: string;
  service: string;
  region: string | null;
  category: Category;
  statusCode: StatusCode;
  severity: Severity;
  startTime: string | null;
  endTime: string | null;
  lastUpdated: string | null;
  affectedAccounts: Array<{ accountId: string; accountName: string }>;
  description: string;
}

/* ------------------------------------------------------------------ */
/*  Pure helpers (no I/O) — tested in isolation                        */
/* ------------------------------------------------------------------ */

/**
 * Infers the display severity from the AWS Health category and status. TOTAL: it
 * always returns one of { alta, media, baja } for any input (Design Property 5).
 *
 * Rules:
 *  - any category with statusCode `closed`        -> baja (already resolved)
 *  - `issue` + `open`                             -> alta
 *  - `issue` + other open-ish status              -> media (still an incident, but not
 *                                                    confirmed open; conservative)
 *  - `scheduledChange` (not closed)               -> media
 *  - `accountNotification`                        -> baja
 *  - unknown / empty category                     -> baja
 */
export function inferSeverity(category: string, statusCode: string): Severity {
  const status = String(statusCode || "").toLowerCase();
  if (status === "closed") return "baja";

  switch (category) {
    case "issue":
      return status === "open" ? "alta" : "media";
    case "scheduledChange":
      return "media";
    case "accountNotification":
      return "baja";
    default:
      return "baja";
  }
}

/** Coerces an arbitrary category string to the typed union, defaulting unknown/empty
 *  values to `accountNotification` (the lowest-severity bucket) so the NOT NULL column
 *  is always satisfied. The raw value is still used for severity inference. */
function coerceCategory(raw: string): Category {
  return (KNOWN_CATEGORIES.has(raw) ? raw : "accountNotification") as Category;
}

/** Coerces a status string to the typed union; unknown/empty -> `open` (most visible). */
function coerceStatus(raw: string): StatusCode {
  const status = String(raw || "").toLowerCase();
  if (status === "open" || status === "upcoming" || status === "closed") {
    return status as StatusCode;
  }
  return "open";
}

/** Parses an AWS Health timestamp (ISO string, RFC-1123 string, or epoch seconds/ms)
 *  into an ISO-8601 string, or null when it cannot be parsed. */
function toIsoOrNull(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    // Heuristic: < 1e12 means epoch seconds, otherwise milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Extracts a human-readable description from the aws.health detail. */
function extractDescription(detail: any): string {
  const desc = detail?.eventDescription;
  if (Array.isArray(desc)) {
    return desc
      .map((d: any) => String(d?.latestDescription ?? "").trim())
      .filter(Boolean)
      .join("\n\n");
  }
  if (typeof desc === "string") return desc;
  if (typeof detail?.description === "string") return detail.description;
  return "";
}

/** Builds a deterministic synthetic ARN when the event has no `eventArn`. */
function syntheticArn(service: string, account: string, startTime: string | null, typeCode: string): string {
  const hash = createHash("sha1")
    .update([service, account, startTime ?? "", typeCode].join("|"))
    .digest("hex")
    .slice(0, 24);
  return `synthetic:aws-health:${hash}`;
}

/**
 * Normalizes a single aws.health detail (with the EventBridge envelope `account`
 * injected onto it) into an AwsNewsItem. Pure: no I/O, deterministic for a given
 * (detail, accountNameMap) pair.
 *
 * The originating account is read from `detail.account` (injected by the poller from
 * the EventBridge envelope) or `detail.affectedAccount`, mapped to a friendly name via
 * `accountNameMap`. When several deliveries of the same `eventArn` arrive from different
 * accounts, they are merged into `affectedAccounts` at upsert time (not here).
 */
export function normalizeHealthEvent(
  detail: any,
  accountNameMap: Record<string, string>,
): AwsNewsItem {
  const safeDetail = detail && typeof detail === "object" ? detail : {};

  const service = String(safeDetail.service || "unknown").trim() || "unknown";
  const region =
    safeDetail.eventRegion || safeDetail.region
      ? String(safeDetail.eventRegion || safeDetail.region)
      : null;

  const rawCategory = String(safeDetail.eventTypeCategory || safeDetail.category || "");
  const rawStatus = String(safeDetail.statusCode || "");

  const category = coerceCategory(rawCategory);
  const statusCode = coerceStatus(rawStatus);
  const severity = inferSeverity(rawCategory, rawStatus);

  const startTime = toIsoOrNull(safeDetail.startTime);
  const endTime = toIsoOrNull(safeDetail.endTime);
  const lastUpdated = toIsoOrNull(
    safeDetail.lastUpdatedTime ?? safeDetail.lastUpdated ?? safeDetail.eventLastUpdatedTime,
  );

  const eventTypeCode = String(safeDetail.eventTypeCode || "");

  const accountId = String(safeDetail.account || safeDetail.affectedAccount || "").trim();
  const affectedAccounts = accountId
    ? [{ accountId, accountName: accountNameMap[accountId] || accountId }]
    : [];

  const arn =
    String(safeDetail.eventArn || safeDetail.arn || "").trim() ||
    syntheticArn(service, accountId, startTime, eventTypeCode);

  return {
    arn,
    service,
    region,
    category,
    statusCode,
    severity,
    startTime,
    endTime,
    lastUpdated,
    affectedAccounts,
    description: extractDescription(safeDetail),
  };
}

/* ------------------------------------------------------------------ */
/*  SQS polling (I/O)                                                  */
/* ------------------------------------------------------------------ */

/** Internal carrier so the sync step can delete only successfully processed messages. */
interface PolledHealthMessage {
  item: AwsNewsItem;
  eventTypeCode: string | null;
  receiptHandle: string;
  messageId: string;
}

/** Extracts the EventBridge envelope + aws.health detail from an SQS message body,
 *  tolerating an SNS wrapping ({"Message": "<json>"}). Returns null on parse failure. */
function parseSqsBody(body: string | undefined): { envelope: any; detail: any } | null {
  if (!body) return null;
  let parsed: any;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  // SNS -> SQS wrapping: the EventBridge event is a JSON string under `Message`.
  if (parsed && typeof parsed.Message === "string" && !parsed.detail) {
    try {
      parsed = JSON.parse(parsed.Message);
    } catch {
      return null;
    }
  }
  const detail = parsed?.detail ?? parsed;
  return { envelope: parsed, detail };
}

/**
 * Receives and normalizes messages from the Health queue, retaining the receipt
 * handles so the caller can delete them after a successful upsert.
 *
 * Degradation: any error (queue missing, no permissions, parse error) is logged and the
 * function returns whatever was accumulated so far (possibly []). It never throws, so
 * the sync step never deletes/corrupts previously persisted rows on failure (Property 8).
 */
async function receiveHealthMessages(opts?: { maxMessages?: number }): Promise<PolledHealthMessage[]> {
  const queueUrl = process.env.AWS_HEALTH_QUEUE_URL;
  if (!queueUrl) {
    console.warn("[aws-health] AWS_HEALTH_QUEUE_URL not set; skipping poll (returning []).");
    return [];
  }

  const maxMessages = Math.max(1, opts?.maxMessages ?? DEFAULT_MAX_MESSAGES);
  const client = new SQSClient({ region: REGION });
  const collected: PolledHealthMessage[] = [];

  // Resolve account names once (best effort; degrade to id-as-name on failure).
  let accountNameMap: Record<string, string> = {};
  try {
    accountNameMap = buildAwsAccountNameMap(await fetchAwsAccountCatalog());
  } catch (err) {
    console.warn(
      "[aws-health] account catalog unavailable; using raw account ids:",
      err instanceof Error ? err.message : err,
    );
  }

  // Safety bound on iterations so a steadily-refilling queue can't loop forever.
  const maxIterations = Math.ceil(maxMessages / 10) + 2;

  try {
    for (let i = 0; i < maxIterations && collected.length < maxMessages; i++) {
      const resp = await client.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 5,
          VisibilityTimeout: 60,
        }),
      );

      const messages: Message[] = resp.Messages ?? [];
      if (messages.length === 0) break; // queue drained

      for (const message of messages) {
        if (!message.ReceiptHandle) continue;
        const parsed = parseSqsBody(message.Body);
        if (!parsed) {
          console.warn(`[aws-health] could not parse SQS message ${message.MessageId}; leaving in queue.`);
          continue;
        }
        // Inject the envelope account/region so normalize stays pure but account-aware.
        const detailWithContext = {
          ...parsed.detail,
          account: parsed.detail?.account ?? parsed.envelope?.account,
          region: parsed.detail?.eventRegion ?? parsed.detail?.region ?? parsed.envelope?.region,
        };
        const item = normalizeHealthEvent(detailWithContext, accountNameMap);
        collected.push({
          item,
          eventTypeCode: String(parsed.detail?.eventTypeCode || "") || null,
          receiptHandle: message.ReceiptHandle,
          messageId: message.MessageId || item.arn,
        });
      }
    }
  } catch (err) {
    console.error(
      "[aws-health] error polling SQS (degrading gracefully):",
      err instanceof Error ? err.message : err,
    );
    // Return whatever was safely collected; previous DB rows are never touched.
    return collected;
  }

  return collected;
}

/**
 * Polls the Health queue (SQS) and returns the normalized aws.health events. Does NOT
 * delete messages from the queue (use syncAwsHealthEvents to consume+persist+delete).
 * Degrades to [] on any error.
 */
export async function pollAwsHealthQueue(opts?: { maxMessages?: number }): Promise<AwsNewsItem[]> {
  const messages = await receiveHealthMessages(opts);
  return messages.map((m) => m.item);
}

/* ------------------------------------------------------------------ */
/*  Sync (poll + upsert + delete)                                      */
/* ------------------------------------------------------------------ */

/** Deletes a set of SQS messages in batches of 10 (best effort; logs failures). */
async function deleteMessages(client: SQSClient, queueUrl: string, messages: PolledHealthMessage[]): Promise<void> {
  for (let i = 0; i < messages.length; i += 10) {
    const chunk = messages.slice(i, i + 10);
    try {
      await client.send(
        new DeleteMessageBatchCommand({
          QueueUrl: queueUrl,
          Entries: chunk.map((m, idx) => ({ Id: String(idx), ReceiptHandle: m.receiptHandle })),
        }),
      );
    } catch (err) {
      console.error(
        "[aws-health] failed to delete processed SQS messages (will redeliver):",
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/**
 * Drains the Health queue and upserts the events into `aws_health_events` by `arn`
 * (merging affected_accounts and preserving first_seen), then deletes ONLY the messages
 * that were persisted successfully.
 *
 * Idempotent (Property 6): re-delivered events update the existing row instead of
 * duplicating. Non-destructive degradation (Property 8): if the poll fails or returns
 * nothing, no row is touched and no message is deleted.
 */
export async function syncAwsHealthEvents(): Promise<{ upserted: number; new: number }> {
  const messages = await receiveHealthMessages();
  if (messages.length === 0) {
    return { upserted: 0, new: 0 };
  }

  const queueUrl = process.env.AWS_HEALTH_QUEUE_URL!;
  const client = new SQSClient({ region: REGION });

  let upserted = 0;
  let added = 0;
  const processed: PolledHealthMessage[] = [];

  for (const message of messages) {
    try {
      const inserted = await upsertHealthEvent(message.item, message.eventTypeCode);
      upserted++;
      if (inserted) added++;
      processed.push(message);
    } catch (err) {
      // Leave the message in the queue (do not delete) so it can be retried; previous
      // rows are untouched.
      console.error(
        `[aws-health] failed to upsert event ${message.item.arn} (will redeliver):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  if (processed.length > 0) {
    await deleteMessages(client, queueUrl, processed);
  }

  return { upserted, new: added };
}

/**
 * Upserts a single AwsNewsItem into aws_health_events by arn. Preserves `first_seen`,
 * merges `affected_accounts` (dedup by accountId, preferring a friendly name), refreshes
 * `synced_at`. Returns true when the row was newly inserted (for "new in last 24h").
 */
async function upsertHealthEvent(item: AwsNewsItem, eventTypeCode: string | null): Promise<boolean> {
  const affectedAccountsJson = JSON.stringify(item.affectedAccounts ?? []);
  const rawJson = JSON.stringify(item);

  const { rows } = await pool.query(
    `
    INSERT INTO aws_health_events
      (arn, service, region, event_type_code, category, status_code, severity,
       start_time, end_time, last_updated, affected_accounts, description, raw,
       first_seen, synced_at)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13::jsonb, NOW(), NOW())
    ON CONFLICT (arn) DO UPDATE SET
      service = EXCLUDED.service,
      region = EXCLUDED.region,
      event_type_code = EXCLUDED.event_type_code,
      category = EXCLUDED.category,
      status_code = EXCLUDED.status_code,
      severity = EXCLUDED.severity,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time,
      last_updated = EXCLUDED.last_updated,
      affected_accounts = (
        SELECT COALESCE(jsonb_agg(acc ORDER BY acc->>'accountId'), '[]'::jsonb)
        FROM (
          SELECT DISTINCT ON (e->>'accountId') e AS acc
          FROM (
            SELECT jsonb_array_elements(aws_health_events.affected_accounts) AS e
            UNION ALL
            SELECT jsonb_array_elements(EXCLUDED.affected_accounts) AS e
          ) all_elems
          ORDER BY e->>'accountId', (e->>'accountName') DESC NULLS LAST
        ) deduped
      ),
      description = EXCLUDED.description,
      raw = EXCLUDED.raw,
      synced_at = NOW()
    RETURNING (xmax = 0) AS inserted
    `,
    [
      item.arn,
      item.service,
      item.region,
      eventTypeCode,
      item.category,
      item.statusCode,
      item.severity,
      item.startTime,
      item.endTime,
      item.lastUpdated,
      affectedAccountsJson,
      item.description,
      rawJson,
    ],
  );

  return Boolean(rows[0]?.inserted);
}

/* ------------------------------------------------------------------ */
/*  Read (sidebar / digest)                                            */
/* ------------------------------------------------------------------ */

/**
 * Reads aws_health_events for the sidebar / digest, ordered by relevance: open/upcoming
 * events first, then by last_updated descending. Optionally hides closed events and/or
 * restricts to events new or updated within the last `sinceHours` hours.
 */
export async function getAwsNews(opts?: {
  includeClosed?: boolean;
  sinceHours?: number;
}): Promise<AwsNewsItem[]> {
  const includeClosed = opts?.includeClosed ?? false;
  const sinceHours = opts?.sinceHours;

  const conditions: string[] = [];
  const params: unknown[] = [];

  if (!includeClosed) {
    conditions.push("status_code <> 'closed'");
  }
  if (typeof sinceHours === "number" && Number.isFinite(sinceHours) && sinceHours > 0) {
    params.push(sinceHours);
    // "new or updated in the last N hours"
    conditions.push(
      `(last_updated >= NOW() - make_interval(hours => $${params.length})
        OR first_seen >= NOW() - make_interval(hours => $${params.length}))`,
    );
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const { rows } = await pool.query(
    `
    SELECT arn, service, region, event_type_code, category, status_code, severity,
           start_time, end_time, last_updated, affected_accounts, description
    FROM aws_health_events
    ${where}
    ORDER BY
      CASE WHEN status_code IN ('open', 'upcoming') THEN 0 ELSE 1 END,
      last_updated DESC NULLS LAST,
      first_seen DESC
    `,
    params,
  );

  return rows.map(rowToNewsItem);
}

/** Maps a DB row to an AwsNewsItem. */
function rowToNewsItem(row: any): AwsNewsItem {
  return {
    arn: String(row.arn),
    service: String(row.service ?? "unknown"),
    region: row.region ? String(row.region) : null,
    category: coerceCategory(String(row.category ?? "")),
    statusCode: coerceStatus(String(row.status_code ?? "")),
    severity: normalizeStoredSeverity(row.severity),
    startTime: toIsoOrNull(row.start_time),
    endTime: toIsoOrNull(row.end_time),
    lastUpdated: toIsoOrNull(row.last_updated),
    affectedAccounts: parseAffectedAccounts(row.affected_accounts),
    description: String(row.description ?? ""),
  };
}

/** Normalizes a stored severity value to the typed union (defaults unknown -> baja). */
function normalizeStoredSeverity(value: unknown): Severity {
  const v = String(value ?? "").toLowerCase();
  if (v === "alta" || v === "media" || v === "baja") return v as Severity;
  return "baja";
}

/** Parses the affected_accounts JSONB column into a typed array. */
function parseAffectedAccounts(value: unknown): Array<{ accountId: string; accountName: string }> {
  let raw: any = value;
  if (typeof value === "string") {
    try {
      raw = JSON.parse(value);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((a: any) => ({
      accountId: String(a?.accountId ?? ""),
      accountName: String(a?.accountName ?? a?.accountId ?? ""),
    }))
    .filter((a) => a.accountId.length > 0);
}
