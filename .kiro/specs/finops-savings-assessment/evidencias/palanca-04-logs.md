# Palanca 4 — Logs de CloudWatch y WAF · Registro de evidencia (Tarea 6.1)

> Artefacto auditable del Estudio FinOps de Ahorro AWS. Aísla el coste de logs vendidos
> (`VendedLog`) de CloudWatch en el Mes_Referencia por cuenta, región y tipo, identifica las
> mayores fuentes y, en particular, los **logs de WAF de CloudFront en `us-east-1`** con su cuenta
> de origen. Cifras congeladas (EU + `us-east-1`) contra el `Dataset_Congelado`.
>
> **Tarea 6.1** — _Requirements: 11.1, 11.2, 2.3_.
> La `Verificacion_Recurso_Vivo` en `us-east-1` (`wafv2 list-logging-configurations`,
> `logs describe-log-groups`) corresponde a la **Tarea 6.2** (no incluida aquí). La fórmula,
> clasificación y documentación de Palanca corresponden a la **Tarea 6.3**.

## Parámetros del Dataset_Congelado (anclaje — Req 1.2, 1.3, 2.5)

| Campo | Valor |
|-------|-------|
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23T08:15:23Z` (UTC) · `2026-06-23T10:15+02:00` (Europe/Madrid, CEST) |
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

## Registro 6.1 — Logs vendidos de CloudWatch (CloudWatch + WAF)

**Validates: Requirements 11.1, 11.2, 2.3**

**Clasificación del registro:** mixta —
- las cifras **agregadas por cuenta/región/tipo** son `no atribuible a recurso` (agregación por
  dimensión, Req 2.3);
- la fuente **WAF de CloudFront en `us-east-1`** se desglosa además a **recurso identificable**
  (ARN de log group de CloudWatch Logs, Req 2.2), listado más abajo.

**Dimensión de agregación (Req 2.3):** `(line_item_usage_account_id, product_region_code,
line_item_usage_type)`; valor de agregación = `SUM(line_item_unblended_cost)` (bruto) y
`SUM(line_item_net_unblended_cost)` (neto). Para el recurso WAF, dimensión adicional
`line_item_resource_id`.

### Consulta CUR exacta (re-ejecutable) — Q1: por cuenta, región y tipo

```sql
SELECT line_item_usage_account_id    AS account,
       product_region_code           AS region,
       line_item_usage_type          AS usage_type,
       SUM(line_item_unblended_cost) AS cost,
       COUNT(*)                      AS line_items
FROM data
WHERE line_item_product_code = 'AmazonCloudWatch'
  AND line_item_usage_type LIKE '%VendedLog%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

### Consulta CUR exacta (re-ejecutable) — Q2: bruto vs neto por tipo de línea

Añade `line_item_line_item_type` y la medida neta para separar el **uso** (`Usage`) de los
**descuentos** (`SppDiscount`, `BundledDiscount`) que el CUR imputa con `product_region_code` NULL.

```sql
SELECT line_item_usage_account_id        AS account,
       COALESCE(product_region_code,'(null)') AS region,
       line_item_usage_type              AS usage_type,
       line_item_line_item_type          AS lit,
       SUM(line_item_unblended_cost)     AS unblended,
       SUM(line_item_net_unblended_cost) AS net_unblended,
       COUNT(*)                          AS line_items
FROM data
WHERE line_item_product_code = 'AmazonCloudWatch'
  AND line_item_usage_type LIKE '%VendedLog%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2, 3, 4
ORDER BY 5 DESC;
```

### Consulta CUR exacta (re-ejecutable) — Q3: WAF `us-east-1` por recurso (log group)

Identifica la fuente WAF de CloudFront a nivel de ARN de log group y su cuenta de origen
(`888899990000`, digital-ecommerce) — Req 11.2, 2.2.

```sql
SELECT line_item_resource_id             AS resource_id,
       SUM(line_item_unblended_cost)     AS gross,
       SUM(line_item_net_unblended_cost) AS net,
       COUNT(*)                          AS line_items
FROM data
WHERE line_item_product_code = 'AmazonCloudWatch'
  AND line_item_usage_type  = 'USE1-VendedLog-Bytes-WAFLogs'
  AND line_item_usage_account_id = '888899990000'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

### Comandos de ejecución re-ejecutables (Athena vía AWS CLI; credenciales por nombre de perfil — Req 7.2, 7.5)

```bash
# Q1 — por cuenta/región/tipo
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "<Q1 de arriba, en una sola línea>" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/

