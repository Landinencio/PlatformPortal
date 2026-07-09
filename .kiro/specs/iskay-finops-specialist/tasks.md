# Implementation Plan — Iskay FinOps especialista (Excel export + precisión/evals)

## Overview

Plan para elevar Iskay como chatbot FinOps especialista (read-only). Dos frentes: (A) export a Excel vía tool `build_report` + tabla `finops_reports` + endpoint de descarga + botón UI; (B) precisión/fiabilidad vía harness de evals + guard de citas + refuerzo de prompt + tests. Todo en TypeScript (Next.js App Router) + scripts de evals bajo `ops/iskay-evals/`. Sin tools de escritura, sin cambios de RBAC.

## Task Dependency Graph

```
A (Excel):
  1 (migración finops_reports) ─► 2 (report-store) ─► 3 (build_report tool) ─► 4 (SSE done.report) ─► 5 (endpoint descarga) ─► 6 (UI botón)
                                                            │
                                                            └─► 7 (tests build_report)
B (precisión/evals):
  8 (tests prettyServiceName + fechas/cuentas)
  9 (citation guard "log & measure") ─► 10 (refuerzo system prompt)
  11 (eval harness: tipos + runner) ─► 12 (assertions deterministas) ─► 13 (casos golden) ─► 14 (LLM-judge opcional)
C:
  15 (steering)  ← depende de A y B
```

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "8", "9", "11"], "dependsOn": [] },
    { "wave": 2, "tasks": ["2", "10", "12"], "dependsOn": ["1", "9", "11"] },
    { "wave": 3, "tasks": ["3", "13"], "dependsOn": ["2", "12"] },
    { "wave": 4, "tasks": ["4", "5", "7", "14"], "dependsOn": ["3", "13"] },
    { "wave": 5, "tasks": ["6"], "dependsOn": ["4", "5"] },
    { "wave": 6, "tasks": ["15"], "dependsOn": ["6", "7", "14"] }
  ]
}
```

## Tasks

- [x] 1. Migración de la tabla `finops_reports`
  - Crear `migrations/2026-06-12_finops_reports.sql` con la tabla `finops_reports` (`id UUID PRIMARY KEY`, `filename TEXT`, `content BYTEA`, `user_email TEXT`, `created_at TIMESTAMPTZ DEFAULT NOW()`, `expires_at TIMESTAMPTZ`) e índice por `expires_at`. Idempotente (`IF NOT EXISTS`).
  - _Requirements: 5.4, 5.5_

- [x] 2. Módulo `finops-report-store.ts` (persistencia + recuperación + TTL)
  - Crear `src/lib/finops-report-store.ts` con `saveReport({filename, content, userEmail, ttlMinutes})` → genera UUID, inserta en `finops_reports` con `expires_at`, devuelve `reportId`; y `getReport(id)` → devuelve `{filename, content, userEmail}` solo si no ha expirado (trata expirado como inexistente), con borrado lazy.
  - _Requirements: 5.1, 5.2, 5.3_

- [x] 3. Tool `build_report` en `finops-tools.ts`
  - Añadir la entrada `build_report` a `FINOPS_TOOLS` (JSON Schema: `title`, `startDate`, `endDate` requeridos, `accountIds` opcional, `sections` enum del conjunto definido) y el case en `executeFinopsTool`.
  - Implementar `buildReportTool(args, userEmail)`: validar Report_Spec (campos requeridos, secciones válidas, `startDate<=endDate`); por cada sección, **re-obtener datos** llamando a los executors existentes (`getCostByAccountTool`, `getCostByServiceTool`, `getCostByDomainTool`, `getTopResourcesTool`, `getNetCostBreakdownTool`, `getHiddenCostsTool`, `getMarketplaceChargesTool`, summary); construir workbook `XLSX` (hoja "Resumen" con metadatos + una hoja por sección), aplicar `prettyServiceName` a nombres de servicio; serializar a buffer; persistir vía `saveReport`; devolver `{reportId, filename, sheetCount, rowCounts, downloadUrl}`. Sección que falla → hoja con nota de error y continuar; todas fallan → error.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2_

- [x] 4. Propagar el informe en el evento SSE `done`
  - En `src/app/api/ai/finops-chat/route.ts`: cuando el trace contenga un `tool_result` de `build_report` con `downloadUrl`/`filename`, incluir `report: { downloadUrl, filename }` en el evento `done`. Pasar el `userEmail` de la sesión a la ejecución de la tool para la propiedad del informe.
  - _Requirements: 7.1_

- [x] 5. Endpoint de descarga `GET /api/finops/report/[id]`
  - Crear `src/app/api/finops/report/[id]/route.ts`: `requireUserAuth` con gate admin/directores; `getReport(id)`; validar ownership (`emailsMatch`/lowercase) entre la sesión y `user_email`; si no existe/expiró → 404; si el email no coincide → 404/403; en éxito devolver el `content` con `Content-Disposition: attachment; filename="..."` y `Content-Type` xlsx.
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 6. Botón de descarga en la UI del chat
  - En `src/components/finops/finops-chat.tsx`: extender el tipo `Message` con `report?: {downloadUrl, filename}`; en el handler del evento `done`, si trae `report`, adjuntarlo al mensaje del asistente; renderizar un botón "⬇️ Descargar Excel" que abra el `downloadUrl`.
  - _Requirements: 7.2, 7.3_

- [x] 7. Tests unitarios de `build_report`
  - Crear `src/lib/__tests__/finops-report.test.ts` (node:test + tsx, deps/executors mockeados): genera una hoja por sección pedida + hoja Resumen; aplica `prettyServiceName` (sin IDs opacos en celdas); sección fallida → hoja con nota de error y resto OK; todas fallan → error; valida Report_Spec inválido (campos/secciones/fechas).
  - _Requirements: 1.3, 1.4, 1.5, 3.1, 3.2, 3.3, 4.1, 4.2_

- [x] 8. Tests unitarios de helpers de grounding
  - Crear/extender tests `node:test` para `prettyServiceName` (códigos `cg…`→"Marketplace (contrato)", inference-profile→"Bedrock (GenAI)", nombres normales intactos) y para la resolución de fechas/cuentas (rango por defecto mes en curso, resolución de `accountIds`).
  - _Requirements: 14.1, 14.2_

- [x] 9. Citation_Guard en modo "loguea y mide"
  - Implementar en `src/lib/finops-tools.ts` (o helper nuevo) una función pura `extractCitedAmounts(text)` y `verifyCitations(text, toolResults)` que detecte importes monetarios del texto final y compruebe si aparecen en los toolResults. En el route, tras el loop, ejecutar el guard y **registrar discrepancias como telemetría sin bloquear** la respuesta.
  - _Requirements: 12.1, 12.2_

- [x] 10. Refuerzo del system prompt
  - En el `SYSTEM_PROMPT` de `route.ts`: reforzar instrucciones de resolución de fechas relativas ("mayo", "último trimestre"), manejo de out-of-scope (redirigir al dashboard, no inventar) y prohibición explícita de exponer Opaque_Id. Alinear con los hallazgos de los casos golden.
  - _Requirements: 13.1_

- [x] 11. Harness de evals: tipos + runner base
  - Crear `ops/iskay-evals/` con `cases.ts` (tipo `EvalCase`: `id`, `question`, `expectTools`, `forbidTools?`, `assertions`) y `run.ts` (Node + tsx) que, por cada caso, ejecute el loop del agente reutilizando `executeFinopsTool` + el mismo system prompt, capture el `trace`, y al final emita pass/fail por caso + score agregado. Un caso que peta → fail y continúa. No toca datos de producción.
  - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

- [x] 12. Assertions deterministas del runner
  - En `run.ts`: implementar `expectTools`/`forbidTools` (sobre el trace de tool_calls), `citesToolFigures` (importes del texto ⊆ toolResults, reusa `verifyCitations`), `noOpaqueIds` (regex de `cg…`/inference-profile en la respuesta), `period` (rango resuelto = esperado), `outOfScopeRedirect` (no llama tools de coste y redirige).
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [x] 13. Casos golden iniciales
  - En `cases.ts`: añadir los 5 casos: (a) "¿Cuánto cuesta AWS?" → `expectTools:[get_net_cost_breakdown]`, `forbidTools:[get_total_cost]`; (b) "¿Qué departamento gasta más en IA?" → `expectTools:[get_cost_by_domain]`, `forbidTools:[get_cost_by_service]`; (c) pico día 1 → atribución a marketplace; (d) out-of-scope "dame los logs de oms" → `outOfScopeRedirect`; (e) cita exacta → `citesToolFigures`.
  - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5_

- [x] 14. LLM-as-judge opcional
  - En `run.ts`: flag `--judge` que, si está activo, hace una llamada Bedrock por caso puntuando la respuesta contra una rúbrica (claridad/correctud); si está desactivado, solo corren las assertions deterministas.
  - _Requirements: 11.1, 11.2_

- [x] 15. Actualizar steering canónico
  - En `.kiro/steering/portal-architecture.md` (§4 Iskay): documentar la tool `build_report` (14→15 tools), la tabla `finops_reports`, el endpoint de descarga, el harness `ops/iskay-evals/` y el Citation_Guard. Reflejar que sigue read-only/admin-directores.
  - _Requirements: 15.1, 15.2_

## Notes

- **Cero alucinación en el Excel**: `build_report` re-consulta datos, nunca usa cifras del modelo (R2).
- **Cross-réplica**: el informe vive en BD (`finops_reports`), no en memoria, para que la descarga funcione desde cualquier pod (R5).
- **Evals = la palanca de fiabilidad**: los deterministas pueden correr sin Bedrock (mockeando tool outputs); el LLM-judge es opcional para no encarecer cada corrida.
- **Guard de citas**: arranca en "loguea y mide" (no bloquea); se endurece después con los datos recogidos.
- **Scope**: read-only, admin/directores; sin RBAC nuevo (eso es la spec 3, aparte).
