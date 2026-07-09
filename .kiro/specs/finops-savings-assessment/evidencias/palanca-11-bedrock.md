# Registro Palanca 11 — Bedrock (IA generativa) — Tarea 13.1

> Artefacto auditable de la **Tarea 13.1**: consulta del CUR de Bedrock por **cuenta + inference
> profile** (`line_item_resource_id LIKE 'arn:aws:bedrock:%'`) **+ usage_type**, considerando los
> **inference profiles cross-region**, sobre las cuentas `iskaypet-data` (200300400500) y `data-dev`
> (100200300400), e **identificación del coste guiado por output tokens** como principal
> direccionador del gasto. Cifras congeladas contra el `Dataset_Congelado` y reproducibles
> re-ejecutando las consultas documentadas.
>
> **Validates: Requirements 16.1, 16.3, 2.2, 2.3**
>
> Este fichero es el artefacto PROPIO de la Tarea 13.1 (no se toca `catalogo-evidencias.md`, el
> catálogo compartido de la Fundación, ni el resto de ficheros de `evidencias/`). **Alcance de
> 13.1:** congelar coste de Bedrock por cuenta/modelo/usage_type desde el CUR e identificar el
> direccionador (output tokens). La **confirmación cuenta/modelo + verificación de solo lectura**
> (`bedrock list-inference-profiles`) se produce en la Tarea **13.2**; la **fórmula de ahorro,
> clasificación Estimado, advertencia de calidad del modelo (producto del squad Data) y campos de
> documentación Req 4** se producen en la Tarea **13.3** — aquí NO se propone optimización ni se
> fija ahorro.

## Parámetros de anclaje (Req 2.1, 2.5)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción del `Dataset_Congelado` | `2026-06-23 07:55 UTC` |
| Fecha de re-ejecución de estas consultas | `2026-06-23T11:34:00Z` (UTC) · `2026-06-23T13:34:00+02:00` (Europe/Madrid, CEST) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |

> El `Dataset_Congelado` está cerrado (completitud 100 %, 31/31 días — ver `catalogo-evidencias.md`
> §1.2). Re-ejecutar estas consultas sobre el mismo Mes_Referencia produce diferencia `0,00 USD`
> (Req 7.3; auditoría en Tarea 17.6).

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

## Evidencia A — Consulta canónica del `design.md` (Bedrock por cuenta × inference profile × usage_type)

**`id_evidencia`:** `EV-13.1-bedrock-por-cuenta-perfil-canonica`
**Clasificación del registro:** detalle por recurso con identificador explícito del inference
profile (ARN completo, Req 2.2) + agregados por cuenta/modelo/dirección de token con su dimensión
(Req 2.3).
**Dimensión de agregación (Req 2.3):** `(line_item_usage_account_id, line_item_resource_id,
line_item_usage_type)`; medidas `SUM(line_item_unblended_cost)` (coste),
`SUM(line_item_usage_amount)` (unidades de recuento de tokens del CUR).

### Consulta CUR exacta (re-ejecutable) — consulta canónica del `design.md`

Se sigue la consulta del `design.md` (sección "Palanca 11 — Bedrock"), ampliando las medidas con
`usage_amount` y `line_items` para soportar el análisis del direccionador (output tokens, Req 16.3):

