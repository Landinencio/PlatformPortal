import { NextResponse } from "next/server";
import { requireInternalAuth } from "@/lib/api-auth";
import pool from "@/lib/db";
import { gitlabClient } from "@/lib/gitlab";
import { repoCatalog } from "@/lib/repo-catalog";
import { jiraCreateIssue } from "@/lib/jira";
import { createNotification } from "@/lib/notifications";
import { validateHclSyntax, validateRdsPasswordRotation, validateIamPolicyAdmin, validateManagedPolicyArn } from "@/lib/terraform-validator";
import { scanForSecrets } from "@/lib/secret-scanner";
import { executeSquadInfra } from "@/lib/squad-infra/execute";
import { InfraLogger } from "@/lib/logger";
import type { AuxiliaryFileOp } from "@/lib/infra-agent";
import { upsertTfvarsEntries } from "@/lib/rds/render-rds";
import { ENABLE_INFRA_HARDENING_V1 } from "@/lib/feature-flags";
import { checkDuplicate, invalidateDuplicateCache } from "@/lib/infra/duplicate-guard";
import {
  buildErrorPersisted,
  classifyExecuteError,
  suggestionForCode,
  type ErrorCode,
  type ExecuteStep,
} from "@/lib/infra/error-classifier";

// Req 9.6 (infra-self-service-hardening) — the Execute_API keeps a 120 s
// serverless budget; the precheck below (task 9.1) charges against it and is
// capped at 5 s by `checkDuplicate` (`DUPLICATE_CHECK_TIMEOUT_MS`).
export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Resource types eligible for the precheck (infra-self-service-hardening,
 * task 9.1). `squad-*` types run through a dedicated path earlier in this
 * handler and never reach the precheck.
 */
const PRECHECK_RESOURCE_TYPES = new Set(["rds", "s3", "iam_role"]);

/**
 * Classifies an error caught at `step` and, when the hardening flag is on,
 * emits an `error`-level structured log with the classified `code`, `step`,
 * and — for `code === "unknown"` — the raw stacktrace (Req 5.1). When the
 * flag is off the function is a no-op so the route preserves the exact
 * `portal-prod v0.23.0-rc.1` behaviour byte-per-byte.
 *
 * Task 9.2 scope: log-only. Persistence of the `Error_Persistido` in
 * `infra_requests.error_message` is task 9.3, the 409 `concurrent_execute`
 * gate is task 9.4, and the Guardia_Duplicado cache invalidation on
 * `createFile` success is task 9.5.
 */
function classifyAndLogIfEnabled(
  err: unknown,
  step: ExecuteStep,
  logger: InfraLogger
): { code: ErrorCode; suggestion: string } | null {
  if (!ENABLE_INFRA_HARDENING_V1) return null;
  const code = classifyExecuteError(err, step);
  const meta: Record<string, unknown> = { code, step };
  if (code === "unknown" && err instanceof Error && typeof err.stack === "string") {
    meta.stacktrace = err.stack;
  }
  logger.error(`step:${step} classified`, meta);
  return { code, suggestion: suggestionForCode(code) };
}

/**
 * Context threaded into {@link handleExecuteFailure} for every `execute_failed`
 * transition site. `fallbackMessage` is the pre-hardening Spanish string the
 * route used to pass to `notifyRequestor` — it is the message dispatched when
 * `ENABLE_INFRA_HARDENING_V1` is off so the baseline (`portal-prod v0.23.0-rc.1`)
 * remains byte-exact (Req 7.3). `explicitCode` overrides the classifier for
 * pre-repository bailouts (`terraform_invalid`, `rds_rotation_missing`,
 * `secret_detected`, `repo_not_found`, `shared_file_conflict`) whose original
 * error text contains Spanish keywords the classifier does not match.
 */
interface ExecuteFailureContext {
  id: number;
  requestorEmail: string;
  team: string;
  resourceType: string;
  identifier: string;
  fallbackMessage: string;
  logger: InfraLogger;
  explicitCode?: ErrorCode;
}

/**
 * Handles an `execute_failed` transition (task 9.3, Req 5.2, 5.3, 5.4, 5.6,
 * 5.8, 5.9, 7.2).
 *
 * When `ENABLE_INFRA_HARDENING_V1` is **off** this helper preserves the
 * baseline byte-exact (Req 7.3): a single `UPDATE ... SET status='execute_failed'`
 * followed by the same generic `notifyRequestor` call that the route used to
 * inline.
 *
 * When **on** it:
 * 1. Classifies the error via `classifyExecuteError` (or accepts an explicit
 *    `code` for pre-repository bailouts whose Spanish error text the
 *    classifier does not match).
 * 2. Builds an `Error_Persistido` via `buildErrorPersisted` and persists it
 *    together with the status transition in ONE statement:
 *    `UPDATE infra_requests SET error_message = $1::jsonb, status = 'execute_failed' WHERE id = $2`
 *    (Req 5.6, 5.8 — persistence PRECEDES notification).
 * 3. If the persistence `UPDATE` throws (missing column, DB connectivity,
 *    timeout…), emits `logger.error` with `code: "error_persist_failed"` and
 *    falls back to notifying with `code: "unknown"` + the generic suggestion
 *    from Req 5.3, WITHOUT blocking the outer `try/finally` rollback of the
 *    branch (Req 5.9). A best-effort `UPDATE ... SET status='execute_failed'`
 *    without the JSONB payload is attempted so the row does not stay stuck
 *    in `executing` forever.
 * 4. Emits a complementary `error`-level log with `code`, `step`, `requestId`
 *    right before notifying (Req 7.2).
 * 5. Notifies the requestor via `notifyRequestor` (<30 s per Req 5.5 — the
 *    call runs inline in the same request; `createNotification` writes to
 *    `user_notifications` in the same connection). The message carries the
 *    classified `code`, the deterministic suggestion from `suggestionForCode`,
 *    the failing `step`, and — when `code === "resource_exists_at_execute"` —
 *    a deterministic `/infra-requests?prefill={team,resourceType,identifier}`
 *    link (Req 5.4). When the code is `terraform_invalid`,
 *    `rds_rotation_missing` or `secret_detected` the message is prefixed with
 *    the "preview was rejected before touching the repository" clause
 *    required by Req 5.5.
 */
