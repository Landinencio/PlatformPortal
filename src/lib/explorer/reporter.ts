/**
 * AI Portal Explorer — Reporter.
 *
 * Feature: ai-portal-explorer
 *
 * Construye el artefacto Report de un Exploration_Run: agrega de forma
 * determinista los resultados (ReportSummary) y los renderiza como un documento
 * Markdown consumible por el asistente, incluyendo para cada Triage_Result su
 * Route, Role, Severity, categoría, causa probable, fix sugerido y referencia a
 * la evidencia, más un resumen con totales, anomalías por severidad y nº de
 * RBAC_Findings, y la sección de regresiones.
 *
 * Toda la lógica es pura y determinista (testeable por property-based testing).
 *
 * _Requirements: 7.1, 7.2, 7.3, 7.4_
 */

import { SEVERITY_ORDER } from "./types";
import type {
  ExplorationRun,
  Severity,
  TriageResult,
  VisitResult,
} from "./types";
import type { RegressionReport } from "./regression-detector";

/**
 * Artefacto estructurado de un Exploration_Run. Es la forma in-memory que el
 * Run_Orchestrator persiste (PostgreSQL + S3) y de la que deriva el Markdown.
 *
 * _Requirements: 7.1_
 */
export interface Report {
  run: ExplorationRun;
  triageResults: TriageResult[];
  regressions: RegressionReport;
  summary: ReportSummary;
}

/**
 * Resumen agregado de un Exploration_Run.
 *
 * - `routesVisited`: número de Routes distintas visitadas.
 * - `anomaliesBySeverity`: número de Triage_Results por Severity.
 * - `rbacFindings`: número de Triage_Results de categoría `rbac`.
 *
 * _Requirements: 7.4_
 */
export interface ReportSummary {
  routesVisited: number;
  anomaliesBySeverity: Record<Severity, number>;
  rbacFindings: number;
}

/** Crea el mapa de severidades inicializado a cero, en el orden canónico. */
function emptySeverityCounts(): Record<Severity, number> {
  const counts = {} as Record<Severity, number>;
  for (const severity of SEVERITY_ORDER) {
    counts[severity] = 0;
  }
  return counts;
}

/**
 * Calcula el resumen determinista de un Exploration_Run.
 *
 * - `routesVisited` = nº de paths de Route distintos entre los Visit_Results.
 * - `anomaliesBySeverity` = recuento de Triage_Results por Severity.
 * - `rbacFindings` = recuento de Triage_Results de categoría `rbac`.
 *
 * Es una función pura: para las mismas entradas produce el mismo resumen,
 * independientemente del orden de los elementos.
 *
 * _Requirements: 7.4_
 */
export function buildSummary(
  visits: VisitResult[],
  triage: TriageResult[],
): ReportSummary {
  const distinctRoutes = new Set<string>();
  for (const visit of visits) {
    distinctRoutes.add(visit.route.path);
  }

  const anomaliesBySeverity = emptySeverityCounts();
  let rbacFindings = 0;
  for (const result of triage) {
    anomaliesBySeverity[result.severity] += 1;
    if (result.category === "rbac") {
      rbacFindings += 1;
    }
  }

  return {
    routesVisited: distinctRoutes.size,
    anomaliesBySeverity,
    rbacFindings,
  };
}