```sql
SELECT line_item_usage_account_id AS account,
       line_item_resource_id      AS inference_profile,
       line_item_usage_type       AS usage_type,
       SUM(line_item_unblended_cost) AS cost,
       SUM(line_item_usage_amount)   AS usage_amount,
       COUNT(*)                      AS line_items
FROM data
WHERE (line_item_resource_id LIKE 'arn:aws:bedrock:%'
       OR line_item_product_code = '7g37zhparap7eesm9k78jrzqc')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2, 3
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

- `QueryExecutionId`: `08100a2e-24a9-48e9-859a-59b0a59e3538`
- Estado: `SUCCEEDED` · Datos escaneados: `11 393 542` bytes · Tiempo: `1 165` ms · Filas: `22`

### Resultado completo (toda la organización, Req 16.1 — incluye cross-region)

Coste de Bedrock en **todas** las cuentas con consumo en el Mes_Referencia, por cuenta + inference
profile (ARN) + usage_type. Las regiones que aparecen en los ARN (`eu-west-1`, `eu-central-1`,
`eu-north-1`, `eu-west-2`) son las del **inference profile cross-region** (`eu.` enruta la inferencia
entre regiones de la UE); el CUR imputa el coste a la región del ARN del profile (Req 16.1).

| Cuenta (ID · nombre) | Inference profile (modelo) | Región profile | usage_type | Coste (USD) | Unidades token |
|----------------------|-----------------------------|:--------------:|------------|------------:|---------------:|
| `200300400500` · iskaypet-data | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | eu-west-1 | `EU_OutputTokenCount` | 1 151,31 | 209,330 |
| `200300400500` · iskaypet-data | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | eu-west-1 | `EU_InputTokenCount` | 631,49 | 574,079 |
| `100200300400` · data-dev | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | eu-west-1 | `EU_OutputTokenCount` | 251,48 | 45,723 |
| `100200300400` · data-dev | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | eu-west-1 | `EU_InputTokenCount` | 140,72 | 127,931 |
| `444455556666` · eks-tooling | `eu.anthropic.claude-sonnet-4-20250514-v1:0` | eu-west-1 | `EU_InputTokenCount` | 1,91 | 0,637 |
| `444455556666` · eks-tooling | `eu.anthropic.claude-sonnet-4-20250514-v1:0` | eu-west-1 | `EU_OutputTokenCount` | 0,53 | 0,035 |
| `444455556666` · eks-tooling | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | eu-central-1 | `EUC1_OutputTokenCount` | 0,24 | 0,043 |
| `444455556666` · eks-tooling | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | eu-central-1 | `EUC1_InputTokenCount` | 0,16 | 0,145 |
| `800900100200` · sandbox-data | `anthropic.claude-3-sonnet-20240229-v1` (foundation model) | eu-west-2 | `EUW2_OutputTokenCount` | 0,68 | 0,046 |
| `800900100200` · sandbox-data | `anthropic.claude-3-sonnet-20240229-v1` (foundation model) | eu-west-2 | `EUW2_InputTokenCount` | 0,40 | 0,134 |
| `200300400500` · iskaypet-data | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | eu-north-1 | `EUN1_OutputTokenCount` | 0,0002 | 0,00004 |
| `200300400500` · iskaypet-data | `eu.anthropic.claude-haiku-4-5-20251001-v1:0` | eu-north-1 | `EUN1_InputTokenCount` | 0,00001 | 0,000009 |
| `100300500700` · pruebas (Sandbox Infra&SRE) | `eu.amazon.nova-lite-v1:0` | eu-west-1 | `NovaLite-input-tokens` | 0,0096 | 139,609 |
| `100300500700` · pruebas (Sandbox Infra&SRE) | `eu.amazon.nova-lite-v1:0` | eu-west-1 | `NovaLite-output-tokens` | 0,0039 | 14,116 |
| (7 filas con `resource_id` nulo, matcheadas por `product_code`) | — | — | `*TokenCount-Units` | 0,00 | — |

> Las 7 filas finales con `line_item_resource_id` nulo (matcheadas solo por `product_code =
> '7g37zhparap7eesm9k78jrzqc'`) tienen coste `0,00 USD`; son entradas de metadato sin coste, no
> atribuibles a un profile. No alteran ninguna cifra.

### Cifras congeladas — coste total de Bedrock (USD, half-up 2 dec)

| Concepto | Coste (USD) | % |
|----------|------------:|---:|
| **Bedrock total organización (Mes_Referencia)** | **2 178,94** | 100,0 % |
| → `iskaypet-data` (200300400500) | 1 782,80 | 81,8 % |
| → `data-dev` (100200300400) | 392,20 | 18,0 % |
| → `eks-tooling` (444455556666) — Iskay portal (Sonnet 4 + Haiku eu-central-1) | 2,84 | 0,1 % |
| → `sandbox-data` (800900100200) — Claude 3 Sonnet | 1,09 | 0,05 % |
| → `pruebas` (100300500700) — Nova Lite | 0,01 | 0,001 % |

> **Confirmación del ejemplo trabajado del `design.md`:** ~$2.2k Claude Haiku 4.5 en las cuentas
> `iskaypet-data` + `data-dev`, inference profiles cross-region. El total org congelado es
> **2 178,94 USD**; el modelo `eu.anthropic.claude-haiku-4-5-20251001-v1:0` concentra el **99,8 %**
> (2 175,40 USD). El resto (`Sonnet 4`, `Claude 3 Sonnet`, `Nova Lite`) suma **3,94 USD** y procede
> de cuentas fuera del squad Data (portal Iskay en eks-tooling, sandboxes) — fuera del alcance de la
> Palanca 11, que es producto del squad Data.

**Registro de evidencia (esquema del Catálogo_Evidencias):**

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-13.1-bedrock-por-cuenta-perfil-canonica` |
| `cifra_publicada` | Bedrock total org = `2 178,94 USD`; Claude Haiku 4.5 = `2 175,40 USD` (99,8 %); por cuenta: iskaypet-data `1 782,80`, data-dev `392,20`, resto `3,94` |
| `descripcion` | Consulta canónica del `design.md` de Bedrock por cuenta × inference profile (ARN) × usage_type, considerando inference profiles cross-region (Req 16.1) |
| `consulta_cur` | Consulta canónica (arriba) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23 07:55 UTC` (dataset); re-ejecución `2026-06-23T11:34:00Z` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | Inference profiles explícitos (ARN, Req 2.2): `arn:aws:bedrock:eu-west-1:200300400500:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0`, `arn:aws:bedrock:eu-west-1:100200300400:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0`, + perfiles cross-region eu-central-1/eu-north-1/eu-west-2 y Sonnet 4 / Nova Lite (ver tabla) |
| `dimension_agregacion` | `(line_item_usage_account_id, line_item_resource_id, line_item_usage_type)`; medidas `SUM(line_item_unblended_cost)`, `SUM(line_item_usage_amount)` |
| `verificacion_vivo` | `null` (la confirmación cuenta/modelo + `bedrock list-inference-profiles` se ejecuta en la Tarea 13.2) |
| `clasificacion` | base de cifra; la Palanca 11 se clasifica **Estimado** siempre (Req 16.5), fijado en la Tarea 13.3 |

---

## Evidencia B — Alcance canónico Palanca 11 (cuentas Data) + dirección de token (Req 16.3)

**`id_evidencia`:** `EV-13.1-bedrock-data-direccion-token`
**Clasificación del registro:** agregado por cuenta + modelo + **dirección de token**
(input/output), restringido a las dos cuentas del squad Data del alcance (Req 16.1) — con
identificador de modelo explícito (Req 2.2/2.3).
**Dimensión de agregación (Req 2.3):** `(line_item_usage_account_id, modelo, direccion,
product_pricing_unit)`; medidas `SUM(line_item_unblended_cost)`, `SUM(line_item_usage_amount)`.

### Consulta CUR exacta (re-ejecutable)

```sql
SELECT line_item_usage_account_id AS account,
       regexp_extract(line_item_resource_id, 'inference-profile/(.*)$', 1) AS model,
       CASE WHEN line_item_usage_type LIKE '%Output%' THEN 'output'
            WHEN line_item_usage_type LIKE '%Input%'  THEN 'input'
            ELSE 'other' END AS direction,
       product_pricing_unit AS pricing_unit,
       SUM(line_item_unblended_cost) AS cost,
       SUM(line_item_usage_amount)   AS usage_amount
FROM data
WHERE line_item_resource_id LIKE 'arn:aws:bedrock:%'
  AND line_item_usage_account_id IN ('200300400500','100200300400')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2, 3, 4
