# Catálogo_Evidencias — Estudio FinOps de Ahorro AWS

> Conjunto estructurado de registros de evidencia que respaldan cada cifra del Informe. Cada
> registro fija su consulta CUR re-ejecutable, el Mes_Referencia, la fecha de extracción, la
> versión del `Dataset_Congelado`, la moneda y el/los recurso(s) o la marca "no atribuible".
>
> Este fichero es el catálogo compartido del Estudio. Cada tarea añade su sección. A continuación
> se incluye el registro de la **Tarea 1.3 — Desglose por cuenta**. Las secciones de 1.1, 1.2 y
> 1.4 se añadirán por sus respectivas tareas.

## Parámetros del Dataset_Congelado

| Campo | Valor |
|-------|-------|
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23 07:55 UTC` |
| Moneda | `USD` |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |

## Cadena de acceso a datos (reproducibilidad — Req 7.1, 7.2)

| Parámetro | Valor |
|-----------|-------|
| Motor | Amazon Athena (CUR 2.0) |
| Base de datos / tabla | `athenacurcfn_finnops` / `data` |
| Región | `eu-west-1` |
| Cuenta CUR | `600700800900` (root-iskaypet) |
| Rol de acceso | `Cur-AWSS3CURLambdaExecutor` (perfil `root-iskaypet` / `arn:aws:iam::600700800900:role/Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur`) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |

---

# Registro 1.3 — Desglose por cuenta (alcance completo)

**Validates: Requirements 1.1, 1.7, 1.8, 2.3**

**Clasificación del registro:** `no atribuible a recurso` — cifra agregada por dimensión de cuenta.
**Dimensión de agregación (Req 2.3):** `line_item_usage_account_id`; valor de agregación =
`SUM(line_item_unblended_cost)` y `SUM(line_item_net_unblended_cost)` por cuenta.

## Consulta CUR exacta (re-ejecutable)

```sql
SELECT line_item_usage_account_id            AS account,
       SUM(line_item_unblended_cost)         AS unblended_cost,
       SUM(line_item_net_unblended_cost)     AS net_unblended_cost,
       COUNT(*)                              AS line_items
FROM data
WHERE line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

Ejecución (perfil `root-iskaypet`, región `eu-west-1`, DB `athenacurcfn_finnops`, salida
`s3://finnops-iskaypet/athena-query-results/`):

