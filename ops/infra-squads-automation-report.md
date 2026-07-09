# Informe: Repos de Infraestructura de Squads — Automatización desde Platform Portal

**Fecha:** 2026-06-02  
**Autor:** SRE/Platform Engineering  
**Objetivo:** Catalogar todos los repos de infra de squads, analizar qué recursos despliegan, identificar patrones comunes y definir las bases para su automatización desde el Platform Portal.

---

## 1. Inventario de Repos

| # | ID | Squad/Domain | Repo Name | Path | Última actividad |
|---|---|---|---|---|---|
| 1 | 47360191 | OMS | oms | iskaypetcom/digital/oms/infrastructure/aws/oms | 2026-04-22 |
| 2 | 47996140 | Takeover | animalis | iskaypetcom/digital/takeover/infrastructure/aws/animalis | 2026-02-18 |
| 3 | 53647843 | Products | infra-product | iskaypetcom/digital/products/infrastructure/aws/infra-product | 2025-12-10 |
| 4 | 55103906 | Marketplace | infra-marketplace | iskaypetcom/digital/marketplace/infrastructure/aws/infra-marketplace | 2026-03-12 |
| 5 | 55815553 | Shipping | infra-shipping | iskaypetcom/digital/shipping/infrastructure/aws/infra-shipping | 2026-04-09 |
| 6 | 56914141 | Stores | infra-stores | iskaypetcom/digital/stores/infrastructure/aws/infra-stores | 2026-01-29 |
| 7 | 57834894 | Pricing | infra-pricing | iskaypetcom/digital/oms/pricing/infrastructure/aws/infra-pricing | 2026-02-18 |
| 8 | 58137344 | Websites | websites | iskaypetcom/digital/websites/infrastructure/aws/websites | 2026-04-13 |
| 9 | 58272907 | Loyalty | loyalty-infra | iskaypetcom/digital/loyalty/infrastructure/aws/loyalty-infra | 2026-06-01 |
| 10 | 58720638 | Payments | infra-payments | iskaypetcom/digital/payments/infrastructure/aws/infra-payments | 2026-04-30 |
| 11 | 59123186 | Business Monitoring | infra-business-monitoring | iskaypetcom/digital/business-monitoring/infrastructure/aws/infra-business-monitoring | 2026-02-03 |
| 12 | 66404361 | Retail/Comerzzia | retail-infra | iskaypetcom/retail/comerzzia/infrastructure/aws/retail-infra | 2026-05-31 |
| 13 | 66981860 | Training | infra-training | iskaypetcom/digital/training/infrastructure/aws/infra-training | 2026-04-09 |
| 14 | 68533182 | Mobile | mobile-infra | iskaypetcom/digital/mobile/infrastructure/aws/mobile-infra | 2026-04-09 |
| 15 | 70892055 | Identity Providers | auth-infra | iskaypetcom/digital/identity-providers/infrastructure/aws/auth-infra | 2026-03-18 |
| 16 | 71455105 | Helios | helios-infra | iskaypetcom/martech/helios/infrastructure/aws/helios-infra | 2026-04-09 |
| 17 | 72395996 | SFSC | infra | iskaypetcom/martech/sfsc/infrastructure/aws/infra | 2026-05-25 |
| 18 | 75679703 | Customers | customers-infra | iskaypetcom/digital/customers/infrastructure/aws/customers-infra | 2026-05-13 |
| 19 | 77927223 | OMS/Animalis | animalis | iskaypetcom/digital/oms/infrastructure/aws/animalis | 2026-04-07 |
| 20 | 80605987 | Core | core-infra | iskaypetcom/digital/core/infrastructure/aws/core-infra | 2026-04-02 |

---

## 2. Estructura de Ficheros (Patrón Estándar)

Todos los repos siguen la misma estructura:

