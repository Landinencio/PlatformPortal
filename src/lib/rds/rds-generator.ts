/**
 * Generador_RDS — deterministic RDS Terraform generator (spec:
 * portal-rds-creation-improvement). Replaces the AI-based `buildRdsPrompt`
 * branch for RDS creation.
 *
 * Orchestrates:
 *   1. Engine/version validation against the Catalogo_Versiones (R1.5, R2.5).
 *   2. Familia derivation. When `ENABLE_INFRA_HARDENING_V1` is off the value
 *      comes from the static Catalogo_Versiones (R2.4). When the flag is on
 *      the value is read from `EngineOption.family` (literal
 *      `DBParameterGroupFamily` from `rds:DescribeDBEngineVersions`, Req 1.3
 *      of `infra-self-service-hardening`) with fallthrough to the static
 *      catalog (Req 10.4) whenever `listRdsEngineOptions()` returns
 *      `{ ok: false }`, `{ ok: true, options: [] }` or an option set that
 *      does not include the requested `engineVersion`. The fallthrough is
 *      announced with an `InfraLogger.warn` declaring the source used
 *      (`static-catalog`). The dynamic path preserves the byte-exact
 *      `TerraformPreview` contract (Req 7.3) for every input already in the
 *      static catalog, because AWS returns the same `DBParameterGroupFamily`
 *      literal for the versions we support today (postgres 15/16/17/18).
 *   3. Read-only introspection of `iac/databases/` to reproduce the
 *      Convención_Parametrizada (module version, existing variables, count
 *      pattern). Falls back to `portalDefaultModuleVersion` when no module is
 *      found or the read fails (R4.4/R4.5); aborts with `missing_databases_dir`
 *      when the directory is not readable (R3.5).
 *   4. Deterministic render of the `.tf`, variable declarations and the three
 *      tfvars plans (R3.1, R3.2, R3.3, R6).
 *   5. Pre-emit guards: anti-literal (R3.6), tfvars completeness (R6.6) and
 *      preview↔form coherence (R7.5).
 *   6. Construction of the extended TerraformPreview (primary `.tf` +
 *      auxiliaryFiles + metadata).
 *
 * Every error condition prior to `execute` leaves the repository untouched.
 *
 * Requirements: 1.5, 1.6, 2.5, 3.1, 3.2, 3.4, 3.5, 3.6, 4.4, 4.5, 6.6, 7.2,
 *   7.5, and (infra-self-service-hardening) 1.3, 6.5, 7.3, 10.4.
 */

import { gitlabClient } from "../gitlab";
import { InfraLogger } from "../logger";
import { ENABLE_INFRA_HARDENING_V1 } from "../feature-flags";
import type { TerraformPreview, AuxiliaryFileOp } from "../infra-agent";
import type { RdsFields } from "../infra-prompt-builder";
import {
  isSupportedEngine,
  isValidEngineVersion,
  familyForVersion,
  SUPPORTED_ENGINES,
  type RdsEngine,
} from "./version-catalog";
import { listRdsEngineOptions } from "./aws-engine-catalog";
import { readRdsConvention } from "./repo-introspection";
import { renderRds, tfId, type ParameterizedVar } from "./render-rds";

const DATABASES_DIR = "iac/databases";
const VARIABLES_FILE = `${DATABASES_DIR}/variables.tf`;

/**
 * Region used to query the Catalogo_Dinamico when the flag
 * `ENABLE_INFRA_HARDENING_V1` is on. The design fixes the AWS_Region_Destino
 * to `eu-west-1` for every target account of the portal IaC flow, so the
 * value is a module-level constant. Extending the flow to per-request
 * regions in the future only needs to wire the value through
 * `RdsGenerateInput` (no change to the fallthrough contract).
 */
const RDS_CATALOG_REGION = "eu-west-1";

/**
 * Portal environment → tfvars file name (`prod` maps to `pro.tfvars`). Exported
 * so the completeness guard (`findTfvarsGap`) can be exercised as a pure unit
 * (Property 16) with the exact env→file mapping the generator uses internally.
 */
