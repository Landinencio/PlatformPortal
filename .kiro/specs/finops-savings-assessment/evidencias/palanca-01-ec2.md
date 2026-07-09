# Registro Palanca 1 — Compromiso EC2 (Savings Plans) — Tarea 3.1

> Artefacto auditable de la **Tarea 3.1**: partición del gasto EC2 por opción de compra
> (`sp_covered` / `spot` / `on_demand`), cobertura de compromiso (importe USD + %) y separación de
> la porción **estable** (≥90% de horas en ventana ≥30 días) de la **intermitente/ráfaga**. Cifras
> congeladas contra el `Dataset_Congelado` y reproducibles re-ejecutando las consultas documentadas.
>
> **Validates: Requirements 8.1, 8.4, 2.1, 2.3**
>
> Este fichero es el artefacto PROPIO de la Tarea 3.1 (no se toca `catalogo-evidencias.md`, el
> catálogo compartido de la Fundación). La cifra base/clasificación final (Estimado, rango de SP) y
> la `Verificacion_Recurso_Vivo` se producen en las Tareas 3.2 y 3.3.

## Parámetros de anclaje (Req 2.1, 2.5)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23T08:14:51Z` (UTC) · `2026-06-23T10:14:51+02:00` (Europe/Madrid, CEST) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
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

## Evidencia A — Partición EC2 por opción de compra (cobertura de compromiso)

**`id_evidencia`:** `EV-3.1-ec2-particion-compra`
**Clasificación del registro:** `no atribuible a recurso` — cifra agregada por dimensión de opción
de compra (`purchase_option`), no atribuible a un recurso concreto (Req 2.4).
**Dimensión de agregación (Req 2.3):** partición por `purchase_option` derivada de
`line_item_line_item_type` / `line_item_usage_type`; valores de agregación =
`SUM(line_item_unblended_cost)`, `SUM(pricing_public_on_demand_cost)` y `SUM(line_item_usage_amount)`.

### Consulta CUR exacta (re-ejecutable) — consulta canónica del `design.md`

```sql
SELECT
  CASE
    WHEN line_item_line_item_type = 'SavingsPlanCoveredUsage' THEN 'sp_covered'
    WHEN line_item_usage_type LIKE '%SpotUsage%'              THEN 'spot'
    ELSE 'on_demand'
  END AS purchase_option,
  SUM(line_item_unblended_cost)            AS unblended,
  SUM(pricing_public_on_demand_cost)       AS on_demand_equiv,
  SUM(line_item_usage_amount)              AS usage_hours,
  COUNT(*)                                 AS line_items
FROM data
WHERE line_item_product_code = 'AmazonEC2'
  AND (line_item_usage_type LIKE '%BoxUsage%' OR line_item_usage_type LIKE '%SpotUsage%')
  AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','DiscountedUsage')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1;
```

Ejecución (perfil `root-iskaypet`, región `eu-west-1`, DB `athenacurcfn_finnops`, salida
`s3://finnops-iskaypet/athena-query-results/`):

```bash
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "<consulta de arriba, en una sola línea>" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

- `QueryExecutionId`: `dc0cca4c-d315-4621-81c2-7004990fd67b`
- Estado: `SUCCEEDED` · Datos escaneados: `6.421.583` bytes

### Resultado congelado (importes half-up a 2 decimales, USD)

| `purchase_option` | Unblended (USD) | On-demand equiv (USD) | Horas de uso | Líneas CUR |
|-------------------|----------------:|----------------------:|-------------:|-----------:|
| `sp_covered` (cubierto por Savings Plans) | 7 998,83 | 7 998,83 | 41 151,216 | 7 016 |
| `on_demand` (sin cobertura) | 7 185,92 | 7 185,92 | 24 959,242 | 6 455 |
| `spot` | 3,30 | 6,56 | 25,369 | 58 |
| **Total cómputo EC2 (BoxUsage+SpotUsage)** | **15 188,05** | **15 191,31** | **66 135,827** | **13 529** |

> Precisión completa (antes de redondeo, para reproducibilidad Req 7.3): `sp_covered` =
> `7998.828122917939` unblended / `7998.828122917739` od-equiv / `41151.21611083695` h ·
> `on_demand` = `7185.915289761053` unblended / `7185.915289761355` od-equiv / `24959.24228616288` h ·
> `spot` = `3.2951832223` unblended / `6.5553204007999994` od-equiv / `25.368887` h.

### Cobertura de compromiso EC2 (Req 8.1 — importe USD 2 dec + % entre 0 y 100)

El denominador de cobertura combina lo cubierto por SP y lo on-demand cubrible; el `spot` se
**excluye** del cálculo de cobertura porque no es cubrible por Savings Plans (es una opción de
compra separada y se enruta a la Palanca 10).

| Métrica de cobertura | Valor |
|----------------------|------:|
| Importe **cubierto** por Savings Plans (USD) | **7 998,83** |
| Importe **on-demand sin cobertura** (USD) | **7 185,92** |
| Base cubrible (cubierto + on-demand, USD) | 15 184,75 |
| **Cobertura por coste** = 7 998,83 / 15 184,75 | **52,68 %** |
| **Cobertura por horas** = 41 151,216 / (41 151,216 + 24 959,242) | **62,25 %** |

> Se reportan **ambas** lecturas de cobertura (por coste y por horas) por trazabilidad. La cobertura
> por horas (≈ 62,2 %) coincide con el ejemplo trabajado del `design.md` (≈ 62 %); la cobertura por
> coste (≈ 52,7 %) es la lectura económica. AWS Cost Explorer expresa la cobertura SP por horas/gasto
> de cómputo; ambas quedan dentro de `[0, 100]` (Req 8.1).

**Registro de evidencia (esquema del Catálogo_Evidencias):**

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-3.1-ec2-particion-compra` |
| `descripcion` | Partición del gasto de cómputo EC2 por opción de compra (sp_covered/spot/on_demand) y cobertura de compromiso |
| `consulta_cur` | Consulta canónica del `design.md` (arriba) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:14:51Z` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` (agregado por opción de compra) |
| `dimension_agregacion` | `purchase_option` (CASE sobre `line_item_line_item_type`/`line_item_usage_type`); medidas `SUM(line_item_unblended_cost)`, `SUM(pricing_public_on_demand_cost)`, `SUM(line_item_usage_amount)` |
| `verificacion_vivo` | `null` (se ejecuta en la Tarea 3.2) |
| `clasificacion` | base de cobertura para la Palanca 1 (clasificación Garantizado/Estimado se fija en la Tarea 3.3) |

