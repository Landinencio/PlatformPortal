# Auditoría 17.3 — Clasificación, rango de Estimado y frescura de Garantizado

> **Tarea 17.3** — Auditoría re-ejecutable de las **Correctness Properties 4, 5 y 6** sobre el
> `Catálogo_Evidencias` y el `Dataset_Congelado`. Este es un entregable **analítico** (no software):
> la "prueba" es la verificación de invariantes sobre los artefactos congelados de las Palancas, no
> un test de código.
>
> **Property 4 + Property 5 + Property 6** — **Validates: Requirements 3.1, 3.2, 3.3, 3.5, 5.3, 6.1**

## Parámetros de la auditoría (anclaje)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Fecha de extracción del CUR | `2026-06-23` (UTC) |
| Moneda | `USD` (2 decimales, half-up) |
| Fecha de las Verificaciones_Recurso_Vivo | `2026-06-23` (UTC) — mismo día que la extracción |
| Fecha de esta auditoría | `2026-06-23` (UTC) |
| Fuentes auditadas | `evidencias/palanca-01..12*.md` (clasificación, rangos Conservador/Agresivo, sub-registros de `Verificacion_Recurso_Vivo`) |
| Alcance | 11 Palancas técnicas (1–11) + Palanca 12 (Palanca_Comercial, excluida del total técnico) |

## Definiciones auditadas (del `design.md`)

- **Property 4 — Clasificación exhaustiva y mutuamente excluyente.** *Para toda* Palanca de ahorro
  técnico, su clasificación es exactamente una de {Ahorro_Garantizado, Ahorro_Estimado}. Las
  Palancas_Comerciales y las partidas fuera de alcance **no** son Palancas técnicas y quedan
  excluidas del total técnico. Una Palanca mixta se parte en Sub_Palancas, cada una con una única
  clasificación (Req 3.1, 3.4, 17.3).
- **Property 5 — Invariante de rango del Ahorro_Estimado.** *Para toda* Palanca clasificada como
  Estimado, su ahorro se expresa como par `(Rango_Conservador, Rango_Agresivo)` en USD que cumple
  `0 < Rango_Conservador ≤ Rango_Agresivo`, **nunca** como cifra única (Req 3.3, 6.1).
- **Property 6 — Frescura de la verificación del Ahorro_Garantizado.** *Para toda* Palanca
  clasificada como Garantizado existe una `Verificacion_Recurso_Vivo` con `estado = confirmado` y
  antigüedad ≤ 30 días respecto a la fecha de publicación del Informe; si la verificación falla o no
  es confirmable, la Palanca **no permanece** como Garantizado (Req 3.2, 3.5, 5.3).

---

## 1. Matriz de clasificación por Palanca técnica (Property 4)

| Palanca técnica | ¿Mixta? | Sub_Palanca | Clasificación | Fuente |
|-----------------|:-------:|-------------|---------------|--------|
| **1 — Compromiso EC2 (SP)** | no | — | **Estimado** | `palanca-01-ec2.md` (Tarea 3.3) |
| **2 — Compromiso RDS (+ adyacentes)** | no | — | **Estimado** | `palanca-02-rds.md` (Tarea 4.3) |
| **3 — Extended Support EOL (RDS)** | no | — | **Garantizado** (condicionado a upgrade + compat. app) | `palanca-03-extended-support.md` (Tarea 5.3) |
| **4 — Logs CloudWatch / WAF** | no | — | **Estimado** | `palanca-04-logs.md` (Tarea 6.3) |
| **5 — Aurora no-prod Helios** | no | — | **Estimado** (resource-verified) | `palanca-05-aurora-helios.md` (Tarea 7.3) |
| **6 — EBS** | **sí** | 6a gp2→gp3 | **Estimado** | `palanca-06a-gp2-gp3.md` |
| | | 6b snapshots | **Estimado** | `palanca-06b-snapshots.md` |
| | | 6c volúmenes huérfanos | **Garantizado** | `palanca-06c-volumenes-huerfanos.md` (Tarea 8.3) |
| **7 — S3 lifecycle / IT** | no | — | **Estimado** | `palanca-07-s3.md` (Tarea 9.3) |
| **8 — Red (NAT/VPN/EIP/endpoints)** | **sí** | 8a IPv4 idle + VPC endpoint dup | **Garantizado** | `palanca-08-red.md` (Tarea 10.3) |
| | | 8b NAT (rediseño no-prod) | **Estimado** | ídem |
| | | 8c VPN candidatas a revisión | **Estimado** (contingente) | ídem |
| **9 — Rightsizing / Graviton** | no | — | **Estimado** | `palanca-09-rightsizing.md` (Tarea 11.3) |
| **10 — No-prod scheduling / Spot** | no | — | **Estimado** | `palanca-10-noprod-spot.md` (Tarea 12.3) |
| **11 — Bedrock** | no | — | **Estimado** | `palanca-11-bedrock.md` (Tarea 13.3) |
| **12 — Contrato Marketplace** | n/a | — | **Palanca_Comercial** (no técnica, excluida del total técnico) | `palanca-12-marketplace.md` (Tarea 14.1) |

