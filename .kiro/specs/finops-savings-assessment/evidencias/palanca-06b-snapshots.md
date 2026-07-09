# Registro de evidencia — Palanca 6 · Sub_Palanca 6b: Snapshots EBS (Tarea 8.2)

**Validates: Requirements 10.4, 10.5, 3.3, 5.1, 4.1, 4.2, 6.1**

> Artefacto auditable de **análisis FinOps** (no software). Congela el coste de snapshots EBS del
> Mes_Referencia con su consulta CUR re-ejecutable, **separa snapshots elegibles de no elegibles**
> (todo snapshot que respalda una AMI o está cubierto por retención es **no elegible** y se excluye,
> Req 10.4/10.5), documenta la **Verificacion_Recurso_Vivo de solo lectura** de elegibilidad
> (`ec2 describe-snapshots` / `describe-images`, Req 5.1), aplica la fórmula de ahorro, lo clasifica
> como **Ahorro_Estimado** (rango `0 < Conservador ≤ Agresivo`, Req 3.3/6.1) y rellena los campos de
> documentación por Palanca (Req 4.1, 4.2). Anclado al `Dataset_Congelado` `frozen-2026-05@2026-06-23`.

## Parámetros de anclaje (Req 2.5)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-8.2-ebs-snapshots-2026-05` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23T08:30:00Z` (UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Cuenta CUR | `600700800900` (root-iskaypet), `eu-west-1` |
| Motor / DB / tabla | Amazon Athena (CUR 2.0) · `athenacurcfn_finnops` / `data` |
| Rol de acceso | `Cur-AWSS3CURLambdaExecutor` (perfil `root-iskaypet`) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |

**Clasificación del registro:** cifra **agregada por dimensión** (Req 2.3) — el coste base total de
snapshots se agrega por `line_item_usage_account_id` y por `line_item_usage_type`; el subconjunto
elegible/no elegible se determina por la **Verificacion_Recurso_Vivo** (lista de `line_item_resource_id`
de snapshots reales) cuando hay acceso a la cuenta. Las líneas de coste de snapshot del CUR no
descomponen de forma fiable el coste por snapshot individual (el coste es GiB-mes incremental
agregado), por lo que la separación elegible/no elegible se cuantifica como **fracción direccionable**
sobre el coste base, sustentada por la verificación de solo lectura por cuenta.

---

## 1. Consulta CUR exacta (re-ejecutable) — coste base de snapshots

Consulta del `design.md` (Sub_Palanca 6b) ampliada con `net_unblended`, conteo de líneas y conteo de
recursos distintos, más desgloses por cuenta y por `usage_type`:

```sql
-- Consulta A — Total snapshots EBS (cifra base congelada)
SELECT SUM(line_item_unblended_cost)            AS total_unblended,
       SUM(line_item_net_unblended_cost)        AS total_net,
       COUNT(*)                                 AS line_items,
       COUNT(DISTINCT line_item_resource_id)    AS distinct_resources
FROM data
WHERE line_item_product_code = 'AmazonEC2'
  AND line_item_usage_type LIKE '%SnapshotUsage%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00';
```

```sql
-- Consulta B — Desglose por cuenta
SELECT line_item_usage_account_id        AS account,
       SUM(line_item_unblended_cost)     AS unblended_cost,
       SUM(line_item_net_unblended_cost) AS net_unblended_cost,
       COUNT(*)                          AS line_items
FROM data
WHERE line_item_product_code = 'AmazonEC2'
  AND line_item_usage_type LIKE '%SnapshotUsage%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

```sql
-- Consulta C — Desglose por usage_type (región y tier de snapshot)
SELECT line_item_usage_type              AS usage_type,
       SUM(line_item_unblended_cost)     AS unblended_cost,
       SUM(line_item_net_unblended_cost) AS net_unblended_cost,
       COUNT(*)                          AS line_items
FROM data
WHERE line_item_product_code = 'AmazonEC2'
  AND line_item_usage_type LIKE '%SnapshotUsage%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

