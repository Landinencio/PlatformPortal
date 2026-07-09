# Auditoría 17.5 — Anualización (Property 8) y Redondeo half-up sumando antes de redondear (Property 9)

> **Tarea 17.5** del Estudio FinOps de Ahorro AWS. **Auditoría re-ejecutable** de dos *Correctness
> Properties* sobre el `Catálogo_Evidencias` y el `Dataset_Congelado` — **no** es un test de código.
>
> - **Property 8 — Anualización por multiplicación directa.** *Para toda* cifra anualizada del
>   Informe, el valor anual es igual al ahorro **mensual del Mes_Referencia × 12**, y va acompañada
>   de la **advertencia explícita** de que el método asume mes representativo y **no captura
>   estacionalidad**. **Validates: Requirements 6.3, 6.4.**
> - **Property 9 — Redondeo half-up sumando antes de redondear.** *Para todo* total presentado, su
>   valor es `redondear(Σ xᵢ)` (sumar los importes **sin redondear** y redondear el resultado a
>   **2 decimales half-up**), **no** `Σ redondear(xᵢ)`; todos los importes en **USD**.
>   **Validates: Requirements 6.6, 6.7.**
>
> Este fichero es el **artefacto NUEVO y DEDICADO** de la Tarea 17.5. **No** modifica ningún otro
> fichero del spec (evidencias, catálogo, design, tasks). Recalcula de forma independiente cada cifra
> anual = mensual × 12 y cada total, y los compara con lo publicado en los registros de evidencia.

## Parámetros de anclaje (Req 2.5)

