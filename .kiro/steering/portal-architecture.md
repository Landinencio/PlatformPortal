# Platform Portal — Steering Canónico

> Truth source único para futuras sesiones. Si algo del código contradice este doc, este doc se actualiza (no al revés).
> Última auditoría: Junio 2026.
> Doc público equivalente: `docs/PORTAL_DOCUMENTATION.md` + Confluence `Portal de Plataforma` (id `994443265`).

---

## 1. Identidad y despliegue

| Campo | Valor |
|-------|-------|
| URL (prod) | `https://portal.today.tooling.dp.iskaypet.com` |
| URL (dev) | `https://portal.today.dev.tooling.dp.iskaypet.com` |
| Cluster | dp-tooling (`arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling`) |
| Namespace prod | `n8n` (Deployment `portal-prod`, Service `portal-prod`) |
| Namespace dev | `platformportal` (Deployment `portal-dev`) |
| Container | puerto 3000 |
| Imagen | `harbor.tooling.dp.iskaypet.com/tooling/platformportal:<tag>` |
| ServiceAccount | `portal-sa` con IRSA `portal-inventory-irsa` (`arn:aws:iam::444455556666:role/portal-inventory-irsa`) |
| Output Next.js | `standalone` (AWS SDK clients deben ser top-level imports) |
| Stack | Next 14 App Router, React 18, TypeScript, Tailwind, shadcn/ui (Radix), Recharts |

> **Despliegue GitOps (jun 2026)**: el portal ya NO se despliega con `docker build` + `set image` manual. Todo es **CI/CD + GitOps**: el pipeline (template del Toolkit) construye las imágenes en Harbor y escribe el tag en el GitOps_Repo `argocd/tooling`; ArgoCD sincroniza el cluster. El antiguo deployment `n8n-webhooks` fue sustituido por `portal-prod` (chart `generic-chart`) y retirado.

### Flujo de despliegue (CI/CD + GitOps)

```
merge a main (repo platformportal)
  → GitLab CI (include Toolkit main-portal.yml)
      → tag_release_candidate (semver RC)
      → build_image_harbor      → harbor tooling/platformportal:<RC>
      → build_mr_metrics_image  → harbor tooling/mr-metrics-snapshot:<RC>
      → build_lighthouse_image  → harbor tooling/lighthouse-scanner:<RC>
      → scan (Harbor)
      → deploy_dev (auto)   → yq tag en argocd/tooling shared-apps/portal-dev/values.yaml + push
      → tag_release (manual) + deploy_prod (manual) → shared-apps/portal-prod/values.yaml + push
  → ArgoCD sincroniza portal-dev (ns platformportal) / portal-prod (ns n8n)
```

- **Repo de código**: `iskaypetcom/digital/sre/tools/platformportal`. `.gitlab-ci.yml` hace `include` de `gitlab-ci-toolkit` (`main-portal.yml`) con `ref` fijado a un commit.
- **Toolkit**: `iskaypetcom/sre-infra/tools/cicd/gitlab-ci-toolkit` — `main-portal.yml` + `CI/portal-quality.yml` (quality gates: tests + lint + sonar, antes del build) + `CI/build-portal.yml` (imagen principal a `tooling/platformportal`) + `CI/build-portal-aux.yml` (mr-metrics + lighthouse, context `ops/`) + `CD/deploy-portal.yml` (solo actualiza el `tag`, NO el repository).

### Quality gates (CI/portal-quality.yml)

Stages `test → lint → code_quality` **antes** de `build_image` (fail-fast: un test rojo no produce imagen). Plantilla específica del portal (NO la genérica `CI/react/*`, que asume pnpm + scripts inexistentes).

| Job | Stage | Qué hace | Estado |
|-----|-------|----------|--------|
| `portal_tests` | `test` | `npm ci` + `npm run test:coverage` (node:test vía tsx + **c8** → `coverage/lcov.info`, artifact) | **bloqueante** |
| `portal_lint` | `lint` | `npm ci` + `npm run lint` (eslint) | informativo (`allow_failure`) |
| `sonar_scanning` | `code_quality` | `sonar-scanner -Dsonar.qualitygate.wait=true` contra SonarQube corporativo (`sonarqube.tooling.dp.iskaypet.com`), consume el lcov de `portal_tests` | informativo (`allow_failure`) |

- Config del portal: scripts `test`/`test:coverage` en `package.json` (+ `c8`, `tsx` devDeps), `sonar-project.properties` (projectKey `iskaypetcom-digital-sre-tools:platformportal`, sources=src, exclusiones tests/ops/migrations/.helm/docs), CI var `SQ_TOKEN` (masked, token con scope `provisioning`+`scan`).
- **Adopción gradual**: `portal_tests` bloqueante desde el día 1 (suite en verde, 137 tests); `portal_lint` y `sonar_scanning` informativos al inicio → endurecer quitando `allow_failure` cuando el repo esté saneado.
- Solo corren en `merge_requests` y `main`. Imagen `node:20-bookworm-slim` (Next 14 requiere Node ≥18.17). `npm ci` reproducible (no pnpm).

- **GitOps_Repo**: `iskaypetcom/sre-infra/platform-engineering/argocd/tooling` — `shared-apps/portal-{dev,prod}/` son umbrella charts sobre `generic-chart` (dependencia vendorizada en `charts/*.tgz`), values bajo la clave `generic-chart:`.
- **Chart**: `generic-chart` (`packages/generic-chart`, ≥ v0.5.0) — incluye ESO (`secret_manager.*`), CronJob (`cronjobs.*`) e ingress con host arbitrario (`ingress.hostname`).
- **Applications** (en kube-stack `environments/tooling/applications/argocd/applications/`): `portal-dev` y `portal-prod`, proyecto `shared-apps` (que permite ns `n8n` + `platformportal`), `automated + prune + selfHeal`, `ignoreDifferences` sobre `ExternalSecret /spec/data`.

### Rollback

Revertir el commit del tag en `argocd/tooling` (`shared-apps/portal-prod/values.yaml`) → ArgoCD vuelve a la versión previa. NO usar `set image` (selfHeal lo revertiría).

### Operación manual puntual (raro)

```bash
CTX=arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling
kubectl --context $CTX -n n8n rollout status deploy/portal-prod --timeout=120s
kubectl --context $CTX -n n8n logs deploy/portal-prod --tail=50
# forzar sync manual de una Application
kubectl --context $CTX -n argocd patch application portal-prod --type merge \
  -p '{"operation":{"sync":{"revision":"main"}}}'
```

### Secretos — External Secrets Operator (ESO)

Los secretos del portal NO se crean a mano. Viven en **AWS Secrets Manager** (cuenta tooling, claves `dp/tooling/portal_*`), declarados por Terraform en `shared-general` (`iac/global/secretsmanager.tf` + `variables.tf`, valores vía CI vars `TF_VAR_portal_*`). ESO (`SecretStore` auth JWT vía `portal-sa` IRSA + `ExternalSecret` refresh 1h) materializa el Secret `portal-env` que el Deployment consume por `envFrom`. 16 claves: db, gitlab, sonarqube, grafana, grafana_metrics, awx, internal, jira, teams (sre+finops), aws_health, azure (client_id/secret), nextauth, graph (client_id/secret).

**Alta/rotación de un secreto**: actualizar el valor en Secrets Manager (Terraform `shared-general` o `aws secretsmanager put-secret-value`) → ESO re-sincroniza en ≤1h (o forzar con `kubectl annotate externalsecret <name> force-sync=$(date +%s) --overwrite`) → `rollout restart deploy/portal-prod`.

### Cómo obtener tokens (lectura puntual)

```bash
CTX=arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling
kubectl --context $CTX -n n8n get secret portal-env -o jsonpath='{.data.GRAFANA_TOKEN}' | base64 -d
kubectl --context $CTX -n n8n get secret platformportal-secrets -o jsonpath='{.data.gitlab-token}' | base64 -d
```

---

## 2. RBAC

Jerarquía: `admin > directores > staff > desarrolladores > externos`.

| Rol | Acceso |
|-----|--------|
| `admin` | Todo, incluido panel admin y chat **Iskay** |
| `directores` | Todo excepto admin panel; aprueba requests; chat Iskay |
| `staff` | Infra, access management, métricas, FinOps (sin chat), monitorización |
| `desarrolladores` | Métricas, FinOps (sin chat), incidencias, requests, monitorización |
| `externos` | Métricas, incidencias, requests, monitorización (sin FinOps) |

Mapeo Azure AD (claim `groups` del JWT):

| Group | Object ID | Rol |
|-------|-----------|-----|
| `platformadmins` | 21d068e7-... | admin |
| `platformmanagers` | a273419d-... | directores |
| `platformstaff` | ae7b9e18-... | staff |
| `platformdevelopers` | a79abcc0-... | desarrolladores |
| `platformexternos` | fe12dcbb-... | externos |

Ficheros: `src/lib/auth.ts`, `src/lib/rbac.ts`, `src/lib/api-auth.ts`, `src/lib/session-role.ts`, `middleware.ts`.
APIs internas (cronjobs/n8n) validan header `x-internal-secret` (`INTERNAL_API_SECRET`) y están excluidas del middleware de usuario.

### Domain handling

`@iskaypet.com ↔ @emefinpetcare.com ↔ @ext.emefinpetcare.com`. Helper canónico: `emailsMatch()` y `normalizeEmail()` en `src/lib/access-management/domain-normalizer.ts`. La cadena de búsqueda de aprobador: email exacto → swap dominio → `@ext` variant → fallback por nombre.

---

## 3. Datos: 3 paths de extracción de coste + observabilidad

### Path 1 — Lambda relay (executive Athena + Cost Explorer)

- URL: `FINOPS_ATHENA_LAMBDA_URL` (default `https://jzcrsycqa2plblvxdeck37r6am0kxeqw.lambda-url.eu-north-1.on.aws/`)
- Source: `docs/aws/lambda-finops-athena.mjs`
- Acciones: `costs` (default), `forecast`, `inventory`, `accounts`
- Consumido por: `/api/finops/athena`, `/api/finops/forecast` (sin `accountIds`), `/api/finops/accounts`
- Devuelve: `netCost`, `pricingModel`, `dailyCosts`, `anomalies`, `topMovers`, `monthlyTrend`, `savingsPlans` (org coverage), `rightsizing`
- **Limitación**: forecast del Lambda no acepta `accountIds`. Para forecast scoped → Path 3.

### Path 2 — CUR directo via Athena (CurFullSnapshot)

- Cuenta CUR: `600700800900` (root-iskaypet)
- Role chain: portal IRSA `arn:aws:iam::444455556666:role/portal-inventory-irsa` → AssumeRole `arn:aws:iam::600700800900:role/Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur`
- DB Athena: `athenacurcfn_finnops.data` (CUR 2.0, eu-west-1)
- Output: `s3://finnops-iskaypet/athena-query-results/`
- Source: `src/lib/athena-cur.ts`
- Endpoint: `/api/finops/cur-direct`
- Devuelve `CurFullSnapshot`: byAccount, byService, dailyCosts, topResources, pricingModel, savingsPlans, **byDomain**, **byEnvironment** (tag-based), **tagCoverage**, **spDetails**, **marketplace** (separados de infra), **discounts** (SPP, bundled, credits, refunds, SP negation, tax), **hiddenCosts** (gp2, extendedSupport, cloudwatchLogs, natGateways, bedrock, snapshotCost, interZoneTransfer, gp2Detail, extendedSupportDetail), **ec2Fleet**, **tagCompliance**, **anomalyAttribution** (top services + top resources del día anómalo)
- Iskay tools que consumen: `get_net_cost_breakdown`, `get_marketplace_charges`, `get_hidden_costs`

### Path 3 — Cost Explorer SDK (forecast scoped)

- Mismo role chain que Path 2
- Source: `src/app/api/finops/forecast/route.ts`
- Activado cuando query string trae `accountIds`
- Llama `GetCostForecastCommand` y `GetSavingsPlansCoverageCommand` con `Filter.Dimensions.Key=LINKED_ACCOUNT`

### Identity Store (licencias Kiro per-user)

- Identity Store ID: `d-93670801b4` (en `600700800900`, eu-west-1)
- Mismo role que CUR + policy inline `IdentityStoreReadOnly` (`identitystore:DescribeUser/DescribeGroup/ListGroupMembershipsForMember`)
- Source: `src/lib/kiro-licenses.ts`
- Endpoint: `/api/finops/kiro?accountIds=<csv>` (cache 15 min por set de cuentas)
- Las licencias Kiro vienen como `line_item_line_item_type='FlatRateSubscription'` (no `Fee`). Pro $20, Pro+ $40, Power $200.

### Observabilidad — Grafana Cloud (proxy unificado)

- Stack: `https://iskaylog.grafana.net`
- Token: `GRAFANA_TOKEN` (lectura/escritura datasources)
- Patrón: `${GRAFANA_STACK_URL}/api/datasources/proxy/uid/<uid>/<path>` — un único token, todos los backends
- Source: `src/lib/grafana-proxy.ts`, `src/lib/grafana-metrics.ts`

Datasources expuestos:

| UID | Tipo | Uso |
|-----|------|-----|
| `grafanacloud-prom` | prometheus | Métricas org (también via `GRAFANA_METRICS_URL` con basic auth, username `1290143`) |
| `grafanacloud-logs` | loki | Logs (clusters dp-dev, dp-uat, dp-prd, dp-tooling); username Loki `744117` |
| `grafanacloud-traces` | tempo | Trazas OTel |
| `grafanacloud-profiles` | pyroscope | Profiling (no cableado) |
| `cloudwatch-data-prod` / `cloudwatch-eks-prod` / etc. | cloudwatch | Per-account (10+ datasources) |

### OpenCost (k8s allocation)

- Job en Prom: `integrations/opencost`. Activo en los 4 clusters EKS (dp-dev, dp-uat, dp-prd, dp-tooling).
- Source: `src/lib/k8s-finops.ts`, `src/lib/grafana-metrics.ts`
- Endpoint: `/api/finops/k8s-allocation` (cache 5 min)

Métricas clave:

| Métrica | Labels |
|---------|--------|
| `node_total_hourly_cost` | `k8s_cluster_name`, `node`, `instance_type`, `provider_id`, `region` |
| `node_cpu_hourly_cost` / `node_ram_hourly_cost` / `node_gpu_hourly_cost` | igual |
| `container_cpu_allocation` / `container_memory_allocation_bytes` | `k8s_cluster_name`, `namespace`, `pod`, `container`, `node` |
| `kubecost_cluster_management_cost` | `k8s_cluster_name` (EKS control plane) |
| `kubecost_load_balancer_cost` | `k8s_cluster_name`, `ingress_ip` |
| `kubecost_network_internet_egress_cost` / `region_egress_cost` / `zone_egress_cost` | `k8s_cluster_name` |
| `kubecost_node_is_spot` | per node |
| `kubecost_pv_info` | per PV (0 series — PV cost no habilitado) |

PromQL canónicos:

```promql
# Coste por namespace (CPU)
sum by (k8s_cluster_name, namespace) (
  avg by (k8s_cluster_name, namespace, pod, container, node) (container_cpu_allocation)
  * on (k8s_cluster_name, node) group_left()
  avg by (k8s_cluster_name, node) (node_cpu_hourly_cost)
)

# Coste por namespace (RAM, división DENTRO del sum para preservar labels)
sum by (k8s_cluster_name, namespace) (
  avg by (k8s_cluster_name, namespace, pod, container, node) (container_memory_allocation_bytes / (1024*1024*1024))
  * on (k8s_cluster_name, node) group_left()
  avg by (k8s_cluster_name, node) (node_ram_hourly_cost)
)

# Spot count (Mimir requiere agregación)
count by (k8s_cluster_name) (kubecost_node_is_spot > 0)

# p95 CPU 7d para rightsizing
quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])[7d:5m])
```

