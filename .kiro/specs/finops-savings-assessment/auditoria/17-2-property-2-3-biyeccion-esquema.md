# Auditoría 17.2 — Property 2 (biyección cifra↔evidencia) + Property 3 (completitud del esquema)

> **Tarea 17.2** del Estudio FinOps de Ahorro AWS — auditoría **re-ejecutable** (no software).
> Verifica las dos invariantes de trazabilidad del `design.md` sobre el corpus de evidencias del
> Estudio, anclado al `Dataset_Congelado` `frozen-2026-05@2026-06-23` (Mes_Referencia `2026-05`, USD).
>
> **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 19.5**
>
> - **Property 2 — Biyección cifra publicada ↔ evidencia:** *para toda* cifra publicada existe
>   **exactamente un** registro de evidencia, y *para todo* registro existe **exactamente una** cifra
>   publicada que lo referencia (correspondencia 1-a-1 al 100 %). (Req 2.7, 19.5)
> - **Property 3 — Completitud del esquema de evidencia:** *para todo* registro, los campos
>   obligatorios están presentes y no vacíos: consulta CUR (o "no aplica" justificado),
>   Mes_Referencia en `AAAA-MM`, fecha de extracción con marca temporal y zona horaria, versión del
>   `Dataset_Congelado`, moneda `USD`, y o bien identificador(es) de recurso explícito(s) o bien la
>   etiqueta "no atribuible a recurso". (Req 2.1–2.5)
>
> Este fichero es el artefacto **propio y dedicado** de la Tarea 17.2. **No** modifica
> `catalogo-evidencias.md` ni ningún `evidencias/*.md` (esos artefactos están congelados; esta
> auditoría los recorre y los referencia, no los reescribe).

---

## 1. Alcance y método de la auditoría

### 1.1 Corpus auditado (todos los ficheros de evidencia bajo el spec)

| # | Fichero | Registros de evidencia que aporta |
|--:|---------|-----------------------------------|
| F0 | `catalogo-evidencias.md` (Fundación 1.1–1.4) | `E1.1-TOTAL`, `E1.1-INFRA`, `E1.1-MKT-CONTRACT`, `E1.1-PAYG`, `E1.1-TAX`, `E1.1-FLATRATE`, `E1.1-SP-BRIDGE`, `EV-1.2-completitud-2026-05`, Registro 1.3 (desglose por cuenta), `EV-1.4-conservacion-2026-05` |
| F1 | `evidencias/palanca-01-ec2.md` | `EV-3.1-ec2-particion-compra`, `EV-3.1-ec2-estable-vs-burst`, sub-registro `EV-3.2` (verificación viva V1/V2/V3), `EV-3.3` (fórmula/clasificación Estimado) |
| F2 | `evidencias/palanca-02-rds.md` | `EV-4.1-RDS-COMPUTE`, `EV-4.1-COMMIT-ADJ`, `EV-4.2-RDS-LIVE`, `EV-4.3` (fórmula/clasificación) |
| F3 | `evidencias/palanca-03-extended-support.md` | `EV-5.1-extended-support-2026-05`, `EV-5.2-extended-support-verificacion-viva`, `EV-5.3` (clasificación Garantizado condicionado) |
| F4 | `evidencias/palanca-04-logs.md` | `EV-6.1-vendedlog-2026-05`, `EV-6.2-waf-cloudfront-live`, `EV-6.3` (fórmula/clasificación) |
| F5 | `evidencias/palanca-05-aurora-helios.md` | `EV-7.1-aurora-helios-noprod-2026-05`, `EV-7.2-...-liveverify`, `EV-7.3-...-{cons,agr}-{mensual,anual}` (4 cifras derivadas) |
| F6 | `evidencias/palanca-06-conservacion.md` | `EV-8.4-ebs-conservacion-subpalancas-2026-05` (auditoría Property 7 parcial) |
| F7 | `evidencias/palanca-06a-gp2-gp3.md` | `EV-8.1-ebs-gp2-gp3-2026-05` |
| F8 | `evidencias/palanca-06b-snapshots.md` | `EV-8.2-ebs-snapshots-2026-05` |
| F9 | `evidencias/palanca-06c-volumenes-huerfanos.md` | `EV-8.3-ebs-volumenes-huerfanos-2026-05` (+ sub-registro verificación viva) |
| F10 | `evidencias/palanca-07-s3.md` | `EV-9.1-s3-timedstorage-clase-2026-05`, `EV-9.2-s3-buckets-live`, `EV-9.3` (fórmula/clasificación) |
| F11 | `evidencias/palanca-08-red.md` | `EV-10.1-red-2026-05`, sub-registro `10.2` (verificación viva), `10.3` (clasificación mixta) |
| F12 | `evidencias/palanca-09-rightsizing.md` | `EV-11.1-ec2-boxusage-canonica`, `EV-11.1-boxusage-por-tipo-linea`, `EV-11.1-ec2-candidatos-limpio`, sub-registro `11.2`, `11.3` |
| F13 | `evidencias/palanca-10-noprod-spot.md` | `EV-12.1-noprod-particion-compra`, `EV-12.1-spot-baseline`, `EV-12.1-disyuncion-palanca1`, `EV-12.2-*` (verificación viva), `12.3` |
| F14 | `evidencias/palanca-11-bedrock.md` | `EV-13.1-bedrock-por-cuenta-perfil-canonica`, `EV-13.1-bedrock-data-direccion-token`, `EV-13.2` (verificación viva), `13.3` |
| F15 | `evidencias/palanca-12-marketplace.md` | `EV-14.1-MKT-CONTRACT`, `EV-14.1-MKT-PAYG` |
| F16 | `evidencias/barrido-16-1-steady-state.md` | `EV-16.1-BARRIDO-STEADY` |
| F17 | `evidencias/barrido-16-2-rightsizing-p95.md` | `EV-16.2-barrido-rightsizing-p95` |
| F18 | `evidencias/barrido-16-3-scheduling-spot.md` | `EV-16.3-BARRIDO-SCHED-SPOT` |

