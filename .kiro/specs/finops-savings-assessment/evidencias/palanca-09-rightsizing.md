# Registro Palanca 9 — Rightsizing y Graviton por utilización real — Tarea 11.1

> Artefacto auditable de la **Tarea 11.1**: consulta del CUR por `line_item_resource_id` +
> `product_instance_type` + horas (744 h = 24/7) + coste, para **identificar candidatos** a
> rightsizing y a Graviton (con familia y perfil de uso) y **congelar** coste/horas/tipo desde el
> CUR. Cifras congeladas contra el `Dataset_Congelado` y reproducibles re-ejecutando las consultas
> documentadas.
>
> **Validates: Requirements 13.3, 2.2, 2.3**
>
> Este fichero es el artefacto PROPIO de la Tarea 11.1 (no se toca `catalogo-evidencias.md`, el
> catálogo compartido de la Fundación). **Alcance de 11.1:** identificar candidatos y congelar
> coste/horas/tipo desde el CUR. El **rightsizing por p95 real (Grafana/VPA)**, la lectura de
> utilización en vivo (`ec2 describe-instances`) y la **clasificación final (Estimado, rango)** se
> producen en las Tareas **11.2** y **11.3** — aquí NO se propone recorte ni se fija ahorro.

## Parámetros de anclaje (Req 2.1, 2.5)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23T08:32:02Z` (UTC) · `2026-06-23T10:32:02+02:00` (Europe/Madrid, CEST) |
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

> Nota de horas: el Mes_Referencia (mayo 2026) tiene 31 días = **744 horas**. Un recurso con horas
> de uso `≈ 744` corre **24/7** durante todo el mes; es el perfil que prioriza la identificación de
> candidatos (Req 13: rightsizing y Graviton sobre carga sostenida). El umbral operativo de "24/7"
> usado aquí es `≥ 743 h` (≈ 99,9 % del mes) para absorber redondeos de prorrateo del CUR.

---

## Evidencia A — Consulta canónica del `design.md` (partición por recurso × tipo de instancia)

**`id_evidencia`:** `EV-11.1-ec2-boxusage-canonica`
**Clasificación del registro:** `no atribuible a recurso` a nivel agregado — partición por
`line_item_resource_id` + `product_instance_type` (Req 2.3); el detalle por recurso lleva su
identificador explícito de instancia (Req 2.2).
**Dimensión de agregación (Req 2.3):** `(line_item_resource_id, product_instance_type)`; medidas
`SUM(line_item_usage_amount)` (horas) y `SUM(line_item_unblended_cost)` (coste).

### Consulta CUR exacta (re-ejecutable) — consulta canónica del `design.md`

```sql
SELECT line_item_resource_id AS resource,
       product_instance_type AS instance_type,
       SUM(line_item_usage_amount) AS hours,
       SUM(line_item_unblended_cost) AS cost,
       COUNT(*) AS line_items
FROM data
WHERE line_item_product_code = 'AmazonEC2'
  AND line_item_usage_type LIKE '%BoxUsage%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2
ORDER BY cost DESC;
```

Ejecución:

```bash
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "<consulta de arriba, en una sola línea>" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

- `QueryExecutionId`: `bb24f724-b320-4f89-8769-115c3aca52cd`
- Estado: `SUCCEEDED` · Datos escaneados: `10 275 359` bytes · Filas devueltas: `6 321`

### Hallazgo metodológico — la cifra `cost` neta de esta consulta está distorsionada por Savings Plans

La consulta canónica **no filtra** `line_item_line_item_type`, de modo que `%BoxUsage%` mezcla
cuatro tipos de línea cuya suma de `line_item_unblended_cost` **neta** las coberturas de Savings
Plans y los descuentos, produciendo filas con `resource_id` vacío y costes negativos que **no son
atribuibles a una instancia** (p. ej. `SavingsPlanNegation` aparece como una fila de
`resource_id` en blanco con `−8 573,70 USD` agregados). Composición (Evidencia B):

| `line_item_line_item_type` | Líneas | Horas | Unblended (USD) | On-demand equiv (USD) |
|----------------------------|-------:|------:|----------------:|----------------------:|
| `SavingsPlanCoveredUsage` | 7 016 | 41 151,216 | 7 998,83 | 7 998,83 |
| `Usage` (on-demand puro) | 6 455 | 24 959,242 | 7 185,92 | 7 185,92 |
| `SppDiscount` | 1 404 | 0,0 | −574,87 | 0,0 |
| `SavingsPlanNegation` | 993 | 41 151,216 | −7 998,83 | 0,0 |
| **Total `BoxUsage` neto** | **15 868** | — | **6 611,04** | **15 184,75** |

> El `6 611,04 USD` neto de la consulta canónica **no** representa el coste de la flota de cómputo
> EC2: es el neto tras restar la cobertura de Savings Plans (negación) y el descuento SPP. Para
> **identificar y dimensionar candidatos** de rightsizing/Graviton, la base económica correcta es
> el **equivalente on-demand** (`pricing_public_on_demand_cost`) de las horas realmente ejecutadas
> = **15 184,75 USD** (coincide con la "base cubrible" de la Palanca 1, Evidencia A de
> `palanca-01-ec2.md`). Por eso la Evidencia C re-ejecuta la consulta restringida a los tipos de
> línea de uso real y usa el equivalente on-demand como dimensión de coste de candidatos.

**Registro de evidencia (esquema del Catálogo_Evidencias):**

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-11.1-ec2-boxusage-canonica` |
| `cifra_publicada` | Partición de `66 110,5` h de BoxUsage en `6 321` filas (recurso × tipo); `BoxUsage` neto `6 611,04 USD` (distorsionado por SP — ver hallazgo) |
| `descripcion` | Consulta canónica del `design.md` de candidatos EC2 BoxUsage por recurso y tipo de instancia |
| `consulta_cur` | Consulta canónica (arriba) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:32:02Z` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` a nivel agregado (incluye filas de ajuste SP con `resource_id` vacío); el detalle por instancia se enumera en la Evidencia C |
| `dimension_agregacion` | `(line_item_resource_id, product_instance_type)`; medidas `SUM(line_item_usage_amount)`, `SUM(line_item_unblended_cost)` |
| `verificacion_vivo` | `null` (la lectura en vivo + p95 se ejecuta en la Tarea 11.2) |
| `clasificacion` | base de identificación de candidatos (clasificación Estimado se fija en la Tarea 11.3) |

---

## Evidencia B — Composición de `BoxUsage` por tipo de línea (explica el neto)

**`id_evidencia`:** `EV-11.1-boxusage-por-tipo-linea`
**Clasificación del registro:** `no atribuible a recurso` — agregado por `line_item_line_item_type`.

### Consulta CUR exacta (re-ejecutable)

```sql
SELECT line_item_line_item_type AS lit,
       COUNT(*) AS n,
       SUM(line_item_usage_amount) AS hours,
       SUM(line_item_unblended_cost) AS unblended,
       SUM(pricing_public_on_demand_cost) AS od_equiv
FROM data
WHERE line_item_product_code = 'AmazonEC2'
  AND line_item_usage_type LIKE '%BoxUsage%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

- `QueryExecutionId`: `33f872dd-2f8f-434e-9f3f-2cebd0866b25` · Estado: `SUCCEEDED`
- Resultado: ver la tabla del "Hallazgo metodológico" de la Evidencia A.

---

## Evidencia C — Base limpia de candidatos (uso real, equivalente on-demand por instancia)

**`id_evidencia`:** `EV-11.1-ec2-candidatos-limpio`
**Clasificación del registro:** detalle por recurso con identificador explícito de instancia
(Req 2.2) + agregados por familia con su dimensión (Req 2.3).
**Dimensión de agregación (Req 2.3):** `(line_item_resource_id, product_instance_type,
line_item_usage_account_id)`; medidas `SUM(line_item_usage_amount)` (horas),
`SUM(pricing_public_on_demand_cost)` (equivalente on-demand) y `SUM(line_item_unblended_cost)`.

### Consulta CUR exacta (re-ejecutable)

Restringe a los tipos de línea de **uso real** (`Usage`, `SavingsPlanCoveredUsage`,
`DiscountedUsage`) — excluye `SavingsPlanNegation` y `SppDiscount` (ajustes de cuenta, no
atribuibles a una instancia) — y usa `pricing_public_on_demand_cost` como base económica de
candidato (coste de la capacidad ejecutada a precio de lista, independiente de la cobertura SP):

```sql
SELECT line_item_resource_id      AS resource,
       product_instance_type      AS instance_type,
       line_item_usage_account_id AS account,
       SUM(line_item_usage_amount)        AS hours,
       SUM(pricing_public_on_demand_cost) AS od_equiv,
       SUM(line_item_unblended_cost)      AS unblended,
       COUNT(*)                           AS line_items
