# Documento de Requisitos

## Introducción

Este documento define los requisitos de hardening y mejora para la sección de métricas DORA, integración SonarQube y dashboards de gestión del Portal de Plataforma. El sistema actualmente recopila datos de GitLab API, Prometheus/Grafana (K8s) y SonarQube, los almacena en PostgreSQL, los transforma mediante módulos de cálculo y los presenta en componentes React. La auditoría profunda identificó 15 problemas críticos que afectan la precisión de las métricas, la confianza en los datos, el rendimiento y la mantenibilidad. Estos requisitos abordan cada problema para llevar el sistema a un estado production-ready.

## Glosario

- **Portal**: La aplicación Next.js del Portal de Plataforma
- **DORA_Snapshot**: El módulo en `src/lib/dora-snapshot.ts` que recopila datos de despliegues y calcula métricas DORA diarias desde GitLab
- **Metrics_Formulas**: El módulo en `src/lib/metrics-formulas.ts` que contiene las fórmulas de cálculo de métricas (lead time, CFR, anomalías)
- **Metrics_Dashboard**: El módulo en `src/lib/metrics-dashboard.ts` que sirve datos agregados al frontend
- **Executive_Dashboard**: El componente React en `src/components/metrics/executive-dashboard.tsx` que muestra el resumen ejecutivo de métricas DORA
- **DORA_Benchmarks**: El componente en `src/components/metrics/shared/dora-benchmarks.tsx` que muestra la tabla de benchmarks DORA
- **Deployment_Correlation**: El módulo en `src/lib/deployment-correlation.ts` que correlaciona pipelines de GitLab con syncs de ArgoCD
- **K8s_Metrics**: El módulo en `src/lib/k8s-metrics.ts` que recopila métricas de Kubernetes desde Prometheus/Grafana
- **SonarQube_Client**: El módulo en `src/lib/sonarqube.ts` que interactúa con la API de SonarQube
- **SonarQube_Panel**: El componente en `src/components/sonarqube/enhanced-sonarqube-panel.tsx` que muestra métricas de calidad de código
- **Cache_Module**: El módulo en `src/lib/cache.ts` que implementa caché en memoria con TTL
- **Platform_Snapshot**: El módulo en `src/lib/platform-snapshot.ts` que orquesta la generación unificada de snapshots
- **Lead_Time**: Tiempo transcurrido desde un evento de desarrollo (commit, creación de MR) hasta el despliegue en producción
- **Pipeline_Recovery_Time**: Tiempo entre un pipeline fallido y el siguiente pipeline exitoso en el mismo ámbito (actualmente etiquetado como MTTR)
- **MTTR_Real**: Mean Time To Restore basado en incidentes reales de producción según el modelo definido en `docs/reliability-data-contract.md`
- **Correlation_Confidence**: Puntuación 0.0-1.0 que indica la fiabilidad de la correlación entre un pipeline de GitLab y un sync de ArgoCD
- **INFRA_NAMESPACES**: Conjunto hardcodeado en `src/lib/k8s-metrics.ts` que define namespaces de infraestructura a excluir de métricas de aplicación
- **Anomaly_Threshold**: Umbral (actualmente 50) en Metrics_Formulas por encima del cual la frecuencia de despliegue se marca como anómala
- **Lead_Time_Guard**: Umbral máximo (actualmente 90 días) por encima del cual un lead time se descarta silenciosamente
- **Audit_Summary**: Estructura de datos que resume la calidad y confianza de las métricas mostradas

## Requisitos

### Requisito 1: Definición Canónica de Lead Time

**Historia de Usuario:** Como engineering manager, quiero que el lead time DORA tenga una definición canónica única y consistente en todo el portal, para poder confiar en que la métrica reportada es comparable entre equipos y períodos.

#### Criterios de Aceptación

