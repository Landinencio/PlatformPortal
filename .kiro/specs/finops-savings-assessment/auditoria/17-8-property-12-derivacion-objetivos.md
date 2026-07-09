# Auditoría 17.8 — Derivación cerrada de los objetivos comprometidos (Property 12)

> **Tarea 17.8** del Estudio FinOps de Ahorro AWS. **Auditoría re-ejecutable** de una *Correctness
> Property* sobre el `Catálogo_Evidencias`, los `Barrido_Utilizacion` (16.1/16.2/16.3) y el
> `Dataset_Congelado` — **no** es un test de código (entregable analítico).
>
> **Property 12 — Derivación cerrada de los objetivos.** *Para toda* edición del Informe, el objetivo
> de ahorro comprometido es igual a la suma del total de Ahorro_Garantizado más la suma de los
> `Rango_Conservador` de las Palancas Estimado **con `Barrido_Utilizacion` completado**, y excluye
> toda Palanca Estimado sin `Barrido_Utilizacion` (o con barrido parcial) y toda Palanca_Comercial.
>
> **Validates: Requirements 18.2, 19.4, 19.6**
>
> Este fichero es el **artefacto NUEVO y DEDICADO** de la Tarea 17.8. **No** modifica ningún otro
> fichero del spec (evidencias, barridos, catálogo, design, tasks, ni las auditorías 17.x). Recalcula
> de forma independiente la fórmula cerrada del objetivo comprometido y verifica las exclusiones.

## Parámetros de anclaje (Req 2.5)

| Campo | Valor |
|-------|-------|
| `id_auditoria` | `AUD-17.8-derivacion-objetivos` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` (2 decimales, redondeo half-up; suma antes de redondear, Req 6.7) |
| Fecha de la auditoría | `2026-06-23` (UTC) |
| Naturaleza | Auditoría de derivación (recálculo independiente sobre cifras congeladas + estado de barridos); no ejecuta consultas CUR ni verificaciones en vivo nuevas |
| Fuentes | `auditoria/17-3-property-4-5-6-clasificacion.md` (clasificación + Σ Garantizado), `auditoria/17-5-property-8-9-anualizacion-redondeo.md` (anticipo de totales), `evidencias/barrido-16-1-steady-state.md` (P1/P2), `evidencias/barrido-16-2-rightsizing-p95.md` (P9), `evidencias/barrido-16-3-scheduling-spot.md` (P5/P10), `design.md` (Property 12 + Regla de derivación) |

## Definición auditada (del `design.md` y Req 18.2 / 19.4 / 19.6)

```
Objetivo_Comprometido =  Σ Ahorro_Garantizado
                       +  Σ Rango_Conservador( Palancas Estimado CON Barrido_Utilizacion completado )

Excluidos del objetivo comprometido:
  - Palancas Estimado SIN Barrido_Utilizacion completado  → solo rango estimado
  - Palancas Estimado con Barrido PARCIAL                  → tratadas como pendientes (Req 18.3)
  - Palancas_Comerciales (contrato Marketplace)            → señaladas aparte, nunca en el objetivo
