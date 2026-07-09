# Design Document

> Feature: Portal CI/CD + GitOps + External Secrets

## Overview

Esta feature sustituye el despliegue manual del portal (`docker buildx` + `set image`) por un flujo **CI/CD + GitOps** alineado con el estándar de IskayPet, migra los secretos a **External Secrets Operator (ESO)** con backend AWS Secrets Manager, y deja **dev y prod equivalentes** en el cluster tooling.

Anclado en lo ya investigado y existente (no se reinventa nada):

1. **Toolkit CI/CD** (`gitlab-ci-toolkit`, id 61922532): patrón `main-*.yml` (orquestador por stack) que incluye `CI/build.yml` (Kaniko→Harbor + semver + scan) y `CD/deploy.yml` (el CI escribe el tag en el `values.yaml` del repo GitOps y hace push; ArgoCD sincroniza).
2. **Repo de estado GitOps del cluster tooling**: `sre-infra/platform-engineering/argocd/tooling` (ya existe), con estructura `shared-apps/<app>/` de manifiestos. **Backstage** es el patrón de referencia: tiene `deployment + service + ingress + namespace + serviceaccount(IRSA) + secretstore + externalsecret`.
3. **ESO ya desplegado** en tooling (`environments/tooling/applications/external-secrets`). Patrón de uso (de backstage): `SecretStore` con auth JWT vía SA IRSA → AWS Secrets Manager (eu-west-1); claves `dp/tooling/<app>_<grupo>`; `ExternalSecret` con `refreshInterval: 1h`.
4. **ArgoCD tooling** gestionado por kube-stack (`environments/tooling/applications/argocd/{applications,applicationsets,projects}`); el helmfile de tooling se aplica con credenciales `AWS_*_TOOLING` + `RUNNER_TOOLING_ARN_ROLE`.

### Caso especial del portal

A diferencia del flujo estándar dev/uat/prod **multi-cluster**, el portal tiene **dev (ns `platformportal`) y prod (ns `n8n`) en el MISMO cluster tooling**. El diseño adapta el toolkit a "dos entornos, un cluster, dos namespaces".

### Mapa de componentes

```mermaid
flowchart TD
  subgraph Dev[Developer]
    PR[MR / merge a main\nrepo platformportal]
  end

  subgraph CI[GitLab CI - Portal_Template del Toolkit]
    B[build: Kaniko -> Harbor\ntooling/platformportal:RC/release]
    SC[image scan Harbor]
    DD[deploy_dev: escribe tag en\nGitOps_Repo (env dev) + push]
    DP[deploy_prod: manual\nescribe tag en GitOps_Repo (env prod) + push]
  end

  subgraph Harbor[harbor.tooling.dp.iskaypet.com]
    IMG[tooling/platformportal:<tag>]
  end

  subgraph GitOps[sre-infra/.../argocd/tooling]
    DEVV[shared-apps/portal-dev/values + manifests]
    PRODV[shared-apps/portal-prod/values + manifests]
  end

  subgraph ArgoCD[ArgoCD @ dp-tooling]
    APPDEV[Application portal-dev\nns platformportal]
    APPPROD[Application portal-prod\nns n8n]
  end

  subgraph K8s[dp-tooling]
    DEPDEV[Deployment portal\nns platformportal]
    DEPPROD[Deployment n8n-webhooks\nns n8n]
    ESO[External Secrets Operator]
  end

  subgraph AWS[AWS Secrets Manager 444455556666]
    SM[dp/tooling/portal_*]
  end

  PR --> B --> SC
  B --> IMG
  SC --> DD --> DEVV
  SC --> DP --> PRODV
  DEVV --> APPDEV --> DEPDEV
  PRODV --> APPPROD --> DEPPROD
  IMG -. pull .-> DEPDEV
  IMG -. pull .-> DEPPROD
  ESO --> SM
  ESO -. materializa Secret .-> DEPDEV
  ESO -. materializa Secret .-> DEPPROD
```

## Architecture

### Repositorios implicados