# Q2 — bruto vs neto por tipo de línea   (idéntico patrón, query-string = Q2)
# Q3 — WAF us-east-1 por log group        (idéntico patrón, query-string = Q3)
```

### Ejecuciones congeladas (QueryExecutionId)

| Consulta | QueryExecutionId | Estado | Bytes escaneados |
|----------|------------------|--------|-----------------:|
| Q1 — por cuenta/región/tipo | `202a8910-e268-454b-81fb-c47cd50c54cf` | `SUCCEEDED` | 3 993 362 |
| Q2 — bruto vs neto por tipo de línea | `98ed2b96-d107-422b-a9d8-967ee6904ddb` | `SUCCEEDED` | — |
| Q3 — WAF `us-east-1` por log group | `79c19836-7a8f-4fe5-a102-96e96a7dba41` | `SUCCEEDED` | — |

---

## Cifras congeladas (USD, `frozen-2026-05@2026-06-23`)

> Convención: **bruto** = `SUM(line_item_unblended_cost)` de las líneas `Usage`; **neto** =
> `SUM(line_item_net_unblended_cost)` (ya incluye `SppDiscount` + `BundledDiscount`). Los descuentos
> se imputan en el CUR con `product_region_code` NULL y `net_unblended = 0` (la rebaja ya está
> reflejada en el neto de la línea `Usage`). Importes redondeados a 2 decimales half-up; los totales
> se suman **antes** de redondear (Req 6.7).

### Totales VendedLog (todas las cuentas, todas las regiones)

| Métrica | Bruto (unblended) | Neto (net_unblended) |
|---------|------------------:|---------------------:|
| **Total logs vendidos CloudWatch** | **2 774,92** | **2 374,51** |
| de los cuales: descuentos (SppDiscount + BundledDiscount) | −400,40 | (reflejado en neto) |

### Desglose por región (líneas `Usage`)

| Región | Bruto (USD) | Neto (USD) | Comentario |
|--------|------------:|-----------:|------------|
| `us-east-1` | **2 168,27** | **1 817,71** | Dominado por WAF de CloudFront (logs globales) |
| `eu-west-1` | **606,64** | **556,80** | Logs CloudWatch/WAF de la región principal |
| `eu-north-1` | 0,0001 | 0,0001 | Residual (root) |
| `us-east-2`, `us-west-2`, `eu-central-1`, `eu-west-2` | ≈ 0,00 | ≈ 0,00 | Residual / cero |

> **EU vs us-east-1 (cifra congelada del artefacto):** EU (`eu-*` agregado) = **606,64 bruto /
> 556,80 neto**; `us-east-1` = **2 168,27 bruto / 1 817,71 neto**. Coincide con el ejemplo trabajado
> del `design.md` (WAF `us-east-1` ≈ $2,17k + VendedLog EU ≈ $0,57k), siendo $0,57k la fracción
> `EU-VendedLog-Bytes` de la cuenta `888899990000` (574,07 bruto).

### Mayores fuentes (líneas `Usage`, top por bruto)

| # | Cuenta (ID) | Nombre | Región | Tipo de uso | Bruto (USD) | Neto (USD) | Líneas |
|---|-------------|--------|--------|-------------|------------:|-----------:|-------:|
| 1 | 888899990000 | Digital Ecommerce | `us-east-1` | `USE1-VendedLog-Bytes-WAFLogs` | **2 166,67** | **1 816,23** | 155 |
| 2 | 888899990000 | Digital Ecommerce | `eu-west-1` | `EU-VendedLog-Bytes` | 574,07 | 528,14 | 752 |
| 3 | 333344445555 | EKS Prod | `eu-west-1` | `EU-VendedLog-Bytes-WAFLogs` | 17,11 | 14,43 | 76 |
| 4 | 200300400500 | Iskaypet Data | `eu-west-1` | `EU-VendedLog-Bytes` | 11,15 | 10,26 | 563 |
| 5 | 333344445555 | EKS Prod | `eu-west-1` | `EU-VendedLog-Bytes` | 3,28 | 3,02 | 42 |
| 6 | 222333444555 | Ecommerce Tiendanimal | `us-east-1` | `USE1-VendedLog-Bytes` | 1,60 | 1,48 | 93 |
| 7 | 300400500600 | infraestructura | `eu-west-1` | `EU-VendedLog-Bytes` | 0,34 | 0,31 | 34 |
| 8 | 100200300400 | Data desarrollo | `eu-west-1` | `EU-VendedLog-Bytes` | 0,20 | 0,19 | 302 |
| 9 | 222333444555 | Ecommerce Tiendanimal | `eu-west-1` | `EU-VendedLog-Bytes` | 0,20 | 0,19 | 124 |
| 10 | 111222333444 | Digital Prod | `eu-west-1` | `EU-VendedLog-Bytes` | 0,10 | 0,10 | 93 |

El resto de cuentas/regiones (eks-tooling, eks-dev, eks-uat, digital-dev/uat, sap, retail, helios,
sandbox, log, audit…) aportan cifras `EU-VendedLog-Bytes` residuales (< $0,10/mes cada una). La
señal de coste está **concentrada** en la cuenta `888899990000` (digital-ecommerce): suma el
**~99,0%** del bruto total de logs vendidos (2 740,74 de 2 774,92), todo él WAF de CloudFront en
`us-east-1` + el `EU-VendedLog-Bytes` de su región.

---

## Fuente WAF de CloudFront en `us-east-1` (Req 11.2, 2.2) — desglose por recurso

**Cuenta de origen:** `888899990000` (Digital Ecommerce / digital-ecommerce).
**Tipo de uso:** `USE1-VendedLog-Bytes-WAFLogs` (logs de AWS WAF asociados a distribuciones de
CloudFront; WAF de CloudFront es **global** y factura en `us-east-1`).

| Log group (ARN, recurso identificable — Req 2.2) | Marca | Bruto (USD) | Neto (USD) | Líneas |
|---------------------------------------------------|-------|------------:|-----------:|-------:|
| `arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-tiendanimal` | Tiendanimal (prod) | 881,45 | 738,11 | 31 |
| `arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-kiwoko` | Kiwoko (prod) | 827,28 | 693,71 | 31 |
| `arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-animalis` | Animalis (prod) | 450,77 | 378,31 | 31 |
| `arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-tiendanimal-dev` | Tiendanimal (dev) | 5,80 | 4,94 | 31 |
| `arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-animalis-dev` | Animalis (dev) | 1,37 | 1,17 | 31 |
| (descuentos: `SppDiscount` −157,93 + `BundledDiscount` −192,50; `resource_id` NULL) | — | −350,43 | 0,00 | 32 |
| **Total WAF `us-east-1` (cuenta 888899990000)** | | **2 166,67** | **1 816,23** | 155 |

Notas:
- Son **5 log groups** WAF por marca (3 prod: tiendanimal, kiwoko, animalis; 2 dev: tiendanimal-dev,
  animalis-dev). Coherente con la nota del estado del portal ("CloudWatch Logs us-east-1 (WAF):
  ~$2.4k/mes, log groups por brand"); la cifra **bruta congelada** es **2 166,67 USD/mes** y la
  **neta** **1 816,23 USD/mes**.
- El **97,9%** del coste WAF `us-east-1` está en los 3 log groups de **producción**
  (tiendanimal + kiwoko + animalis = 2 159,50 bruto); los 2 dev son marginales (7,17 bruto).
- WAF total (todas las regiones, líneas `Usage`): **2 183,86 bruto / 1 830,74 neto**
  (`us-east-1` 2 166,67 + `eu-west-1` `EU-VendedLog-Bytes-WAFLogs`: EKS Prod 17,11 + eks-dev 0,08).

---

## Registro de evidencia (esquema del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-6.1-vendedlog-2026-05` |
| `descripcion` | Coste de logs vendidos de CloudWatch (CloudWatch + WAF) en el Mes_Referencia, por cuenta/región/tipo, con desglose del WAF de CloudFront en `us-east-1` por log group |
| `cifra_publicada` | Total VendedLog: **2 774,92 bruto / 2 374,51 neto** · `us-east-1`: **2 168,27 / 1 817,71** · EU: **606,64 / 556,80** · WAF CloudFront us-east-1 (888899990000): **2 166,67 / 1 816,23** |
| `consulta_cur` | Q1 (cuenta/región/tipo), Q2 (bruto vs neto por tipo de línea), Q3 (WAF us-east-1 por log group) — ver arriba |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:15:23Z` (UTC) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `dimension_agregacion` | `(line_item_usage_account_id, product_region_code, line_item_usage_type)`; para WAF us-east-1 además `line_item_resource_id` |
| `recurso_ids` | Agregados por dimensión = `["no atribuible a recurso"]`. WAF us-east-1 = `["arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-tiendanimal", "…:aws-waf-logs-kiwoko", "…:aws-waf-logs-animalis", "…:aws-waf-logs-tiendanimal-dev", "…:aws-waf-logs-animalis-dev"]` |
| `verificacion_vivo` | Pendiente — **Tarea 6.2** (`us-east-1`: `wafv2 list-logging-configurations`, `logs describe-log-groups`; Req 11.2, 5.2) |
| `clasificacion` | Dentro del alcance técnico (CloudWatch/WAF logs es infra AWS direccionable; la Palanca se clasifica Estimado en la Tarea 6.3) |
| `QueryExecutionId` | Q1 `202a8910-e268-454b-81fb-c47cd50c54cf` · Q2 `98ed2b96-d107-422b-a9d8-967ee6904ddb` · Q3 `79c19836-7a8f-4fe5-a102-96e96a7dba41` |

---

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23`, fecha de extracción
  `2026-06-23T08:15:23Z`.
