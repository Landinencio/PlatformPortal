# Implementation Plan

> Feature: Portal CI/CD + GitOps + External Secrets
> Multi-repo: `platformportal` (este), `gitlab-ci-toolkit` (61922532), `argocd/tooling` (GitOps_Repo), `shared-general` (Terraform secretos, id 45950137), `kube-stack` (ArgoCD Applications tooling).
> Orden = migración segura del diseño: secretos → IRSA → chart+ESO en DEV → pipeline DEV → corte PROD no disruptivo → retirar fósil → docs. Validar SIEMPRE en dev antes de prod.

## Overview

Plan incremental para automatizar el despliegue del portal con CI/CD + GitOps (ArgoCD, repo `argocd/tooling`), migrar secretos a External Secrets Operator (AWS Secrets Manager vía Terraform en `shared-general`), e igualar dev (ns `platformportal`) a prod (ns `n8n`) en el cluster tooling. Cada bloque deja el sistema en estado consistente y se valida en dev antes de tocar prod.

## Tasks

### Bloque A — Secretos en AWS (Terraform) + IRSA

- [x] 1. Declarar los secretos del portal en Secrets Manager (Terraform, repo `shared-general`)
  - En `iac/global/secretsmanager.tf` añadir `aws_secretsmanager_secret` + `_version` para las claves `dp/tooling/portal_*` (db, gitlab, sonarqube, grafana, awx, internal, jira, teams {sre_webhook, finops_webhook}, aws_health {queue_url}, azure {client_id, client_secret}, nextauth) siguiendo el patrón existente (`name = "dp/tooling/..."`, valor desde `var.*`).
  - Declarar las `variables` correspondientes (sensibles) y poblar sus valores por el canal seguro del repo (CI vars / tfvars cifrado), NUNCA en claro en el código.
  - Plan + apply; verificar que los secretos existen en Secrets Manager (cuenta tooling, eu-west-1).
  - _Requirements: 4.1, 4.5_

- [x] 2. Conceder lectura de Secrets Manager al rol IRSA del portal
  - Crear plantilla de policy `iac/services/policy_templates/portal_secret_access.json.tmpl` (patrón `backstage_docs_access`/`oms_secret_access`) con `secretsmanager:GetSecretValue`/`DescribeSecret` scoped a `arn:aws:secretsmanager:eu-west-1:444455556666:secret:dp/tooling/portal_*`.
  - Adjuntar esa policy al rol `portal-inventory-irsa` (que hoy NO tiene Secrets Manager: solo AssumeInventoryRoles/AwsHealthQueueReader/BedrockInvokeModel/PortalSESSendEmail).
  - Verificar con `aws iam list-role-policies` / simulación que el rol puede leer `dp/tooling/portal_*` y nada más.
  - _Requirements: 4.5_

### Bloque B — Chart Helm del portal en este repo (fiel a prod real)

- [x] 3. Mejorar el chart corporativo `generic-chart` con ESO + CronJob (gated, default off)
  - En `packages/generic-chart` (id 71265300), rama nueva: añadir `templates/secret-store.yaml` + `templates/secret-manager.yaml` (SecretStore AWS SecretsManager region eu-west-1 + auth jwt vía SA; ExternalSecret `refreshInterval: 1h` iterando `secret_manager.resources`), gated por `secret_manager.enabled` (default false). Referencia: `microservice-chart`.
  - Añadir `templates/cronjob.yaml` que itera `cronjobs.jobs` y hereda `env` + `envFrom` (Secret de ESO), con `image`/`command`/`args`/`timezone`/`env`/`schedule` por cron. Gated por `cronjobs.enabled` (default false).
  - Documentar los nuevos values en `values.yaml` (defaults off). `helm lint` OK. Publicar nueva versión (≥0.3.0) por la pipeline del chart.
  - _Requirements: 2.3, 4.2, 7.4_

- [x] 4. Montar el umbrella chart del portal en `.helm/` sobre `generic-chart`
  - `Chart.yaml` con dependency `generic-chart >=0.3.0` desde el Helm repo del proyecto (`/packages/helm/stable`).
  - `values.yaml` (bajo clave `generic-chart`): `app.image` (Harbor `tooling/platformportal`, tag por CI), `app.containerPorts` 3000, probes `/api/health`, recursos, `podAnnotations` scrape Grafana, `app.podSecurityContext/containerSecurityContext` desactivados (Next standalone escribe en `.next/cache`), `serviceAccount.annotations` IRSA `portal-inventory-irsa`, `ingress.hostname` host real, `extraEnvVarsCM`/`extraEnvVarsSecret`.
  - `secret_manager.resources`: las 13 claves `dp/tooling/portal_*` (secretKey = env var final sin guiones → DATABASE_URL, GITLAB_TOKEN, GRAFANA_TOKEN, …). `configMap`: TODAS las env no sensibles reales del deployment.
  - Eliminar cualquier secreto en claro (no portar `GRAFANA_TOKEN`/`TEAMS_WEBHOOK_URL` hardcodeados del chart fósil).
  - `helm dependency build` + `helm template` renderiza sin errores (`kubectl apply --dry-run=client`).
  - _Requirements: 2.3, 4.2, 4.3, 4.4, 5.1_

