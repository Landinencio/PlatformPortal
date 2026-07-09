# Registro 4.1 — Palanca 2: Compromiso RDS (+ ElastiCache / OpenSearch / Fargate / Lambda)

> Artefacto auditable de la **Tarea 4.1** del Estudio FinOps de Ahorro AWS. Este fichero es el
> registro de evidencia propio de la Palanca 2; **no** modifica `catalogo-evidencias.md`. Sigue el
> mismo esquema del `Catálogo_Evidencias` (consulta CUR re-ejecutable, Mes_Referencia, fecha de
> extracción, versión del `Dataset_Congelado`, moneda, recurso(s) o "no atribuible", dimensión de
> agregación). Las cifras quedan **congeladas** contra el `Dataset_Congelado`.

**Validates: Requirements 8.2, 8.3, 2.1, 2.3**

**Tarea (alcance 4.1):** ejecutar la consulta CUR de cómputo RDS y su cobertura, y **congelar** las
cifras. La aplicación de la fórmula de ahorro, la clasificación Estimado y el marcado "requiere
Barrido_Utilizacion" corresponden a la Tarea 4.3; la `Verificacion_Recurso_Vivo` a la Tarea 4.2.

## Parámetros de anclaje (Req 1.2, 1.3, 2.5)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23T08:21:43Z` (UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Cuenta CUR | `600700800900` (root-iskaypet), `eu-west-1` |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |

## Cadena de acceso a datos (reproducibilidad — Req 7.1, 7.2)

| Parámetro | Valor |
|-----------|-------|
| Motor | Amazon Athena (CUR 2.0) |
| Base de datos / tabla | `athenacurcfn_finnops` / `data` |
| Región | `eu-west-1` |
| Cuenta CUR | `600700800900` (root-iskaypet) |
| Rol de acceso | `Cur-AWSS3CURLambdaExecutor` (perfil `root-iskaypet`) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |

---

## 1. RDS — Cómputo de instancia vs storage vs backups (Req 8.2)

### Hallazgo metodológico (corrección de la consulta del `design.md`)

La consulta del `design.md` aísla el cómputo con `line_item_usage_type LIKE '%InstanceUsage%'`. Ese
filtro **infravalora** el cómputo de instancia porque las implantaciones **Multi-AZ** facturan el
cómputo bajo el usage_type `…Multi-AZUsage:db.<clase>` (sin la subcadena `InstanceUsage`). Verificado
en el CUR del Mes_Referencia: `%InstanceUsage%` solo recupera `2 701,39 USD` (Single-AZ), mientras que
el cómputo de instancia **real** (Single-AZ + Multi-AZ) es `6 616,31 USD`. El cómputo Multi-AZ omitido
asciende a `3 914,93 USD` (p. ej. `EU-Multi-AZUsage:db.m6i.4xl` `2 249,86 USD`, `…:db.t4g.medium`
`1 334,74 USD`). La cifra canónica congelada usa la clasificación robusta
(`%InstanceUsage% OR %Multi-AZUsage%`).

### Consulta CUR canónica — clasificación de componentes RDS (re-ejecutable)

Separa cómputo de instancia, storage, backups y Extended Support, e identifica la cobertura RI/SP
mediante `reservation_reservation_a_r_n`:

```sql
SELECT
  CASE
    WHEN line_item_usage_type LIKE '%InstanceUsage%'
      OR line_item_usage_type LIKE '%Multi-AZUsage%'                 THEN 'instance_compute'
    WHEN line_item_usage_type LIKE '%Storage%'
      OR line_item_usage_type LIKE '%PIOPS%'
      OR line_item_usage_type LIKE '%Throughput%'
      OR line_item_usage_type LIKE '%StorageIOUsage%'                THEN 'storage'
    WHEN line_item_usage_type LIKE '%BackupUsage%'
      OR line_item_usage_type LIKE '%SnapshotUsage%'                 THEN 'backup'
    WHEN line_item_usage_type LIKE '%ExtendedSupport%'               THEN 'extended_support'
    ELSE 'other'
  END                                                                AS rds_component,
  SUM(line_item_unblended_cost)                                      AS cost,
  SUM(CASE WHEN reservation_reservation_a_r_n <> '' THEN line_item_unblended_cost ELSE 0 END) AS covered,
  SUM(line_item_usage_amount)                                        AS usage_amt,
  COUNT(*)                                                           AS line_items
FROM data
WHERE line_item_product_code = 'AmazonRDS'
  AND line_item_line_item_type IN ('Usage','DiscountedUsage')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

- `QueryExecutionId`: `1970253b-db7b-4211-bf0e-97fe49d53b31` · Estado `SUCCEEDED` · escaneado ~5,4 MB.
- Consulta de soporte (desglose del bucket `other`, para confirmar que solo es data-transfer):
  `QueryExecutionId` `188eaab5-4ed7-4220-866e-bb264f108705`.
- Consulta del `design.md` literal (`%InstanceUsage%` por cuenta, Single-AZ only):
  `QueryExecutionId` `04734431-d108-41df-a145-e9af7dc7913a` (documenta la infravaloración).

### Cifras congeladas — componentes RDS (USD, half-up 2 decimales)

| Componente RDS | Coste (USD) | Cubierto RI/SP (USD) | Cobertura % | Líneas | Tratamiento |
|----------------|------------:|---------------------:|------------:|-------:|-------------|
| **Cómputo de instancia** (InstanceUsage + Multi-AZUsage) | **6 616,31** | **0,00** | **0,0 %** | 2 373 | Base de la Palanca 2 (cómputo sin cobertura) |
| Storage (GP3/GP2, PIOPS, throughput) | 5 201,25 | 0,00 | 0,0 % | 2 637 | Separado del cómputo (Req 8.2); no es base de compromiso |
| Backups / snapshots | 500,06 | 0,00 | 0,0 % | 1 080 | Separado del cómputo (Req 8.2) |
| Extended Support (PG13 EOL) | 1 169,52 | 0,00 | n/a | 183 | **Fuera de esta Palanca** → Palanca 3 (Tarea 5.x) |
| Other (data transfer RDS) | 0,01 | 0,00 | n/a | 6 605 | Residual no direccionable |

- **Cómputo de instancia RDS sin cobertura RI/SP (cifra clave, Req 8.2):** `6 616,31 USD` — el
  **100 %** del cómputo de instancia está **on-demand** (`covered = 0,00`, `reservation_reservation_a_r_n`
  vacío en todas las filas). Cobertura de compromiso RDS = **0,0 %**.
- Reparto Single-AZ vs Multi-AZ del cómputo: Single-AZ `2 701,39 USD` · Multi-AZ `3 914,93 USD`.

### Desglose por cuenta del cómputo de instancia RDS (Req 2.3 — dimensión `line_item_usage_account_id`)

Consulta (corregida, incluye Multi-AZ):

```sql
SELECT line_item_usage_account_id AS account,
       SUM(line_item_unblended_cost) AS instance_compute,
       SUM(CASE WHEN reservation_reservation_a_r_n <> '' THEN line_item_unblended_cost ELSE 0 END) AS covered,
       SUM(CASE WHEN line_item_usage_type LIKE '%Multi-AZ%' THEN line_item_unblended_cost ELSE 0 END) AS multi_az_part,
       SUM(line_item_usage_amount) AS usage_hours,
       COUNT(*) AS line_items
