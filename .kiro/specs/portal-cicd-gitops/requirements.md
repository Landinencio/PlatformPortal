# Requirements Document

> Feature: Portal CI/CD + GitOps + External Secrets

## Introduction

Hoy el Platform Portal de IskayPet se despliega **a mano**: build local con `docker buildx`, push a Harbor y `kubectl -n n8n set image deploy/n8n-webhooks ...`. Esto tiene varios problemas que esta feature resuelve:

1. **Despliegue manual y no trazable.** Cada release depende de que un operador (Rubén) ejecute la secuencia build→push→set image desde su portátil. No hay pipeline, no hay historial de qué versión se desplegó cuándo, ni rollback sencillo.

2. **El estado en Git no representa la realidad.** El chart Helm del portal vive en `kube-stack` (`environments/tooling/applications/n8n-webhooks/`) pero está **completamente desincronizado**: apunta a un registry equivocado (ECR `n8n-portal` en vez de Harbor `tooling/platformportal`), tiene un tag fósil (`c0cc162e`) mientras prod corre otra imagen, y su `values.yaml` solo conoce 3 variables de entorno cuando el deployment real tiene ~30 (DB, GitLab, Jira, SonarQube, Bedrock, Teams, FinOps, DORA, etc.).

3. **Dos entornos divergentes en el mismo cluster.** El portal tiene **dev** (namespace `platformportal`) y **prod** (namespace `n8n`, deployment `n8n-webhooks`), ambos en el cluster **dp-tooling**. El de dev está desactualizado y no es funcionalmente equivalente a prod, así que no sirve como entorno de validación real.

4. **Secretos creados a mano.** Las credenciales viven en Secrets de Kubernetes creados manualmente (`platformportal-secrets`, `n8n-webhooks-env`) y editados con `kubectl patch`. Peor aún: hay **secretos en claro versionados en Git** (un `GRAFANA_TOKEN` y un `TEAMS_WEBHOOK_URL` hardcodeados en el chart de kube-stack / dumps). No hay rotación ni fuente de verdad. External Secrets Operator ya está desplegado en el cluster tooling pero el portal no lo usa (`externalSecrets.enabled: false`).

Esta feature establece un flujo **CI/CD + GitOps** completo y reproducible para el portal, alineado con el estándar de la organización (toolkit `gitlab-ci-toolkit` + repos ArgoCD separados), migra los secretos a **External Secrets Operator** (backend AWS Secrets Manager), y deja **dev y prod equivalentes** en el cluster tooling.

## Glossary

- **Portal**: Platform Portal de IskayPet (Next.js standalone). Imagen `harbor.tooling.dp.iskaypet.com/tooling/platformportal`.
- **Tooling_Cluster**: cluster EKS `dp-tooling` (`arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling`), cuenta `444455556666`. Aloja AMBOS entornos del portal.
- **Prod_Env**: entorno de producción del portal. Namespace `n8n`, deployment `n8n-webhooks`, host `portal.today.tooling.dp.iskaypet.com`.
- **Dev_Env**: entorno de desarrollo del portal. Namespace `platformportal`. Debe quedar funcionalmente equivalente a prod (host propio dev).
- **Toolkit**: `iskaypetcom/sre-infra/tools/cicd/gitlab-ci-toolkit` (project id 61922532). Templates CI/CD reutilizables (`main-*.yml`, `CI/`, `CD/`).
- **Portal_Template**: nueva template de despliegue a crear en el Toolkit para que el portal la consuma vía `include`.
- **GitOps_Repo**: repo ArgoCD separado (estándar org, opción B) que ArgoCD vigila; el CI escribe en él el tag de imagen y hace push. Patrón observado: `sre-infra/platform-engineering/argocd/{dev,prod}/digital/<subgrupo>`.
- **ArgoCD_Tooling**: instancia ArgoCD en el cluster tooling (`environments/tooling/applications/argocd` en kube-stack), que sincroniza las Applications del cluster tooling.
- **Harbor**: registry `harbor.tooling.dp.iskaypet.com`, proyecto `tooling`, imagen `platformportal`.
- **ESO**: External Secrets Operator, ya desplegado en tooling (`environments/tooling/applications/external-secrets`). Sincroniza secretos desde un backend externo a Secrets de Kubernetes vía `ExternalSecret` + `SecretStore`/`ClusterSecretStore`.
- **Secrets_Backend**: AWS Secrets Manager (cuenta tooling `444455556666`), fuente de verdad de los secretos del portal.
- **Semver_Toolkit**: imagen `semver-toolkit` del toolkit que calcula tags release-candidate (RC) y release a partir de commits.
- **Internal_Secret**: `INTERNAL_API_SECRET`, header `x-internal-secret` que autentica cronjobs/n8n contra endpoints internos del portal.

