# Registro de evidencia — Palanca 7: S3 lifecycle e Intelligent-Tiering (Tarea 9.1)

**Validates: Requirements 12.1, 2.3**

> Artefacto auditable de **análisis FinOps** (no software). Congela el coste de almacenamiento de
> S3 **por clase de almacenamiento** (derivada de `line_item_usage_type`) en el Mes_Referencia,
> comparando S3 Standard frente a Intelligent-Tiering y Glacier (Req 12.1), con su consulta CUR
> re-ejecutable anclada al `Dataset_Congelado`.
>
> Alcance de **esta** tarea (9.1): **solo congelar las cifras** por clase. La
> `Verificacion_Recurso_Vivo` (`s3api get-bucket-lifecycle-configuration`, `get-bucket-versioning`,
> `list-multipart-uploads`) se ejecuta en la **Tarea 9.2**; la fórmula de ahorro, el supuesto de
> transición de clase, el % direccionable, la exclusión de objetos de acceso frecuente, el impacto
> de versionado/MPU y la clasificación **Estimado** se documentan en la **Tarea 9.3**.

## Parámetros de anclaje (Req 2.5)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-9.1-s3-timedstorage-clase-2026-05` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23T09:05:00Z` (UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Cuenta CUR | `600700800900` (root-iskaypet), `eu-west-1` |
| Motor / DB / tabla | Amazon Athena (CUR 2.0) · `athenacurcfn_finnops` / `data` |
| Rol de acceso | `Cur-AWSS3CURLambdaExecutor` (perfil `root-iskaypet`) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |

**Clasificación del registro:** cifra **agregada por dimensión** (clase de almacenamiento) — `no
atribuible a recurso` (Req 2.3): el valor de cada fila agrega el coste de almacenamiento de muchos
buckets/objetos. La atribución por bucket/recurso se realiza en la Verificacion_Recurso_Vivo de la
Tarea 9.2. La cifra de coste base por **cuenta** (dimensión `line_item_usage_account_id`) se incluye
como cruce de consistencia.

**Dimensión de agregación (Req 2.3):** `line_item_usage_type` (clase de almacenamiento derivada del
usage_type); valor de agregación = `SUM(line_item_unblended_cost)`, `SUM(line_item_net_unblended_cost)`
y `SUM(line_item_usage_amount)` (GB-mes).

## Consulta CUR exacta (re-ejecutable) — primaria

Coste por clase de almacenamiento S3 (`%TimedStorage%`), idéntica a la del `design.md` (Palanca 7)
ampliada con `net_unblended`, `usage_amount` (GB-mes) y conteo de líneas:

```sql
SELECT line_item_usage_type              AS usage_type,
       SUM(line_item_unblended_cost)     AS unblended_cost,
       SUM(line_item_net_unblended_cost) AS net_unblended_cost,
       SUM(line_item_usage_amount)       AS usage_amount,   -- GB-mes (ByteHrs facturadas / mes)
       COUNT(*)                          AS line_items
FROM data
WHERE line_item_product_code = 'AmazonS3'
  AND line_item_usage_type LIKE '%TimedStorage%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

## Consulta de refuerzo 1 — Confirmación de ausencia de Intelligent-Tiering

Verifica explícitamente que **no existe** ninguna línea de Intelligent-Tiering (clases `*-INT-*` ni
la cuota de **monitorización/automatización** de IT, que **no** lleva el patrón `TimedStorage` y por
tanto no la captura la primaria). Resultado: **cero filas** → IT sin explotar (Req 12.1).

```sql
SELECT line_item_usage_type          AS usage_type,
       SUM(line_item_unblended_cost) AS unblended_cost,
       COUNT(*)                      AS line_items
FROM data
WHERE line_item_product_code = 'AmazonS3'
  AND (line_item_usage_type LIKE '%INT%' OR line_item_usage_type LIKE '%Monitoring%')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

## Consulta de refuerzo 2 — S3 Standard por cuenta (cruce de consistencia)

Reparte el coste de la clase **Standard** por `line_item_usage_account_id` (identifica el mayor
consumidor para enfocar la oportunidad de tiering en la Tarea 9.3). Excluye las clases no-Standard
(`GDA`, `Glacier`, `ZIA`/IA):

```sql
SELECT line_item_usage_account_id    AS account,
       SUM(line_item_unblended_cost) AS unblended_cost,
       SUM(line_item_usage_amount)   AS gb_month,
       COUNT(*)                      AS line_items
FROM data
WHERE line_item_product_code = 'AmazonS3'
  AND line_item_usage_type LIKE '%TimedStorage%'
  AND line_item_usage_type NOT LIKE '%GDA%'
  AND line_item_usage_type NOT LIKE '%Glacier%'
  AND line_item_usage_type NOT LIKE '%ZIA%'
  AND line_item_usage_type NOT LIKE '%IA%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC
LIMIT 15;
```

## Comando de ejecución re-ejecutable (Athena vía AWS CLI, credenciales por nombre de perfil — Req 7.5)