| Repo | Rol | Cambios |
|------|-----|---------|
| `platformportal` (este) | Código + chart Helm + `.gitlab-ci.yml` que incluye la Portal_Template | Añadir `.helm/` (chart) y `.gitlab-ci.yml` nuevo |
| `gitlab-ci-toolkit` (61922532) | Templates reutilizables | Añadir `main-portal.yml` + piezas `CD/deploy-portal.yml` |
| `argocd/tooling` (GitOps_Repo) | Estado desplegado que ArgoCD vigila | Añadir `shared-apps/portal-dev/` y `shared-apps/portal-prod/` |
| `kube-stack` | ArgoCD Applications del cluster tooling | Registrar Applications `portal-dev`/`portal-prod`; retirar el chart fósil `n8n-webhooks` |

### Flujo CI/CD

1. **build** (Kaniko → Harbor): tag RC `${semver-rc}` en cada integración; en `main`, además `release` + `latest`. Reutiliza `CI/build.yml` (proyecto Harbor dinámico, scan).
2. **deploy_dev** (automático): clona `argocd/tooling`, hace `yq` para fijar `image.tag` en `shared-apps/portal-dev/values.yaml`, commit + push. ArgoCD sincroniza la Application `portal-dev` (ns `platformportal`).
3. **deploy_prod** (manual / aprobación): igual contra `shared-apps/portal-prod/values.yaml` (ns `n8n`). Promueve la **misma imagen** ya validada en dev. Verifica `Synced`/`Healthy` vía el patrón de `CD/deploy.yml`.

### Conexión a tooling (reutilizada del estándar)

El job que verifica el sync usa las variables ya existentes: `AWS_ACCESS_KEY_ID_TOOLING`, `AWS_SECRET_ACCESS_KEY_TOOLING`, `TOOLING_CLUSTER`, `RUNNER_TOOLING_ARN_ROLE`, `KUBECONFIG_PATH`, `AWS_REGION` (eu-west-1). La mutación de estado es solo `git push` al GitOps_Repo; el cluster lo toca ArgoCD.

## Decisión de chart: reutilizar `generic-chart` corporativo (no chart propio)

En vez de mantener un chart Helm propio en `.helm/`, el portal **reutiliza el chart corporativo `generic-chart`** que el equipo ya mantiene en `iskaypetcom/sre-infra/platform-engineering/packages/generic-chart` (project id 71265300), publicado como paquete Helm en el GitLab Package Registry del propio proyecto (`/packages/helm/stable`, versionado por semver-tag).

### Por qué `generic-chart` y no los charts de microservicio

Se evaluaron los 4 charts del grupo `packages`:

| Chart | Host ingress | ESO | Node affinity | Apto portal |
|-------|--------------|-----|---------------|-------------|
| `microservice-chart` / `oms-chart` / `front-chart` | **fijo** `<release>.<env>.dp.iskaypet.com` (hardcodeado) | ✅ nativo | **`required` por label `department`** (digital/retail/data/helios) | ❌ |
| `generic-chart` (estilo Bitnami + subchart `common`) | **arbitrario** (`ingress.hostname`, `extraHosts`, `extraTls`) | ❌ (no trae templates ESO) | configurable (`app.affinity`) | ✅ |

Los charts de microservicio **no sirven** para el portal por dos motivos verificados contra el cluster:
1. **Host fijo**: construyen `<release>.<env>.dp.iskaypet.com`; el portal usa `portal.today.tooling.dp.iskaypet.com` (con `today`/`tooling`), que ya tiene cert TLS, DNS y está registrado como redirect URI en Azure AD para el SSO. No se puede cambiar sin romper el login (`NEXTAUTH_URL`, callback).
2. **Node affinity `required` por `department`**: los nodos del cluster **tooling NO tienen** label `department` → el pod quedaría `Pending`. No es configurable.

`generic-chart` es el único pensado para apps genéricas/plataforma: host libre, affinity configurable, IRSA por `serviceAccount.annotations`, `extraEnvVarsCM`/`extraEnvVarsSecret`, `extraDeploy` para objetos arbitrarios, y un ingress nativo que soporta el host real (→ **no hace falta un Ingress separado ni redirect**; se descartó el redirect porque cambiaría la URL y rompería el SSO).

