# Platform Portal — Documentación Técnica Completa

> Última actualización: Junio 2026
> Versión del portal: 0.3.x
> Namespace: `n8n` (prod, deploy `portal-prod`) / `platformportal` (dev, deploy `portal-dev`) | Cluster: `dp-tooling` (EKS eu-west-1)
> Despliegue: **CI/CD + GitOps** (ArgoCD repo `argocd/tooling`, chart `generic-chart`, secretos vía ESO). Ya NO se usa `set image` manual.
> URL: https://portal.today.tooling.dp.iskaypet.com
> Truth source canónico: `.kiro/steering/portal-architecture.md` (§1 despliegue, §20 migración CI/CD+GitOps)

---

## 1. Visión General

El Platform Portal es la plataforma interna de IskayPet que centraliza ingeniería, costes cloud, calidad de código, accesos, ticketing y self-service. Sustituye decenas de scripts dispersos y consolidas en un único punto: DORA, MR analytics, FinOps multi-cuenta, OpenCost, monitorización sintética + Lighthouse, gestión de tickets bidireccional con Jira, gestión de accesos (Azure AD + GitLab + AWS), creación de infraestructura asistida por IA (Bedrock Sonnet 4), y un asistente conversacional ("Iskay") con tool-calling sobre datos reales de AWS, Kubernetes, Loki, Tempo y Prometheus.

### Stack tecnológico

| Capa | Tecnología |
|------|-----------|
| Frontend | Next.js 14 App Router (`output: standalone`), React 18, TypeScript, Tailwind CSS, shadcn/ui (Radix), Recharts |
| Backend | Next.js API Routes |
| Base de datos | PostgreSQL 16 (RDS) — 50 tablas |
| Autenticación | Azure AD (OAuth) vía NextAuth.js, sesión JWT 30 min |
| Infraestructura | Kubernetes (EKS dp-tooling), Docker, Harbor Registry |
| CI/CD | GitLab CI (Kaniko) |
| IA | AWS Bedrock — Claude Sonnet 4 (`eu.anthropic.claude-sonnet-4-20250514-v1:0`) |
| Observabilidad | Grafana Cloud (Loki, Tempo, Prometheus, Pyroscope) vía proxy de datasources |
| Idiomas | Español, Inglés, Francés, Portugués |

### URL de producción

`https://portal.today.tooling.dp.iskaypet.com`

---

## 2. Arquitectura

```
┌──────────────────────────────────────────────────────────────────┐
│                        USUARIO (Browser)                          │
│  Azure AD SSO → NextAuth JWT → RBAC                               │
│  (admin > directores > staff > desarrolladores > externos)        │
└──────────────────────────┬───────────────────────────────────────┘
                           │ HTTPS (ingress.k8s.io)
┌──────────────────────────▼───────────────────────────────────────┐
│                  KUBERNETES dp-tooling (n8n)                      │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  Deployment: n8n-webhooks (2 replicas)                    │    │
│  │  Container: n8n-webhooks                                  │    │
│  │  Image: harbor.../platformportal:<tag>                    │    │
│  │  Port: 3000                                               │    │
│  │  ServiceAccount con IRSA: portal-inventory-irsa           │    │
│  │                                                           │    │
│  │  Next.js App (Frontend + API Routes)                      │    │
│  │  ├── /api/metrics/*             → DORA, MR, Sonar         │    │
│  │  ├── /api/finops/*              → CUR, forecast, k8s, kiro│    │
│  │  ├── /api/ai/*                  → Bedrock (chat, advisor) │    │
│  │  ├── /api/access-management/*   → AWS/GitLab/Azure access │    │
│  │  ├── /api/infra-request-v2/*    → IaC con IA              │    │
│  │  ├── /api/synthetics/*          → monitores + Lighthouse  │    │
│  │  ├── /api/jira/*                → Tickets bidireccional   │    │
│  │  ├── /api/admin/*               → Analytics + actividad   │    │
│  │  ├── /api/webhooks/gitlab       → Eventos push/MR/pipeline│    │
│  │  └── /api/notifications/*       → Bell + dropdown         │    │
│  └──────────────────────────────────────────────────────────┘    │
│                                                                   │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │  CronJobs (11)                                           │    │
│  │  ─ dora-metrics-snapshot     18:00 (platformportal)       │    │
│  │  ─ k8s-metrics-snapshot      19:00 (platformportal)       │    │
│  │  ─ mr-metrics-snapshot       04:00 (mr-metrics-snapshot)  │    │
│  │  ─ ai-cost-snapshot          02:00 (platformportal)       │    │
│  │  ─ aws-health-sync           */15m (platformportal)       │    │
│  │  ─ finops-daily-digest       10:20 ES (platformportal)    │    │
│  │  ─ lighthouse-{animalis,kiwoko-es,kiwoko-pt,              │    │
│  │     tiendanimal-es,tiendanimal-pt}  Dom 03:00             │    │
│  └──────────────────────────────────────────────────────────┘    │
└───────────────────────────────────────────────────────────────────┘
                           │
          ┌────────────────┼────────────────────────┐
          ▼                ▼                        ▼
┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐
│  PostgreSQL  │  │   n8n        │  │ Sistemas externos       │
│  RDS pgsql16 │  │  webhooks    │  │ • GitLab.com            │
│  50 tablas   │  │              │  │ • SonarQube (k8s)       │
└──────────────┘  └──────────────┘  │ • Grafana Cloud (proxy) │
                                    │ • AWS multi-cuenta       │
                                    │ • Jira Cloud             │
                                    │ • Azure AD (Graph)       │
                                    │ • AWX/Ansible            │
                                    │ • MS Teams (webhook)     │
                                    │ • AWS Bedrock (Sonnet 4) │
                                    └────────────────────────┘
```

### Recursos del pod

- Deployment: `n8n-webhooks` (replicas: 2)
- Container: `n8n-webhooks` (puerto 3000)
- ServiceAccount: `default` (con anotación IRSA `eks.amazonaws.com/role-arn` → `arn:aws:iam::444455556666:role/portal-inventory-irsa`)
- Ingress: `portal.today.tooling.dp.iskaypet.com`
- Imagen: `harbor.tooling.dp.iskaypet.com/tooling/platformportal:<tag>`
- Output: `standalone` (Next.js) — los AWS SDK clients se importan top-level (un `require()` lazy en runtime falla en el runtime de standalone)

---

## 3. Conexiones Externas

### 3.1 GitLab (gitlab.com)

| Campo | Valor |
|-------|-------|
| URL | `https://gitlab.com` |
| Auth | Personal Access Token (`GITLAB_TOKEN`, secret `platformportal-secrets`) |
| Grupo raíz | `iskaypetcom` |
| Cliente | `src/lib/gitlab.ts` |
| Webhook receiver | `POST /api/webhooks/gitlab` (eventos push, MR, pipeline) |

**Datos extraídos:** proyectos, commits, deployments, pipelines, jobs, MRs (con reviews/comments), push rules, branch protections.

**Snapshots que consumen GitLab:**

- `src/lib/dora-snapshot.ts` — calcula DF/LT/CFR/MTTR a partir de pipelines, jobs y MRs.
- `ops/mr-metrics-snapshot.js` — recoge métricas por MR (time-to-PR, review time, comments, commits, lines, reviewers) sobre los 971 repos del grupo `iskaypetcom`. La función `detectTeam()` recorre los segmentos del path **left-to-right** (parent groups primero) con substring como fallback. Ejemplo: `iskaypetcom/digital/marketplace/marketplace-products-api` → team `marketplace`, no `products`.
- `src/lib/service-compliance.ts` — verifica cumplimiento de políticas por servicio.
- `src/lib/repo-catalog.ts` — sincroniza el catálogo de repositorios.

**Detección de deploy a producción** (override con env `DORA_DEPLOY_JOB_NAMES`):

```
deploy_prod, deploy-production, deploy_artifact, deploy-artifact,
deploy_prd, deploy-prd, android_playstore_prod, ios_appstore_prod,
playstore_prod, appstore_prod, distribute_prod
```

Las stages móviles (Play Store, App Store) cuentan como deploys de primer nivel.

### 3.2 SonarQube (interno, Kubernetes)

| Campo | Valor |
|-------|-------|
| URL | `http://sonarqube-sonarqube.sonarqube.svc.cluster.local:9000/api` |
| Auth | Token (`SONARQUBE_TOKEN`, secret `platformportal-secrets`) |
| Cliente | `src/lib/sonarqube.ts` |
| Snapshot | `src/lib/sonarqube-snapshot.ts` |
| Mapping | `src/lib/sonarqube-mapping.ts` (Sonar key ↔ GitLab project) |
| API | `/api/sonarqube/*` (dashboard, metrics, projects) |

Datos: cobertura, bugs, vulnerabilidades, code smells, deuda técnica, hotspots, quality gate. Persistencia en `sonarqube_metrics_daily`.

### 3.3 Grafana Cloud (proxy unificado: Prometheus + Loki + Tempo)

| Campo | Valor |
|-------|-------|
| Stack | `https://iskaylog.grafana.net` |
| Auth | Service account token (`GRAFANA_TOKEN`, secret `platformportal-secrets`) |
| Patrón | `${GRAFANA_STACK_URL}/api/datasources/proxy/uid/<uid>/<path>` |
| Cliente proxy | `src/lib/grafana-proxy.ts` |
| Cliente metrics | `src/lib/grafana-metrics.ts` |
| Cliente k8s FinOps | `src/lib/k8s-finops.ts` |

**Datasources expuestos:**

| UID | Tipo | Uso |
|-----|------|-----|
| `grafanacloud-prom` | prometheus | Métricas org (también accesible directo via `GRAFANA_METRICS_URL`/`GRAFANA_METRICS_USERNAME`/`GRAFANA_METRICS_TOKEN` con basic auth) |
| `grafanacloud-logs` | loki | Logs aplicativos (clusters dp-dev, dp-uat, dp-prd, dp-tooling) |
| `grafanacloud-traces` | tempo | Trazas distribuidas OTel |
| `grafanacloud-profiles` | pyroscope | Profiling (pendiente de cablear) |
| `cloudwatch-data-prod`, `cloudwatch-eks-prod`, etc. | cloudwatch | Métricas por cuenta AWS (10+ datasources) |

**Datos que consume el portal:**

- ArgoCD syncs (`argocd_app_sync_total`, `argocd_app_info`) → correlación deploy-incidente.
- OpenCost (`integrations/opencost`) → coste real por cluster, namespace y workload (4 clusters EKS).
- Logs y trazas → tools `search_logs`, `log_volume`, `search_traces`, `get_trace_detail` del chat Iskay.

### 3.4 AWS (multi-cuenta)

El portal opera contra ~30 cuentas AWS organizadas como AWS Organizations. Hay tres caminos para sacar coste del CUR + caminos paralelos para inventory, métricas y observabilidad.

**Path 1 — Lambda relay (executive Athena + Cost Explorer):**

- URL: `FINOPS_ATHENA_LAMBDA_URL` (default `https://jzcrsycqa2plblvxdeck37r6am0kxeqw.lambda-url.eu-north-1.on.aws/`)
- Source: `docs/aws/lambda-finops-athena.mjs`
- Acciones: `costs` (default), `forecast`, `inventory`, `accounts`
- Consumido por: `/api/finops/athena`, `/api/finops/forecast` (sin filtro accountIds), `/api/finops/accounts`
- Devuelve un payload pre-agregado: `netCost`, `pricingModel`, `dailyCosts`, `anomalies`, `topMovers`, `monthlyTrend`, `savingsPlans`, `rightsizing` (Cost Explorer)
- Limitación: el forecast del Lambda no acepta accountIds. Para forecast filtrado se usa Path 3.

**Path 2 — CUR directo vía Athena (CurFullSnapshot):**

- Cuenta CUR: `600700800900` (root-iskaypet)
- Role chain: portal IRSA `arn:aws:iam::444455556666:role/portal-inventory-irsa` → AssumeRole `arn:aws:iam::600700800900:role/Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur`
- DB Athena: `athenacurcfn_finnops.data` (CUR 2.0, eu-west-1)
- Bucket de output: `s3://finnops-iskaypet/athena-query-results/`
- Source: `src/lib/athena-cur.ts`
- Endpoint: `/api/finops/cur-direct`
- Devuelve `CurFullSnapshot` con: byAccount, byService, dailyCosts, topResources, pricingModel, savingsPlans, **byDomain** y **byEnvironment** (basado en tags), **tagCoverage**, **spDetails**, **marketplace** (separado para que los charts no muestren falsos picos de Día 1 por contratos anuales), **discounts** (SPP, bundled, credits, refunds, SP negation, tax), **hiddenCosts** (gp2, extendedSupport, cloudwatchLogs, natGateways, bedrock, snapshotCost, interZoneTransfer, gp2Detail, extendedSupportDetail), **ec2Fleet**, **tagCompliance**, **anomalyAttribution**.
- Iskay (chat) consume estos datos vía las tools `get_net_cost_breakdown`, `get_marketplace_charges`, `get_hidden_costs`.

**Path 3 — Cost Explorer SDK (forecast scoped):**

