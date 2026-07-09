# Palanca 8 — Red: NAT, VPN, EIP y VPC endpoints · Registro de evidencia (Tarea 10.1)

> Artefacto auditable del Estudio FinOps de Ahorro AWS. Cuantifica el coste de **red ociosa /
> potencialmente direccionable** en el Mes_Referencia: direcciones **IPv4 ociosas**, **NAT
> Gateways**, **conexiones VPN IPsec** y **VPC endpoints**, desglosado por cuenta y por tipo.
> Cifras congeladas contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23`.
>
> **Tarea 10.1** — _Requirements: 14.1, 2.3_.
> La `Verificacion_Recurso_Vivo` (`ec2 describe-nat-gateways`, `describe-addresses`,
> `describe-vpn-connections`, `describe-vpc-endpoints`, solo lectura, `eu-west-1`) corresponde a la
> **Tarea 10.2** (no incluida aquí). La fórmula, clasificación mixta (Garantizado IPv4 idle +
> recursos confirmados ociosos / Estimado para reducción sujeta a rediseño) y la documentación de
> Palanca corresponden a la **Tarea 10.3**.

## Parámetros del Dataset_Congelado (anclaje — Req 1.2, 1.3, 2.5)

| Campo | Valor |
|-------|-------|
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23T08:33:52Z` (UTC) · `2026-06-23T10:33:52+02:00` (Europe/Madrid, CEST) |
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

## Registro 10.1 — Coste de red ociosa / direccionable (NAT, VPN, VPC endpoints, IPv4)

**Validates: Requirements 14.1, 2.3**

**Clasificación del registro:** `no atribuible a recurso` — cifras agregadas por dimensión
`(line_item_usage_type)` y `(line_item_usage_account_id, categoría de red)`. La atribución a
recursos individuales (NAT Gateway id, EIP, VPN connection id, VPC endpoint id) la produce la
`Verificacion_Recurso_Vivo` de la **Tarea 10.2** (Req 2.2).

**Dimensión de agregación (Req 2.3):** primaria `line_item_usage_type`; secundaria
`(line_item_usage_account_id, net_category)` donde `net_category` es la normalización
`{nat_gateway, vpn_ipsec, vpc_endpoint, ipv4_idle, ipv4_inuse}`. Valor de agregación =
`SUM(line_item_unblended_cost)` (bruto), `SUM(line_item_net_unblended_cost)` (neto) y
`SUM(line_item_usage_amount)` (horas / GB-bytes / address-hours según el tipo).

> **Corrección de la consulta del `design.md` (precedencia de operadores).** La consulta del diseño
> escribe el grupo de `OR` y el filtro temporal de `AND` **sin paréntesis**. En SQL `AND` liga más
> fuerte que `OR`, por lo que el filtro de fechas quedaría asociado **solo** al último término
> (`%PublicIPv4%`), contaminando el resultado con NAT/VPN/VpcEndpoint de **todos** los meses. Se
> corrige envolviendo el grupo de `OR` entre paréntesis. La consulta canónica re-ejecutable es la de
> abajo (Q1/Q2/Q3), no la literal del diseño.

### Consulta CUR exacta (re-ejecutable) — Q1: por tipo de uso

```sql
SELECT line_item_usage_type              AS usage_type,
       SUM(line_item_unblended_cost)     AS gross,
       SUM(line_item_net_unblended_cost) AS net,
       SUM(line_item_usage_amount)       AS usage_amount,
       COUNT(*)                          AS line_items
FROM data
WHERE (line_item_usage_type LIKE '%NatGateway%'
    OR line_item_usage_type LIKE '%VPN%'
    OR line_item_usage_type LIKE '%VpcEndpoint%'
    OR line_item_usage_type LIKE '%PublicIPv4%')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

### Consulta CUR exacta (re-ejecutable) — Q2: por cuenta y categoría de red

```sql
SELECT line_item_usage_account_id AS account,
       CASE
         WHEN line_item_usage_type LIKE '%NatGateway%'              THEN 'nat_gateway'
         WHEN line_item_usage_type LIKE '%VPN%'                     THEN 'vpn_ipsec'
         WHEN line_item_usage_type LIKE '%VpcEndpoint%'             THEN 'vpc_endpoint'
         WHEN line_item_usage_type LIKE '%PublicIPv4:IdleAddress%'  THEN 'ipv4_idle'
         WHEN line_item_usage_type LIKE '%PublicIPv4:InUseAddress%' THEN 'ipv4_inuse'
         ELSE 'other'
       END                              AS net_category,
       SUM(line_item_unblended_cost)     AS gross,
       SUM(line_item_net_unblended_cost) AS net,
       SUM(line_item_usage_amount)       AS usage_amount,
       COUNT(*)                          AS line_items
FROM data
WHERE (line_item_usage_type LIKE '%NatGateway%'
    OR line_item_usage_type LIKE '%VPN%'
    OR line_item_usage_type LIKE '%VpcEndpoint%'
    OR line_item_usage_type LIKE '%PublicIPv4%')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2
ORDER BY 4 DESC;
```

### Consulta CUR exacta (re-ejecutable) — Q3: totales por categoría de red

```sql
SELECT CASE
         WHEN line_item_usage_type LIKE '%NatGateway%'              THEN 'nat_gateway'
         WHEN line_item_usage_type LIKE '%VPN%'                     THEN 'vpn_ipsec'
         WHEN line_item_usage_type LIKE '%VpcEndpoint%'             THEN 'vpc_endpoint'
         WHEN line_item_usage_type LIKE '%PublicIPv4:IdleAddress%'  THEN 'ipv4_idle'
         WHEN line_item_usage_type LIKE '%PublicIPv4:InUseAddress%' THEN 'ipv4_inuse'
         ELSE 'other'
       END                                        AS net_category,
       SUM(line_item_unblended_cost)              AS gross,
       SUM(line_item_net_unblended_cost)          AS net,
       SUM(line_item_usage_amount)                AS usage_amount,
       COUNT(DISTINCT line_item_usage_account_id) AS accounts,
       COUNT(*)                                   AS line_items
FROM data
WHERE (line_item_usage_type LIKE '%NatGateway%'
    OR line_item_usage_type LIKE '%VPN%'
    OR line_item_usage_type LIKE '%VpcEndpoint%'
    OR line_item_usage_type LIKE '%PublicIPv4%')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1
ORDER BY 2 DESC;
```

### Comandos de ejecución re-ejecutables (Athena vía AWS CLI; credenciales por nombre de perfil — Req 7.2, 7.5)

```bash
# Q1 — por tipo de uso
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "<Q1 de arriba, en una sola línea>" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/