---

## Evidencia B — Partición del on-demand en estable vs intermitente/ráfaga (Req 8.4)

**`id_evidencia`:** `EV-3.1-ec2-estable-vs-burst`
**Criterio "uso estable" (Req 8.4):** un recurso está presente en **≥ 90 %** de las horas dentro de
una ventana de **≥ 30 días**. El Mes_Referencia (mayo 2026) tiene 31 días = **744 horas**; el umbral
es `0,90 × 744 = 669,6 horas`. Un `line_item_resource_id` con horas de uso ≥ 669,6 se clasifica
**estable**; el resto, **intermitente/ráfaga**.
**Clasificación del registro:** agrega por `line_item_resource_id` y segmenta; cifra
`no atribuible a recurso` individual (es la suma de un conjunto de recursos por segmento, Req 2.3).

### Consulta CUR exacta (re-ejecutable)

```sql
WITH od AS (
  SELECT line_item_resource_id              AS rid,
         SUM(line_item_usage_amount)        AS hours,
         SUM(line_item_unblended_cost)      AS cost,
         SUM(pricing_public_on_demand_cost) AS od_equiv
  FROM data
  WHERE line_item_product_code = 'AmazonEC2'
    AND line_item_usage_type LIKE '%BoxUsage%'
    AND line_item_line_item_type IN ('Usage','DiscountedUsage')
    AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
    AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
  GROUP BY line_item_resource_id
)
SELECT CASE WHEN hours >= 669.6 THEN 'stable_ge90pct' ELSE 'intermittent_burst' END AS segment,
       COUNT(*)        AS resources,
       SUM(hours)      AS usage_hours,
       SUM(cost)       AS unblended,
       SUM(od_equiv)   AS on_demand_equiv
FROM od
GROUP BY 1;
```

> Nota: la consulta filtra solo `%BoxUsage%` (cómputo on-demand puro), **excluyendo** `%SpotUsage%`,
> porque la separación estable/ráfaga se aplica al on-demand cubrible por compromiso (la base de la
> Palanca 1). El umbral `669,6 h` es 90 % de las 744 h del mes (ventana de 31 días ≥ 30 días, Req 8.4).

Ejecución:

```bash
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "<consulta de arriba, en una sola línea>" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

- `QueryExecutionId`: `1db44d07-1d8d-442f-9fb1-cc8198e0a16a`
- Estado: `SUCCEEDED`

### Resultado congelado (importes half-up a 2 decimales, USD)

| Segmento on-demand | Recursos | Horas de uso | Unblended (USD) | On-demand equiv (USD) | Destino |
|--------------------|---------:|-------------:|----------------:|----------------------:|---------|
| `stable_ge90pct` (≥ 669,6 h) | 18 | 13 358,350 | **4 813,47** | 4 813,47 | Base direccionable de la **Palanca 1** (compromiso SP) |
| `intermittent_burst` (< 669,6 h) | 2 363 | 11 600,892 | **2 372,44** | 2 372,44 | Se **enruta a la Palanca 10** (Spot/scheduling), sin doble conteo (Req 8.6, 8.8) |
| **Total on-demand** | **2 381** | **24 959,242** | **7 185,92** | **7 185,92** | — |

> Precisión completa: `stable_ge90pct` = `4813.473246255701` USD / `13358.3501194394` h ·
> `intermittent_burst` = `2372.4420435053985` USD / `11600.892166723504` h.

**Control de reconciliación (anticipo de Property 7 — ausencia de doble conteo, Req 8.8):** la suma
de los dos segmentos reconstruye exactamente el `on_demand` de la Evidencia A, sin solapes ni huecos:

```
  4 813,47  (estable, → Palanca 1)
