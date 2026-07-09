# Ticket Reopen & Comment Fix — Bugfix Design

## Overview

Este bugfix corrige tres defectos encadenados en el flujo de tickets del portal (Jira Service
Management, proyecto SRE) que provocan que, tras reabrir un ticket, añadir un comentario falle con
un `HTTP 500` opaco (`{"error":"Failed to add comment"}`):

1. **Reapertura solo-inglés**: el handler `PATCH action:"reopen"` en
   `src/app/api/jira/my-tickets/route.ts` empareja la transición de reapertura contra una lista
   solo-inglés `REOPEN_TRANSITION_NAMES = ["reopen","re-open","to do","open","backlog"]`. En el
   workflow SRE el estado Done es **"Finalizado"** y su única transición es **"Volver a abrir
   incidencia"**, que no casa con ningún nombre inglés → no-op silencioso en Jira.
2. **Fallo tragado + BD divergente**: el `fetch` de ejecución de la transición de reapertura NO
   comprueba `res.ok`, y la fila del portal se marca `status='open', closed_at=NULL` aunque Jira
   nunca haya transicionado. La BD del portal queda divergente del estado real de Jira.
3. **Error de comentario opaco**: el `POST` de comentarios
   (`src/app/api/jira/tickets/[key]/comments/route.ts`) devuelve siempre `500` con un cuerpo
   genérico, descartando el código de estado y el mensaje reales de Jira (solo se loguean en
   servidor), haciendo el fallo indiagnosticable desde el cliente.

La estrategia es **simetrizar** el camino de reapertura con el de cierre (que ya es bueno):
`jiraTransitionToDone` es bilingüe (`/done|cerrado|resolved|complete|hecho/i`), obtiene
transiciones, ejecuta y comprueba `res.ok`. Se introduce un helper análogo `jiraTransitionToOpen`
apoyado en un **matcher puro, exportado y testeable** (`matchReopenTransition`) que: (a) empareja
nombres de reapertura de forma bilingüe; (b) cae a un fallback robusto por categoría del estado
destino (`to.statusCategory.key ∈ {"new","indeterminate"}`); y (c) se ejecuta comprobando
`res.ok`. El handler de reapertura deja de tragar fallos y NO marca la fila `open` si Jira no
transicionó realmente. El endpoint de comentarios propaga el código de estado real de Jira (4xx→4xx,
5xx→5xx) e incluye el mensaje real (recortado) en la respuesta JSON.

## Glossary

- **Bug_Condition (C)**: El conjunto de inputs que disparan el bug — reaperturas cuyo workflow Jira
  solo ofrece una transición en español, ejecuciones de transición que devuelven no-OK, y POSTs de
  comentario que Jira rechaza (`status >= 400`).
- **Property (P)**: El comportamiento deseado para los inputs en C — la transición de reapertura se
  empareja y ejecuta de forma bilingüe, los fallos se surface-an sin dejar divergir la BD, y el
  error del comentario expone el estado/mensaje real de Jira.
- **Preservation**: El comportamiento existente que NO debe cambiar — cierre bilingüe, comentarios
  ADF válidos con atribución `💬 Name (email):`, reapertura con transiciones en inglés,
  validaciones de ownership (404) / cuerpo vacío (400), y el `GET` de comentarios.
- **`matchReopenTransition(transitions)`**: Función PURA nueva en `src/lib/jira.ts` que, dada la
  lista de transiciones de una incidencia, devuelve la transición de reapertura correcta (bilingüe
  por nombre, con fallback por categoría de estado destino) o `undefined`.
- **`jiraTransitionToOpen(issueKey)`**: Helper nuevo en `src/lib/jira.ts`, simétrico a
  `jiraTransitionToDone`, que obtiene transiciones, usa `matchReopenTransition`, ejecuta la
  transición y comprueba `res.ok`, devolviendo un resultado estructurado.
- **`REOPEN_TRANSITION_REGEX`**: Regex bilingüe exportada que cubre los nombres de reapertura en
  inglés y español.