- Mismo role chain que Path 2.
- Fuente: `src/app/api/finops/forecast/route.ts`
- Activado cuando hay `accountIds` en query string.
- Llama `GetCostForecastCommand` con `Filter.Dimensions.Key=LINKED_ACCOUNT` y `GetSavingsPlansCoverageCommand` con el mismo filtro.

**Identity Store (resolución de licencias Kiro):**

- Identity Store ID: `d-93670801b4` (en `600700800900`, eu-west-1)
- Mismo role que CUR + policy inline `IdentityStoreReadOnly` con `identitystore:DescribeUser`, `identitystore:DescribeGroup`, `identitystore:ListGroupMembershipsForMember`
- Source: `src/lib/kiro-licenses.ts`
- Endpoint: `/api/finops/kiro?accountIds=<csv>` (cache 15 min por set de cuentas)
- Resuelve cada `arn:aws:identitystore:::user/<UUID>` a email + nombre + grupos SSO; las licencias Kiro vienen como `line_item_line_item_type='FlatRateSubscription'` (no `Fee`).

**Bedrock (cross-account):**

- Modelo: `eu.anthropic.claude-sonnet-4-20250514-v1:0` (configurable con `INFRA_AGENT_MODEL_ID`, `FINOPS_CHAT_MODEL_ID`)
- Región: `eu-west-1`
- Auth: STS AssumeRole desde el portal a la cuenta que tiene Bedrock habilitado (config en env)
- Cliente: `src/lib/bedrock.ts`

**Otros servicios AWS via SDK directo (con IRSA):**

| Servicio | Fichero | Uso |
|----------|---------|-----|
| CloudWatch | `src/lib/aws-cloudwatch-metrics.ts` | CPU/RAM/IOPS/conexiones, Performance Insights |
| Inventory (Resource Explorer) | `src/lib/aws-inventory.ts` | EC2, RDS, S3, Lambda, ECS, ELB, EKS, DynamoDB, ElastiCache, SNS, SQS, CloudFront, ASG |
| Account catalog | `src/lib/aws-account-catalog.ts`, `src/lib/aws-accounts.ts` | Lista cuentas activas |
| Athena CUR (direct) | `src/lib/athena-cur.ts` | CurFullSnapshot |
| Identity Store | `src/lib/kiro-licenses.ts` | Resolución de licencias por usuario SSO |
| STS / role chain | `src/lib/bedrock.ts`, `src/lib/athena-cur.ts` | AssumeRole cross-account |
| Cost Explorer | `src/app/api/finops/forecast/route.ts` | Forecast scoped por cuenta |

### 3.5 AWX (Ansible Tower)

| Campo | Valor |
|-------|-------|
| URL | `https://awx-ansible.tooling.dp.iskaypet.com/api/v2` |
| Auth | Token (`awx-token`, secret `platformportal-secrets`) |
| Datos | 55 job templates (AWS-FinOps, Soporte Tiendas, OMS, Comerzzia, Marketplace, SRE-Ops) |
| API Routes | `src/app/api/automations/awx/route.ts` |

### 3.6 Jira Cloud (bidireccional)

| Campo | Valor |
|-------|-------|
| URL | `https://iskaypet.atlassian.net` |
| API | `/rest/api/3/search/jql` (con `nextPageToken`) |
| Auth | Email (`JIRA_EMAIL`) + API Token (`JIRA_API_TOKEN`) — Basic auth |
| Cliente | `src/lib/jira.ts` |

**Endpoints expuestos por el portal:**

- `POST /api/jira/create-ticket` — Crea incidentes/requests desde el portal con priority, labels y attachments.
- `GET /api/jira/my-tickets` — Lista los tickets del usuario autenticado con filtros (proyecto, status).
- `POST /api/jira/my-tickets/close|reopen` — Transiciona el estado.
- `GET/POST /api/jira/tickets/[key]/comments` — Comentarios bidireccionales: el portal escribe directamente en Jira con prefijo `💬 Name (email):` para identificar al autor (los comments de Jira no llevan email del cliente externo). Los comments del lado Jira se renderizan parsing ese prefijo.
- `GET /api/jira/dashboard` — KPIs: cycle time, distribución por estado/tipo/prioridad, carga por persona, aging, colas Service Desk, tendencia mensual.

### 3.7 n8n (interno, Kubernetes)

| Campo | Valor |
|-------|-------|
| URL | `http://n8n.n8n.svc.cluster.local` (env `N8N_INTERNAL_URL`) |

**Webhooks activos:**

| Webhook | Uso | Trigger |
|---------|-----|---------|
| `/webhook/create-repo` | Crear repo GitLab desde template | Formulario "Crear repositorio" |
| `/webhook/user-onboarding` | Provisionar accesos a apps via grupo Azure AD | Formulario legacy (sustituido por access-management) |
| `/webhook/finops-costs` | Procesar datos de coste | Async desde portal |
| `/webhook/finops-athena` | Ejecutar queries Athena | Async desde portal |
| `/webhook/azure-inactive-users` | Reporte usuarios sin login +90d | Sección Cybersecurity (feature flag) |
| `/webhook/azure-mfa-check` | Reporte usuarios sin MFA | Sección Cybersecurity |
| `/webhook/azure-vpn-groups-report` | Reporte miembros grupos VPN | Sección Cybersecurity |

Los JSON de los flujos están en `docs/n8n/` y los de Azure en `docs/azure-flows/`.

### 3.8 Azure AD (Microsoft Graph)

| Campo | Valor |
|-------|-------|
| Tenant | `19e73cc9-78d1-4540-862c-5a89572ef80e` |
| Auth | Client credentials (app registration) — `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET` (secret `n8n-webhooks-env`) |
| Cliente | `src/lib/graph-client.ts` |
| Datos | Autenticación SSO, grupos, miembros, recientes inicios de sesión |

**Grupos relevantes para RBAC:**

| Grupo | Object ID | Rol |
|-------|-----------|-----|
| `platformadmins` | 21d068e7-... | admin |
| `platformmanagers` | a273419d-... | directores |
| `platformstaff` | ae7b9e18-... | staff |
| `platformdevelopers` | a79abcc0-... | desarrolladores |
| `platformexternos` | fe12dcbb-... | externos |

### 3.9 Microsoft Teams

| Campo | Valor |
|-------|-------|
| Webhook | `TEAMS_WEBHOOK_URL` (secret) — eventos de requests/aprobaciones SRE |
| Webhook FinOps | `FINOPS_TEAMS_WEBHOOK_URL` (secret) — dedicado al Daily FinOps Digest (sección 7.19), distinto del de SRE; lo suministra el operador |
| Uso | Notificaciones de eventos críticos (creación de repo, infra request aprobada, fallo de cronjob) + resumen FinOps diario |

### 3.10 AWS Bedrock — IA

| Campo | Valor |
|-------|-------|
| Región | `eu-west-1` (`AWS_BEDROCK_REGION`) |
| Modelo agente infra | `eu.anthropic.claude-sonnet-4-20250514-v1:0` (`INFRA_AGENT_MODEL_ID`) |
| Modelo Iskay (chat) | `eu.anthropic.claude-sonnet-4-20250514-v1:0` (`FINOPS_CHAT_MODEL_ID`) |
| API | Bedrock `ConverseCommand` con `toolConfig` (tool-calling) |
| Cliente | `src/lib/bedrock.ts` |

---

## 4. Base de Datos (PostgreSQL 16)

- Engine: PostgreSQL 16 (RDS, eu-west-1)
- Connection string en secret `platformportal-secrets` key `database-url`
- Pool: `pg` con `max: 20` connections (`src/lib/db.ts`)
- 50 tablas (alta nivel — el detalle de cada migración está en `migrations/`)

### 4.1 Tablas principales (snapshot)

| Tabla | Propósito | Migración |
|-------|-----------|-----------|
| `dora_metrics_daily` | Agregados DORA por proyecto/día | 2026-02-03_dora_daily_metrics |
| `dora_metrics_snapshots` | Raw DORA snapshot data | 2026-03-02_dora_improvements |
| `developer_activity_daily` | Actividad por desarrollador | (varias) |
| `deployment_traces` | Trazas detalladas de cada deploy | 2026-03-03_deployment_correlation |
| `production_deployments` | Deployments canónicos a prod | 2026-03-13_gitlab_deploy_canonical |
| `deployment_changes` | Commits asociados a cada deploy | (varias) |
| `gitlab_deploy_jobs` | Jobs de deploy de GitLab | 2026-03-04_deployment_correlation_pipeline_id_text |
| `gitlab_deploy_attempts` | Intentos de deploy (éxito/fallo) | (varias) |
| `gitlab_mr_analytics` | Métricas agregadas de MRs | 2026-03-03_mr_analytics |
| `mr_review_metrics` | Per-MR (time-to-PR, review time, comments, reviewers) | 2026-05-22_mr_review_metrics |
| `deployment_correlation` | Correlación GitLab ↔ ArgoCD | 2026-03-03_deployment_correlation |
| `sonarqube_metrics_daily` | Métricas SonarQube diarias | (varias) |
| `services` / `service_compliance_daily` | Catálogo + compliance diario | 2026-03-17_service_compliance_daily |
| `k8s_rollouts_daily` / `k8s_failures_daily` / `argocd_health_daily` | Métricas K8s | 2026-03-04_k8s_metrics_tables |
| `k8s_workload_mapping` | Workload K8s → proyecto GitLab | 2026-03-05_k8s_workload_mapping |

### 4.2 Tablas de FinOps y observabilidad

| Tabla | Propósito |
|-------|-----------|
| `finops_advisor_jobs` | Jobs async del asesor FinOps IA (estados, prompt, resultado) |
| `finops_daily_context` | Snapshot diario de contexto FinOps (oportunidades, calidad) |
| `ai_cost_daily` | Snapshot diario del coste de IA (Kiro + Bedrock): tendencia + anomalías (upsert por `snapshot_date`) |
| `aws_health_events` | Cache de eventos `aws.health` (EventBridge → SQS) para la sidebar de novedades (upsert por `arn`) |
| `lighthouse_audits` | Resultados Lighthouse por route + brand |
| `synthetic_monitors` / `synthetic_checks` | Monitorización sintética |

### 4.3 Tablas de portal & user-facing

| Tabla | Propósito |
|-------|-----------|
| `portal_user_activity` | Tracking de login/navegación |
| `portal_tickets` | Incidencias y requests creados desde el portal |
| `access_requests` | Solicitudes de acceso (AWS, GitLab, Azure AD) |
| `infra_requests` | Solicitudes de infraestructura |
| `repo_catalog` | Catálogo de repositorios |
| `developer_name_map` | Mapping email ↔ name |
| `user_notifications` | Notificaciones in-app |
| `user_preferences` | Settings (presets, etc.) |
| `webhook_events_raw` | Eventos GitLab raw (auditoría) |

### 4.4 Tablas de ciberseguridad

| Tabla | Propósito |
|-------|-----------|
| `cybersecurity_runs` | Ejecuciones de reportes |
| `cyber_azure_inactive_users` | Usuarios inactivos +90d |
| `cyber_azure_mfa_gaps` | Usuarios sin MFA |
| `cyber_azure_vpn_groups` | Grupos VPN |

Las migraciones SQL viven en `migrations/` con nombre `YYYY-MM-DD_descripcion.sql`. Total a fecha: 37 ficheros de migración.

---

## 5. Sistema de Snapshots y CronJobs

### 5.1 CronJobs activos

| Nombre | Schedule | Imagen | Propósito |
|--------|----------|--------|-----------|
| `dora-metrics-snapshot` | 18:00 diario | platformportal | DORA snapshot desde GitLab + ArgoCD |
| `k8s-metrics-snapshot` | 19:00 diario | platformportal | K8s rollouts, failures, health (Grafana) |
| `mr-metrics-snapshot` | 04:00 diario | mr-metrics-snapshot:latest | MR review metrics sobre los 971 repos |
| `lighthouse-animalis` | Dom 03:00 | lighthouse-scanner | Lighthouse animalis.com |
| `lighthouse-kiwoko-es` | Dom 03:00 | lighthouse-scanner | Lighthouse kiwoko.com |
| `lighthouse-kiwoko-pt` | Dom 03:00 | lighthouse-scanner | Lighthouse kiwoko.pt |
| `lighthouse-tiendanimal-es` | Dom 03:00 | lighthouse-scanner | Lighthouse tiendanimal.es |
| `lighthouse-tiendanimal-pt` | Dom 03:00 | lighthouse-scanner | Lighthouse tiendanimal.pt |
| `ai-cost-snapshot` | 02:00 diario | platformportal | Snapshot diario del coste de IA (Kiro + Bedrock) → `ai_cost_daily` |
| `aws-health-sync` | cada 15 min | platformportal | Poll SQS `aws.health` → cache `aws_health_events` |
| `finops-daily-digest` | 10:20 Europe/Madrid | platformportal | Resumen FinOps + novedades AWS → Teams (`FINOPS_TEAMS_WEBHOOK_URL`) |

### 5.2 Pipeline unificado nocturno (DORA)

