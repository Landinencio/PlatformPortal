# Implementation Plan: finops-cost-comparison-explorer

## Overview

El plan implementa las dos partes del diseño dentro de la pestaña **Costes** del módulo FinOps.

**PARTE A (corrección de alcance por cuenta)** arregla el bug de scoping en el origen y refuerza
con defensa en cliente: se añade la dimensión de cuenta a `ec2Fleet` en `src/lib/athena-cur.ts`
(`GROUP BY product_instance_type, line_item_usage_account_id`, con `accountId`/`accountName` por
fila) y se confirma el filtro `line_item_usage_account_id IN (...)` en cada sub-query con cuenta; se
crea el módulo puro `src/lib/finops-scope.ts` (`rowInScope`, `scopeSnapshotToAccounts`); se endurece
`/api/finops/cur-direct` aplicando `scopeSnapshotToAccounts` para `accountIds` explícitos y haciendo
el fallback org-wide (`"all"`/ausente) explícito; se corrige `AwsRightsizingCard` (la fuga real)
propagando `selectedAccountIds` a `/api/finops/forecast` y filtrando recomendaciones por cuenta; y
se propaga `selectedAccountIds` desde `costs-dashboard.tsx` a `cur-deep-insights.tsx` con scoping
defensivo en cliente y la columna de cuenta en la tabla EC2.

**PARTE B (explorador de comparativas)** añade el módulo puro `src/lib/finops-cost-comparison.ts`
(tipos `MonthKey`/`ComparisonLevel`/`Trend`/`EntityCost`/`ComparisonRow`/`ComparisonResult` +
`monthRange`, `sortMonths`, `extractEntities`, `buildComparisonRows`, `computeDelta`,
`buildComparison`, `buildProgression`), el hook `src/hooks/use-cost-comparison.ts` (una llamada
`cur-direct` por mes vía `Promise.allSettled` con aislamiento de error por mes) y los componentes
`src/components/finops/comparison-explorer.tsx` (`ComparisonExplorerDialog`, `MonthPicker`,
`ComparisonBreadcrumb`, `ComparisonTable`, `ComparisonChart` con Recharts + tabla alternativa
accesible), más el botón "Comparar meses" en `costs-dashboard.tsx`.

El plan secuencia primero los módulos puros con sus property tests, luego los cambios de
endpoint/capa de datos con tests de integración (Athena mockeado), y por último los componentes de
UI y el cableado, con checkpoints intermedios.

Stack de test: `node:test` (vía `tsx --test`) + `fast-check`, recogido por `npm test`. Cada property
test usa `{ numRuns: 100 }` y lleva el tag `// Feature: finops-cost-comparison-explorer, Property N: ...`.
Las propiedades viven en `src/lib/__tests__/finops-scope.property.test.ts` (P1) y
`src/lib/__tests__/finops-cost-comparison.property.test.ts` (P2–P8).

## Tasks

- [x] 1. PARTE A — Módulo puro de scoping por cuenta
  - [x] 1.1 Implementar `src/lib/finops-scope.ts`
    - Definir el tipo `AccountScoped` (`{ accountId?: string; account?: string }`) e implementar `rowInScope(row, accountIds: ReadonlySet<string>)`: `true` si la fila pertenece al conjunto
    - Implementar `scopeSnapshotToAccounts(snapshot: CurFullSnapshot, accountIds: string[]): CurFullSnapshot` que filtra sección a sección toda fila con dimensión de cuenta (`byAccount`, `topResources`, `ec2Fleet`, `hiddenCosts.cloudwatchLogs.topGroups`, `hiddenCosts.natGateways.topConsumers`, `hiddenCosts.bedrock.byModel`, `hiddenCosts.gp2Detail`, `hiddenCosts.extendedSupportDetail`, `anomalyAttribution[].topResources`, `aiCostDaily.days[].byAccount`), dejando vacías las secciones sin intersección; conserva sólo las secciones no identificables por cuenta
    - Implementar `assertSnapshotScoped(snapshot, accountIds)` (lanza en dev/test, loguea warning en runtime) para detectar regresiones de query
    - _Requirements: 1.1, 1.2, 1.4, 2.2, 2.3, 2.4_

  - [x] 1.2 Property test del scoping del snapshot
    - **Property 1: Invariante de alcance del snapshot**
    - Archivo `src/lib/__tests__/finops-scope.property.test.ts`; generar `CurFullSnapshot` con cuentas aleatorias + subconjunto seleccionado (incluido disjunto); verificar que ninguna sección con cuenta retiene filas fuera del conjunto y que las secciones sin intersección quedan vacías
    - **Validates: Requirements 1.1, 1.2, 1.4, 2.3, 2.4**