- **`jiraTransitionToDone`**: Helper existente (el patrón BUENO) en `src/lib/jira.ts` que cierra una
  incidencia de forma bilingüe comprobando `res.ok`.
- **`portal_tickets`**: Tabla del portal cuya fila (`status`, `closed_at`) refleja el estado del
  ticket; debe mantenerse consistente con el estado real de Jira.

## Bug Details

### Bug Condition

El bug se manifiesta cuando (a) se reabre un ticket cuya incidencia Jira NO ofrece una transición
de reapertura en inglés pero SÍ una en español (p.ej. "Volver a abrir incidencia"); o (b) la
ejecución `POST .../transitions` de reapertura devuelve un estado no-OK que el código ignora; o (c)
Jira rechaza el `POST .../comment` (`status >= 400`) y el endpoint lo enmascara con un `500`
genérico. El componente responsable es el handler `PATCH action:"reopen"` (matcher solo-inglés, sin
chequeo de `res.ok`) y el `POST` de comentarios (descarta el estado/cuerpo reales de Jira).

**Formal Specification:**
```
FUNCTION isBugCondition(input)
  INPUT: input = { issue, action, comment }
  OUTPUT: boolean

  reopenBug ←
      input.action = "reopen"
      AND NOT existsTransitionMatching(input.issue, REOPEN_TRANSITION_NAMES_EN)
      AND existsReopenTransition(input.issue)        // p.ej. "Volver a abrir incidencia" / "Reabrir"

  reopenExecBug ←
      input.action = "reopen"
      AND transitionPostStatus(input.issue) NOT IN { 200, 204 }

  commentBug ←
      input.action = "comment"
      AND jiraCommentStatus(input.issue, input.comment) >= 400

  RETURN reopenBug OR reopenExecBug OR commentBug
END FUNCTION
```

### Examples

- **"Volver a abrir incidencia" (SRE)**: reabrir SRE-2152 (estado "Finalizado").
  - *Esperado*: la incidencia transiciona a "Reabierto" y la fila del portal pasa a `open`.
  - *Actual*: ninguna transición casa con la lista inglesa → no-op silencioso; la fila se marca
    `open` mientras Jira sigue en "Finalizado".
- **Comentario tras reapertura fallida**: añadir comentario a una incidencia que sigue en
  "Finalizado".
  - *Esperado*: si Jira rechaza, el cliente recibe el código real (p.ej. `400`/`403`) y el mensaje
    real de Jira.
  - *Actual*: el cliente recibe `500 {"error":"Failed to add comment"}`, sin pista del motivo.
- **Transición de reapertura que devuelve no-OK**: el `POST .../transitions` responde `400/409`.
  - *Esperado*: se detecta `!res.ok`, se loguea el código/cuerpo y NO se marca la fila `open`.
  - *Actual*: se ignora `res.ok` y la fila se marca `open` igualmente.
- **(Edge) Reapertura en inglés ("Reopen"/"To Do")**: debe seguir funcionando idéntica tras el fix.

## Expected Behavior

### Preservation Requirements

**Unchanged Behaviors:**
- Cierre de ticket (`action:"close"`) sigue transicionando a Done con el matcher bilingüe
  `jiraTransitionToDone` y marcando la fila `status='closed', closed_at=NOW()` (Req 3.1).
- Un comentario válido sobre una incidencia que acepta comentarios sigue publicándose en ADF con la
  línea de atribución `💬 Name (email):` y devolviendo `{ success: true }` (Req 3.2).
- Reapertura cuya incidencia ofrece una transición en inglés ("Reopen"/"To Do") sigue emparejándose
  y ejecutándose correctamente (Req 3.3).
- Validaciones existentes: `404` "Ticket not found or not yours" (ownership) y `400`
  "Comment is required" (cuerpo vacío) intactas (Req 3.4).
- `GET .../comments` sigue devolviendo comentarios parseados desde ADF con la atribución de autor
  extraída del cuerpo (Req 3.5).