**Orquestador:** `src/lib/platform-snapshot.ts` → `runUnifiedSnapshot(date)`
**API Route:** `POST /api/metrics/snapshot-all` (auth interna `x-internal-secret`)

```
Phase 1 (paralelo):
  ├── DORA           → src/lib/dora-snapshot.ts          → dora_metrics_daily, deployment_traces, production_deployments
  ├── SonarQube      → src/lib/sonarqube-snapshot.ts     → sonarqube_metrics_daily
  ├── K8s metrics    → src/lib/k8s-snapshot.ts           → k8s_rollouts_daily, argocd_health_daily
  └── Compliance     → src/lib/service-compliance.ts     → service_compliance_daily

Phase 2 (secuencial tras Phase 1):
  └── MR Analytics   → src/lib/mr-snapshot.ts            → gitlab_mr_analytics

Phase 3 (secuencial tras Phase 1):
  └── Correlation    → src/lib/deployment-correlation.ts → deployment_correlation (GitLab ↔ ArgoCD via Grafana)
```

**Protecciones:**
- `runStep(name, fn, maxRetries=2)` — backoff 5s/10s
- `runningSnapshots` Set previene duplicados por fecha
- Timeout: 30 min (route maxDuration)
- Timeout CronJob: 33 min (curl `--max-time 2000`)
- `invalidateCache()` se llama al final con prefijos (`dora:`, `sonar:`, `k8s:`, `correlation:`, `executive:`)

### 5.3 Cronjob MR review metrics (separado)

- Imagen propia: `harbor.tooling.dp.iskaypet.com/tooling/mr-metrics-snapshot:latest` (con `imagePullPolicy: Always`)
- Build: `docker buildx build --platform linux/amd64 --load -f Dockerfile.mr-metrics -t harbor.../mr-metrics-snapshot:latest .`
- Script: `ops/mr-metrics-snapshot.js`
- Recoge per-MR: `time_to_pr_hours`, `review_time_hours`, `comments_count`, `commits_count`, `lines_added`, `lines_removed`, `reviewers` (JSONB array), `team` (resuelto por path).

### 5.4 Cronjob Lighthouse (5 instancias por brand/locale)

- Imagen propia: `harbor.tooling.dp.iskaypet.com/tooling/lighthouse-scanner:<tag>`
- Script: `ops/lighthouse-scan.js`
- Manifiesto: `ops/lighthouse-cronjob.yaml`
- Persistencia: tabla `lighthouse_audits`
- UI: `src/components/synthetics/lighthouse-tab.tsx`

### 5.5 Backfill manual

| Script | Uso |
|--------|-----|
| `ops/backfill-gaps.js` | Detecta y rellena días sin snapshot |
| `ops/backfill-recent.js` | Rellena los últimos N días |
| `ops/backfill-snapshots.js` | Backfill genérico |
| `ops/k8s/backfill-job.yaml` | Job K8s para backfill |
| `ops/run-backfill-recent.sh` | Wrapper para ejecutar el job |

### 5.6 VPA recommendations pipeline (CRDs → KSM-CRS → Alloy → Grafana → Portal)

Pipeline cross-cluster que expone las recomendaciones del Vertical Pod Autoscaler como métricas Prometheus para alimentar la sub-sección "Ajuste de recursos" del portal.

**Componentes en cada cluster:**

| Capa | Recurso | Notas |
|------|---------|-------|
| VPA Controller | `vpa-recommender` + `vpa-updater` + `vpa-admission-controller` | Helm chart `autoscaler/vertical-pod-autoscaler 0.9.0` (app 1.6.0), namespace `kube-system` |
| KSM standalone | Deployment `ksm-vpa` con CustomResourceState (CRS) | Imagen `registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.17.0`, namespace `cloud-agent`, args `--custom-resource-state-only=true` |
| Discovery | Annotations `k8s.grafana.com/scrape: "true"` en el pod ksm-vpa | Alloy lo encuentra por `annotation_autodiscovery` (no por label `app.kubernetes.io/name=kube-state-metrics`, para evitar colisiones de `up`/`scrape_samples_scraped` con el KSM principal) |
| Allow rule | `clusterMetrics.kube-state-metrics.metricsTuning.includeMetrics` en el chart `grafana-k8s-monitoring` | Añade los 7 nombres `kube_customresource_verticalpodautoscaler_*` al `keep` regex de Alloy |

**Manifiestos / values:**

| Fichero | Propósito |
|---------|-----------|
| `ops/k8s/vpa-values.yaml` | Values del chart `autoscaler/vertical-pod-autoscaler 0.9.0` |
| `ops/k8s/ksm-vpa-standalone.yaml` | Deployment + Service + ConfigMap + RBAC del KSM-VPA |
| `ops/k8s/ksm-vpa-rbac.yaml` | (legacy del intento de extender el KSM principal — ya no necesario) |
| `ops/k8s/alloy-vpa-allow.yaml` | Values fragment para `helm upgrade --reuse-values` que añade las métricas al include-list de Alloy |

**Comandos canónicos para activar VPA en un cluster:**

```bash
CTX=arn:aws:eks:eu-west-1:<acct>:cluster/<cluster>

# 1. Instalar CRDs (si no están)
kubectl --context $CTX apply -f https://raw.githubusercontent.com/kubernetes/autoscaler/vertical-pod-autoscaler-1.6.0/vertical-pod-autoscaler/deploy/vpa-v1-crd-gen.yaml

# 2. Instalar el VPA controller
helm --kube-context $CTX upgrade --install vpa autoscaler/vertical-pod-autoscaler \
  --version 0.9.0 -n kube-system -f ops/k8s/vpa-values.yaml --skip-crds

# 3. Desplegar el KSM-VPA standalone
kubectl --context $CTX apply -f ops/k8s/ksm-vpa-standalone.yaml

# 4. Permitir las métricas en Alloy
helm --kube-context $CTX upgrade grafana-k8s-monitoring grafana/k8s-monitoring \
  --version 3.8.5 -n cloud-agent --reuse-values -f ops/k8s/alloy-vpa-allow.yaml

# 5. Reload de Alloy para aplicar el include-list nuevo
kubectl --context $CTX -n cloud-agent rollout restart \
  statefulset/grafana-k8s-monitoring-alloy-metrics
```

**Verificación:**

```bash
# Métricas localmente en el ksm-vpa
kubectl --context $CTX -n cloud-agent port-forward deploy/ksm-vpa 18080:8080
curl -s localhost:18080/metrics | grep -c '^kube_customresource_verticalpodautoscaler_recommendation_memory_target_bytes'

# Métricas en Grafana Cloud (~2 min después del reload)
TOKEN=$(kubectl --context arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling -n n8n exec deploy/n8n-webhooks -- printenv GRAFANA_TOKEN)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://iskaylog.grafana.net/api/datasources/proxy/uid/grafanacloud-prom/api/v1/query?query=count%20by(k8s_cluster_name)(kube_customresource_verticalpodautoscaler_recommendation_memory_target_bytes)"
```

**Estado actual (Mayo 2026):**

| Cluster | VPA Controller | KSM-VPA | Alloy include | VPAs CRs | Series en Grafana |
|---------|----------------|---------|----------------|-----------|----------------------|
| dp-dev | 1.6.0 | ✅ | ✅ | 104 (todos `Off`) | 101 |
| dp-uat | 1.6.0 | ✅ | ✅ | 44 (todos `Off`) | ~70 (escalando) |
| dp-prod | 1.6.0 | ✅ | ✅ | 0 (CRs pendientes) | 0 |

**Decisiones encoded en este pipeline:**

- KSM standalone (no extender el KSM principal), porque el wrapper `grafana-k8s-monitoring 3.8.5` filtra `customResourceState`/`extraRules` del sub-chart anidado.
- Discovery por annotations (no por labels) para evitar el "samples with different value but same timestamp" en métricas meta (`up`, `scrape_samples_scraped`) cuando dos pods comparten el `scrape_pool`.
- VPA `1.6.0` (helm chart `0.9.0`), aún si dp-dev venía corriendo `1.4.1` desplegado a mano con Lens. Migración hecha sin pérdida de recomendaciones (las CRs sobreviven el reinstalado del controller).
- VPAs en modo `Off` por defecto: solo emiten recomendación, nunca mutan pods. Cada equipo decide cuándo subir su VPA a `Initial`/`Auto`.

---

## 6. Autenticación y Autorización (RBAC)

### 6.1 Ficheros clave

| Fichero | Responsabilidad |
|---------|----------------|
| `src/lib/auth.ts` | NextAuth config (provider Azure AD, callbacks JWT/session) |
| `src/lib/rbac.ts` | Tipos y resolución de roles (`AppRole`, `resolveAppRole`, `hasMinimumRole`) |
| `src/lib/api-auth.ts` | Helpers: `requireUserAuth()`, `requireInternalAuth()`, `requireAnyAuth()` |
| `src/lib/session-role.ts` | Extracción del rol desde la sesión |
| `middleware.ts` | Protección de rutas de página y API |

### 6.2 Jerarquía de roles

| Rol | Prioridad | Acceso |
|-----|-----------|--------|
| `admin` | 5 | Todo, incluido panel admin y FinOps Iskay |
| `directores` | 4 | Todo excepto admin panel; aprobar requests; FinOps Iskay |
| `staff` | 3 | Infra, access management, métricas, FinOps (sin chat Iskay), monitorización |
| `desarrolladores` | 2 | Métricas, FinOps (sin chat), incidencias, requests, monitorización |
| `externos` | 1 | Métricas, incidencias, requests, monitorización (sin FinOps) |

Mapeo Azure AD → rol en `src/lib/rbac.ts` mediante el claim `groups` del JWT.

### 6.3 Flujo SSO

1. Usuario accede al portal → redirección a Azure AD (tenant IskayPet).
2. Azure AD devuelve JWT con claim `groups` (Object IDs de los 5 grupos `platform*`).
3. NextAuth almacena JWT en sesión (expira en 30 minutos).
4. `roleFromTokenData()` extrae el rol y lo persiste en la sesión.

### 6.4 APIs protegidas

- `/api/admin/*` → `admin`
- `/api/ai/finops-chat` → `admin` o `directores` (Iskay) — devuelve 403 al resto
- `/api/metrics/*`, `/api/sonarqube/*`, `/api/finops/*`, `/api/synthetics/*`, `/api/inventory/*`, `/api/access-management/*`, `/api/infra-request-v2/*` → según rol mínimo en `middleware.ts`
- APIs internas (cronjobs/n8n) excluidas del middleware de usuario, validan `x-internal-secret` (`INTERNAL_API_SECRET`):
  - `/api/metrics/snapshot`, `/api/metrics/snapshot-all`, `/api/metrics/backfill`, `/api/metrics/correlate`, `/api/metrics/compliance-snapshot`, `/api/metrics/k8s-snapshot`
  - `/api/sonarqube/snapshot`, `/api/gitlab/mr-snapshot`
  - `/api/synthetics/rollup`, `/api/synthetics/run`
  - `/api/cybersecurity/intake`, `/api/reliability/incidents/intake`
  - `/api/webhooks/gitlab` (firma verificada)

### 6.5 Domain handling

Email normalization en todas las comparaciones — los usuarios pueden tener `@iskaypet.com` y `@emefinpetcare.com` indistintamente; los externos `@ext.emefinpetcare.com`. Helper canónico: `emailsMatch()` en `src/lib/access-management/domain-normalizer.ts`. La cadena de búsqueda de aprobador usa: email exacto → swap `@iskaypet ↔ @emefinpetcare` → `@ext` variant → fallback por nombre.



---

## 7. Funcionalidades del Portal

### 7.1 Métricas DORA (`/metrics`)

Componente principal: `src/components/metrics/engineering-dashboard.tsx`. Pestañas: **DORA**, **Gestión** (team activity), **MR Review**, **SonarQube**, **Manager dashboard**.

**Ficheros clave:**

| Fichero | Responsabilidad |
|---------|----------------|
| `src/components/metrics/engineering-dashboard.tsx` | Dashboard principal |
| `src/components/metrics/team-activity-tab.tsx` | Pestaña Gestión |
| `src/components/metrics/mr-details-table.tsx` | Tabla per-MR (review metrics) |
| `src/components/metrics/period-comparison.tsx` | Comparación de periodos |
| `src/components/metrics/metrics-actions.tsx` | Acciones (export, feedback) |
| `src/components/metrics/shared/dora-benchmarks.tsx` | Umbrales Elite/High/Medium/Low |
| `src/components/metrics/shared/dora-performance-badge.tsx` | Badge de performance |
| `src/lib/metrics-dashboard.ts` | Queries y agregaciones (cache key incluye from/to) |
| `src/lib/metrics-formulas.ts` | Fórmulas puras DORA |
| `src/lib/dora-snapshot.ts` | Generador de snapshots |
| `src/lib/gitlab-governance.ts` | Constantes detección de deploys |

**APIs:**

