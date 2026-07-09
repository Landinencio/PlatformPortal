# Registro Palanca 10 — Entornos no productivos: scheduling y Spot — Tarea 12.1

> Artefacto auditable de la **Tarea 12.1**: consulta CUR de horas de cómputo EC2 en cuentas
> **no productivas** particionadas por cuenta + opción de compra (`spot` / `on_demand` /
> `sp_covered`), cuantificación del **uso actual de Spot** y de la **oportunidad de ampliarlo**, y
> establecimiento de la base direccionable de Palanca 10 con **horas disjuntas** de las de la
> Palanca 1 (sin doble conteo, Req 8.8). Cifras congeladas contra el `Dataset_Congelado` y
> reproducibles re-ejecutando las consultas documentadas.
>
> **Validates: Requirements 15.1, 15.3, 8.8, 2.3**
>
> Este fichero es el artefacto PROPIO de la Tarea 12.1 (no se toca `catalogo-evidencias.md`, el
> catálogo compartido de la Fundación, ni el resto de ficheros de `evidencias/`). El supuesto de
> horas reducidas, la fórmula de ahorro, las exclusiones (24/7 obligado, stateful/sin tolerancia a
> interrupción), la clasificación (**Estimado**, rango) y la `Verificacion_Recurso_Vivo` se
> producen en las Tareas 12.2 y 12.3, y el barrido en la Tarea 16.3.

## Parámetros de anclaje (Req 2.1, 2.5)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23T08:44:52Z` (UTC) · `2026-06-23T10:44:52+02:00` (Europe/Madrid, CEST) |
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

## Alcance de cuentas no productivas (dev / uat / sandbox)

Conjunto canónico de cuentas no-prod del estudio (mapa de `portal-architecture.md` §3 y §7). Toda
cuenta del alcance no-prod se incluye en la consulta aunque presente cero filas de cómputo EC2.

| Cuenta (ID) | Nombre (perfil) | ¿EC2 BoxUsage/SpotUsage en mayo 2026? |
|-------------|-----------------|----------------------------------------|
| `111122223333` | EKS Dev (eks-dev) | **sí** |
| `222233334444` | EKS UAT (eks-uat) | **sí** |
| `100200300400` | Data desarrollo (data-dev) | **sí** |
| `999900001111` | Digital Dev (digital-dev) | **sí** (1 recurso estable — ver disyunción) |
| `000011112222` | Digital UAT (digital-uat) | no (cero filas EC2 cómputo) |
| `444555666777` | Retail Dev (retail-dev) | no |
| `555666777888` | Retail UAT (retail-uat) | no |
| `555566667777` | Helios Dev (helios-dev) | no |
| `666677778888` | Helios UAT (helios-uat) | no |
| `777888999000` | (animalis-dev) | no (sin datos de coste en el Mes_Referencia) |
| `800900100200` | Sandbox Data (sandbox-data) | no |
| `100300500700` | Sandbox Infra&SRE (pruebas) | no |
| `700800900100` | Sandbox Backoffice (sandbox-backoffice) | no |
| `200400600800` | Sandbox Retail (sandbox-retail) | no |
| `900100200300` | Sandbox Digital (sandbox-digital) | no |

> El cómputo EC2 no-prod se concentra en las cuentas EKS dev/uat (`111122223333`, `222233334444`)
> más `data-dev` y un único recurso en `digital-dev`. Las cuentas dev/uat de squad (digital-uat,
> retail-dev/uat, helios-dev/uat) y las sandbox **no** ejecutan cómputo EC2 en el Mes_Referencia
> (su gasto es serverless/RDS/otros), por lo que no aportan horas de scheduling/Spot.

---

## Nota metodológica — alineación del tipo de línea con la Palanca 1 (corrección de la consulta del `design.md`)

La consulta de ejemplo del `design.md` para esta Palanca **no filtra** `line_item_line_item_type` y
clasifica como `on_demand` todo lo que no sea `%SpotUsage%`. Esa formulación **infla las horas** del
cómputo cubierto por Savings Plans: una hora cubierta aparece como `SavingsPlanCoveredUsage` (con su
`line_item_usage_amount`) **y** como `SavingsPlanNegation` (que arrastra el **mismo**
`usage_amount`), de modo que las horas cubiertas se cuentan **dos veces** y el `unblended` queda
netado por la negación (señal económica engañosa). Ejemplo en `eks-dev`: la consulta sin filtro
devuelve `19 231,57 h / $495,28`, mientras que la partición correcta (abajo) arroja
`on_demand 3 026,02 h / $538,35` + `sp_covered 8 102,78 h / $1 464,66` = `11 128,80 h`.

Para garantizar **disyunción a nivel de recurso/hora con la Palanca 1** (Req 8.8) y evitar ese
doble conteo, esta evidencia usa **el mismo disciplinado de tipos de línea que la Palanca 1**
(`line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','DiscountedUsage')`) y el **mismo
`CASE`** de opción de compra (`SavingsPlanCoveredUsage` → `sp_covered`; `%SpotUsage%` → `spot`;
resto → `on_demand`). Así, el `sp_covered` se separa limpiamente (ya bajo compromiso — territorio de
Palancas 1/2) y `on_demand` queda como base direccionable de scheduling/Spot.

---

## Evidencia A — Partición de cómputo EC2 no-prod por cuenta y opción de compra

**`id_evidencia`:** `EV-12.1-noprod-particion-compra`
**Clasificación del registro:** `no atribuible a recurso` — cifra agregada por dimensión cuenta ×
opción de compra (`purchase_option`), no atribuible a un recurso concreto (Req 2.4, 2.3).
**Dimensión de agregación (Req 2.3):** `line_item_usage_account_id` × `purchase_option` (CASE sobre
`line_item_line_item_type`/`line_item_usage_type`); medidas `SUM(line_item_usage_amount)`,
`SUM(line_item_unblended_cost)`, `SUM(pricing_public_on_demand_cost)`.

### Consulta CUR exacta (re-ejecutable)

