# Barrido de compromiso steady-state — Tarea 16.1 (Palancas 1 y 2)

> Artefacto auditable de la **Tarea 16.1** del Estudio FinOps de Ahorro AWS. Ejecuta el
> **Barrido_Utilizacion de compromiso steady-state** que sostiene el % direccionable de la
> **Palanca 1 (EC2 Savings Plans)** y la **Palanca 2 (RDS Reserved Instances)**: confirma, recurso a
> recurso, el "uso estable" (presencia en **≥ 90 % de las horas** dentro de una ventana **≥ 30 días**)
> antes de que el Ahorro_Estimado de cada Palanca pueda elevarse a **objetivo comprometido**.
>
> Este fichero es el **registro propio** de la Tarea 16.1. **No** modifica `catalogo-evidencias.md`
> ni ningún `palanca-*.md` (esos artefactos están congelados; este barrido los referencia, no los
> reescribe). La elevación efectiva a objetivo y la actualización del Catálogo_Evidencias /
> derivación de objetivos se realizan en las fases 17/19.
>
> **Validates: Requirements 18.1, 18.3, 18.4, 8.4**

## Parámetros de anclaje (heredados del Dataset_Congelado)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Horas de la ventana | **744 h** (31 días ≥ 30 días, Req 8.4) |
| Umbral "uso estable" (Req 8.4) | **≥ 90 % → ≥ 669,6 h** (`0,90 × 744`) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Fecha de ejecución del barrido (UTC) | `2026-06-24` |
| Moneda | `USD` (half-up, 2 decimales; suma antes de redondear, Req 6.7) |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND < TIMESTAMP '2026-06-01 00:00:00'` |

## Cadena de acceso a datos (reproducibilidad — Req 7.1, 7.2)

| Parámetro | Valor |
|-----------|-------|
| Motor | Amazon Athena (CUR 2.0) |
| Base de datos / tabla | `athenacurcfn_finnops` / `data` |
| Región | `eu-west-1` |
| Cuenta CUR | `600700800900` (root-iskaypet) |
| Rol de acceso | `Cur-AWSS3CURLambdaExecutor` (perfil `root-iskaypet`) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |

## Definición operativa del barrido (Req 8.4, 18.1)

Para cada Palanca de compromiso se mide, **por `line_item_resource_id`**, las horas de cómputo
facturadas en el Mes_Referencia y se segmenta:

- `stable_ge90pct` → horas ≥ 669,6 (≥ 90 % de 744 h): sostiene el % direccionable de la Palanca.
- `intermittent_burst` → horas < 669,6: no sostiene compromiso (se enruta a Spot/scheduling, Req 8.6).

**Criterio de aprobación del barrido (Req 18.1, 18.3):** el barrido **CONFIRMA** una Palanca si la
**totalidad** de su base direccionable congelada cae en el segmento estable. Si una porción de la
base direccionable cayera en intermitente, el barrido sería **PARCIAL** y la Palanca se trataría como
**pendiente** a efectos de comprometer objetivos (Req 18.3).

> Nota metodológica sobre la unidad de medida. Las líneas CUR de cómputo son **diarias**: la métrica
> de presencia se obtiene de `SUM(line_item_usage_amount)` (instancia-horas del mes), **no** de un
> recuento de marcas horarias. Se descartaron dos enfoques erróneos durante la ejecución y se dejan
> registrados por trazabilidad: (a) `COUNT(DISTINCT line_item_usage_start_date)` —cuenta días, no
> horas— (`QueryExecutionId` `33692705-e48e-47f3-a193-fd75dc0e9bdc`); (b) normalización
> `usage_amount/(1+multi_az)` —incorrecta, porque en este CUR el `usage_amount` de una instancia RDS
> Multi-AZ ya es 744 h/mes y no 1488 h, como confirma digital-prod (20 instancias × 744 = 14 880 h en
> el Registro 4.1)— (`QueryExecutionId` `994ad16d-4295-481b-b7fa-ec2f951a13ed`). La consulta canónica
> usa `SUM(line_item_usage_amount)` sin normalizar, idéntica en unidad a la del barrido EC2.

---

## Palanca 1 — EC2 Savings Plans (gating Palanca 1)

**Entrada (congelada, `palanca-01-ec2.md`, Tareas 3.1/3.3):** base on-demand **estable**
`4 813,47 USD` (18 recursos), marcada "requiere Barrido_Utilizacion"; Estimado
`1 347,77`–`1 780,99 USD/mes`.

### Consulta del barrido (re-ejecutable)

```sql
WITH od AS (
  SELECT line_item_resource_id AS rid,
         SUM(line_item_usage_amount) AS hours,
         SUM(line_item_unblended_cost) AS cost
  FROM data
  WHERE line_item_product_code = 'AmazonEC2'
    AND line_item_usage_type LIKE '%BoxUsage%'
    AND line_item_line_item_type IN ('Usage','DiscountedUsage')
    AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
    AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
  GROUP BY line_item_resource_id
)
SELECT CASE WHEN hours >= 669.6 THEN 'stable_ge90pct' ELSE 'intermittent_burst' END AS segment,
       COUNT(*) AS resources, SUM(hours) AS usage_hours, SUM(cost) AS unblended,
       MIN(CASE WHEN hours >= 669.6 THEN hours END) AS min_stable_hours,
       ROUND(MIN(CASE WHEN hours >= 669.6 THEN hours END)/744.0*100, 1) AS min_stable_pct