- `GET /api/metrics/dora-core` — datos agregados DORA
- `GET /api/metrics/lead-time`, `/api/metrics/deployment-frequency`, `/api/metrics/change-failure-rate`, `/api/metrics/mttr`
- `GET /api/metrics/traces` — trazas detalladas de lead time
- `GET /api/metrics/projects`, `/api/metrics/teams`, `/api/metrics/developers`
- `GET /api/metrics/manager-dashboard`
- `GET /api/metrics/mr` — agregados de MR
- `GET /api/metrics/mr-details` — listado per-MR (review time, comments, etc.)
- `GET /api/metrics/team-activity` — contributors con MR stats
- `GET /api/metrics/executive-summary` — resumen ejecutivo cacheado
- `POST /api/metrics/feedback` — feedback con imagen y checklist (crea ticket Jira)
- `POST /api/metrics/snapshot` / `snapshot-all` / `backfill` / `correlate` / `compliance-snapshot` / `k8s-snapshot` — interno

**Fórmulas (`src/lib/metrics-formulas.ts`):**

| Métrica | Fórmula |
|---------|---------|
| Deployment Frequency | `calculateDeploymentFrequencyPerProjectDay(deploys, projectDays)` |
| Lead Time | `pickPreferredLeadTimeHours(lastCommit, mr, firstCommit)` — prioridad: first commit > MR > last commit; mediana del resultado; constante `CANONICAL_LEAD_TIME_VARIANT` |
| Change Failure Rate | `calculateChangeFailureRatePct(deploys, failures)` |
| MTTR (Pipeline Recovery Time) | Tiempo entre fallo y siguiente éxito en el mismo scope |
| Sonar Risk Score | `vulns×4 + bugs×2 + hotspots×1.5 + (gate==ERROR?20:0) + max(0, 80-coverage)` |

**Custom date range + period comparison:** El dashboard acepta `from`/`to` (YYYY-MM-DD). Cuando ambos están presentes, ganan sobre `days`. La cache key de `getDoraCoreDashboard` incluye `days`, `from`, `to`, `teams`, `projectIds`, `includeClusterSignals`.

**Confidence Score:** Score 0-100 basado en cobertura de lead time, confianza de correlaciones y ausencia de anomalías. Visible como badge.

**Umbrales configurables:** `DORA_MAX_LEAD_TIME_HOURS`, `DORA_DF_ANOMALY_THRESHOLD`, `DORA_MIN_CORRELATION_CONFIDENCE`.

### 7.2 Team Activity (Gestión)

**Componente:** `src/components/metrics/team-activity-tab.tsx`
**API:** `GET /api/metrics/team-activity?days=30&teams=basket,mobile&projectIds=...`
**Fuente:** `gitlab_mr_analytics` (snapshot nocturno).

Métricas por persona: MRs mergeadas, tiempo medio de merge, reviews dados (extraídos de campo JSONB `reviewers`), último merge, MRs abiertas. Username de GitLab (`author_username`) como clave — sin fusión de identidades, sin commits ni líneas.

Vista: scorecards responsive con badge activo/inactivo + filtros (Todos/Activos/Sin actividad). Click en una persona → últimas 5 MRs mergeadas con link a GitLab.

### 7.3 MR Review (per-MR analytics)

**Componente:** `src/components/metrics/mr-details-table.tsx`
**API:** `GET /api/metrics/mr-details`
**Tabla DB:** `mr_review_metrics`
**CronJob:** `mr-metrics-snapshot` (04:00 diario, imagen separada `mr-metrics-snapshot:latest`)
**Script:** `ops/mr-metrics-snapshot.js`

Recoge por MR:

- `time_to_pr_hours` — tiempo desde primer commit hasta apertura del MR
- `review_time_hours` — desde apertura hasta merge
- `comments_count` — comentarios en el MR
- `commits_count`, `lines_added`, `lines_removed`
- `reviewers` (JSONB array) — quién aprobó/comentó
- `team` — resuelto via `detectTeam()` (path left-to-right, parent groups primero)

### 7.4 Calidad de Código — SonarQube

**Componentes:** `src/components/sonarqube/` (panel standalone) + pestaña en engineering-dashboard
**APIs:** `/api/sonarqube/*` (dashboard, metrics, projects)
**Snapshot diario** persiste en `sonarqube_metrics_daily`.

Datos: cobertura media, vulnerabilidades, deuda técnica, tendencia histórica, riesgo agregado, portfolio con export Excel, mapping SonarQube ↔ GitLab por nombre.

### 7.5 Espacio FinOps (`/finops`)

`src/components/finops-workspace.tsx` orquesta cuatro pestañas: **Costes**, **Inventario**, **EKS Allocation**, **Asesor FinOps**. En las cuatro, hay un botón flotante que abre el chat **Iskay** (solo visible para admin/directores).

#### 7.5.1 Pestaña Costes (CUR + executive + AI cost analysis)

**Componente principal:** `src/components/finops/costs-dashboard.tsx`

Secciones plegables (`<FinOpsSection>`):

1. **Executive Summary** (`executive-summary.tsx`) — KPIs de coste, savings, anomalías.
2. **Net Cost Waterfall** — descomposición gross → discounts → marketplace → net.
3. **Top Movers** (`cost-movers-card.tsx`) — Top services/accounts con mayor variación período-período.
4. **Anomaly Timeline** (`anomaly-timeline-card.tsx`) — clickable con drill-down al detalle por servicio + recurso.
5. **AWS Rightsizing Recommendations** (`aws-rightsizing-card.tsx`) — Cost Explorer.
6. **Cost Trend** (`CostTrendChart.tsx`, `MonthlyCostTrendChart.tsx`).
7. **Service Comparison** (`ServiceComparisonChart.tsx`).
8. **Account Breakdown** (`AccountBreakdownTable.tsx`).
9. **Savings Plans** (`SavingsPlansCard.tsx`) — coverage + détalle SP.
10. **CUR Deep Insights** (`cur-deep-insights.tsx`) — sub-secciones: hidden costs (gp2, RDS Extended Support, CloudWatch Logs, NAT GW data, Bedrock por modelo, snapshots, inter-AZ), gp2 migration plan, RDS Extended Support detail, Bedrock 3-month trend, EC2 Fleet por instance type, Tag compliance, Allocation por dominio/entorno (basado en tags).
11. **Forecast** (`forecast-panel.tsx`) — scoped a las cuentas seleccionadas. Sin `accountIds` → Lambda relay; con `accountIds` → Cost Explorer SDK directo (`Filter.Dimensions.Key=LINKED_ACCOUNT`).
12. **Costes de IA** (`kiro-licenses-card.tsx`, `ai-cost-history-card.tsx`) — Bedrock + Kiro (suscripciones por usuario). Tab unificado con resolución de Identity Store (UUID → email + nombre + grupos). El `AiCostHistoryCard` añade una **gráfica de tendencia histórica** del coste de IA (área apilada Kiro + Bedrock por día) alimentada por la tabla `ai_cost_daily`: a diferencia del CUR (que devuelve agregados puntuales por rango), aquí se persiste un snapshot diario que permite ver evolución y resaltar los días anómalos (los que superan `media + 2·desviación` y `1,5·media` de la ventana). Respeta el filtro de cuentas del dashboard y el control de acceso FinOps (`externos` no acceden). Estado vacío informativo mientras se construye el histórico. Fuente: `GET /api/finops/ai-cost/history`.
13. **Quick filters** (`QuickFilters.tsx`) + **Account multi-select** (`AccountMultiSelect.tsx`) + **Excel export** (`ExcelExportButton.tsx`).

**APIs FinOps:**

- `GET /api/finops/costs` / `forecast` / `accounts`
- `GET /api/finops/athena` (Lambda relay)
- `GET /api/finops/cur-direct` (Athena directo)
- `GET /api/finops/credits` — créditos AWS
- `GET /api/finops/k8s-allocation` (OpenCost)
- `GET /api/finops/kiro?accountIds=<csv>` — licencias Kiro per-user
- `POST /api/finops/ai-cost/snapshot` (interno) — persiste el snapshot diario del coste de IA en `ai_cost_daily`; `GET /api/finops/ai-cost/history?startDate&endDate&accountIds=csv` — serie temporal para la gráfica

**CUR notes:**

- CUR 2.0, columnas reducidas. Disponibles: `product_instance_type`, `product_instance_family`, `product_region_code`, `product_servicecode`, `product_pricing_unit`, `product_product_family`, `product_location`. NO disponibles: `product_volume_api_name`, `product_database_engine`, `product_storage_class` (se derivan parsing `line_item_usage_type`).
- Marketplace contracts: `line_item_product_code LIKE 'cg%'` OR `usage_type` `Global-SoftwareUsage-Contracts` o `MP:%`. Se separan en bucket aparte para no mostrar falsos picos en daily charts (contratos anuales se cobran Día 1).
- Tag coverage real (Mayo 2026): ~3.7% del coste tiene `user_domain` como tag consistente. Tags obligatorios: `user_department`, `user_domain`, `user_environment`. Compliance por tag se calcula en `tagCompliance`.

#### 7.5.2 Pestaña Inventario (`/inventory` + dashboard FinOps)

**Componentes:** `src/components/inventory/aws-inventory-dashboard.tsx`, `inventory-kpi-bar.tsx`
**API:** `GET /api/inventory` — collectors de 13 servicios (`src/lib/aws-inventory.ts`)

Servicios collectados: EC2, RDS, S3, Lambda, ECS, ELB, EKS, DynamoDB, ElastiCache, SNS, SQS, CloudFront, ASG.

El badge de coste por recurso se calcula con CUR real cuando es posible (badge **CUR**) o con heurística estimada (badge **est.**).

#### 7.5.3 Pestaña EKS Allocation (OpenCost)

**Componente:** `src/components/finops/k8s-allocation-dashboard.tsx`
**API:** `GET /api/finops/k8s-allocation` (cache 5 min)
**Fuente:** Grafana Cloud — job `integrations/opencost`
**Source code:** `src/lib/k8s-finops.ts`

Datos: coste por cluster, namespace, workload (CPU + RAM), top consumers, rightsizing por workload, load balancers, network egress, cluster health.

**Métricas OpenCost clave:**

| Métrica | Labels |
|---------|--------|
| `node_total_hourly_cost` | k8s_cluster_name, node, instance_type, provider_id, region |
| `node_cpu_hourly_cost` / `node_ram_hourly_cost` / `node_gpu_hourly_cost` | igual |
| `container_cpu_allocation` | k8s_cluster_name, namespace, pod, container, node |
| `container_memory_allocation_bytes` | igual |
| `kubecost_cluster_management_cost` | k8s_cluster_name |
| `kubecost_load_balancer_cost` | k8s_cluster_name, ingress_ip |
| `kubecost_network_internet_egress_cost` / `region_egress_cost` / `zone_egress_cost` | k8s_cluster_name |
| `kubecost_node_is_spot` | per node |

**Fórmula rightsizing (`k8s-finops.ts`):**

- `target_cpu = max(p95_cpu_7d / 0.5, 0.1 cores * pod_count)` — 50% headroom, suelo 100m
- `target_ram = max(p95_ram_7d / 0.7, 0.125 GiB * pod_count)` — 30% headroom, suelo 128 MiB
- `savings = (allocated - target) * unit_cost`, capped al 70% del coste actual
- Skip pods con <60 min uptime en 7d (cronjobs/jobs)

**Gotcha:** La división `/(1024*1024*1024)` debe ir DENTRO del `sum by(...)` para preservar la label `k8s_cluster_name`. El test `kubecost_node_is_spot == 1` requiere agregación explícita en Mimir: `count by(k8s_cluster_name) (kubecost_node_is_spot > 0)`.

#### 7.5.3.bis Sub-sección "Ajuste de recursos" (VPA recommendations)

Sub-sección de la pestaña EKS Allocation que muestra las recomendaciones de Vertical Pod Autoscaler (VPA) por workload, comparando los `requests` actuales contra el `target` recomendado y permitiendo a cada squad ver qué microservicios están sobre-dimensionados o infra-dimensionados.

**Componentes:**

| Fichero | Responsabilidad |
|---------|----------------|
| `src/lib/k8s-vpa.ts` | Lógica core: PromQL contra Grafana, classifyRatio (port del Python), pivote VPA↔requests↔limits↔HPA, savings con OpenCost real, squad mapping, builder de YAML "copiar valores" |
| `src/app/api/finops/vpa/route.ts` | `GET /api/finops/vpa?cluster=dp-dev[&status=...&includeSidecars=true]`, RBAC `desarrolladores`, cache 5 min |
| `src/components/finops/k8s-vpa-table.tsx` | Tabla con filtros, badges, agregado por squad y drawer expandible con YAML |

**Fuentes de datos:**

- Recomendaciones VPA: `kube_customresource_verticalpodautoscaler_recommendation_{cpu,memory}_{target,lowerbound,upperbound}_*` (expuesto por un KSM standalone con CustomResourceState — ver sección 5.6).
- Requests/limits actuales: `kube_pod_container_resource_{requests,limits}` (KSM principal de Grafana k8s-monitoring).
- HPA conflict detection: `kube_horizontalpodautoscaler_info`.
- Precio real $/core-mes y $/GiB-mes: `node_cpu_hourly_cost` y `node_ram_hourly_cost` de OpenCost (no hardcoded).

**Clasificación visual** (replica `ratio_label()` del script Python de referencia):