FROM data
WHERE line_item_product_code = 'AmazonEC2'
  AND line_item_usage_type LIKE '%BoxUsage%'
  AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','DiscountedUsage')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2, 3
ORDER BY od_equiv DESC;
```

Ejecución:

```bash
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "<consulta de arriba, en una sola línea>" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

- `QueryExecutionId`: `5365a962-5255-4131-b7db-6475bdd49e54`
- Estado: `SUCCEEDED` · Datos escaneados: `11 319 530` bytes · Filas (recursos): `6 298`

### Cifras base congeladas de la flota EC2 BoxUsage (USD, half-up 2 dec)

| Métrica | Valor |
|---------|------:|
| Equivalente on-demand total (base de candidatos) | **15 184,74 USD** |
| Unblended total (uso real, antes de negación SP) | 15 184,74 USD |
| Horas de uso totales | 66 110,5 h |
| Recursos facturados distintos (`line_item_resource_id`) | **6 298** |

> El grueso de los 6 298 recursos son entradas de muy pocas horas (flota EKS efímera: nodos/pods
> con `resource_id` de instancia y horas fraccionarias). La oportunidad de rightsizing/Graviton se
> concentra en las instancias de **carga sostenida** (24/7) que se listan abajo.

### C.1 — Desglose por familia de instancia (perfil de arquitectura, Req 13.3)

Graviton (arm64) detectado por familia que termina en `g[…]` (p. ej. `m7g`, `m6g`, `r6g`, `r7gd`).
El resto es x86 (Intel/AMD), candidato a migración a Graviton sujeto a compatibilidad arm64.

| Familia | Arquitectura | Equiv. on-demand (USD) | Horas | Recursos |
|---------|:------------:|----------------------:|------:|---------:|
| `m6i` | x86 | 2 087,65 | 9 185,1 | 34 |
| `m7i` | x86 | 2 026,13 | 9 760,1 | 1 549 |
| `c6a` | x86 | 1 807,09 | 11 008,1 | 66 |
| `m7g` | **arm64 (Graviton)** | 1 424,56 | 5 942,8 | 868 |
| `r6a` | x86 | 1 302,89 | 744,0 | 1 |
| `c7a` | x86 | 1 158,64 | 5 260,8 | 181 |
| `r6g` | **arm64 (Graviton)** | 1 012,13 | 2 279,9 | 1 074 |
| `m6g` | **arm64 (Graviton)** | 755,56 | 2 576,7 | 1 379 |
| `r7i` | x86 | 687,99 | 4 647,0 | 76 |
| `t3` | x86 (burstable) | 621,96 | 4 420,7 | 10 |
| `m5` | x86 | 578,14 | 1 954,1 | 47 |
| `c5a` | x86 | 529,73 | 744,0 | 1 |
| `t2` | x86 (burstable) | 389,48 | 5 206,8 | 7 |
| `m6id` | x86 | 333,76 | 744,0 | 1 |
| `t3a` | x86 (burstable) | 176,18 | 744,0 | 1 |
| `r7a` | x86 | 132,67 | 505,9 | 1 |
| `r7gd` | **arm64 (Graviton)** | 97,80 | 161,7 | 382 |
| `c5` | x86 | 44,31 | 155,5 | 521 |
| `m5a` | x86 | 10,09 | 52,6 | 93 |
| `r7g` | **arm64 (Graviton)** | 7,98 | 16,7 | 6 |

**Split de arquitectura (perfil de la flota):**

| Arquitectura | Equiv. on-demand (USD) | % de la flota |
|--------------|----------------------:|--------------:|
| **x86 (candidato a Graviton)** | **11 886,71** | **78,3 %** |
| arm64 (ya Graviton) | 3 298,04 | 21,7 % |
| **Total** | **15 184,75** | 100 % |

> **Recorrido Graviton:** el **78,3 %** del gasto de cómputo BoxUsage sigue en x86. La migración a
> familias arm64 equivalentes (p. ej. `m6i`→`m7g`/`m6g`, `c6a`/`c7a`→`c7g`, `r6a`→`r7g`,
> `m7i`→`m7g`) es la oportunidad. **Riesgo declarado (Req 13.3): compatibilidad con arquitectura
> arm64** — binarios/dependencias/imágenes de contenedor deben soportar arm64; en particular las
> cargas **SAP** (cuenta `400500600700`, ver C.2) tienen alta probabilidad de **no** soportar
> Graviton. La cuantificación del ahorro y el rango se hacen en la Tarea 11.3.

### C.2 — Candidatos de carga sostenida 24/7 (≥ 743 h) — base de rightsizing + Graviton

Instancias individuales que corren prácticamente todo el mes (≥ 743 h ≈ 24/7). Son los candidatos
prioritarios: el rightsizing requiere validar p95 real de CPU/RAM (Tarea 11.2/11.3) y la migración
Graviton requiere validar compatibilidad arm64. **24 instancias, equiv. on-demand 6 017,58 USD.**

| # | Instancia (`line_item_resource_id`) | Tipo | Cuenta (ID · nombre) | Horas | Equiv. on-demand (USD) | Arq. | Perfil candidato |
|--:|--------------------------------------|------|----------------------|------:|----------------------:|:----:|------------------|
| 1 | `i-077c80e4ad5dee2f6` | `r6a.4xlarge` | `400500600700` · SAP | 744,0 | 1 302,89 | x86 | Rightsizing + Graviton (riesgo SAP) |
| 2 | `i-09e46b118b490e70c` | `m6i.4xlarge` | `400500600700` · SAP | 744,0 | 1 184,45 | x86 | Rightsizing + Graviton (riesgo SAP) |
| 3 | `i-09df511c7032ee013` | `c5a.2xlarge` | `400500600700` · SAP | 744,0 | 529,73 | x86 | Rightsizing + Graviton (riesgo SAP) |
| 4 | `i-0131f5d7404a789c1` | `m6id.xlarge` | `200300400500` · iskaypet-data | 744,0 | 333,76 | x86 | Rightsizing + Graviton |
| 5 | `i-03c5a408758018ee9` | `m5.2xlarge` | `300400500600` · infra | 744,0 | 318,43 | x86 | Rightsizing + Graviton |
| 6 | `i-05540466050ace462` | `m7g.2xlarge` | `200300400500` · iskaypet-data | 744,0 | 270,67 | arm64 | Rightsizing (ya Graviton) |
| 7 | `i-07b80bdbf1e8921df` | `m7g.2xlarge` | `200300400500` · iskaypet-data | 744,0 | 270,67 | arm64 | Rightsizing (ya Graviton) |
| 8 | `i-0d85d225d1419549a` | `t3.xlarge` | `400500600700` · SAP | 744,0 | 190,46 | x86 (burst) | Oportunidad **moderada** (burstable, Req 13.4) |
| 9 | `i-00f748c002789db71` | `t3.xlarge` | `300400500600` · infra | 744,0 | 190,46 | x86 (burst) | Oportunidad **moderada** (burstable, Req 13.4) |
| 10 | `i-0dbaca293bddef0e4` | `t3a.xlarge` | `400500600700` · SAP | 744,0 | 176,18 | x86 (burst) | Oportunidad **moderada** (burstable, Req 13.4) |
| 11 | `i-01df3007e1dc5a4ad` | `m5.xlarge` | `999000111222` · clinicanimal | 744,0 | 159,22 | x86 | Rightsizing + Graviton |
| 12 | `i-0cd21ed0a1c0c1f1a` | `t2.xlarge` | `300400500600` · infra | 744,0 | 149,99 | x86 (burst) | Oportunidad **moderada** (burstable, Req 13.4) |
| 13 | `i-0f9235a3416897cb9` | `m7g.xlarge` | `200300400500` · iskaypet-data | 744,0 | 135,33 | arm64 | Rightsizing (ya Graviton) |
| 14 | `i-0c1a6ef567ca689cc` | `m7g.xlarge` | `200300400500` · iskaypet-data | 744,0 | 135,33 | arm64 | Rightsizing (ya Graviton) |
| 15 | `i-0db1f405e62e1c269` | `m7g.xlarge` | `200300400500` · iskaypet-data | 743,5 | 135,24 | arm64 | Rightsizing (ya Graviton) |
| 16 | `i-0c98874c30cec8c1e` | `m7g.xlarge` | `200300400500` · iskaypet-data | 743,3 | 135,20 | arm64 | Rightsizing (ya Graviton) |
| 17 | `i-0621a19f59aa7220f` | `t2.large` | `300400500600` · infra | 744,0 | 95,83 | x86 (burst) | Oportunidad **moderada** (burstable, Req 13.4) |
| 18 | `i-0b31a6e7b21850597` | `t3.large` | `200300400500` · iskaypet-data | 744,0 | 88,39 | x86 (burst) | Oportunidad **moderada** (burstable, Req 13.4) |
| 19 | `i-0371aa15d3a418184` | `t3.large` | `200300400500` · iskaypet-data | 743,1 | 88,28 | x86 (burst) | Oportunidad **moderada** (burstable, Req 13.4) |
| 20 | `i-07358c83ad2054d84` | `t2.medium` | `300400500600` · infra | 744,0 | 37,20 | x86 (burst) | Oportunidad **moderada** (burstable, Req 13.4) |
| 21 | `i-075ed705608c1f1f4` | `t2.medium` | `300400500600` · infra | 744,0 | 37,20 | x86 (burst) | Oportunidad **moderada** (burstable, Req 13.4) |
| 22 | `i-0d0c64ae101022f6e` | `t3.medium` | `300400500600` · infra | 744,0 | 33,93 | x86 (burst) | Oportunidad **moderada** (burstable, Req 13.4) |
| 23 | `i-0fa5be6c33a8560da` | `t2.micro` | `444455556666` · eks-tooling | 744,0 | 9,37 | x86 (burst) | Oportunidad **moderada** (burstable, Req 13.4) |
| 24 | `i-0d4b98e283cf4cc16` | `t2.micro` | `999900001111` · digital-dev | 743,9 | 9,37 | x86 (burst) | Oportunidad **moderada** (burstable, Req 13.4) |

