/**
 * Render determinista — composes the parameterized RDS `.tf`, the variable
 * declarations for `iac/databases/variables.tf` and the per-environment tfvars
 * entries, as pure functions (no I/O, fully reproducible).
 *
 * The five engine/version/flag attributes (`engine_version`, `family`,
 * `major_engine_version`, `allow_major_version_upgrade`, `apply_immediately`)
 * are ALWAYS emitted as `var.<db>_...` references (zero literals — R3.1), where
 * the per-database prefix `<db>` is `tfId(identifier)`. The mandatory
 * Bloque_Rotacion (R5) is always present, and `count` scopes the resource to
 * the selected Entornos_Destino unless all three are present (R6.3).
 *
 * The same five variables are written with a value in all three tfvars
 * (dev/uat/pro) regardless of the selected environments, so `terraform plan`
 * never fails for unassigned variables (R6.1, R6.2); the per-environment
 * scoping is done by `count`, not by the absence of a variable value.
 *
 * ## Multi-environment tfvars operations (Feature: infra-self-service-hardening, Task 7.2)
 *
 * The single-file merge helper {@link upsertTfvarsEntries} keeps its historic
 * signature `(currentContent, entries) => string` **untouched** — every
 * existing caller (`/api/infra-assistant/execute/[id]`, the property tests,
 * the checkpoint suite) continues to work byte-for-byte. To support the
 * `targetEnvironments` operation of `POST /api/infra-request-v2/modify` (Reqs
 * 4.6, 4.8, 6.4), which needs to ADD entries to newly-included envs AND
 * REMOVE this resource's entries from retired envs across up to three tfvars
 * files, this module additionally exports:
 *
 *   - {@link removeTfvarsEntriesByPrefix} — strip every entry whose key starts
 *     with `<identifier>_` from a tfvars content, preserving byte-exact the
 *     rest (including the trailing newline of surviving entries).
 *   - {@link upsertTfvarsEntriesMulti} — multi-file orchestrator that consumes
 *     a per-env spec (path + current content + entries to upsert) and an
 *     optional `{ removeEnvironments, identifier }`, returns the new content
 *     per file plus a `filesAffected` classification (added / updated /
 *     deleted) that the executor propagates to the MR as CREATE / UPDATE /
 *     DELETE GitLab actions.
 *
 * Requirements: 3.1, 3.2, 3.3, 4.1, 4.6, 4.8, 5.1, 5.4, 6.1, 6.3, 6.4
 */

import type { Env } from "../infra/environments-parser";
import type { RdsFields } from "../infra-prompt-builder";
import type { NetworkWiring } from "./network-extractor";

/** Canonical Portal environment order. `prod` maps to the `pro.tfvars` file. */
const ALL_ENVS = ["dev", "uat", "prod"] as const;

export interface ParameterizedVar {
  /** Prefixed name, e.g. "<db>_rds_version". */
  name: string;
  /** Terraform type. */
  type: "string" | "bool";
  /** Per-environment values for the tfvars (`prod` is keyed as `pro`). */
  values: { dev: string; uat: string; pro: string };
}

export interface RenderedRds {
  /** Primary `.tf` content (var references, Bloque_Rotacion, optional count). */
  tf: string;
  /** `variable "..." { type = ... }` declarations to add to variables.tf (new only). */
  variableDeclarations: string;
  /** The five parameterized variables with their per-environment values. */
  vars: ParameterizedVar[];
}

/**
 * Terraform module/resource label: lowercase, non-alphanumeric runs collapse to
 * a single underscore, surrounding underscores trimmed. E.g.
 * `marketplace-payments-api-db` → `marketplace_payments_api_db`.
 */
