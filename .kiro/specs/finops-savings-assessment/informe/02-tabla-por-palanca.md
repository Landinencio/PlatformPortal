# Informe FinOps de Ahorro AWS — Tabla por Palanca (Tarea 19.2)

> Sección del **Informe** (entregable analítico, no software). Una **fila por Palanca** (y por
> Sub_Palanca cuando la Palanca es mixta) con todas las columnas exigidas por el Req 19.3:
> clasificación, ahorro mensual y anualizado, supuesto (% a 1 decimal) + origen + fecha,
> % direccionable + coste base mensual afectado, riesgo, esfuerzo, responsable (owner) y estado de
> `Barrido_Utilizacion`. Las Palancas pendientes de barrido se marcan explícitamente (Req 18.5).
>
> **Validates: Requirements 19.1, 19.3, 18.5, 6.2**

## Anclaje y convenciones

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` (2 decimales, half-up; sumas calculadas antes de redondear — Req 6.7) |
| Anualización | mensual × 12; **asume Mes_Referencia representativo y NO captura estacionalidad** (Req 6.4) |
| Origen de los supuestos % | salvo el contrato Marketplace (tarifa negociada), todo es **precio público AWS** a fecha `2026-06-23`, a re-confirmar contra la calculadora vigente |
| Trazabilidad | cada fila referencia su registro en el `Catálogo_Evidencias` (`evidencias/palanca-*.md`); el anexo de evidencias (Tarea 19.3) recoge consultas CUR y verificaciones |

**Clasificación** ∈ {Garantizado, Estimado, Comercial}. `Garantizado*` = **Garantizado condicionado**
(a una acción previa, p. ej. upgrade de motor). Los **Estimado** se expresan **siempre como rango**
Conservador–Agresivo (invariante `0 < Conservador ≤ Agresivo`); los **Garantizado** como **cifra
única**. Las cifras de la Palanca 12 (Comercial) se señalan aparte y **nunca** entran en el ahorro
técnico (Req 17.3).

**Estado de `Barrido_Utilizacion`**: `completado` / `pendiente` / `parcial→pendiente` / `n/a`
(no requiere barrido: Garantizado, o Estimado cuyo rango no depende de perfil de uso) / `no requerido`.
Solo un Estimado con barrido **completado** puede elevar su Rango_Conservador a objetivo comprometido
(Req 18.2; derivación en la Tarea 19.4).

---

## Tabla por Palanca — clasificación, ahorro y supuesto

| # | Palanca (Sub_Palanca) | Clasificación | Ahorro mensual (USD) | Ahorro anualizado ×12 (USD) | Supuesto (% 1 decimal) | Origen + fecha |
|---|------------------------|---------------|----------------------|-----------------------------|------------------------|----------------|
| 1 | Compromiso EC2 (Savings Plans) | Estimado | **1 347,77 – 1 780,99** | **16 173,27 – 21 371,82** | reducción **28,0 %** (Compute SP) – **37,0 %** (EC2 Instance SP) | precio público AWS · 2026-06-23 |
| 2 | Compromiso RDS (Reserved Instances) | Estimado | **1 732,78 – 2 548,20** | **20 793,33 – 30 578,42** | reducción **34,0 %** (RI 1 año no-upfront) – **50,0 %** (RI 3 años partial-upfront) | precio público AWS · 2026-06-23 |
| 2b | └ Adyacente: ElastiCache Reserved Nodes | Estimado (pendiente verificación) | 123,37 – 185,05 | 1 480,39 – 2 220,59 | reducción **30,0 % – 45,0 %** | precio público AWS · 2026-06-23 |
| 3 | Extended Support PG13 (RDS) | **Garantizado\*** (condicionado a upgrade de motor + validación de compatibilidad) | **833,28** (bruto) · 766,62 (neto) | **9 999,36** (bruto) · 9 199,44 (neto) | **100,0 %** (supresión íntegra del cargo) | precio público AWS (cargo observado en CUR) · 2026-06-23 |
| 4 | Logs CloudWatch y WAF | Estimado | **1 419,51 – 1 921,80** (bruto) · 1 189,98 – 1 611,05 (neto) | **17 034,11 – 23 061,56** (bruto) · 14 279,77 – 19 332,61 (neto) | reducción **65,0 % – 88,0 %** sobre base WAF (redirección a S3 + muestreo + metric filters) | precio público AWS · 2026-06-23 |
| 5 | Aurora no productivo de Helios | Estimado | **425,57 – 723,47** (bruto) · 391,52 – 665,59 (neto) | **5 106,82 – 8 681,59** (bruto) · 4 698,27 – 7 987,06 (neto) | reducción **50,0 %** (solo reader) – **85,0 %** (reader + downsize + scheduling) | precio público AWS · 2026-06-23 |
| 6a | EBS: migración gp2→gp3 | Estimado | **151,76 – 212,38** | **1 821,12 – 2 548,56** | reducción neta **15,0 % – 21,0 %** sobre base gp2 | precio público AWS · 2026-06-23 |
| 6b | EBS: snapshots elegibles | Estimado | **20,15 – 60,44** | **241,76 – 725,27** | supresión **100,0 %** del subconjunto elegible (% direccionable 5,0 – 15,0 %) | precio público AWS · 2026-06-23 |
| 6c | EBS: volúmenes huérfanos (`available`) | **Garantizado** | **232,20** | **2 786,40** | **100,0 %** (eliminación del volumen ocioso) | precio público AWS · 2026-06-23 |
| 7 | S3 lifecycle e Intelligent-Tiering | Estimado | **955,35 – 1 389,60** | **11 464,20 – 16 675,20** | transición de clase sobre lo direccionable (≈ **55,0 % – 80,0 %** del coste direccionable) | precio público AWS · 2026-06-23 |
| 8a | Red: IPv4 ociosa + VPC endpoint duplicado | **Garantizado** | **45,88** | **550,56** | **100,0 %** (liberar EIP ociosa / borrar endpoint duplicado) | precio público AWS · 2026-06-23 |
| 8b | Red: NAT — rediseño de redundancia no-prod | Estimado | **65,71 – 98,57** | **788,52 – 1 182,84** | reducción **12,5 % – 18,8 %** del coste de NAT-horas (colapsar 2–3 de 16 NAT-mes) | precio público AWS · 2026-06-23 |
| 8c | Red: VPN candidatas a revisión | Estimado (contingente, **no comprometible**) | **68,44 – 273,76** | **821,28 – 3 285,12** | reducción **10,5 % – 42,1 %** del coste VPN (2–8 de 19 conexiones-mes) | precio público AWS · 2026-06-23 |
| 9 | Rightsizing y Graviton (utilización real) | Estimado | **574,27 – 1 531,39** | **6 891,26 – 18 376,70** | reducción **15,0 % – 40,0 %** por p95 (Graviton subsumido por riesgo arm64) | precio público AWS · 2026-06-23 |
| 10 | Entornos no-prod: scheduling y Spot | Estimado | **252,30 – 542,80** | **3 027,60 – 6 513,62** | 10a scheduling **30,0 % – 65,0 %** · 10b Spot **25,0 % – 50,0 %** efectivo | precio público AWS · 2026-06-23 |
| 11 | Bedrock (IA generativa) | Estimado | **488,41 – 1 016,08** | **5 860,97 – 12 192,95** | reducción **22,5 % – 46,7 %** (prompt caching + reducción de output + cambio de modelo) | precio público AWS / Anthropic · 2026-06-23 |
| 12 | Contrato Marketplace | **Comercial** (no contabilizado) | contrato **85 000,55 (PUNTUAL)** + PAYG **6 663,33/mes** | PAYG 79 960,00/año · contrato **no ×12** | **pendiente** (depende de renegociación / ajuste en renovación) | tarifa negociada (términos no disponibles) · 2026-06-23 |

> Notas de las cifras: P3 se publica en **bruto** (objetivo real a fecha de verificación: 3 instancias
> prod/tooling aún en PG13; las 4 dev/uat ya migradas a PG18.4 quedan fuera). P4/P5 muestran bruto y
> neto (el neto descuenta SPP/Bundled). P12 es coste, **no ahorro técnico**: se señala aparte (Req 17.3);
> el contrato (85 000,55) es un **cargo puntual prepagado** (gotcha #3), **no recurrente mensual y no se anualiza × 12**.

---

## Tabla por Palanca — % direccionable, coste base, riesgo, esfuerzo, responsable y barrido

| # | Palanca (Sub_Palanca) | % direccionable | Coste base mensual afectado (USD) | Riesgo | Esfuerzo | Responsable (owner) | Estado `Barrido_Utilizacion` |
|---|------------------------|-----------------|-----------------------------------|--------|----------|---------------------|------------------------------|
| 1 | Compromiso EC2 (Savings Plans) | **67,0 %** del on-demand cubrible | **4 813,47** (porción on-demand estable) | Medio | Bajo | **pendiente** (SRE / Plataforma) | **completado** (Tarea 16.1) |
| 2 | Compromiso RDS (Reserved Instances) | **77,0 %** del cómputo de instancia RDS | **5 096,40** (prod estable, de 6 616,31) | Medio | Bajo | **pendiente** (Digital + SRE / Plataforma) | **completado** (Tarea 16.1) |
| 2b | └ ElastiCache Reserved Nodes | s/ base adyacente | 411,22 | Medio | Bajo | **pendiente** (Digital + SRE) | **pendiente** (verificación + barrido propios) |
| 3 | Extended Support PG13 (RDS) | **100,0 %** del cargo de Extended Support | **833,28** (3 instancias prod/tooling PG13) | **Alto** (compatibilidad app; prod MultiAZ; salto de versión mayor) | **Alto** (upgrade RDS major, ventana + rollback) | **pendiente** (Digital — `oms` / `payments-api`) | **n/a** (Garantizado; supresión de cargo verificado, no depende de uso) |
| 4 | Logs CloudWatch y WAF | **78,7 %** del total VendedLog | **2 183,86** (bruto) · 1 830,74 (neto) — logs WAF | Medio | Medio | **pendiente** (Digital ecommerce + SRE / Plataforma) | **no requerido** (rango no depende de perfil 24/7) |
| 5 | Aurora no productivo de Helios | **100,0 %** (4 instancias no-prod) | **851,14** (bruto) · 783,05 (neto) | Medio | Medio | **pendiente** (Helios) | **completado** para el Conservador (Tarea 16.3); extras del Agresivo siguen Estimado |
| 6a | EBS: gp2→gp3 | **100,0 %** de la base gp2 | **1 011,76** | bajo | bajo | **pendiente** (SRE por cuenta) | **no requerido** (pendiente verificación `describe-volumes` para fijar el % neto exacto) |
| 6b | EBS: snapshots elegibles | **5,0 – 15,0 %** del coste de snapshots | **402,93** | bajo | bajo | **pendiente** (SRE por cuenta) | **no requerido** (elegibilidad por `describe-snapshots`/`describe-images`) |
| 6c | EBS: volúmenes huérfanos | **100,0 %** (27 volúmenes confirmados) | **232,20** | bajo | bajo | **pendiente** (SRE por cuenta) | **n/a** (Garantizado verificado en vivo, frescura ≤ 30 días) |
| 7 | S3 lifecycle e Intelligent-Tiering | **80,0 %** del coste Standard (direccionable 1 737,00) | **2 170,80** (S3 Standard) | Medio | Medio | **pendiente** (Data + SRE / Plataforma + Digital ecommerce) | **no requerido** (rango no depende de perfil de uso) |
| 8a | Red: IPv4 ociosa + VPC endpoint duplicado | **100,0 %** del recurso ocioso (1,6 % de la base de red) | **45,88** (de base de red 2 843,02) | bajo | bajo | **pendiente** (SRE) | **n/a** (Garantizado verificado en vivo) |
| 8b | Red: NAT rediseño no-prod | **2,3 – 3,5 %** de la base de red (NAT-horas 525,68) | **525,68** (coste de NAT-horas) | medio-alto (pérdida de HA + transfer cross-AZ) | alto (rediseño de routing) | **pendiente** (SRE) | **no requerido** (sujeto a rediseño aprobado por dirección; fuera del piso comprometido si no se aprueba) |
| 8c | Red: VPN candidatas a revisión | **2,4 – 9,6 %** de la base de red (VPN 650,26) | **650,26** (coste VPN IPsec) | medio (alto si se elimina una VPN de DR) | medio (coordinación con owners) | **pendiente** (SRE + tiendas PT + Sistemas TA + Data) | **excluido del objetivo** hasta confirmación de owner (Req 14.4) |
| 9 | Rightsizing y Graviton | **63,6 %** de los candidatos 24/7 | **3 828,48** (6 instancias x86 no burstable) | **Alto** (capacidad sin p95 de RAM + incompatibilidad arm64) | Medio | **pendiente** (SAP, Data, SRE/Infra, Clinicanimal) | **pendiente al 100 %** (Tarea 16.2; sin p95 de RAM no hay propuesta comprometida) |
| 10 | Entornos no-prod: scheduling y Spot | **98,9 %** del cómputo no-prod on-demand | **856,39** (10a 764,05 + 10b 92,35) | medio | medio | **pendiente** (SRE + Digital / Helios / Comerzzia / Data) | **parcial → pendiente** (Tarea 16.3; 10a sin horas reducibles defendibles, 10b inmaterial) |
| 11 | Bedrock (IA generativa) | **99,8 %** del Bedrock de la organización (cuentas Data) | **2 175,00** (iskaypet-data 1 782,80 + data-dev 392,20) | **Alto** (producto del squad Data; optimizar puede degradar calidad del modelo) | Medio | **pendiente** (squad Data + SRE / FinOps) | **no requerido** (rango no depende de perfil 24/7; previo a desplegar: evals de calidad) |
| 12 | Contrato Marketplace | **0,0 %** técnico (direccionamiento **comercial**) | contrato 85 000,55 **(puntual/prepago)** + PAYG 6 663,33/mes | **pendiente** (depende de términos de renegociación) | **pendiente** (proceso de compras, no de ingeniería) | **pendiente** (Dirección + Compras) | **n/a** — cargo puntual no recurrente; fecha de renovación **pendiente** (Req 17.4, 17.5) |

---

## Marcado explícito de Palancas pendientes de barrido (Req 18.5)

El Req 18.5 exige identificar qué Palancas tienen `Barrido_Utilizacion` **completado** y cuáles
**pendientes**. Resumen a efectos de comprometer objetivos:

- **Barrido COMPLETADO (Estimado elegible para objetivo comprometido, su Rango_Conservador entra en la derivación de la Tarea 19.4):**
  - **Palanca 1** — EC2 Savings Plans (base 100 % estable, mín. 96,0 % de horas).
  - **Palanca 2** — RDS Reserved Instances (base 100 % estable, todos los recursos a 744 h).
  - **Palanca 5** — Aurora no-prod Helios, **solo el Rango_Conservador** (eliminación del reader con consolidación). Los extras del Agresivo (downsize + scheduling del writer) siguen Estimado, no comprometibles.

- **Barrido PENDIENTE (Estimado que se presenta SOLO como rango, fuera del objetivo comprometido — Req 18.2):**
  - **Palanca 9** — Rightsizing/Graviton: **pendiente al 100 %** (falta p95 de RAM en todas las cuentas; sin él no se propone rightsizing comprometido, Req 13.2).
  - **Palanca 10** — Scheduling/Spot no-prod: **barrido parcial → pendiente** (Req 18.3); 10a sin horas reducibles defendibles desde facturación, 10b (Spot EMR TASK) inmaterial.
  - **Palanca 8c** — VPN candidatas a revisión: **excluida del objetivo** hasta que el owner clasifique cada VPN como retirada (elegible) vs backup/DR (excluida).
  - **Adyacente 2b** — ElastiCache Reserved Nodes: pendiente de su propia `Verificacion_Recurso_Vivo` y barrido.

- **No requiere barrido (Estimado cuyo rango no depende de perfil de utilización):** Palancas **4** (logs), **6a** (gp2→gp3), **6b** (snapshots), **7** (S3) y **11** (Bedrock). La **8b** (NAT) no requiere barrido pero su entrada al piso comprometido depende de aprobación de rediseño por dirección.

- **No aplica barrido (Garantizado, desperdicio puro verificado en vivo):** Palancas **3** (Extended Support, Garantizado condicionado a upgrade), **6c** (volúmenes huérfanos) y **8a** (IPv4 ociosa + VPC endpoint duplicado).

- **Comercial (fuera del ahorro técnico, sin barrido):** Palanca **12** (contrato Marketplace).

---

## Subtotales por clasificación (para el resumen ejecutivo y la derivación de objetivos)

> Sumas calculadas antes de redondear (half-up, USD). Los totales Estimado se presentan como **suma de
> Conservadores – suma de Agresivos** (Req 6.6), nunca como cifra puntual. Detalle completo de la
> derivación de objetivos comprometidos en la Tarea 19.4.

| Bloque | Mensual (USD) | Anualizado ×12 (USD) |
|--------|---------------|----------------------|
| **Σ Ahorro_Garantizado** (6c 232,20 + 8a 45,88) | **278,08** | **3 336,96** |
| **Ahorro_Garantizado\* condicionado** (Palanca 3) | 833,28 (bruto) | 9 999,36 (bruto) |
| **Σ Ahorro_Estimado — rango total** (Palancas 1, 2, 4, 5, 6a, 6b, 7, 8b, 9, 10, 11) | **7 433,58 – 11 825,72** | **89 202,96 – 141 908,64** |
| **Ahorro_Estimado contingente / pendiente** (8c VPN, 2b ElastiCache) | (8c) 68,44 – 273,76 · (2b) 123,37 – 185,05 | (8c) 821,28 – 3 285,12 · (2b) 1 480,39 – 2 220,59 |
| **Palanca_Comercial** (Marketplace, no contabilizada) | contrato 85 000,55 **(puntual)** + PAYG 6 663,33/mes | PAYG 79 960,00 (contrato no ×12) |

> El **Σ Ahorro_Estimado — rango total** suma las 11 Palancas Estimado del cuerpo principal
> (Conservadores: 1 347,77 + 1 732,78 + 1 419,51 + 425,57 + 151,76 + 20,15 + 955,35 + 65,71 + 574,27 +
> 252,30 + 488,41 = **7 433,58**; Agresivos: 1 780,99 + 2 548,20 + 1 921,80 + 723,47 + 212,38 + 60,44 +
> 1 389,60 + 98,57 + 1 531,39 + 542,80 + 1 016,08 = **11 825,72**). Excluye la adyacente ElastiCache
> (2b) y la VPN contingente (8c), que se reportan aparte por estar pendientes/contingentes, y excluye
> la Palanca_Comercial. El **Objetivo_Comprometido** (Tarea 19.4) NO es esta suma: se restringe a
> `Σ Garantizado + Σ Conservador(Estimado con Barrido completado)` = Garantizado (278,08) + Conservador
> de Palancas 1, 2 y 5 — más el tratamiento de la Palanca 3 (Garantizado condicionado).