**Resumen de candidatos 24/7 (perfiles, sin proponer recorte — eso es 11.2/11.3):**

| Segmento de candidato 24/7 | Instancias | Equiv. on-demand (USD) | Nota |
|----------------------------|-----------:|----------------------:|------|
| x86 **no** burstable (rightsizing + Graviton prioritario) | 6 | **3 828,48** | r6a/m6i/c5a (SAP), m6id (data), m5.2xlarge (infra), m5.xlarge (clinicanimal) |
| x86 burstable familia `t` (oportunidad moderada, Req 13.4) | 12 | 1 106,67 | `t2`/`t3`/`t3a` — ya de bajo coste; moderar |
| arm64 ya Graviton (solo rightsizing, no migración) | 6 | 1 082,44 | `m7g.2xlarge` × 2 + `m7g.xlarge` × 4 (iskaypet-data) |
| **Total 24/7 (≥ 743 h)** | **24** | **6 017,58** | — |

> **Concentración del ejemplo trabajado del `design.md`:** las 3 instancias SAP de la cuenta
> `400500600700` (`r6a.4xlarge` + `m6i.4xlarge` + `c5a.2xlarge`) suman **3 017,07 USD/mes** 24/7,
> coincidiendo con el "≈ $3k 24/7" del diseño. La familia `t2`/`t3` está presente y se marca como
> oportunidad moderada por ser burstable de bajo coste (Req 13.4).

**Registro de evidencia (esquema del Catálogo_Evidencias):**

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-11.1-ec2-candidatos-limpio` |
| `cifra_publicada` | Flota EC2 BoxUsage = `15 184,74 USD` equiv. on-demand / `66 110,5` h / `6 298` recursos; candidatos 24/7 (≥ 743 h) = `6 017,58 USD` equiv. on-demand en `24` instancias; split x86 `11 886,71` (78,3 %) / arm64 `3 298,04` (21,7 %) |
| `descripcion` | Base limpia (uso real, equiv. on-demand) por instancia para identificar candidatos de rightsizing y Graviton, con familia y perfil de uso (24/7) |
| `consulta_cur` | Consulta de la Evidencia C (arriba) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:32:02Z` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | Detalle por instancia en la tabla C.2 (24 `line_item_resource_id` explícitos, Req 2.2); agregados por familia con dimensión `product_instance_type` (Req 2.3) |
| `dimension_agregacion` | `(line_item_resource_id, product_instance_type, line_item_usage_account_id)`; medidas `SUM(line_item_usage_amount)`, `SUM(pricing_public_on_demand_cost)`, `SUM(line_item_unblended_cost)`; agregación secundaria por familia y por arquitectura |
| `verificacion_vivo` | `null` (la lectura en vivo `ec2 describe-instances` + p95 Grafana/VPA se ejecuta en la Tarea 11.2) |
| `clasificacion` | base de identificación de candidatos; la Palanca 9 se clasifica **Estimado** siempre (Req 13.6), fijado en la Tarea 11.3; **requiere Barrido_Utilizacion** (Req 18.1) |

---

## Síntesis de la Tarea 11.1 (cifras congeladas)

| Concepto | Valor | Notas |
|----------|------:|-------|
| Gasto EC2 BoxUsage (equiv. on-demand) | 15 184,74 USD | base de cómputo; = "base cubrible" Palanca 1 |
| Horas de uso totales | 66 110,5 h | — |
| Recursos facturados distintos | 6 298 | mayoría flota EKS efímera de pocas horas |
| Flota x86 (candidato a Graviton) | 11 886,71 USD (78,3 %) | riesgo arm64 (Req 13.3) |
| Flota arm64 (ya Graviton) | 3 298,04 USD (21,7 %) | solo rightsizing aplica |
| Candidatos 24/7 (≥ 743 h) | 24 instancias · 6 017,58 USD | base de rightsizing + Graviton |
| → x86 no burstable (prioritario) | 6 instancias · 3 828,48 USD | r6a/m6i/c5a SAP, m6id, m5.2xlarge, m5.xlarge |
| → x86 burstable `t` (moderado, Req 13.4) | 12 instancias · 1 106,67 USD | ya de bajo coste |
| → arm64 ya Graviton (solo rightsizing) | 6 instancias · 1 082,44 USD | m7g (iskaypet-data) |

**Pendiente (siguientes sub-tareas, NO parte de 11.1):**
- **Tarea 11.2** — `Verificacion_Recurso_Vivo` de solo lectura (`ec2 describe-instances`) + lectura
  de utilización real **p95 de CPU/RAM** vía Grafana/VPA
  (`quantile_over_time(0.95, ...)[7d:5m]`); sin métricas para un candidato → **no** proponer
  rightsizing y marcar pendiente de Barrido_Utilizacion (Req 13.1, 13.2); región `eu-west-1`.