export function tfId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/**
 * Master username for the AWS RDS `aws_db_instance`. The upstream module
 * `terraform-aws-modules/rds/aws` v6.6.0 requires `username` in the resource
 * even when `manage_master_user_password = true` (AWS Secrets Manager owns the
 * password rotation but not the identity itself). Without it the resource
 * fails `terraform apply` with `"username": required field is not set`.
 *
 * Follows the naming convention observed in the digital squad's `oms` repo
 * (`iac/databases/*.tf` files like `core.tf`, `marketplace.tf`, `loyalty.tf`,
 * `subscriptions-api.tf`): the master user is `<db_name minus trailing "db">adm`,
 * stripped of any non-alphanumeric characters.
 *
 * Examples:
 *   coredb              → coreadm
 *   marketplacedb       → marketplaceadm
 *   loyaltydb           → loyaltyadm
 *   subssapi            → subssapiadm
 *   mkp_ur_connector    → mkpurconnectoradm
 *
 * PostgreSQL identifier limit is 63 chars — no truncation is required for the
 * db_names the portal accepts (max 63 chars pre-sanitisation, and the "adm"
 * suffix keeps well below).
 */
export function buildMasterUsername(dbName: string): string {
  const alnum = dbName.toLowerCase().replace(/[^a-z0-9]/g, "");
  const withoutTrailingDb = alnum.replace(/db$/, "");
  return `${withoutTrailingDb}adm`;
}

/** Same value across the three tfvars (scoping is done via `count`). */
function triple(value: string): { dev: string; uat: string; pro: string } {
  return { dev: value, uat: value, pro: value };
}

/**
 * Builds the five ParameterizedVar for a database prefix.
 *
 * | variable                         | type   | value             |
 * |----------------------------------|--------|-------------------|
 * | <db>_rds_version                 | string | engineVersion     |
 * | <db>_family                      | string | family            |
 * | <db>_major_engine_version        | string | engineVersion     |
 * | <db>_allow_major_version_upgrade | bool   | "false"           |
 * | <db>_apply_immediately           | bool   | "false"           |
 */
function buildVars(db: string, engineVersion: string, family: string): ParameterizedVar[] {
  return [
    { name: `${db}_rds_version`, type: "string", values: triple(engineVersion) },
    { name: `${db}_family`, type: "string", values: triple(family) },
    { name: `${db}_major_engine_version`, type: "string", values: triple(engineVersion) },
    { name: `${db}_allow_major_version_upgrade`, type: "bool", values: triple("false") },
    { name: `${db}_apply_immediately`, type: "bool", values: triple("false") },
  ];
}

/**
 * Composes the deterministic RDS `.tf`, the new variable declarations and the
 * five parameterized variables. `dbPrefix = tfId(fields.identifier)`.
 *
 * @param fields              RDS form fields (engine, engineVersion, identifier, ...).
 * @param family             Familia derived from the catalog by the generator.
 * @param moduleVersion      Exact module version (MAJOR.MINOR.PATCH, no operators).
 * @param targetEnvironments Subset of dev/uat/prod selected by the requester.
 * @param existingVariables  Variables already declared in variables.tf (with prefix).
 * @param network            Network wiring (VPC/subnets/SG) discovered from the
 *                           target repo's existing RDS modules (SRE-001). Emitted
 *                           as an `aws_security_group` resource before the module
 *                           plus `subnet_ids`/`vpc_security_group_ids`/subnet-group
 *                           attributes inside it, so the RDS never lands in the
 *                           account's default VPC.
 */