FROM data
WHERE line_item_product_code = 'AmazonRDS'
  AND (line_item_usage_type LIKE '%InstanceUsage%' OR line_item_usage_type LIKE '%Multi-AZUsage%')
  AND line_item_line_item_type IN ('Usage','DiscountedUsage')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

- `QueryExecutionId`: `67c88b8e-92e8-432f-ab21-b51b660e01c5` · Estado `SUCCEEDED`.

| # | Cuenta (ID) | Nombre (perfil) | Cómputo instancia (USD) | Cubierto RI/SP | Parte Multi-AZ | Horas | Líneas |
|---|-------------|------------------|------------------------:|---------------:|---------------:|------:|-------:|
| 1 | 666777888999 | Retail Prod (retail-prod) | 2 531,09 | 0,00 | 2 249,86 | 1 488,17 | 63 |
| 2 | 111222333444 | Digital Prod (digital-prod) | 1 665,07 | 0,00 | 1 665,07 | 14 880,00 | 620 |
| 3 | 777788889999 | Helios Prod (helios-prod) | 425,57 | 0,00 | 0,00 | 1 488,00 | 62 |
| 4 | 666677778888 | Helios UAT (helios-uat) | 425,57 | 0,00 | 0,00 | 1 488,00 | 62 |
| 5 | 555566667777 | Helios Dev (helios-dev) | 425,57 | 0,00 | 0,00 | 1 488,00 | 62 |
| 6 | 400500600700 | SAP (sap) | 281,23 | 0,00 | 0,00 | 744,00 | 31 |
| 7 | 555666777888 | Retail UAT (retail-uat) | 246,66 | 0,00 | 0,00 | 652,55 | 102 |
| 8 | 444455556666 | EKS Tooling (eks-tooling) | 232,13 | 0,00 | 0,00 | 4 464,00 | 237 |
| 9 | 999900001111 | Digital Dev (digital-dev) | 176,78 | 0,00 | 0,00 | 8 065,69 | 541 |
| 10 | 000011112222 | Digital UAT (digital-uat) | 155,15 | 0,00 | 0,00 | 6 935,18 | 477 |
| 11 | 333344445555 | EKS Prod (eks-prd) | 26,04 | 0,00 | 0,00 | 744,00 | 31 |
| 12 | 111122223333 | EKS Dev (eks-dev) | 12,77 | 0,00 | 0,00 | 364,94 | 22 |
| 13 | 300400500600 | infraestructura (infra) | 12,65 | 0,00 | 0,00 | 744,00 | 31 |
| 14 | 444555666777 | Retail Dev (retail-dev) | 0,03 | 0,00 | 0,00 | 744,00 | 32 |

**Σ cómputo de instancia (sumado antes de redondear, half-up, Req 6.7):** `6 616,31 USD` ·
**Σ cubierto RI/SP:** `0,00 USD` → **cobertura 0,0 %**. (14 cuentas con cómputo RDS.)

> Concentración: Retail Prod (`2 531,09`) + Digital Prod (`1 665,07`) suman el **63,4 %** del cómputo
> RDS. Las 3 cuentas Helios (dev/uat/prod, `425,57` cada una) son Aurora no-prod/prod → su porción
> no-prod la trata por separado la **Palanca 5** (Tarea 7.x), evitando doble conteo (Req 8.8); aquí
> se contabiliza el cómputo a efectos de cobertura, no de scheduling.

---

## 2. Sub-análisis de cobertura por Compute SP — ElastiCache / OpenSearch / Fargate / Lambda (Req 8.3)

### Consulta CUR — cobertura por servicio (covered vs on-demand)

```sql
SELECT line_item_product_code AS product,
       CASE
         WHEN line_item_line_item_type = 'SavingsPlanCoveredUsage' THEN 'sp_covered'
         WHEN line_item_line_item_type = 'DiscountedUsage'         THEN 'ri_covered'
         ELSE 'on_demand'
       END AS coverage,
       SUM(line_item_unblended_cost) AS cost,
       SUM(line_item_usage_amount)   AS usage_amt,
       COUNT(*)                      AS line_items
FROM data
WHERE line_item_product_code IN ('AmazonElastiCache','AmazonES','AmazonOpenSearchService','AWSLambda')
  AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','DiscountedUsage')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1,2
ORDER BY 1,3 DESC;
```

- `QueryExecutionId`: `e2eafae9-d705-4acf-bd1d-313d95001950` · Estado `SUCCEEDED`.

Consulta complementaria para **Fargate** (`%Fargate%` en cualquier product_code, p. ej. `AmazonECS`/
`AmazonEKS`) y **OpenSearch** (`AmazonES` / `%OpenSearch%`):

```sql
SELECT line_item_product_code AS product,
       CASE WHEN line_item_usage_type LIKE '%Fargate%' THEN 'fargate' ELSE 'other' END AS kind,
       CASE WHEN line_item_line_item_type = 'SavingsPlanCoveredUsage' THEN 'sp_covered' ELSE 'on_demand' END AS coverage,
       SUM(line_item_unblended_cost) AS cost,
       COUNT(*) AS line_items
FROM data
WHERE (line_item_usage_type LIKE '%Fargate%' OR line_item_product_code LIKE '%OpenSearch%' OR line_item_product_code = 'AmazonES')
  AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','DiscountedUsage')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1,2,3
ORDER BY 4 DESC;
```

