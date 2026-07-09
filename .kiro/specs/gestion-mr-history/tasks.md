# Implementation Plan

## Overview

Metodología BUGFIX (condición de bug). `B` = límite de cobertura del histórico per-MR (fecha de
merge más antigua ya presente en `mr_review_metrics`, ~`2026-04-22`). `F = mrDetails`,
`F' = mrDetails'`. El endpoint `src/app/api/metrics/mr-details/route.ts` **no cambia su lógica**: el
fix añade datos históricos (`merged_at < B`) parametrizando `ops/mr-metrics-snapshot.js` con un
backfill puntual (env `BACKFILL_FROM`/`BACKFILL_TO`), manteniendo intacto el incremental diario
(`LOOKBACK_DAYS = 1`). La preservación se cumple por construcción: el backfill solo acota a
`merged_at < B`, sin tocar ninguna fila que el detalle ya servía.

El plan sigue el orden de la metodología: (1) test exploratorio de la condición del bug que FALLA
sobre el código actual, (2) tests de preservación que PASAN sobre el código actual, (3)
implementación del fix con sus PBT de lógica pura, (4) checkpoint de verificación (Fix Checking +
Preservation Checking pasan).

**Convenciones de test** (del repo): runner `node:test` vía `tsx`, `fast-check ^4`, tests en
`src/lib/__tests__/*.property.test.ts`, `fc.assert(fc.property(...), { numRuns: 100 })`, un
comentario `// Feature: gestion-mr-history, Property N: ...` por propiedad. Para que el harness
(`npm test`, glob `src/lib/__tests__/*.test.ts`) pueda importar la lógica pura del snapshot,
`ops/mr-metrics-snapshot.js` debe **exportar** `resolveWindow`/`planPagination` y proteger su
arranque con `if (require.main === module) main()`.

## Tasks

- [x] 1. Escribir test exploratorio de la condición del bug (Property 1) — ANTES del fix
  - **Property 1: Bug Condition** - Los rangos históricos con MRs reales muestran y paginan el detalle
  - **CRITICAL**: Este test DEBE FALLAR sobre el código actual — el fallo confirma que el bug existe (ausencia de backfill).
  - **DO NOT** intentar arreglar el test ni el código cuando falle; el fallo es el resultado esperado.
  - **NOTE**: Este test codifica el comportamiento esperado; validará el fix cuando pase tras la implementación.
  - **GOAL**: Surfacear el counterexample principal: rango `2026-01-01..2026-03-28` sobre `basket-api` → empty-state/truncado pese a existir MRs mergeados reales.
  - **Scoped PBT Approach**: bug determinista por datos → acotar la propiedad a casos concretos. Crear `src/lib/__tests__/gestion-mr-history.bugcondition.property.test.ts`.
  - Modelar la condición `isBugCondition(X) = X.from < B AND existedMergedMRsInGitLab(X.from, min(X.to,B), filters)` (del design, sección Bug Condition).
  - Test A (planificación de ventana del snapshot, sobre `ops/mr-metrics-snapshot.js` sin fix): para `env={ BACKFILL_FROM: '2026-01-01' }` y cualquier `B` posterior, la ventana que resuelve el snapshot actual SHALL cubrir `[from, min(to,B))`. En el código sin fix **no existe modo backfill** (`LOOKBACK_DAYS=1`, `getMergedMRs` usa `updated_after=hoy-1d`) → la cobertura histórica es vacía → **FALLA**.
  - Test B (cobertura de MRs históricos, simulando la fuente): dado un conjunto de MRs con `merged_at` en `[from, B)`, el plan de fetch del backfill SHALL incluirlos todos. Sin fix no hay backfill → **FALLA**.
  - Las aserciones deben coincidir con las Expected Behavior Properties del design (Property 1): `result.mrs` contiene los MRs de `[X.from, min(X.to,B)]`, `pagination.total = recuento_real`, `totalPages = ceil(total/limit)`, y NO empty-state cuando `recuento_real > 0`.
  - Ejecutar el test sobre el código SIN fix.
  - **EXPECTED OUTCOME**: el test FALLA (correcto — demuestra que el bug existe).
  - Documentar el counterexample observado (p. ej. "con BACKFILL_FROM=2026-01-01 el snapshot solo resuelve ventana incremental de 1 día; cero cobertura para merged_at < B").
  - Marcar la tarea como completa cuando el test esté escrito, ejecutado y el fallo documentado.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

