# Registro de evidencia — Palanca 6 / Sub_Palanca 6a: Migración EBS gp2→gp3 (Tarea 8.1)

**Validates: Requirements 10.1, 10.2, 3.3, 4.1, 4.2, 4.3, 6.1**

> Artefacto auditable de **análisis FinOps** (no software). Congela el coste de los volúmenes EBS
> aún en `gp2` por cuenta, aplica la fórmula de **ahorro NETO** de la migración a `gp3` (restando el
> coste del rendimiento extra a aprovisionar en gp3 cuando el gp2 supera la línea base de gp3), lo
> clasifica como **Ahorro_Estimado** (rango Conservador–Agresivo, invariante `0 < Cons ≤ Agr`) y
> documenta los campos de la Palanca (Req 4). Todo anclado al `Dataset_Congelado`
> `frozen-2026-05@2026-06-23`.
>
> Palanca 6 es **mixta** → se parte en Sub_Palancas: **6a** gp2→gp3 (Estimado, este registro),
> **6b** snapshots (Estimado, Tarea 8.2), **6c** volúmenes huérfanos (Garantizado, Tarea 8.3). La
> conservación de costes base entre Sub_Palancas se audita en la Tarea 8.4 (Property 7 parcial).

## Parámetros de anclaje (Req 1.2, 1.3, 2.5)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-8.1-ebs-gp2-gp3-2026-05` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23T08:30:38Z` (UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Cuenta CUR | `600700800900` (root-iskaypet), `eu-west-1` |
| Motor / DB / tabla | Amazon Athena (CUR 2.0) · `athenacurcfn_finnops` / `data` |
| Rol de acceso | `Cur-AWSS3CURLambdaExecutor` (perfil `root-iskaypet` / `arn:aws:iam::600700800900:role/Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur`) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |

**Clasificación del registro:** cifra **agregada por dimensión** (Req 2.3) — coste de
almacenamiento gp2 sumado por `line_item_usage_account_id` (no atribuible a un único recurso). La
atribución por volumen (`vol-…`) y la confirmación del rendimiento aprovisionado pertenecen a la
**Verificacion_Recurso_Vivo** (`ec2 describe-volumes`), no ejecutada en esta tarea (ver
"Dependencia de verificación en vivo").

**Dimensión de agregación (Req 2.3):** `line_item_usage_account_id`; valor de agregación =
`SUM(line_item_unblended_cost)`, `SUM(line_item_net_unblended_cost)` y `SUM(line_item_usage_amount)`
(GB-mes).

## Consulta CUR exacta (re-ejecutable)

Consulta primaria (cifra congelada por cuenta), idéntica a la del `design.md` (Sub_Palanca 6a)
ampliada con `net_unblended`, GB-mes y conteo de líneas:

```sql
SELECT line_item_usage_account_id        AS account,
       SUM(line_item_unblended_cost)     AS gp2_unblended,
       SUM(line_item_net_unblended_cost) AS gp2_net,
       SUM(line_item_usage_amount)       AS gb_month,
       COUNT(*)                          AS line_items
FROM data
WHERE line_item_product_code = 'AmazonEC2'
  AND line_item_usage_type LIKE '%VolumeUsage.gp2%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

Consulta de refuerzo (descompone por `usage_type` para confirmar que las líneas gp2 son
**solo almacenamiento** — gp2 no factura IOPS ni throughput por separado — y para separar por
región):

```sql
SELECT line_item_usage_type          AS usage_type,
       SUM(line_item_unblended_cost) AS cost,
       SUM(line_item_usage_amount)   AS amount,
       COUNT(*)                      AS line_items
FROM data
WHERE line_item_product_code = 'AmazonEC2'
  AND line_item_usage_type LIKE '%VolumeUsage.gp2%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

## Comandos de ejecución re-ejecutables (Athena vía AWS CLI, credenciales por nombre de perfil — Req 7.5)