- `QueryExecutionId`: `edea3fbd-5eac-41f0-852a-953469fce386` · Estado `SUCCEEDED` · **0 filas**
  (no hay uso de Fargate ni de OpenSearch en la organización en el Mes_Referencia).

### Cifras congeladas — sub-análisis de cobertura (USD)

| Servicio | On-demand (USD) | Cubierto (USD) | Cobertura % | Tipo de compromiso aplicable | Nota |
|----------|----------------:|---------------:|------------:|------------------------------|------|
| **AWS Lambda** | 19,30 | 0,01 (SP) | 0,1 % | **Compute Savings Plans** (cómputo cubrible) | Gasto Lambda casi nulo; oportunidad de SP **despreciable** |
| **ElastiCache** | 411,22 | 0,00 | 0,0 % | Reserved Nodes propios (**no** Compute SP) | Único servicio adyacente con coste relevante; 0 % cubierto |
| **OpenSearch** (`AmazonES`/`AmazonOpenSearchService`) | 0,00 | 0,00 | n/a | Reserved Instances propias (**no** Compute SP) | **Sin uso** en el Mes_Referencia |
| **Fargate** (ECS/EKS) | 0,00 | 0,00 | n/a | **Compute Savings Plans** | **Sin uso** en el Mes_Referencia |

> **Precisión técnica (Req 8.3):** de los servicios listados, **solo Lambda y Fargate** son cubribles
> por **Compute Savings Plans**; **ElastiCache y OpenSearch** se cubren con sus **Reserved Nodes /
> Reserved Instances** propias, no con Compute SP. En el Mes_Referencia: Fargate y OpenSearch tienen
> coste `0,00 USD` (sin uso); Lambda tiene un gasto residual (`19,30 USD` on-demand) cuya cobertura
> por Compute SP sería **inmaterial**; ElastiCache (`411,22 USD`) está al **0 %** de cobertura por
> Reserved Nodes. Conclusión: el sub-análisis confirma que **no hay cómputo cubrible por Compute SP
> materialmente direccionable** en estos servicios; la oportunidad de compromiso adyacente real es
> **ElastiCache Reserved Nodes** sobre `411,22 USD`, que se documentará en la Tarea 4.3.

---

## 3. Registros de evidencia (esquema del Catálogo_Evidencias)

### EV-4.1-RDS-COMPUTE — Cómputo de instancia RDS y cobertura

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-4.1-RDS-COMPUTE` |
| `descripcion` | Cómputo de instancia RDS (Single-AZ + Multi-AZ) separado de storage/backups, con cobertura RI/SP vía `reservation_reservation_a_r_n` |
| `cifra_publicada` | Cómputo instancia `6 616,31 USD` · cubierto RI/SP `0,00 USD` · **cobertura 0,0 %** · storage `5 201,25` · backup `500,06` (separados) |
| `consulta_cur` | Consulta de clasificación de componentes RDS (§1) + desglose por cuenta (§1) |
| `query_execution_ids` | `1970253b-db7b-4211-bf0e-97fe49d53b31`, `67c88b8e-92e8-432f-ab21-b51b660e01c5`, `188eaab5-4ed7-4220-866e-bb264f108705`, `04734431-d108-41df-a145-e9af7dc7913a` |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:21:43Z` (UTC) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` — cifra agregada por `line_item_usage_account_id` (lista de cuentas en §1); la atribución por instancia se registra en la Tarea 4.2 (`Verificacion_Recurso_Vivo`) |
| `dimension_agregacion` | `rds_component` (CASE sobre `line_item_usage_type`) y `line_item_usage_account_id`; valor = `SUM(line_item_unblended_cost)`; cobertura = `SUM(... WHERE reservation_reservation_a_r_n <> '')` |
| `verificacion_vivo` | Pendiente — Tarea 4.2 (`rds describe-db-instances`, `rds describe-reserved-db-instances`) |
| `clasificacion` | Base de Palanca técnica (Estimado) — la clasificación y la fórmula se aplican en Tarea 4.3 |

### EV-4.1-COMMIT-ADJ — Cobertura adyacente (ElastiCache / OpenSearch / Fargate / Lambda)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-4.1-COMMIT-ADJ` |
| `descripcion` | Cobertura de compromiso de ElastiCache, OpenSearch, Fargate y Lambda (Compute SP donde aplica; Reserved Nodes/Instances en ElastiCache/OpenSearch) |
| `cifra_publicada` | Lambda on-demand `19,30` / SP `0,01` (0,1 %) · ElastiCache on-demand `411,22` / cubierto `0,00` (0,0 %) · OpenSearch `0,00` (sin uso) · Fargate `0,00` (sin uso) |
| `consulta_cur` | Consultas de cobertura por servicio y de Fargate/OpenSearch (§2) |
| `query_execution_ids` | `e2eafae9-d705-4acf-bd1d-313d95001950`, `edea3fbd-5eac-41f0-852a-953469fce386` |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:21:43Z` (UTC) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` — cifra agregada por `line_item_product_code` + tipo de cobertura |
| `dimension_agregacion` | `line_item_product_code` × tipo de cobertura (`SavingsPlanCoveredUsage`/`DiscountedUsage`/`Usage`); valor = `SUM(line_item_unblended_cost)` |
| `verificacion_vivo` | No requerida en 4.1 (sin uso de Fargate/OpenSearch; Lambda/ElastiCache documentados desde CUR) |
| `clasificacion` | Insumo de Palanca 2 — fórmula y clasificación en Tarea 4.3 |

---

## 4. Comando de ejecución re-ejecutable (Athena vía AWS CLI, credenciales por nombre de perfil — Req 7.2, 7.5)

```bash
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "<consulta de §1 o §2, en una sola línea>" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

## 5. Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23`, fecha de extracción
  `2026-06-23T08:21:43Z` (UTC). Todos los `QueryExecutionId` listados con estado `SUCCEEDED`.
- Cifras congeladas y reproducibles: re-ejecutar las consultas documentadas sobre el mismo
  Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría en
  Tarea 17.6).
- **Resumen de la cifra clave (Req 8.2):** cómputo de instancia RDS `6 616,31 USD`, **cobertura RI/SP
  0,0 %** → la totalidad es cómputo **sin cobertura** y por tanto base direccionable de la Palanca 2.