- **Tarea 11.3** — basar la propuesta en p95 (no solo coste CUR); **moderar** la oportunidad en
  familias burstable `t` (Req 13.4); declarar como riesgo la **compatibilidad arm64** (Graviton) y
  el impacto en capacidad (Req 13.3, 13.5); clasificar **Estimado** siempre (rango, Req 13.6);
  documentar campos Req 4; marcar **requiere Barrido_Utilizacion** (Req 18.1).

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23` el `2026-06-23T08:32:02Z`.
- `QueryExecutionId` retenidos: `bb24f724-b320-4f89-8769-115c3aca52cd` (canónica `design.md`),
  `33f872dd-2f8f-434e-9f3f-2cebd0866b25` (composición por tipo de línea) y
  `5365a962-5255-4131-b7db-6475bdd49e54` (base limpia de candidatos).
- Cifras congeladas y reproducibles: re-ejecutar las consultas documentadas sobre el mismo
  Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría en
  Tarea 17.6).
- La cifra `cost` neta de la consulta canónica (`6 611,04 USD`) está distorsionada por la negación
  de Savings Plans y el descuento SPP (ver Evidencia A/B); la base económica de candidatos es el
  **equivalente on-demand `15 184,74 USD`** de la Evidencia C, consistente con la base cubrible de
  la Palanca 1.

---

# Sub-registro Tarea 11.2 — Verificacion_Recurso_Vivo + utilización real (solo lectura)

> Artefacto auditable de la **Tarea 11.2**: para los **24 candidatos 24/7** congelados en la
> Tarea 11.1 (Evidencia C.2), ejecutar `ec2 describe-instances` (solo lectura) para confirmar
> existencia/estado/tipo/arquitectura/plataforma, y **leer la utilización real p95 de CPU/RAM**.
> Regla de gating (Req 13.2): **sin métricas → NO se propone rightsizing y el candidato queda
> pendiente de Barrido_Utilizacion**. Aquí NO se fija ahorro ni recorte (eso es 11.3); solo se
> verifica el recurso y se lee utilización. Región `eu-west-1`.
>
> **Validates: Requirements 5.1, 13.1, 13.2**

## Parámetros de anclaje (Req 2.1, 5.5)

| Campo | Valor |
|-------|-------|
| Fecha-hora de ejecución (UTC) | `2026-06-23T09:11:51Z` |
| Fecha-hora (Europe/Madrid, CEST) | `2026-06-23T11:11:51+02:00` |
| Ventana de utilización leída | `2026-06-16T09:07Z → 2026-06-23T09:07Z` (**7 días**, paso de muestreo nativo CloudWatch) |
| Región consultada | `eu-west-1` (todos los candidatos residen en eu-west-1) |
| Naturaleza de los comandos | **solo lectura** (`describe-instances`, `cloudwatch get-metric-statistics`, `cloudwatch list-metrics`, `sts get-caller-identity`, PromQL `query`/`label values`) — ninguna operación mutante (Req 5.1, Property 11) |
| Credenciales | SSO SRE por cuenta (`sso_role_name = SRE`) + token Grafana de secret; **sin credenciales/tokens incrustados** (Req 7.5) |
| Identidad efectiva (prueba) | `arn:aws:sts::300400500600:assumed-role/AWSReservedSSO_SRE_933e5a8baf2a2495/ruben.landin@emefinpetcare.com` (y equivalentes por cuenta) |

## Hallazgo central — la fuente de utilización designada (Grafana/VPA) NO cubre estos recursos

La Tarea 11.2 (y el `design.md` de la Palanca 9) designa **Grafana/VPA** como fuente de p95
(`quantile_over_time(0.95, ...)[7d:5m]`). La verificación en vivo demuestra que **ninguno de los
24 candidatos** es observable por esa vía, porque **no son cargas de EKS** sino EC2 *standalone*
(SAP/PowerBI Windows, UniFi, Veeam, GLPI, DWH, print, DC…):

1. **Grafana Cloud Prometheus** (`grafanacloud-prom`, data plane `prometheus-prod-24-prod-eu-west-2`):
   no existe la métrica `aws_ec2_*` (CloudWatch EC2 **no** está ingerido; sí `aws_rds_*`), ni
   `windows_exporter` (las métricas Windows del estate viven en el Grafana **autogestionado**
   VictoriaMetrics de TPVs de tienda/clínica, no aplicable a estos servidores). Probado:
   `count(__name__=~"aws_ec2.*") = 0`, `count(__name__=~".*windows.*") = 0`.
2. **OpenCost / node metrics** (EKS): `node_total_hourly_cost{provider_id=~".*(<9 instance-ids candidatos>).*"}`
   → **0 series**. Ningún candidato es un nodo de los clusters EKS.
3. **VPA**: las recomendaciones VPA solo existen para **pods de EKS** (dp-dev/uat/prod), no para
   EC2 standalone. No hay CR de VPA para estos recursos.
4. **CWAgent (RAM)**: `cloudwatch list-metrics --namespace CWAgent` → **0 métricas** en `sap`,
   `iskaypet-data`, `infra` y `clinicanimal`. **No hay p95 de RAM** para ningún candidato.

**Única señal de utilización real disponible:** CloudWatch `AWS/EC2 CPUUtilization` (nativa, sin
agente) para las instancias **en ejecución**. Se lee como p95 sobre 7 días (read-only) y se
registra como señal **parcial (solo CPU)**. Req 13.1 exige p95 de **CPU y RAM**; al faltar RAM en
todo el conjunto, **ningún candidato alcanza el criterio de p95 completo** → todos quedan
**pendientes de Barrido_Utilizacion** (Req 13.2). El p95 de CPU se conserva como insumo que
orientará la Tarea 11.3, pero **no eleva** la Palanca a objetivo comprometido.

## Verificación en vivo `ec2 describe-instances` (Req 5.1) + p95 CPU (CloudWatch, parcial)

Estado, tipo, arquitectura y plataforma confirmados en vivo; p95/avg/max de CPU en `%` sobre la
ventana de 7 días. **RAM = n/d** (sin CWAgent) en todas las filas.

| # | Instancia | Tipo (11.1) | Cuenta · nombre | Estado vivo | Plataforma | p95 CPU % | avg % | max % | Estado verificación |
|--:|-----------|-------------|-----------------|-------------|-----------|----------:|------:|------:|---------------------|
| 1 | `i-077c80e4ad5dee2f6` | `r6a.4xlarge` | 400500600700 · SAP (slimstock/logística) | **running** | Windows | 32,39 | 10,96 | 77,49 | confirmado · pendiente Barrido (sin RAM) |
| 2 | `i-09e46b118b490e70c` | `m6i.4xlarge` | 400500600700 · SAP (spaceman) | **running** | Windows | 1,86 | 1,56 | 7,88 | confirmado · pendiente Barrido (sin RAM) |
| 3 | `i-09df511c7032ee013` | `c5a.2xlarge` | 400500600700 · SAP (publishing) | **running** | Windows | 2,04 | 1,89 | 14,68 | confirmado · pendiente Barrido (sin RAM) |
| 4 | `i-0131f5d7404a789c1` | `m6id.xlarge` | 200300400500 · iskaypet-data (power-bi-gateway) | **running** | Windows | 28,37 | 4,24 | 100,0 | confirmado · pendiente Barrido (sin RAM) |
| 5 | `i-03c5a408758018ee9` | `m5.2xlarge` | 300400500600 · infra (unifi) | **running** | Linux | 23,09 | 14,58 | 85,90 | confirmado · pendiente Barrido (sin RAM) |
| 6 | `i-05540466050ace462` | `m7g.2xlarge` | 200300400500 · iskaypet-data | **no existe** | — | — | — | — | **excluido** (terminada/rotada — drift Req 5.3) |
| 7 | `i-07b80bdbf1e8921df` | `m7g.2xlarge` | 200300400500 · iskaypet-data | **no existe** | — | — | — | — | **excluido** (terminada/rotada — drift Req 5.3) |
| 8 | `i-0d85d225d1419549a` | `t3.xlarge` | 400500600700 · SAP (servicios) | **running** | Windows (burst) | 1,85 | 1,17 | 28,39 | confirmado · pendiente Barrido (sin RAM; burstable Req 13.4) |
| 9 | `i-00f748c002789db71` | `t3.xlarge` | 300400500600 · infra (papercut) | **running** | Windows (burst) | 12,86 | 10,19 | 85,75 | confirmado · pendiente Barrido (sin RAM; burstable) |
| 10 | `i-0dbaca293bddef0e4` | `t3a.xlarge` | 400500600700 · SAP (middleware) | **running** | Windows (burst) | 37,28 | 27,15 | 80,27 | confirmado · pendiente Barrido (sin RAM; burstable) |
| 11 | `i-01df3007e1dc5a4ad` | `m5.xlarge` | 999000111222 · clinicanimal (DWH_PROVET) | **running** | Linux | 0,11 | 0,62 | 31,27 | confirmado · pendiente Barrido (sin RAM; CPU casi nula) |
| 12 | `i-0cd21ed0a1c0c1f1a` | `t2.xlarge` | 300400500600 · infra (warehouse.print) | **running** | Linux (burst) | 2,96 | 2,54 | 11,39 | confirmado · pendiente Barrido (sin RAM; burstable) |
| 13 | `i-0f9235a3416897cb9` | `m7g.xlarge` | 200300400500 · iskaypet-data | **no existe** | — | — | — | — | **excluido** (terminada/rotada — drift Req 5.3) |
| 14 | `i-0c1a6ef567ca689cc` | `m7g.xlarge` | 200300400500 · iskaypet-data | **no existe** | — | — | — | — | **excluido** (terminada/rotada — drift Req 5.3) |
| 15 | `i-0db1f405e62e1c269` | `m7g.xlarge` | 200300400500 · iskaypet-data | **no existe** | — | — | — | — | **excluido** (terminada/rotada — drift Req 5.3) |
| 16 | `i-0c98874c30cec8c1e` | `m7g.xlarge` | 200300400500 · iskaypet-data | **no existe** | — | — | — | — | **excluido** (terminada/rotada — drift Req 5.3) |
| 17 | `i-0621a19f59aa7220f` | `t2.large` | 300400500600 · infra (dc / Domain Controller) | **running** | Windows (burst) | 10,79 | 8,40 | 69,86 | confirmado · pendiente Barrido (sin RAM; burstable) |
| 18 | `i-0b31a6e7b21850597` | `t3.large` | 200300400500 · iskaypet-data (powerbi.ecommerce) | **running** | Windows (burst) | 11,78 | 3,60 | 100,0 | confirmado · pendiente Barrido (sin RAM; burstable) |
| 19 | `i-0371aa15d3a418184` | `t3.large` | 200300400500 · iskaypet-data (powerbi.marketing) | **running** | Windows (burst) | 13,48 | 10,04 | 99,70 | confirmado · pendiente Barrido (sin RAM; burstable) |
| 20 | `i-07358c83ad2054d84` | `t2.medium` | 300400500600 · infra (adopta301) | **running** | Linux (burst) | **71,20** | 29,89 | 74,05 | confirmado · **NO rightsizing** (p95 alto; burstable trabajando) |
| 21 | `i-075ed705608c1f1f4` | `t2.medium` | 300400500600 · infra (Glpi-Retail) | **running** | Linux (burst) | 5,32 | 3,58 | 18,81 | confirmado · pendiente Barrido (sin RAM; burstable) |
| 22 | `i-0d0c64ae101022f6e` | `t3.medium` | 300400500600 · infra (veeam) | **running** | Linux (burst) | 18,90 | 14,31 | 60,02 | confirmado · pendiente Barrido (sin RAM; burstable) |
| 23 | `i-0fa5be6c33a8560da` | `t2.micro` | 444455556666 · eks-tooling (sin Name) | **running** | Linux (burst) | 3,09 | 2,80 | 4,25 | confirmado · pendiente Barrido (sin RAM; burstable, ya mínima) |
| 24 | `i-0d4b98e283cf4cc16` | `t2.micro` | 999900001111 · digital-dev (testeando) | **stopped** | Linux | — | — | — | **no verificable utilización** (instancia parada; coste ≈ 0, candidato a baja) |

**Recuento:** 24 verificados en vivo → **17 running con p95 CPU leído**, **1 stopped** (digital-dev
`testeando`, sin utilización → no rightsizing; señalar para apagado/baja), **6 inexistentes**
(`m7g` de iskaypet-data, eran nodos EKS de data terminados/rotados tras mayo → drift Req 5.3,
**excluidos** del candidato).

## Hallazgos relevantes para la Palanca (orientan la Tarea 11.3; aquí no se cuantifica)

- **Graviton (Req 13.3) — riesgo arm64 confirmado en vivo:** las **5 SAP** + las **3 PowerBI** de
  iskaypet-data + `papercut` y `dc` de infra son **Windows** → migración a Graviton arm64 **no
  aplicable** (esos workloads Windows/SAP/PowerBI son x86). Los **6 `m7g`** que en 11.1 figuraban
  como "ya Graviton" eran **nodos EKS de data** y **ya no existen** (terminados). El recorrido
  Graviton real se reduce a los **Linux x86**: `unifi` (m5.2xlarge), `DWH_PROVET` (m5.xlarge) y la
  familia `t` Linux (oportunidad **moderada** por burstable, Req 13.4).
- **Señales de infrautilización de CPU (parciales, faltan RAM):** `m6i.4xlarge` spaceman (p95
  1,86 %), `c5a.2xlarge` publishing (p95 2,04 %), `t3.xlarge` servicios SAP (p95 1,85 %) y
  `m5.xlarge` DWH_PROVET (p95 0,11 %) muestran CPU muy holgada; son candidatos naturales a
  rightsizing **pero** SAP/PowerBI/DWH suelen ser memory-bound — **sin p95 de RAM no se puede
  proponer recorte sin riesgo de capacidad** (Req 13.5). Quedan pendientes de Barrido.
- **Excluir de rightsizing:** `t2.medium` adopta301 (p95 71,2 % → ya ajustada) y `t2.micro`
  (ya mínimas). `testeando` (stopped) no es rightsizing sino candidato a **terminación**.

## Comandos / PromQL exactos re-ejecutables (solo lectura — Req 5.1, 7.3, Property 11)

**Existencia/estado/tipo/plataforma (por cuenta, perfil SSO SRE, `eu-west-1`):**

```bash
aws ec2 describe-instances --profile <perfil> --region eu-west-1 \
  --instance-ids <ids de la cuenta> \
  --query 'Reservations[].Instances[].{Id:InstanceId,Type:InstanceType,State:State.Name,Arch:Architecture,Plat:PlatformDetails,Launch:LaunchTime,Name:Tags[?Key==`Name`]|[0].Value}' \
  --output json