- Cifras congeladas y reproducibles: re-ejecutar las consultas documentadas (Q1/Q2/Q3) sobre el
  mismo Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría
  en Tarea 17.6).
- ⏭️ **Pendiente Tarea 6.2** — `Verificacion_Recurso_Vivo` en `us-east-1` (solo lectura) para
  confirmar destino y volumen de los log groups WAF de CloudFront.
- ⏭️ **Pendiente Tarea 6.3** — fórmula (redirección a S3 / muestreo / metric filters), clasificación
  (Estimado, rango) y documentación de Palanca (Req 4).

---

## Verificacion_Recurso_Vivo en `us-east-1` (Tarea 6.2 — solo lectura)

**Validates: Requirements 5.1, 5.2, 11.2**

> Confirma en vivo el **destino** (log group de CloudWatch Logs) y el **volumen** del WAF de
> CloudFront cuyas cifras de coste se congelaron en el Registro 6.1, ejecutando la verificación
> **en la región donde reside el recurso** (`us-east-1`, porque el WAF de CloudFront es global y
> factura/registra en `us-east-1`, no en `eu-west-1` — Req 5.2). Exclusivamente operaciones de
> **solo lectura** (`list`/`describe`); ninguna operación mutante (Req 5.1).

### Parámetros de la verificación (Req 5.5)

| Campo | Valor |
|-------|-------|
| Cuenta consultada | `888899990000` (Digital Ecommerce / digital-ecommerce) |
| Región consultada | `us-east-1` (recurso global de CloudFront/WAF — Req 5.2) |
| Identidad efectiva | `arn:aws:sts::888899990000:assumed-role/AWSReservedSSO_SRE_2a9f954eac099984/ruben.landin@emefinpetcare.com` |
| Perfil / credenciales | perfil `digital-ecommerce` (SSO SRE, `sso_role_name = SRE`); **sin credenciales incrustadas** (Req 7.5) |
| Fecha-hora UTC | `2026-06-23T08:50:59Z` |
| Estado | **confirmado** |

### Comandos de solo lectura re-ejecutables (Req 5.1, 7.5) — región `us-east-1`

```bash
# 1) Identidad (sanity check de cuenta/rol — solo lectura)
aws sts get-caller-identity --profile digital-ecommerce --region us-east-1

# 2) Configuraciones de logging del WAF de CloudFront (scope global → us-east-1)
aws wafv2 list-logging-configurations \
  --scope CLOUDFRONT --region us-east-1 --profile digital-ecommerce

# 3) Destino y volumen de los log groups WAF en CloudWatch Logs
aws logs describe-log-groups \
  --log-group-name-prefix aws-waf-logs --region us-east-1 --profile digital-ecommerce \
  --query 'logGroups[].{name:logGroupName,storedBytes:storedBytes,retentionInDays:retentionInDays,created:creationTime}' \
  --output table
```