FROM od GROUP BY 1 ORDER BY 1;
```

- `QueryExecutionId`: **`2b579fc1-ff16-4dac-b258-39d459a4b7c3`** · Estado `SUCCEEDED`.

### Resultado del barrido (congelado)

| Segmento on-demand EC2 | Recursos | Horas | Unblended (USD) | Mín. horas del estable | Mín. % del estable |
|------------------------|---------:|------:|----------------:|-----------------------:|-------------------:|
| `stable_ge90pct` (≥ 669,6 h) | 18 | 13 358,350 | **4 813,47** | **713,87 h** | **96,0 %** |
| `intermittent_burst` (< 669,6 h) | 2 363 | 11 600,892 | 2 372,44 | — | — |

**Lectura del barrido (Req 8.4, 18.1):** los **18** recursos que componen la base direccionable de la
Palanca 1 (`4 813,47 USD`) están **todos** en el segmento estable, y el **menos estable de ellos**
está presente en el **96,0 %** de las horas (713,87 h ≥ 669,6 h), por encima del umbral del 90 %. No
hay ningún dólar de la base direccionable en el segmento intermitente. La porción intermitente
(`2 372,44 USD`, 2 363 recursos) ya estaba **excluida** de la Palanca 1 y enrutada a la Palanca 10
(Spot/scheduling), sin doble conteo (Req 8.6, 8.8).

### Veredicto Palanca 1

> **BARRIDO CONFIRMADO (steady-state completo).** El 100 % de la base direccionable
> (`4 813,47 USD/mes`, 18 recursos) cumple el criterio de uso estable (mínimo 96,0 % de horas). La
> Palanca 1 queda **elegible para objetivo comprometido**: su `Rango_Conservador` (`1 347,77 USD/mes`
> · `16 173,27 USD/año`) puede entrar en la derivación de objetivos (Req 18.4, 19.4). No es barrido
> parcial → no aplica el tratamiento "pendiente" del Req 18.3.

---

## Palanca 2 — RDS Reserved Instances (gating Palanca 2)

**Entrada (congelada, `palanca-02-rds.md`, Tareas 4.1/4.2/4.3):** cómputo de instancia RDS
`6 616,31 USD` (cobertura RI/SP 0,0 %); base direccionable **prod estable** `5 096,40 USD` (77,0 %),
tras descontar la RI All Upfront vigente de eks-tooling (`≈ 77,38 USD`, 2× `db.t3.medium`) y enrutar
el no-prod Helios a la Palanca 5 (`851,14 USD`); marcada "requiere Barrido_Utilizacion"; Estimado
`1 732,78`–`2 548,20 USD/mes`.

### Consulta del barrido (re-ejecutable, unidad = instancia-horas)

```sql
WITH inst AS (
  SELECT line_item_resource_id AS rid,
         line_item_usage_account_id AS acct,
         SUM(line_item_usage_amount) AS hours,
         SUM(line_item_unblended_cost) AS cost
  FROM data
  WHERE line_item_product_code = 'AmazonRDS'
    AND (line_item_usage_type LIKE '%InstanceUsage%' OR line_item_usage_type LIKE '%Multi-AZUsage%')
    AND line_item_line_item_type IN ('Usage','DiscountedUsage')
    AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
    AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
  GROUP BY line_item_resource_id, line_item_usage_account_id
)
SELECT CASE WHEN hours >= 669.6 THEN 'stable_ge90pct' ELSE 'intermittent_burst' END AS segment,
       COUNT(*) AS resources, SUM(cost) AS unblended,
       MIN(hours) AS min_hours, MAX(hours) AS max_hours
