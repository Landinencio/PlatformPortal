# Auditoría 17.4 — Ausencia de doble conteo (disyunción entre Palancas que comparten servicio)

> **Tarea 17.4** — Auditoría **re-ejecutable** de la **Correctness Property 7** sobre el
> `Catálogo_Evidencias` y el `Dataset_Congelado`. Entregable **analítico** (no software): la "prueba"
> es la verificación de invariantes de conjuntos sobre los artefactos congelados de las Palancas
> (cruce de `line_item_resource_id` y de horas), no un test de código.
>
> **Property 7** — **Validates: Requirements 3.4, 8.8**

## Parámetros de la auditoría (anclaje)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Fecha de extracción del CUR | `2026-06-23` (UTC) |
| Fecha de esta auditoría (re-ejecución Athena) | `2026-06-24` (UTC) |
| Moneda | `USD` (2 decimales, half-up, sumando antes de redondear — Req 6.7) |
| Motor / DB / tabla | Amazon Athena (CUR 2.0) · `athenacurcfn_finnops` / `data` · `eu-west-1` |
| Cuenta CUR / rol / perfil | `600700800900` (root-iskaypet) · `Cur-AWSS3CURLambdaExecutor` · perfil `root-iskaypet` |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |
| Fuentes auditadas | `palanca-01-ec2.md`, `palanca-02-rds.md`, `palanca-05-aurora-helios.md`, `palanca-06-conservacion.md`, `palanca-09-rightsizing.md`, `palanca-10-noprod-spot.md`, `barrido-16-1-steady-state.md`, `barrido-16-3-scheduling-spot.md` |

## Definición auditada (del `design.md`)

> **Property 7 — Ausencia de doble conteo.** *Para toda* Palanca dividida en Sub_Palancas, la suma de
> los costes base de las Sub_Palancas es igual al coste base de la Palanca; y *para todo* par de
> Palancas que compiten por el mismo gasto (p. ej. compromiso EC2 vs Spot/scheduling sobre las mismas
> horas), los conjuntos de unidades de coste asignadas (horas de cómputo, GiB, recursos) son
> disjuntos. (Req 3.4, 8.8; principio de metodología 6.)

La auditoría se descompone en **dos invariantes**:

- **INV-A (conservación de Sub_Palancas):** `Σ coste base Sub_Palancas = coste base de la Palanca`.
- **INV-B (disyunción entre Palancas que comparten servicio):** los conjuntos de `resource_id` / horas
  asignados a Palancas que compiten por el mismo gasto son disjuntos (cada unidad de coste a una sola
  Palanca).

---

## 1. INV-A — Conservación de Sub_Palancas (Req 3.4)

### 1.1 Palanca 6 (EBS) — única Palanca mixta con Sub_Palancas de la misma dimensión de coste

La auditoría de conservación de la Palanca 6 ya fue ejecutada en la Tarea 8.4
(`palanca-06-conservacion.md`, `EV-8.4-ebs-conservacion-subpalancas-2026-05`). Se **re-verifica** aquí
su aritmética sobre las cifras congeladas:

| Sub_Palanca | Coste base **declarado** (USD/mes) | Ajuste no-doble-conteo | Coste base **disjunto** (USD/mes) |
|-------------|-----------------------------------:|------------------------|----------------------------------:|
| 6a gp2→gp3 (`VolumeUsage.gp2`) | 1 011,76 | − 216,00 (gp2 huérfano → 6c) | **795,76** |
| 6b Snapshots (`SnapshotUsage`) | 402,93 | 0,00 (dimensión disjunta) | **402,93** |
| 6c Volúmenes huérfanos (`available`) | 232,20 | + 216,00 ya incluido (asignado aquí) | **232,20** |
| **Σ Sub_Palancas (disjunta)** | | | **1 430,89** |