export const ENV_TO_TFVARS: Array<{ env: keyof ParameterizedVar["values"]; file: string }> = [
  { env: "dev", file: `${DATABASES_DIR}/vars/dev.tfvars` },
  { env: "uat", file: `${DATABASES_DIR}/vars/uat.tfvars` },
  { env: "pro", file: `${DATABASES_DIR}/vars/pro.tfvars` },
];

/** The five parameterized attributes as they appear in the rendered `.tf`. */
const PARAMETERIZED_ATTRIBUTES = [
  "engine_version",
  "family",
  "major_engine_version",
  "allow_major_version_upgrade",
  "apply_immediately",
] as const;

export interface RdsGenerateInput {
  /** RDS form fields (engine, engineVersion, identifier, dbName, ...). */
  fields: RdsFields;
  /** Subset of dev/uat/prod selected by the requester (Portal naming). */
  targetEnvironments: string[];
  projectId: number;
  defaultBranch: string;
  /** Portal standard Version_Modulo used as fallback (R4.4/R4.5). */
  portalDefaultModuleVersion: string;
}

export interface RdsGenerateOk {
  ok: true;
  preview: TerraformPreview;
}

export interface RdsGenerateError {
  ok: false;
  /**
   * 'invalid_engine' | 'invalid_version' | 'missing_databases_dir' |
   * 'network_convention_missing' | 'literal_guard' | 'tfvars_incomplete' |
   * 'coherence_mismatch'
   */
  code: string;
  message: string;
}

export type RdsGenerateResult = RdsGenerateOk | RdsGenerateError;

/**
 * Anti-literal guard (R3.6). Finds a parameterized attribute in a candidate
 * `.tf` that is assigned a literal value instead of the expected
 * `var.<db>_...` reference. Returns the offending attribute name, or null when
 * all five attributes use variable references.
 *
 * Exported so the guard can be exercised as a pure unit (Property 9). The
 * generator uses this exact same function internally — behavior is identical.
 */
export function findLiteralRdsAttribute(tf: string): string | null {
  for (const attr of PARAMETERIZED_ATTRIBUTES) {
    // Anchor at line start so `engine_version` does not match `major_engine_version`.
    const re = new RegExp(`^\\s*${attr}\\s*=\\s*(.+)$`, "m");
    const match = tf.match(re);
    if (!match) {
      // The attribute is missing entirely → treat as a literal-guard violation.
      return attr;
    }
    const rhs = match[1].trim();
    if (!rhs.startsWith("var.")) {
      return attr;
    }
  }
  return null;
}

/**
 * tfvars completeness guard (R6.6). Verifies that each of the five variables
 * has a non-empty value in each of the three tfvars (5×3 coverage). Returns the
 * offending `{ variable, file }` (the `file` being the full tfvars path, e.g.
 * `iac/databases/vars/dev.tfvars`) or null when coverage is complete.
 *
 * Exported so the guard can be exercised as a pure unit (Property 16). The
 * generator uses this exact same function internally — behavior is identical.
 */
export function findTfvarsGap(
  vars: ParameterizedVar[],
): { variable: string; file: string } | null {
  for (const { env, file } of ENV_TO_TFVARS) {
    for (const v of vars) {
      const value = v.values[env];
      if (value == null || value === "") {
        return { variable: v.name, file };
      }
    }
  }
  return null;
}

/**
 * Coherence guard preview↔form (R7.5). Compares the assembled preview
 * `metadata` (engine/engineVersion/family) against the values derived from the
 * form selection. Returns the first discrepant `{ field, message }`
 * (`field` ∈ `'engine' | 'engineVersion' | 'family'`) or null when all three
 * match.
 *
 * Exported so the guard can be exercised as a pure unit (Property 17). The
 * generator uses this exact same function internally — behavior is identical.
 */
export function checkRdsCoherence(
  metadata: { engine?: string; engineVersion?: string; family?: string } | undefined,
  form: { engine: string; engineVersion: string; family: string },
): { field: string; message: string } | null {
  if (metadata?.engine !== form.engine) {
    return {
      field: "engine",
      message: `Incoherencia en el campo "engine": preview="${metadata?.engine}" vs formulario="${form.engine}".`,
    };
  }
  if (metadata?.engineVersion !== form.engineVersion) {
    return {
      field: "engineVersion",
      message: `Incoherencia en el campo "engineVersion": preview="${metadata?.engineVersion}" vs formulario="${form.engineVersion}".`,
    };
  }
  if (metadata?.family !== form.family) {
    return {
      field: "family",
      message: `Incoherencia en el campo "family": preview="${metadata?.family}" vs formulario="${form.family}".`,
    };
  }
  return null;
}