ORDER BY cost DESC;
```

- `QueryExecutionId`: `f7d5e819-5ec4-49f3-843c-1341a66185a4`
- Estado: `SUCCEEDED` · Datos escaneados: `11 276 874` bytes · Tiempo: `1 154` ms · Filas: `4`

### Resultado (USD, half-up 2 dec)

| Cuenta (ID · nombre) | Modelo | Dirección | Coste (USD) | Unidades token |
|----------------------|--------|:---------:|------------:|---------------:|
| `200300400500` · iskaypet-data | claude-haiku-4-5 | **output** | 1 151,32 | 209,330 |
| `200300400500` · iskaypet-data | claude-haiku-4-5 | input | 631,49 | 574,079 |
| `100200300400` · data-dev | claude-haiku-4-5 | **output** | 251,48 | 45,723 |
| `100200300400` · data-dev | claude-haiku-4-5 | input | 140,72 | 127,931 |

> `product_pricing_unit` viene **vacío** en el CUR 2.0 para estas líneas; la unidad facturable es la
> del `usage_type` (`EU_OutputTokenCount` / `EU_InputTokenCount`). El `usage_amount` está expresado
> en unidades de recuento de tokens del CUR (la relación coste/unidad ≈ **5,50 USD/unidad output** y
> **≈ 1,10 USD/unidad input** es coherente con que cada unidad sea **un millón de tokens** a la
> tarifa pública EU cross-region de Claude Haiku 4.5).

### Direccionador del gasto — output tokens (Req 16.3)

Alcance canónico Palanca 11 = `iskaypet-data` + `data-dev` = **2 175,00 USD**:

| Dirección | Coste (USD) | % del alcance Data | Unidades token |
|-----------|------------:|-------------------:|---------------:|
| **Output tokens** | **1 402,79** | **64,5 %** | 255,053 |
| Input tokens | 772,21 | 35,5 % | 702,010 |
| **Total Data (Palanca 11)** | **2 175,00** | 100,0 % | 957,063 |

> **Hallazgo (Req 16.3): el coste está guiado por los OUTPUT tokens.** Aunque el volumen de
> **input** es ~2,75× el de output en unidades de token (702,01 vs 255,05), el coste de output
> (1 402,79 USD, **64,5 %**) supera ampliamente al de input (772,21 USD, 35,5 %), porque el precio
> por token de salida de Claude Haiku 4.5 es ~5× el de entrada. El **principal direccionador
> direccionable** del gasto de Bedrock es por tanto la **generación de output tokens** — lo que
> orienta la palanca de optimización (Tarea 13.3) hacia reducir/acotar la longitud de salida,
> prompt caching de la entrada y/o cambio de modelo, declarando que es **producto del squad Data** y
> que optimizar puede afectar la calidad del modelo (Req 16.2, advertencia que se registra en 13.3).

**Registro de evidencia (esquema del Catálogo_Evidencias):**

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-13.1-bedrock-data-direccion-token` |
| `cifra_publicada` | Alcance Data = `2 175,00 USD`; output `1 402,79` (64,5 %) vs input `772,21` (35,5 %); iskaypet-data `1 782,80`, data-dev `392,20` |
| `descripcion` | Coste Bedrock de las cuentas del squad Data por modelo y dirección de token; identifica los output tokens como principal direccionador (Req 16.3) |
| `consulta_cur` | Consulta de la Evidencia B (arriba) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23 07:55 UTC` (dataset); re-ejecución `2026-06-23T11:34:00Z` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `arn:aws:bedrock:eu-west-1:200300400500:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0`, `arn:aws:bedrock:eu-west-1:100200300400:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0` (Req 2.2) |
| `dimension_agregacion` | `(line_item_usage_account_id, modelo, direccion, product_pricing_unit)`; medidas `SUM(line_item_unblended_cost)`, `SUM(line_item_usage_amount)` |
| `verificacion_vivo` | `null` (Tarea 13.2) |
| `clasificacion` | base de cifra; **Estimado** siempre (Req 16.5), fijado en la Tarea 13.3 |

---

## Síntesis de la Tarea 13.1 (cifras congeladas)

| Concepto | Valor | Notas |
|----------|------:|-------|
| Bedrock total organización (Mes_Referencia) | 2 178,94 USD | todas las cuentas con consumo |
| **Alcance canónico Palanca 11 (cuentas Data)** | **2 175,00 USD** | iskaypet-data + data-dev |
| → iskaypet-data (200300400500) | 1 782,80 USD | 81,8 % del total org |
| → data-dev (100200300400) | 392,20 USD | 18,0 % del total org |
| Modelo dominante | claude-haiku-4-5 (99,8 %) | confirma el `design.md` |
| Output tokens (direccionador, Req 16.3) | 1 402,79 USD (64,5 %) | principal direccionador del gasto |
| Input tokens | 772,21 USD (35,5 %) | ~2,75× volumen pero menor coste/token |
| Fuera de alcance Palanca 11 (otras cuentas) | 3,94 USD | portal Iskay (Sonnet 4), sandboxes |
| Inference profiles cross-region (Req 16.1) | eu-west-1, eu-central-1, eu-north-1, eu-west-2 | el `eu.` enruta inferencia entre regiones UE |

**Pendiente (siguientes sub-tareas, NO parte de 13.1):**
- **Tarea 13.2** — confirmar cuenta/modelo desde el `resource_id` del CUR y, si procede,
  `bedrock list-inference-profiles` (solo lectura); registrar estado/región del profile/fecha-hora
  UTC (Req 5.1, 16.1).
- **Tarea 13.3** — declarar supuesto de optimización (prompt caching / cambio de modelo) y %
  direccionable (Req 16.4); señalar que, al ser producto del squad Data, optimizar puede afectar la
  calidad del modelo (advertencia, Req 16.2); clasificar **Estimado** siempre (rango, Req 16.5);
  documentar campos Req 4; owner Data ("pendiente" de correo).

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23`; consultas re-ejecutadas
  el `2026-06-23T11:34:00Z`.
- `QueryExecutionId` retenidos: `08100a2e-24a9-48e9-859a-59b0a59e3538` (canónica `design.md`,
  cuenta × profile × usage_type) y `f7d5e819-5ec4-49f3-843c-1341a66185a4` (alcance Data, dirección
  de token).