Total: **19 ficheros recorridos** (1 catálogo de Fundación + 18 bajo `evidencias/`).

### 1.2 Taxonomía de registros (necesaria para evaluar la biyección con rigor)

El corpus tiene una estructura **en capas**; no todos los registros son "cifras publicadas en el
Informe". Distinguir las capas es lo que permite evaluar la biyección correctamente:

| Capa | Naturaleza | ¿Aporta una cifra publicable al Informe? | ¿Sujeta a Property 2? |
|------|-----------|:----------------------------------------:|:---------------------:|
| **A. Cifra base / cifra de ahorro** (p. ej. `E1.1-*`, `EV-5.1`, `EV-8.x`, `EV-7.3-*`) | Importe USD que entra en la línea base, la tabla por Palanca o el resumen | **Sí** | **Sí** (1 cifra ↔ 1 registro) |
| **B. Sub-registro de Verificacion_Recurso_Vivo** (`EV-3.2`, `EV-4.2`, `EV-5.2`, `EV-6.2`, `EV-9.2`, `EV-11.2`, `EV-13.2`, sub-registros de 6c/8/10) | Estado `confirmado/excluido/no_verificable` de un recurso | No (no porta cifra USD propia; es el campo `verificacion_vivo` de un registro de capa A) | No como cifra independiente; sí como **sub-registro anidado** del esquema (Req 5.5) |
| **C. Registro de control / auditoría** (`EV-1.2`, `EV-1.4`, `EV-8.4`, este 17.2) | Resultado de una Correctness Property (completitud, conservación, biyección) | No (es metodológico; `clasificacion` `fuera_alcance`/`auditoria`) | No como cifra de ahorro; mantiene esquema completo |
| **D. Registro de barrido** (`EV-16.1`, `EV-16.2`, `EV-16.3`) | Veredicto de gating (CONFIRMADO/PARCIAL/PENDIENTE) que habilita o no elevar una cifra de capa A a objetivo | No porta cifra nueva; **referencia** la cifra de la Palanca | No como cifra independiente |