**Scope:**
Todos los inputs que NO están en la Bug Condition deben quedar completamente inafectados por el fix:
- Cierres (`action:"close"`).
- Reaperturas con transición en inglés disponible.
- Comentarios que Jira acepta (`status < 400`).
- Peticiones con fallo de ownership o cuerpo vacío.
- Listado de comentarios (`GET`).

## Hypothesized Root Cause

Confirmado en vivo contra el workflow SRE (`GET /rest/api/3/issue/SRE-2152/transitions`):

1. **Matcher de reapertura solo-inglés**: `REOPEN_TRANSITION_NAMES` no incluye términos en español
   ("reabrir", "volver a abrir", "reabierto", "por hacer", "pendiente", "abrir"). El estado Done SRE
   "Finalizado" solo expone "Volver a abrir incidencia" → 0 matches → no-op.
2. **Ejecución sin chequeo de `res.ok`**: el segundo `fetch` (POST de la transición) no inspecciona
   la respuesta. Cualquier fallo (4xx/5xx) se traga; el `try/catch` solo captura excepciones de red,
   no respuestas no-OK.
3. **Actualización incondicional de la BD**: el `UPDATE portal_tickets SET status='open'` se ejecuta
   siempre, desacoplado de si Jira transicionó. La BD diverge del estado real de Jira.
4. **Endpoint de comentarios opaco**: ante `!res.ok`, devuelve `500 {"error":"Failed to add
   comment"}` descartando `res.status` y el cuerpo. El cliente no puede distinguir 4xx (cliente) de
   5xx (servidor) ni ver el mensaje real de Jira.

## Correctness Properties

Property 1: Bug Condition — Reapertura bilingüe, fallos surface-ados y error de comentario real

_For any_ input donde la Bug Condition se cumple (`isBugCondition` devuelve `true`), el flujo
corregido SHALL: (a) para una reapertura cuya incidencia ofrece una transición de reapertura
(en español o inglés), emparejarla y ejecutarla de forma bilingüe de modo que la incidencia
transicione fuera de "Finalizado"/Done; (b) cuando la ejecución de la transición devuelve no-OK,
comprobar `res.ok`, registrar el código/cuerpo reales y NO marcar la fila del portal como `open`
(evitando que la BD diverja del estado real de Jira); y (c) cuando Jira rechaza el `POST` del
comentario, propagar al cliente el código de estado real de Jira (4xx para errores de cliente,
5xx para errores de servidor) e incluir el mensaje real de Jira (recortado) en la respuesta JSON,
en lugar de devolver siempre `500 {"error":"Failed to add comment"}`.

**Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5**

Property 2: Preservation — Comportamiento no-buggy idéntico al original

_For any_ input donde la Bug Condition NO se cumple (`isBugCondition` devuelve `false`), el flujo
corregido SHALL producir el mismo resultado que el flujo original, preservando: el cierre bilingüe
con `jiraTransitionToDone` y `status='closed'`, la publicación de comentarios válidos en ADF con
atribución `💬 Name (email):` devolviendo `{ success: true }`, la reapertura con transiciones en
inglés, las validaciones de ownership (`404`) y cuerpo vacío (`400`), y el `GET` de comentarios con
parseo ADF y atribución de autor.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**

## Fix Implementation

### Changes Required

Asumiendo que el análisis de root cause es correcto:

**File**: `src/lib/jira.ts`