# Q2 — por cuenta y categoría   (idéntico patrón, query-string = Q2)
# Q3 — totales por categoría     (idéntico patrón, query-string = Q3)
```

### Ejecuciones congeladas (QueryExecutionId)

| Consulta | QueryExecutionId | Estado | Bytes escaneados |
|----------|------------------|--------|-----------------:|
| Q1 — por tipo de uso | `c3a0cc87-f48d-4b7d-b3b3-96bb15609ad3` | `SUCCEEDED` | 6 878 467 |
| Q2 — por cuenta y categoría | `7cdd6ac4-543e-45cc-9380-482e70d945bd` | `SUCCEEDED` | 6 878 467 |
| Q3 — totales por categoría | `c15f3f7d-eefa-4834-978c-ee4f8fa8b3e1` | `SUCCEEDED` | — |

---

## Cifras congeladas (USD, `frozen-2026-05@2026-06-23`)

> Convención: **bruto** = `SUM(line_item_unblended_cost)`; **neto** =
> `SUM(line_item_net_unblended_cost)`. En el Mes_Referencia, para estas partidas de red,
> `unblended ≡ net_unblended` a 2 decimales (no hay divergencia material por descuentos). Importes
> redondeados a 2 decimales half-up; los totales se suman **antes** de redondear (Req 6.7).

### Q1 — Desglose por tipo de uso (todas las cuentas)

| Tipo de uso (`line_item_usage_type`) | Bruto (USD) | Neto (USD) | Cantidad (`usage_amount`) | Líneas |
|--------------------------------------|------------:|-----------:|---------------------------|-------:|
| `EU-NatGateway-Bytes` | 977,60 | 977,60 | 22 137,66 GB-procesados | 837 |
| `EU-VPN-Usage-Hours:ipsec.1` | 650,26 | 650,26 | 14 136,0 h-túnel | 713 |
| `EU-NatGateway-Hours` | 525,68 | 525,68 | 11 904,0 h-NAT | 837 |
| `EU-VpcEndpoint-Hours` | 352,42 | 352,42 | 34 824,0 h-endpoint-AZ | 830 |
| `EU-PublicIPv4:InUseAddress` | 305,90 | 305,90 | 66 499,05 address-hours | 3 400 |
| `EU-PublicIPv4:IdleAddress` | **30,82** | **30,82** | 6 699,81 address-hours | 639 |
| `EU-VpcEndpoint-Bytes` | 0,35 | 0,35 | 37,71 GB-procesados | 213 |

### Q3 — Totales por categoría de red (cifras congeladas del artefacto)

| Categoría | Bruto (USD) | Neto (USD) | Cantidad agregada | Cuentas | Líneas |
|-----------|------------:|-----------:|-------------------|--------:|-------:|
| **NAT Gateway** (Bytes + Hours) | **1 503,28** | 1 503,28 | 34 041,66 (GB + h) · **16 NAT-meses** (11 904 h ÷ 744) | 11 | 1 674 |
| **VPN IPsec** (`ipsec.1` túnel-horas) | **650,26** | 650,26 | 14 136,0 h → **~19 túneles-mes** (14 136 ÷ 744) | 4 | 713 |
| **VPC endpoint** (Hours + Bytes) | **352,77** | 352,77 | 34 861,71 (h-AZ + GB) → **~46,8 endpoint-AZ-mes** | 3 | 1 043 |
| **IPv4 en uso** (`InUseAddress`) | **305,90** | 305,90 | 66 499,05 address-hours → **~89,4 IP-mes** | 14 | 3 400 |
| **IPv4 ociosa** (`IdleAddress`) | **30,82** | 30,82 | 6 699,81 address-hours → **~9,0 IP-mes ociosas** | 7 | 639 |
| **Total red (5 categorías)** | **2 843,02** | **2 843,02** | — | — | 7 469 |

> **Cuantificación de unidades (Req 14.1).**
> - **IPv4 ociosas:** 6 699,81 address-hours ÷ 744 h ≈ **9,0 direcciones-mes** ociosas (en 7 cuentas),
>   por **30,82 USD/mes**. Es el desperdicio directo (candidato a Garantizado, sujeto a la
>   `Verificacion_Recurso_Vivo` de la Tarea 10.2; clasificación en la 10.3).
> - **NAT Gateways:** 11 904 NAT-horas ÷ 744 ≈ **16 NAT Gateways activos** el mes completo (11
>   cuentas) → 525,68 USD de horas + 977,60 USD de proceso de datos = **1 503,28 USD/mes**.
> - **VPN IPsec:** 14 136 túnel-horas ÷ 744 ≈ **19 túneles-mes** (`ipsec.1`) en 4 cuentas →
>   **650,26 USD/mes**.
> - **VPC endpoints:** 34 824 endpoint-AZ-horas ÷ 744 ≈ **46,8 asociaciones endpoint·AZ-mes** en 3
>   cuentas → **352,77 USD/mes** (incl. 0,35 USD de bytes procesados).

### Q2 — Desglose por cuenta y categoría (nombres por mapa del Registro 1.3)

**NAT Gateway** (11 cuentas, total 1 503,28 USD):

| Cuenta (ID) | Nombre | Bruto (USD) | NAT-horas | Líneas |
|-------------|--------|------------:|----------:|-------:|
| 333344445555 | EKS Prod | 379,25 | 8 587,99* | 186 |
| 300400500600 | infraestructura | 353,57 | 8 006,58* | 186 |
| 111122223333 | EKS Dev | 218,89 | 4 956,86* | 186 |
| 444455556666 | EKS Tooling | 174,09 | 3 942,25* | 186 |
| 222233334444 | EKS UAT | 105,09 | 2 379,78* | 186 |
| 200300400500 | Iskaypet Data | 98,97 | 2 241,19* | 124 |
| 100200300400 | Data desarrollo | 41,78 | 945,99* | 124 |
| 666777888999 | Retail Prod | 33,00 | 747,20* | 124 |
| 400500600700 | SAP | 32,94 | 745,83* | 124 |
| 222333444555 | Ecommerce Tiendanimal | 32,86 | 744,00* | 124 |
| 888899990000 | Digital Ecommerce | 32,86 | 744,00* | 124 |

\* `usage_amount` combina horas de NAT (`-Hours`) y GB procesados (`-Bytes`); la cifra es la suma de
ambos tipos. Para nº de NAT Gateways usar las horas aisladas vía la Tarea 10.2.

**VPN IPsec** (4 cuentas, total 650,26 USD):

| Cuenta (ID) | Nombre | Bruto (USD) | Túnel-horas | Líneas |
|-------------|--------|------------:|------------:|-------:|
| 300400500600 | infraestructura | 547,58 | 11 904,0 (~16 túneles-mes) | 527 |
| 111122223333 | EKS Dev | 34,22 | 744,0 (1 túnel) | 62 |
| 500600700800 | Sistemas Tiendanimal | 34,22 | 744,0 (1 túnel) | 62 |
| 200300400500 | Iskaypet Data | 34,22 | 744,0 (1 túnel) | 62 |

**VPC endpoint** (3 cuentas, total 352,77 USD):

| Cuenta (ID) | Nombre | Bruto (USD) | Líneas |
|-------------|--------|------------:|-------:|
| 200300400500 | Iskaypet Data | 169,02 | 519 |
| 100200300400 | Data desarrollo | 168,69 | 462 |
| 111222333444 | Digital Prod | 15,06 | 62 |

**IPv4 ociosa** (`IdleAddress`, 7 cuentas, total 30,82 USD) — *el candidato a Garantizado*:

| Cuenta (ID) | Nombre | Bruto (USD) | Address-horas | IP-mes ociosas (÷744) |
|-------------|--------|------------:|--------------:|----------------------:|
| 888899990000 | Digital Ecommerce | 10,27 | 2 233,11 | ~3,0 |
| 500600700800 | Sistemas Tiendanimal | 10,27 | 2 232,00 | ~3,0 |
| 200300400500 | Iskaypet Data | 6,84 | 1 488,00 | ~2,0 |
| 300400500600 | infraestructura | 3,43 | 744,99 | ~1,0 |
| 400500600700 | SAP | 0,003 | 0,68 | ~0,0 |
| 333344445555 | EKS Prod | 0,003 | 0,65 | ~0,0 |
| 111122223333 | EKS Dev | 0,002 | 0,37 | ~0,0 |

**IPv4 en uso** (`InUseAddress`, 14 cuentas, total 305,90 USD): se registra como contexto (no es
desperdicio); top: infraestructura 156,22 · Digital Ecommerce 27,41 · SAP 27,39 · EKS Dev 20,55 ·
EKS Prod 19,57 · resto < 11 USD/cuenta.

---

## Observaciones (para las Tareas 10.2 y 10.3, no clasifican aquí)

- **El ejemplo trabajado del `design.md`** citaba `TransitGateway $1.38k · VPN ipsec $707 · VPC
  endpoints $383 · IPv4 InUse $332 · IPv4 Idle $33`. Las cifras **canónicas** congeladas de este
  registro son: VPN IPsec **650,26** · VPC endpoints **352,77** · IPv4 InUse **305,90** · IPv4 Idle
  **30,82** · NAT **1 503,28**. El **TransitGateway no lo captura** la consulta de esta Palanca (sus
  patrones son `NatGateway`/`VPN`/`VpcEndpoint`/`PublicIPv4`); si dirección quiere contabilizarlo,
  se trataría en una consulta aparte (`%TransitGateway%`). El ejemplo del diseño se mantiene solo
  como ilustración de la metodología.
- **NAT** es la mayor partida de red (1 503,28 USD/mes), concentrada en cuentas EKS (Prod/Dev/UAT/
  Tooling) + infra; la mayoría da egress a subredes privadas **en uso** → presumiblemente
  **necesario** (Req 14.3). La parte direccionable (NAT duplicados/ociosos) la determina la
  `Verificacion_Recurso_Vivo` (Tarea 10.2).
- **VPN IPsec** está dominada por `infraestructura` (547,58 USD, ~16 túneles-mes); hay que
  distinguir túneles productivos de backup/DR (Req 14.4) en la Tarea 10.3.
- **IPv4 ociosa** (30,82 USD/mes, ~9 IP-mes) es el desperdicio directo y el principal candidato a
  **Ahorro_Garantizado** una vez confirmado por `describe-addresses` (EIP sin asociar) en la Tarea
  10.2.

---

## Registro de evidencia (esquema del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-10.1-red-2026-05` |
| `descripcion` | Coste de red ociosa / direccionable en el Mes_Referencia (NAT Gateways, VPN IPsec, VPC endpoints, IPv4 en uso e IPv4 ociosa), por tipo de uso y por cuenta/categoría |
| `cifra_publicada` | Total red: **2 843,02 bruto / 2 843,02 neto**. Por categoría — NAT **1 503,28** (11 cuentas) · VPN IPsec **650,26** (4) · VPC endpoint **352,77** (3) · IPv4 en uso **305,90** (14) · **IPv4 ociosa 30,82** (7). Unidades: ~16 NAT-mes, ~19 túneles VPN-mes, ~46,8 endpoint·AZ-mes, ~9,0 IP-mes ociosas |
| `consulta_cur` | Q1 (por tipo de uso), Q2 (por cuenta y categoría), Q3 (totales por categoría) — ver arriba; precedencia de `OR` corregida con paréntesis respecto al ejemplo del `design.md` |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:33:52Z` (UTC) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `dimension_agregacion` | Primaria `line_item_usage_type`; secundaria `(line_item_usage_account_id, net_category)` con `net_category ∈ {nat_gateway, vpn_ipsec, vpc_endpoint, ipv4_idle, ipv4_inuse}`; valor = `SUM(line_item_unblended_cost)` / `SUM(line_item_net_unblended_cost)` / `SUM(line_item_usage_amount)` |
| `recurso_ids` | `["no atribuible a recurso"]` (agregados por dimensión). La atribución a NAT id / EIP / VPN connection id / VPC endpoint id la produce la `Verificacion_Recurso_Vivo` de la Tarea 10.2 |
| `verificacion_vivo` | Pendiente — **Tarea 10.2** (`ec2 describe-nat-gateways`, `describe-addresses`, `describe-vpn-connections`, `describe-vpc-endpoints`; solo lectura, `eu-west-1`; Req 5.1, 14.2) |
| `clasificacion` | Dentro del alcance técnico (red es infra AWS direccionable). Palanca **mixta**: IPv4 idle + recursos confirmados ociosos → Garantizado; reducción de NAT/endpoints sujeta a rediseño → Estimado. Clasificación formal en la Tarea 10.3 |
| `QueryExecutionId` | Q1 `c3a0cc87-f48d-4b7d-b3b3-96bb15609ad3` · Q2 `7cdd6ac4-543e-45cc-9380-482e70d945bd` · Q3 `c15f3f7d-eefa-4834-978c-ee4f8fa8b3e1` |

---

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23`, fecha de extracción
  `2026-06-23T08:33:52Z` (UTC), perfil `root-iskaypet`, `eu-west-1`, DB `athenacurcfn_finnops`.