> **Solo lectura (Req 5.1):** los tres comandos son `get`/`list`/`describe`. No se ejecutó ninguna
> operación mutante (`put-logging-configuration`, `delete-log-group`, `put-retention-policy`, etc.).

### Resultado A — `wafv2 list-logging-configurations --scope CLOUDFRONT` (5 web ACLs)

Las 5 web ACLs globales de CloudFront tienen logging activo (`LogType: WAF_LOGS`,
`LogScope: CUSTOMER`, `ManagedByFirewallManager: false`), confirmando el origen del coste
`USE1-VendedLog-Bytes-WAFLogs` del Registro 6.1:

| Web ACL (CloudFront, `us-east-1`) | Destino de logging (log group) en el momento de la verificación |
|-----------------------------------|------------------------------------------------------------------|
| `animalis` (prod) | `arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-animalis-ia` |
| `kiwoko` (prod) | `arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-kiwoko-ia` |
| `tiendanimal` (prod) | `arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-tiendanimal-ia` |
| `animalis-dev` | `arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-animalis-dev` |
| `tiendanimal-dev` | `arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-tiendanimal-dev` |

### Resultado B — `logs describe-log-groups` (destino + volumen)

Los **5 log groups del Registro 6.1 existen** con volumen acorde a su peso en coste, y además
aparecen **3 log groups nuevos `-*-ia`** (ver nota de drift):

| Log group (`us-east-1:888899990000`) | En CUR 6.1 | `storedBytes` | ≈ | Retención (días) | Creado (UTC) |
|--------------------------------------|:----------:|--------------:|---|-----------------:|--------------|
| `aws-waf-logs-tiendanimal` | ✅ | 1 457 814 216 088 | ~1,46 TB | 90 | 2024-04-22 |
| `aws-waf-logs-kiwoko` | ✅ | 1 329 275 166 956 | ~1,33 TB | 90 | 2024-04-22 |
| `aws-waf-logs-animalis` | ✅ | 839 309 492 132 | ~839 GB | 90 | 2023-08-08 |
| `aws-waf-logs-tiendanimal-dev` | ✅ | 4 817 654 832 | ~4,82 GB | 30 | 2024-07-08 |
| `aws-waf-logs-animalis-dev` | ✅ | 1 587 901 525 | ~1,59 GB | 30 | 2025-07-22 |
| `aws-waf-logs-tiendanimal-ia` | nuevo (drift) | 205 138 800 326 | ~205 GB | 90 | 2026-06-11 |
| `aws-waf-logs-kiwoko-ia` | nuevo (drift) | 173 613 318 697 | ~174 GB | 90 | 2026-06-11 |
| `aws-waf-logs-animalis-ia` | nuevo (drift) | 127 336 136 903 | ~127 GB | 90 | 2026-06-11 |

> `storedBytes` es el almacenamiento **acumulado** bajo la retención vigente (no la ingesta de mayo),
> y sirve como indicador **relativo** de volumen. Confirma la jerarquía del coste del Registro 6.1:
> los 3 grupos **prod** (tiendanimal > kiwoko > animalis) concentran el volumen (TB), mientras los 2
> **dev** son marginales (GB), coherente con el 97,9 % del coste WAF en producción.

### Hallazgos y conclusión

- **Destino confirmado (Req 11.2):** el coste WAF de CloudFront de la cuenta `888899990000` se
  origina en log groups de **CloudWatch Logs** en `us-east-1`, alimentados por las 5 web ACLs
  globales de CloudFront. Los **5 log groups congelados en el Registro 6.1 existen** y su volumen
  relativo es coherente con la distribución de coste (prod ≫ dev).
- **Volumen confirmado:** los grupos prod almacenan ~0,8–1,5 TB cada uno (retención 90 días); los
  dev, ~1,6–4,8 GB. La señal de coste está concentrada en producción, como en el Registro 6.1.
- **Drift esperado (Req 7.6) — destino prod migrado a `-ia`:** en la verificación en vivo
  (`2026-06-23`), las 3 web ACLs de **producción** (`animalis`, `kiwoko`, `tiendanimal`) registran
  ahora en log groups con sufijo **`-ia`** (`aws-waf-logs-animalis-ia`, `-kiwoko-ia`,
  `-tiendanimal-ia`), **creados el `2026-06-11`** — es decir, **después** del Mes_Referencia
  (`2026-05`). Durante mayo, esas web ACLs registraban en los grupos de nombre base
  (`aws-waf-logs-animalis|kiwoko|tiendanimal`), que son exactamente los que el CUR imputa el coste en
  el Registro 6.1. Este drift entre la verificación en vivo y el `Dataset_Congelado` es **esperado**
  (Req 7.6) y **no invalida** las cifras ancladas a `frozen-2026-05@2026-06-23`: la fecha de creación
  de los grupos `-ia` (2026-06-11) es posterior a la ventana de facturación de mayo, y los grupos de
  nombre base siguen existiendo con su volumen acumulado.
- **Implicación para la Tarea 6.3:** la migración a grupos `-ia` (probablemente "Infrequent Access"
  o una segregación de clase de log) es un dato a tener en cuenta al modelar la fórmula de
  redirección a S3 / muestreo / metric filters de la Palanca, pero la cifra base de ahorro sigue
  anclada al coste congelado de mayo.