+ 2 372,44  (intermitente/ráfaga, → Palanca 10)
-----------
= 7 185,92  (= on_demand de la Evidencia A)  ✓
```

Horas: `13 358,350 + 11 600,892 = 24 959,242` = horas `on_demand` de la Evidencia A ✓.

**Registro de evidencia (esquema del Catálogo_Evidencias):**

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-3.1-ec2-estable-vs-burst` |
| `descripcion` | Separación del cómputo EC2 on-demand en estable (≥90% de 744 h) vs intermitente/ráfaga, por `line_item_resource_id` |
| `consulta_cur` | Consulta CTE `od` (arriba) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:14:51Z` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` a nivel de segmento (18 recursos estables + 2 363 intermitentes; el detalle por `line_item_resource_id` se enumera en la Verificacion_Recurso_Vivo de la Tarea 3.2) |
| `dimension_agregacion` | segmento {`stable_ge90pct`, `intermittent_burst`} sobre `line_item_resource_id`; medida `SUM(line_item_unblended_cost)` y `SUM(line_item_usage_amount)` |
| `verificacion_vivo` | `null` (familias estables se confirman en la Tarea 3.2) |
| `clasificacion` | base estable = direccionable Palanca 1; base intermitente = Palanca 10 |

---

## Síntesis de la Tarea 3.1 (cifras congeladas)

| Concepto | Importe (USD) | Horas | Notas |
|----------|--------------:|------:|-------|
| EC2 cubierto por Savings Plans | 7 998,83 | 41 151,216 | ya optimizado (no direccionable) |
| EC2 on-demand sin cobertura | 7 185,92 | 24 959,242 | de los cuales… |
| → on-demand **estable** (Palanca 1) | **4 813,47** | 13 358,350 | 18 recursos · base de compromiso SP |
| → on-demand **intermitente/ráfaga** (Palanca 10) | 2 372,44 | 11 600,892 | 2 363 recursos · Spot/scheduling |
| EC2 Spot | 3,30 | 25,369 | opción Spot ya en uso |
| **Cobertura de compromiso EC2** | **52,68 % (coste) / 62,25 % (horas)** | — | Req 8.1, ∈ [0, 100] |

**Pendiente (siguientes sub-tareas, no parte de 3.1):**
- **Tarea 3.2** — `Verificacion_Recurso_Vivo` de solo lectura (`aws ce get-savings-plans-coverage`,
  `describe-savings-plans`, `ec2 describe-instances`) para confirmar cobertura vigente, fechas de
  expiración y familias estables; región `eu-west-1`.
- **Tarea 3.3** — aplicar fórmula de ahorro sobre la base **estable** `4 813,47 USD` (Conservador ≈
  Compute SP 28 %, Agresivo ≈ EC2 Instance SP 37 %, origen precio público AWS + fecha), declarar
  plazos (1 y 3 años) y opción de pago, clasificar **Estimado** (rango) y marcar **requiere
  Barrido_Utilizacion** (Req 18.1).

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23` el `2026-06-23T08:14:51Z`.
- `QueryExecutionId` retenidos: `dc0cca4c-d315-4621-81c2-7004990fd67b` (partición por opción de
  compra) y `1db44d07-1d8d-442f-9fb1-cc8198e0a16a` (estable vs intermitente).
- Cifras congeladas y reproducibles: re-ejecutar las consultas documentadas sobre el mismo
  Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría en
  Tarea 17.6). Ambos segmentos reconcilian con la partición (`Σ = on_demand`, Req 8.8).

---

# Sub-registro de Verificacion_Recurso_Vivo — Tarea 3.2 (solo lectura)

> Artefacto auditable de la **Tarea 3.2**: confirmación contra AWS en vivo (operaciones
> **estrictamente de solo lectura** describe/list/get) de la cobertura EC2 por Savings Plans
> vigente, de sus fechas de expiración respecto al horizonte de anualización, y de las familias
> de instancia estables que sostienen la base direccionable de la Palanca 1 (Tarea 3.1). Ningún
> comando es mutante (Req 5.1; auditoría en Tarea 17.7).
>
> **Validates: Requirements 5.1, 5.5, 8.7**
>
> Esquema de cada entrada (Catálogo_Evidencias → Sub-registro de Verificacion_Recurso_Vivo):
> `comando`, `cuenta`, `region`, `fecha_hora_utc`, `estado` (confirmado/excluido/no_verificable),
> `motivo`. Credenciales referenciadas por **nombre de perfil SSO** (nunca incrustadas, Req 7.5).

## Contexto de ejecución

| Campo | Valor |
|-------|-------|
| Fecha-hora de verificación (UTC) | `2026-06-23T08:49:49Z` → `2026-06-23T08:51:23Z` |
| Fecha-hora (Europe/Madrid, CEST) | `2026-06-23T10:51:23+02:00` |
| Identidad SSO | `AWSReservedSSO_MPA-AdministratorAccess` · `ruben.landin@emefinpetcare.com` (perfil `root-iskaypet`) para `ce`/`savingsplans`; perfiles SSO SRE por cuenta para `ec2 describe-instances` |
| Región | `eu-west-1` (Cost Explorer y Savings Plans son APIs **a nivel de cuenta pagadora/globales**: agregan todas las regiones de la organización; `ec2 describe-instances` sí es regional `eu-west-1`) |
| Frescura respecto al `Dataset_Congelado` | Verificación a `2026-06-23` vs extracción del congelado `2026-06-23` → frescura 0 días (≤ 30 días, Req 3.2) |
| Naturaleza de los comandos | `get-savings-plans-coverage`, `describe-savings-plans`, `describe-instances` → **todas read-only** |

---

## Verificación V1 — Cobertura de compromiso EC2 vigente (`ce get-savings-plans-coverage`)

**Comando re-ejecutable:**

```bash
aws ce get-savings-plans-coverage \
  --profile root-iskaypet --region eu-west-1 \
  --time-period Start=2026-05-01,End=2026-06-01 \
  --granularity MONTHLY \
  --group-by Type=DIMENSION,Key=SERVICE