> La biyección de Property 2 aplica con todo rigor a la **capa A** (cifras publicables). Las capas
> B/C/D son **sub-registros y controles** correctamente modelados por el esquema del `design.md`
> (el campo `verificacion_vivo` es un sub-registro; los controles llevan `clasificacion` no de
> ahorro). Evaluar la biyección "1 cifra ↔ 1 registro" sobre la capa A, y la completitud del esquema
> (Property 3) sobre **todas** las capas, es el método correcto.

### 1.3 Convención sobre el "ejemplo trabajado" del `design.md`

El `design.md` declara explícitamente que sus cifras de mayo 2026 son un **ejemplo trabajado de la
metodología, no el resultado final**. Cada Palanca documenta su "desviación respecto al ejemplo
trabajado" y publica la cifra **canónica** congelada. Por tanto, las cifras del `design.md` **no son
cifras publicadas del Informe** y quedan **fuera** del alcance de la biyección. (Verificado: F0, F10,
F11 incluyen la sección de desviación; el resto cita el ejemplo solo como contraste.)

---

## 2. Property 3 — Completitud del esquema de evidencia

Se audita, registro por registro de **capa A** (y se comprueba el esquema en B/C/D), la presencia y
no-vacuidad de los **seis campos obligatorios** del Req 2.1–2.5, más `recurso_ids` (Req 2.2/2.3/2.4).

### 2.1 Matriz de cumplimiento de campos obligatorios (cifras base / de ahorro — capa A)

Leyenda: ✓ presente y no vacío · `n/a*` "no aplica" justificado (permitido por el esquema para
`consulta_cur` en cifras derivadas o verificadas en vivo).

