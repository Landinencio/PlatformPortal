# Reliability Data Contract

Este documento define cómo deben llegar al portal los datos de incidentes reales y de despliegues reales para que DORA refleje producción de verdad.

## Principio Base

No vamos a sustituir GitLab como fuente de cambio. El modelo queda así:

- GitLab: `commit`, `MR`, `review`, `branch`, `labels`, `lead time` de ingeniería.
- Runtime real: `deploy_completed_at` real en producción.
- Observabilidad/incidentes: `change failure rate` y `MTTR` reales.

## Qué Cuenta Como Incidente

Debe existir impacto real o degradación relevante en producción. Un incidente válido debe representar al menos uno de estos casos:

- Error funcional visible por usuario.
- Degradación significativa de latencia o throughput.
- Aumento sostenido de `5xx`, timeouts o saturación que rompe el SLO acordado.
- Caída parcial o total del servicio.
- Problema de seguridad o dependencia crítica con impacto en producción.

No debe contarse como incidente DORA por sí solo:

- Un job de pipeline fallido antes de llegar a producción.
- Un error de Docker o build si el cambio nunca impactó en runtime.
- Un warning aislado sin impacto operativo.

## Modelo de Datos

Las tablas nuevas del portal son:

- `services`
- `service_runtime_targets`
- `production_deployments`
- `deployment_changes`
- `production_incidents`
- `incident_events`
- `deployment_incident_links`

## Campos Mínimos Para Incidentes

Cada incidente debe traer como mínimo:

- `source`: origen, por ejemplo `pagerduty`, `grafana`, `sentry`, `manual`.
- `sourceIncidentId`: id estable del incidente en el origen.
- `serviceKey` o `serviceName`: identificador del servicio.
- `environment`: normalmente `production`.
- `severity`: `critical | high | medium | low | info`.
- `status`: `open | acknowledged | investigating | mitigating | resolved | closed`.
- `classification`: `app | infra | dependency | security | unknown`.
- `title`
- `openedAt`

Campos muy recomendables:

- `resolvedAt`
- `summary`
- `sourceUrl`
- `team`
- `gitlabProjectId`
- `namespace`
- `workloadKind`
- `workloadName`
- `events[]`

## Campos Mínimos Para Deploys Reales

Para que `Deployment Frequency` y la correlación de CFR sean fiables, el evento de deploy real debería incluir:

- `source`: `gitlab`, `argocd`, `k8s`, `helm`, etc.
- `externalId`: id estable del deploy o rollout.
- `serviceKey`
- `environment`
- `status`
- `deployCompletedAt`

Muy recomendables:

- `commitSha`
- `imageTag`
- `imageDigest`
- `deployStartedAt`
- `projectId`

## Reglas Operativas

### Servicios

Cada equipo debe usar un identificador estable de servicio.

Recomendación:

- `serviceKey`: corto, estable y sin espacios. Ejemplo: `checkout-api`.
- `serviceName`: legible. Ejemplo: `Checkout API`.

No cambiéis el `serviceKey` por entorno o por marca.

### Entornos

Usad nombres consistentes:

- `production`
- `staging`
- `uat`
- `dev`

Para DORA real, el portal solo debería considerar `production`.

### Clasificación de Incidentes

Usad esta taxonomía:

- `app`: bug funcional, regresión, mal comportamiento del cambio.
- `infra`: nodo, red, balanceador, DNS, storage, cluster.
- `dependency`: caída o degradación de tercero o sistema externo.
- `security`: incidente de seguridad.
- `unknown`: mientras no se haya clasificado.

### Severidad

Usad una escala pequeña y estable:

- `critical`
- `high`
- `medium`
- `low`
- `info`

## Cómo Impactará En DORA

- `Deployment Frequency`: contará `production_deployments` exitosos.
- `Lead Time for Changes`: seguirá naciendo en GitLab, pero cerrará con `deploy_completed_at` real.
- `Change Failure Rate`: un deploy contará como fallido si tiene incidente(s) reales vinculados dentro de la ventana acordada.
- `MTTR`: se medirá con `resolved_at - opened_at`.

## Estrategia de Correlación Inicial

El portal enlazará incidentes y despliegues con reglas simples y auditables:

- mismo `service`
- mismo `environment`
- incidente abierto dentro de una ventana tras deploy
- si coincide `imageTag`, `imageDigest`, `namespace` o `workload`, sube la confianza

Después podrá existir override manual.

## Endpoints Preparados

- `GET /api/metrics/incidents`
- `POST /api/reliability/incidents/intake`
- `GET /api/ai/status`

## Seguridad de Ingesta

La ingesta de incidentes requiere `INCIDENTS_INGEST_TOKEN`.

Header soportado:

- `Authorization: Bearer <token>`

Sin ese token, la ruta de ingesta responderá con error.

## Ejemplo de Payload de Incidente

```json
{
  "source": "pagerduty",
  "incidents": [
    {
      "sourceIncidentId": "PD-10421",
      "serviceKey": "checkout-api",
      "serviceName": "Checkout API",
      "team": "digital",
      "gitlabProjectId": 1234,
      "environment": "production",
      "severity": "high",
      "status": "resolved",
      "classification": "app",
      "title": "Checkout latency above SLO",
      "summary": "P95 latency above 2 seconds for 18 minutes",
      "openedAt": "2026-03-03T09:10:00.000Z",
      "resolvedAt": "2026-03-03T09:42:00.000Z",
      "sourceUrl": "https://pagerduty.example/incidents/PD-10421",
      "namespace": "checkout",
      "workloadKind": "deployment",
      "workloadName": "checkout-api",
      "events": [
        {
          "eventType": "detected",
          "status": "open",
          "message": "Latency alert fired",
          "happenedAt": "2026-03-03T09:10:00.000Z"
        },
        {
          "eventType": "resolved",
          "status": "resolved",
          "message": "Latency back under SLO",
          "happenedAt": "2026-03-03T09:42:00.000Z"
        }
      ]
    }
  ]
}
```