### Mejora del `generic-chart` (aportada por esta feature)

`generic-chart` no trae soporte ESO ni CronJob. Esta feature **amplía el chart corporativo** (cambios gated por flag, **default off** → no afecta a otros consumidores), tomando como referencia `microservice-chart`:
- `templates/secret-store.yaml` + `templates/secret-manager.yaml`: `SecretStore` (AWS SecretsManager, auth JWT vía el SA con IRSA) + `ExternalSecret` (`refreshInterval: 1h`), gated por `secret_manager.enabled`.
- `templates/cronjob.yaml`: itera `cronjobs.jobs`, hereda `env` + `envFrom` (Secret de ESO), permite `image`/`command`/`args`/`timezone`/`env`/`schedule` por cron. Gated por `cronjobs.enabled`.

El chart mejorado se publica como nueva versión (≥ 0.3.0) y el portal lo fija con `ref`/version.

### Estructura en este repo (umbrella chart)

```
.helm/
  Chart.yaml             # umbrella: dependency generic-chart (>=0.3.0) desde el Helm repo del proyecto
  values.yaml            # values del portal, anidados bajo la clave "generic-chart"
  values-dev.yaml        # override: host dev, recursos reducidos
  values-prod.yaml       # override: host prod
```

Los values del portal viven bajo la clave `generic-chart:` (alias de la dependencia) e incluyen: `app.image` (`harbor.tooling.dp.iskaypet.com/tooling/platformportal`, tag escrito por el CI), `serviceAccount.annotations` (IRSA `portal-inventory-irsa`), `ingress.hostname` (host real), `secret_manager.resources` (mapa de las 13 claves `dp/tooling/portal_*`), `configMap` (env no sensibles) y `cronjobs.jobs` (los 12 cronjobs).

### Modelo de secretos con `generic-chart`

`secret_manager` materializa un Secret `portal-env` que el Deployment consume por `extraEnvVarsSecret`. Como `generic-chart` inyecta el secret por `envFrom secretRef`, los `secretKey` se nombran como la **env var final** (sin guiones): `DATABASE_URL`, `GITLAB_TOKEN`, `GRAFANA_TOKEN`, `INTERNAL_API_SECRET`, etc. Cada uno mapea a su `sm_name` (`dp/tooling/portal_*`) + `property` (el campo JSON del secreto en Secrets Manager). Esto difiere del enfoque "mismo nombre `platformportal-secrets`" del diseño original, pero es equivalente y no disruptivo: en el corte de prod (Bloque F) se valida que el set de variables del pod es idéntico antes/después.

## Data Models / Artefactos

### 1. (Obsoleto) Chart Helm propio

> **Descartado.** El primer enfoque creaba un chart propio en `.helm/templates/`. Se sustituye por el umbrella sobre `generic-chart` (ver sección anterior). `image.repository` = `harbor.tooling.dp.iskaypet.com/tooling/platformportal` (NO ECR). `image.tag` lo escribe el CI en el GitOps_Repo.

### 2. ExternalSecret + SecretStore (patrón backstage)

`SecretStore` (auth JWT vía SA IRSA → AWS Secrets Manager eu-west-1):

```yaml
apiVersion: external-secrets.io/v1beta1   # alinear a la versión del ESO desplegado
kind: SecretStore
metadata:
  name: portal-secret-store
spec:
  provider:
    aws:
      service: SecretsManager
      region: eu-west-1
      auth:
        jwt:
          serviceAccountRef:
            name: portal-secrets-sa
```

`ServiceAccount` con IRSA (rol con lectura sobre `dp/tooling/portal_*`):

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: portal-secrets-sa
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::444455556666:role/portal-secrets-access
```

`ExternalSecret` que materializa el Secret consumido por el Deployment (cubre TODOS los secretos actuales, no solo 3):

```yaml
apiVersion: external-secrets.io/v1beta1
kind: ExternalSecret
metadata:
  name: portal-env