### Verificación Property 4

- **Exhaustividad.** Las 11 Palancas técnicas tienen clasificación. Las mixtas (6 y 8) se parten en
  Sub_Palancas y **cada Sub_Palanca** tiene exactamente una clasificación (Req 3.4). Ninguna Palanca
  ni Sub_Palanca queda sin clasificar.
- **Exclusión mutua.** Ninguna Palanca/Sub_Palanca pertenece simultáneamente a Garantizado y a
  Estimado. La partición de las mixtas asigna desperdicio puro → Garantizado y lo sujeto a supuestos
  → Estimado, sin solapes.
- **Exclusión de no-técnicas.** La Palanca 12 (Marketplace) está clasificada como
  **Palanca_Comercial**, **fuera** del conjunto {Garantizado, Estimado} y **nunca** contabilizada en
  el total de ahorro técnico (Req 1.5, 17.3) → correctamente excluida del universo de Property 4.
- **Concordancia con las clasificaciones congeladas del contexto:** Garantizado = {Palanca 3
  $833,28/mes futuro, Palanca 6c $232,20/mes, Palanca 8a $45,88/mes}; Estimado = {1, 2, 4, 5, 6a, 6b,
  7, 8b, 8c, 9, 10, 11}. **Coincide exactamente.**

> **VEREDICTO Property 4 (Req 3.1, 17.3): ✅ PASS** — clasificación única y exhaustiva
> {Garantizado | Estimado} por Palanca técnica; mixtas correctamente partidas; Palanca_Comercial
> excluida del total técnico.

---

## 2. Invariante de rango del Ahorro_Estimado (Property 5)

Para cada Palanca/Sub_Palanca **Estimado**, rango mensual en USD y comprobación
`0 < Conservador ≤ Agresivo`:

| Palanca / Sub_Palanca | Rango_Conservador (USD/mes) | Rango_Agresivo (USD/mes) | `0 < C ≤ A` | ¿Cifra única? |
|-----------------------|----------------------------:|-------------------------:|:-----------:|:-------------:|
| 1 — Compromiso EC2 | 1 347,77 | 1 780,99 | ✅ | No (rango) |
| 2 — Compromiso RDS | 1 732,78 | 2 548,20 | ✅ | No (rango) |
| 4 — Logs CW/WAF | 1 419,51 | 1 921,80 | ✅ | No (rango) |
| 5 — Aurora Helios | 425,57 | 723,47 | ✅ | No (rango) |
| 6a — gp2→gp3 | 151,76 | 212,38 | ✅ | No (rango) |
| 6b — Snapshots EBS | 20,15 | 60,44 | ✅ | No (rango) |
| 7 — S3 lifecycle/IT | 955,35 | 1 389,60 | ✅ | No (rango) |
| 8b — NAT (no-prod) | 65,71 | 98,57 | ✅ | No (rango) |
| 8c — VPN (contingente) | 68,44 | 273,76 | ✅ | No (rango) |
| 9 — Rightsizing/Graviton | 574,27 | 1 531,39 | ✅ | No (rango) |
| 10 — No-prod sched/Spot | 252,30 | 542,80 | ✅ | No (rango) |
| 11 — Bedrock | 488,41 | 1 016,08 | ✅ | No (rango) |

### Verificación Property 5

- **12/12** Sub_Palancas Estimado cumplen `0 < Conservador ≤ Agresivo` (estricta positividad del
  límite inferior y orden no estricto entre límites). El caso más ajustado mantiene `C < A` con
  holgura amplia; ninguno tiene `C = 0` ni `C > A`.
- **Ninguna** Estimado se presenta como cifra única: todas se expresan como par
  (Conservador, Agresivo), en USD, con su anualizado ×12 y advertencia de estacionalidad (Req 6.1,
  6.3, 6.4).
- Cada rango es **reproducible**: deriva de la cifra base congelada × el supuesto de descuento/
  reducción declarado (origen "precio público AWS" con fecha `2026-06-23`), redondeo half-up a 2
  decimales sumando antes de redondear (Req 6.7).