- [x] 2. PARTE B — Módulo puro de comparación
  - [x] 2.1 Implementar tipos y extracción de entidades en `src/lib/finops-cost-comparison.ts`
    - Definir `MonthKey` (`"YYYY-MM"`), `ComparisonLevel` (`"account" | "service" | "resource"`), `Trend`, `EntityCost`, `ComparisonRow`, `ComparisonResult`
    - Implementar `monthRange(month): { startDate; endDate }` (límites del mes natural para las llamadas a `cur-direct`) y `sortMonths(months)` (orden cronológico ascendente)
    - Implementar `extractEntities(snapshot, level, drill)`: nivel `account` desde `byAccount[]`; `service` desde `byAccount[accountId].services[]`; `resource` desde `topResources[]` filtrado por `accountId` + `service`
    - _Requirements: 5.1, 5.2, 5.3, 6.5, 8.3, 10.1_

  - [x] 2.2 Implementar el núcleo comparativo en `src/lib/finops-cost-comparison.ts`
    - Implementar `buildComparisonRows(perMonth, months)` con zero-fill (una entrada en `byMonth` por cada mes; ausencia ⇒ `0`)
    - Implementar `computeDelta(byMonth, months)`: `deltaAbs = byMonth[last] - byMonth[first]`; `deltaPct = base===0 ? null : (deltaAbs/base)*100`; `trend = up|down|flat`
    - Implementar `buildProgression(row, months)` (importes en orden cronológico) y el orquestador puro `buildComparison(snapshotsByMonth, level, drill): ComparisonResult`
    - _Requirements: 4.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 9.1, 9.2, 9.3, 9.4_

  - [x] 2.3 Property test de completitud por zero-fill
    - **Property 2: Completitud por zero-fill**
    - Archivo `src/lib/__tests__/finops-cost-comparison.property.test.ts`; entidades presentes en subconjuntos de meses; cada fila tiene valor para todos los meses, `0` donde no había datos (altas y bajas incluidas)
    - **Validates: Requirements 6.1, 9.1, 9.2, 9.3**

  - [x] 2.4 Property test de variación absoluta
    - **Property 3: Variación absoluta = reciente − antiguo**
    - En `finops-cost-comparison.property.test.ts`; `byMonth` con importes y ceros aleatorios
    - **Validates: Requirements 6.2, 6.4, 9.4**

  - [x] 2.5 Property test de variación porcentual con base cero
    - **Property 4: Variación porcentual no aplicable con base cero**
    - En `finops-cost-comparison.property.test.ts`; importes con `base` 0 y ≠ 0; `null` sii base 0, en otro caso `(reciente − base)/base*100`
    - **Validates: Requirements 6.3, 6.6**

  - [x] 2.6 Property test de progresión cronológica
    - **Property 5: Progresión cronológica ordenada**
    - En `finops-cost-comparison.property.test.ts`; `sortMonths` ordena ascendente y `buildProgression` recorre `byMonth` en ese orden con la misma longitud que el nº de meses
    - **Validates: Requirements 6.5, 7.2, 7.3**

  - [x] 2.7 Property test de agregación jerárquica
    - **Property 6: Consistencia de agregación jerárquica**
    - En `finops-cost-comparison.property.test.ts`; dataset `(mes, cuenta, servicio, recurso, coste)`; suma de objetos = coste del servicio y suma de servicios = coste de la cuenta (salvo redondeo a 2 decimales)
    - **Validates: Requirements 5.2, 5.3, 6.1**

  - [x] 2.8 Property test del conjunto activo de meses
    - **Property 7: El dataset refleja el conjunto activo de meses**
    - En `finops-cost-comparison.property.test.ts`; las claves de `byMonth` son exactamente el conjunto de meses; al añadir/quitar un mes cambian; el drill-down no altera `months` ni `accountIds`
    - **Validates: Requirements 4.4, 5.5**

  - [x] 2.9 Property test del alcance del explorador
    - **Property 8: Invariante de alcance del explorador**
    - En `finops-cost-comparison.property.test.ts`; filas crudas con cuentas mixtas + `selectedAccountIds`; ninguna fila (nivel cuenta/servicio/objeto) pertenece a una cuenta fuera del conjunto
    - **Validates: Requirements 8.1, 8.3**