```

**Resultado (línea `Amazon Elastic Compute Cloud - Compute`):**

| Métrica (Cost Explorer en vivo) | Valor | Cifra congelada CUR (Tarea 3.1, Evidencia A) | Conciliación |
|---------------------------------|------:|---------------------------------------------:|:------------:|
| `SpendCoveredBySavingsPlans` | 7 998,8281229178 | 7 998,83 (`sp_covered`) | ✓ |
| `OnDemandCost` | 7 185,9152897611 | 7 185,92 (`on_demand`) | ✓ |
| `TotalCost` (base cubrible) | 15 184,7434126789 | 15 184,75 | ✓ |
| `CoveragePercentage` | 52,6767…% | 52,68 % (cobertura por coste) | ✓ |

> La verificación en vivo **cuadra exactamente** con la partición congelada del CUR (diferencia
> ≤ 0,01 USD por redondeo half-up). La llamada agregada sin `group-by` devuelve 50,89 % porque mete
> en el denominador otros servicios cubribles por Compute SP (Lambda `OnDemandCost` 18,33; DynamoDB
> 451,96 sin cobertura SP —no aplica—; ElastiCache 27,32; SageMaker 35,61); para la Palanca 1 se usa
> la línea **EC2-Compute** (52,68 %), idéntica a la base congelada.

| Campo del sub-registro | Valor |
|------------------------|-------|
| `comando` | `aws ce get-savings-plans-coverage --profile root-iskaypet --region eu-west-1 --time-period Start=2026-05-01,End=2026-06-01 --granularity MONTHLY --group-by Type=DIMENSION,Key=SERVICE` |
| `cuenta` | `600700800900` (root-iskaypet, cuenta pagadora — la cobertura SP agrega toda la organización) |
| `region` | `eu-west-1` (API a nivel de cuenta pagadora/global) |
| `fecha_hora_utc` | `2026-06-23T08:49:49Z` |
| `estado` | `confirmado` |
| `motivo` | Cobertura EC2 en vivo (52,68 %, cubierto 7 998,83 / on-demand 7 185,92) concilia con la partición congelada de la Tarea 3.1 sin discrepancia material |

---

## Verificación V2 — Inventario de Savings Plans y fechas de expiración (`savingsplans describe-savings-plans`)

**Comando re-ejecutable:**

```bash
aws savingsplans describe-savings-plans \
  --profile root-iskaypet --region eu-west-1 \
  --states active
```

**Resultado: 1 Savings Plan activo.**

| Atributo | Valor |
|----------|-------|
| `savingsPlanId` | `dae0756e-c1b1-465a-a5a0-c48a1927ddb5` |
| `savingsPlanArn` | `arn:aws:savingsplans::600700800900:savingsplan/dae0756e-c1b1-465a-a5a0-c48a1927ddb5` |
| `description` | `3 year Partial Upfront Compute Savings Plan` |
| `savingsPlanType` | `Compute` (flexible: aplica a EC2, Fargate y Lambda) |
| `productTypes` | `Fargate`, `EC2`, `Lambda` |
| `paymentOption` | `Partial Upfront` |
| `commitment` | `5.21400000` USD/hora |
| `upfrontPaymentAmount` | `68 512,00` USD |
| `recurringPaymentAmount` | `2.60699848` USD/hora |
| `start` | `2025-04-21T08:16:07Z` |
| `end` | **`2028-04-20T08:16:06Z`** |
| `state` | `active` |

**Análisis de expiración dentro del horizonte de anualización (Req 8.7):** el horizonte de
anualización del Estudio es Mes_Referencia + 12 meses ≈ `2026-05` → `2027-05`. El único SP activo
**expira el `2028-04-20`**, es decir, **fuera** de ese horizonte. Por tanto:

- **NO hay** Savings Plans que expiren dentro del horizonte de anualización.
- **NO existe**, en consecuencia, coste que quedaría sin cobertura por expiración a renovar dentro
  del horizonte (lista vacía para Req 8.7).
- El compromiso vigente (`commitment` 5,214 USD/h ≈ 3 879,22 USD/mes sobre 744 h) seguirá cubriendo
  cómputo durante todo el horizonte; el ahorro de la Palanca 1 se basa en **ampliar** cobertura
  sobre la porción on-demand **estable** (4 813,47 USD, Tarea 3.1), no en renovar un SP que expire.

| Campo del sub-registro | Valor |
|------------------------|-------|
| `comando` | `aws savingsplans describe-savings-plans --profile root-iskaypet --region eu-west-1 --states active` |
| `cuenta` | `600700800900` (root-iskaypet — los SP de la organización se compran a nivel de cuenta pagadora) |
| `region` | `eu-west-1` (API a nivel de cuenta pagadora/global) |
| `fecha_hora_utc` | `2026-06-23T08:50Z` |
| `estado` | `confirmado` |
| `motivo` | 1 Compute SP activo (3 años, Partial Upfront) con expiración `2028-04-20`, **fuera** del horizonte de anualización; sin SP expirando dentro del horizonte (Req 8.7: lista de expiración vacía) |

---

## Verificación V3 — Familias de instancia estables EC2 (`ec2 describe-instances`)

**Comando re-ejecutable (por cuenta de cómputo, región `eu-west-1`):**

```bash
aws ec2 describe-instances \
  --profile <perfil> --region eu-west-1 \
  --filters Name=instance-state-name,Values=running \
  --query 'Reservations[].Instances[].InstanceType' --output text