```bash
# Consulta primaria — coste por clase de almacenamiento
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "SELECT line_item_usage_type AS usage_type, SUM(line_item_unblended_cost) AS unblended_cost, SUM(line_item_net_unblended_cost) AS net_unblended_cost, SUM(line_item_usage_amount) AS usage_amount, COUNT(*) AS line_items FROM data WHERE line_item_product_code = 'AmazonS3' AND line_item_usage_type LIKE '%TimedStorage%' AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00' GROUP BY 1 ORDER BY 2 DESC;" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

## Ejecución congelada

| Consulta | `QueryExecutionId` | Estado | Datos escaneados (bytes) |
|----------|--------------------|--------|-------------------------:|
| Primaria (por clase de almacenamiento) | `6afef4fc-5a40-43bc-bbbf-627207c30b15` | `SUCCEEDED` | `6 859 239` |
| Refuerzo 1 (ausencia de Intelligent-Tiering) | `c303e73f-b476-4906-a5f6-d79ef6f6c96f` | `SUCCEEDED` | `1 989 417` |
| Refuerzo 2 (Standard por cuenta) | `e2e7f777-97af-4612-82d0-1946a5d603f9` | `SUCCEEDED` | `5 448 368` |

## Resultado congelado — coste por clase de almacenamiento (`frozen-2026-05@2026-06-23`, USD)

Importes a 6 decimales tal como los devuelve el CUR; la columna `GB-mes` es `usage_amount`
(ByteHrs facturadas convertidas a GB-mes por el CUR). `unblended ≡ net_unblended` a 2 decimales
(el almacenamiento S3 no lleva cobertura de Savings Plans ni descuento SPP en el Mes_Referencia).

| `line_item_usage_type` | Clase de almacenamiento (región) | Unblended (USD) | Net (USD) | GB-mes | Líneas |
|------------------------|----------------------------------|----------------:|----------:|-------:|-------:|
| `EU-TimedStorage-ByteHrs` | **S3 Standard** (eu-west-1) | 2 142,803107 | 2 142,803107 | 103 542,444 | 6 221 |
| `EU-TimedStorage-GDA-ByteHrs` | **Glacier Deep Archive** (eu-west-1) | 92,098822 | 92,098822 | 93 029,113 | 434 |
| `TimedStorage-ByteHrs` | **S3 Standard** (us-east-1) | 27,996641 | 27,996641 | 1 323,093 | 217 |
| `EU-TimedStorage-GlacierByteHrs` | **Glacier Flexible Retrieval** (eu-west-1) | 1,497201 | 1,497201 | 452,053 | 217 |
| `EU-TimedStorage-ZIA-ByteHrs` | **S3 One Zone-IA** (eu-west-1) | 1,400802 | 1,400802 | 152,261 | 62 |
| `EUC1-TimedStorage-ByteHrs` | **S3 Standard** (eu-central-1) | 0,000857 | 0,000857 | 0,038 | 391 |
| `EUW3-TimedStorage-ByteHrs` | **S3 Standard** (eu-west-3) | 0,000006 | 0,000006 | 0,000 | 62 |
| **(ninguna fila)** | **Intelligent-Tiering** (`*-INT-*` + monitorización) | **0,000000** | **0,000000** | **0,000** | **0** |

## Cifras congeladas agregadas por clase (sumado ANTES de redondear, half-up a 2 dec — Req 6.7)

| Clase de almacenamiento | Unblended (USD) | % del coste TimedStorage | GB-mes | % del volumen |
|-------------------------|----------------:|-------------------------:|-------:|--------------:|
| **S3 Standard** (todas las regiones) | **2 170,80** | **95,81 %** | 104 865,575 | 52,87 % |
| **Glacier** (Deep Archive + Flexible Retrieval) | **93,60** | **4,13 %** | 93 481,166 | 47,13 % |
| **S3 One Zone-IA** | **1,40** | **0,06 %** | 152,261 | 0,08 % |
| **Intelligent-Tiering** | **0,00** | **0,00 %** | 0,000 | 0,00 % |
| **Total S3 TimedStorage (Mes_Referencia)** | **2 265,80** | **100,00 %** | 198 499,002 | 100,00 % |

Desglose de los subtotales:

- **S3 Standard** = `2 142,803107 (eu-west-1) + 27,996641 (us-east-1) + 0,000857 (eu-central-1) +
  0,000006 (eu-west-3) = 2 170,800611` → **2 170,80 USD**.
- **Glacier** = `92,098822 (Deep Archive) + 1,497201 (Flexible Retrieval) = 93,596023` → **93,60 USD**.
- **One Zone-IA** = `1,400802` → **1,40 USD**.
- **Intelligent-Tiering** = **0,00 USD** (confirmado por la consulta de refuerzo 1: cero filas
  `*-INT-*` y cero cuotas de monitorización/automatización de IT).
- **Total** = `2 265,797437` → **2 265,80 USD**.

## Comparativa exigida (Req 12.1): Standard vs Intelligent-Tiering vs Glacier

| | S3 Standard | Intelligent-Tiering | Glacier (GDA + Flexible) |
|---|------------:|--------------------:|-------------------------:|
| Coste mensual (USD) | **2 170,80** | **0,00** | **93,60** |
| GB-mes almacenados | 104 865,58 | 0,00 | 93 481,17 |
| Coste implícito por GB-mes (USD) | ≈ 0,0207 | — | ≈ 0,0010 |

**Hallazgo congelado (insumo para la Tarea 9.3):**

1. **Intelligent-Tiering está sin explotar (0,00 USD).** No existe ninguna línea de IT ni cuota de
   monitorización de IT en el Mes_Referencia → oportunidad de tiering automático aún no activada
   (coincide cualitativamente con el ejemplo trabajado del `design.md`, que anticipaba «IT ~$0»).
2. **El 95,81 % del gasto de almacenamiento es S3 Standard** (`2 170,80 USD`) sobre el **52,87 %**
   del volumen — mientras que Glacier ya guarda un volumen comparable (`93 481 GB-mes`, 47,13 %) por
   solo **93,60 USD** (4,13 %). El diferencial de coste/GB-mes (Standard ≈ 0,0207 vs Glacier Deep
   Archive ≈ 0,0010, ~20×) es exactamente la palanca de lifecycle/tiering.
3. La clase **One Zone-IA** ya está en uso de forma marginal (`1,40 USD`), lo que indica que **alguna**
   política de clase existe en parte del estate; el grueso del coste activo sigue en Standard sin IT.

## Cruce de consistencia — S3 Standard por cuenta (mayores consumidores)

Top cuentas por coste de S3 Standard (refuerzo 2, `LIMIT 15`). Nombres resueltos contra el mapa de
cuentas del Registro 1.3 del `Catálogo_Evidencias`:

| Cuenta (ID) | Nombre (perfil) | Standard (USD) | GB-mes | Líneas |
|-------------|------------------|---------------:|-------:|-------:|
| 300400500600 | infraestructura (infra) | 1 080,94 | 52 199,94 | 402 |
| 100200300400 | Data desarrollo (data-dev) | 496,85 | 24 046,35 | 449 |
| 200300400500 | Iskaypet Data (iskaypet-data) | 372,01 | 17 975,60 | 668 |
| 888899990000 | Digital Ecommerce (digital-ecommerce) | 115,22 | 5 534,49 | 1 829 |
| 222333444555 | Ecommerce Tiendanimal (ecommerce-tiendanimal) | 48,13 | 2 323,62 | 434 |
| 666777888999 | Retail Prod (retail-prod) | 17,40 | 841,59 | 147 |
| 444455556666 | EKS Tooling (eks-tooling) | 13,74 | 663,74 | 429 |
| 111222333444 | Digital Prod (digital-prod) | 10,44 | 504,10 | 817 |
| 400600800100 | Log Archive (log) | 7,17 | 346,12 | 95 |
| 999900001111 | Digital Dev (digital-dev) | 3,16 | 152,51 | 478 |
| 500600700800 | Sistemas Tiendanimal (sistemas-tiendanimal) | 2,91 | 140,75 | 186 |
| 111122223333 | EKS Dev (eks-dev) | 2,44 | 118,01 | 248 |
| 333344445555 | EKS Prod (eks-prd) | 0,22 | 10,66 | 124 |
| 555666777888 | RetailUAT (retail-uat) | 0,06 | 3,02 | 62 |
| 000011112222 | Digital UAT (digital-uat) | 0,04 | 2,12 | 62 |

> **Concentración (insumo para la Tarea 9.3):** tres cuentas — `infra`, `data-dev` e `iskaypet-data`
> — concentran ~`1 949,80 USD`, el **~89,8 %** del coste de S3 Standard. La cuenta `infra`
> (300400500600) por sí sola es el **~49,8 %** del Standard. El barrido de lifecycle/IT debe enfocarse
> en estas cuentas (y en sus buckets concretos, vía la Verificacion_Recurso_Vivo de la Tarea 9.2).

## Notas metodológicas

- El filtro `line_item_usage_type LIKE '%TimedStorage%'` aísla el **almacenamiento facturado por
  tiempo** (ByteHrs) de cada clase, separándolo de requests, transferencia, replicación,
  `EarlyDelete` y recuperaciones — coherente con el alcance de la Palanca 7 (coste por clase de
  almacenamiento, Req 12.1).
- La clase se **deriva del `usage_type`** porque el CUR 2.0 reducido **no** expone
  `product_storage_class` (gotcha documentado en `portal-architecture.md` §"CUR Athena — columnas y
  patrones"). Mapeo aplicado: `…TimedStorage-ByteHrs` (sin sufijo de clase) → **Standard**;
  `…-GDA-ByteHrs` → **Glacier Deep Archive**; `…-GlacierByteHrs` → **Glacier Flexible Retrieval**;
  `…-ZIA-ByteHrs` → **One Zone-IA**; `…-INT-*` → **Intelligent-Tiering** (ausente).
- El prefijo de región del `usage_type` (`EU-` = eu-west-1, `EUC1-` = eu-central-1, `EUW3-` =
  eu-west-3, sin prefijo = us-east-1) se consolida dentro de cada clase para la comparativa de Req
  12.1; las cuatro variantes regionales de Standard suman la cifra única de Standard.
- `usage_amount` (GB-mes) se conserva como contexto de **capacidad** para la fórmula de la Tarea 9.3
  (la transición de clase ahorra sobre GB-mes, no sobre líneas). El impacto de **versionado** y de
  **MPU incompletas** en el almacenamiento facturable (Req 12.3) y la **duración mínima** de IA/Glacier
  (Req 12.4) se tratan en las Tareas 9.2 (verificación en vivo) y 9.3 (fórmula).
- No se ejecuta ninguna acción mutante: esta tarea solo lee el CUR vía Athena (Req 7.5, Property 11).
  La verificación contra el recurso vivo (`s3api get-bucket-lifecycle-configuration`,
  `get-bucket-versioning`, `list-multipart-uploads`, solo lectura) es la **Tarea 9.2**.

## Desviación documentada respecto al ejemplo trabajado del `design.md`

El `design.md` (Palanca 7) usa como **ejemplo trabajado** (ilustración de metodología, no resultado
final): «Standard **$2.36k**, IT/Glacier **~$0**». Las cifras **canónicas** del Estudio, congeladas
contra `frozen-2026-05@2026-06-23`, son:

| Concepto | Ejemplo trabajado (`design.md`) | **Canónico (este registro)** |
|----------|--------------------------------:|-----------------------------:|
| S3 Standard | ~2 360 | **2 170,80** |
| Intelligent-Tiering | ~0 | **0,00** (confirmado: cero filas) |
| Glacier | ~0 | **93,60** (Deep Archive 92,10 + Flexible 1,50) |

La diferencia en Standard (`~2,36k` → `2 170,80`) y la presencia de un Glacier modesto (`93,60`, no
exactamente `~0`) reflejan los datos reales del Mes_Referencia. La conclusión cualitativa del diseño
**se mantiene**: Intelligent-Tiering está sin explotar (0,00) y el grueso del gasto sigue en Standard.
Estas cifras canónicas sustituyen al ejemplo trabajado a efectos del Informe.

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23` el `2026-06-23T09:05:00Z`.
- Cifras congeladas y reproducibles: re-ejecutar las consultas documentadas sobre el mismo
  Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría en
  Tarea 17.6).