/** Escapa los caracteres que romperían una celda de tabla Markdown. */
function mdCell(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** Referencia legible a la evidencia de un Triage_Result. */
function evidenceReference(result: TriageResult): string {
  const { evidence } = result;
  const parts: string[] = [];
  if (evidence.screenshotRef) {
    parts.push(`screenshot: ${evidence.screenshotRef}`);
  }
  if (evidence.httpStatus !== null && evidence.httpStatus !== undefined) {
    parts.push(`httpStatus: ${evidence.httpStatus}`);
  }
  if (evidence.latencyMs !== null && evidence.latencyMs !== undefined) {
    parts.push(`latencyMs: ${evidence.latencyMs}`);
  }
  if (evidence.consoleErrors.length > 0) {
    parts.push(`consoleErrors: ${evidence.consoleErrors.length}`);
  }
  if (evidence.failedRequests.length > 0) {
    parts.push(`failedRequests: ${evidence.failedRequests.length}`);
  }
  if (evidence.domErrorStates.length > 0) {
    parts.push(`domErrorStates: ${evidence.domErrorStates.length}`);
  }
  if (evidence.observedAccess && evidence.expectedAccess) {
    parts.push(
      `access observed=${evidence.observedAccess} expected=${evidence.expectedAccess}`,
    );
  }
  const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
  return `${evidence.summary}${detail}`;
}

/**
 * Renderiza el Report como un documento Markdown consumible por el asistente.
 *
 * Incluye:
 * - Cabecera con el identificador del run, su estado y marcas temporales.
 * - Resumen: total de Routes visitadas, anomalías por Severity y nº de
 *   RBAC_Findings.
 * - Sección de regresiones respecto al baseline.
 * - Detalle por cada Triage_Result: Route, Role, Severity, categoría, causa
 *   probable, fix sugerido y referencia a la evidencia.
 *
 * _Requirements: 7.2, 7.3_
 */
export function renderMarkdown(report: Report): string {
  const { run, summary, triageResults, regressions } = report;
  const lines: string[] = [];

  lines.push("# AI Portal Explorer — Report");
  lines.push("");
  lines.push(`- **Run ID:** ${run.runId}`);
  lines.push(`- **Estado:** ${run.status}`);
  lines.push(`- **Base URL:** ${run.baseUrl}`);
  lines.push(`- **Inicio:** ${run.startedAt}`);
  lines.push(`- **Fin:** ${run.finishedAt ?? "—"}`);
  lines.push(`- **Roles cubiertos:** ${run.rolesCovered.join(", ") || "—"}`);
  if (run.abortReason) {
    lines.push(`- **Motivo de aborto:** ${run.abortReason}`);
  }
  lines.push("");

  // Resumen (Req 7.4)
  lines.push("## Resumen");
  lines.push("");
  lines.push(`- **Routes visitadas:** ${summary.routesVisited}`);
  lines.push(`- **RBAC findings:** ${summary.rbacFindings}`);
  lines.push("- **Anomalías por severidad:**");
  for (const severity of SEVERITY_ORDER) {
    lines.push(`  - ${severity}: ${summary.anomaliesBySeverity[severity]}`);
  }
  lines.push("");

  // Regresiones (Req 8.2, contexto del Report)
  lines.push("## Regresiones");
  lines.push("");
  if (!regressions.hasBaseline) {
    lines.push(
      "No hay run previo comparable: las anomalías de este run no se clasifican como regresión.",
    );
  } else if (regressions.regressions.length === 0) {
    lines.push("Sin regresiones nuevas respecto al run previo.");
  } else {
    lines.push(
      `${regressions.regressions.length} regresión(es) nueva(s) respecto al run previo:`,
    );
    lines.push("");
    for (const reg of regressions.regressions) {
      lines.push(
        `- **${reg.route}** [${reg.role}] — ${reg.severity} / ${reg.category}`,
      );
    }
  }
  lines.push("");

  // Detalle de hallazgos (Req 7.3)
  lines.push("## Hallazgos (Triage)");
  lines.push("");
  if (triageResults.length === 0) {
    lines.push("No se detectaron anomalías en este run.");
    lines.push("");
    return lines.join("\n");
  }

  for (const result of triageResults) {
    lines.push(`### ${result.route} — ${result.role} — ${result.severity}`);
    lines.push("");
    lines.push(`- **ID:** ${result.id}`);
    lines.push(`- **Route:** ${result.route}`);
    lines.push(`- **Role:** ${result.role}`);
    lines.push(`- **Severity:** ${result.severity}`);
    lines.push(`- **Categoría:** ${result.category}`);
    lines.push(`- **Estado de triage:** ${result.status}`);
    lines.push(`- **Causa probable:** ${result.probable_cause}`);
    lines.push(`- **Fix sugerido:** ${result.suggested_fix}`);
    lines.push(`- **Evidencia:** ${evidenceReference(result)}`);
    lines.push("");
  }

  // Tabla compacta de hallazgos para consumo tabular del asistente.
  lines.push("## Tabla de hallazgos");
  lines.push("");
  lines.push("| Route | Role | Severity | Categoría | Causa probable | Fix sugerido | Evidencia |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const result of triageResults) {
    lines.push(
      `| ${mdCell(result.route)} | ${mdCell(result.role)} | ${mdCell(result.severity)} | ${mdCell(result.category)} | ${mdCell(result.probable_cause)} | ${mdCell(result.suggested_fix)} | ${mdCell(evidenceReference(result))} |`,
    );
  }
  lines.push("");

  return lines.join("\n");
}