```sql
SELECT
  line_item_usage_account_id AS acct,
  CASE
    WHEN line_item_line_item_type = 'SavingsPlanCoveredUsage' THEN 'sp_covered'
    WHEN line_item_usage_type LIKE '%SpotUsage%'              THEN 'spot'
    ELSE 'on_demand'
  END AS option,
  SUM(line_item_usage_amount)        AS hours,
  SUM(line_item_unblended_cost)      AS unblended,
  SUM(pricing_public_on_demand_cost) AS od_equiv,
  COUNT(*)                           AS line_items
FROM data
WHERE line_item_product_code = 'AmazonEC2'
  AND (line_item_usage_type LIKE '%BoxUsage%' OR line_item_usage_type LIKE '%SpotUsage%')
  AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','DiscountedUsage')
  AND line_item_usage_account_id IN (
    '111122223333','222233334444','999900001111','000011112222','444555666777',
    '555666777888','555566667777','666677778888','100200300400','777888999000',
    '800900100200','100300500700','700800900100','200400600800','900100200300')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2
ORDER BY 1, 2;
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

- `QueryExecutionId`: `db76fe8a-090f-4808-ac47-967e932456ae`
- Estado: `SUCCEEDED` · Datos escaneados: `6.480.792` bytes

### Resultado congelado (importes half-up a 2 decimales, USD)

| Cuenta (ID) | Nombre | Opción | Horas | Unblended (USD) | On-demand equiv (USD) | Líneas |
|-------------|--------|--------|------:|----------------:|----------------------:|-------:|
| `111122223333` | eks-dev | `on_demand` | 3 026,02 | 538,35 | 538,35 | 1 087 |
| `111122223333` | eks-dev | `sp_covered` | 8 102,78 | 1 464,66 | 1 464,66 | 1 783 |
| `222233334444` | eks-uat | `on_demand` | 1 052,54 | 225,70 | 225,70 | 328 |
| `222233334444` | eks-uat | `sp_covered` | 4 642,71 | 883,09 | 883,09 | 289 |
| `100200300400` | data-dev | `on_demand` | 241,39 | 92,35 | 92,35 | 462 |
| `100200300400` | data-dev | `sp_covered` | 511,36 | 203,77 | 203,77 | 697 |
| `999900001111` | digital-dev | `on_demand` | 743,94 | 9,37 | 9,37 | 32 |
| **Total no-prod `on_demand`** | | | **5 063,90** | **865,77** | **865,77** | 1 909 |
| **Total no-prod `sp_covered`** | | | **13 256,84** | **2 551,52** | **2 551,52** | 2 769 |
| **Total no-prod `spot`** | | | **0,00** | **0,00** | **0,00** | 0 |
| **Total cómputo EC2 no-prod** | | | **18 320,74** | **3 417,29** | **3 417,29** | 4 678 |

> Precisión completa (antes de redondeo, para reproducibilidad Req 7.3):
> `eks-dev on_demand` = `3026.0208451229014` h / `538.3454259323998` USD ·
> `eks-dev sp_covered` = `8102.775263877103` h / `1464.6606361581958` USD ·
> `eks-uat on_demand` = `1052.5438750367002` h / `225.6956825280003` USD ·
> `eks-uat sp_covered` = `4642.7083489633005` h / `883.0916586646988` USD ·
> `data-dev on_demand` = `241.39215449140008` h / `92.35060824570003` USD ·
> `data-dev sp_covered` = `511.3606275085999` h / `203.7707383519998` USD ·
> `digital-dev on_demand` = `743.943333` h / `9.373685995800006` USD.
> Totales antes de redondear: `on_demand` = `5063.900207650002` h / `865.7654027019001` USD;
> `sp_covered` = `13256.844240349003` h / `2551.5230331748944` USD.

**Hallazgo (Req 15.3 — uso de Spot):** en cuentas no productivas el uso de Spot es **cero**
(`0,00 USD`, 0 horas, 0 líneas). Todo el cómputo no-prod es `on_demand` o `sp_covered`.

---

## Evidencia B — Uso actual de Spot (org) y oportunidad de ampliarlo (Req 15.3)

**`id_evidencia`:** `EV-12.1-spot-baseline`
**Clasificación del registro:** `no atribuible a recurso` — cifra agregada por cuenta × Spot.

### Consulta CUR exacta (re-ejecutable)

```sql
SELECT line_item_usage_account_id        AS acct,
       SUM(line_item_usage_amount)        AS spot_hours,
       SUM(line_item_unblended_cost)      AS spot_unblended,
       SUM(pricing_public_on_demand_cost) AS spot_od_equiv,
       COUNT(*)                           AS line_items
FROM data
WHERE line_item_product_code = 'AmazonEC2'
  AND line_item_usage_type LIKE '%SpotUsage%'
  AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','DiscountedUsage')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 3 DESC;
```

- `QueryExecutionId`: `0a488303-6289-4622-b583-a1f5e35dbcff`
- Estado: `SUCCEEDED` · Datos escaneados: `6.450.702` bytes

### Resultado congelado

| Cuenta (ID) | Nombre | Horas Spot | Unblended (USD) | On-demand equiv (USD) | Líneas |
|-------------|--------|-----------:|----------------:|----------------------:|-------:|
| `444455556666` | EKS Tooling | 25,37 | 3,30 | 6,56 | 58 |
| **Total Spot org** | | **25,37** | **3,30** | **6,56** | 58 |

> Precisión completa: `25.368887` h / `3.2951832223` unblended / `6.5553204007999994` od_equiv.
> Cifra coherente con la Evidencia A de la Palanca 1 (mismo `spot` = 25,369 h / $3,30 / $6,56).

**Interpretación (uso actual + oportunidad):** el uso de Spot a nivel de **organización** es
**marginal** (`$3,30`, 25,37 h, **una sola cuenta**: tooling) y **nulo en no-prod**. El precio
on-demand-equivalente de ese mismo uso Spot es `$6,56`, lo que ilustra un descuento Spot ≈ 50 % ya
en esas pocas horas. La **oportunidad de ampliar Spot** es, por tanto, prácticamente todo el cómputo
`on_demand` tolerante a interrupción (recorrido máximo desde una base ≈ 0). La cuantificación del
ahorro y el % direccionable (con las exclusiones de workloads stateful/sin tolerancia a interrupción,
Req 15.4) se realizan en la Tarea 12.3.

---

## Evidencia C — Disyunción de horas con la Palanca 1 (control anti-doble-conteo, Req 8.8)

**`id_evidencia`:** `EV-12.1-disyuncion-palanca1`
**Property 7 (anticipo) — ausencia de doble conteo entre Palancas que comparten servicio (EC2).**

La Palanca 1 (compromiso EC2 / Savings Plans) fija su base direccionable sobre el cómputo on-demand
**estable** (`line_item_resource_id` con horas ≥ `0,90 × 744 = 669,6 h`) y **enruta a la Palanca 10**
la porción **intermitente/ráfaga** (< 669,6 h). Para confirmar que las horas de la Palanca 10 son
**disjuntas** de las comprometidas por la Palanca 1, se reproduce el conjunto **estable** de la
Palanca 1 con su cuenta de origen.

### Consulta CUR exacta (re-ejecutable)

```sql
WITH od AS (
  SELECT line_item_resource_id         AS rid,
         line_item_usage_account_id     AS acct,
         SUM(line_item_usage_amount)    AS hours,
         SUM(line_item_unblended_cost)  AS cost
  FROM data
  WHERE line_item_product_code = 'AmazonEC2'
    AND line_item_usage_type LIKE '%BoxUsage%'
    AND line_item_line_item_type IN ('Usage','DiscountedUsage')
    AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
    AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
  GROUP BY line_item_resource_id, line_item_usage_account_id
)
SELECT acct, COUNT(*) AS stable_resources, SUM(hours) AS hours, SUM(cost) AS cost
FROM od
WHERE hours >= 669.6
GROUP BY acct
ORDER BY cost DESC;
```

- `QueryExecutionId`: `5c394e67-22d2-4955-ad5d-0707137c8cf4`
- Estado: `SUCCEEDED` · Datos escaneados: `9.802.648` bytes

### Resultado congelado — recursos estables de la Palanca 1 por cuenta

| Cuenta (ID) | Nombre | Recursos estables | Horas | Coste (USD) | ¿No-prod? |
|-------------|--------|------------------:|------:|------------:|:---------:|
| `400500600700` | SAP | 5 | 3 720,00 | 3 383,71 | no (prod) |
| `300400500600` | infraestructura | 7 | 5 176,48 | 850,07 | no (compartida) |
| `200300400500` | Iskaypet Data | 4 | 2 973,93 | 560,94 | no (prod) |
| `444455556666` | EKS Tooling | 1 | 744,00 | 9,37 | no (tooling) |
| `999900001111` | **digital-dev** | 1 | 743,94 | 9,37 | **sí (no-prod)** |
| **Total estable Palanca 1** | | **18** | **15 358,35** | **4 813,47** | — |

> Reconcilia exactamente con la Evidencia B de la Palanca 1 (`palanca-01-ec2.md`): 18 recursos
> estables, base direccionable `$4 813,47`.

### Regla de disyunción aplicada y reconciliación

- De los **18** recursos estables comprometidos por la Palanca 1, **uno solo** reside en una cuenta
  no-prod: `digital-dev` (`999900001111`), 1 recurso, **743,94 h / $9,37**.
- Las cuentas no-prod con cómputo EC2 `on_demand` —`eks-dev`, `eks-uat`, `data-dev`— **no tienen
  ningún** recurso estable (≥ 669,6 h): su on-demand es **100 % intermitente/ráfaga**, exactamente
  la porción que la Palanca 1 enruta a la Palanca 10. Son, por construcción, **disjuntas** de la
  base de compromiso de la Palanca 1.
- Para preservar la disyunción (Req 8.8), el recurso estable de `digital-dev` (743,94 h / $9,37)
  **permanece en la Palanca 1** y se **excluye** de la base direccionable de la Palanca 10.

**Base direccionable de scheduling de la Palanca 10 (no-prod `on_demand`, DISJUNTA de la Palanca 1):**

```
  3 026,02 h / $538,35   (eks-dev   on_demand — 0 recursos estables)
