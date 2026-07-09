# Grafana ArgoCD Runtime Contract

Este bloque describe cómo se leen las métricas de ArgoCD desde Grafana Cloud para complementar DORA.

## Objetivo

No sustituimos GitLab.

La separación queda así:

- GitLab: trazabilidad del cambio, commits, MRs, lead time.
- Grafana Cloud Metrics: runtime delivery real observado por ArgoCD.

## Fuente

Se consulta el endpoint Prometheus/Mimir de Grafana Cloud mediante `Basic Auth`.

Variables necesarias:

```env
GRAFANA_METRICS_URL=https://prometheus-prod-24-prod-eu-west-2.grafana.net/api/prom
GRAFANA_METRICS_USERNAME=1290143
GRAFANA_METRICS_TOKEN=<secret>
```

## Métricas Utilizadas

Core:

- `argocd_app_info`
- `argocd_app_sync_total`

Opcional para enriquecer el contexto:

- `argocd_app_labels`

## Labels Reales Observadas En Este Entorno

En `argocd_app_info` ya vemos labels útiles sin tocar cluster:

- `name`
- `dest_namespace`
- `project`
- `repo`
- `cluster`
- `k8s_cluster_name`
- `operation`
- `sync_status`
- `health_status`

Hay otras labels de scrape (`namespace`, `service`, `job`, `instance`) que no deben usarse como identidad funcional de la app.

## Qué Significa Cada Cosa

- `argocd_app_info`: estado actual de cada app.
- `argocd_app_sync_total`: contador de syncs observados por ArgoCD.
- `argocd_app_labels`: contexto adicional como `team`, `service`, `environment` si está habilitado.

## Qué Leemos En El Portal

La API runtime construye:

- apps activas
- healthy apps
- degraded apps
- out-of-sync apps
- syncs totales
- syncs exitosos
- syncs fallidos
- syncs sin clasificar
- tendencia diaria

## Qué Cuenta Como Deploy Runtime

En esta fase, el portal usa `syncs de ArgoCD` como proxy de despliegue runtime.

Eso implica:

- cuenta actividad real de entrega observada por Argo
- no implica todavía correlación perfecta `sync -> commit -> incidente`
- no reemplaza el `lead time` de GitLab

## Limitaciones Conocidas

Si `argocd_app_labels` no está disponible:

- no se puede filtrar bien por `production`
- no se puede filtrar bien por `team`
- no se puede filtrar bien por `service`

En ese caso, el portal lo mostrará como advertencia y hará fallback a una lectura más amplia.

## Variables Opcionales

```env
GRAFANA_ARGO_PRODUCTION_ONLY=true
GRAFANA_ARGO_PRODUCTION_VALUES=production,prod
GRAFANA_ARGO_DEST_NAMESPACE_LABEL=dest_namespace
GRAFANA_ARGO_REPO_LABEL=repo
GRAFANA_ARGO_CLUSTER_LABEL=k8s_cluster_name
GRAFANA_ARGO_CLUSTER_FALLBACK_LABEL=cluster
GRAFANA_ARGO_PRODUCTION_CLUSTER_REGEX=prod
GRAFANA_ARGO_ENVIRONMENT_LABEL=label_environment
GRAFANA_ARGO_TEAM_LABEL=label_team
GRAFANA_ARGO_SERVICE_LABEL=label_service
GRAFANA_ARGO_APP_INCLUDE_REGEX=
GRAFANA_ARGO_PROJECT_INCLUDE_REGEX=
GRAFANA_ARGO_NAMESPACE_INCLUDE_REGEX=
GRAFANA_ARGO_SUCCESS_PHASES=Succeeded
GRAFANA_ARGO_FAILURE_PHASES=Failed,Error
```

## Regla Recomendada

Con las labels actuales, la lógica recomendada es esta:

- identidad de app: `project + name`
- team inicial: `dest_namespace`
- namespace funcional: `dest_namespace`
- cluster real: `k8s_cluster_name`, con fallback a `cluster`
- producción: inferida por cluster que contenga `prod`
- servicio operativo: derivado del `name` sin prefijo de team y sin sufijo `-helm`
- repositorio fuente: `repo`
- proyecto GitLab: primero por `project_id` extraído de `repo`, y si no, fallback por nombre derivado de app

Mejor aún si además activáis `argocd_app_labels` con:

- `label_environment`
- `label_team`
- `label_service`

Ejemplo:

- `label_environment=production`
- `label_team=platform`
- `label_service=checkout-api`

## Endpoints Nuevos

- `GET /api/metrics/argocd`
- `GET /api/metrics/dora-core`

El bloque runtime también se inyecta dentro de `dora-core`.

## Capa Híbrida CFR/MTTR En DORA Core

`dora-core` mantiene GitLab como base para DORA y aplica ajuste híbrido en `change failure rate` y `MTTR` cuando existe señal runtime suficiente en `deployment_correlation`.

Reglas actuales:

- se exige confianza mínima por correlación (`correlation_confidence`)
- se exige cobertura mínima de despliegues correlacionados frente al total GitLab del periodo
- si no se alcanza cobertura/calidad, el cálculo vuelve a modo GitLab (fallback explícito)

Métodos de correlación actuales:

- `repo-match` (preferido)
- `workload-mapping` (usa `k8s_workload_mapping`)
- `name-match`
- `timestamp-proximity` (último recurso)

Variables opcionales:

```env
DORA_CORRELATION_MIN_CONFIDENCE=0.7
DORA_CORRELATION_MIN_COVERAGE=0.35
DORA_CORRELATION_MIN_DEPLOYS=8
```

## Qué No Hace Todavía

Este bloque no:

- consulta el cluster directamente
- abre incidentes
- calcula CFR real por incidente
- reemplaza el snapshot DORA histórico

Eso vendrá después, cuando conectemos incidentes reales y correlación de despliegues.