## Requirements

### Requisito 1: Pipeline CI/CD automatizado del portal

**User Story:** Como SRE, quiero que el portal se construya y despliegue mediante un pipeline de GitLab CI al hacer merge, para olvidarme del `docker build` + `set image` manual.

#### Criterios de Aceptación

1. THE Portal SHALL tener un `.gitlab-ci.yml` que consuma (vía `include`) la Portal_Template del Toolkit, en lugar del pipeline ad-hoc actual.
2. WHEN se haga merge a la rama por defecto, THE pipeline SHALL construir la imagen del portal con Kaniko y publicarla en Harbor (`tooling/platformportal`) con un tag semántico (RC para no-prod, release + `latest` para prod), siguiendo el patrón de `CI/build.yml` del Toolkit.
3. THE pipeline SHALL ejecutar las etapas de calidad existentes del estándar (lint, test si aplica, escaneo de imagen) antes de publicar.
4. THE pipeline SHALL NO requerir que el operador ejecute `docker build`, `docker push` ni `kubectl set image` manualmente para un despliegue normal.
5. WHEN el build de imagen falle, THE pipeline SHALL fallar de forma visible y NO promover ni desplegar una imagen rota.
6. THE pipeline SHALL etiquetar las imágenes de forma única e inmutable por commit/release (no depender solo de `latest`) para permitir trazabilidad y rollback.

### Requisito 2: Despliegue GitOps vía ArgoCD (repo de estado separado)

**User Story:** Como SRE, quiero que el despliegue sea GitOps —el CI actualiza un repo de estado y ArgoCD sincroniza— para tener trazabilidad, auto-sync y rollback por git.

#### Criterios de Aceptación

1. THE despliegue SHALL seguir el patrón de la organización: el estado desplegado (tag de imagen por entorno) vive en un GitOps_Repo **separado** del repo de código del portal, y ArgoCD_Tooling lo sincroniza.
2. WHEN el pipeline publique una imagen nueva, THE pipeline SHALL actualizar el `values.yaml` del entorno correspondiente en el GitOps_Repo (repository + tag) y hacer push, sin tocar el cluster directamente para la mutación de estado.
3. THE chart Helm del portal (Deployment, Service, Ingress, ServiceAccount, ExternalSecret) SHALL ser la fuente de verdad del despliegue y SHALL reflejar el deployment **real** de prod actual (todas las env vars, probes `/api/health`, recursos, IRSA, imagePullSecrets `harbor-registry`, anotaciones de scrape Grafana).
4. THE despliegue a Prod_Env SHALL requerir una acción manual/aprobación (no auto-deploy a prod en cada merge), mientras que Dev_Env PUEDE desplegarse automáticamente.
5. WHEN ArgoCD detecte un cambio en el GitOps_Repo, THE Application SHALL sincronizar y quedar `Synced`/`Healthy`; el pipeline SHALL poder verificar ese estado (patrón del `CD/deploy.yml` del Toolkit).
6. THE solución SHALL permitir rollback a una versión anterior revirtiendo el commit de estado en el GitOps_Repo.
7. THE configuración de conexión a Tooling_Cluster SHALL reutilizar las variables/credenciales ya existentes del estándar (`AWS_*_TOOLING`, `TOOLING_CLUSTER`, `RUNNER_TOOLING_ARN_ROLE`, `KUBECONFIG_PATH`, `AWS_REGION`).

### Requisito 3: Template reutilizable del portal en el Toolkit

**User Story:** Como SRE de plataforma, quiero una template de despliegue del portal en el repo Toolkit, para que el portal (y potencialmente otras apps tooling) la consuma sin duplicar pipeline.