### Sub-registro de evidencia (esquema del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-6.2-waf-cloudfront-live-2026-06-23` |
| `descripcion` | Verificacion_Recurso_Vivo (solo lectura) del WAF de CloudFront en `us-east-1`: confirma destino (log groups de CloudWatch Logs) y volumen de las 5 web ACLs de la cuenta `888899990000` que originan el coste `USE1-VendedLog-Bytes-WAFLogs` del Registro 6.1 |
| `cuenta` | `888899990000` (digital-ecommerce) |
| `region` | `us-east-1` (recurso global CloudFront/WAF — Req 5.2) |
| `fecha_hora_utc` | `2026-06-23T08:50:59Z` |
| `estado` | **confirmado** |
| `metodo` | `aws sts get-caller-identity`; `aws wafv2 list-logging-configurations --scope CLOUDFRONT`; `aws logs describe-log-groups --log-group-name-prefix aws-waf-logs` (todas en `--region us-east-1 --profile digital-ecommerce`; solo lectura — Req 5.1) |
| `credenciales` | perfil `digital-ecommerce` (SSO SRE); sin credenciales incrustadas (Req 7.5) |
| `recurso_ids` | `["arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-tiendanimal", "…:aws-waf-logs-kiwoko", "…:aws-waf-logs-animalis", "…:aws-waf-logs-tiendanimal-dev", "…:aws-waf-logs-animalis-dev"]` (los 5 del Registro 6.1, confirmados existentes) |
| `recursos_nuevos_drift` | `["…:aws-waf-logs-animalis-ia", "…:aws-waf-logs-kiwoko-ia", "…:aws-waf-logs-tiendanimal-ia"]` (creados `2026-06-11`, posteriores al Mes_Referencia; drift esperado Req 7.6) |
| `drift_observado` | Sí — destino de logging de las 3 web ACLs prod migrado de los grupos de nombre base a los `-ia` el `2026-06-11` (post Mes_Referencia). No invalida las cifras congeladas (Req 7.6) |
| `clasificacion` | Confirmado (destino y volumen del WAF de CloudFront verificados en vivo en `us-east-1`); la clasificación de ahorro de la Palanca (**Estimado**, rango) es de la Tarea 6.3 |

### Estado de ejecución (Tarea 6.2)

- ✅ **Ejecutado** en vivo el `2026-06-23T08:50:59Z` (UTC) contra la cuenta `888899990000`, región
  `us-east-1`, perfil `digital-ecommerce` (SSO SRE), **solo lectura**.
- ✅ **Confirmado**: existen los 5 log groups del Registro 6.1, con volumen coherente con el coste; las
  5 web ACLs de CloudFront tienen logging activo a CloudWatch Logs en `us-east-1`.
- ⚠️ **Drift esperado** (Req 7.6): destino de logging prod migrado a grupos `-ia` el `2026-06-11`
  (posterior al Mes_Referencia `2026-05`); no afecta a las cifras ancladas a
  `frozen-2026-05@2026-06-23`.
- ⏭️ **Pendiente Tarea 6.3** — fórmula (redirección a S3 / muestreo / metric filters), exclusión de
  log groups de compliance/seguridad con retención obligatoria, clasificación **Estimado** (rango) y
  documentación de Palanca (Req 4).

---

# Fórmula, clasificación y documentación de la Palanca 4 (Tarea 6.3)

> Artefacto auditable de la **Tarea 6.3**: a partir de la cifra base congelada en el Registro 6.1
> (logs vendidos `VendedLog`, dominados por el WAF de CloudFront en `us-east-1`) y de la
> `Verificacion_Recurso_Vivo` `confirmado` del Registro 6.2, se aplica la fórmula de ahorro
> **distinguiendo las tres palancas de reducción** (redirección a S3, muestreo y metric filters),
> se marcan **no eliminables** los log groups de compliance/seguridad con retención obligatoria
> (solo redirección/muestreo), se clasifica la Palanca como **Estimado** (rango
> Conservador–Agresivo, invariante `0 < Cons ≤ Agr`) y se documentan los campos del Requisito 4.
>
> **Validates: Requirements 3.3, 11.3, 11.4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1**
>
> No se introduce ninguna consulta CUR nueva: la cifra base es **derivada** de las cifras
> congeladas del Registro 6.1 (ancladas a `frozen-2026-05@2026-06-23`); las transformaciones son
> supuestos de reducción con su origen y fecha. La existencia/volumen del recurso está confirmada
> en el Registro 6.2 (solo lectura, `us-east-1`).

## Coste base mensual afectado (Req 4.2) y % direccionable

La Palanca 4 actúa sobre los **logs vendidos de CloudWatch** (`%VendedLog%`). El total congelado del
Mes_Referencia es **2 774,92 USD bruto / 2 374,51 USD neto**. La señal direccionable por esta Palanca
está **concentrada en los logs de WAF** (de CloudFront en `us-east-1` + WAF de EKS Prod en
`eu-west-1`), que son los que admiten redirección de destino y muestreo a nivel de servicio:

| Componente de la base | Bruto (USD/mes) | Neto (USD/mes) | Tratamiento en la Palanca |
|-----------------------|----------------:|---------------:|---------------------------|
| WAF CloudFront `us-east-1` — **prod** (tiendanimal+kiwoko+animalis) | 2 159,50 | 1 810,13 | **No eliminable** (compliance/seguridad) → solo redirección + muestreo (Req 11.3) |
| WAF CloudFront `us-east-1` — **dev** (tiendanimal-dev+animalis-dev) | 7,17 | 6,11 | Flexible → redirección + muestreo + metric filters |
| WAF `eu-west-1` (`EU-VendedLog-Bytes-WAFLogs`: EKS Prod 17,11 + eks-dev 0,08) | 17,19 | 14,51 | Redirección + muestreo |
| **Coste base afectado por la Palanca (WAF, todas las regiones)** | **2 183,86** | **1 830,74** | Base de la fórmula |
| Resto VendedLog no-WAF (`EU-VendedLog-Bytes` de aplicación/CloudFront, residuales) | 591,06 | 543,77 | Fuera del alcance de esta Palanca (logs de aplicación; ajuste de nivel de log, no redirección WAF) |
| **Total VendedLog (denominador del % direccionable)** | **2 774,92** | **2 374,51** | — |