- **Resumen del sub-análisis (Req 8.3):** sin cómputo materialmente cubrible por Compute SP en
  Fargate (sin uso), OpenSearch (sin uso) ni Lambda (residual `19,30 USD`); única cobertura adyacente
  real = ElastiCache Reserved Nodes sobre `411,22 USD` (0 % cubierto hoy).
- ⏭️ **Pendiente (otras tareas):** `Verificacion_Recurso_Vivo` solo-lectura (Tarea 4.2); fórmula de
  ahorro RDS RI ~34 % 1 año no-upfront, clasificación **Estimado** (rango `0 < Cons ≤ Agr`),
  documentación Req 4 y marca **requiere Barrido_Utilizacion** (Tarea 4.3).

---

# Registro 4.2 — Palanca 2: Verificacion_Recurso_Vivo RDS (solo lectura)

> Artefacto auditable de la **Tarea 4.2**. Sub-registro de `Verificacion_Recurso_Vivo` que confirma,
> mediante llamadas **estrictamente de solo lectura** (`describe`), que el cómputo RDS congelado en la
> Tarea 4.1 corresponde a instancias **reales, prod 24/7** y que la **cobertura RI/SP es ~0 %**. No
> modifica las cifras del `Dataset_Congelado` (frozen, mayo 2026): el drift del recurso vivo entre la
> fecha de extracción del CUR (`2026-06-23T08:21:43Z`) y esta verificación es **esperado** (Req 7.6).

**Validates: Requirements 5.1, 5.5**

## Parámetros de anclaje de la verificación (Req 5.1, 5.5)

| Campo | Valor |
|-------|-------|
| Tipo de verificación | `Verificacion_Recurso_Vivo` — solo lectura (`describe-db-instances`, `describe-reserved-db-instances`) |
| Ventana de ejecución (UTC) | `2026-06-23T08:50:24Z` → `2026-06-23T08:57:00Z` |
| Región consultada | `eu-west-1` (RDS de la organización; sin WAF/CloudFront → no aplica `us-east-1`) |
| Credenciales | SSO SRE por cuenta (rol `AWSReservedSSO_SRE_*`); referenciadas **por nombre de perfil**, sin incrustar credenciales (Req 7.5) |
| Cuentas verificadas | 14 (todas las cuentas con cómputo RDS del Registro 4.1) |
| Estado global | **confirmado** en las 14 cuentas (sesión SSO válida, `describe` exitoso) |
| Operaciones mutantes | **ninguna** (Property 11 — solo describe/list/get) |

## Comandos re-ejecutables (solo lectura — Req 5.1, 7.5)

```bash
# 1) Existencia, clase, motor, versión, Multi-AZ y estado de cada instancia RDS (por cuenta)
aws rds describe-db-instances --profile <perfil> --region eu-west-1 \
  --query 'DBInstances[].{id:DBInstanceIdentifier,cls:DBInstanceClass,eng:Engine,ver:EngineVersion,maz:MultiAZ,st:DBInstanceStatus}' \
  --output json

# 2) Cobertura por Reserved Instances vigentes (confirmar 0 cobertura sobre el cómputo prod)
aws rds describe-reserved-db-instances --profile <perfil> --region eu-west-1 \
  --query 'ReservedDBInstances[].{cls:DBInstanceClass,eng:ProductDescription,count:DBInstanceCount,maz:MultiAZ,state:State,start:StartTime,dur:Duration,offer:OfferingType}' \
  --output json
```

Perfiles cubiertos (14): `retail-prod`, `digital-prod`, `helios-prod`, `helios-uat`, `helios-dev`,
`sap`, `retail-uat`, `eks-tooling`, `digital-dev`, `digital-uat`, `eks-prd`, `eks-dev`, `infra`,
`retail-dev`. Identidad asumida confirmada con `aws sts get-caller-identity --profile <perfil>`
(rol `AWSReservedSSO_SRE_*`) en las 14 cuentas.

---

## 1. `describe-db-instances` — existencia y características (Req 5.1)

Todas las instancias verificadas figuran en estado `available` (operativas, 24/7). Total: **82
instancias RDS** en 14 cuentas. Resumen por cuenta (estado de verificación = **confirmado** en todas):

| # | Cuenta (ID) | Perfil | Instancias | Prod 24/7 | Observaciones (coherencia con 4.1) |
|---|-------------|--------|-----------:|-----------|-------------------------------------|
| 1 | 666777888999 | retail-prod | 2 | Sí | `mariadb-retail` `db.m6i.4xlarge` **Multi-AZ=true** + `mariadb-retail-replica` `db.m5.xlarge` Single-AZ. Confirma el componente Multi-AZ (`2 249,86 USD` en `db.m6i.4xl`) del Registro 4.1 |
| 2 | 111222333444 | digital-prod | 20 | Sí | 20 instancias postgres/mysql, **todas Multi-AZ=true**. Confirma que la totalidad del cómputo (`1 665,07 USD`) es Multi-AZ en 4.1. Incluye `oms`/`payments-api` en **PG 13.20** (EOL → Palanca 3) |
| 3 | 777788889999 | helios-prod | 2 | Sí | Aurora PostgreSQL `db.r6g.large` (writer+reader, Single-AZ). Cómputo Aurora prod |
| 4 | 666677778888 | helios-uat | 2 | Sí | Aurora PostgreSQL `db.r6g.large` (writer+reader). **No-prod** → porción tratada por **Palanca 5** (sin doble conteo, Req 8.8) |
| 5 | 555566667777 | helios-dev | 2 | Sí | Aurora PostgreSQL `db.r6g.large` (writer+reader). **No-prod** → **Palanca 5** |
| 6 | 400500600700 | sap | 1 | Sí | `mariadb-middleware` `db.m5.xlarge` Single-AZ |
| 7 | 555666777888 | retail-uat | 2 | Sí | 2× MariaDB `db.m5.xlarge` (no-prod) |
| 8 | 444455556666 | eks-tooling | 6 | Sí | 6× postgres `db.t3.medium` (servicios plataforma 24/7). **2 cubiertas por RI activa** — ver §2 (hallazgo) |
| 9 | 999900001111 | digital-dev | 22 | Sí | 22 instancias (no-prod), mayoría `db.t4g.micro` Single-AZ |
| 10 | 000011112222 | digital-uat | 19 | Sí | 19 instancias (no-prod), mayoría `db.t4g.micro` Single-AZ |
| 11 | 333344445555 | eks-prd | 1 | Sí | `kiti-app-rds` `db.t4g.small` postgres 14.22 |
| 12 | 111122223333 | eks-dev | 1 | Sí | `kiti-app-rds` `db.t4g.small` postgres 14.17 |
| 13 | 300400500600 | infra | 1 | Sí | `database-1-veeampostgres` `db.t4g.micro` postgres 16.13 |
| 14 | 444555666777 | retail-dev | 1 | Sí | `mariadb-retail` `db.m5.large` (no-prod) |