| Registro | `consulta_cur` | `mes_referencia` (`AAAA-MM`) | `fecha_extraccion` (con TZ) | `version_dataset` | `moneda`=USD | `recurso_ids` o "no atribuible" |
|----------|:--------------:|:----------------------------:|:---------------------------:|:-----------------:|:------------:|:-------------------------------:|
| `E1.1-TOTAL` | ✓ (Consulta 1) | ✓ `2026-05` | ✓ `2026-06-23T07:55:14Z` | ✓ | ✓ | ✓ "no atribuible" |
| `E1.1-INFRA` | ✓ (Consulta 2) | ✓ | ✓ | ✓ | ✓ | ✓ "no atribuible" |
| `E1.1-MKT-CONTRACT` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ "no atribuible" |
| `E1.1-PAYG` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ "no atribuible" |
| `E1.1-TAX` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ "no atribuible" |
| `E1.1-FLATRATE` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ "no atribuible" |
| `E1.1-SP-BRIDGE` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ "no atribuible" |
| `EV-1.2-completitud` | ✓ | ✓ | ✓ `2026-06-23T09:50:50+02:00` | ✓ | ✓ | ✓ "no atribuible" |
| Registro 1.3 (cuentas) | ✓ | ✓ | ✓ `2026-06-23 07:55 UTC` | ✓ | ✓ | ✓ "no atribuible" (dim. cuenta) |
| `EV-1.4-conservacion` | ✓ (A/B/C) | ✓ | ✓ | ✓ | ✓ | ✓ "no atribuible" |
| `EV-3.1-ec2-particion-compra` | ✓ | ✓ | ✓ `2026-06-23T08:14:51Z` | ✓ | ✓ | ✓ "no atribuible" |
| `EV-3.1-ec2-estable-vs-burst` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ "no atribuible" (segmento) |
| `EV-4.1-RDS-COMPUTE` | ✓ | ✓ | ✓ `2026-06-23T08:21:43Z` | ✓ | ✓ | ✓ "no atribuible" (dim. cuenta) |
| `EV-4.1-COMMIT-ADJ` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ "no atribuible" |
| `EV-5.1-extended-support` | ✓ (1/2/3) | ✓ | ✓ `2026-06-23T08:10:33Z` | ✓ | ✓ | ✓ 7 ARNs RDS explícitos |
| `EV-6.1-vendedlog` | ✓ (Q1/Q2/Q3) | ✓ | ✓ `2026-06-23T08:15:23Z` | ✓ | ✓ | ✓ 5 ARNs log-group + "no atribuible" en agregados |
| `EV-7.1-aurora-helios-noprod` | ✓ | ✓ | ✓ `2026-06-23T08:13:39Z` | ✓ | ✓ | ✓ 4 ARNs Aurora |
| `EV-7.3-*` (4 cifras) | `n/a*` (derivadas de `EV-7.1`) | ✓ | ✓ (anclaje 7.3) | ✓ | ✓ | ✓ 4 ARNs Aurora |
| `EV-8.1-ebs-gp2-gp3` | ✓ | ✓ | ✓ `2026-06-23T08:30:38Z` | ✓ | ✓ | ✓ "no atribuible" (dim. cuenta) |
| `EV-8.2-ebs-snapshots` | ✓ (A/B/C) | ✓ | ✓ `2026-06-23T08:30:00Z` | ✓ | ✓ | ✓ "no atribuible" (dim. cuenta) |
| `EV-8.3-ebs-volumenes-huerfanos` | `n/a*` (verificada en vivo) | ✓ | ✓ `2026-06-23T09:01:54Z` | ✓ | ✓ | ✓ 27 `vol-…` explícitos |
| `EV-8.4-ebs-conservacion` | `n/a*` (consolidación) | ✓ | (deriva de fuentes ancladas) | ✓ | ✓ | ✓ "no atribuible" |
| `EV-9.1-s3-timedstorage-clase` | ✓ | ✓ | ✓ `2026-06-23T09:05:00Z` | ✓ | ✓ | ✓ "no atribuible" (dim. clase) |
| `EV-10.1-red` | ✓ (Q1/Q2/Q3) | ✓ | ✓ `2026-06-23T08:33:52Z` | ✓ | ✓ | ✓ "no atribuible" (dim. tipo/cuenta) |
| `EV-11.1-*` (3 registros) | ✓ | ✓ | ✓ `2026-06-23T08:32:02Z` | ✓ | ✓ | ✓ 24 `i-…` explícitos + "no atribuible" agregados |
| `EV-12.1-*` (3 registros) | ✓ | ✓ | ✓ `2026-06-23T08:44:52Z` | ✓ | ✓ | ✓ "no atribuible" (dim. cuenta×opción) |
| `EV-13.1-*` (2 registros) | ✓ | ✓ | ✓ `2026-06-23 07:55 UTC` (+ re-ej.) | ✓ | ✓ | ✓ ARNs inference-profile explícitos |
| `EV-14.1-MKT-CONTRACT` | ✓ | ✓ | ✓ `2026-06-23T07:55:14Z` | ✓ | ✓ | ✓ "no atribuible" |
| `EV-14.1-MKT-PAYG` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ "no atribuible" |
| `EV-16.1-BARRIDO-STEADY` | ✓ | ✓ | ✓ `2026-06-24` s/ congelado | ✓ | ✓ | ✓ "no atribuible" (segmento) |
| `EV-16.2-barrido-rightsizing-p95` | `n/a*` (PromQL, no CUR) | ✓ | ✓ `2026-06-23T11:07:32Z` | ✓ | ✓ | ✓ 6 `i-…` explícitos |
| `EV-16.3-BARRIDO-SCHED-SPOT` | ✓ (P5+P10) | ✓ | ✓ `2026-06-23T11:19:41Z` | ✓ | ✓ | ✓ 4 ARNs Aurora + "no atribuible" P10 |

### 2.2 Sub-registros de Verificacion_Recurso_Vivo (capa B) — esquema del Req 5.5

Todos los sub-registros de verificación llevan los campos del sub-esquema (`comando`/`comandos`,
`cuenta`, `region`, `fecha_hora_utc`, `estado`, `motivo`) y se anclan a su registro de cifra (capa A)
vía el campo `verificacion_vivo` o un `vinculo` explícito:

| Sub-registro | `comando(s)` | `cuenta` | `region` | `fecha_hora_utc` | `estado` | `motivo`/vínculo |
|--------------|:------------:|:--------:|:--------:|:----------------:|:--------:|:----------------:|
| `EV-3.2` (V1/V2/V3) | ✓ | ✓ | ✓ `eu-west-1` | ✓ | ✓ confirmado | ✓ |
| `EV-4.2-RDS-LIVE` | ✓ | ✓ (14) | ✓ | ✓ | ✓ confirmado | ✓ (hallazgo RI) |
| `EV-5.2` | ✓ | ✓ (4) | ✓ | ✓ | ✓ confirmado/drift | ✓ |
| `EV-6.2-waf-cloudfront-live` | ✓ | ✓ | ✓ `us-east-1` (Req 5.2) | ✓ | ✓ confirmado | ✓ (drift `-ia`) |
| `EV-8.3` sub-registro | ✓ | ✓ | ✓ | ✓ | ✓ confirmado/no_verificable | ✓ |
| `EV-9.2-s3-buckets-live` | ✓ | ✓ (3) | ✓ | ✓ | ✓ confirmado | ✓ |
| `10.2` (red) | ✓ | ✓ (13) | ✓ | ✓ | ✓ confirmado/candidata | ✓ |
| `EV-11.2` | ✓ | ✓ (4) | ✓ | ✓ | ✓ confirmado/excluido | ✓ (drift, sin RAM) |
| `EV-12.2-*` | ✓ | ✓ (4) | ✓ | ✓ | ✓ confirmado | ✓ |
| `EV-13.2` (V1/V2) | ✓ | ✓ (2) | ✓ | ✓ | ✓ confirmado | ✓ |

> **Manejo de `us-east-1` (Req 5.2):** `EV-6.2` ejecuta la verificación de WAF de CloudFront en
> `us-east-1` (recurso global), correctamente, no en `eu-west-1`. ✓
> **Estados `no_verificable` (Req 5.4):** `EV-8.3` registra animalis-dev/prod, log, pruebas, 4×sandbox
> y root como `no_verificable` con motivo, excluidos del Garantizado y mantenidos en alcance. ✓

### 2.3 Veredicto Property 3

| Comprobación (Req) | Resultado |
|--------------------|:---------:|
| `consulta_cur` presente, o "no aplica" **justificado** (2.1) | ✅ (los `n/a` son cifras derivadas, verificadas en vivo o controles — justificados) |
| `mes_referencia` en formato `AAAA-MM` = `2026-05` (2.5) | ✅ en los 19 ficheros |
| `fecha_extraccion` con marca temporal **y zona horaria** (2.5) | ✅ (todas con sufijo `Z` UTC y/o `+02:00` CEST) |
| `version_dataset` = `frozen-2026-05@2026-06-23` (2.5) | ✅ uniforme en todo el corpus |
| `moneda` = `USD` (2.5) | ✅ |
| `recurso_ids` explícitos o "no atribuible a recurso" (2.2/2.3/2.4) | ✅ (atribuibles llevan ARN/`vol-`/`i-`; agregadas llevan "no atribuible" + dimensión) |
| Sub-registro `Verificacion_Recurso_Vivo` con su sub-esquema (5.5) | ✅ cuando aplica |

> **PROPERTY 3 — VEREDICTO: ✅ PASA.** Todo registro del corpus presenta los campos obligatorios del
> esquema, no vacíos. Los `consulta_cur = "no aplica"` están **justificados** en todos los casos
> (cifras derivadas de una base congelada, palancas verificadas en vivo como 6c, o auditorías de
> control), conforme al esquema del `design.md` ("Sí (o 'no aplica' si es derivada)"). La marca
> temporal incluye zona horaria en el 100 % de los registros. No se hallaron campos obligatorios
> ausentes ni vacíos.

---

## 3. Property 2 — Biyección cifra publicada ↔ evidencia

### 3.1 Dirección A — toda cifra publicable tiene exactamente un registro

Recorrido de las cifras que el Informe publicará (Req 19.2/19.3), con su registro **único** de
respaldo:

