# Gestión MR History — Bugfix Design

## Overview

La pestaña **Gestión** de `/metrics` muestra dos bloques que se alimentan de **fuentes distintas con
ventanas temporales distintas**:

- Las tarjetas **"Indicadores de gestión"** se sirven desde `gitlab_mr_analytics`
  (`/api/metrics/teams` y agregados del manager dashboard), poblada por `src/lib/mr-snapshot.ts` con
  una ventana de **90 días** (`ninetyDaysAgo`).
- La tabla **"Detalle por MR"** se sirve desde `mr_review_metrics`
  (`src/app/api/metrics/mr-details/route.ts`, filtro por `merged_at`), poblada por
  `ops/mr-metrics-snapshot.js` en modo **incremental diario** (`LOOKBACK_DAYS = 1`, sin backfill).

Como el cron de detalle arrancó alrededor del **22 de abril de 2026** y nunca ha rellenado hacia
atrás, `mr_review_metrics` solo contiene MRs mergeados a partir de esa fecha. Cualquier rango
personalizado anterior a ese límite (`B ≈ 2026-04-22`) devuelve el detalle vacío (empty-state, 200
OK) o truncado, mientras las tarjetas (con 90 días de cobertura) sí muestran totales → incoherencia
visible.

La estrategia del fix es **dotar a `mr_review_metrics` del histórico que le falta** mediante un
**backfill puntual parametrizado** del mismo script de snapshot (manteniendo intacto el incremental
diario), de modo que los rangos históricos con MRs reales muestren el detalle y paginen
correctamente. El endpoint que sirve el detalle **no cambia su lógica**: al limitarse el backfill a
las fechas anteriores al límite de cobertura actual, el comportamiento de los rangos recientes
queda preservado por construcción.

## Glossary

- **Bug_Condition (C)**: consulta de la pestaña Gestión cuyo rango `[from, to]` abarca fechas
  anteriores al límite de cobertura del detalle (`B`) y para las que existieron MRs mergeados reales
  en GitLab en la porción histórica del rango.
- **Property (P)**: para esas consultas, el "Detalle por MR" debe listar los MRs históricos del
  rango, paginar el conjunto completo y reportar el `total`/`totalPages` reales (no empty-state ni
  serie truncada).
- **Preservation**: el comportamiento de los rangos recientes (dentro de la ventana ya cubierta),
  los filtros (equipo/proyecto/autor), el orden (`merged_at DESC`), el tamaño de página y el
  empty-state legítimo cuando no hay MRs, deben permanecer idénticos.
- **`mr_review_metrics`**: tabla per-MR (UNIQUE `project_id, mr_iid`) que respalda el "Detalle por
  MR". Origen del bug por falta de histórico.
- **`gitlab_mr_analytics`**: tabla agregada (particionada por `snapshot_date`, UNIQUE
  `snapshot_date, project_id, mr_iid`) que respalda las tarjetas. Cobertura de 90 días.
- **`ops/mr-metrics-snapshot.js`**: cron nocturno (`0 4 * * *`, imagen `mr-metrics-snapshot`) que
  puebla `mr_review_metrics`. Usa `LOOKBACK_DAYS = 1` y `getMergedMRs` con `updated_after`.
- **`mrDetails` (F)**: el endpoint `GET /api/metrics/mr-details` tal y como se comporta hoy.
- **`mrDetails'` (F')**: el mismo endpoint tras el fix (sin cambios funcionales; cambia el dato
  subyacente).
- **B**: límite de cobertura del histórico per-MR (fecha de merge más antigua consultable hoy,
  ~`2026-04-22`).

## Bug Details

### Bug Condition

El bug se manifiesta cuando el usuario consulta un rango personalizado que entra en territorio
anterior a `B`. El endpoint `mr-details` filtra correctamente por `merged_at`, pero la tabla
`mr_review_metrics` **no contiene filas** para `merged_at < B` porque el snapshot nunca hizo
backfill (`LOOKBACK_DAYS = 1`, `getMergedMRs` solo mira el último día vía `updated_after`). El
defecto no está en la consulta sino en la **ausencia de datos históricos**.

**Formal Specification:**
```
FUNCTION isBugCondition(X)
  INPUT:  X = { from: Date, to: Date, filters }   // rango personalizado de la pestaña Gestión
  OUTPUT: boolean

  // El rango abarca fechas anteriores al límite de cobertura del detalle por MR,
  // y existieron MRs mergeados reales en esa porción histórica del rango.
  RETURN X.from < B
     AND existedMergedMRsInGitLab(X.from, min(X.to, B), X.filters)
END FUNCTION
```

