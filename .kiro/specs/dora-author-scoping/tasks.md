# Implementation Plan: dora-author-scoping

## Overview

El plan añade la **dimensión de autor de extremo a extremo** a las métricas DORA del Portal,
arreglando el problema **en el origen** (el cálculo) y reflejándolo con transparencia en la UI,
y cierra los **property tests pendientes** de la spec previa `dora-metrics-production-readiness`.

Se secuencia de forma incremental y coherente con el diseño:

1. **Módulo puro** `src/lib/dora-author-scope.ts` (resolución/dedup de autoría con identidad
   canónica reutilizada de `developer-identity.ts`/`dashboard-utils.ts`, predicado de pertenencia,
   Deployment Frequency atribuido, selección de Lead Times del autor + mediana,
   `Author_Attribution_Coverage`, `listSelectableAuthors`) con sus **property tests** (Properties
   1–11) en `src/lib/__tests__/dora-author-scope.property.test.ts`.
2. **Cierre de los property tests** pendientes de la spec previa (Properties 12–14) sobre los
   símbolos **ya existentes** (`selectLeadTimeWithVariant` en `metrics-formulas.ts`,
   `calculateConfidenceScore` en `metrics-formulas.ts`, `filterByConfidence` /
   `MIN_CORRELATION_CONFIDENCE` en `deployment-correlation.ts`) — **sin redefinirlos**.
3. **Threading de `authors`** en `src/lib/metrics-dashboard.ts`: clave de caché con autores
   normalizados (regresión cero con vacío), dejar de hacer `developers: []`, nueva query
   `getDeploymentChangeRows`, override de DF y Lead Time bajo filtro de autor, CFR/Recovery a nivel
   despliegue con flags, coverage en el audit e indicador "no disponible" `{ available: false }`.
   Con tests de integración (DB sembrada/mockeada) y un test de regresión cero.
4. **UI** en `src/components/metrics/engineering-dashboard.tsx` (pestaña DORA): `ScopeBanner`,
   `DeploymentLevelBadge`, `DoraEmptyState`, `AttributionCoverageNotice`, con tests de
   ejemplo/render + accesibilidad.
5. **i18n** de las nuevas etiquetas/avisos/tooltips en los 4 idiomas (en/es/pt/fr) con paridad de
   claves.

Stack de test: `node:test` (vía `tsx --test`) + `fast-check`, recogido por `npm test`. Cada property
test usa `fc.assert(prop, { numRuns: 100, seed: <n>, endOnFailure: true })` (≥100 casos, semilla
fija) y lleva el tag `// Feature: dora-author-scoping, Property N: ...`, con **una propiedad ↔ un
test**. Las propiedades 1–11 viven en `src/lib/__tests__/dora-author-scope.property.test.ts`; el
cierre de la spec previa (12–14) en `src/lib/__tests__/metrics-formulas.property.test.ts` (P12, P13)
y `src/lib/__tests__/deployment-correlation.property.test.ts` (P14).

## Tasks