**Solape detectado y de-duplicado (clave de la Palanca 6):** un volumen **gp2 en estado `available`**
(huérfano) **sigue facturando** `VolumeUsage.gp2`, de modo que sus **2 160 GiB-mes = 216,00 USD/mes**
estaban contados a la vez en 6a (todos los gp2) y en 6c (todos los `available`). La regla de asignación
determinista —un huérfano se **elimina** (6c, Garantizado), no se **migra** (6a, Estimado)— asigna esos
$216,00 a **6c** y los **resta** de la base direccionable de 6a (1 011,76 → 795,76). Los componentes
gp3 (9,20) y standard (7,00) de 6c y la dimensión `SnapshotUsage` de 6b **no** solapan con 6a.

**Ecuación de conservación:**

```
Coste_base_Palanca_6 = VolumeUsage.gp2 (1 011,76) + SnapshotUsage (402,93) + huérfanos no-gp2 (16,20)
                     = 1 430,89 USD/mes
Σ Sub_Palancas disj. = 6a_ajustada (795,76) + 6b (402,93) + 6c (232,20) = 1 430,89 USD/mes
Diferencia           = 0,00 USD   ✅
Comprobación solape  = Σ naïve (1 646,89) − solape gp2 (216,00) = 1 430,89   ✅
```

- Conjuntos de identificadores **disjuntos**: 6c enumera **27 `vol-…`** (22 de ellos gp2 = el solape);
  6a cubre el resto de gp2 **activos** (excluyendo esos 22); 6b opera sobre **1 216 `resource_id` de
  snapshots** (espacio de identificadores disjunto del de volúmenes).

> **INV-A (Palanca 6): ✅ CONSERVA** — `795,76 + 402,93 + 232,20 = 1 430,89` = coste base EBS;
> diferencia `0,00 USD`; el único solape (gp2 huérfano, 216,00) está de-duplicado (asignado a 6c,
> restado de 6a). Sin otras unidades de coste contadas dos veces.

### 1.2 Otras Palancas mixtas

La **Palanca 8 (Red)** se parte en Sub_Palancas (8a Garantizado, 8b/8c Estimado) sobre **dimensiones
de coste distintas** (IPv4 idle + VPC endpoint dup vs NAT vs VPN), que son **disjuntas por
construcción** (cada `usage_type` pertenece a una sola Sub_Palanca); no hay un coste base único a
conservar como en EBS, sino tipos de cargo separados. No se observa solape entre 8a/8b/8c. El resto de
Palancas técnicas (1, 2, 3, 4, 5, 7, 9, 10, 11) **no** se dividen en Sub_Palancas → INV-A no aplica.

---

## 2. INV-B — Disyunción entre Palancas que comparten servicio (Req 8.8)

Tres pares comparten servicio y deben repartirse el gasto de forma disjunta: **(2.1)** P1 vs P10
(compromiso EC2 vs Spot/scheduling, mismas horas EC2), **(2.2)** P2 vs P5 (compromiso RDS vs Aurora
no-prod de Helios), **(2.3)** P1 vs P9 (compromiso EC2 vs rightsizing, mismas instancias EC2).

### 2.1 P1 (compromiso EC2) vs P10 (Spot/scheduling) — disyunción por HORAS

**Mecanismo de disyunción.** La Palanca 1 fija su base sobre el on-demand **estable**
(`line_item_resource_id` con horas ≥ `0,90 × 744 = 669,6 h`); la porción **intermitente** (< 669,6 h)
se **enruta a la Palanca 10**. La unidad disjunta es la **hora de cómputo** por recurso.

**Re-ejecución — conjunto estable de la Palanca 1 (18 recursos):**

```sql
WITH od AS (
  SELECT line_item_resource_id AS rid, line_item_usage_account_id AS acct,
         SUM(line_item_usage_amount) AS hours, SUM(line_item_unblended_cost) AS cost
  FROM data
  WHERE line_item_product_code='AmazonEC2' AND line_item_usage_type LIKE '%BoxUsage%'
    AND line_item_line_item_type IN ('Usage','DiscountedUsage')
    AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
    AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
  GROUP BY line_item_resource_id, line_item_usage_account_id)
SELECT rid, acct, ROUND(hours,2) AS hours, ROUND(cost,2) AS cost
FROM od WHERE hours >= 669.6 ORDER BY cost DESC;
```