```bash
# Consulta primaria (cifra congelada por cuenta)
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "SELECT line_item_usage_account_id AS account, SUM(line_item_unblended_cost) AS gp2_unblended, SUM(line_item_net_unblended_cost) AS gp2_net, SUM(line_item_usage_amount) AS gb_month, COUNT(*) AS line_items FROM data WHERE line_item_product_code = 'AmazonEC2' AND line_item_usage_type LIKE '%VolumeUsage.gp2%' AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00' GROUP BY 1 ORDER BY 2 DESC;" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

## Ejecución congelada

| Métrica | Valor |
|---------|-------|
| `QueryExecutionId` (consulta primaria, por cuenta) | `ff91e28e-b7e4-4335-906c-9416bd4c6f30` |
| `QueryExecutionId` (consulta de refuerzo, por usage_type) | `649a9f61-0d8d-4c9d-8041-d7c048cad4f7` |
| Estado | `SUCCEEDED` |
| Datos escaneados (primaria) | `6 901 394` bytes |

## Resultado congelado — coste gp2 por cuenta (`Dataset_Congelado` = `frozen-2026-05@2026-06-23`, USD)

Importes con precisión completa de Athena; el total se suma **antes** de redondear (half-up, Req 6.7).
`unblended` ≡ `net_unblended` en el Mes_Referencia (sin divergencia a 2 decimales para gp2).

| # | Cuenta (ID) | Nombre (perfil) | gp2 unblended (USD) | gp2 net (USD) | GB-mes | Líneas |
|---|-------------|------------------|--------------------:|--------------:|-------:|-------:|
| 1 | 111122223333 | EKS Dev (eks-dev) | 336,521286 | 336,521285 | 3 325,31 | 976 |
| 2 | 333344445555 | EKS Prod (eks-prd) | 249,761600 | 249,761600 | 2 468,00 | 558 |
| 3 | 400500600700 | SAP (sap) | 184,993600 | 184,993600 | 1 828,00 | 279 |
| 4 | 222333444555 | Ecommerce Tiendanimal (ecommerce-tiendanimal) | 81,162400 | 81,162400 | 802,00 | 217 |
| 5 | 200300400500 | Iskaypet Data (iskaypet-data) | 76,650841 | 76,650841 | 757,42 | 9 410 |
| 6 | 999000111222 | Clinicanimal (clinicanimal) | 25,300000 | 25,300000 | 250,00 | 62 |
| 7 | 500600700800 | Sistemas Tiendanimal (sistemas-tiendanimal) | 19,783680 | 19,783680 | 192,00 | 124 |
| 8 | 444455556666 | EKS Tooling (eks-tooling) | 9,816400 | 9,816400 | 97,00 | 279 |
| 9 | 300400500600 | infraestructura (infra) | 9,512800 | 9,512800 | 94,00 | 93 |
| 10 | 100200300400 | Data desarrollo (data-dev) | 8,042147 | 8,042147 | 79,47 | 1 702 |
| 11 | 222233334444 | EKS UAT (eks-uat) | 6,476800 | 6,476800 | 64,00 | 93 |
| 12 | 888899990000 | Digital Ecommerce (digital-ecommerce) | 2,134400 | 2,134400 | 20,00 | 62 |
| 13 | 333444555666 | Iskaypet Ecommerce (iskaypet-ecommerce) | 1,600800 | 1,600800 | 15,00 | 62 |

**Total gp2 (sumado antes de redondear, half-up — Req 6.7):**
`Σ unblended = 1 011,76 USD/mes` · `Σ net = 1 011,76 USD/mes` · `Σ GB-mes = 9 992,20`.

> Concordancia con el `design.md`: el ejemplo trabajado declaraba **«gp2 $1.01k/mes»**, que coincide
> exactamente con el bruto congelado aquí (`1 011,76 USD`).

### Desglose por región (consulta de refuerzo)

| `usage_type` | Región | Coste (USD) | GB-mes | Líneas |
|--------------|--------|------------:|-------:|-------:|
| `EU-EBS:VolumeUsage.gp2` | eu-west-1 | 1 001,191474 | 9 893,20 | 13 731 |
| `EUW2-EBS:VolumeUsage.gp2` | eu-west-2 | 8,964480 | 84,00 | 124 |
| `EUW3-EBS:VolumeUsage.gp2` | eu-west-3 | 1,600800 | 15,00 | 62 |

Las **únicas** líneas gp2 son `VolumeUsage.gp2` (almacenamiento): **gp2 no factura IOPS ni
throughput por separado** (su rendimiento se deriva del tamaño). Por tanto el CUR por sí solo da el
GB-mes pero **no** el rendimiento aprovisionado por volumen → identificar los volúmenes que superan
la base gp3 exige verificación en vivo (ver más abajo). Tarifa gp2 efectiva observada:
`1 001,19 / 9 893,20 = 0,1012 USD/GB-mes` ≈ **precio público AWS de gp2 en eu-west-1 (0,10 USD/GB-mes)**.

## Origen del supuesto de descuento (Req 4.3) — precio público AWS, fecha 2026-06-23

| Concepto | Precio público AWS (eu-west-1) | Nota |
|----------|--------------------------------|------|
| gp2 — almacenamiento | `0,10 USD / GB-mes` | Sin facturación separada de IOPS/throughput |
| gp3 — almacenamiento | `0,08 USD / GB-mes` | **−20 %** frente a gp2 |
| gp3 — IOPS aprovisionadas por encima de 3 000 | `0,005 USD / IOPS-mes` | Las primeras 3 000 IOPS son gratis |
| gp3 — throughput por encima de 125 MiB/s | `0,040 USD / (MiB/s)-mes` | Los primeros 125 MiB/s son gratis |

Origen: **precio público AWS** (lista pública EBS, región Europe-Ireland `eu-west-1`), consultado el
`2026-06-23`. No se usa tarifa negociada.

## Fórmula de ahorro NETO (Req 10.1, 10.2)

```
Ahorro_neto = (Coste_gp2 − Coste_gp3_almacenamiento) − Coste_rendimiento_extra_gp3