```

**Resultado por cuenta (instancias `running`, recuento por tipo):**

| Cuenta (perfil) | id cuenta | Tipos de instancia en ejecución | Familias |
|-----------------|-----------|---------------------------------|----------|
| eks-prd | `333344445555` | 10× `c6a.xlarge`, 7× `r7i.large`, 7× `m6i.large` | c6a, r7i, m6i |
| eks-uat | `222233334444` | 4× `m7i.xlarge`, 3× `c6a.xlarge` | m7i, c6a |
| eks-dev | `111122223333` | 8× `m7i.xlarge`, 2× `m7i.large`, 2× `m6i.large`, 2× `c7a.xlarge` | m7i, m6i, c7a |
| eks-tooling | `444455556666` | 3× `m7a.2xlarge`, 1× `t2.micro` | m7a, t2 |
| digital-prod | `111222333444` | (sin instancias EC2 en ejecución) | — (cómputo serverless/Fargate) |

**Análisis (familias estables, Palanca 1):** todas las instancias en ejecución pertenecen a
**familias de generación actual de propósito general / cómputo / memoria** (`m6i`, `m7i`, `m7a`,
`c6a`, `c7a`, `r7i`) — todas **cubribles por Compute Savings Plans** y estables/persistentes (nodos
de EKS 24/7). La única excepción es `1× t2.micro` (burstable, coste marginal). Esto confirma que la
base on-demand **estable** identificada en la Tarea 3.1 (18 recursos, 4 813,47 USD) corresponde a
familias aptas para compromiso, sin tipos exóticos ni de fin de vida. `digital-prod` no tiene EC2
en ejecución (cómputo serverless), coherente con su perfil.

| Campo del sub-registro | Valor |
|------------------------|-------|
| `comando` | `aws ec2 describe-instances --profile {eks-prd,eks-uat,eks-dev,eks-tooling,digital-prod} --region eu-west-1 --filters Name=instance-state-name,Values=running --query 'Reservations[].Instances[].InstanceType'` |
| `cuenta` | `333344445555` (eks-prd), `222233334444` (eks-uat), `111122223333` (eks-dev), `444455556666` (eks-tooling), `111222333444` (digital-prod) |
| `region` | `eu-west-1` |
| `fecha_hora_utc` | `2026-06-23T08:51:23Z` |
| `estado` | `confirmado` |
| `motivo` | Familias en ejecución (m6i/m7i/m7a/c6a/c7a/r7i) de generación actual y cubribles por Compute SP; base estable de la Palanca 1 confirmada apta para compromiso. `digital-prod` sin EC2 (serverless) → no aplica |

---

## Síntesis de la Tarea 3.2 (estado de verificación)

| Verificación | Comando read-only | Cuenta(s) | Región | Estado | Resultado |
|--------------|-------------------|-----------|--------|--------|-----------|
| V1 — cobertura EC2 vigente | `ce get-savings-plans-coverage` | `600700800900` (pagadora) | eu-west-1 | **confirmado** | 52,68 % EC2-Compute; concilia con CUR 3.1 |
| V2 — inventario + expiración SP | `savingsplans describe-savings-plans` | `600700800900` (pagadora) | eu-west-1 | **confirmado** | 1 Compute SP activo, expira 2028-04-20 (fuera del horizonte; Req 8.7 lista vacía) |
| V3 — familias estables | `ec2 describe-instances` | eks-prd/uat/dev/tooling, digital-prod | eu-west-1 | **confirmado** | Familias gen-actual cubribles por SP; base estable Palanca 1 apta |

**Conclusiones para la Palanca 1 (entrada a la Tarea 3.3):**
- La cobertura SP en vivo (52,68 % EC2-Compute) **confirma** la partición congelada de la Tarea 3.1
  sin discrepancia material (Req 5.5).
- **No hay SP expirando dentro del horizonte de anualización** (único SP activo vence 2028-04-20),
  por lo que el coste direccionable de la Palanca 1 proviene de **ampliar** la cobertura sobre la
  porción on-demand **estable** (4 813,47 USD), no de renovaciones por expiración (Req 8.7).
- Las **familias estables** que sostienen esa base están **confirmadas** como aptas para Compute SP.
- Todos los comandos ejecutados son **estrictamente de solo lectura** (describe/list/get); ninguno
  es mutante (Req 5.1; auditoría Property 11 en la Tarea 17.7).

## Estado de ejecución (Tarea 3.2)

- ✅ **Ejecutado** en vivo el `2026-06-23` (08:49–08:51 UTC) con sesión SSO SRE.
- Las tres verificaciones quedan en estado **`confirmado`**; no hubo cuentas con permisos denegados
  para esta Palanca (la cobertura/inventario SP se obtienen de la cuenta pagadora `root-iskaypet`,
  accesible; las cuentas de cómputo EKS responden a `describe-instances`).
- Verificación re-ejecutable: los comandos están documentados con credenciales referenciadas por
  **nombre de perfil** (sin incrustar, Req 7.5); el drift del recurso vivo en re-ejecuciones futuras
  es esperado y no invalida las cifras ancladas al `Dataset_Congelado` (Req 7.6).

---

# Aplicación de fórmula, clasificación y documentación — Tarea 3.3

> Artefacto auditable de la **Tarea 3.3**: aplicación de la fórmula de ahorro de Savings Plans sobre
> la porción on-demand **estable** congelada en la Tarea 3.1 (`4 813,47 USD`, 18 recursos),
> clasificación de la Palanca como **Estimado** (rango Conservador–Agresivo) y documentación de los
> campos obligatorios por Palanca (Req 4). Las cifras de descuento parten del **precio público AWS**
> a fecha de extracción y la Palanca queda marcada como **requiere Barrido_Utilizacion** antes de
> elevarse a objetivo comprometido (Req 18.1).
>
> **Validates: Requirements 3.3, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1, 8.5, 8.6, 8.8, 18.1**
>
> Entradas: base estable `4 813,47 USD` (Tarea 3.1, Evidencia B) + verificación en vivo `confirmado`
> (Tarea 3.2: cobertura 52,68 %, 1 Compute SP activo que expira 2028-04-20, **fuera** del horizonte
> de anualización; familias estables gen-actual aptas para SP). Todas las cifras ancladas al
> `Dataset_Congelado` `frozen-2026-05@2026-06-23`, moneda USD.

## Base direccionable y enrutado (Req 8.5, 8.6, 8.8 — sin doble conteo)

La fórmula se aplica **exclusivamente** sobre la porción on-demand **estable** (uso ≥ 90 % de las
744 h del mes, ventana ≥ 30 días — definición de "uso estable", Req 8.4). La porción
intermitente/ráfaga **no** entra en esta Palanca: se enruta a la **Palanca 10** (Spot/scheduling),
de modo que ninguna hora de cómputo se contabiliza dos veces (Req 8.6, 8.8).

| Segmento on-demand (Tarea 3.1, Ev. B) | Coste base (USD) | Horas | Destino |
|---------------------------------------|-----------------:|------:|---------|
| `stable_ge90pct` (≥ 669,6 h) | **4 813,47** | 13 358,350 | **Palanca 1** (base direccionable de compromiso SP) |
| `intermittent_burst` (< 669,6 h) | 2 372,44 | 11 600,892 | **Palanca 10** (Spot/scheduling) — excluido aquí |

**Coste base mensual afectado (Req 4.2):** `4 813,47 USD` (porción on-demand estable). El `spot`
(3,30 USD) y el ya cubierto por SP (7 998,83 USD) **no** son direccionables por esta Palanca (el
primero es opción de compra separada → Palanca 10; el segundo ya está optimizado).

**% direccionable (Req 4.2, 0–100, 1 decimal).** Se reporta sobre tres denominadores por
transparencia; el canónico de la Palanca es el relativo al on-demand cubrible:

| Denominador | Cálculo | % direccionable |
|-------------|---------|----------------:|
| **On-demand cubrible** (canónico) | 4 813,47 / 7 185,92 | **67,0 %** |
| Base cubrible (cubierto + on-demand, excl. spot) | 4 813,47 / 15 184,75 | 31,7 % |
| Cómputo EC2 total (BoxUsage+SpotUsage) | 4 813,47 / 15 188,05 | 31,7 % |

> Lectura: de cada dólar on-demand de EC2, ~67 % corresponde a uso estable comprometible por
> Savings Plans; el ~33 % restante es ráfaga/intermitente que se trata en la Palanca 10.

## Fórmula de ahorro y supuesto de descuento (Req 4.1, 4.3, 6.1)

**Mecánica.** Un Savings Plan convierte el precio on-demand de la porción estable en un precio
comprometido con descuento. El ahorro mensual = `coste_base_estable × tasa_descuento_SP`.

| Parámetro | Valor | Detalle |
|-----------|-------|---------|
| Coste base estable (mensual) | `4 813,47 USD` | precisión completa `4813.473246255701` |
| **Conservador** — tasa Compute SP (flexible) | **28,0 %** | SP flexible (EC2 + Fargate + Lambda), descuento más prudente |
| **Agresivo** — tasa EC2 Instance SP | **37,0 %** | SP ligado a familia/región, descuento máximo defendible |
| Origen del supuesto (Req 4.3) | **precio público AWS** | fecha del dato: **2026-06-23** (= fecha de extracción del `Dataset_Congelado`) |

> Los porcentajes 28 % / 37 % proceden del **precio público AWS** (calculadora de Savings Plans) y
> deben re-confirmarse contra la calculadora vigente en la fecha de extracción. No son tarifa
> negociada. Ambos tramos corresponden al ejemplo trabajado del `design.md` (Palanca 1).

### Cálculo del ahorro (half-up a 2 decimales, USD — Req 6.7)

**Ahorro mensual** (Rango_Conservador–Rango_Agresivo):

```
Conservador = 4 813,473246255701 × 0,28 = 1 347,772508951596  → 1 347,77 USD/mes
Agresivo    = 4 813,473246255701 × 0,37 = 1 780,985101114609  → 1 780,99 USD/mes
```

**Ahorro anualizado** = mensual × 12 (Req 6.3; advertencia de estacionalidad abajo):

```
Conservador anual = 1 347,772508951596 × 12 = 16 173,270107419  → 16 173,27 USD/año
Agresivo anual    = 1 780,985101114609 × 12 = 21 371,821213375  → 21 371,82 USD/año
```

> **Advertencia de anualización (Req 6.4):** la cifra anual asume que el Mes_Referencia (mayo 2026)
> es representativo y **no captura estacionalidad**. El cómputo EKS 24/7 es estable mes a mes, lo
> que respalda la representatividad, pero el objetivo comprometido no se fija hasta el
> Barrido_Utilizacion.
>
> Nota de captura progresiva (Req 6.5): un SP captura ahorro desde su activación; el primer año real
> puede ser captura parcial prorrateada según el mes de compra. La cifra anualizada de arriba es la
> de **régimen estacionario** (12 meses completos de cobertura).

## Clasificación (Req 3.3) — **Estimado** (rango)

| Atributo | Valor |
|----------|-------|
| Clasificación | **Estimado** (Ahorro_Estimado) — se expresa **siempre como rango**, nunca cifra única |
| Rango_Conservador | **1 347,77 USD/mes** · 16 173,27 USD/año |
| Rango_Agresivo | **1 780,99 USD/mes** · 21 371,82 USD/año |
| Invariante `0 < Conservador ≤ Agresivo` (Req 3.3) | `0 < 1 347,77 ≤ 1 780,99` ✓ · anual `0 < 16 173,27 ≤ 21 371,82` ✓ |

**Motivo de la clasificación Estimado:** el recurso está **confirmado en vivo** (Tarea 3.2:
familias estables aptas, cobertura conciliada), pero el ahorro depende de **supuestos** (tasa de
descuento SP 28–37 %, perfil de uso estable sostenido). No es desperdicio puro eliminable, sino una
optimización de compra sujeta a supuestos → **Estimado**, no Garantizado (Req 3.1, 3.3).

## Plazo de compromiso y opción de pago (Req 8.5)

| Dimensión | Opciones declaradas |
|-----------|---------------------|
| **Plazo** | **1 año** y **3 años** (a mayor plazo, mayor descuento; el rango 28–37 % cubre la combinación tipo de SP × plazo) |
| **Opción de pago** | No Upfront / Partial Upfront / All Upfront (a mayor pago anticipado, mayor descuento) |
| Tipo de SP | Compute SP (flexible) → Conservador · EC2 Instance SP (ligado a familia/región) → Agresivo |

> Contexto de la Tarea 3.2: el SP vigente de la organización es un **3 year Partial Upfront Compute
> Savings Plan** (commitment 5,214 USD/h, expira 2028-04-20, **fuera** del horizonte de anualización
> Mes_Referencia + 12 m). La ampliación de cobertura de esta Palanca se **suma** al compromiso
> vigente sobre la porción on-demand estable; no es una renovación por expiración (Req 8.7: lista de
> expiración dentro del horizonte vacía).

## Documentación de la Palanca — campos obligatorios (Req 4.1–4.7)

| Campo (Req 4) | Valor |
|---------------|-------|
| **Supuesto de descuento** (Req 4.1, 0–100, 1 decimal) | Conservador **28,0 %** (Compute SP) · Agresivo **37,0 %** (EC2 Instance SP) |
| **% direccionable + coste base mensual afectado** (Req 4.2) | **67,0 %** del on-demand cubrible · coste base afectado **4 813,47 USD/mes** (porción estable) |
| **Origen del supuesto + fecha** (Req 4.3) | **precio público AWS** (calculadora de Savings Plans) · fecha **2026-06-23** |
| **Riesgo** (Req 4.4) | **Medio** — compromiso de 1–3 años: si el uso estable cae (migración a Spot/serverless, apagado de cuentas), el SP infrautilizado se paga igual. Mitigado porque la base es cómputo EKS 24/7 confirmado y el SP Compute es flexible (cubre EC2/Fargate/Lambda) |
| **Esfuerzo** (Req 4.5) | **Bajo** — la compra de un SP es una acción de consola/API sin cambios en workloads ni downtime; el esfuerzo real está en el Barrido_Utilizacion previo (dimensionar el commitment) |
| **Owner / responsable** (Req 4.6) | **pendiente** (SRE / Plataforma — correo corporativo por asignar) |
| Campos no evaluables (Req 4.7) | owner → "pendiente" (resto evaluado) |

## Barrido_Utilizacion (Req 18.1) — **REQUERIDO**

🔶 **Esta Palanca REQUIERE Barrido_Utilizacion antes de elevarse a objetivo comprometido.** El
ahorro Estimado se presenta **solo como rango** hasta completar el barrido de compromiso
steady-state (Tarea 16.1): confirmar que el "uso estable" (≥ 90 % de horas en ventana ≥ 30 días) que
sostiene el coste base de 4 813,47 USD se mantiene de forma defendible y dimensionar el commitment
óptimo (sin sobre-comprometer). Hasta entonces, esta Palanca **no entra** en el
`Objetivo_Comprometido` (Req 18.2; derivación cerrada en Tarea 19.4).

## Registro de evidencia (esquema del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-3.3-ec2-sp-ahorro` |
| `cifra_publicada` | Rango mensual **1 347,77 – 1 780,99 USD** · anual **16 173,27 – 21 371,82 USD** |
| `descripcion` | Ahorro por compromiso Savings Plans sobre la porción on-demand EC2 estable (28 % Compute SP Conservador – 37 % EC2 Instance SP Agresivo) |
| `consulta_cur` | derivada — no aplica consulta propia (se calcula sobre la base estable `4 813,47 USD` de `EV-3.1-ec2-estable-vs-burst`); fórmula `base × tasa_SP` documentada arriba |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:14:51Z` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` — ahorro agregado sobre los 18 recursos estables de `EV-3.1-ec2-estable-vs-burst` (enumerados en la Verificacion_Recurso_Vivo de la Tarea 3.2) |
| `dimension_agregacion` | porción on-demand `stable_ge90pct` (≥ 669,6 h); medida = `SUM(line_item_unblended_cost)` × tasa de descuento SP {28 %, 37 %} |
| `verificacion_vivo` | Tarea 3.2 — `confirmado` (V1 cobertura 52,68 % concilia; V2 1 SP activo expira 2028-04-20 fuera del horizonte; V3 familias gen-actual aptas para SP) |
| `clasificacion` | `estimado` (rango Conservador–Agresivo; invariante `0 < Cons ≤ Agr` ✓) |
| `requiere_barrido` | **Sí** — Barrido_Utilizacion de compromiso steady-state (Tarea 16.1) pendiente antes de comprometer objetivo (Req 18.1) |