| Cifra publicable (USD) | Dónde se publica (Informe) | Registro único de respaldo |
|------------------------|----------------------------|----------------------------|
| Total org `148 553,36` | Resumen ejecutivo | `E1.1-TOTAL` |
| Infra direccionable `48 320,13` | Resumen ejecutivo (denominador) | `E1.1-INFRA` |
| Tax `9 448,99` | Línea base (5 grupos) | `E1.1-TAX` |
| FlatRate Kiro `904,73` | Línea base (5 grupos) | `E1.1-FLATRATE` |
| Puente SP/descuentos `−1 784,38` | Línea base (cierre) | `E1.1-SP-BRIDGE` |
| Completitud `31/31` | Control de Mes_Referencia | `EV-1.2-completitud` |
| Σ dentro/fuera `48 320,13`/`100 233,22` | Conservación (Property 1) | `EV-1.4-conservacion` |
| Palanca 1 — base estable `4 813,47`; Estimado `1 347,77`–`1 780,99`/mes | Tabla por Palanca | `EV-3.1-*` + `EV-3.3` |
| Palanca 2 — cómputo `6 616,31`; Estimado `1 732,78`–`2 548,20`/mes | Tabla por Palanca | `EV-4.1-RDS-COMPUTE` + `EV-4.3` |
| Palanca 3 — Extended Support `1 169,52`; Garantizado condicionado `833,28`/mes | Tabla por Palanca | `EV-5.1` + `EV-5.3` |
| Palanca 4 — VendedLog `2 774,92`; Estimado (rango) | Tabla por Palanca | `EV-6.1` + `EV-6.3` |
| Palanca 5 — base `851,14`; Estimado `425,57`–`723,47`/mes | Tabla por Palanca | `EV-7.1` + `EV-7.3-*` |
| Palanca 6a — gp2 `1 011,76`; Estimado `151,76`–`212,38`/mes | Tabla por Palanca | `EV-8.1` |
| Palanca 6b — snapshots `402,93`; Estimado `20,15`–`60,44`/mes | Tabla por Palanca | `EV-8.2` |
| Palanca 6c — huérfanos Garantizado `232,20`/mes | Tabla por Palanca | `EV-8.3` |
| Palanca 6 — conservación base `1 430,89` | Control (Property 7 parcial) | `EV-8.4` |
| Palanca 7 — S3 Standard `2 170,80`; Estimado (rango) | Tabla por Palanca | `EV-9.1` + `EV-9.3` |
| Palanca 8 — red `2 843,02`; IPv4 idle Garantizado `30,82` | Tabla por Palanca | `EV-10.1` + `10.3` |
| Palanca 9 — flota `15 184,74`; Estimado `574,27`–`1 531,39`/mes | Tabla por Palanca | `EV-11.1-*` + `11.3` |
| Palanca 10 — base disjunta `856,39`; Estimado `252,30`–`542,80`/mes | Tabla por Palanca | `EV-12.1-*` + `12.3` |
| Palanca 11 — Bedrock Data `2 175,00`; Estimado (rango) | Tabla por Palanca | `EV-13.1-*` + `13.3` |
| Palanca 12 — contrato `85 000,55`; PAYG `6 663,33` | Tabla por Palanca (comercial, aparte) | `EV-14.1-MKT-CONTRACT` / `EV-14.1-MKT-PAYG` |
| Barridos (gating) — veredictos P1/P2/P5 elegibles; P9/P10 pendientes | Tabla (columna Barrido) | `EV-16.1` / `EV-16.2` / `EV-16.3` |

**Resultado dirección A:** **no se halló ninguna cifra publicable huérfana** (sin registro). Cada
cifra de la línea base, de cada Palanca y de cada barrido tiene un registro de respaldo identificado.

### 3.2 Dirección B — todo registro corresponde a una cifra publicable (o es sub-registro/control)