Fórmula rightsizing (`k8s-finops.ts`):

- `target_cpu = max(p95_cpu_7d / 0.5, 0.1 cores * pod_count)` — 50% headroom, suelo 100m
- `target_ram = max(p95_ram_7d / 0.7, 0.125 GiB * pod_count)` — 30% headroom, suelo 128 MiB
- `savings = (allocated - target) * unit_cost`, capped al 70% del coste actual
- Skip pods con <60 min uptime en 7d (cronjobs/jobs)

### CUR Athena — columnas y patrones

CUR 2.0, columnas reducidas. Disponibles: `product_instance_type`, `product_instance_family`, `product_region_code`, `product_servicecode`, `product_pricing_unit`, `product_product_family`, `product_location`. **NO** disponibles: `product_volume_api_name`, `product_database_engine`, `product_storage_class` (se derivan parsing `line_item_usage_type`).

Tipos de line item:

| Tipo | Significado |
|------|-------------|
| `Usage` | Uso estándar (la mayoría de métricas filtran por esto) |
| `Fee` | Tasas fijas |
| `FlatRateSubscription` | **Suscripciones Kiro** (Pro $20, Pro+ $40, Power $200) — NO confundir con `Fee` |
| `Tax` / `Credit` / `Refund` | Tax/credits/refunds |
| `SppDiscount` / `BundledDiscount` | Descuentos negativos |
| `SavingsPlanNegation` / `SavingsPlanCoveredUsage` / `SavingsPlanRecurringFee` | SP |
| `RIFee` | Reservation fee |

Marketplace separation:

```sql
WHERE line_item_product_code LIKE 'cg%'
   OR line_item_usage_type = 'Global-SoftwareUsage-Contracts'
   OR line_item_usage_type LIKE 'MP:%'
```

Tag coverage real (Mayo 2026): ~3.7% del coste tiene `user_domain`. Tags obligatorios (por compliance): `user_department`, `user_domain`, `user_environment`. Compliance per-tag en `tagCompliance`.

### Histórico de coste de IA (CUR-direct, sin tabla)

Serie temporal diaria del coste de IA (Kiro + Bedrock) leída **directamente del CUR vía Athena**, igual que el resto de la pestaña Costes. NO hay tabla snapshot ni cronjob: el histórico completo está disponible bajo demanda para cualquier rango/cuentas que pida el dashboard (el CUR ya tiene granularidad diaria). Permite ver tendencia y detectar picos (ej. job EMR que gastó ~700€ de Bedrock en un día en cuentas de Data).

> Histórico: el primer diseño usó una tabla `ai_cost_daily` + cronjob de snapshot + backfill. Se descartó (jun 2026) por sobreingeniería: el CUR ya da la serie diaria estable, así que se reescribió a una sola query CUR-direct cacheada. Eliminados la tabla, el cronjob `ai-cost-snapshot` y el endpoint de snapshot.

- Source: `src/lib/ai-cost-history.ts` → `getAiCostHistory(startDate, endDate, accountIds?)`, cacheado 10 min (`cache.ts`, prefijo `ai-cost`).
- Query: `fetchAiCostSeries(start, end, accountIds?)` en `athena-cur.ts` — una sola query agrupada por día + cuenta + fuente. **Kiro** = `line_item_product_code = 'Kiro'` (Usage/Fee/Credit/FlatRateSubscription… neteado); **Bedrock** = `line_item_resource_id LIKE 'arn:aws:bedrock:%'` (Usage/Fee). Nombres de cuenta resueltos vía `aws-account-catalog.ts`.
- Anomalías (`detectAiCostAnomalies`, pura): un día es anómalo sii `totalAiCost > mean + 2*stddev && totalAiCost > 1.5*mean` sobre la ventana; vacío con ≤1 día (sin base estadística).
- Endpoint: `GET /api/finops/ai-cost/history?startDate&endDate&accountIds=csv` (rol `desarrolladores`).
- UI: `AiCostHistoryCard` en la pestaña Costes (sección "Costes de IA"). Respeta el rango global de fechas y la selección de cuentas del dashboard; incluye desglose por cuenta con nombres amigables. Sin filtro 30/60/90 propio (usa el global).

### Ingesta de novedades AWS (EventBridge `aws.health` → SQS, sin coste de soporte)

Consolida las notificaciones de AWS Health (incidencias, mantenimientos programados, fin de soporte) que hoy llegan por email, **sin pagar plan de soporte**. Verificado: root (`600700800900`) está en **Basic Support** (`aws support describe-severity-levels`, `aws health describe-events` → `SubscriptionRequiredException`), por lo que la AWS Health API programática NO está disponible. Los eventos `source: "aws.health"` sí se emiten por EventBridge en cada cuenta aunque estén en Basic Support.

- Source: `src/lib/aws-health.ts`. Tabla cache `aws_health_events` (PK `arn`, upsert idempotente ante reentregas SQS at-least-once).
- **Topología fan-in cross-account**: en cada cuenta (×22) una regla en el `default` bus con pattern `{"source":["aws.health"]}` → target el bus central `portal-aws-health` en dp-tooling (`444455556666`, eu-west-1) vía rol `portal-aws-health-putevents` (cross-account `events:PutEvents`). En dp-tooling, una regla en `portal-aws-health` enruta a la cola SQS `portal-aws-health-events`.
- El portal hace polling de la cola con su IRSA (`portal-inventory-irsa` + policy inline `AwsHealthQueueReader`: `sqs:ReceiveMessage/DeleteMessage/GetQueueAttributes` sobre esa cola). La cola está en la propia cuenta dp-tooling (sin AssumeRole).
- `pollAwsHealthQueue` long-poll (10 msgs, wait 5s), `normalizeHealthEvent` → `AwsNewsItem` (servicio, región, categoría, estado, cuentas afectadas con nombre amigable vía `aws-account-catalog`, severidad inferida: `issue` abierto→alta, `scheduledChange`→media, `accountNotification`→baja). `syncAwsHealthEvents` upsert por `arn` (merge `affected_accounts`, preserva `first_seen`) y solo entonces borra de SQS. Degradación: error de SQS → `[]` sin tocar filas previas.
- Endpoints: `POST /api/aws-health/sync` (interno, `maxDuration=120`) + `GET /api/aws-health/news?includeClosed` (rol `admin`, validado en servidor). CronJob `aws-health-sync` (`*/15 * * * *`).
- UI: `NewsSidebar` admin-only en la home. Infra: `ops/setup-aws-health-hub.sh` (hub dp-tooling: cola + bus + regla + policy IRSA) y `ops/apply-aws-health-eventbridge.sh` (rollout multi-cuenta idempotente, patrón `apply-infra-live-policy.sh`; aplicado a 22 cuentas) + JSONs `ops/aws-health-{bus,sqs,queue-reader}-policy.json`.

### Resumen FinOps diario a Teams (Daily FinOps Digest)

Entrega proactiva diaria a un grupo de Teams (10:20 Europe/Madrid, justo antes de la daily) con un resumen FinOps **determinista** (sin Bedrock) del día + novedades AWS.