export function renderRds(
  fields: RdsFields,
  family: string,
  moduleVersion: string,
  targetEnvironments: string[],
  existingVariables: Set<string>,
  network: NetworkWiring,
): RenderedRds {
  const db = tfId(fields.identifier);
  const engine = fields.engine ?? "postgres";
  const vars = buildVars(db, fields.engineVersion, family);

  // count: only when the Entornos_Destino do NOT include all three. The list is
  // normalized to the canonical dev/uat/prod order for determinism (R6.3).
  const selected = ALL_ENVS.filter((e) => targetEnvironments.includes(e));
  const hasAllEnvs = selected.length === ALL_ENVS.length;
  const countList = selected.map((e) => `"${e}"`).join(", ");
  const countExpr = `contains([${countList}], var.environment) ? 1 : 0`;

  // Security-group reference from the module: index [0] only when the resource
  // carries a `count` (i.e. not all three envs selected).
  const sgRef = hasAllEnvs
    ? `aws_security_group.${db}.id`
    : `aws_security_group.${db}[0].id`;

  const lines: string[] = [];

  // ── Security group (SRE-001) — emitted BEFORE the module so the RDS is wired
  // to the discovered VPC/subnets and never falls back to the default VPC. The
  // SG `count` mirrors the module `count` exactly.
  lines.push(`resource "aws_security_group" "${db}" {`);
  if (!hasAllEnvs) {
    lines.push(`  count       = ${countExpr}`);
  }
  lines.push(`  description = "${fields.identifier} RDS Access"`);
  lines.push(`  vpc_id      = ${network.vpcIdExpr}`);
  lines.push(`  ingress {`);
  lines.push(`    protocol    = "tcp"`);
  lines.push(`    from_port   = ${network.port}`);
  lines.push(`    to_port     = ${network.port}`);
  lines.push(`    cidr_blocks = ${network.ingressCidrExpr}`);
  lines.push(`  }`);
  lines.push(`}`);
  lines.push("");

  lines.push(`module "${db}" {`);
  lines.push(`  source  = "terraform-aws-modules/rds/aws"`);
  lines.push(`  version = "${moduleVersion}"`);
  lines.push("");
  lines.push(`  identifier = "${fields.identifier}"`);
  if (!hasAllEnvs) {
    lines.push(`  count      = ${countExpr}`);
  }
  lines.push("");
  // engine is allowed as a literal; the five parameterized attributes are NOT.
  lines.push(`  engine         = "${engine}"`);
  lines.push(`  engine_version = var.${db}_rds_version`);
  lines.push(`  family         = var.${db}_family`);
  lines.push(`  major_engine_version        = var.${db}_major_engine_version`);
  lines.push(`  allow_major_version_upgrade = var.${db}_allow_major_version_upgrade`);
  lines.push(`  apply_immediately           = var.${db}_apply_immediately`);
  lines.push("");
  lines.push(`  db_name           = "${fields.dbName}"`);
  lines.push(`  username          = "${buildMasterUsername(fields.dbName)}"`);
  lines.push(`  instance_class    = "${fields.instanceClass}"`);
  lines.push(`  allocated_storage = ${fields.storageGb}`);
  lines.push(`  multi_az          = ${fields.multiAz}`);
  lines.push("");
  // ── Red descubierta del repo destino (SRE-001) — nunca VPC por defecto.
  lines.push(`  vpc_security_group_ids          = [${sgRef}]`);
  lines.push(`  storage_encrypted               = true`);
  lines.push(`  create_db_subnet_group          = true`);
  lines.push(`  db_subnet_group_name            = "db_${engine}_${db}"`);
  lines.push(`  db_subnet_group_use_name_prefix = false`);
  lines.push(`  subnet_ids                      = ${network.subnetIdsExpr}`);
  lines.push(`  port                            = ${network.port}`);
  lines.push(`  create_cloudwatch_log_group     = true`);
  lines.push(`  deletion_protection             = var.environment == "prod" ? true : false`);
  lines.push(`  backup_retention_period         = 30`);
  lines.push(`  skip_final_snapshot             = var.environment == "prod" ? true : false`);
  lines.push("");
  lines.push(`  # Rotación obligatoria de contraseña master (Bloque_Rotacion)`);
  lines.push(`  manage_master_user_password                       = true`);
  lines.push(`  manage_master_user_password_rotation              = true`);
  lines.push(`  master_user_password_rotate_immediately           = false`);
  lines.push(`  master_user_password_rotation_schedule_expression = "rate(15 days)"`);
  lines.push("");
  lines.push(`  tags = {`);
  lines.push(`    Terraform   = true`);
  lines.push(`    Environment = var.environment`);
  lines.push(`  }`);
  lines.push(`}`);
  const tf = lines.join("\n") + "\n";

  // Only declare variables that do not already exist in the Repositorio_Destino.
  const variableDeclarations = vars
    .filter((v) => !existingVariables.has(v.name))
    .map((v) => `variable "${v.name}" { type = ${v.type} }`)
    .join("\n");

  return { tf, variableDeclarations, vars };
}

