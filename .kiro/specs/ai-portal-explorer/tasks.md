# Implementation Plan: AI Portal Explorer

## Overview

Plan incremental orientado a TDD/PBT para construir el **AI Portal Explorer**: un job de solo lectura
(on-demand + CronJob) que recorre el Platform Portal (`portal-dev`) bajo cada rol RBAC con sesiones
sintéticas, captura evidencia técnica y funcional, detecta anomalías de forma determinista, las pasa
por Bedrock para triage, persiste un informe + histórico (PostgreSQL + S3), notifica a Teams y detecta
regresiones.

La estrategia separa **lógica pura** (módulos en `src/lib/explorer/`, cubiertos por property-based tests
con `fast-check`) de la **captura con navegador / integración Bedrock / IaC** (cubiertas con tests de
ejemplo/integración/snapshot). Cada módulo puro tiene su tarea de implementación seguida de una tarea
de test de propiedad por cada una de las **27 Correctness Properties** del diseño. Cada prueba de
propiedad usa `fast-check` con **mínimo 100 iteraciones** (`{ numRuns: 100 }`) y lleva el comentario
`// Feature: ai-portal-explorer, Property {N}: ...`.

Convención de tests de propiedad: **un fichero por propiedad** en
`src/lib/explorer/__tests__/`, para permitir ejecución en paralelo sin conflictos de fichero.

Lenguaje: TypeScript (igual que el diseño y el resto del portal). Tests con `node:test` vía `tsx` + `c8`.

## Tasks

- [x] 1. Preparar estructura del módulo y tipos compartidos
  - [x] 1.1 Crear tipos compartidos y scaffolding de `src/lib/explorer/`
    - Crear `src/lib/explorer/types.ts` con todos los tipos del diseño: `TargetEnvironment`, `Route`, `ParamSpec`, `FilterSpec`, `Scenario`, `VisitResult`, `ConsoleError`, `FailedRequest`, `DomErrorState`, `DataSignal`, `TimeSeriesSignal`, `PaginationSignal`, `AnomalyCategory`, `Anomaly`, `AnomalyEvidence`, `Severity`, `SEVERITY_ORDER`, `TriageStatus`, `TriageResult`, `RunStatus`, `ExplorationRun`
    - Reutilizar `AppRole` y `PortalSection` importados de `@/lib/rbac`
    - Crear el directorio `src/lib/explorer/__tests__/` y un arbitrary compartido base (`arbAppRole`) en `src/lib/explorer/__tests__/arbitraries.ts`
    - _Requirements: 2.2, 6.2_

- [x] 2. Implementar Safety_Guard (solo lectura innegociable)
  - [x] 2.1 Implementar `src/lib/explorer/safety-guard.ts`
    - `SAFE_METHODS`, `MUTATION_KEYWORDS`, `InteractionCandidate`, `GuardDecision`
    - `evaluateInteraction` (default-deny: solo `navigate`/`read`/`open-panel`/`paginate` y `http` con método seguro; bloquea `submit-form` y `click-button` cuyo `controlLabel`/atributos casen con `MUTATION_KEYWORDS`)
    - `isDevTargetEnvironment(baseUrl)` y `isSafeMethod(method)` (normalización case-insensitive)
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [x] 2.2 Test de propiedad: entorno objetivo fijado a desarrollo
    - **Property 1: El entorno objetivo está fijado a desarrollo**
    - Fichero `__tests__/safety-guard.prop01.property.test.ts`, `fast-check`, `{ numRuns: 100 }`
    - **Validates: Requirements 1.2**

  - [x] 2.3 Test de propiedad: Allowlist default-deny del Safety_Guard
    - **Property 2: El Safety_Guard solo permite interacciones de solo lectura (default-deny)**
    - Usar `arbInteractionCandidate` (incluye etiquetas con/sin `MUTATION_KEYWORDS`)
    - **Validates: Requirements 1.3, 1.4, 1.7, 1.8**

  - [x] 2.4 Test de propiedad: solo métodos HTTP seguros
    - **Property 3: El Crawler solo emite métodos HTTP seguros**
    - Usar `arbHttpMethod` (válidos/ inválidos, mayúsculas/minúsculas)
    - **Validates: Requirements 1.5, 1.6, 1.8**