spec:
  refreshInterval: 1h
  secretStoreRef: { kind: SecretStore, name: portal-secret-store }
  target:
    name: platformportal-secrets   # mismo nombre que hoy espera el Deployment (no disruptivo)
  data:
    - { secretKey: database-url,             remoteRef: { key: dp/tooling/portal_db,        property: url } }
    - { secretKey: gitlab-token,             remoteRef: { key: dp/tooling/portal_gitlab,    property: token } }
    - { secretKey: sonarqube-token,          remoteRef: { key: dp/tooling/portal_sonarqube, property: token } }
    - { secretKey: GRAFANA_TOKEN,            remoteRef: { key: dp/tooling/portal_grafana,   property: token } }
    - { secretKey: awx-token,                remoteRef: { key: dp/tooling/portal_awx,       property: token } }
    - { secretKey: INTERNAL_API_SECRET,      remoteRef: { key: dp/tooling/portal_internal,  property: secret } }
    - { secretKey: JIRA_API_TOKEN,           remoteRef: { key: dp/tooling/portal_jira,      property: token } }
    - { secretKey: TEAMS_WEBHOOK_URL,        remoteRef: { key: dp/tooling/portal_teams,     property: sre_webhook } }
    - { secretKey: FINOPS_TEAMS_WEBHOOK_URL, remoteRef: { key: dp/tooling/portal_teams,     property: finops_webhook } }
    - { secretKey: AWS_HEALTH_QUEUE_URL,     remoteRef: { key: dp/tooling/portal_aws_health, property: queue_url } }
    - { secretKey: AZURE_AD_CLIENT_ID,       remoteRef: { key: dp/tooling/portal_azure,     property: client_id } }
    - { secretKey: AZURE_AD_CLIENT_SECRET,   remoteRef: { key: dp/tooling/portal_azure,     property: client_secret } }
    - { secretKey: NEXTAUTH_SECRET,          remoteRef: { key: dp/tooling/portal_nextauth,  property: secret } }
```

> `target.name: platformportal-secrets` reutiliza el nombre del Secret que el Deployment ya consume vía `envFrom` → migración no disruptiva. El `n8n-webhooks-env` (Azure/NextAuth) se consolida aquí o se mantiene como segundo ExternalSecret de transición.

### 3. ArgoCD Applications (en kube-stack)

Dos Applications nuevas en `environments/tooling/applications/argocd/applications/`: `portal-dev` (path `shared-apps/portal-dev`, ns `platformportal`) y `portal-prod` (path `shared-apps/portal-prod`, ns `n8n`), apuntando al GitOps_Repo `argocd/tooling`, con `syncPolicy.automated` (prod con `prune`/`selfHeal` a decidir).

### 4. Portal_Template en el Toolkit

`main-portal.yml` que incluye `CI/build.yml`, escaneo, y un `CD/deploy-portal.yml` adaptado: dos targets de despliegue al MISMO repo (`argocd/tooling`) en paths `shared-apps/portal-dev` / `shared-apps/portal-prod`, parametrizados por variables (`PORTAL_NS_DEV=platformportal`, `PORTAL_NS_PROD=n8n`, `GITOPS_REPO=argocd/tooling`, hosts). El repo del portal lo consume por `include` con `ref` fijado a un tag del toolkit.

## Migración (orden seguro, sin downtime)

```mermaid
flowchart LR
  S1[1. Crear secretos en\nAWS Secrets Manager\ndp/tooling/portal_*] --> S2[2. Crear rol IRSA\nportal-secrets-access]
  S2 --> S3[3. Desplegar ESO objects\n(SecretStore+ExternalSecret)\nen DEV, validar Secret]
  S3 --> S4[4. Montar chart + Application\nportal-dev, validar portal dev\nfuncional = prod]
  S4 --> S5[5. Pipeline end-to-end en DEV]
  S5 --> S6[6. ExternalSecret en PROD\nmaterializa platformportal-secrets\n(mismo nombre, no disruptivo)]
  S6 --> S7[7. Application portal-prod\n+ primer deploy GitOps]
  S7 --> S8[8. Retirar chart fósil n8n-webhooks\nde kube-stack + quitar set image]