```
repo-root/
├── .gitlab-ci.yml                    # Include de los ficheros por entorno
├── .gitlab-ci-services-dev.yml       # Pipeline init/plan/apply para DEV
├── .gitlab-ci-services-uat.yml       # Pipeline init/plan/apply para UAT (opcional)
├── .gitlab-ci-services-pro.yml       # Pipeline init/plan/apply para PRO
├── README.md
└── iac/
    └── services/
        ├── backend.tf                # terraform { backend "http" {} }
        ├── provider.tf               # AWS provider con assume_role
        ├── variables.tf              # Variables comunes + específicas del recurso
        ├── <recurso-1>.tf            # Definición de recursos
        ├── <recurso-2>.tf            # Definición de recursos
        ├── locals.tf                 # (opcional) valores locales
        └── vars/
            ├── dev.tfvars            # Variables no-sensibles DEV
            ├── uat.tfvars            # Variables no-sensibles UAT (opcional)
            └── pro.tfvars            # Variables no-sensibles PRO
```

### Excepciones (repos con módulos locales):

- **helios-infra**: `iac/services/modules/{eventbridge,secrets_manager,business_rules}/`
- **infra-product**: `iac/services/modules/{shopper-api,subscriptions-api}/`
- **infra-shipping**: `iac/services/modules/my-orders-backend/`
- **sfsc/infra**: `iac/services/modules/hermes/` (el más complejo, incluye Lambda)

---

## 3. Recursos Desplegados por Tipo

### 3.1 SQS Queues (el recurso más común)

**Módulo:** `terraform-aws-modules/sqs/aws` versión `4.0.1`

**Patrón estándar:**
```hcl
module "<nombre>_sqs" {
  source  = "terraform-aws-modules/sqs/aws"
  version = "4.0.1"

  name = "<nombre-cola>"

  create_dlq = true
  dlq_message_retention_seconds = var.dlq_retention_time  # 1209600 (14 días)
  redrive_policy = {
    maxReceiveCount = 3
  }

  create_queue_policy = true
  queue_policy_statements = {
    publish = {
      sid     = "PublishEvents"
      actions = ["sqs:SendMessage"]
      principals = [
        { type = "Service", identifiers = ["sns.amazonaws.com"] },
        { type = "Service", identifiers = ["events.amazonaws.com"] }
      ]
    }
  }

  tags = {
    Terraform    = true
    Environment  = var.environment
    Project      = "<project>"
    Owner        = "Digital"
    Cluster-name = "eks-${var.environment}"
  }
}
```

**Parámetros configurables para el portal:**
| Parámetro | Descripción | Default |
|-----------|-------------|---------|
| `name` | Nombre de la cola | Requerido |
| `create_dlq` | Crear Dead Letter Queue | `true` |
| `dlq_message_retention_seconds` | Retención DLQ (seg) | `1209600` (14d) |
| `maxReceiveCount` | Reintentos antes de DLQ | `3` |
| `principals` | Servicios que pueden enviar | `["sns.amazonaws.com", "events.amazonaws.com"]` |
| `delay_seconds` | Delay de entrega (opcional) | `0` |
| `visibility_timeout_seconds` | Timeout visibilidad (opcional) | `30` |

**Repos que usan SQS:** OMS (15+ colas), Loyalty (5), Stores (2), Business Monitoring (9), Shipping (1), Customers (dinámico), Retail (dinámico)

---

### 3.2 DynamoDB Tables

**Módulo:** `terraform-aws-modules/dynamodb-table/aws` versión `3.3.0`

**Patrón estándar:**
```hcl
module "<nombre>_dynamodb_table" {
  source  = "terraform-aws-modules/dynamodb-table/aws"
  version = "3.3.0"

  name      = "<nombre-tabla>"
  hash_key  = "<partition-key>"
  range_key = "<sort-key>"  # opcional

  attributes = [
    { name = "<key>", type = "S" }
  ]

  point_in_time_recovery_enabled = var.environment == "prod" ? true : false
  billing_mode                   = "PAY_PER_REQUEST"

  global_secondary_indexes = [...]  # opcional
  ttl_attribute_name = "..."        # opcional
  ttl_enabled = true                # opcional

  tags = { ... }
}
```

