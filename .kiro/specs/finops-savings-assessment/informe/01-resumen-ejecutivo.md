# Informe FinOps de Ahorro AWS — 01 · Resumen Ejecutivo

> **Tarea 19.1** del Estudio FinOps de Ahorro AWS. Primera pieza del **Informe** (Req 19.1: el
> Informe se estructura como *resumen ejecutivo* + *tabla por Palanca* + *anexo de evidencias*).
> Este fichero es el **artefacto NUEVO y DEDICADO** del resumen ejecutivo; **no** modifica ningún
> otro fichero del spec (requirements, design, tasks, evidencias, catálogo, auditorías).
>
> **Validates: Requirements 19.1, 19.2, 19.5, 3.6, 6.6.**
>
> Audiencia: SRE Lead → dirección. Todas las cifras están **ancladas** al `Dataset_Congelado`
> `frozen-2026-05@2026-06-23` (Mes_Referencia `2026-05`, moneda **USD**, 2 decimales half-up,
> **sumando antes de redondear** — Req 6.7) y **cada una referencia su `id_evidencia`** en el
> `Catálogo_Evidencias` (Req 19.5). Cifras auditadas (todas **PASS**) en las auditorías 17.1–17.8.

---

## Parámetros de anclaje

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Fecha de extracción del CUR | `2026-06-23T07:55:14Z` (UTC) |
| Fecha de las `Verificacion_Recurso_Vivo` | `2026-06-23` (UTC) — mismo día que la extracción (frescura 0 días, Req 3.2) |
| Moneda | `USD` (2 decimales, redondeo half-up, suma antes de redondear — Req 6.7) |
| Completitud del Mes_Referencia | `31/31 días = 100,0 %` (`EV-1.2-completitud-2026-05`) → cifras base definitivas |

---

## 1. Marco contable de la organización (Req 19.2)

| Concepto | Importe (USD/mes) | `id_evidencia` | Tratamiento |
|----------|------------------:|----------------|-------------|
| **Coste total de la organización** (bruto = neto) | **148 553,36** | `E1.1-TOTAL` | Marco de referencia (30 cuentas con coste + 2 Animalis a 0; 32 en alcance) |
| **Coste de infraestructura AWS direccionable** (Usage, excl. marketplace) | **48 320,13** bruto · 44 484,97 neto | `E1.1-INFRA` | **Denominador del ahorro técnico** |

> La infraestructura direccionable (`48 320,13`/mes) es el **denominador** sobre el que se mide la
> oportunidad técnica: representa el **32,5 %** del coste total de la organización. El resto del total
> (`100 233,22`/mes) queda **fuera del alcance de ahorro técnico** y se compone de: contrato
> Marketplace `85 000,55` (`E1.1-MKT-CONTRACT`), PAYG del mismo producto `6 663,33` (`E1.1-PAYG`),
> Tax `9 448,99` (`E1.1-TAX`), suscripciones Kiro `904,73` (`E1.1-FLATRATE`) y el puente Savings
> Plans / descuentos `−1 784,38` (`E1.1-SP-BRIDGE`). La partición es exhaustiva y disjunta
> (conservación contable verificada — Property 1, `EV-1.4-conservacion-2026-05`).

---

## 2. Ahorro_Garantizado — desperdicio puro verificado en vivo (Req 3.6)

Ahorro derivado de **desperdicio puro**, eliminable sin pérdida de capacidad y **confirmado contra el
recurso vivo** (frescura 0 días ≤ 30 — Req 3.2). Se presenta como **cifra única** y **por separado**
del Ahorro_Estimado (Req 3.6). Auditado en 17.3 (Property 6: **PASS**).