| Estado | Rango `request/target` | Significado |
|--------|------------------------|-------------|
| 🔴 SOBRE | `r ≥ 3` | Muy sobre-dimensionado |
| 🟠 sobre | `1.5 ≤ r < 3` | Sobre-dimensionado |
| 🟢 ok | `0.7 ≤ r < 1.5` | Bien |
| 🟡 infra | `0.4 ≤ r < 0.7` | Infra-dimensionado |
| 🔴 INFRA | `r < 0.4` | Muy infra-dimensionado, riesgo OOM |

**Decisiones de diseño aplicadas:**

- **Memory copy-to-yaml** usa `upperBound` (defensivo contra OOMs).
- **CPU copy-to-yaml** usa `target` (eficiencia).
- **Sidecars conocidos** (`istio-proxy`, `linkerd-proxy`, `cloudsql-proxy`, `oauth2-proxy`, `vault-agent`, `envoy`) se excluyen por defecto. Toggle "incluir sidecars" disponible.
- **Ahorro €** se calcula con OpenCost real ponderado por cluster, no precio fijo.
- **HPA conflict** se detecta con `kube_horizontalpodautoscaler_info` y se muestra warning en el drawer.

**Filtros de la UI:** cluster, status (todos/sobre/infra/ok), squad, namespace search, includeSidecars.

**Drawer de detalle al hacer click:** muestra lower/target/upper para CPU+RAM, request/limit actuales, badge HPA si aplica, y bloque YAML listo para pegar en `values.yaml`.

#### 7.5.4 Pestaña Asesor FinOps (jobs async + Iskay flotante)

**Componente:** `src/components/inventory/finops-advisor.tsx` y `finops-advisor-page.tsx`
**Orquestador:** `src/lib/finops-advisor-runner.ts` → `runFinOpsAdvisorAnalysis()`
**API:** `POST /api/ai/finops-advisor` (lanza job), `GET /api/ai/finops-advisor/jobs` (lista)
**Persistencia:** `finops_advisor_jobs`

Genera un informe markdown con:

1. fetching_inventory — `fetchInventory(accountIds)` 13 servicios
2. collecting_metrics — CloudWatch (CPU/RAM/IOPS/conexiones) en batches de 3, últimos 14 días
3. fetching_costs — Lambda CUR
4. building_prompt — `buildFinOpsAdvisorInsights()` análisis determinista pre-modelo (oportunidades, gaps, calidad) + `buildFinOpsPrompt()` prompt masivo multiidioma
5. generating_report — Bedrock Sonnet 4 (`maxTokens: 5120`, `temperature: 0.2`)

Tablas de pricing integradas en `src/lib/finops-advisor.ts`: EC2 (40+ tipos), RDS (15+), ElastiCache, EBS, NAT, LB, EIP libre.

### 7.6 Iskay — FinOps Chat (Bedrock tool-calling)

**Componentes:**
- `src/components/finops/finops-chat.tsx` — modal de chat
- `src/components/finops/finops-chat-floating.tsx` — botón flotante, montado en `FinOpsWorkspace`, visible en las 4 pestañas

**API:** `POST /api/ai/finops-chat`
**Tools (~22):** `src/lib/finops-tools.ts`
**Modelo:** `eu.anthropic.claude-sonnet-4-20250514-v1:0` (`FINOPS_CHAT_MODEL_ID`)
**Loop:** Bedrock `ConverseCommand` con `toolConfig`; max 6 iteraciones; ejecución paralela de tools por turno
**Acceso:** **admin o directores** únicamente (servidor 403, cliente null para resto)

**Catálogo de tools:**

| Categoría | Tools |
|-----------|-------|
| AWS Cost (Lambda + CUR direct) | `list_accounts`, `get_total_cost`, `get_cost_by_account`, `get_cost_by_service`, `compare_periods`, `get_forecast`, `get_top_resources`, `get_daily_context`, `get_net_cost_breakdown`, `get_marketplace_charges`, `get_hidden_costs` |
| Kubernetes (OpenCost) | `get_k8s_clusters_cost`, `get_k8s_top_namespaces`, `get_k8s_top_workloads`, `get_k8s_workload_detail`, `get_k8s_rightsizing`, `get_k8s_load_balancers`, `get_k8s_network_egress`, `get_k8s_cluster_health` |
| Inventario | `get_inventory_summary`, `search_inventory` |
| Observabilidad (Grafana proxy) | `search_logs` (Loki LogQL), `log_volume`, `search_traces` (Tempo TraceQL), `get_trace_detail`, `query_prometheus` (escape hatch) |

### 7.7 Monitorización Sintética + Lighthouse (`/synthetics`)

**Componentes:**
- `src/components/synthetics/synthetic-dashboard.tsx`
- `src/components/synthetics/monitor-management.tsx`
- `src/components/synthetics/monitor-detail-dialog.tsx`
- `src/components/synthetics/external-status.tsx`
- `src/components/synthetics/lighthouse-tab.tsx`

**APIs:** CRUD monitores + run/rollup/stats/metrics/export/lighthouse + `external-status`. Métricas Prometheus expuestas en `/api/synthetics/metrics` para scraping.

**Tablas:** `synthetic_monitors`, `synthetic_checks`, `lighthouse_audits`.

**Lighthouse:** 5 cronjobs (Domingo 03:00) escanean animalis, kiwoko.com, kiwoko.pt, tiendanimal.es, tiendanimal.pt. Imagen `lighthouse-scanner`, script `ops/lighthouse-scan.js`.

### 7.8 Tickets bidireccional (`/tickets`)

**Componentes:** `src/components/tickets/`
**APIs:** `/api/jira/create-ticket`, `/api/jira/my-tickets`, `/api/jira/my-tickets/close|reopen`, `/api/jira/tickets/[key]/comments`
**Tabla:** `portal_tickets`

Flujo:

1. Usuario crea incident/request desde el portal — `POST /api/jira/create-ticket` con priority, labels, attachments.
2. El ticket se persiste en `portal_tickets` y se crea el issue en Jira (proyecto SRE).
3. Comentarios bidireccionales: el portal escribe en Jira con prefijo `💬 Name (email):` y los lee de vuelta parsing ese prefijo (Jira no expone email del cliente externo en sus comments).
4. Transiciones: close/reopen con valida de estado actual.

### 7.9 Admin Analytics (`/admin`)

**Componente principal:** `src/components/admin/admin-analytics-dashboard.tsx`
**Sub-componentes:** `src/components/admin/analytics/` (8 tabs)

| Tab | Componente | API |
|-----|------------|-----|
| Overview | `overview-tab.tsx` | `/api/admin/analytics/overview` |
| Engagement | `engagement-tab.tsx` | `/api/admin/analytics/engagement` |
| Tickets | `tickets-tab.tsx` | `/api/admin/analytics/tickets` |
| Approvals | `approvals-tab.tsx` | `/api/admin/analytics/approvals` |
| Access | `access-tab.tsx` | `/api/admin/analytics/access` |
| Repos | `repos-tab.tsx` | `/api/admin/analytics/repos` |
| Infra | `infra-tab.tsx` | `/api/admin/analytics/infra` |
| User detail | (drill-down) | `/api/admin/analytics/user-detail?email=...` |

Componentes auxiliares: `analytics-skeleton.tsx`, `error-card.tsx`, `kpi-card.tsx`, `trend-indicator.tsx`.

**Activity tracking:**
- `src/lib/activity-client.ts` — `trackClientActivity()` envía eventos desde el cliente.
- `src/components/admin/activity-tracker.tsx` — wrapper.
- Endpoints internos: `POST /api/admin/activity/track`, `GET /api/admin/activity/events`, `GET /api/admin/activity/summary`.
- Tabla: `portal_user_activity`.

### 7.10 Solicitudes de Infraestructura con IA (`/infra-requests`)

**Componentes:** `src/components/infra-request-v2/`, `src/components/infra-requests/`
**APIs:** `/api/infra-request-v2/{generate,modify,list-resources}`, `/api/infra-assistant/{chat,submit,execute/[id]}`, `/api/infra-requests/*`

**Ficheros lib:**

| Fichero | Responsabilidad |
|---------|----------------|
| `src/lib/infra-agent.ts` | Agente IA con tool-use (Bedrock ConverseCommand) |
| `src/lib/infra-prompt-builder.ts` | Constructor de prompts por tipo de recurso |
| `src/lib/infra-cost-estimator.ts` | Estimador de costes (RDS, S3, IAM) |
| `src/lib/infra-resource-parser.ts` | Parser de recursos existentes |
| `src/lib/infra-approvers.ts` / `team-approvers.ts` | Resolución de aprobador con cascade reporter |
| `src/lib/terraform-validator.ts` | Validador HCL (braces, strings, var refs, resource names, count) |
| `src/lib/secret-scanner.ts` | Scanner de secretos en HCL |
| `src/lib/field-validators.ts` | Validadores RDS/S3/IAM |
| `src/lib/resource-scope-verifier.ts` | Verificador de scope en modificaciones |
| `src/lib/rate-limiter.ts` | Rate limiter in-memory (10 req/hora por usuario) |
| `src/lib/logger.ts` | Logger estructurado JSON |

**Modelo:** `INFRA_AGENT_MODEL_ID` = `eu.anthropic.claude-sonnet-4-20250514-v1:0`. Tools read-only: `read_repo_tree`, `read_file`, `list_existing_tf_resources`, `read_tf_module_readme`.

**Flujo:**

1. Usuario rellena formulario (RDS / S3 / IAM Role) con tipo, equipo, campos específicos, entornos.
2. `validateRdsFields` / `validateS3Fields` / `validateIamRoleFields` — HTTP 400 si inválido.
3. Rate limiting (10 req/hora) — HTTP 429 si excedido.
4. `InfraAgent` lee el repo del equipo via tools, copia patrones existentes, genera Terraform.
5. Usuario revisa preview + estimación.
6. Manager aprueba (cascade reporter en `team-approvers.ts`).
7. Ejecución: validación HCL → secret scanning → branch + commit + MR + Jira issue + Teams notification.

**Modify:** `POST /api/infra-request-v2/modify` recibe `currentContent` (string) + `terraformPreview` (objeto `TerraformPreview` con `.content`) y usa `verifyModifyScope(currentContent, terraformPreview.content, resourceName)`.

**Tabla:** `infra_requests`. Estados: `pending` → `approved` → `executed` / `execute_failed` / `rejected`.

### 7.11 Gestión de Accesos (`/access-management`)

**Componentes:**
- `src/components/access-management/access-request-form.tsx`
- `src/components/access-management/kiro-license-form.tsx`

**APIs:** `/api/access-management/{request, [id], execute, groups, pending, portal-role}`

**Tipos de acceso:**

| Tipo | Destino | API utilizada |
|------|---------|---------------|
| Azure AD Group | Grupos de seguridad, VPN, distribución | Microsoft Graph |
| GitLab Group/Project | Permisos GitLab (Developer/Maintainer/Guest) | GitLab API |
| AWS account/role | Acceso a cuentas AWS | A través del flujo aprobador |
| Kiro license | Pro $20 / Pro+ $40 / Power $200 | Form dedicado |

**Flujo:**

1. Usuario solicita acceso. La cascade reporter identifica al manager (email exacto → swap dominio → `@ext` variant → name fallback).
2. Manager aprueba/rechaza desde el portal.
3. Ejecución automática post-aprobación.
4. Notificación al solicitante via `user_notifications`.

**Tabla:** `access_requests`. Estados: `pending` → `approved` → `executed` / `rejected` / `execute_failed`. Migración 2026-05-06 añadió `business_team`.

### 7.12 Sistema de Notificaciones

**Componente:** `src/components/notification-bell.tsx` — campana con dropdown, polling 30s al endpoint lightweight `/api/notifications/count`.
**Lib:** `src/lib/notifications.ts` — `createNotification()`, `createNotificationBatch()`.
**APIs:** `/api/notifications` (list), `/api/notifications/count` (count unread), `/api/notifications/read` (mark read).
**Tabla:** `user_notifications` con `metadata` JSONB.

Tipos: `approval_request`, `approval_result`, `system`, `info`. La búsqueda usa email normalization para soportar `@iskaypet ↔ @emefinpetcare`.

### 7.13 Webhooks GitLab (auditoría)

**Endpoint:** `POST /api/webhooks/gitlab` (firma verificada)
**Tabla:** `webhook_events_raw`
**Eventos:** push, MR open/update/close/merge, pipeline status

Permite reconstruir trazabilidad completa de cambios sin depender solo de polling de la API.

### 7.14 Self-service repo + onboarding

**Crear repositorio (`/create-repo`):**
- Componente: `src/components/gitlab-repo-form.tsx`
- API: `POST /api/create-repo` → reenvía a webhook n8n `/webhook/create-repo`
- Templates: go-microservices, frontend-headless, springboot-microservices, fastapi-microservices, springboot-library, headless-template-multi-brand
- Flujo n8n: `docs/n8n/create-repo-flow.json`

**Onboarding (`/user-onboarding` — legacy, sustituido por access-management):**
- API: `POST /api/user-onboarding` → webhook `/webhook/user-onboarding`
- Flujo n8n: `docs/n8n/user-onboarding-flow.json`