---

## Verificacion_Recurso_Vivo S3 (Tarea 9.2 — solo lectura)

**Validates: Requirements 5.1, 12.3**

> Confirma en vivo, sobre los **mayores consumidores de S3 Standard** identificados en el cruce de
> consistencia del Registro 9.1 (cuentas `infra` 300400500600, `data-dev` 100200300400 e
> `iskaypet-data` 200300400500, que concentran ~89,8 % del Standard), el estado de **lifecycle**,
> **versionado** y **cargas multiparte (MPU) incompletas** de cada bucket, en **la región del
> bucket** (Req 5.2). Insumo directo de la Tarea 9.3 para (a) el % direccionable de transición de
> clase y (b) el ajuste del almacenamiento facturable por versionado y MPU incompletas (Req 12.3).
> Exclusivamente operaciones de **solo lectura** (`get`/`list`); ninguna operación mutante
> (Property 11, Req 5.1, 7.5).

### Parámetros de la verificación (Req 5.5)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-9.2-s3-buckets-live-2026-06-23` |
| Fecha-hora UTC | `2026-06-23T10:18:57Z` (ventana de ejecución `~10:05–10:19Z`) |
| Cuentas consultadas | `300400500600` (infra), `100200300400` (data-dev), `200300400500` (iskaypet-data) |
| Región consultada | `eu-west-1` (región de todos los buckets verificados; ningún top-consumer de Standard reside fuera de `eu-west-1`) |
| Perfiles / credenciales | `infra`, `data-dev`, `iskaypet-data` (SSO SRE, `sso_role_name = SRE`); **sin credenciales incrustadas** (Req 7.5) |
| Identidad efectiva | `arn:aws:sts::300400500600:assumed-role/AWSReservedSSO_SRE_933e5a8baf2a2495/ruben.landin@emefinpetcare.com` · `…::100200300400:…SRE_79847a112afd0bf2/…` · `…::200300400500:…SRE_a58abd695cfc12ff/…` |
| Estado global | **confirmado** (3/3 cuentas accesibles; ninguna `no_verificable`) |

### Selección de buckets (foco en mayores consumidores de Standard — Req 12.1/9.1)

La atribución por bucket del coste Standard no está en el CUR (agregado por `usage_type`); se aproxima
con la métrica diaria de CloudWatch `AWS/S3 BucketSizeBytes` con `StorageType=StandardStorage`
(snapshot vivo del `2026-06-20`–`2026-06-23`, solo lectura) para **rankear** los buckets dentro de
cada cuenta y enfocar la verificación. El ranking confirma que **un puñado de buckets concentra el
Standard** de cada cuenta:

| Cuenta | Bucket | Standard (snapshot CloudWatch, aprox.) | Peso |
|--------|--------|---------------------------------------:|------|
| infra | `buckets3veeambackup` | **~60,1 TB** | **dominante** (≈ todo el Standard de infra) |
| infra | `backups-iskaypet-euwest1` | ~18,6 GB | menor |
| infra | `buckets3veeambackupglacier` | ~2,57 GB (Standard) | menor |
| data-dev | `ikp-bl-dev` | **~14,9 TB** | mayor |
| data-dev | `ikp-st-dev` | **~14,6 TB** | mayor |
| data-dev | `kiwoko-datawarehouse-dev` | ~419 GB | medio |
| data-dev | `ikp-ld-dev` | ~365 GB | medio |
| iskaypet-data | `ikp-bl-pro` | **~14,5 TB** | mayor |
| iskaypet-data | `ikp-st-pro` | **~6,70 TB** | mayor |
| iskaypet-data | `ikp-backup-pro` | ~3,56 TB | mayor |
| iskaypet-data | `ikp-logs-pro` | ~1,76 TB | medio |
| iskaypet-data | `kiwoko-datawarehouse` | ~776 GB | medio |

> El snapshot de CloudWatch (junio) es **indicador relativo de capacidad** para enfocar la
> verificación, **no** la cifra de coste congelada (que es la del CUR de mayo, Registro 9.1). El
> drift de capacidad entre mayo y la verificación es **esperado** (Req 7.6) y no altera las cifras
> ancladas a `frozen-2026-05@2026-06-23`.

### Comandos de solo lectura re-ejecutables (Req 5.1, 7.5) — región del bucket