### Examples

- `01/01/2026–28/03/2026` sobre `basket-api`: existieron MRs mergeados en ese periodo en GitLab,
  pero el "Detalle por MR" devuelve **0 filas** y empty-state con **200 OK** (esperado: listar esos
  MRs). **Counterexample principal.**
- `01/01/2026–26/06/2026` (cruza `B`): el detalle solo incluye MRs con `merged_at ≥ ~22 abril` y
  **omite** todos los anteriores (esperado: incluir anteriores y posteriores).
- Paginación de un rango que abarca histórico: `total`/`totalPages` reflejan solo los MRs
  conservados (~desde 22 abril), no el recuento real del rango (esperado: recuento completo).
- Rango íntegramente reciente (p. ej. últimos 30 días): funciona correctamente hoy → **NO** es
  condición de bug (debe preservarse).

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Rangos recientes dentro de la ventana ya cubierta: filas, KPIs (AVG REVIEW TIME, TOTAL MRS…) y
  paginación idénticos a hoy (Req 3.1, 3.4).
- Filtros de equipo, proyecto y autor: se siguen aplicando igual sobre cualquier rango (Req 3.2).
- Empty-state legítimo: un rango sin ningún MR sigue devolviendo **200 OK** + empty-state, no error
  (Req 3.3).
- Orden por `merged_at DESC NULLS LAST` y tamaño de página (límite 50 por defecto) sin cambios
  (Req 3.5).

**Scope:**
Todas las consultas que **no** cumplen `isBugCondition` (rangos íntegramente dentro de
`[B, hoy]`, o rangos sin MRs reales) deben quedar completamente inalteradas. El backfill se acota a
`merged_at < B`, por lo que **no toca** ninguna fila que el detalle ya servía → la preservación se
cumple por construcción.

> El comportamiento correcto esperado para entradas buggy se define en la sección Correctness
> Properties (Property 1).

## Hypothesized Root Cause

La causa raíz está **confirmada por inspección del código**, no es una mera hipótesis:

1. **Ausencia de backfill en el snapshot de detalle** (causa raíz). `ops/mr-metrics-snapshot.js`
   define `LOOKBACK_DAYS = 1` y `getMergedMRs(projectId)` consulta
   `merge_requests?state=merged&updated_after=<hoy-1d>`. Solo trae MRs actualizados en las últimas
   24 h. No hay ningún proceso que rellene hacia atrás → `mr_review_metrics` solo tiene datos desde
   el primer día que corrió el cron (~22 abril 2026 = `B`).

2. **Fuentes y ventanas distintas para tarjetas vs detalle** (causa de la incoherencia visible).
   Las tarjetas leen `gitlab_mr_analytics`, poblada por `src/lib/mr-snapshot.ts` con
   `ninetyDaysAgo` (90 días de cobertura). El detalle lee `mr_review_metrics` (cobertura desde `B`).
   Para un rango histórico, las tarjetas (90 d) pueden reportar totales mientras el detalle sale
   vacío.

3. **Paginación correcta sobre datos incompletos** (síntoma, no causa). El endpoint calcula
   `total = COUNT(*)` y `totalPages = ceil(total/limit)` correctamente sobre las filas existentes;
   como solo existen filas desde `B`, el `total` y la paginación reflejan un universo truncado. La
   lógica de paginación **no** necesita cambios.

4. **Falta de índice por `merged_at` puro** (factor de rendimiento, no de corrección). Los índices
   actuales lideran por `project_id` / `team` / `author_username` y luego `merged_at`. Una consulta
   por rango **sin** filtro de equipo/proyecto/autor (caso típico al abrir la pestaña) no tiene un
   índice óptimo; tras el backfill la tabla crece y conviene un índice por `merged_at`.

## Correctness Properties

Property 1: Bug Condition - Los rangos históricos con MRs reales muestran y paginan el detalle

_For any_ consulta `X` donde la condición del bug se cumple (`isBugCondition(X)` devuelve true), el
endpoint corregido `mrDetails'(X)` SHALL devolver las filas de los MRs mergeados en
`[X.from, min(X.to, B)]` (además de los posteriores si el rango cruza `B`), con
`pagination.total` igual al recuento real de MRs del periodo bajo los filtros activos y
`totalPages = ceil(total / limit)`, sin devolver empty-state cuando el recuento real es > 0.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

Property 2: Preservation - Los rangos no afectados se comportan exactamente igual