```

- **Req 18.2** — una Palanca Estimado **sin** `Barrido_Utilizacion` completado se presenta **solo como
  rango**, nunca como objetivo comprometido.
- **Req 19.4** — el objetivo se deriva de `Σ Garantizado + Rango_Conservador(Estimado con barrido completado)`.
- **Req 19.6** — el Informe identifica explícitamente qué Palancas quedan **pendientes** de barrido y,
  por tanto, **fuera** de los objetivos comprometidos.

---

## 1. Insumo A — Σ Ahorro_Garantizado (heredado y reverificado de la auditoría 17.3)

El Garantizado **no** requiere `Barrido_Utilizacion` (es desperdicio puro live-confirmado, no un
supuesto de utilización); entra íntegro en el objetivo. Cifras congeladas (USD/mes):

| (Sub_)Palanca Garantizado | Mensual (USD) | Verificación viva (17.3) |
|---------------------------|--------------:|--------------------------|
| P3 — Extended Support (3 inst. prod/tooling PG13, condicionado a upgrade) | 833,28 | `confirmado` 0 días |
| P6c — Volúmenes EBS huérfanos (27 vols `available`) | 232,20 | `confirmado` 0 días |
| P8a — IPv4 idle (7 EIP) + VPC endpoint duplicado | 45,88 | `confirmado` 0 días |
| **Σ Ahorro_Garantizado (mensual)** | **1 111,36** | — |

> `833,28 + 232,20 + 45,88 = 1 111,36` ✓ (coincide con la auditoría 17.3 §3 y el anticipo 17.5 §5).
> **Piso conservador alternativo:** si dirección exige que el Garantizado use exclusivamente cifras
> aisladas directamente del CUR, P8a baja a **30,82** (solo IPv4 idle) → Σ Garantizado = **1 096,30**
> (variante documentada en §4).

## 2. Insumo B — Σ Rango_Conservador de Palancas Estimado CON Barrido_Utilizacion completado

Gate de elegibilidad: una Palanca Estimado entra en el objetivo **solo si su `Barrido_Utilizacion`
está completado** (Req 18.1–18.4). Estado de los barridos según 16.1/16.2/16.3:

| Palanca Estimado | Barrido | Veredicto del barrido | Fuente | ¿Elegible? | Rango_Conservador (USD/mes) |
|------------------|---------|-----------------------|--------|:----------:|----------------------------:|
| **P1 — Compromiso EC2 (SP)** | steady-state | **CONFIRMADO** (100 % base estable, mín. 96,0 % h) | `barrido-16-1` | ✅ **Sí** | **1 347,77** |
| **P2 — Compromiso RDS (RI)** | steady-state | **CONFIRMADO** (100 % base estable, todos a 744 h) | `barrido-16-1` | ✅ **Sí** | **1 732,78** |
| **P5 — Aurora no-prod Helios** | scheduling/uso | **COMPLETO (Conservador)** (reader 24/7 + holgura writer → eliminación defendida) | `barrido-16-3` | ✅ **Sí** | **425,57** |
| **Σ Rango_Conservador (barrido completado)** | | | | | **3 506,12** |

> `1 347,77 + 1 732,78 + 425,57 = 3 506,12` ✓ (sumado antes de redondear, Req 6.7).
> P5 entra **solo** por su `Rango_Conservador` bruto (eliminación del reader, 50,0 %); los extras del
> `Rango_Agresivo` (downsize + scheduling del writer) siguen Estimado, **no** comprometidos.

## 3. Recálculo de la fórmula cerrada — Objetivo_Comprometido

```
Objetivo_Comprometido (mensual) = Σ Garantizado + Σ Conservador(Estimado con Barrido completado)
                                = 1 111,36 + 3 506,12
                                = 4 617,48  USD/mes

Objetivo_Comprometido (anual)   = 4 617,48 × 12
                                = 55 409,76  USD/año