- [x] 3. Implementar Auth_Minter (sesión sintética multi-rol)
  - [x] 3.1 Implementar `src/lib/explorer/auth-minter.ts`
    - `SyntheticSession`, `mintSyntheticSession(role)` (replica `encode` de next-auth/jwt con `NEXTAUTH_SECRET` y los claims del callback `jwt()` de `src/lib/auth.ts`: `appRole`, `roles`, `oid`)
    - `canMintSessions()` (true si `NEXTAUTH_SECRET` presente) y `buildSyntheticClaims(role)` (email reservado `explorer+<role>@synthetic.invalid`, `synthetic: true`)
    - _Requirements: 2.1, 2.2, 2.4, 2.5_

  - [x] 3.2 Test de propiedad: round-trip de sesión sintética al rol pedido
    - **Property 4: Las sesiones sintéticas round-trip al rol pedido y se marcan sintéticas**
    - Acuñar + decodificar JWE con `NEXTAUTH_SECRET`; `appRole` resuelve al Role y claim sintético
    - **Validates: Requirements 2.1, 2.2, 2.4**

  - [x] 3.3 Test de propiedad: las sesiones sintéticas nunca se persisten
    - **Property 5: Las sesiones sintéticas nunca se persisten en el Report**
    - Verifica que ni la forma estructurada ni el Markdown del Report contienen el valor de la cookie
    - **Validates: Requirements 2.6**

- [x] 4. Implementar RBAC_Validator (validación por rol)
  - [x] 4.1 Implementar `src/lib/explorer/rbac-validator.ts`
    - `RbacExpectation`, `deriveRbacExpectations(roles)` y `expectedAccess(role, section)` derivados de `SECTION_ACCESS`/`canAccessSection` de `src/lib/rbac.ts`
    - `RbacFinding`, `evaluateRbac(route, role, observed)` (finding sii observado ≠ esperado; `unauthorized-access` con `minSeverity: "high"`)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x] 4.2 Test de propiedad: la RBAC_Expectation refleja SECTION_ACCESS
    - **Property 6: La RBAC_Expectation refleja SECTION_ACCESS**
    - Comparar `expectedAccess` contra `canAccessSection` para toda combinación rol×sección
    - **Validates: Requirements 3.1**

  - [x] 4.3 Test de propiedad: RBAC_Finding sii observado difiere de esperado
    - **Property 7: Un RBAC_Finding existe si y solo si el acceso observado difiere del esperado**
    - **Validates: Requirements 3.2, 3.3, 3.4, 3.5, 3.6**

- [x] 5. Implementar Route_Discovery (inventario de rutas)
  - [x] 5.1 Implementar `src/lib/explorer/route-discovery.ts`
    - `discoverNavRoutes()` (espejo de `NAV_ITEMS` de `portal-shell.tsx`), `discoverApiRoutes()` (catálogo curado `/api/*` GET)
    - `addRouteIfAbsent(inventory, candidate)` (dedupe por `id`), `isInternalUrl(url, baseUrl)`, `buildRouteInventory(baseUrl)`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.6_

  - [x] 5.2 Test de propiedad: inventario sin duplicados e idempotente
    - **Property 8: El inventario de rutas no contiene duplicados y su construcción es idempotente**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4**

  - [x] 5.3 Test de propiedad: solo URLs internas al Target_Environment
    - **Property 9: Solo se incluyen URLs internas al Target_Environment**
    - **Validates: Requirements 4.6**

- [x] 6. Implementar Scenario_Generator (matriz de escenarios seguros)
  - [x] 6.1 Implementar `src/lib/explorer/scenario-generator.ts`
    - `ScenarioMatrix`, `DateRangeSpec`, `DEFAULT_SCENARIO_MATRIX` (incluye DELIBERADAMENTE el rango etiquetado `"crosses-90d-boundary"`, p.ej. `2026-01-01`–`2026-03-28`, `expectsData: true` — el rango del bug de Gestión)
    - `generateScenarios(route, matrix, runDate)` (producto cartesiano acotado, determinista, solo `safeValues`) y `buildScenarioId(route, params)` (estable, independiente de runId/timestamp)
    - _Requirements: 4.5_

  - [x] 6.2 Test de propiedad: generación de scenarios determinista y segura
    - **Property 10: La generación de Scenarios es determinista y usa solo valores seguros**
    - **Validates: Requirements 4.5**

