# Barrido_Utilizacion — Scheduling y Spot no-prod (Palancas 5 y 10) — Tarea 16.3

> Artefacto auditable y **dedicado** de la **Tarea 16.3** del Estudio FinOps de Ahorro AWS. Ejecuta
> el **Barrido_Utilizacion de scheduling/Spot no productivo** que sostiene el % direccionable de la
> **Palanca 5 (Aurora no-prod de Helios)** y la **Palanca 10 (scheduling + Spot no-prod)**: confirma,
> por cuenta/recurso, el **perfil 24/7 vs intermitente** y las **horas reducibles defendibles** antes
> de que el Ahorro_Estimado de cada Palanca pueda elevarse a **objetivo comprometido**.
>
> Este fichero es el **registro propio** de la Tarea 16.3. **No** modifica `catalogo-evidencias.md`
> ni ningún `palanca-*.md` ni los otros `barrido-16-*.md` (esos artefactos están congelados; este
> barrido los referencia, no los reescribe). La elevación efectiva a objetivo y la actualización del
> Catálogo_Evidencias / derivación de objetivos se realizan en las fases 17/19.
>
> **Validates: Requirements 18.1, 18.3, 18.4, 15.5**
>
> Gating: **Palancas 5 y 10**.

## Parámetros de anclaje (heredados del Dataset_Congelado)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Horas de la ventana | **744 h** (31 días) |
| Umbral "uso estable" (Req 8.4, reutilizado) | **≥ 90 % → ≥ 669,6 h** (`0,90 × 744`) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Fecha-hora de ejecución del barrido (UTC) | `2026-06-23T11:19:41Z` |
| Fecha-hora (Europe/Madrid, CEST) | `2026-06-23T13:19:41+02:00` |
| Moneda | `USD` (half-up, 2 decimales; suma antes de redondear, Req 6.7) |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND < TIMESTAMP '2026-06-01 00:00:00'` |

## Cadena de acceso a datos (reproducibilidad — Req 7.1, 7.2)

| Parámetro | Valor |
|-----------|-------|
| Motor (cifras CUR) | Amazon Athena (CUR 2.0) · DB/tabla `athenacurcfn_finnops` / `data` · región `eu-west-1` |
| Cuenta CUR | `600700800900` (root-iskaypet) · rol `Cur-AWSS3CURLambdaExecutor` (perfil `root-iskaypet`) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |
| Verificación viva (solo lectura) | SSO SRE por nombre de perfil (`helios-dev`, `helios-uat`), rol `AWSReservedSSO_SRE`; `rds describe-db-clusters`, `cloudwatch get-metric-statistics`; **sin credenciales incrustadas** (Req 7.5) |
| Unidad de horas | `SUM(line_item_usage_amount)` (instancia-horas del mes) — **NO** `COUNT(DISTINCT fechas)` |

> **Nota metodológica (unidad de medida).** Las horas se miden con `SUM(line_item_usage_amount)`
> (instancia-horas), idéntica unidad a los barridos 16.1/16.2. `COUNT(DISTINCT date(...))` se usa
> **solo** como divisor para normalizar a horas/día por día de la semana (no como medida de horas).
> Las líneas CUR de cómputo de este dataset son **diarias** (1 por recurso y día), por lo que **no**
> es posible reconstruir un perfil **horario** (08:00–20:00) desde el CUR; el barrido usa el perfil
> **por día de la semana** (laborable vs fin de semana) como mejor proxy disponible, complementado
> con métricas vivas de CloudWatch (RDS) para la Palanca 5.

---

## Palanca 5 — Aurora no productivo de Helios (gating Palanca 5)

**Entrada (congelada, `palanca-05-aurora-helios.md`, Tareas 7.1/7.2/7.3):** 4× `db.r6g.large`
(writer + reader en `helios-dev` `555566667777` y `helios-uat` `666677778888`), `MultiAZ=false`,
**24/7**, base **851,14 USD/mes bruto** (783,05 neto); resource-verified; Estimado (rango)
**425,57 – 723,47 USD/mes** bruto; marcada "requiere Barrido_Utilizacion". El barrido debe confirmar
las **horas activas del reader** (¿24/7 reducible a horario laboral / apagado nocturno / eliminación
con consolidación de lecturas en el writer?).

### Consulta del barrido — horas por recurso (re-ejecutable)

```sql
SELECT line_item_usage_account_id        AS acct,
       line_item_resource_id             AS resource,
       SUM(line_item_usage_amount)        AS hours,
       SUM(line_item_unblended_cost)      AS unblended,
       COUNT(*)                           AS line_items