- Cifras congeladas y reproducibles: re-ejecutar las consultas documentadas (Q1/Q2/Q3) sobre el
  mismo Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría
  en Tarea 17.6).
- Conservación interna verificada: Q3 (totales por categoría) reconstruye Q1 (por tipo) —
  NAT = `EU-NatGateway-Bytes` 977,60 + `EU-NatGateway-Hours` 525,68 = 1 503,28; VPC endpoint =
  `EU-VpcEndpoint-Hours` 352,42 + `EU-VpcEndpoint-Bytes` 0,35 = 352,77 — y Q2 (por cuenta) suma a
  los totales de Q3 por categoría (diferencias ≤ 0,02 USD por redondeo).
- ⏭️ **Pendiente Tarea 10.2** — `Verificacion_Recurso_Vivo` (solo lectura) para identificar NAT
  ociosos/duplicados, EIP sin asociar, túneles VPN de backup/DR y redundancia intencionada de VPC
  endpoints por AZ.
- ⏭️ **Pendiente Tarea 10.3** — fórmula, clasificación mixta (Garantizado / Estimado) y
  documentación de Palanca (Req 4, 14.3–14.5).

---

# Sub-registro 10.2 — Verificacion_Recurso_Vivo de red (solo lectura)

> **Tarea 10.2** — _Requirements: 5.1, 14.2_. Verificación en vivo (describe/list/get,
> estrictamente solo lectura — Property 11) del estado real de los recursos de red en `eu-west-1`,
> para atribuir a recursos concretos las cifras agregadas del Registro 10.1 y distinguir lo
> **necesario** (NAT con egress a subredes en uso, redundancia HA por AZ, VPN de backup/DR) de lo
> **ocioso/duplicado/sin uso**. **No congela importes** (eso lo hace el CUR del Registro 10.1); la
> clasificación formal Garantizado/Estimado y la fórmula son la **Tarea 10.3**.

**Validates: Requirements 5.1, 14.2**

## Parámetros de la verificación

| Campo | Valor |
|-------|-------|
| Naturaleza | `Verificacion_Recurso_Vivo` — exclusivamente operaciones de solo lectura `describe-*` (Req 5.1, Property 11). Ninguna operación mutante. |
| Región | `eu-west-1` |
| Ventana de ejecución (UTC) | `2026-06-23T08:59:29Z` – `2026-06-23T09:06Z` |
| Credenciales | SSO SRE por cuenta (perfiles nombrados de `~/.aws/config`). **No se incrustan credenciales** (Req 7.5). Referenciadas por nombre de perfil. |
| Cuentas consultadas | 13 (unión de las cuentas con coste de red del Registro 10.1) — todas con sesión SSO activa y rol de lectura → **0 cuentas `no_verificable`** |
| Drift esperado | El Mes_Referencia del CUR es `2026-05`; esta verificación es del `2026-06-23`. El drift del recurso vivo entre ambas fechas es **esperado** y no invalida las cifras ancladas (Req 7.6). |

### Comandos exactos re-ejecutables (solo lectura — Req 7.5)

```bash
# Por cada cuenta (perfil SSO SRE), región eu-west-1:
aws ec2 describe-nat-gateways    --profile <perfil> --region eu-west-1 \
    --filter Name=state,Values=available,pending,deleting
aws ec2 describe-addresses       --profile <perfil> --region eu-west-1
aws ec2 describe-vpn-connections --profile <perfil> --region eu-west-1
aws ec2 describe-vpc-endpoints   --profile <perfil> --region eu-west-1
# Confirmación de NAT en uso (egress real a subredes privadas):
aws ec2 describe-route-tables    --profile <perfil> --region eu-west-1 \
    --filters 'Name=route.nat-gateway-id,Values=nat-*'
```

Perfiles ↔ cuenta verificados con `aws sts get-caller-identity` (todos OK):
`eks-prd`→333344445555 · `infra`→300400500600 · `eks-dev`→111122223333 · `eks-tooling`→444455556666 ·
`eks-uat`→222233334444 · `iskaypet-data`→200300400500 · `data-dev`→100200300400 ·
`retail-prod`→666777888999 · `sap`→400500600700 · `ecommerce-tiendanimal`→222333444555 ·
`digital-ecommerce`→888899990000 · `sistemas-tiendanimal`→500600700800 · `digital-prod`→111222333444.

---

## A) NAT Gateways — `describe-nat-gateways` + confirmación por route table

**Resultado: 16 NAT Gateways, todos `available`, todos con EIP asociada, y los 16 referenciados por
al menos una route table → 16/16 confirmados EN USO (egress a subredes en uso = necesario, Req
14.3). 0 NAT ociosos, 0 NAT duplicados/huérfanos.** El recuento coincide con los ~16 NAT-mes del
Registro 10.1 (conservación de cifra, drift nulo en conteo).