- [x] 1. Módulo puro `src/lib/dora-author-scope.ts`
  - [x] 1.1 Implementar resolución de identidad, dedup y autores seleccionables
    - Crear `src/lib/dora-author-scope.ts` con los tipos `DeploymentChangeRow`, `DeploymentAuthorship`, `CanonicalAuthorKey`
    - `resolveChangeAuthorKeys(rows)`: resuelve la identidad canónica de cada fila reutilizando `resolveAuthorIdentitySeed` (`@/lib/dashboard-utils`) + `mergeDevelopersByIdentity` (`@/lib/developer-identity`); determinista e independiente del orden; filas sin email/username resoluble ⇒ `null` (autoría no resoluble)
    - `buildDeploymentAuthorship(rows)`: agrupa por `deploymentId`, deduplica autores por clave canónica y por `DATE(deploy_completed_at)`; marca `unresolved` cuando ningún cambio resuelve
    - `normalizeAuthorFilter(authors)`: normaliza a `Set<CanonicalAuthorKey>` (orden-insensible, sin duplicados; vacío ⇒ Set vacío)
    - `listSelectableAuthors(rows)`: `MergedDeveloperIdentity[]` sin duplicados por `canonicalKey` y en orden determinista
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

  - [x] 1.2 Implementar predicado, DF atribuido, Lead Times del autor, mediana y coverage
    - `changeBelongsToAuthorFilter(authorKey, filter)`: `true` sii la clave canónica coincide con ≥1 clave del filtro
    - `countAttributedDeployments(authorship, filter)`: cuenta cada despliegue con ≥1 cambio del filtro **una sola vez**; invariante ante duplicación de filas equivalentes
    - `selectAuthorLeadTimes(rows, authorKeyByRow, filter, guardHours)`: Lead Time (variante `first_commit`, en horas) de los cambios del filtro, excluyendo autores no seleccionados y filas no resolubles; aplica el guard rail de outliers
    - `median(values)`: valor central si impar, media de los dos centrales si par; `[]` ⇒ `null`
    - `authorAttributionCoverage(authorship)`: `(despliegues resolubles / total) * 100` redondeado a 1 decimal, acotado `[0,100]`; `null` si 0 despliegues
    - Helper puro de clave de caché: `authorsCacheKeyPart(authors)` = `[...normalizeAuthorFilter(authors)].sort()` y un predicado puro `authorScopeActive(filter)` (false con filtro vacío ⇒ ruta de regresión cero)
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.1, 6.2, 7.1, 7.2, 7.3_

  - [x] 1.3 Property test: identidad canónica determinista e independiente del orden
    - Archivo `src/lib/__tests__/dora-author-scope.property.test.ts`; generar filas con emails variados (mayúsculas, dominios `@iskaypet.com`/`@emefinpetcare.com`) y permutaciones; verificar mismas claves canónicas por despliegue agrupando la misma identidad
    - **Property 1: Identidad canónica de autor determinista e independiente del orden**
    - **Validates: Requirements 3.1, 3.2, 3.3**

  - [x] 1.4 Property test: pertenencia a Author_Filter por clave canónica
    - En `dora-author-scope.property.test.ts`; `changeBelongsToAuthorFilter` true sii la clave coincide con ≥1 autor del filtro
    - **Property 2: Pertenencia a Author_Filter por clave canónica**
    - **Validates: Requirements 1.6**

  - [x] 1.5 Property test: Deployment Frequency atribuido cuenta cada despliegue una sola vez
    - En `dora-author-scope.property.test.ts`; despliegues con autores dentro/fuera del filtro; `countAttributedDeployments` = nº de despliegues con ≥1 cambio del filtro, cada uno una vez
    - **Property 3: Deployment Frequency atribuido cuenta cada despliegue una sola vez**
    - **Validates: Requirements 1.1, 1.2, 1.4**

  - [x] 1.6 Property test: conteo atribuido invariante ante duplicación de filas equivalentes
    - En `dora-author-scope.property.test.ts`; duplicar filas equivalentes (mismo `deploymentId` + misma identidad) no cambia `countAttributedDeployments`; dedup por identidad canónica y por `DATE(deploy_completed_at)`
    - **Property 4: Conteo atribuido invariante ante duplicación de filas equivalentes**
    - **Validates: Requirements 8.4, 3.3**

  - [x] 1.7 Property test: Lead Time atribuido es la mediana de los cambios del autor
    - En `dora-author-scope.property.test.ts`; lead times con outliers (> guard) y negativos; mediana de `first_commit` de los cambios del filtro; `null` (no cero) sin cambios atribuibles
    - **Property 5: Lead Time atribuido es la mediana de los cambios del autor**
    - **Validates: Requirements 1.3, 1.5, 6.2**

  - [x] 1.8 Property test: Author_Attribution_Coverage bien definido y acotado
    - En `dora-author-scope.property.test.ts`; coverage = resolubles/total*100 redondeado a 1 decimal, acotado `[0,100]`; despliegues sin cambios o sin identidad ⇒ no resolubles; 0 despliegues ⇒ `null`
    - **Property 8: Author_Attribution_Coverage bien definido y acotado**
    - **Validates: Requirements 7.1, 7.2, 7.3**

  - [x] 1.9 Property test: lista de autores seleccionables canónica, sin duplicados y determinista
    - En `dora-author-scope.property.test.ts`; ante cualquier permutación, `listSelectableAuthors` devuelve la misma lista sin duplicados por `canonicalKey` y en orden determinista
    - **Property 9: Lista de autores seleccionables canónica, sin duplicados y determinista**
    - **Validates: Requirements 3.4**

  - [x] 1.10 Property test: las métricas de nivel despliegue son invariantes al filtro de autor
    - En `dora-author-scope.property.test.ts`; el conjunto de despliegues/pipelines usado para CFR/Recovery (derivado del alcance, sin intersección por autor) es el mismo con filtro vacío que con cualquier filtro no vacío
    - **Property 6: Las métricas de nivel despliegue son invariantes al filtro de autor**
    - **Validates: Requirements 2.1, 2.2**

  - [x] 1.11 Property test: escenario vacío bajo filtro de autor devuelve no disponible
    - En `dora-author-scope.property.test.ts`; con filtro no vacío sin actividad atribuible: DF = 0 exacto; `median(selectAuthorLeadTimes(...))` = `null`; coverage = `null`; sin heredar valores del alcance sin autor
    - **Property 7: Escenario vacío bajo filtro de autor devuelve no disponible**
    - **Validates: Requirements 2.5, 6.1, 6.3, 6.4**

  - [x] 1.12 Property test: clave de caché canónica en la dimensión de autor
    - En `dora-author-scope.property.test.ts`; usando `authorsCacheKeyPart`/`normalizeAuthorFilter`: (a) conjuntos distintos ⇒ partes distintas; (b) mismo conjunto con distinto orden/duplicados ⇒ misma parte; (c) filtro vacío ⇒ parte constante
    - **Property 10: Clave de caché canónica en la dimensión de autor**
    - **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 9.5**

  - [x] 1.13 Property test: regresión cero sin filtro de autor (nivel puro)
    - En `dora-author-scope.property.test.ts`; `authorScopeActive(normalizeAuthorFilter([]))` es `false` ⇒ no se aplica scoping de autor; el conjunto de despliegues/cambios considerado no se reduce, amplía ni reordena
    - **Property 11: Regresión cero sin filtro de autor**
    - **Validates: Requirements 9.1, 9.2, 9.3**