- [x] 7. Checkpoint - Asegurar que pasan los tests de los módulos base
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Implementar Anomaly_Detectors (heurísticas deterministas — corazón del QA funcional)
  - [x] 8.1 Implementar detectores técnicos y de rendimiento en `src/lib/explorer/anomaly-detectors.ts`
    - `detectTechnicalAnomalies(visit)` (console errors, failed requests, DOM errors), `detectLatencyAnomaly(visit, thresholdMs)`, `detectTimeoutAnomaly(visit)`
    - `buildAnomalyId(...)` y `anomalyEquivalenceKey(...)` (clave Route+Role+categoría), `DetectorConfig`
    - _Requirements: 5.6, 5.7, 10.6, 8.4_

  - [x] 8.2 Implementar detectores funcionales y orquestador `detectAnomalies` en `anomaly-detectors.ts`
    - `detectEmptyStateAnomaly(visit, scenario)`, `detectTruncatedSeriesAnomaly(visit)`, `detectStuckPaginationAnomaly(prev, next)`, `detectIncoherentTotals(a, b)`, `detectSuspiciousNulls(visit)`
    - `detectAnomalies(visit, scenario, config)` que aplica todos los detectores
    - _Requirements: 5.7_

  - [x] 8.3 Test de propiedad: anomalía de latencia/timeout
    - **Property 11: Anomalía de latencia/timeout si y solo si se supera el umbral o expira**
    - Usar `arbVisitResult` (latencias y `timedOut` variados)
    - **Validates: Requirements 5.6, 10.6**

  - [x] 8.4 Test de propiedad: anomalía técnica sii hay evidencia técnica
    - **Property 12: Anomalía técnica si y solo si hay evidencia técnica**
    - **Validates: Requirements 5.7**

  - [x] 8.5 Test de propiedad: empty-state con expectativa de datos
    - **Property 13: Empty-state con expectativa de datos es una anomalía funcional**
    - Usar `arbDataSignal` (incluye empty-states y `rowCount` cero)
    - **Validates: Requirements 5.7** (intent: bug de Gestión — empty-state con HTTP 200)

  - [x] 8.6 Test de propiedad: serie temporal truncada
    - **Property 14: Serie temporal truncada antes del fin del rango es una anomalía**
    - Usar `arbTimeSeriesSignal` (series que terminan antes del fin del rango)
    - **Validates: Requirements 5.7**

  - [x] 8.7 Test de propiedad: paginación estancada
    - **Property 15: Paginación estancada es una anomalía**
    - **Validates: Requirements 5.7**

  - [x] 8.8 Test de propiedad: totales incoherentes entre rangos solapados
    - **Property 16: Totales incoherentes entre rangos solapados son una anomalía**
    - **Validates: Requirements 5.7**

  - [x] 8.9 Test de ejemplo dirigido: detección del bug de Gestión
    - Fichero `__tests__/gestion-empty-state.example.test.ts` (no PBT; ejemplo dirigido)
    - Construir un `VisitResult` con `httpStatus: 200`, scenario `crosses-90d-boundary` (`2026-01-01`–`2026-03-28`, `expectsData: true`) y `dataSignal.isEmptyState = true`
    - Afirmar que `detectAnomalies` produce exactamente una `Anomaly` de categoría `empty-state` (la regresión que el sistema debe cazar)
    - _Requirements: 5.7_

