#!/usr/bin/env -S npx tsx
/**
 * AI Portal Explorer — Job runner (entrypoint).
 *
 * Feature: ai-portal-explorer (task 15.2)
 *
 * Punto de entrada del job de exploración (on-demand + CronJob). Sigue el patrón
 * de los runners existentes en `ops/` (`lighthouse-scan.js`, `mr-metrics-snapshot.js`):
 * construye su configuración desde variables de entorno, ejecuta el trabajo,
 * emite trazas de progreso por stdout y sale con código 0 en éxito / no-cero ante
 * un fallo fatal.
 *
 * A diferencia de los runners JS legacy (que re-implementan toda su lógica de
 * forma autocontenida con `require`), este runner es TypeScript y **reutiliza** el
 * Run_Orchestrator (`src/lib/explorer/orchestrator.ts`) y los módulos del Explorer
 * vía el alias de paths `@/*`. Por eso se ejecuta con **tsx** (ya presente como
 * devDependency y usado por la suite de tests), apuntando `TSX_TSCONFIG_PATH` al
 * `tsconfig.test.json` que declara `paths: { "@/*": ["./src/*"] }`. La imagen del
 * job (`ops/Dockerfile.portal-explorer`, tarea 15.3) instala `tsx` + Playwright y
 * usa este fichero como entrypoint (`tsx ops/portal-explorer/run.ts`).
 *
 * El Crawler (`src/lib/explorer/crawler.ts`) importa Playwright mediante un
 * `import()` dinámico guardado, de modo que importar el orquestador desde aquí NO
 * exige que Playwright esté instalado para compilar; solo se resuelve en runtime,
 * dentro de la imagen del job que sí lo trae.
 *
 * Variables de entorno (todas con defaults razonables salvo las que el orquestador
 * exige internamente, p.ej. `NEXTAUTH_SECRET` para acuñar sesiones y `DATABASE_URL`
 * para persistir — provistas por el Secret `portal-env` vía `envFrom`):
 *
 *   EXPLORER_BASE_URL                 Base URL del Target_Environment.
 *                                     Default: https://portal.today.dev.tooling.dp.iskaypet.com
 *   EXPLORER_ROLES                    CSV de AppRoles a barrer.
 *                                     Default: admin,directores,managers,staff,desarrolladores,externos
 *   EXPLORER_LATENCY_THRESHOLD_MS     Umbral de latencia para anomalía de rendimiento. Default: 3000
 *   EXPLORER_SERIES_END_TOLERANCE_DAYS Tolerancia (días) para serie truncada. Default: 2
 *   EXPLORER_BEDROCK_BUDGET           Máximo de invocaciones a Bedrock (triage). Default: 50
 *   EXPLORER_VISIT_TIMEOUT_MS         Timeout por-visita (ms). Default: 30000
 *   EXPLORER_TRIGGER_SOURCE           Origen del disparo: "cron" | "on-demand". Default: cron
 *
 * _Requirements: 9.3, 10.3_
 */

import type { AppRole } from "@/lib/rbac";
import type { TriggerSource } from "@/lib/explorer/report-store";
import { DEFAULT_SCENARIO_MATRIX } from "@/lib/explorer/scenario-generator";
import { runExploration } from "@/lib/explorer/orchestrator";
import type { ProgressTrace, RunConfig } from "@/lib/explorer/orchestrator";

/** AppRoles soportados por el portal (ver `src/lib/rbac.ts`). */
const ALL_ROLES: AppRole[] = ["admin", "directores", "managers", "staff", "desarrolladores", "externos"];

const DEFAULT_BASE_URL = "https://portal.today.dev.tooling.dp.iskaypet.com";
const DEFAULT_LATENCY_THRESHOLD_MS = 3_000;
const DEFAULT_SERIES_END_TOLERANCE_DAYS = 2;
const DEFAULT_BEDROCK_BUDGET = 50;
const DEFAULT_VISIT_TIMEOUT_MS = 30_000;

/** Lee un entero positivo de env con fallback ante valores ausentes/invalidos. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/** Resuelve los roles a barrer desde `EXPLORER_ROLES` (CSV), validados. */
function resolveRoles(): AppRole[] {
  const raw = process.env.EXPLORER_ROLES;
  if (!raw || raw.trim() === "") return ALL_ROLES;
  const requested = raw
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  const valid = requested.filter((r): r is AppRole => (ALL_ROLES as string[]).includes(r));
  return valid.length > 0 ? valid : ALL_ROLES;
}