- **Observación (no es violación):** la Sub_Palanca **8c (VPN)** es Estimado **contingente** —
  expresada como rango (cumple Property 5) pero **excluida del objetivo comprometido** hasta
  confirmación de owner de que las 8 VPN con ambos túneles DOWN no son backup/DR (Req 14.4, 5.3).
  Esto afecta a Property 12 (derivación de objetivos), no a la invariante de rango de Property 5.

> **VEREDICTO Property 5 (Req 3.3, 6.1): ✅ PASS** — toda Palanca Estimado se expresa como rango
> `(Conservador, Agresivo)` en USD con `0 < Conservador ≤ Agresivo`, nunca como cifra única.

---

## 3. Frescura de la verificación del Ahorro_Garantizado (Property 6)

Para cada Palanca/Sub_Palanca **Garantizado**, `Verificacion_Recurso_Vivo` asociada, estado y
frescura respecto a la extracción del `Dataset_Congelado` (`2026-06-23`):

| (Sub_)Palanca Garantizado | Cifra única (USD/mes) | Verificación viva (UTC) | Estado | Frescura | Comandos solo lectura |
|---------------------------|----------------------:|-------------------------|--------|---------:|------------------------|
| 3 — Extended Support (3 inst. prod/tooling PG13) | 833,28 (bruto) | `2026-06-23T08:54:09Z` | **confirmado** (3/7 siguen PG13 EOL) | 0 días | `rds describe-db-instances`, `describe-db-major-engine-versions`, `describe-db-engine-versions` |
| 6c — Volúmenes EBS huérfanos (27 vols) | 232,20 | `2026-06-23T09:01:54Z` | **confirmado** (27 `available`, sin tags warm-spare/forense/retención) | 0 días | `ec2 describe-volumes --filters Name=status,Values=available` |
| 8a — IPv4 idle (7 EIP) + VPC endpoint dup (1) | 45,88 | `2026-06-23T08:59:29Z`–`09:06Z` | **confirmado** (7 EIP sin asociación + 1 endpoint duplicado) | 0 días | `ec2 describe-addresses`, `describe-vpc-endpoints`, `describe-nat-gateways`, `describe-route-tables` |
| **Σ Ahorro_Garantizado** | **1 111,36** | | | | |

### Verificación Property 6

- **estado = confirmado.** Las 3 Sub_Palancas Garantizado tienen `Verificacion_Recurso_Vivo` con
  `estado = confirmado` (existencia y características asumidas confirmadas en vivo, solo lectura,
  `eu-west-1`).
- **Frescura ≤ 30 días.** Las tres verificaciones son del `2026-06-23`, **mismo día** que la
  extracción del `Dataset_Congelado` → frescura **0 días** ≤ 30 (Req 3.2). ✅
- **Disciplina de reclasificación/retirada ante fallo (Req 3.5, 5.3) — aplicada y evidenciada:**
  - **Palanca 3 (drift):** 4 de las 7 instancias EOL (`digital-dev`/`digital-uat` `oms`+`payments-api`)
    se verificaron ya migradas a PG18.4 → **retiradas del Garantizado futuro** (su Extended Support se
    extingue). Solo las **3 prod/tooling** confirmadas aún en PG13 permanecen como Garantizado
    (`833,28 USD/mes`). La cifra base de coste de mayo sigue anclada (Req 7.6), pero el ahorro
    comprometido se ajusta al recurso vivo confirmado.
  - **Palanca 8c (VPN):** las 8 VPN con ambos túneles DOWN **no** se clasificaron como Garantizado
    (un túnel DOWN ≠ desperdicio; puede ser backup/DR). Quedaron como Estimado contingente, excluido
    del objetivo hasta confirmación de owner (Req 14.4, 5.3) → disciplina correcta.
  - **Palanca 6c:** ningún volumen huérfano con etiquetas warm-spare/forense/retención en este
    barrido; la regla de exclusión (Req 10.7) queda documentada para futuras re-ejecuciones.