- [x] 9. Implementar Triage_Engine (Bedrock + presupuesto)
  - [x] 9.1 Implementar `src/lib/explorer/triage-engine.ts`
    - `TriageDeps` (inyección de `invokeBedrock` y `parseTriage`), `triageAnomaly(anomaly, deps)`, `triageAll(anomalies, budget, deps)` (respeta `Bedrock_Budget`; sobrantes `triage-skipped-budget`; fallos `triage-unavailable`; nunca lanza)
    - `serializeTriageResult(t)` / `deserializeTriageResult(json)` (inversas) y `fallbackTriage(anomaly, status)` (severidad determinista desde categoría)
    - Usar el patrón `ConverseCommand` de `src/lib/bedrock.ts`, modelo `eu.anthropic.claude-sonnet-4-20250514-v1:0`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 9.4_

  - [x] 9.2 Test de propiedad: Triage_Result bien formado y severidad válida
    - **Property 17: El Triage_Result está bien formado y con severidad válida**
    - Bedrock simulado vía `TriageDeps`
    - **Validates: Requirements 6.1, 6.2, 6.3**

  - [x] 9.3 Test de propiedad: triage respeta presupuesto y solo procesa anomalías
    - **Property 18: El triage respeta el presupuesto y solo procesa anomalías**
    - **Validates: Requirements 6.4, 6.6, 9.4**

  - [x] 9.4 Test de propiedad: degradación elegante ante fallos de Bedrock
    - **Property 19: El triage degrada con elegancia ante fallos de Bedrock**
    - Subconjunto arbitrario de invocaciones falla; cardinalidad de salida = entrada
    - **Validates: Requirements 6.5**

  - [x] 9.5 Test de propiedad: round-trip JSON del Triage_Result
    - **Property 20: Round-trip JSON del Triage_Result**
    - Usar `arbTriageResult`
    - **Validates: Requirements 6.7**

- [x] 10. Implementar Regression_Detector
  - [x] 10.1 Implementar `src/lib/explorer/regression-detector.ts`
    - `RegressionReport`, `detectRegressions(current, previous)` (Regression sii la clave de equivalencia Route+Role+categoría no aparece en el baseline; `hasBaseline: false` si no hay run previo)
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [x] 10.2 Test de propiedad: detección de regresiones determinista
    - **Property 23: La detección de regresiones es determinista por Route+Role+categoría**
    - Usar `arbAnomalySet` + baseline
    - **Validates: Requirements 8.1, 8.2, 8.3, 8.4**

- [x] 11. Checkpoint - Asegurar que pasan los tests de detectores, triage y regresiones
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Implementar persistencia (migración SQL + Report_Store)
  - [x] 12.1 Crear la migración SQL `migrations/2026-06-20_ai_portal_explorer.sql`
    - Tablas `exploration_runs`, `visit_results` (UNIQUE `(run_id, scenario_id, role)`), `anomalies`, `triage_results` (con `is_regression`, `equivalence_key`) y `explorer_run_lock` (singleton `id = 1`) con sus índices
    - _Requirements: 7.1, 7.7, 9.5, 10.2_

  - [x] 12.2 Implementar la capa de persistencia PostgreSQL del Report_Store en `src/lib/explorer/report-store.ts`
    - Reutilizar `pool` de `src/lib/db.ts`. Funciones: `createRun`, `updateRunTerminal`, `persistVisitResult` (no lanza, registra fallo por-fila y continúa), `persistAnomaly`, `persistTriageResults`, `loadPreviousRunTriage` (baseline para regresiones), `loadRun`
    - _Requirements: 7.1, 7.7, 10.2, 10.5_

  - [x] 12.3 Implementar el almacenamiento en S3 de screenshots y Markdown en `src/lib/explorer/report-s3.ts`
    - Cliente S3 top-level (compat. Next standalone, IRSA `portal-inventory-irsa`): `putScreenshot(runId, scenarioId, role, buffer)` → `s3://...`, `putReportMarkdown(runId, markdown)` → `report_markdown_ref`
    - _Requirements: 5.5, 7.2_

  - [x] 12.4 Tests unitarios de la capa de persistencia
    - Dependencias (`pool`, cliente S3) inyectadas/mockeadas: claim por-fila idempotente, fallo de `visit_result` individual no descarta los ya persistidos (10.5), histórico conservado (7.7)
    - _Requirements: 7.7, 10.5_

- [x] 13. Implementar Reporter y Teams_Notifier
  - [x] 13.1 Implementar `src/lib/explorer/reporter.ts`
    - `Report`, `ReportSummary`, `buildSummary(visits, triage)` (agregación determinista), `renderMarkdown(report)` (incluye por cada Triage_Result: Route, Role, Severity, categoría, causa probable, fix sugerido y referencia a evidencia; más resumen con totales, anomalías por severidad y nº de RBAC_Findings)
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 13.2 Implementar el Teams_Notifier en `src/lib/explorer/teams-notifier.ts`
    - `buildExplorerTeamsCard(report, reportUrl)` reutilizando `buildDigestCard`/`sendTeamsCard` de `src/lib/teams-notify.ts`; resumen por severidad + enlace al Report; nunca lanza ante fallo de publicación (conserva el Report persistido)
    - _Requirements: 7.5, 7.6_

  - [x] 13.3 Test de propiedad: el Markdown contiene la evidencia de cada triage
    - **Property 21: El Markdown del Report contiene la evidencia de cada triage**
    - **Validates: Requirements 7.1, 7.2, 7.3**

  - [x] 13.4 Test de propiedad: el resumen del Report es una agregación coherente
    - **Property 22: El resumen del Report es una agregación coherente**
    - **Validates: Requirements 7.4**