- Source: `src/lib/finops-daily-digest.ts` + helper `src/lib/teams-notify.ts` (`sendTeamsCard`, `buildDigestCard`).
- **Determinista** (no usa el Asesor/Bedrock): consulta el Lambda relay de coste (path 1, `action: costs`) sobre todas las cuentas vivas (`filterLiveAwsAccounts`) en tres ventanas — ayer, mes-a-fecha y **mismos días del mes anterior** (`costWindows`, clamp a la longitud del mes previo) — y `getAwsNews({sinceHours:24})`.
- Reporta: gasto de ayer, mes-a-fecha + comparativa MoM (Δ€ y %), mayores variaciones por servicio (subidas y bajadas; `prettyService` traduce los códigos opacos del CUR: `cg*`→"Marketplace (contrato)", ids de inference-profile→"Bedrock (GenAI)"), días anómalos (μ+2σ) y novedades AWS. Nota: la cabecera MoM puede verse distorsionada por contratos marketplace prepagados el día 1 (gotcha #3); se muestran explícitos en los movers.
- Envía 1 o 2 Adaptive Cards según `FINOPS_DIGEST_MODE` (`single`|`split`, default `split`) al webhook dedicado `FINOPS_TEAMS_WEBHOOK_URL` (distinto del `TEAMS_WEBHOOK_URL` de SRE) + enlace al dashboard. Si el resumen de coste falla pero hay novedades, envía solo novedades; nunca lanza por fallo parcial (Property 9). Sólo usa `FINOPS_TEAMS_WEBHOOK_URL` (Property 10).
- Helpers puros testeados (`costWindows`, `buildFinopsSummary`, `prettyService`, builders de card): `src/lib/__tests__/finops-daily-digest.property.test.ts`.
- Endpoint: `POST /api/finops/daily-digest` (interno, `maxDuration=300`). CronJob `finops-daily-digest` (`20 10 * * *`, `timeZone: Europe/Madrid`).

### Notificación a Teams en cada deploy a producción (prod-deploy-teams-notify)

Notifica a un canal de Teams **dedicado** cada vez que hay un deploy a producción en GitLab (org-wide, grupo `iskaypetcom`). Sustituye al intento previo con ArgoCD notifications (demasiado ruido por el sync). Reutiliza el receptor de webhooks existente y el helper de Teams.

- Source: `src/lib/deploy-notify.ts` (puro + testeable): `detectProdDeploy` (status `success` + build que casa `DORA_DEPLOY_JOB_NAMES` con status `success`, substring case-insensitive sobre name/stage), `buildDeployInfo` (enriquece MR/commit best-effort vía `gitlabClient`, nunca lanza), `buildDeployCard` (Adaptive Card), `notifyProdDeploy` (orquestador, nunca lanza, retorna `{sent, reason}`).
- Trigger: enganchado fire-and-forget al final de `processPipeline()` en `src/app/api/webhooks/gitlab/route.ts` (el group webhook de `iskaypetcom` ya entrega `pipeline_events` vía API GW `t0dabp3vme…/portal-webhook`). NO afecta a DORA (que sigue por snapshot).
- **Dos capas anti-duplicado**: (1) gate `DEPLOY_NOTIFY_ENABLED="true"` SOLO en `values-prod.yaml` → dev nunca envía (dev/prod tienen BD separadas, así que el dedup en BD NO cruza entornos); (2) dedup en BD `deploy_notifications` (PK `(pipeline_id, project_id)`, claim atómico `ON CONFLICT DO NOTHING` **antes** de enviar) → cubre las 2 réplicas + reentregas de GitLab.
- Webhook dedicado `DEPLOY_TEAMS_WEBHOOK_URL` (distinto de SRE/FinOps), vía ESO desde `dp/tooling/portal_teams` propiedad `deploy_webhook` (Terraform en `shared-general`, CI var `TF_VAR_portal_teams_deploy_webhook` protected). La card lleva: micro, equipo, entorno, timestamp (Europe/Madrid), ref, commit (corto + mensaje), autor, MR (iid+título), pipeline, y botones a MR/pipeline/proyecto.
- Tests: `src/lib/__tests__/deploy-notify.test.ts` (22 casos, deps inyectadas).
- `reason` posibles: `disabled`, `not-prod-deploy`, `already-notified`, `claim-error`, `no-webhook`, `send-failed`, `sent`.

---

## 4. Bedrock — Iskay y agentes

| Caso de uso | Endpoint | Modelo env | Source |
|-------------|----------|------------|--------|
| **Iskay** chat tool-calling | `POST /api/ai/finops-chat` | `FINOPS_CHAT_MODEL_ID` = `eu.anthropic.claude-sonnet-4-20250514-v1:0` | `src/lib/finops-tools.ts`, `src/components/finops/finops-chat.tsx`, `finops-chat-floating.tsx` |
| **Infra agent** | `POST /api/infra-request-v2/generate|modify` | `INFRA_AGENT_MODEL_ID` = `eu.anthropic.claude-sonnet-4-20250514-v1:0` | `src/lib/infra-agent.ts` |
| **FinOps advisor** (job async) | `POST /api/ai/finops-advisor` | mismo | `src/lib/finops-advisor-runner.ts` |
| Otros (`/api/ai/chat`, `/analyze`, `/anomalies`, `/risk-assessment`, `/report`, `/analyze-costs`) | varios | `src/lib/bedrock.ts` |

- Loop Iskay: `ConverseCommand` con `toolConfig`; max 6 iteraciones; tools en paralelo por turno
- Acceso Iskay: **admin o directores únicamente** (servidor 403, cliente null para resto)
- Botón flotante visible en las 4 pestañas FinOps (Costes, Inventario, EKS Allocation, Asesor)

### Catálogo Iskay (15 tools — solo coste AWS + inventario + reporting)

> Iskay es **FinOps de coste AWS puro** (jun 2026): se retiraron las tools de Kubernetes/OpenCost y de observabilidad (logs/trazas/PromQL) para acotar el scope, reducir latencia y evitar que el modelo divague. Esas capacidades siguen en el portal (pestaña EKS Allocation, Grafana), pero NO en el chat. Además: grounding con `finops-knowledge.ts`, memoria conversacional (`iskay_conversations`), caché de queries de coste (5 min) y prompt caching de Bedrock.

- **AWS Cost (Lambda + CUR direct)**: `list_accounts`, `get_total_cost`, `get_cost_by_account`, `get_cost_by_service`, `compare_periods`, `get_forecast`, `get_top_resources`, `get_daily_context`, `get_net_cost_breakdown`, `get_marketplace_charges`, `get_hidden_costs`, `get_cost_by_domain` (coste por tag `user_domain` + cobertura)
- **Inventario**: `get_inventory_summary`, `search_inventory`
- **Reporting**: `build_report` — genera un `.xlsx` multi-hoja descargable. La tool **NO recibe cifras del modelo**: recibe un Report_Spec (`title`, `startDate`, `endDate`, `accountIds?`, `sections[]`) y **vuelve a obtener los datos** llamando a los executors existentes (`getCostByAccountTool`, `getCostByServiceTool`, `getCostByDomainTool`, `getTopResourcesTool`, `getNetCostBreakdownTool`, `getHiddenCostsTool`, `getMarketplaceChargesTool`, summary), garantizando cifras exactas. Secciones soportadas: `summary`, `by_account`, `by_service`, `by_domain`, `top_resources`, `net_breakdown`, `hidden_costs`, `marketplace`. Aplica `prettyServiceName` antes de escribir celdas (cero IDs opacos en el Excel). Sección que falla → hoja con nota de error y resto OK; todas fallan → error que el modelo comunica. Devuelve `{reportId, filename, sheetCount, rowCounts, downloadUrl}`.
- Tools de coste muestran nombres legibles (`prettyServiceName`): los códigos `cg…`→"Marketplace (contrato)" y los inference-profile ids→"Bedrock (GenAI)".
- Acceso: admin o directores (servidor 403 para el resto).

### Reporting Iskay — Export Excel (cross-réplica)

- **Persistencia**: `src/lib/finops-report-store.ts` — `saveReport({filename, content, userEmail, ttlMinutes})` (genera UUID, inserta `expires_at`) y `getReport(id)` (trata expirado como inexistente, borrado lazy).
- **Tabla**: `finops_reports` (`id UUID PK`, `filename TEXT`, `content BYTEA`, `user_email TEXT`, `created_at TIMESTAMPTZ`, `expires_at TIMESTAMPTZ`) + índice por `expires_at` para limpieza por TTL. Migración `migrations/2026-06-12_finops_reports.sql`. Almacenar el buffer en BD (no en memoria) garantiza que la descarga funcione desde cualquiera de las 2 réplicas.
- **Endpoint**: `GET /api/finops/report/[id]` — `requireUserAuth` con gate admin/directores, valida ownership por email (`emailsMatch`) entre la sesión y `user_email`, devuelve el `content` con `Content-Disposition: attachment; filename="..."` y `Content-Type` xlsx; 404 si no existe / expiró / no es propietario.
- **SSE**: el evento `done` ahora puede transportar `report?: { downloadUrl, filename }` cuando la última tool del turno es `build_report`, además de un `citationGuard?: { citedCount, missingCount }` con la telemetría del guard. La UI (`src/components/finops/finops-chat.tsx`) extiende el tipo `Message` con `report?` y renderiza un botón "⬇️ Descargar Excel" bajo la respuesta del asistente que apunta al `downloadUrl`.

### Evals + Citation_Guard (Spec `iskay-finops-specialist`)

- **Eval harness**: `ops/iskay-evals/` (Node + tsx, **read-only**, no toca producción). `cases.ts` define `EvalCase` (`id`, `question`, `expectTools`, `forbidTools?`, `assertions`); `run.ts` ejecuta el loop reutilizando `executeFinopsTool` + el mismo system prompt y captura el `trace`. Assertions deterministas: `expectTools`/`forbidTools`, `citesToolFigures` (importes ⊆ toolResults), `noOpaqueIds`, `period`, `outOfScopeRedirect`. Modo `--judge` opcional (LLM-as-judge contra rúbrica, una llamada Bedrock por caso; desactivado por defecto para no encarecer cada corrida). Un caso que peta no aborta la corrida: se marca fail y continúa. Casos golden iniciales cubren los gotchas FinOps conocidos: net_cost vs total bruto, `get_cost_by_domain` vs `get_cost_by_service` para "departamento", pico día 1 = marketplace, out-of-scope ("dame los logs de oms") → redirección al dashboard, cita exacta.
- **Citation_Guard**: `src/lib/finops-citation-guard.ts` — funciones puras `extractCitedAmounts(text)` + `verifyCitations(text, toolResults)`. En el route, tras el loop, registra discrepancias como telemetría **sin bloquear** la respuesta (modo "loguea y mide" — alimenta los evals; se endurece después con los datos recogidos).

> Iskay sigue **estrictamente read-only**, accesible **solo a admin/directores** (servidor 403 para el resto). Ni `build_report` (consulta y exporta) ni el harness (lee y mide) añaden capacidades de escritura.

---

## 5. Funcionalidades del portal

### Self-service y workflow

| Ruta | Qué hace | Ficheros |
|------|----------|----------|
| `/create-repo` | Crea repo GitLab desde template via webhook n8n | `gitlab-repo-form.tsx`, `/api/create-repo` |
| `/access-management` | Solicita acceso (Azure AD / GitLab / AWS / Kiro license) con cascade reporter | `access-management/`, `/api/access-management/*` |
| `/infra-requests` | Solicitudes IaC con AI agent (RDS/S3/IAM Role) | `infra-request-v2/`, `/api/infra-request-v2/*`, `/api/infra-assistant/*` |
| `/tickets` | Tickets bidireccional con Jira (parsing `💬 Name (email):`) | `tickets/`, `/api/jira/{create-ticket,my-tickets,tickets/[key]/comments}` |
| `/notifications` | Inbox y campana global (polling 30s) | `notification-bell.tsx`, `/api/notifications/{,count,read}` |
| `/` (home) | Sidebar **Novedades AWS** admin-only (eventos `aws.health`) | `home/news-sidebar.tsx`, `/api/aws-health/news` |

### Métricas y observabilidad

| Ruta | Qué hace | Ficheros |
|------|----------|----------|
| `/metrics` | DORA + Gestión + MR Review + SonarQube + Manager dashboard | `metrics/engineering-dashboard.tsx` (2318 líneas), `/api/metrics/*` |
| `/synthetics` | Monitores HTTP + tab Lighthouse (5 cronjobs Dom 03:00) | `synthetics/`, `/api/synthetics/*` |
| `/admin` | Analytics admin (8 tabs: overview, engagement, tickets, approvals, access, repos, infra, user-detail) | `admin/admin-analytics-dashboard.tsx`, `admin/analytics/*` |

### FinOps (`/finops` — 4 tabs + Iskay flotante)

| Pestaña | Componente | Endpoints |
|---------|------------|-----------|
| Costes | `costs-dashboard.tsx`, `cur-deep-insights.tsx`, `executive-summary.tsx`, `cost-movers-card.tsx`, `anomaly-timeline-card.tsx`, `aws-rightsizing-card.tsx`, `kiro-licenses-card.tsx`, `ai-cost-history-card.tsx`, `forecast-panel.tsx` | `/api/finops/{costs,athena,cur-direct,forecast,credits,kiro,accounts,ai-cost/history}` |
| Inventario | `aws-inventory-dashboard.tsx`, `inventory-kpi-bar.tsx` (badge CUR/est) | `/api/inventory` |
| EKS Allocation | `eks-cost/eks-cost-dashboard.tsx` (+ `kpi-bar.tsx`, `filters-bar.tsx`, `cost-by-environment-chart.tsx`, `nodegroup-breakdown-chart.tsx`, `squad-attribution-chart.tsx`, `recommendations-table.tsx`, `recommendation-detail-panel.tsx`) — dashboard nodo-céntrico ("el coste real de EKS es el NODO"), cadena de valor over-provisioning → nodos de más → € → recomendación → ahorro | `/api/finops/k8s-cost`, `/api/finops/k8s-allocation` (alias legacy con `Deprecation: true` + `Link: </api/finops/k8s-cost>; rel="successor-version"` durante 2 releases), `/api/finops/vpa` |
| Asesor FinOps | `finops-advisor.tsx` (jobs async) | `/api/ai/finops-advisor`, `/api/ai/finops-advisor/jobs` |

### Detección de deploy a producción (DORA)

Default constants en `src/lib/dora-snapshot.ts` y `src/lib/gitlab-governance.ts`. Override env: `DORA_DEPLOY_JOB_NAMES`.

```
deploy_prod, deploy-production, deploy_artifact, deploy-artifact,
deploy_prd, deploy-prd, android_playstore_prod, ios_appstore_prod,
playstore_prod, appstore_prod, distribute_prod
```

Las stages móviles (Play Store, App Store) son deploys de primer nivel.

### CronJobs

> **Gestionados por GitOps (jun 2026)**: los 12 cronjobs se declaran en el chart (`generic-chart` `cronjobs.jobs` en `argocd/tooling shared-apps/portal-{dev,prod}/values.yaml`), heredan env + el Secret de ESO (`portal-env`) por `envFrom`, y los crea ArgoCD. NO se crean/parchean a mano. Las imágenes `mr-metrics-snapshot` y `lighthouse-scanner` las construye el pipeline (context `ops/`) y el CI escribe su tag junto al del portal.

| Nombre | Schedule | Imagen | Propósito |
|--------|----------|--------|-----------|
| `dora-metrics-snapshot` | `0 18 * * *` | platformportal (curl interno) | DORA + ArgoCD correlation |
| `k8s-metrics-snapshot` | `0 19 * * *` | alpine (curl interno) | Métricas k8s |
| `mr-metrics-snapshot` | `0 4 * * *` | mr-metrics-snapshot:<tag> | Per-MR review metrics (971 repos) |
| `lighthouse-targets-refresh` | `0 22 * * *` | lighthouse-scanner:<tag> | Refresh targets |
| `lighthouse-{animalis,kiwoko-es,kiwoko-pt,tiendanimal-es,tiendanimal-pt}` | `0 3 */2 * *` | lighthouse-scanner:<tag> (`MONITOR_ID` 1-5) | Lighthouse audits |
| `aws-health-sync` | `*/15 * * * *` | curl interno | Poll SQS `aws.health` → `aws_health_events` |
| `infra-live-check` | `*/10 * * * *` | curl interno | Detección infra creada de verdad |
| `finops-daily-digest` | `20 10 * * *` (`timeZone: Europe/Madrid`) | curl interno | Resumen FinOps + novedades AWS → Teams |

`mr-metrics-snapshot.js` resuelve squad walking path **left-to-right** (parent groups primero) con substring fallback. Ejemplo: `iskaypetcom/digital/marketplace/marketplace-products-api` → `marketplace`, NO `products`.

### Pipeline unificado nocturno

`src/lib/platform-snapshot.ts` → `runUnifiedSnapshot(date)` → `POST /api/metrics/snapshot-all`

```
Phase 1 (paralelo):
  ├── DORA           → src/lib/dora-snapshot.ts          → dora_metrics_daily, deployment_traces, production_deployments
  ├── SonarQube      → src/lib/sonarqube-snapshot.ts     → sonarqube_metrics_daily
  ├── K8s metrics    → src/lib/k8s-snapshot.ts           → k8s_rollouts_daily, argocd_health_daily
  └── Compliance     → src/lib/service-compliance.ts     → service_compliance_daily

Phase 2: MR Analytics  → src/lib/mr-snapshot.ts          → gitlab_mr_analytics
Phase 3: Correlation   → src/lib/deployment-correlation.ts → deployment_correlation
```

`runStep(name, fn, maxRetries=2)` con backoff 5s/10s. `runningSnapshots` Set previene duplicados. `invalidateCache()` con prefijos al final.

### VPA recommendations pipeline (cross-cluster)

Pipeline que expone las recomendaciones del Vertical Pod Autoscaler como métricas Prometheus en Grafana Cloud, alimentando la sub-sección "Ajuste de recursos" en EKS Allocation.

| Capa | Recurso | Manifest |
|------|---------|----------|
| Controller | `vpa-recommender` + `vpa-updater` + `vpa-admission-controller` | `ops/k8s/vpa-values.yaml` (chart `autoscaler/vertical-pod-autoscaler 0.9.0`, app 1.6.0) |
| KSM standalone | Deployment `ksm-vpa` con `--custom-resource-state-only=true` | `ops/k8s/ksm-vpa-standalone.yaml` |
| Discovery | Annotations `k8s.grafana.com/scrape: "true"` en el pod ksm-vpa | (en `ksm-vpa-standalone.yaml`) |
| Allow rule | `clusterMetrics.kube-state-metrics.metricsTuning.includeMetrics` | `ops/k8s/alloy-vpa-allow.yaml` |

Métricas emitidas (label `k8s_cluster_name` añadido por Alloy):

```
kube_customresource_verticalpodautoscaler_recommendation_cpu_target_cores
kube_customresource_verticalpodautoscaler_recommendation_cpu_lowerbound_cores
kube_customresource_verticalpodautoscaler_recommendation_cpu_upperbound_cores
kube_customresource_verticalpodautoscaler_recommendation_memory_target_bytes
kube_customresource_verticalpodautoscaler_recommendation_memory_lowerbound_bytes
kube_customresource_verticalpodautoscaler_recommendation_memory_upperbound_bytes
kube_customresource_verticalpodautoscaler_spec_updatemode
```

**Comandos canónicos para activar VPA en un cluster:**

```bash
CTX=arn:aws:eks:eu-west-1:<acct>:cluster/<cluster>
kubectl --context $CTX apply -f https://raw.githubusercontent.com/kubernetes/autoscaler/vertical-pod-autoscaler-1.6.0/vertical-pod-autoscaler/deploy/vpa-v1-crd-gen.yaml
helm --kube-context $CTX upgrade --install vpa autoscaler/vertical-pod-autoscaler --version 0.9.0 -n kube-system -f ops/k8s/vpa-values.yaml --skip-crds
kubectl --context $CTX apply -f ops/k8s/ksm-vpa-standalone.yaml
helm --kube-context $CTX upgrade grafana-k8s-monitoring grafana/k8s-monitoring --version 3.8.5 -n cloud-agent --reuse-values -f ops/k8s/alloy-vpa-allow.yaml
kubectl --context $CTX -n cloud-agent rollout restart statefulset/grafana-k8s-monitoring-alloy-metrics
```

Estado a Mayo 2026: dp-dev/dp-uat/dp-prod tienen los 4 capas desplegadas. dp-dev (104 VPAs) y dp-uat (44) en `Off`. dp-prod sin CRs todavía pero con el plano listo.

---

## 6. Base de datos (PostgreSQL 16)

- Engine: PostgreSQL 16 (RDS, eu-west-1). Connection en secret `platformportal-secrets` key `database-url`.
- Pool: `pg` con `max: 20` (`src/lib/db.ts`).
- 50 tablas. Migraciones: `migrations/YYYY-MM-DD_descripcion.sql` (37 ficheros a la fecha).

### Tablas principales

| Tabla | Propósito |
|-------|-----------|
| `dora_metrics_daily`, `dora_metrics_snapshots` | DORA agregado + raw |
| `developer_activity_daily` | Actividad por desarrollador/día |
| `deployment_traces`, `production_deployments`, `deployment_changes` | Trazas detalladas |
| `gitlab_deploy_jobs`, `gitlab_deploy_attempts` | Jobs de deploy |
| `gitlab_mr_analytics` | MR agregadas |
| `mr_review_metrics` | Per-MR review (time-to-PR, review time, comments, reviewers JSONB) |
| `deployment_correlation` | GitLab ↔ ArgoCD |
| `sonarqube_metrics_daily` | Métricas Sonar |
| `services`, `service_compliance_daily` | Catálogo + compliance |
| `k8s_rollouts_daily`, `k8s_failures_daily`, `argocd_health_daily`, `k8s_workload_mapping` | K8s |
| `finops_advisor_jobs`, `finops_daily_context` | FinOps async + contexto |
| `finops_reports` | Workbooks `.xlsx` generados por la tool `build_report` de Iskay (BYTEA + TTL para descarga cross-réplica). PK `id UUID`, `filename TEXT`, `content BYTEA`, `user_email TEXT`, `created_at`, `expires_at`. Índice por `expires_at`. Migración `2026-06-12_finops_reports.sql` |
| `aws_health_events` | Cache de eventos `aws.health` (EventBridge → SQS). Upsert por `arn` (PK) |
| `deploy_notifications` | Dedup de notificaciones de deploy a prod → Teams. PK `(pipeline_id, project_id)`, claim atómico `ON CONFLICT DO NOTHING` |
| `lighthouse_audits`, `synthetic_monitors`, `synthetic_checks` | Monitorización |
| `portal_user_activity`, `portal_tickets`, `access_requests`, `infra_requests` | Portal user-facing |
| `repo_catalog`, `developer_name_map`, `webhook_events_raw` | Catálogos / auditoría |
| `user_notifications`, `user_preferences` | UX |
| `cybersecurity_runs`, `cyber_azure_*` | Cyber (feature flag off) |

---

## 7. Infraestructura externa (clusters, AWS, integraciones)

### Clusters EKS

| Cluster | Cuenta | Profile | Namespaces clave |
|---------|--------|---------|-------------------|
| dp-tooling | 444455556666 | eks-tooling | n8n (portal), argocd, harbor, sonarqube, grafana, monitoring, gitlab-runner, awx-ansible, cert-manager, external-secrets, crossplane, keda, synthetic-monitoring, dependencytrack, mattermost, tech-radar, platformportal, k6-tests |
| dp-dev | 111122223333 | eks-dev | oms, basket, checkout, payments, loyalty, customers, products, pricing, shipping, returns, stores, marketplace, auth, identifiers, comerzzia/czz, animalis, helios, websites, front-vue/vue-ssr, mobile, core, data-science |
| dp-uat | 222233334444 | eks-uat | (subset de dp-dev) |
| dp-prod | 333344445555 | eks-prd | (mismo set + synthetic-monitoring, devlake, beyla) |

### AWS Profiles relevantes

| Profile | Cuenta | Uso |
|---------|--------|-----|
| eks-tooling | 444455556666 | Cluster portal |
| eks-{dev,uat,prd} | 111122223333 / 222233334444 / 333344445555 | EKS apps |
| root-iskaypet | 600700800900 | CUR + Identity Store + Athena |
| digital-prod | 111222333444 | RDS digital con `db-o11y` |
| retail-prod | 666777888999 | mariadb-retail |

Todos los profiles SSO usan `sso_start_url=https://iskaypet.awsapps.com/start`, `sso_role_name=SRE`, región `eu-west-1` (excepto root, con rol admin propio MPA). Profiles configurados localmente (`~/.aws/config`): clinicanimal, data-dev, digital-{dev,uat,prod}, digital-ecommerce, ecommerce-tiendanimal, eks-{dev,uat,prd,tooling}, helios-{dev,uat,prod}, infra, iskaypet-data, iskaypet-ecommerce, log, pruebas (=Sandbox Infra&SRE 100300500700), retail-{dev,uat,prod}, sap, sistemas-tiendanimal, sandbox-{backoffice,data,digital,retail}, root-iskaypet.

### `n8n-cost-reader-role` (inventario + infra-live-detector)

Rol read-only que el portal asume (vía IRSA `portal-inventory-irsa`) para inventario AWS y para el detector de "infra creada de verdad". **Existe en 22 cuentas** (todas las productivas/squad). Lleva la policy inline `InfraLiveDetectorReadOnly` (`ops/n8n-cost-reader-infra-live-policy.json`: sqs/sns/dynamodb/rds/secretsmanager/s3/events read-only), aplicada con `ops/apply-infra-live-policy.sh`.

**NO existe** (inventario y detector no llegan) en: `log` (400600800100), `pruebas`/Sandbox Infra&SRE (100300500700), las 4 sandbox (backoffice 700800900100, data 800900100200, digital 900100200300, retail 200400600800) y root (que usa otro rol admin para CUR). Pendiente: crear el rol en esas cuentas si se quiere cobertura total del inventario.

### RDS Database Observability

Credenciales canónicas para monitorización: usuario `db-o11y`, password `grafanapass`. Permisos: PostgreSQL `pg_monitor` + `pg_read_all_stats`; MySQL `PROCESS, REPLICATION CLIENT, SELECT ON performance_schema.*`.

Endpoints (digital-prod, sufijo cluster `.csiltpf3i9jz.eu-west-1.rds.amazonaws.com`):

- **PostgreSQL**: subscriptions-api, animalis-rds-postgres, content-api-rds-postgres, core-rds-postgres, lastmilesservices-rds-postgres, marketplace-offers-api, marketplace-products-api, oms, oms-erp-connector-rds-postgres, oms-stats-rds-postgres, payments-api, rbac-rds-postgres, ship-from-store-rds-postgres, stores-interlocutor-rds-postgres, stores-rds-postgres
- **MySQL**: identifiers-rds-mysql, loyalty-rds-mysql, marketplace-payments-api, products-rds-mysql, shipstore-rds-mysql

Retail-prod (sufijo `.chmwgsbjh6mo.eu-west-1.rds.amazonaws.com`): mariadb-retail (primaria), mariadb-retail-replica.

### Fleet Management (Grafana Alloy collectors)

- Base: `https://fleet-management-prod-011.grafana.net`
- Pipelines: `/pipeline.v1.PipelineService/{ListPipelines,GetPipeline,CreatePipeline,UpdatePipeline,UpsertPipeline,DeletePipeline}`
- Collectors: `/collector.v1.CollectorService/`
- Auth: Basic `791121:{GCLOUD_RW_API_KEY}`

### Otras integraciones

| Servicio | Cliente | Auth |
|----------|---------|------|
| GitLab.com | `src/lib/gitlab.ts` | `GITLAB_TOKEN` (PAT) |
| Jira Cloud | `src/lib/jira.ts` (API v3 con `nextPageToken`) | `JIRA_EMAIL` + `JIRA_API_TOKEN` |
| SonarQube | `src/lib/sonarqube.ts` (con `fetchWithTimeout`) | `SONARQUBE_TOKEN` |
| Microsoft Graph | `src/lib/graph-client.ts` | client_credentials, tenant `19e73cc9-78d1-4540-862c-5a89572ef80e` |
| AWX | `/api/automations/awx/route.ts` | `awx-token` |
| MS Teams | `TEAMS_WEBHOOK_URL` (notificaciones) | webhook URL |
| n8n | `N8N_INTERNAL_URL = http://n8n.n8n.svc.cluster.local` | sin auth (cluster-internal) |
| AWS Bedrock | `src/lib/bedrock.ts` (cross-account via STS) | role chain |

---

## 8. Variables de entorno

### Secrets (`platformportal-secrets`)

`database-url`, `gitlab-token`, `sonarqube-token`, `GRAFANA_TOKEN`, `GRAFANA_METRICS_TOKEN`, `awx-token`, `INTERNAL_API_SECRET`, `JIRA_API_TOKEN`, `TEAMS_WEBHOOK_URL`, `FINOPS_TEAMS_WEBHOOK_URL` (webhook FinOps dedicado para el Daily FinOps Digest — distinto del `TEAMS_WEBHOOK_URL` de requests/aprobaciones SRE; el operador debe suministrar el valor), `DEPLOY_TEAMS_WEBHOOK_URL` (webhook dedicado para la notificación de deploy a prod — vía ESO desde `dp/tooling/portal_teams` propiedad `deploy_webhook`; distinto de SRE/FinOps). Gate `DEPLOY_NOTIFY_ENABLED="true"` SOLO en prod (`values-prod.yaml`) para evitar duplicado dev↔prod.

### Secrets (`n8n-webhooks-env`)

`AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `NEXTAUTH_SECRET`.

### ConfigMap / env directas

`NEXTAUTH_URL=https://portal.today.tooling.dp.iskaypet.com`, `AZURE_AD_TENANT_ID=19e73cc9-...`, `GITLAB_URL=https://gitlab.com`, `JIRA_BASE_URL=https://iskaypet.atlassian.net`, `JIRA_EMAIL=ruben.landin@iskaypet.com`, `GRAFANA_STACK_URL=https://iskaylog.grafana.net`, `GRAFANA_METRICS_URL`, `GRAFANA_METRICS_USERNAME=1290143`, `SONARQUBE_URL`, `AWX_API`, `N8N_INTERNAL_URL`, `AWS_BEDROCK_REGION=eu-west-1`, `INFRA_AGENT_MODEL_ID`, `FINOPS_CHAT_MODEL_ID`, `FINOPS_ATHENA_LAMBDA_URL`, `IDENTITY_STORE_ROLE_ARN`, `AWS_HEALTH_QUEUE_URL` (URL de la cola SQS `portal-aws-health-events` en dp-tooling, eu-west-1; la lee `aws-health.ts`), `FINOPS_DIGEST_MODE` (`single`|`split`, default `split`), `DORA_DEPLOY_JOB_NAMES`, `DORA_MAX_LEAD_TIME_HOURS`, `DORA_DF_ANOMALY_THRESHOLD`, `DORA_MIN_CORRELATION_CONFIDENCE`.

---

## 9. Convenciones Git

**Branch:** `<type>/<TICKET>` — regex `^(main|master|develop|release\/.*|(feat|fix|hotfix|perf|refactor|chore|build|ci|docs|test)\/[A-Z]{2,10}-[0-9]+)$`. Ejemplo: `feat/SRE-001`.

**Commit:** `[TICKET] <type>: <description>`. Ejemplo: `[SRE-001] feat: add lighthouse scanning to synthetics`. Description 2-70 ASCII. Tipos: feat, fix, hotfix, perf, refactor, chore, build, ci, docs, test, revert, style.

---

## 10. Operational gotchas (cosas que rompen si no se respetan)

1. **DORA cache key**: `getDoraCoreDashboard` incluye `from`, `to`, `days`, `teams`, `projectIds`, `includeClusterSignals`. Si añades dimensión, actualiza la key.
2. **DORA custom range**: cuando `from`/`to` (YYYY-MM-DD) están presentes, ganan sobre `days`. Period comparison pasa ambos — usar la ventana explícita.
3. **Marketplace contracts**: separar siempre con `line_item_product_code LIKE 'cg%'` OR `Global-SoftwareUsage-Contracts` para no mostrar falsos picos Día 1.
4. **Identity Store role**: `Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur` requiere policy inline `IdentityStoreReadOnly`. Sin ella, UUIDs sin nombre en la pestaña Kiro.
5. **Standalone Next + AWS SDK**: imports top-level. `require()` lazy en runtime falla con `Cannot find module`.
6. **Mimir aggregation**: `kubecost_node_is_spot == 1` requiere `count by(...) (kubecost_node_is_spot > 0)`.
7. **PromQL division-by-bytes**: `/(1024*1024*1024)` DENTRO del `sum by(...)` para preservar labels.
8. **i18n closures**: helpers fuera del componente principal deben tener su propio `const { t } = useI18n()` — el minificador rompe closures.
9. **Modify infra**: `verifyModifyScope()` espera string HCL, no el objeto `TerraformPreview`. Usar `result.terraformPreview.content`.
10. **MR detectTeam**: walking path left-to-right, parent primero. `iskaypetcom/digital/marketplace/marketplace-products-api` → `marketplace`.
11. **Domain normalization**: usar SIEMPRE `emailsMatch()` de `domain-normalizer.ts`.
12. **FlatRateSubscription**: las suscripciones Kiro vienen como `FlatRateSubscription`, no `Fee`.
13. **VPA via KSM**: el chart `grafana-k8s-monitoring 3.8.5` tiene un sub-chart `kube-state-metrics 6.4.2` que **filtra** `customResourceState`/`extraRules`/`extraArgs`. Hay que desplegar un KSM standalone (`ops/k8s/ksm-vpa-standalone.yaml`) con discovery por annotations (no por labels — porque al compartir el `scrape_pool` con el KSM principal, Alloy emite "samples with different value but same timestamp" para las métricas meta `up`/`scrape_samples_scraped`). Y añadir las métricas al `metricsTuning.includeMetrics` (`ops/k8s/alloy-vpa-allow.yaml`).
14. **helmfile + kubeContext NO es fiable**: el campo `kubeContext:` del `helmfile.yaml` de cada entorno NO garantiza el cluster destino — `helm` acaba usando el **contexto default del shell** (`kubectl config current-context`). Esto causó un deploy accidental de los **values de dev sobre el cluster de prod** (sync ejecutado desde `environments/dev` con el contexto default en prod). Daño concreto: el `argocd-cm` de prod quedó con `url: argocd.dev.dp.iskaypet.com` y `oidc.config.clientID` de la app Azure AD de dev (`5feeab55-...`) → login OIDC roto con "Invalid redirect URL". **Fix aplicado**: patch quirúrgico del `argocd-cm` restaurando `url=https://argocd.prod.dp.iskaypet.com` y `clientID=16cbe4d4-...` (app prod) + `kubectl rollout restart deploy/argocd-server`. NO se re-sincronizó el chart completo porque el helmfile de prod tiene un repo helm roto (`apache/incubator-devlake` da 404) que aborta el sync. **Procedimiento obligatorio antes de cualquier `helmfile sync`**: (1) `kubectl config use-context <cluster-destino>`, (2) verificar con `kubectl config current-context`, (3) sync, (4) restaurar el default a un contexto NO-prod al terminar. OIDC clientID por entorno: dev=`5feeab55-91d0-4393-a8da-f21884926b24`, prod=`16cbe4d4-d71e-4baa-8be7-0b182f8d4a3d`.
15. **argocd-rbac-cm no se actualiza por cambio en values.yaml en la pipeline**: la pipeline GitLab de kube-stack (`.apply-*-helmfile.yml`) solo dispara `deploy-*-helmfile` cuando cambia `helmfile.yaml`, NO cuando cambia `applications/argocd/values.yaml`. Por eso tras mergear un cambio de RBAC hay que ejecutar `helmfile -l app=argocd sync` manualmente (con el procedimiento del punto 14) en cada entorno. El ConfigMap `argocd-rbac-cm` además puede tener `kubectl.kubernetes.io/last-applied-configuration` por ediciones manuales previas (k8slens), pero helm lo sobrescribe igual en el sync.
16. **`build_report` re-consulta datos**: la tool de export Excel de Iskay NUNCA escribe en el workbook cifras que vengan del texto del modelo. Recibe un Report_Spec (rango/cuentas/secciones) y vuelve a llamar a los executors existentes (`getCostByAccountTool`, `getCostByServiceTool`, etc.) para poblar las celdas. Si añades una sección nueva, repite el patrón: consultar la fuente, no leer del trace.

---

## 11. Spending alto a vigilar

- Marketplace contracts: ~$85k/mes (anuales prepagados Día 1)
- PostgreSQL 13 Extended Support: ~$950/mes (pagamos por NO migrar)
- CloudWatch Logs us-east-1 (WAF): ~$2.4k/mes (4 log groups por brand)
- Bedrock Haiku: ~$2.2k/mes (split entre `iskaypet-data` 200300400500 y `data-dev` 100200300400)
- NAT Gateways: 9 activos. Top consumer (`nat-02fa21f2db24ee28f` prod) ~$200/mes
- EBS gp2 → gp3: migración ahorra ~20% (`hiddenCosts.gp2Detail`)

---

## 12. Estilo y proceso de trabajo (preferencias del usuario)

- **Idioma**: español para UI/explicaciones, inglés para código
- **Tono**: directo, sin overthinking. Implementar y desplegar.
- **No preguntar** lo obvio: si el flujo es claro, ejecutar.
- **Builds largos**: usar `control_bash_process` con `start` (next build ~7 min)
- **Cluster default**: `dp-tooling` (`arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling`)
- **Namespace default**: `n8n` (NO `platformportal/platformportal-app`, eso es legacy)
- **CronJob `mr-metrics-snapshot:latest`**: ya tiene `imagePullPolicy: Always`, basta con push
- **AWS profile root**: `root-iskaypet` (600700800900) para Athena/CUR

---

## 13. Documentación pública

- `docs/PORTAL_DOCUMENTATION.md` — markdown con la versión "user-facing"
- Confluence (espacio TS — SRE):
  - "Portal de Plataforma" (id `994443265`) — página padre, hermana de Grafana (`505446421`)
  - "Documentación técnica completa" (id `994476033`) — hija con el doc completo
- Scripts de upload: `ops/upload_confluence.py` (crear), `ops/update_confluence.py` (actualizar página existente)

---

## 14. Deuda técnica conocida (próximas sesiones, atacar por orden)

### Duplicidades verificadas (refactor mecánico)

1. **`normalizeEmail` duplicado** — `src/lib/infra-approvers.ts:13` tiene su propia copia. Importar desde `src/lib/access-management/domain-normalizer.ts`.
2. **AssumeRole replicado en 7 ficheros** (`athena-cur.ts`, `aws-cloudwatch-metrics.ts`, `aws-inventory.ts`, `bedrock.ts`, `finops-advisor-runner.ts`, `infra-agent.ts`, `kiro-licenses.ts`). Centralizar en `src/lib/aws-assume-role.ts` con cache de credenciales (1h TTL).
3. **Modelo Bedrock obsoleto en fallback** — `src/lib/bedrock.ts:249` y `src/app/api/ai/chat/route.ts:260` aún tienen `amazon.nova-lite-v1:0`. Reemplazar por Sonnet 4 o eliminar el fallback.
4. **Ollama dead code** — `finops-advisor-runner.ts` aún referencia `callOllama` y `FINOPS_USE_BEDROCK`. Eliminar si nadie usa Ollama.
5. **`fetchWithTimeout` solo en SonarQube** — añadir wrapper genérico y usarlo en `gitlab.ts`, `jira.ts`, `grafana-proxy.ts`, `awx`. Riesgo real de hangs.
6. **Cache invalidation por prefijo** — auditar que todos los uses respeten los prefijos canónicos (`dora:`, `sonar:`, `k8s:`, `correlation:`, `executive:`, `team-activity:`, `kiro:`).

### Endpoints/flows legacy a sustituir

7. **`/api/create-infra` (n8n webhook) vs `/api/infra-request-v2`** — el primero ya no se usa en UI activa. Eliminar route y formulario legacy `infra-request-form.tsx`.
8. **`/api/user-onboarding` (n8n webhook) vs `/api/access-management/request`** — sustituido por access-management con cascade reporter. Marcar como deprecated.
9. **`/api/ai/chat` (Becario) vs `/api/ai/finops-chat` (Iskay)** — convergir al endpoint unificado con param `scope: 'general'|'finops'` y reusar la mecánica de tools.
10. **Feature flags en `false` indefinidamente** — `ENABLE_JIRA`, `ENABLE_CYBERSECURITY`, `ENABLE_AUTOMATIONS`. Decidir: matar el código o promover a producción.

### Componentes monolíticos a partir

11. **`engineering-dashboard.tsx`** (2318 líneas) — extraer cada pestaña (DORA, Gestión, MR Review, SonarQube, Manager) a su propio fichero.
12. **`aws-inventory-dashboard.tsx`** (1230 líneas) — extraer por servicio (EC2, RDS, S3, Lambda, ECS, etc.) a sub-componentes.
13. **`cur-deep-insights.tsx`** (824 líneas) — cada sección colapsable como sub-componente.

### Mejoras de funcionalidad propuestas

14. **Drift detection Terraform** — cron que compare estado en S3 vs lo desplegado y publique en `/infra-requests/drift`.
15. **Iskay con memoria conversacional** — persistir historial en DB (tabla `iskay_conversations`); permitir resumen y "continuar conversación".
16. **Coste por MR** — combinar k8s-allocation + minutos CI (GitLab) para mostrar "esta MR cuesta X $/mes en infra" en el dashboard de MR Review.
17. **Audit log unificado** — vista `/admin/audit` que cruce `portal_user_activity`, `access_requests` (status changes), `infra_requests` (status changes), `webhook_events_raw` para "quién hizo qué".
18. **Public API + tokens** — exponer DORA y FinOps a integraciones externas con tokens por servicio (sin SSO).
19. **Tag enforcement bot** — detectar módulos Terraform sin `user_domain/department/environment` y abrir MR automático.
20. **DORA per-team SLO** — umbrales configurables por equipo y alertas Teams cuando bajan.
21. **Slack además de Teams** — algunos squads usan Slack. Notificaciones webhook duales.
22. **Backup/restore one-click RDS** — botón en `/inventory` que llame al template AWX correspondiente.
23. **Reducir tools de Iskay** (22 → ~12) — consolidar `get_total_cost` (Lambda) + `get_net_cost_breakdown` (CUR) detrás de un solo tool con `source: 'lambda'|'cur-direct'`.
24. **Mover snapshots a colas SQS/EventBridge** — actualmente CronJob → curl → API; si el pod cae a media, snapshot inconsistente. Cola garantiza reintentos.
25. **Lighthouse trend dashboard** — actualmente vemos audit por audit; agregar tendencia de Performance/Accessibility/SEO/BestPractices por brand+route en el tiempo.

### Validación pendiente

26. **DORA period comparison fix desplegado** — el fix en `src/lib/metrics-dashboard.ts` (líneas 1033-1075, cache key con `from`/`to` + ventana explícita) ya está en código pero hay que verificar en producción que los rangos de una semana muestran métricas distintas semana a semana.

27. **Borrado del legacy EKS Allocation (Fase 4 spec `eks-cost-optimization`)** — tras el cutover a `<EksCostDashboard />` en dev+prod (task 17.1, jun 2026) y una **ventana de observación de ≥2 semanas** sin llamadas al alias `GET /api/finops/k8s-allocation` (comprobar en los logs del portal-prod grepeando `[k8s-allocation] legacy call from`), borrar del repo:
    - `src/lib/k8s-finops.ts`
    - `src/app/api/finops/k8s-allocation/route.ts`
    - `src/lib/eks-cost/legacy-adapter.ts`
    - `src/components/finops/k8s-allocation-dashboard.tsx`
    - `src/components/finops/k8s-vpa-table.tsx`
    - `src/components/finops/k8s-nodes-analysis.tsx`

    Cerrar el feature flag `ENABLE_EKS_COST_V2` (borrarlo de `src/lib/feature-flags.ts` y de los 3 `.helm/values*.yaml` + del GitOps repo `argocd/tooling` `shared-apps/portal-{dev,prod}/values.yaml`) y desguazar el ternario en `src/components/finops-workspace.tsx` — a estas alturas ya es `<EksCostDashboard />` directo, sólo faltará borrar el flag no consumido.


---

## 15. Plan en curso — Access Management standardization (Junio 2026)

Reorganización integral de cómo el portal solicita y materializa accesos en AWS, ArgoCD, SonarQube y GitLab tras la migración a la nueva jerarquía padre/hijo de Enterprise Apps en Azure AD.

### Estado actual del plan

| Item | Estado |
|------|--------|
| Permisos Graph para `iskaypet-automation-n8n` (`bbca2c99-...`): Application.Read.All, AppRoleAssignment.ReadWrite.All, Group.Read.All, GroupMember.ReadWrite.All, Directory.Read.All, AuditLog.Read.All, RoleManagement.Read.All, User.Read.All, User.ReadWrite.All | ✅ aplicado + admin consent |
| `src/lib/access-management/team-mapping.ts` con clasificador por displayName y `PUBLIC_TEAMS=[digital,retail,marktech,data]` vs `ADMIN_ONLY=[backoffice,soporte-tienda,soporte-sede,platform,audit,other]` | ✅ desplegado |
| `src/lib/access-management/platform-groups.ts` reescrito — devuelve TODOS los grupos sin filtro de keywords, con `teamCategory` adjunto | ✅ desplegado |
| `/api/access-management/groups?platform=aws&team=...` con filtro por equipo + rol (admins ignoran filtro) | ✅ desplegado |
| Form `access-request-form.tsx` recarga grupos al cambiar team o platform; admins tienen toggle "Mostrar todos los grupos sin filtrar"; no-admins ven solo Digital/Retail/Marktech/Data | ✅ desplegado |
| Distinción `PLATFORMS_WITH_TEAM_GROUPS = ["aws"]` — para ArgoCD y SonarQube se ignora `team` (workaround temporal: tienen grupos transversales) | ⚠️ provisional, se quita cuando ArgoCD tenga grupos por AppSet asignados |
| MR 342 en repo `iskaypetcom/digital/platform-engineering/azure/azuread`: `iac/services/argocd_app_role_assignments.tf` que asigna 25 grupos `ArgoCD_*` a 6 SPs de ArgoCD | ✅ mergeada |
| MR 344 fix: excluir `ArgoCd Comerzzia Prod` (SAML SSO con role `User` que NO acepta asignaciones de grupos) | ✅ mergeada y aplicada — **125 asignaciones limpias** (5 SPs × 25 grupos) en Azure AD |
| Borrado de 17 grupos legacy `argocd_app_*` (incluyendo `argocd_app_marketplace` cuyos 2 miembros se mantuvieron en `ArgoCD_Marketplace`) | ✅ ejecutado con `ops/migrate-legacy-argocd-groups.js` |
| Población inicial: 42 usuarios únicos propagados desde squads AWS (`AWS_DH_*`, `AWS_Data_*`) a sus grupos `ArgoCD_*` equivalentes (script idempotente) | ✅ ejecutado con `ops/populate-argocd-groups-from-aws-squads.js` |
| MR 669 a `iskaypetcom/digital/platform-engineering/eks/kube-stack`: rewrite RBAC ArgoCD en values.yaml (dev/uat/prod) — 25 roles `appset-<name>` + readonly + sysadmin + comerzzia + CocktailDevelopers (29 totales). Borradas 6 roles legacy con grupos 404 (DigitalLeads/OMSDevelopers/TakeoverDevelopers/ConversionDevelopers/ProfitabilityDevelopers/CXDevelopers) | ✅ mergeada |
| MR 670 fix globs RBAC: 5 globs no matcheaban ninguna app real (el RBAC de ArgoCD filtra por **nombre de Application**, no por namespace destino). Corregidos `czz_proxysql-*`→`czz-czz-proxysql-*`, `websites_animalis-*`→`animalis-ecom-*`, `websites_kiwoko-*`→`kiwoko-*`, `websites_tiendanimal-*`→`tiendanimal-*`, y `appset-animalis` `animalis-*`→`animalis-[!e]*` (class-negation de gobwas/glob para excluir `animalis-ecom-*` que pertenece al AppSet websites-animalis). Validados contra apps reales de dev+uat+prod | ⏳ abierta, esperando review/merge |
| Bug Francisca (aprobadora): `team-approvers.ts` figuraba en `data` pero `isApprover()` global solo aceptaba la lista en `infra-approvers.ts`. Añadido `isTeamApprover()` y usado en `/api/access-management/[id]/review` y `/api/infra-requests/[id]/review` | ✅ desplegado (1ª iteración) |
| Bug Francisca (raíz real): el botón "Aprobar" NO le salía en `/infra-requests` porque `GET /api/infra-requests` devolvía `isApprover: false` para team approvers (solo miraba `ALL_APPROVER_EMAILS` global). Además `infra_requests` NO tiene columna `approver_email` (mi fallback de la 1ª iteración leía una columna inexistente). **Fix 2ª iteración**: añadido `teamsApprovedBy()` en `team-approvers.ts`; `GET /api/infra-requests` ahora marca `isApprover: true` para team approvers y les devuelve las requests de SUS equipos (filtro `team = ANY($teams)` en infra, `business_team = ANY($teams)` en access) | ⏳ build `francisca-fix-v2` en curso |
| UI access-management: cuando platform=ArgoCD muestra "ApplicationSet" en lugar de "Grupo", limpia el prefijo "ArgoCD_" del display y oculta el toggle "Mostrar todos los grupos" (sólo aplica a AWS) | ✅ desplegado |
| SonarQube standardisation: creado grupo `SonarQube_Developers` (`b0536bfc-...`) con 42 miembros únicos derivados de los 25 grupos `ArgoCD_*`. Asignado a SonarQube SP. Desasignados los 9 grupos transversales legacy (sus grupos no se borran, sólo se quita el binding) | ✅ ejecutado con `ops/sonarqube-standardize.js` |
| Renovación secret `PlatformPortal` (`ac7af294-...`) — caducaba **7 jun 2026** | ✅ creado nuevo `PlatformPortal-202606` válido hasta **2028-06-01**, patcheado `n8n-webhooks-env.AZURE_AD_CLIENT_SECRET`, rollout restart de `n8n-webhooks` |
| Distinción `PLATFORMS_WITH_TEAM_GROUPS = ["aws"]` — para ArgoCD y SonarQube se ignora `team` (workaround temporal) | ⚠️ se mantiene: AWS sí filtra por team via `AWS_DH_*`/`AWS_Data_*`. Para ArgoCD ahora cada grupo ya es un AppSet (no aplica filtro por team). SonarQube ahora es un único grupo, así que el filtro por team no aporta. |

### Apps Azure AD relevantes

| App registration | appId | Para qué | Estado secret |
|------------------|-------|----------|---------------|
| **PlatformPortal** | `ac7af294-f64a-4345-924b-5bfc652b639d` | NextAuth SSO + Grafana SSO. **NO** se usa para Graph. | Secret `grafanasoporte` caduca **2026-06-07**, hay que renovar |
| **iskaypet-automation-n8n** | `bbca2c99-4520-44a8-8108-cb00333e5792` | Llamadas Graph (resolver grupos, añadir miembros, listar SPs). Usado por el portal vía `AZURE_AD_GRAPH_CLIENT_ID/SECRET` | Secrets vivos hasta 2028 |

### Enterprise App SPs canónicos (ArgoCD)

| SP | Object ID | appRoles |
|----|-----------|----------|
| OMS General Argo CD | `d4c1136c-b16e-4a53-81fd-3e6f016d71ec` | (none → usa default-access id) |
| EKS Prod Argo CD | `effa022d-719d-49d4-b2e2-72c02966a49d` | (none) |
| EKS Dev ArgoCD | `fcd7ad35-4976-4543-858e-a7bd080237a9` | `AdminTest` (`2597b8d2-5c2c-4fe6-bac9-163ebe2caff8`) |
| EKS UAT ArgoCD | `a3a9c6dc-2652-49cc-9502-528ca6971497` | (none) |
| ArgoCd Comerzzia Prod | `61f786d2-879d-45ef-9929-ec2356f7fb7d` | `msiam_access`, `User` |
| ArgoCD Dev Comerzzia | `80ac0baa-81f2-4c62-94be-e616527e4cbe` | (none) |

### Repos involucrados

- `iskaypetcom/digital/platform-engineering/azure/azuread` (project id 48661569) — Terraform de los grupos AzureAD. Backend `http` con state en GitLab Terraform Registry. Pipeline GitLab CI con stages `prepare/build/deploy`.
- `iskaypetcom/digital/platform-engineering/eks/kube-stack` (project id 51818634) — Helm values + ApplicationSets + AppProjects de ArgoCD por entorno (dev/uat/prod).

### Scripts auxiliares (nuevos)

| Script | Uso |
|--------|-----|
| `ops/azuread/argocd_app_role_assignments.tf` | Plantilla TF que se sube al repo `azuread` para asignar grupos a SPs |
| `ops/list-argocd-groups.js` | Lista grupos `ArgoCD_*` de Azure (42 detectados: 24 estandarizados + 18 legacy) |
| `ops/list-legacy-argocd-members.js` | Auditoría de miembros de los 18 grupos `argocd_app_*` legacy |
| `ops/migrate-legacy-argocd-groups.js` | Migra miembros de legacy → estandarizado y borra el legacy. Idempotente. |
| `ops/list-legacy-developer-groups.js` | Lista grupos `*Developers`/`*Leads` para auditoría pre-migración kube-stack |

### Roles ArgoCD a conservar / migrar

**Conservar**:
- `readonly` → grupo `ArgoCD RO` (`10e6a424-9175-4943-8882-47c18b0dffcf`, 50 miembros vivos).

**Borrar (grupos no existen, roles muertas)**:
- `DigitalLeads`, `OMSDevelopers`, `TakeoverDevelopers`, `ConversionDevelopers`, `ProfitabilityDevelopers`.

**Añadir 25 nuevas, una por AppSet** (mapeo tabla en sección 16).

---

## 16. Mapeo paralelo AWS_DH/Data ↔ ArgoCD por AppSet

Tabla de correspondencia entre los grupos AWS Identity Center que ya tienen miembros productivos (squad de desarrollo) y los grupos ArgoCD per-AppSet a los que esos miembros deben heredar accesos. Sirve como **guía de migración inicial**: cuando se ejecute el script de población, los usuarios que están en `AWS_DH_OMS_Developers` se añaden automáticamente a `ArgoCD_OMS`, los de `AWS_Data_Developers` a `ArgoCD_Data_Science`, etc.

### Mapeo squad AWS → AppSets ArgoCD

| Grupo AWS (Identity Center) | Miembros | AppSet(s) ArgoCD que les corresponden | Grupos ArgoCD destino |
|----------------------------|----------|---------------------------------------|------------------------|
| `AWS_DH_OMS_Developers` | 9 | oms, animalis, stores, business-monitoring | `ArgoCD_OMS`, `ArgoCD_Animalis`, `ArgoCD_Stores`, `ArgoCD_Business_Monitoring` |
| `AWS_DH_MKP_Developers` | 5 | marketplace, identifiers | `ArgoCD_Marketplace`, `ArgoCD_Identifiers` |
| `AWS_DH_CEX_Developers` | 10 | customers, business-monitoring | `ArgoCD_Customers`, `ArgoCD_Business_Monitoring` |
| `AWS_DH_GROWTH_Developers` | 7 | payments, websites, products | `ArgoCD_Payments`, `ArgoCD_Websites`, `ArgoCD_Products` |
| `AWS_DH_FLS_Developers` | 1 | stores | `ArgoCD_Stores` |
| `AWS_DH_Mobile_Developers` | 0 | mobile | `ArgoCD_Mobile` |
| `AWS_Data_Developers` | 10 | data-science, data-apis | `ArgoCD_Data_Science` (data-apis cae bajo data-science) |
| `AWS_Data_AIEngineer` | (?) | data-science | `ArgoCD_Data_Science` |
| `AWS_Retail_CZZ` | (?) | czz, czz-proxysql | `ArgoCD_CZZ`, `ArgoCD_CZZ_ProxySQL` |
| `AWS_Retail_Seidor` | (?) | czz, czz-proxysql | `ArgoCD_CZZ`, `ArgoCD_CZZ_ProxySQL` |
| `AWS_MarTech_*` | (?) | helios | `ArgoCD_Helios` |
| `AWS_Backoffice_Developers` | 3 | (sin AppSets en ArgoCD hoy) | (no migrar) |

### Mapeo AppSet kube-stack → grupo Azure AD ArgoCD

Esta es la tabla canónica que `kube-stack/values.yaml` debe usar para construir las roles RBAC ArgoCD per-AppSet. Las roles se llaman `appset-<lowercase-appset-name>` y reciben permisos admin sobre `apps/<appset-prefix>-*`.

| AppSet (helm-based, helm_applicationset_X.yaml) | Namespace pattern | Grupo Azure AD | object_id |
|------------------------------------------------|-------------------|-----------------|-----------|
| `oms-helm` | `apps/oms-*` | `ArgoCD_OMS` | `fb68d1c6-e167-41f6-ac78-c50835b4ffde` |
| `marketplace-helm` | `apps/marketplace-*` | `ArgoCD_Marketplace` | `2ceb1157-ba04-46d4-93cf-c02aefc58db4` |
| `customers-helm` | `apps/customers-*` | `ArgoCD_Customers` | `1000511b-25cc-4701-9752-f28773fb0820` |
| `auth-helm` | `apps/auth-*` | `ArgoCD_Auth` | `2ac5cde3-824e-4d89-a9fd-3565c1211c64` |
| `loyalty-helm` | `apps/loyalty-*` | `ArgoCD_Loyalty` | `d60f52ce-a362-4e1b-b39b-ca52586823fd` |
| `mobile-helm` | `apps/mobile-*` | `ArgoCD_Mobile` | `2fb94cdf-7878-4489-8244-c16db25710e7` |
| `payments-helm` | `apps/payments-*` | `ArgoCD_Payments` | `6a081f04-4c80-492a-b4d5-9022c11d4f60` |
| `products-helm` | `apps/products-*` | `ArgoCD_Products` | `4332c161-12d5-407f-adf4-0f6ac2033ec2` |
| `stores-helm` | `apps/stores-*` | `ArgoCD_Stores` | `65abe35f-c175-431c-9ac0-c33913a772f8` |
| `shipping-helm` | `apps/shipping-*` | `ArgoCD_Shipping` | `bb0a7a16-a08f-41a9-a909-d30272c44071` |
| `identifiers-helm` | `apps/identifiers-*` | `ArgoCD_Identifiers` | `97ba24cb-a965-4361-b2c9-cac0400b1359` |
| `animalis-helm` | `apps/animalis-*` | `ArgoCD_Animalis` | `4891f0a2-eb4e-4ae6-9ab8-d7bb11802947` |
| `business-monitoring-helm` | `apps/business-monitoring*` | `ArgoCD_Business_Monitoring` | `c8278fa8-fac3-41be-ab44-958df1cb0588` |
| `basket-helm` | `apps/basket-*` | `ArgoCD_Basket` | `27422c3f-cfcb-487f-9635-2e73dac5138a` |
| `checkout-helm` | `apps/checkout-*` | `ArgoCD_Checkout` | `c5c61720-7770-4c3e-89fa-b851e72f6704` |
| `core-helm` | `apps/core-*` | `ArgoCD_Core` | `a7bff54e-a6a1-4b1b-a408-004fd0b713f4` |
| `pricing-helm` | `apps/pricing-*` | `ArgoCD_Pricing` | `7d363d98-7fdc-46df-9fbe-d1059e09c6be` |
| `czz-helm` | `apps/czz-*` | `ArgoCD_CZZ` | `663b2f6c-9fef-4f67-a747-5a22f19f890d` |
| `czz_proxysql-helm` | `apps/czz_proxysql-*` | `ArgoCD_CZZ_ProxySQL` | `547f5e6c-a186-48e9-8933-cab9877c3691` |
| `helios-helm` | `apps/helios-*` | `ArgoCD_Helios` | `a5eb2fcc-6c01-4631-95be-740bed0a668d` |
| `data_science-helm` | `apps/data*` | `ArgoCD_Data_Science` | `9e47f6ca-2db7-4948-9abc-13688b1dc118` |
| `data_apis-helm` (cae bajo data-science) | (compartido con data-science) | `ArgoCD_Data_Science` | (mismo) |
| `websites-helm` | `apps/websites-*` | `ArgoCD_Websites` | `246413c0-8d9f-4cba-8c0d-a0fd6c9572f6` |
| `websites_animalis-helm` | `apps/websites_animalis-*` | `ArgoCD_Websites_Animalis` | `cdd3cd4d-4899-4a45-9100-f2386560c44d` |
| `websites_kiwoko-helm` | `apps/websites_kiwoko-*` | `ArgoCD_Websites_Kiwoko` | `af3ca44e-e12f-4159-91e1-915651539b26` |
| `websites_tiendanimal-helm` | `apps/websites_tiendanimal-*` | `ArgoCD_Websites_Tiendanimal` | `6ad4e0ca-d76c-40f4-a79a-7561328382fd` |
| `front-vue` (cae bajo websites) | (compartido) | `ArgoCD_Websites` | (mismo) |
| `dorametrics-helm`, `metricspatcher-helm`, `identity-providers` | (SRE-only) | (no se crea grupo) | — |

### Plantilla de role en `values.yaml` ArgoCD

Para cada AppSet, generar un bloque así en `policy.csv`:

```
g, <object_id>, role:appset-<name>
p, role:appset-<name>, applications, *, apps/<prefix>-*, allow
p, role:appset-<name>, applications, action/*, apps/<prefix>-*, allow
p, role:appset-<name>, applicationsets, get, apps/<prefix>-*, allow
p, role:appset-<name>, applicationsets, list, apps/<prefix>-*, allow
p, role:appset-<name>, exec, create, apps/<prefix>-*, allow
p, role:appset-<name>, logs, get, apps/<prefix>-*, allow
```

Ese set de políticas permite al grupo: ver/sync/refrescar apps de su AppSet, ejecutar acciones (rollback, restart, etc.), abrir terminal `exec` en pods de sus namespaces y leer logs. Es lo que necesitan los squads para operar sus workloads sin pedirle a SRE.

### Próximos pasos pendientes (orden recomendado)

1. ✅ ~~Mergear MR 342~~ + ✅ ~~MR 344 fix Comerzzia~~ — las 125 asignaciones de grupos `ArgoCD_*` a SPs ArgoCD están aplicadas en Azure AD.
2. ✅ ~~Borrar 17 grupos legacy `argocd_app_*`~~ — completado.
3. ✅ ~~Población inicial squad-AWS → ArgoCD_*~~ — 42 usuarios únicos propagados.
4. ✅ ~~MR 669 en `kube-stack`~~ — mergeada. 25 roles `appset-<name>` + las 4 preservadas (readonly, sysadmin, comerzzia, CocktailDevelopers) activas.
   - ✅ **MR 670 fix globs** — mergeada y aplicada con `helmfile -l app=argocd sync` en **prod (rev 31), dev (rev 106), uat (rev 33)**. Corrige los 5 globs (websites-kiwoko→`kiwoko-*`, websites-tiendanimal→`tiendanimal-*`, websites-animalis→`animalis-ecom-*`, czz-proxysql→`czz-czz-proxysql-*`, animalis backend→`animalis-[!e]*`).
   - **Aprendizaje clave**: el RBAC de ArgoCD filtra por `<project>/<application-name>` (glob sobre nombre de app), NO por namespace destino. Los AppSets cuyas apps no llevan el prefijo del AppSet requieren glob específico. Para scoping fuerte por namespace haría falta un AppProject por dominio (descartado por riesgo: 143 apps en el proyecto único `apps`).
5. ✅ ~~UI ArgoCD — selector AppSet~~ — etiqueta y placeholder cambian a "ApplicationSet" cuando platform=argocd; toggle "Mostrar todos los grupos" sólo visible para AWS.
6. ✅ ~~SonarQube standardisation~~ — `SonarQube_Developers` con 42 miembros únicos (derivados de los 25 ArgoCD_*); 9 grupos legacy desasignados.
7. ✅ ~~Renovar secret `PlatformPortal`~~ — `PlatformPortal-202606` válido hasta 2028-06-01.
8. ✅ ~~Bug Francisca~~ — `isTeamApprover()` añadido y usado en los 2 endpoints de review.


---

## 17. Flujo de requests/aprobaciones — auditoría y hardening (Junio 2026)

Auditoría completa del flujo self-service de solicitudes (infra + access), aprobaciones, ejecución y cancelación. Bugs detectados y corregidos:

### Modelo de datos

- **Dos tablas distintas** con IDs independientes: `infra_requests` (IaC vía AI agent) y `access_requests` (AWS/ArgoCD/SonarQube/GitLab/Kiro). El dashboard `/infra-requests` las muestra unificadas con campo `_type: "infra"|"access"`.
- `infra_requests` **NO tiene** columna `approver_email` — el aprobador designado vive en `payload.approver`. `access_requests` **SÍ tiene** `approver_email` y `business_team`.
- Estados: `pending → approved → executing → executed` (o `execute_failed`), más `rejected` y `cancelled`. `executing` es transitorio (claim atómico).

### Bugs corregidos

1. **Access requests no se podían cancelar**: no existía endpoint. Creado `POST /api/access-management/[id]/cancel` (ownership por `emailsMatch`, transición atómica `pending→cancelled`, notifica al `approver_email`).
2. **Cancel UI cruzaba tablas**: `handleCancel` siempre pegaba a `/api/infra-requests/[id]/cancel`. Con un id de access cancelaba la infra_request con el mismo id. Ahora enruta por `_type`.
3. **TOCTOU en review** (infra y access): el `UPDATE` de status no era condicional → dos aprobadores simultáneos podían aprobar 2 veces. Ahora `UPDATE ... WHERE id=$ AND status='pending'` + check `rowCount===0 → 409`.
4. **Doble ejecución**: los endpoints `execute` (access e infra-assistant) leían `approved` y actuaban sin reclamar la fila. Añadido claim atómico `approved→executing` con `rowCount`. Estado `executing` manejado en idempotency guards y en la UI (`STATUS_CONFIG` + i18n).
5. **Escalada entre equipos**: un team approver (p.ej. Francisca de `data`) podía aprobar requests de OTRO equipo vía API (la UI no lo mostraba pero el endpoint lo permitía, porque `isTeamApprover()` devolvía true para cualquier equipo). Ahora el review valida que el aprobador **cubre el `team`/`business_team` de esa request concreta** vía `teamsApprovedBy()` — salvo aprobadores globales (`ALL_APPROVER_EMAILS`) que pueden todo.
6. **i18n incompleto**: faltaban `infra.status.executed`/`execute_failed` (en/pt/fr) y `infra.status.executing` (los 4 idiomas). Añadidos.

### Reglas canónicas del flujo (no romper)

- **Self-approval bloqueado**: `requestor == reviewer` (domain-normalized) → 403, en ambos endpoints de review.
- **Quién ve el botón Aprobar**: `GET /api/infra-requests` devuelve `isApprover: true` para aprobadores globales Y team approvers; los team approvers solo ven requests de SUS equipos (`team = ANY($teams)` / `business_team = ANY($teams)`) + las suyas propias.
- **Quién puede aprobar (servidor)**: aprobador global (`isApprover`) O `teamsApprovedBy(reviewer)` incluye el equipo de la request O es el approver designado. Esta validación es independiente de la UI.
- **Cancelar**: solo el requestor (ownership domain-normalized), solo si `pending`, transición atómica.
- **Helpers en `src/lib/team-approvers.ts`**: `isTeamApprover(email)` (cualquier equipo), `teamsApprovedBy(email)` (lista de equipos que cubre), `getApproversForTeam(team, requesterEmail)` (para el dropdown, excluye self).


---

## 18. Flujo de creación/modificación de infraestructura — auditoría y mejoras (Junio 2026)

Revisión end-to-end del flujo IaC self-service (`/infra-requests` → AI agent → MR en repo de equipo).

### Arquitectura del flujo

1. **Generate** (`/api/infra-request-v2/generate`): form estructurado → `buildPrompt()` → `InfraAgent.run()` (Bedrock Sonnet 4, tool-use loop read-only sobre el repo del equipo) → `TerraformPreview`. Rate-limited por usuario.
2. **Submit** (`/api/infra-assistant/submit`): persiste `infra_requests` status=pending + notifica aprobadores.
3. **Review** (`/api/infra-requests/[id]/review`): aprobar/rechazar (atómico, scoped por equipo — ver sección 17).
4. **Execute** (`/api/infra-assistant/execute/[id]`, internal): valida sintaxis HCL + secretos + rotación RDS → crea branch `feat/SRE-<id>` + commit + MR + Jira. Idempotente con claim `approved→executing`. Rollback de branch si falla.
5. **Modify** (`/api/infra-request-v2/modify`): lee el .tf actual, aplica cambios vía AI, `verifyModifyScope()` (pasa `result.terraformPreview.content`, string HCL), retry 1 vez si toca recursos fuera de scope.

### Catálogo de repos (`repo_catalog`)

- `getByTeam()` es **case-insensitive** (acepta slug `digital` o label `Digital`) para evitar 422 entre el form de creación (envía slugs) y el de modificación (enviaba labels). Limpiados los duplicados `Digital`/`Retail` (mayúscula) de la BD.
- Equipos: `digital` (45379727), `marktech` (71456629, comparte repo con `Helios` porque **MarTech hereda de Helios**), `retail` (45383610), `data` (72391440), + legacy `Clusters`/`Commerce`/`Helios`/`Tooling`.
- **MarTech**: slug interno es `marktech` (typo histórico, NO cambiar la key porque rompe BD/RBAC); label visible corregido a `"MarTech"` en team-approvers, team-mapping, i18n (4 idiomas), gitlab-repo-form.

### RDS — rotación de contraseña obligatoria (3 capas)

Toda RDS nueva DEBE gestionar el password del master en Secrets Manager y rotarlo cada 15 días (estándar visto en repo digital, p.ej. `subscriptions-api.tf`):
```hcl
manage_master_user_password                       = true
manage_master_user_password_rotation              = true
master_user_password_rotate_immediately           = false
master_user_password_rotation_schedule_expression = "rate(15 days)"
```
Forzado en: (1) `buildRdsPrompt()` en `infra-prompt-builder.ts`, (2) `SYSTEM_PROMPT` de `infra-agent.ts`, (3) `validateRdsPasswordRotation()` en `terraform-validator.ts` invocado en execute → 422 si falta. NUNCA hardcodear `password`.

### Modificaciones de RDS soportadas (self-service)

instanceClass, storageGb (**solo ampliar** — backend bloquea reducción), maxStorageGb (≥ allocated), multiAz, engineVersion (**solo subir** — backend bloquea downgrade, avisa downtime), backupRetentionDays (1-35), performanceInsights. **deletion_protection NO es modificable** vía self-service (salvaguarda anti-borrado; sacarlo de aquí es deliberado). S3: versioning + lifecycleRules. IAM: addPermissions/removePermissions (managed ARNs comunes + ARN custom).

### Bugs corregidos en esta revisión

1. **approver no se persistía** en `infra_requests.payload` (submit v2) → el review por approver designado nunca podía match. Ahora se guarda `payload.approver`.
2. **Nombre "-"** en el resumen de éxito (claves `bucket_name`/`role_name` en vez de camelCase `bucketName`/`roleName`).
3. **Validación cliente** desalineada con servidor: RDS identifier permitía trailing hyphen; S3 no rechazaba `aws`/`amazon`. Alineadas.
4. **`roleName` sin validación server-side** en IAM → añadida en `validateIamRoleFields`.
5. **modify form**: stale state entre recursos, sin disabled in-flight, sin reset en success, sin `role="alert"`. Corregido y ampliado a todos los atributos.


---

## 19. Squad self-service infra automation (Junio 2026)

Automatización de la infra "del día a día" de los squads (no la crítica de SRE), unificada en `/infra-requests` (tercer modo "Infra de squad"), con el MISMO flujo de aprobación por equipo, Teams, y tickets Jira (auto-Done estilo access-management).

### Decisión clave: plantillas deterministas, NO AI
SQS, Secret, DynamoDB, SNS y EventBridge son tan plantillables que se generan con templates TypeScript (`src/lib/squad-infra/templates.ts`), no con Bedrock. Es instantáneo, gratis, predecible y sin alucinaciones. El AI (InfraAgent) se reserva para la infra crítica de SRE y para las MODIFICACIONES de squad (donde hay que leer y editar HCL existente).

### Piezas
- Migración `2026-06-02_squad_infra_automation.sql`: tabla `squad_repo_catalog` (17 squads con `business_team`, cuentas AWS por entorno, project_tag, domain_tag). NO hay tabla de requests separada — se reusa `infra_requests` con `resource_type` = `squad-<tipo>`.
- `src/lib/squad-infra/{templates,validators,render,squad-catalog,execute}.ts`
- APIs `src/app/api/squad-infra/{squads,preview,request,modify,update-secret,list-resources,buses}/route.ts`
- Frontend: `squad-infra-form.tsx` (crear) + `squad-modify-form.tsx` (modificar) integrados en `infra-page-client.tsx` (modo "Infra de squad", sub-toggle crear/modificar).
- Módulos pineados: SQS `terraform-aws-modules/sqs/aws 4.0.1`, DynamoDB `dynamodb-table/aws 3.3.0`, EventBridge `eventbridge/aws 2.3.0`.

### Secrets — el reto resuelto
Los valores sensibles NUNCA tocan la BD del portal. Al crear/rotar un secret, el valor se escribe directamente como **variable CI/CD de GitLab** (masked+protected) vía `gitlabClient.upsertCiVariable()`. El `.tf` solo referencia `var.X`. Modificar el valor de un secret = actualizar la CI var + relanzar pipeline (sin cambio de .tf). Para que tome efecto SIEMPRE hay que relanzar la pipeline (`gitlabClient.triggerPipeline`).

### EventBridge bus dinámico
El selector de bus NO está hardcodeado a "oms": `/api/squad-infra/buses` escanea el repo del squad y descubre los `bus_name` reales, ofreciéndolos + opción custom.

### Ejecución (execute.ts)
Al aprobar, `executeSquadInfra` (invocado desde el execute unificado cuando `resource_type` empieza por `squad-`): crea branch `feat/SRE-<id>`, escribe el fichero (overwrite si es modificación, create/append si es creación), añade variables.tf para secrets, abre MR, crea Jira (auto-Done), lanza pipeline. Idempotente con claim atómico, rollback de branch si falla.

### IAM least-privilege (creación de roles)
El system prompt del InfraAgent prohíbe `*FullAccess`: usa políticas read/write scoped (SQS SendMessage/Receive/Delete, DynamoDB data actions, S3 Get/Put/Delete/List, SNS Publish, EventBridge PutEvents, Secrets GetSecretValue). **NUNCA políticas RDS** (las apps conectan con user/password propio de Secrets Manager, no por IAM role).

### Notificación "infra creada de verdad" (infra-live-detector)
**La pipeline NO es fuente de verdad** (un apply puede dar timeout y el recurso existir; multi-entorno son stages separados; nombres de rama `feat/SRE-<n>` colisionan con tickets SRE reales). La verdad está en AWS. `src/lib/infra-live-detector.ts` asume `n8n-cost-reader-role` (read-only) en la cuenta de CADA entorno solicitado y comprueba existencia real (`GetQueueUrl`, `DescribeTable`, `DescribeDBInstances`, `HeadBucket`, `ListSecrets`, `ListRules`...). Notifica al solicitante SOLO cuando el recurso existe en TODOS los entornos pedidos. Cronjob `infra-live-check` cada 10 min → `POST /api/infra-requests/live-check` (internal). Columna `infra_requests.infra_live_notified` evita duplicados (migración `2026-06-02_infra_live_notified.sql`).

Para RDS, al detectarla `available`, resuelve el `MasterUserSecret.SecretArn` real (gestionado y rotado cada 15 días) y lo incluye en la notificación. Siguiente nivel propuesto: crear un user RW dedicado por RDS y pasar ese secret en vez del admin.

---

## 20. Migración CI/CD + GitOps + External Secrets (Junio 2026)

Sustitución del despliegue manual (`docker build` + `set image`) por CI/CD + GitOps con ArgoCD, secretos vía ESO, y dev/prod equivalentes en el cluster tooling. Spec: `.kiro/specs/portal-cicd-gitops/`.

### Resultado final

| Pieza | Estado |
|-------|--------|
| Chart corporativo `generic-chart` (packages/generic-chart) ampliado con ESO + CronJob + fixes de ingress | ✅ v0.5.0 publicada |
| Secretos del portal en AWS Secrets Manager (`dp/tooling/portal_*`, 14 secretos) vía Terraform en `shared-general` (`iac/global`) | ✅ aplicado |
| Rol IRSA `portal-inventory-irsa` con policy `PortalSecretsManagerRead` (`PortalSecretsAccess`) + trust para `portal-sa` en `n8n`/`platformportal` | ✅ aplicado |
| Umbrella chart en `.helm/` (dependency `generic-chart`, values bajo `generic-chart:`) | ✅ |
| GitOps_Repo `argocd/tooling` `shared-apps/portal-{dev,prod}/` (umbrella + dep vendorizada) | ✅ |
| ArgoCD Applications `portal-dev` (auto) + `portal-prod` (auto tras corte) en kube-stack, AppProject `shared-apps` con ns `n8n`+`platformportal` | ✅ |
| Portal_Template en Toolkit (`main-portal.yml` + `CI/build-portal{,-aux}.yml` + `CD/deploy-portal.yml`) | ✅ |
| `.gitlab-ci.yml` del portal consume la template por `include` + `ref` fijo | ✅ |
| Dev validado (ESO 16 claves, pod Running, `/api/health` 200) | ✅ |
| Corte de prod no disruptivo: ingress del host real movido de `n8n-webhooks` (viejo) a `portal-prod` (nuevo) | ✅ HTTPS 200 |
| Deployment viejo `n8n-webhooks` escalado a 0 (pendiente borrado definitivo tras observación) | ⏳ |
| Chart fósil `n8n-webhooks` retirado de kube-stack | ✅ (MR) |
| `GRAFANA_TOKEN` filtrado en Git rotado (SA `platformtoken` id 103, token viejo id 22 revocado) | ✅ |

### Gotchas aprendidos (añadir a §10)

- **generic-chart ingress**: usaba helpers `common.ingress.supportsPathType/supportsIngressClassname` eliminados en Bitnami common 2.31.3 → rompía con `ingress.enabled`. Y el backend usaba `common.names.fullname` ≠ `genericApplication.fullname` (service real). Ambos corregidos en el chart.
- **Imagen con host duplicado**: NO sobreescribir `app.image.repository` con el host; el chart compone `registry/repository`. El deploy solo toca el `tag`.
- **Imágenes aux (mr-metrics, lighthouse)**: build context = `ops/` (los Dockerfiles hacen `COPY` relativo a `ops/`).
- **deploy_dev antes del gate manual**: el stage `deploy_dev` debe ir antes de `versioning_release` (tag_release manual), o dev no auto-despliega.
- **ESO OutOfSync cosmético**: el operador rellena defaults en `ExternalSecret.spec.data[].remoteRef` → `ignoreDifferences` sobre `/spec/data` en la Application.
- **trust IRSA**: al cambiar el SA (`n8n-webhooks` → `portal-sa`), actualizar el trust del rol o ESO da `InvalidProviderConfig`.
- **AppProject shared-apps**: lista blanca de namespaces; hubo que añadir `n8n` y `platformportal`. La pipeline de tooling es manual y no siempre aplica el AppProject → aplicar a mano si hace falta.

### Repos y MRs de referencia

- `shared-general` (45950137): SRE-9001 (secretos), SRE-9010 (trust), SRE-9016 (grafana_metrics+graph). TF 1.1 → adopción de recursos existentes con `terraform import` (job temporal one-time).
- `generic-chart` (71265300): SRE-9012 (ESO+CronJob), SRE-9013 (aux context), SRE-9014 (stage order), SRE-9015 (image repo).
- `argocd/tooling` (67911533): SRE-9007 (shared-apps/portal-{dev,prod}).
- `kube-stack` (51818634): SRE-9008 (Applications + AppProject), SRE-9011 (ignoreDifferences), SRE-9017 (prod automated), SRE-9018 (retirar fósil).
- `platformportal` (77693276): `.gitlab-ci.yml` + `.helm/` en `feat/SRE-001` → main.

### Gotcha conocido: portal-prod "Degraded" en ArgoCD por CronJob sin lastScheduleTime

Tras el primer despliegue por GitOps, la Application `portal-prod` aparecía **Degraded** aunque el portal funcionaba (HTTPS 200, todo sano). 

- **Causa raíz**: el CronJob `dora-metrics-snapshot` (schedule diario `0 18 * * *`) era el único de los 12 que aún **no había ejecutado ningún Job** tras el redespliegue (`status: {}` vacío, `lastScheduleTime` ausente). El health check builtin de ArgoCD v3.4.2 para `batch/CronJob` marca **Degraded** un CronJob sin `lastScheduleTime`, y eso degradaba el rollup de la Application. Los demás cronjobs (con schedules más frecuentes) ya habían corrido y estaban Healthy.
- **Fix aplicado**: health check custom `resource.customizations.health.batch_CronJob` en `argocd-cm` (values del chart argo-cd en kube-stack) que trata el CronJob como Healthy (salvo `suspend: true`). Un CronJob recién creado que aún no ha llegado a su hora NO debe degradar la app.
- **Alternativa**: esperar a que el cronjob corra a su hora (a las 18:00 habría dejado de estar Degraded solo). El health check custom lo resuelve de raíz para cualquier cronjob nuevo.
- **Verificado**: tras aplicar el check, `portal-prod` pasó a `Synced/Healthy` de forma estable.


---

## 21. Kiro Analytics (sección `/kiro-analytics`) — modelo de datos y dashboards (Junio 2026)

Migración de los dashboards de uso de Kiro IDE (antes app standalone React+Vite+Amplify+Cognito, repo `kiro-analytics-dashboard`) al portal. Spec: `.kiro/specs/kiro-analytics/`. Sin Cognito ni Amplify: protegido por la sesión next-auth del portal y RBAC de sección.

### Acceso y navegación

| Campo | Valor |
|-------|-------|
| Ruta | `/kiro-analytics` (App Router, `src/app/kiro-analytics/page.tsx`) |
| Rol mínimo | `directores` (datos de productividad/uso por persona; sensible). En `rbac.ts` `SECTION_ACCESS["kiro-analytics"] = ["admin","directores"]` |
| Nav | `portal-shell.tsx` `NAV_ITEMS` id `kiro-analytics`, sección `nav.section.operations`, icono `Sparkles` |
| Home card | `src/app/page.tsx` `features[]` id `kiro-analytics`, `visibleFor: ["directores","admin"]` |
| Workspace | `src/components/kiro-analytics/kiro-analytics-workspace.tsx` — 3 tabs: Resumen, AI Insights, Actividad por usuario (esta última tras flag `ENABLE_KIRO_USER_ACTIVITY` en `feature-flags.ts`) |
| Guard API | `src/app/api/kiro-analytics/_shared.ts` — `guard()` (401/403), `parseFilters()` (valida user ids `^[0-9a-fA-F-]+$` y fechas `YYYY-MM-DD` → 400), `cachedJson()` (prefijo cache `kiro-analytics`, TTL 10 min) |

### Athena: dataset y acceso

- **Cuenta/región**: tooling `444455556666`, **eu-central-1** (Frankfurt, misma región que el bucket de logs de Kiro). NO eu-west-1.
- **Workgroup**: `kiro-analytics` · **DB Glue**: `kiro_analytics` · resultados en `s3://kiro-athena-results-444455556666-eu-central-1/`.
- **Cliente**: `src/lib/kiro-analytics.ts`. Usa las credenciales **IRSA ambientes** del portal (`portal-inventory-irsa`, mismo account) por defecto; solo hace AssumeRole si se define `KIRO_ATHENA_ROLE_ARN`. Top-level import (compatible standalone).
- **Permisos IAM**: policy inline `KiroAnalyticsAthenaRead` en `portal-inventory-irsa` (`ops/kiro-analytics-athena-policy.json`): Athena workgroup + Glue `kiro_analytics` + lectura buckets `test-kiro-logs`/`kiro-classified-data-*` + RW del bucket de resultados. Aplicada con `aws iam put-role-policy` (idempotente). **Sin ella → 500 `AccessDeniedException` en todos los endpoints.**

### Las tablas (y el gran gotcha del crawler)

El bucket de logs `test-kiro-logs` tiene, por **cuenta** (444455556666 tooling, 666777888999 retail-prod, 111222333444 digital-prod), bajo `logs/logs/AWSLogs/<acct>/KiroLogs/`:
- `by_user_analytic/` — métricas de **productividad** por usuario/día (líneas IA aceptadas, /dev, /test, chat/inline code…). Cols `userid`,`date`. **Solo digital+retail** lo generan; tooling NO.
- `user_report/` — reporte de **uso/licencia** por usuario/día (email, subscription_tier, total/auto messages, conversations, credits, mensajes por modelo Claude). **Las 3 cuentas** (incl. tooling).
- `GenerateAssistantResponse/`, `GenerateCompletions/`, `StartTaskAssistCodeGeneration/` — prompt logs JSON en tiempo real (alimentan `chat_logs_raw`, etc.).

**Gotcha raíz**: el Glue Crawler `kiro-user-activity-crawler` (diario 07:00) apuntaba a la **raíz** `AWSLogs/` con recurse → mezclaba los dos esquemas CSV incompatibles (`by_user_analytic` vs `user_report`), desalineaba columnas y corrompía `user_id` (recibía fechas/textos). El filtro `^[0-9a-f]{8}-` del dashboard era lo único que tapaba la basura → parecía que "solo había 12 filas / 1 usuario". Además el OpenCSVSerde es **obligatorio** (LazySimpleSerDe deja las comillas literales `"uuid"` y rompe el match del UUID).

**Fix de raíz (en IaC `shared-general/iac/kiro_dashboard/cloudformation_templates/kiro-analytics.yaml`, rama `feat/SRE-1825`, commit `726057c` — PENDIENTE de `terraform apply`)**:
- `UserActivityTable` (`user_activity_raw`): convertida a **tabla particionada por `account`** con *partition projection*, `Location` scoped a `KiroLogs/by_user_analytic/`, OpenCSVSerde, cols `user_id`/`report_date`. Lee todas las cuentas sin contaminación.
- `UserReportTable` (`user_report_raw`): tabla **nueva** equivalente para `KiroLogs/user_report/`, multi-cuenta, projection, OpenCSVSerde, cols alineadas al header real del CSV (`report_date,user_id,client_type,chat_conversations,credits_used,overage_*,profileid,subscription_tier,total_messages,new_user,user_email,auto_messages,claude_messages`).
- `UserActivityCrawler`: reapuntado fuera de la raíz + `Exclusions` de las carpetas de prompt-logs.

**Tablas temporales (creadas a mano vía Athena DDL, mientras no se aplica el CFN)**: `user_activity_view` (vista sobre `user_activity_multi`) y `user_report_multi`. DDL versionado en `ops/kiro-user-activity-multi-account.sql`, `ops/kiro-user-activity-view.sql`, `ops/kiro-user-report-multi-account.sql`. Nombres que el crawler (que nombra por carpeta) NO recrea. Columnas alineadas a las canónicas (`user_id`/`report_date`) para que migrar sea solo cambiar la env de tabla.

### Tablas que consume el portal (env overridables)

| Constante (env) | Default | Uso |
|-----------------|---------|-----|
| `ACTIVITY_TABLE` (`KIRO_ACTIVITY_TABLE`) | `user_activity_view` | Productividad (by_user_analytic). Tras aplicar CFN → `user_activity_raw` |
| `REPORT_TABLE` (`KIRO_REPORT_TABLE`) | `user_report_multi` | Uso/licencia (user_report). Tras aplicar CFN → `user_report_raw` |
| `KIRO_HOURLY_RATE` | 26 | €/h para el ahorro estimado del Overview |
| `KIRO_LINES_PER_HOUR` | 50 | Heurística líneas IA → horas ahorradas |

Otras tablas: `classified_prompts`/`classified_sessions` (clasificación IA de prompts, bucket `kiro-classified-data-*`), `chat_logs_raw` (prompt logs JSON, las 3 cuentas), `user_metadata` (opcional, resuelve `user_id`→email/display/primary_group; si falta se cae a Identity Store `d-93670801b4` igual que `kiro-licenses.ts`).

### Decisión de producto: productividad vs uso (camino 2, revisado jun 2026)

`by_user_analytic` (líneas de código IA) está **casi vacío** en origen (ETL de Kiro Enterprise apenas lo puebla: 6 usuarios, solo 1 con valor>0). `user_report` (mensajes/tier/créditos) tiene cobertura rica multi-cuenta (incl. EKS Tooling). Estado final de los widgets:
- **Pestaña Resumen**: "Top usuarios por código IA" y "Código IA por equipo/grupo" se alimentan de `user_report` (`total_messages`) vía `getTopByCode(users)` / `getActivityByGroup(users)` — porque con `by_user_analytic` colapsaban a un único usuario/grupo. Las etiquetas conservan el nombre "código IA" (el usuario los nombra así) aunque la métrica subyacente es mensajes.
- **Pestaña Actividad por usuario**: KPIs + tendencia + tabla "Detalle de actividad" desde `ACTIVITY_TABLE` (líneas de código, by_user_analytic — escaso pero honesto) + **sección "Uso por licencia"** (`license-usage-section.tsx`, `getLicenseUsage()`, endpoint `/license-usage`) desde `user_report` (plan, clientes KIRO_IDE/KIRO_CLI, mensajes, conversaciones, créditos).
- Pendiente (camino 3, fuera del portal): investigar por qué `by_user_analytic` está casi vacío en el tenant de Kiro Enterprise (config de user-activity logging).

### Filtros (usuario + fechas)

- **Pestaña Resumen**: selector de rango de fechas (`startDate`/`endDate`) que afecta a KPIs/overview (`activityDateClause` sobre `report_date %m-%d-%Y`, `promptsDateClause` sobre classified_prompts). Top-by-code / by-group NO se filtran por fecha (rankings globales).
- **Pestaña Actividad por usuario**: selector de usuario (`MultiSelect`) **y** selector de rango de fechas. Ambos se propagan a: tabla de actividad (`getUserActivity(users,start,end)`), tendencia (`getActivityTrend`), y TODA la sección Uso por licencia (`getLicenseUsage(users,start,end)`). Fechas de `user_report` ya en `%Y-%m-%d` → `reportDateClause` (comparación directa de strings); fechas de `by_user_analytic` en `%m-%d-%Y` → `activityDateClause` (con `date_parse`).
- Validación de inputs en `_shared.parseFilters`: user ids `^[0-9a-fA-F-]+$`, fechas `YYYY-MM-DD` → 400.

### Endpoints (`src/app/api/kiro-analytics/`)

`overview`, `users`, `user-activity` (+ `/trend`,`/wau-trend`,`/feature-adoption`,`/by-group`,`/top-by-code`), `classified/{prompts,session-stats,distribution/[field],trend,top-by-prompts,avg-prompts-per-session,weekly-ai-lines-trend,daily-usage}`, `license-usage`. Privacidad: el texto de los prompts NO se expone (solo metadatos de clasificación).

### RBAC — solo admin + directores (defensa en profundidad, 5 capas)

1. `rbac.ts` `SECTION_ACCESS["kiro-analytics"] = ["admin","directores"]`.
2. Page server component `src/app/kiro-analytics/page.tsx`: `getServerSession` + `hasSessionMinimumRole(session,"directores")` → redirect `/`.
3. API guard `_shared.guard()`: `KIRO_ANALYTICS_MIN_ROLE = "directores"` → 401/403 en TODOS los endpoints.
4. `middleware.ts`: `ROLE_RULES` `/kiro-analytics → directores` + `API_ROLE_RULES` `/api/kiro-analytics → directores`.
5. Nav (`portal-shell`) y home card (`page.tsx`) `minimumRole/visibleFor: directores+` → ni se muestran a roles inferiores.

### Despliegue a dev (gotcha CI)

El job `deploy_dev` del Toolkit (`CD/deploy-portal.yml`) solo corre si `only.refs` ∈ `[merge_requests, main, master, develop, release*]` **Y** (`$CI_COMMIT_BRANCH == main` OR `$CI_COMMIT_MESSAGE =~ /deploy-dev/`). Desde una feature branch sin MR pipeline NO despliega. Para forzar dev sin mergear: commit (o `--allow-empty`) con **`deploy-dev`** en el mensaje sobre la rama de la MR abierta. Tras el build (RC nueva en Harbor) ArgoCD sincroniza `portal-dev` (ns `platformportal`). Verificar imagen real: `kubectl -n platformportal get deploy portal-dev -o jsonpath='{.spec.template.spec.containers[0].image}'` y que el bundle trae el cambio: `kubectl -n platformportal exec deploy/portal-dev -- grep -rl '<tabla/símbolo>' /app/.next/server`.


---

## 22. AI Portal Explorer (QA crawler de solo lectura) — SRE-2210 (Junio 2026)

Job de **solo lectura** (on-demand + CronJob) que recorre `portal-dev` bajo cada rol RBAC con sesiones sintéticas, detecta anomalías de forma **determinista** (técnicas + funcionales) y pasa **solo las anomalías** por Bedrock para triage. Persiste informe + histórico (PostgreSQL + S3), notifica a Teams y detecta regresiones entre ejecuciones. Spec: `.kiro/specs/ai-portal-explorer/`.

### Arquitectura (todo en `src/lib/explorer/`)

- **Lógica pura** (testeada con PBT, fast-check, 27 Correctness Properties): `safety-guard` (solo-lectura innegociable, default-deny, fija baseURL a portal-dev), `auth-minter` (sesiones JWE NextAuth sintéticas por rol, reusa `NEXTAUTH_SECRET`), `rbac-validator` (espejo de `SECTION_ACCESS`), `route-discovery` (espejo de `NAV_ITEMS` + catálogo `/api/*`), `scenario-generator` (matriz de rangos×filtros seguros; incluye DELIBERADAMENTE `crosses-90d-boundary` 2026-01-01–03-28, el rango del bug de Gestión), `anomaly-detectors` (técnicos + funcionales: empty-state, serie truncada, paginación estancada, totales incoherentes, nulls), `triage-engine` (Bedrock ConverseCommand + presupuesto), `regression-detector`, `reporter`, `teams-notifier`.
- **I/O / orquestación**: `crawler.ts` (Playwright headless; intercepta `route()` y aborta todo método ≠ GET/HEAD), `report-store.ts` (PostgreSQL), `report-s3.ts` (S3), `orchestrator.ts` (`runExploration` — lock de ejecución única, degradación elegante, estado terminal). Runner del job en `ops/portal-explorer/run.ts`; endpoint `POST /api/explorer/run` (`x-internal-secret`, arranca en background y delega la concurrencia al lock del orquestador).

### Persistencia y modelo

Migración `migrations/2026-06-20_ai_portal_explorer.sql`: `exploration_runs`, `visit_results` (UNIQUE `(run_id, scenario_id, role)`), `anomalies`, `triage_results` (con `is_regression`, `equivalence_key`), `explorer_run_lock` (singleton `id=1`, claim atómico para no-concurrencia). Screenshots + Markdown del informe en S3; PostgreSQL guarda metadatos + evidencia JSONB + refs S3.

### Infra AWS (shared-general, MR !302)

- Bucket S3 `portal-explorer-444455556666-eu-west-1` (privado, AES256, public-access bloqueado, lifecycle 90 días) en `iac/services/s3.tf`.
- Inline policy `PortalExplorerS3Access` en `portal-inventory-irsa` (`iac/services/roles.tf`): `s3:PutObject/GetObject` sobre objetos + `ListBucket/GetBucketLocation` sobre el bucket. Bedrock ya cubierto por `BedrockInvokeModel` (incluye `inference-profile/*`). Var `EXPLORER_S3_BUCKET` (default = el bucket anterior).
- **Gotcha S3 ACL**: NO declarar `aws_s3_bucket_acl` en buckets nuevos — fallan con `AccessControlListNotSupported` (default "Bucket owner enforced", ACLs deshabilitadas). Basta `aws_s3_bucket_public_access_block` para privacidad. El primer apply de shared-general petó solo en el recurso ACL (el bucket+policy+encryption+lifecycle ya se crearon); fix = quitar el bloque ACL.

### CronJob

Declarado en `.helm/values.yaml` (`generic-chart.cronjobs.jobs`): `ai-portal-explorer`, schedule `30 2 * * *` (Europe/Madrid, off-peak), `concurrencyPolicy: Forbid`, `activeDeadlineSeconds: 3600`, imagen `tooling/portal-explorer`, sin `command:` override (usa el CMD de la imagen). `envFrom` el secret `portal-env` (lo inyecta el chart a todos los cronjobs). Habilitado solo en prod (`values-prod.yaml`).

### Gotchas de despliegue (PENDIENTES fuera del repo platformportal)

1. **Imagen con contexto repo-root**: `ops/Dockerfile.portal-explorer` se construye con **contexto repo-root** (NO `ops/`), porque el runner reusa `src/lib/explorer/*` vía alias `@/*`. Los otros aux (mr-metrics, lighthouse) son self-contained y usan contexto `ops/`. El job `build-portal-aux` del Toolkit debe tratar esta imagen como caso especial. BuildKit debe estar activo para que `ops/Dockerfile.portal-explorer.dockerignore` (que des-ignora `ops`/`src`) tenga precedencia sobre el `.dockerignore` raíz. CMD = `npx tsx ops/portal-explorer/run.ts`.
2. **generic-chart**: ✅ resuelto en MR !6 (`feat/SRE-2210`) — el template `templates/cronjob.yaml` ahora renderiza `activeDeadlineSeconds` (jobTemplate.spec) y `startingDeadlineSeconds` (CronJob spec), opcionales por job. Pendiente: mergear + que el release tag (v0.7.0) se publique y el portal/argocd consuma esa versión del chart.
3. **DB**: aplicar la migración `2026-06-20_ai_portal_explorer.sql`.

### Tests / CI

27 property tests en `src/lib/explorer/__tests__/` + unit (report-store), endpoint (`explorer-run-route`), manifiesto (`ai-portal-explorer-cronjob`). El glob de `npm test`/`test:coverage` se amplió a `src/lib/explorer/__tests__/*.test.ts` (antes solo cubría `src/lib/__tests__/`). Suite del portal: 575 tests, 573 pass, 2 skip (smoke Bedrock real `EXPLORER_BEDROCK_SMOKE=1` y e2e navegador `EXPLORER_E2E=1`, ambos gated por entorno). MR código: platformportal !259.

### Estado de despliegue (SRE-2210) y MRs

| Repo | MR | Qué |
|------|----|-----|
| platformportal | !259 | código + glob CI + `.dockerignore` (`ops/*` + `!ops/portal-explorer`) + steering |
| shared-general | !302 | bucket S3 + IRSA `PortalExplorerS3Access` — **aplicado en AWS** (bucket + policy vivos) |
| generic-chart | !6 → **merged v0.7.0** | render de `activeDeadlineSeconds`/`startingDeadlineSeconds` |
| gitlab-ci-toolkit | !212 → **merged** | `build_explorer_image` (contexto repo-root) + deploy reescribe tag del cronjob |
| argocd/tooling | !2 | cronjob `ai-portal-explorer` en `shared-apps/portal-{dev,prod}/values.yaml` + bump tgz a v0.7.0 + borrado Chart.lock |

**Migración DB**: `2026-06-20_ai_portal_explorer.sql` **APLICADA** a la RDS (vía pod efímero en n8n, `DATABASE_URL` del secret `portal-env`). 5 tablas + lock singleton verificados.

Gotchas aprendidos:
- **El cronjob real vive en argocd/tooling** `shared-apps/portal-{dev,prod}/values.yaml`, NO en `platformportal/.helm/values.yaml` (esa es plantilla; el deploy del Toolkit solo reescribe TAGS de imagen en el GitOps repo vía `yq`). Toda definición de cronjob nueva del portal hay que añadirla en argocd/tooling.
- **psql vs sslmode**: `DATABASE_URL` lleva `sslmode=no-verify` (válido para el driver `pg` de node, NO para `psql` → `invalid sslmode value`). Al usar `psql`, reescribir a `sslmode=require` (`sed s/sslmode=no-verify/sslmode=require/`).
- **kaniko + .dockerignore**: kaniko respeta SOLO el `.dockerignore` raíz del contexto (no el per-Dockerfile de BuildKit). Para el build repo-root del explorer, el raíz usa `ops/*` + `!ops/portal-explorer`.
- **generic-chart Chart.lock**: `helm dependency update` no resuelve contra el registry Helm privado de GitLab por URL (quirk auth/constraint); `helm pull <repo-alias>/...` sí. En argocd/tooling se vendoriza el `.tgz` y se BORRA el Chart.lock (ArgoCD renderiza del tgz; un lock obsoleto dispararía `helm dependency build` y rompería el sync). En `platformportal/.helm`, `Chart.lock` y `charts/*.tgz` están gitignored (se generan en build; `>=0.5.0` resuelve a v0.7.0 solo).
- `glab` instalado/autenticado (ver `tool-access.md`). Target branch por defecto: platformportal/toolkit/generic-chart/argocd-tooling=`main`, shared-general=`master`.