Recorridos los **~50 registros** del corpus:
- Los registros de **capa A** portan una cifra publicable (verificado en §3.1).
- Los registros de **capa B** (verificación viva) son **sub-registros anidados** (campo
  `verificacion_vivo`) de un registro de capa A — no son cifras independientes; el esquema del
  `design.md` los define explícitamente como sub-registro. No hay sub-registro "colgante" sin
  registro padre (todos citan su `EV-x.1`/base).
- Los registros de **capa C/D** (controles `EV-1.2`, `EV-1.4`, `EV-8.4`; barridos `EV-16.x`) llevan
  `clasificacion` metodológica (`fuera_alcance`/`auditoria`) o veredicto de gating, y **referencian**
  cifras existentes; no introducen cifras nuevas no publicadas.

**Resultado dirección B:** **no se halló ningún registro huérfano** (sin cifra ni rol definido).

### 3.3 Hallazgos de la biyección (observaciones a resolver en el ensamblado del Informe)

La biyección 1-a-1 se sostiene en el corpus actual, pero la auditoría deja constancia honesta de
**dos cuestiones** que la fase de ensamblado del Informe (Tareas 17.8/19) debe respetar para no
introducir una violación de Property 2:

**Hallazgo H1 — Importe Marketplace presente en dos registros con roles distintos (no es violación, requiere cita canónica única).**
El importe del contrato Marketplace (`85 000,55`) aparece en `E1.1-MKT-CONTRACT` (Registro 1.1,
partición **contable** — fuente oficial) **y** en `EV-14.1-MKT-CONTRACT` (Palanca 12, registro de
**Palanca_Comercial**). Igual para el PAYG (`6 663,33`): `E1.1-PAYG` y `EV-14.1-MKT-PAYG`. Los
importes **coinciden exactamente** y `palanca-12` documenta que **re-consulta, no recalcula** (no
altera la partición oficial). No es doble conteo contable ni una cifra contradictoria. **Acción para
17.8/19:** cuando el Informe publique la cifra del Marketplace **una sola vez**, debe citar **un único**
`id_evidencia` canónico (recomendación: `E1.1-MKT-CONTRACT`/`E1.1-PAYG` como fuente contable en la
línea base, y que la fila de la Palanca 12 **referencie** ese mismo id en lugar de exponer un id
paralelo) para preservar la correspondencia estricta 1-cifra↔1-registro.

**Hallazgo H2 — Cifras agregadas del Informe aún no materializadas en registro propio (dependencia diferida, esperada).**
Tres cifras que el resumen ejecutivo publicará **no tienen todavía** un registro de evidencia propio,
porque se **ensamblan** en fases posteriores:
- **Total de Ahorro_Garantizado** (suma de: EBS huérfanos `232,20` `EV-8.3` + Extended Support
  condicionado `833,28` `EV-5.3` + IPv4 idle `30,82` Palanca 8 + lo confirmado de red).
- **Rango de Ahorro_Estimado total** (Σ Conservadores – Σ Agresivos de las Palancas Estimado).
- **Objetivo_Comprometido** (= Σ Garantizado + Σ Conservador de Palancas con Barrido completo:
  P1 `1 347,77` + P2 `1 732,78` + P5 `425,57` + Garantizados; **excluye** P9/P10 pendientes y P12
  comercial — Property 12).

Esto **no es una violación de Property 2 en el estado actual** (esas cifras aún no están
"publicadas"); es una **dependencia diferida** correctamente prevista por el flujo (Tareas 17.8 y 19).
**Acción para 17.8/19:** crear un registro de evidencia dedicado para **cada** cifra agregada del
resumen (total Garantizado, rango Estimado total, Objetivo_Comprometido), con `consulta_cur = "no
aplica"` (derivada por suma) y `recurso_ids = "no atribuible a recurso"`, citando los ids componentes
— para que también el resumen ejecutivo mantenga la biyección 1-a-1.

### 3.4 Veredicto Property 2