FROM data
WHERE line_item_product_code = 'AmazonRDS'
  AND line_item_usage_type LIKE '%InstanceUsage%'
  AND line_item_line_item_type IN ('Usage','DiscountedUsage')
  AND line_item_usage_account_id IN ('555566667777','666677778888')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2
ORDER BY 1, 2;
```

- `QueryExecutionId`: **`205a3b9d-eab1-4201-abe3-38b620fca002`** · Estado `SUCCEEDED` · escaneado `9 832 738` bytes.

### Resultado del barrido (congelado) — perfil 24/7 por recurso

| Cuenta (ID) | Recurso (instancia) | Rol clúster | Horas | Unblended (USD) | Líneas | Perfil |
|-------------|---------------------|-------------|------:|----------------:|-------:|--------|
| 555566667777 (helios-dev) | `…golden-record-db-aurora-0` | writer | **744,0** | 212,78 | 31 | **24/7** |
| 555566667777 (helios-dev) | `…golden-record-db-aurora-1` | **reader** | **744,0** | 212,78 | 31 | **24/7** |
| 666677778888 (helios-uat) | `…golden-record-db-aurora-0` | **reader** | **744,0** | 212,78 | 31 | **24/7** |
| 666677778888 (helios-uat) | `…golden-record-db-aurora-1` | writer | **744,0** | 212,78 | 31 | **24/7** |

**Lectura:** las **4 instancias** (incluidos los **2 readers**) están presentes el **100 % del mes**
(744 h = 744 h, 31/31 líneas diarias). Los readers son réplicas de lectura **dedicadas 24/7** en
entornos no productivos.

### Verificación viva (solo lectura) — utilización real del reader y holgura del writer

Para decidir si las horas del reader son **defendiblemente reducibles**, se midió la utilización real
de las 4 instancias en el Mes_Referencia vía CloudWatch (solo lectura, `get-metric-statistics`), y se
reconfirmó la topología writer/reader (`describe-db-clusters`). Fecha-hora: `2026-06-23T11:19:41Z`.

```bash
# Topología viva (writer/reader) — solo lectura
aws rds describe-db-clusters --profile helios-dev --region eu-west-1 \
  --query "DBClusters[?contains(DBClusterIdentifier,'golden-record')].{Cluster:DBClusterIdentifier,Members:DBClusterMembers[].{Id:DBInstanceIdentifier,Writer:IsClusterWriter},Status:Status}"
aws rds describe-db-clusters --profile helios-uat --region eu-west-1 \
  --query "DBClusters[?contains(DBClusterIdentifier,'golden-record')].DBClusterMembers[].{Id:DBInstanceIdentifier,Writer:IsClusterWriter}"

# Utilización real (solo lectura) — período mensual (2592000 s) sobre el Mes_Referencia
aws cloudwatch get-metric-statistics --profile <helios-dev|helios-uat> --region eu-west-1 \
  --namespace AWS/RDS --metric-name DatabaseConnections \
  --dimensions Name=DBInstanceIdentifier,Value=<instancia> \
  --start-time 2026-05-01T00:00:00Z --end-time 2026-06-01T00:00:00Z \
  --period 2592000 --statistics Average Maximum Minimum
aws cloudwatch get-metric-statistics --profile <helios-dev|helios-uat> --region eu-west-1 \
  --namespace AWS/RDS --metric-name CPUUtilization \
  --dimensions Name=DBInstanceIdentifier,Value=<instancia> \
  --start-time 2026-05-01T00:00:00Z --end-time 2026-06-01T00:00:00Z \
  --period 2592000 --statistics Average Maximum