- [x] 2. Escribir tests de preservación (Property 2) — ANTES del fix
  - **Property 2: Preservation** - Los rangos no afectados se comportan exactamente igual
  - **IMPORTANT**: Seguir metodología observation-first.
  - **GOAL**: Fijar el comportamiento de las entradas que NO cumplen `isBugCondition` (rangos íntegramente dentro de `[B, hoy]`, filtros, orden, empty-state legítimo) para garantizar que el fix no los altera.
  - Crear `src/lib/__tests__/gestion-mr-history.preservation.property.test.ts`.
  - Observar sobre el código SIN fix y capturar como propiedades:
    - Observación: en modo incremental (sin `BACKFILL_FROM`) el snapshot resuelve ventana `[hoy-LOOKBACK_DAYS, null]` con `mode='incremental'` (el cron diario no cambia).
    - Observación: el orden del "Detalle por MR" es `merged_at DESC NULLS LAST` con tamaño de página por defecto (50) y clamps `limit ∈ [10,200]`, `page ≥ 1`.
    - Observación: un rango sin MRs devuelve 200 + empty-state legítimo (no error).
  - Property (pura, recomendada): para cualquier `env` SIN `BACKFILL_FROM`, `resolveWindow(env, B)` ⇒ `mode='incremental'` y `until=null` (no se toca el comportamiento ya cubierto). Como el fix aún no existe, esta property se escribe contra el comportamiento esperado del helper que se añadirá; verificar que el comportamiento incremental ACTUAL del snapshot (la rama por defecto) es equivalente y queda fijado.
  - Property (paginación, observada): `totalPages = ceil(total/limit)` y `offset = (page-1)*limit` para `total ≥ 0`, `limit ∈ [10,200]` — comportamiento ya existente del endpoint, fijado como invariante de no-regresión.
  - Ejecutar los tests sobre el código SIN fix.
  - **EXPECTED OUTCOME**: los tests PASAN (confirman la línea base a preservar). `fast-check`, `{ numRuns: 100 }`, comentario por propiedad.
  - Marcar completa cuando los tests estén escritos, ejecutados y en verde sobre el código sin fix.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Fix — backfill histórico parametrizado de `mr_review_metrics`

  - [x] 3.1 Extraer y exportar la lógica pura de selección de ventana y paginación
    - En `ops/mr-metrics-snapshot.js` implementar `resolveWindow(env, coverageStart)`:
      - Si `env.BACKFILL_FROM` presente ⇒ `{ since: BACKFILL_FROM, until: env.BACKFILL_TO ?? coverageStart, mode: 'backfill' }`.
      - Si no ⇒ `{ since: now - LOOKBACK_DAYS días, until: null, mode: 'incremental' }` (idéntico a hoy).
    - Implementar `planPagination(total, limit)` / helper de recorrido de páginas (pura) para el modo backfill.
    - Exportar ambas (`module.exports = { resolveWindow, planPagination, ... }`) y proteger el arranque con `if (require.main === module) main()` para que el harness pueda importarlas.
    - _Bug_Condition: isBugCondition(X) = X.from < B AND existedMergedMRsInGitLab(X.from, min(X.to,B), filters)_
    - _Expected_Behavior: expectedBehavior(result) — result.mrs contiene los MRs de [from, min(to,B)], total real, totalPages=ceil(total/limit), no empty-state si total>0_
    - _Preservation: rangos en [B, hoy], filtros, orden merged_at DESC, tamaño de página y empty-state legítimo inalterados (el backfill solo añade filas con merged_at < B)_
    - _Requirements: 2.5, 3.1, 3.4_

  - [x] 3.2 Calcular el límite de cobertura `B` y activar el modo backfill en `main`
    - Calcular `coverageStart = SELECT MIN(merged_at)::date FROM mr_review_metrics` (si la tabla está vacía, usar un suelo razonable o el propio `BACKFILL_TO`).
    - En `main`, usar `resolveWindow(process.env, coverageStart)`; el incremental diario queda intacto cuando no hay `BACKFILL_FROM`.
    - _Bug_Condition: rango con X.from < B y MRs reales en la porción histórica_
    - _Expected_Behavior: el snapshot rellena las filas per-MR de [BACKFILL_FROM, B)_
    - _Requirements: 2.1, 2.5_

  - [x] 3.3 Paginar TODAS las páginas de MRs merged + filtro client-side por `merged_at` (modo backfill)
    - Modificar `getMergedMRs(projectId, window)`: en modo backfill recorrer todas las páginas de `merge_requests?state=merged&updated_after=<since>&order_by=updated_at&sort=desc&per_page=100&page=N` (reutilizar el patrón de bucle de `getActiveProjects`).
    - Filtrar client-side `merged_at ∈ [since, until)` (GitLab no expone `merged_after`).
    - Mantener el upsert idempotente existente (`ON CONFLICT (project_id, mr_iid) DO UPDATE`); re-ejecutar el backfill no duplica filas.
    - Conservar el `RATE_LIMIT_DELAY` (200 ms) y el manejo de 429 de `gitlabFetch`; añadir backoff exponencial acotado para ráfagas largas. Capturar errores por MR/proyecto y continuar (no abortar el backfill completo).
    - _Bug_Condition: cobertura de [from, min(to,B)) cuando X.from < B_
    - _Expected_Behavior: incluir MRs anteriores y posteriores a B cuando el rango lo cruza_
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.4 Tests PBT de la lógica pura `resolveWindow` (modos incremental y backfill)
    - **Property 3: resolveWindow incremental** - Sin `BACKFILL_FROM`, `resolveWindow(env, B)` ⇒ `mode='incremental'` y `until=null` para cualquier `env` (el cron diario nunca se altera).
    - **Property 4: resolveWindow backfill until≤B** - Con cualquier `BACKFILL_FROM < B`, `resolveWindow(env, B).until ≤ B` (el backfill nunca invade el rango ya cubierto → soporte formal de la preservación).
    - Añadir a `src/lib/__tests__/gestion-mr-history.window.property.test.ts`, importando desde `ops/mr-metrics-snapshot.js`. `fast-check`, `{ numRuns: 100 }`, comentario por propiedad.
    - _Requirements: 2.5, 3.1, 3.4_

  - [x] 3.5 Tests PBT de paginación y orden
    - **Property 5: Paginación cubre exactamente `total`** - Para cualquier `total ≥ 0` y `limit ∈ [10,200]`, recorrer todas las páginas del plan cubre exactamente `total` filas sin solapes ni huecos; `totalPages = ceil(total/limit)` consistente.
    - **Property 6: Orden monótono** - Para cualquier conjunto de MRs, la salida queda ordenada por `merged_at DESC` (NULLS LAST).
    - `fast-check`, `{ numRuns: 100 }`, comentario por propiedad.
    - _Requirements: 2.2, 2.3, 3.5_

  - [x] 3.6 Migración SQL: índice por `merged_at` (rendimiento)
    - Crear `migrations/2026-06-XX_mr_review_merged_at_index.sql` con `CREATE INDEX IF NOT EXISTS idx_mr_review_merged_at ON mr_review_metrics(merged_at DESC);` (idempotente; valorar `CONCURRENTLY` fuera de transacción en tabla grande).
    - Acelera el caso por defecto de la pestaña (rango sin filtro equipo/proyecto/autor) una vez la tabla crece con el histórico. No cambia la corrección.
    - _Requirements: 2.3_

  - [x] 3.7 Manifiesto del Job one-off de k8s + documentación de lanzamiento
    - Añadir un manifiesto/plantilla del Job puntual derivado del CronJob `mr-metrics-snapshot` (misma imagen `tooling/mr-metrics-snapshot`, mismo `envFrom: portal-env`), con `command` override y env `BACKFILL_FROM` (+ `BACKFILL_TO` opcional). Documentar en el repo el procedimiento (`kubectl --context <dp-tooling> -n n8n create job mr-backfill-2026q1 --from=cronjob/mr-metrics-snapshot` + parche de env), off-peak, idempotente/reanudable.
    - **NOTA**: solo crear el manifiesto y documentar; el lanzamiento real del backfill en producción es operación manual fuera de este plan.
    - El CronJob diario sigue corriendo sin cambios.
    - _Requirements: 2.5_

  - [x] 3.8 Verificar que el test exploratorio de la condición del bug ahora pasa
    - **Property 1: Expected Behavior** - Los rangos históricos con MRs reales muestran y paginan el detalle
    - **IMPORTANT**: Re-ejecutar el MISMO test de la tarea 1 — NO escribir uno nuevo. Ese test codifica el comportamiento esperado.
    - Ejecutar el test exploratorio de la condición del bug de la tarea 1.
    - **EXPECTED OUTCOME**: el test PASA (confirma que el bug está resuelto: el modo backfill cubre `[BACKFILL_FROM, B)` y la paginación reporta el recuento real).
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 3.9 Verificar que los tests de preservación siguen pasando
    - **Property 2: Preservation** - Los rangos no afectados se comportan exactamente igual
    - **IMPORTANT**: Re-ejecutar los MISMOS tests de la tarea 2 — NO escribir nuevos.
    - Ejecutar los tests de preservación de la tarea 2.
    - **EXPECTED OUTCOME**: PASAN (sin regresiones — el backfill solo añade filas con `merged_at < B`, el incremental y el endpoint no cambian).
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 4. Checkpoint — asegurar que toda la suite pasa
  - Ejecutar `npm test` (toda la suite de propiedades + unit). Confirmar que Property 1 pasa, Property 2 sigue en verde y Properties 3–6 pasan.
  - Verificar `npm run lint` sobre los ficheros tocados.
  - Si surgen dudas o fallos inesperados, consultar antes de continuar.
  - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5_