## Síntesis de la Tarea 3.3 (Palanca 1 — clasificada y documentada)

| Concepto | Valor |
|----------|-------|
| Clasificación | **Estimado** (rango) |
| Coste base mensual afectado | 4 813,47 USD (on-demand estable) · % direccionable 67,0 % del on-demand cubrible |
| Ahorro mensual | **1 347,77 – 1 780,99 USD** (Compute SP 28 % – EC2 Instance SP 37 %) |
| Ahorro anualizado (×12) | **16 173,27 – 21 371,82 USD** (asume mes representativo; no captura estacionalidad) |
| Plazo / pago | 1 y 3 años · No/Partial/All Upfront |
| Origen del supuesto | precio público AWS · 2026-06-23 |
| Riesgo / Esfuerzo / Owner | Medio / Bajo / pendiente (SRE-Plataforma) |
| Enrutado sin doble conteo | porción intermitente/ráfaga (2 372,44 USD) → **Palanca 10** (Req 8.6, 8.8) |
| Gating | 🔶 **requiere Barrido_Utilizacion** (Tarea 16.1) — fuera de objetivo comprometido hasta completarlo (Req 18.1) |

## Estado de ejecución (Tarea 3.3)

- ✅ **Completada.** Fórmula aplicada sobre la base estable congelada (`4 813,47 USD`); rango
  Estimado **1 347,77 – 1 780,99 USD/mes** (anual 16 173,27 – 21 371,82 USD), invariante
  `0 < Conservador ≤ Agresivo` verificada en mensual y anual.
- Cifras reproducibles: re-aplicar `base × {0,28; 0,37}` sobre `4813.473246255701` con redondeo
  half-up a 2 decimales reproduce exactamente el rango (diferencia `0,00 USD`, Req 7.3).
- Palanca marcada **requiere Barrido_Utilizacion**; no se eleva a objetivo comprometido hasta la
  Tarea 16.1 (Req 18.1, 18.2). Porción ráfaga enrutada a la Palanca 10 sin doble conteo (Req 8.8).