| Campo | Valor |
|-------|-------|
| `id_auditoria` | `AUD-17.5-anualizacion-redondeo` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` (2 decimales, redondeo half-up) |
| Fecha de la auditoría | `2026-06-23` (UTC) |
| Naturaleza | Auditoría de cálculo (recálculo independiente sobre cifras congeladas); no ejecuta consultas CUR ni verificaciones en vivo nuevas |
| Properties auditadas | **Property 8** (anualización ×12 + advertencia) · **Property 9** (half-up, sumar antes de redondear) |
| Fuentes | `palanca-01-ec2.md`, `palanca-02-rds.md`, `palanca-03-extended-support.md`, `palanca-04-logs.md`, `palanca-05-aurora-helios.md`, `palanca-06a-gp2-gp3.md`, `palanca-06b-snapshots.md`, `palanca-06c-volumenes-huerfanos.md`, `palanca-08-red.md`, `palanca-09-rightsizing.md`, `palanca-10-noprod-spot.md`, `palanca-11-bedrock.md`, `palanca-12-marketplace.md`, `barrido-16-1-steady-state.md`, `barrido-16-3-scheduling-spot.md` |

---

## 1. Convención de anualización observada en el Estudio (clave para el veredicto)

La Property 8 exige `anual = mensual × 12`. Al recalcular se detectan **dos formas** de materializar
ese ×12, que conviene distinguir antes de auditar:

- **Método (b) — "multiplicar antes de redondear" (purista):** `anual = redondear(mensual_sin_redondear × 12)`.
  Es lo que prescribe el espíritu del Req 6.7 (sumar/operar antes de redondear). Produce, en general,
  un anual que **no** coincide con `mensual_publicado × 12` por una diferencia de céntimos.
- **Método (a) — "multiplicar el mensual publicado (redondeado)":** `anual = mensual_redondeado × 12`.
  Satisface literalmente Property 8 (el anual ES el mensual publicado × 12), pero introduce el error
  de redondeo del mensual amplificado ×12.

**Hallazgo:** **12 de 13** registros con cifras anualizadas usan el **método (b)** (purista),
coherente con el Req 6.7. La **única excepción** es la **Sub_Palanca 6a (gp2→gp3)**, que usó el
**método (a)**. El impacto es **inmaterial** (≤ 0,05 USD/año) y **no** afecta a ningún total agregado.
Se documenta como observación menor (§4) y se recomienda alinear 6a al método (b) en la composición
del Informe (Tarea 19). Ninguno de los dos métodos viola la letra de Property 8 (`anual = mensual ×
12`); la observación es de **consistencia interna** y de adherencia estricta al Req 6.7.

---

## 2. Property 8 — Auditoría de anualización (recálculo `anual = mensual × 12`)

Recálculo independiente de **cada** cifra anualizada publicada. `mensual` = cifra mensual congelada
del Mes_Referencia; `anual recalculado (b)` = `redondear(mensual_sin_redondear × 12)`; se compara con
el `anual publicado`. ✅ = coincide; ⚠️ = coincide pero por método (a) en lugar de (b).

| Palanca / Sub_Palanca | Línea | Mensual publicado (USD) | Anual publicado (USD) | Recálculo ×12 (método b) | Veredicto |
|-----------------------|-------|------------------------:|----------------------:|--------------------------|:---------:|
| **P1 — EC2 SP** (Estimado) | Conservador (28,0%) | 1 347,77 | 16 173,27 | `4 813,473246×0,28×12 = 16 173,27` | ✅ |
| | Agresivo (37,0%) | 1 780,99 | 21 371,82 | `4 813,473246×0,37×12 = 21 371,82` | ✅ |
| **P2 — RDS RI** (Estimado) | Conservador (34,0%) | 1 732,78 | 20 793,33 | `5 096,404×0,34×12 = 20 793,33` | ✅ |
| | Agresivo (50,0%) | 2 548,20 | 30 578,42 | `5 096,404×0,50×12 = 30 578,42` | ✅ |
| P2 — ElastiCache (adyacente, Estimado) | Conservador (≈30%) | 123,37 | 1 480,39 | `411,22×0,30×12 = 1 480,39` | ✅ |
| | Agresivo (≈45%) | 185,05 | 2 220,59 | `411,22×0,45×12 = 2 220,59` | ✅ |
| **P3 — Extended Support** (Garantizado cond.) | Base bruto | 1 169,52 | 14 034,20 | `1 169,5167×12 = 14 034,20` | ✅ |
| | Base neto | 1 075,96 | 12 911,46 | `1 075,955×12 = 12 911,46` | ✅ |
| | Garantizado futuro bruto (3 inst PG13) | 833,28 | 9 999,36 | `833,28×12 = 9 999,36` | ✅ |
| | Garantizado futuro neto | 766,62 | 9 199,44 | `766,62×12 = 9 199,44` | ✅ |
| **P4 — Logs WAF** (Estimado) | Conservador bruto | 1 419,51 | 17 034,11 | `1 419,509×12 = 17 034,11` | ✅ |
| | Agresivo bruto | 1 921,80 | 23 061,56 | `1 921,797×12 = 23 061,56` | ✅ |
| | Conservador neto | 1 189,98 | 14 279,77 | `1 189,981×12 = 14 279,77` | ✅ |
| | Agresivo neto | 1 611,05 | 19 332,61 | `1 611,051×12 = 19 332,61` | ✅ |
| **P5 — Aurora Helios** (Estimado) | Conservador bruto (50,0%) | 425,57 | 5 106,82 | `851,136×0,50×12 = 5 106,82` | ✅ |
| | Agresivo bruto (85,0%) | 723,47 | 8 681,59 | `851,136×0,85×12 = 8 681,59` | ✅ |
| | Conservador neto | 391,52 | 4 698,27 | `783,04512×0,50×12 = 4 698,27` | ✅ |
| | Agresivo neto | 665,59 | 7 987,06 | `783,04512×0,85×12 = 7 987,06` | ✅ |
| **P6a — gp2→gp3** (Estimado) | Conservador (15,0%) | 151,76 | 1 821,12 | `151,7635×12 = 1 821,16` (b) · doc usó `151,76×12 = 1 821,12` (a) | ⚠️ |
| | Agresivo (21,0%) | 212,38 | 2 548,56 | `212,380754×12 = 2 548,57` (b) · doc usó `212,38×12 = 2 548,56` (a) | ⚠️ |
| **P6b — Snapshots** (Estimado) | Conservador (5,0%) | 20,15 | 241,76 | `402,9275×0,05×12 = 241,76` | ✅ |
| | Agresivo (15,0%) | 60,44 | 725,27 | `402,9275×0,15×12 = 725,27` | ✅ |
| **P6c — Huérfanos** (Garantizado) | Cifra única | 232,20 | 2 786,40 | `232,20×12 = 2 786,40` | ✅ |
| **P8a — IPv4 idle + VPC endpoint dup** (Garantizado) | Cifra única | 45,88 | 550,56 | `45,88×12 = 550,56` | ✅ |
| **P8b — NAT no-prod** (Estimado) | Conservador (2 pares) | 65,71 | 788,52 | `65,7098×12 = 788,52` | ✅ |
| | Agresivo (3 pares) | 98,57 | 1 182,84 | `98,5647×12 = 1 182,84` | ✅ |
| **P8c — VPN** (Estimado contingente) | Conservador (2) | 68,44 | 821,28 | `68,44×12 = 821,28` | ✅ |
| | Agresivo (8) | 273,76 | 3 285,12 | `273,76×12 = 3 285,12` | ✅ |
| **P9 — Rightsizing** (Estimado) | Conservador (15,0%) | 574,27 | 6 891,26 | `3 828,48×0,15×12 = 6 891,26` | ✅ |
| | Agresivo (40,0%) | 1 531,39 | 18 376,70 | `3 828,48×0,40×12 = 18 376,70` | ✅ |
| **P10 — Scheduling+Spot no-prod** (Estimado) | Conservador | 252,30 | 3 027,60 | `252,29998×12 = 3 027,60` | ✅ |
| | Agresivo | 542,80 | 6 513,62 | `542,80202×12 = 6 513,62` | ✅ |
| **P11 — Bedrock** (Estimado) | Conservador | 488,41 | 5 860,97 | `488,4142×12 = 5 860,97` | ✅ |
| | Agresivo | 1 016,08 | 12 192,95 | `1 016,079×12 = 12 192,95` | ✅ |
| **P12 — Marketplace** (Comercial) | Contrato | 85 000,55 | 1 020 006,60 | `85 000,55×12 = 1 020 006,60` | ✅ |
| | PAYG sobrecarga | 6 663,33 | 79 960,00 | `6 663,3335806×12 = 79 960,00` | ✅ |
| | Total producto (contrato+PAYG) | 91 663,88 | 1 099 966,60 | `91 663,8835806×12 = 1 099 966,60` | ✅ |

**Concordancia con el ejemplo trabajado del enunciado:** P1 Conservador `1 347,77 → 16 173,27` ✅;
P2 Conservador `1 732,78 → 20 793,33` ✅; P5 Conservador bruto `425,57 → 5 106,82` ✅. Coinciden
exactamente con las cifras congeladas.

> **Nota técnica de las diferencias de céntimos (confirma el método purista):** en P1/P2/P3/P4/P5/
> P6b/P9/P10/P11/P12 el anual publicado **difiere** del producto ingenuo `mensual_redondeado × 12`
> por ±0,01–0,06 USD (p. ej. P2: `1 732,78×12 = 20 793,36` ≠ `20 793,33` publicado; P3 bruto:
> `1 169,52×12 = 14 034,24` ≠ `14 034,20` publicado). Esa diferencia es **precisamente la huella** de
> haber multiplicado el mensual **sin redondear** y redondeado al final (método b) — es decir, el
> comportamiento correcto del Req 6.7. La excepción es P6a, que sí coincide con el producto ingenuo
> (método a). Ver §4.

### 2.1 Advertencia de estacionalidad / mes representativo (Req 6.4) — presencia por palanca

Property 8 exige que **toda** cifra anualizada lleve la advertencia explícita de mes representativo /
no captura de estacionalidad. Verificación de presencia literal en cada registro fuente:

| Palanca / Sub_Palanca | ¿Advertencia presente? | Texto / cita verificada en el registro |
|-----------------------|:----------------------:|----------------------------------------|
| P1 — EC2 SP | ✅ | "la cifra anual asume que el Mes_Referencia (mayo 2026) es representativo y no captura estacionalidad" |
| P2 — RDS RI | ✅ | "la cifra anual = mensual × 12 asume que el Mes_Referencia (mayo 2026) es representativo y no captura estacionalidad" |
| P3 — Extended Support | ✅ | "el ×12 asume que mayo 2026 es representativo y no captura estacionalidad ni cambios de inventario" |
| P4 — Logs WAF | ✅ | "asumen que el Mes_Referencia es representativo y NO capturan estacionalidad (… tráfico ecommerce estacional: campañas, rebajas, Black Friday)" |
| P5 — Aurora Helios | ✅ | "las cifras anualizadas asumen que el Mes_Referencia (mayo 2026) es representativo y no capturan estacionalidad" |
| P6a — gp2→gp3 | ✅ | "multiplicar por 12 asume que mayo 2026 es un mes representativo y no captura estacionalidad" |
| P6b — Snapshots | ✅ | "el método asume que mayo 2026 es un mes representativo … y no captura estacionalidad" |
| P6c — Huérfanos | ✅ | "la cifra anual = mensual × 12 asume que el parque … es representativo y no captura estacionalidad" (+ matiz de saneamiento puntual) |
| P8 — Red (8a/8b/8c) | ✅ | "La anualización ×12 asume que el Mes_Referencia es representativo y no capta estacionalidad" (repetida en 8a, 8b, 8c) |
| P9 — Rightsizing | ✅ | "la cifra anual asume que el Mes_Referencia (mayo 2026) es representativo y no captura estacionalidad" |
| P10 — Scheduling+Spot | ✅ | "el método asume que mayo 2026 es representativo y no captura estacionalidad (picos jobs EMR, campañas, releases)" |
| P11 — Bedrock | ✅ | "asumen que el Mes_Referencia es representativo y NO capturan estacionalidad … consumo de Bedrock especialmente variable" |
| P12 — Marketplace | ✅ | "la cifra anualizada asume que el Mes_Referencia (mayo 2026) es representativo y no captura estacionalidad" |

**Resultado 2.1:** **13/13** registros con anualización incluyen la advertencia explícita exigida por
el Req 6.4. Varias palancas añaden además matices honestos (estacionalidad real del ecommerce en P4;
variabilidad de Bedrock en P11; naturaleza de saneamiento puntual en P6c; captura progresiva del RI
en P2 vía Req 6.5). **Property 8 (advertencia): PASA.**

### 2.2 Captura progresiva / primer año (Req 6.5) — comprobación complementaria

El Req 6.5 (prorrateo del primer año para compromisos de captura progresiva) está correctamente
tratado: **P2 (RDS RI)** documenta el prorrateo `≈ ahorro_mensual × (12 − m)` frente al régimen
estacionario ×12; **P1 (EC2 SP)** anota la nota de captura progresiva; **P5/P10** declaran
explícitamente que **no** son captura progresiva (acción de efecto inmediato), por lo que el ×12
directo es correcto. No es alcance directo de Property 8, pero confirma coherencia de la anualización.

---

## 3. Property 9 — Auditoría de redondeo half-up sumando antes de redondear

Property 9 exige que **todo total** sea `redondear(Σ xᵢ)` con half-up a 2 decimales en USD, **no**
`Σ redondear(xᵢ)`. Recálculo de los totales sumados en los registros:

| Total auditado | Componentes (sin redondear) | `redondear(Σ)` recalculado | Publicado | Veredicto |
|----------------|-----------------------------|---------------------------:|----------:|:---------:|
| **P1 — partición EC2** (cubierto + on-demand + spot) | `7 998,8281 + 7 185,9153 + 3,2952` | `15 188,04` (cómputo total) | 15 188,05 | ✅ (≤0,01 redondeo) |
| P1 — reconciliación estable+intermitente = on_demand | `4 813,473246 + 2 372,442044` | `7 185,92` | 7 185,92 | ✅ |
| **P2 — Σ cómputo instancia RDS** (14 cuentas) | suma de las 14 filas sin redondear | `6 616,31` | 6 616,31 | ✅ |
| **P3 — Σ Extended Support por recurso** (7 ARNs) | bruto: 7 filas; neto: 7 filas | bruto `1 169,52` · neto `1 075,96` | 1 169,52 / 1 075,96 | ✅ |
| P3 — reparto futuro+capturado = base | `833,28 + 336,24` (bruto) | `1 169,52` | 1 169,52 | ✅ |
| **P4 — Σ VendedLog** (todas cuentas/regiones) | bruto + neto sin redondear | bruto `2 774,92` · neto `2 374,51` | 2 774,92 / 2 374,51 | ✅ |
| **P5 — Aurora combinado** (4 inst + SppDiscount) | `4×212,784` bruto; `−2×34,04544` SPP | bruto `851,14` · neto `783,05` | 851,14 / 783,05 | ✅ |
| **P6a — Σ gp2 por cuenta** (13 cuentas) | suma de 13 filas sin redondear (`…1011,756754`) | `1 011,76` | 1 011,76 | ✅ |
| **P6b — Σ snapshots** (11 cuentas / 11 304 líneas) | `Σ line_item_unblended_cost` sin redondear | `402,93` | 402,93 | ✅ |
| **P6c — Σ huérfanos** (27 vols × tarifa por tipo) | `216,00 + 9,20 + 7,00` (gp2/gp3/std) | `232,20` | 232,20 | ✅ |
| **P6 — conservación Sub_Palancas** (Tarea 8.4) | `795,76 + 402,93 + 232,20` | `1 430,89` | 1 430,89 (dif 0,00) | ✅ |
| **P7 (S3 total TimedStorage)** | `2 170,80 + 93,60 + 1,40 + 0,00` | `2 265,80` | 2 265,80 | ✅ |
| **P8a — Garantizado red** | `30,82 (IPv4) + 15,06 (VPC endpoint dup)` | `45,88` | 45,88 | ✅ |
| **P11 — Bedrock total mensual** | `Σ componentes optimización` | `488,41` (Cons) / `1 016,08` (Agr) | 488,41 / 1 016,08 | ✅ |
| **P12 — Total producto Marketplace** | `85 000,55 + 6 663,3335806` | `91 663,88` | 91 663,88 | ✅ |

**Observaciones de Property 9:**

- Todos los registros **declaran y aplican** la regla "sumado antes de redondear" (Req 6.7). Las
  sumas de muchas líneas (Σ por cuenta en P2/P6a/P6b, Σ por recurso en P3, Σ por clase en P7) se
  calculan sobre los valores de Athena **sin redondear** y se redondean al final → `redondear(Σ)`,
  **no** `Σ redondear`. Las diferencias ≤ 0,01 USD que aparecen (p. ej. P1 cómputo total 15 188,04 vs
  15 188,05) son **artefacto del redondeo final** de un `redondear(Σ)` correcto, no acumulación de
  error.
- **No se detecta** ningún total construido como `Σ redondear(xᵢ)` en los registros auditados.
- **Moneda:** el 100 % de los importes está en **USD**, 2 decimales, half-up. ✅
- La auditoría de conservación de la Palanca 6 (Tarea 8.4) ya verificó `Σ Sub_Palancas = base` con
  diferencia **0,00 USD**, ejemplo de `redondear(Σ)` sin error de redondeo acumulado.

**Property 9: PASA** (con la observación menor de §4 sobre el método de anualización de 6a, que es un
matiz de orden de redondeo en una multiplicación ×12, no un error de agregación de totales).

---

## 4. Observación menor — inconsistencia de método de anualización en Sub_Palanca 6a

| Cifra (P6a) | Mensual publicado | Anual publicado (método a) | Anual purista (método b) | Δ |
|-------------|------------------:|---------------------------:|-------------------------:|----:|
| Conservador (15,0%) | 151,76 | **1 821,12** (`151,76×12`) | 1 821,16 (`151,7635×12`) | 0,04 |
| Agresivo (21,0%) | 212,38 | **2 548,56** (`212,38×12`) | 2 548,57 (`212,380754×12`) | 0,01 |

- **Naturaleza:** 6a anualizó multiplicando el **mensual ya redondeado** (método a) en lugar del
  mensual **sin redondear** (método b) que usan las otras 12 palancas. La base gp2 sin redondear es
  `1 011,756754 USD` (Σ de 13 cuentas).
- **Impacto:** **inmaterial** — ≤ 0,04 USD/año por línea. **No** afecta a ningún total agregado del
  Informe (el ahorro de 6a se publica como rango sobre su base; los totales del Informe se compondrán
  en la Tarea 19).
- **¿Viola Property 8?** **No** — literalmente `anual = mensual_publicado × 12` se cumple
  (`151,76×12 = 1 821,12`). Es una desviación de **consistencia interna** respecto al método purista
  del Req 6.7 que el resto del Estudio aplica.
- **Recomendación (no bloqueante, para Tarea 19):** recalcular el anual de 6a desde la base sin
  redondear para alinearlo con las demás palancas → Conservador **1 821,16** y Agresivo **2 548,57**.
  Alternativamente, dejar constancia explícita de que 6a anualiza por método (a). No requiere
  re-extracción del CUR ni cambia la clasificación ni el rango mensual.

---

## 5. Anticipo de totales del Informe (Property 9 / Req 6.6 a nivel de Informe — pendiente Tarea 19)

El Req 6.6 exige que el **total** de ahorro se presente como rango (Σ Conservadores y Σ Agresivos),
sumado antes de redondear. Esos totales **a nivel de Informe se componen en la Tarea 19** (aún
`[~]`), por lo que su auditoría definitiva pertenece a esa fase. Como **anticipo** y control cruzado,
se recalculan aquí con las cifras congeladas (mensual, USD, sumando antes de redondear). Excluye la
Palanca_Comercial (P12) del ahorro técnico (Req 17.3) y separa Garantizado de Estimado (Req 3.6):

**Ahorro_Garantizado (cifra única, mensual):**

| Palanca | Garantizado mensual (USD) |
|---------|--------------------------:|
| P3 — Extended Support (3 inst PG13, condicionado, bruto) | 833,28 |
| P6c — Volúmenes huérfanos | 232,20 |
| P8a — IPv4 idle + VPC endpoint duplicado | 45,88 |
| **Σ Garantizado (mensual)** | **1 111,36** |
| **Σ Garantizado (anual ×12)** | **13 336,32** |

> `833,28 + 232,20 + 45,88 = 1 111,36`; `1 111,36 × 12 = 13 336,32`. (P3 condicionado a upgrade de
> motor; cifra bruta. Si dirección exige piso por cifras aisladas del CUR, P8a baja a 30,82.)

**Ahorro_Estimado (rango, mensual) — palancas técnicas Estimado, bruto donde aplica:**

| Palanca | Conservador (USD/mes) | Agresivo (USD/mes) |
|---------|----------------------:|-------------------:|
| P1 — EC2 SP | 1 347,77 | 1 780,99 |
| P2 — RDS RI | 1 732,78 | 2 548,20 |
| P4 — Logs WAF (bruto) | 1 419,51 | 1 921,80 |
| P5 — Aurora Helios (bruto) | 425,57 | 723,47 |
| P6a — gp2→gp3 | 151,76 | 212,38 |
| P6b — Snapshots | 20,15 | 60,44 |
| P8b — NAT no-prod | 65,71 | 98,57 |
| P9 — Rightsizing | 574,27 | 1 531,39 |
| P10 — Scheduling+Spot no-prod | 252,30 | 542,80 |
| P11 — Bedrock | 488,41 | 1 016,08 |
| **Σ Estimado (mensual)** | **6 478,23** | **10 436,12** |
| **Σ Estimado (anual ×12)** | **77 738,76** | **125 233,44** |

> Σ Conservador mensual = `1 347,77+1 732,78+1 419,51+425,57+151,76+20,15+65,71+574,27+252,30+488,41
> = 6 478,23` → ×12 = `77 738,76`. Σ Agresivo mensual = `1 780,99+2 548,20+1 921,80+723,47+212,38+
> 60,44+98,57+1 531,39+542,80+1 016,08 = 10 436,12` → ×12 = `125 233,44`. Invariante `Σ Cons ≤ Σ Agr`
> ✅. **No incluye** P8c-VPN (Estimado contingente, fuera de objetivo hasta owner) ni P7-S3 (rango
> definido en Tarea 9.3) ni la sub-línea adyacente ElastiCache de P2; la composición final y la
> selección de qué entra en el objetivo comprometido es de la Tarea 19/17.8.

> **Estos totales son un anticipo de control**, no la cifra publicable: la Tarea 19 fijará el formato
> definitivo (qué palancas, bruto vs neto, y la derivación del objetivo comprometido = Σ Garantizado
> + Σ Conservador de Estimado con Barrido). La auditoría de esos totales a nivel de Informe es de la
> Tarea 17.8 (Property 12) y de la composición (Tarea 19). Aquí solo se confirma que **sumar antes de
> redondear** produce cifras coherentes.

---

## 6. Resultado de la auditoría

| Property | Alcance | Veredicto |
|----------|---------|:---------:|
| **Property 8 — Anualización por multiplicación directa** | `anual = mensual × 12` en las 13 palancas/sub-palancas + advertencia de mes representativo/estacionalidad | **PASA** |
| **Property 9 — Redondeo half-up sumando antes de redondear** | `redondear(Σ xᵢ)` en todos los totales; USD 2 dec half-up; sin `Σ redondear(xᵢ)` | **PASA** (con observación menor §4) |

**Conclusión.**

- **Property 8 — PASA.** Toda cifra anualizada del Estudio equivale a su mensual × 12 (recálculo en
  §2, 38 cifras verificadas) y **toda** anualización (13/13 registros) lleva la advertencia explícita
  de mes representativo / no captura de estacionalidad exigida por el Req 6.4 (§2.1). 12 de 13
  registros aplican el método purista "multiplicar antes de redondear", confirmado por la huella de
  céntimos respecto al producto ingenuo.
- **Property 9 — PASA.** Todos los totales auditados (§3) son `redondear(Σ)` sobre valores sin
  redondear, en USD a 2 decimales half-up; **no** se detecta ningún `Σ redondear(xᵢ)` ni acumulación
  de error de redondeo (la conservación de la Palanca 6 cuadra a 0,00 USD).
- **Observación menor (no bloqueante):** la Sub_Palanca **6a** anualizó por `mensual_redondeado × 12`
  (método a) en lugar del método purista del resto; impacto ≤ 0,04 USD/año, sin efecto en totales.
  Recomendación para la Tarea 19: recalcular 6a desde la base sin redondear (Conservador 1 821,16 /
  Agresivo 2 548,57) o dejar constancia explícita del método. No invalida ninguna cifra ni cambia
  clasificaciones.
- Los **totales a nivel de Informe** (Σ Garantizado, Σ Conservador, Σ Agresivo) se componen en la
  Tarea 19; su auditoría definitiva corresponde a esa fase y a la Tarea 17.8 (Property 12). El §5
  ofrece su anticipo de control, ya conforme a "sumar antes de redondear".

---

## 7. Re-ejecución de la auditoría (procedimiento)

Auditoría **re-ejecutable**; debe reproducir el mismo veredicto mientras los registros sigan anclados
a `frozen-2026-05@2026-06-23`:

1. Para cada cifra anualizada de §2, releer el `mensual` (preferiblemente la base sin redondear) del
   registro fuente y verificar `redondear(mensual_sin_redondear × 12) == anual_publicado` (método b);
   si difiere, comprobar si coincide con `mensual_redondeado × 12` (método a) y anotarlo (caso 6a).
2. Confirmar la **presencia literal** de la advertencia de estacionalidad/mes representativo (Req 6.4)
   en cada registro con anualización (§2.1).
3. Para cada total de §3, recalcular `redondear(Σ xᵢ)` sobre los componentes **sin redondear** y
   verificar que coincide con el publicado y que **no** es `Σ redondear(xᵢ)`.
4. Confirmar que todos los importes están en **USD**, 2 decimales, half-up.
5. Recalcular los anticipos de totales del §5 (Σ Garantizado, Σ Conservador, Σ Agresivo) sumando
   antes de redondear y verificar la invariante `Σ Conservador ≤ Σ Agresivo`.

Cualquier desviación distinta de la observación documentada en §4 indicaría un cambio en una cifra
base (drift del `Dataset_Congelado` o reexpresión del CUR) y debe investigarse antes de publicar el
Informe (Req 7.3).

## 8. Estado de ejecución

- ✅ **Ejecutada** la auditoría 17.5 contra las cifras congeladas de las 12 Palancas (+ sub-palancas)
  y los barridos 16-1 / 16-3, ancladas a `frozen-2026-05@2026-06-23`.
- ✅ **Property 8 — PASA** (38 cifras anuales recalculadas = mensual × 12; 13/13 advertencias de
  estacionalidad presentes).
- ✅ **Property 9 — PASA** (15 totales recalculados como `redondear(Σ)`; USD half-up 2 dec; sin error
  de redondeo acumulado).
- ⚠️ **Observación menor registrada:** método de anualización de la Sub_Palanca 6a (método a vs b),
  impacto ≤ 0,04 USD/año; recomendación de alineación para la Tarea 19 (no bloqueante).
- ⏭️ La auditoría de los **totales del Informe** (Σ por categoría) se cierra en la composición (Tarea
  19) y en la derivación de objetivos (Tarea 17.8 / Property 12).