/**
 * Non-destructive merge of `key = value` entries into a tfvars file: existing
 * keys are updated in place (preserving leading indentation), missing keys are
 * appended, and every other line of the file is preserved verbatim (R6.1, R6.3).
 *
 * Values are typed: `bool` is rendered unquoted (`false`), `string` is quoted
 * (`"18"`).
 */
export function upsertTfvarsEntries(
  currentContent: string,
  entries: Array<{ key: string; value: string; type: "string" | "bool" }>,
): string {
  const formatValue = (e: { value: string; type: "string" | "bool" }): string =>
    e.type === "bool" ? e.value : `"${e.value}"`;

  const pending = new Map(entries.map((e) => [e.key, e] as const));
  const lines = currentContent.length === 0 ? [] : currentContent.split("\n");

  const updated = lines.map((line) => {
    const m = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*)\s*=.*$/);
    if (m) {
      const indent = m[1];
      const key = m[2];
      const entry = pending.get(key);
      if (entry) {
        pending.delete(key);
        return `${indent}${key} = ${formatValue(entry)}`;
      }
    }
    return line;
  });

  const toAppend = entries
    .filter((e) => pending.has(e.key))
    .map((e) => `${e.key} = ${formatValue(e)}`);

  let result = updated.join("\n");
  if (toAppend.length > 0) {
    if (result.length > 0 && !result.endsWith("\n")) result += "\n";
    result += toAppend.join("\n") + "\n";
  }
  return result;
}

/**
 * Escapes regex metacharacters in an identifier so it can be safely embedded
 * in a `RegExp` source string. Local helper for {@link removeTfvarsEntriesByPrefix}.
 */