- `QueryExecutionId`: **`65ffc5e5-1680-4504-b00a-61a1b078500b`** · `SUCCEEDED` · 9 766 668 bytes.
- **Resultado:** 18 recursos, `Σ = 4 813,46 USD` (≈ 4 813,47 congelado; redondeo). Cuentas presentes:
  `400500600700` (SAP), `200300400500` (iskaypet-data), `300400500600` (infra), `999900001111`
  (digital-dev), `444455556666` (eks-tooling).

**Cuentas de la base de la Palanca 10** (`palanca-10`, `EV-12.1-noprod-particion-compra`,
`QueryExecutionId` `db76fe8a-090f-4808-ac47-967e932456ae`): `111122223333` (eks-dev), `222233334444`
(eks-uat), `100200300400` (data-dev), base direccionable **disjunta** = **856,39 USD/mes**.

**Intersección de conjuntos:**

- Las 3 cuentas de la base de P10 (`eks-dev`, `eks-uat`, `data-dev`) **no aparecen** en el conjunto
  estable de P1 → a nivel de cuenta la intersección ya es **∅**.
- Confirmado en origen (`palanca-10`, `EV-12.1-disyuncion-palanca1`, `QueryExecutionId`
  `5c394e67-22d2-4955-ad5d-0707137c8cf4`): eks-dev / eks-uat / data-dev tienen **0 recursos estables**
  (su on_demand es **100 % intermitente**, máx. 226 h/recurso — corroborado por el barrido 16.3,
  `QueryExecutionId` `96e7baa8-83b3-4190-92d5-20842d2a0889`).
- El **único** recurso estable de P1 en cuenta no-prod (`digital-dev` `i-0d4b98e283cf4cc16`, 743,94 h /
  9,37 USD) **permanece en P1** y se **excluye** de la base de P10 (regla de disyunción aplicada en
  origen).

```
Base P10 disjunta = eks-dev (538,35) + eks-uat (225,70) + data-dev (92,35) − digital-dev estable (9,37→permanece P1)
                  = 856,39 USD/mes   (reconcilia con la porción intermitente que P1 enrutó: subconjunto de 2 372,44)
P1_estable ∩ P10_base (resource_id) = ∅   ·   P1_estable ∩ P10_base (horas) = ∅
```

> **2.1 P1 vs P10: ✅ DISJUNTOS** por horas y por recurso. La capacidad 24/7-plana de eks-dev/eks-uat
> está además bajo `sp_covered` (territorio P1/P2), no en la base on_demand de P10 (barrido 16.3). Spot
> no-prod actual = 0 h / $0 (sin solape con nada).

### 2.2 P2 (compromiso RDS) vs P5 (Aurora no-prod Helios) — disyunción por RECURSO

**Mecanismo de disyunción.** El cómputo Aurora no-prod de Helios (cuentas **dev + uat**) se **enruta a
la Palanca 5** y se **resta** de la base direccionable de la Palanca 2. Helios **prod** permanece en P2.

**Re-ejecución — cómputo Aurora no-prod Helios (base de P5):**

```sql
SELECT line_item_usage_account_id AS acct,
       ROUND(SUM(line_item_unblended_cost),2) AS gross_instanceusage,
       COUNT(DISTINCT line_item_resource_id) AS resources
FROM data
WHERE line_item_product_code='AmazonRDS' AND line_item_usage_type LIKE '%InstanceUsage%'
  AND line_item_line_item_type IN ('Usage','DiscountedUsage')
  AND line_item_usage_account_id IN ('555566667777','666677778888')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1 ORDER BY 1;
```

- `QueryExecutionId`: **`ae9be23b-5623-486d-84b7-008039929608`** · `SUCCEEDED` · 8 234 466 bytes.
- **Resultado:** `helios-dev` (555566667777) = **425,57** (2 recursos) · `helios-uat` (666677778888) =
  **425,57** (2 recursos) → **Σ = 851,14 USD/mes bruto**, **4 recursos** Aurora `db.r6g.large`. Coincide
  exactamente con la base congelada de P5 (`palanca-05`, `EV-7.1`, `QueryExecutionId`
  `ac82037a-2731-430c-b129-8dc310bdff45`).