```

> Topología viva reconfirmada (drift esperado, Req 7.6): helios-dev → writer `aurora-0` + reader
> `aurora-1` (`available`); helios-uat → reader `aurora-0` + writer `aurora-1`. Coincide con la
> Tarea 7.2.

| Cuenta | Instancia | Rol | Conexiones (avg / máx / mín) | CPU % (avg / máx) | Lectura |
|--------|-----------|-----|------------------------------|-------------------|---------|
| helios-dev | `aurora-0` | writer | — | **~9–10 / 57–72** | infrautilizado, gran holgura |
| helios-dev | `aurora-1` | **reader** | **16–24 / 64 / 0** | **~10 / 63–65** | con tráfico de lectura real; con valles ociosos (mín 0) |
| helios-uat | `aurora-0` | **reader** | **15,5–24,4 / 62 / 0** | **~10 / 57–65** | con tráfico de lectura real; con valles ociosos (mín 0) |
| helios-uat | `aurora-1` | writer | — | **~10 / 61–99,6** | infrautilizado en media; un pico puntual al 99,6 % |

**Hallazgos para defender las horas reducibles (Req 15.5):**

1. **Los readers NO son waste puro:** llevan tráfico de lectura real (avg ~16–24 conexiones), por lo
   que su eliminación **no es de coste cero / riesgo cero** — exige repuntar el endpoint de lectura
   de la aplicación dev/uat al writer. Esto mantiene la Palanca como **Estimado** (no Garantizado),
   coherente con `palanca-05`.
2. **Consolidación viable (writer absorbe lecturas):** writer y reader operan a **~10 % de CPU media**
   con ~90 % de holgura; el writer puede absorber la carga del reader (suma ≈ 20 % media). El pico
   puntual del writer uat (99,6 %) obliga a validar el manejo de picos, pero la media respalda la
   consolidación.
3. **Valles ociosos confirmados (mín conexiones = 0):** existen franjas sin conexiones → respaldan
   tanto la **eliminación con consolidación** (Conservador) como un **apagado nocturno** del reader
   (componente del Agresivo), si bien el apagado del **writer** sigue dependiendo de confirmar la
   ausencia de **jobs nocturnos** (golden-record sync) — owner-dependiente, **no** resoluble desde
   métricas.

### Veredicto Palanca 5

> **BARRIDO COMPLETO para el Rango_Conservador (eliminación del reader, 50,0 %).** Las **horas
> reducibles están confirmadas y son defendibles**: los 2 readers corren **24/7 (744 h)** en no-prod
> sin necesidad de escalado de lectura, con tráfico modesto (avg ~16–24 conexiones, valles a 0) que
> el **writer puede absorber** (holgura de CPU ~90 %). La acción Conservadora (eliminar el reader y
> consolidar lecturas en el writer) queda **defendida por evidencia** → la Palanca 5 es **elegible
> para objetivo comprometido en su Rango_Conservador**: **425,57 USD/mes bruto** (`391,52` neto) ·
> **5 106,82 USD/año** bruto (`4 698,27` neto).
>
> **Extras del Rango_Agresivo siguen Estimados (no comprometibles):** el **downsize** un escalón
> (`db.r6g.large`→`medium`) está respaldado por la CPU media ~10 % pero **acotado** por los picos
> (máx 57–99,6 %); el **scheduling off-hours del writer** depende de confirmar la ausencia de jobs
> nocturnos (owner Helios). Por tanto el tramo `>50 %–85 %` permanece como **rango estimado**, no
> como objetivo comprometido (Req 18.2). No es barrido parcial de la Palanca: el Conservador queda
> plenamente sostenido.

---

## Palanca 10 — Scheduling y Spot no-prod (gating Palanca 10)

**Entrada (congelada, `palanca-10-noprod-spot.md`, Tareas 12.1/12.2/12.3):** base direccionable
**disjunta** de la Palanca 1 = **856,39 USD/mes** (`eks-dev` 538,35 + `eks-uat` 225,70 + `data-dev`
92,35 on_demand), Spot no-prod = **0 h / $0**. Partición en Sub_Palanca **10a Scheduling** (`$764,05`,
eks-dev+eks-uat) y **10b Spot** (`$92,35`, EMR TASK data-dev). Estimado **252,30 – 542,80 USD/mes**;
marcada "requiere Barrido_Utilizacion". El barrido debe confirmar **qué horas no-prod son reducibles**
(excluyendo QA compartido, jobs nocturnos y stateful/sin tolerancia a Spot).

### Consulta 1 del barrido — perfil por día de la semana (re-ejecutable)

Mide si la capacidad `on_demand` no-prod sigue un **perfil de horario laboral** (caída en fin de
semana → poca hora adicional reducible por calendario) o es **plana/elevada en fin de semana**
(capacidad presente los 7 días).

```sql
SELECT line_item_usage_account_id                      AS acct,
       day_of_week(line_item_usage_start_date)         AS dow,  -- 1=Lun … 7=Dom
       SUM(line_item_usage_amount)                      AS hours,
       SUM(line_item_unblended_cost)                    AS unblended,
       COUNT(DISTINCT date(line_item_usage_start_date)) AS days  -- divisor de normalización