1. **Matcher puro exportado `matchReopenTransition`** (testeable en aislamiento — clave para que
   las propiedades de bugfix.md sean ejecutables):
   - Tipo `JiraTransition = { id: string; name: string; to?: { statusCategory?: { key?: string } } }`.
   - Regex bilingüe exportada `REOPEN_TRANSITION_REGEX` que cubre:
     `reopen`, `re-open`, `reabr` (→ "Reabrir"/"Reabierto"), `volver a abrir`, `to do`, `por hacer`,
     `backlog`, `abrir` (→ "Volver a abrir incidencia"), `pendiente`, `open`.
   - Estrategia: (1) match por nombre con la regex; (2) **fallback** por categoría del estado
     destino `to.statusCategory.key ∈ {"new","indeterminate"}` (To Do / In Progress) cuando el
     nombre es ambiguo, excluyendo siempre `"done"`. Devuelve la transición o `undefined`.

   ```
   FUNCTION matchReopenTransition(transitions)
     INPUT: transitions: JiraTransition[]
     OUTPUT: JiraTransition | undefined

     byName ← first t in transitions WHERE REOPEN_TRANSITION_REGEX matches t.name
     IF byName EXISTS THEN RETURN byName

     byCategory ← first t in transitions
                    WHERE t.to.statusCategory.key IN { "new", "indeterminate" }
     RETURN byCategory   // undefined si ninguna
   END FUNCTION
   ```

2. **Helper `jiraTransitionToOpen`** (simétrico a `jiraTransitionToDone`, pero devolviendo
   resultado estructurado para que el caller mantenga la BD consistente):
   - Tipo `TransitionResult = { ok: boolean; matched: boolean; transitioned: boolean; status?: number; message?: string }`.
   - Obtiene transiciones (`GET /rest/api/3/issue/{key}/transitions`); si la respuesta no es OK,
     devuelve `{ ok:false, matched:false, transitioned:false, status, message }`.
   - Aplica `matchReopenTransition`; si no hay match, devuelve `{ ok:false, matched:false, ... }`
     con la lista de transiciones disponibles en `message` (para diagnóstico).
   - Ejecuta `POST .../transitions`; **comprueba `res.ok` (y `204`)**, logueando el código/cuerpo
     reales en fallo (como `jiraTransitionToDone`), y devuelve `{ ok, matched:true, transitioned, status, message }`.

   ```
   FUNCTION jiraTransitionToOpen(issueKey) -> TransitionResult
     transRes ← jiraFetch GET /issue/{issueKey}/transitions
     IF NOT transRes.ok THEN
       RETURN { ok:false, matched:false, transitioned:false, status:transRes.status, message:body }
     transitions ← transRes.json().transitions
     reopen ← matchReopenTransition(transitions)
     IF reopen IS undefined THEN
       RETURN { ok:false, matched:false, transitioned:false,
                message:"No reopen transition. Available: " + names }
     res ← jiraFetch POST /issue/{issueKey}/transitions { transition:{ id:reopen.id } }
     IF NOT res.ok AND res.status != 204 THEN
       log error(res.status, body)
       RETURN { ok:false, matched:true, transitioned:false, status:res.status, message:body }
     RETURN { ok:true, matched:true, transitioned:true, status:res.status }
   END FUNCTION
   ```

**File**: `src/app/api/jira/my-tickets/route.ts`

3. **Reapertura usa el helper y NO traga fallos** (contrato de consistencia BD↔Jira):
   - Eliminar el bloque inline `fetch` y la constante local `REOPEN_TRANSITION_NAMES` /
     `jiraTransitionToOpen` stub vacío.
   - Importar y llamar `const result = await jiraTransitionToOpen(jiraKey)`.
   - **Contrato elegido (surface the failure)**: si `result.matched === false` o
     `result.ok === false`, NO ejecutar el `UPDATE ... status='open'`; devolver una respuesta de
     error que refleje el problema (`502` para fallo upstream de Jira / `409` o `422` cuando no hay
     transición de reapertura disponible) con `{ error, jiraStatus: result.status, detail:
     result.message }`. Así la fila del portal NO diverge del estado real de Jira.
   - Solo si `result.ok === true` se ejecuta `UPDATE portal_tickets SET status='open',
     closed_at=NULL, updated_at=NOW()` y se devuelve `{ success:true, jiraKey, action }`.
   - El camino `action:"close"` queda intacto (sigue usando `jiraTransitionToDone`).

**File**: `src/app/api/jira/tickets/[key]/comments/route.ts`