| (Sub_)Palanca Garantizado | USD/mes | USD/año (×12) | `id_evidencia` | Verificación viva |
|---------------------------|--------:|--------------:|----------------|-------------------|
| **P3 — Extended Support RDS** (3 inst. prod/tooling PG13) | 833,28 | 9 999,36 | `EV-5.1-extended-support-2026-05` · `EV-5.3-extended-support-clasificacion-2026-06-23` | `EV-5.2-...` (`confirmado`) |
| **P6c — Volúmenes EBS huérfanos** (27 vols `available`) | 232,20 | 2 786,40 | `EV-8.3-ebs-volumenes-huerfanos-2026-05` | incluida (`confirmado`) |
| **P8a — IPv4 idle (7 EIP) + VPC endpoint duplicado** | 45,88 | 550,56 | `EV-10.1-red-2026-05` (+ verif. viva Tarea 10.2) | `confirmado` |
| **Σ Ahorro_Garantizado** | **1 111,36** | **13 336,32** | — | — |

`833,28 + 232,20 + 45,88 = 1 111,36` (sumado antes de redondear); `1 111,36 × 12 = 13 336,32`.

**Notas (trazabilidad, no afectan al veredicto):**
- **P3 condicionado** a upgrade de motor + validación de compatibilidad de la aplicación (Req 9.4,
  9.5). El ahorro futuro se duplicaría (salto a tramo Año 3) si el upgrade se retrasa más allá de
  `2028-02-28` → **priorizar**.
- **P8a — doble lectura de la cifra:** `45,88`/mes por defecto (IPv4 idle `30,82` aislada del CUR +
  VPC endpoint duplicado `15,06` valorado por precio unitario del propio `Dataset_Congelado`). Si
  dirección exige que el Garantizado use **solo** cifras aisladas directamente del CUR, el piso es
  **`30,82`/mes** → **Σ Garantizado piso = `1 096,30`/mes · `13 155,60`/año**.

---

## 3. Ahorro_Estimado — rango honesto (Req 6.6, 3.6)

Ahorro que **depende de supuestos** (tasa de descuento de compromiso, % direccionable, perfil de
uso). Se presenta **como rango** `(Σ Rango_Conservador, Σ Rango_Agresivo)`, nunca como cifra única, y
**por separado** del Garantizado (Req 3.6, 6.6). Rangos por palanca auditados en 17.3 (Property 5:
**PASS**, `0 < Conservador ≤ Agresivo`) y anualización/redondeo en 17.5 (Property 8 y 9: **PASS**).

| Palanca Estimado | Conservador (USD/mes) | Agresivo (USD/mes) | `id_evidencia` |
|------------------|----------------------:|-------------------:|----------------|
| P1 — Compromiso EC2 (SP) | 1 347,77 | 1 780,99 | `EV-3.3-ec2-sp-ahorro` |
| P2 — Compromiso RDS (RI) | 1 732,78 | 2 548,20 | `EV-4.3-RDS-COMMIT` |
| P4 — Logs CloudWatch/WAF (bruto) | 1 419,51 | 1 921,80 | `EV-6.3-waf-logs-estimado-2026-05` |
| P5 — Aurora no-prod Helios (bruto) | 425,57 | 723,47 | `EV-7.3-aurora-helios-noprod-ahorro` |
| P6a — gp2→gp3 | 151,76 | 212,38 | `EV-8.1-ebs-gp2-gp3-2026-05` |
| P6b — Snapshots EBS | 20,15 | 60,44 | `EV-8.2-ebs-snapshots-2026-05` |
| **P7 — S3 lifecycle / tiering** | **955,35** | **1 389,60** | `EV-9.3-s3-tiering-estimado-2026-05` |
| P8b — NAT no-prod (rediseño) | 65,71 | 98,57 | `EV-10.1-red-2026-05` |
| P9 — Rightsizing / Graviton | 574,27 | 1 531,39 | `EV-11.3-rightsizing-clasificacion` |
| P10 — Scheduling + Spot no-prod | 252,30 | 542,80 | `EV-12.3-palanca10-estimado` |
| P11 — Bedrock (squad Data) | 488,41 | 1 016,08 | `EV-13.3-bedrock-estimado-2026-05` |
| **Σ Ahorro_Estimado (rango, mensual)** | **7 433,58** | **11 825,72** | — |
| **Σ Ahorro_Estimado (rango, anual ×12)** | **89 202,96** | **141 908,64** | — |