FROM inst GROUP BY 1 ORDER BY 1;
```

- `QueryExecutionId`: **`e0d5fb2b-a62f-4ce1-81a4-dd57217c31fa`** · Estado `SUCCEEDED`.

### Resultado del barrido (congelado)

| Segmento de cómputo RDS | Recursos | Unblended (USD) | Mín. horas | Máx. horas |
|-------------------------|---------:|----------------:|-----------:|-----------:|
| `stable_ge90pct` (≥ 669,6 h) | 38 | **6 024,94** | **744,00 h (100 %)** | 744,00 |
| `intermittent_burst` (< 669,6 h) | 44 | 591,37 | 0,17 | 385,31 |
| **Total cómputo instancia RDS** | **82** | **6 616,31** | — | — |

> Reconciliación (Req 8.8): `6 024,94 + 591,37 = 6 616,31` = cómputo de instancia RDS del Registro
> 4.1 ✓. El segmento intermitente (`591,37 USD`, 44 recursos) coincide con el término `591,39` de la
> ecuación de conservación del Registro 4.3 (`6 616,31 = 5 096,40 + 77,38 + 851,14 + 591,39`),
> confirmando que esa porción ya estaba fuera de la base direccionable.

### Desglose del segmento estable por cuenta (`QueryExecutionId` `837da239-7c97-41a5-8186-3f1f5dc2f9b9`)

| Cuenta (ID) | Perfil | Recursos estables | Unblended estable (USD) | Mín. horas | Destino |
|-------------|--------|------------------:|------------------------:|-----------:|---------|
| 666777888999 | retail-prod | 2 | 2 531,09 | 744 | Direccionable Palanca 2 |
| 111222333444 | digital-prod | 20 | 1 665,07 | 744 | Direccionable Palanca 2 |
| 777788889999 | helios-prod | 2 | 425,57 | 744 | Direccionable Palanca 2 |
| 666677778888 | helios-uat | 2 | 425,57 | 744 | **No-prod → Palanca 5** |
| 555566667777 | helios-dev | 2 | 425,57 | 744 | **No-prod → Palanca 5** |
| 400500600700 | sap | 1 | 281,23 | 744 | Direccionable Palanca 2 |
| 444455556666 | eks-tooling | 6 | 232,13 | 744 | Direccionable (− RI `77,38` cubierta) |
| 333344445555 | eks-prd | 1 | 26,04 | 744 | Direccionable Palanca 2 |
| 300400500600 | infra | 1 | 12,65 | 744 | Direccionable Palanca 2 |
| 444555666777 | retail-dev | 1 | 0,03 | 744 | No-prod (importe inmaterial) |
| **Σ estable** | | **38** | **6 024,94** | 744 | — |

**Conciliación con la base direccionable congelada (`5 096,40 USD`, Req 18.4):**

```
  Σ estable (38 recursos, todos a 744 h = 100 %)        6 024,94