async function handleExecuteFailure(
  err: unknown,
  step: ExecuteStep,
  ctx: ExecuteFailureContext
): Promise<void> {
  // ── Feature-flag OFF: baseline behaviour, byte-exact (Req 7.3). ────────────
  if (!ENABLE_INFRA_HARDENING_V1) {
    await pool.query(
      `UPDATE infra_requests SET status = 'execute_failed' WHERE id = $1`,
      [ctx.id]
    );
    await notifyRequestor(
      ctx.requestorEmail,
      ctx.id,
      "execute_failed",
      ctx.fallbackMessage
    );
    return;
  }

  // ── Hardened path (task 9.3). ──────────────────────────────────────────────
  const classifiedCode: ErrorCode =
    ctx.explicitCode ?? classifyExecuteError(err, step);
  const errorPersisted = buildErrorPersisted(err, step, classifiedCode);
  let effectiveCode: ErrorCode = classifiedCode;

  // Persist + transition in ONE statement (Req 5.6, 5.8).
  try {
    await pool.query(
      `UPDATE infra_requests SET error_message = $1::jsonb, status = 'execute_failed' WHERE id = $2`,
      [JSON.stringify(errorPersisted), ctx.id]
    );
  } catch (persistErr) {
    // Req 5.9: log `error_persist_failed`, fall back to `code: "unknown"`, do
    // NOT block the outer rollback of the branch (the `try/finally` in the
    // caller still fires because we return here without throwing).
    effectiveCode = "unknown";
    ctx.logger.error("Error_Persistido persistence failed", {
      code: "error_persist_failed",
      step,
      requestId: ctx.id,
      originalCode: classifiedCode,
      error: String(persistErr),
    });
    // Best-effort: still flip the status so the row does not stay stuck in
    // `executing`. If this ALSO fails the outer rollback still cleans up the
    // branch; the row will be re-collected by the next idempotency guard.
    try {
      await pool.query(
        `UPDATE infra_requests SET status = 'execute_failed' WHERE id = $1`,
        [ctx.id]
      );
    } catch (statusErr) {
      ctx.logger.error("Fallback status transition failed", {
        step,
        requestId: ctx.id,
        error: String(statusErr),
      });
    }
  }

  // Req 7.2: complementary `error` log with the same `code` and `step` as the
  // Error_Persistido plus `requestId`.
  ctx.logger.error("execute_failed", {
    code: effectiveCode,
    step,
    requestId: ctx.id,
  });

  // Notification (Req 5.3, 5.4, 5.5, 5.8).
  const notificationMessage = buildFailureNotificationMessage(
    effectiveCode,
    step
  );
  const link = buildPrefillLinkIfDuplicate(effectiveCode, ctx);
  await notifyRequestor(
    ctx.requestorEmail,
    ctx.id,
    "execute_failed",
    notificationMessage,
    link
  );
}

/**
 * Codes whose failure happens BEFORE any repository write — the notification
 * must declare it (Req 5.5).
 */
const PREVIEW_REJECTION_CODES: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  "terraform_invalid",
  "rds_rotation_missing",
  "secret_detected",
]);

/**
 * Assembles the Spanish notification body per Req 5.3 and 5.5. The prefix for
 * pre-repository rejections comes from the exhaustive
 * {@link PREVIEW_REJECTION_CODES} set; every other code emits just
 * `[código: <code>] Paso: <step>. <suggestion>`.
 */
function buildFailureNotificationMessage(
  code: ErrorCode,
  step: ExecuteStep
): string {
  const prefix = PREVIEW_REJECTION_CODES.has(code)
    ? "El preview fue rechazado antes de tocar el repositorio. "
    : "";
  return `${prefix}[código: ${code}] Paso: ${step}. ${suggestionForCode(code)}`;
}

/**
 * Deterministic prefill link for `resource_exists_at_execute` (Req 5.4). The
 * three values are JSON-encoded and then URL-encoded so the client-side form
 * can decode them safely, mirroring how `/infra-requests` consumes the query
 * string. `undefined` for every other code preserves the existing
 * notification default (`/infra-requests`) applied by `notifyRequestor`.
 */
function buildPrefillLinkIfDuplicate(
  code: ErrorCode,
  ctx: ExecuteFailureContext
): string | undefined {
  if (code !== "resource_exists_at_execute") return undefined;
  const prefill = JSON.stringify({
    team: ctx.team,
    resourceType: ctx.resourceType,
    identifier: ctx.identifier,
  });
  return `/infra-requests?prefill=${encodeURIComponent(prefill)}`;
}