> **Inclusión de P7-S3 (decisión documentada, Tarea 19.1).** El anticipo de control de la auditoría
> 17.5 §5 sumó **10** palancas Estimado y arrojó **`6 478,23 – 10 436,12`/mes**, excluyendo
> explícitamente P7-S3 (entre otras). P7-S3 es, sin embargo, una palanca **plenamente clasificada
> como Estimado** con rango verificado (`955,35 – 1 389,60`/mes, `EV-9.3-...`, invariante
> `0 < Cons ≤ Agr` cumplida) y **base afectada anclada al CUR** (`EV-9.1-s3-timedstorage-clase-2026-05`).
> No existe motivo metodológico para excluirla del **total** de Ahorro_Estimado que exige el Req 19.2
> (a diferencia de las partidas contingentes/no verificadas del §3.1). Por tanto, el rango canónico de
> Ahorro_Estimado del Informe **incluye P7-S3**: **`7 433,58 – 11 825,72`/mes**
> (`= 6 478,23 + 955,35` y `= 10 436,12 + 1 389,60`, respectivamente). Se documentan ambas lecturas
> para reconciliar con la auditoría 17.5.

### 3.1 Upside contingente / no verificado — señalado aparte, FUERA del rango anterior

No se contabiliza en el Σ Ahorro_Estimado del §3 por carecer de confirmación de owner o de
verificación viva (Req 5.3, 14.4):

| Partida | Conservador (USD/mes) | Agresivo (USD/mes) | `id_evidencia` | Motivo |
|---------|----------------------:|-------------------:|----------------|--------|
| P8c — VPN candidatas a revisión | 68,44 | 273,76 | `EV-10.1-red-2026-05` | Estimado **contingente**: un túnel DOWN ≠ desperdicio (posible backup/DR); excluido hasta confirmación de owner (Req 14.4) |
| Adyacente — ElastiCache Reserved Nodes (de P2) | 123,37 | 185,05 | `EV-4.3-RDS-COMMIT` | Sin `Verificacion_Recurso_Vivo` ni barrido; no forma parte de la base RDS |

---

## 4. Objetivo de ahorro comprometido (derivación, Req 19.4)

El **objetivo comprometido** se deriva de forma cerrada (Property 12, auditoría 17.8: **PASS**) como
`Σ Ahorro_Garantizado + Σ Rango_Conservador de las palancas Estimado CON Barrido_Utilizacion
completado`. Solo **P1, P2 y P5** tienen su barrido **completado** (steady-state 16.1 para P1/P2;
scheduling 16.3 para P5). Ningún Ahorro_Estimado sin barrido entra como objetivo (Req 18.2).

```
Objetivo_Comprometido = Σ Garantizado (1 111,36) + Σ Conservador{P1 1 347,77 + P2 1 732,78 + P5 425,57}
                      = 1 111,36 + 3 506,12
                      = 4 617,48  USD/mes  ·  55 409,76  USD/año (×12)
```

| Componente | USD/mes | USD/año (×12) | `id_evidencia` |
|------------|--------:|--------------:|----------------|
| Σ Ahorro_Garantizado (P3 + P6c + P8a) | 1 111,36 | 13 336,32 | ver §2 |
| P1 — EC2 SP (Conservador, barrido `EV-16.1-BARRIDO-STEADY`) | 1 347,77 | 16 173,27 | `EV-3.3-ec2-sp-ahorro` |
| P2 — RDS RI (Conservador, barrido `EV-16.1-BARRIDO-STEADY`) | 1 732,78 | 20 793,33 | `EV-4.3-RDS-COMMIT` |
| P5 — Aurora Helios (Conservador, barrido 16.3) | 425,57 | 5 106,82 | `EV-7.3-aurora-helios-cons-mensual` |
| **Objetivo_Comprometido** | **4 617,48** | **55 409,76** | — |