− No-prod Helios dev+uat (→ Palanca 5)                  −  851,14
− RI All Upfront vigente eks-tooling (2× db.t3.medium)  −   77,38
------------------------------------------------------------------
= Base direccionable prod estable (Palanca 2)             5 096,42  ≈ 5 096,40  ✓
```

(La diferencia de `0,02 USD` es redondeo half-up sobre componentes; dentro de tolerancia.)

**Lectura del barrido (Req 8.4, 18.1):** la **totalidad** de la base direccionable de la Palanca 2
(`5 096,40 USD`) cae en el segmento estable, y **cada uno** de esos recursos está presente en el
**100 %** de las horas del mes (744 h, muy por encima del umbral 669,6 h / 90 %). El cómputo
intermitente (`591,37 USD`) y el no-prod Helios (`851,14 USD`, estable pero enrutado a la Palanca 5
por su naturaleza no-prod) y la RI ya cubierta (`77,38 USD`) están **fuera** de la base direccionable,
sin doble conteo (Req 8.8).

### Veredicto Palanca 2

> **BARRIDO CONFIRMADO (steady-state completo).** El 100 % de la base direccionable
> (`5 096,40 USD/mes`) cumple el criterio de uso estable (todos los recursos al 100 % de horas). La
> Palanca 2 queda **elegible para objetivo comprometido**: su `Rango_Conservador` (`1 732,78 USD/mes`
> · `20 793,33 USD/año`) puede entrar en la derivación de objetivos (Req 18.4, 19.4). No es barrido
> parcial → no aplica el tratamiento "pendiente" del Req 18.3.
>
> **Pendiente acotado (no afecta al veredicto RDS):** la sub-línea adyacente **ElastiCache Reserved
> Nodes** (`411,22 USD/mes`, registro 4.3 §3) sigue **pendiente** de su `Verificacion_Recurso_Vivo`
> (`describe-cache-clusters` / `describe-reserved-cache-nodes`) y de su propio barrido; **no** forma
> parte de la base RDS de `5 096,40 USD` y, por tanto, no entra en objetivos comprometidos en esta
> edición.

---

## Síntesis del barrido (Tarea 16.1)

| Palanca | Base direccionable congelada | Cobertura del barrido | % horas (mínimo) | Veredicto | Elegible objetivo (Conservador) |
|---------|-----------------------------:|-----------------------|-----------------:|-----------|---------------------------------|
| **1 — EC2 SP** | `4 813,47 USD/mes` (18 rec.) | 100 % en segmento estable | **96,0 %** | **CONFIRMADO** | **Sí** — `1 347,77 USD/mes` · `16 173,27 USD/año` |
| **2 — RDS RI** | `5 096,40 USD/mes` (prod estable) | 100 % en segmento estable | **100 %** | **CONFIRMADO** | **Sí** — `1 732,78 USD/mes` · `20 793,33 USD/año` |

**Registro de evidencia (esquema del Catálogo_Evidencias):**

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-16.1-BARRIDO-STEADY` |
| `descripcion` | Barrido_Utilizacion de compromiso steady-state (uso estable ≥ 90 % de 744 h) que sostiene el % direccionable de las Palancas 1 (EC2 SP) y 2 (RDS RI), por `line_item_resource_id` |
| `consulta_cur` | Consultas del barrido EC2 y RDS (arriba) + desglose del estable RDS por cuenta |
| `query_execution_ids` | `2b579fc1-ff16-4dac-b258-39d459a4b7c3` (EC2), `e0d5fb2b-a62f-4ce1-81a4-dd57217c31fa` (RDS), `837da239-7c97-41a5-8186-3f1f5dc2f9b9` (RDS estable por cuenta); descartadas por método: `33692705-e48e-47f3-a193-fd75dc0e9bdc`, `994ad16d-4295-481b-b7fa-ec2f951a13ed` |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-24` (barrido) sobre el `Dataset_Congelado` `frozen-2026-05@2026-06-23` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` a nivel de segmento (18 recursos estables EC2; 38 recursos estables RDS — detalle por cuenta arriba) |
| `dimension_agregacion` | segmento {`stable_ge90pct`,`intermittent_burst`} sobre `line_item_resource_id`; medida `SUM(line_item_usage_amount)` (horas) y `SUM(line_item_unblended_cost)` |
| `verificacion_vivo` | Heredada: Palanca 1 `confirmado` (`EV-3.2`), Palanca 2 RDS `confirmado` (`EV-4.2-RDS-LIVE`); ElastiCache adyacente pendiente |
| `clasificacion` | Barrido **completo** para Palancas 1 y 2 → ambas elegibles para objetivo comprometido (Conservador). ElastiCache Reserved Nodes pendiente de barrido (fuera de objetivos) |

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23`. Todas las consultas
  canónicas con estado `SUCCEEDED` y `QueryExecutionId` retenidos.
- ✅ **Palanca 1 — CONFIRMADA**: base `4 813,47 USD` 100 % estable (mín. 96,0 % de horas).
- ✅ **Palanca 2 — CONFIRMADA**: base `5 096,40 USD` 100 % estable (todos los recursos a 744 h);
  reconcilia con la ecuación de conservación del Registro 4.3.
- ⚠️ **Salvedad (no afecta a las Palancas 1/2):** ElastiCache Reserved Nodes (`411,22 USD/mes`) sigue
  pendiente de verificación + barrido → fuera de los objetivos comprometidos de esta edición (Req 18.3).
- ⏭️ **Siguiente (fases 17/19):** registrar este barrido en el Catálogo_Evidencias y elevar los
  `Rango_Conservador` de las Palancas 1 y 2 a la derivación de objetivos comprometidos (Req 18.4, 19.4).