**Reconciliación de la disyunción (barrido 16.1, `QueryExecutionId` `837da239-7c97-41a5-8186-3f1f5dc2f9b9`):**

```
Σ estable cómputo RDS              = 6 024,94 USD
− Helios no-prod dev+uat (→ P5)    −   851,14   ← los 4 ARN Aurora salen de la base de P2
− RI All Upfront eks-tooling       −    77,38   ← 2× db.t3.medium ya cubiertas
-----------------------------------------------
= Base direccionable P2 (prod)        5 096,42  ≈ 5 096,40 USD/mes  ✅
```

- Los **4 ARN** Aurora no-prod (`helios-{dev,uat}-golden-record-db-aurora-{0,1}`) están en **P5**, no en
  la base direccionable de **P2**. **Helios prod** (`777788889999`, 425,57) **permanece en P2** (es prod)
  → P5 (dev+uat) y la porción prod de P2 son **disjuntas por recurso/cuenta**.
- P5 es servicio RDS (Aurora) y P10 es EC2 → dimensiones disjuntas (sin solape P5↔P10).

> **2.2 P2 vs P5: ✅ DISJUNTOS** por recurso. Los 4 ARN Aurora no-prod ($851,14) están **fuera** de la
> base de P2 (restados y enrutados a P5); helios-prod queda en P2. `P2_base ∩ P5_base = ∅`.

### 2.3 P1 (compromiso EC2) vs P9 (rightsizing) — SOLAPE DE RECURSOS detectado

**Naturaleza.** P1 (compromiso) y P9 (rightsizing) operan sobre **ejes de optimización ortogonales**
(opción de compra vs tamaño de instancia) que pueden recaer sobre la **misma instancia física**. La base
direccionable de P9 son **6 instancias x86 no burstable 24/7** (`palanca-09`, `EV-11.3`, base
3 828,48 USD).

**Re-ejecución — caracterización de las 6 instancias base de P9 por opción de compra:**

```sql
SELECT line_item_resource_id AS rid, line_item_usage_account_id AS acct,
       CASE WHEN line_item_line_item_type='SavingsPlanCoveredUsage' THEN 'sp_covered'
            WHEN line_item_usage_type LIKE '%SpotUsage%' THEN 'spot' ELSE 'on_demand' END AS opt,
       ROUND(SUM(line_item_usage_amount),2) AS hours,
       ROUND(SUM(line_item_unblended_cost),2) AS unblended,
       ROUND(SUM(pricing_public_on_demand_cost),2) AS od_equiv
FROM data
WHERE line_item_product_code='AmazonEC2' AND line_item_usage_type LIKE '%BoxUsage%'
  AND line_item_line_item_type IN ('Usage','SavingsPlanCoveredUsage','DiscountedUsage')
  AND line_item_resource_id IN ('i-077c80e4ad5dee2f6','i-09e46b118b490e70c','i-09df511c7032ee013',
      'i-0131f5d7404a789c1','i-03c5a408758018ee9','i-01df3007e1dc5a4ad')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1,2,3 ORDER BY 1;
```

- `QueryExecutionId`: **`fcbe2755-98af-4d5d-8e91-b2d13ba58f0a`** · `SUCCEEDED` · 12 891 989 bytes.

**Resultado — ¿está cada instancia base de P9 en el conjunto estable de P1?**