4. **POST de comentarios propaga el error real de Jira**:
   - Ante `!res.ok`: leer el cuerpo (`text`), loguear (como hoy), y devolver al cliente el código
     de estado **real** de Jira en lugar de `500` fijo:
     - mapear `4xx → 4xx` (error de cliente) y `5xx → 5xx` (error de servidor).
     - cuerpo JSON `{ error: <mensaje real de Jira recortado>, jiraStatus: res.status }`.
   - Helper de mapeo (puro, exportado, testeable) `mapJiraErrorStatus(jiraStatus): number`:
     `4xx → mismo código`; `>=500 → 502` (Bad Gateway, upstream); cualquier otro inesperado → `502`.
   - Las validaciones `404` (ownership) y `400` (cuerpo vacío) permanecen ANTES de la llamada a
     Jira, sin cambios. El happy path sigue devolviendo `{ success:true }`.
   - El `GET` de comentarios (parseo ADF + atribución) queda intacto.

## Testing Strategy

### Validation Approach

Enfoque en dos fases: primero surface-ar counterexamples que demuestren el bug sobre el código sin
corregir; luego verificar que el fix funciona y que el comportamiento no-buggy se preserva. El
pilar es que `matchReopenTransition` y `mapJiraErrorStatus` son funciones **puras, exportadas y
unit-testables** (sin red ni BD), por lo que las propiedades Fix/Preservation de `bugfix.md` son
ejecutables de forma determinista con `node:test` + `tsx` bajo `src/lib/__tests__/`.

### Exploratory Bug Condition Checking

**Goal**: Surface-ar counterexamples que demuestren el bug ANTES de implementar el fix. Confirmar o
refutar el análisis de root cause. Si se refuta, re-hipotetizar.

**Test Plan**: Ejercitar el matcher actual (solo-inglés) y el mapeo de error con fixtures derivados
del workflow SRE real, observando los fallos sobre el código sin corregir.

**Test Cases**:
1. **Reapertura SRE en español**: dado el conjunto de transiciones `[{name:"Volver a abrir
   incidencia", to:{statusCategory:{key:"new"}}}]`, el matcher solo-inglés NO casa (will fail on
   unfixed code).
2. **Ejecución no-OK tragada**: simular `POST .../transitions` devolviendo `409`; el handler actual
   marca la fila `open` igualmente (will fail on unfixed code).
3. **Comentario rechazado opaco**: simular `POST .../comment` devolviendo `403` con cuerpo; el
   endpoint actual devuelve `500 {"error":"Failed to add comment"}` (will fail on unfixed code).
4. **(Edge) Reapertura inglesa**: `[{name:"Reopen"}]` casa hoy (NO debe fallar — referencia de
   preservación).

**Expected Counterexamples**:
- El matcher no encuentra "Volver a abrir incidencia".
- La fila del portal se marca `open` pese a un `409` en la transición.
- El cliente recibe `500` genérico en vez del `403` real de Jira.
- Posibles causas: lista solo-inglés, ausencia de chequeo `res.ok`, `UPDATE` incondicional, descarte
  de `res.status`/cuerpo.

### Fix Checking

**Goal**: Para todos los inputs donde la Bug Condition se cumple, el flujo corregido produce el
comportamiento esperado.

**Pseudocode:**
```
FOR ALL input WHERE isBugCondition(input) DO
  result := fixedFlow(input)

  IF input.action = "reopen" AND existsReopenTransition(input.issue) THEN
    ASSERT matchReopenTransition(transitions) IS DEFINED            // bilingüe (Req 2.1)
    ASSERT jiraTransitionToOpen ejecutó y comprobó res.ok           // (Req 2.2)

  IF reopen transition POST devolvió no-OK THEN
    ASSERT NOT updatedPortalRowToOpen(input.issue)                  // BD no diverge (Req 2.3)

  IF input.action = "comment" AND jiraCommentStatus(input) >= 400 THEN
    ASSERT result.status = mapJiraErrorStatus(jiraCommentStatus(input))  // 4xx→4xx,5xx→5xx (Req 2.5)
    ASSERT result.body incluye el mensaje real de Jira              // diagnosticable (Req 2.4)
END FOR
```