1. THE Metrics_Formulas SHALL definir una constante documentada `CANONICAL_LEAD_TIME_VARIANT` con valor `first_commit` que represente la variante oficial para reporting DORA
2. WHEN el Metrics_Dashboard calcula el lead time agregado para el Executive_Dashboard, THE Metrics_Dashboard SHALL usar exclusivamente la variante canónica definida en `CANONICAL_LEAD_TIME_VARIANT`
3. WHEN la variante canónica no está disponible para un despliegue (no hay MR o no hay commits previos), THE Metrics_Dashboard SHALL aplicar el orden de fallback: `first_commit` → `mr_created` → `last_commit`
4. THE Executive_Dashboard SHALL mostrar junto al valor de lead time una etiqueta indicando la variante utilizada (por ejemplo "desde primer commit")
5. WHEN el Executive_Dashboard muestra lead time, THE Executive_Dashboard SHALL incluir un tooltip explicando la definición canónica y el porcentaje de despliegues que usaron cada variante en el período
6. THE DORA_Benchmarks SHALL usar la variante canónica para clasificar el nivel de rendimiento del equipo

### Requisito 2: Renombrado de MTTR a Pipeline Recovery Time

**Historia de Usuario:** Como engineering manager, quiero que la métrica actualmente etiquetada como "MTTR" se renombre a "Pipeline Recovery Time" con una explicación clara, para no confundirla con el MTTR real basado en incidentes de producción.

#### Criterios de Aceptación

1. THE DORA_Benchmarks SHALL mostrar la métrica de recuperación de pipelines con la etiqueta "Pipeline Recovery Time" en lugar de "MTTR"
2. THE Executive_Dashboard SHALL mostrar la métrica de recuperación de pipelines con la etiqueta "Pipeline Recovery Time"
3. WHEN el Executive_Dashboard muestra Pipeline Recovery Time, THE Executive_Dashboard SHALL incluir un tooltip explicando que mide el tiempo entre un pipeline fallido y el siguiente exitoso, y que no representa incidentes reales de producción
4. THE Metrics_Dashboard SHALL exponer la métrica con el campo `pipelineRecoveryTime` en lugar de `mttr` en las respuestas de API
5. WHEN el sistema integre datos de incidentes reales según el modelo de `reliability-data-contract.md`, THE Metrics_Dashboard SHALL exponer una métrica separada `mttr` basada en incidentes reales

### Requisito 3: Umbral Mínimo de Confianza en Correlaciones

**Historia de Usuario:** Como engineering manager, quiero que las correlaciones de baja confianza entre GitLab y ArgoCD no se incluyan en el cálculo de Change Failure Rate, para evitar falsos positivos que distorsionen la métrica.

#### Criterios de Aceptación

1. THE Deployment_Correlation SHALL definir una constante configurable `MIN_CORRELATION_CONFIDENCE` con valor por defecto 0.7
2. WHEN el Metrics_Dashboard calcula Change Failure Rate usando datos de correlación, THE Metrics_Dashboard SHALL excluir correlaciones con confianza inferior a `MIN_CORRELATION_CONFIDENCE`
3. THE Executive_Dashboard SHALL mostrar un indicador visual de confianza junto al valor de CFR (por ejemplo: "alta", "media", "baja") basado en la confianza promedio de las correlaciones usadas
4. WHEN más del 30% de las correlaciones del período tienen confianza inferior a `MIN_CORRELATION_CONFIDENCE`, THE Executive_Dashboard SHALL mostrar una advertencia indicando que el CFR puede ser impreciso
5. THE Deployment_Correlation SHALL permitir configurar `MIN_CORRELATION_CONFIDENCE` mediante la variable de entorno `DORA_MIN_CORRELATION_CONFIDENCE`

### Requisito 4: Configuración Dinámica de Namespaces de Infraestructura

**Historia de Usuario:** Como SRE, quiero poder configurar los namespaces de infraestructura excluidos de métricas K8s sin modificar código, para que nuevos namespaces de infraestructura se excluyan inmediatamente.

#### Criterios de Aceptación

1. THE K8s_Metrics SHALL leer la lista de namespaces de infraestructura desde la variable de entorno `K8S_INFRA_NAMESPACES`
2. WHEN la variable de entorno `K8S_INFRA_NAMESPACES` está definida, THE K8s_Metrics SHALL parsear su valor como lista separada por comas y usarla como conjunto de exclusión
3. IF la variable de entorno `K8S_INFRA_NAMESPACES` no está definida, THEN THE K8s_Metrics SHALL usar el conjunto hardcodeado actual como fallback
4. THE K8s_Metrics SHALL registrar en log al inicio la lista de namespaces de infraestructura activa (ya sea de variable de entorno o fallback)

### Requisito 5: Mejora del Auto-Mapeo SonarQube-GitLab