+ 1 052,54 h / $225,70   (eks-uat   on_demand — 0 recursos estables)
+   241,39 h / $ 92,35   (data-dev  on_demand — 0 recursos estables)
- (excluido) 743,94 h / $9,37  (digital-dev estable → permanece en Palanca 1)
---------------------------------------------------------------
= 4 319,96 h / $856,39   (suma antes de redondear, half-up — Req 6.7)
                          (Σ de componentes ya redondeados = $856,40; artefacto de redondeo de 0,01 USD)
```

> Precisión completa: `3026.0208451229014 + 1052.5438750367002 + 241.39215449140008 =
> 4319.956874650002 h`; coste `538.3454259323998 + 225.6956825280003 + 92.35060824570003 =
> 856.3917167061001 USD` → **$856,39**.

**Reconciliación con la porción intermitente enrutada por la Palanca 1:** la Palanca 1 enrutó a la
Palanca 10 **$2 372,44** (2 363 recursos) de on-demand intermitente **a nivel organización**. La base
no-prod de scheduling de la Palanca 10 (**$856,39**) es un **subconjunto** de ese importe; el resto
(`$2 372,44 − $856,39 = $1 516,05`) corresponde a on-demand intermitente en cuentas **prod/compartidas**
(eks-prd, infra, iskaypet-data, SAP, retail-prod, clinicanimal, tooling). Ese remanente es elegible
para **Spot** (no para scheduling de no-prod) y se trata bajo la oportunidad de ampliación de Spot;
**no** se contabiliza ni en la base de compromiso de la Palanca 1 ni dos veces en la Palanca 10.

---

## Registros de evidencia (esquema del Catálogo_Evidencias)

| Campo | `EV-12.1-noprod-particion-compra` | `EV-12.1-spot-baseline` | `EV-12.1-disyuncion-palanca1` |
|-------|-----------------------------------|-------------------------|-------------------------------|
| `descripcion` | Cómputo EC2 no-prod por cuenta × opción (sp_covered/spot/on_demand), horas y coste | Uso actual de Spot a nivel org y no-prod (baseline + on-demand-equiv) | Disyunción de horas con la Palanca 1 (conjunto estable comprometido) |
| `consulta_cur` | Evidencia A (arriba) | Evidencia B (arriba) | Evidencia C (arriba) |
| `mes_referencia` | `2026-05` | `2026-05` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:44:52Z` | `2026-06-23T08:44:52Z` | `2026-06-23T08:44:52Z` |
| `version_dataset` | `frozen-2026-05@2026-06-23` | `frozen-2026-05@2026-06-23` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` | `USD` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` (agregado cuenta × opción) | `["no atribuible a recurso"]` (agregado cuenta × Spot) | `["no atribuible a recurso"]` (agregado de 18 recursos estables; detalle por recurso en Tarea 12.2) |
| `dimension_agregacion` | `line_item_usage_account_id` × `purchase_option`; medidas `SUM(usage_amount)`, `SUM(unblended_cost)`, `SUM(public_on_demand_cost)` | `line_item_usage_account_id` (filtro `%SpotUsage%`); mismas medidas | `line_item_resource_id` + `line_item_usage_account_id`, umbral estable ≥ 669,6 h |
| `verificacion_vivo` | `null` (se ejecuta en la Tarea 12.2) | `null` | `null` |
| `clasificacion` | base de cuantificación de la Palanca 10 (clasificación Estimado/rango en Tarea 12.3) | uso actual + oportunidad de Spot (Req 15.3) | control anti-doble-conteo (Property 7, Req 8.8) |

---

## Síntesis de la Tarea 12.1 (cifras congeladas)

| Concepto | Horas | Importe (USD) | Notas |
|----------|------:|--------------:|-------|
| Cómputo EC2 no-prod total | 18 320,74 | 3 417,29 | eks-dev + eks-uat + data-dev + digital-dev |
| → no-prod `sp_covered` (bajo compromiso) | 13 256,84 | 2 551,52 | territorio Palancas 1/2; **no** es base de scheduling incremental |
| → no-prod `on_demand` | 5 063,90 | 865,77 | de los cuales… |
| &nbsp;&nbsp;→ estable (digital-dev) → **permanece Palanca 1** | 743,94 | 9,37 | excluido de Palanca 10 (disyunción Req 8.8) |
| &nbsp;&nbsp;→ **base direccionable Palanca 10 (no-prod, disjunta)** | **4 319,96** | **856,39** | eks-dev + eks-uat + data-dev (100 % intermitente) |
| Uso actual de Spot (org) | 25,37 | 3,30 | una sola cuenta (tooling); **$0 en no-prod** |
| Oportunidad de Spot | — | (≈ todo el on-demand tolerante) | recorrido máximo desde base ≈ 0; cuantificación en 12.3 |

**Pendiente (siguientes sub-tareas, no parte de 12.1):**
- **Tarea 12.2** — `Verificacion_Recurso_Vivo` de solo lectura (`ec2 describe-instances` en cuentas
  no-prod: tags de entorno, perfil de uso, identificar 24/7); región `eu-west-1`.
- **Tarea 12.3** — declarar supuesto de horas reducidas y riesgo; excluir con motivo lo que deba
  estar 24/7 (QA compartido, jobs nocturnos, Req 15.2) y los workloads stateful/sin tolerancia a
  interrupción para Spot (Req 15.4); aplicar fórmula sobre la base disjunta `$856,39`; clasificar
  **Estimado** (rango); documentar campos Req 4; marcar **requiere Barrido_Utilizacion** (Req 18.1).
- **Tarea 16.3** — `Barrido_Utilizacion` de scheduling/Spot no-prod (perfil 24/7 vs intermitente,
  horas reducibles defendibles) antes de elevar a objetivo comprometido.

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23` el `2026-06-23T08:44:52Z`.
- `QueryExecutionId` retenidos: `db76fe8a-090f-4808-ac47-967e932456ae` (partición no-prod por
  cuenta × opción), `0a488303-6289-4622-b583-a1f5e35dbcff` (baseline Spot org) y
  `5c394e67-22d2-4955-ad5d-0707137c8cf4` (conjunto estable Palanca 1 — disyunción). Consulta de
  referencia cruzada con la formulación sin filtro de tipo del `design.md`:
  `e4352c30-1944-4e48-bd8b-1db73c854595` (documenta el doble conteo de horas SP que esta evidencia
  corrige).
- Cifras congeladas y reproducibles: re-ejecutar las consultas documentadas sobre el mismo
  Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría en
  Tarea 17.6). La base de Palanca 10 reconcilia con la partición estable/intermitente de la
  Palanca 1 sin solapes ni huecos (Req 8.8; auditoría en Tarea 17.4 / Property 7).


---

# Sub-registro — Tarea 12.2 — Verificacion_Recurso_Vivo (solo lectura)

> Artefacto auditable de la **Tarea 12.2**: confirmación contra los **recursos vivos** de las
> cuentas no productivas de los candidatos de cómputo EC2 derivados del CUR en la Tarea 12.1,
> mediante llamadas **exclusivamente de solo lectura** (`aws ec2 describe-instances`), sin ninguna
> operación mutante (Req 5.1). Se registran tags de entorno, perfil de uso y la identificación de
> los recursos que corren **24/7**, junto con cuenta, región consultada, estado y **fecha-hora en
> UTC** (Req 5.5, 15.1).
>
> **Validates: Requirements 5.1, 15.1**
>
> Este sub-registro NO modifica las cifras congeladas de la Tarea 12.1 (ancladas al
> `Dataset_Congelado` `frozen-2026-05@2026-06-23`). El drift del recurso vivo entre la extracción
> del CUR (Mes_Referencia `2026-05`) y esta verificación es **esperado** y no invalida las cifras
> ancladas (Req 7.6). La fórmula de ahorro, las exclusiones 24/7 y la clasificación se producen en
> la Tarea 12.3; el `Barrido_Utilizacion` en la Tarea 16.3.

## Parámetros de la verificación

| Campo | Valor |
|-------|-------|
| Fecha-hora de la verificación (UTC) | `2026-06-23T08:59:37Z` |
| Fecha-hora local (Europe/Madrid, CEST) | `2026-06-23T10:59:37+02:00` |
| Región consultada | `eu-west-1` |
| Operación | `aws ec2 describe-instances` (solo lectura — describe) |
| Credenciales | SSO IAM Identity Center, `sso_role_name = SRE` (rol `AWSReservedSSO_SRE_*`), por perfil de cuenta. **No se incrustan credenciales** (Req 7.5). |
| Operaciones mutantes ejecutadas | **ninguna** (Req 5.1) |
| Herramienta | `aws-cli/2.35.7` |

## Comando de solo lectura (re-ejecutable — Req 7.5)

Ejecutado una vez por cuenta, sustituyendo `<PERFIL>` por el perfil SSO de cada cuenta
(`eks-dev`, `eks-uat`, `data-dev`, `digital-dev`):

```bash
# Identidad (confirma cuenta y rol SRE asumido; sin secretos)
aws sts get-caller-identity --profile <PERFIL> --region eu-west-1 --output json