- Cifras congeladas y reproducibles: re-ejecutar las consultas documentadas sobre el mismo
  Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría en
  Tarea 17.6).
- El total congelado (2 178,94 USD org / 2 175,00 USD alcance Data) confirma el ejemplo trabajado
  del `design.md` (~$2.2k Claude Haiku 4.5 en iskaypet-data + data-dev). El **output token** es el
  principal direccionador del gasto (64,5 % del coste del alcance Data, Req 16.3).

---

# Registro Palanca 11 — Bedrock — Tarea 13.2 (Confirmación cuenta/modelo + Verificacion_Recurso_Vivo)

> Artefacto auditable de la **Tarea 13.2**: confirmación de **cuenta + modelo** desde el
> `line_item_resource_id` del CUR (extraídos en 13.1) y **Verificacion_Recurso_Vivo de solo
> lectura** (`aws bedrock list-inference-profiles`) en las cuentas/regiones de los inference
> profiles. Solo operaciones `describe/list/get` — **ninguna operación mutante**
> (create/update/delete/modify), conforme al principio "Lectura no mutante, siempre" del
> `design.md` (Req 5.1).
>
> **Validates: Requirements 5.1, 16.1**
>
> Esta tarea **no** fija ahorro ni clasificación (eso es la Tarea 13.3). Aquí solo se confirma que
> los recursos de coste del CUR (los inference profiles de Claude Haiku 4.5) **existen y están
> activos** en las cuentas del alcance, y se anota el estado/región/fecha-hora UTC.

## Confirmación cuenta/modelo desde el `resource_id` del CUR (Req 16.1)

Los `line_item_resource_id` congelados en la Tarea 13.1 (Evidencia A/B) que concentran el **99,8 %**
del gasto de Bedrock se confirman uno a uno contra el inference profile vivo:

| `line_item_resource_id` del CUR (13.1) | Cuenta (ID · nombre) | Modelo confirmado | Profile vivo |
|----------------------------------------|----------------------|-------------------|:------------:|
| `arn:aws:bedrock:eu-west-1:200300400500:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0` | `200300400500` · iskaypet-data | Claude Haiku 4.5 (`eu.anthropic.claude-haiku-4-5-20251001-v1:0`) | **ACTIVE** |
| `arn:aws:bedrock:eu-west-1:100200300400:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0` | `100200300400` · data-dev | Claude Haiku 4.5 (`eu.anthropic.claude-haiku-4-5-20251001-v1:0`) | **ACTIVE** |

El ARN del CUR coincide **exactamente** con el `inferenceProfileArn` devuelto por la API en cada
cuenta (mismo `account-id` embebido en el ARN), confirmando la atribución cuenta↔modelo de 13.1.

### Inference profiles cross-region (Req 16.1) — confirmación del enrutado

El profile `eu.anthropic.claude-haiku-4-5-20251001-v1:0` es `type: SYSTEM_DEFINED` y enruta la
inferencia a las **foundation-model** de 6 regiones miembro de la UE (idéntico en ambas cuentas):

```
eu-north-1, eu-west-3, eu-south-1, eu-south-2, eu-west-1, eu-central-1
```

Esto **explica y confirma** el hallazgo de 13.1 de que el CUR imputó coste de este profile en
varias regiones (`eu-west-1`, `eu-central-1` con `EUC1_*TokenCount`, `eu-north-1` con
`EUN1_*TokenCount`): son regiones miembro del profile cross-region `eu.`, no profiles distintos. El
coste se imputa a la región donde se sirvió cada inferencia dentro del conjunto cross-region.

## Acceso y credenciales (reproducibilidad — Req 7.5, sin incrustar credenciales)

| Parámetro | Valor |
|-----------|-------|
| Mecanismo de credenciales | AWS SSO (IAM Identity Center), `sso_role_name = SRE` |
| Perfiles AWS CLI | `iskaypet-data` (200300400500), `data-dev` (100200300400) |
| Identidad efectiva | `assumed-role/AWSReservedSSO_SRE_*/ruben.landin@emefinpetcare.com` (confirmado vía `sts get-caller-identity`, solo lectura) |
| AWS CLI | `aws-cli/2.35.7` |
| Operación usada | `bedrock:ListInferenceProfiles` (solo lectura) |
| Región consultada | `eu-west-1` (región propietaria del ARN del profile; los miembros cross-region son metadato del propio profile, no requieren consulta por región) |

> Las credenciales se referencian **por nombre de perfil/rol** (`--profile iskaypet-data` /
> `--profile data-dev`, rol SSO `SRE`); no se incrusta ningún token ni clave en este registro
> (Req 7.5).

## Comandos re-ejecutables (solo lectura)

```bash
# Confirmación de identidad/rol (solo lectura)
aws sts get-caller-identity --profile iskaypet-data --region eu-west-1
aws sts get-caller-identity --profile data-dev      --region eu-west-1

# Verificacion_Recurso_Vivo del profile Claude Haiku 4.5 (solo lectura) — iskaypet-data
aws bedrock list-inference-profiles --profile iskaypet-data --region eu-west-1 \
  --query "inferenceProfileSummaries[?inferenceProfileId=='eu.anthropic.claude-haiku-4-5-20251001-v1:0'].{id:inferenceProfileId,arn:inferenceProfileArn,status:status,type:type,models:models[].modelArn}" \
  --output json

# Verificacion_Recurso_Vivo del profile Claude Haiku 4.5 (solo lectura) — data-dev
aws bedrock list-inference-profiles --profile data-dev --region eu-west-1 \
  --query "inferenceProfileSummaries[?inferenceProfileId=='eu.anthropic.claude-haiku-4-5-20251001-v1:0'].{id:inferenceProfileId,arn:inferenceProfileArn,status:status,type:type,models:models[].modelArn}" \
  --output json
```

## Sub-registro de Verificacion_Recurso_Vivo (esquema `design.md`, Req 5.5)

### Verificación 1 — iskaypet-data