| Cuenta | NAT Gateway id | VPC | Estado | EIP asociada | ¿Ruta apunta a él? | Veredicto |
|--------|----------------|-----|--------|--------------|--------------------|-----------|
| 333344445555 EKS Prod | nat-0cfad73973fd6f9b5 | vpc-02bf4132a316f8c72 | available | 54.72.208.203 | sí | en uso |
| 333344445555 EKS Prod | nat-02fa21f2db24ee28f | vpc-02bf4132a316f8c72 | available | 34.251.4.197 | sí | en uso |
| 300400500600 infraestructura | nat-03ff8ddb165609779 | vpc-02eabaf9cadbfc538 | available | 54.228.244.182 | sí | en uso |
| 300400500600 infraestructura | nat-05e97d97ba7883a1a | vpc-05d7d515d2aafb338 | available | 18.202.146.55 | sí | en uso |
| 111122223333 EKS Dev | nat-029a1b12a3ae8a7c7 | vpc-021112d36aa61ec76 | available | 54.217.73.57 | sí | en uso |
| 111122223333 EKS Dev | nat-014934a8caceff8fb | vpc-021112d36aa61ec76 | available | 54.75.140.104 | sí | en uso |
| 444455556666 EKS Tooling | nat-04f7fa4df45268aa9 | vpc-0916e3fdfcc0cdcbe | available | 52.215.128.128 | sí | en uso |
| 444455556666 EKS Tooling | nat-0310e34fbe496a7bf | vpc-0916e3fdfcc0cdcbe | available | 34.254.145.70 | sí | en uso |
| 222233334444 EKS UAT | nat-066d86c7719d56582 | vpc-007265e243e3ac0e4 | available | 54.75.43.254 | sí | en uso |
| 222233334444 EKS UAT | nat-0662646227ecb8c11 | vpc-007265e243e3ac0e4 | available | 54.217.67.209 | sí | en uso |
| 200300400500 Iskaypet Data | nat-03d45bfaabd9c8ab4 | vpc-092d0d795ae1e0534 | available | 34.251.227.112 | sí | en uso |
| 100200300400 Data desarrollo | nat-0c952636c31cee408 | vpc-01ce40dfd5a108cdc | available | 46.51.191.92 | sí | en uso |
| 666777888999 Retail Prod | nat-0b5f9dec75a2fd915 | vpc-01d113929eca9acd5 | available | 54.77.89.254 | sí | en uso |
| 400500600700 SAP | nat-0687850c191111501 | vpc-0d054af11a1f1acf0 | available | 34.249.17.178 | sí | en uso |
| 222333444555 Ecommerce Tiendanimal | nat-025ff736c888740dd | vpc-7b58311e | available | 52.31.89.159 | sí | en uso |
| 888899990000 Digital Ecommerce | nat-0d0bbe18a20b9fc70 | vpc-06075493831bce889 | available | 54.76.35.248 | sí | en uso |

- **Redundancia intencionada (no es desperdicio):** los pares de NAT en EKS Prod/Dev/UAT/Tooling
  están en el **mismo VPC pero subredes distintas** = **un NAT por AZ** (patrón HA estándar de AWS;
  evita single-point-of-failure y cargos cross-AZ). En `infraestructura` los 2 NAT están en **VPCs
  distintos** (cada uno sirve a su VPC). Ambos casos → **necesarios** (Req 14.3); no se contabilizan
  como ahorro. La reducción de redundancia (p. ej. colapsar a 1 NAT/cuenta en no-prod) sería un
  **rediseño** → tratable como Estimado en la Tarea 10.3, nunca como Garantizado.
- **estado = `confirmado`** para los 16. **motivo:** n/a.

## B) Direcciones IPv4 / EIP — `describe-addresses` (idle = sin `AssociationId`)

**Resultado: 7 EIP OCIOSAS confirmadas (sin asociación a ENI/instancia/NAT), en 3 cuentas. Son el
candidato directo a Ahorro_Garantizado (desperdicio puro, eliminable sin pérdida de capacidad).**

| Cuenta | EIP (IP pública) | AllocationId | Name tag | Estado |
|--------|------------------|--------------|----------|--------|
| 200300400500 Iskaypet Data | 54.229.148.90 | eipalloc-01b054ab81b75b367 | ikp-public-eip-pro (lakehouse) | **ociosa confirmada** |
| 888899990000 Digital Ecommerce | 176.34.197.121 | eipalloc-00eb8070db7c28660 | prod.blog.kiwoko.pt.eip | **ociosa confirmada** |
| 888899990000 Digital Ecommerce | 52.18.120.113 | eipalloc-056ec0523370b101e | prod.blog.kiwoko.pt.new.eip | **ociosa confirmada** |
| 888899990000 Digital Ecommerce | 54.228.98.44 | eipalloc-08e727611160fd0e1 | prod.blog.kiwoko.es.eip | **ociosa confirmada** |
| 500600700800 Sistemas Tiendanimal | 18.200.43.123 | eipalloc-07be1bf2b7e6446d8 | (sin tag) | **ociosa confirmada** |
| 500600700800 Sistemas Tiendanimal | 3.255.71.4 | eipalloc-09bfeb9f162eb4fe3 | (sin tag) | **ociosa confirmada** |
| 500600700800 Sistemas Tiendanimal | 54.75.98.5 | eipalloc-0f7a5ff2b35d913e8 | (sin tag) | **ociosa confirmada** |

- **Concordancia con el CUR (Registro 10.1):** las cuentas con IPv4 idle en mayo eran Digital
  Ecommerce (~3), Sistemas Tiendanimal (~3), Iskaypet Data (~2), infra (~1) y trazas (~0) en SAP/EKS
  Prod/EKS Dev. La foto viva del 2026-06-23 confirma **exactamente** las 3 cuentas dominantes
  (Digital Ecommerce 3, Sistemas Tiendanimal 3, Iskaypet Data 1). En `infra`, `sap`, `eks-prd` y
  `eks-dev` **todas las EIP están ahora asociadas** (las trazas idle de mayo se resolvieron — drift
  esperado, Req 7.6). Las EIP idle de Digital Ecommerce son antiguos blogs Kiwoko (PT/ES)
  desmantelados; el `.new` sugiere una migración que dejó la IP vieja sin liberar.
- **estado = `confirmado` (ocioso)** para las 7. Son candidatas a Garantizado (Tarea 10.3) salvo que
  una reserva deliberada de IP (allowlist de terceros) justifique su retención — a validar con owner.

## C) Conexiones VPN IPsec — `describe-vpn-connections`

**Resultado: 20 conexiones VPN `available` (`ipsec.1`): infra 17 (todas vía Transit Gateway
`tgw-055a93679409b99f6`), y 1 en cada una de eks-dev, sistemas-tiendanimal e iskaypet-data (vía
Virtual Private Gateway).** Coincide con los ~19–20 connection-months del Registro 10.1.

> **Aclaración de unidad (corrige nomenclatura del Registro 10.1):** AWS factura
> `EU-VPN-Usage-Hours:ipsec.1` **por conexión-hora**, no por túnel. Lo que el Registro 10.1 llamó
> "túneles-mes" son en realidad **connection-months** (cada conexión VPN tiene siempre 2 túneles por
> diseño HA). 14 136 h ÷ 744 ≈ 19 conexiones-mes; la foto viva muestra 20 conexiones (drift +1).

**Estado de túneles.** El patrón **1 túnel UP / 1 DOWN es el comportamiento HA normal** de AWS VPN
(solo un túnel activo a la vez) → NO indica ociosidad. Lo relevante es la VPN con **ambos túneles
DOWN**, que es **candidata a revisión** (puede ser backup/DR, lado on-prem caído, o sitio retirado).
Por Req 14.4 una VPN de backup/DR **se excluye con motivo** y NO es Garantizado sin confirmación del
owner. Candidatas con ambos túneles DOWN en la ventana de verificación:

| Cuenta | VPN id | Name | Túnel A | Túnel B | Veredicto |
|--------|--------|------|---------|---------|-----------|
| 300400500600 infra | vpn-07bf45e7b2b258a1c | prod.retail.arrabida.gw | DOWN | DOWN | candidata a revisión (tienda PT) |
| 300400500600 infra | vpn-03f042c159d4d132e | prod.retail.seixalriosul.vpn | DOWN | DOWN | candidata a revisión (tienda PT) |
| 300400500600 infra | vpn-03cd93b7dc5125e45 | prod.tier1.vpn | DOWN | DOWN | candidata a revisión (integración) |
| 300400500600 infra | vpn-0722e7ce2901a46fe | prod.nkt.vpn | DOWN | DOWN | candidata a revisión (integración) |
| 300400500600 infra | vpn-0b4b0da35feb30921 | prod.retailnossoshopping.vpn | DOWN | DOWN | candidata a revisión (tienda PT) |
| 111122223333 EKS Dev | vpn-0b9e3bf73ddfef303 | prod.viseo.omkiner.eks.ipsec | DOWN | DOWN | candidata a revisión (no-prod EKS dev) |
| 500600700800 Sistemas Tiendanimal | vpn-083a90fab50196b06 | AWS-SistemasTA | DOWN | DOWN | candidata a revisión (sin tags) |
| 200300400500 Iskaypet Data | vpn-01cf39dd7c94a7f12 | prod.data.ipsec.vpn | DOWN | DOWN | candidata a revisión |

- Las 12 VPN restantes de `infra` tienen ≥1 túnel UP → tráfico/standby activo (tiendas PT y
  partners: atlanticpark, senora, loures, oitava, mondego, maia, campo, aquaroma, gxo, viseo.new,
  navision/azure, etc.) → **en uso**.
- **estado = `confirmado` (existencia y características)** para las 20; las 8 con ambos túneles DOWN
  quedan marcadas como **candidatas a revisión por owner** (posible backup/DR o sitio retirado). La
  decisión Garantizado/Estimado/excluido (con motivo, Req 14.4) es de la Tarea 10.3. **motivo de no
  cierre automático:** un túnel DOWN no implica desperdicio (HA/standby/DR), requiere confirmación.

## D) VPC endpoints — `describe-vpc-endpoints`

**Resultado: 17 VPC endpoints `available` en 3 cuentas.** Solo los **Interface** generan
`EU-VpcEndpoint-Hours` (por endpoint·AZ); los **Gateway** (S3, DynamoDB) son **gratuitos**.

| Cuenta | Endpoint id | Tipo | Servicio | AZs | Nota |
|--------|-------------|------|----------|-----|------|
| 200300400500 Iskaypet Data | vpce-00dd694fd768d3ca7 | Gateway | s3 | — | gratuito (1 ruta) |
| 200300400500 Iskaypet Data | vpce-0c0474521dba03bc6 | Gateway | dynamodb | — | gratuito (1 ruta) |
| 200300400500 Iskaypet Data | vpce-0f612bdb80fab5185 | Interface | glue | 2 | en uso |
| 200300400500 Iskaypet Data | vpce-065df41ea72130de3 | Interface | sagemaker.api | 2 | en uso |
| 200300400500 Iskaypet Data | vpce-03452b9982ee5192d | Interface | sagemaker.runtime | 2 | en uso |
| 100200300400 Data desarrollo | vpce-0c23c267b664de72a | Gateway | s3 | — | gratuito |
| 100200300400 Data desarrollo | vpce-0cbaaed3f73a9838d | Gateway | dynamodb | — | gratuito |
| 100200300400 Data desarrollo | vpce-0dde94dd6b2f20355 | Interface | glue | 2 | en uso |
| 100200300400 Data desarrollo | vpce-07404982a271d4168 | Interface | sagemaker.runtime | 2 | en uso |
| 100200300400 Data desarrollo | vpce-0cc411c65aea26587 | Interface | sagemaker.api | 2 | en uso |
| 111222333444 Digital Prod | vpce-020a0442a30405491 | Interface | dms | 2 | en uso |
| 111222333444 Digital Prod | vpce-0b4a5d127fdf01182 | Interface | elasticache svc-...293e1d | 2 | en uso |
| 111222333444 Digital Prod | vpce-07b567cbf8e936b76 | Interface | elasticache svc-...46e | 2 | en uso |
| 111222333444 Digital Prod | vpce-00c6b6e88bef794d8 | Interface | elasticache **svc-0fabaa0808d0d0127** | 2 | **DUPLICADO** ↓ |
| 111222333444 Digital Prod | vpce-097cb527f78f07666 | Interface | elasticache **svc-0fabaa0808d0d0127** | 2 | **DUPLICADO** ↑ |
| 111222333444 Digital Prod | vpce-0d4e2dd239b12ebc1 | Interface | elasticache svc-...750 | 2 | en uso |
| 111222333444 Digital Prod | vpce-05df5e3604951b3b1 | Interface | elasticache svc-...3b9 | 2 | en uso |

- **DUPLICADO confirmado (candidato a eliminación):** en Digital Prod (111222333444),
  `vpce-00c6b6e88bef794d8` y `vpce-097cb527f78f07666` apuntan al **mismo servicio**
  `com.amazonaws.elasticache.serverless.eu-west-1.vpce-svc-0fabaa0808d0d0127` en las **mismas dos
  subredes**. Uno de los dos es redundante → 1 Interface endpoint (×2 AZ) eliminable. Coste modesto
  (Digital Prod aporta solo 15,06 USD/mes de VPC endpoint en el Registro 10.1), pero es desperdicio
  neto verificado → candidato Garantizado/Estimado en la Tarea 10.3 (sujeto a confirmar que ninguna
  app referencia el id concreto a eliminar).
- **Redundancia por AZ intencionada (no desperdicio):** todos los Interface endpoints están
  desplegados en **2 AZs** = alta disponibilidad estándar (Req 14.4). No se contabiliza como ahorro.
- **Drift vs CUR (Req 7.6):** la foto viva tiene **13 Interface endpoints (26 endpoint·AZ)** frente
  a los ~46,8 endpoint·AZ-mes del CUR de mayo (~23 interface endpoints). La diferencia se explica por
  **decommission de endpoints** (probablemente SageMaker/Glue de los entornos data) entre el
  Mes_Referencia y la verificación. Esperado; las cifras siguen ancladas al `Dataset_Congelado`.
- **estado = `confirmado`** para los 17; el par duplicado de Digital Prod marcado como
  **candidato a eliminación** (1 endpoint redundante).

---

## Resumen de la Verificacion_Recurso_Vivo (entrada para la Tarea 10.3)

| Categoría | Verificado en vivo | Confirmado ocioso/duplicado (candidato a ahorro) | Confirmado necesario / redundancia intencionada |
|-----------|--------------------|--------------------------------------------------|--------------------------------------------------|
| **NAT Gateway** | 16 (todos available + EIP + ruta) | **0** | 16 (egress en uso; pares = HA por AZ / por VPC) |
| **EIP / IPv4** | 7 cuentas | **7 EIP ociosas** (Iskaypet Data 1, Digital Ecommerce 3, Sistemas Tiendanimal 3) → **candidato Garantizado** | resto asociadas |
| **VPN IPsec** | 20 conexiones | **8 con ambos túneles DOWN** → candidatas a revisión por owner (posible backup/DR, Req 14.4) | 12 con ≥1 túnel UP (en uso) |
| **VPC endpoint** | 17 (13 Interface + 4 Gateway gratis) | **1 Interface duplicado** en Digital Prod (svc-0fabaa0808d0d0127) → candidato | resto en uso; doble AZ = HA intencionada |

**Conclusiones para la clasificación (Tarea 10.3, Req 14.3–14.5):**
1. **NAT** → íntegramente **necesario** (16/16 con egress real). Cualquier ahorro sería por rediseño
   de redundancia en no-prod → **Estimado**, no Garantizado.
2. **EIP ociosas (7)** → desperdicio puro confirmado en vivo → **Ahorro_Garantizado** (sujeto a la
   regla de frescura ≤30 días, Req 3.2; verificación del 2026-06-23 vigente).