donde:
  Coste_gp2                  = Σ gp2 unblended del Mes_Referencia = 1 011,76 USD/mes
  Coste_gp3_almacenamiento   = Σ GB-mes × 0,08 = 9 992,20 × 0,08 = 799,38 USD/mes
  Coste_rendimiento_extra_gp3 = Σ_volúmenes con base gp2 > base gp3 de:
        max(0, IOPS_gp2 − 3 000) × 0,005
      + max(0, throughput_gp2 − 125 MiB/s) × 0,040
```

**Ahorro bruto de almacenamiento** (sin penalización de rendimiento):
`1 011,76 − 799,38 = 212,38 USD/mes` → **21,0 %** del coste base gp2.
(El equivalente lista-a-lista gp2 0,10 → gp3 0,08 es exactamente **20,0 %** = `202,35 USD/mes`.)

**Ajuste por rendimiento extra (Req 10.2).** La base de gp3 incluye **3 000 IOPS + 125 MiB/s
gratis**. Un gp2 supera esa base cuando:
- **IOPS:** gp2 entrega `3 IOPS/GiB` (mín. 100, ráfaga hasta 3 000 por debajo de 1 000 GiB) → un gp2
  **> 1 000 GiB** tiene IOPS base > 3 000 y, para igualarlo en gp3, hay que aprovisionar
  `(3 × GiB − 3 000)` IOPS a `0,005 USD/IOPS-mes`.
- **Throughput:** gp2 de 170–1 000 GiB puede sostener hasta 250 MiB/s; preservar > 125 MiB/s en gp3
  cuesta `+125 MiB/s × 0,040 = +5 USD/volumen-mes`.

**Evidencia agregada del tamaño medio (del propio CUR):** el nº de volúmenes ≈ `líneas / 31 días`;
el tamaño medio ≈ `GB-mes / nº volúmenes`. En las mayores cuentas: eks-dev ≈ 31 vols · ~107 GiB
medio; eks-prd ≈ 18 vols · ~137 GiB; sap ≈ 9 vols · ~203 GiB. Todos **muy por debajo** del umbral de
1 000 GiB (IOPS base < 3 000), por lo que la penalización de IOPS esperada es **≈ 0** para el grueso
del parque. La penalización de throughput solo aplicaría a volúmenes 170–1 000 GiB que **sostengan**
> 125 MiB/s, cuyo recuento exacto requiere `ec2 describe-volumes` (no ejecutado en esta tarea).

### Dependencia de verificación en vivo (Req 5.1 — fuera del alcance de la Tarea 8.1)

El CUR de gp2 expone GB-mes pero **no** el rendimiento aprovisionado por volumen. La identificación
exacta de los volúmenes con base > 3 000 IOPS (> 1 000 GiB) o > 125 MiB/s, y por tanto el cálculo
**exacto** de `Coste_rendimiento_extra_gp3`, depende de una **Verificacion_Recurso_Vivo de solo
lectura** (`ec2 describe-volumes` → `Size`, `Iops`, `Throughput`, `VolumeType`, región `eu-west-1`).
Esa verificación se solapa con la de la Sub_Palanca 6c (Tarea 8.3) y se incorporará al consolidar la
Palanca; hasta entonces, el ajuste de rendimiento se trata como **reserva conservadora** dentro del
rango (no como cifra exacta).

## Clasificación: Ahorro_Estimado (Req 3.3, 6.1) — rango Conservador–Agresivo

La migración gp2→gp3 es **in situ y sin pérdida de capacidad** (cambio de tipo de volumen en
caliente), pero el **% neto** depende de supuestos (penalización de rendimiento a aprovisionar y
fracción efectivamente migrada) → se clasifica **Ahorro_Estimado** y se expresa como **rango**, nunca
como cifra única.

| Límite del rango | Supuesto | % neto sobre base gp2 | Ahorro mensual (USD) | Ahorro anualizado ×12 (USD) |
|------------------|----------|----------------------:|---------------------:|----------------------------:|
| **Rango_Conservador** | Delta de almacenamiento lista-a-lista (20 %) **menos** reserva de ~5 pp por rendimiento a aprovisionar en la cola de volúmenes grandes/de alto throughput y fracción no migrable a corto plazo → **15,0 %** | 15,0 % | **151,76** | **1 821,12** |
| **Rango_Agresivo** | Todo el GB-mes migra; penalización de rendimiento ≈ 0 (parque medio ~100–200 GiB, por debajo de la base gp3 de 3 000 IOPS / 125 MiB/s) → ahorro bruto de almacenamiento completo **21,0 %** | 21,0 % | **212,38** | **2 548,56** |

**Invariante (Req 3.3, 6.1):** `0 < Rango_Conservador (151,76) ≤ Rango_Agresivo (212,38)` ✅.

**Anualización (Req 6.3, 6.4):** cifras anuales = ahorro mensual del Mes_Referencia × 12.
**Advertencia explícita:** el método de multiplicar por 12 asume que mayo 2026 es un mes
representativo y **no captura estacionalidad** (variaciones de parque EBS a lo largo del año). El gp2
es almacenamiento relativamente estable, pero la cifra anual debe leerse como régimen estacionario,
no como compromiso.

## Documentación de la Palanca (Req 4)

| Campo (Req 4) | Valor |
|---------------|-------|
| **Supuesto de reducción** (Req 4.1, % 0–100, 1 decimal) | **15,0 %** (Conservador) – **21,0 %** (Agresivo) neto sobre el coste base gp2 |
| **% direccionable + coste base mensual afectado** (Req 4.2) | **100,0 %** del coste base gp2 es técnicamente direccionable (la migración gp2→gp3 es lossless e in situ); **coste base mensual afectado = 1 011,76 USD/mes** (9 992,20 GB-mes en 13 cuentas) |
| **Origen del supuesto + fecha** (Req 4.3) | **Precio público AWS** (lista pública EBS `eu-west-1`), fecha del dato **2026-06-23**. No es tarifa negociada |
| **Riesgo** (Req 4.4) | **bajo** — cambio de tipo de volumen en caliente, sin downtime ni pérdida de datos; único matiz: igualar IOPS/throughput en volúmenes que hoy dependen de la ráfaga de gp2 |
| **Esfuerzo** (Req 4.5) | **bajo** — `modify-volume` por volumen (automatizable); sin migración de datos |
| **Owner** (Req 4.6, 4.7) | **pendiente** (SRE por cuenta; transversal a los 13 propietarios de cuenta) |
| **Estado de Barrido_Utilizacion** | No requiere Barrido_Utilizacion de patrón 24/7; **sí** requiere la Verificacion_Recurso_Vivo de tamaños/rendimiento (`ec2 describe-volumes`) para cerrar el ajuste de rendimiento y fijar el % neto exacto |
| **Clasificación** | **Ahorro_Estimado** (rango) |

## Registro de evidencia (esquema del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-8.1-ebs-gp2-gp3-2026-05` |
| `descripcion` | Coste de volúmenes EBS gp2 por cuenta y ahorro NETO estimado de la migración a gp3 (Sub_Palanca 6a) |
| `cifra_publicada` | Coste base gp2 = `1 011,76 USD/mes`; Ahorro_Estimado neto = `151,76 USD/mes` (Cons, 15,0 %) – `212,38 USD/mes` (Agr, 21,0 %); anualizado `1 821,12` – `2 548,56 USD` |
| `consulta_cur` | Consulta primaria (por cuenta) + consulta de refuerzo (por usage_type) de este registro |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:30:38Z` (UTC) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` (cifra agregada por cuenta; la atribución por `vol-…` corresponde a la Verificacion_Recurso_Vivo `ec2 describe-volumes`, no ejecutada en esta tarea) |
| `dimension_agregacion` | `line_item_usage_account_id`; valor = `SUM(line_item_unblended_cost)` / `SUM(line_item_net_unblended_cost)` / `SUM(line_item_usage_amount)` |
| `verificacion_vivo` | `pendiente` — `ec2 describe-volumes` (solo lectura, `eu-west-1`) para tamaños y rendimiento por volumen; necesaria para cerrar `Coste_rendimiento_extra_gp3` (Req 10.2) |
| `clasificacion` | `estimado` (Ahorro_Estimado, rango) |