_For any_ consulta `X` donde la condición del bug NO se cumple (`isBugCondition(X)` devuelve false),
el resultado de `mrDetails'(X)` SHALL ser idéntico al de `mrDetails(X)`, preservando filas, KPIs,
orden (`merged_at DESC`), tamaño de página, aplicación de filtros (equipo/proyecto/autor) y el
empty-state legítimo con 200 OK cuando no hay MRs.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Decisión de solución (entre las opciones planteadas)

Se evaluaron las tres opciones del enunciado:

| Opción | Resuelve C(X) | Riesgo / Alcance | Decisión |
|--------|---------------|------------------|----------|
| **1. Backfill histórico parametrizado de `mr_review_metrics`** | Sí, de raíz: crea las filas per-MR que el detalle necesita para listar y paginar | Bajo en código (parametrizar el script ya existente, upsert idempotente). Coste operativo acotado (job one-off off-peak) | **ELEGIDA (núcleo)** |
| **2. Unificar/alinear ventanas (servir el detalle desde `gitlab_mr_analytics`)** | Parcial: `gitlab_mr_analytics` también solo cubre 90 d y está **particionada por `snapshot_date`** (varias filas por MR) → requeriría `DISTINCT ON` y aun así no cubriría rangos > 90 d | Alto: refactor del endpoint + nueva fuente, rompe la preservación trivial | Descartada como fuente única. Se adopta solo su **principio de coherencia** (ver abajo) |
| **3. Retención** | No resuelve por sí sola; complementa | Bajo | **ADOPTADA**: conservar histórico completo, sin purga inicial |

**Solución elegida**: backfill puntual parametrizado de `mr_review_metrics` (opción 1),
manteniendo el incremental diario `LOOKBACK_DAYS = 1`, **coherencia de cobertura** alineando el
backfill al menos con la ventana de los agregados (90 d) y extendiéndolo hacia atrás N meses
(parámetro), y **retención completa** del per-MR (opción 3). No se unifican las dos tablas: el
endpoint del detalle **no cambia su lógica**, lo que hace que la preservación se cumpla por
construcción (el backfill solo añade filas con `merged_at < B`).

**Por qué backfill y no unificar fuentes**: el "Detalle por MR" necesita filas per-MR (una por MR)
para listar y paginar; `gitlab_mr_analytics` no es ese origen (multi-fila por `snapshot_date`, 90 d).
Backfillear la tabla ya diseñada para ese propósito (UNIQUE `project_id, mr_iid`, upsert) es el
cambio mínimo que satisface 2.1–2.5 y preserva 3.1–3.5.

### Cambios requeridos

**Fichero**: `ops/mr-metrics-snapshot.js`

**Función**: `getMergedMRs` + `main` (parametrización del modo backfill, sin tocar el incremental).

1. **Parámetros de entorno nuevos** (el incremental diario no los define → comportamiento idéntico):
   - `BACKFILL_FROM` (YYYY-MM-DD): si está presente, activa el modo backfill. Define el inicio del
     histórico a rellenar.
   - `BACKFILL_TO` (YYYY-MM-DD, opcional): fin del backfill; por defecto `B` (la fecha de merge más
     antigua ya presente en `mr_review_metrics`, calculada con
     `SELECT MIN(merged_at)::date FROM mr_review_metrics`). Acotar a `B` evita tocar filas recientes
     ya servidas → preserva 3.x por construcción.

2. **Selección de ventana** (lógica pura, testeable):
   ```
   FUNCTION resolveWindow(env, coverageStart)
     IF env.BACKFILL_FROM THEN
       RETURN { since: env.BACKFILL_FROM, until: env.BACKFILL_TO ?? coverageStart, mode: 'backfill' }
     ELSE
       RETURN { since: now - LOOKBACK_DAYS days, until: null, mode: 'incremental' }
   ```

3. **Paginación de MRs en backfill**: `getMergedMRs` hoy trae solo la primera página (`PER_PAGE=100`,
   sin bucle). En modo backfill, paginar **todas** las páginas de
   `merge_requests?state=merged&updated_after=<since>&order_by=updated_at&sort=desc` y filtrar
   client-side por `merged_at ∈ [since, until)` (GitLab no expone `merged_after`). Reutilizar el
   patrón de paginación de `getActiveProjects`.

4. **Idempotencia**: el `storeMR` ya hace `INSERT … ON CONFLICT (project_id, mr_iid) DO UPDATE`. Es
   idempotente: re-ejecutar el backfill no duplica filas. Como el backfill se acota a
   `merged_at < B`, no recalcula ninguna fila reciente.