> Coherencia con el Registro 4.1: la verificación confirma la concentración prod (retail-prod +
> digital-prod) y el patrón Multi-AZ. En retail-prod el cómputo Multi-AZ proviene de
> `mariadb-retail` (`db.m6i.4xlarge`, Multi-AZ=true); en digital-prod **todas** las instancias son
> Multi-AZ, consistente con `multi_az_part = instance_compute` (`1 665,07 USD`) en 4.1.

---

## 2. `describe-reserved-db-instances` — cobertura RI (Req 5.1) + HALLAZGO

Estado de las reservas RDS por cuenta (filtrado por `State`):

| Cuenta (perfil) | RI vigentes (`active`) | RI `retired` | Cobertura efectiva |
|-----------------|:----------------------:|:------------:|--------------------|
| retail-prod | 0 | 0 | **0 %** |
| digital-prod | 0 | 2 | **0 %** (2 RI 1-año expiradas, alta 2024-01-29) |
| helios-prod / -uat / -dev | 0 | 0 | **0 %** |
| sap | 0 | 0 | **0 %** |
| retail-uat | 0 | 0 | **0 %** |
| **eks-tooling** | **1 reserva → 2 instancias** | 2 | parcial (ver hallazgo) |
| digital-dev | 0 | 2 | **0 %** (2 RI expiradas) |
| digital-uat | 0 | 2 | **0 %** (2 RI expiradas) |
| eks-prd / eks-dev / infra / retail-dev | 0 | 0 | **0 %** |

### Hallazgo (matiz sobre la cifra "0 % cobertura" del Registro 4.1)

La verificación en vivo **detecta una reserva RDS activa** que el CUR no reflejó como coste cubierto:

- **Cuenta:** `444455556666` (eks-tooling) · **ARN:** `arn:aws:rds:eu-west-1:444455556666:ri:ri-2024-01-23-08-39-10-833`
- **Reserva:** `db.t3.medium`, PostgreSQL, **count=2**, Single-AZ, `OfferingType = All Upfront`
- **Alta:** `2024-01-23T08:39:14Z` · **Duración:** 94 608 000 s = **3 años** → **vigente hasta ≈ 2027-01-23** (activa durante el Mes_Referencia)
- **Cargos:** `FixedPrice = 904,00 USD` (pago único), `RecurringChargeAmount = 0,00 USD/h`

**Por qué el CUR mostró `covered = 0,00 USD` (no es contradicción).** Una RI **All Upfront** no tiene
cargo recurrente: las líneas `DiscountedUsage` que consume aparecen con `line_item_unblended_cost = 0`
(el coste se pagó por adelantado y se amortiza en una línea `RIFee`, no en la línea de uso). La cifra
de 4.1 mide cobertura como **coste unblended de líneas con `reservation_reservation_a_r_n`**, por lo
que una RI All Upfront aporta `0,00 USD` aunque **sí** cubra capacidad. En consecuencia: la cobertura
económica del **cómputo on-demand** sigue siendo `0,0 %` en términos de unblended (la cifra base de la
Palanca 2 no cambia), pero **2 de las 6 instancias `db.t3.medium` de eks-tooling están reservadas** y
**no deben tratarse como direccionables** por un nuevo compromiso.

**Acción para la Tarea 4.3 (no ejecutada aquí):** al dimensionar el compromiso RDS, **descontar** esas
2 instancias `db.t3.medium` postgres de eks-tooling (RI All Upfront vigente hasta ~2027-01-23) del
% direccionable, para no comprar cobertura duplicada. El resto del cómputo prod estable (retail-prod,
digital-prod) permanece sin cobertura y plenamente direccionable. Las RI `retired` de
digital-prod/dev/uat (términos de 1 año dados de alta en 2024) están **expiradas** y no aportan
cobertura en el Mes_Referencia → consistentes con `0 %`.

---

## 3. Registro de evidencia (esquema del Catálogo_Evidencias)