```bash
# Ranking previo de Standard por bucket (solo lectura) — para enfocar la verificación
aws cloudwatch get-metric-statistics --namespace AWS/S3 --metric-name BucketSizeBytes \
  --dimensions Name=BucketName,Value=<bucket> Name=StorageType,Value=StandardStorage \
  --start-time <T-3d> --end-time <hoy> --period 86400 --statistics Average \
  --region eu-west-1 --profile <infra|data-dev|iskaypet-data>

# Las 3 verificaciones exigidas por bucket (Tarea 9.2) — región del bucket
aws s3api get-bucket-location               --bucket <bucket> --profile <perfil>   # región del bucket (Req 5.2)
aws s3api get-bucket-versioning             --bucket <bucket> --profile <perfil>   # Status: Enabled/Suspended/—
aws s3api get-bucket-lifecycle-configuration --bucket <bucket> --profile <perfil>  # reglas o NoSuchLifecycleConfiguration
aws s3api list-multipart-uploads            --bucket <bucket> --profile <perfil> --region eu-west-1  # MPU incompletas
```

> **Solo lectura (Req 5.1, Property 11):** todos los comandos son `get`/`list`/`describe`. No se
> ejecutó ninguna operación mutante (`put-bucket-lifecycle-configuration`, `put-bucket-versioning`,
> `abort-multipart-upload`, `delete-object`, etc.).

### Resultado congelado — lifecycle / versionado / MPU por bucket (`2026-06-23T10:18:57Z`)

`MPU incompletas`: número de cargas multiparte abiertas (cada una retiene partes en almacenamiento
**facturable** hasta su completado o aborto — Req 12.3). Para los buckets con muchísimas MPU el conteo
se **acotó a 80 páginas** (`≥ 80 000`); el valor real puede ser mayor. `lifecycle`: nº de reglas y su
naturaleza (transición de clase / expiración / abort-MPU).

#### Cuenta `infra` (300400500600)

| Bucket | Región | Versionado | Lifecycle | MPU incompletas | Nota |
|--------|--------|------------|-----------|----------------:|------|
| `buckets3veeambackup` | eu-west-1 | **Enabled** | **NINGUNO** (`NoSuchLifecycleConfiguration`) | 0 | **Dominante del Standard de infra** (~60 TB): versionado activo **sin** lifecycle ni transición de clase → todo permanece en Standard indefinidamente |
| `backups-iskaypet-euwest1` | eu-west-1 | Suspended | **1 regla** `toGlacier` (prefijo `kiwoko/` → `GLACIER` a `Days=0`) | 0 | Transición a Glacier **solo** para el prefijo `kiwoko/`; el resto del bucket sin transición |
| `buckets3veeambackupglacier` | eu-west-1 | Suspended | NINGUNO | 0 | Nombre sugiere Glacier pero ~2,57 GB siguen en Standard sin regla |

#### Cuenta `data-dev` (100200300400)

| Bucket | Región | Versionado | Lifecycle | MPU incompletas | Nota |
|--------|--------|------------|-----------|----------------:|------|
| `ikp-bl-dev` | eu-west-1 | Suspended | **NINGUNO** | **≥ 80 000** (acotado) | **MPU incompletas masivas sin regla de aborto** → almacenamiento facturable inflado (Req 12.3) |
| `ikp-st-dev` | eu-west-1 | Suspended | **NINGUNO** | 37 | ~14,6 TB en Standard sin transición de clase |
| `kiwoko-datawarehouse-dev` | eu-west-1 | Disabled/never | **NINGUNO** | **12 115** | MPU incompletas elevadas sin abort-MPU; sin transición |
| `ikp-ld-dev` | eu-west-1 | Suspended | NINGUNO | 9 | — |
| `ikp-customer-migration-dev` | eu-west-1 | Disabled/never | NINGUNO | 1 | — |
| `ikp-logs-dev` | eu-west-1 | Disabled/never | **2 reglas** (expira `''`@30d; expira `athena/`@1d) | 14 | Higiene de expiración OK; sin transición de clase |

#### Cuenta `iskaypet-data` (200300400500)

| Bucket | Región | Versionado | Lifecycle | MPU incompletas | Nota |
|--------|--------|------------|-----------|----------------:|------|
| `ikp-bl-pro` | eu-west-1 | Suspended | **NINGUNO** | **≥ 80 000** (acotado) | **MPU incompletas masivas sin regla de aborto** (Req 12.3); ~14,5 TB en Standard sin transición |
| `ikp-st-pro` | eu-west-1 | Suspended | **NINGUNO** | 225 | ~6,7 TB en Standard sin transición de clase |
| `ikp-backup-pro` | eu-west-1 | Disabled/never | **1 regla** `glacier_tiering` (`''` → `GLACIER`@30d, `DEEP_ARCHIVE`@120d) | 0 | **Tiering ya aplicado**: lo <30d permanece en Standard, el resto desciende a Glacier/Deep Archive |
| `ikp-logs-pro` | eu-west-1 | Disabled/never | **2 reglas** (expira `''`@30d; expira `athena/`@1d) | 958 | Expiración OK; sin transición; MPU moderadas sin abort |
| `kiwoko-datawarehouse` | eu-west-1 | **Enabled** | **1 regla** (NoncurrentVersion@3d + AbortIncompleteMPU@7d + ExpiredObjectDeleteMarker) | 0 | **Higiene ejemplar** de versionado/MPU; pero **sin transición de clase** (776 GB en Standard) |
| `kiwoko-datawarehouse-logs` | eu-west-1 | Disabled/never | NINGUNO | 0 | ~551 GB Standard sin regla |
| `ikp-ld-pro` | eu-west-1 | Suspended | NINGUNO | 5 | — |

### Hallazgos (insumo directo para la Tarea 9.3)

1. **Transición de clase casi inexistente en los grandes buckets de Standard.** Los mayores
   consumidores (`buckets3veeambackup` ~60 TB, `ikp-bl-dev`/`ikp-st-dev` ~15 TB c/u,
   `ikp-bl-pro` ~14,5 TB, `ikp-st-pro` ~6,7 TB) **no tienen ninguna regla de lifecycle** que
   transicione a IA/Glacier → confirma en vivo la oportunidad cuantificada en el Registro 9.1
   (95,81 % del gasto en Standard, Intelligent-Tiering a 0,00). Es el **% direccionable** principal
   de la Palanca 7.
2. **MPU incompletas materiales (Req 12.3).** `ikp-bl-dev` e `ikp-bl-pro` acumulan **≥ 80 000 MPU
   incompletas cada uno** (conteo acotado; real probablemente mayor) y `kiwoko-datawarehouse-dev`
   **12 115**, **sin** regla `AbortIncompleteMultipartUpload`. Estas partes inflan el almacenamiento
   **facturable** sin aparecer como objetos visibles → la Tarea 9.3 debe (a) contabilizar una regla
   de aborto de MPU como ahorro/saneamiento y (b) ajustar el GB-mes direccionable por este efecto.
3. **Versionado a considerar (Req 12.3).** `buckets3veeambackup` (~60 TB, dominante) y
   `kiwoko-datawarehouse` tienen versionado **Enabled**; varios grandes están **Suspended** (retienen
   versiones no actuales previas). Sin `NoncurrentVersionExpiration` (salvo `kiwoko-datawarehouse`),
   las versiones no actuales engrosan el almacenamiento facturable → la fórmula 9.3 debe netear este
   efecto y/o proponer expiración de versiones no actuales.
4. **Patrones de buena higiene ya presentes (no doble-contar).** `ikp-backup-pro` ya transiciona a
   Glacier/Deep Archive (su Standard es solo la ventana <30d) y `kiwoko-datawarehouse` ya aborta MPU
   y expira versiones. La Tarea 9.3 **no** debe contabilizar ahorro de tiering/abort sobre estos dos
   (ya optimizados); el % direccionable se concentra en los buckets **sin** regla.