```

**p95 de CPU real, 7 días (CloudWatch nativo, sin agente):**

```bash
END=$(date -u +%Y-%m-%dT%H:%M:%SZ); START=$(date -u -d '7 days ago' +%Y-%m-%dT%H:%M:%SZ)
aws cloudwatch get-metric-statistics --profile <perfil> --region eu-west-1 \
  --namespace AWS/EC2 --metric-name CPUUtilization \
  --dimensions Name=InstanceId,Value=<id> \
  --start-time $START --end-time $END --period 604800 \
  --extended-statistics p95 --statistics Average Maximum \
  --query 'Datapoints[0].[ExtendedStatistics.p95,Average,Maximum]' --output text
```

**Comprobación de ausencia de RAM (CWAgent) por cuenta:**

```bash
aws cloudwatch list-metrics --profile <perfil> --region eu-west-1 \
  --namespace CWAgent --query 'length(Metrics)' --output text   # → 0 en todas
```

**p95 designado por el diseño (Grafana/VPA) — re-ejecutable cuando haya cobertura:**

```promql
# CPU p95 7d de un pod (solo aplica a cargas EKS; estos EC2 standalone no están)
quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])[7d:5m])
# Recomendación VPA (solo pods EKS)
kube_customresource_verticalpodautoscaler_recommendation_cpu_target_cores
kube_customresource_verticalpodautoscaler_recommendation_memory_target_bytes
```

```bash
# Acceso al data plane de Grafana Cloud (token de secret; sin incrustar)
TOKEN=$(kubectl --context arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling \
  -n n8n get secret kiro-grafana-cloud -o jsonpath='{.data.GRAFANA_CLOUD_TOKEN}' | base64 -d)
curl -s -u "1290143:${TOKEN}" \
  "https://prometheus-prod-24-prod-eu-west-2.grafana.net/api/prom/api/v1/query" \
  --data-urlencode 'query=node_total_hourly_cost{provider_id=~".*i-077c80e4ad5dee2f6.*"}'   # → 0 series