```

Clave de no-disrupción: el `ExternalSecret` de prod escribe el **mismo** Secret (`platformportal-secrets`) que el Deployment ya consume; al adoptarlo, ESO pasa a ser el dueño de ese Secret. Se valida primero en dev.

## Error Handling

| Escenario | Manejo |
|-----------|--------|
| Build de imagen falla | Pipeline falla; no se promueve ni se escribe tag en GitOps_Repo. |
| ESO no puede leer un secreto | `ExternalSecret` queda `SecretSyncedError`; el Secret previo persiste (no se borra) → portal sigue vivo. Validado en dev primero. |
| ArgoCD no sincroniza / Degraded | El job de verificación (patrón `CD/deploy.yml`) falla el pipeline; rollback = revertir commit de estado. |
| Secreto en claro en Git | Eliminado del chart; referenciado vía ExternalSecret. Rotar el `GRAFANA_TOKEN`/webhooks expuestos tras migrar. |
| Tag fósil / divergencia git-realidad | El chart pasa a reflejar el deployment real; kube-stack reconciliado/retirado (una sola fuente de verdad). |

## Correctness Properties

Propiedades verificables (no PBT de código, sino invariantes operativas del flujo):

### 5. CronJobs del portal (vía `generic-chart` mejorado)

Los 12 cronjobs de prod se declaran en los values bajo `cronjobs.jobs`. Tres patrones:

| Patrón | Cronjobs | Imagen | Hereda |
|--------|----------|--------|--------|
| curl/alpine → endpoint interno | `aws-health-sync`, `infra-live-check`, `dora-metrics-snapshot`, `k8s-metrics-snapshot`, `finops-daily-digest` | `curlimages/curl` / `alpine:3.19` | `INTERNAL_API_SECRET` (de ESO) |
| imagen MR | `mr-metrics-snapshot` | `tooling/mr-metrics-snapshot` | `DATABASE_URL`, `GITLAB_TOKEN`, env `GITLAB_URL` |
| imagen Lighthouse | `lighthouse-targets-refresh` + 5 `lighthouse-{animalis,kiwoko-es,kiwoko-pt,tiendanimal-es,tiendanimal-pt}` | `tooling/lighthouse-scanner` | `DATABASE_URL`, env por cron (`MONITOR_ID`, etc.) |

`cronjobs.jobs` (forma):

```yaml
cronjobs:
  enabled: true
  jobs:
    - name: aws-health-sync
      schedule: "*/15 * * * *"
      image: curlimages/curl:latest
      command: ["/bin/sh","-c", "<curl POST /api/aws-health/sync con x-internal-secret>"]
      # hereda INTERNAL_API_SECRET vía envFrom del Secret de ESO
    - name: finops-daily-digest
      schedule: "20 10 * * *"
      timezone: Europe/Madrid
      image: curlimages/curl:latest
      command: [...]
    - name: mr-metrics-snapshot
      schedule: "0 4 * * *"
      image: harbor.tooling.dp.iskaypet.com/tooling/mr-metrics-snapshot:<tag>
      command: ["node","/app/mr-metrics-snapshot.js"]
      env: { GITLAB_URL: https://gitlab.com }
    - name: lighthouse-animalis
      schedule: "0 3 */2 * *"
      image: harbor.tooling.dp.iskaypet.com/tooling/lighthouse-scanner:<tag>
      command: ["node","/app/lighthouse-scan.js"]
      env: { MONITOR_ID: "1" }
    # ... resto lighthouse (MONITOR_ID 2..5) + lighthouse-targets-refresh
```

Las imágenes `mr-metrics-snapshot` y `lighthouse-scanner` (Dockerfiles `Dockerfile.mr-metrics`, `ops/Dockerfile.lighthouse`) las construye y versiona el pipeline; el CI escribe sus tags en el GitOps_Repo junto al tag del portal. Los cronjobs comparten el SA con IRSA (necesario para los que tocan AWS) y el `imagePullSecrets` de Harbor.

### Property 1: Una sola fuente de verdad del despliegue
Tras la migración, el estado desplegado del portal (imagen + tag por entorno) proviene EXCLUSIVAMENTE del GitOps_Repo `argocd/tooling`; no existe un segundo chart activo (kube-stack fósil retirado) ni `set image` manual.
**Validates: Requirements 2.1, 6.3**

### Property 2: Sin secretos en claro en Git
Ningún repositorio (portal, toolkit, GitOps_Repo) contiene valores de secretos en claro; todos se resuelven vía ExternalSecret desde AWS Secrets Manager.
**Validates: Requirements 4.1, 4.4**

### Property 3: Despliegue reproducible y trazable
Para cualquier release, existe un commit en el GitOps_Repo que fija el tag inmutable de imagen desplegado, y revertirlo restaura la versión anterior.
**Validates: Requirements 1.6, 2.6**

### Property 4: Prod requiere intención explícita
Ningún merge despliega a Prod_Env automáticamente; prod exige acción manual/aprobación. Dev sí es automático.
**Validates: Requirements 2.4, 5.3**

### Property 5: Dev y prod equivalentes
Dev_Env y Prod_Env usan el MISMO chart, difiriendo solo en `values-{dev,prod}` (namespace, host, escala); la promoción a prod usa la misma imagen validada en dev.
**Validates: Requirements 5.1, 5.4**

### Property 6: Secretos completos y no disruptivos
El Secret materializado por ESO contiene TODAS las claves que el Deployment consume; el portal en prod no pierde ninguna variable durante la migración (mismo nombre de Secret).
**Validates: Requirements 4.3, 4.7**

### Property 7: CronJobs completos y gestionados por GitOps
Los 12 cronjobs de prod existen en el chart/GitOps con su schedule/timezone/imagen reales; ninguno queda creado o parcheado a mano fuera de Git, y heredan sus secretos de ESO (sin valores en claro).
**Validates: Requirements 7.1, 7.2, 7.6**

## Testing Strategy

Esta feature es de infraestructura/entrega; la validación es operativa y se hace **primero en dev**:

- **ESO en dev**: aplicar SecretStore+ExternalSecret, verificar que el Secret de Kubernetes se materializa con todas las claves (`kubectl get secret ... -o json` → contar claves vs esperadas) y que el pod arranca.
- **Pipeline en dev**: un merge dispara build→Harbor→push GitOps→ArgoCD sync; verificar imagen y `Synced/Healthy`.
- **Equivalencia dev↔prod**: smoke test del portal dev (login Azure, `/api/health`, una query FinOps) igual que prod.
- **Promoción a prod**: deploy manual, verificar que corre la MISMA imagen validada en dev y que `platformportal-secrets` lo gestiona ESO.
- **Rollback**: revertir el commit de tag en el GitOps_Repo y confirmar que ArgoCD vuelve a la versión previa.
- **No-regresión de secretos**: diff de claves del Secret antes/después de adoptar ESO en prod (deben coincidir).

## Decisiones y trade-offs

1. **GitOps_Repo = `argocd/tooling` existente** (no uno nuevo por el portal): es el repo de estado del cluster tooling y ya aloja apps compartidas (backstage, tech-radar). Encaja con "dos entornos en un cluster".
2. **Mismo nombre de Secret (`platformportal-secrets`)** para la migración ESO: minimiza cambios en el Deployment y permite cortar sin downtime.
3. **AWS Secrets Manager** (no Parameter Store/Vault): es lo que ya usa ESO en tooling (patrón backstage), claves `dp/tooling/*`.
4. **Prod manual, dev automático**: el portal es interno pero prod-facing; se evita auto-deploy a prod por seguridad operativa.
5. **Template en el Toolkit** (no pipeline ad-hoc): reutilizable y alineado con el resto de la org; el portal la consume con `ref` fijado para reproducibilidad.
6. **Retirar el chart fósil de kube-stack**: evita dos fuentes de verdad; el chart vivo pasa a `.helm/` del repo del portal + estado en `argocd/tooling`.