FROM data
WHERE line_item_product_code = 'AmazonEC2'
  AND line_item_usage_type LIKE '%BoxUsage%'
  AND line_item_line_item_type IN ('Usage','DiscountedUsage')
  AND line_item_usage_account_id IN ('111122223333','222233334444','100200300400')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2
ORDER BY 1, 2;
```

- `QueryExecutionId`: **`0d3b1059-6a78-4633-b940-896a14b89ee4`** · Estado `SUCCEEDED` · escaneado `4 978 500` bytes.

Resultado normalizado a **horas/día** (mayo 2026: Lun–Jue = 4 días; Vie/Sáb/Dom = 5 días):

| Cuenta | Lun | Mar | Mié | Jue | Vie | **Sáb** | **Dom** | Lectura |
|--------|----:|----:|----:|----:|----:|--------:|--------:|---------|
| `111122223333` eks-dev | 84,5 | 91,9 | 97,0 | 75,8 | 91,1 | **97,6** | **137,2** | fin de semana **≥** laborable |
| `222233334444` eks-uat | 36,1 | 29,3 | 39,6 | 26,5 | 26,7 | **35,4** | **43,2** | fin de semana **≥** laborable |
| `100200300400` data-dev | 16,1 | 20,0 | 14,9 | 6,4 | 7,0 | **0** | **4,1** | esporádico (batch EMR) |

**Hallazgo (Req 15.5):** la capacidad `on_demand` no-prod de eks-dev/eks-uat **no presenta un perfil
de horario laboral**: las horas/día de **sábado y domingo son iguales o superiores** a las de los
días laborables. No hay caída de fin de semana que "ya esté capturada" por el autoscaler, pero
tampoco un patrón 08:00–20:00 reducible por calendario: la capacidad es **demand-driven** (el
cluster-autoscaler la arranca/para según pods) y se reparte por los **7 días**. `data-dev` es batch
EMR esporádico (incluso días a 0).

### Consulta 2 del barrido — segmentación estable vs intermitente del `on_demand` no-prod

```sql
WITH od AS (
  SELECT line_item_resource_id AS rid, line_item_usage_account_id AS acct,
         SUM(line_item_usage_amount) AS hours, SUM(line_item_unblended_cost) AS cost
  FROM data
  WHERE line_item_product_code = 'AmazonEC2'
    AND line_item_usage_type LIKE '%BoxUsage%'
    AND line_item_line_item_type IN ('Usage','DiscountedUsage')
    AND line_item_usage_account_id IN ('111122223333','222233334444','100200300400')
    AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
    AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
  GROUP BY 1, 2)
SELECT acct,
       CASE WHEN hours >= 669.6 THEN 'stable_ge90pct' ELSE 'intermittent_burst' END AS segment,
       COUNT(*) AS resources, SUM(hours) AS hours, SUM(cost) AS cost,
       MAX(hours) AS max_hours_one_resource
