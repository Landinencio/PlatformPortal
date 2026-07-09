/**
 * Catalogo_Versiones — single source of truth for RDS engines, versions and
 * parameter-group families.
 *
 * This pure module is shared by both the Formulario_RDS (which engines/versions
 * to offer and the per-engine defaults) and the deterministic Generador_RDS
 * (how the Familia is derived from the selected version). Keeping a single
 * catalog guarantees the UI and the backend can never diverge.
 *
 * Standard versions (Version_Estandar):
 *   - PostgreSQL → "18" (family "postgres18")
 *
 * NOTE: MySQL is intentionally NOT offered. By organizational decision, new RDS
 * instances may only use PostgreSQL; MySQL is rejected by the generator
 * (`invalid_engine`) and never shown by the form.
 */

export type RdsEngine = "postgres";

export interface EngineVersion {
  /** Major engine version, e.g. "18" (postgres) or "8.4" (mysql). */
  version: string;
  /** Associated parameter group family, e.g. "postgres18" / "mysql8.4". */
  family: string;
}

export interface EngineCatalogEntry {
  engine: RdsEngine;
  /** Allowed versions, ordered; the entry matching `defaultVersion` is the Version_Estandar. */
  versions: EngineVersion[];
  /** Version_Estandar (must exist in `versions`). */
  defaultVersion: string;
}

/** Single source of truth (form + generator). */
export const VERSION_CATALOG: Record<RdsEngine, EngineCatalogEntry> = {
  postgres: {
    engine: "postgres",
    defaultVersion: "18",
    versions: [
      { version: "18", family: "postgres18" },
      { version: "17", family: "postgres17" },
      { version: "16", family: "postgres16" },
      { version: "15", family: "postgres15" },
    ],
  },
};

export const SUPPORTED_ENGINES: RdsEngine[] = ["postgres"];

/** true if `engine` is a supported Motor. */
export function isSupportedEngine(engine: string): engine is RdsEngine {
  return (SUPPORTED_ENGINES as string[]).includes(engine);
}

/** Returns the Motor versions, or [] if the engine does not exist (empty catalog). */
export function versionsForEngine(engine: string): EngineVersion[] {
  if (!isSupportedEngine(engine)) return [];
  // Return a shallow copy so callers cannot mutate the catalog.
  return VERSION_CATALOG[engine].versions.map((v) => ({ ...v }));
}

/** Version_Estandar of the Motor (R2.2, R2.3). */
export function defaultVersionForEngine(engine: RdsEngine): string {
  return VERSION_CATALOG[engine].defaultVersion;
}

/**
 * Derives the Familia from (engine, version) using the catalog.
 * Returns null if the pair does not exist (R2.4, R7.3).
 */
export function familyForVersion(engine: string, version: string): string | null {
  if (!isSupportedEngine(engine)) return null;
  const match = VERSION_CATALOG[engine].versions.find((v) => v.version === version);
  return match ? match.family : null;
}

/** true if (engine, version) belongs to the catalog (R1.5, R2.5). */
export function isValidEngineVersion(engine: string, version: string): boolean {
  if (!isSupportedEngine(engine)) return false;
  return VERSION_CATALOG[engine].versions.some((v) => v.version === version);
}

/**
 * Reconciles the selected version when the Motor changes.
 *
 * - Keeps `prevVersion` if it belongs to the new engine's catalog.
 * - Otherwise returns `defaultVersionForEngine(engine)`.
 * - Returns null ("sin selección") when the new engine has no versions
 *   available (empty catalog), so the form can block submission (R1.4, R2.6).
 */
export function reconcileVersionOnEngineChange(
  engine: string,
  prevVersion: string | null | undefined,
): string | null {
  if (!isSupportedEngine(engine)) return null;
  const versions = VERSION_CATALOG[engine].versions;
  if (versions.length === 0) return null;
  if (prevVersion != null && versions.some((v) => v.version === prevVersion)) {
    return prevVersion;
  }
  return VERSION_CATALOG[engine].defaultVersion;
}