3. **VPN con ambos túneles DOWN (8)** → **no se contabilizan como Garantizado**; requieren
   confirmación de función (backup/DR/sitio retirado). Exclusión con motivo o Estimado según owner.
4. **VPC endpoint duplicado (1)** → desperdicio neto verificado → candidato Garantizado/Estimado
   (coste modesto), tras confirmar que ningún consumidor referencia el id a eliminar.

### Sub-registro (esquema `verificacion_vivo` del design.md)

| Campo | Valor |
|-------|-------|
| `comando` | `aws ec2 describe-nat-gateways` · `describe-addresses` · `describe-vpn-connections` · `describe-vpc-endpoints` · `describe-route-tables --filters Name=route.nat-gateway-id` (todos `--region eu-west-1`, perfiles SSO SRE por cuenta; credenciales por nombre de perfil, no incrustadas) |
| `cuenta` | 13 cuentas (333344445555, 300400500600, 111122223333, 444455556666, 222233334444, 200300400500, 100200300400, 666777888999, 400500600700, 222333444555, 888899990000, 500600700800, 111222333444) |
| `region` | `eu-west-1` |
| `fecha_hora_utc` | `2026-06-23T08:59:29Z`–`2026-06-23T09:06Z` |
| `estado` | `confirmado` (NAT 16/16 en uso; 7 EIP ociosas; 1 VPC endpoint duplicado; 20 VPN existentes con 8 candidatas a revisión). **0 cuentas `no_verificable`** (todas con rol de lectura SSO activo). |
| `motivo` | NAT: ninguno ocioso (todos con ruta) → necesario (Req 14.3). VPN con ambos túneles DOWN: no se cierran como desperdicio sin confirmar backup/DR (Req 14.4). VPC endpoints en doble AZ: redundancia intencionada (Req 14.4). |


---

# Registro 10.3 — Fórmula, clasificación mixta y documentación de la Palanca 8 (Red)

> **Tarea 10.3** — _Requirements: 14.3, 14.4, 14.5, 3.1, 3.4, 4.1, 4.4–4.7_. Aplica la fórmula de la
> Palanca 8 sobre las cifras congeladas del **Registro 10.1** (CUR, `frozen-2026-05@2026-06-23`) y la
> **Verificacion_Recurso_Vivo** del **Sub-registro 10.2** (`2026-06-23`, solo lectura), produce la
> clasificación **mixta** (Garantizado cifra única / Estimado rango), excluye con motivo lo necesario
> y documenta los campos obligatorios de Palanca (Req 4). **No re-ejecuta consultas CUR** (reusa las
> cifras ancladas de la 10.1) y **no muta recursos** (reusa la verificación de la 10.2).

**Validates: Requirements 14.3, 14.4, 14.5, 3.1, 3.4, 4.1, 4.4, 4.5, 4.6, 4.7**

## A) Fórmula y supuesto de la Palanca (Req 14.3, 14.4, 14.5)

La Palanca 8 es **mixta** y por tanto se **divide en Sub_Palancas** (Req 3.4): la parte de
desperdicio puro confirmado en vivo es **Ahorro_Garantizado** (cifra única) y la parte sujeta a
rediseño o a confirmación de owner es **Ahorro_Estimado** (rango). La fórmula que aplica el filtro
necesario/desperdicio es:

```
Ahorro_red = Σ (coste de recursos de red CONFIRMADOS ociosos/duplicados en vivo,
                que NO cumplen función necesaria)
           − (todo lo necesario: NAT con egress real, redundancia HA por AZ, VPN de backup/DR)
```

Reglas de filtrado aplicadas (entradas del Registro 10.1 + Sub-registro 10.2):

1. **NAT con egress a subredes privadas en uso → necesario (Req 14.3).** Los **16/16 NAT** están
   `available`, con EIP, y **referenciados por al menos una route table** (egress real). Ninguno
   ocioso ni duplicado → **0 USD de desperdicio NAT directo**. No entran en Garantizado.
2. **Redundancia intencionada → excluida con motivo (Req 14.4).** Los pares de NAT por AZ (EKS
   Prod/Dev/UAT/Tooling) y la doble-AZ de todos los Interface VPC endpoints son **alta
   disponibilidad estándar**; no se contabilizan como ahorro.
3. **VPN de backup/DR → excluida con motivo (Req 14.4).** Una VPN con ambos túneles DOWN **no
   implica desperdicio** (puede ser backup/DR, lado on-prem caído o sitio retirado). No es
   Garantizado sin confirmación de owner.
4. **IPv4 ociosa + recursos confirmados ociosos → Garantizado (Req 14.5).** Las **7 EIP sin
   asociación** (CUR `IdleAddress` = 30,82 USD/mes) y el **VPC endpoint duplicado** confirmado en
   vivo son desperdicio puro eliminable sin pérdida de capacidad → **Ahorro_Garantizado**.
5. **Reducción sujeta a rediseño / a revisión → Estimado (rango).** Colapsar redundancia de NAT en
   no-prod (rediseño de routing/HA) y retirar VPN confirmadas muertas (tras owner) son
   oportunidades **sujetas a supuestos** → **Ahorro_Estimado**, nunca cifra única.

---

## B) Sub-Palanca 8a — Ahorro_Garantizado (cifra única) · Req 14.5, 3.1, 3.2

**Desperdicio puro confirmado en vivo, eliminable sin pérdida de capacidad.** Se expresa como
**cifra única** (Req 3.1) y cumple la frescura de la `Verificacion_Recurso_Vivo` ≤ 30 días
(verificación `2026-06-23`, dentro de ventana respecto a la publicación del Informe — Req 3.2).

| Componente | Recursos confirmados (Sub-registro 10.2) | Base de la cifra | USD/mes |
|------------|------------------------------------------|------------------|--------:|
| **IPv4 ociosa** | **7 EIP** sin `AssociationId` (Iskaypet Data 1, Digital Ecommerce 3, Sistemas Tiendanimal 3) | CUR `EU-PublicIPv4:IdleAddress` (Registro 10.1, directo) | **30,82** |
| **VPC endpoint duplicado** | 1 Interface endpoint redundante en Digital Prod (`vpce-097cb527f78f07666` ó `vpce-00c6b6e88bef794d8`, ambos a `vpce-svc-0fabaa0808d0d0127`, mismas 2 subredes) → eliminar 1 (×2 AZ) deja la HA intacta | precio **derivado del propio Dataset_Congelado**: `EU-VpcEndpoint-Hours` 352,42 ÷ 34 824 h = **0,010120 USD/endpoint·AZ-h**; × 744 h × 2 AZ | **15,06** |
| **Total Sub-Palanca 8a (Garantizado)** | | | **45,88** |

- **Anualizado (Req 6.3):** 45,88 × 12 = **550,56 USD/año** (IPv4 idle 369,84 + VPC endpoint dup
  180,72). ⚠️ _La anualización ×12 asume que el Mes_Referencia es representativo y no captura
  estacionalidad (Req 6.4)._
- **Nota de anclaje (honestidad de la cifra).** La parte **IPv4 idle (30,82)** está anclada
  **directamente** al CUR de mayo. La parte **VPC endpoint duplicado (15,06)** se obtiene por
  **precio unitario derivado del propio `Dataset_Congelado`** (0,010120 USD/endpoint·AZ-h)
  aplicado a la **configuración confirmada en vivo** (1 endpoint redundante × 2 AZ × 744 h), porque
  el CUR de mayo agrega todos los endpoints de Digital Prod en una sola línea (15,06 USD) y no aísla
  el id duplicado. Si dirección exige que el **piso comprometido** use solo cifras aisladas
  directamente del CUR, el Garantizado conservador de esta Palanca es **30,82 USD/mes** (solo IPv4
  idle) y el VPC endpoint duplicado se traslada a Estimado. Se documentan ambas lecturas; el
  Garantizado por defecto de esta Palanca es **45,88 USD/mes**.

---

## C) Sub-Palanca 8b — Ahorro_Estimado (rango) · NAT: rediseño de redundancia en no-prod

**Sujeto a rediseño** (Req 14.3 cierra el desperdicio directo de NAT a 0; cualquier ahorro adicional
es por reducir redundancia HA en entornos no productivos). Se expresa **como rango** cumpliendo
`0 < Rango_Conservador ≤ Rango_Agresivo` (Req 3.3), **nunca cifra única**.