> **Variante de piso conservador** (si P8a = `30,82`, solo IPv4 aislada del CUR):
> **`4 602,42`/mes · `55 229,04`/año**. Ambas lecturas deben acompañar al objetivo en la presentación
> a dirección.

---

## 5. Palanca_Comercial Marketplace — SEÑALADA APARTE (Req 17.3, nunca en el ahorro técnico)

| Partida | Cadencia | Importe (USD) | Anualizado | `id_evidencia` |
|---------|----------|--------------:|-----------:|----------------|
| Contrato Marketplace (`Fee` / `Global-SoftwareUsage-Contracts`) | **PUNTUAL** (prepago, 1 vez — mayo 2026) | **85 000,55** | **no aplica × 12** (recurre solo en la renovación) | `E1.1-MKT-CONTRACT` |
| PAYG del mismo producto (sobrecarga, indicador de tier mal dimensionado, Req 17.2) | recurrente (mensual) | **6 663,33** /mes | 79 960,00 /año | `E1.1-PAYG` |

> **Corrección (gotcha #3).** El **contrato Marketplace (`85 000,55`) es un cargo PUNTUAL** (prepago
> del contrato SaaS, facturado de una sola vez; cae íntegro en la factura de mayo 2026). **NO es un
> coste recurrente mensual y NO se anualiza × 12** — recurre únicamente en la renovación del contrato.
> Solo el **PAYG (`6 663,33`/mes)** es recurrente. **No es ahorro técnico.** Es una **oportunidad
> comercial** cuya realización depende de **renegociación o ajuste en renovación** (Req 17.5),
> **separada** y **nunca** sumada al Ahorro_Garantizado, al Ahorro_Estimado ni al
> Objetivo_Comprometido. El PAYG señala un **tier de infraestructura mal dimensionado** (consumo por
> encima del contrato comprometido).

---

## 6. Síntesis para dirección

| Magnitud | Valor (mensual) | Valor (anual ×12) | Naturaleza |
|----------|----------------:|------------------:|------------|
| Coste total organización (mayo 2026) | 148 553,36 | ver nota | Marco de referencia (`E1.1-TOTAL`) — incluye el cargo PUNTUAL Marketplace 85 000,55 |
| Run-rate recurrente organización (excl. cargo puntual) | ~63 552,81 | ~762 633,72 | Coste mensual recurrente normalizado (148 553,36 − 85 000,55) |
| Infraestructura AWS direccionable | 48 320,13 | 579 841,56 | Denominador técnico (`E1.1-INFRA`) |
| **Σ Ahorro_Garantizado** | **1 111,36** | **13 336,32** | Desperdicio puro verificado (piso `1 096,30` / `13 155,60`) |
| **Σ Ahorro_Estimado (rango)** | **7 433,58 – 11 825,72** | **89 202,96 – 141 908,64** | Sujeto a supuestos; incluye P7-S3 |
| **Objetivo_Comprometido** | **4 617,48** | **55 409,76** | Garantizado + Conservador{P1,P2,P5} con barrido (piso `4 602,42` / `55 229,04`) |
| Palanca_Comercial Marketplace | contrato 85 000,55 **(puntual)** + PAYG 6 663,33/mes | PAYG 79 960,00 | **Aparte** — comercial, no técnica; contrato no recurrente (no ×12) |

> **Nota total org anual:** NO se anualiza × 12 el total de mayo (1 782 640,32 sería incorrecto)
> porque mayo incluye el **cargo puntual** del contrato Marketplace (85 000,55). El anual recurrente
> aproximado es `~762 633,72` (run-rate) **más** el contrato cuando recurra en su renovación.