```

## Registro de evidencia (esquema del Catálogo_Evidencias — Req 2.x, 5.5)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-11.2-rightsizing-live-2026-06-23` |
| `descripcion` | Verificacion_Recurso_Vivo (solo lectura) de los 24 candidatos 24/7 de la Tarea 11.1 + lectura de utilización real p95 (CPU vía CloudWatch `AWS/EC2`; RAM no disponible; Grafana/VPA sin cobertura por ser EC2 standalone) |
| `consulta_cur` | `no aplica` (verificación en vivo, no consulta CUR) |
| `mes_referencia` | `2026-05` (candidatos congelados); ventana de utilización `2026-06-16 → 2026-06-23` |
| `fecha_hora_utc` | `2026-06-23T09:11:51Z` |
| `version_dataset` | `frozen-2026-05@2026-06-23` (candidatos de la Evidencia C.2) |
| `moneda` | `USD` (no aplica a esta verificación; cifras de coste en 11.1) |
| `cuentas` | `400500600700` (SAP), `200300400500` (iskaypet-data), `300400500600` (infra), `999000111222` (clinicanimal), `444455556666` (eks-tooling), `999900001111` (digital-dev) |
| `region` | `eu-west-1` |
| `recurso_ids` | 24 `line_item_resource_id` de la tabla (18 existentes — 17 running + 1 stopped — y 6 inexistentes) |
| `metodo` | `aws ec2 describe-instances`; `aws cloudwatch get-metric-statistics` (p95/avg/max CPUUtilization, period 604800, 7d); `aws cloudwatch list-metrics --namespace CWAgent`; PromQL `query`/`label/__name__/values` contra Grafana Cloud — **todo solo lectura** (Req 5.1, Property 11) |
| `credenciales` | SSO SRE por cuenta + token Grafana de secret; sin credenciales/tokens incrustados (Req 7.5) |
| `estado` | **confirmado** (existencia/estado/tipo) para 18; **excluido** (drift, no existen) para 6; utilización p95 CPU leída para 17; **RAM no disponible** (0 CWAgent) y **Grafana/VPA sin cobertura** para los 24 |
| `gating_barrido` | **Todos los candidatos quedan pendientes de Barrido_Utilizacion** (Req 13.2): rightsizing exige p95 de CPU **y** RAM (Req 13.1) y la RAM no está instrumentada en ninguna cuenta; en 11.2 **no se propone** ningún rightsizing. El p95 de CPU es insumo parcial para 11.3. |
| `clasificacion` | La Palanca 9 se clasifica **Estimado** siempre (Req 13.6), se fija en 11.3; **requiere Barrido_Utilizacion** (Req 18.1) |

## Estado de ejecución (Tarea 11.2)

- ✅ **Ejecutado en vivo** el `2026-06-23T09:11:51Z` (UTC), región `eu-west-1`, perfiles SSO SRE por
  cuenta, **solo lectura** (describe/list/get + PromQL query). Sin credenciales/tokens incrustados.
- ✅ **`ec2 describe-instances`**: 18 de 24 candidatos existen (17 running, 1 stopped); **6 `m7g` de
  iskaypet-data ya no existen** (eran nodos EKS de data, terminados/rotados tras el Mes_Referencia
  → drift Req 5.3, **excluidos** del candidato).
- ✅ **Utilización real**: p95 de **CPU** leído para las 17 instancias en ejecución vía CloudWatch
  `AWS/EC2 CPUUtilization` (7 días). **p95 de RAM no disponible** (0 métricas CWAgent en todas las
  cuentas). **Grafana/VPA** (fuente designada) **sin cobertura**: estos recursos son EC2
  standalone, no cargas EKS (0 `aws_ec2_*`, 0 `windows_exporter`, 0 nodos OpenCost, sin VPA).
- ⏭️ **Gating (Req 13.2)**: al faltar el p95 de RAM en todo el conjunto, **ningún candidato** cumple
  el criterio p95 CPU+RAM → **todos pendientes de Barrido_Utilizacion**; en 11.2 **no se propone
  rightsizing**. El p95 de CPU se conserva como señal parcial para orientar la Tarea 11.3.
- ⏭️ **Pendiente Tarea 11.3** — basar la propuesta en p95 (cuando exista RAM), moderar burstables
  `t` (Req 13.4), declarar riesgo arm64/Graviton (Windows/SAP/PowerBI no migrables) e impacto en
  capacidad (Req 13.5), clasificar **Estimado** (rango, Req 13.6), documentar campos Req 4.
- ⏭️ **Recomendación de instrumentación para cerrar el Barrido (Tarea 16.2)**: habilitar señal de
  utilización para EC2 standalone — CloudWatch Agent (`mem_used_percent` Linux / `Memory % Committed
  Bytes In Use` Windows) o `node_exporter`/`windows_exporter` ingerido — para disponer de p95 de RAM
  y poder proponer rightsizing sin riesgo de capacidad.

---

# Aplicación de fórmula, clasificación y documentación — Tarea 11.3

> Artefacto auditable de la **Tarea 11.3**: a partir de los 24 candidatos 24/7 congelados en la
> Tarea 11.1 (Evidencia C.2, equiv. on-demand `6 017,58 USD`) y de la `Verificacion_Recurso_Vivo` +
> utilización real de la Tarea 11.2, se **basa la propuesta en p95** (no solo en el coste del CUR),
> se **modera** la oportunidad en familias burstable `t` (Req 13.4), se **declara como riesgo** la
> compatibilidad arm64 (Graviton) y el impacto en capacidad (Req 13.3, 13.5), se clasifica la
> Palanca como **Estimado** (rango Conservador–Agresivo, Req 13.6) y se documentan los campos
> obligatorios por Palanca (Req 4). La Palanca queda marcada como **requiere Barrido_Utilizacion**
> (Req 18.1): al **faltar el p95 de RAM en todas las cuentas** (Tarea 11.2), **ningún candidato**
> cumple el criterio p95 CPU+RAM (Req 13.1) → el rango es una **oportunidad honesta condicionada** a
> instrumentar la RAM, **no** un objetivo comprometido (Req 13.2, 18.2).
>
> **Validates: Requirements 13.1, 13.4, 13.5, 13.6, 3.3, 4.1, 4.4, 4.5, 4.6, 4.7, 6.1, 18.1**
>
> Entradas: candidatos 24/7 (Tarea 11.1, Evidencia C.2) + verificación en vivo (Tarea 11.2: 18 de 24
> existen — 17 running + 1 stopped —; **6 `m7g` ya no existen**, drift Req 5.3; **p95 de RAM no
> disponible** en ninguna cuenta; Grafana/VPA sin cobertura por ser EC2 standalone). Todas las cifras
> ancladas al `Dataset_Congelado` `frozen-2026-05@2026-06-23`, moneda USD.

## Regla rectora — la propuesta se basa en p95, no en el coste del CUR (Req 13.1, 13.2)

El rightsizing **no** se propone por coste alto del CUR, sino por **utilización real holgada**
confirmada por p95. La Tarea 11.2 dejó dos hechos que gobiernan toda la cuantificación:

1. **Falta el p95 de RAM en los 24 candidatos** (0 métricas CWAgent en `sap`, `iskaypet-data`,
   `infra`, `clinicanimal`; Grafana/VPA solo cubre pods EKS, no estos EC2 standalone). Req 13.1
   exige p95 de CPU **y** RAM; al faltar la RAM, **ningún candidato alcanza el criterio completo** y,
   por la regla del Req 13.2, **no se propone ningún rightsizing comprometido**. La Palanca entera
   queda **pendiente de Barrido_Utilizacion**.
2. El **p95 de CPU** (señal parcial, CloudWatch `AWS/EC2`, 7 días) sí está disponible para las 17
   running y se usa para **acotar honestamente** la oportunidad y para **excluir** candidatos sin
   recorrido. No eleva la Palanca a objetivo.

> Por tanto la cifra de esta tarea es un **rango Estimado condicionado**: representa la *superficie
> de oportunidad orientada por el p95 de CPU*, explícitamente **acotada/condicionada a instrumentar
> la RAM** (Barrido de la Tarea 16.2). No es un recorte propuesto ni un objetivo comprometido.

## Depuración del conjunto de candidatos (p95 + verificación en vivo)

| Segmento (Tarea 11.1) | Instancias | Equiv. on-demand (USD) | Tratamiento en 11.3 (basado en p95 + vivo) |
|-----------------------|-----------:|----------------------:|--------------------------------------------|
| x86 **no** burstable (running) | 6 | **3 828,48** | **Base direccionable** del rango (p95 CPU holgado en varias; RAM por confirmar) |
| x86 burstable familia `t` (running) | 10 | 925,12 | **Moderado a marginal** (Req 13.4): ya de bajo coste → fuera del rango cuantificado |
| arm64 ya Graviton (`m7g`) | 6 | 1 082,44 | **Excluido** (drift Req 5.3: terminadas/rotadas, **ya no existen**) |
| burstable ya ajustada / mínima / parada | 2 | 56,57 | **Excluido** con motivo (ver abajo) |
| **Total candidatos 24/7 (11.1)** | **24** | **6 017,58** | — |