# Verificación de recurso vivo (solo lectura: describe-instances)
aws ec2 describe-instances --profile <PERFIL> --region eu-west-1 \
  --query 'Reservations[].Instances[].{Id:InstanceId,Type:InstanceType,State:State.Name,Launch:LaunchTime,Lifecycle:InstanceLifecycle,AZ:Placement.AvailabilityZone,Tags:Tags}' \
  --output json
```

> `InstanceLifecycle` distingue Spot (`spot`) de On-Demand (`null`). El tag `eks:nodegroup-name` +
> `aws:autoscaling:groupName` + `aws:ec2:fleet-id` identifican nodos de **nodegroups EKS
> gestionados** detrás de un Auto Scaling Group con cluster-autoscaler. Los tags
> `aws:elasticmapreduce:*` identifican nodos transitorios de **EMR**.

## Resultado de acceso por cuenta (Req 5.5)

| Cuenta (ID) | Perfil | Rol asumido (SSO) | Región | Estado de la verificación |
|-------------|--------|-------------------|--------|---------------------------|
| `111122223333` | eks-dev | `AWSReservedSSO_SRE_f6601b3081a0e196` | `eu-west-1` | **confirmado** (acceso de solo lectura OK) |
| `222233334444` | eks-uat | `AWSReservedSSO_SRE_20afb91acb0b98b5` | `eu-west-1` | **confirmado** (acceso de solo lectura OK) |
| `100200300400` | data-dev | `AWSReservedSSO_SRE_79847a112afd0bf2` | `eu-west-1` | **confirmado** (acceso de solo lectura OK) |
| `999900001111` | digital-dev | `AWSReservedSSO_SRE_133d920cd23a9d10` | `eu-west-1` | **confirmado** (acceso de solo lectura OK) |

> Las 4 cuentas no-prod con cómputo EC2 en la Tarea 12.1 fueron verificables con permisos de solo
> lectura. **Ningún** candidato queda "no verificable" por denegación de permisos (Req 5.4 no
> aplica en esta verificación).

## Hallazgo transversal — Spot en vivo = 0 (corrobora 12.1, Req 15.3)

Ninguna instancia viva en las 4 cuentas tiene `InstanceLifecycle = spot` ni tag de capacidad Spot
(`karpenter.sh/capacity-type`, `capacityType`): **todo el cómputo no-prod vivo es On-Demand**. Esto
corrobora contra el recurso vivo el hallazgo de la Tarea 12.1 (uso de Spot no-prod = `$0,00`, 0 h) y
confirma que la **oportunidad de ampliar Spot** parte de una base ≈ 0 (Req 15.3).

## Evidencia D — Inventario vivo y perfil de uso (eks-dev `111122223333`)

**`id_evidencia`:** `EV-12.2-eks-dev-vivo`
**Naturaleza:** 15 instancias descritas (14 `running` + 1 `terminated`); **todas On-Demand**
(`InstanceLifecycle=null`). Todas son **nodos de nodegroups EKS gestionados** del cluster `dp-dev`
(tags `eks:cluster-name`, `kubernetes.io/cluster/dp-dev`, `aws:autoscaling:groupName`,
`k8s.io/cluster-autoscaler/enabled`). No portan tag `environment` explícito; el **entorno no-prod**
queda determinado por el tag de cluster `kubernetes.io/cluster/dp-dev` (dev).

| Instancia | Tipo | Nodegroup (`eks:nodegroup-name`) | Lanzamiento (UTC) | Uptime aprox. | Perfil de uso |
|-----------|------|----------------------------------|-------------------|--------------:|---------------|
| `i-00b03f31ba8b8cbd3` | m6i.large | oms-dev | 2026-05-25T09:47 | ~29 d | **24/7 baseline** |
| `i-0242537d039da696b` | m6i.large | oms-dev | 2026-05-25T09:47 | ~29 d | **24/7 baseline** |
| `i-0a51a8eda83c17acb` | m7i.large | data-dev | 2026-05-25T09:20 | ~29 d | **24/7 baseline** |
| `i-00c6f1126b77945f1` | m7i.large | data-dev | 2026-05-25T09:20 | ~29 d | **24/7 baseline** |
| `i-0ff00bc8b7e31c2b4` | c7a.xlarge | infrastructure | 2026-05-25T09:21 | ~29 d | **24/7 baseline** |
| `i-03f23c3dbba15208a` | c7a.xlarge | infrastructure | 2026-05-25T09:21 | ~29 d | **24/7 baseline** |
| `i-0fa573e055aaa8f52` | m7i.xlarge | helios-dev | 2026-05-25T09:21 | ~29 d | **24/7 baseline** |
| `i-0902f8af017880e92` | m7i.xlarge | helios-dev | 2026-05-28T05:01 | ~26 d | **24/7 baseline** |
| `i-0d4d96ffc659077ba` | m7i.xlarge | digital-workers | 2026-06-17T06:56 | ~6 d | intermitente (scale-up) |
| `i-0dc63f68ee19c5c84` | m7i.xlarge | comerzzia-workers | 2026-06-19T08:48 | ~4 d | intermitente (scale-up) |
| `i-0ae01fef6f484ebff` | m7i.xlarge | comerzzia-workers | 2026-06-21T06:07 | ~2 d | intermitente (scale-up) |
| `i-07adbdc2c1dd6eb35` | m7i.xlarge | digital-workers | 2026-06-22T05:00 | ~1 d | intermitente (scale-up) |
| `i-01705bfee29f02fab` | m7i.xlarge | digital-workers | 2026-06-23T07:00 | ~2 h | churn autoscaler |
| `i-0a2bd76a6b3d3845d` | m7i.xlarge | comerzzia-workers | 2026-06-23T08:27 | <1 h | churn autoscaler |
| `i-04…` (1 inst.) | m7i.xlarge | — | — | — | `terminated` (no factura cómputo) |

**Perfil EKS:** 8 nodos baseline (oms-dev, data-dev, infrastructure, helios-dev) llevan ~26–29 días
**corriendo de forma continua** → **24/7** (Req 15.1). El resto (comerzzia-workers, digital-workers)
son nodos recientes que el cluster-autoscaler arranca/para según demanda → **intermitentes/ráfaga**.

## Evidencia E — Inventario vivo y perfil de uso (eks-uat `222233334444`)

**`id_evidencia`:** `EV-12.2-eks-uat-vivo`
**Naturaleza:** 7 instancias, todas `running` y **On-Demand**; nodos de nodegroups EKS gestionados
del cluster `dp-uat` (tags `kubernetes.io/cluster/dp-uat`).

| Instancia | Tipo | Nodegroup | Lanzamiento (UTC) | Uptime aprox. | Perfil de uso |
|-----------|------|-----------|-------------------|--------------:|---------------|
| `i-0dd9ab006add13d7a` | c6a.xlarge | digitalnodes | 2026-05-25T11:48 | ~29 d | **24/7 baseline** |
| `i-0856df179efa5b53e` | c6a.xlarge | digitalnodes | 2026-05-28T11:15 | ~26 d | **24/7 baseline** |
| `i-0123027d535753787` | m7i.xlarge | heliosuat | 2026-05-28T10:54 | ~26 d | **24/7 baseline** |
| `i-0f7f89e834d74331b` | m7i.xlarge | comerzzia-helios-uat | 2026-06-10T20:14 | ~12 d | 24/7 baseline (reciente) |
| `i-07e2a0c05649f4491` | m7i.xlarge | comerzzianodes | 2026-06-10T20:22 | ~12 d | 24/7 baseline (reciente) |
| `i-0f6f32a4571ac5e9e` | c6a.xlarge | digitalnodes | 2026-06-23T05:00 | ~4 h | churn autoscaler |
| `i-06ce4b2bc311d778b` | m7i.xlarge | comerzzianodes | 2026-06-23T05:00 | ~4 h | churn autoscaler |

**Perfil EKS:** 5 nodos baseline (digitalnodes, heliosuat, comerzzia-helios-uat, comerzzianodes) en
ejecución continua ≥ 12 días → **24/7**; 2 nodos lanzados hoy → churn de autoscaler.

## Evidencia F — Inventario vivo (data-dev `100200300400`) — EMR transitorio

**`id_evidencia`:** `EV-12.2-data-dev-vivo`
**Naturaleza:** 5 instancias, **todas `terminated`** en el momento de la verificación; **On-Demand**;
tipo `m7g.2xlarge` (Graviton). Tags `aws:elasticmapreduce:instance-group-role=TASK`,
`aws:elasticmapreduce:job-flow-id=j-3UYEU3WX14B7X`, `cluster_name=emr-medium-laura`,
**`environment=dev`** (único tag de entorno explícito de las 4 cuentas).

| Instancia | Tipo | Rol EMR | Lanzamiento (UTC) | Estado | Perfil de uso |
|-----------|------|---------|-------------------|--------|---------------|
| `i-0ad6fd5f1b6e1c0ca` | m7g.2xlarge | TASK | 2026-06-23T08:23:56 | terminated | **transitorio (job batch EMR)** |
| `i-016bcf8168209e50c` | m7g.2xlarge | TASK | 2026-06-23T08:24:29 | terminated | transitorio (job batch EMR) |
| `i-097b3428538fc0180` | m7g.2xlarge | TASK | 2026-06-23T08:24:29 | terminated | transitorio (job batch EMR) |
| `i-00cfc4258cabac663` | m7g.2xlarge | TASK | 2026-06-23T08:24:29 | terminated | transitorio (job batch EMR) |
| `i-01ffb9b76034810cd` | m7g.2xlarge | TASK | 2026-06-23T08:24:30 | terminated | transitorio (job batch EMR) |

**Perfil:** nodos **TASK** de un cluster EMR (`emr-medium-laura`), lanzados y terminados el mismo día
en cuestión de minutos → cómputo **intermitente/ráfaga**, **no 24/7**. Confirma en vivo el hallazgo de
12.1 (el on-demand de data-dev es 100% intermitente). Los nodos EMR TASK son el caso de uso
**canónico de Spot** (tolerantes a interrupción) → candidatos directos para la oportunidad de Spot de
la Palanca 10 (la confirmación de tolerancia a interrupción y la exclusión de stateful se documentan
en la Tarea 12.3).

## Evidencia G — Inventario vivo (digital-dev `999900001111`)

**`id_evidencia`:** `EV-12.2-digital-dev-vivo`
**Naturaleza:** 1 instancia `stopped`, On-Demand, `t2.micro`, `Name=testeando`, lanzada
`2024-12-26T11:47:54Z`, AZ `eu-west-1b`. Sin tags de entorno ni de EKS/EMR.

| Instancia | Tipo | Name | Lanzamiento (UTC) | Estado | Perfil de uso |
|-----------|------|------|-------------------|--------|---------------|
| `i-0d4b98e283cf4cc16` | t2.micro | testeando | 2024-12-26T11:47:54 | stopped | caja de prueba parada (sin cómputo) |

**Perfil:** instancia de prueba **parada** (no factura horas de cómputo, solo EBS si tuviera).
**No es** el recurso estable de 743,94 h que la Tarea 12.1 atribuyó a `digital-dev` y mantuvo en la
Palanca 1 — ese cómputo on-demand estable **no aparece como instancia EC2 viva** en esta
verificación (drift esperado entre el Mes_Referencia `2026-05` y la fecha de verificación, Req 7.6;
probablemente cargas ya retiradas o de naturaleza no-EC2-clásica). Coherente con la regla de
disyunción de 12.1: ese recurso permanece en la Palanca 1 y se excluye de la base de la Palanca 10.

## Identificación de recursos 24/7 (Req 15.1)

| Cuenta | Recursos 24/7 confirmados en vivo | Naturaleza |
|--------|-----------------------------------|------------|
| `111122223333` eks-dev | 8 nodos baseline (oms-dev ×2, data-dev ×2, infrastructure ×2, helios-dev ×2) | nodegroups EKS gestionados, uptime ~26–29 d |
| `222233334444` eks-uat | 5 nodos baseline (digitalnodes ×2, heliosuat, comerzzia-helios-uat, comerzzianodes) | nodegroups EKS gestionados, uptime ≥ 12 d |
| `100200300400` data-dev | 0 (todo transitorio EMR) | nodos TASK efímeros |
| `999900001111` digital-dev | 0 (instancia parada) | caja de prueba `stopped` |

> **Matiz clave (reconcilia 12.1 ↔ 12.2):** los nodos baseline de EKS corren **24/7 a nivel de
> nodegroup**, pero a **nivel de `line_item_resource_id`** son instancias de vida corta que el
> autoscaler recicla (los `InstanceId` rotan), por lo que **ninguna** alcanza el umbral estable de
> ≥ 669,6 h/mes de la Palanca 1 — exactamente por eso la Tarea 12.1 clasificó el 100% del on-demand
> no-prod de eks-dev/eks-uat/data-dev como **intermitente** y lo enrutó a la Palanca 10. La
> verificación viva confirma esa lectura: el **scheduling** de la Palanca 10 actúa sobre la
> **capacidad baseline de los nodegroups** (reducir/parar fuera de horario), no sobre instancias
> individuales persistentes.

## Registros de evidencia (esquema del Catálogo_Evidencias)

| Campo | `EV-12.2-eks-dev-vivo` | `EV-12.2-eks-uat-vivo` | `EV-12.2-data-dev-vivo` | `EV-12.2-digital-dev-vivo` |
|-------|------------------------|------------------------|-------------------------|----------------------------|
| `descripcion` | Inventario EC2 vivo eks-dev: 14 nodos EKS running On-Demand, 8 baseline 24/7 | Inventario EC2 vivo eks-uat: 7 nodos EKS running On-Demand, 5 baseline 24/7 | Inventario EC2 vivo data-dev: 5 nodos EMR TASK terminated (transitorio) | Inventario EC2 vivo digital-dev: 1 t2.micro stopped |
| `verificacion_vivo` | `aws ec2 describe-instances` (solo lectura) | `aws ec2 describe-instances` (solo lectura) | `aws ec2 describe-instances` (solo lectura) | `aws ec2 describe-instances` (solo lectura) |
| `cuenta` | `111122223333` | `222233334444` | `100200300400` | `999900001111` |
| `region` | `eu-west-1` | `eu-west-1` | `eu-west-1` | `eu-west-1` |
| `fecha_hora_utc` | `2026-06-23T08:59:37Z` | `2026-06-23T08:59:37Z` | `2026-06-23T08:59:37Z` | `2026-06-23T08:59:37Z` |
| `estado` | **confirmado** | **confirmado** | **confirmado** | **confirmado** |
| `lifecycle` | On-Demand (Spot=0) | On-Demand (Spot=0) | On-Demand (Spot=0) | On-Demand (Spot=0) |
| `recursos_24_7` | 8 (nodos baseline EKS) | 5 (nodos baseline EKS) | 0 (EMR transitorio) | 0 (stopped) |
| `tag_entorno` | implícito `kubernetes.io/cluster/dp-dev` | implícito `kubernetes.io/cluster/dp-uat` | explícito `environment=dev` | sin tag de entorno |
| `clasificacion` | base de scheduling 24/7 (no-prod) | base de scheduling 24/7 (no-prod) | candidato Spot (EMR TASK, tolerante a interrupción) | excluido (parado, sin cómputo) |

## Síntesis de la Tarea 12.2

- **4/4 cuentas no-prod verificadas** con solo lectura (`describe-instances`), región `eu-west-1`,
  el `2026-06-23T08:59:37Z` (UTC). Sin operaciones mutantes (Req 5.1). Estado: **confirmado** en las
  cuatro; ningún candidato "no verificable".
- **Spot vivo = 0** en todas las cuentas (todo On-Demand) → corrobora 12.1 y la oportunidad de Spot
  desde base ≈ 0 (Req 15.3).
- **Recursos 24/7 identificados (Req 15.1):** 8 nodos baseline en eks-dev + 5 en eks-uat (capacidad
  continua de nodegroups EKS gestionados). data-dev = EMR TASK transitorio (no 24/7, candidato Spot).
  digital-dev = caja de prueba parada (excluida).
- **Reconciliación 12.1:** la disyunción de horas se mantiene; la base de scheduling de la Palanca 10
  actúa sobre la capacidad baseline de los nodegroups no-prod, no sobre `resource_id` individuales.

### Pendiente (Tarea 12.3, no parte de 12.2)
- Declarar supuesto de horas reducidas y riesgo; **excluir con motivo** lo que deba estar 24/7 (QA
  compartido, jobs nocturnos — Req 15.2) y los workloads stateful/sin tolerancia a interrupción para
  Spot (Req 15.4); aplicar fórmula sobre la base disjunta **$856,39**; clasificar **Estimado**
  (rango); documentar campos Req 4; marcar **requiere Barrido_Utilizacion** (Req 18.1).

## Estado de ejecución (Tarea 12.2)

- ✅ **Ejecutado** el `2026-06-23T08:59:37Z` (UTC). Verificación de solo lectura sobre recursos vivos
  en `eu-west-1` para las cuentas `111122223333`, `222233334444`, `100200300400`, `999900001111`.
- Comando re-ejecutable documentado arriba (Req 7.5), referenciando el rol SSO `SRE` por nombre, sin
  incrustar credenciales. El drift del recurso vivo respecto al Mes_Referencia `2026-05` es esperado
  (Req 7.6) y no altera las cifras congeladas de la Tarea 12.1.


---

# Sub-registro — Tarea 12.3 — Fórmula, clasificación y documentación de la Palanca 10

> Artefacto auditable de la **Tarea 12.3**: aplicación de la **fórmula de ahorro** sobre la base
> direccionable **disjunta** congelada en la Tarea 12.1 (`$856,39/mes`), declarando el **supuesto de
> horas reducidas** y el **riesgo**, **excluyendo con motivo** lo que debe permanecer 24/7 (QA
> compartido, jobs nocturnos — Req 15.2) y los workloads **stateful / sin tolerancia a interrupción**
> de la oportunidad de Spot (Req 15.4), **declarando la tolerancia a interrupción requerida**
> (Req 15.3), clasificando la Palanca como **Ahorro_Estimado** (rango Conservador–Agresivo,
> invariante `0 < Cons ≤ Agr`; mensual + anualizado ×12 con advertencia de estacionalidad),
> documentando los **campos del Req 4** (owner "pendiente") y marcándola como **requiere
> Barrido_Utilizacion** (Req 18.1).
>
> **Validates: Requirements 15.2, 15.4, 15.5, 15.6, 3.3, 4.1, 4.4, 4.5, 4.6, 4.7, 6.1, 18.1**
>
> Cifra **derivada** (no introduce consulta CUR nueva): se construye sobre las cifras ya congeladas
> en la Tarea 12.1 (`Dataset_Congelado` `frozen-2026-05@2026-06-23`) y la `Verificacion_Recurso_Vivo`
> de la Tarea 12.2. El `Barrido_Utilizacion` (horas reducibles defendibles por perfil real) se ejecuta
> en la Tarea 16.3; hasta entonces el ahorro se presenta **solo como rango estimado**, nunca como
> objetivo comprometido (Req 18.2).

## Descomposición de la base direccionable en Sub_Palancas (Req 3.4)

La base disjunta de la Palanca 10 (`$856,39/mes`, no-prod `on_demand` intermitente, DISJUNTA de la
Palanca 1) se divide en **dos Sub_Palancas** según la **acción de optimización** aplicable, guiadas
por el perfil de uso verificado en vivo en la Tarea 12.2:

| Sub_Palanca | Acción | Base afectada (USD/mes) | Cuentas / perfil (Tarea 12.2) |
|-------------|--------|------------------------:|-------------------------------|
| **10a — Scheduling no-prod** | Apagar/escalar a 0 la capacidad baseline de nodegroups EKS dev/uat fuera de horario | **764,05** | `eks-dev` (538,35) + `eks-uat` (225,70) — 8 + 5 nodos baseline de nodegroups gestionados |
| **10b — Spot (EMR TASK)** | Mover cómputo tolerante a interrupción a capacidad Spot | **92,35** | `data-dev` (92,35) — nodos **EMR TASK** transitorios (`emr-medium-laura`, `environment=dev`) |
| **Total Palanca 10** | | **856,39** | suma antes de redondear `764,0411084604 + 92,3506082457 = 856,3917167061` → **$856,39** |

> **Por qué esta partición y no scheduling sobre todo:** los nodos de `data-dev` son **EMR TASK
> efímeros** (lanzados y terminados en minutos, Tarea 12.2 Evidencia F) — el scheduling off-hours
> **no aplica** a un job batch que ya es de vida corta; su palanca natural es **Spot** (caso
> canónico tolerante a interrupción). A la inversa, la capacidad **baseline 24/7** de los nodegroups
> de `eks-dev`/`eks-uat` (que el autoscaler mantiene encendida con instancias rotatorias) es el
> objeto del **scheduling**, no de Spot (son servicios dev/uat de larga vida, no batch tolerante).

## Sub_Palanca 10a — Scheduling no-prod

### Supuesto de horas reducidas y riesgo (Req 15.5)

- **Ventana de actividad supuesta:** los entornos no productivos (dev/uat) se usan en **horario
  laboral**. Una ventana laboral ampliada de **L–V 08:00–20:00** (12 h × 5 d = **60 h/semana**)
  sobre las **168 h/semana** totales implica un **uptime ≈ 35,7 %** → **reducción potencial máxima
  ≈ 64,3 %** de las horas de la capacidad schedulable.
- **Riesgo asociado (Req 15.5, 4.4):** **medio** — apagar capacidad baseline puede afectar a
  pruebas de QA fuera de horario, pipelines de CI/CD nocturnos y validaciones de despliegue; mitigable
  con calendarios configurables y exclusiones por nodegroup (abajo). El riesgo de capacidad es real
  pero acotado (entornos no productivos, sin impacto a clientes).
- **Naturaleza del ahorro:** **scheduling ⇒ ahorro recurrente** mientras la capacidad permanezca
  apagada; NO es un compromiso de captura progresiva (Req 6.5 no aplica), por lo que el anualizado es
  el mensual ×12 directo (con la advertencia de estacionalidad del Req 6.4).

### Exclusiones con motivo — debe permanecer 24/7 (Req 15.2)

Se **excluyen del ahorro por scheduling** (y por eso el `Rango_Conservador` no asume apagar todo el
parque) los siguientes perfiles, con su motivo registrado:

| Excluido del scheduling | Cuenta / nodegroup | Motivo (Req 15.2) |
|-------------------------|--------------------|-------------------|
| Entornos de **QA compartidos** | `eks-uat` (`digitalnodes`, `comerzzianodes`, `heliosuat`, `comerzzia-helios-uat`) | UAT es entorno de **validación compartida** entre squads y QA; debe estar disponible fuera de horario para pruebas de aceptación, demos y validaciones de release → no se apaga sistemáticamente |
| **Jobs nocturnos programados** | `eks-dev` (`data-dev`, `infrastructure` baseline) | Pipelines de datos / tareas batch y de plataforma que corren de noche por diseño; apagarlos perdería su ventana de ejecución → permanecen 24/7 |
| Capacidad **baseline mínima de plataforma** | `eks-dev`/`eks-uat` nodegroup `infrastructure` | Componentes de cluster (ingress, observabilidad, controllers) que deben sobrevivir al apagado de cargas de aplicación |

> Estas exclusiones **no se restan numéricamente** de la base congelada (que permanece `$764,05`,
> anclada al `Dataset_Congelado`): se reflejan como **menor fracción schedulable** en el
> `Rango_Conservador` y se **confirmarán/ajustarán** en el `Barrido_Utilizacion` (Tarea 16.3), que
> determinará qué nodegroups concretos son apagables y durante qué horas.

### Fórmula y rango (Req 3.3, 6.1)

`Ahorro_scheduling = base_afectada × % reducción de horas`. Base afectada = **$764,05/mes**
(precisión completa `764,0411084604`).

| Escenario | Supuesto de reducción (% horas) | Justificación |
|-----------|:-------------------------------:|---------------|
| **Rango_Conservador** | **30,0 %** | Scheduling **parcial**: solo `eks-dev` (cargas de aplicación dev), solo noches en días laborables, preservando UAT compartido, jobs nocturnos y baseline de plataforma (exclusiones Req 15.2) |
| **Rango_Agresivo** | **65,0 %** | Scheduling **off-hours completo** (noches + fines de semana) sobre la mayor parte de dev/uat, ≈ uptime laboral 35,7 % → reducción ≈ 64,3 % (redondeado a 65,0 %) |

## Sub_Palanca 10b — Spot (EMR TASK no-prod)

### Tolerancia a interrupción requerida (Req 15.3) y supuesto

- **Tolerancia a interrupción declarada (Req 15.3):** Spot exige que el workload **tolere la
  recuperación/terminación de capacidad con aviso de 2 minutos**. Los **nodos EMR TASK** de
  `data-dev` (`emr-medium-laura`) son el caso **canónico**: EMR re-planifica las tareas perdidas de
  un nodo TASK interrumpido sin pérdida de datos (los TASK no almacenan HDFS), por lo que **toleran
  interrupción por diseño** → elegibles para Spot.
- **Descuento Spot supuesto (Req 4.1, 4.3):** **≈ 50 %** sobre on-demand. Origen: **precio público
  AWS** corroborado **en los propios datos** del estudio — la Tarea 12.1 (Evidencia B) observó el
  único uso de Spot vivo de la org a `$3,30` unblended frente a `$6,56` on-demand-equiv (descuento
  ≈ 50 %); fecha del dato `2026-06-23`.

### Exclusiones con motivo — stateful / sin tolerancia a interrupción (Req 15.4)

| Excluido de Spot | Motivo (Req 15.4) |
|------------------|-------------------|
| **EMR MASTER / CORE** (si los hubiera) | El MASTER coordina el cluster y los CORE alojan HDFS → su pérdida **mata el job**; solo los **TASK** son Spot-elegibles |
| Cargas **stateful** dev/uat (bases de datos, brokers, PV con estado) | No toleran reemplazo abrupto de nodo → fuera de la oportunidad de Spot |
| Servicios **sin tolerancia a interrupción** (sesiones largas, pruebas E2E en curso) | Una interrupción invalidaría la prueba/sesión → excluidos |
| `digital-dev` instancia `i-0d4b98e283cf4cc16` (`testeando`, `stopped`) | **Parada**, no factura cómputo (Tarea 12.2 Evidencia G) → sin base de ahorro |

### Fórmula y rango (Req 3.3, 6.1)

`Ahorro_spot = base_afectada × (% capacidad movida a Spot) × (descuento Spot)`.
Base afectada = **$92,35/mes** (precisión `92,3506082457`); descuento Spot = 50,0 %.

| Escenario | % capacidad TASK a Spot | Reducción efectiva sobre base | Justificación |
|-----------|:-----------------------:|:-----------------------------:|---------------|
| **Rango_Conservador** | 50,0 % | **25,0 %** (`0,50 × 0,50`) | Mezcla Spot/on-demand para absorber escasez de capacidad Spot y garantizar finalización de jobs |
| **Rango_Agresivo** | 100,0 % | **50,0 %** (`1,00 × 0,50`) | Toda la capacidad TASK en Spot (instance fleets EMR con diversificación de tipos) |

## Cálculo del ahorro — mensual + anualizado ×12 (Req 6.1, 6.2, 6.3, 6.7)

Calculado sobre las bases **sin redondear**; el total se suma antes de redondear half-up a 2
decimales (Req 6.7).

| Sub_Palanca | Base (USD/mes) | Conservador (USD/mes) | Agresivo (USD/mes) |
|-------------|---------------:|----------------------:|-------------------:|
| 10a Scheduling | 764,05 | `764,0411 × 0,300 =` **229,21** | `764,0411 × 0,650 =` **496,63** |
| 10b Spot (EMR TASK) | 92,35 | `92,3506 × 0,250 =` **23,09** | `92,3506 × 0,500 =` **46,18** |
| **Total Palanca 10** | **856,39** | **252,30** | **542,80** |

> Total antes de redondear (Req 6.7): Conservador `229,21233253812 + 23,0876520614 = 252,29998459952`
> → **$252,30**; Agresivo `496,62672049926 + 46,17530412285 = 542,80202462211` → **$542,80**.
> La suma de los componentes ya redondeados del Agresivo da `496,63 + 46,18 = 542,81` (artefacto de
> redondeo de `0,01 USD`); el valor canónico publicado es el sumado-antes-de-redondear **$542,80**.

### Rango del Ahorro_Estimado — mensual y anualizado (Req 3.3, 6.1, 6.2, 6.3)

| Base | Rango_Conservador | Rango_Agresivo | Invariante `0 < Cons ≤ Agr` |
|------|------------------:|---------------:|:---------------------------:|
| **Mensual** | **252,30 USD** | **542,80 USD** | `0 < 252,30 ≤ 542,80` ✓ |
| **Anualizado ×12** | **3 027,60 USD** | **6 513,62 USD** | `0 < 3 027,60 ≤ 6 513,62` ✓ |

> Derivación anual (sobre el mensual sin redondear, Req 6.3, 6.7): Conservador
> `252,29998459952 × 12 = 3 027,5998151942` → **$3 027,60**; Agresivo
> `542,80202462211 × 12 = 6 513,6242954653` → **$6 513,62**.
>
> ⚠️ **Advertencia de anualización (Req 6.4):** las cifras anuales son el ahorro **mensual del
> Mes_Referencia (mayo 2026) multiplicado por 12**. El método **asume que mayo 2026 es
> representativo** y **no captura estacionalidad** (p. ej. picos de jobs EMR de Data, campañas que
> alteran el uso de dev/uat, semanas de release). Es un objetivo en régimen estacionario, no una
> proyección con estacionalidad.

## Documentación de la Palanca — campos del Req 4

| Campo (Req 4) | Valor |
|---------------|-------|
| **Supuesto de reducción/descuento (4.1)** | 10a Scheduling: reducción de horas **30,0 % – 65,0 %**. 10b Spot: descuento **50,0 %** × capacidad movida 50,0 %–100,0 % ⇒ reducción efectiva **25,0 % – 50,0 %** |
| **% direccionable + base mensual afectada (4.2)** | **98,9 %** del cómputo no-prod `on_demand` (`856,39 / 865,77`; el `1,1 %` restante = recurso estable de `digital-dev` `$9,37` que permanece en la Palanca 1 por disyunción Req 8.8). Base mensual afectada = **$856,39** (10a `$764,05` + 10b `$92,35`) |
| **Origen del supuesto + fecha (4.3)** | **Precio público AWS** — descuento Spot ≈ 50 % corroborado con el uso Spot vivo observado en la Tarea 12.1 (`$3,30` vs `$6,56` on-demand-equiv); matemática de scheduling sobre ventana laboral estándar. Fecha del dato: **2026-06-23** |
| **Riesgo (4.4)** | **medio** — scheduling puede afectar QA fuera de horario / CI nocturno (mitigado con calendarios y exclusiones); Spot introduce interrupciones (acotadas a EMR TASK tolerante). Sin impacto a producción/clientes |
| **Esfuerzo (4.5)** | **medio** — 10a: automatizar apagado/escalado a 0 por nodegroup (cron/KEDA/scheduled scaling) + validar exclusiones; 10b: configurar EMR **instance fleets** con capacidad Spot diversificada |
| **Owner (4.6, 4.7)** | **pendiente** — Palanca **transversal**: **SRE** (plataforma/scheduling de nodegroups) + squads dueños de las cargas no-prod (**Digital**, **Helios**, **Comerzzia** para `eks-dev`/`eks-uat`; **Data** para EMR `data-dev`). Correo del responsable concreto: **pendiente** |

## Clasificación (Req 15.6, 3.1, 3.3) y marca de Barrido (Req 18.1)

- **Clasificación: `Ahorro_Estimado`** — **siempre** (Req 15.6). El ahorro por scheduling y Spot
  depende de supuestos de horas reducibles y de capacidad Spot disponible; no es desperdicio puro
  eliminable sin pérdida de capacidad. Se expresa **siempre como rango** Conservador–Agresivo
  (Req 3.3), nunca como cifra única.
- **Requiere `Barrido_Utilizacion` (Req 18.1):** ✅ **SÍ**. Antes de elevar esta Palanca a objetivo
  comprometido, la Tarea **16.3** debe ejecutar el barrido que determine, por nodegroup y perfil real
  de uso, **qué horas son defendiblemente reducibles** (24/7 vs intermitente, calendario de QA y de
  jobs nocturnos) y **qué fracción de la capacidad EMR TASK** tolera Spot de forma estable. Hasta
  completarse, el ahorro se presenta **solo como rango estimado** (Req 18.2), no como objetivo
  comprometido.

## Registro de evidencia (esquema del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-12.3-palanca10-estimado` |
| `cifra_publicada` | Ahorro_Estimado Palanca 10: **mensual 252,30 – 542,80 USD**; **anualizado ×12 3 027,60 – 6 513,62 USD**. Sub_Palancas: 10a scheduling (base $764,05; 30,0 %–65,0 %), 10b Spot EMR TASK (base $92,35; 25,0 %–50,0 % efectivo) |
| `descripcion` | Aplicación de la fórmula de ahorro por scheduling no-prod (eks-dev/eks-uat) y por Spot (EMR TASK data-dev) sobre la base disjunta de la Palanca 10; exclusiones 24/7 (QA compartido, jobs nocturnos, baseline plataforma) y stateful/sin tolerancia a interrupción; clasificación Estimado (rango), documentación Req 4 y marca de Barrido_Utilizacion |
| `consulta_cur` | **No aplica** — cifra **derivada** de las cifras congeladas en la Tarea 12.1 (`QueryExecutionId` `db76fe8a-090f-4808-ac47-967e932456ae` partición no-prod por cuenta × opción; `0a488303-6289-4622-b583-a1f5e35dbcff` baseline Spot org) y de la `Verificacion_Recurso_Vivo` de la Tarea 12.2 (`EV-12.2-*`). No introduce consulta CUR nueva |
| `recurso_ids` | `["no atribuible a recurso"]` — derivación agregada por cuenta × opción de compra (base scheduling: `eks-dev`+`eks-uat` on_demand; base Spot: `data-dev` EMR TASK). Detalle vivo por instancia en `EV-12.2-eks-dev-vivo`, `EV-12.2-eks-uat-vivo`, `EV-12.2-data-dev-vivo` |
| `dimension_agregacion` | Derivación sobre `line_item_usage_account_id` × `purchase_option` (Tarea 12.1); transformación = supuestos de reducción de horas (scheduling 30,0 %–65,0 %) y descuento Spot (50,0 %) × % capacidad movida (50,0 %–100,0 %) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:44:52Z` (base congelada Tarea 12.1) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `verificacion_vivo` | `confirmado` (Tarea 12.2, `2026-06-23T08:59:37Z`, `eu-west-1`): Spot vivo = 0; 8 nodos baseline 24/7 en eks-dev + 5 en eks-uat; data-dev = EMR TASK transitorio tolerante a interrupción |
| `clasificacion` | **Ahorro_Estimado** (Req 15.6); rango Conservador–Agresivo (invariante `0 < Cons ≤ Agr` ✓); **requiere Barrido_Utilizacion** (Req 18.1; Tarea 16.3) |
| `supuesto_descuento` | Scheduling: reducción horas 30,0 %–65,0 %. Spot: descuento 50,0 % × capacidad 50,0 %–100,0 % (origen precio público AWS, `2026-06-23`) |
| `porcentaje_direccionable` | 98,9 % del cómputo no-prod `on_demand` (base afectada $856,39) |
| `riesgo` | medio · `esfuerzo` medio · `owner` **pendiente** (transversal: SRE + Digital/Helios/Comerzzia/Data) |

## Síntesis de la Tarea 12.3

- ✅ **Fórmula aplicada** sobre la base disjunta congelada `$856,39/mes`, dividida en **Sub_Palanca
  10a Scheduling** (`$764,05`, eks-dev+eks-uat) y **Sub_Palanca 10b Spot** (`$92,35`, EMR TASK
  data-dev), guiada por el perfil de uso verificado en vivo (Tarea 12.2).
- ✅ **Supuesto de horas reducidas y riesgo declarados** (Req 15.5): ventana laboral L–V 08:00–20:00
  (uptime ≈ 35,7 %), riesgo medio.
- ✅ **Exclusiones con motivo registradas**: 24/7 obligado (QA compartido en UAT, jobs nocturnos,
  baseline de plataforma — Req 15.2) y stateful/sin tolerancia a interrupción para Spot (EMR
  MASTER/CORE, stateful, sesiones largas, caja parada de digital-dev — Req 15.4).
- ✅ **Tolerancia a interrupción declarada** (Req 15.3): EMR TASK tolera reemplazo de nodo por diseño.
- ✅ **Clasificada `Ahorro_Estimado`** (Req 15.6) con rango Conservador–Agresivo (invariante
  `0 < Cons ≤ Agr` ✓), **mensual** (`252,30 – 542,80 USD`) y **anualizado ×12** (`3 027,60 –
  6 513,62 USD`) con advertencia de estacionalidad (Req 3.3, 6.1, 6.3, 6.4).
- ✅ **Documentación Req 4** completa; **owner "pendiente"** (transversal SRE + squads).
- ✅ **Marcada `requiere Barrido_Utilizacion`** (Req 18.1) → Tarea 16.3; hasta entonces, solo rango
  estimado, no objetivo comprometido (Req 18.2).
- **Trazabilidad:** cifra **derivada** de las cifras congeladas de la Tarea 12.1 y la verificación en
  vivo de la Tarea 12.2; correspondencia 1-a-1 en el Catálogo_Evidencias (`EV-12.3-palanca10-estimado`).

## Estado de ejecución (Tarea 12.3)

- ✅ **Completada.** Fórmula, clasificación (Estimado, rango) y documentación Req 4 derivadas sobre el
  `Dataset_Congelado` `frozen-2026-05@2026-06-23`. No introduce consulta CUR nueva (derivación de
  12.1/12.2), por lo que la reproducibilidad recae en las consultas ya retenidas de la Tarea 12.1.
- ⏭️ **Pendiente Tarea 16.3** — `Barrido_Utilizacion` de scheduling/Spot no-prod: confirmar por
  nodegroup y perfil real las horas reducibles defendibles y la fracción de EMR TASK que tolera Spot
  de forma estable, antes de elevar la Palanca 10 a objetivo comprometido.