### EV-4.2-RDS-LIVE — Verificacion_Recurso_Vivo del cómputo RDS

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-4.2-RDS-LIVE` |
| `descripcion` | Verificación en vivo de solo lectura de las instancias RDS (existencia, clase, motor, versión, Multi-AZ, estado) y de la cobertura por Reserved Instances vigentes, en las 14 cuentas con cómputo RDS del Registro 4.1 |
| `cifra_publicada` | 82 instancias `available` en 14 cuentas; cobertura RI vigente = **0 %** del cómputo on-demand (unblended); **excepción**: 2× `db.t3.medium` postgres en eks-tooling cubiertas por RI All Upfront 3 años (ARN `ri-2024-01-23-08-39-10-833`, vigente ~2027-01-23) |
| `consulta_cur` | `no aplica` — verificación de existencia en vivo (no es consulta CUR). Comandos `describe` re-ejecutables en §0/§1/§2 |
| `comandos` | `aws rds describe-db-instances` + `aws rds describe-reserved-db-instances` (`--region eu-west-1`, perfil SSO SRE por cuenta) |
| `mes_referencia` | `2026-05` (cifras base ancladas a 4.1; verificación de existencia a fecha 2026-06-23) |
| `fecha_verificacion` | `2026-06-23T08:50:24Z` → `2026-06-23T08:57:00Z` (UTC) |
| `version_dataset` | `frozen-2026-05@2026-06-23` (sin modificar; drift vivo esperado, Req 7.6) |
| `moneda` | `USD` |
| `recurso_ids` | 82 `DBInstanceIdentifier` listados por cuenta en §1; reserva activa `arn:aws:rds:eu-west-1:444455556666:ri:ri-2024-01-23-08-39-10-833` |
| `dimension_agregacion` | `line_item_usage_account_id` (perfil) → conteo de instancias y estado de cobertura RI |
| `cuenta_consultada` | 14 cuentas (IDs en §1) |
| `region_consultada` | `eu-west-1` |
| `estado` | **confirmado** (14/14 cuentas); ninguna `no_verificable` (todas con rol SRE de lectura disponible) |
| `clasificacion` | Insumo de verificación de Palanca 2 (Estimado); la fórmula y el ajuste del % direccionable por la RI de eks-tooling se aplican en la Tarea 4.3 |

---

## 4. Cumplimiento de solo lectura (Property 11 — Req 5.1, 7.5)

- Todos los comandos ejecutados pertenecen al conjunto **describe/list/get**: `sts get-caller-identity`,
  `rds describe-db-instances`, `rds describe-reserved-db-instances`. **Ninguna** operación mutante
  (`create/modify/delete/reboot/...`).
- Credenciales referenciadas **por nombre de perfil** (SSO SRE); **sin** claves ni tokens incrustados.
- Sin recursos WAF/CloudFront en esta Palanca → toda la verificación en `eu-west-1` (no aplica
  `us-east-1`).

## 5. Estado de ejecución

- ✅ **Ejecutado** el 2026-06-23 (UTC). 14/14 cuentas con cómputo RDS verificadas; estado global
  **confirmado**. Ninguna cuenta `no_verificable` (rol SRE de lectura disponible en todas).
- ✅ **Confirmado:** las instancias del cómputo RDS de 4.1 existen, están `available` (24/7) y el
  patrón Multi-AZ (retail-prod, digital-prod) coincide con el Registro 4.1.
- ⚠️ **Hallazgo registrado:** RI All Upfront activa en eks-tooling (2× `db.t3.medium` postgres,
  vigente ~2027-01-23) — no contradice la cifra base (`0 %` unblended) pero **debe descontarse** del
  % direccionable en la Tarea 4.3 para evitar cobertura duplicada.
- ⏭️ **Pendiente (Tarea 4.3):** fórmula RDS RI ~34 % 1 año no-upfront sobre prod estable,
  clasificación **Estimado** (rango `0 < Cons ≤ Agr`), documentación Req 4 y marca **requiere
  Barrido_Utilizacion**, aplicando el ajuste por la RI vigente de eks-tooling.

---

# Registro 4.3 — Palanca 2: Fórmula de ahorro, clasificación y documentación

> Artefacto auditable de la **Tarea 4.3** del Estudio FinOps de Ahorro AWS. Toma como insumo las
> cifras **congeladas** en el Registro 4.1 (cómputo de instancia RDS `6 616,31 USD`, cobertura RI/SP
> `0,0 %`; ElastiCache on-demand `411,22 USD` al 0 %) y la `Verificacion_Recurso_Vivo` del Registro
> 4.2 (82 instancias `available`, 24/7; **hallazgo**: 2× `db.t3.medium` postgres en eks-tooling
> cubiertas por RI All Upfront vigente ~2027-01-23). Aplica la fórmula de ahorro por compromiso RDS,
> clasifica la Palanca como **Estimado** (rango), documenta los campos del Req 4 y la marca como
> **requiere Barrido_Utilizacion**. No modifica el `Dataset_Congelado` ni las cifras de 4.1/4.2.

**Validates: Requirements 3.3, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1, 8.5, 18.1**

## Parámetros de anclaje (heredados de 4.1/4.2)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Fecha de extracción CUR | `2026-06-23T08:21:43Z` (UTC) |
| Moneda | `USD` (2 decimales, redondeo half-up, sumando antes de redondear — Req 6.7) |
| Cifra base (cómputo instancia RDS) | `6 616,31 USD/mes`, cobertura RI/SP `0,0 %` (unblended) |
| Definición de **uso estable** (Req 8.4) | uso presente en ≥ 90 % de las horas en ventana ≥ 30 días → base del % direccionable |

---

## 1. Base direccionable — porción prod estable (Req 8.4, 8.6, 8.8)

El compromiso RI sólo se dimensiona sobre cómputo **prod estable 24/7 sin cobertura**. Partiendo de
las 14 cuentas del Registro 4.1 se aplica: **(a)** descontar las 2× `db.t3.medium` de eks-tooling ya
cubiertas por RI All Upfront (hallazgo 4.2) para no comprar cobertura duplicada; **(b)** enrutar la
porción **no-prod** fuera de esta Palanca (Helios Aurora dev/uat → **Palanca 5**; resto no-prod →
scheduling/rightsizing, sin compromiso) evitando doble conteo (Req 8.8).

| Cuenta (perfil) | Cómputo instancia (USD) | Perfil | Tratamiento en Palanca 2 | Base direccionable (USD) |
|-----------------|------------------------:|--------|--------------------------|-------------------------:|
| retail-prod | 2 531,09 | prod 24/7 (Multi-AZ) | **Incluido** — prod estable | 2 531,09 |
| digital-prod | 1 665,07 | prod 24/7 (todo Multi-AZ) | **Incluido** — prod estable | 1 665,07 |
| helios-prod | 425,57 | prod (Aurora writer+reader) | **Incluido** — prod estable | 425,57 |
| sap | 281,23 | prod (mariadb-middleware) | **Incluido** — prod estable | 281,23 |
| eks-tooling | 232,13 | plataforma 24/7 (6× db.t3.medium) | **Incluido parcial** — 4 de 6; 2 ya cubiertas por RI (descontadas) | 154,75 |
| eks-prd | 26,04 | prod (db.t4g.small, burstable) | **Incluido** — prod (familia `t`, ver riesgo) | 26,04 |
| infra | 12,65 | prod/infra (db.t4g.micro, burstable) | **Incluido** — prod (familia `t`, ver riesgo) | 12,65 |
| helios-uat | 425,57 | **no-prod** (Aurora) | **Excluido** → Palanca 5 (scheduling Aurora) | — |
| helios-dev | 425,57 | **no-prod** (Aurora) | **Excluido** → Palanca 5 (scheduling Aurora) | — |
| retail-uat | 246,66 | **no-prod** | **Excluido** — no-prod (candidato a scheduling, no a compromiso) | — |
| digital-dev | 176,78 | **no-prod** | **Excluido** — no-prod | — |
| digital-uat | 155,15 | **no-prod** | **Excluido** — no-prod | — |
| eks-dev | 12,77 | **no-prod** | **Excluido** — no-prod | — |
| retail-dev | 0,03 | **no-prod** | **Excluido** — no-prod | — |
| *(ajuste RI eks-tooling)* | — | RI All Upfront vigente | **Descontado** 2× db.t3.medium (`ri-2024-01-23-08-39-10-833`) | −77,38 |

- **Σ Base direccionable (prod estable, sumado antes de redondear, half-up):** **`5 096,40 USD/mes`**.
- **% direccionable de la Palanca (Req 4.2):** `5 096,40 / 6 616,31` = **`77,0 %`** del cómputo de
  instancia RDS.

### Control de conservación de la base (anticipo Property 7 — sin doble conteo)

```
6 616,31  (cómputo instancia RDS total, Registro 4.1)
−  77,38  (2× db.t3.medium eks-tooling ya cubiertas por RI All Upfront — hallazgo 4.2)
− 851,14  (Helios Aurora no-prod dev 425,57 + uat 425,57 → Palanca 5)
− 591,39  (otro no-prod: retail-uat 246,66 + digital-dev 176,78 + digital-uat 155,15 + eks-dev 12,77 + retail-dev 0,03)
= 5 096,40  (base direccionable prod estable de la Palanca 2)  ✔ cuadra
```

Cada unidad de cómputo se asigna a una sola Palanca (Req 8.8): el no-prod Aurora de Helios queda en
la Palanca 5 y el resto de no-prod en scheduling; el cómputo ya reservado de eks-tooling no se
recompromete.

---

## 2. Fórmula de ahorro por compromiso RDS RI (Req 8.5, 6.1, 6.3, 6.4)

**Supuesto de descuento.** RDS Reserved Instances sobre la base prod estable, **origen: precio
público AWS** a fecha `2026-06-23` (a re-confirmar contra la calculadora vigente en la fecha de
extracción):

| Escenario | Plazo | Opción de pago | Tasa de descuento supuesta (Req 4.1) |
|-----------|-------|----------------|-------------------------------------:|
| **Conservador** | **1 año** | **No upfront** | **34,0 %** |
| **Agresivo** | **3 años** | **Partial upfront** | **50,0 %** |

> Declaración de plazo y opción de pago (Req 8.5): se presentan ambos plazos (1 y 3 años). El
> Conservador usa 1 año / no-upfront (mínimo lock-in, descuento menor); el Agresivo usa 3 años /
> partial-upfront (mayor descuento a cambio de mayor compromiso y desembolso inicial). Las tasas son
> de **precio público AWS** y varían por motor/clase/región → re-confirmar en la fecha de extracción.

### Cifras de ahorro — Estimado como rango (Req 3.3, 6.1, 6.2)

Base afectada = `5 096,40 USD/mes`. Mensual y anualizado (×12) diferenciados y etiquetados (Req 6.2,
6.3); el anual se calcula sobre el mensual sin redondear y luego se redondea half-up (Req 6.7).

| Métrica | Rango_Conservador (34,0 %) | Rango_Agresivo (50,0 %) |
|---------|---------------------------:|------------------------:|
| Ahorro **mensual** (USD) | **1 732,78** | **2 548,20** |
| Ahorro **anualizado** (×12, USD) | **20 793,33** | **30 578,42** |

- **Invariante (Req 3.3):** `0 < Conservador ≤ Agresivo` → `1 732,78 ≤ 2 548,20` ✔ (mensual) y
  `20 793,33 ≤ 30 578,42` ✔ (anual).
- **Advertencia de anualización (Req 6.4):** *la cifra anual = mensual × 12 asume que el
  Mes_Referencia (mayo 2026) es representativo y no captura estacionalidad.*
- **Captura progresiva / primer año (Req 6.5):** un RI rinde su descuento desde el momento de la
  compra; si el compromiso se adquiere en el mes `m` del año, el **primer año** captura de forma
  prorrateada `≈ ahorro_mensual × (12 − m_transcurridos)`, frente a la cifra en **régimen
  estacionario** (×12) de la tabla. Supuesto de prorrateo: meses efectivos desde la compra hasta el
  cierre del horizonte de anualización.

---

## 3. Oportunidad de compromiso adyacente — ElastiCache Reserved Nodes (Req 8.3)

El sub-análisis de 4.1 descartó Compute SP materialmente direccionable en Fargate (sin uso),
OpenSearch (sin uso) y Lambda (`19,30 USD` on-demand, ahorro por Compute SP **inmaterial**). La única
oportunidad de compromiso adyacente real es **ElastiCache Reserved Nodes** sobre `411,22 USD/mes`
(0 % cubierto hoy). Se documenta como sub-línea **Estimado** separada, **pendiente** de su propia
`Verificacion_Recurso_Vivo` y de Barrido (no ejecutadas en 4.2, que cubrió sólo RDS):

| Métrica | Rango_Conservador (≈30,0 %) | Rango_Agresivo (≈45,0 %) |
|---------|----------------------------:|-------------------------:|
| Base afectada (USD/mes) | 411,22 | 411,22 |
| Ahorro mensual (USD) | 123,37 | 185,05 |
| Ahorro anualizado (×12, USD) | 1 480,39 | 2 220,59 |

- **Origen:** precio público AWS de ElastiCache Reserved Nodes (`2026-06-23`), a re-confirmar.
- **Pendiente (Req 5.1):** `aws elasticache describe-cache-clusters` + `describe-reserved-cache-nodes`
  (solo lectura) para confirmar nodos prod 24/7 y 0 cobertura, antes de elevar a objetivo.
- **No se suma** al ahorro RDS de la sección 2; se presenta aparte y queda **pendiente de
  verificación + Barrido** (Req 18.1, 18.3).

---

## 4. Nota de expiración dentro del horizonte (Req 8.7)

La RI All Upfront de eks-tooling (`ri-2024-01-23-08-39-10-833`, 2× `db.t3.medium`) **expira
~2027-01-23**, dentro del horizonte de anualización (mayo 2026 → mayo 2027). Al expirar, esas 2
instancias (`≈ 77,38 USD/mes`, hoy descontadas de la base) quedarían **sin cobertura** y pasarían a
ser **coste direccionable a renovación**. Se listan aquí para no perder la renovación; no alteran la
base direccionable del Mes_Referencia.

---

## 5. Documentación por Palanca (Req 4) — campos obligatorios

| Campo (Req) | Valor |
|-------------|-------|
| Supuesto de descuento (Req 4.1) | **34,0 %** (Conservador, RDS RI 1 año no-upfront) – **50,0 %** (Agresivo, RDS RI 3 años partial-upfront) |
| % direccionable + coste base mensual (Req 4.2) | **77,0 %** del cómputo de instancia RDS; **coste base afectado = 5 096,40 USD/mes** (de 6 616,31) |
| Origen del supuesto + fecha (Req 4.3) | **precio público AWS**, fecha `2026-06-23` (re-confirmar contra calculadora vigente) |
| Riesgo (Req 4.4) | **medio** — lock-in plurianual; clases/familias podrían cambiar (incl. burstable `t` en eks-prd/infra); mitigado porque el cómputo prod 24/7 está verificado (4.2) y RI permite flexibilidad de tamaño dentro de familia |
| Esfuerzo (Req 4.5) | **bajo** — compra de RI; sin cambios de arquitectura ni de aplicación |
| Owner (Req 4.6) | **pendiente** — Palanca transversal; equipos responsables: **Digital + SRE/Plataforma** (correo corporativo pendiente, Req 4.7) |

---

## 6. Clasificación y gating (Req 3.1, 3.3, 18.1, 18.2)

- **Clasificación:** **Ahorro_Estimado** (única categoría; depende de tasa de descuento supuesta y de
  la confirmación de uso estable). Se expresa **siempre como rango** Conservador–Agresivo, nunca como
  cifra única (Req 3.3).
- **Requiere `Barrido_Utilizacion`** (Req 18.1): la base direccionable (`5 096,40 USD/mes`, 77,0 %)
  presupone "uso estable" (≥ 90 % de horas en ventana ≥ 30 días). Hasta completar el barrido de
  compromiso steady-state (Tarea 16.1, gating de la Palanca 2), el ahorro se presenta **solo como
  rango estimado** y **no como objetivo comprometido** (Req 18.2). Barrido parcial → Palanca tratada
  como pendiente (Req 18.3).
- ElastiCache Reserved Nodes (§3) queda además **pendiente de su `Verificacion_Recurso_Vivo`**.

---

## 7. Registro de evidencia (esquema del Catálogo_Evidencias)

### EV-4.3-RDS-COMMIT — Fórmula, clasificación y documentación de la Palanca 2

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-4.3-RDS-COMMIT` |
| `descripcion` | Aplicación de la fórmula de ahorro por compromiso RDS RI sobre la base prod estable (descontando la RI vigente de eks-tooling y enrutando el no-prod a Palancas 5/scheduling), clasificación Estimado (rango), documentación Req 4 y marca de Barrido_Utilizacion; sub-línea adyacente ElastiCache Reserved Nodes |
| `cifra_publicada` | Base direccionable `5 096,40 USD/mes` (77,0 %); ahorro RDS mensual `1 732,78`–`2 548,20 USD`; anualizado `20 793,33`–`30 578,42 USD`. Adyacente ElastiCache (pendiente verificación): mensual `123,37`–`185,05`, anual `1 480,39`–`2 220,59 USD` |
| `consulta_cur` | `no aplica` — derivación sobre cifras ya congeladas en 4.1 (`QueryExecutionId` `1970253b-…`, `67c88b8e-…`, `e2eafae9-…`) y verificación 4.2 (`EV-4.2-RDS-LIVE`); no introduce consulta CUR nueva |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:21:43Z` (UTC) — insumos de 4.1; derivación 4.3 sobre el mismo `Dataset_Congelado` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` (half-up, 2 decimales, suma antes de redondear) |
| `recurso_ids` | `["no atribuible a recurso"]` — base agregada por `line_item_usage_account_id` (7 cuentas prod incluidas en §1); referencias a recurso/RI vía `EV-4.2-RDS-LIVE` |
| `dimension_agregacion` | `line_item_usage_account_id` filtrado a prod estable; supuesto de descuento × base direccionable; rango Conservador/Agresivo |
| `supuesto_descuento` | Conservador 34,0 % (RDS RI 1 año no-upfront) · Agresivo 50,0 % (RDS RI 3 años partial-upfront) · origen precio público AWS `2026-06-23` |
| `pct_direccionable` | 77,0 % sobre coste base `5 096,40 USD/mes` |
| `riesgo` / `esfuerzo` / `owner` | medio / bajo / **pendiente** (Digital + SRE/Plataforma) |
| `clasificacion` | **Ahorro_Estimado** (rango, `0 < Cons ≤ Agr`) — **requiere Barrido_Utilizacion** (gating Tarea 16.1); no comprometido como objetivo hasta barrido (Req 18.2) |
| `verificacion_vivo` | RDS: `confirmado` (Registro 4.2, `EV-4.2-RDS-LIVE`). ElastiCache adyacente: **pendiente** (`describe-cache-clusters` / `describe-reserved-cache-nodes`) |