| Campo | Valor |
|-------|-------|
| `comando` | `aws bedrock list-inference-profiles --profile iskaypet-data --region eu-west-1 --query "inferenceProfileSummaries[?inferenceProfileId=='eu.anthropic.claude-haiku-4-5-20251001-v1:0']..."` |
| `cuenta` | `200300400500` · iskaypet-data |
| `region` | `eu-west-1` (profile cross-region `eu.` con miembros eu-north-1/eu-west-3/eu-south-1/eu-south-2/eu-west-1/eu-central-1) |
| `fecha_hora_utc` | `2026-06-23T10:26:34Z` |
| `recurso_id` | `arn:aws:bedrock:eu-west-1:200300400500:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `estado_profile` | `ACTIVE` · `type: SYSTEM_DEFINED` |
| `estado` | **confirmado** |
| `motivo` | — (existencia y modelo asumidos confirmados; ARN del CUR == `inferenceProfileArn` vivo) |

### Verificación 2 — data-dev

| Campo | Valor |
|-------|-------|
| `comando` | `aws bedrock list-inference-profiles --profile data-dev --region eu-west-1 --query "inferenceProfileSummaries[?inferenceProfileId=='eu.anthropic.claude-haiku-4-5-20251001-v1:0']..."` |
| `cuenta` | `100200300400` · data-dev |
| `region` | `eu-west-1` (profile cross-region `eu.` con miembros eu-north-1/eu-west-3/eu-south-1/eu-south-2/eu-west-1/eu-central-1) |
| `fecha_hora_utc` | `2026-06-23T10:27:20Z` |
| `recurso_id` | `arn:aws:bedrock:eu-west-1:100200300400:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0` |
| `estado_profile` | `ACTIVE` · `type: SYSTEM_DEFINED` |
| `estado` | **confirmado** |
| `motivo` | — (existencia y modelo asumidos confirmados; ARN del CUR == `inferenceProfileArn` vivo) |

> **Nota de naturaleza del recurso (design.md, Palanca 11).** Bedrock **no tiene recurso físico
> aprovisionado** (el inference profile es un enrutador gestionado por AWS, no una instancia que se
> pueda apagar). La Verificacion_Recurso_Vivo aquí confirma que **el modelo/profile que generó el
> coste del CUR existe y está activo en la cuenta atribuida**, no una característica dimensionable
> de capacidad. Por eso la Palanca 11 se clasifica **Estimado** siempre (Req 16.5, se fija en 13.3)
> y nunca Garantizado: no hay desperdicio puro verificable, solo coste de uso optimizable con
> supuestos.

## Estado de ejecución (Tarea 13.2)

- ✅ **Confirmado cuenta/modelo** desde el `resource_id` del CUR (13.1): ambos ARN del CUR coinciden
  con el `inferenceProfileArn` vivo en su cuenta respectiva (iskaypet-data 200300400500 y data-dev
  100200300400).
- ✅ **Verificacion_Recurso_Vivo (solo lectura) ejecutada**: `bedrock list-inference-profiles` en
  `eu-west-1` para ambas cuentas → profile `eu.anthropic.claude-haiku-4-5-20251001-v1:0`
  **ACTIVE** en las dos. **Estado: confirmado** en ambas.
- ✅ **Cross-region confirmado** (Req 16.1): el profile `eu.` enruta a 6 regiones UE
  (eu-north-1/eu-west-3/eu-south-1/eu-south-2/eu-west-1/eu-central-1), lo que explica la imputación
  multi-región del coste en el CUR de 13.1.
- ✅ **Solo lectura, sin operaciones mutantes** (Req 5.1): únicamente `sts:GetCallerIdentity` y
  `bedrock:ListInferenceProfiles`.
- Marca temporal de ejecución de la verificación: iskaypet-data `2026-06-23T10:26:34Z`, data-dev
  `2026-06-23T10:27:20Z` (UTC) · referencia local `2026-06-23T12:27:36+02:00` (Europe/Madrid, CEST).
- **Pendiente (Tarea 13.3):** fórmula de ahorro + supuesto (prompt caching / cambio de modelo) y %
  direccionable (Req 16.4); advertencia de impacto en calidad por ser producto del squad Data
  (Req 16.2); clasificación **Estimado** con rango (Req 16.5); campos Req 4; owner Data.

---

# Fórmula, clasificación y documentación de la Palanca 11 (Tarea 13.3)

> Artefacto auditable de la **Tarea 13.3**: a partir de la cifra base congelada en la Tarea 13.1
> (coste de Bedrock del alcance Data = **2 175,00 USD/mes**, modelo Claude Haiku 4.5 al 99,8 %,
> **output tokens** como principal direccionador = 1 402,79 USD / 64,5 %) y de la
> `Verificacion_Recurso_Vivo` **confirmado** de la Tarea 13.2 (profiles `eu.anthropic.claude-haiku-4-5`
> **ACTIVE** en iskaypet-data y data-dev, `SYSTEM_DEFINED` cross-region), se **declara el supuesto de
> optimización** (prompt caching / reducción de output / cambio de modelo) con su **% direccionable**
> (Req 16.4), se **registra la advertencia de impacto en la calidad del modelo** por ser producto
> propiedad del squad Data (Req 16.2), se clasifica la Palanca como **Estimado** (rango
> Conservador–Agresivo, invariante `0 < Cons ≤ Agr`) y se documentan los campos del **Requisito 4**.
>
> **Validates: Requirements 16.2, 16.4, 16.5, 3.3, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1**
>
> No se introduce ninguna consulta CUR nueva: la cifra base es **derivada** de las cifras congeladas
> de la Tarea 13.1 (Evidencias A/B, ancladas a `frozen-2026-05@2026-06-23`); las transformaciones son
> supuestos de optimización con su origen y fecha. La existencia/actividad del recurso (inference
> profile) está **confirmada** en vivo en la Tarea 13.2 (solo lectura, `eu-west-1`).

## Coste base mensual afectado (Req 4.2) y % direccionable

La Palanca 11 actúa sobre el consumo de **Bedrock del squad Data** (cuentas `iskaypet-data`
200300400500 + `data-dev` 100200300400), que es donde se concentra el gasto. El coste base congelado
del alcance Data en el Mes_Referencia es **2 175,00 USD/mes**, con el direccionador del gasto en los
**output tokens** (Tarea 13.1, Evidencia B):

| Componente de la base (alcance Data) | Coste (USD/mes) | % del alcance | Tratamiento en la Palanca |
|---------------------------------------|----------------:|--------------:|---------------------------|
| **Output tokens** (`EU_OutputTokenCount`) — principal direccionador | **1 402,79** | **64,5 %** | Reducción de salida (max_tokens / salida concisa / structured output) + cambio de modelo |
| Input tokens (`EU_InputTokenCount`) | 772,21 | 35,5 % | Prompt caching (contexto/sistema reutilizado) |
| **Coste base afectado por la Palanca (alcance Data)** | **2 175,00** | 100,0 % | Base de la fórmula |
| Fuera de alcance (Sonnet 4 portal Iskay, sandboxes Claude 3 / Nova Lite) | 3,94 | — | Otras cuentas, no producto del squad Data — excluido |
| **Total Bedrock organización** | **2 178,94** | — | Denominador del % direccionable |

- **% direccionable de la Palanca (Req 4.2):** `2 175,00 / 2 178,94 = ` **99,8 %** del coste de
  Bedrock de la organización (las dos cuentas del squad Data). El resto (3,94 USD, 0,2 %) procede de
  cuentas fuera del producto Data (portal Iskay en eks-tooling, sandboxes) y queda **fuera de alcance**.
- **Coste base mensual afectado (Req 4.2):** **2 175,00 USD/mes** (iskaypet-data 1 782,80 + data-dev
  392,20).
- Dentro de esa base, el **supuesto de reducción** alcanzable por optimización es **22,5 %
  (Conservador) – 46,7 % (Agresivo)** (ver descomposición por mecanismo más abajo).

## Los tres mecanismos de optimización (Req 16.4) — supuesto y % direccionable de cada uno

El Req 16.4 exige declarar el **supuesto de optimización** (p. ej. prompt caching o cambio de modelo)
y el % direccionable. Se modelan **tres mecanismos**, cada uno actuando sobre la porción de la base
que le corresponde, y se atribuye a cada uno una **porción disjunta** del ahorro total (en puntos
porcentuales de la base afectada), de modo que **suman exactamente el total sin solapes** (sin doble
conteo, en el espíritu de la Property 7). Los puntos por mecanismo son su contribución marginal, no
sumables más allá del total.

### (a) Prompt caching — sobre los input tokens (772,21 USD, 35,5 % de la base)

- **Supuesto (Req 4.1):** activar **prompt caching de Bedrock** para el **contexto reutilizado** entre
  invocaciones (prompt de sistema, few-shot, instrucciones y datos de referencia estables). En el
  pricing de Anthropic Claude sobre Bedrock, la **lectura de caché** cuesta ≈ **0,1×** el precio de un
  input token base (escritura de caché ≈ 1,25×), es decir ~**90 % más barato** sobre la fracción de
  input que es cacheable y se reaprovecha.
- **% direccionable:** la fracción de input **cacheable** (contexto estable reutilizado) se estima en
  **40 % (Conservador) – 70 % (Agresivo)** del coste de input, con ~90 % de reducción sobre esa
  porción. Reducción del coste de input = `0,40 × 0,90 = 36 %` (Cons) / `0,70 × 0,90 = 63 %` (Agr).
- **Ahorro:** `772,21 × 0,36 = 278,00` (Cons) / `772,21 × 0,63 = 486,49` (Agr) USD/mes.
- **Atribución al ahorro total:** **12,8 puntos** (Cons) / **22,4 puntos** (Agr) de la base afectada.

### (b) Reducción de output — sobre los output tokens (1 402,79 USD, 64,5 % de la base)

- **Supuesto (Req 4.1):** acotar la **longitud de salida** (límite `max_tokens` ajustado al caso de
  uso, generación concisa, **salida estructurada** que evita texto redundante) sobre el **principal
  direccionador** del gasto (output tokens, Req 16.3). El precio por token de **salida** de Claude
  Haiku 4.5 es ~5× el de entrada, por lo que recortar volumen de output es la palanca de mayor
  impacto unitario.
- **% direccionable:** reducción de volumen de output del **15 % (Conservador) – 30 % (Agresivo)** sin
  pérdida funcional del producto Data (recorte de relleno/verbosidad, no de contenido sustantivo).
- **Ahorro:** `1 402,79 × 0,15 = 210,42` (Cons) / `1 402,79 × 0,30 = 420,84` (Agr) USD/mes.
- **Riesgo asociado:** acotar la salida puede recortar contenido útil del producto → se mantiene
  moderado y sujeto a validación de calidad (ver advertencia Req 16.2).
- **Atribución al ahorro total:** **9,7 puntos** (Cons) / **19,3 puntos** (Agr).

### (c) Cambio de modelo — sobre el total de la base (mayor riesgo de calidad)

- **Supuesto (Req 4.1):** enrutar la fracción de menor exigencia del workload a un **modelo más
  barato** (p. ej. un Haiku/Nova de gama inferior) reservando Claude Haiku 4.5 para lo que requiere su
  calidad. Es el mecanismo con **mayor riesgo de degradación** de calidad (Req 16.2), por lo que se
  **excluye del escenario Conservador** (0 puntos) y solo se considera, parcial, en el Agresivo.
- **% direccionable:** **0 % (Conservador)** / **5 % (Agresivo)** del coste base, condicionado a que
  una evaluación de calidad (evals) demuestre paridad aceptable en la fracción reenrutada.
- **Ahorro:** `0,00` (Cons) / `2 175,00 × 0,05 = 108,75` (Agr) USD/mes.
- **Atribución al ahorro total:** **0,0 puntos** (Cons) / **5,0 puntos** (Agr).

### Composición del supuesto de reducción total (Req 4.1)

| Mecanismo | Conservador (pts de base) | Agresivo (pts de base) |
|-----------|--------------------------:|-----------------------:|
| (a) Prompt caching (input) | 12,8 | 22,4 |
| (b) Reducción de output | 9,7 | 19,3 |
| (c) Cambio de modelo | 0,0 | 5,0 |
| **Reducción total de la base afectada** | **22,5 %** | **46,7 %** |

> Los tres mecanismos se aplican sobre porciones disjuntas del coste (input → caching; output →
> reducción; fracción del total → cambio de modelo), garantizando que cada punto porcentual se asigna
> a un único mecanismo (sin doble conteo). El supuesto de reducción total es **22,5 %** (Conservador)
> – **46,7 %** (Agresivo) **del coste base afectado**, ambos ∈ [0, 100] con 1 decimal (Req 4.1).

## Advertencia de impacto en la calidad del modelo (Req 16.2) — producto del squad Data

> **ADVERTENCIA (Req 16.2).** El consumo de Bedrock del alcance de esta Palanca corresponde a un
> **producto propiedad del squad Data** (inference profiles Claude Haiku 4.5 en `iskaypet-data` y
> `data-dev`, confirmados ACTIVE en la Tarea 13.2). **Optimizar el coste puede afectar la calidad del
> modelo / de las respuestas del producto**, y el impacto es distinto por mecanismo:
>
> - **Cambio de modelo** — riesgo **alto**: un modelo más barato puede degradar exactitud, formato o
>   capacidad de razonamiento del producto Data. Por eso se excluye del escenario Conservador (0 pts).
> - **Reducción de output** — riesgo **medio**: acotar `max_tokens` o forzar salida concisa puede
>   truncar contenido útil si no se ajusta por caso de uso.
> - **Prompt caching** — riesgo **bajo**: no altera el modelo ni la salida (solo abarata el input
>   reutilizado); es el mecanismo más seguro y la base del escenario Conservador.
>
> **Ninguna de estas optimizaciones debe desplegarse sin validación de calidad previa (evals /
> revisión del squad Data)**. La decisión y la ejecución corresponden al squad Data como dueño del
> producto; SRE/FinOps solo cuantifica la oportunidad. Esta advertencia se registra como parte de la
> evidencia de la Palanca (Req 16.2).

## Fórmula de ahorro y clasificación — **Estimado** siempre (Req 16.5, 3.3, 6.1)

Ahorro mensual = `base afectada × supuesto de reducción total`, sobre la base del alcance Data
**2 175,00 USD/mes**. Importes half-up a 2 decimales; los totales se suman **antes** de redondear
(Req 6.7).

### Ahorro mensual por mecanismo

| Mecanismo | Conservador (USD/mes) | Agresivo (USD/mes) |
|-----------|----------------------:|-------------------:|
| (a) Prompt caching (input) | 278,00 | 486,49 |
| (b) Reducción de output | 210,42 | 420,84 |
| (c) Cambio de modelo | 0,00 | 108,75 |
| **Total mensual** | **488,41** | **1 016,08** |

### Rango del Ahorro_Estimado (Req 3.3, 6.1, 16.5) — mensual y anualizado

| Base | Rango_Conservador | Rango_Agresivo | Invariante |
|------|------------------:|---------------:|:----------:|
| **Mensual** | **488,41 USD** | **1 016,08 USD** | `0 < 488,41 ≤ 1 016,08` ✓ |
| **Anualizado ×12** | **5 860,97 USD** | **12 192,95 USD** | ✓ |

> **Advertencia de anualización (Req 6.3, 6.4):** las cifras anuales son el **mensual del
> Mes_Referencia (mayo 2026) × 12**; **asumen que el Mes_Referencia es representativo y NO capturan
> estacionalidad**. El consumo de Bedrock del producto Data es **especialmente variable** (depende de
> la carga de trabajo del squad: jobs batch, picos puntuales — p. ej. el estado del portal documenta
> un job EMR que gastó ~700 € de Bedrock en un solo día). Reevaluar con varios meses antes de
> comprometer la cifra anual.

**Clasificación: `Ahorro_Estimado`** (rango, **no** cifra única) — **Estimado siempre** (Req 16.5).
El ahorro depende de supuestos (fracción cacheable, recorte de output defendible, paridad de calidad
de un modelo alternativo, % direccionable) y **no** de desperdicio puro verificable. Como ya señaló la
Tarea 13.2, Bedrock **no tiene recurso físico aprovisionado** que apagar (el inference profile es un
enrutador gestionado por AWS), por lo que **nunca** es `Ahorro_Garantizado`: no hay desperdicio puro,
solo coste de uso optimizable con supuestos. La existencia y actividad del recurso (profile **ACTIVE**)
están **confirmadas** en vivo (Tarea 13.2), pero eso confirma la *base*, no el *% de reducción*.

**Barrido_Utilizacion:** **no requerido**. A diferencia de las palancas de compromiso (1, 2) o de
utilización (5, 9, 10), el rango de la Palanca 11 no depende de un perfil de uso 24/7 ni de p95 de
CPU/RAM, sino de decisiones de arquitectura del producto (caching, longitud de salida, elección de
modelo) y de precio público; por eso la Tarea 13.3 **no** la marca como `requiere Barrido_Utilizacion`
(Req 18.1 no aplica aquí). La condición de gating real es la **validación de calidad** del squad Data
antes de desplegar cualquier optimización (advertencia Req 16.2), no un Barrido_Utilizacion.

## Documentación por Palanca (Req 4.1–4.7)

| Campo (Req 4) | Valor |
|---------------|-------|
| **Supuesto de optimización** (4.1, % 0–100, 1 decimal) | **Total 22,5 % (Conservador) – 46,7 % (Agresivo)** de la base afectada. Desglose por mecanismo (pts de base): prompt caching 12,8 / 22,4; reducción de output 9,7 / 19,3; cambio de modelo 0,0 / 5,0 |
| **% direccionable + coste base afectado** (4.2) | **99,8 %** del Bedrock de la organización (cuentas del squad Data); **coste base afectado = 2 175,00 USD/mes** (iskaypet-data 1 782,80 + data-dev 392,20) sobre un total Bedrock org de 2 178,94 |
| **Origen del supuesto + fecha** (4.3) | **Precio público AWS / Anthropic en Bedrock** (prompt caching: lectura de caché ≈ 0,1× input, escritura ≈ 1,25×; tarifa EU cross-region de Claude Haiku 4.5 con output ~5× el precio de input), fecha del dato **2026-06-23**. Los % de reducción son estimaciones de ingeniería ancladas al pricing público; re-confirmar contra la calculadora vigente y contra evals de calidad del squad Data |
| **Riesgo** (4.4) | **Alto** — producto propiedad del squad Data; optimizar puede degradar la calidad del modelo/respuestas (Req 16.2). El **cambio de modelo** es el de mayor riesgo (excluido del Conservador); la **reducción de output** es de riesgo medio; el **prompt caching** es de riesgo bajo. Ninguna optimización debe desplegarse sin validación de calidad previa |
| **Esfuerzo** (4.5) | **Medio** — requiere cambios en el código del producto Data (configurar prompt caching de Bedrock, ajustar `max_tokens`/prompts/salida estructurada y, en su caso, integrar un modelo alternativo) más una **evaluación de calidad (evals)** antes de desplegar |
| **Owner / equipos** (4.6) | **Pendiente** (correo por confirmar). Palanca del **squad Data** (dueño del producto Bedrock en `iskaypet-data` + `data-dev`); **SRE/FinOps** acompaña en la cuantificación y el seguimiento |
| **Campos "pendiente"** (4.7) | `owner` (correo corporativo) = **"pendiente"** (a confirmar por correo con el squad Data); equipo responsable identificado = **squad Data** (+ SRE/FinOps), por lo que se enumera en lugar de marcar el campo completo como pendiente |

## Registro de evidencia (esquema completo del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-13.3-bedrock-estimado-2026-05` |
| `cifra_publicada` | Ahorro_Estimado Palanca 11 (Bedrock, alcance Data): **mensual 488,41 – 1 016,08 USD**; **anualizado ×12 5 860,97 – 12 192,95 USD** |
| `descripcion` | Optimización del coste de Bedrock del squad Data (Claude Haiku 4.5) por prompt caching (input) + reducción de output + cambio de modelo (parcial); rango Conservador–Agresivo. Producto del squad Data: optimizar puede afectar la calidad del modelo (advertencia Req 16.2) |
| `consulta_cur` | **No aplica** (cifra **derivada**): base = cifras congeladas de la Tarea 13.1 `EV-13.1-bedrock-data-direccion-token` (alcance Data 2 175,00; output 1 402,79 / input 772,21) y `EV-13.1-bedrock-por-cuenta-perfil-canonica`; transformación = supuestos de optimización (precio público AWS/Anthropic) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23 07:55 UTC` (heredada del `Dataset_Congelado` de la base, Tarea 13.1) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["arn:aws:bedrock:eu-west-1:200300400500:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0", "arn:aws:bedrock:eu-west-1:100200300400:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0"]` (Req 2.2) |
| `dimension_agregacion` | Base afectada = coste Bedrock de `line_item_usage_account_id IN ('200300400500','100200300400')` con `line_item_resource_id LIKE 'arn:aws:bedrock:%'`, separado por dirección de token (output/input); medida `SUM(line_item_unblended_cost)` |
| `verificacion_vivo` | Sub-registros de la Tarea 13.2 (estado **confirmado**, `bedrock list-inference-profiles`, `eu-west-1`, solo lectura): profile `eu.anthropic.claude-haiku-4-5-20251001-v1:0` **ACTIVE** en iskaypet-data (`2026-06-23T10:26:34Z`) y data-dev (`2026-06-23T10:27:20Z`) |
| `clasificacion` | **`estimado`** (rango; `0 < Conservador ≤ Agresivo`). **Estimado siempre** (Req 16.5): Bedrock no tiene recurso físico aprovisionado, no hay desperdicio puro; el % de reducción es el componente estimado. No requiere Barrido_Utilizacion (gating real = validación de calidad del squad Data, Req 16.2) |
| `advertencia_calidad` | **Sí (Req 16.2)** — producto del squad Data; optimizar puede afectar la calidad del modelo. No desplegar sin validación de calidad previa (evals). Cambio de modelo = riesgo alto (excluido del Conservador); reducción de output = medio; prompt caching = bajo |