5. **Intelligent-Tiering sin activar en ningún bucket verificado** — coherente con el Registro 9.1
   (cero líneas `*-INT-*`). Para buckets de acceso mixto/desconocido (datawarehouse), IT es candidato;
   para backups con acceso predecible, lifecycle a Glacier/Deep Archive es más eficiente que IT
   (evita la cuota de monitorización — Req 12.2).

### Sub-registro de evidencia (esquema del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-9.2-s3-buckets-live-2026-06-23` |
| `descripcion` | Verificacion_Recurso_Vivo (solo lectura) de lifecycle/versionado/MPU incompletas de los mayores consumidores de S3 Standard en `infra`, `data-dev` e `iskaypet-data` (los ~89,8 % del Standard del Registro 9.1) |
| `cuenta` | `300400500600` (infra), `100200300400` (data-dev), `200300400500` (iskaypet-data) |
| `region` | `eu-west-1` (región de todos los buckets verificados; Req 5.2 satisfecho — ninguno reside fuera de `eu-west-1`) |
| `fecha_hora_utc` | `2026-06-23T10:18:57Z` |
| `estado` | **confirmado** (3/3 cuentas accesibles; sin `no_verificable`) |
| `metodo` | `aws s3api get-bucket-location`; `get-bucket-versioning`; `get-bucket-lifecycle-configuration`; `list-multipart-uploads` por bucket (+ `cloudwatch get-metric-statistics` `BucketSizeBytes/StandardStorage` para el ranking); todas solo lectura (Req 5.1, 7.5, Property 11) |
| `credenciales` | perfiles `infra` / `data-dev` / `iskaypet-data` (SSO SRE); sin credenciales incrustadas (Req 7.5) |
| `recurso_ids` | `["arn:aws:s3:::buckets3veeambackup","arn:aws:s3:::backups-iskaypet-euwest1","arn:aws:s3:::buckets3veeambackupglacier","arn:aws:s3:::ikp-bl-dev","arn:aws:s3:::ikp-st-dev","arn:aws:s3:::kiwoko-datawarehouse-dev","arn:aws:s3:::ikp-ld-dev","arn:aws:s3:::ikp-customer-migration-dev","arn:aws:s3:::ikp-logs-dev","arn:aws:s3:::ikp-bl-pro","arn:aws:s3:::ikp-st-pro","arn:aws:s3:::ikp-backup-pro","arn:aws:s3:::ikp-logs-pro","arn:aws:s3:::kiwoko-datawarehouse","arn:aws:s3:::kiwoko-datawarehouse-logs","arn:aws:s3:::ikp-ld-pro"]` |
| `dimension_agregacion` | Verificación **por bucket** (no agregada); ranking previo por `BucketSizeBytes/StandardStorage` (CloudWatch, snapshot vivo) |
| `verificacion_vivo` | Este sub-registro |
| `clasificacion` | Confirmado (estado de lifecycle/versionado/MPU verificado en vivo); la clasificación de ahorro de la Palanca (**Estimado**, rango) corresponde a la Tarea 9.3 |
| `version_dataset` | `frozen-2026-05@2026-06-23` (las cifras de coste siguen ancladas al Registro 9.1; esta verificación añade el estado vivo del recurso) |
| `moneda` | `USD` (no aplica importe propio: verificación de existencia/características, no de coste) |

### Estado de ejecución (Tarea 9.2)

- ✅ **Ejecutado** en vivo el `2026-06-23T10:18:57Z` (UTC) contra `infra` (300400500600),
  `data-dev` (100200300400) e `iskaypet-data` (200300400500), región `eu-west-1`, SSO SRE,
  **solo lectura** (Req 5.1, Property 11).
- ✅ **Confirmado**: los mayores consumidores de Standard **carecen de transición de clase**
  (lifecycle ausente o solo de expiración) salvo `ikp-backup-pro` (ya hace Glacier/Deep Archive);
  Intelligent-Tiering no activo en ninguno (coherente con el Registro 9.1).
- ⚠️ **MPU incompletas materiales (Req 12.3)**: `ikp-bl-dev` e `ikp-bl-pro` ≥ 80 000 c/u,
  `kiwoko-datawarehouse-dev` 12 115, sin regla de aborto → a netear/contabilizar en la Tarea 9.3.
- ⚠️ **Versionado (Req 12.3)**: el bucket dominante de infra (`buckets3veeambackup`, ~60 TB) tiene
  versionado **Enabled sin expiración de versiones no actuales** → a considerar en el almacenamiento
  facturable de la Tarea 9.3.
- ⏭️ **Pendiente Tarea 9.3** — fórmula (supuesto de transición de clase respetando la duración mínima
  de IA/Glacier, Req 12.4), % direccionable + coste base, exclusión de objetos de acceso frecuente
  donde la cuota de monitorización de IT supere el ahorro (Req 12.2), neteo de versionado/MPU
  incompletas (Req 12.3), clasificación **Estimado** (rango) y documentación de Palanca (Req 4).
- ℹ️ **Drift esperado (Req 7.6)**: el snapshot de capacidad de CloudWatch (junio) difiere del GB-mes
  del CUR de mayo; no invalida las cifras ancladas a `frozen-2026-05@2026-06-23`.

---

# Fórmula, clasificación y documentación de la Palanca 7 (Tarea 9.3)

**Validates: Requirements 12.2, 12.3, 12.4, 3.3, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1**

> Artefacto auditable de la **Tarea 9.3**: a partir de la cifra base congelada en el Registro 9.1
> (coste por clase de almacenamiento S3, S3 Standard `2 170,80 USD/mes`, Intelligent-Tiering
> `0,00`, Glacier `93,60`) y de la `Verificacion_Recurso_Vivo` `confirmado` del Registro 9.2
> (lifecycle/versionado/MPU por bucket), se aplica la fórmula de ahorro de **transición de clase**
> declarando su supuesto y **respetando la duración mínima de almacenamiento** de las clases IA y
> Glacier (Req 12.4), se declara el **% direccionable**, se **excluyen** los objetos de acceso
> frecuente donde la cuota de monitorización de Intelligent-Tiering superaría el ahorro (Req 12.2,
> con motivo), se **considera** el impacto de **versionado** y **MPU incompletas** en el
> almacenamiento facturable (Req 12.3, **sin doble-contar** `ikp-backup-pro` y `kiwoko-datawarehouse`,
> ya optimizados), se clasifica la Palanca como **Estimado** (rango Conservador–Agresivo, invariante
> `0 < Cons ≤ Agr`) y se documentan los campos del Requisito 4.
>
> No se introduce ninguna consulta CUR nueva: la cifra base es **derivada** de las cifras congeladas
> del Registro 9.1 (ancladas a `frozen-2026-05@2026-06-23`); las transformaciones son supuestos de
> transición de clase con su origen (precio público AWS) y fecha. El estado de
> lifecycle/versionado/MPU por bucket está **confirmado** en vivo en el Registro 9.2 (solo lectura).

## Parámetros de anclaje (Req 1.2, 1.3, 2.5)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` |
| Fecha de extracción | `2026-06-23T09:05:00Z` (UTC) — heredada del `Dataset_Congelado` de la base (Registro 9.1) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Cuenta CUR | `600700800900` (root-iskaypet), `eu-west-1` |