**Parámetros configurables para el portal:**
| Parámetro | Descripción | Default |
|-----------|-------------|---------|
| `name` | Nombre tabla | Requerido |
| `hash_key` | Partition key | Requerido |
| `range_key` | Sort key | Opcional |
| `attributes` | Definiciones de atributos | Requerido |
| `billing_mode` | Modo facturación | `PAY_PER_REQUEST` |
| `point_in_time_recovery_enabled` | PITR | `true` en prod |
| `global_secondary_indexes` | GSIs | Opcional |
| `ttl_attribute_name` | Campo TTL | Opcional |

**Repos que usan DynamoDB:** OMS (orders_v2, carriers, delivery_promise), Stores (stores), Shipping (delivery_promise_v1), Loyalty (loyalty-premium-club-store)

---

### 3.3 EventBridge Rules + Targets

**Módulo:** `terraform-aws-modules/eventbridge/aws` versión `2.3.0`

**Patrón A — Usar bus existente (mayoría de casos):**
```hcl
module "<nombre>_eventbridge" {
  source  = "terraform-aws-modules/eventbridge/aws"
  version = "2.3.0"

  create_bus          = false
  create_role         = false
  bus_name            = "<nombre-bus>"  # normalmente "oms"
  append_rule_postfix = false

  rules = {
    <rule-name> = {
      description   = "<descripcion>"
      event_pattern = jsonencode({ "detail-type" : ["<evento>"] })
      enabled       = true
    }
  }

  targets = {
    <rule-name> = [
      {
        name            = "<target-name>"
        arn             = module.<sqs>.queue_arn
        dead_letter_arn = module.<sqs>.dead_letter_queue_arn
      }
    ]
  }

  tags = { ... }
}
```

**Patrón B — Crear bus nuevo (customers, retail, helios):**
```hcl
module "<nombre>_eventbridge" {
  source  = "terraform-aws-modules/eventbridge/aws"
  version = "~> 2.0"

  create_bus = true
  bus_name   = var.<bus_name>

  rules = {
    for key, config in local.<configs> : key => {
      description   = "..."
      event_pattern = jsonencode({...})
      enabled       = true
    }
  }

  targets = {
    for key, config in local.<configs> : key => [
      { name = "...", arn = module.<queues>[key].queue_arn }
    ]
  }
}
```

**Parámetros configurables para el portal:**
| Parámetro | Descripción | Default |
|-----------|-------------|---------|
| `bus_name` | Nombre del bus | Requerido |
| `create_bus` | Crear bus o usar existente | `false` |
| `rules` | Lista de reglas (nombre + event_pattern) | Requerido |
| `targets` | Target por regla (SQS ARN normalmente) | Requerido |

**Repos que usan EventBridge:** OMS, Stores, Business Monitoring, Customers, Retail, Helios, Shipping

---

### 3.4 Secrets Manager

**Recurso nativo:** `aws_secretsmanager_secret` + `aws_secretsmanager_secret_version`

**Patrón estándar:**
```hcl
resource "aws_secretsmanager_secret" "<nombre>-secret" {
  name        = "dp/<domain>/<secret-name>"
  description = "<descripcion>"
}

resource "aws_secretsmanager_secret_version" "<nombre>-secret" {
  secret_id = aws_secretsmanager_secret.<nombre>-secret.id
  secret_string = jsonencode({
    "<key1>" = var.<VAR_1>,
    "<key2>" = var.<VAR_2>
  })
}
```

**Convención de naming:** `dp/<domain>/<service-name>` o `dp/<environment>/<service_name>`

**Parámetros configurables para el portal:**
| Parámetro | Descripción | Default |
|-----------|-------------|---------|
| `name` | Path del secreto (dp/<domain>/<name>) | Requerido |
| `description` | Descripción | Requerido |
| `keys` | Lista de keys del JSON | Requerido |

**NOTA:** Los valores de los secretos se pasan como variables sensibles en GitLab CI/CD Variables, NUNCA en tfvars.