> **Lectura rápida:** el objetivo **comprometible hoy** es **`4 617,48`/mes (`55 409,76`/año)** —
> respaldado por desperdicio verificado y por los compromisos de uso con barrido completado. El
> **techo del recorrido técnico** adicional (Estimado, no comprometido aún) llega a
> **`11 825,72`/mes** si se completan los barridos pendientes y se materializan los rangos agresivos.
> El contrato Marketplace (`~85 k` **puntual**, no mensual) es una palanca **comercial** independiente
> y la mayor oportunidad absoluta, pero fuera del ahorro técnico y de cadencia contractual (renovación).

---

## 7. Caveats y condiciones de validez (obligatorio en la presentación)

1. **Gate de frescura del Garantizado (Req 3.2).** Las 3 `Verificacion_Recurso_Vivo` que sostienen el
   Ahorro_Garantizado son del `2026-06-23` (frescura 0 días). Si el Informe se **publica > 30 días
   después** de `2026-06-23`, **re-ejecutar** las verificaciones (Extended Support, volúmenes
   huérfanos, EIP/endpoint) antes de mantener la clasificación Garantizado.
2. **P9 y P10 fuera del objetivo comprometido.** P9 (rightsizing) tiene `Barrido_Utilizacion`
   **pendiente** (sin p95 de CPU/RAM por la fuente designada) y P10 (scheduling/Spot) **parcial →
   pendiente**. Ambas se presentan **solo como rango** Estimado, **nunca** como objetivo (Req 18.2),
   y se identifican como **pendientes de barrido** (Req 18.5 / 19.6).
3. **P1 ↔ P9 no son aditivos.** El compromiso EC2 (P1) y el rightsizing/Graviton (P9) actúan sobre la
   **misma flota EC2**: 5 de las 6 instancias candidatas a rightsizing solapan con la base
   comprometida del SP. Comprometer un SP sobre instancias que luego se reducen sería **doble conteo**
   (Property 7, auditoría 17.4). P1 entra en el objetivo comprometido; **P9 queda fuera** (solo rango)
   y su materialización exige reconciliar la base con P1 antes de comprometerse.
4. **Estacionalidad (Req 6.4).** Toda cifra anualizada es `mensual × 12` y **asume que mayo 2026 es
   representativo**; **no** captura estacionalidad (campañas, Black Friday, picos de jobs EMR/Bedrock).
5. **Bruto vs neto.** El Garantizado y los rangos Estimado se presentan en **bruto** salvo indicación;
   varios registros aportan también la lectura neta (descontando SPP). La infraestructura direccionable
   tiene `48 320,13` bruto / `44 484,97` neto.

---

## 8. Trazabilidad (Req 19.5) y estado

- **Cada cifra de este resumen referencia su `id_evidencia`** del `Catálogo_Evidencias`
  (correspondencia 1:1, Req 2.7). La **tabla por Palanca** (Tarea 19.2) y el **anexo de evidencias**
  (Tarea 19.3) completan la estructura del Informe exigida por el Req 19.1.
- **Auditorías de respaldo (todas PASS):** Property 1 (conservación) 17.1 · Property 4/5/6
  (clasificación, rango, frescura) 17.3 · Property 7 (doble conteo) 17.4 · Property 8/9
  (anualización, redondeo) 17.5 · Property 12 (derivación de objetivos) 17.8.
- **Disciplina de redondeo (Req 6.7):** las cifras por palanca son `redondear(Σ)` de sus bases sin
  redondear; los totales de este resumen se componen **sumando las cifras mensuales publicadas** (mismo
  nivel de composición que la auditoría 17.5). Las diferencias de céntimos entre `Σ anuales` y
  `total mensual × 12` (≤ 0,02 USD) son el artefacto esperado de multiplicar antes de redondear; la
  cifra canónica anual es **el total mensual comprometido × 12**.