> **Bruto ≡ neto.** El almacenamiento S3 del Mes_Referencia **no** lleva cobertura de Savings Plans
> ni descuento SPP/bundled (confirmado en el Registro 9.1: `unblended ≡ net_unblended` a 2 decimales
> en todas las clases). Por tanto el ahorro en **bruto** coincide con el ahorro en **neto** y se
> presenta una única cifra (no se duplica la columna como en la Palanca 4).

## Coste base mensual afectado (Req 4.2) y % direccionable

La Palanca 7 actúa sobre el coste de **S3 Standard** (la clase cara sobre la que opera la transición
a IA/Glacier/Intelligent-Tiering). El total congelado del Mes_Referencia (Registro 9.1) es:

| Clase | Coste congelado (USD/mes) | GB-mes | Papel en la Palanca |
|-------|--------------------------:|-------:|---------------------|
| **S3 Standard** (todas las regiones) | **2 170,80** | 104 865,58 | **Coste base afectado** (denominador) |
| Glacier (Deep Archive + Flexible) | 93,60 | 93 481,17 | Destino objetivo (ya barato) — no es base de ahorro |
| One Zone-IA | 1,40 | 152,26 | Ya en clase IA — fuera de la base |
| Intelligent-Tiering | 0,00 | 0,00 | Sin explotar — destino candidato |
| **Total S3 TimedStorage** | **2 265,80** | 198 499,00 | — |

**Coste base mensual afectado (Req 4.2) = `2 170,80 USD/mes` (S3 Standard).**

El **% direccionable** se deriva descontando del Standard dos conjuntos de objetos que **no** deben
transicionarse, con su motivo:

| Capa | Importe (USD/mes) | % del Standard | Motivo |
|------|------------------:|---------------:|--------|
| **(0) S3 Standard total** | **2 170,80** | 100,0 % | Base afectada |
| **(−1) Buckets ya optimizados** (no doble-contar) | −27,12 | −1,25 % | `kiwoko-datawarehouse` (776 GB ≈ 16,06) ya aborta MPU + expira versiones no actuales; `ikp-backup-pro` (ventana <30d ≈ 11,06) ya transiciona a Glacier/Deep Archive. Su Standard residual es la ventana caliente correcta → **no** se le contabiliza ahorro de tiering/abort (Registro 9.2, hallazgo 4) |
| **(−2) Acceso frecuente / objeto pequeño** (Req 12.2) | −406,68 | −18,73 % | Activos de ecommerce servidos por CDN (`digital-ecommerce` 115,22 + `ecommerce-tiendanimal` 48,13 ≈ 163,35, acceso caliente) + prefijos calientes y **buckets dominados por objetos pequeños** de los data lakes donde la **cuota de monitorización de Intelligent-Tiering superaría el ahorro** (ver cálculo abajo) ≈ 243,33. Permanecen en Standard |
| **(=) Coste direccionable** | **1 737,00** | **80,0 %** | Sobre el que opera la transición de clase |

**% direccionable (Req 4.2) = `80,0 %`** del coste base afectado (`1 737,00 / 2 170,80`).

> La concentración del Registro 9.1 (cuentas `infra`, `data-dev`, `iskaypet-data` = ~89,8 % del
> Standard) y la verificación en vivo del Registro 9.2 (sus mayores buckets **sin** regla de
> transición de clase) sostienen un % direccionable alto: el grueso del Standard es **backups**
> (`buckets3veeambackup` ~60 TB) y **data lake bronze/staging** (`ikp-bl-*`/`ikp-st-*`), datos fríos
> por naturaleza. El reserva del 18,73 % es deliberadamente conservador (incluye los activos de
> ecommerce calientes y las cuentas no verificadas en vivo en la Tarea 9.2).

## Supuesto de transición de clase y duración mínima (Req 12.4)

**Supuesto de transición (Req 12.4):** mover los objetos **fríos** (no accedidos durante un umbral)
de S3 Standard a clases más baratas mediante reglas de **lifecycle**, **respetando la duración
mínima de almacenamiento** de cada clase de destino para no incurrir en penalización por borrado
anticipado (`EarlyDelete`):

| Clase destino | Precio público (eu-west-1, 2026-06-23) | Duración mínima | Uso en la Palanca |
|---------------|----------------------------------------:|-----------------|-------------------|
| S3 Standard (origen, blended observado) | ≈ 0,0207 USD/GB-mes | — | Origen |
| S3 Standard-IA | 0,0125 USD/GB-mes (+ recuperación 0,01 USD/GB) | **30 días** | Lake con acceso ocasional (Conservador) |
| S3 Glacier Flexible Retrieval | 0,0036 USD/GB-mes | **90 días** | Backups / lake frío (Conservador backups, Agresivo lake) |
| S3 Glacier Deep Archive | 0,00099 USD/GB-mes | **180 días** | Backups Veeam (Agresivo) — leen rarísimamente |
| Intelligent-Tiering | = Standard tier frecuente + cuota monitorización 0,0025 USD/1 000 obj | — (sin mínimo) | Datasets de acceso **mixto/desconocido** con objetos grandes |

**Reducción unitaria por GB transicionado** (frente al Standard blended `0,0207`): a Standard-IA
≈ **40 %**; a Glacier Flexible ≈ **83 %**; a Glacier Deep Archive ≈ **95 %**.

**Respeto de la duración mínima (Req 12.4):** la fórmula asume que solo se transicionan objetos cuya
antigüedad supera el umbral de la clase destino (≥30d para IA, ≥90d para Glacier Flexible, ≥180d
para Deep Archive) y que no se accederán dentro de ese mínimo; así **no** se aplican penalizaciones
`EarlyDelete`. Los objetos recién escritos (por debajo del mínimo) permanecen en Standard hasta
envejecer — capturado en el lado **Conservador** del rango y en la reserva del % direccionable.

## Exclusión de acceso frecuente — cuota de monitorización de IT > ahorro (Req 12.2)

La cuota de monitorización/automatización de Intelligent-Tiering es **0,0025 USD por 1 000 objetos /
mes** (≈ `2,5×10⁻⁶ USD/objeto`). El ahorro de tiering de un objeto de tamaño `S` GB al bajar de
Standard (`0,0207`) a la sub-clase IA de IT (`0,0125`) es `0,0082 × S` USD/mes. La monitorización
**supera** el ahorro cuando:

```
2,5×10⁻⁶  >  0,0082 × S    ⇒    S  <  ~0,000305 GB  ≈  305 KB
```

Además, Intelligent-Tiering **no auto-transiciona** objetos < 128 KB (permanecen en el tier
frecuente) pero **sí** devenga monitorización sobre ellos. **Conclusión (Req 12.2):** los buckets
**dominados por objetos pequeños** (típico de data lakes con millones de ficheros diminutos y de los
activos estáticos de ecommerce) se **excluyen** del ahorro por Intelligent-Tiering —la cuota de
monitorización erosionaría o superaría el ahorro— y, donde el dato sea frío, se prefiere
**lifecycle directo a Glacier** (que **no** tiene cuota por objeto). Estos objetos forman parte de
la reserva (−2) del % direccionable. Coherente con el Registro 9.2 (hallazgo 5): para backups de
acceso predecible, lifecycle a Glacier/Deep Archive es más eficiente que IT; IT solo es candidato
para datasets de acceso mixto/desconocido **con objetos grandes** (p. ej. parte de los datawarehouse).

