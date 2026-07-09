/**
 * AI Portal Explorer — Regression_Detector.
 *
 * Feature: ai-portal-explorer
 *
 * Identifica las anomalías del Exploration_Run actual que son NUEVAS respecto al
 * run previo comparable (baseline). La equivalencia entre anomalías de runs
 * distintos se determina por la tripleta Route + Role + categoría (Req 8.4).
 *
 * Funciones puras, sin efectos secundarios: comparan dos listas de Triage_Results.
 *
 * _Requirements: 8.1, 8.2, 8.3, 8.4_
 */

import type { TriageResult } from "./types";

/** Informe de regresiones de un Exploration_Run frente a su baseline. */
export interface RegressionReport {
  /** false si no hay run previo comparable (Req 8.3). */
  hasBaseline: boolean;
  /** Anomalías nuevas respecto al baseline (Req 8.1, 8.2). */
  regressions: TriageResult[];
}

/**
 * Clave de equivalencia para regresiones: Route + Role + categoría (Req 8.4).
 *
 * Es consistente con `anomalyEquivalenceKey` de anomaly-detectors.ts: para un
 * TriageResult, `route` ya es el path (string) y `category` la categoría de la
 * anomalía. Se define localmente para mantener este módulo autocontenido; si en
 * el futuro se quiere compartir, importar desde anomaly-detectors.ts.
 */
function regressionEquivalenceKey(t: TriageResult): string {
  return `${t.route}::${t.role}::${t.category}`;
}

/**
 * Identifica como Regression cada anomalía del run actual ausente (por
 * Route + Role + categoría) en el run previo comparable.
 *
 * - Si `previous` es null → no hay baseline: `hasBaseline: false` y
 *   `regressions: []` (todas las anomalías quedan como no clasificables como
 *   regresión, registrando la ausencia de base de comparación) (Req 8.3).
 * - En caso contrario → `hasBaseline: true`; una anomalía del run actual es
 *   regresión si y solo si su clave de equivalencia NO está presente en el
 *   baseline (Req 8.1, 8.4).
 *
 * @param current  Triage_Results del run actual.
 * @param previous Triage_Results del run previo comparable, o null si no existe.
 */
export function detectRegressions(
  current: TriageResult[],
  previous: TriageResult[] | null,
): RegressionReport {
  if (previous === null) {
    return { hasBaseline: false, regressions: [] };
  }

  const baselineKeys = new Set<string>(previous.map(regressionEquivalenceKey));

  const regressions = current.filter(
    (t) => !baselineKeys.has(regressionEquivalenceKey(t)),
  );

  return { hasBaseline: true, regressions };
}