## Notes

- **Orden metodológico**: tareas 1 (Bug Condition, debe FALLAR) y 2 (Preservation, deben PASAR) se
  escriben y ejecutan sobre el código SIN fix antes de tocar nada. La implementación (tarea 3) va
  después; las verificaciones 3.8/3.9 re-ejecutan los MISMOS tests de 1 y 2.
- **El endpoint `mr-details` no cambia**: la corrección es de datos (backfill), por eso la
  preservación se cumple por construcción acotando el backfill a `merged_at < B`.
- **Solo actividades de código**: se crea el manifiesto del Job y se documenta cómo lanzarlo (3.7),
  pero el lanzamiento real del backfill en producción queda fuera de este plan (operación manual
  off-peak).
- **Testabilidad de la lógica pura**: `resolveWindow` y `planPagination` viven en
  `ops/mr-metrics-snapshot.js` exportadas, con arranque protegido por `require.main === module`,
  para que los tests del glob `src/lib/__tests__/*.test.ts` puedan importarlas.
- **Counterexample de referencia**: rango `2026-01-01..2026-03-28` sobre `basket-api` →
  empty-state con 200 OK pese a existir MRs mergeados reales en GitLab.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "description": "Tests previos al fix (sobre código sin fix): exploración del bug y preservación",
      "tasks": ["1", "2"],
      "dependsOn": []
    },
    {
      "wave": 2,
      "description": "Lógica pura del snapshot (resolveWindow/planPagination) y migración SQL independiente",
      "tasks": ["3.1", "3.6"],
      "dependsOn": ["1", "2"]
    },
    {
      "wave": 3,
      "description": "Activación del modo backfill, paginación completa y PBT de la lógica pura",
      "tasks": ["3.2", "3.4"],
      "dependsOn": ["3.1"]
    },
    {
      "wave": 4,
      "description": "Fetch paginado + filtro client-side, PBT de paginación/orden y manifiesto del Job",
      "tasks": ["3.3", "3.5", "3.7"],
      "dependsOn": ["3.2"]
    },
    {
      "wave": 5,
      "description": "Verificación: Fix Checking (Property 1) y Preservation Checking (Property 2)",
      "tasks": ["3.8", "3.9"],
      "dependsOn": ["3.2", "3.3"]
    },
    {
      "wave": 6,
      "description": "Checkpoint final de la suite completa",
      "tasks": ["4"],
      "dependsOn": ["3.4", "3.5", "3.6", "3.7", "3.8", "3.9"]
    }
  ],
  "tasks": [
    {
      "id": "1",
      "name": "Property 1: Bug Condition exploration test (debe FALLAR sin fix)",
      "type": "pbt-exploration",
      "property": "Property 1: Bug Condition",
      "dependsOn": [],
      "requirements": ["2.1", "2.2", "2.3", "2.4", "2.5"],
      "expectedOutcomeUnfixed": "fail"
    },
    {
      "id": "2",
      "name": "Property 2: Preservation tests (deben PASAR sin fix)",
      "type": "pbt-preservation",
      "property": "Property 2: Preservation",
      "dependsOn": [],
      "requirements": ["3.1", "3.2", "3.3", "3.4", "3.5"],
      "expectedOutcomeUnfixed": "pass"
    },
    {
      "id": "3.1",
      "name": "Extraer/exportar resolveWindow + planPagination (lógica pura)",
      "type": "implementation",
      "dependsOn": ["1", "2"],
      "requirements": ["2.5", "3.1", "3.4"]
    },
    {
      "id": "3.2",
      "name": "Calcular B y activar modo backfill en main",
      "type": "implementation",
      "dependsOn": ["3.1"],
      "requirements": ["2.1", "2.5"]
    },
    {
      "id": "3.3",
      "name": "Paginar todas las páginas + filtro client-side merged_at (backfill)",
      "type": "implementation",
      "dependsOn": ["3.2"],
      "requirements": ["2.1", "2.2", "2.3"]
    },
    {
      "id": "3.4",
      "name": "Property 3/4: PBT resolveWindow (incremental + until≤B)",
      "type": "pbt",
      "property": "Property 3/4",
      "dependsOn": ["3.1"],
      "requirements": ["2.5", "3.1", "3.4"]
    },
    {
      "id": "3.5",
      "name": "Property 5/6: PBT paginación cubre total + orden merged_at DESC",
      "type": "pbt",
      "property": "Property 5/6",
      "dependsOn": ["3.1", "3.3"],
      "requirements": ["2.2", "2.3", "3.5"]
    },
    {
      "id": "3.6",
      "name": "Migración SQL índice idx_mr_review_merged_at",
      "type": "implementation",
      "dependsOn": [],
      "requirements": ["2.3"]
    },
    {
      "id": "3.7",
      "name": "Manifiesto Job one-off k8s + documentación de lanzamiento",
      "type": "implementation",
      "dependsOn": ["3.2", "3.3"],
      "requirements": ["2.5"]
    },
    {
      "id": "3.8",
      "name": "Property 1: Expected Behavior — re-ejecutar test de tarea 1 (debe PASAR)",
      "type": "pbt-verification",
      "property": "Property 1: Expected Behavior",
      "dependsOn": ["3.2", "3.3"],
      "requirements": ["2.1", "2.2", "2.3", "2.4", "2.5"],
      "expectedOutcomeFixed": "pass"
    },
    {
      "id": "3.9",
      "name": "Property 2: Preservation — re-ejecutar tests de tarea 2 (deben seguir PASANDO)",
      "type": "pbt-verification",
      "property": "Property 2: Preservation",
      "dependsOn": ["3.2", "3.3"],
      "requirements": ["3.1", "3.2", "3.3", "3.4", "3.5"],
      "expectedOutcomeFixed": "pass"
    },
    {
      "id": "4",
      "name": "Checkpoint — npm test + lint en verde",
      "type": "checkpoint",
      "dependsOn": ["3.4", "3.5", "3.6", "3.7", "3.8", "3.9"],
      "requirements": ["2.1", "2.2", "2.3", "2.4", "2.5", "3.1", "3.2", "3.3", "3.4", "3.5"]
    }
  ]
}
```