- [x] 3. Checkpoint - Módulos puros (scoping y comparación)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. PARTE A — Capa de datos (Athena/CUR) y endpoint
  - [x] 4.1 Añadir dimensión de cuenta a `ec2Fleet` en `src/lib/athena-cur.ts`
    - Modificar la query #12 a `GROUP BY product_instance_type, line_item_usage_account_id` y añadir `accountId`/`accountName` (resuelto vía `accountNameMap`) a cada fila
    - Ampliar el tipo `CurFullSnapshot["ec2Fleet"]` a `Array<{ instanceType; accountId; accountName; resourceCount; cost }>`; mantener `WHERE line_item_usage_account_id IN (${idsStr})`
    - Auditar y documentar que cada sub-query con dimensión de cuenta (`byAccount`, `topResources`, `cloudwatchLogs`, `natGateways`, `bedrock.byModel`, `gp2Detail`, `extendedSupportDetail`, `aiCostDaily`) lleva `line_item_usage_account_id IN (...)`
    - _Requirements: 1.3, 2.2_

  - [x] 4.2 Tests de integración de la query `ec2Fleet` (Athena mockeado)
    - Archivo `src/lib/__tests__/athena-cur-scope.test.ts`: el SQL de `ec2Fleet` agrupa por instance type + cuenta y filtra por `line_item_usage_account_id IN (...)`; las filas resultantes incluyen `accountId`/`accountName`
    - _Requirements: 1.3, 2.2_

  - [x] 4.3 Endurecer `src/app/api/finops/cur-direct/route.ts`
    - Aplicar `scopeSnapshotToAccounts(snapshot, accountIds)` cuando `accountIdsParam` es explícito, antes de devolver
    - Hacer el fallback org-wide explícito: `"all"`/ausente sigue mapeando a cuentas vivas pero documentado y separado del camino con cuentas explícitas (sin fuga silenciosa)
    - _Requirements: 2.1, 2.2, 1.4_

  - [x] 4.4 Tests de integración del endpoint `cur-direct` (Athena/catálogo mockeado)
    - Archivo `src/lib/__tests__/cur-direct-route.test.ts`: con `accountIds` explícito la respuesta sólo contiene cuentas pedidas (aunque una query devolviese de más); el camino `"all"`/ausente cae a cuentas vivas de forma explícita
    - _Requirements: 2.2, 1.4_

- [x] 5. Checkpoint - Capa de datos y endpoint
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. PARTE A — Defensa en cliente y corrección de fugas
  - [x] 6.1 Defensa en cliente en `src/components/finops/cur-deep-insights.tsx`
    - Añadir prop `selectedAccountIds: string[]` y envolver `data` con `scopeSnapshotToAccounts(data, selectedAccountIds)` antes de renderizar
    - Ampliar el tipo `CurDeepInsights["ec2Fleet"]` con `accountId`/`accountName` y mostrar la columna de cuenta en `Ec2FleetCard` (doblemente protegida)
    - _Requirements: 1.1, 1.2, 1.3, 2.3, 2.4_

  - [x] 6.2 Propagar `selectedAccountIds` desde `src/components/finops/costs-dashboard.tsx`
    - Pasar `selectedAccountIds` a `<CurDeepInsights />`
    - _Requirements: 2.4_

  - [x] 6.3 Corregir la fuga real en `src/components/finops/aws-rightsizing-card.tsx`
    - Recibir `selectedAccountIds` como prop y añadir `accountIds=<csv>` a la llamada `/api/finops/forecast`
    - Filtrar defensivamente `rs.recommendations` por `accountId ∈ selectedAccountIds` antes de renderizar y recalcular los contadores de resumen mostrados
    - Pasar `selectedAccountIds` desde `costs-dashboard.tsx` al montar `<AwsRightsizingCard />`
    - _Requirements: 1.1, 1.2_

  - [x] 6.4 Tests de ejemplo de scoping en cliente y wiring de rightsizing
    - Archivo `src/lib/__tests__/finops-scope-client.test.ts`: `scopeSnapshotToAccounts` elimina filas fuera de cuenta de `ec2Fleet` y `hiddenCosts`; el filtro de recomendaciones de `AwsRightsizingCard` descarta cuentas no seleccionadas y la URL de forecast incluye `accountIds`
    - _Requirements: 1.1, 1.3, 1.2_

- [x] 7. Checkpoint - PARTE A completa (origen + cliente)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. PARTE B — Hook de orquestación de red
  - [x] 8.1 Implementar `src/hooks/use-cost-comparison.ts`
    - Dado `selectedAccountIds` y `selectedMonths`, lanzar una llamada `fetch('/api/finops/cur-direct?...')` por mes en paralelo con `Promise.allSettled` (usando `monthRange` para `startDate`/`endDate` y propagando `accountIds`)
    - Guardar `snapshotsByMonth` y `monthErrors` (fallo aislado por mes), exponer `loading` y un `buildComparison(...)` memoizado
    - _Requirements: 4.3, 8.2, 10.1, 10.2, 10.3, 10.4_

  - [x] 8.2 Tests de ejemplo del hook (aislamiento de fallo parcial)
    - Archivo `src/lib/__tests__/use-cost-comparison.test.ts` (fetch mockeado): un mes que falla se registra en `monthErrors` sin impedir los meses correctos; cada petición transmite `accountIds`
    - _Requirements: 10.4, 8.2_