- [x] 5. Declarar los values por entorno y los 12 cronjobs
  - `values-dev.yaml` (host `portal.today.dev.tooling.dp.iskaypet.com`, recursos reducidos) y `values-prod.yaml` (host `portal.today.tooling.dp.iskaypet.com`).
  - `cronjobs.jobs` con los 12 cronjobs reales: 5 curl/alpine (heredan `INTERNAL_API_SECRET` de ESO), `mr-metrics-snapshot` (imagen propia + `GITLAB_URL`), 6 `lighthouse-*` (imagen propia + `MONITOR_ID`/env por cron, `lighthouse-targets-refresh`). Schedules/timezone fieles a prod (`finops-daily-digest` TZ Europe/Madrid).
  - `helm template` con cada values produce los manifiestos del portal + los 12 CronJobs válidos.
  - _Requirements: 5.1, 5.2, 5.5, 7.1, 7.2, 7.3_

### Bloque C — GitOps en `argocd/tooling` + Applications (DEV primero)

- [x] 6. Materializar el estado del portal en el GitOps_Repo `argocd/tooling`
  - Crear `shared-apps/portal-dev/` y `shared-apps/portal-prod/` consumibles por ArgoCD (umbrella chart + values del entorno, o manifiestos renderizados), patrón de las apps existentes (backstage/tech-radar).
  - `image.tag` del portal y de las imágenes auxiliares (`mr-metrics-snapshot`, `lighthouse-scanner`) placeholder inicial = las que corren HOY en prod (primer sync idempotente, sin cambiar versión desplegada).
  - _Requirements: 2.1, 2.2, 7.5_

- [x] 7. Registrar las ArgoCD Applications en kube-stack (DEV y PROD)
  - En `environments/tooling/applications/argocd/applications/` añadir `portal-dev` (path `shared-apps/portal-dev`, ns `platformportal`) y `portal-prod` (path `shared-apps/portal-prod`, ns `n8n`), repoURL = `argocd/tooling`.
  - `syncPolicy.automated` con `prune` + `selfHeal` (GitOps puro, como pediste) en ambos.
  - Aplicar las Applications (pipeline `argocd-tooling-applications` de kube-stack, con `AWS_*_TOOLING`/`RUNNER_TOOLING_ARN_ROLE`).
  - _Requirements: 2.1, 2.4, 2.5_

### Bloque D — Validación en DEV (ESO + app + equivalencia)

- [x] 8. Validar ESO en DEV
  - Confirmar que el ExternalSecret materializa el Secret en ns `platformportal` con TODAS las claves esperadas (contar claves vs lista) y que el pod arranca.
  - Probar refresh (rotar un valor de prueba en Secrets Manager → ESO re-sincroniza).
  - _Requirements: 4.2, 4.3, 4.6_

- [x] 9. Igualar y validar Dev_Env funcionalmente equivalente a prod
  - Desplegar el portal dev por GitOps; smoke test: login Azure AD, `/api/health`, una query FinOps, Iskay responde.
  - Host/DNS y cert propios de dev (sin colisión con prod).
  - _Requirements: 5.1, 5.2, 5.5_

### Bloque E — Template Toolkit + pipeline del portal (validado en DEV)

- [x] 10. Crear la Portal_Template en el Toolkit (`gitlab-ci-toolkit`)
  - `main-portal.yml` que incluye `CI/build.yml` (Kaniko→Harbor `tooling/platformportal`, semver RC/release+latest, scan) + un `CD/deploy-portal.yml` adaptado al caso "2 entornos, 1 cluster": targets dev/prod escriben el tag en `argocd/tooling` paths `shared-apps/portal-{dev,prod}/values.yaml` y push.
  - Parametrizar por variables (`GITOPS_REPO=argocd/tooling`, `PORTAL_NS_DEV=platformportal`, `PORTAL_NS_PROD=n8n`, hosts); nada del portal hardcodeado en el Toolkit.
  - Tag/versión del Toolkit para consumo con `ref` fijo.
  - _Requirements: 1.1, 1.2, 1.6, 3.1, 3.2, 3.3_

