# Informe FinOps de Ahorro AWS — 04 · Derivación de objetivos comprometidos

> **Tarea 19.4** del Estudio FinOps de Ahorro AWS. Cuarta pieza del **Informe** (tras el resumen
> ejecutivo, la tabla por Palanca y el anexo de evidencias). Deriva de forma **cerrada** el
> `Objetivo_Comprometido`, identifica explícitamente las Palancas **pendientes de barrido** (fuera de
> objetivos) y presenta la **Palanca_Comercial** Marketplace **por separado** con su dependencia de
> renegociación/renovación.
>
> **Validates: Requirements 19.4, 19.6, 18.2, 18.5, 17.5.**
>
> Este fichero es el **artefacto NUEVO y DEDICADO** de la Tarea 19.4; **no** modifica ningún otro
> fichero del spec (requirements, design, tasks, evidencias, catálogo, auditorías ni las otras piezas
> del Informe). Todas las cifras están **ancladas** al `Dataset_Congelado` `frozen-2026-05@2026-06-23`
> (Mes_Referencia `2026-05`, moneda **USD**, 2 decimales half-up, **sumando antes de redondear** —
> Req 6.7) y **referencian su `id_evidencia`** del `Catálogo_Evidencias` (Req 19.5). La derivación
> reproduce **exactamente** la auditoría **17.8 Property 12 (PASS)** y la cifra compuesta en
> `informe/01-resumen-ejecutivo.md` §4 y `informe/03-anexo-evidencias.md` §5.3 (`EV-AGG-OBJETIVO`).

---

## Parámetros de anclaje

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` (2 decimales, half-up; **suma antes de redondear** — Req 6.7) |
| Anualización | mensual × 12; **asume Mes_Referencia representativo y NO captura estacionalidad** (Req 6.4) |
| Regla auditada | Property 12 (auditoría `17-8-property-12-derivacion-objetivos.md`: **PASS**) |
| Registro agregado | `EV-AGG-OBJETIVO` (anexo `03-anexo-evidencias.md` §5.3) |

---

## 1. Regla cerrada de derivación (Req 19.4)

El `Objetivo_Comprometido` **no** es la suma de todo el ahorro identificado. Es una cifra
**comprometible hoy**: solo lo que es desperdicio puro verificado en vivo (**Garantizado**) más los
compromisos de uso cuyo `Barrido_Utilizacion` está **completado** (su `Rango_Conservador`). Ningún
Ahorro_Estimado sin barrido completado se eleva a objetivo (Req 18.2); la Palanca_Comercial nunca
entra (Req 17.3).

```
Objetivo_Comprometido =  Σ Ahorro_Garantizado
                      +  Σ Rango_Conservador( Palancas Estimado CON Barrido_Utilizacion completado )

Excluidos del objetivo:
  · Palancas Estimado SIN barrido completado          → solo rango (Req 18.2)
  · Palancas Estimado con barrido PARCIAL              → tratadas como pendientes (Req 18.3)
  · Palanca_Comercial (contrato Marketplace)           → señalada aparte (Req 17.3, 17.5)
```

Aplicando la regla a las cifras congeladas — **Garantizado** íntegro (no requiere barrido: es
desperdicio puro live-confirmado) y **solo P1, P2 y P5** como Estimado con barrido completado
(steady-state 16.1 para P1/P2; scheduling/uso 16.3 para el Conservador de P5):

```
Objetivo_Comprometido = Σ Garantizado (1 111,36)
                      + Σ Conservador{ P1 1 347,77 + P2 1 732,78 + P5 425,57 = 3 506,12 }
                      = 1 111,36 + 3 506,12
                      = 4 617,48  USD/mes
                      = 55 409,76 USD/año  (4 617,48 × 12)