Casos concretos (unit/PBT sobre helpers puros):
- `matchReopenTransition` empareja "Volver a abrir incidencia", "Reabrir", "Reabierto",
  "Reopen", "To Do" (Req 2.1, 3.3).
- `matchReopenTransition` cae al fallback por categoría (`new`/`indeterminate`) cuando el nombre no
  casa, y NUNCA selecciona una transición con `to.statusCategory.key === "done"`.
- `mapJiraErrorStatus`: `400→400`, `403→403`, `404→404`, `500→502`, `503→502` (Req 2.5).

### Preservation Checking

**Goal**: Para todos los inputs donde la Bug Condition NO se cumple, el flujo corregido produce el
mismo resultado que el original.

**Pseudocode:**
```
FOR ALL input WHERE NOT isBugCondition(input) DO
  ASSERT originalFlow(input) = fixedFlow(input)
END FOR
```

**Testing Approach**: Property-based testing es la herramienta recomendada para Preservation: genera
muchos casos a través del dominio de entradas (nombres de transición arbitrarios, estados de
comentario `< 400`, cuerpos válidos/vacíos) y da garantías fuertes de que el comportamiento no
cambia para los inputs no-buggy. Se observa el comportamiento sobre el código sin corregir primero y
luego se captura en tests.

**Test Cases**:
1. **Reapertura inglesa preservada**: para transiciones que casan con la regex inglesa,
   `matchReopenTransition` devuelve la MISMA transición que el matcher original elegía (Req 3.3).
2. **Mapeo de estado OK preservado**: para `jiraCommentStatus < 400`, el endpoint sigue devolviendo
   `{ success:true }` (sin tocar el path de error) (Req 3.2).
3. **Validaciones preservadas**: ownership inválido → `404`; comentario vacío → `400`, igual que el
   original (Req 3.4).
4. **Cierre preservado**: `action:"close"` no se toca; sigue usando `jiraTransitionToDone` y marca
   `status='closed'` (Req 3.1).

### Unit Tests

- `matchReopenTransition`: nombres ES/EN, fallback por categoría, exclusión de `done`, lista vacía →
  `undefined`.
- `mapJiraErrorStatus`: tabla de mapeo 4xx/5xx → código propagado.
- `jiraTransitionToOpen` (con `jiraFetch`/`fetch` inyectado o mockeado): `transitions` no-OK, sin
  match, ejecución no-OK, ejecución OK (200/204) → `TransitionResult` correcto en cada rama.
- Handler de reapertura (con helper mockeado): `result.ok=false` → no `UPDATE`, respuesta de error
  con `jiraStatus`; `result.ok=true` → `UPDATE status='open'` + `{ success:true }`.
- Endpoint de comentarios (con `jiraFetch` mockeado): Jira `403` → respuesta `403` con mensaje real;
  Jira `500` → `502`; Jira OK → `{ success:true }`.

### Property-Based Tests

- Generar nombres de transición aleatorios y verificar que cualquier nombre que casa con la regex
  inglesa también lo hace tras el fix (preservación), y que añadidos en español ("…abrir…",
  "reabr…") ahora casan (fix).
- Generar `jiraStatus` aleatorios en `[400, 599]` y verificar la invariante de `mapJiraErrorStatus`:
  4xx se propaga idéntico, 5xx colapsa a `502`, y el resultado es siempre un código HTTP válido.
- Generar estados de comentario `< 400` y verificar que el endpoint nunca entra en el path de error
  (preservación del happy path).

### Integration Tests

- Flujo completo reabrir→comentar sobre una incidencia con transición en español: la incidencia sale
  de "Finalizado" y la fila del portal pasa a `open` solo cuando Jira transicionó de verdad.
- Reapertura fallida (sin transición / ejecución no-OK): la fila del portal NO pasa a `open` y el
  cliente recibe un error con el estado real.
- Comentario rechazado por Jira: el cliente recibe el código real (4xx/5xx) y el mensaje real, no un
  `500` genérico.