export class RdsGenerator {
  constructor(private gitlab = gitlabClient) {}

  async generate(input: RdsGenerateInput): Promise<RdsGenerateResult> {
    const { fields, targetEnvironments, projectId, defaultBranch, portalDefaultModuleVersion } =
      input;

    // ── 1. Engine validation (R1.5) ──────────────────────────────────────────
    const engine = fields.engine ?? "postgres";
    if (!isSupportedEngine(engine)) {
      return {
        ok: false,
        code: "invalid_engine",
        message:
          `Motor de base de datos inválido: "${engine}". ` +
          `Valores admitidos: ${SUPPORTED_ENGINES.join(", ")}.`,
      };
    }

    // ── 2. Version validation (R2.5) ─────────────────────────────────────────
    if (!isValidEngineVersion(engine, fields.engineVersion)) {
      return {
        ok: false,
        code: "invalid_version",
        message:
          `Versión de motor inválida: "${fields.engineVersion}" para el motor "${engine}". ` +
          `No pertenece al catálogo de versiones de ${engine}.`,
      };
    }

    // ── 3. Familia derivation (R2.4) ─────────────────────────────────────────
    // Flag `ENABLE_INFRA_HARDENING_V1` (infra-self-service-hardening, Task 3.3):
    //   - OFF → historic behavior. `family` comes exclusively from the static
    //     Catalogo_Versiones. No AWS call. Byte-exact preview identical to
    //     `portal-prod v0.23.0-rc.1`.
    //   - ON  → primary source is the Catalogo_Dinamico (Req 1.3): the
    //     `DBParameterGroupFamily` literal returned by AWS for the exact
    //     `engineVersion` selected. Fallthrough to the static catalog when
    //     the dynamic response is `{ok: false}`, `{ok: true, options: []}` or
    //     the requested version is not present in `options` (Req 10.4). The
    //     fallthrough emits an `InfraLogger.warn` declaring the source used.
    //     For every input already in the static catalog the AWS value matches
    //     the static value (postgres 15/16/17/18 → same `postgres<major>`),
    //     so the byte-exact contract of Req 7.3 is preserved.
    let family: string | null;

    if (ENABLE_INFRA_HARDENING_V1) {
      const catalogResult = await listRdsEngineOptions(engine, RDS_CATALOG_REGION);
      const dynamicMatch =
        catalogResult.ok
          ? catalogResult.options.find((o) => o.version === fields.engineVersion)
          : undefined;

      if (dynamicMatch) {
        family = dynamicMatch.family;
      } else {
        const reason = !catalogResult.ok
          ? catalogResult.error.code
          : catalogResult.options.length === 0
            ? "empty_options"
            : "version_not_in_catalog";
        new InfraLogger("rds-generate", "system").warn(
          "Catalogo_Dinamico fallthrough to static version-catalog",
          {
            engine,
            engineVersion: fields.engineVersion,
            source: "static-catalog",
            reason,
          },
        );
        family = familyForVersion(engine, fields.engineVersion);
      }
    } else {
      family = familyForVersion(engine, fields.engineVersion);
    }

    if (family == null) {
      // Unreachable after the version check, but keep the invariant explicit.
      return {
        ok: false,
        code: "invalid_version",
        message:
          `No se pudo derivar la familia para "${fields.engineVersion}" (motor "${engine}").`,
      };
    }

    // ── 4. Repo introspection (R3.4, R3.5, R4.4, R4.5) ───────────────────────
    const convention = await readRdsConvention(this.gitlab, projectId, defaultBranch);
    if (!convention.databasesDirReadable) {
      return {
        ok: false,
        code: "missing_databases_dir",
        message:
          `No se pudo determinar la Convención_Parametrizada: el directorio ` +
          `"${DATABASES_DIR}/" no existe o no puede leerse en el repositorio destino.`,
      };
    }

    let moduleVersion = convention.moduleVersion;
    if (moduleVersion == null) {
      // No `terraform-aws-modules/rds/aws` module found → fall back (R4.4/R4.5).
      moduleVersion = portalDefaultModuleVersion;
      new InfraLogger("rds-generate", "system").warn(
        "No RDS module version found in iac/databases/; using portal default",
        { projectId, portalDefaultModuleVersion },
      );
    }

    // ── 4b. Fail-safe de red (SRE-001) ───────────────────────────────────────
    // Never fall through to the account's default VPC. If no network wiring
    // (VPC/subnets/SG) could be discovered from an existing RDS of the target
    // repo, BLOCK generation before rendering. The incident `mkp-ur-connector`
    // (prod digital 111222333444) landed in the default VPC because the render
    // had no network block; this guard makes that impossible.
    if (convention.networkWiring == null) {
      return {
        ok: false,
        code: "network_convention_missing",
        message:
          "No se pudo descubrir el cableado de red (VPC/subnets/SG) de ninguna RDS " +
          "existente en iac/databases/ del repo destino. Generación bloqueada para no " +
          "crear la base de datos en el VPC por defecto. Añade al menos una RDS de " +
          "referencia con security group y subnet_ids, o define la red manualmente.",
      };
    }

    // ── 5. Deterministic render (R3.1, R3.2, R3.3, R6) ───────────────────────
    const rendered = renderRds(
      { ...fields, engine, family },
      family,
      moduleVersion,
      targetEnvironments,
      convention.existingVariables,
      convention.networkWiring,
    );

    // ── 6. Pre-emit guards ───────────────────────────────────────────────────

    // 6a. Anti-literal guard (R3.6).
    const literalAttr = findLiteralRdsAttribute(rendered.tf);
    if (literalAttr != null) {
      return {
        ok: false,
        code: "literal_guard",
        message:
          `El atributo "${literalAttr}" se generó con un valor literal en lugar de una ` +
          `referencia a variable (var.${tfId(fields.identifier)}_...). Generación bloqueada.`,
      };
    }

    // 6b. tfvars completeness guard (R6.6).
    const gap = findTfvarsGap(rendered.vars);
    if (gap != null) {
      return {
        ok: false,
        code: "tfvars_incomplete",
        message:
          `La variable "${gap.variable}" quedaría sin valor en "${gap.file}". ` +
          `Generación abortada sin modificar el repositorio.`,
      };
    }

    // ── 7. Build the extended TerraformPreview ───────────────────────────────
    const auxiliaryFiles: AuxiliaryFileOp[] = [];

    // variables.tf append op (only when there are new declarations to add — R3.2).
    if (rendered.variableDeclarations.length > 0) {
      auxiliaryFiles.push({
        filePath: VARIABLES_FILE,
        op: "append",
        content: rendered.variableDeclarations,
      });
    }

    // Three tfvars upsert ops (R3.3, R6.1).
    for (const { env, file } of ENV_TO_TFVARS) {
      auxiliaryFiles.push({
        filePath: file,
        op: "upsert-entries",
        entries: rendered.vars.map((v) => ({
          key: v.name,
          value: v.values[env],
          type: v.type,
        })),
      });
    }

    const preview: TerraformPreview = {
      filePath: `${DATABASES_DIR}/${fields.identifier}.tf`,
      content: rendered.tf,
      resourceType: "rds",
      resourceName: fields.identifier,
      targetEnvironments,
      estimatedCostMonthly: null,
      auxiliaryFiles,
      metadata: {
        engine: engine as RdsEngine,
        engineVersion: fields.engineVersion,
        family,
      },
    };

    // 6c. Coherence guard preview↔form (R7.5). Runs against the assembled
    // metadata so a divergence blocks persistence and identifies the field.
    const coherence = checkRdsCoherence(preview.metadata, {
      engine,
      engineVersion: fields.engineVersion,
      family,
    });
    if (coherence != null) {
      return {
        ok: false,
        code: "coherence_mismatch",
        message: coherence.message,
      };
    }

    return { ok: true, preview };
  }
}