- [x] 11. Reescribir el `.gitlab-ci.yml` del portal para consumir la Template
  - `include` de la Portal_Template del Toolkit con `ref` fijado (no `main`).
  - Etapas: build imagen principal (Kaniko→Harbor) + build de las imágenes auxiliares de cronjobs (`mr-metrics-snapshot` con `Dockerfile.mr-metrics`, `lighthouse-scanner` con `ops/Dockerfile.lighthouse`), scan, deploy_dev (automático), deploy_prod (manual). El deploy escribe los 3 tags (portal + 2 auxiliares) en el GitOps_Repo. Eliminar el pipeline ad-hoc actual y el `set image` manual.
  - _Requirements: 1.1, 1.3, 1.4, 1.5, 3.4, 7.5_

- [x] 12. Validar el pipeline end-to-end en DEV (incluidos cronjobs)
  - Un merge dispara build→Harbor→push GitOps(dev)→ArgoCD sync; verificar imagen publicada, commit de tag en `argocd/tooling`, y Application `portal-dev` `Synced`/`Healthy` con la nueva imagen.
  - Verificar que los 12 CronJobs se materializan en dev (`kubectl get cronjobs`) con su schedule/timezone, que un trigger manual de uno curl (p.ej. `infra-live-check`) recibe el `INTERNAL_API_SECRET` de ESO, y que uno de imagen propia arranca con su `DATABASE_URL`.
  - _Requirements: 1.2, 2.5, 5.3, 5.4, 7.2, 7.3, 7.6_

### Bloque F — Corte de PROD (no disruptivo) y limpieza

- [x] 13. Adoptar ESO en PROD sin downtime
  - Aplicar el ExternalSecret de prod que materializa el MISMO Secret `platformportal-secrets` (mismas claves que el Deployment ya consume); validar diff de claves antes/después (deben coincidir) y que ESO pasa a ser dueño del Secret.
  - Consolidar/retirar `n8n-webhooks-env` (Azure/NextAuth) dentro del ExternalSecret o como segundo ES de transición.
  - _Requirements: 4.3, 4.7, 6.4_

- [x] 14. Primer despliegue de PROD por GitOps
  - Ejecutar `deploy_prod` (manual) del pipeline: promueve la MISMA imagen validada en dev, escribe el tag en `shared-apps/portal-prod`, ArgoCD sincroniza ns `n8n`. Verificar `Synced`/`Healthy` y portal operativo.
  - Confirmar que un `set image` manual ya NO es el camino (selfHeal revertiría).
  - _Requirements: 1.4, 2.4, 2.6, 5.4_

- [x] 15. Retirar el chart fósil de kube-stack (una sola fuente de verdad)
  - Eliminar/parar el `environments/tooling/applications/n8n-webhooks` desincronizado de kube-stack para que no haya dos fuentes de verdad del despliegue del portal.
  - Verificar que tras la retirada ArgoCD sigue gestionando el portal solo desde `argocd/tooling`.
  - _Requirements: 6.3_

- [x] 16. Rotar los secretos expuestos en Git
  - Rotar en Secrets Manager los secretos que estuvieron en claro en el chart fósil/manifiestos (`GRAFANA_TOKEN`, `TEAMS_WEBHOOK_URL` y cualquier otro detectado); ESO propaga el nuevo valor.
  - _Requirements: 4.1, 4.4_

### Bloque G — Documentación

- [x] 17. Actualizar la documentación canónica
  - `.kiro/steering/portal-architecture.md` (§1 comandos: sustituir build/push/`set image` por el flujo CI/CD+GitOps; §6/§8 secretos vía ESO; nueva sección de despliegue) y `docs/PORTAL_DOCUMENTATION.md`.
  - Documentar rollback (revertir commit de tag en `argocd/tooling`) y alta/rotación de secretos (Terraform en `shared-general` → ESO).
  - _Requirements: 6.1, 6.2_

## Notes

- **Validar siempre en DEV antes de PROD**: bloques D y E ocurren en dev; el corte de prod (bloque F) solo tras éxito en dev.
- **No disrupción en PROD**: la clave es `target.name: platformportal-secrets` (mismo Secret) y promover la misma imagen ya corriendo en el primer sync (tarea 6 placeholder = imagen actual).
- **Secretos**: declarados por Terraform en `shared-general` (patrón `dp/tooling/*`), leídos por el rol IRSA del portal (ampliado), materializados por ESO (patrón backstage). Cero secretos en claro en Git.
- **Sync GitOps puro**: `automated + prune + selfHeal` en ambas Applications → se acabó el `set image` manual (selfHeal lo revertiría).
- **Multi-repo**: cada tarea indica el repo donde actúa. Las MRs siguen la convención `[SRE-XXX]` y ramas `feat/SRE-XXX`.