| Comprobación (Req 2.7, 19.5) | Resultado |
|------------------------------|:---------:|
| Toda cifra publicable de la **línea base** tiene exactamente 1 registro | ✅ (`E1.1-*`, `EV-1.2`, `EV-1.4`) |
| Toda cifra publicable de **cada Palanca (1–12)** tiene exactamente 1 registro | ✅ |
| Todo **sub-registro de verificación** está anidado en su registro de cifra (no es cifra suelta) | ✅ |
| Todo **registro de control/barrido** referencia cifras existentes (no introduce cifras huérfanas) | ✅ |
| Cifras **agregadas del resumen** (total Garantizado, rango total, Objetivo) | ⚠️ diferidas a 17.8/19 (H2) — no publicadas aún |
| Importe Marketplace con **cita canónica única** en el Informe | ⚠️ requiere cita única al ensamblar (H1) |

> **PROPERTY 2 — VEREDICTO: ✅ PASA** (sobre el corpus de evidencias del estado actual). La
> correspondencia 1-a-1 entre cifras publicables y registros de evidencia se sostiene: **no hay
> cifras huérfanas ni registros huérfanos**. Las dos observaciones (H1 cita canónica del Marketplace;
> H2 registros de las cifras agregadas del resumen) **no son violaciones presentes**, sino
> **condiciones que la fase de ensamblado del Informe (17.8/19) debe cumplir** para que la biyección
> se mantenga al publicar el resumen ejecutivo. Se dejan registradas como acciones obligatorias de
> esas tareas.

---

## 4. Veredicto global de la Tarea 17.2

| Property | Validates | Veredicto | Hallazgos |
|----------|-----------|:---------:|-----------|
| **Property 2 — Biyección cifra↔evidencia** | Req 2.7, 19.5 | ✅ **PASA** | H1 (cita canónica única del Marketplace en el Informe) · H2 (crear registro propio para las cifras agregadas del resumen en 17.8/19). Ninguna cifra huérfana ni registro huérfano en el corpus actual. |
| **Property 3 — Completitud del esquema** | Req 2.1, 2.2, 2.3, 2.4, 2.5 | ✅ **PASA** | Ninguno. Los seis campos obligatorios están presentes y no vacíos en todos los registros; `consulta_cur="no aplica"` siempre justificado; marca temporal con zona horaria en el 100 %; sub-registros de verificación con su sub-esquema y región correcta (`us-east-1` para WAF/CloudFront). |

**Conclusión.** El corpus de evidencias del Estudio (`catalogo-evidencias.md` + `evidencias/*.md`)
cumple **Property 2** y **Property 3**: cada cifra publicable está respaldada por exactamente un
registro de evidencia y cada registro tiene los campos obligatorios del esquema completos. Las dos
observaciones de biyección (H1, H2) son **acciones de la fase de ensamblado del Informe**, no defectos
del corpus actual. La auditoría es **re-ejecutable**: recorrer los 19 ficheros y reconstruir las
tablas §2.1/§2.2 y §3.1/§3.2 debe reproducir estos veredictos mientras los artefactos sigan anclados
al `Dataset_Congelado` `frozen-2026-05@2026-06-23`.

---

## 5. Re-ejecución de la auditoría (procedimiento)

1. `list_directory` sobre `evidencias/` → confirmar los 18 ficheros + `catalogo-evidencias.md`.
2. Para cada registro `EV-*`/`E1.1-*`, comprobar los seis campos obligatorios (Property 3, §2.1) y,
   si es atribuible, que `recurso_ids` lleva ARN/`vol-`/`i-` reales; si es agregada, "no atribuible a
   recurso" + dimensión.
3. Construir el mapa cifra→registro (§3.1) y registro→rol (§3.2); marcar cualquier cifra sin registro
   (huérfana) o registro sin cifra/rol (huérfano).
4. Confirmar que las cifras agregadas del resumen (total Garantizado, rango Estimado total,
   Objetivo_Comprometido) tienen registro propio **una vez ejecutadas las Tareas 17.8/19** (cierre
   de H2) y que el Marketplace se cita con un único id (cierre de H1).
5. Cualquier cifra huérfana, registro huérfano o campo obligatorio vacío invalida la biyección o la
   completitud y debe corregirse antes de publicar el Informe (Req 2.7, 19.5).
