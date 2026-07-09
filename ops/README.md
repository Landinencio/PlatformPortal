# Ops — Scripts Operacionales

Scripts y manifiestos para operaciones del portal.

## Scripts

| Script | Descripción |
|--------|-------------|
| `backfill-gaps.js` | Rellena huecos en datos DORA/SonarQube |
| `backfill-recent.js` | Backfill de los últimos N días |
| `run-backfill-recent.sh` | Wrapper para ejecutar backfill reciente |
| `trigger-snapshot.js` | Lanza snapshot manual vía API |
| `smoke-metrics-dashboard.js` | Smoke test del dashboard de métricas |
| `k8s-metrics-check.js` | Verificación de métricas K8s |
| `apply-branch-push-rules.sh` | Aplica reglas de naming de ramas (ADR-001) |
| `verify-cybersecurity-schema.js` | Valida schema de reportes de ciberseguridad |
| `test-cybersecurity-intake.sh` | Test de ingesta de ciberseguridad |
| `generate-n8n-flows-with-portal.js` | Genera flujos n8n con integración portal |
| `generate-n8n-flows-with-portal.py` | Versión Python del generador de flujos |
| `apply-infra-live-policy.sh` | Aplica la inline policy read-only del infra-live-detector a `n8n-cost-reader-role` en las 22 cuentas |
| `setup-aws-health-hub.sh` | Provisiona el hub central de AWS Health en dp-tooling (SQS + bus EventBridge + reglas + inline policy IRSA). Idempotente |
| `apply-aws-health-eventbridge.sh` | Rollout multi-cuenta: crea en cada cuenta la regla `aws.health` en el bus `default` + el rol cross-account `PutEvents` hacia el hub. Idempotente |

## AWS Health ingestion (EventBridge `aws.health` → SQS)

La org está en **Basic Support**, así que la AWS Health API de pago no se usa. En su lugar, los eventos `aws.health` se recogen vía EventBridge (sin coste) y se hace fan-in cross-account a un bus central en dp-tooling, de ahí a una cola SQS que el portal consume (`src/lib/aws-health.ts`).

Ficheros:

| Fichero | Descripción |
|---------|-------------|
| `setup-aws-health-hub.sh` | Crea/actualiza en dp-tooling: cola `portal-aws-health-events`, bus `portal-aws-health`, regla `portal-aws-health-to-sqs` (→ SQS) e inline policy `AwsHealthQueueReader` en el rol IRSA `portal-inventory-irsa` |
| `apply-aws-health-eventbridge.sh` | Itera los 22 perfiles AWS y crea en cada cuenta el rol `portal-aws-health-putevents` + la regla `portal-aws-health-forward` en el bus `default` (target = bus central) |
| `aws-health-bus-policy.json` | Resource policy del bus central: `events:PutEvents` condicionado por `aws:PrincipalOrgID` (org `o-8u43vqg0jh`), sin enumerar cuentas |
| `aws-health-sqs-policy.json` | Queue policy: `events.amazonaws.com` puede `sqs:SendMessage` solo desde la regla del bus central (SourceArn) |
| `aws-health-queue-reader-policy.json` | Inline policy `AwsHealthQueueReader` (3 acciones SQS) sobre la cola, attachada al rol IRSA del portal |

Despliegue (orden):

```bash
# 1. Hub central en dp-tooling (idempotente, medium-risk: cuenta propia del portal)
bash ops/setup-aws-health-hub.sh

# 2. Rollout en las 22 cuentas (idempotente; requiere sesiones SSO activas).
#    Staged opcional con AWS_HEALTH_PROFILES="digital-dev eks-dev".
bash ops/apply-aws-health-eventbridge.sh

# 3. Configurar el portal con la URL de la cola
#    AWS_HEALTH_QUEUE_URL=https://sqs.eu-west-1.amazonaws.com/444455556666/portal-aws-health-events
```

Verificar recepción de un evento (los `aws.health` reales no se pueden inyectar — AWS rechaza `PutEvents` con `source: aws.*`). Para probar la fontanería extremo a extremo, ensanchar temporalmente el patrón de la(s) regla(s) a un source de prueba (`portal.selftest`), poner un evento y restaurar el patrón:

```bash
QURL=https://sqs.eu-west-1.amazonaws.com/444455556666/portal-aws-health-events
# (a) ensanchar la regla central + (en cuentas) la regla forward a ["aws.health","portal.selftest"]
# (b) aws events put-events --entries '[{"Source":"portal.selftest","EventBusName":"portal-aws-health",...}]'
# (c) aws sqs receive-message --queue-url $QURL --wait-time-seconds 10
# (d) RESTAURAR el patrón a {"source":["aws.health"]} y purgar la cola
```

Los eventos reales llegarán automáticamente cuando AWS Health publique una notificación en cualquiera de las 22 cuentas; el cronjob `aws-health-sync` (cada 15 min) hace polling y upsert en `aws_health_events`.

## K8s Manifests (`k8s/`)

| Manifest | Descripción |
|----------|-------------|
| `backfill-job.yaml` | Job de backfill completo |
| `backfill-recent-job.yaml` | Job de backfill reciente |
| `dora-backfill-180d-job.yaml` | Backfill DORA 180 días |
| `dora-backfill-gaps-job.yaml` | Backfill DORA huecos |
| `mr-backfill-job.yaml` | Job puntual de backfill histórico per-MR (`mr_review_metrics`). Deriva del CronJob `mr-metrics-snapshot` (misma imagen + `envFrom: portal-env`) con `BACKFILL_FROM`/`BACKFILL_TO`. Idempotente y reanudable. Doc: `k8s/MR_BACKFILL.md` |
| `snapshot-all-cronjob.yaml` | CronJob de snapshot nocturno |
| `backfill-job-configmap.yaml` | ConfigMap para jobs de backfill |
| `infra-live-check-cronjob.yaml` | CronJob (cada 10 min) → `POST /api/infra-requests/live-check` (detector infra-live) |
| `ai-cost-snapshot-cronjob.yaml` | CronJob (`0 2 * * *`) → `POST /api/finops/ai-cost/snapshot`. Persiste el snapshot diario de coste de IA (Kiro + Bedrock) en `ai_cost_daily` (body vacío → día anterior) |
| `aws-health-sync-cronjob.yaml` | CronJob (`*/15 * * * *`) → `POST /api/aws-health/sync`. Hace polling de la cola SQS `portal-aws-health-events` y upsert en `aws_health_events` |
| `finops-daily-digest-cronjob.yaml` | CronJob (`20 10 * * *` con `timeZone: Europe/Madrid`; fallback UTC `20 8 * * *` documentado) → `POST /api/finops/daily-digest`. Genera y envía el resumen FinOps diario al webhook de Teams |