/** Resuelve el origen del disparo desde `EXPLORER_TRIGGER_SOURCE`. */
function resolveTriggerSource(): TriggerSource {
  return process.env.EXPLORER_TRIGGER_SOURCE === "on-demand" ? "on-demand" : "cron";
}

/** Construye el `RunConfig` a partir del entorno. */
function buildRunConfig(): RunConfig {
  return {
    baseUrl: process.env.EXPLORER_BASE_URL?.trim() || DEFAULT_BASE_URL,
    roles: resolveRoles(),
    scenarioMatrix: DEFAULT_SCENARIO_MATRIX,
    detector: {
      latencyThresholdMs: envInt("EXPLORER_LATENCY_THRESHOLD_MS", DEFAULT_LATENCY_THRESHOLD_MS),
      seriesEndToleranceDays: envInt(
        "EXPLORER_SERIES_END_TOLERANCE_DAYS",
        DEFAULT_SERIES_END_TOLERANCE_DAYS,
      ),
    },
    bedrockBudget: envInt("EXPLORER_BEDROCK_BUDGET", DEFAULT_BEDROCK_BUDGET),
    visitTimeoutMs: envInt("EXPLORER_VISIT_TIMEOUT_MS", DEFAULT_VISIT_TIMEOUT_MS),
  };
}

/**
 * Sumidero de trazas de progreso (Req 10.3). Emite una línea legible por fase con
 * el contador de Routes visitadas y Anomalies detectadas, de modo que los logs del
 * Job muestren el avance en tiempo real.
 */
function logProgress(trace: ProgressTrace): void {
  const detail = trace.message ? ` — ${trace.message}` : "";
  console.log(
    `[explorer] ${trace.phase.padEnd(8)} | routes=${trace.routesVisited} anomalies=${trace.anomaliesTotal}${detail}`,
  );
}

async function main(): Promise<void> {
  const config = buildRunConfig();
  const triggerSource = resolveTriggerSource();

  console.log(`AI Portal Explorer — ${new Date().toISOString()}`);
  console.log("=".repeat(60));
  console.log(`Target_Environment : ${config.baseUrl}`);
  console.log(`Roles              : ${config.roles.join(", ")}`);
  console.log(`Trigger            : ${triggerSource}`);
  console.log(`Latency threshold  : ${config.detector.latencyThresholdMs} ms`);
  console.log(`Series tolerance   : ${config.detector.seriesEndToleranceDays} d`);
  console.log(`Bedrock budget     : ${config.bedrockBudget}`);
  console.log(`Visit timeout      : ${config.visitTimeoutMs} ms`);
  console.log("=".repeat(60));

  // Deps por defecto de producción (crawler/Playwright, Bedrock, store PG, S3,
  // Teams). Solo inyectamos el origen del disparo y el sumidero de progreso.
  const report = await runExploration(config, {
    triggerSource,
    onProgress: logProgress,
  });

  const { run, summary, triageResults, regressions } = report;

  console.log("\n" + "=".repeat(60));
  console.log(`Run ${run.runId} — estado: ${run.status}`);
  if (run.abortReason) {
    console.log(`Motivo de aborto: ${run.abortReason}`);
  }
  console.log(`Roles cubiertos    : ${run.rolesCovered.join(", ") || "(ninguno)"}`);
  console.log(`Routes visitadas   : ${summary.routesVisited}`);
  console.log(`Anomalías (triage) : ${triageResults.length}`);
  console.log(`RBAC findings      : ${summary.rbacFindings}`);
  console.log(
    `Por severidad      : ${Object.entries(summary.anomaliesBySeverity)
      .map(([sev, count]) => `${sev}=${count}`)
      .join(" ")}`,
  );
  console.log(
    `Regresiones        : ${regressions.hasBaseline ? regressions.regressions.length : "(sin baseline)"}`,
  );
  console.log("=".repeat(60));

  // Un run abortado (entorno no-dev o inicio duplicado) no realizó el barrido:
  // se marca como fallo para que el Job lo refleje. Los estados completados
  // (con o sin errores por-visita) se consideran éxito del job.
  if (run.status === "aborted") {
    console.error(`Run abortado: ${run.abortReason ?? "motivo desconocido"}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => {
    // Da margen a que los handles abiertos (pool PG) se cierren sin colgar el job.
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