```

Desglose de control (mensual → anual ×12, método purista "multiplicar antes de redondear", Req 6.7):

| Componente | Mensual (USD) | Anual ×12 (USD) |
|------------|--------------:|----------------:|
| Σ Garantizado (P3 + P6c + P8a) | 1 111,36 | 13 336,32 |
| P1 — EC2 SP (Conservador) | 1 347,77 | 16 173,27 |
| P2 — RDS RI (Conservador) | 1 732,78 | 20 793,33 |
| P5 — Aurora Helios (Conservador bruto) | 425,57 | 5 106,82 |
| **Objetivo_Comprometido** | **4 617,48** | **55 409,76** |

> **Nota de redondeo (Req 6.7 / Property 9):** sumar los **anuales** publicados da
> `13 336,32 + 16 173,27 + 20 793,33 + 5 106,82 = 55 409,74`, que difiere en **0,02 USD** del
> `4 617,48 × 12 = 55 409,76`. La diferencia es el artefacto esperado de que cada anual individual se
> obtuvo multiplicando su mensual **sin redondear** antes de redondear (método b). La cifra canónica
> del objetivo es **`55 409,76 USD/año`** (anualizar el total mensual comprometido). Llevar la
> advertencia de estacionalidad / mes representativo (Req 6.4): el ×12 asume mayo 2026 representativo
> y **no** captura estacionalidad.

## 4. Verificación de exclusiones (Req 18.2, 18.3, 19.6) — nunca un objetivo sin barrido

Confirmación explícita de que **toda** Palanca no elegible queda **fuera** del objetivo comprometido,
con su motivo:

| Palanca / Sub_Palanca | Clasificación | Estado barrido | Motivo de exclusión | ¿En objetivo? |
|-----------------------|---------------|----------------|---------------------|:-------------:|
| **P9 — Rightsizing/Graviton** | Estimado | **PENDIENTE (0 %)** | Sin p95 CPU+RAM por fuente designada (EC2 standalone fuera de EKS, RAM no instrumentada) — `barrido-16-2` (Req 13.1/13.2) | ❌ No |
| **P10 — Scheduling/Spot no-prod** | Estimado | **PARCIAL → PENDIENTE** | 10a (89,2 %) sin horas reducibles defendibles (demand-driven, baseline bajo SP); 10b Spot inmaterial — `barrido-16-3` (Req 18.3) | ❌ No |
| P4 — Logs CloudWatch/WAF | Estimado | no elevado | Estimado sin barrido completado elevado a objetivo → solo rango (Req 18.2) | ❌ No |
| P6a — gp2→gp3 | Estimado | no elevado | ídem — solo rango | ❌ No |
| P6b — Snapshots EBS | Estimado | no elevado | ídem — solo rango | ❌ No |
| P7 — S3 lifecycle/IT | Estimado | no elevado | ídem — solo rango | ❌ No |
| P8b — NAT no-prod | Estimado | no elevado | ídem — solo rango | ❌ No |
| P8c — VPN | Estimado **contingente** | no elevado | Contingente a confirmación de owner (backup/DR); fuera hasta confirmar (Req 14.4, 5.3) | ❌ No |
| P11 — Bedrock | Estimado | no elevado | ídem — solo rango | ❌ No |
| Adyacente — ElastiCache Reserved Nodes (de P2) | Estimado | **PENDIENTE** | Sin `Verificacion_Recurso_Vivo` ni barrido; no forma parte de la base RDS de 5 096,40 — `barrido-16-1` | ❌ No |
| **P12 — Contrato Marketplace** | **Palanca_Comercial** | n/a | No técnica; señalada aparte; **nunca** en el objetivo técnico (Req 17.3) | ❌ No (excluida por definición) |

**Resultado de la verificación:** las Palancas con barrido **completado** {P1, P2, P5} son las únicas
que aportan `Rango_Conservador` al objetivo. P9 (pendiente) y P10 (parcial → pendiente) quedan
**fuera** y se presentan solo como rango; el resto de Estimado no elevado (P4, P6a, P6b, P7, P8b, P8c,
P11, ElastiCache) también fuera; P12 (Comercial) excluida por definición. **Ningún Ahorro_Estimado
se presenta como objetivo comprometido sin su barrido** → Req 18.2 / 19.6 satisfechos.

### Variante de piso conservador (P8a = 30,82, solo IPv4 aislada del CUR)

Si dirección exige el piso del Garantizado por cifras aisladas directamente del CUR:

```
Σ Garantizado (piso)        = 833,28 + 232,20 + 30,82 = 1 096,30  USD/mes
Objetivo_Comprometido (piso, mensual) = 1 096,30 + 3 506,12 = 4 602,42  USD/mes
Objetivo_Comprometido (piso, anual)   = 4 602,42 × 12       = 55 229,04  USD/año
```

Ambas lecturas (45,88 por defecto / 30,82 piso) deben documentarse en el Informe (recomendación 17.3 §5.2).

---

## 5. Veredicto

> **VEREDICTO Property 12 (Req 18.2, 19.4, 19.6): ✅ PASS.**
>
> El `Objetivo_Comprometido` recalculado de forma cerrada es:
>
> | | Por defecto (P8a = 45,88) | Piso conservador (P8a = 30,82) |
> |---|--------------------------:|-------------------------------:|
> | **Σ Garantizado** | 1 111,36 | 1 096,30 |
> | **Σ Conservador (P1+P2+P5, barrido completado)** | 3 506,12 | 3 506,12 |
> | **Objetivo_Comprometido mensual** | **4 617,48 USD/mes** | **4 602,42 USD/mes** |
> | **Objetivo_Comprometido anual (×12)** | **55 409,76 USD/año** | **55 229,04 USD/año** |
>
> La fórmula cerrada `Objetivo = Σ Garantizado + Σ Conservador(Estimado con Barrido completado)` se
> cumple exactamente: las únicas Palancas Estimado que aportan son **P1, P2 y P5** (las tres con
> barrido **completado** en 16.1/16.3). Quedan **excluidas** y solo como rango: **P9** (barrido
> pendiente al 100 %), **P10** (barrido parcial → pendiente, Req 18.3), y el resto de Estimado no
> elevado (P4, P6a, P6b, P7, P8b, P8c contingente, P11, ElastiCache adyacente). La **Palanca 12
> (Marketplace)** queda excluida por ser **Palanca_Comercial** (nunca en el objetivo técnico). Ningún
> Ahorro_Estimado se presenta como objetivo comprometido sin su barrido.

## 6. Re-ejecución de la auditoría (procedimiento)

Auditoría **re-ejecutable**; reproduce el mismo veredicto mientras las cifras sigan ancladas a
`frozen-2026-05@2026-06-23` y los veredictos de barrido no cambien:

1. Releer Σ Garantizado de `auditoria/17-3` (§3) y confirmar `833,28 + 232,20 + 45,88 = 1 111,36`
   (o piso `1 096,30` con P8a = 30,82).
2. Releer el veredicto de cada barrido: `barrido-16-1` (P1/P2 CONFIRMADO), `barrido-16-3` (P5 COMPLETO
   Conservador, P10 PARCIAL→PENDIENTE), `barrido-16-2` (P9 PENDIENTE). Confirmar que **solo** P1, P2 y
   P5 son elegibles.
3. Recalcular `Σ Conservador = 1 347,77 + 1 732,78 + 425,57 = 3 506,12` (sumando antes de redondear).
4. Recalcular `Objetivo = 1 111,36 + 3 506,12 = 4 617,48` mensual y `× 12 = 55 409,76` anual.
5. Verificar que ninguna Palanca pendiente/parcial/comercial (P9, P10, P4, P6a, P6b, P7, P8b, P8c,
   P11, ElastiCache, P12) entra en el objetivo (§4).

Cualquier desviación indicaría un cambio en una cifra base o en un veredicto de barrido y debe
investigarse antes de publicar el Informe (Req 7.3).

## 7. Estado de ejecución

- ✅ **Auditoría ejecutada** sobre las cifras congeladas (17.3, 17.5) y los veredictos de barrido
  (16.1/16.2/16.3), ancladas a `frozen-2026-05@2026-06-23`.
- ✅ **Property 12: PASS.** `Objetivo_Comprometido = 4 617,48 USD/mes · 55 409,76 USD/año`
  (`= Σ Garantizado 1 111,36 + Σ Conservador{P1,P2,P5} 3 506,12`). Variante piso: `4 602,42 USD/mes ·
  55 229,04 USD/año`.
- ✅ **Exclusiones verificadas:** P9 (pendiente), P10 (parcial→pendiente), P4/P6a/P6b/P7/P8b/P8c/P11 +
  ElastiCache (Estimado no elevado), P12 (Comercial) — todas fuera del objetivo, con motivo.
- ⏭️ La composición final del Informe (Tarea 19) debe publicar esta derivación con su referencia al
  Catálogo_Evidencias (Req 19.5) y la doble lectura del Garantizado de red (45,88 / 30,82).