| Instancia base P9 | Cuenta | Opción / horas (CUR) | ¿En conjunto estable de P1 (≥669,6 h on_demand)? |
|-------------------|--------|----------------------|:------------------------------------------------:|
| `i-077c80e4ad5dee2f6` (r6a.4xlarge, SAP) | 400500600700 | on_demand 744,0 h / 1 302,89 | **Sí** (en P1) |
| `i-09e46b118b490e70c` (m6i.4xlarge, SAP) | 400500600700 | on_demand 744,0 h / 1 184,45 | **Sí** (en P1) |
| `i-09df511c7032ee013` (c5a.2xlarge, SAP) | 400500600700 | on_demand 744,0 h / 529,73 | **Sí** (en P1) |
| `i-0131f5d7404a789c1` (m6id.xlarge, data) | 200300400500 | on_demand 744,0 h / 333,76 | **Sí** (en P1) |
| `i-03c5a408758018ee9` (m5.2xlarge, infra) | 300400500600 | on_demand 713,87 h / 305,54 (+ sp_covered 30,13 h) | **Sí** (en P1, porción on_demand estable) |
| `i-01df3007e1dc5a4ad` (m5.xlarge, clinicanimal) | 999000111222 | on_demand **573,06 h** / 122,64 (+ sp_covered 170,94 h) | **No** (on_demand < 669,6 h → intermitente) |

**Intersección:** **5 de las 6** instancias base de P9 están en el conjunto estable de P1.

```
P1_estable ∩ P9_base (resource_id) = { i-077c80e4ad5dee2f6, i-09e46b118b490e70c,
                                        i-09df511c7032ee013, i-0131f5d7404a789c1,
                                        i-03c5a408758018ee9 }   (5 recursos, ≠ ∅)
Coste P1 estable de esos 5  = 1 302,89 + 1 184,45 + 529,73 + 333,76 + 305,54 = 3 656,37 USD
Coste P9 base de esos 5     = 3 669,26 USD (equiv. on-demand 744 h; ≈ 95,8 % de los 3 828,48 de P9)
La 6ª (clinicanimal, 159,22) NO está en P1: su on_demand es 573,06 h (intermitente, parcialmente SP-cubierta)
```

**¿Es esto una violación de Property 7?** No para el `Objetivo_Comprometido`, **pero exige tratamiento
explícito** en el rango Estimado:

1. **A nivel de objetivo comprometido — disjunto de hecho.** P9 está **pendiente al 100 %** de
   `Barrido_Utilizacion` (sin p95 de RAM, Req 13.2/18.2; `palanca-09` 11.3) → **EXCLUIDA del
   `Objetivo_Comprometido`**. P1 está **CONFIRMADA** (barrido 16.1) → incluida. Por tanto, en la cifra
   comprometida que deriva la Property 12, los 5 recursos compartidos se cuentan **una sola vez** (vía
   P1). **No hay doble conteo en el objetivo comprometido.** ✅
2. **A nivel de rango Estimado — interacción no aditiva (caveat obligatorio).** P1 y P9 son optimizaciones
   ortogonales (cambiar opción de compra vs reducir tamaño): su efecto combinado es **multiplicativo**,
   no la suma de ambos ahorros sobre el mismo coste base. Sumar el Estimado de P1 (1 347,77–1 780,99) y
   el de P9 (574,27–1 531,39) **como si fueran independientes sobre los 5 recursos compartidos
   sobrestimaría** el ahorro. El Informe **debe** señalar esta no-aditividad (ver Hallazgo 1).

> **2.3 P1 vs P9: ⚠️ SOLAPE DE RECURSOS (5 de 6 instancias).** No viola Property 7 en el objetivo
> comprometido (P9 está excluida por barrido pendiente → cuenta única vía P1), **pero** los rangos
> Estimado de P1 y P9 **no son aditivos** sobre esos 5 recursos: requiere nota de interacción explícita
> en el Informe y, si P9 se eleva alguna vez, secuenciación (rightsize → recomputar el compromiso sobre
> la capacidad ya redimensionada) para preservar la disyunción.

---

## 3. Resumen de veredictos