- **% direccionable de la Palanca (Req 4.2):** `2 183,86 / 2 774,92 = ` **78,7 %** (bruto)
  — los logs de WAF sobre el total de logs vendidos. El **78,1 %** del total VendedLog es WAF de
  CloudFront `us-east-1` exclusivamente (2 166,67 / 2 774,92).
- **Coste base mensual afectado (Req 4.2):** **2 183,86 USD bruto / 1 830,74 USD neto**.
- El **97,9 %** de la base afectada es **producción** (2 159,50 de 2 166,67 WAF `us-east-1`),
  marcada **no eliminable** por compliance (ver más abajo).

> **Bruto vs neto:** el ahorro real sobre lo facturado se mide en **neto** (ya incluye
> `SppDiscount` + `BundledDiscount`); reducir el gasto de CloudWatch reduce también el descuento
> agregado de forma proporcional. Se presenta el rango sobre **bruto** (consistente con el ejemplo
> trabajado del `design.md`, WAF `us-east-1` ≈ $2,17k) y, en paralelo, sobre **neto** (lectura más
> conservadora de lo efectivamente ahorrado). El ratio neto/bruto de la base WAF es
> `1 830,74 / 2 183,86 = 0,8383`.

## Las tres palancas de reducción (Req 11.4) — supuesto y % direccionable de cada una

El Req 11.4 exige **distinguir** la reducción atribuible a (a) **redirección a S3**, (b) **muestreo**
y (c) **metric filters**, cada una con su supuesto y % direccionable. Las tres se modelan como una
**descomposición en capas, aplicadas en secuencia sobre el mismo volumen WAF**, y se atribuye a cada
mecanismo una **porción disjunta** del ahorro total (en puntos porcentuales de la base afectada), de
modo que **suman exactamente el total sin solapes** (sin doble conteo, en el espíritu de la
Property 7). Los puntos de cada mecanismo **no son sumables de forma independiente más allá del
total**: son su contribución marginal dentro de la secuencia.

### (a) Redirección a S3 — palanca dominante

- **Supuesto (Req 4.1):** redirigir el destino de logging de las web ACLs de WAF de **CloudWatch
  Logs** a **S3** (directo o vía Kinesis Data Firehose) para el volumen que se conserva. La ingesta
  de *vended logs* en CloudWatch Logs cuesta **≈ 0,50 USD/GB** (precio público), mientras que el
  almacenamiento en **S3 Standard ≈ 0,023 USD/GB-mes** (más PUT/Firehose y consultas Athena), con
  ciclo de vida a IA/Glacier para la retención larga. La reducción del **coste unitario** del volumen
  retenido es del orden del 90–95 %, moderada por costes de Firehose, requests, Athena y la
  retención de compliance que se mantiene (más larga, pero baratísima en Glacier).
- **% direccionable:** aplica a **todo** el volumen WAF retenido, **incluidos los log groups de
  compliance** (la redirección no elimina el log, solo abarata su destino — Req 11.3). Es el
  mecanismo que más aporta porque la base es casi toda compliance/prod (no eliminable, pero sí
  redirigible).
- **Atribución al ahorro total:** **55,0 puntos** (Conservador) / **70,0 puntos** (Agresivo) de la
  base afectada.

### (b) Muestreo (logging filters de WAF)

- **Supuesto (Req 4.1):** configurar *logging filters* de AWS WAF para **no registrar** la fracción
  de tráfico de menor valor forense (típicamente las peticiones con acción `ALLOW`, que dominan el
  volumen) conservando íntegramente las acciones `BLOCK`/`COUNT` y los eventos relevantes de
  seguridad. Reduce **volumen ingerido** antes de la redirección.
- **% direccionable:** **limitado en producción** — en los grupos de compliance/seguridad **no** se
  descartan eventos de seguridad (`BLOCK`, reglas administradas, rate-based); solo se filtra el ruido
  `ALLOW` no requerido por la política de retención. En **dev** el muestreo puede ser agresivo.
- **Riesgo asociado:** pérdida de completitud forense → por eso se acota en prod.
- **Atribución al ahorro total:** **8,0 puntos** (Conservador) / **13,0 puntos** (Agresivo).

### (c) Metric filters

- **Supuesto (Req 4.1):** para los casos de uso cuyo **único** fin es métrica/alerta (recuentos de
  peticiones bloqueadas, tasas), sustituir la retención de log completo por **CloudWatch metric
  filters** que extraen solo la métrica, evitando ingerir/almacenar el contenido íntegro. Aporte
  **marginal**, porque AWS WAF ya emite **métricas nativas** de CloudWatch (las reglas publican
  contadores sin necesidad de parsear logs), de modo que los logs existen sobre todo para análisis
  forense/seguridad, no para métricas.
- **% direccionable:** pequeño — solo las porciones (principalmente **dev**/monitorización) cuyo
  valor es exclusivamente de conteo.
- **Atribución al ahorro total:** **2,0 puntos** (Conservador) / **5,0 puntos** (Agresivo).

### Composición del supuesto de reducción total (Req 4.1)

| Mecanismo | Conservador (pts de base) | Agresivo (pts de base) |
|-----------|--------------------------:|-----------------------:|
| (a) Redirección a S3 | 55,0 | 70,0 |
| (b) Muestreo | 8,0 | 13,0 |
| (c) Metric filters | 2,0 | 5,0 |
| **Reducción total de la base afectada** | **65,0 %** | **88,0 %** |