## Notas metodológicas

- El filtro `line_item_usage_type LIKE '%VolumeUsage.gp2%'` aísla **solo almacenamiento gp2**
  (excluye gp3, io1/io2, st1, sc1, snapshots e IOPS/throughput). Confirmado por la consulta de
  refuerzo: las 3 únicas variantes son `EU/EUW2/EUW3-EBS:VolumeUsage.gp2`.
- gp2 **no** tiene líneas de IOPS/throughput facturadas por separado (su rendimiento se deriva del
  tamaño), por lo que el ajuste de rendimiento de Req 10.2 no se puede calcular desde el CUR y se
  trata como reserva conservadora del rango hasta la verificación en vivo.
- No se ejecuta ninguna acción mutante: esta tarea solo lee el CUR vía Athena (describe/list/get y
  consultas Athena de solo lectura).
- Sin doble conteo con otras Sub_Palancas: 6a cubre `VolumeUsage.gp2` (almacenamiento de volúmenes
  activos); 6b cubre `SnapshotUsage` (snapshots); 6c cubre volúmenes `available` (huérfanos). Los
  conjuntos de `usage_type`/estado son disjuntos (auditoría en Tarea 8.4, Property 7 parcial).

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23` el `2026-06-23T08:30:38Z`.
- Cifras congeladas y reproducibles: re-ejecutar la consulta documentada sobre el mismo
  Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría en
  Tarea 17.6).
- ⏳ **Pendiente** (fuera del alcance de la Tarea 8.1): Verificacion_Recurso_Vivo `ec2 describe-volumes`
  para fijar el `Coste_rendimiento_extra_gp3` exacto y estrechar el rango; asignación de owner.