- [x] 2. Cierre de property tests pendientes de la spec previa (sobre símbolos existentes, sin redefinir)
  - [x] 2.1 Property test: selección de Lead Time con fallback canónico
    - Archivo `src/lib/__tests__/metrics-formulas.property.test.ts`; importar `selectLeadTimeWithVariant` y `CANONICAL_LEAD_TIME_VARIANT` de `@/lib/metrics-formulas` (no redefinir); ternas con ≥1 valor válido ⇒ primera variante disponible (`first_commit` → `mr_created` → `last_commit`); ninguno válido ⇒ `null`; nunca lanza
    - **Property 12: Selección de Lead Time con fallback canónico (cierre spec previa)**
    - **Validates: Requirements 8.1**

  - [x] 2.2 Property test: confidence score en rango cerrado [0,100]
    - En `metrics-formulas.property.test.ts`; importar `calculateConfidenceScore` de `@/lib/metrics-formulas`; dominio documentado (`leadTimeCoveragePct ∈ [0,100]`, `avgCorrelationConfidence ∈ [0,1]`, `anomalyCount ≥ 0`), incluidos límites y entradas vacías; resultado siempre en `[0,100]`
    - **Property 13: Confidence score en rango cerrado [0,100] (cierre spec previa)**
    - **Validates: Requirements 8.2**

  - [x] 2.3 Property test: filtrado por confianza de correlaciones
    - Archivo `src/lib/__tests__/deployment-correlation.property.test.ts`; importar `filterByConfidence` y `MIN_CORRELATION_CONFIDENCE` de `@/lib/deployment-correlation`; el resultado es subconjunto sin añadir ni modificar elementos y conserva todas y solo las correlaciones con score ≥ umbral
    - **Property 14: Filtrado por confianza de correlaciones (cierre spec previa)**
    - **Validates: Requirements 8.3**