> Las tres se aplican en secuencia (muestrear → redirigir el volumen retenido → métricas para lo que
> solo es conteo); la atribución en puntos disjuntos garantiza que cada punto porcentual de coste se
> asigna a un único mecanismo (sin doble conteo). El supuesto de reducción total es **65,0 %**
> (Conservador) – **88,0 %** (Agresivo) **del coste base afectado**, ambos ∈ [0, 100] con 1 decimal
> (Req 4.1).

## Marcado de no eliminables — compliance/seguridad con retención obligatoria (Req 11.3)

Los **3 log groups de producción** del WAF de CloudFront son la salida de un **control de seguridad**
(AWS WAF protege las tiendas de ecommerce con flujos de pago, ámbito típicamente sujeto a
**retención de auditoría obligatoria**, p. ej. PCI-DSS ≈ 12 meses). Se marcan **no eliminables**: la
Palanca **no** los suprime; solo aplica **redirección a S3** (con ciclo de vida a Glacier para
sostener la retención larga a coste mínimo) y **muestreo limitado** del ruido `ALLOW` **sin** tocar
los eventos de seguridad. Quedan **excluidos de cualquier supresión total y de "solo metric
filters"**.

| Log group (`us-east-1:888899990000`) | Clasificación | Mecanismos permitidos | Motivo |
|--------------------------------------|---------------|-----------------------|--------|
| `aws-waf-logs-tiendanimal` (prod) | **No eliminable** (seguridad/compliance) | Redirección S3 + muestreo limitado | WAF de tienda con pagos; retención de auditoría obligatoria |
| `aws-waf-logs-kiwoko` (prod) | **No eliminable** (seguridad/compliance) | Redirección S3 + muestreo limitado | Íd. |
| `aws-waf-logs-animalis` (prod) | **No eliminable** (seguridad/compliance) | Redirección S3 + muestreo limitado | Íd. |
| `aws-waf-logs-tiendanimal-dev` (dev) | Flexible | Redirección + muestreo + metric filters | Entorno no productivo |
| `aws-waf-logs-animalis-dev` (dev) | Flexible | Redirección + muestreo + metric filters | Entorno no productivo |

> **Corroboración del Registro 6.2 (drift `-ia`):** la verificación en vivo detectó **3 log groups
> nuevos `-*-ia`** creados el `2026-06-11` (posteriores al Mes_Referencia) a los que las web ACLs
> prod ya redirigen su logging. Esto evidencia que la cuenta `888899990000` **ya inició** una
> reestructuración del destino/clase de los logs de WAF, lo que **reduce el riesgo y el esfuerzo** de
> la palanca de redirección (parte del camino está en marcha) y **no altera** la cifra base anclada a
> mayo 2026.

## Fórmula de ahorro y clasificación — **Estimado** (rango, Req 3.3, 6.1)

Ahorro mensual = `base afectada × supuesto de reducción total`. Sobre la base WAF **bruta**
2 183,86 USD (y en paralelo la **neta** 1 830,74 USD). Importes half-up a 2 decimales; los totales se
suman **antes** de redondear (Req 6.7).

### Ahorro mensual por mecanismo (bruto)

| Mecanismo | Conservador (USD/mes) | Agresivo (USD/mes) |
|-----------|----------------------:|-------------------:|
| (a) Redirección a S3 | 1 201,12 | 1 528,70 |
| (b) Muestreo | 174,71 | 283,90 |
| (c) Metric filters | 43,68 | 109,19 |
| **Total mensual (bruto)** | **1 419,51** | **1 921,80** |

### Rango del Ahorro_Estimado (Req 3.3, 6.1) — mensual y anualizado

| Base | Rango_Conservador | Rango_Agresivo | Invariante |
|------|------------------:|---------------:|:----------:|
| **Mensual (bruto)** | **1 419,51 USD** | **1 921,80 USD** | `0 < 1 419,51 ≤ 1 921,80` ✓ |
| **Anualizado ×12 (bruto)** | **17 034,11 USD** | **23 061,56 USD** | ✓ |
| Mensual (neto, lectura conservadora) | 1 189,98 USD | 1 611,05 USD | ✓ |
| Anualizado ×12 (neto) | 14 279,77 USD | 19 332,61 USD | ✓ |

> **Advertencia de anualización (Req 6.3, 6.4):** las cifras anuales son el **mensual del
> Mes_Referencia (mayo 2026) × 12**; **asumen que el Mes_Referencia es representativo y NO capturan
> estacionalidad** (el tráfico de ecommerce —y por tanto el volumen de logs de WAF— es estacional:
> campañas, rebajas, Black Friday). Reevaluar con varios meses antes de comprometer la cifra anual.

**Clasificación: `Ahorro_Estimado`** (rango, **no** cifra única) — el ahorro depende de supuestos
(política de muestreo, destino S3 elegido, ratio de precio CloudWatch-vended vs S3, % direccionable),
no de desperdicio puro verificado. Por tanto **no** es `Ahorro_Garantizado` (Req 3.1, 3.3). La
existencia y el volumen del recurso están **confirmados** en vivo (Registro 6.2), pero eso confirma
la *base*, no el *% de reducción*, que sigue siendo estimado.

**Barrido_Utilizacion:** **no requerido**. A diferencia de las palancas de compromiso (1, 2) o de
utilización (5, 9, 10), el rango de la Palanca 4 no depende de un perfil de uso 24/7 ni de p95 de
CPU/RAM, sino de una decisión de arquitectura de logging y de precio público; por eso la Tarea 6.3
**no** la marca como `requiere Barrido_Utilizacion` (Req 18.1 no aplica aquí).

## Documentación por Palanca (Req 4.1–4.7)