- [x] 14. Implementar Run_Orchestrator (idempotencia, lock, degradación elegante)
  - [x] 14.1 Implementar `src/lib/explorer/orchestrator.ts`
    - `RunConfig`, `OrchestratorDeps`, `runExploration(config, deps)` que cablea: validación de entorno (aborta si no es `portal-dev`) → `claimRunLock` → mint sesiones por rol → discovery → scenarios → visitas (captura por-visita de excepciones, continúa) → detectores → RBAC → triage acotado → regresiones → reporter + persistencia + Teams
    - `claimRunLock(deps)` (UPDATE atómico sobre `explorer_run_lock`, `acquired=false` si ya hay run); estado terminal `completed`/`completed-with-errors`/`aborted`; trazas de progreso (Routes visitadas / Anomalies)
    - _Requirements: 1.2, 2.5, 9.4, 9.5, 10.1, 10.2, 10.3, 10.4, 10.6_

  - [x] 14.2 Test de propiedad: ejecución única (no concurrente)
    - **Property 24: La ejecución es única (no concurrente)**
    - Mock del store; secuencia de claims sin liberación
    - **Validates: Requirements 9.5**

  - [x] 14.3 Test de propiedad: un fallo de Visit no aborta el run
    - **Property 25: Un fallo de Visit no aborta el run y queda registrado**
    - Subconjunto arbitrario de visitas lanza excepción
    - **Validates: Requirements 10.1**

  - [x] 14.4 Test de propiedad: el estado terminal refleja si hubo errores
    - **Property 26: El estado terminal refleja si hubo errores**
    - **Validates: Requirements 10.2**

  - [x] 14.5 Test de propiedad: barrido idempotente sobre estado idéntico
    - **Property 27: El barrido es idempotente sobre un estado idéntico del Portal**
    - Portal y store mockeados; comparar por scenario + clave de equivalencia
    - **Validates: Requirements 10.4**

- [x] 15. Implementar el Crawler (Playwright) y el runner del job
  - [x] 15.1 Implementar el Crawler con Playwright en `src/lib/explorer/crawler.ts`
    - `visit(route, role, scenario, session)` headless: solo GET/HEAD (interceptación `route()` que bloquea métodos no seguros), `evaluateInteraction` en cada interacción, captura de `consoleErrors`, `failedRequests`, `domErrorStates`, `latencyMs`, `httpStatus`, `Screenshot` y extracción best-effort de `DataSignal`; lectura de formularios sin envío; timeout por-visita configurable → Anomaly `timeout`
    - _Requirements: 1.5, 1.6, 1.7, 5.1, 5.2, 5.3, 5.4, 5.5, 10.6_

  - [x] 15.2 Crear el runner del job en `ops/portal-explorer/run.ts`
    - Punto de entrada del job (patrón de `ops/lighthouse-scan.js`/`mr-metrics-snapshot.js`): construye `RunConfig` desde env (`portal-env`), invoca `runExploration`, emite trazas de progreso (Routes visitadas / Anomalies detectadas)
    - _Requirements: 9.3, 10.3_

  - [x] 15.3 Crear el `ops/Dockerfile.portal-explorer`
    - Patrón de `ops/Dockerfile.lighthouse` (`node:20-slim` + Chromium/Playwright), context `ops/`, entrypoint al runner
    - _Requirements: 9.3_

  - [x] 15.4 Tests de integración del Crawler con navegador real (OPCIONAL, no bloqueante)
    - 1–3 visitas contra un portal de prueba/mock; verifican que `VisitResult` puebla status, latency, console errors, failed requests, DOM states y screenshot. Comportamiento determinista, fuera de CI por entorno
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 16. Implementar el endpoint on-demand
  - [x] 16.1 Implementar `POST /api/explorer/run` en `src/app/api/explorer/run/route.ts`
    - Validar con `requireInternalAuth` (`x-internal-secret`); arrancar el `Exploration_Run` en background (patrón de los snapshots); 401 sin secreto válido; respetar el lock de ejecución única (rechazo de inicio duplicado)
    - _Requirements: 9.1, 9.2, 9.5_

  - [x] 16.2 Tests del endpoint on-demand
    - 401 sin `x-internal-secret`; arranque con secreto válido; rechazo cuando ya hay un run en curso. Dependencias inyectadas/mockeadas
    - _Requirements: 9.1, 9.2, 9.5_