- [x] 3. Checkpoint - Módulo puro + property tests (incl. cierre spec previa)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Threading de `authors` en `src/lib/metrics-dashboard.ts`
  - [x] 4.1 Incluir `authors` normalizados en la `DORA_Cache_Key` de `getDoraCoreDashboard`
    - Añadir `authors: [...normalizeAuthorFilter(filters.authors)].sort()` a la `cacheKey` (junto a `days/from/to/teams/projectIds/includeClusterSignals`)
    - Filtro vacío ⇒ sub-clave `authors=` constante ⇒ misma entrada de caché que hoy (regresión cero); mantener el prefijo de invalidación canónico `dora:`/`dora-core:`
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 9.5_

  - [x] 4.2 Nueva query `getDeploymentChangeRows` (autoría desde `deployment_changes`)
    - Implementar `getDeploymentChangeRows(startDate, endDate, filters): Promise<DeploymentChangeRow[]>` en `metrics-dashboard.ts`: `production_deployments pd LEFT JOIN deployment_changes dc ON dc.deployment_id = pd.id` con las **mismas condiciones** que `getCanonicalDoraRows` (`source='gitlab'`, `status='success'`, ventana de fechas, `environment ∈ DORA_PROD_ENVIRONMENTS`, team/projectIds)
    - Proyectar `pd.id`, `DATE(pd.deploy_completed_at)`, `dc.commit_sha`, `dc.commit_created_at`, `dc.mr_first_commit_at`, `pd.deploy_completed_at`, `dc.author_email`
    - Capturar fallos de query como `getCanonicalDoraRows` (try/catch + `console.error`) para degradar sin romper la respuesta
    - _Requirements: 1.1, 3.5, 7.2_

  - [x] 4.3 Aplicar el scoping de autor en `_getDoraCoreDashboardImpl`
    - Dejar de descartar la dimensión de autor (eliminar `developers: []`); cuando `filters.authors.length > 0` resolver autoría con el módulo puro (`resolveChangeAuthorKeys`, `buildDeploymentAuthorship`, `normalizeAuthorFilter`)
    - Override de respuesta bajo filtro: `deploymentFrequency` = `countAttributedDeployments` (conteo exacto, 0 si no hay); `leadTimeForChanges` = `median(selectAuthorLeadTimes(...))` o `{ available: false }` si `null` (no heredar el del alcance sin autor)
    - CFR y Pipeline Recovery Time **sin tocar** el SQL: cálculo a nivel despliegue/pipeline del alcance `(fecha ∩ equipo ∩ proyecto)`, marcados con `deploymentLevel: { changeFailureRate: true, pipelineRecoveryTime: true }`; `{ available: false }` si 0 despliegues/pipelines
    - Extender `summary` con `authorScope: DoraAuthorScope` (authors, `attributionCoverage`, `attributionCoverageThreshold` default 80.0, `active`) y añadir el check `author_attribution_coverage` al `summary.audit`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.5, 6.1, 6.2, 6.3, 6.4, 7.4_

  - [x] 4.4 Tests de integración de la query de autoría y el scoping (DB sembrada/mockeada)
    - Archivo `src/lib/__tests__/metrics-dashboard-author-scope.test.ts`: con `production_deployments` + `deployment_changes` sembrados/mockeados, verificar scoping `(fecha ∩ equipo ∩ proyecto)`, uso de `DATE(deploy_completed_at)` y join correcto en `getDeploymentChangeRows`; bajo `authors=...` el resultado cambia (DF atribuido, Lead Time mediana, `{available:false}` en escenario vacío) y el `audit` incluye `author_attribution_coverage`
    - _Requirements: 1.1, 1.3, 2.5, 6.2, 7.4_

  - [x] 4.5 Test de regresión cero (authors=[] ⇒ idéntico)
    - En `metrics-dashboard-author-scope.test.ts`: snapshot del resultado con `authors=[]` produce el mismo conteo entero de DF y los mismos Lead Time/CFR/Recovery (|Δ| ≤ 0,01; vacío si la referencia es vacía); misma clave de caché que sin la dimensión de autor
    - _Requirements: 9.1, 9.2, 9.3, 9.5_

- [x] 5. Checkpoint - Backend + integración
  - Ensure all tests pass, ask the user if questions arise.

- [x] 6. UI de la pestaña DORA en `src/components/metrics/engineering-dashboard.tsx`
  - [x] 6.1 Implementar `ScopeBanner` y `DeploymentLevelBadge`
    - `ScopeBanner`: muestra SIEMPRE las 3 dimensiones (equipo, proyecto, autores) aunque vacías; con autores muestra hasta 5 nombres canónicos + "+N más"; vacío ⇒ "sin filtro de autor"; ni equipo ni proyecto ni autores ⇒ "todos los equipos y proyectos"; se re-renderiza al completar el recálculo (estado React, sin recarga)
    - `DeploymentLevelBadge`: etiqueta "Nivel despliegue/pipeline" para CFR y Recovery, sólo cuando `authorScope.active`; tooltip accesible (`role="tooltip"`, `aria-describedby`) visible en hover y en foco de teclado, persistente, explicando que un despliegue fallido puede mezclar autores y la métrica no responsabiliza a una persona; `visible=false` con filtro vacío (sin etiquetas/tooltips)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 2.3, 2.4, 9.4_

  - [x] 6.2 Implementar `DoraEmptyState` y `AttributionCoverageNotice` y cablear la respuesta extendida
    - `DoraEmptyState`: identifica los autores seleccionados, indica 0 despliegues y 0 cambios atribuibles, distinto visualmente de error y de carga; se muestra cuando hay filtro de autor y métricas vacías
    - `AttributionCoverageNotice`: aviso visible cuando `attributionCoverage < attributionCoverageThreshold` ("atribución best-effort, puede estar incompleta") y nota permanente bajo filtro ("atribución basada en cambios de deployment_changes"); maneja `available:false` como "no disponible" (distinto de 0)
    - Consumir `summary.authorScope` y `summary.deploymentLevel` de la respuesta DORA para alimentar banner/badges/empty-state/aviso
    - _Requirements: 6.5, 7.5, 7.6, 2.5, 6.2, 6.3_

  - [x] 6.3 Tests de ejemplo de render y accesibilidad de la UI DORA
    - Archivo `src/lib/__tests__/dora-author-scope-ui.test.tsx` (Testing Library): banner con las 3 dimensiones (5.1), truncado a 5 + "+N" (5.2), texto "sin filtro" (5.3) y "todos los equipos y proyectos" (5.5), reactividad al cambiar filtro (5.4); badge de nivel despliegue presente con filtro y ausente sin filtro (2.3, 9.4); tooltip en hover y foco con `role="tooltip"`/`aria-describedby` persistente (2.4); estado vacío distinto de error/carga (6.5); aviso de cobertura con `coverage < threshold` y nota `deployment_changes` (7.5, 7.6)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 2.3, 2.4, 6.5, 7.5, 7.6, 9.4_

