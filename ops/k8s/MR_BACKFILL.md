# Backfill histórico per-MR (`mr_review_metrics`)

Procedimiento para rellenar el histórico que le falta a la tabla `mr_review_metrics` (la que
respalda la tabla **"Detalle por MR"** de la pestaña Gestión en `/metrics`). Spec:
`.kiro/specs/gestion-mr-history/`.

> ⚠️ **El lanzamiento real del backfill en producción es una operación MANUAL fuera del plan del
> spec.** Este documento + el manifiesto `mr-backfill-job.yaml` solo dejan la herramienta y el
> procedimiento listos. No ejecutes los `kubectl` de abajo hasta que decidas hacer el backfill de
> forma consciente y off-peak.

## Contexto

- El CronJob `mr-metrics-snapshot` (`0 4 * * *`, imagen
  `harbor.tooling.dp.iskaypet.com/tooling/mr-metrics-snapshot:<tag>`) corre en modo **incremental**
  (`LOOKBACK_DAYS = 1`) y solo trae los MRs del último día. Por eso `mr_review_metrics` solo tiene
  datos desde que arrancó el cron (~`2026-04-22` = `B`, el límite de cobertura).
- El script `ops/mr-metrics-snapshot.js` soporta un **modo backfill** que se activa con la env
  `BACKFILL_FROM`: recorre todas las páginas de MRs mergeados y rellena `[BACKFILL_FROM, B)`.
- El backfill es **idempotente** (`INSERT … ON CONFLICT (project_id, mr_iid) DO UPDATE`) y
  **reanudable**: si el Job se interrumpe, se re-lanza desde el principio sin duplicar filas.
- El **CronJob diario sigue intacto**: el Job de backfill no define `BACKFILL_*` en el cron, solo en
  el Job puntual, así que el incremental no se altera.

## Variables

| Env | Obligatoria | Significado |
|-----|-------------|-------------|
| `BACKFILL_FROM` | Sí | Inicio del histórico a rellenar (`YYYY-MM-DD`). Su presencia activa el modo backfill. |
| `BACKFILL_TO` | No | Fin del backfill (`YYYY-MM-DD`). Por defecto `B` (MIN(merged_at) actual). Acotarlo a `B` garantiza que el backfill no toca filas que el detalle ya servía → **preservación por construcción**. |

El resto de la configuración (`DATABASE_URL`, `GITLAB_TOKEN`, `GITLAB_URL`, …) la aporta el Secret
`portal-env` vía `envFrom`, igual que el CronJob.

## Recomendaciones operativas

- **Off-peak**: el backfill recorre ~971 repos × varias llamadas por MR. Lánzalo fuera de horario
  productivo. El script respeta `RATE_LIMIT_DELAY` (200 ms) y el `Retry-After` de los 429, con
  backoff exponencial acotado.
- **Idempotente / reanudable**: si falla a media, vuelve a lanzar el mismo Job (mismo
  `BACKFILL_FROM`). No se duplican filas.
- **El CronJob diario no se toca.** Tras el backfill, el detalle cubrirá el histórico y el
  incremental seguirá añadiendo el día a día.

```
CTX=arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling
NS=n8n
```

## Opción A — `kubectl create job --from=cronjob` + parche de env (rápida, sin fichero)

Crea un Job clonando el `jobTemplate` del CronJob existente (misma imagen, mismo `envFrom`, mismo
comando) y luego le añade `BACKFILL_FROM`:

```bash
# 1) Crear el Job a partir del CronJob
kubectl --context "$CTX" -n "$NS" create job mr-backfill-2026q1 \
  --from=cronjob/mr-metrics-snapshot

# 2) Inyectar BACKFILL_FROM (y opcionalmente BACKFILL_TO) en el contenedor.
#    El nombre del contenedor en el CronJob es `mr-metrics`.
kubectl --context "$CTX" -n "$NS" set env job/mr-backfill-2026q1 \
  BACKFILL_FROM=2026-01-01
# (opcional) acotar el fin del backfill:
# kubectl --context "$CTX" -n "$NS" set env job/mr-backfill-2026q1 BACKFILL_TO=2026-04-22
```

> Nota: `set env` sobre un Job ya creado funciona porque el Pod aún no se ha completado; si el Job
> ya arrancó el contenedor, bórralo (`kubectl delete job mr-backfill-2026q1`) y repite, o usa la
> Opción B (define la env desde el inicio).

## Opción B — aplicar el manifiesto (reproducible, versionado)

Usa la plantilla `ops/k8s/mr-backfill-job.yaml` (ya trae `BACKFILL_FROM` y `envFrom: portal-env`).
Edita el `name`, el `image` tag y `BACKFILL_FROM` (placeholders `CHANGE-ME`) y aplícala:

```bash
kubectl --context "$CTX" -n "$NS" apply -f ops/k8s/mr-backfill-job.yaml
```

## Seguimiento

```bash
# Estado del Job
kubectl --context "$CTX" -n "$NS" get job mr-backfill-2026q1

# Logs en vivo
kubectl --context "$CTX" -n "$NS" logs -f job/mr-backfill-2026q1

# Verificar cobertura ganada (la fila más antigua debería bajar hacia BACKFILL_FROM)
# SELECT MIN(merged_at), COUNT(*) FROM mr_review_metrics;
```

## Limpieza

El manifiesto define `ttlSecondsAfterFinished: 172800` (48h) → el Job se borra solo. Para borrarlo
antes:

```bash
kubectl --context "$CTX" -n "$NS" delete job mr-backfill-2026q1
```