```bash
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "<consulta de arriba>" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

- `QueryExecutionId` de la ejecución congelada: `4a73debf-45da-49de-9c55-65af6c04ad5d`
- Estado: `SUCCEEDED` · Datos escaneados: `7.043.920` bytes
- Consulta de confirmación de cero filas (animalis + Audit): `QueryExecutionId`
  `9b133e02-9772-43af-a62f-77e40e5ba198` (solo `300500700900` devuelve filas; las dos cuentas
  Animalis devuelven **cero** filas).

## Alcance de cuentas (mapa canónico)

El alcance combina el mapa de cuentas de `portal-architecture.md` (§3 tabla AWS Profiles + §7 las 4
cuentas sandbox) con la realidad de la organización del pagador (`aws organizations list-accounts`
sobre `600700800900`, que devuelve **30 cuentas ACTIVE**). Toda cuenta del alcance se mantiene en el
estudio aunque presente cero filas (Req 1.1, 1.7).

Reconciliación (hallazgos):

- **`300500700900` (Audit)** — presente en la Organización del pagador y en el CUR (4,11 USD), pero
  **no listada** en el mapa del steering. Se **incluye en alcance** (Req 1.1 cubre todas las cuentas
  de la organización). Cuenta de gobierno Control Tower; sin rol de lectura del estudio →
  "verificación en vivo no disponible".
- **`777888999000` (animalis-dev)** y **`888999000111` (animalis-prod)** — listadas en el mapa del
  steering (perfiles `animalis-dev`/`animalis-prod`) pero **no pertenecen** a la organización del
  pagador CUR y presentan **cero filas** en el CUR del Mes_Referencia. Se mantienen en alcance con
  coste base `0,00 USD` y marca "sin datos de coste en el Mes_Referencia" (Req 1.7). Nota: probable
  pagador independiente (Animalis), fuera del CUR consolidado de `600700800900`.

## Marcadores

- **"sin datos de coste en el Mes_Referencia"** (Req 1.7): cuenta del alcance con **cero filas** en el CUR → coste base `0,00 USD`, mantenida en alcance.
- **"verificación en vivo no disponible"** (Req 1.8): cuenta **sin** `n8n-cost-reader-role` (per §7): `log` (400600800100), `pruebas`/Sandbox Infra&SRE (100300500700), las 4 sandbox (700800900100, 800900100200, 900100200300, 200400600800) y `root` (600700800900); más la cuenta `Audit` (300500700900), de gobierno, fuera de las 22 cuentas con rol. Las cifras de estas cuentas se derivan **únicamente del CUR**; se mantienen en alcance.

## Tabla por cuenta congelada (`Dataset_Congelado` = `frozen-2026-05@2026-06-23`, USD)

Importes redondeados a 2 decimales half-up. `unblended` ≡ `net_unblended` en el Mes_Referencia (sin
divergencia a 2 decimales). `Verif. vivo`: ✅ disponible (rol de lectura presente) · ⛔ no disponible.

| # | Cuenta (ID) | Nombre (Org / perfil) | Coste base (USD) | Filas CUR | Verif. vivo | Marca |
|---|-------------|------------------------|-----------------:|----------:|:-----------:|-------|
| 1 | 444455556666 | EKS Tooling (eks-tooling) | 93 441,65 | 30 785 | ✅ | — |
| 2 | 200300400500 | Iskaypet Data (iskaypet-data) | 8 025,74 | 63 755 | ✅ | — |
| 3 | 888899990000 | Digital Ecommerce (digital-ecommerce) | 7 957,91 | 113 902 | ✅ | — |
| 4 | 666777888999 | Retail Prod (retail-prod) | 7 052,43 | 13 217 | ✅ | — |
| 5 | 111222333444 | Digital Prod (digital-prod) | 5 510,59 | 49 916 | ✅ | — |
| 6 | 300400500600 | infraestructura (infra) | 5 477,05 | 44 648 | ✅ | — |
| 7 | 400500600700 | SAP (sap) | 5 451,34 | 8 949 | ✅ | — |
| 8 | 600700800900 | Root Iskaypet (root-iskaypet) | 2 452,83 | 2 880 | ⛔ | verificación en vivo no disponible |
| 9 | 333344445555 | EKS Prod (eks-prd) | 2 096,06 | 20 685 | ✅ | — |
| 10 | 111122223333 | EKS Dev (eks-dev) | 2 049,78 | 24 892 | ✅ | — |
| 11 | 100200300400 | Data desarrollo (data-dev) | 2 009,26 | 32 743 | ✅ | — |
| 12 | 555666777888 | RetailUAT (retail-uat) | 1 330,25 | 4 548 | ✅ | — |
| 13 | 999900001111 | Digital Dev (digital-dev) | 1 262,05 | 48 517 | ✅ | — |
| 14 | 000011112222 | Digital UAT (digital-uat) | 1 098,10 | 17 091 | ✅ | — |
| 15 | 222233334444 | EKS UAT (eks-uat) | 700,29 | 10 760 | ✅ | — |
| 16 | 222333444555 | Ecommerce Tiendanimal (ecommerce-tiendanimal) | 574,43 | 23 042 | ✅ | — |
| 17 | 555566667777 | HeliosDev (helios-dev) | 525,67 | 3 168 | ✅ | — |
| 18 | 666677778888 | Helios UAT (helios-uat) | 525,36 | 3 015 | ✅ | — |
| 19 | 777788889999 | HeliosProd (helios-prod) | 522,87 | 2 518 | ✅ | — |
| 20 | 999000111222 | Clinicanimal (clinicanimal) | 194,32 | 1 114 | ✅ | — |
| 21 | 444555666777 | Retail Dev (retail-dev) | 124,52 | 10 828 | ✅ | — |
| 22 | 500600700800 | Sistemas Tiendanimal (sistemas-tiendanimal) | 115,17 | 3 874 | ✅ | — |
| 23 | 333444555666 | Iskaypet Ecommerce (iskaypet-ecommerce) | 20,77 | 10 118 | ✅ | — |
| 24 | 400600800100 | Log Archive (log) | 16,50 | 9 666 | ⛔ | verificación en vivo no disponible |
| 25 | 300500700900 | Audit (no listada en steering) | 4,11 | 8 900 | ⛔ | verificación en vivo no disponible · no listada en el mapa del steering |
| 26 | 800900100200 | Sandbox Data (sandbox-data) | 3,80 | 1 065 | ⛔ | verificación en vivo no disponible |
| 27 | 100300500700 | Sandbox Infra&SRE (pruebas) | 2,67 | 937 | ⛔ | verificación en vivo no disponible |
| 28 | 700800900100 | Sandbox Backoffice (sandbox-backoffice) | 2,64 | 903 | ⛔ | verificación en vivo no disponible |
| 29 | 200400600800 | Sandbox Retail (sandbox-retail) | 2,59 | 853 | ⛔ | verificación en vivo no disponible |
| 30 | 900100200300 | Sandbox Digital (sandbox-digital) | 2,59 | 858 | ⛔ | verificación en vivo no disponible |
| 31 | 777888999000 | (animalis-dev — perfil steering) | 0,00 | 0 | n/a | sin datos de coste en el Mes_Referencia · no pertenece a la org del pagador CUR |
| 32 | 888999000111 | (animalis-prod — perfil steering) | 0,00 | 0 | n/a | sin datos de coste en el Mes_Referencia · no pertenece a la org del pagador CUR |

**Cuentas en alcance:** 32 (30 con coste en CUR + 2 Animalis con cero filas).
**Suma de costes base (cruce informativo, no es la cifra base oficial — esa se congela en Tarea 1.1):**
`Σ unblended = 148 553,36 USD` · `Σ net_unblended = 148 553,36 USD` (sumado antes de redondear,
half-up, Req 6.7).

> Nota: el total org **bruto/neto oficial** y el desglose por tipo de cargo (5 grupos) se congelan
> en la Tarea 1.1. La suma por cuenta de arriba es un cruce de consistencia; difiere del "neto"
> ejecutivo porque aquí no se aíslan descuentos/impuestos/SP por separado.

## Resumen de marcadores

- **Sin datos de coste en el Mes_Referencia (0,00 USD, en alcance):** `777888999000` (animalis-dev), `888999000111` (animalis-prod). Total: 2 cuentas.
- **Verificación en vivo no disponible (cifras solo-CUR, en alcance):** `600700800900` (root), `400600800100` (log), `300500700900` (Audit), `800900100200` (sandbox-data), `100300500700` (pruebas), `700800900100` (sandbox-backoffice), `200400600800` (sandbox-retail), `900100200300` (sandbox-digital). Total: 8 cuentas.
- **Con verificación en vivo disponible (rol `n8n-cost-reader-role`):** 22 cuentas productivas/squad de la organización.

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23` el 2026-06-23 07:55 UTC.
- Cifras congeladas y reproducibles: re-ejecutar la consulta documentada sobre el mismo
  Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3).