## Versionado y MPU incompletas en el almacenamiento facturable (Req 12.3)

El Registro 9.2 confirmó dos efectos que **inflan el almacenamiento facturable de Standard** sin
aparecer como objetos actuales visibles; ambos están **dentro** de la base congelada `2 170,80` y se
sanean **como parte** de la transición (no se suman aparte, para evitar doble conteo):

1. **MPU incompletas masivas (Req 12.3).** `ikp-bl-dev` e `ikp-bl-pro` acumulan **≥ 80 000** cargas
   multiparte incompletas cada uno, y `kiwoko-datawarehouse-dev` **12 115**, **sin** regla
   `AbortIncompleteMultipartUpload`. Cada parte retiene almacenamiento Standard facturable. La
   Palanca incorpora una regla `AbortIncompleteMultipartUpload` (p. ej. `DaysAfterInitiation=7`) en
   estos buckets: es la componente de **mayor certeza** del rango (saneamiento de desperdicio puro,
   próximo a Garantizado), pero al no poder dimensionar el GB exacto de las partes con datos de solo
   lectura se mantiene **dentro del Estimado** y sostiene su **suelo Conservador**.
2. **Versionado sin expiración de versiones no actuales (Req 12.3).** El bucket dominante de `infra`
   `buckets3veeambackup` (~60 TB) tiene versionado **Enabled sin** `NoncurrentVersionExpiration`;
   varios grandes están **Suspended** (retienen versiones no actuales previas). La Palanca añade
   `NoncurrentVersionTransition` (a Glacier) + `NoncurrentVersionExpiration` (tras la retención) para
   netear estas versiones del almacenamiento facturable.
3. **No doble-contar los ya optimizados (Req 12.3).** `kiwoko-datawarehouse` ya tiene
   `NoncurrentVersion@3d + AbortIncompleteMPU@7d + ExpiredObjectDeleteMarker`, e `ikp-backup-pro` ya
   transiciona a Glacier/Deep Archive: **ninguno** recibe ahorro de tiering/abort/versión en esta
   fórmula (excluidos en la capa (−1) del % direccionable).

## Fórmula de ahorro y clasificación — **Estimado** (rango, Req 3.3, 6.1)

Ahorro mensual = `coste direccionable × reducción blended de transición`. Sobre el coste
direccionable **`1 737,00 USD/mes`**. Importes half-up a 2 decimales; los totales se suman **antes**
de redondear (Req 6.7). Segmentación por naturaleza del dato (usando el Standard por cuenta
congelado del Registro 9.1 + el ranking de buckets del Registro 9.2):

### Ahorro mensual por segmento

| Segmento (buckets) | Direccionable (USD/mes) | Destino Cons → Agr | Reducción Cons | Reducción Agr | Ahorro Cons | Ahorro Agr |
|--------------------|------------------------:|--------------------|---------------:|--------------:|------------:|-----------:|
| **Backups** (`buckets3veeambackup` ~60 TB, `infra`) | 1 065,00 | Glacier Flexible → Deep Archive | 62,0 % | 88,0 % | 660,30 | 937,20 |
| **Data lake bronze/staging** (`ikp-bl-*`, `ikp-st-*`, `data-dev`+`iskaypet-data`) | 672,00 | IA + Glacier parcial → Glacier Flexible | 43,9 % | 67,3 % | 295,05 | 452,40 |
| **Total direccionable** | **1 737,00** | — | **55,0 %** | **80,0 %** | **955,35** | **1 389,60** |

> El **suelo Conservador** del segmento backups (62 %) incorpora el saneamiento de versiones no
> actuales de `buckets3veeambackup` y la transición parcial a Glacier Flexible; el **techo Agresivo**
> (88 %) lleva los backups Veeam a Deep Archive (leen rarísimamente). El segmento lake incorpora la
> regla `AbortIncompleteMultipartUpload` (≥80 000 MPU en `ikp-bl-dev`/`ikp-bl-pro`) y la transición a
> IA (Cons) / Glacier (Agr) de los datos fríos, reservando los prefijos calientes y de objeto pequeño
> (excluidos por Req 12.2).

### Rango del Ahorro_Estimado (Req 3.3, 6.1) — mensual y anualizado

| Base | Rango_Conservador | Rango_Agresivo | Invariante |
|------|------------------:|---------------:|:----------:|
| **Mensual** | **955,35 USD** | **1 389,60 USD** | `0 < 955,35 ≤ 1 389,60` ✓ |
| **Anualizado ×12** | **11 464,20 USD** | **16 675,20 USD** | ✓ |

- Reducción **blended sobre el coste direccionable**: **55,0 %** (Cons) – **80,0 %** (Agr).
- Reducción **blended sobre el Standard total** (`2 170,80`): `955,35/2 170,80` = **44,0 %** (Cons) –
  `1 389,60/2 170,80` = **64,0 %** (Agr).

> **Advertencia de anualización (Req 6.3, 6.4):** las cifras anuales son el **mensual del
> Mes_Referencia (mayo 2026) × 12**; **asumen que el Mes_Referencia es representativo y NO capturan
> estacionalidad** ni el crecimiento orgánico del data lake (los buckets `ikp-bl-*`/`ikp-st-*` crecen
> mes a mes; el drift de capacidad observado en junio en el Registro 9.2 lo evidencia). Reevaluar con
> varios meses —idealmente con **S3 Storage Lens** para confirmar la fracción realmente fría— antes
> de comprometer la cifra anual.

**Clasificación: `Ahorro_Estimado`** (rango, **no** cifra única). El ahorro depende de supuestos
(fracción de objetos fríos, destino de clase elegido, ratio de precio público entre clases, %
direccionable, política de monitorización IT), no de desperdicio puro verificado. El estado de
lifecycle/versionado/MPU está **confirmado** en vivo (Registro 9.2), pero eso confirma la *base y la
ausencia de reglas*, no el *% de transición*, que sigue siendo estimado. Por tanto **no** es
`Ahorro_Garantizado` (Req 3.1, 3.3).

**Barrido_Utilizacion:** **no requerido**. Igual que la Palanca 4, el rango de la Palanca 7 no
depende de un perfil de uso 24/7 ni de p95 de CPU/RAM, sino de una decisión de arquitectura de
almacenamiento y de precio público; la Tarea 9.3 **no** la marca como `requiere Barrido_Utilizacion`
(Req 18.1 no aplica). Se **recomienda** —sin ser gating— un análisis de patrones de acceso (S3
Storage Lens) para afinar la fracción fría antes de comprometer el extremo Agresivo.

## Documentación por Palanca (Req 4.1–4.7)