**Repos que usan SecretsManager:** Todos excepto Training, Business Monitoring y Shipping

---

### 3.5 SNS Topics

**Recurso nativo:** `aws_sns_topic`

**Patrón estándar:**
```hcl
resource "aws_sns_topic" "<nombre>" {
  name = "<topic-name>"
}
```

**Parámetros configurables para el portal:**
| Parámetro | Descripción |
|-----------|-------------|
| `name` | Nombre del topic | Requerido |

**Repos que usan SNS:** OMS, Loyalty (5 topics), Stores (3 topics)

---

### 3.6 SNS Platform Application (Push Notifications)

**Recurso nativo:** `aws_sns_platform_application`

Solo usado en **Stores**:
```hcl
resource "aws_sns_platform_application" "omspda_application" {
  name                = "com.iskaypet.omspda"
  platform            = "GCM"
  platform_credential = var.GCM_API_KEY_STORES
}
```

---

### 3.7 Lambda (caso excepcional)

Solo usado en **SFSC/Hermes** — módulo local complejo con Lambda + SQS + EventBridge + Secrets. Este NO debería automatizarse inicialmente por su complejidad.

---

## 4. Patrón de CI/CD

### .gitlab-ci.yml (root)
```yaml
include:
  - local: '.gitlab-ci-services-pro.yml'
  - local: '.gitlab-ci-services-dev.yml'
  - local: '.gitlab-ci-services-uat.yml'  # opcional

default:
  image: registry.gitlab.com/gitlab-org/terraform-images/releases/1.1:v0.30.0
  tags:
    - kubernetes-executor
    - iskay

variables:
  TF_USERNAME: "iskay.ci-cd"
  TF_PASSWORD: ${CICD_TOKEN}
  TF_PLUGIN_CACHE_DIR: ${TF_ROOT}/.terraform
  TF_CLI_CONFIG_FILE: ${CI_PROJECT_DIR}/.terraformrc

stages:
  - prepare
  - build
  - deploy
```

### Pipeline por entorno (init → plan → apply)
```yaml
init-services-<env>:
  stage: prepare
  script: gitlab-terraform init -upgrade=true
  environment: { name: <project>-<env> }
  variables:
    TF_STATE_NAME: SERVICES-<ENV>
    TF_ROOT: ${CI_PROJECT_DIR}/iac/services

plan-services-<env>:
  stage: build
  script:
    - gitlab-terraform plan -var-file=vars/<env>.tfvars
    - gitlab-terraform plan-json

apply-services-<env>:
  stage: deploy
  script: gitlab-terraform apply
  rules: [when: manual]  # PRO siempre manual
```

### Variables de entorno (CI/CD Variables en GitLab):
- Variables **sensibles** (passwords, API keys, secrets) → GitLab CI/CD Variables (masked)
- Variables **no-sensibles** (account_id, region, environment) → `vars/<env>.tfvars`

---

## 5. Provider Configuration

```hcl
terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region
  assume_role {
    duration = "1h"
    role_arn = "arn:aws:iam::${var.<account_id_var>}:role/terraform-gl-cicd-apps"
  }
  default_tags {
    tags = {
      environment = var.environment
      terraform   = true
      department  = "<dh|data>"
      domain      = "<domain>"
    }
  }
}
```

**Role estándar:** `terraform-gl-cicd-apps` (existe en todas las cuentas AWS de squads)

---

## 6. Resumen: Recursos a Automatizar desde Platform Portal

| Recurso | Prioridad | Complejidad | Módulo/Recurso TF | Repos que lo usan |
|---------|-----------|-------------|-------------------|-------------------|
| **SQS Queue** | 🔴 Alta | Baja | terraform-aws-modules/sqs/aws v4.0.1 | 10/20 repos |
| **SecretsManager** | 🔴 Alta | Baja | aws_secretsmanager_secret (nativo) | 15/20 repos |
| **EventBridge Rule** | 🟡 Media | Media | terraform-aws-modules/eventbridge/aws v2.3.0 | 8/20 repos |
| **DynamoDB Table** | 🟡 Media | Media | terraform-aws-modules/dynamodb-table/aws v3.3.0 | 5/20 repos |
| **SNS Topic** | 🟢 Baja | Baja | aws_sns_topic (nativo) | 3/20 repos |
| **SNS Platform App** | ⚪ Muy baja | Baja | aws_sns_platform_application (nativo) | 1/20 repos |
| **Lambda** | ⚫ No automatizar | Alta | Módulo custom complejo | 1/20 repos |