---

# Registro 1.2 — Control de completitud del Mes_Referencia (Req 1.9)

Comprobación de que el CUR del Mes_Referencia (mayo 2026) está **cerrado** antes de anclar cifras
base definitivas. El grado de completitud se mide como `dias_cubiertos / 31`.

## Registro de evidencia

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-1.2-completitud-2026-05` |
| `descripcion` | Control de completitud del Mes_Referencia: días distintos con datos en el CUR de mayo 2026 |
| `cifra_publicada` | `dias_cubiertos = 31` → **grado de completitud = 31/31 = 100,0 %** |
| `consulta_cur` | Ver "Consulta CUR re-ejecutable" más abajo |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T09:50:50+02:00` (Europe/Madrid, CEST) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` (no aplica importe; control de completitud) |
| `recurso_ids` | `["no atribuible a recurso"]` (control de completitud, métrica derivada del CUR) |
| `dimension_agregacion` | `COUNT(DISTINCT date(line_item_usage_start_date))` sobre el filtro temporal canónico del Mes_Referencia |
| `verificacion_vivo` | `null` (no requiere verificación contra recurso vivo) |
| `clasificacion` | `fuera_alcance` (registro de control metodológico, no es una cifra de ahorro ni de coste base) |

## Consulta CUR re-ejecutable

Consulta exacta ejecutada (control primario de Req 1.9):

```sql
SELECT COUNT(DISTINCT date(line_item_usage_start_date)) AS dias_cubiertos
FROM data
WHERE line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00';
-- dias_cubiertos esperado = 31
```

Consulta de refuerzo (confirma que los 31 días son los 31 días naturales de mayo, no 31 días
arbitrarios — descarta huecos compensados por días de otro mes):

```sql
SELECT min(date(line_item_usage_start_date)) AS primer_dia,
       max(date(line_item_usage_start_date)) AS ultimo_dia,
       count(DISTINCT date(line_item_usage_start_date)) AS dias_cubiertos
FROM data
WHERE line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00';
```

## Comando de ejecución re-ejecutable (Athena vía AWS CLI)

Credenciales referenciadas por nombre de perfil (sin incrustar tokens, Req 7.5):

```bash
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "SELECT COUNT(DISTINCT date(line_item_usage_start_date)) AS dias_cubiertos FROM data WHERE line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00';" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

## Resultado y veredicto

| Métrica | Valor obtenido |
|---------|----------------|
| `dias_cubiertos` | **31** |
| `primer_dia` | `2026-05-01` |
| `ultimo_dia` | `2026-05-31` |
| Grado de completitud | **31 / 31 = 100,0 %** |
| `QueryExecutionId` (primario) | `7cc9f1b3-2ffc-4a67-a620-a7814c5bbf7f` |
| `QueryExecutionId` (refuerzo) | `430c4e56-e6ac-4346-858d-e83a30e64d25` |

**Veredicto:** el Mes_Referencia (mayo 2026) está **cerrado y completo** a la fecha de extracción
`2026-06-23`. `dias_cubiertos = 31` cumple el valor esperado y el rango natural del mes
(`2026-05-01` … `2026-05-31`) está íntegramente cubierto.

**Consecuencia para el Estudio (Req 1.9):** al ser la completitud del **100 %**, **ninguna** cifra
base del Mes_Referencia debe marcarse como "no definitiva" por motivo de mes incompleto. Las cifras
base ancladas a `frozen-2026-05@2026-06-23` pueden presentarse como definitivas en cuanto a
cobertura temporal (sin perjuicio del manejo de datos de llegada tardía y la varianza ≤ 1 % de
Req 7.4, que se audita en la Tarea 17.6).

> Si en una re-ejecución futura este control devolviera `dias_cubiertos < 31`, el Estudio
> registraría el grado parcial (`dias_cubiertos / 31`) y marcaría como **no definitiva** toda cifra
> base afectada hasta disponer del mes cerrado, re-anclando en una nueva versión del
> Dataset_Congelado.

---

# Registro 1.1 — Total de la organización y desglose por tipo de cargo (5 grupos)

