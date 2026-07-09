# Informe — Anexo de evidencias (Catálogo_Evidencias consolidado)

> **Tarea 19.3** del Estudio FinOps de Ahorro AWS. Tercera sección del Informe (tras el resumen
> ejecutivo y la tabla por Palanca). Es el **índice maestro** del `Catálogo_Evidencias` completo:
> por cada cifra publicada en el Informe, su `id_evidencia`, descripción, consulta CUR (o "no
> aplica" justificado), Mes_Referencia, fecha de extracción con zona horaria, versión del
> `Dataset_Congelado`, recurso(s) o "no atribuible a recurso", el sub-registro de
> `Verificacion_Recurso_Vivo` cuando aplica, y el/los `QueryExecutionId`.
>
> **Validates: Requirements 19.1, 2.1, 2.2, 2.3, 2.4, 2.5, 5.5**
>
> **Naturaleza del documento.** Este anexo **consolida y referencia**, no duplica. El contenido
> íntegro de cada registro (consultas SQL exactas, tablas por recurso, resultados congelados, salida
> de los comandos `describe/list/get`) vive en su **fichero fuente** (`catalogo-evidencias.md` y
> `evidencias/*.md`), que está **congelado**. Este anexo recorre ese corpus, resume cada registro y
> apunta a su fichero fuente, y **resuelve** las dos acciones que la auditoría 17.2 (Property 2/3)
> dejó para la fase de ensamblado: **H1** (cita canónica única del Marketplace) y **H2** (registro
> propio de las tres cifras agregadas del resumen ejecutivo). **No** modifica ningún fichero fuente.

---

## 1. Parámetros comunes del `Dataset_Congelado`

Todos los registros comparten el anclaje siguiente (Req 2.5); por eso el índice maestro **no** repite
estas columnas y solo lista la `fecha_extraccion` propia de cada registro.

| Campo común | Valor |
|-------------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` (2 decimales, half-up, sumando antes de redondear — Req 6.7) |
| Motor / DB / tabla | Amazon Athena (CUR 2.0) · `athenacurcfn_finnops` / `data` · `eu-west-1` |
| Cuenta CUR / rol | `600700800900` (root-iskaypet) · `Cur-AWSS3CURLambdaExecutor` (perfil `root-iskaypet`) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |
| Filtro temporal canónico | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND < TIMESTAMP '2026-06-01 00:00:00'` |

## 2. Convenciones de lectura del índice (capas de registro)

El corpus es **en capas** (taxonomía fijada por la auditoría 17.2). Distinguirlas es lo que permite
leer la biyección cifra↔evidencia correctamente:

- **Capa A — cifra base / de ahorro.** Importe USD que entra en la línea base, en la tabla por
  Palanca o en el resumen. Sujeta a la biyección 1-a-1 (Property 2).
- **Capa B — sub-registro de `Verificacion_Recurso_Vivo`.** Estado `confirmado` / `excluido` /
  `no_verificable` de un recurso (solo lectura `describe/list/get`); es el campo `verificacion_vivo`
  **anidado** de un registro de capa A, no una cifra independiente. Lleva el sub-esquema del Req 5.5
  (`comando`, `cuenta`, `region`, `fecha_hora_utc`, `estado`, `motivo`).
- **Capa C — control / auditoría.** Resultado de una Correctness Property (completitud, conservación,
  biyección). `clasificacion` metodológica (`fuera_alcance` / `auditoria`); referencia cifras, no las
  introduce.
- **Capa D — barrido.** Veredicto de gating (CONFIRMADO / PARCIAL / PENDIENTE) que habilita o no
  elevar una cifra de capa A a objetivo comprometido (Req 18). Referencia la cifra de la Palanca.

Convención de `consulta_cur`: las cifras **derivadas** (por suma o por transformación de una base ya
congelada) y las verificadas en vivo llevan `consulta_cur = "no aplica"` **justificado**, conforme al
esquema del `design.md` ("Sí, o 'no aplica' si es derivada"). Las marcas temporales incluyen zona
horaria (`Z` UTC y/o `+02:00` CEST) en el 100 % de los registros.

---

## 3. Índice maestro de evidencias

### 3.0 Fundación — línea base contable (`catalogo-evidencias.md`)

| `id_evidencia` | Descripción | Cifra publicada (USD) | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` · `QueryExecutionId` |
|----------------|-------------|----------------------|----------------|-----------|:-----------:|------------------------------------------|
| `E1.1-TOTAL` | Total organización (bruto/neto) | 148 553,36 / 148 553,36 | Consulta 1 (total org) | no atribuible | — | `2026-06-23T07:55:14Z` · QEID no retenido (reproducible) |
| `E1.1-INFRA` | Infra AWS (Usage, excl. marketplace) — denominador técnico | 48 320,13 bruto / 44 484,97 neto | Consulta 2 (`charge_group=infra_aws`) | no atribuible | — | `2026-06-23T07:55:14Z` |
| `E1.1-MKT-CONTRACT` | Contrato Marketplace (Fee) — **Palanca_Comercial** · **cargo PUNTUAL/prepago (no recurrente, no ×12)** · **fuente canónica (H1)** | 85 000,55 (puntual) | Consulta 2 (`marketplace_contract`) | — | — | `2026-06-23T07:55:14Z` |
| `E1.1-PAYG` | PAYG mismo producto Marketplace — tier mal dimensionado · **fuente canónica (H1)** | 6 663,33 | Consulta 2 (`marketplace_payg`) | — | — | `2026-06-23T07:55:14Z` |
| `E1.1-TAX` | Tax | 9 448,99 | Consulta 2 (`tax`) | no atribuible | — | `2026-06-23T07:55:14Z` |
| `E1.1-FLATRATE` | FlatRateSubscription (Kiro) | 904,73 | Consulta 2 (`flat_rate_subscription`) | no atribuible | — | `2026-06-23T07:55:14Z` |
| `E1.1-SP-BRIDGE` | Puente Savings Plans / descuentos (cierre contable) | −1 784,38 | Consulta 2 (`sp_discounts_bridge`) | no atribuible | — | `2026-06-23T07:55:14Z` |
| `EV-1.2-completitud-2026-05` | Control de completitud del Mes_Referencia (Req 1.9) | 31/31 días = 100,0 % | `COUNT(DISTINCT date(...))` | no atribuible | `null` | `2026-06-23T09:50:50+02:00` · `7cc9f1b3-2ffc-4a67-a620-a7814c5bbf7f`, `430c4e56-e6ac-4346-858d-e83a30e64d25` |
| Registro 1.3 (desglose por cuenta) | Coste base por cuenta — 32 cuentas en alcance (30 con coste + 2 Animalis a 0) | Σ = 148 553,36 | Consulta por `account` | no atribuible (dim. cuenta) | per-cuenta (✅ 22 · ⛔ 8 · n/a 2) | `2026-06-23 07:55 UTC` · `4a73debf-45da-49de-9c55-65af6c04ad5d`, `9b133e02-9772-43af-a62f-77e40e5ba198` |
| `EV-1.4-conservacion-2026-05` | **Control Property 1** — conservación contable (Σ dentro+fuera = total CUR) | dentro 48 320,13 / fuera 100 233,22 | Consulta A/B/C (CASE 2 conjuntos) | no atribuible | `null` | derivada de `E1.1-*` (anclada) |

### 3.1 Palanca 1 — Compromiso EC2 (Savings Plans) · `evidencias/palanca-01-ec2.md`

| `id_evidencia` | Descripción | Cifra (USD) | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` · `QueryExecutionId` |
|----------------|-------------|-------------|----------------|-----------|:-----------:|------------------------------------------|
| `EV-3.1-ec2-particion-compra` | Partición de cómputo EC2 por opción de compra; cobertura SP | sp_covered 7 998,83 · on_demand 7 185,92 · spot 3,30 · cobertura 52,68 %/62,25 % | Consulta canónica `design.md` | no atribuible (dim. opción de compra) | `EV-3.2` | `2026-06-23T08:14:51Z` · `dc0cca4c-d315-4621-81c2-7004990fd67b` |
| `EV-3.1-ec2-estable-vs-burst` | Separación on-demand estable (≥90 % de 744 h) vs intermitente | estable 4 813,47 (18 rec.) · intermitente 2 372,44 (2 363 rec.) | CTE `od` por `resource_id` | no atribuible (segmento) | `EV-3.2` | `2026-06-23T08:14:51Z` · `1db44d07-1d8d-442f-9fb1-cc8198e0a16a` |
| `EV-3.2` (V1/V2/V3) | **[Capa B]** Verificación viva: cobertura SP vigente, inventario+expiración SP, familias estables | estado **confirmado** | no aplica (verif. viva) | SP `dae0756e-…` (expira 2028-04-20); familias m6i/m7i/m7a/c6a/c7a/r7i | confirmado | verif. `2026-06-23T08:49–08:51Z` (`eu-west-1`) |
| `EV-3.3-ec2-sp-ahorro` | Ahorro_Estimado por SP sobre la base estable (28 % Cons – 37 % Agr) | mensual **1 347,77 – 1 780,99** · anual 16 173,27 – 21 371,82 | no aplica (derivada de `EV-3.1-…estable`) | las 18 instancias estables | `EV-3.2` (confirmado) | derivada · clasificación **estimado** |

### 3.2 Palanca 2 — Compromiso RDS (Reserved Instances) · `evidencias/palanca-02-rds.md`

| `id_evidencia` | Descripción | Cifra (USD) | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` · `QueryExecutionId` |
|----------------|-------------|-------------|----------------|-----------|:-----------:|------------------------------------------|
| `EV-4.1-RDS-COMPUTE` | Cómputo de instancia RDS (Single+Multi-AZ) vs storage/backups; cobertura RI/SP | cómputo 6 616,31 · cobertura 0,0 % · storage 5 201,25 · backup 500,06 | Clasificación de componentes + por cuenta | no atribuible (dim. cuenta) | `EV-4.2-RDS-LIVE` | `2026-06-23T08:21:43Z` · `1970253b-…`, `67c88b8e-…`, `188eaab5-…`, `04734431-…` |
| `EV-4.1-COMMIT-ADJ` | Cobertura adyacente ElastiCache/OpenSearch/Fargate/Lambda | ElastiCache 411,22 (0 %) · Lambda 19,30 · OpenSearch/Fargate 0,00 (sin uso) | Cobertura por servicio + Fargate/OpenSearch | no atribuible (dim. producto) | no requerida | `2026-06-23T08:21:43Z` · `e2eafae9-…`, `edea3fbd-…` |
| `EV-4.2-RDS-LIVE` | **[Capa B]** Verificación viva 14 cuentas: 82 instancias `available`; cobertura RI 0 % | estado **confirmado**; hallazgo RI All Upfront eks-tooling 2× `db.t3.medium` | no aplica (verif. viva) | 82 `DBInstanceIdentifier`; RI `ri-2024-01-23-08-39-10-833` | confirmado (14/14) | verif. `2026-06-23T08:50–08:57Z` (`eu-west-1`) |
| `EV-4.3-RDS-COMMIT` | Ahorro_Estimado RDS RI sobre prod estable (34 % 1y no-upfront) | base direcc. 5 096,40 (77 %) · mensual **1 732,78 – 2 548,20** · anual 20 793,33 – 30 578,42 | no aplica (derivada de `EV-4.1`) | prod estable (retail-prod, digital-prod, …) | `EV-4.2` (confirmado) | derivada · clasificación **estimado** |

### 3.3 Palanca 3 — Extended Support de motores EOL (RDS) · `evidencias/palanca-03-extended-support.md`

| `id_evidencia` | Descripción | Cifra (USD) | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` · `QueryExecutionId` |
|----------------|-------------|-------------|----------------|-----------|:-----------:|------------------------------------------|
| `EV-5.1-extended-support-2026-05` | Coste RDS Extended Support por recurso y tramo de precio anual | bruto **1 169,52**/mes · neto 1 075,96 · 100 % Año 1–2 · anual bruto 14 034,20 | Consultas 1/2/3 | **7 ARNs RDS** (PG13: digital-prod oms+payments-api, dp-tooling, digital-dev/uat) | `EV-5.2` | `2026-06-23T08:10:33Z` · `9eb416e1-…`, `5d0b789f-…`, `c31c555e-…` |
| `EV-5.2-…-verificacion-viva` | **[Capa B]** Verificación viva 7 instancias: id/motor/versión/fin de soporte | confirmado 3/7 (PG13 prod/tooling); **drift** 4/7 (dev/uat ya en PG18.4) | no aplica (verif. viva) | 7 ARNs RDS; fin soporte PG13 `2026-02-28` | confirmado/drift | verif. `2026-06-23T08:54:09Z` (`eu-west-1`) |
| `EV-5.3-…-clasificacion` | Clasificación **Garantizado condicionado** (upgrade + compat. app); reparto por drift | **Garantizado 833,28**/mes bruto (3 inst. PG13) · anual 9 999,36 · ya capturado 336,24 | no aplica (deriva de `EV-5.1`/`EV-5.2`) | 3 ARNs PG13 prod/tooling | `EV-5.2` (confirmado) | clasificación **garantizado** (condicionado) |

### 3.4 Palanca 4 — Logs de CloudWatch y WAF · `evidencias/palanca-04-logs.md`

| `id_evidencia` | Descripción | Cifra (USD) | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` · `QueryExecutionId` |
|----------------|-------------|-------------|----------------|-----------|:-----------:|------------------------------------------|
| `EV-6.1-vendedlog-2026-05` | Logs vendidos CloudWatch+WAF por cuenta/región/tipo; WAF CloudFront `us-east-1` por log group | total **2 774,92** bruto / 2 374,51 neto · WAF `us-east-1` 2 166,67 | Q1/Q2/Q3 | **5 ARNs log-group** WAF (888899990000) + "no atribuible" en agregados | `EV-6.2` | `2026-06-23T08:15:23Z` · `202a8910-…`, `98ed2b96-…`, `79c19836-…` |
| `EV-6.2-waf-cloudfront-live` | **[Capa B]** Verificación viva `us-east-1` (Req 5.2): destino + volumen de 5 web ACLs | estado **confirmado**; drift destino prod a grupos `-ia` (post-mayo) | no aplica (verif. viva) | 5 log-groups WAF (+ 3 `-ia` drift) | confirmado | verif. `2026-06-23T08:50:59Z` (**`us-east-1`**) |
| `EV-6.3-waf-logs-estimado-2026-05` | Ahorro_Estimado (redirección S3 + muestreo + metric filters); compliance no eliminable | mensual **1 419,51 – 1 921,80** bruto · anual 17 034,11 – 23 061,56 | no aplica (derivada de `EV-6.1`) | 5 log-groups WAF | `EV-6.2` (confirmado) | clasificación **estimado** |

### 3.5 Palanca 5 — Aurora no productivo de Helios · `evidencias/palanca-05-aurora-helios.md`

| `id_evidencia` | Descripción | Cifra (USD) | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` · `QueryExecutionId` |
|----------------|-------------|-------------|----------------|-----------|:-----------:|------------------------------------------|
| `EV-7.1-aurora-helios-noprod-2026-05` | Cómputo Aurora no-prod Helios (dev+uat), 4× `db.r6g.large` 24/7 | bruto **851,14**/mes · neto 783,05 | Consulta primaria + refuerzo | **4 ARNs Aurora** (helios-dev/uat writer+reader) | `EV-7.2` | `2026-06-23T08:13:39Z` · `ac82037a-…`, `683d2e5a-…` |
| `EV-7.2-…-liveverify` | **[Capa B]** Verificación viva: writer+reader, `db.r6g.large`, `MultiAZ=false`, 24/7 | estado **confirmado** (4/4) | no aplica (verif. viva) | 4 ARNs Aurora | confirmado | verif. `2026-06-23T08:51:44Z` (`eu-west-1`) |
| `EV-7.3-aurora-helios-cons-mensual` | Ahorro Conservador mensual (solo reader, 50 %) | **425,57** (neto 391,52) | no aplica (`851,136 × 0,50`) | 4 ARNs Aurora | `EV-7.2` (confirmado) | **estimado** |
| `EV-7.3-aurora-helios-cons-anual` | Ahorro Conservador anual (×12) | 5 106,82 (neto 4 698,27) | no aplica (`425,568 × 12`) | 4 ARNs Aurora | `EV-7.2` | **estimado** |
| `EV-7.3-aurora-helios-agr-mensual` | Ahorro Agresivo mensual (reader+downsize+schedule, 85 %) | 723,47 (neto 665,59) | no aplica (`851,136 × 0,85`) | 4 ARNs Aurora | `EV-7.2` | **estimado** |
| `EV-7.3-aurora-helios-agr-anual` | Ahorro Agresivo anual (×12) | 8 681,59 (neto 7 987,06) | no aplica (`723,4656 × 12`) | 4 ARNs Aurora | `EV-7.2` | **estimado** |

### 3.6 Palanca 6 — EBS: gp2→gp3, snapshots, huérfanos · `evidencias/palanca-06a/06b/06c/06-conservacion.md`

| `id_evidencia` | Descripción | Cifra (USD) | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` |
|----------------|-------------|-------------|----------------|-----------|:-----------:|--------------------|
| `EV-8.1-ebs-gp2-gp3-2026-05` | **6a** gp2→gp3 (Estimado): coste base gp2 y ahorro neto | base 1 011,76 · ahorro **151,76 – 212,38**/mes · anual 1 821,12 – 2 548,56 | Consulta por cuenta + usage_type | no atribuible (dim. cuenta) | dependencia rendimiento pendiente | `2026-06-23T08:30:38Z` |
| `EV-8.2-ebs-snapshots-2026-05` | **6b** Snapshots (Estimado, separa elegibles) | base 402,93 · ahorro **20,15 – 60,44**/mes | Consulta A/B/C `SnapshotUsage` | no atribuible (dim. cuenta) | — | `2026-06-23T08:30:00Z` |
| `EV-8.3-ebs-volumenes-huerfanos-2026-05` | **6c** Volúmenes `available` (Garantizado), verificado en vivo | **Garantizado 232,20**/mes · anual 2 786,40 | no aplica (verificado en vivo) | **27 `vol-…`** explícitos | sub-registro confirmado/no_verificable | `2026-06-23T09:01:54Z` (verif.) |
| `EV-8.4-ebs-conservacion-subpalancas-2026-05` | **[Capa C]** Property 7 parcial — conservación 6a/6b/6c sin doble conteo | base disjunta 1 430,89 · solape gp2 huérfano eliminado 216,00 · dif. 0,00 | no aplica (consolidación) | no atribuible | hereda `EV-8.3` | derivada de EV-8.1/8.2/8.3 |

### 3.7 Palanca 7 — S3 lifecycle e Intelligent-Tiering · `evidencias/palanca-07-s3.md`

| `id_evidencia` | Descripción | Cifra (USD) | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` |
|----------------|-------------|-------------|----------------|-----------|:-----------:|--------------------|
| `EV-9.1-s3-timedstorage-clase-2026-05` | Coste S3 por clase de almacenamiento (Standard vs IT/Glacier) | Standard 2 170,80 · IT/Glacier ~0 | Consulta `TimedStorage` por usage_type | no atribuible (dim. clase) | `EV-9.2` | `2026-06-23T09:05:00Z` |
| `EV-9.2-s3-buckets-live` | **[Capa B]** Verificación viva lifecycle/versionado/MPU (infra, data-dev, iskaypet-data) | estado **confirmado** | no aplica (verif. viva) | mayores buckets de los ~89,8 % del Standard | confirmado (3 cuentas) | verif. `2026-06-23T10:18:57Z` |
| `EV-9.3-s3-tiering-estimado-2026-05` | Ahorro_Estimado lifecycle/tiering; base 2 170,80, direccionable 80 % | mensual **955,35 – 1 389,60** · anual 11 464,20 – 16 675,20 | no aplica (derivada de `EV-9.1`) | no atribuible | `EV-9.2` (confirmado) | clasificación **estimado** |

### 3.8 Palanca 8 — Red: NAT, VPN, EIP, VPC endpoints · `evidencias/palanca-08-red.md`

| `id_evidencia` | Descripción | Cifra (USD) | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` |
|----------------|-------------|-------------|----------------|-----------|:-----------:|--------------------|
| `EV-10.1-red-2026-05` | Coste de red por tipo (NAT/VPN/endpoints/IPv4) y cuenta | total **2 843,02** · NAT 1 503,28 · VPN 650,26 · endpoint 352,77 · IPv4 uso 305,90 · **IPv4 idle 30,82** | Q1/Q2/Q3 (precedencia OR corregida) | no atribuible (dim. tipo/cuenta) | sub-registro `10.2` | `2026-06-23T08:33:52Z` |
| `10.2` (verificación viva red) | **[Capa B]** `describe-nat-gateways/addresses/vpn-connections/vpc-endpoints` 13 cuentas | estado **confirmado** / candidata | no aplica (verif. viva) | NAT/EIP/VPN/endpoints por cuenta | confirmado (13) | verif. `2026-06-23` (`eu-west-1`) |
| `EV-10.3a-red-garantizado-2026-05` | **Garantizado** (cifra única): IPv4 idle + VPC endpoint duplicado | **45,88**/mes (30,82 + 15,06) · anual 550,56 | IPv4 idle de Q1/Q3; endpoint dup derivada | 7 EIP ociosas + 1 endpoint dup (Digital Prod) | hereda `10.2` (confirmado) | clasificación **garantizado** |
| `EV-10.3b-red-estimado-nat-2026-05` | Estimado: colapsar 2–3 pares NAT redundantes no-prod | **65,71 – 98,57**/mes · anual 788,52 – 1 182,84 | derivada de `EV-10.1` (NAT-horas) | NAT no-prod (Tooling/UAT/Dev) | hereda `10.2` | **estimado** |
| `EV-10.3c-red-estimado-vpn-2026-05` | Estimado **ilustrativo** (VPN túneles DOWN); **NO en objetivo** hasta owner (Req 14.4) | 68,44 – 273,76/mes · anual 821,28 – 3 285,12 | derivada de `EV-10.1` (VPN-horas) | VPN con ambos túneles DOWN | hereda `10.2` | **estimado** (contingente, fuera de objetivo) |

### 3.9 Palanca 9 — Rightsizing y Graviton · `evidencias/palanca-09-rightsizing.md`

| `id_evidencia` | Descripción | Cifra (USD) | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` |
|----------------|-------------|-------------|----------------|-----------|:-----------:|--------------------|
| `EV-11.1-ec2-boxusage-canonica` | Consulta canónica `design.md` (recurso × tipo de instancia) | 66 110,5 h · BoxUsage neto 6 611,04 (distorsionado por SP) | Consulta canónica | no atribuible (agregado) | `EV-11.2` | `2026-06-23T08:32:02Z` |
| `EV-11.1-boxusage-por-tipo-linea` | Composición de BoxUsage por tipo de línea (explica el neto) | desglose por `line_item_type` | Consulta por tipo de línea | no atribuible | — | `2026-06-23T08:32:02Z` |
| `EV-11.1-ec2-candidatos-limpio` | Base limpia (equiv. on-demand) por instancia; candidatos 24/7 | flota 15 184,74 · candidatos 24/7 6 017,58 (24 inst.) · x86 78,3 % | Consulta Evidencia C | **24 `i-…`** explícitos + agregados | `EV-11.2` | `2026-06-23T08:32:02Z` |
| `EV-11.2-rightsizing-live-2026-06-23` | **[Capa B]** Verificación viva 24 candidatos + p95 CPU (CloudWatch; RAM n/d) | estado **confirmado**/excluido; sin RAM | no aplica (verif. viva) | 24 `i-…` | confirmado | verif. `2026-06-23` (`eu-west-1`) |
| `EV-11.3-rightsizing-clasificacion` | Ahorro_Estimado por p95 (x86 no burstable); Graviton subsumido | mensual **574,27 – 1 531,39** · anual 6 891,26 – 18 376,70 | no aplica (derivada de `EV-11.1`/`EV-11.2`) | 6 inst. x86 no burstable | `EV-11.2` (confirmado) | **estimado** (pendiente Barrido) |

### 3.10 Palanca 10 — Scheduling y Spot no-prod · `evidencias/palanca-10-noprod-spot.md`

| `id_evidencia` | Descripción | Cifra (USD) | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` |
|----------------|-------------|-------------|----------------|-----------|:-----------:|--------------------|
| `EV-12.1-noprod-particion-compra` | Partición cómputo EC2 no-prod por cuenta × opción de compra | base disjunta 856,39 (eks-dev 538,35 + eks-uat 225,70 + data-dev 92,35) | Consulta por cuenta × opción | no atribuible (dim. cuenta×opción) | `EV-12.2-*` | `2026-06-23T08:44:52Z` |
| `EV-12.1-spot-baseline` | Uso actual de Spot (org) y oportunidad de ampliarlo | Spot no-prod ≈ 0 h / $0 | Consulta Spot por cuenta | no atribuible | — | `2026-06-23T08:44:52Z` |
| `EV-12.1-disyuncion-palanca1` | **Control anti-doble-conteo** (Property 7 anticipo): horas disjuntas de P1 | horas P10 ∩ P1 = ∅ | Consulta de disyunción | no atribuible | — | `2026-06-23T08:44:52Z` |
| `EV-12.2-eks-dev-vivo` / `-eks-uat-vivo` / `-data-dev-vivo` / `-digital-dev-vivo` | **[Capa B]** Inventario vivo y perfil de uso (4 cuentas) | estado **confirmado**; EMR TASK Spot-tolerante | no aplica (verif. viva) | nodos EKS/EMR (On-Demand) | confirmado | verif. `2026-06-23T08:59:37Z` |
| `EV-12.3-palanca10-estimado` | Ahorro_Estimado (10a scheduling + 10b Spot EMR TASK) | mensual **252,30 – 542,80** · anual 3 027,60 – 6 513,62 | no aplica (derivada de `EV-12.1`) | no atribuible (detalle en `EV-12.2-*`) | `EV-12.2-*` | **estimado** (pendiente Barrido) |

### 3.11 Palanca 11 — Bedrock (IA generativa) · `evidencias/palanca-11-bedrock.md`

| `id_evidencia` | Descripción | Cifra (USD) | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` |
|----------------|-------------|-------------|----------------|-----------|:-----------:|--------------------|
| `EV-13.1-bedrock-por-cuenta-perfil-canonica` | Bedrock por cuenta × inference profile × usage_type | total org **2 178,94** · Claude Haiku 4.5 2 175,40 (99,8 %) | Consulta canónica `design.md` | **ARNs inference-profile** | `EV-13.2` | `2026-06-23 07:55 UTC` (+ re-ej.) |
| `EV-13.1-bedrock-data-direccion-token` | Bedrock alcance Data por modelo y dirección de token | Data 2 175,00 · output 1 402,79 (64,5 %) / input 772,21 | Consulta Evidencia B | ARNs inference-profile (iskaypet-data, data-dev) | `EV-13.2` | `2026-06-23 07:55 UTC` |
| `EV-13.2` (V1/V2) | **[Capa B]** Verificación viva cuenta/modelo (`bedrock list-inference-profiles`) | estado **confirmado** (2 cuentas) | no aplica (verif. viva) | inference profiles | confirmado | verif. `2026-06-23` |
| `EV-13.3-bedrock-estimado-2026-05` | Ahorro_Estimado (prompt caching + reducción output + cambio modelo) | mensual **488,41 – 1 016,08** · anual 5 860,97 – 12 192,95 | no aplica (derivada de `EV-13.1`) | alcance Data | `EV-13.2` (confirmado) | **estimado** (advertencia calidad, Req 16.2) |

### 3.12 Palanca 12 (comercial) — Contrato Marketplace · `evidencias/palanca-12-marketplace.md`

> **Resolución H1 (cita canónica única — ver §4).** La fuente **canónica** del importe Marketplace es
> la partición contable de la Fundación: **`E1.1-MKT-CONTRACT`** (contrato 85 000,55) y **`E1.1-PAYG`**
> (PAYG 6 663,33). Los registros de Palanca 12 abajo **re-consultan, no recalculan** ese importe (lo
> documenta el propio fichero fuente) y, a efectos del Informe, **referencian** los ids canónicos.

| `id_evidencia` | Descripción | Cifra (USD) | `consulta_cur` | Recurso(s) | Cita canónica (H1) | `fecha_extraccion` |
|----------------|-------------|-------------|----------------|-----------|--------------------|--------------------|
| `EV-14.1-marketplace-contrato-payg-2026-05` | Registro raíz Palanca 12 (separa contrato y PAYG del mismo producto `cgdwha66…`) | contrato 85 000,55 · PAYG 6 663,33 | Consulta primaria Marketplace | no atribuible | → `E1.1-MKT-CONTRACT` / `E1.1-PAYG` | `2026-06-23T07:55:14Z` |
| `EV-14.1-MKT-CONTRACT` | Contrato Marketplace (Fee / `Global-SoftwareUsage-Contracts`) | **85 000,55** (cargo PUNTUAL/prepago — no recurrente, **no ×12**) | (re-consulta de `charge_type=Fee`) | no atribuible | **referencia `E1.1-MKT-CONTRACT`** | `2026-06-23T07:55:14Z` |
| `EV-14.1-MKT-PAYG` | PAYG mismo producto — tier mal dimensionado (Req 17.2) | **6 663,33**/mes · 79 960,00/año | (re-consulta de `MP:%`) | no atribuible | **referencia `E1.1-PAYG`** | `2026-06-23T07:55:14Z` |

Clasificación: **Palanca_Comercial** — separada del ahorro técnico, **no contabilizada** en el
Objetivo_Comprometido (Req 17.3). Fecha de renovación del contrato: **pendiente** (Req 17.4).

### 3.13 Barridos de utilización (gating de objetivos) · `evidencias/barrido-16-*.md`

| `id_evidencia` | Descripción | Veredicto | `consulta_cur` | Recurso(s) | Verif. viva | `fecha_extraccion` · `QueryExecutionId` |
|----------------|-------------|-----------|----------------|-----------|:-----------:|------------------------------------------|
| `EV-16.1-BARRIDO-STEADY` | **[Capa D]** Barrido steady-state Palancas 1 y 2 (uso estable ≥90 % de 744 h) | **CONFIRMADO** (P1 100 % estable mín. 96,0 %; P2 100 % a 744 h) → P1/P2 elegibles | Consultas barrido EC2 + RDS | no atribuible (18 rec. EC2 / 38 rec. RDS) | hereda `EV-3.2`, `EV-4.2` | `2026-06-24` · `2b579fc1-…`, `e0d5fb2b-…`, `837da239-…` |
| `EV-16.2-barrido-rightsizing-p95` | **[Capa D]** Barrido rightsizing p95 Palanca 9 | **PENDIENTE** (sin métricas: EC2 standalone fuera de EKS, RAM no instrumentada) → P9 pendiente | no aplica (PromQL, no CUR) | 6 `i-…` | — | `2026-06-23T11:07:32Z` |
| `EV-16.3-BARRIDO-SCHED-SPOT` | **[Capa D]** Barrido scheduling/Spot Palancas 5 y 10 | **P5 COMPLETO (Conservador)** elegible; **P10 PARCIAL → PENDIENTE** (Req 18.3) | Consultas P5 horas + P10 día-semana + segmentación | 4 ARNs Aurora + no atribuible (P10) | RDS describe + CloudWatch (P5); hereda `EV-12.2-*` (P10) | `2026-06-23T11:19:41Z` · `205a3b9d-…`, `0d3b1059-…`, `96e7baa8-…` |

---

## 4. Resolución H1 — Cita canónica única del Marketplace

La auditoría 17.2 detectó que el importe del Marketplace aparece en **dos** registros con roles
distintos pero importes idénticos: `E1.1-MKT-CONTRACT`/`E1.1-PAYG` (partición **contable** de la
línea base) y `EV-14.1-MKT-CONTRACT`/`EV-14.1-MKT-PAYG` (registro de **Palanca_Comercial**). No es
doble conteo (Palanca 12 re-consulta, no recalcula), pero para preservar la biyección estricta
1-cifra↔1-registro (Property 2) el Informe debe citar **un único** id canónico.

**Decisión (vinculante para el Informe):**

| Cifra del Informe | `id_evidencia` **canónico** (fuente única) | Registro que la referencia (no la republica) |
|-------------------|--------------------------------------------|----------------------------------------------|
| Contrato Marketplace `85 000,55` (cargo **PUNTUAL**, no ×12) | **`E1.1-MKT-CONTRACT`** | `EV-14.1-MKT-CONTRACT` (fila Palanca 12) → referencia `E1.1-MKT-CONTRACT` |
| PAYG mismo producto `6 663,33`/mes (`79 960,00`/año) | **`E1.1-PAYG`** | `EV-14.1-MKT-PAYG` (fila Palanca 12) → referencia `E1.1-PAYG` |

Tanto la **línea base** (5 grupos) como la **fila de la Palanca 12** del Informe publican la cifra
del Marketplace **una sola vez**, citando `E1.1-MKT-CONTRACT` / `E1.1-PAYG`. Los `EV-14.1-*` quedan
como registros de **detalle comercial** de la Palanca 12 (renegociación, fecha de renovación
pendiente, tier mal dimensionado), no como fuente paralela del importe. Con esto, **H1 queda
cerrado**: una cifra ↔ un id canónico.

---

## 5. Resolución H2 — Registros propios de las cifras agregadas del resumen ejecutivo

El resumen ejecutivo (sección 1 del Informe) publica tres cifras **agregadas** que la auditoría 17.2
señaló como aún sin registro propio (dependencia diferida). Aquí se crean los **tres registros
dedicados**, con `consulta_cur = "no aplica"` (derivadas por suma) y `recurso_ids = "no atribuible a
recurso"`, citando explícitamente sus **ids componentes**, de modo que el resumen también mantenga la
biyección 1-a-1 (Property 2) y la derivación cerrada de objetivos (Property 12).

> Frescura de los Garantizados (Req 3.2 / Property 6): las tres verificaciones en vivo que sostienen
> el total Garantizado tienen frescura **0 días** respecto a la fecha de extracción del congelado
> (`2026-06-23`): EBS huérfanos (`EV-8.3`, verif. `2026-06-23T09:01:54Z`), Extended Support
> (`EV-5.2`, verif. `2026-06-23T08:54:09Z`) y red garantizada (`10.2`, verif. `2026-06-23`). Todas ≤
> 30 días → el Garantizado es contabilizable.

### 5.1 `EV-AGG-GARANTIZADO` — Total de Ahorro_Garantizado

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-AGG-GARANTIZADO` |
| `descripcion` | Total de Ahorro_Garantizado del Estudio = suma de las cifras Garantizadas verificadas en vivo (cifra única, no rango) |
| `cifra_publicada` | **1 111,36 USD/mes** · anualizado ×12 = **13 336,32 USD/año** (con advertencia de estacionalidad, Req 6.4) |
| `consulta_cur` | **no aplica** — cifra **derivada por suma** de cifras Garantizadas congeladas |
| `ids_componentes` | `EV-5.3-…-clasificacion` (Extended Support PG13 prod/tooling, **833,28**) + `EV-8.3-ebs-volumenes-huerfanos-2026-05` (EBS huérfanos, **232,20**) + `EV-10.3a-red-garantizado-2026-05` (IPv4 idle + endpoint dup, **45,88**) |
| `cálculo` | `833,28 + 232,20 + 45,88 = 1 111,36` (sumado antes de redondear, half-up — Req 6.7) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `frozen-2026-05@2026-06-23` (derivada; verificaciones vivas a `2026-06-23`, frescura ≤ 30 días — Req 3.2) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` (agregado; recursos en los registros componentes: 3 ARNs RDS PG13, 27 `vol-…`, 7 EIP + 1 VPC endpoint) |
| `verificacion_vivo` | Heredada de los componentes — `EV-5.2` (confirmado/drift), `EV-8.3` (confirmado), `10.2` (confirmado). Todas frescura 0 días |
| `clasificacion` | `garantizado` (Extended Support es **condicionado** a upgrade + validación de compatibilidad) |

### 5.2 `EV-AGG-ESTIMADO` — Rango de Ahorro_Estimado total

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-AGG-ESTIMADO` |
| `descripcion` | Rango total de Ahorro_Estimado = suma de los Rango_Conservador y suma de los Rango_Agresivo de las Palancas Estimado (nunca cifra única — Req 6.6) |
| `cifra_publicada` | **mensual 7 433,58 – 11 825,72 USD** · anualizado ×12 **89 202,96 – 141 908,64 USD** (con advertencia de estacionalidad, Req 6.4) |
| `consulta_cur` | **no aplica** — cifra **derivada** (Σ Conservadores – Σ Agresivos de las Palancas Estimado) |
| `ids_componentes` | `EV-3.3` (P1: 1 347,77–1 780,99) + `EV-4.3-RDS-COMMIT` (P2: 1 732,78–2 548,20) + `EV-6.3` (P4: 1 419,51–1 921,80 bruto) + `EV-7.3-…-{cons,agr}-mensual` (P5: 425,57–723,47 bruto) + `EV-8.1` (P6a: 151,76–212,38) + `EV-8.2` (P6b: 20,15–60,44) + `EV-9.3` (P7: 955,35–1 389,60) + `EV-10.3b` (P8 NAT: 65,71–98,57) + `EV-11.3` (P9: 574,27–1 531,39) + `EV-12.3` (P10: 252,30–542,80) + `EV-13.3` (P11: 488,41–1 016,08) |
| `cálculo` | Σ Conservadores = `1 347,77+1 732,78+1 419,51+425,57+151,76+20,15+955,35+65,71+574,27+252,30+488,41 = 7 433,58`; Σ Agresivos = `1 780,99+2 548,20+1 921,80+723,47+212,38+60,44+1 389,60+98,57+1 531,39+542,80+1 016,08 = 11 825,72` (sumado antes de redondear — Req 6.7) |
| `exclusiones` | **No** se incluye `EV-10.3c` (VPN, 68,44–273,76) por ser **contingente** a confirmación del owner (Req 14.4), ni ninguna cifra Garantizada (que va en `EV-AGG-GARANTIZADO`), ni la Palanca_Comercial (P12). P4 y P5 se suman en **bruto** (consistente con su publicación). |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `frozen-2026-05@2026-06-23` (derivada) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` (agregado de 11 Palancas Estimado) |
| `verificacion_vivo` | Heredada de cada componente (P1, P2, P4, P5, P7, P9, P11 con verificación viva confirmada; P6a/P6b/P8-NAT/P10 según su registro) |
| `clasificacion` | `estimado` (rango; invariante `0 < Conservador ≤ Agresivo` ✓: `0 < 7 433,58 ≤ 11 825,72`) |

> Nota (Req 18.5 / Property 12): el **rango Estimado total** incluye Palancas **con y sin** barrido
> completado, porque el resumen presenta la oportunidad total estimada; lo que **no** se hace es
> elevarlas todas a objetivo comprometido. La frontera barrido-completo se materializa en
> `EV-AGG-OBJETIVO` (§5.3).

### 5.3 `EV-AGG-OBJETIVO` — Objetivo_Comprometido

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-AGG-OBJETIVO` |
| `descripcion` | Objetivo de ahorro **comprometido** = Σ Ahorro_Garantizado + Σ Rango_Conservador de las Palancas Estimado **con Barrido_Utilizacion completado**; excluye Estimadas sin barrido y la Palanca_Comercial (Property 12, Req 18.2, 19.4, 19.6) |
| `cifra_publicada` | **4 617,48 USD/mes** · anualizado ×12 = **55 409,76 USD/año** (con advertencia de estacionalidad, Req 6.4) |
| `consulta_cur` | **no aplica** — cifra **derivada** por la regla cerrada de derivación de objetivos |
| `ids_componentes` | `EV-AGG-GARANTIZADO` (**1 111,36**) + Conservadores con barrido completo: `EV-3.3` (P1, **1 347,77**, barrido `EV-16.1` CONFIRMADO) + `EV-4.3-RDS-COMMIT` (P2, **1 732,78**, barrido `EV-16.1` CONFIRMADO) + `EV-7.3-…-cons-mensual` (P5, **425,57**, barrido `EV-16.3` COMPLETO Conservador) |
| `cálculo` | `1 111,36 + 1 347,77 + 1 732,78 + 425,57 = 4 617,48` (sumado antes de redondear, half-up — Req 6.7) |
| `exclusiones` | **P9** (rightsizing) y **P10** (scheduling/Spot): barrido `EV-16.2`/`EV-16.3` **PENDIENTE/PARCIAL** → fuera del objetivo, solo rango estimado (Req 18.3). **P4, P6a, P6b, P7, P8-NAT, P11**: Estimadas sin barrido completo → fuera del objetivo. **P12** Marketplace: comercial, nunca en el objetivo técnico (Req 17.3). El **Agresivo** de P5 (downsize+scheduling) permanece estimado, no comprometido. |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `frozen-2026-05@2026-06-23` (derivada) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` (agregado; recursos en los registros componentes) |
| `verificacion_vivo` | Heredada: Garantizados (frescura 0 días) + barridos `EV-16.1` (P1/P2 CONFIRMADO) y `EV-16.3` (P5 COMPLETO Conservador) |
| `clasificacion` | `objetivo_comprometido` (derivación cerrada — Property 12) |

> **Trazabilidad de la derivación (Property 12):**
> `Objetivo = Σ Garantizado (1 111,36) + Σ Conservador{P1,P2,P5 con barrido} (1 347,77 + 1 732,78 + 425,57 = 3 506,12) = 4 617,48 USD/mes`.
> Cada sumando cita su registro; ninguna Palanca sin barrido completo ni la comercial entra.

---

## 6. Veredicto de biyección y completitud (cierre de 17.2 sobre el Informe)

Tras aplicar H1 (cita canónica única del Marketplace) y H2 (tres registros agregados propios), el
Informe completo —resumen ejecutivo + tabla por Palanca + este anexo— mantiene:

- **Property 2 (biyección 1-a-1):** cada cifra publicada cita **exactamente un** `id_evidencia`
  (incluidas las tres agregadas del resumen y la cifra única del Marketplace). Sin cifras huérfanas
  ni registros huérfanos.
- **Property 3 (completitud del esquema):** todos los registros de capa A llevan los seis campos
  obligatorios; las cifras derivadas/agregadas llevan `consulta_cur = "no aplica"` **justificado** y
  citan sus ids componentes; los sub-registros de capa B llevan el sub-esquema del Req 5.5 (con
  `us-east-1` para WAF/CloudFront); marcas temporales con zona horaria en el 100 %.

## 7. Conteo de registros consolidados

| Bloque | Registros |
|--------|----------:|
| Fundación (línea base + controles 1.1–1.4) | 10 |
| Palanca 1 (EC2 SP) | 4 |
| Palanca 2 (RDS RI) | 4 |
| Palanca 3 (Extended Support) | 3 |
| Palanca 4 (Logs CloudWatch/WAF) | 3 |
| Palanca 5 (Aurora no-prod Helios) | 6 |
| Palanca 6 (EBS 6a/6b/6c + conservación) | 4 |
| Palanca 7 (S3) | 3 |
| Palanca 8 (Red) | 5 |
| Palanca 9 (Rightsizing/Graviton) | 5 |
| Palanca 10 (Scheduling/Spot no-prod) | 8 |
| Palanca 11 (Bedrock) | 4 |
| Palanca 12 (Marketplace, comercial) | 3 |
| Barridos de utilización (16.1/16.2/16.3) | 3 |
| **Subtotal corpus congelado referenciado** | **65** |
| Registros agregados **nuevos** (H2): `EV-AGG-GARANTIZADO`, `EV-AGG-ESTIMADO`, `EV-AGG-OBJETIVO` | 3 |
| **Total índice maestro del anexo** | **68** |

> El corpus congelado se distribuye en **19 ficheros** (`catalogo-evidencias.md` + 18 bajo
> `evidencias/`). Este anexo los **referencia** (no los reescribe) y añade los 3 registros agregados
> del resumen ejecutivo. La auditoría 17.2 cuenta "~50 registros" sobre la **capa A** (cifras
> publicables); el conteo de 65 de arriba incluye además los sub-registros de verificación viva
> (capa B), los controles (capa C) y los barridos (capa D), que el índice lista por trazabilidad.

## 8. Re-ejecución del anexo (procedimiento)

1. `list_directory` sobre `evidencias/` → confirmar los 18 ficheros + `catalogo-evidencias.md`.
2. Por cada `id_evidencia` del §3, abrir su fichero fuente y verificar los seis campos obligatorios
   (Property 3) y el `recurso_ids` (ARN/`vol-`/`i-` reales, o "no atribuible a recurso" + dimensión).
3. Recalcular las tres cifras agregadas (§5) sumando los ids componentes **antes** de redondear
   (half-up): Garantizado `1 111,36`, Estimado `7 433,58 – 11 825,72`, Objetivo `4 617,48`.
4. Confirmar la cita canónica única del Marketplace (§4): el Informe cita `E1.1-MKT-CONTRACT` /
   `E1.1-PAYG`, no los `EV-14.1-*` paralelos.
5. Cualquier diferencia distinta de `0,00 USD`, cifra huérfana o campo vacío debe investigarse antes
   de publicar el Informe (Req 7.3, 2.7, 19.5).