```

> **Verificación contra la regla cerrada (Property 12, 17.8 §3 — PASS):** `1 111,36 + 3 506,12 =
> 4 617,48`/mes; `4 617,48 × 12 = 55 409,76`/año. **Cuadra exactamente** con el resumen ejecutivo §4
> y con `EV-AGG-OBJETIVO`. ✔

---

## 2. Tabla de componentes del Objetivo_Comprometido

Cada componente cita su `id_evidencia` del `Catálogo_Evidencias` y el estado de su
`Barrido_Utilizacion` (Req 19.5, 18.5). El registro agregado es **`EV-AGG-OBJETIVO`** (anexo §5.3).

| Componente | Clasificación | USD/mes | USD/año (×12) | `id_evidencia` | Barrido_Utilizacion |
|------------|---------------|--------:|--------------:|----------------|---------------------|
| **Σ Ahorro_Garantizado** (P3* + P6c + P8a) | Garantizado | **1 111,36** | **13 336,32** | `EV-AGG-GARANTIZADO` (agrega `EV-5.3` + `EV-8.3` + `EV-10.3a`) | `n/a` (desperdicio puro, frescura 0 días ≤ 30 — Req 3.2) |
| ├ P3 — Extended Support PG13 (RDS) | Garantizado\* **condicionado** | 833,28 | 9 999,36 | `EV-5.3-…-clasificacion` | `n/a` (supresión de cargo, no depende de uso) |
| ├ P6c — Volúmenes EBS huérfanos (27 `available`) | Garantizado | 232,20 | 2 786,40 | `EV-8.3-ebs-volumenes-huerfanos-2026-05` | `n/a` (verificado en vivo) |
| └ P8a — IPv4 idle (7 EIP) + VPC endpoint duplicado | Garantizado | 45,88 | 550,56 | `EV-10.3a-red-garantizado-2026-05` | `n/a` (verificado en vivo) |
| **P1 — Compromiso EC2 (SP), Conservador** | Estimado → comprometido | 1 347,77 | 16 173,27 | `EV-3.3-ec2-sp-ahorro` | **completado** — `EV-16.1-BARRIDO-STEADY` (CONFIRMADO) |
| **P2 — Compromiso RDS (RI), Conservador** | Estimado → comprometido | 1 732,78 | 20 793,33 | `EV-4.3-RDS-COMMIT` | **completado** — `EV-16.1-BARRIDO-STEADY` (CONFIRMADO) |
| **P5 — Aurora no-prod Helios, Conservador** | Estimado → comprometido | 425,57 | 5 106,82 | `EV-7.3-aurora-helios-cons-mensual` | **completado (Conservador)** — `EV-16.3-BARRIDO-SCHED-SPOT` |
| **Objetivo_Comprometido** | derivado | **4 617,48** | **55 409,76** | `EV-AGG-OBJETIVO` | — |

> `833,28 + 232,20 + 45,88 = 1 111,36` (Σ Garantizado); `1 347,77 + 1 732,78 + 425,57 = 3 506,12`
> (Σ Conservador con barrido); `1 111,36 + 3 506,12 = 4 617,48`/mes. Todas **sumadas antes de
> redondear** (Req 6.7).
>
> **Nota P5 (Req 18.3):** entra **solo** por su `Rango_Conservador` bruto (eliminación del reader,
> 50,0 %). Los extras del `Rango_Agresivo` (downsize + scheduling del writer) **siguen Estimado**, no
> comprometidos.
>
> **Nota de redondeo (Req 6.7 / Property 9):** sumar los **anuales** publicados da
> `13 336,32 + 16 173,27 + 20 793,33 + 5 106,82 = 55 409,74`, que difiere **0,02 USD** del
> `4 617,48 × 12 = 55 409,76`. Es el artefacto esperado de multiplicar cada mensual **sin redondear**
> antes de redondear. La cifra anual **canónica** es **`55 409,76`** (anualizar el total mensual
> comprometido). El ×12 **asume mayo 2026 representativo** y no captura estacionalidad (Req 6.4).

### Variante de piso conservador (Garantizado por cifras aisladas directamente del CUR)

Si dirección exige que el Garantizado use **solo** cifras aisladas directamente del CUR, P8a baja a
**30,82**/mes (solo IPv4 idle, sin el VPC endpoint duplicado valorado por precio unitario):

```
Σ Garantizado (piso)           = 833,28 + 232,20 + 30,82 = 1 096,30  USD/mes
Objetivo_Comprometido (piso)   = 1 096,30 + 3 506,12     = 4 602,42  USD/mes  ·  55 229,04 USD/año
```

> **Ambas lecturas (45,88 por defecto / 30,82 piso) deben acompañar al objetivo en la presentación a
> dirección** (recomendación 17.3 §5.2): `4 617,48`/mes (`55 409,76`/año) por defecto · `4 602,42`/mes
> (`55 229,04`/año) en el piso.

---

## 3. Reconciliación con el subtotal "Σ Garantizado = 278,08" de la tabla 19.2 (doble lectura)

La **tabla por Palanca** (`02-tabla-por-palanca.md`, sección "Subtotales por clasificación")
presenta un subtotal **`Σ Ahorro_Garantizado = 278,08`** que suma **solo P6c (232,20) + P8a (45,88)**,
tratando **P3 — Extended Support** como una línea separada de **"Ahorro_Garantizado\* condicionado"**
(`833,28` bruto) por su naturaleza condicionada (a upgrade de motor + validación de compatibilidad de
la aplicación, Req 9.4/9.5). En cambio, el **resumen ejecutivo** (§2) y la **auditoría 17.8** usan
**`Σ Garantizado = 1 111,36`**, que **incluye P3 condicionado** dentro del total Garantizado.

Esto es una **diferencia de presentación, no de cifras**: ambas lecturas manejan los mismos importes
(`833,28`, `232,20`, `45,88`); solo difieren en si P3 se agrupa dentro del subtotal Garantizado o se
lista aparte como condicionado.

**Decisión canónica (vinculante para el Informe):** el `Objetivo_Comprometido` **INCLUYE P3
condicionado** dentro del Garantizado total (`Σ Garantizado = 1 111,36`), tal como lo derivan el
resumen ejecutivo §4, la auditoría 17.8 (Property 12: PASS) y el registro `EV-AGG-OBJETIVO`. P3 es un
**Garantizado condicionado** (la cifra es desperdicio puro live-confirmado; la condición es operativa,
no de medición), por lo que entra en el objetivo. Se deja constancia explícita de la **doble lectura**:

| Lectura | Σ Garantizado | + Σ Conservador{P1,P2,P5} | **Objetivo_Comprometido** |
|---------|--------------:|--------------------------:|--------------------------:|
| **CON P3 condicionado** (canónica — resumen ejecutivo, 17.8, `EV-AGG-OBJETIVO`) | **1 111,36** | 3 506,12 | **4 617,48 USD/mes** · 55 409,76/año |
| **SIN P3 condicionado** (subtotal 19.2 "Σ Garantizado = 278,08", P3 aparte) | 278,08 | 3 506,12 | **3 784,20 USD/mes** · 45 410,40/año |

> `4 617,48 − 833,28 = 3 784,20`/mes: la diferencia entre ambas lecturas es **exactamente** el
> Garantizado condicionado de P3 (`833,28`/mes · `9 999,36`/año). La cifra que se compromete a
> dirección es la **canónica con P3: `4 617,48`/mes (`55 409,76`/año)**. La lectura sin P3
> (`3 784,20`/mes) se documenta únicamente para reconciliar el subtotal de la tabla 19.2; **no** es la
> cifra del objetivo. La materialización de P3 está **condicionada** al upgrade de motor PG13→PG18
> (Digital — `oms` / `payments-api`) y debe **priorizarse**: el ahorro futuro se duplicaría (salto a
> tramo Año 3) si el upgrade se retrasa más allá de `2028-02-28`.

---

## 4. Palancas PENDIENTES de barrido — FUERA de los objetivos comprometidos (Req 19.6, 18.5)

El Req 19.6 exige identificar **explícitamente** qué Palancas quedan pendientes de
`Barrido_Utilizacion` y, por tanto, **fuera** del objetivo comprometido. Se presentan **solo como
rango** Estimado (Req 18.2), **nunca** como objetivo.

### 4.1 Pendientes / parciales de barrido (el barrido es exigible y NO está completado)

| Palanca | Clasificación | Rango Estimado (USD/mes) | `id_evidencia` | Estado de barrido | Motivo de exclusión |
|---------|---------------|-------------------------:|----------------|-------------------|---------------------|
| **P9 — Rightsizing / Graviton** | Estimado | 574,27 – 1 531,39 | `EV-11.3-rightsizing-clasificacion` · barrido `EV-16.2-barrido-rightsizing-p95` | **PENDIENTE (0 %)** | Sin p95 de CPU+RAM por la fuente designada (EC2 standalone fuera de EKS, RAM no instrumentada — Req 13.1/13.2). Sin barrido no hay propuesta comprometida |
| **P10 — Scheduling + Spot no-prod** | Estimado | 252,30 – 542,80 | `EV-12.3-palanca10-estimado` · barrido `EV-16.3-BARRIDO-SCHED-SPOT` | **PARCIAL → PENDIENTE** (Req 18.3) | 10a (89,2 %) sin horas reducibles defendibles desde facturación (demand-driven, baseline bajo SP); 10b (Spot EMR TASK) inmaterial |

### 4.2 Contingentes / pendientes de verificación propia (fuera del objetivo hasta confirmación)

| Partida | Clasificación | Rango (USD/mes) | `id_evidencia` | Motivo |
|---------|---------------|----------------:|----------------|--------|
| **P8c — VPN candidatas a revisión** | Estimado **contingente** | 68,44 – 273,76 | `EV-10.3c-red-estimado-vpn-2026-05` | Un túnel DOWN ≠ desperdicio (posible backup/DR); **excluido del objetivo** hasta que el owner clasifique cada VPN (Req 14.4) |
| **Adyacente 2b — ElastiCache Reserved Nodes** | Estimado | 123,37 – 185,05 | `EV-4.3-RDS-COMMIT` (cobertura adyacente) | Sin `Verificacion_Recurso_Vivo` ni barrido propio; no forma parte de la base RDS comprometida |

### 4.3 Estimado no elevado (barrido `no requerido`, pero NO comprometido — solo rango)

Estas Palancas tienen un rango cuyo cálculo **no depende del perfil de utilización** (no requieren
barrido), pero **no** se elevan a objetivo comprometido: se presentan **solo como rango** Estimado
(Req 18.2). Entran en el `Σ Ahorro_Estimado` total del resumen ejecutivo, **no** en el objetivo.

| Palanca | Rango (USD/mes) | `id_evidencia` |
|---------|----------------:|----------------|
| P4 — Logs CloudWatch / WAF | 1 419,51 – 1 921,80 | `EV-6.3-waf-logs-estimado-2026-05` |
| P6a — EBS gp2→gp3 | 151,76 – 212,38 | `EV-8.1-ebs-gp2-gp3-2026-05` |
| P6b — EBS snapshots elegibles | 20,15 – 60,44 | `EV-8.2-ebs-snapshots-2026-05` |
| P7 — S3 lifecycle / Intelligent-Tiering | 955,35 – 1 389,60 | `EV-9.3-s3-tiering-estimado-2026-05` |
| P8b — NAT no-prod (rediseño) | 65,71 – 98,57 | `EV-10.3b-red-estimado-nat-2026-05` |
| P11 — Bedrock (squad Data) | 488,41 – 1 016,08 | `EV-13.3-bedrock-estimado-2026-05` |

> **Caveat P1 ↔ P9 no aditivos (Property 7, auditoría 17.4).** El compromiso EC2 (P1, **en** el
> objetivo) y el rightsizing/Graviton (P9, **fuera**) actúan sobre la **misma flota EC2**: 5 de las 6
> instancias candidatas a rightsizing solapan con la base comprometida del SP. Comprometer un SP sobre
> instancias que luego se reducen sería **doble conteo**. P1 entra en el objetivo; **P9 queda fuera**
> (solo rango) y su materialización exige **reconciliar la base con P1** antes de comprometerse.

---

## 5. Palanca_Comercial Marketplace — SEÑALADA APARTE (Req 17.5)

La Palanca 12 (contrato Marketplace) es una **oportunidad comercial**, **no** ahorro técnico. Se
presenta **separada** y **nunca** se suma al Ahorro_Garantizado, al Ahorro_Estimado ni al
`Objetivo_Comprometido` (Req 17.3). Su cita canónica única es `E1.1-MKT-CONTRACT` / `E1.1-PAYG`
(resolución H1 del anexo §4).

| Partida | Cadencia | Importe (USD) | Anualizado | `id_evidencia` (canónico) |
|---------|----------|--------------:|-----------:|---------------------------|
| Contrato Marketplace (`Fee` / `Global-SoftwareUsage-Contracts`) | **PUNTUAL** (prepago, 1 vez — mayo 2026) | **85 000,55** | **no aplica × 12** (recurre solo en la renovación) | `E1.1-MKT-CONTRACT` |
| PAYG del mismo producto (sobrecarga → tier mal dimensionado, Req 17.2) | recurrente (mensual) | **6 663,33** /mes | 79 960,00 /año | `E1.1-PAYG` |

> **Dependencia de renegociación / renovación (Req 17.5).** La realización de esta palanca **no**
> depende de ninguna acción de ingeniería: depende de **renegociación del contrato o ajuste en la
> renovación**. La **fecha de renovación del contrato está pendiente** (Req 17.4) y la decisión recae
> en **Dirección + Compras**. El PAYG (`6 663,33`/mes) señala un **tier de infraestructura mal
> dimensionado** (consumo por encima del contrato comprometido), indicador adicional para la
> renegociación. Es la **mayor oportunidad absoluta** del estudio (~`85 k` de contrato, **cargo
> puntual prepagado — no mensual, no ×12**, gotcha #3), pero **fuera del ahorro técnico** y, por
> definición, **fuera del `Objetivo_Comprometido`**.

---

## 6. Síntesis de la derivación (para dirección)

| Magnitud | Mensual (USD) | Anual ×12 (USD) | Naturaleza | `id_evidencia` |
|----------|--------------:|----------------:|------------|----------------|
| Σ Ahorro_Garantizado (con P3 condicionado) | 1 111,36 | 13 336,32 | Desperdicio puro verificado (piso `1 096,30`/`13 155,60`) | `EV-AGG-GARANTIZADO` |
| Σ Conservador con barrido completado {P1+P2+P5} | 3 506,12 | 42 073,42 | Compromisos de uso con barrido `EV-16.1`/`EV-16.3` | `EV-3.3` · `EV-4.3-RDS-COMMIT` · `EV-7.3-…-cons-mensual` |
| **Objetivo_Comprometido (canónico, con P3)** | **4 617,48** | **55 409,76** | Comprometible hoy (piso `4 602,42`/`55 229,04`) | `EV-AGG-OBJETIVO` |
| Lectura sin P3 condicionado (reconciliación tabla 19.2) | 3 784,20 | 45 410,40 | Solo para reconciliar el subtotal "278,08" | — |
| Palancas pendientes de barrido (P9, P10) — fuera | rango 826,57 – 2 074,19 | — | Solo rango Estimado (Req 18.2, 19.6) | `EV-11.3` · `EV-12.3` |
| Palanca_Comercial Marketplace — aparte | contrato 85 000,55 **(puntual)** + PAYG 6 663,33/mes | PAYG 79 960,00 (contrato no ×12) | Comercial; depende de renegociación/renovación (Req 17.5) | `E1.1-MKT-CONTRACT` · `E1.1-PAYG` |

> **Lectura rápida para dirección:** el objetivo **comprometible hoy** es **`4 617,48`/mes
> (`55 409,76`/año)** — Garantizado verificado (incl. P3 condicionado) + Conservadores con barrido
> completado de P1/P2/P5. La derivación es **cerrada y auditada** (Property 12, 17.8: **PASS**) y cuadra
> con `EV-AGG-OBJETIVO`. **P9 y P10 quedan fuera** (barrido pendiente/parcial) y solo se presentan como
> rango; el **contrato Marketplace** (~`85 k`/mes) es una palanca **comercial** independiente que
> depende de **renegociación/renovación** (fecha pendiente), nunca parte del objetivo técnico.

---

## 7. Caveats de validez (obligatorio en la presentación)

1. **Gate de frescura del Garantizado (Req 3.2).** Las 3 `Verificacion_Recurso_Vivo` que sostienen el
   Garantizado (`EV-5.2` Extended Support, `EV-8.3` volúmenes huérfanos, `10.2` red) son del
   `2026-06-23` (frescura **0 días** ≤ 30). Si el Informe se **publica > 30 días después** de
   `2026-06-23`, **re-ejecutar** esas verificaciones antes de mantener la clasificación Garantizado y
   la cifra del objetivo.
2. **P3 condicionado.** Su `833,28`/mes está dentro del objetivo canónico, pero **condicionado** al
   upgrade PG13→PG18 + validación de compatibilidad de la aplicación (Req 9.4/9.5). **Priorizar**: el
   ahorro se duplicaría (tramo Año 3) si el upgrade se retrasa más allá de `2028-02-28`.
3. **P9 y P10 fuera del objetivo (Req 18.2, 19.6).** P9 barrido **pendiente al 100 %**, P10 **parcial →
   pendiente**. Solo rango; su elevación a objetivo exige completar el barrido (y, para P9, reconciliar
   con P1 — Property 7).
4. **Doble lectura del Garantizado de red.** P8a por defecto `45,88` (IPv4 idle + VPC endpoint
   duplicado) / piso `30,82` (solo IPv4 aislada del CUR) → objetivo `4 617,48` / `4 602,42`.
   **Ambas** acompañan a la cifra en la presentación.
5. **Estacionalidad (Req 6.4).** Toda cifra anualizada es `mensual × 12` y **asume mayo 2026
   representativo**; no captura campañas, Black Friday ni picos de jobs EMR/Bedrock.

---

## 8. Trazabilidad y re-ejecución

- **Cada componente del objetivo referencia su `id_evidencia`** (Req 19.5); el agregado es
  `EV-AGG-OBJETIVO` (anexo §5.3), que a su vez cita `EV-AGG-GARANTIZADO` + `EV-3.3` + `EV-4.3-RDS-COMMIT`
  + `EV-7.3-…-cons-mensual`.
- **Auditoría de respaldo:** Property 12 (`auditoria/17-8-property-12-derivacion-objetivos.md`:
  **PASS**), apoyada en Property 4/5/6 (17.3, clasificación/rango/frescura), Property 7 (17.4, doble
  conteo P1↔P9) y Property 8/9 (17.5, anualización/redondeo).
- **Re-ejecución (idéntico veredicto mientras las cifras sigan ancladas a `frozen-2026-05@2026-06-23`
  y los veredictos de barrido no cambien):**
  1. Confirmar `Σ Garantizado = 833,28 + 232,20 + 45,88 = 1 111,36` (piso `1 096,30` con P8a = 30,82).
  2. Confirmar barridos: `EV-16.1` (P1/P2 CONFIRMADO), `EV-16.3` (P5 COMPLETO Conservador; P10
     PARCIAL→PENDIENTE), `EV-16.2` (P9 PENDIENTE). Solo P1, P2 y P5 elegibles.
  3. Recalcular `Σ Conservador = 1 347,77 + 1 732,78 + 425,57 = 3 506,12`.
  4. Recalcular `Objetivo = 1 111,36 + 3 506,12 = 4 617,48`/mes · `× 12 = 55 409,76`/año.
  5. Verificar exclusiones: P9, P10, P4, P6a, P6b, P7, P8b, P8c, P11, ElastiCache 2b (todas fuera del
     objetivo, solo rango) y P12 Marketplace (comercial, aparte por renegociación/renovación).
  6. Cualquier desviación ≠ `0,00 USD` indica cambio en una cifra base o en un veredicto de barrido y
     debe investigarse antes de publicar (Req 7.3).