**Exclusiones con motivo (Req 13.4, 13.2):**

- **6 `m7g` de iskaypet-data** (`1 082,44 USD`): no existen en vivo (eran nodos EKS de Data
  terminados/rotados tras el Mes_Referencia) → **drift Req 5.3**, fuera de candidato. *Efecto
  colateral:* el segmento "arm64 ya Graviton" desaparece; el rightsizing arm64-solo queda vacío.
- **`t2.medium` adopta301** (`37,20 USD`, p95 CPU **71,2 %**): ya trabajando cerca de su techo →
  **NO rightsizing** (recortar rompería capacidad).
- **`t2.micro`** eks-tooling (`9,37 USD`, p95 3,09 %): ya en el tamaño mínimo de su familia → sin
  recorrido de downsize.
- **`t2.micro` digital-dev `testeando`** (`9,37 USD`, **stopped**): sin utilización; no es
  rightsizing sino candidato a **terminación/baja** (se señala, no se cuantifica aquí).
- **Familia `t` burstable running** (10 inst., `925,12 USD`): Req 13.4 — ya de bajo coste y los
  créditos de CPU absorben los picos; la oportunidad de downsize es marginal y de alto riesgo de
  throttling → **moderada a marginal**, fuera del rango cuantificado (se documenta cualitativamente).

> **Base direccionable cuantificada (Req 4.2): 6 instancias x86 no burstable, `3 828,48 USD/mes`**
> equiv. on-demand: `r6a.4xlarge` (SAP, p95 32,39 %), `m6i.4xlarge` (SAP spaceman, p95 1,86 %),
> `c5a.2xlarge` (SAP publishing, p95 2,04 %), `m6id.xlarge` (data power-bi-gateway, p95 28,37 %),
> `m5.2xlarge` (infra unifi, p95 23,09 %), `m5.xlarge` (clinicanimal DWH_PROVET, p95 0,11 %).

## Graviton — riesgo arm64 declarado (Req 13.3): oportunidad casi nula en este conjunto

La migración a Graviton (arm64) **no se cuantifica como ahorro adicional** porque la superficie real
es casi inexistente y el riesgo de compatibilidad es el factor dominante:

- Las **5 instancias SAP** + las **3 PowerBI** de iskaypet-data + `papercut`/`dc` de infra son
  **Windows** → **arm64 no aplicable** (SAP/PowerBI/Windows son x86). **Riesgo declarado (Req 13.3):
  incompatibilidad arm64.**
- Los **6 `m7g`** que en 11.1 figuraban como "ya Graviton" **ya no existen** (drift).
- El único recorrido teórico arm64 son **2 instancias Linux x86**: `unifi` (m5.2xlarge) y
  `DWH_PROVET` (m5.xlarge), ambas pequeñas; `DWH_PROVET` además es memory-bound y de CPU casi nula.
  Su migración (≈ 10–20 % precio-rendimiento, precio público AWS) queda **subsumida** en el rango de
  rightsizing (downsize) para **evitar doble conteo** y **condicionada** a validar binarios/imágenes
  arm64 y RAM. No se añade una cifra Graviton separada.

## Fórmula de ahorro y supuesto de reducción (Req 4.1, 4.3, 6.1, 13.5)

**Mecánica.** El rightsizing convierte el coste on-demand de la instancia actual en el de una clase
inferior cuando el p95 de utilización lo permite. Ahorro mensual = `coste_base × tasa_reducción`. La
tasa es un **supuesto de ingeniería** orientado por el p95 de CPU y **acotado** por la
incertidumbre de RAM (sin p95 de RAM, una clase memory-bound como SAP/PowerBI/DWH no puede
recortarse al límite que sugiere la CPU sin riesgo de capacidad — Req 13.5).

| Parámetro | Valor | Detalle |
|-----------|-------|---------|
| Coste base afectado (mensual) | `3 828,48 USD` | 6 instancias x86 no burstable (equiv. on-demand, Tarea 11.1) |
| **Conservador** — tasa de reducción | **15,0 %** | downsize de una sola clase solo en las de CPU claramente ociosa, **descontado** por RAM desconocida |
| **Agresivo** — tasa de reducción | **40,0 %** | downsize de 1–2 clases en las de CPU muy holgada (spaceman 1,86 %, publishing 2,04 %, DWH 0,11 %) si la RAM lo confirma |
| Origen del supuesto (Req 4.3) | **precio público AWS** | ratio de precio entre clases de instancia (downsize) y delta Graviton; fecha del dato: **2026-06-23** |

> Los porcentajes 15 % / 40 % derivan del **precio público AWS** (diferencial de precio on-demand al
> bajar de clase) y de la holgura observada en el p95 de CPU; **no** son tarifa negociada. Son
> deliberadamente prudentes porque la RAM no está instrumentada: SAP/PowerBI/DWH suelen ser
> memory-bound y el recorte real defendible podría ser **menor** que el que sugiere la CPU.

### Cálculo del ahorro (half-up a 2 decimales, USD — Req 6.7)

**Ahorro mensual** (Rango_Conservador–Rango_Agresivo):

```
Conservador = 3 828,48 × 0,15 = 574,272   → 574,27 USD/mes
Agresivo    = 3 828,48 × 0,40 = 1 531,392 → 1 531,39 USD/mes
```

**Ahorro anualizado** = mensual × 12 (Req 6.3; advertencia de estacionalidad abajo):

```
Conservador anual = 574,272   × 12 = 6 891,264  → 6 891,26 USD/año
Agresivo anual    = 1 531,392 × 12 = 18 376,704 → 18 376,70 USD/año
```

> **Advertencia de anualización (Req 6.4):** la cifra anual asume que el Mes_Referencia (mayo 2026)
> es representativo y **no captura estacionalidad**. Las instancias son cargas 24/7 estables
> (SAP/PowerBI/UniFi/DWH), lo que respalda la representatividad del coste base, pero el objetivo
> comprometido **no se fija** hasta completar el Barrido_Utilizacion (instrumentar RAM, Tarea 16.2).

## Clasificación (Req 3.3, 13.6) — **Estimado** (rango), condicionada al Barrido

| Atributo | Valor |
|----------|-------|
| Clasificación | **Estimado** (Ahorro_Estimado) — **siempre rango** (Req 13.6), nunca cifra única |
| Rango_Conservador | **574,27 USD/mes** · 6 891,26 USD/año |
| Rango_Agresivo | **1 531,39 USD/mes** · 18 376,70 USD/año |
| Invariante `0 < Conservador ≤ Agresivo` (Req 3.3) | `0 < 574,27 ≤ 1 531,39` ✓ · anual `0 < 6 891,26 ≤ 18 376,70` ✓ |

**Motivo de la clasificación Estimado (Req 13.6):** el ahorro por rightsizing/Graviton es **siempre
Estimado** por definición del requisito; además aquí depende de supuestos (tasa de reducción
15–40 %) y de una utilización real **incompleta** (p95 de CPU sin RAM). No es desperdicio puro
eliminable → **Estimado**, no Garantizado. El rango está **enteramente condicionado** a completar el
Barrido (p95 de RAM): hasta entonces se presenta **solo como rango**, no como objetivo comprometido
(Req 13.2, 18.2).

## Documentación de la Palanca — campos obligatorios (Req 4.1–4.7)

| Campo (Req 4) | Valor |
|---------------|-------|
| **Supuesto de reducción** (Req 4.1, 0–100, 1 decimal) | Conservador **15,0 %** · Agresivo **40,0 %** (downsize por p95; Graviton subsumido, ≈10–20 % precio público solo en Linux x86 migrable) |
| **% direccionable + coste base mensual afectado** (Req 4.2) | base afectada **3 828,48 USD/mes** (6 inst. x86 no burstable) · **63,6 %** de los candidatos 24/7 (`3 828,48 / 6 017,58`) · 25,2 % de la flota EC2 BoxUsage (`3 828,48 / 15 184,74`) |
| **Origen del supuesto + fecha** (Req 4.3) | **precio público AWS** (diferencial de precio entre clases + delta Graviton) · fecha **2026-06-23** |
| **Riesgo** (Req 4.4, 13.5, 13.3) | **Alto** — **impacto en capacidad**: sin p95 de RAM, recortar clases memory-bound (SAP/PowerBI/DWH) por señal de CPU puede agotar memoria y romper el servicio (Req 13.5); **incompatibilidad arm64** (Graviton) en todas las cargas Windows/SAP/PowerBI (Req 13.3) |
| **Esfuerzo** (Req 4.5) | **Medio** — el rightsizing exige parar/redimensionar/arrancar (ventana de downtime) por instancia y validación con el owner; las cargas SAP/Windows requieren coordinación; previo obligatorio: instrumentar RAM (Barrido) |
| **Owner / responsable** (Req 4.6) | **pendiente** — por squad dueño de cada instancia: equipo **SAP** (`400500600700`), squad **Data** (`200300400500`, iskaypet-data), **SRE/Infra** (`300400500600`), **Clinicanimal** (`999000111222`) — correos corporativos por asignar |
| Campos no evaluables (Req 4.7) | owner → "pendiente" (transversal, equipos enumerados); resto evaluado |