// POST /api/infra-assistant/execute/[id]
// Internal-only endpoint (protected by x-internal-secret).
// Performs all write operations after an infra request is approved.
export async function POST(
  request: Request,
  { params }: { params: { id: string } }
) {
  const auth = requireInternalAuth(request);
  if (auth.error) return auth.error;

  const id = parseInt(params.id, 10);
  if (isNaN(id)) {
    return NextResponse.json({ error: "Invalid request id" }, { status: 400 });
  }

  // Step 1: Load infra_requests row
  const { rows } = await pool.query(
    `SELECT id, status, executed_at, requestor_email, team,
            resource_type, terraform_preview, payload
     FROM infra_requests WHERE id = $1`,
    [id]
  );

  if (rows.length === 0) {
    return NextResponse.json({ error: "Request not found" }, { status: 404 });
  }

  const row = rows[0];

  // Idempotency guard — check terminal statuses before any external operations.
  //
  // Task 9.4 (infra-self-service-hardening, Req 3.5c, 3.6):
  //   - `executed` and `execute_failed` are TERMINAL — never re-enter
  //     `executing`. They keep responding 200 with an idempotent message so
  //     retries of the internal endpoint stay non-disruptive (baseline).
  //   - `executing` means another invocation of the SAME `id` is already
  //     inside the critical section. When `ENABLE_INFRA_HARDENING_V1` is on
  //     THE Execute_API SHALL respond HTTP 409 `{ code: "concurrent_execute" }`
  //     without writing to the destination repo and without sending any
  //     notification (Req 3.6). Bailing out HERE, before branch creation and
  //     before the notification path, is what enforces that guarantee. When
  //     the flag is off the byte-exact baseline (200 ok) is preserved
  //     (Req 7.3, ventana de convivencia).
  if (row.status === "executed") {
    return NextResponse.json({ ok: true, message: "Already executed", status: "executed" });
  }
  if (row.status === "execute_failed") {
    return NextResponse.json({ ok: true, message: "Previously failed", status: "execute_failed" });
  }
  if (row.status === "executing") {
    if (ENABLE_INFRA_HARDENING_V1) {
      return NextResponse.json({ code: "concurrent_execute" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, message: "Already in progress", status: "executing" });
  }
  if (row.status !== "approved") {
    return NextResponse.json(
      { error: `Status is '${row.status}', must be 'approved'` },
      { status: 403 }
    );
  }

  // Atomically claim the request (approved → executing) so two concurrent
  // triggers can't both create a branch / MR for the same request. This
  // `UPDATE ... WHERE status='approved'` is the SOURCE OF TRUTH for the
  // transition (Req 3.5a) — the pre-claim SELECT above is only a fast path.
  //
  // The `WHERE status='approved'` predicate ALSO enforces Req 3.5c: rows in
  // the terminal states `executed` / `execute_failed` cannot be flipped back
  // to `executing` because they do not match the predicate.
  //
  // When `rowCount === 0` another invocation won the race between our SELECT
  // and this UPDATE (the row is now `executing`), so the guarantee is the
  // same as the pre-claim guard above: 409 `concurrent_execute` under the
  // hardening flag, byte-exact 200 baseline otherwise. No repo writes, no
  // notifications have run at this point (Req 3.6).
  const claim = await pool.query(
    `UPDATE infra_requests SET status = 'executing' WHERE id = $1 AND status = 'approved'`,
    [id]
  );
  if (claim.rowCount === 0) {
    if (ENABLE_INFRA_HARDENING_V1) {
      return NextResponse.json({ code: "concurrent_execute" }, { status: 409 });
    }
    return NextResponse.json({ ok: true, message: "Already claimed by another run", status: "executing" });
  }

  // ── Squad self-service infra: deterministic templates, separate execution path ──
  if (typeof row.resource_type === "string" && row.resource_type.startsWith("squad-")) {
    const squadPayload = typeof row.payload === "string" ? JSON.parse(row.payload) : (row.payload || {});
    // reviewer_email is set by the review endpoint just before triggering execute.
    const { rows: revRows } = await pool.query(`SELECT reviewer_email FROM infra_requests WHERE id = $1`, [id]);
    const reviewerEmail: string | null = revRows[0]?.reviewer_email ?? null;
    const result = await executeSquadInfra(id, row.resource_type, row.requestor_email, reviewerEmail, squadPayload);
    if (!result.ok) {
      return NextResponse.json({ error: "Squad infra execution failed", details: result.error }, { status: 500 });
    }
    return NextResponse.json({ ok: true, status: result.status, gitlab_mr_url: result.mrUrl, gitlab_branch: result.branch });
  }

  const preview = typeof row.terraform_preview === 'string'
    ? JSON.parse(row.terraform_preview)
    : (row.terraform_preview || {});

  const requestorEmail: string = row.requestor_email;
  const team: string = row.team;
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {});
  const resourceName: string = preview?.resourceName || payload?.identifier || row.resource_type || "resource";

  // Create structured logger after extracting user info from DB row
  const logger = new InfraLogger('execute', requestorEmail);
  logger.info('Starting execution', { id, team, resourceName, filePath: preview?.filePath });

  // Step 2: Look up repo
  const repo = await repoCatalog.getByTeam(team);
  if (!repo) {
    await handleExecuteFailure(
      new Error(`repo not found for team "${team}"`),
      "create_branch",
      {
        id,
        requestorEmail,
        team,
        resourceType: String(row.resource_type || ""),
        identifier: resourceName,
        fallbackMessage: `No se encontró repositorio para el equipo "${team}".`,
        logger,
        explicitCode: "repo_not_found",
      }
    );
    return NextResponse.json({ error: `No repo for team '${team}'` }, { status: 422 });
  }

  const { gitlabProjectId: projectId, defaultBranch } = repo;
  const branchName = `feat/SRE-${id}`;
  const commitMessage = `[SRE-${id}] feat: ${resourceName} infrastructure`;
  const filePath = preview?.filePath || `iac/${resourceName}.tf`;
  const content = preview?.content || "";

  logger.info('Repo resolved', { projectId, branchName, defaultBranch });

  // Step 2.5: Validate Terraform content
  const validation = validateHclSyntax(content);
  if (!validation.valid) {
    const errorSummary = validation.errors.map(e => e.message).join("; ");
    logger.error('Terraform validation failed', { errorSummary });
    await handleExecuteFailure(
      new Error(`terraform validation failed: ${errorSummary}`),
      "create_file",
      {
        id,
        requestorEmail,
        team,
        resourceType: String(row.resource_type || ""),
        identifier: resourceName,
        fallbackMessage: `El código Terraform generado tiene errores de sintaxis: ${errorSummary}`,
        logger,
        explicitCode: "terraform_invalid",
      }
    );
    return NextResponse.json(
      { error: "Terraform validation failed", details: errorSummary },
      { status: 422 }
    );
  }

  // Step 2.5b: RDS-specific guard — enforce mandatory master password rotation.
  // Belt-and-suspenders: the prompt forces it, this rejects anything that slipped through.
  if ((row.resource_type || "").toLowerCase() === "rds") {
    const rotation = validateRdsPasswordRotation(content);
    if (!rotation.valid) {
      const rotationSummary = rotation.errors.map(e => e.message).join("; ");
      logger.error('RDS rotation validation failed', { rotationSummary });
      await handleExecuteFailure(
        new Error(`rds master password rotation missing: ${rotationSummary}`),
        "create_file",
        {
          id,
          requestorEmail,
          team,
          resourceType: String(row.resource_type || ""),
          identifier: resourceName,
          fallbackMessage: `La RDS generada no incluye la rotación obligatoria de contraseña master: ${rotationSummary}`,
          logger,
          explicitCode: "rds_rotation_missing",
        }
      );
      return NextResponse.json(
        { error: "RDS password rotation validation failed", details: rotationSummary },
        { status: 422 }
      );
    }
  }

  // Step 2.6: Secret scanning — before branch creation to avoid unnecessary cleanup
  const scanResult = scanForSecrets(content);
  if (!scanResult.clean) {
    const patternTypes = scanResult.findings.map(f => f.patternType).join(", ");
    logger.error('Secret scan detected potential secrets', { patternTypes });
    await handleExecuteFailure(
      new Error(`secret scanner detected potential secrets: ${patternTypes}`),
      "create_file",
      {
        id,
        requestorEmail,
        team,
        resourceType: String(row.resource_type || ""),
        identifier: resourceName,
        fallbackMessage: `El contenido Terraform generado contiene posibles secretos (${patternTypes}) y fue rechazado por seguridad.`,
        logger,
        explicitCode: "secret_detected",
      }
    );
    return NextResponse.json(
      { error: "Secret detected in generated content", patterns: patternTypes },
      { status: 422 }
    );
  }

  // Step 2.7: IAM anti-admin validator (feature: iam-role-least-privilege,
  // task 9.1 — Req 5.7, 5.8, 5.9). Only for `iam_role`; every other resource
  // type skips this guard. Runs AFTER the atomic claim (approved → executing)
  // and BEFORE branch creation, so a rejection here bails out without any
  // repo/MR/Jira side effects (no branch exists yet, so the finally-block
  // rollback is a no-op). Extends the existing pre-repo chain:
  //   validateHclSyntax → validateRdsPasswordRotation → scanForSecrets →
  //   validateIamPolicyAdmin (this block).
  if ((row.resource_type || "").toLowerCase() === "iam_role") {
    // Collect the managed policy ARNs to validate individually (Req 5.8): the
    // ARNs explicitly added by a modification (when the payload/preview carries
    // them) PLUS any managed policy ARN referenced in the generated HCL
    // (`policy_arn = "arn:aws:iam::(aws|<acct>):policy/..."`). The regex sweep
    // catches `*FullAccess` / `Administrator` attachments that
    // `validateIamPolicyAdmin` (which only inspects inline Statement blocks)
    // would miss, and covers both creation and modification uniformly.
    const managedArns: string[] = [];
    const mods = preview?.modifications ?? payload?.modifications;
    if (Array.isArray(mods?.addPermissions)) {
      for (const a of mods.addPermissions) {
        if (typeof a === "string" && a.trim().length > 0) managedArns.push(a.trim());
      }
    }
    const arnMatches = String(content).match(/arn:aws:iam::(?:aws|\d{12}):policy\/[^"'\s]+/g) || [];
    for (const a of arnMatches) managedArns.push(a);

    // 1) Each managed policy ARN → validateManagedPolicyArn (Req 5.8).
    let adminRule: string | null = null;
    let adminDetail = "";
    for (const arn of managedArns) {
      const r = validateManagedPolicyArn(arn);
      if (r.verdict === "Politica_Admin") {
        adminRule = r.rule ?? "invalid_managed_arn";
        adminDetail = r.detail ?? arn;
        break;
      }
    }

    // 2) The generated document itself (Req 5.7 creation, Req 5.8 modification).
    if (!adminRule) {
      const docResult = validateIamPolicyAdmin(String(content));
      if (docResult.verdict === "Politica_Admin") {
        adminRule = docResult.rule ?? "empty_or_malformed";
        adminDetail = docResult.detail ?? "";
      }
    }

    if (adminRule) {
      logger.error('IAM anti-admin validation failed', { rule: adminRule, detail: adminDetail });
      await handleExecuteFailure(
        new Error(`iam policy admin rejected (rule: ${adminRule})${adminDetail ? `: ${adminDetail}` : ""}`),
        "create_file",
        {
          id,
          requestorEmail,
          team,
          resourceType: String(row.resource_type || ""),
          identifier: resourceName,
          fallbackMessage: `La política IAM generada concede permisos de administrador y fue rechazada (regla: ${adminRule}). Usa permisos de mínimo privilegio y reenvía.`,
          logger,
          explicitCode: "iam_policy_admin",
        }
      );
      return NextResponse.json(
        { error: "IAM policy grants admin privileges", rule: adminRule, detail: adminDetail },
        { status: 422 }
      );
    }
  }

  // Step 3: createBranch
  let branchCreated = false;
  try {
    await gitlabClient.createBranch(projectId, branchName, defaultBranch);
    branchCreated = true;
    logger.info('Branch created', { branchName });
  } catch (err) {
    logger.error('createBranch failed', { error: String(err) });
    classifyAndLogIfEnabled(err, "create_branch", logger);
    await handleExecuteFailure(err, "create_branch", {
      id,
      requestorEmail,
      team,
      resourceType: String(row.resource_type || ""),
      identifier: resourceName,
      fallbackMessage: `No se pudo crear la rama "${branchName}".`,
      logger,
    });
    return NextResponse.json({ error: "createBranch failed", detail: String(err) }, { status: 500 });
  }

  // Track request status — used by finally block to decide branch rollback
  let requestStatus: string = "approved";

  // Wrap all operations after branch creation in try/finally for consistent rollback
  const isModification = preview?.isModification === true;
  const isSharedFile = filePath.endsWith('/s3.tf') || filePath.endsWith('/roles.tf') || filePath.endsWith('/policies.tf');

  try {
    // ── Precheck (Req 3.1, 3.3, 9.6, 9.7 — task 9.1) ─────────────────────────
    // After the atomic claim `approved → executing` and after branch creation,
    // verify the destination file does not already exist on the team repo's
    // default branch. This catches races where another request created the
    // same resource between generate and execute.
    //
    // Skipped when:
    //   - `preview.isModification === true` — modifications operate on files
    //     that ALREADY exist by definition (Req 3.1).
    //   - `resource_type` is outside {rds, s3, iam_role} — squad-* types have
    //     their own dedicated flow and were already routed away above.
    //   - `ENABLE_INFRA_HARDENING_V1` is off — the flag keeps the baseline
    //     behaviour byte-exact during the coexistence window.
    //
    // The precheck's total budget is 5 000 ms (enforced by `checkDuplicate`
    // via an internal `AbortController`, `DUPLICATE_CHECK_TIMEOUT_MS`). Any
    // 5xx from GitLab or an aborted call materialises as `unavailable` and is
    // treated here as `precheck_unavailable` (Req 3.3). Task 9.2 will refine
    // the error classification and task 9.3 will persist `Error_Persistido`;
    // for now we surface the failure via the same inline pattern used by the
    // other steps below so the outer try/finally can roll back the branch.
    if (
      ENABLE_INFRA_HARDENING_V1 &&
      !isModification &&
      PRECHECK_RESOURCE_TYPES.has(String(row.resource_type || "").toLowerCase())
    ) {
      try {
        const dup = await checkDuplicate(projectId, defaultBranch, filePath);
        if (dup.unavailable) {
          // Transient GitLab failure (5xx / timeout > 5 s / network).
          throw new Error(`precheck_unavailable: ${dup.unavailable.reason}`);
        }
        if (dup.exists) {
          // File already exists on the destination branch — a duplicate
          // slipped past the generate-time Guardia_Duplicado (Req 3.2).
          // Task 9.2 will classify this as `resource_exists_at_execute`.
          throw new Error(`resource already exists at ${filePath}`);
        }
        logger.info('Precheck passed', { filePath, defaultBranch });
      } catch (err) {
        // Inline handling mirrors the existing per-step pattern below so the
        // request does not stay hung in `executing`; the outer try/finally
        // rolls back the branch because `requestStatus === "approved"` and
        // `branchCreated === true` (Req 3.2c, 3.5b). Task 9.2 wires the
        // `classifyExecuteError` + structured log at step `"precheck"`;
        // persistence of the `Error_Persistido` is handled by task 9.3 via
        // `handleExecuteFailure`.
        logger.error('Precheck failed', { step: 'precheck', error: String(err) });
        classifyAndLogIfEnabled(err, "precheck", logger);
        await handleExecuteFailure(err, "precheck", {
          id,
          requestorEmail,
          team,
          resourceType: String(row.resource_type || ""),
          identifier: resourceName,
          fallbackMessage: `Verificación previa fallida antes de escribir el archivo "${filePath}".`,
          logger,
        });
        return NextResponse.json(
          { error: "precheck failed", detail: String(err) },
          { status: 500 }
        );
      }
    }

    // Step 4: createFile or updateFile
    // For shared files (s3.tf, roles.tf) we need to APPEND to existing content
    try {
      if (isModification) {
        // Modification: replace the entire file with the AI-generated version
        await gitlabClient.updateFile(projectId, filePath, branchName, content, commitMessage);
        logger.info('File updated (modification)', { filePath });
      } else if (isSharedFile) {
        // Shared file: read current content with optimistic locking and APPEND the new block
        const MAX_RETRIES = 3;
        let attempt = 0;
        let committed = false;

        while (attempt < MAX_RETRIES && !committed) {
          attempt++;
          try {
            const fileMeta = await gitlabClient.getRepositoryFileWithMeta(projectId, filePath, branchName);
            const currentContent = fileMeta?.content || "";
            const lastCommitId = fileMeta?.lastCommitId;
            const appendedContent = currentContent + "\n\n" + content;
            await gitlabClient.updateFile(
              projectId, filePath, branchName, appendedContent,
              commitMessage,
              lastCommitId
            );
            committed = true;
            logger.info('File appended (shared)', { filePath, addedChars: content.length, attempt });
          } catch (retryErr: unknown) {
            const errMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            const isConflict = errMsg.includes("409") || errMsg.toLowerCase().includes("conflict") || errMsg.toLowerCase().includes("modified");
            if (isConflict && attempt < MAX_RETRIES) {
              logger.warn('Conflict on shared file update, retrying', { attempt });
              continue;
            }
            // Not a conflict or exhausted retries — rethrow
            throw retryErr;
          }
        }

        if (!committed) {
          // All retries exhausted due to conflicts
          logger.error('Shared file update failed after max conflict retries', { filePath, maxRetries: MAX_RETRIES });
          await handleExecuteFailure(
            new Error(`shared file conflict: max retries (${MAX_RETRIES}) exhausted on ${filePath}`),
            "update_file",
            {
              id,
              requestorEmail,
              team,
              resourceType: String(row.resource_type || ""),
              identifier: resourceName,
              fallbackMessage: `No se pudo actualizar el archivo compartido "${filePath}" después de ${MAX_RETRIES} intentos por conflictos concurrentes.`,
              logger,
              explicitCode: "shared_file_conflict",
            }
          );
          return NextResponse.json(
            { error: "Shared file update failed after max retries", detail: "Concurrent modification conflicts" },
            { status: 409 }
          );
        }
      } else {
        // New file: create it
        await gitlabClient.createFile(projectId, filePath, branchName, content, commitMessage);
        logger.info('File created', { filePath });

        // Task 9.5 (Req 2.10): invalidate the Guardia_Duplicado cache entry
        // for `(projectId, defaultBranch, filePath)` so the next `/generate`
        // sees the fresh state instead of the stale "does not exist" miss
        // cached during the last 60 s. Only fires here (new-file path); for
        // modifications and shared files the invalidation is semantically a
        // no-op (the file already existed before we touched the repo).
        //
        // Gated behind `ENABLE_INFRA_HARDENING_V1`: when the flag is off the
        // baseline `portal-prod v0.23.0-rc.1` byte-exact behaviour is
        // preserved (Req 7.3). If `createFile` throws we skip this line
        // entirely (control transfers to the catch block); the cache expires
        // on its own after 60 s or gets refreshed on the next check.
        if (ENABLE_INFRA_HARDENING_V1) {
          const invalidated = invalidateDuplicateCache(projectId, defaultBranch, filePath);
          logger.info('Duplicate-guard cache invalidated', {
            filePath,
            ref: defaultBranch,
            invalidated,
          });
        }
      }
    } catch (err) {
      // Task 9.2: classify by branch — modification / shared-file both go
      // through `updateFile` (step `"update_file"`) while a new resource
      // goes through `createFile` (step `"create_file"`). The classifier's
      // strong signatures (Req 3.4: "already exists" → `resource_exists_at_execute`)
      // dominate over the step-specific fallback, so a stale duplicate that
      // slips past the precheck still surfaces with the correct code.
      const fileStep: ExecuteStep = (isModification || isSharedFile) ? "update_file" : "create_file";
      logger.error('createFile/updateFile failed', { error: String(err) });
      classifyAndLogIfEnabled(err, fileStep, logger);
      await handleExecuteFailure(err, fileStep, {
        id,
        requestorEmail,
        team,
        resourceType: String(row.resource_type || ""),
        identifier: resourceName,
        fallbackMessage: `No se pudo ${isModification ? 'actualizar' : 'crear'} el archivo "${filePath}".`,
        logger,
      });
      return NextResponse.json({ error: "createFile failed", detail: String(err) }, { status: 500 });
    }

    // Step 4b: Auxiliary files (RDS deterministic generator).
    // Applies variables.tf (append) + vars/{dev,uat,pro}.tfvars (upsert-entries)
    // with optimistic locking, in addition to the primary `.tf` written above.
    // Absent for s3/iam, so guarding on length is enough.
    if (Array.isArray(preview?.auxiliaryFiles) && preview.auxiliaryFiles.length > 0) {
      try {
        for (const op of preview.auxiliaryFiles as AuxiliaryFileOp[]) {
          await applyAuxiliaryFileOp(projectId, branchName, op, commitMessage, logger);
        }
        logger.info('Auxiliary files applied', { count: preview.auxiliaryFiles.length });
      } catch (err) {
        logger.error('Auxiliary file write failed', { error: String(err) });
        classifyAndLogIfEnabled(err, "aux_file", logger);
        await handleExecuteFailure(err, "aux_file", {
          id,
          requestorEmail,
          team,
          resourceType: String(row.resource_type || ""),
          identifier: resourceName,
          fallbackMessage: `No se pudieron escribir los archivos auxiliares (variables.tf / tfvars).`,
          logger,
        });
        // requestStatus stays 'approved' → finally rolls back the branch.
        return NextResponse.json({ error: "Auxiliary file write failed", detail: String(err) }, { status: 500 });
      }
    }

    // Step 5: createMR (non-fatal — does NOT trigger branch deletion)
    let mrUrl: string | null = null;
    try {
      const mr = await gitlabClient.createMR(
        projectId, branchName, defaultBranch,
        commitMessage,
        `## Infra Request #${id}\n\nTeam: ${team}\nResource: ${resourceName}\n\nGenerated by AI Infrastructure Assistant.`
      );
      mrUrl = mr.web_url;
      logger.info('MR created', { mrUrl });
    } catch (err) {
      logger.error('createMR failed (non-fatal)', { error: String(err) });
      classifyAndLogIfEnabled(err, "create_mr", logger);
    }

    // Step 6: jiraCreateIssue (non-blocking — does NOT trigger branch deletion)
    let jiraKey: string | null = null;
    try {
      const envList = (preview?.targetEnvironments || []).join(", ") || "N/A";
      const jiraDescription = [
        `h2. Solicitud de Infraestructura #${id}`,
        ``,
        `||Campo||Valor||`,
        `|Equipo|${team}|`,
        `|Tipo de recurso|${(preview?.resourceType || row.resource_type || "").toUpperCase()}|`,
        `|Recurso|${resourceName}|`,
        `|Entornos|${envList}|`,
        `|Solicitante|${requestorEmail}|`,
        `|Archivo|${filePath}|`,
        `|Rama|${branchName}|`,
        ``,
        `h3. Descripción`,
        `Recurso de infraestructura generado automáticamente por el Portal de Plataforma.`,
        ``,
        `El código Terraform ha sido commiteado en la rama *${branchName}* y requiere revisión antes de hacer merge.`,
      ].join("\n");

      const jiraResult = await jiraCreateIssue({
        projectKey: "SRE",
        issueTypeId: "10048",
        summary: `[Infra] ${(preview?.resourceType || row.resource_type || "resource").toUpperCase()} — ${resourceName} — ${team}`,
        description: jiraDescription,
        labels: ["SRE", "portal", team.toLowerCase(), (preview?.resourceType || "resource").toLowerCase()],
        reporterEmail: requestorEmail,
      });
      jiraKey = jiraResult.key;
      logger.info('Jira issue created', { jiraKey });
    } catch (err) {
      logger.error('jiraCreateIssue failed (non-blocking)', { error: String(err) });
      classifyAndLogIfEnabled(err, "create_jira", logger);
    }

    // Step 7: Teams webhook (non-blocking — does NOT trigger branch deletion)
    const teamsWebhookUrl = process.env.TEAMS_WEBHOOK_URL;
    if (teamsWebhookUrl) {
      try {
        const card = buildTeamsAdaptiveCard({ id, team, resourceName, mrUrl, jiraKey });
        const teamsRes = await fetch(teamsWebhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(card),
        });
        if (!teamsRes.ok) {
          const body = await teamsRes.text().catch(() => "");
          logger.error('Teams webhook returned error', { status: teamsRes.status, body: body.slice(0, 200) });
          classifyAndLogIfEnabled(
            new Error(`Teams webhook returned ${teamsRes.status}${body ? `: ${body.slice(0, 200)}` : ""}`),
            "notify_teams",
            logger,
          );
        } else {
          logger.info('Teams notification sent');
        }
      } catch (err) {
        logger.error('Teams webhook failed', { error: String(err) });
        classifyAndLogIfEnabled(err, "notify_teams", logger);
      }
    } else {
      logger.warn('TEAMS_WEBHOOK_URL not configured, skipping');
    }

    // Step 8: UPDATE infra_requests row
    try {
      await pool.query(
        `UPDATE infra_requests
         SET gitlab_mr_url = $1, gitlab_branch = $2, jira_key = $3,
             executed_at = NOW(), status = 'executed'
         WHERE id = $4`,
        [mrUrl, branchName, jiraKey, id]
      );
      requestStatus = "executed";
      logger.info('DB updated', { status: 'executed', mrUrl, jiraKey });
    } catch (err) {
      logger.error('DB update failed', { error: String(err) });
      classifyAndLogIfEnabled(err, "db_update", logger);
      return NextResponse.json({ error: "DB update failed", detail: String(err) }, { status: 500 });
    }

    // Step 9: Notify requestor
    await notifyRequestor(requestorEmail, id, "approval_result",
      `Tu solicitud de infraestructura ha sido ejecutada correctamente. El código Terraform está listo para revisión.`,
      `/infra-requests`
    );

    logger.done('Execution complete', { mrUrl, branchName, jiraKey });

    return NextResponse.json({
      ok: true,
      gitlab_mr_url: mrUrl,
      gitlab_branch: branchName,
      jira_key: jiraKey,
    });
  } finally {
    // Branch rollback: if branch was created but request did not reach 'executed' status,
    // clean up the branch to avoid orphaned branches in the repository.
    if (branchCreated && requestStatus !== "executed") {
      try {
        await deleteBranch(projectId, branchName);
        logger.info('Branch rolled back', { branchName });
      } catch (rollbackErr) {
        logger.error('Branch rollback failed (non-fatal)', { error: String(rollbackErr) });
      }
    }
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────

async function notifyRequestor(
  email: string, requestId: number,
  type: "info" | "approval_result" | "execute_failed",
  message: string, link?: string
) {
  try {
    await createNotification({
      userEmail: email,
      type: type === "execute_failed" ? "system" : type,
      title: type === "execute_failed" ? "Error en ejecución de infraestructura" : "Solicitud de infraestructura ejecutada",
      message, link: link || `/infra-requests`,
      metadata: { requestId },
    });
  } catch (err) {
    // Use console.error here since logger may not be in scope for this helper
    console.error(`[execute/${requestId}] notification failed:`, err);
  }
}

async function deleteBranch(projectId: number, branchName: string): Promise<void> {
  const url = `https://gitlab.com/api/v4/projects/${projectId}/repository/branches/${encodeURIComponent(branchName)}`;
  const res = await fetch(url, { method: "DELETE", headers: { "PRIVATE-TOKEN": process.env.GITLAB_TOKEN || "" } });
  if (!res.ok && res.status !== 404) throw new Error(`DELETE branch returned ${res.status}`);
}

const AUX_MAX_RETRIES = 3;

// Applies a single auxiliary-file operation on `branch` with optimistic locking
// and retry on concurrent-modification conflicts (same pattern as the shared-file
// path). Supported ops:
//   - create:        write op.content (create-or-update if it already exists)
//   - append:        current + "\n\n" + op.content (create with content if absent)
//   - upsert-entries: merge tfvars k=v entries non-destructively (empty base if absent)
async function applyAuxiliaryFileOp(
  projectId: number,
  branch: string,
  op: AuxiliaryFileOp,
  commitMessage: string,
  logger: InfraLogger,
): Promise<void> {
  let attempt = 0;
  while (attempt < AUX_MAX_RETRIES) {
    attempt++;
    try {
      const fileMeta = await gitlabClient.getRepositoryFileWithMeta(projectId, op.filePath, branch);
      const exists = fileMeta !== null;
      const currentContent = fileMeta?.content ?? "";
      const lastCommitId = fileMeta?.lastCommitId;

      let newContent: string;
      switch (op.op) {
        case "create":
          newContent = op.content ?? "";
          break;
        case "append":
          newContent = exists && currentContent.length > 0
            ? currentContent + "\n\n" + (op.content ?? "")
            : (op.content ?? "");
          break;
        case "upsert-entries":
          newContent = upsertTfvarsEntries(currentContent, op.entries ?? []);
          break;
        default:
          throw new Error(`Unknown auxiliary file op: ${(op as AuxiliaryFileOp).op}`);
      }

      if (exists) {
        await gitlabClient.updateFile(projectId, op.filePath, branch, newContent, commitMessage, lastCommitId);
      } else {
        await gitlabClient.createFile(projectId, op.filePath, branch, newContent, commitMessage);
      }
      logger.info('Auxiliary file applied', { filePath: op.filePath, op: op.op, attempt });
      return;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const isConflict = errMsg.includes("409") || errMsg.toLowerCase().includes("conflict") || errMsg.toLowerCase().includes("modified");
      if (isConflict && attempt < AUX_MAX_RETRIES) {
        logger.warn('Conflict on auxiliary file, retrying', { filePath: op.filePath, attempt });
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Auxiliary file "${op.filePath}" failed after ${AUX_MAX_RETRIES} attempts due to conflicts`);
}

function buildTeamsAdaptiveCard(opts: { id: number; team: string; resourceName: string; mrUrl: string | null; jiraKey: string | null }) {
  return {
    type: "message",
    attachments: [{
      contentType: "application/vnd.microsoft.card.adaptive",
      content: {
        $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
        type: "AdaptiveCard", version: "1.4",
        body: [
          { type: "TextBlock", text: "🚀 Nueva infraestructura creada", weight: "Bolder", size: "Medium" },
          { type: "FactSet", facts: [
            { title: "Equipo", value: opts.team },
            { title: "Recurso", value: opts.resourceName },
            { title: "Request ID", value: String(opts.id) },
            { title: "Jira", value: opts.jiraKey || "N/A" },
            { title: "MR", value: opts.mrUrl || "Crear manualmente" },
          ]},
        ],
        ...(opts.mrUrl ? { actions: [{ type: "Action.OpenUrl", title: "Ver Merge Request", url: opts.mrUrl }] } : {}),
      },
    }],
  };
}
