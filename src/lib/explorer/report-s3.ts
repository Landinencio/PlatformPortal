/**
 * AI Portal Explorer — S3 storage for screenshots and the Markdown report.
 *
 * PostgreSQL keeps the structured run metadata and evidence (JSONB), while the
 * heavy artefacts — per-visit PNG screenshots and the full Markdown report —
 * live in S3 and are referenced from the DB columns `visit_results.screenshot_ref`
 * and `exploration_runs.report_markdown_ref` (both `s3://...`).
 *
 * Client instantiation follows the project convention (gotcha #5): the
 * `@aws-sdk/client-s3` client is a TOP-LEVEL import and the `S3Client` is created
 * at module load, NOT lazily via `require()`. A lazy `require()` breaks under
 * Next.js `standalone` output with `Cannot find module`. Mirrors the patterns in
 * `athena-cur.ts`, `aws-inventory.ts` and `kiro-analytics.ts`.
 *
 * Credentials: the portal runs in the tooling account with the
 * `portal-inventory-irsa` role, so the client uses the ambient IRSA credentials
 * by default (no explicit credentials in-cluster). Region comes from
 * `AWS_REGION` (default `eu-west-1`) and the bucket from `EXPLORER_S3_BUCKET`.
 *
 * _Requirements: 5.5 (screenshot evidence), 7.2 (persisted Markdown report)._
 */

import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type { AppRole } from "@/lib/rbac";

// ─── Configuration (env-driven) ─────────────────────────────────────────────

/** Region for the S3 client. Bucket lives in the tooling account (eu-west-1). */
const S3_REGION = process.env.AWS_REGION?.trim() || "eu-west-1";

/**
 * Destination bucket for explorer artefacts. Defaults to a documented,
 * account-scoped bucket name in the tooling account. Override via env in dev.
 */
export const EXPLORER_S3_BUCKET =
  process.env.EXPLORER_S3_BUCKET?.trim() || "portal-explorer-444455556666-eu-west-1";

// ─── Top-level S3 client (Next.js standalone compatible) ─────────────────────

const s3Client = new S3Client({ region: S3_REGION });

// ─── Key helpers ─────────────────────────────────────────────────────────────

/** Strips characters that would be awkward in an S3 key, keeping it deterministic. */
function sanitizeKeySegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

/** S3 key for a per-visit screenshot: `screenshots/<runId>/<scenarioId>-<role>.png`. */
export function screenshotKey(runId: string, scenarioId: string, role: AppRole): string {
  return `screenshots/${sanitizeKeySegment(runId)}/${sanitizeKeySegment(scenarioId)}-${sanitizeKeySegment(role)}.png`;
}

/** S3 key for the run's Markdown report: `reports/<runId>/report.md`. */
export function reportMarkdownKey(runId: string): string {
  return `reports/${sanitizeKeySegment(runId)}/report.md`;
}

/** Builds the canonical `s3://bucket/key` URI for a stored object. */
function s3Uri(key: string): string {
  return `s3://${EXPLORER_S3_BUCKET}/${key}`;
}

// ─── Uploads ──────────────────────────────────────────────────────────────────

/**
 * Uploads a PNG screenshot for a (run, scenario, role) visit and returns its
 * `s3://bucket/key` URI (stored in `visit_results.screenshot_ref`).
 *
 * @param runId      the Exploration_Run id
 * @param scenarioId the stable scenario id
 * @param role       the RBAC role under which the visit was performed
 * @param buffer     the raw PNG bytes captured by the Crawler
 */
export async function putScreenshot(
  runId: string,
  scenarioId: string,
  role: AppRole,
  buffer: Buffer,
): Promise<string> {
  const key = screenshotKey(runId, scenarioId, role);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: EXPLORER_S3_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: "image/png",
    }),
  );
  return s3Uri(key);
}

/**
 * Uploads the rendered Markdown report for a run and returns its `s3://bucket/key`
 * URI (stored in `exploration_runs.report_markdown_ref`).
 *
 * @param runId    the Exploration_Run id
 * @param markdown the rendered report produced by `reporter.renderMarkdown`
 */
export async function putReportMarkdown(runId: string, markdown: string): Promise<string> {
  const key = reportMarkdownKey(runId);
  await s3Client.send(
    new PutObjectCommand({
      Bucket: EXPLORER_S3_BUCKET,
      Key: key,
      Body: markdown,
      ContentType: "text/markdown",
    }),
  );
  return s3Uri(key);
}