- [x] 17. Declarar el CronJob en generic-chart (GitOps)
  - [x] 17.1 Añadir el manifiesto del CronJob `ai-portal-explorer` a los values de `generic-chart`
    - En `argocd/tooling shared-apps/portal-{dev,prod}` (`cronjobs.jobs`): imagen `ops/portal-explorer`, `envFrom` el secret `portal-env`, `concurrencyPolicy: Forbid`, `activeDeadlineSeconds` acotado; crear test de snapshot/validación del manifiesto que afirme esos campos
    - _Requirements: 9.3, 9.5_

- [x] 18. Smoke de Bedrock real (OPCIONAL, no bloqueante)
  - [x] 18.1 Smoke test de `triageAnomaly` contra Bedrock real
    - 1 invocación end-to-end del `ConverseCommand` para validar el contrato; acotada, fuera de CI por coste/entorno
    - _Requirements: 6.1_

- [x] 19. Wiring final e integración
  - [x] 19.1 Cablear el orquestador en el runner del job y en el endpoint, y verificar el flujo completo
    - Conectar `runExploration` (con `OrchestratorDeps` reales: crawler, report-store, report-s3, triage-engine con Bedrock, teams-notifier) desde `ops/portal-explorer/run.ts` y desde `src/app/api/explorer/run/route.ts`; asegurar que no queda código huérfano
    - _Requirements: 7.1, 7.5, 9.1, 9.3, 10.2_

- [x] 20. Checkpoint final - Asegurar que pasa toda la suite
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Las sub-tareas marcadas con `*` son opcionales (tests) y pueden omitirse para un MVP más rápido; el agente NO las implementa salvo petición explícita.
- Los tests de integración del Crawler con navegador real (15.4) y el smoke de Bedrock real (18.1) se marcan opcionales/no bloqueantes por coste y dependencia de entorno, conforme a la Testing Strategy del diseño.
- Cada test de propiedad usa `fast-check` con `{ numRuns: 100 }` (mínimo 100 iteraciones) y el comentario `// Feature: ai-portal-explorer, Property {N}: ...`, con un único test por propiedad y un fichero por propiedad.
- Cobertura de las 27 Correctness Properties: P1–P3 (2.2–2.4), P4–P5 (3.2–3.3), P6–P7 (4.2–4.3), P8–P9 (5.2–5.3), P10 (6.2), P11–P16 (8.3–8.8), P17–P20 (9.2–9.5), P21–P22 (13.3–13.4), P23 (10.2), P24–P27 (14.2–14.5).
- Cada tarea referencia los requisitos (granular) y/o propiedades que cubre para trazabilidad.
- El bug de Gestión queda cubierto por el detector funcional (8.2 + propiedad 8.5/Property 13) y por el test de ejemplo dirigido (8.9).

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["2.1", "3.1", "4.1", "5.1", "6.1", "8.1", "9.1", "10.1", "12.1", "13.1", "13.2"] },
    { "id": 2, "tasks": ["2.2", "2.3", "2.4", "3.2", "3.3", "4.2", "4.3", "5.2", "5.3", "6.2", "8.2", "9.2", "9.3", "9.4", "9.5", "10.2", "12.2", "12.3", "13.3", "13.4", "15.1"] },
    { "id": 3, "tasks": ["8.3", "8.4", "8.5", "8.6", "8.7", "8.8", "8.9", "12.4", "14.1", "15.2", "17.1"] },
    { "id": 4, "tasks": ["14.2", "14.3", "14.4", "14.5", "15.3", "15.4", "16.1", "18.1"] },
    { "id": 5, "tasks": ["16.2", "19.1"] }
  ]
}
```