5. **Lanzamiento (job one-off, no endpoint)**: ejecutar como **Job de Kubernetes puntual** derivado
   del CronJob existente (misma imagen `tooling/mr-metrics-snapshot`, mismo `envFrom: portal-env`),
   sobreescribiendo `command` y añadiendo `BACKFILL_FROM`. Se descarta un endpoint HTTP por la
   duración (horas) frente a los límites de `maxDuration` del runtime. Ejemplo:
   ```
   kubectl --context <dp-tooling> -n n8n create job mr-backfill-2026q1 \
     --from=cronjob/mr-metrics-snapshot
   # y parchear el Job para añadir env BACKFILL_FROM=2026-01-01 (y BACKFILL_TO si procede)
   ```
   El cron diario sigue corriendo sin cambios.

**Fichero**: `src/app/api/metrics/mr-details/route.ts` — **sin cambios funcionales**. (Opcional, no
requerido para corrección: ningún cambio en la construcción de WHERE/paginación; se preserva la
firma exacta.)

**Fichero**: nueva migración SQL `migrations/2026-06-XX_mr_review_merged_at_index.sql`
(rendimiento, no corrección):
```sql
CREATE INDEX IF NOT EXISTS idx_mr_review_merged_at
    ON mr_review_metrics(merged_at DESC);
```
Acelera las consultas por rango sin filtro de equipo/proyecto/autor (caso por defecto de la pestaña)
una vez la tabla crece con el histórico. `CREATE INDEX IF NOT EXISTS` es idempotente; en una tabla
grande considerar `CONCURRENTLY` (fuera de transacción).

### Consideraciones de migración / datos

- **¿Hace falta migración de esquema?** No para la corrección: la tabla ya tiene las columnas y la
  UNIQUE necesarias. Sí se añade un **índice** por `merged_at` (migración aparte) por rendimiento.
- **`snapshot_date` de filas backfilleadas**: tomará `CURRENT_DATE` (la fecha del backfill). El
  endpoint `mr-details` **no filtra por `snapshot_date`**, así que no afecta a la corrección ni a la
  preservación.
- **Coherencia con tarjetas**: tras el backfill, el detalle cubrirá al menos los mismos 90 días que
  `gitlab_mr_analytics` (y más, según `BACKFILL_FROM`), eliminando la incoherencia de 2.4.

### Retención

- Las filas per-MR son pequeñas (una fila por MR, sin payloads grandes). Estimación: 971 repos ×
  decenas de MRs/mes ≈ pocas decenas de miles de filas/año → coste de almacenamiento despreciable.
- **Decisión**: conservar el histórico **completo** (sin purga automática inicial). Revisar si la
  tabla supera un umbral operativo; en ese caso añadir purga por `merged_at` (p. ej. > 24 meses) en
  una iteración posterior. No se introduce purga en este fix para no arriesgar 2.5.

### Manejo de errores y rate-limits del backfill

- **429 (rate limit)**: `gitlabFetch` ya respeta `Retry-After` y reintenta. Añadir backoff
  exponencial acotado para ráfagas largas del backfill (971 repos × múltiples llamadas por MR:
  commits, notes, detalle).
- **`RATE_LIMIT_DELAY`**: mantener el delay (200 ms) entre llamadas; el backfill es masivo, por lo
  que se ejecuta **off-peak** como job puntual.
- **Reanudación**: ante caída a media ejecución, la idempotencia del upsert permite **re-lanzar
  desde el principio** sin duplicar. Opcionalmente, registrar el último `project_path` procesado
  para reanudar (mejora; no imprescindible por la idempotencia).
- **Errores por MR/proyecto**: ya se capturan y se continúa (no abortar el backfill completo por un
  fallo puntual), igual que el patrón actual de `main`.

## Testing Strategy

### Validation Approach

Dos fases: primero reproducir el bug sobre el código/datos sin fix (counterexamples), luego
verificar que el fix lista/pagina el histórico (Fix Checking) y que los rangos recientes quedan
intactos (Preservation Checking).

### Exploratory Bug Condition Checking

**Goal**: Reproducir el bug ANTES del backfill y confirmar la causa raíz (ausencia de filas
históricas), no un fallo de la query.

**Test Plan**: Sobre una BD con datos solo desde `B`, llamar a `mrDetails` con rangos históricos y
observar empty-state/truncado. Verificar en GitLab que esos MRs existieron (confirma que no es
empty-state legítimo).