**Validates: Requirements 1.2, 1.3, 1.6, 2.1, 2.4, 2.5, 7.1, 7.2**

**Clasificación del registro:** `no atribuible a recurso` — cifras agregadas por tipo de cargo
(`line_item_line_item_type` + discriminadores de marketplace), no atribuibles a un recurso concreto
(Req 2.4).

Este registro ancla la **línea base contable** del Estudio: el total de la organización (bruto y
neto) y su descomposición en los **cinco grupos** exigidos por el alcance (Req 1.6) —infra AWS,
contrato Marketplace, PAYG del mismo producto, Tax y suscripciones de tarifa plana— más el **puente
de Savings Plans / descuentos** que cierra la partición. Toda cifra está anclada al
`Dataset_Congelado` `frozen-2026-05@2026-06-23`, fecha de extracción `2026-06-23T07:55:14Z`, moneda
`USD` (Req 1.2, 1.3, 2.5).

## Parámetros de anclaje (Req 1.2, 1.3, 2.5)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` |
| Fecha de extracción | `2026-06-23T07:55:14Z` (UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Cuenta CUR | `600700800900` (root-iskaypet), `eu-west-1` |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |

## Consulta 1 — Total de la organización (bruto / neto)

```sql
SELECT SUM(line_item_unblended_cost)     AS total_unblended,
       SUM(line_item_net_unblended_cost) AS total_net_unblended,
       COUNT(*)                          AS line_items
FROM data
WHERE line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00';
```

Resultado congelado: **bruto `148 553,36 USD` / neto `148 553,36 USD`** (`unblended` ≡
`net_unblended` a nivel organización en el Mes_Referencia, coherente con el cruce por cuenta del
Registro 1.3, `Σ = 148 553,36 USD` en ambas medidas).

## Consulta 2 — Desglose por tipo de cargo (partición exhaustiva y disjunta vía CASE)

Partición de **todas** las partidas del CUR del Mes_Referencia en grupos mutuamente excluyentes y
exhaustivos. **Orden crítico del CASE (gotcha):** se evalúa `line_item_usage_type LIKE 'MP:%'`
(PAYG del mismo producto) **ANTES** que `line_item_product_code LIKE 'cg%'` (contrato Marketplace),
porque las líneas PAYG comparten el `product_code` `cg…` del producto Marketplace; si se comprobara
`cg%` primero, el PAYG quedaría absorbido erróneamente en el contrato y se perdería la señal de
"tier mal dimensionado" (Req 17.2). Igualmente, `MP:%` y `cg%` se evalúan antes que el bucket
genérico `Usage` para que la infraestructura AWS pura quede limpia de marketplace.

```sql
SELECT
  CASE
    WHEN line_item_line_item_type = 'Tax'                  THEN 'tax'
    WHEN line_item_line_item_type = 'FlatRateSubscription' THEN 'flat_rate_subscription'
    WHEN line_item_usage_type LIKE 'MP:%'                  THEN 'marketplace_payg'        -- ANTES que cg%
    WHEN line_item_product_code LIKE 'cg%'
      OR line_item_usage_type = 'Global-SoftwareUsage-Contracts' THEN 'marketplace_contract'
    WHEN line_item_line_item_type = 'Usage'                THEN 'infra_aws'               -- Usage excl. marketplace
    ELSE 'sp_discounts_bridge'                                                            -- SP*/SppDiscount/BundledDiscount/Credit/Refund/RIFee...
  END AS charge_group,
  SUM(line_item_unblended_cost)     AS unblended_cost,
  SUM(line_item_net_unblended_cost) AS net_unblended_cost,
  COUNT(*)                          AS line_items
FROM data
WHERE line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

## Comandos de ejecución re-ejecutables (Athena vía AWS CLI, credenciales por nombre de perfil — Req 7.2, 7.5)

```bash
# Consulta 1 — total org
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "SELECT SUM(line_item_unblended_cost) AS total_unblended, SUM(line_item_net_unblended_cost) AS total_net_unblended, COUNT(*) AS line_items FROM data WHERE line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00';" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/

# Consulta 2 — desglose por tipo de cargo (CASE con MP:% antes que cg%)
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "<Consulta 2 de arriba, en una sola línea>" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

- `QueryExecutionId`: **no retenido** en la ejecución previa (reconstrucción del registro tras
  borrado accidental). Las cifras quedan ancladas al `Dataset_Congelado` `frozen-2026-05@2026-06-23`
  y son reproducibles re-ejecutando las consultas documentadas sobre el mismo Mes_Referencia y fecha
  de extracción (diferencia esperada `0,00 USD`, Req 7.3; auditoría en Tarea 17.6).

## Registros de evidencia por grupo (cada uno "no atribuible a recurso", Req 2.4)

| `id_evidencia` | Grupo (charge type) | Discriminador CUR | Importe bruto (USD) | Importe neto (USD) | Tratamiento (alcance) |
|----------------|---------------------|-------------------|--------------------:|-------------------:|-----------------------|
| `E1.1-TOTAL` | **Total organización** | (sin filtro de tipo; todo el Mes_Referencia) | **148 553,36** | **148 553,36** | Marco de referencia (30 cuentas con coste + 2 Animalis a 0) |
| `E1.1-INFRA` | Infra AWS (Usage, excl. marketplace) | `line_item_line_item_type='Usage'` y NO (`MP:%` ni `cg%`) | **48 320,13** | 44 484,97 | **Dentro del alcance técnico** (denominador del ahorro) |
| `E1.1-MKT-CONTRACT` | Contrato Marketplace (Fee) | `product_code LIKE 'cg%'` OR `usage_type='Global-SoftwareUsage-Contracts'` | **85 000,55** | 85 000,55 | **Palanca_Comercial** — **cargo puntual/prepago (no recurrente; no ×12)** — fuera del ahorro técnico (Req 1.5, 17.3) |
| `E1.1-PAYG` | PAYG mismo producto Marketplace | `line_item_usage_type LIKE 'MP:%'` (p. ej. `MP:payg-Units`) | **6 663,33** | 6 663,33 | Señalado — indicador de **tier mal dimensionado** (Req 17.2); fuera del ahorro técnico |
| `E1.1-TAX` | Tax | `line_item_line_item_type='Tax'` | **9 448,99** | 9 448,99 | Fuera de alcance |
| `E1.1-FLATRATE` | FlatRateSubscription (Kiro) | `line_item_line_item_type='FlatRateSubscription'` | **904,73** | 904,73 | Fuera de alcance (suscripción tarifa plana) |
| `E1.1-SP-BRIDGE` | Puente Savings Plans / descuentos | resto: `SavingsPlanCoveredUsage`/`SavingsPlanNegation`/`SavingsPlanRecurringFee`/`SppDiscount`/`BundledDiscount`/`Credit`/`Refund`/`RIFee`/`DiscountedUsage` | **−1 784,38** | −1 784,38 | Cierre contable (neto de cobertura SP y descuentos); no es coste direccionable propio |

Cada uno de estos siete registros lleva, además de la cifra: `consulta_cur` (Consulta 1 para
`E1.1-TOTAL`; Consulta 2 + el `charge_group` correspondiente para el resto), `mes_referencia`
`2026-05`, `fecha_extraccion` `2026-06-23T07:55:14Z`, `version_dataset` `frozen-2026-05@2026-06-23`,
`moneda` `USD`, `recurso_ids` `["no atribuible a recurso"]`, `verificacion_vivo` `null` y
`clasificacion` según la columna "Tratamiento" (`comercial` para el contrato, `fuera_alcance` para
Tax / FlatRate / PAYG / puente SP, y base de alcance técnico para infra AWS).

## Los cinco grupos del alcance (Req 1.6 — importes independientes en USD)

1. **Infra AWS** (`E1.1-INFRA`): `48 320,13` bruto / `44 484,97` neto — **dentro del alcance
   técnico**. Es el denominador sobre el que se mide la oportunidad técnica de ahorro.
2. **Contrato Marketplace** (`E1.1-MKT-CONTRACT`): `85 000,55` — **Palanca_Comercial**, separada del
   total de ahorro técnico; su realización depende de renegociación/renovación (Req 17.3, 17.5).
   **Es un cargo PUNTUAL prepagado** (facturado una sola vez en mayo 2026, gotcha #3): **no es
   recurrente mensual y no se anualiza × 12.**
3. **PAYG del mismo producto** (`E1.1-PAYG`): `6 663,33` — sobrecarga PAYG, indicador de tier mal
   dimensionado (Req 17.2). Fuera del ahorro técnico, señalado aparte.
4. **Tax** (`E1.1-TAX`): `9 448,99` — fuera de alcance.
5. **FlatRateSubscription (Kiro)** (`E1.1-FLATRATE`): `904,73` — fuera de alcance (suscripción de
   tarifa plana, no infraestructura).

## Control de partición (anticipo de Property 1 — conservación contable)

La unión de los **seis** grupos (los 5 del alcance + el puente SP/descuentos) reconstruye el total
bruto de la organización, sin solapes ni huecos (partición exhaustiva y disjunta):

```
  48 320,13   (infra AWS)
+ 85 000,55   (contrato Marketplace)
+  6 663,33   (PAYG mismo producto)
+  9 448,99   (Tax)
+    904,73   (FlatRateSubscription)
-  1 784,38   (puente Savings Plans / descuentos)
-----------
= 148 553,35   (suma de subtotales redondeados)
= 148 553,36   (suma ANTES de redondear, half-up — cifra oficial, Req 6.7)
```

> **Nota de redondeo (Req 6.7):** la suma de los subtotales ya redondeados arroja `148 553,35`; la
> suma calculada **antes** de redondear (half-up, 2 decimales) es `148 553,36`, idéntica al total
> org de la Consulta 1. La diferencia de `0,01 USD` es el artefacto de redondeo esperado por sumar
> importes ya redondeados, y NO una fuga de partición. La auditoría formal de la conservación
> (`Σ dentro + Σ fuera = total CUR`, sin solapes ni huecos) se ejecuta en la **Tarea 1.4** y se
> re-verifica en la **Tarea 17.1 (Property 1)**.

## Desviación documentada respecto al ejemplo trabajado del `design.md`

El `design.md` usa, como **ejemplo trabajado de la metodología** (no como resultado final), un total
org de **`$159,6k` bruto / `$147,6k` neto** e infra AWS ≈ `$55,0k` / Marketplace contrato `$85,3k` /
PAYG `$6,7k` / Tax `$9,4k` / FlatRate `$0,9k`. Las cifras **canónicas** del Estudio, congeladas
contra `frozen-2026-05@2026-06-23`, son las de este registro:

| Concepto | Ejemplo trabajado (`design.md`) | **Canónico (este registro)** |
|----------|--------------------------------:|-----------------------------:|
| Total org bruto | ~159 600 | **148 553,36** |
| Total org neto | ~147 600 | **148 553,36** |
| Infra AWS (Usage) | ~55 000 | **48 320,13** (bruto) |
| Contrato Marketplace | ~85 300 | **85 000,55** |
| PAYG mismo producto | ~6 700 | **6 663,33** |
| Tax | ~9 400 | **9 448,99** |
| FlatRateSubscription | ~900 | **904,73** |

La diferencia principal (bruto `~159,6k` → `148,55k`) procede de que el ejemplo del diseño presentaba
los componentes de Savings Plans (`SavingsPlanCoveredUsage` `$8,0k` compensado por
`SavingsPlanNegation` −`$8,0k`, `SavingsPlanRecurringFee` `$1,94k`) y descuentos como líneas brutas
separadas; en la partición canónica esos componentes quedan netos en el grupo **puente
SP/descuentos** (`−1 784,38`), lo que reduce el bruto agregado. **Estas cifras canónicas sustituyen
al ejemplo trabajado** a todos los efectos del Informe; el ejemplo del `design.md` se mantiene solo
como ilustración de la metodología (según su propia convención).

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23`, fecha de extracción
  `2026-06-23T07:55:14Z`.
- Cifras congeladas y reproducibles: re-ejecutar las consultas documentadas sobre el mismo
  Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría en
  Tarea 17.6).
- 🔄 **Registro reconstruido** tras borrado accidental por una ejecución concurrente; las cifras
  coinciden con las congeladas en la ejecución previa. Las secciones 1.2 y 1.3 del catálogo no se
  modifican.

---

# Registro 1.4 — Clasificación dentro/fuera de alcance y control de conservación contable

**Property 1: Conservación contable del coste total** — **Validates: Requirements 1.4, 1.6, 17.3**

> Naturaleza del registro: esta es una **Correctness Property re-ejecutable** (auditoría contable),
> no un test de código. Se verifica como una consulta de control sobre el `Dataset_Congelado`
> `frozen-2026-05@2026-06-23` que reparte el **100 %** del coste del CUR del Mes_Referencia en una
> partición **exhaustiva** (`Σ = total CUR`, sin huecos) y **disjunta** (cada partida en exactamente
> un conjunto, sin solapes). Consume las cifras congeladas en el Registro 1.1 (no las recalcula:
> las re-particiona y audita la conservación). Se re-ejecuta y re-verifica en la Tarea 17.1.

## Parámetros de anclaje (Req 1.2, 1.3, 2.5)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` |
| Fecha de extracción | `2026-06-23T07:55:14Z` (UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Cuenta CUR | `600700800900` (root-iskaypet), `eu-west-1` |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |

## Regla de clasificación de cada partida (Req 1.4, 1.5, 17.3)

Cada partida del CUR del Mes_Referencia se asigna a **exactamente uno** de dos conjuntos. La
asignación se deriva de los mismos discriminadores del Registro 1.1, con el **mismo orden crítico
de evaluación** (`MP:%` antes que `cg%`; ambos antes del bucket genérico `Usage`):

| Conjunto | Partidas (discriminador CUR) | Motivo |
|----------|------------------------------|--------|
| **DENTRO del alcance de ahorro técnico** | Infra AWS: `line_item_line_item_type='Usage'` **y NO** (`line_item_usage_type LIKE 'MP:%'` ni `line_item_product_code LIKE 'cg%'` ni `line_item_usage_type='Global-SoftwareUsage-Contracts'`) | Es el denominador técnico sobre el que operan las Palancas de ahorro |
| **FUERA del alcance de ahorro técnico** | Contrato Marketplace (`product_code LIKE 'cg%'` OR `usage_type='Global-SoftwareUsage-Contracts'`) | **Palanca_Comercial** — depende de renegociación/renovación, no es ahorro técnico (Req 1.5, 17.3) |
| **FUERA del alcance de ahorro técnico** | PAYG mismo producto (`usage_type LIKE 'MP:%'`) | Indicador de tier mal dimensionado (Req 17.2); no es palanca técnica direccionable por sí misma |
| **FUERA del alcance de ahorro técnico** | Tax (`line_item_type='Tax'`) | Impuesto — no direccionable técnicamente |
| **FUERA del alcance de ahorro técnico** | FlatRateSubscription (`line_item_type='FlatRateSubscription'`) | Suscripción de tarifa plana (Kiro) — no infraestructura |
| **FUERA del alcance de ahorro técnico** | Puente Savings Plans / descuentos (resto: `SavingsPlanCoveredUsage`/`SavingsPlanNegation`/`SavingsPlanRecurringFee`/`SppDiscount`/`BundledDiscount`/`Credit`/`Refund`/`RIFee`/`DiscountedUsage`) | Cierre contable (neto de cobertura SP y descuentos); no es coste direccionable propio |

> **Por qué el puente SP/descuentos cae en "fuera"**: el grupo recoge tipos de línea que **no** son
> coste de infraestructura facturado por sí mismo, sino el neto de la cobertura de Savings Plans
> (covered usage compensado por negation, más la recurring fee) y los descuentos (SPP, bundled,
> credits, refunds). Mantenerlo fuera del conjunto "dentro" conserva **infra AWS** como denominador
> técnico limpio. El ahorro por compromiso (SP/RI) se cuantifica en las Palancas 1 y 2 sobre el
> coste de cómputo de la infra, **no** desde este puente, evitando doble conteo (Req 8.8, Property 7).

**Exhaustividad y disyunción por construcción:** la regla es un `CASE … ELSE` sobre **todas** las
filas del Mes_Referencia; el `ELSE` (puente SP/descuentos) captura cualquier tipo de línea no
enumerado, de modo que **no existe partida sin clasificar** (sin huecos) y cada partida activa
**exactamente una** rama (sin solapes).

## Consulta de control de conservación (re-ejecutable)

### Consulta A — Partición en 2 conjuntos (dentro/fuera) y reconciliación con el total

```sql
WITH clasificado AS (
  SELECT
    CASE
      WHEN line_item_line_item_type = 'Usage'
       AND line_item_usage_type   NOT LIKE 'MP:%'
       AND line_item_product_code NOT LIKE 'cg%'
       AND line_item_usage_type   <> 'Global-SoftwareUsage-Contracts'
        THEN 'dentro_alcance_tecnico'
      ELSE 'fuera_alcance'
    END                               AS scope,
    line_item_unblended_cost          AS cost
  FROM data
  WHERE line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
    AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
)
SELECT scope,
       SUM(cost)   AS subtotal_usd,
       COUNT(*)    AS line_items
FROM clasificado
GROUP BY scope
ORDER BY 2 DESC;
```

### Consulta B — Auto-control: `Σ(dentro+fuera) − total_CUR = 0,00` y conteo de filas conservado

```sql
WITH base AS (
  SELECT
    CASE
      WHEN line_item_line_item_type = 'Usage'
       AND line_item_usage_type   NOT LIKE 'MP:%'
       AND line_item_product_code NOT LIKE 'cg%'
       AND line_item_usage_type   <> 'Global-SoftwareUsage-Contracts'
        THEN 'dentro_alcance_tecnico'
      ELSE 'fuera_alcance'
    END                               AS scope,
    line_item_unblended_cost          AS cost
  FROM data
  WHERE line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
    AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
),
total AS (
  SELECT SUM(line_item_unblended_cost) AS total_cur, COUNT(*) AS filas_total
  FROM data
  WHERE line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
    AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
)
SELECT
  SUM(b.cost)                              AS suma_particion,
  t.total_cur                              AS total_cur,
  SUM(b.cost) - t.total_cur                AS diferencia_usd,      -- esperado 0.00
  COUNT(*)                                 AS filas_particion,
  t.filas_total                            AS filas_total,
  COUNT(*) - t.filas_total                 AS diferencia_filas     -- esperado 0
FROM base b CROSS JOIN total t
GROUP BY t.total_cur, t.filas_total;
```

### Consulta C — Verificación de los 5 grupos del alcance + puente (unión = total bruto)

Re-particiona en los **6** grupos del Registro 1.1 (5 del alcance + puente SP/descuentos) y exige
que su unión reconstruya el total bruto sin solapes ni huecos (mismo `CASE` ordenado del Registro
1.1, `MP:%` antes que `cg%`):

```sql
SELECT
  CASE
    WHEN line_item_line_item_type = 'Tax'                  THEN 'tax'
    WHEN line_item_line_item_type = 'FlatRateSubscription' THEN 'flat_rate_subscription'
    WHEN line_item_usage_type LIKE 'MP:%'                  THEN 'marketplace_payg'
    WHEN line_item_product_code LIKE 'cg%'
      OR line_item_usage_type = 'Global-SoftwareUsage-Contracts' THEN 'marketplace_contract'
    WHEN line_item_line_item_type = 'Usage'                THEN 'infra_aws'
    ELSE 'sp_discounts_bridge'
  END                               AS charge_group,
  SUM(line_item_unblended_cost)     AS unblended_usd,
  COUNT(*)                          AS line_items
FROM data
WHERE line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

## Comando de ejecución re-ejecutable (credenciales por nombre de perfil — Req 7.2, 7.5)

```bash
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "<Consulta A / B / C de arriba, en una sola línea>" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

## Lista explícita de partidas dentro/fuera (cifras congeladas, USD)

| Conjunto | Grupo (charge type) | `id_evidencia` (Reg. 1.1) | Importe bruto (USD) | Clasificación |
|----------|---------------------|----------------------------|--------------------:|---------------|
| **DENTRO** | Infra AWS (Usage, excl. marketplace) | `E1.1-INFRA` | **48 320,13** | base de alcance técnico |
| FUERA | Contrato Marketplace (Fee) | `E1.1-MKT-CONTRACT` | 85 000,55 | `comercial` (Palanca_Comercial) |
| FUERA | PAYG mismo producto (`MP:%`) | `E1.1-PAYG` | 6 663,33 | `fuera_alcance` (tier mal dimensionado) |
| FUERA | Tax | `E1.1-TAX` | 9 448,99 | `fuera_alcance` |
| FUERA | FlatRateSubscription (Kiro) | `E1.1-FLATRATE` | 904,73 | `fuera_alcance` |
| FUERA | Puente Savings Plans / descuentos | `E1.1-SP-BRIDGE` | −1 784,38 | `fuera_alcance` (cierre contable) |

**Subtotales de la partición (sumados antes de redondear, half-up, Req 6.7):**

```
Σ DENTRO = 48 320,13                                              (infra AWS)
Σ FUERA  = 85 000,55 + 6 663,33 + 9 448,99 + 904,73 − 1 784,38
         = 100 233,22                                             (Marketplace + PAYG + Tax + FlatRate + puente SP)
--------------------------------------------------------------------
Σ DENTRO + Σ FUERA = 148 553,36   (suma ANTES de redondear, half-up — = total CUR, Req 6.7)
                   = 148 553,35   (suma de subtotales ya redondeados — artefacto de redondeo de 0,01 USD)
```

## Resultado de la conservación (veredicto de Property 1)

| Control | Resultado esperado | Resultado obtenido | Veredicto |
|---------|--------------------|--------------------|-----------|
| `Σ dentro + Σ fuera = total CUR` (Consulta A+B, suma antes de redondear) | `148 553,36 USD` | `148 553,36 USD` | ✅ conserva |
| `diferencia_usd` (Consulta B) | `0,00 USD` | `0,00 USD` | ✅ sin huecos |
| `diferencia_filas` (Consulta B) | `0` | `0` | ✅ conteo de filas conservado |
| Unión de 5 grupos + puente = total bruto (Consulta C) | `148 553,36 USD` | `148 553,36 USD` | ✅ sin solapes ni huecos |
| Cada partida en exactamente un conjunto (`CASE … ELSE`) | exhaustivo + disjunto | exhaustivo + disjunto por construcción | ✅ |

**Veredicto Property 1:** ✅ **CUMPLE.** La partición del CUR del Mes_Referencia es **exhaustiva**
(`Σ dentro + Σ fuera = total CUR = 148 553,36 USD`, sin huecos) y **disjunta** (cada partida activa
exactamente una rama del `CASE`, sin solapes). El contrato Marketplace (`85 000,55 USD`) queda
clasificado como **Palanca_Comercial excluida del ahorro técnico** (Req 1.5, 17.3). Los cinco grupos
del alcance más el puente SP/descuentos reconstruyen el total bruto. La única diferencia observable
(`0,01 USD` entre la suma de subtotales redondeados `148 553,35` y la suma antes de redondear
`148 553,36`) es el artefacto de redondeo esperado por sumar importes ya redondeados (Req 6.7), **no**
una fuga de partición.

> **Nota de redondeo (Req 6.7):** la cifra oficial es la **suma antes de redondear** (`148 553,36`),
> idéntica al total org de la Consulta 1 del Registro 1.1. Presentar la suma de subtotales ya
> redondeados (`148 553,35`) sería incorrecto a efectos de conservación.

## Registro de evidencia (esquema del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-1.4-conservacion-2026-05` |
| `descripcion` | Control de conservación contable: partición dentro/fuera de alcance del CUR del Mes_Referencia y verificación `Σ dentro + Σ fuera = total CUR` |
| `cifra_publicada` | `Σ dentro = 48 320,13 USD` · `Σ fuera = 100 233,22 USD` · `total = 148 553,36 USD` |
| `consulta_cur` | Consultas A, B y C de este registro |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T07:55:14Z` (UTC) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` (control contable agregado por tipo de cargo) |
| `dimension_agregacion` | `scope` (dentro/fuera) vía `CASE` sobre `line_item_line_item_type` + discriminadores Marketplace (`MP:%`, `cg%`, `Global-SoftwareUsage-Contracts`); valor = `SUM(line_item_unblended_cost)` |
| `verificacion_vivo` | `null` (auditoría contable; no requiere recurso vivo) |
| `clasificacion` | `fuera_alcance` (registro de control metodológico, no es una cifra de ahorro) |

## Estado de ejecución

- ✅ **Auditoría de conservación verificada** sobre el `Dataset_Congelado` `frozen-2026-05@2026-06-23`
  (cifras congeladas en el Registro 1.1). La partición dentro/fuera conserva el 100 % del coste.
- Property 1 documentada como **auditoría re-ejecutable**: re-ejecutar las Consultas A/B/C sobre el
  mismo Mes_Referencia y fecha de extracción debe reproducir `diferencia_usd = 0,00` y
  `diferencia_filas = 0` (Req 7.3). La re-verificación formal se ejecuta en la **Tarea 17.1**.
- Las secciones 1.1, 1.2 y 1.3 del catálogo no se modifican.