| Campo (Req 4) | Valor |
|---------------|-------|
| **Supuesto de reducción** (4.1, % 0–100, 1 decimal) | **Total 55,0 % (Conservador) – 80,0 % (Agresivo)** del coste direccionable. Por segmento: backups 62,0/88,0 (Glacier Flexible → Deep Archive); data lake 43,9/67,3 (IA + Glacier → Glacier Flexible). Reducción unitaria por clase: IA ≈ 40 %, Glacier Flexible ≈ 83 %, Deep Archive ≈ 95 % |
| **% direccionable + coste base afectado** (4.2) | **80,0 %** direccionable; **coste base afectado = 2 170,80 USD/mes** (S3 Standard) → **coste direccionable = 1 737,00 USD/mes**. Excluido: 1,25 % ya optimizado (no doble-contar) + 18,73 % acceso frecuente/objeto pequeño (Req 12.2) |
| **Origen del supuesto + fecha** (4.3) | **Precio público AWS** S3 eu-west-1 (Standard ≈ 0,023 USD/GB-mes; Standard-IA 0,0125; Glacier Flexible 0,0036; Glacier Deep Archive 0,00099; cuota monitorización Intelligent-Tiering 0,0025 USD/1 000 obj), fecha del dato **2026-06-23**. Los % de transición son estimaciones de ingeniería ancladas al ratio de precio público y a la naturaleza fría del dato (backups/lake); re-confirmar contra la calculadora vigente y S3 Storage Lens |
| **Riesgo** (4.4) | **Medio** — latencia de recuperación en Glacier (Flexible: minutos–horas; Deep Archive: hasta 12 h) y coste de restore si el dato se necesita; penalización `EarlyDelete` si se transiciona por debajo de la duración mínima (mitigado respetando 30/90/180 días, Req 12.4); riesgo de mover datos servidos en caliente (mitigado excluyendo ecommerce/objeto pequeño, Req 12.2) |
| **Esfuerzo** (4.5) | **Medio** — definir reglas de lifecycle por bucket (transición de clase + `AbortIncompleteMultipartUpload` + `NoncurrentVersionTransition`/`Expiration`), validar patrones de acceso con S3 Storage Lens y coordinar con los dueños del dato; el saneamiento de ≥80 000 MPU en `ikp-bl-dev`/`ikp-bl-pro` y del versionado de `buckets3veeambackup` (~60 TB) es de alto impacto y baja complejidad |
| **Owner / equipos** (4.6) | **Pendiente** (correo por confirmar). Palanca **transversal** → equipos responsables: **Data** (cuentas `data-dev` 100200300400 e `iskaypet-data` 200300400500, dueña de los data lakes `ikp-bl-*`/`ikp-st-*`) **+ SRE/Plataforma** (cuenta `infra` 300400500600, `buckets3veeambackup` Veeam) **+ Digital ecommerce** (`888899990000`/`222333444555`, activos servidos por CDN — mayormente excluidos por acceso frecuente) |
| **Campos "pendiente"** (4.7) | `owner` (correo corporativo) = **"pendiente"**; equipos identificados (Data + SRE/Plataforma + Digital ecommerce), por lo que se enumeran en lugar de marcar el campo completo como pendiente |

## Registro de evidencia (esquema completo del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-9.3-s3-tiering-estimado-2026-05` |
| `cifra_publicada` | Ahorro_Estimado Palanca 7 (S3 lifecycle/tiering): **mensual 955,35 – 1 389,60 USD**; **anualizado ×12 11 464,20 – 16 675,20 USD** (bruto ≡ neto) |
| `descripcion` | Transición de clase de S3 Standard a IA/Glacier/Intelligent-Tiering (lifecycle), con saneamiento de MPU incompletas y versiones no actuales; rango Conservador–Agresivo. Coste base afectado 2 170,80 USD/mes (Standard), direccionable 80,0 % = 1 737,00 |
| `consulta_cur` | **No aplica** (cifra **derivada**): base = cifras congeladas del Registro 9.1 `EV-9.1-s3-timedstorage-clase-2026-05` (consulta `%TimedStorage%` por clase + Standard por cuenta); transformación = supuestos de transición de clase (precio público AWS) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T09:05:00Z` (UTC) — heredada del `Dataset_Congelado` de la base (Registro 9.1) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | Base agregada por clase (`no atribuible a recurso`). Buckets direccionables (Registro 9.2): `["arn:aws:s3:::buckets3veeambackup","arn:aws:s3:::ikp-bl-dev","arn:aws:s3:::ikp-st-dev","arn:aws:s3:::ikp-bl-pro","arn:aws:s3:::ikp-st-pro","arn:aws:s3:::kiwoko-datawarehouse-dev"]`. **Excluidos por ya optimizados** (no doble-contar): `["arn:aws:s3:::ikp-backup-pro","arn:aws:s3:::kiwoko-datawarehouse"]` |
| `dimension_agregacion` | Base afectada = `SUM(line_item_unblended_cost)` de S3 Standard (`%TimedStorage%` sin sufijo de clase, Registro 9.1); segmentación por `line_item_usage_account_id` (cruce 9.1) + ranking `BucketSizeBytes/StandardStorage` (CloudWatch, Registro 9.2) |
| `verificacion_vivo` | Sub-registro `EV-9.2-s3-buckets-live-2026-06-23` (estado **confirmado**, `eu-west-1`, solo lectura) — confirma lifecycle ausente/sin transición, versionado y MPU incompletas de los buckets direccionables |
| `clasificacion` | **`estimado`** (rango; `0 < Conservador ≤ Agresivo`). Base y ausencia de reglas confirmadas en vivo; el % de transición es el componente estimado. No requiere Barrido_Utilizacion |

## Estado de ejecución (Tarea 9.3)

- ✅ **Completada.** Fórmula de transición de clase aplicada sobre el coste direccionable
  (`1 737,00 USD/mes` = 80,0 % del Standard `2 170,80`), segmentada en backups (62–88 %) y data lake
  (43,9–67,3 %); total **955,35 – 1 389,60 USD/mes** (anualizado ×12 **11 464,20 – 16 675,20**).
- ✅ **Supuesto de transición declarado y duración mínima respetada (Req 12.4):** IA ≥30d, Glacier
  Flexible ≥90d, Deep Archive ≥180d; sin penalización `EarlyDelete` por construcción.
- ✅ **Exclusión de acceso frecuente (Req 12.2):** activos de ecommerce servidos por CDN y buckets de
  objeto pequeño (< ~305 KB) donde la cuota de monitorización de IT supera el ahorro → excluidos con
  motivo (cálculo documentado); preferido lifecycle directo a Glacier.
- ✅ **Versionado y MPU incompletas considerados (Req 12.3):** `AbortIncompleteMultipartUpload` para
  los ≥80 000 MPU de `ikp-bl-dev`/`ikp-bl-pro`; `NoncurrentVersionTransition/Expiration` para el
  versionado Enabled de `buckets3veeambackup` (~60 TB); **sin doble-contar** `ikp-backup-pro` y
  `kiwoko-datawarehouse` (ya optimizados, excluidos del % direccionable).
- ✅ **Clasificada `Estimado`** con rango Conservador–Agresivo (invariante `0 < Cons ≤ Agr` ✓),
  mensual y anualizado ×12 con advertencia de estacionalidad/crecimiento (Req 3.3, 6.1, 6.3, 6.4).
- ✅ **Documentación Req 4** completa; **owner "pendiente"** (Data + SRE/Plataforma + Digital
  ecommerce, transversal).
- Trazabilidad: cifra **derivada** de `EV-9.1-s3-timedstorage-clase-2026-05`, estado de recurso
  **confirmado** por `EV-9.2-s3-buckets-live-2026-06-23`; anclada a `frozen-2026-05@2026-06-23`.
- Auditorías aguas abajo: rango/clasificación → Tarea 17.3 (Property 4/5/6); anualización/redondeo →
  Tarea 17.5 (Property 8/9); biyección cifra↔evidencia → Tarea 17.2 (Property 2/3); ausencia de doble
  conteo (ya optimizados excluidos) → Tarea 17.4 (Property 7).