| Invariante / par | Mecanismo | Resultado | Síntesis |
|------------------|-----------|:---------:|----------|
| **INV-A** Palanca 6 (EBS) | Σ Sub_Palancas = base | ✅ **PASS** | `795,76 + 402,93 + 232,20 = 1 430,89`; gp2 huérfano (216,00) de-duplicado 6a→6c; diferencia `0,00 USD` |
| **INV-B 2.1** P1 vs P10 | disyunción por **horas** | ✅ **PASS** | estable (≥669,6 h) vs intermitente; cuentas disjuntas; `∩ = ∅` |
| **INV-B 2.2** P2 vs P5 | disyunción por **recurso** | ✅ **PASS** | 4 ARN Aurora no-prod ($851,14) enrutados a P5 y restados de P2; helios-prod queda en P2; `∩ = ∅` |
| **INV-B 2.3** P1 vs P9 | ejes ortogonales (solape) | ⚠️ **PASS con caveat** | 5/6 instancias de P9 ∈ estable de P1; **sin** doble conteo en el objetivo (P9 pendiente, excluida); rangos Estimado **no aditivos** → nota obligatoria |

> **VEREDICTO Property 7 (Req 3.4, 8.8): ✅ PASS** (con un caveat documentado de no-aditividad P1↔P9).
> La conservación de Sub_Palancas se cumple (Palanca 6, diferencia 0,00 USD); los pares que reparten el
> mismo gasto por construcción (P1 vs P10 por horas; P2 vs P5 por recurso) son **disjuntos**. El único
> solape de `resource_id` (P1 ∩ P9, 5 instancias) **no produce doble conteo en el `Objetivo_Comprometido`**
> porque P9 está excluida (barrido pendiente al 100 %); su tratamiento en el rango Estimado exige la nota
> de interacción del Hallazgo 1.

**Cobertura de Property 7 ya verificada parcialmente en 8.4:** la conservación de la Palanca 6
(`palanca-06-conservacion.md`) se re-confirma aquí sin cambios. Esta auditoría 17.4 completa el alcance
a nivel de Informe (todas las Palancas que comparten servicio).

---

## 4. QueryExecutionId reales (re-ejecutables)

| Propósito | `QueryExecutionId` | Fuente |
|-----------|--------------------|--------|
| Conjunto estable de P1 (18 recursos, ≥669,6 h on_demand) | `65ffc5e5-1680-4504-b00a-61a1b078500b` | esta auditoría (2026-06-24) |
| Caracterización de las 6 instancias base de P9 por opción de compra | `fcbe2755-98af-4d5d-8e91-b2d13ba58f0a` | esta auditoría (2026-06-24) |
| Cómputo Aurora no-prod Helios (base P5 = $851,14) | `ae9be23b-5623-486d-84b7-008039929608` | esta auditoría (2026-06-24) |
| Partición no-prod por cuenta × opción (base P10) | `db76fe8a-090f-4808-ac47-967e932456ae` | `palanca-10` (EV-12.1) |
| Disyunción P10 ↔ conjunto estable P1 | `5c394e67-22d2-4955-ad5d-0707137c8cf4` | `palanca-10` (EV-12.1) |
| Segmentación estable/intermitente no-prod (barrido) | `96e7baa8-83b3-4190-92d5-20842d2a0889` | `barrido-16-3` |
| Conjunto estable RDS por cuenta (reconciliación P2/P5) | `837da239-7c97-41a5-8186-3f1f5dc2f9b9` | `barrido-16-1` |
| Base P5 congelada (Aurora Helios) | `ac82037a-2731-430c-b129-8dc310bdff45` | `palanca-05` (EV-7.1) |

> Helper de re-ejecución: `auditoria/_athena_run.sh "<SQL>"` (perfil `root-iskaypet`, `eu-west-1`, DB
> `athenacurcfn_finnops`, salida `s3://finnops-iskaypet/athena-query-results/`). Credenciales
> referenciadas por **nombre de perfil**, sin incrustar (Req 7.5). Todas las consultas son de **solo
> lectura** sobre el CUR.

---

## 5. Hallazgos y recomendaciones (no bloquean el veredicto)

