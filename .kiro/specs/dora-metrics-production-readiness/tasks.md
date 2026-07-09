# Implementation Plan: DORA Metrics Production Readiness

## Overview

Hardening del sistema de métricas DORA para producción. Se corrigen definiciones semánticas, se mejora la configurabilidad mediante variables de entorno, se optimiza rendimiento con índices y caché selectiva, y se añade transparencia con indicadores de confianza y auditoría. Todos los cambios son sobre módulos existentes excepto el nuevo endpoint `/api/metrics/executive-summary`.

Lenguaje: TypeScript (Next.js + fast-check para property tests, node:test como runner)

## Tasks

- [ ] 1. Correcciones semánticas en metrics-formulas.ts
  - [x] 1.1 Implementar constantes canónicas y funciones de selección de Lead Time
    - Exportar `CANONICAL_LEAD_TIME_VARIANT = "first_commit"` con documentación JSDoc
    - Exportar tipo `LeadTimeVariant` y array `LEAD_TIME_FALLBACK_ORDER`
    - Implementar `selectLeadTimeWithVariant(firstCommitHours, mrCreatedHours, lastCommitHours)` que retorna `{hours, variant}` o null
    - Implementar helper `parsePositiveEnvInt(envKey)` para lectura segura de env vars
    - Exportar `LEAD_TIME_GUARD_HOURS` configurable via `DORA_MAX_LEAD_TIME_HOURS` con fallback 90*24
    - Documentar `DF_ANOMALY_THRESHOLD` con comentario sobre percentil 99 y hacerlo configurable via `DORA_DF_ANOMALY_THRESHOLD`
    - _Requirements: 1.1, 1.2, 1.3, 6.2, 6.3, 7.1, 7.2, 7.3_

  - [ ]* 1.2 Write property test: Lead Time Fallback Selection (Property 1)
    - **Property 1: Selección de Lead Time con Fallback Canónico**
    - Para cualquier combinación de valores (null, positivo, negativo), la función retorna la primera variante válida según el orden canónico, o null si ninguna es válida
    - File: `src/lib/__tests__/metrics-formulas.property.test.ts`
    - **Validates: Requirements 1.2, 1.3**

  - [ ]* 1.3 Write property test: Confidence Score Range (Property 9)
    - **Property 9: Confidence Score en Rango Válido**
    - Para cualquier combinación de inputs válidos, `calculateConfidenceScore` retorna un valor en [0, 100]
    - File: `src/lib/__tests__/metrics-formulas.property.test.ts`
    - **Validates: Requirements 11.1**

  - [ ]* 1.4 Write property test: Anomaly Reporting (Property 7)
    - **Property 7: Reporte de Anomalías en Audit Summary**
    - Si deployment frequency excede el umbral, aparece en audit; si no, no aparece
    - File: `src/lib/__tests__/metrics-formulas.property.test.ts`
    - **Validates: Requirements 7.4**

- [ ] 2. Filtrado de confianza en deployment-correlation.ts
  - [x] 2.1 Implementar constante y funciones de filtrado de correlaciones
    - Exportar `MIN_CORRELATION_CONFIDENCE` configurable via `DORA_MIN_CORRELATION_CONFIDENCE` con default 0.7
    - Implementar helper `parsePositiveEnvFloat(envKey)` para lectura de floats
    - Implementar `filterByConfidence(correlations, minConfidence?)` que retorna solo correlaciones ≥ umbral
    - Implementar `selectBestCorrelationPerPipeline(correlations)` que agrupa por pipeline_id y retorna la de mayor confianza por grupo
    - _Requirements: 3.1, 3.2, 3.5, 14.3, 14.4_

  - [ ]* 2.2 Write property test: Confidence Filtering (Property 2)
    - **Property 2: Exclusión de Correlaciones de Baja Confianza en CFR**
    - El resultado de `filterByConfidence` es subconjunto del original y todas las entradas tienen score ≥ umbral
    - File: `src/lib/__tests__/deployment-correlation.property.test.ts`
    - **Validates: Requirements 3.2**

  - [ ]* 2.3 Write property test: Low Confidence Warning (Property 3)
    - **Property 3: Advertencia de Confianza Baja**
    - Si >30% de correlaciones están bajo el umbral, `lowConfidenceWarning` es true; en caso contrario false
    - File: `src/lib/__tests__/deployment-correlation.property.test.ts`
    - **Validates: Requirements 3.4**

  - [ ]* 2.4 Write property test: Best Correlation Per Pipeline (Property 12)
    - **Property 12: Selección de Mejor Correlación por Pipeline**
    - Para cada grupo (pipeline_id, app_key), la correlación seleccionada tiene el mayor confidence del grupo
    - File: `src/lib/__tests__/deployment-correlation.property.test.ts`
    - **Validates: Requirements 14.4**