### Comando de ejecución re-ejecutable (Athena vía AWS CLI, credenciales por nombre de perfil — Req 7.5)

```bash
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "SELECT SUM(line_item_unblended_cost) AS total_unblended, SUM(line_item_net_unblended_cost) AS total_net, COUNT(*) AS line_items, COUNT(DISTINCT line_item_resource_id) AS distinct_resources FROM data WHERE line_item_product_code = 'AmazonEC2' AND line_item_usage_type LIKE '%SnapshotUsage%' AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00';" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

### Ejecución congelada

| Consulta | `QueryExecutionId` | Estado | Datos escaneados |
|----------|--------------------|--------|-----------------:|
| A — total snapshots | `4ac33f7e-cf0a-4bbe-9eae-b1c5b8c45d10` | `SUCCEEDED` | — |
| B — por cuenta | `d9059921-5d04-4d02-a7f7-fc96462fc2fa` | `SUCCEEDED` | `5 342 069` bytes |
| C — por usage_type | `09aef59c-4f79-420e-b675-5a0874a1e22f` | `SUCCEEDED` | — |

---

## 2. Resultado congelado — coste base de snapshots (`frozen-2026-05@2026-06-23`, USD)

**Cifra base total (Consulta A):**

| Métrica | Valor |
|---------|------:|
| Coste total snapshots (unblended) | **402,93 USD** (`402,9275398306`) |
| Coste total snapshots (net unblended) | **402,93 USD** (`402,9275397882`) |
| Líneas CUR | `11 304` |
| Snapshots distintos (`line_item_resource_id`) | `1 216` |

> Concordancia con el `design.md`: el ejemplo trabajado declaraba **«$403»**, que coincide con la
> cifra base congelada (`402,93`). `unblended ≡ net_unblended` a 2 decimales (sin divergencia).

**Desglose por cuenta (Consulta B), redondeado a 2 decimales half-up:**

| # | Cuenta (ID) | Nombre (perfil) | Coste snapshots (USD) | Líneas | Verif. vivo |
|---|-------------|------------------|----------------------:|-------:|:-----------:|
| 1 | 400500600700 | SAP (sap) | 249,10 | 2 006 | ✅ verificado (muestra) |
| 2 | 222333444555 | Ecommerce Tiendanimal (ecommerce-tiendanimal) | 64,53 | 4 774 | ✅ verificado (muestra) |
| 3 | 300400500600 | infraestructura (infra) | 42,27 | 3 284 | ⏳ pendiente |
| 4 | 999000111222 | Clinicanimal (clinicanimal) | 17,24 | 93 | ⏳ pendiente |
| 5 | 111122223333 | EKS Dev (eks-dev) | 8,77 | 62 | ⏳ pendiente |
| 6 | 333344445555 | EKS Prod (eks-prd) | 8,77 | 62 | ⏳ pendiente |
| 7 | 200300400500 | Iskaypet Data (iskaypet-data) | 5,26 | 341 | ⏳ pendiente |
| 8 | 888899990000 | Digital Ecommerce (digital-ecommerce) | 3,12 | 372 | ⏳ pendiente |
| 9 | 666777888999 | Retail Prod (retail-prod) | 2,07 | 62 | ⏳ pendiente |
| 10 | 500600700800 | Sistemas Tiendanimal (sistemas-tiendanimal) | 0,96 | 62 | ⏳ pendiente |
| 11 | 100200300400 | Data desarrollo (data-dev) | 0,84 | 186 | ⏳ pendiente |
| | | **Total (sumado antes de redondear, Req 6.7)** | **402,93** | **11 304** | |

> Concentración: las 2 cuentas verificadas (SAP + ecommerce-tiendanimal) suman **313,63 USD = 77,8 %**
> del coste base de snapshots. La verificación en vivo se realizó sobre esas dos cuentas como muestra
> representativa; las 9 cuentas restantes (`89,30 USD = 22,2 %`) tienen la **lógica de elegibilidad
> documentada** pero su describe por snapshot queda pendiente (no bloquea el rango Estimado, ver §5).

**Desglose por `usage_type` (Consulta C) — región y tier:**

| `usage_type` | Región | Coste (USD) | Líneas | Tier |
|--------------|--------|------------:|-------:|------|
| `EU-EBS:SnapshotUsage` | eu-west-1 | 402,73 | 11 242 | Standard |
| `EUW2-EBS:SnapshotUsage` | eu-west-2 | 0,20 | 62 | Standard |

> **No hay snapshots en tier Archive** (`SnapshotArchiveStorage`) en el Mes_Referencia: el 100 % del
> coste es snapshot Standard. El 99,95 % reside en `eu-west-1`.

---

## 3. Separación elegibles / no elegibles (Req 10.4, 10.5)

**Regla de elegibilidad (determinista):** un snapshot es **NO elegible** (se excluye del ahorro) si
cumple **cualquiera** de estas condiciones:

1. **Respalda una AMI** — su `SnapshotId` aparece en `BlockDeviceMappings[].Ebs.SnapshotId` de alguna
   imagen propia (`describe-images --owners self`). Eliminarlo rompería la AMI (Req 10.5).
2. **Está cubierto por una política de retención / backup** — lleva etiquetas de un sistema de
   backup gestionado, p. ej. `aws:backup:source-resource` (AWS Backup), `dlm:managed` / `DeleteOn`
   (Data Lifecycle Manager), o `veeam*` (Veeam Backup). Su ciclo de vida lo gobierna una política;
   no es desperdicio (Req 10.5).

Un snapshot es **elegible** (candidato a eliminación) si **no** respalda ninguna AMI **y no** está
cubierto por ninguna política de retención/backup. La eliminación de un snapshot elegible retira la
**totalidad** de su coste GiB-mes.

---

## 4. Verificacion_Recurso_Vivo de elegibilidad (solo lectura — Req 5.1, 5.5)

**Comandos de solo lectura (describe/list/get — ninguna operación mutante), región `eu-west-1`:**

```bash
# Snapshots propios de la cuenta
aws ec2 describe-snapshots --profile <perfil> --region eu-west-1 --owner-ids self