---

## 8. Estado de ejecución

- ✅ **Fórmula aplicada** sobre el `Dataset_Congelado` `frozen-2026-05@2026-06-23`: base direccionable
  prod estable `5 096,40 USD/mes` (77,0 % del cómputo RDS), tras descontar la RI All Upfront de
  eks-tooling y enrutar el no-prod a Palanca 5/scheduling (conservación verificada: `6 616,31 =
  5 096,40 + 77,38 + 851,14 + 591,39`).
- ✅ **Clasificación Estimado** con rango RDS RI `1 732,78`–`2 548,20 USD/mes` (anual `20 793,33`–
  `30 578,42 USD`), invariante `0 < Cons ≤ Agr` cumplida; advertencia de anualización y prorrateo de
  primer año declaradas.
- ✅ **Documentación Req 4** completa (supuesto, % direccionable + base, origen + fecha, riesgo medio,
  esfuerzo bajo, owner pendiente Digital + SRE).
- ✅ **Sub-línea adyacente ElastiCache Reserved Nodes** documentada (base `411,22 USD/mes`, rango
  `123,37`–`185,05 USD/mes`), **pendiente** de su `Verificacion_Recurso_Vivo` y de Barrido; Lambda/
  Fargate/OpenSearch confirmados inmateriales/sin uso.
- ⚠️ **Marca de gating:** la Palanca 2 **requiere `Barrido_Utilizacion`** (Tarea 16.1). Hasta
  completarlo se presenta **solo como rango**, **no** como objetivo comprometido (Req 18.1, 18.2).
- ⏭️ **Pendiente (otras tareas):** Barrido de compromiso steady-state (Tarea 16.1); auditorías de
  invariantes (fase 17: conservación, biyección cifra↔evidencia, rango Estimado, no doble conteo,
  anualización/redondeo); composición del Informe (fase 19).