- [ ] 3. Configuración dinámica de namespaces en k8s-metrics.ts
  - [x] 3.1 Reemplazar constante INFRA_NAMESPACES por función configurable
    - Implementar `getInfraNamespaces()` que lee `K8S_INFRA_NAMESPACES` (comma-separated) con fallback al set hardcodeado
    - Trim de espacios, eliminación de valores vacíos, deduplicación
    - Log al inicio con la lista activa de namespaces
    - Reemplazar todas las referencias a la constante por llamadas a la función
    - _Requirements: 4.1, 4.2, 4.3, 4.4_

  - [ ]* 3.2 Write property test: Namespace Parsing (Property 4)
    - **Property 4: Parsing de Namespaces desde Variable de Entorno**
    - Para cualquier string con comas, espacios extra y valores vacíos, el resultado es un Set con valores trimmeados no-vacíos sin duplicados
    - File: `src/lib/__tests__/k8s-metrics.property.test.ts`
    - **Validates: Requirements 4.2**

- [ ] 4. Checkpoint — Verificar módulos backend core
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 5. Paginación segura y auto-mapeo en sonarqube.ts
  - [x] 5.1 Implementar paginación con límite máximo en getAllProjects
    - Exportar `MAX_SONAR_PAGES` configurable via `SONAR_MAX_PAGES` con default 50
    - Modificar `getAllProjects` para detener iteración al alcanzar el límite
    - Log warning cuando se alcanza el límite indicando proyectos potencialmente no recuperados
    - Log del total de proyectos obtenidos al completar
    - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5_

  - [x] 5.2 Implementar auto-mapeo SonarQube → GitLab
    - Definir tipo `MappingStrategy` y interface `MappingResult`
    - Implementar `autoMapSonarProject(sonarProject, gitlabProjects)` con estrategias: exact-name, normalized-path, gitlab-project-id
    - Generar sugerencias por similitud de nombre cuando no hay match exacto
    - Log de proyectos no mapeados con motivo del fallo
    - _Requirements: 5.1, 5.2, 5.3, 5.5_

  - [ ]* 5.3 Write property test: Pagination Limit (Property 11)
    - **Property 11: Paginación con Límite Máximo**
    - Para cualquier MAX_SONAR_PAGES > 0, la iteración se detiene después de exactamente ese número de páginas
    - File: `src/lib/__tests__/sonarqube.property.test.ts`
    - **Validates: Requirements 13.2**

  - [ ]* 5.4 Write property test: Mapping Coverage Percentage (Property 5)
    - **Property 5: Porcentaje de Mapeo SonarQube-GitLab**
    - Para N proyectos con M mapeados, el porcentaje es exactamente (M/N)*100
    - File: `src/lib/__tests__/sonarqube.property.test.ts`
    - **Validates: Requirements 5.4**

- [ ] 6. Caché selectiva y prefijos en cache.ts y platform-snapshot.ts
  - [x] 6.1 Documentar prefijos estándar en cache.ts
    - Exportar constante `CACHE_PREFIXES` con los prefijos: dora, sonar, k8s, correlation, executive
    - Añadir documentación JSDoc explicando el uso de cada prefijo
    - Verificar que `invalidateCache(prefix)` funciona correctamente para invalidación por prefijo
    - _Requirements: 12.1, 12.6_

  - [x] 6.2 Implementar invalidación selectiva en platform-snapshot.ts
    - Tras fase DORA: `invalidateCache("dora")`
    - Tras fase SonarQube: `invalidateCache("sonar")`
    - Tras fase K8s: `invalidateCache("k8s")`
    - Tras fase Correlation: `invalidateCache("dora")` + `invalidateCache("correlation")`
    - Eliminar la invalidación global actual al final del snapshot
    - _Requirements: 12.2, 12.3, 12.4, 12.5_

  - [ ]* 6.3 Write property test: Selective Cache Invalidation (Property 10)
    - **Property 10: Invalidación Selectiva de Caché por Prefijo**
    - Al invalidar un prefijo, se eliminan todas y solo las entradas con ese prefijo; las demás permanecen intactas
    - File: `src/lib/__tests__/cache.property.test.ts`
    - **Validates: Requirements 12.1, 12.2, 12.3, 12.4, 12.5**