1. **(P1 ↔ P9 — obligatorio en el Informe) No-aditividad de compromiso y rightsizing.** 5 de las 6
   instancias base de P9 (SAP `r6a.4xlarge`/`m6i.4xlarge`/`c5a.2xlarge`, data `m6id.xlarge`, infra
   `m5.2xlarge`) coinciden con el conjunto estable de P1 ($3 656,37 de la base de P1 / ~$3 669,26 de la
   de P9). Sus rangos Estimado **no deben sumarse** como independientes. El Informe debe: (a) presentar
   P1 y P9 con una nota de interacción; (b) si P9 se eleva a objetivo tras el Barrido (RAM), recomputar
   el compromiso de P1 sobre la capacidad **ya redimensionada** (secuencia rightsize → commit) para
   mantener la disyunción de unidades de coste.
2. **(Salvaguarda vigente) P9 fuera del objetivo.** La exclusión de P9 del `Objetivo_Comprometido` (por
   barrido pendiente al 100 %, sin p95 de RAM) es lo que **hoy** evita el doble conteo en la cifra
   comprometida. Si se instrumenta la RAM y P9 se eleva, aplicar el punto 1 **antes** de comprometer.
3. **(clinicanimal `i-01df3007e1dc5a4ad`) Caso correcto de disyunción por horas.** Su on_demand (573,06 h)
   queda **por debajo** del umbral estable (669,6 h) por estar parcialmente SP-cubierta → **no** entra en
   P1; correctamente disponible para P9 sin solape con el compromiso de P1.
4. **(P2 ↔ P5) Helios prod permanece en P2.** Solo dev+uat ($851,14, 4 ARN) van a P5; helios-prod
   ($425,57) sigue en la base direccionable de P2. Mantener esta frontera al actualizar el barrido.

## 6. Re-ejecución de la auditoría (procedimiento)

1. Re-ejecutar las 3 consultas de §2 con `auditoria/_athena_run.sh` → obtener el conjunto estable de P1
   (18 recursos, Σ ≈ 4 813,47), la opción de compra de las 6 instancias de P9 y la base P5 ($851,14).
2. Comprobar **INV-A** Palanca 6: `795,76 + 402,93 + 232,20 = 1 430,89` (diferencia 0,00).
3. Comprobar **INV-B 2.1**: cuentas de P10 {eks-dev, eks-uat, data-dev} ∉ conjunto estable de P1 → `∩ = ∅`.
4. Comprobar **INV-B 2.2**: 4 ARN Aurora no-prod ($851,14) ∉ base direccionable de P2 (restados, → P5).
5. Comprobar **INV-B 2.3**: 5/6 instancias de P9 ∈ estable de P1 → confirmar que P9 sigue **excluida**
   del objetivo (barrido pendiente); si se eleva, aplicar la secuenciación del Hallazgo 1.
6. Cualquier diferencia distinta de la esperada indica drift del `Dataset_Congelado` o reexpresión del
   CUR (Req 7.3, 7.4) → investigar antes de publicar.

## 7. Estado de ejecución

- ✅ **Auditoría ejecutada** sobre el `Catálogo_Evidencias` y el `Dataset_Congelado`
  `frozen-2026-05@2026-06-23`, con re-ejecución de las consultas de cruce en Athena (perfil
  `root-iskaypet`, `eu-west-1`) el `2026-06-24`. `QueryExecutionId` retenidos en §4.
- ✅ **INV-A (conservación Sub_Palancas, Palanca 6): PASS** (diferencia `0,00 USD`; gp2 huérfano
  de-duplicado).
- ✅ **INV-B 2.1 (P1 vs P10): PASS** (disjuntos por horas y recurso).
- ✅ **INV-B 2.2 (P2 vs P5): PASS** ($851,14 Helios no-prod fuera de la base de P2, enrutado a P5).
- ⚠️ **INV-B 2.3 (P1 vs P9): PASS con caveat** (solape de 5/6 recursos; sin doble conteo en el objetivo
  porque P9 está excluida; rangos Estimado no aditivos → Hallazgo 1).
- ✅ **VEREDICTO Property 7 (Req 3.4, 8.8): PASS** con el caveat de no-aditividad P1↔P9 documentado.
- Re-ejecutable: re-correr §6 produce el mismo veredicto mientras el `Dataset_Congelado` y los artefactos
  fuente no cambien.