## Barrido_Utilizacion (Req 18.1) — **REQUERIDO** (bloqueante de objetivo)

🔶 **Esta Palanca REQUIERE Barrido_Utilizacion antes de elevarse a objetivo comprometido**, y a día
de hoy está **pendiente al 100 %**: el criterio del Req 13.1 (p95 de CPU **y** RAM) **no se cumple
para ningún candidato** porque la RAM no está instrumentada en ninguna cuenta (Tarea 11.2). Por la
regla del Req 13.2, **no se propone rightsizing comprometido**; el rango Estimado se presenta solo
como rango (Req 18.2).

**Para cerrar el Barrido (Tarea 16.2):**

1. **Instrumentar el p95 de RAM** de los 6 candidatos x86 no burstable (y, si se quiere ampliar, de
   la familia `t`): CloudWatch Agent (`mem_used_percent` en Linux / `Memory % Committed Bytes In
   Use` en Windows) o `node_exporter`/`windows_exporter` ingerido a Grafana.
2. Consolidar p95 de CPU **y** RAM por recurso sobre ventana ≥ 7 días y **re-derivar** la tasa de
   reducción por instancia (las memory-bound bajarán su recorte respecto a lo que sugiere la CPU).
3. Validar **compatibilidad arm64** antes de cualquier propuesta Graviton (descartado de entrada en
   Windows/SAP/PowerBI).
4. Registrar resultados en el `Catálogo_Evidencias` **antes** de elevar la Palanca a objetivo
   (Req 18.4).

| Campo | Valor |
|-------|-------|
| `requiere_barrido` | **Sí** — Barrido de rightsizing por p95 (Tarea 16.2) **pendiente al 100 %**; sin p95 de RAM no hay propuesta comprometida (Req 13.1, 13.2, 18.1) |
| `estado_barrido` | **pendiente** (no iniciable hasta instrumentar RAM) |
| `efecto_en_objetivo` | **Fuera del Objetivo_Comprometido** hasta cerrar el Barrido (Req 18.2); contribuye solo como rango Estimado |

## Registro de evidencia (esquema del Catálogo_Evidencias — Req 2.x, 19.5)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-11.3-rightsizing-clasificacion` |
| `cifra_publicada` | Ahorro **Estimado** por rightsizing/Graviton (Palanca 9): **574,27 – 1 531,39 USD/mes** · **6 891,26 – 18 376,70 USD/año** (×12, advertencia de estacionalidad); base afectada `3 828,48 USD/mes` (6 inst. x86 no burstable); % direccionable 63,6 % de los candidatos 24/7 |
| `descripcion` | Aplicación de la fórmula de rightsizing sobre la base x86 no burstable basada en p95 de CPU (RAM no instrumentada), Graviton subsumido por riesgo arm64, clasificación Estimado (rango) y documentación Req 4; Palanca pendiente de Barrido_Utilizacion |
| `consulta_cur` | `no aplica` (derivación sobre cifras congeladas de las Tareas 11.1/11.2: `EV-11.1-ec2-candidatos-limpio`, `EV-11.2-rightsizing-live-2026-06-23`) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:32:02Z` (base 11.1) · utilización `2026-06-23T09:11:51Z` (11.2) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | Base direccionable (6): `i-077c80e4ad5dee2f6` (r6a.4xlarge SAP), `i-09e46b118b490e70c` (m6i.4xlarge SAP), `i-09df511c7032ee013` (c5a.2xlarge SAP), `i-0131f5d7404a789c1` (m6id.xlarge data), `i-03c5a408758018ee9` (m5.2xlarge infra), `i-01df3007e1dc5a4ad` (m5.xlarge clinicanimal) |
| `dimension_agregacion` | `(line_item_resource_id, product_instance_type, line_item_usage_account_id)`; ahorro = base × tasa_reducción {0,15; 0,40}; anualizado ×12 |
| `verificacion_vivo` | `EV-11.2-rightsizing-live-2026-06-23` (18/24 existen; 6 drift excluidas; p95 CPU parcial; **RAM no disponible**) |
| `clasificacion` | **Estimado** (rango, Req 13.6); **requiere Barrido_Utilizacion** (Req 18.1), pendiente al 100 % (sin p95 de RAM, Req 13.2) |

## Síntesis de la Tarea 11.3 (Palanca 9 — clasificada y documentada)

| Concepto | Valor |
|----------|-------|
| Clasificación | **Estimado** (siempre, Req 13.6) — rango, condicionado al Barrido |
| Coste base mensual afectado | 3 828,48 USD (6 inst. x86 no burstable) · % direccionable 63,6 % de candidatos 24/7 |
| Ahorro mensual | **574,27 – 1 531,39 USD** (reducción 15,0 % – 40,0 % por p95) |
| Ahorro anualizado (×12) | **6 891,26 – 18 376,70 USD** (asume mes representativo; no captura estacionalidad) |
| Supuesto / origen | reducción 15,0–40,0 % · **precio público AWS** · 2026-06-23 |
| Graviton (Req 13.3) | **no cuantificado aparte** — Windows/SAP/PowerBI no migrables (riesgo arm64); solo 2 Linux x86 teóricos, subsumidos para no doble contar |
| Burstable `t` (Req 13.4) | **moderado a marginal** — ya de bajo coste, fuera del rango cuantificado |
| Riesgo / Esfuerzo / Owner | **Alto** (capacidad sin RAM + arm64) / Medio / **pendiente** (SAP, Data, SRE/Infra, Clinicanimal) |
| Gating | 🔶 **requiere Barrido_Utilizacion** (Tarea 16.2) — **pendiente al 100 %**; fuera de objetivo comprometido hasta instrumentar RAM (Req 13.2, 18.1, 18.2) |

## Estado de ejecución (Tarea 11.3)

- ✅ **Completada.** Propuesta basada en **p95** (no en coste CUR): base depurada a las 6 instancias
  x86 no burstable running; familia `t` moderada (Req 13.4); 6 `m7g` excluidas por drift; adopta301
  / t2.micro / `testeando` excluidas con motivo.
- ✅ **Graviton declarado como riesgo arm64** (Req 13.3): no aplicable a Windows/SAP/PowerBI; no se
  cuantifica ahorro Graviton separado (evita doble conteo).
- ✅ **Clasificada Estimado** (Req 13.6) con rango **574,27 – 1 531,39 USD/mes** (anual
  **6 891,26 – 18 376,70 USD**), invariante `0 < Cons ≤ Agr` cumplida; anualización ×12 con
  advertencia de estacionalidad (Req 6.3, 6.4).
- ✅ **Campos Req 4 documentados** (supuesto %, % direccionable + coste base, origen + fecha, riesgo
  Alto, esfuerzo Medio, owner "pendiente" transversal — Req 4.1–4.7).
- 🔶 **Marcada `requiere Barrido_Utilizacion`** (Req 18.1) y **pendiente al 100 %**: sin p95 de RAM
  ningún candidato cumple el Req 13.1 → no se propone rightsizing comprometido (Req 13.2); el rango
  es una oportunidad honesta **condicionada** a instrumentar la RAM (Tarea 16.2). No entra en el
  Objetivo_Comprometido (Req 18.2).
- Cifras reproducibles: re-aplicar `3828.48 × {0,15; 0,40}` con redondeo half-up a 2 decimales y ×12
  reproduce exactamente el rango (diferencia `0,00 USD`, Req 7.3).