- [ ] 7. Endpoint unificado y metrics-dashboard.ts
  - [x] 7.1 Implementar lógica de executive summary en metrics-dashboard.ts
    - Definir interface `ExecutiveSummaryResponse` con todos los campos (deploymentFrequency, leadTime con variant/coverage, changeFailureRate con confidence, pipelineRecoveryTime, totals, mrStats, audit, errors)
    - Implementar `calculateConfidenceScore(params)` con pesos: leadTimeCoverage 40%, avgCorrelationConfidence 40%, ausencia anomalías 20%
    - Implementar `getExecutiveSummary(filters)` que ejecuta consultas en paralelo y combina resultados
    - Usar `filterByConfidence` para excluir correlaciones de baja confianza del cálculo de CFR
    - Usar `selectLeadTimeWithVariant` para el cálculo canónico de lead time
    - Renombrar campo `mttr` a `pipelineRecoveryTime` en la respuesta
    - Incluir `AuditSummary` con droppedDeployments, anomalías, checks con estado
    - Manejar fallos parciales: retornar datos disponibles + array `errors`
    - _Requirements: 1.2, 1.3, 2.4, 3.2, 3.4, 6.4, 7.4, 8.1, 8.3, 8.4, 11.1, 11.5_

  - [x] 7.2 Crear route handler en src/app/api/metrics/executive-summary/route.ts
    - Implementar GET handler con autenticación via `requireAuth`
    - Aceptar query params: `days`, `teams`, `projectIds`
    - Cachear respuesta con prefijo `executive:`
    - Retornar `ExecutiveSummaryResponse` como JSON
    - _Requirements: 8.1, 8.2, 8.3, 8.5, 8.6_

  - [ ]* 7.3 Write property test: Partial Results (Property 8)
    - **Property 8: Resultados Parciales del Endpoint Unificado**
    - Para cualquier combinación de sub-consultas que fallan/tienen éxito, la respuesta contiene datos válidos para las exitosas y lista las fallidas en `errors`
    - File: `src/lib/__tests__/metrics-dashboard.property.test.ts`
    - **Validates: Requirements 8.4**

  - [ ]* 7.4 Write property test: API Field Renamed (Property 13)
    - **Property 13: Campo de API Renombrado**
    - Toda respuesta válida de `getExecutiveSummary` contiene `pipelineRecoveryTime` y no contiene `mttr` a nivel raíz
    - File: `src/lib/__tests__/metrics-dashboard.property.test.ts`
    - **Validates: Requirements 2.4**

  - [ ]* 7.5 Write property test: Dropped Deployments Count (Property 6)
    - **Property 6: Conteo de Despliegues Descartados**
    - El campo `droppedDeployments` es igual al número de despliegues cuyo lead time excede el umbral
    - File: `src/lib/__tests__/metrics-dashboard.property.test.ts`
    - **Validates: Requirements 6.4**

- [ ] 8. Checkpoint — Verificar backend completo
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 9. Migración SQL
  - [x] 9.1 Crear archivo de migración migrations/2026-05-04_dora_production_readiness.sql
    - Deprecar columnas SonarQube en dora_metrics_daily (SET DEFAULT NULL + COMMENT)
    - Crear índice `idx_deployment_traces_deploy_type` en `deployment_traces(deploy_type)`
    - Crear índice compuesto `idx_deployment_traces_composite` en `deployment_traces(snapshot_date, project_id, deploy_type)`
    - Crear índice `idx_dora_metrics_daily_date_project` en `dora_metrics_daily(snapshot_date, project_id)`
    - Crear índice `idx_sonarqube_metrics_daily_date_key` en `sonarqube_metrics_daily(snapshot_date, sonar_project_key)`
    - Eliminar constraint UNIQUE actual de deployment_correlation y crear nueva con argocd_sync_timestamp
    - Usar `IF NOT EXISTS` / `IF EXISTS` para idempotencia
    - _Requirements: 9.1, 9.4, 10.1, 10.2, 10.3, 10.4, 10.5, 14.1, 14.2_