| Campo (Req 4) | Valor |
|---------------|-------|
| **Supuesto de reducción** (4.1, % 0–100, 1 decimal) | **Total 65,0 % (Conservador) – 88,0 % (Agresivo)** de la base afectada. Desglose por mecanismo: redirección S3 55,0/70,0; muestreo 8,0/13,0; metric filters 2,0/5,0 |
| **% direccionable + coste base afectado** (4.2) | **78,7 %** del total VendedLog; **coste base afectado = 2 183,86 USD/mes bruto (1 830,74 neto)** sobre un total VendedLog de 2 774,92 bruto |
| **Origen del supuesto + fecha** (4.3) | **Precio público AWS** (CloudWatch Logs *vended logs* ingesta ≈ 0,50 USD/GB; S3 Standard ≈ 0,023 USD/GB-mes; destinos de logging de AWS WAF: CloudWatch Logs / S3 / Firehose), fecha del dato **2026-06-23**. Los % de reducción son estimaciones de ingeniería ancladas al ratio de precio público; re-confirmar contra la calculadora vigente |
| **Riesgo** (4.4) | **Medio** — el muestreo reduce completitud forense (acotado en prod por compliance); la redirección exige re-arquitectar el pipeline de logging y disponer de Athena/Glacier para consulta y retención; debe preservarse la retención obligatoria de los grupos de seguridad |
| **Esfuerzo** (4.5) | **Medio** — reconfigurar el destino de logging de 5 web ACLs (×3 marcas prod + 2 dev), montar bucket S3 + ciclo de vida + Athena, ajustar dashboards/alertas y *logging filters*; parcialmente iniciado (grupos `-ia` del `2026-06-11`) |
| **Owner / equipos** (4.6) | **Pendiente** (correo por confirmar). Palanca **transversal** → equipos responsables: **Digital ecommerce** (cuenta `888899990000`, dueña de las web ACLs/CloudFront y de la política de retención) **+ SRE/Plataforma** (pipeline de logging, S3/Athena) |
| **Campos "pendiente"** (4.7) | `owner` (correo corporativo) = **"pendiente"**; equipos identificados (Digital ecommerce + SRE), por lo que se enumeran en lugar de marcar el campo completo como pendiente |

## Registro de evidencia (esquema completo del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-6.3-waf-logs-estimado-2026-05` |
| `cifra_publicada` | Ahorro_Estimado Palanca 4 (logs WAF): **mensual 1 419,51 – 1 921,80 USD bruto** (neto 1 189,98 – 1 611,05); **anualizado ×12 17 034,11 – 23 061,56 USD bruto** (neto 14 279,77 – 19 332,61) |
| `descripcion` | Reducción del coste de logs vendidos de WAF (CloudFront `us-east-1` + WAF `eu-west-1`) por redirección a S3 + muestreo + metric filters; rango Conservador–Agresivo |
| `consulta_cur` | **No aplica** (cifra **derivada**): base = cifras congeladas del Registro 6.1 `EV-6.1-vendedlog-2026-05` (consultas Q1/Q2/Q3); transformación = supuestos de reducción (precio público AWS) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:15:23Z` (UTC) — heredada del `Dataset_Congelado` de la base (Registro 6.1) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["arn:aws:logs:us-east-1:888899990000:log-group:aws-waf-logs-tiendanimal", "…:aws-waf-logs-kiwoko", "…:aws-waf-logs-animalis", "…:aws-waf-logs-tiendanimal-dev", "…:aws-waf-logs-animalis-dev"]` + WAF `eu-west-1` (EKS Prod `333344445555`, eks-dev) |
| `dimension_agregacion` | Base afectada agregada por `line_item_usage_type LIKE '%VendedLog%'` filtrada a WAF (`%WAFLogs%` + WAF de CloudFront `USE1-VendedLog-Bytes-WAFLogs`); medida `SUM(line_item_unblended_cost)` (bruto) / `SUM(line_item_net_unblended_cost)` (neto) |
| `verificacion_vivo` | Sub-registro `EV-6.2-waf-cloudfront-live-2026-06-23` (estado **confirmado**, `us-east-1`, solo lectura) — confirma destino y volumen de la base |
| `clasificacion` | **`estimado`** (rango; `0 < Conservador ≤ Agresivo`). Existencia del recurso confirmada en vivo; el % de reducción es el componente estimado. No requiere Barrido_Utilizacion |

## Estado de ejecución (Tarea 6.3)

- ✅ **Completada.** Fórmula aplicada sobre la base WAF congelada (2 183,86 USD bruto / 1 830,74 neto),
  distinguiendo las **tres palancas de reducción** (redirección a S3 55–70 pts, muestreo 8–13 pts,
  metric filters 2–5 pts; total 65,0 %–88,0 %) con supuesto y % direccionable de cada una (Req 11.4).
- ✅ **No eliminables marcados** (Req 11.3): los 3 log groups WAF de **producción** (seguridad/
  compliance, retención obligatoria) → solo redirección + muestreo limitado; los 2 de **dev**,
  flexibles.
- ✅ **Clasificada `Estimado`** con rango Conservador–Agresivo (invariante `0 < Cons ≤ Agr` ✓),
  mensual y anualizado ×12 con advertencia de estacionalidad (Req 3.3, 6.1, 6.3, 6.4).
- ✅ **Documentación Req 4** completa; **owner "pendiente"** (Digital ecommerce + SRE, transversal).
- Trazabilidad: cifra **derivada** de `EV-6.1-vendedlog-2026-05`, recurso **confirmado** por
  `EV-6.2-waf-cloudfront-live-2026-06-23`; anclada a `frozen-2026-05@2026-06-23`.
- Auditorías aguas abajo: rango/clasificación → Tarea 17.3 (Property 4/5/6); anualización/redondeo →
  Tarea 17.5 (Property 8/9); biyección cifra↔evidencia → Tarea 17.2 (Property 2/3).