### 7.15 Cybersecurity (oculto, feature flag)

**Componente:** `src/components/cybersecurity-workspace.tsx`
**APIs:** `/api/cybersecurity/intake` (interno, recibe datos de n8n) + clientes en `src/lib/cybersecurity.ts`, `cybersecurity-live.ts`
**Tablas:** `cybersecurity_runs`, `cyber_azure_inactive_users`, `cyber_azure_mfa_gaps`, `cyber_azure_vpn_groups`

Reportes generados por n8n: usuarios inactivos, MFA gaps, grupos VPN. Detrás del flag `ENABLE_CYBERSECURITY=false`.

### 7.16 Infraestructura self-service (`/infra-requests`)

Un único punto para provisionar y modificar infraestructura, con tres modos:

**1. Crear recurso (infra crítica SRE)** — RDS, S3, IAM Role en el repo de Terraform del equipo. El agente de IA (Bedrock) lee el repo, copia el patrón existente y genera el `.tf`. Las RDS fuerzan rotación de contraseña master cada 15 días (Secrets Manager) en 3 capas (prompt builder, system prompt, validador en execute). Los roles IAM siguen mínimos privilegios (read/write scoped, nunca `*FullAccess`, nunca políticas RDS).

**2. Modificar existente** — cambia atributos de un recurso ya creado leyendo el `.tf` real y editándolo con IA (`verifyModifyScope` garantiza que solo toca el recurso objetivo). RDS modificable: clase de instancia, almacenamiento (solo ampliar), max autoscaling, multi-AZ, versión PostgreSQL (solo subir), retención backup, performance insights. `deletion_protection` NO es modificable (salvaguarda anti-borrado).

**3. Infra de squad** — recursos del día a día (SQS, Secret, DynamoDB, SNS, EventBridge) en el repo de cada squad. Generación con plantillas deterministas (no IA). Sub-modo "Modificar" para reconfigurar SQS/EventBridge/DynamoDB y rotar valores de secrets. Los valores sensibles de secrets se inyectan como variables CI/CD de GitLab (masked), nunca en la BD del portal.

**Flujo común:** todas las solicitudes (crítica y squad) pasan por la misma tabla `infra_requests`, el mismo flujo de aprobación por equipo (Teams + email + notificación in-app), y al aprobarse generan branch + MR + ticket Jira. 

**Notificación "creado de verdad":** el cronjob `infra-live-check` (cada 10 min) consulta AWS directamente por entorno (rol read-only `n8n-cost-reader-role`) y avisa al solicitante cuando el recurso existe REALMENTE en todos los entornos pedidos — no cuando arranca la pipeline (que puede tardar o dar timeout). Para RDS incluye el ARN del secret con las credenciales del admin.

**APIs:** `/api/infra-request-v2/{generate,modify}`, `/api/infra-assistant/{submit,execute/[id]}`, `/api/infra-requests/{,[id]/review,[id]/cancel,live-check}`, `/api/squad-infra/{squads,preview,request,modify,update-secret,list-resources,buses}`
**Catálogos:** `repo_catalog` (infra crítica), `squad_repo_catalog` (17 squads)

### 7.17 Histórico del coste de IA (pestaña Costes)

Gráfica de tendencia del coste de inteligencia artificial (licencias Kiro + inferencia Bedrock) a lo largo del tiempo, dentro de la sección "Costes de IA" de la pestaña Costes de FinOps.

**Por qué existe:** el CUR devuelve agregados por rango, no una serie temporal estable. Sin persistencia no se podía ver si el gasto de IA crece, cae o tiene picos (el caso real: un job EMR consumió ~700 € de Bedrock en un solo día en cuentas de Data). Ahora un snapshot diario guarda el desglose del coste de IA y construye el histórico.

**Qué muestra el usuario:**

- Una gráfica de área apilada (coste Kiro + coste Bedrock) por día sobre el rango elegido.
- Los **días anómalos** resaltados (los que superan la media + 2·desviación típica y además 1,5·la media de la ventana).
- Respeta el **filtro de cuentas** del dashboard FinOps: al seleccionar un subconjunto de cuentas, la serie se recalcula para esas cuentas.
- Si todavía no hay snapshots, un estado vacío informativo ("el histórico se está construyendo") en lugar de una gráfica rota.
- Sujeto al control de acceso FinOps habitual (los `externos` no acceden a FinOps).

**Cómo se alimenta:** el cronjob `ai-cost-snapshot` (02:00 diario) calcula el coste de IA del día anterior (Kiro vía Identity Store + Bedrock vía CUR/Athena acotado a un día) y lo persiste en la tabla `ai_cost_daily` con upsert idempotente por fecha. Admite un backfill manual por rango para reconstruir el histórico.

**Componente:** `src/components/finops/ai-cost-history-card.tsx`. **APIs:** `POST /api/finops/ai-cost/snapshot` (interno), `GET /api/finops/ai-cost/history`. **Source:** `src/lib/ai-cost-history.ts`. **Tabla:** `ai_cost_daily`.

### 7.18 Novedades AWS — sidebar de la home (admin)

Panel lateral en la home del portal, **visible solo para administradores**, que consolida las notificaciones de AWS Health (incidencias de servicios, mantenimientos programados, avisos de cuenta, fin de soporte) de todas las cuentas de la organización, para no depender del aluvión de emails.

**Sin coste de soporte:** la organización está en Basic Support, por lo que la AWS Health API de pago no se usa. Los eventos `aws.health` se recogen vía EventBridge (que los emite en cada cuenta aunque estén en Basic Support), se hacen fan-in cross-account a un bus central en dp-tooling y de ahí a una cola SQS que el portal consume.

**Qué muestra:**

- Lista de novedades ordenadas por relevancia (eventos abiertos/próximos primero, luego por fecha de actualización descendente).
- Por cada evento: servicio AWS, categoría, estado (`open`/`upcoming`/`closed`), cuentas afectadas (con nombre amigable), fecha y resumen, con indicación visual de severidad (alta/media/baja inferida según categoría y estado).
- Toggle para ocultar los eventos ya cerrados y centrarse en lo accionable.
- Estado vacío "sin novedades de AWS" cuando no hay nada que mostrar.

El acceso `admin` se valida en el servidor (no solo se oculta en el cliente). La sincronización degrada con elegancia: si la cola no está disponible, la sidebar sirve lo último persistido sin romper la home.

**Cómo se alimenta:** el cronjob `aws-health-sync` (cada 15 min) hace polling de la cola SQS, normaliza cada evento y hace upsert por ARN en la tabla cache `aws_health_events`. El rollout de las reglas EventBridge a las cuentas se automatiza con `ops/setup-aws-health-hub.sh` (hub en dp-tooling) y `ops/apply-aws-health-eventbridge.sh` (multi-cuenta, idempotente).

**Componente:** `src/components/home/news-sidebar.tsx`. **APIs:** `POST /api/aws-health/sync` (interno), `GET /api/aws-health/news` (admin). **Source:** `src/lib/aws-health.ts`. **Tabla:** `aws_health_events`.

### 7.19 Resumen FinOps diario a Teams (Daily FinOps Digest)

Resumen FinOps proactivo enviado automáticamente cada día a un grupo de Teams, a las **10:20 (hora de Madrid)**, justo antes de la daily. Complementa al Asesor FinOps bajo demanda con una entrega diaria que no requiere entrar al portal.

**Qué incluye el mensaje:**

- Los hallazgos FinOps del día reutilizando el Asesor FinOps sobre todas las cuentas vivas: coste total y variación respecto al periodo anterior, top movers, anomalías detectadas, oportunidades de ahorro priorizadas y el coste de IA del día.
- Las **novedades de AWS** de las últimas 24 horas (o un aviso explícito de que no hubo novedades).
- Un enlace al dashboard FinOps del portal para profundizar.

Se puede enviar como un único mensaje o como dos mensajes separados (resumen FinOps y novedades AWS), según configuración (`FINOPS_DIGEST_MODE`, por defecto separados). Si el contenido excede el tamaño de una tarjeta de Teams, se trunca de forma controlada. Si el análisis FinOps falla pero hay novedades, envía al menos las novedades.

**Webhook dedicado:** se publica en `FINOPS_TEAMS_WEBHOOK_URL`, un webhook de Teams distinto del usado para las notificaciones de requests/aprobaciones SRE (`TEAMS_WEBHOOK_URL`). El valor del webhook lo suministra el operador (nunca se hardcodea).

**Cómo se ejecuta:** el cronjob `finops-daily-digest` (10:20 Europe/Madrid) llama al endpoint interno que genera y envía el digest.

**Source:** `src/lib/finops-daily-digest.ts` + `src/lib/teams-notify.ts`. **API:** `POST /api/finops/daily-digest` (interno).

---

### 7.20 Kiro Analytics (`/kiro-analytics`)

Dashboards de analítica de uso de Kiro IDE, migrados desde una app standalone (React+Vite+Amplify+Cognito) al portal. **Acceso restringido a `admin` y `directores`** (datos de productividad/uso por persona), aplicado en 5 capas: `rbac.ts` (`SECTION_ACCESS`), page guard server-side, API guard (`_shared.guard()`), `middleware.ts` (página + API) y la visibilidad de nav/home card.

**Datos:** Athena DB `kiro_analytics` (workgroup `kiro-analytics`) en la cuenta tooling (444455556666), región **eu-central-1**. El portal consulta con las credenciales IRSA `portal-inventory-irsa` (mismo account, sin AssumeRole) gracias a la policy `KiroAnalyticsAthenaRead`. Cliente: `src/lib/kiro-analytics.ts`.

**Tres pestañas:**
- **Resumen:** KPIs (usuarios activos, prompts, líneas IA, horas ahorradas, ahorro estimado €), tendencia de usuarios activos, top usuarios por prompts, "Top usuarios por código IA" y "Código IA por equipo/grupo". Filtro por rango de fechas.
- **AI Insights:** prompts clasificados (work_type, intent, category, complexity, specificity), métricas de sesiones, tendencias, distribuciones. Filtro por usuario. Solo metadatos de clasificación (NO se expone el texto del prompt).
- **Actividad por usuario:** KPIs + tendencia + tabla de actividad (líneas de código IA, `by_user_analytic`) + sección **"Uso por licencia"** (plan, clientes KIRO_IDE/CLI, mensajes, conversaciones, créditos por usuario; fuente `user_report`). Filtros por usuario **y** por rango de fechas que afectan a toda la pestaña.

**Modelo de datos (dos fuentes complementarias):** `by_user_analytic` mide productividad de código (escaso en origen — limitación del ETL del tenant Kiro); `user_report` mide uso/licencia (cobertura rica, las 3 cuentas incl. EKS Tooling). Detalle técnico completo (tablas, partition projection, crawler, env `KIRO_*`) en el steering `portal-architecture.md` §21.

**Componentes:** `src/components/kiro-analytics/`. **APIs:** `src/app/api/kiro-analytics/*`. **i18n:** claves `kiroAnalytics.*` en los 4 idiomas.

---

## 8. Inteligencia Artificial (AWS Bedrock)

El portal usa AWS Bedrock para tres casos de uso principales: **Iskay** (chat tool-calling FinOps), **agente de infraestructura** (genera Terraform), y **asesor FinOps** (informe async). Todo sobre Claude Sonnet 4.

### 8.1 Modelo y conexión

| Campo | Valor |
|-------|-------|
| Proveedor | AWS Bedrock (Converse API) |
| Modelo principal | `eu.anthropic.claude-sonnet-4-20250514-v1:0` (override via `INFRA_AGENT_MODEL_ID` y `FINOPS_CHAT_MODEL_ID`) |
| Región | `eu-west-1` (`AWS_BEDROCK_REGION`) |
| SDK | `@aws-sdk/client-bedrock-runtime` (`ConverseCommand`) |
| Auth | STS AssumeRole cross-account (config en env) |
| Cliente | `src/lib/bedrock.ts` |

### 8.2 Iskay — FinOps Chat (tool-calling)

Ya documentado en sección 7.6. Es el caso de uso más sofisticado: ~22 tools sobre Lambda + CUR + OpenCost + Loki + Tempo + Prometheus + Inventory. Loop con max 6 iteraciones, tools en paralelo por turno. Permitido a admin y directores únicamente.

### 8.3 Agente de Infraestructura

Ya documentado en sección 7.10. `src/lib/infra-agent.ts` usa Bedrock ConverseCommand con tools read-only para leer el repo del equipo y generar Terraform. Validación HCL + secret scanning antes de commitear.

### 8.4 Asesor FinOps (jobs async)

Ya documentado en sección 7.5.4. `src/lib/finops-advisor-runner.ts` orquesta inventario + métricas CloudWatch + costes CUR + análisis determinista pre-modelo + prompt masivo → Bedrock para generar informe markdown. Persistencia en `finops_advisor_jobs`.

### 8.5 Otras rutas IA