function escapeRegex(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Removes every tfvars entry whose key starts with `<identifier>_` from
 * `currentContent`. Any other byte of the file is preserved verbatim — the
 * matched entry's own trailing newline is also consumed so the surrounding
 * lines do not gain a blank separator.
 *
 * Total. Never throws. Returns the input unchanged when `identifier` is empty
 * or the content is empty. Only lines that look like a Terraform assignment
 * (`^[ \t]*<key>\s*=...`) are candidates for removal; comments and free-form
 * text lines are always preserved.
 *
 * Requirements: 4.6
 */
export function removeTfvarsEntriesByPrefix(
  currentContent: string,
  identifier: string,
): string {
  if (typeof currentContent !== "string" || currentContent.length === 0) return currentContent;
  if (typeof identifier !== "string" || identifier.length === 0) return currentContent;
  const prefix = escapeRegex(identifier);
  // Match: optional leading indentation, key starting with `<identifier>_`
  // followed by an identifier tail, `\s*=`, the rest of the line (no newline),
  // and an OPTIONAL trailing newline (consumed to avoid dangling blank lines).
  const re = new RegExp(
    `^[ \\t]*${prefix}_[A-Za-z_][A-Za-z0-9_]*\\s*=[^\\n]*\\n?`,
    "gm",
  );
  return currentContent.replace(re, "");
}

/**
 * A single per-env input to {@link upsertTfvarsEntriesMulti}.
 */
export interface TfvarsFileSpec {
  /** Canonical environment slot (`dev`/`uat`/`prod`) this file corresponds to. */
  env: Env;
  /**
   * Repo-relative path of the tfvars file, e.g. `iac/databases/vars/dev.tfvars`
   * (or `iac/databases/vars/pro.tfvars` for `prod` — the caller decides the
   * mapping, this helper just carries the path through).
   */
  filePath: string;
  /**
   * Current byte content of the file. Use `null` when the file does not exist
   * on the source branch; the multi helper will emit a `create` op with the
   * merged entries as content. Existing files receive `update` (or `delete`
   * if the file becomes empty after removing entries). NB: for the RDS
   * modify flow the caller (Modify_API) validates existence first and rejects
   * missing tfvars with HTTP 422 `missing_tfvars_file` (Req 4.8), so in
   * practice this stays non-null.
   */
  currentContent: string | null;
  /** Entries to upsert into this env's tfvars. Empty array is allowed. */
  entries: Array<{ key: string; value: string; type: "string" | "bool" }>;
}

/**
 * Options for {@link upsertTfvarsEntriesMulti}.
 */
export interface TfvarsMultiOptions {
  /**
   * Environments where the resource is being retired. For each env listed,
   * every entry whose key starts with `<identifier>_` is stripped from that
   * env's tfvars file (byte-exact for the surviving content). Ignored when
   * `identifier` is missing or empty.
   */
  removeEnvironments?: Env[];
  /**
   * Terraform identifier prefix (typically the output of {@link tfId}).
   * Selects which entries are stripped from the tfvars of the environments
   * listed in `removeEnvironments`.
   */
  identifier?: string;
}

/**
 * A single file-level action produced by {@link upsertTfvarsEntriesMulti}.
 */
export interface TfvarsMultiFile {
  env: Env;
  filePath: string;
  op: "create" | "update" | "delete";
  /** New content of the file. Omitted (undefined) when `op === "delete"`. */
  content?: string;
}

/**
 * Result of {@link upsertTfvarsEntriesMulti}.
 */
export interface TfvarsMultiResult {
  /**
   * Ordered list of file-level actions the executor must apply. Only files
   * whose content actually changed are included; unchanged files are dropped.
   */
  files: TfvarsMultiFile[];
  /**
   * Repo-relative paths grouped by operation. The executor uses this to
   * translate the change set into GitLab commit actions (`create` /
   * `update` / `delete`) so the MR carries the complete diff — new tfvars
   * entries for envs being added AND the removal of this resource's entries
   * from envs being retired.
   */
  filesAffected: {
    added: string[];
    updated: string[];
    deleted: string[];
  };
}

/**
 * Multi-environment orchestrator over {@link upsertTfvarsEntries} and
 * {@link removeTfvarsEntriesByPrefix}. For each per-env spec:
 *
 *   1. If the env is listed in `options.removeEnvironments` **and**
 *      `options.identifier` is provided, strip every entry whose key starts
 *      with `${identifier}_` from the current content.
 *   2. Merge `spec.entries` into the (possibly stripped) content using the
 *      exact semantics of {@link upsertTfvarsEntries} (existing keys updated
 *      in place preserving leading indentation; missing keys appended;
 *      every other byte preserved).
 *
 * Files whose content ends up identical to the input are dropped from the
 * result (no-op). Files classified as:
 *   - `added`   → `currentContent === null` and new content is non-empty
 *   - `updated` → `currentContent !== null` and new content differs, non-empty
 *   - `deleted` → `currentContent !== null` and new content is empty (all
 *                 entries were stripped and no new ones were added)
 *
 * The single-file helper {@link upsertTfvarsEntries} is intentionally left
 * untouched — every existing caller continues to work byte-for-byte.
 *
 * Total. Never throws.
 *
 * Requirements: 4.6, 4.8, 6.4
 */
export function upsertTfvarsEntriesMulti(
  files: TfvarsFileSpec[],
  options?: TfvarsMultiOptions,
): TfvarsMultiResult {
  const removeSet = new Set<Env>(options?.removeEnvironments ?? []);
  const identifier = options?.identifier ?? "";
  const canRemove = removeSet.size > 0 && identifier.length > 0;

  const out: TfvarsMultiFile[] = [];
  const added: string[] = [];
  const updated: string[] = [];
  const deleted: string[] = [];

  for (const spec of files) {
    const previous = spec.currentContent ?? "";
    const stripped =
      canRemove && removeSet.has(spec.env)
        ? removeTfvarsEntriesByPrefix(previous, identifier)
        : previous;
    const merged =
      spec.entries.length > 0 ? upsertTfvarsEntries(stripped, spec.entries) : stripped;

    if (merged === previous) continue; // no-op

    if (spec.currentContent === null) {
      if (merged.length === 0) continue; // nothing to create
      out.push({ env: spec.env, filePath: spec.filePath, op: "create", content: merged });
      added.push(spec.filePath);
    } else if (merged.length === 0) {
      out.push({ env: spec.env, filePath: spec.filePath, op: "delete" });
      deleted.push(spec.filePath);
    } else {
      out.push({ env: spec.env, filePath: spec.filePath, op: "update", content: merged });
      updated.push(spec.filePath);
    }
  }

  return { files: out, filesAffected: { added, updated, deleted } };
}