- [x] 9. PARTE B — Componentes del explorador y cableado
  - [x] 9.1 Implementar `src/components/finops/comparison-explorer.tsx` (diálogo, selección y tabla)
    - `ComparisonExplorerDialog` (shadcn `Dialog`): título accesible, cierre por teclado, hereda `selectedAccountIds`; estado `selectedMonths`, `level`, `drillPath`, `loading`, `monthErrors`
    - `MonthPicker` (selección ≥2 meses; bloquea generar con <2 mostrando aviso `role="alert"`), `ComparisonBreadcrumb` (volver al nivel superior, activable por teclado) y `ComparisonTable` (shadcn table con `<th scope>`, importe por mes, Δ€, Δ%, tendencia; Δ% "n/a" si base 0; indicador de carga y mensajes de error por mes)
    - Drill-down cuenta → servicio → objeto reutilizando `buildComparison` del hook; mantener fijos meses y cuentas al navegar
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.6, 8.1, 8.3, 10.3, 10.4, 11.1, 11.2, 11.3, 11.5_

  - [x] 9.2 Implementar `ComparisonChart` en `src/components/finops/comparison-explorer.tsx`
    - Gráfica Recharts (barras agrupadas para 2 meses, líneas para progresión multi-mes) que se actualiza al cambiar de nivel y al cambiar la selección de meses
    - Proveer tabla/alternativa textual accesible equivalente a la gráfica
    - _Requirements: 6.5, 7.1, 7.2, 7.3, 11.4_

  - [x] 9.3 Cablear el botón "Comparar meses" en `src/components/finops/costs-dashboard.tsx`
    - Botón que abre `ComparisonExplorerDialog` pasando `selectedAccountIds`; cerrar el diálogo no muta `selectedAccountIds`/`startDate`/`endDate`
    - _Requirements: 3.1, 3.2, 3.3, 3.4_

  - [x] 9.4 Tests de ejemplo de los componentes del explorador
    - Archivo `src/lib/__tests__/comparison-explorer.test.ts`: rol/título del Dialog y cierre por teclado (11.1, 11.2); selector exige ≥2 meses (4.2); `th[scope]` en la tabla (11.3); tabla alternativa por gráfica (11.4); breadcrumb activable por teclado (11.5); herencia de cuentas al abrir (3.3)
    - _Requirements: 3.3, 4.2, 11.1, 11.2, 11.3, 11.4, 11.5_

- [x] 10. Checkpoint final - Ejecutar la suite completa
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Las tareas marcadas con `*` son opcionales (tests) y pueden saltarse para un MVP más rápido; las tareas de implementación nunca son opcionales.
- Cada tarea referencia cláusulas concretas de requisitos para trazabilidad.
- Las 8 propiedades de corrección se implementan con un único property test cada una (≥100 iteraciones), con el tag `// Feature: finops-cost-comparison-explorer, Property N: ...`. P1 vive en `finops-scope.property.test.ts`; P2–P8 en `finops-cost-comparison.property.test.ts`.
- El alcance a nivel de query Athena (`ec2Fleet`, endurecimiento de `cur-direct`) y el wiring de UI (defensa en cliente, `AwsRightsizingCard`, componentes del explorador) se cubren con tests de integración y de ejemplo, no con PBT.
- Los módulos puros (`finops-scope`, `finops-cost-comparison`) se construyen primero con sus property tests; el hook recibe los snapshots por mes y el orquestador comparativo es puro y testeable sin red.
- Los checkpoints aseguran validación incremental antes de avanzar.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "4.1"] },
    { "id": 1, "tasks": ["1.2", "2.2", "4.2", "4.3"] },
    { "id": 2, "tasks": ["2.3", "4.4", "6.1"] },
    { "id": 3, "tasks": ["2.4", "6.2", "6.3"] },
    { "id": 4, "tasks": ["2.5", "6.4", "8.1"] },
    { "id": 5, "tasks": ["2.6", "8.2", "9.1"] },
    { "id": 6, "tasks": ["2.7", "9.2"] },
    { "id": 7, "tasks": ["2.8", "9.3"] },
    { "id": 8, "tasks": ["2.9", "9.4"] }
  ]
}
```