FROM od GROUP BY 1, 2 ORDER BY 1, 2;
```

- `QueryExecutionId`: **`96e7baa8-83b3-4190-92d5-20842d2a0889`** · Estado `SUCCEEDED` · escaneado `9 793 584` bytes.

| Cuenta | Segmento | Recursos | Horas | Coste (USD) | Máx. horas (1 recurso) |
|--------|----------|---------:|------:|------------:|-----------------------:|
| `111122223333` eks-dev | `intermittent_burst` | 267 | 3 026,02 | 538,35 | **226,09** |
| `222233334444` eks-uat | `intermittent_burst` | 31 | 1 052,54 | 225,70 | **190,13** |
| `100200300400` data-dev | `intermittent_burst` | 304 | 241,39 | 92,35 | **4,09** |

**Hallazgo (Req 15.1):** el **100 %** de la base `on_demand` no-prod es **intermitente**: **ningún**
recurso alcanza el umbral estable (≥ 669,6 h); el más persistente vive **226 h** (de 744). Es un
parque de instancias de vida corta que el autoscaler recicla — confirma en CUR el hallazgo vivo de la
Tarea 12.2 (los `InstanceId` rotan).

### Implicación para el scheduling (Sub_Palanca 10a) — horas reducibles NO defendibles desde facturación

La base `on_demand` de 10a (`$764,05`) **no sostiene** un supuesto de horas reducibles defendible por
evidencia, por dos razones convergentes:

1. **Es capacidad demand-driven, no 24/7-plana.** El `on_demand` es churn del autoscaler (267+31
   recursos < 226 h), presente los 7 días sin perfil laboral. Un apagado por **calendario** encima de
   un autoscaler que **ya** dimensiona por demanda solo ahorraría donde haya cargas planificadas
   fuera de horario que sean **prescindibles** — determinación que exige **calendarios por workload /
   nodegroup** (qué se puede pausar de noche/fin de semana), **no derivable del CUR**.
2. **La capacidad 24/7-plana realmente schedulable está bajo compromiso (SP).** El baseline continuo
   de los nodegroups eks-dev/eks-uat se factura como `sp_covered` (~$1 464,66 + $883,09/mes,
   territorio Palancas 1/2), no como `on_demand`. **Apagarlo no ahorra a corto plazo**: el Savings
   Plan se sigue pagando (commitment varado) hasta su vencimiento. La granularidad **diaria** del CUR
   además impide aislar la ventana 08:00–20:00 que sustentaría el uptime ≈ 35,7 % del escenario.

→ **10a Scheduling: horas reducibles NO confirmadas** (requiere calendarios por workload + análisis
de runway del SP, fuera del alcance de datos de este barrido). **PENDIENTE.**

### Implicación para el Spot (Sub_Palanca 10b) — tolerancia a interrupción CONFIRMADA

La base de 10b (`$92,35`, `data-dev`) son **nodos EMR TASK** (`emr-medium-laura`, `environment=dev`),
**verificados en vivo** (Tarea 12.2, Evidencia F: lanzados/terminados en minutos, On-Demand,
`InstanceLifecycle=null`) y corroborados aquí por el perfil esporádico (Consulta 1: días a 0). Los
nodos **TASK** no alojan HDFS y EMR re-planifica sus tareas ante interrupción → **toleran Spot por
diseño** (Req 15.3). Exclusiones de Spot registradas (Req 15.4): EMR MASTER/CORE (stateful, matan el
job), cargas stateful dev/uat y servicios sin tolerancia a interrupción.

→ **10b Spot: tolerancia a interrupción confirmada** para la capacidad EMR TASK. No obstante, el
ahorro por Spot es **Estimado siempre** (Req 15.6) y la base es **inmaterial** (`$92,35`, 10,8 % de
la Palanca 10).

### Veredicto Palanca 10

> **BARRIDO PARCIAL → Palanca 10 PENDIENTE a efectos de objetivo comprometido (Req 18.3).**
> - **10a Scheduling (`$764,05`, 89,2 % de la base): PENDIENTE.** Las horas reducibles **no son
>   defendibles** desde la facturación: la base `on_demand` es 100 % intermitente/demand-driven
>   (autoscaler), sin perfil laboral y repartida los 7 días; la capacidad 24/7-plana realmente
>   schedulable está bajo Savings Plan (apagarla no ahorra a corto plazo). Determinar horas
>   reducibles exige calendarios por workload + runway del SP, no disponibles aquí.
> - **10b Spot (`$92,35`, 10,8 %): tolerancia confirmada** (EMR TASK), pero Estimado siempre
>   (Req 15.6) e inmaterial.
>
> Como la sub-palanca mayoritaria (10a) queda **sin barrido completo**, por el **Req 18.3** la
> **Palanca 10 se trata como pendiente** y **NO entra en el Objetivo_Comprometido** (Req 18.2). Su
> ahorro **252,30 – 542,80 USD/mes** se mantiene **solo como rango estimado**.

### Acciones para cerrar el barrido de la Palanca 10 (no parte de esta tarea)

1. Recoger, por nodegroup no-prod (eks-dev/eks-uat), el **calendario de workloads** apagables fuera
   de horario (qué cargas dev/uat pueden pausarse noches/fines de semana sin romper QA ni CI/CD
   nocturno) — input de squads (Digital/Helios/Comerzzia) + SRE.
2. Analizar el **runway del Savings Plan** que cubre el baseline: cuándo vence y qué capacidad podría
   no recomprometerse para que el scheduling rinda ahorro neto.
3. Configurar/medir **EMR instance fleets con Spot** en `data-dev` y registrar el % de capacidad TASK
   efectivamente desplazable a Spot de forma estable.

---

## Síntesis del barrido (Tarea 16.3)

| Palanca | Base direccionable congelada | Perfil confirmado | Horas reducibles defendibles | Veredicto | Elegible objetivo (Conservador) |
|---------|------------------------------|-------------------|------------------------------|-----------|---------------------------------|
| **5 — Aurora no-prod Helios** | `851,14 USD/mes` bruto (4× `db.r6g.large` 24/7) | reader 24/7 (744 h), con tráfico real y valles a 0; writer con holgura ~90 % | **Sí** — eliminación del reader con consolidación en writer | **COMPLETO (Conservador)** | **Sí** — `425,57 USD/mes` bruto (`391,52` neto) · `5 106,82 USD/año` |
| **10 — Scheduling + Spot no-prod** | `856,39 USD/mes` (10a `764,05` + 10b `92,35`) | `on_demand` 100 % intermitente, demand-driven, 7 días; baseline 24/7 bajo SP; EMR TASK Spot-tolerante | **10a no; 10b sí (inmaterial)** | **PARCIAL → PENDIENTE** | **No** (Req 18.3) |

**Registro de evidencia (esquema del Catálogo_Evidencias — Req 2.x, 18.4):**

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-16.3-BARRIDO-SCHED-SPOT` |
| `descripcion` | Barrido_Utilizacion de scheduling/Spot no-prod (Palancas 5 y 10): perfil 24/7 vs intermitente y horas reducibles defendibles. Palanca 5 → reader 24/7 con utilización viva (CloudWatch) y holgura del writer → Conservador (eliminación reader) defendido. Palanca 10 → `on_demand` no-prod 100 % intermitente/demand-driven (sin perfil laboral; baseline schedulable bajo SP) → 10a scheduling pendiente; 10b Spot (EMR TASK) tolerancia confirmada pero inmaterial |
| `consulta_cur` | Consulta del barrido P5 (horas por recurso Aurora) + P10 Consulta 1 (perfil por día de la semana) + P10 Consulta 2 (segmentación estable/intermitente) — arriba |
| `query_execution_ids` | `205a3b9d-eab1-4201-abe3-38b620fca002` (P5 horas/recurso), `0d3b1059-6a78-4633-b940-896a14b89ee4` (P10 día-de-semana), `96e7baa8-83b3-4190-92d5-20842d2a0889` (P10 segmentación) |
| `verificacion_viva` | `rds describe-db-clusters` (helios-dev, helios-uat) + `cloudwatch get-metric-statistics` (DatabaseConnections, CPUUtilization de las 4 instancias Aurora), solo lectura, `eu-west-1`, `2026-06-23T11:19:41Z`. Para Palanca 10 se hereda `EV-12.2-*` (`ec2 describe-instances`, `2026-06-23T08:59:37Z`) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T11:19:41Z` (barrido) sobre el `Dataset_Congelado` `frozen-2026-05@2026-06-23` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recursos` | **P5:** `arn:…:db:helios-dev-golden-record-db-aurora-0/-1`, `arn:…:db:helios-uat-golden-record-db-aurora-0/-1` (4 instancias). **P10:** `no atribuible a recurso` (agregado cuenta × opción; detalle vivo por instancia en `EV-12.2-*`) — cuentas `111122223333`, `222233334444`, `100200300400` |
| `dimension_agregacion` | P5: `line_item_resource_id`, medida `SUM(line_item_usage_amount)`; P10: `line_item_usage_account_id` × día-de-semana y segmento {`stable_ge90pct`,`intermittent_burst`}, medida `SUM(line_item_usage_amount)` |
| `clasificacion` | **Palanca 5: barrido COMPLETO (Conservador)** → elegible para objetivo comprometido (`425,57 USD/mes` bruto); extras Agresivo siguen Estimado. **Palanca 10: barrido PARCIAL → PENDIENTE** (Req 18.3) → fuera del Objetivo_Comprometido; rango Estimado `252,30 – 542,80 USD/mes` se mantiene |