- **Unidad de coste (derivada del Dataset_Congelado):** `EU-NatGateway-Hours` 525,68 ÷ 11 904 h =
  **0,044161 USD/NAT-h** → **32,86 USD/NAT-mes** (solo horas; los **bytes procesados NO se ahorran**:
  el egress sigue fluyendo por el NAT superviviente).
- **Candidatos:** 1 NAT colapsable por cuenta no-prod con par HA → **EKS Tooling, EKS UAT, EKS Dev**.
- **Rango_Conservador:** colapsar **2** pares no-prod (Tooling + UAT) = 2 × 32,86 = **65,71 USD/mes**
  → ×12 = **788,52 USD/año**.
- **Rango_Agresivo:** colapsar **3** pares no-prod (Tooling + UAT + Dev) = 3 × 32,86 = **98,57 USD/mes**
  → ×12 = **1 182,84 USD/año**.

⚠️ _Anualización ×12: asume Mes_Referencia representativo, no capta estacionalidad (Req 6.4)._
**Trade-off (por lo que es Estimado y no Garantizado):** eliminar un NAT por AZ **reduce la HA** y
**aumenta el transfer cross-AZ** (workloads de la AZ huérfana enrutan al NAT superviviente,
~0,01 USD/GB cada sentido), reduciendo el ahorro neto. **Excluido de prod** (Prod/infra/Retail/SAP/
Ecommerce mantienen su redundancia por riesgo).

---

## D) Sub-Palanca 8c — Ahorro_Estimado (rango) CONTINGENTE · VPN candidatas a revisión

**Excluido del ahorro contabilizado hasta confirmación de owner (Req 14.4).** Las **8 VPN con ambos
túneles DOWN** (Sub-registro 10.2.C) son **candidatas a revisión**, no desperdicio confirmado: por
Req 14.4 una VPN de **backup/DR se excluye con motivo**. Se cuantifica la oportunidad **solo como
ilustración Estimado**, marcada **no comprometible** hasta que el owner clasifique cada VPN como
*retirada* (elegible) vs *backup/DR/tienda intermitente* (excluida).

- **Unidad de coste (derivada del Dataset_Congelado):** `EU-VPN-Usage-Hours:ipsec.1` 650,26 ÷
  14 136 h = **0,046001 USD/conexión-h** → **34,22 USD/conexión-mes**.
- **Rango_Conservador:** solo las **2** sin función productiva aparente (EKS Dev `viseo.omkiner` no-prod
  + Sistemas Tiendanimal `AWS-SistemasTA` sin tags) = 2 × 34,22 = **68,44 USD/mes** → ×12 = **821,28 USD/año**.
- **Rango_Agresivo:** las **8** candidatas retiradas = 8 × 34,22 = **273,76 USD/mes** → ×12 = **3 285,12 USD/año**.

⚠️ _Anualización ×12: asume Mes_Referencia representativo, no capta estacionalidad (Req 6.4)._
**Motivo de exclusión del objetivo comprometido (Req 14.4, 5.3):** un túnel DOWN ≠ desperdicio
(HA/standby/DR/sitio temporalmente caído). 5 de las 8 son VPN de **tiendas PT / integraciones**
(arrabida, seixalriosul, nossoshopping, tier1, nkt) que pueden ser backup/DR o reconectarse. **No se
contabilizan** en el total de ahorro hasta confirmación de owner.

---

## E) Exclusiones con motivo (Req 14.3, 14.4) — registro explícito

| Recurso | Cifra/mes implicada | Motivo de exclusión | Req |
|---------|--------------------:|---------------------|-----|
| **16 NAT Gateways** (egress real) | 1 503,28 (todo el NAT) | NAT con egress a subredes privadas **en uso** → **necesario**; 0 ociosos/duplicados | 14.3 |
| **Redundancia NAT por AZ** (prod/infra) | incluida arriba | Alta disponibilidad **intencionada**; colapsar = rediseño (→ Estimado solo en no-prod, Sub-Palanca 8b) | 14.4 |
| **Doble-AZ de VPC endpoints Interface** | incluida en 352,77 | Redundancia por AZ **intencionada** (HA estándar) | 14.4 |
| **12 VPN con ≥1 túnel UP** | parte de 650,26 | Tráfico/standby **activo** (tiendas PT/partners) → en uso | 14.4 |
| **8 VPN ambos túneles DOWN** | ~273,76 (8×34,22) | **Candidatas a revisión**: posible backup/DR/sitio retirado → exclusión del objetivo hasta owner (Estimado contingente, Sub-Palanca 8c) | 14.4 |

---

## F) Documentación obligatoria de la Palanca (Req 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7)

| Campo (Req) | Sub-Palanca 8a (Garantizado) | Sub-Palanca 8b (Estimado · NAT) | Sub-Palanca 8c (Estimado · VPN, contingente) |
|-------------|------------------------------|---------------------------------|----------------------------------------------|
| **Clasificación** (3.1) | **Ahorro_Garantizado** (cifra única) | **Ahorro_Estimado** (rango) | **Ahorro_Estimado** (rango) — **no comprometible** sin owner |
| **Supuesto de reducción %** (4.1) | **100,0%** (eliminación total del recurso confirmado ocioso/duplicado) | **12,5%–18,8%** del coste de NAT-horas (2–3 de 16 NAT-mes) | **10,5%–42,1%** del coste VPN (2–8 de 19 conexiones-mes) |
| **% direccionable + coste base afectado USD** (4.2) | IPv4 idle **100,0%** de 30,82 + VPC endpoint dup **100,0%** de 15,06; sobre coste base de red **1,6%** de **2 843,02** | **2,3%–3,5%** de la base de red **2 843,02** (coste NAT-horas afectado 525,68) | **2,4%–9,6%** de la base de red **2 843,02** (coste VPN afectado 650,26) |
| **Origen del supuesto + fecha** (4.3) | **Precio público AWS** = precio efectivo del `Dataset_Congelado` `frozen-2026-05@2026-06-23` (sin descuento material; unblended ≡ net). Fecha del dato: **2026-06-23** | ídem (0,044161 USD/NAT-h derivado del dataset). Fecha **2026-06-23** | ídem (0,046001 USD/conexión-h derivado del dataset). Fecha **2026-06-23** |
| **Riesgo** (4.4) | **bajo** (liberar EIP sin asociar / borrar 1 de 2 endpoints idénticos; reversible). Verificar que ninguna allowlist de terceros fije la IP y que ningún consumidor referencie el id concreto a eliminar | **medio-alto** (pérdida de HA por AZ + transfer cross-AZ; requiere rediseño de routing) | **medio** (confirmar backup/DR vs retirada; eliminar una VPN de DR sería **alto**) |
| **Esfuerzo** (4.5) | **bajo** (`release-address` + borrar VPC endpoint; reversible re-creando) | **alto** (rediseño de subredes/route tables, validación de tráfico) | **medio** (coordinación con owners de tiendas PT / Sistemas TA / Data) |
| **Owner** (4.6, 4.7) | **pendiente (SRE)** — EIP: Iskaypet Data, Digital Ecommerce, Sistemas Tiendanimal; VPC endpoint: Digital Prod | **pendiente (SRE)** | **pendiente** — transversal: SRE infra + dueños tiendas PT + Sistemas Tiendanimal + Data |

> Campos no evaluables registrados como **"pendiente"** en lugar de omitirse (Req 4.7): todos los
> owners (sin correo concreto asignado todavía).

---

## G) Resumen de clasificación de la Palanca 8 (entrada para el Informe, Req 3.6, 6.6)

| Sub-Palanca | Clasificación | Mensual (USD) | Anual ×12 (USD) | Estado |
|-------------|---------------|--------------:|----------------:|--------|
| **8a — IPv4 idle + VPC endpoint duplicado** | **Garantizado** (cifra única) | **45,88** | **550,56** | Verificado en vivo `2026-06-23`, frescura ≤30 d (Req 3.2) |
| **8b — NAT: rediseño redundancia no-prod** | **Estimado** (rango) | **65,71 – 98,57** | **788,52 – 1 182,84** | Sujeto a rediseño; trade-off HA/cross-AZ |
| **8c — VPN candidatas a revisión** | **Estimado** (rango) **contingente** | **68,44 – 273,76** | **821,28 – 3 285,12** | **Excluido del objetivo** hasta confirmación de owner (Req 14.4) |