**Test Cases**:
1. **Rango íntegramente histórico** (`2026-01-01..2026-03-28`, `basket-api`): devuelve 0 filas /
   empty-state con 200 (falla la expectativa 2.1).
2. **Rango que cruza `B`** (`2026-01-01..2026-06-26`): faltan los MRs anteriores a `B` (falla 2.2).
3. **Paginación en rango histórico**: `total`/`totalPages` reflejan solo el universo desde `B`
   (falla 2.3).
4. **Incoherencia tarjetas vs detalle**: tarjetas con totales y detalle vacío para el mismo rango
   (falla 2.4).

**Expected Counterexamples**:
- `mr_review_metrics` no tiene filas con `merged_at < B` aunque GitLab sí tenía MRs mergeados.
- Causa: `LOOKBACK_DAYS = 1` + `updated_after` en `getMergedMRs`, sin backfill.

### Fix Checking

**Goal**: Para toda entrada que cumple la condición del bug, el detalle corregido produce el
comportamiento esperado.

**Pseudocode:**
```
FOR ALL X WHERE isBugCondition(X) DO
  result := mrDetails_fixed(X)
  ASSERT result.mrs CONTIENE los MRs históricos de [X.from, min(X.to, B)]
  ASSERT result.pagination.total = recuento_real_de_MRs(X.from, X.to, X.filters)
  ASSERT NOT isEmptyState(result) WHEN recuento_real > 0
END FOR
```

### Preservation Checking

**Goal**: Para toda entrada que NO cumple la condición del bug, el detalle corregido produce el
mismo resultado que el original.

**Pseudocode:**
```
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT mrDetails_original(X) = mrDetails_fixed(X)
END FOR
```

**Testing Approach**: Property-based testing recomendado para la lógica pura de selección de ventana
y de paginación, porque genera muchos casos en el dominio de fechas/paginación y captura edge cases
(límites de página, rangos que tocan exactamente `B`, `limit`/`offset`).

**Test Plan**: Sobre código sin fix, observar el comportamiento de los rangos recientes (filas, KPIs,
orden, empty-state) y fijar tests que verifiquen que tras el fix siguen idénticos. Como el backfill
solo añade filas con `merged_at < B`, los rangos en `[B, hoy]` no cambian.

**Test Cases**:
1. **Rango reciente (últimos 30 d)**: mismas filas, KPIs y orden antes y después.
2. **Filtros equipo/proyecto/autor**: se aplican igual sobre cualquier rango.
3. **Rango sin MRs**: sigue devolviendo 200 + empty-state legítimo.

### Unit Tests

- `resolveWindow(env, coverageStart)`: modo incremental cuando no hay `BACKFILL_FROM`; modo backfill
  con `since/until` correctos cuando sí lo hay; `until` por defecto = `B`.
- Construcción del WHERE de `mr-details` (rango vs `days`, filtros opcionales) — verificar que el
  modo `days` y el modo `from/to` no cambian respecto a hoy.
- Paginación: `totalPages = ceil(total/limit)`, `offset = (page-1)*limit`, clamps de `limit` (10–200)
  y `page` (≥1).
- Idempotencia del upsert: insertar el mismo MR dos veces deja una sola fila con valores estables.

### Property-Based Tests

- **Selección de ventana** (pura): para cualquier `env` sin `BACKFILL_FROM`, `resolveWindow` ⇒ modo
  incremental (no se altera el cron diario). Para cualquier `BACKFILL_FROM < B`, `until ≤ B` (el
  backfill nunca invade el rango ya cubierto → soporte formal de la preservación).
- **Paginación** (pura): para cualquier `total ≥ 0` y `limit ∈ [10,200]`, recorrer todas las
  páginas cubre exactamente `total` filas sin solapes ni huecos; `totalPages` consistente.
- **Monotonía del orden**: para cualquier conjunto de MRs, la salida está ordenada por
  `merged_at DESC` (NULLS LAST).

### Integration Tests

- Flujo completo con BD sembrada: insertar filas históricas (simulando el backfill) + filas
  recientes; un rango que cruza `B` devuelve ambos tramos y pagina el conjunto completo (2.2, 2.3).
- Coherencia: para un rango histórico, si `gitlab_mr_analytics` reporta MRs, el detalle los lista
  tras el backfill (2.4).
- Preservación end-to-end: un rango íntegramente reciente devuelve idéntico resultado con y sin
  filas históricas presentes en la tabla (3.1–3.5).