- `POST /api/ai/chat` — Chat genérico (El Becario, separado de Iskay)
- `POST /api/ai/analyze` — Análisis DORA con Bedrock
- `POST /api/ai/anomalies` — Detección de anomalías
- `POST /api/ai/risk-assessment` — Evaluación de riesgo de deploy
- `POST /api/ai/report` — Generación de reporte ejecutivo semanal
- `POST /api/ai/analyze-costs` — Análisis de costes
- `GET /api/ai/status` — Estado del proveedor IA

### 8.6 Mock fallback

Si la conexión a Bedrock falla, las funciones de `src/lib/bedrock.ts` tienen implementación mock con respuestas deterministas basadas en los datos reales (no hardcoded). Permite seguir desarrollando localmente sin credenciales.

---

## 9. Internacionalización (i18n)

**Ficheros:**

| Fichero | Responsabilidad |
|---------|----------------|
| `src/lib/i18n.tsx` | Provider, Context, hook `useI18n()`, lazy-loading |
| `src/i18n/es.json` | Español |
| `src/i18n/en.json` | Inglés |
| `src/i18n/fr.json` | Francés |
| `src/i18n/pt.json` | Portugués |
| `src/components/language-selector.tsx` | Selector |

**Implementación:** React Context con lazy-loading de JSONs (`import()`), persistencia en `localStorage`. Hook `useI18n()` da `t(key, fallback?)`, `locale`, `setLocale()`, `ready`.

**Uso:**

```typescript
const { t } = useI18n();
return <span>{t("dora.deploymentFrequency")}</span>;
```

**Importante:** Las funciones helper fuera del componente principal deben tener su propio `const { t } = useI18n()` — el minificador de producción rompe closures cuando `t` se captura.

**Cobertura:** Todo el portal está traducido; el prompt del asesor FinOps también es multiidioma (`getFinOpsSystemPrompt(locale)`).

---

## 10. Feature Flags

**Fichero:** `src/lib/feature-flags.ts`

```typescript
export const ENABLE_CYBERSECURITY = false;
export const ENABLE_AUTOMATIONS = false;
export const ENABLE_JIRA = false;
```

| Flag | Estado actual | Controla |
|------|---------------|----------|
| `ENABLE_CYBERSECURITY` | `false` | Workspace cybersecurity (reportes Azure AD) |
| `ENABLE_AUTOMATIONS` | `false` | Sección automatizaciones AWX + n8n |
| `ENABLE_JIRA` | `false` | Dashboard de Jira (KPIs) — el flujo de tickets bidireccional vive en `/tickets` y NO está detrás de este flag |

Para activar: cambiar a `true` y rebuild de imagen.

---

## 11. Variables de Entorno

### 11.1 Secrets (`platformportal-secrets`)

| Key | Uso |
|-----|-----|
| `database-url` | Connection string PostgreSQL |
| `gitlab-token` | GitLab Personal Access Token (`glpat-...`) |
| `sonarqube-token` | Token SonarQube |
| `GRAFANA_TOKEN` | Service account token Grafana Cloud (lectura/escritura) |
| `GRAFANA_METRICS_TOKEN` | Token directo para Prometheus (basic auth con `GRAFANA_METRICS_USERNAME`) |
| `awx-token` | Token AWX |
| `INTERNAL_API_SECRET` | Secret de auth interna entre servicios (cronjobs, n8n) |
| `JIRA_API_TOKEN` | API Token Atlassian |
| `TEAMS_WEBHOOK_URL` | Webhook MS Teams para notificaciones |

### 11.2 Secrets (`n8n-webhooks-env`)

| Key | Uso |
|-----|-----|
| `AZURE_AD_CLIENT_ID` | Azure AD app registration |
| `AZURE_AD_CLIENT_SECRET` | Azure AD app secret |
| `NEXTAUTH_SECRET` | NextAuth JWT signing |

### 11.3 ConfigMap / env vars directas

| Variable | Valor |
|----------|-------|
| `NEXTAUTH_URL` | `https://portal.today.tooling.dp.iskaypet.com` |
| `AZURE_AD_TENANT_ID` | `19e73cc9-78d1-4540-862c-5a89572ef80e` |
| `GITLAB_URL` | `https://gitlab.com` |
| `JIRA_BASE_URL` | `https://iskaypet.atlassian.net` |
| `JIRA_EMAIL` | `ruben.landin@iskaypet.com` |
| `GRAFANA_STACK_URL` | `https://iskaylog.grafana.net` |
| `GRAFANA_METRICS_URL` | URL directa de Prometheus en Grafana Cloud |
| `GRAFANA_METRICS_USERNAME` | Username Prometheus (1290143) |
| `SONARQUBE_URL` | `http://sonarqube-sonarqube.sonarqube.svc.cluster.local:9000/api` |
| `AWX_API` | `https://awx-ansible.tooling.dp.iskaypet.com/api/v2` |
| `N8N_INTERNAL_URL` | `http://n8n.n8n.svc.cluster.local` |
| `AWS_BEDROCK_REGION` | `eu-west-1` |
| `INFRA_AGENT_MODEL_ID` | `eu.anthropic.claude-sonnet-4-20250514-v1:0` |
| `FINOPS_CHAT_MODEL_ID` | `eu.anthropic.claude-sonnet-4-20250514-v1:0` |
| `FINOPS_ATHENA_LAMBDA_URL` | `https://jzcrsycqa2plblvxdeck37r6am0kxeqw.lambda-url.eu-north-1.on.aws/` |
| `IDENTITY_STORE_ROLE_ARN` | Role para AssumeRole en cuenta `600700800900` |
| `DORA_DEPLOY_JOB_NAMES` | (override opcional) Nombres de jobs considerados deploy a producción |
| `DORA_MAX_LEAD_TIME_HOURS` | Umbral max lead time |
| `DORA_DF_ANOMALY_THRESHOLD` | Umbral DF anomaly |
| `DORA_MIN_CORRELATION_CONFIDENCE` | Confianza mínima correlación |

---

## 12. Estructura del Proyecto

```
src/
├── app/                          # Next.js App Router
│   ├── api/                      # API Routes
│   │   ├── access-management/    # Solicitudes acceso (request, [id], execute, groups, pending, portal-role)
│   │   ├── admin/                # activity/, analytics/{overview,engagement,tickets,approvals,access,repos,infra,user-detail}
│   │   ├── ai/                   # chat, analyze, anomalies, risk-assessment, report, analyze-costs, status,
│   │   │                         # finops-advisor (+ jobs), finops-chat (Iskay)
│   │   ├── auth/                 # NextAuth
│   │   ├── automations/          # awx, n8n
│   │   ├── create-infra/         # Wrapper a webhook n8n (legacy)
│   │   ├── create-repo/          # Wrapper a webhook n8n
│   │   ├── cybersecurity/        # intake (interno)
│   │   ├── finops/               # accounts, athena, costs, credits, cur-direct, forecast, k8s-allocation, kiro, snapshot, vpa
│   │   ├── gitlab/               # mr-snapshot, mr-analytics, mr-stats
│   │   ├── grafana-chat/         # Endpoint experimental
│   │   ├── health/               # Health check
│   │   ├── incidents/            # Reliability
│   │   ├── infra-assistant/      # chat, submit, execute/[id]
│   │   ├── infra-request-v2/     # generate, modify, list-resources
│   │   ├── infra-requests/       # CRUD
│   │   ├── inventory/            # AWS multi-cuenta
│   │   ├── jira/                 # create-ticket, dashboard, my-tickets, tickets/[key]/comments
│   │   ├── metrics/              # dora-core, lead-time, deployment-frequency, change-failure-rate, mttr,
│   │   │                         # mr, mr-details, traces, projects, teams, developers, manager-dashboard,
│   │   │                         # team-activity, executive-summary, feedback, snapshot, snapshot-all,
│   │   │                         # backfill, correlate, compliance-snapshot, k8s-snapshot, k8s-mapping,
│   │   │                         # incidents, argocd, code-quality
│   │   ├── notifications/        # list, count, read
│   │   ├── preferences/          # User preferences (presets)
│   │   ├── reliability/          # Incidents intake
│   │   ├── sonarqube/            # snapshot, dashboard, metrics, projects
│   │   ├── synthetics/           # CRUD monitors, run, rollup, stats, metrics, export, lighthouse, init, external-status
│   │   ├── user-onboarding/      # Wrapper webhook n8n (legacy)
│   │   └── webhooks/             # gitlab (push, MR, pipeline)
│   ├── access-management/        # Página access management
│   ├── admin/                    # Página admin analytics
│   ├── ai/                       # Página chat IA (El Becario)
│   ├── automations/              # Página automatizaciones
│   ├── aws-inventory/            # Página inventario
│   ├── create-infra/             # Form legacy infra
│   ├── create-repo/              # Form crear repo
│   ├── cybersecurity/            # Página cyber (feature flag)
│   ├── executive/                # Dashboard ejecutivo
│   ├── finops/                   # Página FinOps (4 tabs + Iskay)
│   ├── finops-athena/            # Vista Athena directa
│   ├── incidents/                # Página incidentes
│   ├── infra-assistant/          # Asistente IA infra
│   ├── infra-requests/           # Listado de solicitudes
│   ├── jira/                     # Página Jira (feature flag)
│   ├── metrics/                  # Página métricas
│   ├── modify-infra/             # Modificar recursos existentes
│   ├── notifications/            # Página notificaciones
│   ├── requests/                 # Listado generic de requests
│   ├── synthetics/               # Página monitorización + Lighthouse
│   ├── tickets/                  # Tickets bidireccional Jira
│   ├── user-onboarding/          # Onboarding legacy
│   ├── layout.tsx, page.tsx, globals.css, favicon.ico
├── components/
│   ├── access-management/        # access-request-form, kiro-license-form
│   ├── admin/                    # admin-activity-dashboard, admin-analytics-dashboard, activity-tracker, analytics/{8 tabs}
│   ├── ai/                       # Componentes chat IA
│   ├── automations/              # automations-workspace
│   ├── chat/                     # Componentes chat genérico
│   ├── cybersecurity-workspace.tsx
│   ├── finops/                   # 22 componentes (workspace, costs-dashboard, executive-summary, forecast-panel,
│   │                             # cur-deep-insights, cost-movers-card, anomaly-timeline-card, aws-rightsizing-card,
│   │                             # finops-section, finops-chat, finops-chat-floating, k8s-allocation-dashboard,
│   │                             # k8s-vpa-table,
│   │                             # kiro-licenses-card, AccountBreakdownTable, AccountMultiSelect, CostTrendChart,
│   │                             # MonthlyCostTrendChart, ServiceComparisonChart, SavingsPlansCard, QuickFilters,
│   │                             # ExcelExportButton, TrendIndicator)
│   ├── infra-assistant/, infra-request-v2/, infra-requests/
│   ├── inventory/                # aws-inventory-dashboard, finops-advisor, finops-advisor-page, inventory-kpi-bar
│   ├── jira/                     # jira-dashboard
│   ├── metrics/                  # engineering-dashboard, team-activity-tab, mr-details-table, period-comparison,
│   │                             # metrics-actions, shared/{metric-card, chart-card, mini-stat, dora-benchmarks,
│   │                             # dora-performance-badge, skeleton-card, empty-state, section-shell}
│   ├── sonarqube/                # enhanced-sonarqube-panel
│   ├── synthetics/               # synthetic-dashboard, monitor-management, monitor-detail-dialog, lighthouse-tab, external-status
│   ├── tickets/                  # Componentes tickets
│   ├── ui/                       # shadcn/ui (badge, button, card, dialog, form, input, label, multi-select,
│   │                             # popover, scroll-area, select, table, tabs, toast, checkbox, command)
│   ├── portal-shell.tsx          # ★ Sidebar + layout principal
│   ├── finops-workspace.tsx      # Layout FinOps (4 tabs)
│   ├── notification-bell.tsx     # Campana notificaciones
│   ├── command-palette.tsx       # Cmd+K
│   ├── page-header.tsx, error-boundary.tsx, providers.tsx, conditional-shell.tsx,
│   ├── theme-toggle.tsx, language-selector.tsx, login-button.tsx, logout-button.tsx,
│   ├── stale-data-banner.tsx, data-freshness.tsx, gitlab-repo-form.tsx, infra-request-form.tsx
├── lib/                          # ★ Lógica de negocio (75+ ficheros)
│   ├── access-management/        # domain-normalizer.ts (emailsMatch)
│   ├── athena-cur.ts             # CurFullSnapshot via Athena directo
│   ├── auth.ts, rbac.ts, api-auth.ts, session-role.ts
│   ├── aws-account-catalog.ts, aws-accounts.ts
│   ├── aws-inventory.ts, aws-inventory-persistence.ts, aws-cloudwatch-metrics.ts
│   ├── bedrock.ts                # Cliente Bedrock
│   ├── cache.ts                  # Caché in-memory (TTL 5min, prefijos)
│   ├── cybersecurity.ts, cybersecurity-live.ts
│   ├── db.ts, db/                # Pool PostgreSQL
│   ├── deployment-correlation.ts, developer-identity.ts
│   ├── dora-snapshot.ts, gitlab.ts, gitlab-governance.ts, gitlab-mr-metrics.ts
│   ├── finops-advisor.ts, finops-advisor-runner.ts, finops-advisor-insights.ts
│   ├── finops-advisor-jobs.ts, finops-cost-estimation.ts, finops-format.ts
│   ├── finops-resource-costs.ts, finops-tools.ts          # ★ Tools de Iskay
│   ├── grafana-metrics.ts, grafana-proxy.ts               # ★ Proxy Grafana datasources
│   ├── graph-client.ts                                    # Microsoft Graph
│   ├── i18n.tsx, feature-flags.ts
│   ├── infra-agent.ts, infra-prompt-builder.ts, infra-cost-estimator.ts,
│   │   infra-resource-parser.ts, infra-approvers.ts, team-approvers.ts
│   ├── jira.ts                   # Cliente Jira
│   ├── k8s-finops.ts             # ★ OpenCost + rightsizing
│   ├── k8s-vpa.ts                # ★ VPA recommendations + savings con OpenCost
│   ├── k8s-metrics.ts, k8s-snapshot.ts, k8s-workload-mapping.ts
│   ├── kiro-licenses.ts          # ★ Licencias Kiro per-user (Identity Store)
│   ├── logger.ts, metrics-dashboard.ts, metrics-formulas.ts, mr-snapshot.ts
│   ├── notifications.ts, platform-snapshot.ts, query-filters.ts
│   ├── rate-limiter.ts, reliability.ts, repo-catalog.ts, resource-scope-verifier.ts
│   ├── secret-scanner.ts, service-compliance.ts
│   ├── sonarqube.ts, sonarqube-snapshot.ts, sonarqube-mapping.ts
│   ├── statistics.ts, terraform-validator.ts, user-activity.ts
│   ├── dashboard-utils.ts, format-utils.ts, field-validators.ts, utils.ts, ai-agent-tools.ts, ai-agent-executors.ts, email.ts
├── i18n/                         # Archivos de traducción
│   ├── es.json, en.json, fr.json, pt.json
└── types/                        # TypeScript types

ops/                              # Scripts operativos
├── k8s/                          # Manifiestos K8s (CronJobs, Jobs, ConfigMaps, ksm-vpa, vpa-values)
├── Dockerfile.lighthouse, Dockerfile.mr-metrics
├── lighthouse-cronjob.yaml, mr-metrics-cronjob.yaml
├── lighthouse-scan.js, mr-metrics-snapshot.js
├── backfill-gaps.js, backfill-recent.js, backfill-snapshots.js, run-backfill-recent.sh
├── trigger-snapshot.js, smoke-metrics-dashboard.js
├── apply-branch-push-rules.sh, apply-template-push-rules.sh
├── athena-cur-audit.sh, athena-explore.sh
├── identity-store-policy.json    # IAM policy para CUR role
├── test-identity-store.js, test-cybersecurity-intake.sh
├── verify-cybersecurity-schema.js, verify-rds.js
├── check-grafana-opencost.js, k8s-metrics-check.js
├── debug-sfra-deploys.js, fetch-all-gitlab-users.js, list-gitlab-members.js
├── generate-name-mapping.js, generate-n8n-flows-with-portal.{js,py}
├── bulk_add_developers.py, find_user.py, check_overlap.py, cleanup-commit-regex.sh
├── migrate-to-rds.js, migrate-to-rds-v2.js, migrate-to-rds-v3.js
└── README.md

migrations/                       # 32 migraciones SQL
docs/                             # Documentación + referencias
├── PORTAL_DOCUMENTATION.md       # Este documento
├── n8n/                          # Flujos n8n (5 JSONs + workspace + asset)
├── aws/                          # Lambdas AWS (lambda-finops-athena.mjs, lambda-inventory.mjs)
├── azure-flows/                  # Flujos Azure AD (3 JSONs)
├── cybersecurity-intake-contract.md, cybersecurity-n8n-integration.md
├── finops-advisor-role-guidance.md, gitlab-dora-data-contract.md
├── grafana-argocd-runtime-contract.md, k8s-workload-mapping.md
├── reliability-data-contract.md, GITLAB_STANDARDIZATION_PLAN.md
```