- **Total Garantizado de la Palanca 8:** **45,88 USD/mes** (550,56 USD/año). _Piso conservador
  alternativo (solo cifras aisladas directamente del CUR): 30,82 USD/mes._
- **Total Estimado comprometible de la Palanca 8 (solo 8b, NAT con rediseño):** rango **65,71 –
  98,57 USD/mes**. La Sub-Palanca 8c (VPN) **no** entra en el objetivo comprometido hasta owner.
- Conforme al modelo de objetivo comprometido del diseño, la Sub-Palanca 8b es **Estimado sin
  Barrido_Utilizacion específico**, por lo que su Rango_Conservador entra en el objetivo
  comprometido **solo si** dirección lo acepta como rediseño aprobado; en caso contrario se reporta
  como oportunidad Estimado fuera del piso comprometido.

---

## Registro de evidencia (esquema completo del Catálogo_Evidencias — Req 2.1, 2.3, 2.4)

### Registro 10.3a — Garantizado (IPv4 idle + VPC endpoint duplicado)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-10.3a-red-garantizado-2026-05` |
| `cifra_publicada` | **45,88 USD/mes** (Garantizado, cifra única) = IPv4 idle **30,82** + VPC endpoint duplicado **15,06**. Anualizado ×12 = **550,56 USD/año** |
| `descripcion` | Desperdicio de red puro confirmado en vivo y eliminable sin pérdida de capacidad: 7 EIP ociosas (sin `AssociationId`) + 1 Interface VPC endpoint duplicado en Digital Prod (×2 AZ) |
| `consulta_cur` | IPv4 idle: Q1/Q3 del Registro 10.1 (`EU-PublicIPv4:IdleAddress` = 30,82). VPC endpoint dup: **derivada** — precio unitario `EU-VpcEndpoint-Hours` 352,42 ÷ 34 824 h = 0,010120 USD/endpoint·AZ-h × 744 h × 2 AZ = 15,06 (no aislable directamente del CUR de mayo, que agrega todos los endpoints de Digital Prod) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:33:52Z` (UTC) — CUR; verificación en vivo `2026-06-23T08:59:29Z`–`09:06Z` (UTC) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | EIP: `eipalloc-01b054ab81b75b367`, `eipalloc-00eb8070db7c28660`, `eipalloc-056ec0523370b101e`, `eipalloc-08e727611160fd0e1`, `eipalloc-07be1bf2b7e6446d8`, `eipalloc-09bfeb9f162eb4fe3`, `eipalloc-0f7a5ff2b35d913e8`. VPC endpoint duplicado (eliminar uno): `vpce-097cb527f78f07666` ó `vpce-00c6b6e88bef794d8` (svc `vpce-svc-0fabaa0808d0d0127`, cuenta 111222333444) |
| `dimension_agregacion` | IPv4 idle: `SUM(line_item_unblended_cost)` sobre `EU-PublicIPv4:IdleAddress` (7 cuentas). VPC endpoint dup: precio unitario × unidades verificadas en vivo (1 endpoint × 2 AZ × 744 h) |
| `verificacion_vivo` | `confirmado` — 7 EIP sin asociación (`describe-addresses`) + par duplicado (`describe-vpc-endpoints`); ver Sub-registro 10.2.B y 10.2.D |
| `clasificacion` | `garantizado` |

### Registro 10.3b — Estimado (NAT rediseño no-prod)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-10.3b-red-estimado-nat-2026-05` |
| `cifra_publicada` | Rango **65,71 – 98,57 USD/mes** (×12 = **788,52 – 1 182,84 USD/año**). `0 < 65,71 ≤ 98,57` ✓ |
| `descripcion` | Ahorro estimado por colapsar 2–3 pares NAT redundantes en cuentas EKS no productivas (Tooling/UAT/Dev); solo NAT-horas (los bytes procesados no se ahorran) |
| `consulta_cur` | Derivada del Registro 10.1: `EU-NatGateway-Hours` 525,68 ÷ 11 904 h = 0,044161 USD/NAT-h × 744 h × {2,3} NAT |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:33:52Z` (UTC) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | NAT no-prod colapsables: EKS Tooling `nat-04f7fa4df45268aa9`/`nat-0310e34fbe496a7bf`, EKS UAT `nat-066d86c7719d56582`/`nat-0662646227ecb8c11`, EKS Dev `nat-029a1b12a3ae8a7c7`/`nat-014934a8caceff8fb` (se elimina 1 de cada par) |
| `dimension_agregacion` | Precio unitario NAT-hora × NAT-meses colapsados (rango 2–3) |
| `verificacion_vivo` | `confirmado` (16/16 NAT en uso; redundancia por AZ) — Sub-registro 10.2.A. La reducción es **rediseño**, no desperdicio |
| `clasificacion` | `estimado` |

### Registro 10.3c — Estimado contingente (VPN candidatas a revisión)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-10.3c-red-estimado-vpn-2026-05` |
| `cifra_publicada` | Rango **68,44 – 273,76 USD/mes** (×12 = **821,28 – 3 285,12 USD/año**), `0 < 68,44 ≤ 273,76` ✓. **No contabilizado en el objetivo** hasta confirmación de owner (Req 14.4) |
| `descripcion` | Oportunidad ilustrativa por retirar VPN con ambos túneles DOWN, contingente a que el owner las clasifique como retiradas (elegibles) vs backup/DR/intermitentes (excluidas) |
| `consulta_cur` | Derivada del Registro 10.1: `EU-VPN-Usage-Hours:ipsec.1` 650,26 ÷ 14 136 h = 0,046001 USD/conexión-h × 744 h × {2,8} conexiones |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:33:52Z` (UTC) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `vpn-07bf45e7b2b258a1c`, `vpn-03f042c159d4d132e`, `vpn-03cd93b7dc5125e45`, `vpn-0722e7ce2901a46fe`, `vpn-0b4b0da35feb30921` (infra), `vpn-0b9e3bf73ddfef303` (EKS Dev), `vpn-083a90fab50196b06` (Sistemas TA), `vpn-01cf39dd7c94a7f12` (Iskaypet Data) |
| `dimension_agregacion` | Precio unitario conexión-hora × conexiones retiradas (rango 2–8) |
| `verificacion_vivo` | `excluido` (del Garantizado) — 8 VPN con ambos túneles DOWN; **motivo:** un túnel DOWN no implica desperdicio (HA/standby/DR); requiere confirmación de owner (Req 14.4, 5.3). Sub-registro 10.2.C |
| `clasificacion` | `estimado` (contingente, fuera del objetivo comprometido) |

---

## Estado de ejecución (Tarea 10.3)

- ✅ **Completada.** Fórmula aplicada sobre cifras congeladas (Registro 10.1) + verificación en vivo
  (Sub-registro 10.2), sin re-ejecutar CUR ni mutar recursos.
- **Clasificación mixta** (Req 3.4): Garantizado **45,88 USD/mes** (cifra única) · Estimado NAT
  **65,71–98,57 USD/mes** (rango) · Estimado VPN **68,44–273,76 USD/mes** (rango, contingente,
  excluido del objetivo por Req 14.4).
- **Exclusiones con motivo** registradas (Req 14.3/14.4): 16 NAT necesarios, redundancia HA por AZ,
  12 VPN con ≥1 túnel UP, 8 VPN DOWN candidatas a revisión.
- **Documentación de Palanca (Req 4.1–4.7)** completa; owners marcados **"pendiente"** (Req 4.7).
- 3 registros de evidencia (`EV-10.3a/b/c`) con el esquema completo del Catálogo_Evidencias.
- ⏭️ **Siguiente:** asignar owners (correo) y, para 8b, decidir si el Rango_Conservador entra en el
  objetivo comprometido como rediseño aprobado; para 8c, recoger la clasificación de cada VPN por su
  owner antes de contabilizar.