**Historia de Usuario:** Como engineering manager, quiero que el portal muestre claramente qué proyectos SonarQube no están mapeados a GitLab y ofrezca mejor auto-descubrimiento, para poder completar los mapeos faltantes.

#### Criterios de Aceptación

1. WHEN el SonarQube_Client obtiene la lista de proyectos, THE SonarQube_Client SHALL intentar auto-mapear cada proyecto a GitLab usando las estrategias: coincidencia exacta de nombre, coincidencia por path normalizado, y coincidencia por `gitlab_project_id` en las propiedades del proyecto SonarQube
2. THE SonarQube_Panel SHALL mostrar una sección separada "Proyectos sin mapear" listando los proyectos SonarQube que no tienen correspondencia con ningún proyecto GitLab
3. WHEN un proyecto SonarQube no está mapeado, THE SonarQube_Panel SHALL mostrar sugerencias de posibles coincidencias en GitLab basadas en similitud de nombre
4. THE SonarQube_Panel SHALL mostrar el porcentaje de proyectos mapeados vs total como indicador de cobertura del mapeo
5. THE SonarQube_Client SHALL registrar en log los proyectos que no pudieron auto-mapearse con el motivo del fallo

### Requisito 6: Registro y Configurabilidad del Lead Time Guard

**Historia de Usuario:** Como engineering manager, quiero saber cuándo se descartan despliegues por exceder el umbral de lead time y poder ajustar ese umbral, para no perder datos legítimos silenciosamente.

#### Criterios de Aceptación

1. WHEN el DORA_Snapshot descarta un despliegue porque su lead time excede el Lead_Time_Guard, THE DORA_Snapshot SHALL registrar en log un mensaje con nivel warning incluyendo: project_id, deploy_id, lead_time_hours calculado y el umbral vigente
2. THE DORA_Snapshot SHALL permitir configurar el umbral máximo de lead time mediante la variable de entorno `DORA_MAX_LEAD_TIME_HOURS`
3. IF la variable de entorno `DORA_MAX_LEAD_TIME_HOURS` está definida y es un número válido, THEN THE DORA_Snapshot SHALL usar ese valor como umbral en lugar del hardcodeado
4. THE Metrics_Dashboard SHALL incluir en el Audit_Summary un campo `droppedDeployments` con el conteo de despliegues descartados por exceder el umbral en el período consultado
5. THE Executive_Dashboard SHALL mostrar en la sección de auditoría el número de despliegues descartados cuando sea mayor que cero

### Requisito 7: Documentación y Configurabilidad del Umbral de Anomalías

**Historia de Usuario:** Como engineering manager, quiero entender por qué el umbral de anomalía de deployment frequency es 50 y poder ajustarlo por equipo, para que la detección de anomalías sea relevante para cada contexto.

#### Criterios de Aceptación

1. THE Metrics_Formulas SHALL incluir un comentario de documentación junto a `DF_ANOMALY_THRESHOLD` explicando la justificación del valor (basado en percentil 99 de frecuencias históricas observadas)
2. THE Metrics_Formulas SHALL permitir configurar el umbral de anomalía mediante la variable de entorno `DORA_DF_ANOMALY_THRESHOLD`
3. IF la variable de entorno `DORA_DF_ANOMALY_THRESHOLD` está definida y es un número válido mayor que cero, THEN THE Metrics_Formulas SHALL usar ese valor como umbral
4. WHEN el Metrics_Dashboard detecta una frecuencia de despliegue anómala, THE Metrics_Dashboard SHALL incluir el evento en el Audit_Summary con el valor observado y el umbral aplicado

### Requisito 8: Endpoint Unificado de Métricas para Dashboard

**Historia de Usuario:** Como desarrollador frontend, quiero un endpoint único que devuelva todas las métricas del executive dashboard en una sola llamada, para reducir la latencia de carga y simplificar el manejo de errores.

#### Criterios de Aceptación