### Cómo añadir una nueva funcionalidad

1. **Página:** `src/app/mi-feature/page.tsx`
2. **API:** `src/app/api/mi-feature/route.ts` con `requireUserAuth(req, "minRole")`
3. **Componente:** `src/components/mi-feature/...`
4. **Lógica:** `src/lib/mi-cliente.ts` (clientes externos), `src/lib/mi-feature.ts` (queries DB)
5. **Navegación:** `NAV_ITEMS` en `src/components/portal-shell.tsx`
6. **Home:** Card en `src/app/page.tsx`
7. **Traducciones:** los 4 JSON de `src/i18n/`
8. **Protección:** regla en `middleware.ts`
9. **Feature flag (opcional):** `src/lib/feature-flags.ts`
10. **Migración (si aplica):** `migrations/YYYY-MM-DD_descripcion.sql`

---

## 13. Despliegue

### 13.1 Build & Deploy del portal principal

```bash
# Build
docker buildx build --platform linux/amd64 --load \
  -t harbor.tooling.dp.iskaypet.com/tooling/platformportal:<tag> .

# Push
docker push harbor.tooling.dp.iskaypet.com/tooling/platformportal:<tag>

# Deploy
kubectl --context arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling \
  -n n8n set image deploy/n8n-webhooks \
  n8n-webhooks=harbor.tooling.dp.iskaypet.com/tooling/platformportal:<tag>

# Verify rollout
kubectl -n n8n rollout status deploy/n8n-webhooks --timeout=120s

# Logs
kubectl -n n8n logs deploy/n8n-webhooks --tail=50
```

### 13.2 Build de la imagen del CronJob mr-metrics-snapshot

```bash
docker buildx build --platform linux/amd64 --load \
  -f Dockerfile.mr-metrics \
  -t harbor.tooling.dp.iskaypet.com/tooling/mr-metrics-snapshot:latest \
  -t harbor.tooling.dp.iskaypet.com/tooling/mr-metrics-snapshot:<version> \
  .
docker push harbor.tooling.dp.iskaypet.com/tooling/mr-metrics-snapshot:latest
```

El CronJob tiene `imagePullPolicy: Always` con tag `latest`, así que un push basta para que la próxima ejecución use la versión nueva.

### 13.3 Build de la imagen lighthouse-scanner

```bash
docker buildx build --platform linux/amd64 --load \
  -f ops/Dockerfile.lighthouse \
  -t harbor.tooling.dp.iskaypet.com/tooling/lighthouse-scanner:<tag> \
  ops/
docker push harbor.tooling.dp.iskaypet.com/tooling/lighthouse-scanner:<tag>
```

Aplicar el manifiesto: `kubectl -n n8n apply -f ops/lighthouse-cronjob.yaml`.

### 13.4 Snapshot manual

```bash
kubectl -n n8n run snapshot-manual --rm -i --restart=Never --image=curlimages/curl:latest -- \
  curl -s -X POST \
  -H "x-internal-secret: $INTERNAL_API_SECRET" \
  "http://n8n-webhooks.n8n.svc.cluster.local:3000/api/metrics/snapshot-all"
```

### 13.5 Añadir variables de entorno

```bash
# Patch a secret
kubectl -n n8n patch secret platformportal-secrets --type merge \
  -p '{"stringData":{"nueva-key":"valor"}}'

# Env var directa al deployment
kubectl -n n8n set env deployment/n8n-webhooks NUEVA_VAR=valor
```

### 13.6 Aplicar migración SQL

```bash
psql $DATABASE_URL -f migrations/YYYY-MM-DD_descripcion.sql
```

### 13.7 Convenciones de Git

**Branch:** `<type>/<TICKET>` — regex: `^(main|master|develop|release\/.*|(feat|fix|hotfix|perf|refactor|chore|build|ci|docs|test)\/[A-Z]{2,10}-[0-9]+)$`

Ejemplos: `feat/SRE-001`, `fix/CRO-128`, `refactor/MKP-55`.

**Commit:** `[TICKET] <type>: <description>` (descripción 2-70 ASCII).

Ejemplo: `[SRE-001] feat: add lighthouse scanning to synthetics`.

---

## 14. Operational Gotchas

- **DORA cache invalidation:** `getDoraCoreDashboard` cache key incluye `from`, `to`, `days`, `teams`, `projectIds`, `includeClusterSignals`. Al añadir una dimensión nueva, actualizar la cache key.
- **DORA custom range vs days:** Cuando `from`/`to` (YYYY-MM-DD) están presentes, ganan sobre `days`. La period comparison pasa ambos — la query usa la ventana explícita, no `subDays(now, days)`.
- **Marketplace contracts:** Filtrar `line_item_product_code LIKE 'cg%'` OR usage_type `Global-SoftwareUsage-Contracts` para separarlos del coste de infra (anuales, cobrados Día 1 del mes).
- **Identity Store role:** El role `Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur` necesita policy inline `IdentityStoreReadOnly`. Sin ella, en la pestaña Kiro aparecen UUIDs en lugar de nombres.
- **Standalone Next.js + AWS SDK:** El portal usa `output: standalone`. Los AWS SDK clients deben ser imports top-level del paquete instalado. Un `require()` lazy en runtime falla con `Cannot find module` dentro del runtime de standalone.
- **Mimir aggregation:** `kubecost_node_is_spot == 1` requiere agregación explícita en Grafana Cloud Mimir. Usar `count by(k8s_cluster_name) (kubecost_node_is_spot > 0)`.
- **PromQL division-by-bytes:** La división `/(1024*1024*1024)` debe ir DENTRO del `sum by(...)` para preservar labels. Fuera rompe la label `k8s_cluster_name`.
- **i18n closures:** Funciones helper fuera del componente principal deben tener su propio `const { t } = useI18n()` — el minificador rompe closures cuando capturan `t`.
- **Modify infra:** `verifyModifyScope()` espera **string HCL**, no el objeto `TerraformPreview`. Usar `result.terraformPreview.content`.
- **MR detectTeam:** Walking left-to-right por path segments con substring fallback. `iskaypetcom/digital/marketplace/marketplace-products-api` → team `marketplace`, no `products`.
- **Domain normalization:** Siempre usar `emailsMatch()` de `src/lib/access-management/domain-normalizer.ts` para `@iskaypet ↔ @emefinpetcare ↔ @ext.emefinpetcare`.
- **VPA via KSM CustomResourceState:** Extender el KSM principal del chart `grafana-k8s-monitoring 3.8.5` no funciona — el sub-chart `kube-state-metrics 6.4.2` ignora `customResourceState`/`extraRules`/`extraArgs` del parent. Hay que desplegar un KSM standalone (`ops/k8s/ksm-vpa-standalone.yaml`) con discovery por annotations (no por labels) para evitar colisiones de `up`/`scrape_samples_scraped`, y añadir las métricas al `metricsTuning.includeMetrics` del chart wrapper.

---

## 15. Spending / quotas a monitorizar

- **Marketplace contracts:** ~$85k/mes — contratos anuales prepagados (Día 1).
- **PostgreSQL 13 Extended Support:** ~$950/mes — pagamos a AWS por NO migrar a PG14+.
- **CloudWatch Logs us-east-1 (WAF):** ~$2.4k/mes — 4 log groups por brand.
- **Bedrock Haiku:** ~$2.2k/mes — split entre `iskaypet-data` (200300400500) y `data-dev` (100200300400).
- **NAT Gateways:** 9 activos. Top consumer (`nat-02fa21f2db24ee28f` en prod) ~$200/mes en data processing.
- **EBS gp2 → gp3:** Migración ahorra ~20% (datos en `hiddenCosts.gp2Detail`).

---

## 16. Tabla rápida de referencia

| Necesito... | Voy a... |
|-------------|----------|
| Ver el dashboard DORA | `/metrics` |
| Comparar dos periodos DORA | `/metrics` con custom date range |
| Ver MR review metrics per-MR | `/metrics` → tab "MR Review" |
| Ver coste AWS por cuenta | `/finops` → Costes |
| Ver coste por workload K8s | `/finops` → EKS Allocation |
| Ver recomendaciones VPA por workload | `/finops` → EKS Allocation → "Ajuste de recursos" |
| Ver licencias Kiro per-user | `/finops` → Costes → Costes de IA |
| Hablar con Iskay (chat) | Botón flotante en cualquier pestaña FinOps (admin/directores) |
| Crear un repo nuevo | `/create-repo` |
| Solicitar infra (RDS/S3/IAM) | `/infra-requests` (con AI agent) |
| Solicitar acceso (AWS/GitLab/Azure) | `/access-management` |
| Crear un ticket/incidente | `/tickets` (bidireccional con Jira) |
| Ver actividad del portal | `/admin` → Overview/Engagement/etc. |
| Ver Lighthouse audits | `/synthetics` → Lighthouse |
| Ejecutar snapshot manual | `kubectl run` con curl al endpoint interno |
| Cambiar imagen del portal | `kubectl -n n8n set image deploy/n8n-webhooks ...` |
| Ver logs del portal | `kubectl -n n8n logs deploy/n8n-webhooks --tail=50` |
| Obtener token Grafana | `kubectl -n n8n exec deploy/n8n-webhooks -- printenv GRAFANA_TOKEN` |
