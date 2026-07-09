/**
 * Variante canónica de Lead Time para reporting DORA oficial.
 * Mide desde el primer commit del MR hasta el deploy en producción.
 * Referencia: DORA/Accelerate State of DevOps Report.
 */
export const CANONICAL_LEAD_TIME_VARIANT = "first_commit" as const;

/** Variantes posibles de Lead Time */
export type LeadTimeVariant = "first_commit" | "mr_created" | "last_commit";

/** Orden de fallback cuando la variante canónica no está disponible. */
export const LEAD_TIME_FALLBACK_ORDER: LeadTimeVariant[] = [
  "first_commit",
  "mr_created",
  "last_commit",
];

/**
 * Parsea un entero positivo desde una variable de entorno.
 * Retorna null si la variable no existe, no es numérica, o no es positiva.
 */
export function parsePositiveEnvInt(envKey: string): number | null {
  const raw = process.env[envKey];
  if (raw == null || raw.trim() === "") return null;
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

/**
 * Umbral máximo de lead time en horas.
 * Despliegues con lead time superior se descartan del cálculo.
 * Configurable via variable de entorno DORA_MAX_LEAD_TIME_HOURS.
 * Default: 90 días (2160 horas).
 */
export const LEAD_TIME_GUARD_HOURS: number =
  parsePositiveEnvInt("DORA_MAX_LEAD_TIME_HOURS") ?? 90 * 24;

export function isValidLeadTimeHours(hours: number) {
  return Number.isFinite(hours) && hours >= 0 && hours <= LEAD_TIME_GUARD_HOURS;
}

/**
 * Selecciona la variante de lead time según el orden canónico de fallback.
 * Retorna el valor y la variante utilizada, o null si ninguna es válida.
 *
 * Un valor es válido si es finito y estrictamente positivo (> 0).
 */
export function selectLeadTimeWithVariant(
  firstCommitHours: number | null,
  mrCreatedHours: number | null,
  lastCommitHours: number | null
): { hours: number; variant: LeadTimeVariant } | null {
  const candidates: Array<{ hours: number | null; variant: LeadTimeVariant }> = [
    { hours: firstCommitHours, variant: "first_commit" },
    { hours: mrCreatedHours, variant: "mr_created" },
    { hours: lastCommitHours, variant: "last_commit" },
  ];

  for (const candidate of candidates) {
    if (
      candidate.hours != null &&
      Number.isFinite(candidate.hours) &&
      candidate.hours > 0
    ) {
      return { hours: candidate.hours, variant: candidate.variant };
    }
  }

  return null;
}

/**
 * Legacy function — kept for backward compatibility.
 * Prefer `selectLeadTimeWithVariant` for new code.
 */
export function pickPreferredLeadTimeHours(
  lastCommitHours: number,
  mrHours: number,
  firstCommitHours: number
): number | null {
  if (Number.isFinite(firstCommitHours) && firstCommitHours > 0) return firstCommitHours;
  if (Number.isFinite(mrHours) && mrHours > 0) return mrHours;
  if (Number.isFinite(lastCommitHours) && lastCommitHours > 0) return lastCommitHours;
  return null;
}

/**
 * Umbral de anomalía para Deployment Frequency.
 * Basado en el percentil 99 de frecuencias históricas observadas en el cluster.
 * Valores por encima de este umbral se consideran anómalos (posible error de conteo
 * o pipeline en loop). Configurable via DORA_DF_ANOMALY_THRESHOLD.
 */
export const DF_ANOMALY_THRESHOLD: number =
  parsePositiveEnvInt("DORA_DF_ANOMALY_THRESHOLD") ?? 50;

export function calculateDeploymentFrequencyPerProjectDay(deployments: number, projectDays: number) {
  return projectDays > 0 ? deployments / projectDays : 0;
}

/** Returns true when the DF value exceeds the anomaly threshold. */
export function isAnomalousDeploymentFrequency(df: number) {
  return df > DF_ANOMALY_THRESHOLD;
}

export function calculateChangeFailureRatePct(deployments: number, failures: number) {
  const total = deployments + failures;
  return total > 0 ? (failures / total) * 100 : 0;
}

export function calculateOpenAgingBuckets(openAgesHours: number[]) {
  return {
    over3d: openAgesHours.filter((value) => value >= 24 * 3).length,
    over7d: openAgesHours.filter((value) => value >= 24 * 7).length,
    over14d: openAgesHours.filter((value) => value >= 24 * 14).length,
  };
}

export function calculateSonarRiskScore(input: {
  vulnerabilities: number;
  bugs: number;
  securityHotspots: number;
  qualityGate: string;
  coverage: number;
}) {
  return (
    input.vulnerabilities * 4 +
    input.bugs * 2 +
    input.securityHotspots * 1.5 +
    (input.qualityGate === "ERROR" ? 20 : 0) +
    Math.max(0, 80 - input.coverage)
  );
}

/**
 * Calcula el confidence score (0-100) basado en:
 * - Porcentaje de despliegues con lead time disponible (peso 40%)
 * - Confianza promedio de correlaciones (peso 40%)
 * - Ausencia de anomalías (peso 20%)
 *
 * @param leadTimeCoveragePct - Porcentaje de despliegues con lead time [0, 100]
 * @param avgCorrelationConfidence - Confianza promedio de correlaciones [0, 1]
 * @param anomalyCount - Número de anomalías detectadas (≥ 0)
 * @returns Score en el rango [0, 100]
 */
export function calculateConfidenceScore(params: {
  leadTimeCoveragePct: number;
  avgCorrelationConfidence: number;
  anomalyCount: number;
}): number {
  const { leadTimeCoveragePct, avgCorrelationConfidence, anomalyCount } = params;

  // Clamp inputs to valid ranges
  const coverageClamped = Math.max(0, Math.min(100, leadTimeCoveragePct));
  const confidenceClamped = Math.max(0, Math.min(1, avgCorrelationConfidence));
  const anomalyClamped = Math.max(0, anomalyCount);

  // Weight: 40% lead time coverage, 40% correlation confidence, 20% anomaly absence
  const coverageScore = (coverageClamped / 100) * 40;
  const confidenceScore = confidenceClamped * 40;
  // Anomaly penalty: each anomaly reduces the 20% component, floored at 0
  const anomalyScore = Math.max(0, 20 - anomalyClamped * 5);

  const total = coverageScore + confidenceScore + anomalyScore;

  // Clamp final result to [0, 100]
  return Math.max(0, Math.min(100, total));
}