- **Caveats documentados (no son violaciones de Property 6):**
  1. **Gate de publicación (Req 3.2).** La frescura se mide aquí contra la fecha de extracción
     (`2026-06-23` → 0 días). El Req 3.2 exige ≤ 30 días respecto a la **fecha de publicación del
     Informe**. Si el Informe se publica > 30 días después del `2026-06-23`, las 3 verificaciones
     **deben re-ejecutarse** antes de mantener la clasificación Garantizado. Los propios artefactos
     lo señalan.
  2. **Composición de la cifra 8a.** De los `45,88 USD/mes`, la porción **IPv4 idle (30,82)** está
     anclada directamente al CUR; la porción **VPC endpoint duplicado (15,06)** se obtiene por precio
     unitario derivado del propio `Dataset_Congelado` aplicado a la configuración confirmada en vivo
     (el CUR agrega todos los endpoints de Digital Prod en una sola línea). El artefacto ofrece un
     **piso conservador de 30,82 USD/mes** (solo IPv4 idle aislada del CUR) si dirección exige que el
     Garantizado comprometido use exclusivamente cifras aisladas directamente del CUR. El recurso
     está live-confirmado en ambos casos → Property 6 se cumple; es una nota de trazabilidad de la
     cifra, no un fallo de verificación.

> **VEREDICTO Property 6 (Req 3.2, 3.5, 5.3): ✅ PASS** — las 3 Sub_Palancas Garantizado tienen
> `Verificacion_Recurso_Vivo` `confirmado` con frescura 0 días ≤ 30; la disciplina de
> reclasificar/retirar ante fallo está aplicada (drift PG18.4 en Palanca 3; VPN DOWN → Estimado en
> 8c). **Condición de publicación:** re-verificar si el Informe se publica > 30 días tras
> `2026-06-23`.

---

## 4. Resumen de veredictos

| Property | Requisitos | Veredicto | Síntesis |
|----------|------------|:---------:|----------|
| **Property 4** — Clasificación exhaustiva y mutuamente excluyente | 3.1, 17.3 | ✅ **PASS** | 11 Palancas técnicas con clasificación única {Garantizado\|Estimado}; mixtas (6, 8) partidas en Sub_Palancas; Palanca 12 = Comercial, excluida del total técnico |
| **Property 5** — Invariante de rango del Estimado | 3.3, 6.1 | ✅ **PASS** | 12/12 Sub_Palancas Estimado con `0 < Conservador ≤ Agresivo`, en USD, siempre como rango (nunca cifra única) |
| **Property 6** — Frescura de la verificación del Garantizado | 3.2, 3.5, 5.3 | ✅ **PASS** | 3 Sub_Palancas Garantizado con `Verificacion_Recurso_Vivo` `confirmado`, frescura 0 días ≤ 30; disciplina de reclasificación aplicada (drift PG3→PG18.4; VPN DOWN→Estimado). Re-verificar al publicar si > 30 días desde `2026-06-23` |

**Total Ahorro_Garantizado verificado:** `833,28 + 232,20 + 45,88 = ` **1 111,36 USD/mes**
(`13 336,32 USD/año` ×12, con advertencia de estacionalidad y, en Extended Support, de salto a tramo
Año 3 si el upgrade se retrasa más allá de `2028-02-28`).

## 5. Hallazgos y recomendaciones (no bloquean el veredicto)

1. **Gate de frescura a la publicación (Property 6 / Req 3.2).** Antes de publicar el Informe,
   confirmar que la fecha de publicación está dentro de 30 días de `2026-06-23`; en caso contrario,
   re-ejecutar las 3 `Verificacion_Recurso_Vivo` (Extended Support, volúmenes huérfanos, EIP/endpoint).
2. **Cifra 8a — doble lectura.** Documentar en el Informe ambas lecturas del Garantizado de red:
   `45,88 USD/mes` (por defecto, incluye VPC endpoint duplicado valorado por precio unitario del
   dataset) y `30,82 USD/mes` (piso conservador, solo IPv4 idle aislada del CUR).
3. **8c VPN — pendiente de owner.** La Sub_Palanca 8c cumple Property 5 como rango, pero su elevación
   a objetivo depende de la confirmación de owner (backup/DR vs retirada). Mantener fuera del
   `Objetivo_Comprometido` (auditoría Property 12, Tarea 17.8).
4. **Palanca 3 — ventana de captura.** El ahorro Garantizado futuro (`833,28 USD/mes`, 3 instancias
   PG13) se duplicaría en coste evitado si el upgrade se retrasa más allá de `2028-02-28` (salto a
   tramo Año 3). Priorizar.

## Estado de ejecución

- ✅ **Auditoría ejecutada** sobre el `Catálogo_Evidencias` y el `Dataset_Congelado`
  `frozen-2026-05@2026-06-23`.
- ✅ **Property 4: PASS** · **Property 5: PASS** · **Property 6: PASS** (con gate de frescura a la
  publicación).
- Re-ejecutable: re-leer los ficheros `evidencias/palanca-*.md` y re-comprobar las tres invariantes
  produce el mismo veredicto mientras el `Dataset_Congelado` y las verificaciones vivas no cambien.