#### Criterios de Aceptación

1. THE Toolkit SHALL incluir una Portal_Template (p. ej. `main-portal.yml` + piezas en `CI/`/`CD/`) coherente con las templates existentes (`main-react.yml`, `CI/build.yml`, `CD/deploy.yml`).
2. THE Portal_Template SHALL contemplar el caso especial del portal: **ambos entornos (dev y prod) en el mismo cluster tooling**, en namespaces distintos (`platformportal` dev, `n8n` prod), no el flujo dev/uat/prod multi-cluster habitual.
3. THE Portal_Template SHALL parametrizar lo específico (namespace, host, nombre de release, GitOps_Repo destino) vía variables, sin hardcodear valores del portal en el Toolkit.
4. THE repo del portal SHALL consumir la Portal_Template por `include` con `ref` fijada a una versión/tag del Toolkit (no `main` flotante) para builds reproducibles.

### Requisito 4: Migración de secretos a External Secrets Operator

**User Story:** Como SRE, quiero que el portal consuma sus secretos vía External Secrets desde AWS Secrets Manager, para eliminar los secretos creados a mano y los secretos en claro en Git.

#### Criterios de Aceptación

1. THE secretos del portal SHALL almacenarse en el Secrets_Backend (AWS Secrets Manager, cuenta tooling) como fuente de verdad, NO en Secrets de Kubernetes creados a mano ni en valores hardcodeados en Git.
2. THE chart del portal SHALL definir un `ExternalSecret` (y el `SecretStore`/`ClusterSecretStore` necesario) que materialice el Secret de Kubernetes que consume el Deployment, con `externalSecrets.enabled: true`.
3. THE ExternalSecret SHALL cubrir TODOS los secretos que hoy usa el portal (al menos: `database-url`, `gitlab-token`, `sonarqube-token`, `GRAFANA_TOKEN`, `awx-token`, `INTERNAL_API_SECRET`, `JIRA_API_TOKEN`, `TEAMS_WEBHOOK_URL`, `FINOPS_TEAMS_WEBHOOK_URL`, `AZURE_AD_CLIENT_ID`, `AZURE_AD_CLIENT_SECRET`, `NEXTAUTH_SECRET`), no solo las 3 del chart actual.
4. THE solución SHALL eliminar del repositorio Git cualquier secreto en claro (el `GRAFANA_TOKEN` y `TEAMS_WEBHOOK_URL` hardcodeados detectados en el chart/manifiestos) y referenciarlos vía ExternalSecret.
5. THE acceso del portal al Secrets_Backend SHALL usar el IRSA/rol del ServiceAccount del portal (no claves estáticas), con permisos mínimos de lectura sobre los secretos del portal.
6. WHEN se rote un secreto en el Secrets_Backend, THE ExternalSecret SHALL re-sincronizar el Secret de Kubernetes sin intervención manual (refreshInterval).
7. THE migración SHALL ser no disruptiva: el portal en prod SHALL seguir funcionando durante y después de la migración (mismas claves/nombres de Secret que espera el Deployment, o transición controlada).

### Requisito 5: Igualar Dev_Env a Prod_Env

**User Story:** Como SRE, quiero un entorno de desarrollo del portal funcionalmente equivalente a producción, para validar cambios (incluido el propio pipeline) antes de tocar prod.

#### Criterios de Aceptación

1. THE Dev_Env SHALL desplegarse con el MISMO chart Helm que Prod_Env, parametrizado por un `values` de dev (namespace `platformportal`, host de dev, posibles réplicas/recursos reducidos).
2. THE Dev_Env SHALL tener los mismos componentes que prod (Deployment, Service, Ingress, ServiceAccount, ExternalSecret) y consumir sus secretos vía ESO desde el Secrets_Backend (sus propios valores de dev cuando aplique).
3. THE Dev_Env SHALL ser desplegado automáticamente por el pipeline al integrar cambios (deploy-dev), sirviendo como validación previa a la promoción a prod.
4. WHEN se promueva a prod, THE proceso SHALL usar la misma imagen ya validada en dev (promoción de artefacto), no una build distinta.
5. THE Dev_Env SHALL tener su propio host/DNS y certificado, sin colisionar con el de prod.