## Estado de ejecución (Tarea 13.3)

- ✅ **Completada.** Supuesto de optimización aplicado sobre la base congelada del alcance Data
  (2 175,00 USD/mes), declarando **tres mecanismos** con su supuesto y % direccionable (Req 16.4):
  prompt caching 12,8/22,4 pts (input), reducción de output 9,7/19,3 pts (output, el direccionador
  Req 16.3) y cambio de modelo 0,0/5,0 pts (parcial, agresivo); total **22,5 %–46,7 %** de reducción.
- ✅ **Advertencia de calidad registrada** (Req 16.2): producto propiedad del squad Data → optimizar
  puede afectar la calidad del modelo; riesgo por mecanismo (cambio de modelo alto, output medio,
  caching bajo); no desplegar sin validación de calidad previa.
- ✅ **Clasificada `Estimado` siempre** (Req 16.5) con rango Conservador–Agresivo (invariante
  `0 < 488,41 ≤ 1 016,08` ✓), mensual y anualizado ×12 con advertencia de variabilidad/estacionalidad
  del consumo de Bedrock (Req 3.3, 6.1, 6.3, 6.4).
- ✅ **Documentación Req 4** completa; **owner "pendiente"** (squad Data, a confirmar por correo;
  SRE/FinOps acompaña). **No requiere Barrido_Utilizacion**.
- Trazabilidad: cifra **derivada** de `EV-13.1-bedrock-data-direccion-token`, recurso **confirmado**
  por la `Verificacion_Recurso_Vivo` de la Tarea 13.2; anclada a `frozen-2026-05@2026-06-23`.
- Auditorías aguas abajo: rango/clasificación → Tarea 17.3 (Property 4/5/6); anualización/redondeo →
  Tarea 17.5 (Property 8/9); biyección cifra↔evidencia → Tarea 17.2 (Property 2/3).