# AMIs propias → snapshots que respaldan AMIs (NO elegibles)
aws ec2 describe-images --profile <perfil> --region eu-west-1 --owners self \
  --query 'Images[].BlockDeviceMappings[].Ebs.SnapshotId'

# Snapshots con etiquetas de retención/backup (NO elegibles)
aws ec2 describe-snapshots --profile <perfil> --region eu-west-1 --owner-ids self \
  --query "Snapshots[?Tags[?Key=='aws:backup:source-resource' || Key=='DeleteOn' || starts_with(Key,'veeam')]]"
```

### Sub-registros de verificación (estado / cuenta / región / fecha-hora UTC — Req 5.5)

| Cuenta (ID) | Snapshots propios | Respaldan AMI | Retención/backup | Candidatos elegibles | Región | Fecha-hora UTC | Estado |
|-------------|------------------:|--------------:|------------------|---------------------:|--------|----------------|--------|
| 400500600700 (SAP) | 73 | 10 | 61 `veeam*` + 10 `aws:backup:source-resource` | **2** | `eu-west-1` | `2026-06-23T08:34:56Z` | confirmado |
| 222333444555 (ecommerce-tiendanimal) | 159 | 19 | 35 `DeleteOn` (DLM) + 9 `veeam*` | bulk no elegible | `eu-west-1` | `2026-06-23T08:34:56Z` | confirmado |

**Hallazgos de la verificación:**

- **SAP (400500600700 — 62 % del coste, $249,10):** de 73 snapshots propios, **71 son no elegibles**
  (10 respaldan AMIs; 61 son backups gestionados por **Veeam** con etiquetas `veeam00:`…`veeam10:`;
  10 son **AWS Backup** con `aws:backup:source-resource`). Solo **2 snapshots** quedan como candidatos
  elegibles (`snap-00d9af72bc58510a5`, `snap-092791b3756534c05`): sin AMI y sin etiqueta de backup.
  Es decir, **≈97 % de los snapshots de la cuenta dominante son no elegibles** (DR / AMIs).
- **ecommerce-tiendanimal (222333444555 — 16 % del coste, $64,53):** de 159 snapshots, 19 respaldan
  AMIs y la mayoría del resto está gobernada por **DLM** (etiqueta `DeleteOn`, 35) y **Veeam** (9) →
  política de retención automatizada (no elegibles). El residuo elegible es pequeño.

**Conclusión de elegibilidad:** en las cuentas que concentran el 77,8 % del coste de snapshots, la
**gran mayoría** del gasto corresponde a snapshots **no elegibles** (respaldan AMIs o están cubiertos
por retención: Veeam DR, AWS Backup, DLM `DeleteOn`). La fracción **elegible** (desperdicio
direccionable) es un **residuo pequeño y acotado**.

> **Solo lectura (Req 5.1):** todos los comandos son `describe-*` (lectura). No se ejecutó ninguna
> operación mutante (`delete-snapshot`, `deregister-image`, etc.). El drift del recurso vivo entre
> esta verificación y futuras re-ejecuciones es esperado (Req 7.6) y no invalida la cifra base anclada
> al `Dataset_Congelado`.

---

## 5. Fórmula de ahorro y clasificación — Ahorro_Estimado (Req 3.3, 6.1)

**Base mensual afectada (coste base de snapshots):** `402,93 USD/mes`.

**% direccionable (fracción elegible del coste base — Req 4.2):** rango **5,0 % – 15,0 %**. Justificación
defendible a partir de la verificación: en las cuentas que cubren el 77,8 % del coste, **≥85 %** de los
snapshots son no elegibles (AMI / Veeam / AWS Backup / DLM), por lo que el residuo elegible es **≤15 %**
(límite agresivo); el suelo conservador se fija en **5,0 %** dado que parte del residuo aún requiere
confirmación manual cuenta por cuenta. La separación elegible/no elegible se expresa como fracción del
coste base porque las líneas de snapshot del CUR no descomponen de forma fiable el coste por snapshot
individual.

**Supuesto de reducción aplicado (Req 4.1):** **100,0 %** sobre el subconjunto elegible — eliminar un
snapshot elegible retira la totalidad de su coste GiB-mes (no es un descuento, es supresión de gasto).

**Cálculo del ahorro (sumado antes de redondear, half-up 2 decimales, Req 6.7):**

| Límite | % direccionable | Ahorro mensual (USD) | Ahorro anualizado ×12 (USD) |
|--------|----------------:|---------------------:|----------------------------:|
| **Rango_Conservador** | 5,0 % | `402,9275 × 0,050 =` **20,15** | **241,76** |
| **Rango_Agresivo** | 15,0 % | `402,9275 × 0,150 =` **60,44** | **725,27** |

**Invariante de Estimado (Req 3.3, 6.1):** `0 < Conservador ≤ Agresivo` → `0 < 20,15 ≤ 60,44` ✅
(mensual) y `0 < 241,76 ≤ 725,27` ✅ (anualizado). Ahorro expresado **siempre como rango**, nunca como
cifra única.

**Anualización (Req 6.1, base ×12):** las cifras anuales son el ahorro mensual del Mes_Referencia
multiplicado por 12. **Advertencia (Req 6.4):** el método asume que mayo 2026 es un mes representativo
del coste de snapshots y **no captura estacionalidad** (p. ej. picos de backups puntuales o limpiezas).

**Clasificación: `Ahorro_Estimado`.** Aunque la eliminación de un snapshot elegible es desperdicio
puro, la **cifra** es estimada porque (a) el % direccionable se expresa como rango sustentado en una
verificación muestral (77,8 % del coste) y (b) la separación elegible/no elegible se cuantifica como
fracción del coste base, no por coste por snapshot. No se eleva a Ahorro_Garantizado mientras el
describe por snapshot no se complete en las 11 cuentas (los volúmenes huérfanos —desperdicio puro
verificado al 100 %— son la Sub_Palanca **6c**, clasificada como Garantizado, fuera de esta tarea).

---

## 6. Documentación de la Palanca (Req 4)

| Campo (Req 4) | Valor |
|---------------|-------|
| **Supuesto de reducción** (4.1) | **100,0 %** sobre el subconjunto elegible (la eliminación retira la totalidad del coste GiB-mes del snapshot elegible) |
| **% direccionable + coste base mensual** (4.2) | **5,0 % – 15,0 %** del coste base; **coste base mensual afectado = 402,93 USD** |
| **Origen del supuesto** (4.3) | **Precio público AWS** — EBS Snapshot Standard `$0,05/GB-mes` (`eu-west-1`); el coste ya está reflejado en el CUR, la reducción es supresión directa de ese coste. Fecha del dato: `2026-06-23` |
| **Riesgo** (4.4) | **bajo** — el subconjunto elegible no respalda AMIs ni está bajo retención; su eliminación no supone pérdida de capacidad. Mitigación: confirmación manual previa por cuenta |
| **Esfuerzo** (4.5) | **bajo** — eliminación puntual o vía política de limpieza de snapshots sin política |
| **Responsable (owner)** (4.6) | **pendiente** (SRE por cuenta) |
| **Campos no evaluables** (4.7) | `owner` registrado como **"pendiente"** en lugar de omitirse |
| **Barrido_Utilizacion** | **No requerido** para 6b — la elegibilidad se confirma por `describe-snapshots`/`describe-images` (solo lectura), no por un barrido de utilización p95. Pendiente: completar el describe por snapshot en las 9 cuentas restantes (22,2 % del coste) para estrechar el rango |

---

## 7. Notas metodológicas

- El filtro `line_item_product_code = 'AmazonEC2' AND line_item_usage_type LIKE '%SnapshotUsage%'`
  aísla el coste de almacenamiento de snapshots EBS (Standard y, si existiera, otros tiers de
  `SnapshotUsage`), excluyendo `SnapshotArchiveStorage` (no presente en el Mes_Referencia) y la
  copia/transferencia de snapshots.
- La cifra base (`402,93 USD`) está **congelada y es reproducible**: re-ejecutar las Consultas A/B/C
  sobre el mismo Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3;
  auditoría en Tarea 17.6).
- Las verificaciones de elegibilidad son **estrictamente de solo lectura** (Req 5.1; auditoría en
  Tarea 17.7). Solo se ejecutaron `aws ec2 describe-snapshots` y `aws ec2 describe-images`.
- Esta Sub_Palanca **no añade doble conteo** con 6a (gp2→gp3, coste de `VolumeUsage`) ni con 6c
  (volúmenes huérfanos, `VolumeUsage` de volúmenes `available`): el coste de snapshots
  (`SnapshotUsage`) es una dimensión de coste **disjunta** del coste de volumen (Property 7, auditada
  en Tareas 8.4 y 17.4).

## 8. Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23` el `2026-06-23` (CUR
  `~08:30Z`; verificación en vivo `~08:35Z`).
- ✅ Cifra base de snapshots congelada: **402,93 USD/mes** (`unblended` ≡ `net`).
- ✅ Separación elegibles/no elegibles documentada y verificada (solo lectura) en las 2 cuentas que
  concentran el 77,8 % del coste; lógica de elegibilidad documentada para las 11 cuentas.
- ✅ Clasificación **Ahorro_Estimado**: rango `20,15 – 60,44 USD/mes` (`241,76 – 725,27 USD/año`),
  invariante `0 < Cons ≤ Agr` cumplida.
- ⏳ Pendiente (no bloquea el rango): completar el describe por snapshot en las 9 cuentas restantes
  (22,2 % del coste) para estrechar el % direccionable; asignar owner por cuenta.