### Requisito 6: Documentación, migración y operación

**User Story:** Como SRE, quiero que el nuevo flujo quede documentado y la transición sea segura, para operar el portal sin sorpresas y poder revertir si algo falla.

#### Criterios de Aceptación

1. THE documentación canónica (`.kiro/steering/portal-architecture.md` y `docs/PORTAL_DOCUMENTATION.md`) SHALL actualizarse: nuevo flujo CI/CD, GitOps, External Secrets, y retirada del procedimiento manual `set image`.
2. THE solución SHALL documentar el procedimiento de rollback y el de rotación/alta de secretos en el Secrets_Backend.
3. THE chart en `kube-stack` (desincronizado) SHALL ser reconciliado o retirado de forma que no haya dos fuentes de verdad del despliegue del portal.
4. THE transición SHALL definir un orden seguro (p. ej. ESO en paralelo a los secretos actuales → validar en dev → cortar a GitOps en prod) que evite downtime del portal en prod.
5. THE nuevo pipeline SHALL validarse end-to-end primero en Dev_Env antes de habilitar el despliegue a Prod_Env.

### Requisito 7: CronJobs del portal gestionados por GitOps

**User Story:** Como SRE, quiero que los cronjobs del portal se gestionen por GitOps con el resto del despliegue, para no tenerlos creados/parcheados a mano y que compartan imagen, secretos y ciclo de vida con el portal.

#### Criterios de Aceptación

1. THE chart del portal SHALL declarar TODOS los cronjobs que hoy corren en Prod_Env (ns `n8n`), a saber: `aws-health-sync` (`*/15 * * * *`), `infra-live-check` (`*/10 * * * *`), `dora-metrics-snapshot` (`0 18 * * *`), `k8s-metrics-snapshot` (`0 19 * * *`), `finops-daily-digest` (`20 10 * * *`, TZ `Europe/Madrid`), `mr-metrics-snapshot` (`0 4 * * *`) y los 6 `lighthouse-*` (`lighthouse-targets-refresh` `0 22 * * *` + `lighthouse-{animalis,kiwoko-es,kiwoko-pt,tiendanimal-es,tiendanimal-pt}` `0 3 */2 * *`).
2. THE cronjobs que invocan endpoints internos del portal (curl/alpine) SHALL heredar el `Internal_Secret` (`INTERNAL_API_SECRET`) desde el Secret materializado por ESO, sin valores en claro.
3. THE cronjobs con imagen propia (`mr-metrics-snapshot`, `lighthouse-scanner`) SHALL poder especificar su imagen y `command`/`args`/`env` por cron (p. ej. `MONITOR_ID` por marca en lighthouse), heredando además los secretos comunes (`DATABASE_URL`, `GITLAB_TOKEN`).
4. WHERE el chart base elegido (`generic-chart`) no disponga de plantilla de CronJob, THE chart SHALL ampliarse con una plantilla de cronjobs (gated por flag, desactivada por defecto) tomando como referencia la de los charts de microservicio (`microservice-chart`), preservando la herencia de `env`+`envFrom` (ESO).
5. THE imágenes auxiliares de cronjobs (`mr-metrics-snapshot`, `lighthouse-scanner`) SHALL construirse y versionarse por el pipeline CI/CD (no a mano), y su tag SHALL materializarse en el GitOps_Repo igual que la imagen principal.
6. THE cronjobs SHALL desplegarse por GitOps junto al portal (misma Application/estado), de modo que no existan cronjobs creados/parcheados a mano fuera de Git.

## Decisiones de alcance (out of scope)

- No se migra el portal a otro cluster: ambos entornos siguen en dp-tooling.
- No se cambia el runtime del portal (Next.js standalone) ni su Dockerfile salvo lo necesario para el build en pipeline.
- No se aborda la parte "agente" de Iskay ni features de producto; esta feature es puramente de infraestructura/entrega.
- La elección del backend de secretos es AWS Secrets Manager (no Parameter Store/Vault) por alineamiento con ESO ya desplegado en tooling.
- GitOps con repo de estado separado (opción B, estándar org), no estado GitOps dentro del repo de código.