- [ ] 10. Cambios en frontend — Executive Dashboard
  - [x] 10.1 Refactorizar executive-dashboard.tsx para usar endpoint unificado
    - Reemplazar múltiples llamadas fetch por una sola a `/api/metrics/executive-summary`
    - Adaptar el state management al nuevo shape de respuesta `ExecutiveSummaryData`
    - _Requirements: 8.5_

  - [x] 10.2 Añadir indicadores de confianza y auditoría en executive-dashboard.tsx
    - Mostrar badge de confidence score con niveles: alta (≥80), media (50-79), baja (<50)
    - Mostrar banner de advertencia cuando confidence < 50
    - Mostrar indicador visual de confianza junto a CFR (alta/media/baja)
    - Mostrar advertencia cuando >30% correlaciones son de baja confianza
    - Añadir panel colapsable de auditoría con: versión de metodología, fuente de datos, cobertura, anomalías, despliegues descartados
    - _Requirements: 3.3, 3.4, 6.5, 11.2, 11.3, 11.4_

  - [x] 10.3 Añadir etiqueta de variante de Lead Time y renombrar MTTR
    - Mostrar etiqueta indicando variante utilizada junto al valor de lead time (ej. "desde primer commit")
    - Añadir tooltip con definición canónica y porcentaje de cobertura por variante
    - Renombrar "MTTR" → "Pipeline Recovery Time" en todos los labels
    - Añadir tooltip explicando que mide tiempo entre pipeline fallido y siguiente exitoso
    - _Requirements: 1.4, 1.5, 2.1, 2.2, 2.3_

- [ ] 11. Cambios en frontend — DORA Benchmarks y SonarQube Panel
  - [x] 11.1 Actualizar dora-benchmarks.tsx
    - Cambiar label "MTTR" → "Pipeline Recovery Time"
    - Usar variante canónica para clasificar nivel de rendimiento de Lead Time
    - Añadir subtítulo/tooltip en "Lead Time": "desde primer commit hasta deploy en producción"
    - Añadir nota al pie sobre benchmarks DORA de referencia (Accelerate/DORA Report)
    - Mostrar desglose en hover: valor canónico, cobertura, variantes alternativas
    - _Requirements: 1.6, 2.1, 15.1, 15.2, 15.3_

  - [x] 11.2 Actualizar enhanced-sonarqube-panel.tsx
    - Añadir sección "Proyectos sin mapear" listando proyectos sin correspondencia GitLab
    - Mostrar sugerencias de posibles coincidencias basadas en similitud de nombre
    - Mostrar porcentaje de cobertura de mapeo (proyectos mapeados vs total)
    - _Requirements: 5.2, 5.3, 5.4_

- [ ] 12. Actualizaciones de i18n
  - [x] 12.1 Actualizar archivos de traducción con nuevas etiquetas
    - Añadir claves para: "Pipeline Recovery Time", "Confidence Score", "Audit Summary", variantes de lead time, niveles de confianza, advertencias, "Proyectos sin mapear", "Cobertura de mapeo"
    - Actualizar en los 4 idiomas: `src/i18n/en.json`, `src/i18n/es.json`, `src/i18n/pt.json`, `src/i18n/fr.json`
    - Verificar paridad de claves entre los 4 archivos
    - _Requirements: 2.1, 2.2, 15.1_

- [ ] 13. Checkpoint final — Verificación completa
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation between logical blocks
- Property tests use `fast-check` with `node:test` runner (existing pattern in `src/lib/__tests__/`)
- All 13 correctness properties from the design document are covered as sub-tasks
- The SQL migration is idempotent (IF NOT EXISTS / IF EXISTS guards)
- Frontend changes depend on backend being complete (tasks 1-8 before 10-11)