1. THE Portal SHALL exponer un endpoint GET en `/api/metrics/executive-summary` que devuelva en una sola respuesta: deployment frequency, lead time, change failure rate, pipeline recovery time, totales de despliegues, y estadísticas de MR
2. THE endpoint `/api/metrics/executive-summary` SHALL aceptar los mismos parámetros de filtro que los endpoints individuales: `days`, `teams`, `projectIds`
3. WHEN el endpoint recibe una petición, THE endpoint SHALL ejecutar las consultas en paralelo internamente y combinar los resultados
4. IF alguna consulta individual falla, THEN THE endpoint SHALL devolver resultados parciales con un campo `errors` indicando qué secciones fallaron
5. THE Executive_Dashboard SHALL usar el endpoint unificado en lugar de las 5 llamadas individuales actuales
6. THE endpoint `/api/metrics/executive-summary` SHALL utilizar el Cache_Module para cachear la respuesta completa

### Requisito 9: Eliminación de Columnas Deprecadas de SonarQube

**Historia de Usuario:** Como desarrollador de plataforma, quiero que las columnas deprecadas de SonarQube en `dora_metrics_daily` dejen de popularse, para eliminar confusión sobre la fuente de verdad de métricas de calidad.

#### Criterios de Aceptación

1. THE DORA_Snapshot SHALL no escribir valores en las columnas `coverage`, `bugs`, `vulnerabilities`, `code_smells` y `tech_debt_minutes` de la tabla `dora_metrics_daily`
2. THE Metrics_Dashboard SHALL no leer métricas de SonarQube desde la tabla `dora_metrics_daily`, usando exclusivamente `sonarqube_metrics_daily`
3. WHEN el Metrics_Dashboard consulta métricas de SonarQube, THE Metrics_Dashboard SHALL usar la tabla `sonarqube_metrics_daily` unida con `project_sonar_mapping` para resolver la relación con proyectos GitLab
4. THE Portal SHALL incluir una migración SQL que establezca las columnas deprecadas como DEFAULT NULL y añada un comentario indicando que ya no se populan

### Requisito 10: Índices de Rendimiento para Consultas de Dashboard

**Historia de Usuario:** Como desarrollador de plataforma, quiero que las consultas frecuentes del dashboard tengan índices apropiados, para que los tiempos de respuesta sean consistentes a medida que crece el volumen de datos.

#### Criterios de Aceptación

1. THE Portal SHALL crear un índice en `deployment_traces(deploy_type)` para filtrado por tipo de despliegue
2. THE Portal SHALL crear un índice compuesto en `deployment_traces(snapshot_date, project_id, deploy_type)` para las consultas de dashboard que filtran por fecha, proyecto y tipo
3. THE Portal SHALL crear un índice en `dora_metrics_daily(snapshot_date, project_id)` si no existe, para las consultas de agregación temporal
4. THE Portal SHALL crear un índice en `sonarqube_metrics_daily(snapshot_date, sonar_project_key)` para consultas de tendencia de calidad
5. THE Portal SHALL incluir estos índices en un archivo de migración SQL ejecutable

### Requisito 11: Indicador de Confianza y Auditoría en Dashboard

**Historia de Usuario:** Como engineering manager, quiero ver un indicador de confianza de los datos y un resumen de auditoría en el dashboard, para saber si las métricas mostradas son fiables antes de tomar decisiones.

#### Criterios de Aceptación

1. THE Metrics_Dashboard SHALL calcular un `confidenceScore` (0-100) basado en: porcentaje de despliegues con lead time disponible, porcentaje de correlaciones de alta confianza, y ausencia de anomalías detectadas
2. THE Executive_Dashboard SHALL mostrar el confidence score como badge visual con niveles: alta (≥80), media (50-79), baja (<50)
3. THE Executive_Dashboard SHALL mostrar un panel colapsable de auditoría con: versión de metodología, fuente de datos, cobertura de proyectos, anomalías detectadas y despliegues descartados
4. WHEN el confidence score es "baja", THE Executive_Dashboard SHALL mostrar un banner de advertencia indicando que los datos pueden no ser representativos
5. THE Audit_Summary SHALL incluir la lista de checks realizados con su estado (pass, warn, fail) para transparencia total

### Requisito 12: Invalidación Selectiva de Caché

**Historia de Usuario:** Como desarrollador de plataforma, quiero que la invalidación de caché tras un snapshot sea selectiva por tipo de métrica, para que una actualización de SonarQube no invalide datos DORA que no cambiaron.

#### Criterios de Aceptación