---

## 7. Propuesta de Automatización

### Fase 1 — SQS + SecretsManager (quick wins)
El portal debería poder:
1. **Crear SQS Queue** con formulario: nombre, DLQ sí/no, maxReceiveCount, principals
2. **Crear Secret** con formulario: path (dp/<domain>/<name>), keys del JSON
3. Generar el .tf y el commit al repo correcto
4. Triggerar pipeline automáticamente

### Fase 2 — EventBridge + DynamoDB
1. **Crear EventBridge Rule**: seleccionar bus, definir event_pattern, seleccionar target (SQS existente)
2. **Crear DynamoDB Table**: nombre, keys, GSIs, billing mode

### Fase 3 — SNS + Orquestación completa
1. **Crear SNS Topic** + subscripciones
2. **Flujos combinados**: "Quiero una cola que escuche un evento X del bus Y" → genera SQS + EventBridge rule + target

### Datos necesarios del Portal para cada recurso:
```json
{
  "target_repo_id": "<gitlab_project_id>",
  "environment": "dev|uat|pro",
  "aws_account_id": "<account>",
  "domain": "<squad>",
  "resource_type": "sqs|dynamodb|eventbridge|secret|sns",
  "resource_config": { ... }
}
```

### Flujo de automatización:
```
Portal → API → Genera .tf → Git commit → Push → Pipeline trigger → Plan → (Approval) → Apply
```

---

## 8. Mapping de Cuentas AWS por Squad

| Squad | DEV | UAT | PRO |
|-------|-----|-----|-----|
| Digital (OMS, Shipping, etc.) | 999900001111 | 000011112222 | 111222333444 |
| Retail | 444555666777 | 555666777888 | 666777888999 |
| Helios | 555566667777 | 666677778888 | 777788889999 |
| Animalis | 777888999000 | — | 888999000111 |

---

## 9. Variables Sensibles (Patrón de Gestión)

Las variables sensibles NUNCA van en tfvars. Se gestionan así:
1. Se definen en `variables.tf` con `sensitive = true`
2. Se configuran como **CI/CD Variables** en GitLab (Project → Settings → CI/CD → Variables)
3. El nombre de la variable TF se mapea automáticamente: `TF_VAR_<nombre>` en GitLab

**Para el portal:** Necesitamos una API que configure las CI/CD variables en GitLab al crear un secreto:
```
POST /api/v4/projects/:id/variables
{ "key": "TF_VAR_<var_name>", "value": "<secret>", "masked": true, "protected": true }
```

---

## 10. Repos Vacíos o Sin Recursos Útiles

| Repo | Estado |
|------|--------|
| infra-training (66981860) | Solo scaffolding, sin recursos reales |
| takeover/animalis (47996140) | Solo SQS comentado + secretsmanager |
| infra-pricing (57834894) | Solo secretsmanager (bundles) |

---

## 11. Conclusiones

1. **El 95% de la infra de squads se reduce a 4 tipos de recursos:** SQS, SecretsManager, EventBridge y DynamoDB.
2. **Todos los repos siguen la misma estructura** — esto facilita enormemente la automatización.
3. **El patrón es totalmente plantillable** — los módulos son siempre los mismos con las mismas versiones.
4. **Las variables sensibles** son el mayor reto: hay que gestionar CI/CD Variables de GitLab como parte del flujo.
5. **El bus EventBridge "oms"** es compartido por muchos squads — cuidado con colisiones de rule names.
6. **El repo SFSC/Hermes** es el outlier más complejo y NO debería automatizarse en primera instancia.