## Estado de ejecución (Tarea 16.3)

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23` el `2026-06-23T11:19:41Z`
  (UTC). Tres consultas CUR con estado `SUCCEEDED` y `QueryExecutionId` retenidos; verificación viva
  de solo lectura (RDS describe + CloudWatch) sin operaciones mutantes (Req 5.1, 7.5, Property 11).
- ✅ **Palanca 5 — BARRIDO COMPLETO (Conservador).** Reader 24/7 (744 h) confirmado; utilización viva
  (conexiones avg ~16–24, valles a 0; CPU ~10 % en las 4 instancias con holgura del writer ~90 %)
  defiende la eliminación del reader con consolidación de lecturas → Conservador **`425,57 USD/mes`
  bruto** (`391,52` neto) · **`5 106,82 USD/año`** **elegible** para objetivo comprometido. Extras del
  Agresivo (downsize + scheduling del writer) permanecen Estimado.
- 🔶 **Palanca 10 — BARRIDO PARCIAL → PENDIENTE.** `on_demand` no-prod 100 % intermitente/demand-driven
  (máx 226 h/recurso), sin perfil laboral y repartido los 7 días; el baseline 24/7 schedulable está
  bajo Savings Plan. 10a (scheduling, 89,2 %) sin horas reducibles defendibles; 10b (Spot EMR TASK,
  10,8 %) tolerante a interrupción pero inmaterial y Estimado siempre. Por Req 18.3 la Palanca **queda
  fuera** del Objetivo_Comprometido; su rango `252,30 – 542,80 USD/mes` se mantiene como Estimado.
- ⏭️ **Siguiente (fases 17/19):** registrar este barrido en el Catálogo_Evidencias (Req 18.4) y elevar
  **solo** el `Rango_Conservador` de la **Palanca 5** (`425,57 USD/mes`) a la derivación de objetivos
  comprometidos; la **Palanca 10** se presenta como rango estimado, fuera de objetivos (Req 18.2, 18.5).
- Reproducibilidad (Req 7.3): re-ejecutar las consultas documentadas sobre el mismo Mes_Referencia y
  Dataset_Congelado debe producir diferencia `0,00 USD`; el drift del recurso vivo (CloudWatch/RDS)
  respecto a mayo 2026 es esperado y no altera las cifras ancladas (Req 7.6).