- [x] 7. i18n de las nuevas etiquetas, avisos y tooltips
  - [x] 7.1 Añadir las claves nuevas en los 4 catálogos (en/es/pt/fr)
    - Añadir las etiquetas del `ScopeBanner` (dimensiones, "sin filtro", "todos los equipos y proyectos", "+N más"), el texto y tooltip de `DeploymentLevelBadge`, el `DoraEmptyState` y los avisos de `AttributionCoverageNotice` en los 4 idiomas, con paridad de claves; respetar el patrón de closures i18n (cada helper su propio `const { t } = useI18n()`)
    - _Requirements: 2.3, 2.4, 5.1, 5.2, 5.3, 5.5, 6.5, 7.5, 7.6_

  - [x] 7.2 Test de paridad de claves i18n
    - Test que verifica que las nuevas claves existen en los 4 idiomas (en/es/pt/fr) con conjuntos de claves idénticos (sin huérfanas ni faltantes)
    - _Requirements: 2.3, 2.4, 5.1, 5.2, 5.3, 5.5, 6.5, 7.5, 7.6_

- [x] 8. Checkpoint - UI + i18n
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. Checkpoint final - Ejecutar la suite completa
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Las tareas marcadas con `*` son opcionales (tests) y pueden saltarse para un MVP más rápido; las tareas de implementación nunca son opcionales.
- Cada tarea referencia cláusulas concretas de requisitos para trazabilidad.
- Las 14 propiedades de corrección se implementan con un único property test cada una (≥100 iteraciones, semilla fija), con el tag `// Feature: dora-author-scoping, Property N: ...`. P1–P11 viven en `dora-author-scope.property.test.ts`; P12–P13 en `metrics-formulas.property.test.ts`; P14 en `deployment-correlation.property.test.ts`.
- Los símbolos de la spec previa (`selectLeadTimeWithVariant`, `CANONICAL_LEAD_TIME_VARIANT`, `calculateConfidenceScore`, `filterByConfidence`, `MIN_CORRELATION_CONFIDENCE`) se **reutilizan sin redefinir**; las tareas 2.x sólo aportan los property tests pendientes.
- El módulo puro se construye primero con sus property tests; el threading de backend, el wiring de UI y la i18n se cubren con tests de integración y de ejemplo, no con PBT.
- Regresión cero: `authors=[]` ⇒ misma clave de caché, mismo scope, mismos valores (reforzado por la tarea 4.5 a nivel de integración).
- Los checkpoints aseguran validación incremental antes de avanzar.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "2.1", "2.3"] },
    { "id": 1, "tasks": ["1.2", "2.2", "4.1"] },
    { "id": 2, "tasks": ["1.3", "4.2"] },
    { "id": 3, "tasks": ["1.4", "4.3"] },
    { "id": 4, "tasks": ["1.5", "4.4"] },
    { "id": 5, "tasks": ["1.6", "4.5", "6.1"] },
    { "id": 6, "tasks": ["1.7", "6.2"] },
    { "id": 7, "tasks": ["1.8", "6.3", "7.1"] },
    { "id": 8, "tasks": ["1.9", "7.2"] },
    { "id": 9, "tasks": ["1.10"] },
    { "id": 10, "tasks": ["1.11"] },
    { "id": 11, "tasks": ["1.12"] },
    { "id": 12, "tasks": ["1.13"] }
  ]
}
```
