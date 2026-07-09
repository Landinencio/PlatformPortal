# K8s Workload Mapping

Este documento describe cómo mapear workloads de Kubernetes a proyectos GitLab para habilitar filtros de runtime por `team` y `projectId`.

## Objetivo

Los snapshots de Kubernetes (`k8s_rollouts_daily`, `k8s_failures_daily`) se capturan por `namespace/deployment`.  
Para usar filtros DORA por proyecto/equipo, se necesita un mapping explícito:

`cluster + namespace + deployment -> project_id + team`

## Esquema

Migración: `migrations/2026-03-05_k8s_workload_mapping.sql`

- Tabla `k8s_workload_mapping`
- Enriquecimiento en snapshots:
  - `k8s_rollouts_daily.project_id`, `team`, `mapping_source`, `mapping_confidence`
  - `k8s_failures_daily.project_id`, `team`, `mapping_source`, `mapping_confidence`

## API

### Listar mappings

`GET /api/metrics/k8s-mapping?cluster=dp-prod&team=websites`

### Upsert mappings

`POST /api/metrics/k8s-mapping`

Body:

```json
{
  "mappings": [
    {
      "cluster": "dp-prod",
      "namespace": "websites",
      "deployment": "checkout-service",
      "projectId": 12345,
      "team": "websites",
      "projectName": "checkout-service",
      "source": "manual",
      "confidence": 1,
      "notes": "mapping validado por plataforma"
    }
  ]
}
```

Si existe `K8S_MAPPING_TOKEN`, el endpoint exige `Authorization: Bearer <token>`.

## Snapshot K8s

`POST /api/metrics/k8s-snapshot` ahora:

- aplica mapping al persistir cada workload,
- devuelve cobertura de mapping por día (`rolloutCoveragePct`, `failureCoveragePct`).

## Impacto En Correlación DORA

La correlación `GitLab -> runtime` (`deployment_correlation`) usa este mapping como boost de matching:

- método `workload-mapping` cuando `namespace + app/service` coincide con un workload mapeado al `project_id`,
- mejora cobertura cuando no hay `repo` útil o el nombre de app no coincide exactamente con el proyecto.

Recomendación operativa:

- mantener cobertura de mapping > 80% en workloads activos de producción,
- lanzar backfill (`ops/k8s/backfill-job.yaml`) tras ampliar mappings para recalcular snapshots y correlaciones históricas.