1. THE Cache_Module SHALL soportar invalidación por prefijo, permitiendo invalidar solo las entradas que comienzan con un prefijo específico (por ejemplo `dora:`, `sonar:`, `k8s:`)
2. WHEN el Platform_Snapshot completa el paso de DORA, THE Platform_Snapshot SHALL invalidar solo las entradas de caché con prefijo `dora:`
3. WHEN el Platform_Snapshot completa el paso de SonarQube, THE Platform_Snapshot SHALL invalidar solo las entradas de caché con prefijo `sonar:`
4. WHEN el Platform_Snapshot completa el paso de K8s, THE Platform_Snapshot SHALL invalidar solo las entradas de caché con prefijo `k8s:`
5. WHEN el Platform_Snapshot completa el paso de correlación, THE Platform_Snapshot SHALL invalidar las entradas con prefijos `dora:` y `correlation:`
6. THE Metrics_Dashboard SHALL usar prefijos consistentes al crear claves de caché: `dora:` para métricas DORA, `sonar:` para SonarQube, `k8s:` para Kubernetes, `correlation:` para correlaciones

### Requisito 13: Paginación Segura en SonarQube

**Historia de Usuario:** Como desarrollador de plataforma, quiero que la obtención de proyectos SonarQube tenga un límite máximo de páginas, para evitar timeouts o loops infinitos con instancias SonarQube grandes.

#### Criterios de Aceptación

1. THE SonarQube_Client SHALL definir una constante configurable `MAX_SONAR_PAGES` con valor por defecto 50 (5000 proyectos máximo con pageSize=100)
2. WHEN el SonarQube_Client itera páginas en `getAllProjects`, THE SonarQube_Client SHALL detener la iteración al alcanzar `MAX_SONAR_PAGES`
3. IF la iteración se detiene por alcanzar el límite de páginas, THEN THE SonarQube_Client SHALL registrar un warning en log indicando que se alcanzó el límite y que pueden existir proyectos no recuperados
4. THE SonarQube_Client SHALL permitir configurar el límite máximo de páginas mediante la variable de entorno `SONAR_MAX_PAGES`
5. WHEN el SonarQube_Client completa la obtención de proyectos, THE SonarQube_Client SHALL registrar en log el total de proyectos obtenidos y si se alcanzó el límite

### Requisito 14: Flexibilización de Unicidad en Tabla de Correlación

**Historia de Usuario:** Como desarrollador de plataforma, quiero que la tabla de correlación permita múltiples syncs de ArgoCD por pipeline, para reflejar correctamente escenarios donde un pipeline dispara múltiples despliegues.

#### Criterios de Aceptación

1. THE Portal SHALL incluir una migración SQL que elimine la constraint UNIQUE actual `(correlation_date, gitlab_project_id, gitlab_pipeline_id, argocd_app_key)` de la tabla `deployment_correlation`
2. THE Portal SHALL crear una nueva constraint UNIQUE más granular: `(correlation_date, gitlab_project_id, gitlab_pipeline_id, argocd_app_key, argocd_sync_timestamp)` que permita múltiples syncs del mismo app en diferentes momentos
3. THE Deployment_Correlation SHALL manejar correctamente múltiples correlaciones por pipeline al insertar, usando la nueva constraint para evitar duplicados exactos
4. WHEN el Metrics_Dashboard calcula métricas usando correlaciones, THE Metrics_Dashboard SHALL agrupar por pipeline_id y usar la correlación de mayor confianza cuando existan múltiples para el mismo pipeline y app

### Requisito 15: Indicador de Variante de Lead Time en Benchmarks

**Historia de Usuario:** Como engineering manager, quiero que la tabla de benchmarks DORA indique claramente que el "Lead Time" mostrado se refiere a la variante canónica y no a pipeline duration, para evitar malinterpretaciones.

#### Criterios de Aceptación

1. THE DORA_Benchmarks SHALL mostrar junto a la etiqueta "Lead Time" un subtítulo o tooltip indicando "desde primer commit hasta deploy en producción"
2. THE DORA_Benchmarks SHALL incluir una nota al pie explicando que los benchmarks DORA de referencia (Accelerate/DORA Report) miden desde commit hasta producción
3. WHEN el usuario pasa el cursor sobre la celda de Lead Time actual, THE DORA_Benchmarks SHALL mostrar el desglose: valor canónico, porcentaje de cobertura, y variantes alternativas disponibles

