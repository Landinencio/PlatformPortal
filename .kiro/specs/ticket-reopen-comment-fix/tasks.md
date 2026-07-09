# Implementation Plan — Ticket Reopen & Comment Fix

## Overview

Plan de bugfix exploratorio para los tres defectos encadenados del flujo de tickets (Jira Service
Management, proyecto SRE): (1) matcher de reapertura solo-inglés que no casa "Volver a abrir
incidencia", (2) ejecución de la transición de reapertura que se traga fallos y deja la fila del
portal divergente de Jira, y (3) endpoint de comentarios que enmascara el error real de Jira tras un
`500` opaco.

Metodología: **primero** se escribe un test de exploración que DEBE FALLAR sobre el código sin
corregir (demuestra la raíz), y un test de preservación que DEBE PASAR sobre el código sin corregir
(captura el comportamiento a no romper). **Después** se implementa el fix simetrizando el camino de
reapertura con el de cierre (`jiraTransitionToDone`), apoyándose en funciones puras, exportadas y
testeables (`matchReopenTransition`, `REOPEN_TRANSITION_REGEX`, `mapJiraErrorStatus`,
`jiraTransitionToOpen`). Todo en TypeScript (Next.js 14 App Router). Tests bajo
`src/lib/__tests__/` con `node:test` + `tsx` (`npm test`), property-based con `fast-check`.

## Task Dependency Graph

```
PRE-FIX (sobre código sin corregir):
  1 (Property 1: Bug Condition — exploración, FALLA)
  2 (Property 2: Preservation — PBT, PASA)

FIX:
  helpers puros (jira.ts):
    3.1 (matchReopenTransition + REOPEN_TRANSITION_REGEX)
    3.2 (jiraTransitionToOpen → TransitionResult)   ─► depende de 3.1
    3.3 (mapJiraErrorStatus)
  wiring:
    3.4 (reopen PATCH my-tickets)   ─► depende de 3.2
    3.5 (comment POST comments)     ─► depende de 3.3
  verificación:
    3.6 (re-run Property 1 → PASA)  ─► depende de 3.4, 3.5
    3.7 (re-run Property 2 → PASA)  ─► depende de 3.4, 3.5

COBERTURA ADICIONAL:
  4 (unit: matchReopenTransition + mapJiraErrorStatus)  ─► depende de 3.1, 3.3
  5 (unit: jiraTransitionToOpen ramas, fetch mockeado)  ─► depende de 3.2
  6 (contrato reopen: BD no se actualiza en fallo)      ─► depende de 3.4
  7 (comment endpoint: propagación de error real)       ─► depende de 3.5

CHECKPOINT:
  8 (npm test — Fix Checking + sin regresiones de Preservation)
```

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2"], "dependsOn": [] },
    { "wave": 2, "tasks": ["3.1", "3.3"], "dependsOn": ["1", "2"] },
    { "wave": 3, "tasks": ["3.2", "4"], "dependsOn": ["3.1", "3.3"] },
    { "wave": 4, "tasks": ["3.4", "3.5", "5"], "dependsOn": ["3.2", "3.3"] },
    { "wave": 5, "tasks": ["6", "7", "3.6", "3.7"], "dependsOn": ["3.4", "3.5"] },
    { "wave": 6, "tasks": ["8"], "dependsOn": ["3.6", "3.7", "4", "5", "6", "7"] }
  ]
}
```

## Tasks

- [x] 1. Write bug condition exploration test
  - **Property 1: Bug Condition** - Reapertura solo-inglés + comentario con 500 opaco
  - **CRITICAL**: This test MUST FAIL on unfixed code — failure confirms the bug exists.
  - **DO NOT attempt to fix the test or the code when it fails** — the failure is the goal.
  - **NOTE**: This test encodes the expected behavior — it will validate the fix when it passes after implementation.
  - **GOAL**: Surface counterexamples that demonstrate the root cause before any fix.
  - **Scoped PBT Approach** (bug determinista): acotar la propiedad a los casos concretos que fallan, derivados del workflow SRE real:
    - Reapertura: lista de transiciones `[{ id:"X", name:"Volver a abrir incidencia", to:{ statusCategory:{ key:"new" } } }]`. Aserción esperada: el sistema empareja y devuelve esa transición de reapertura (vía `matchReopenTransition` de `src/lib/jira.ts`). Sobre el código sin corregir FALLA: el matcher solo-inglés (`REOPEN_TRANSITION_NAMES = ["reopen","re-open","to do","open","backlog"]`) no contiene ningún término que `"volver a abrir incidencia"` incluya, y `matchReopenTransition`/`REOPEN_TRANSITION_REGEX` aún no existen.
    - Comentario: dado un estado de Jira `403` (y `500`) al hacer `POST .../comment`, la aserción esperada es que el cliente reciba el código real de Jira (`403` y `502` respectivamente) vía `mapJiraErrorStatus`, no un `500` fijo con `{"error":"Failed to add comment"}`. Sobre el código sin corregir FALLA: el endpoint devuelve siempre `500` y `mapJiraErrorStatus` no existe.
  - Crear `src/lib/__tests__/ticket-reopen-comment-exploration.test.ts` (`node:test` + `tsx`), importando los símbolos objetivo desde `src/lib/jira.ts`.
  - Run test on UNFIXED code: `npm test`.
  - **EXPECTED OUTCOME**: Test FAILS (prueba que el matcher bilingüe y el mapeo de estado no existen / el comportamiento actual es incorrecto).
  - Documentar los counterexamples: "matchReopenTransition no empareja 'Volver a abrir incidencia'"; "el comentario devuelve 500 en lugar del 403/502 real de Jira".
  - Marcar la tarea completa cuando el test esté escrito, ejecutado, y el fallo documentado.
  - _Bug_Condition: isBugCondition(X) con X.action="reopen" y existsReopenTransition (ES) sin match EN; y X.action="comment" con jiraCommentStatus >= 400_
  - _Requirements: 2.1, 2.4, 2.5_

- [x] 2. Write preservation property tests (BEFORE implementing fix)
  - **Property 2: Preservation** - Comportamiento no-buggy idéntico al original
  - **IMPORTANT**: Follow observation-first methodology.
  - **Observar sobre el código sin corregir** (leyendo `my-tickets/route.ts` y `comments/route.ts`):
    - Las transiciones en inglés ("Reopen", "To Do") SÍ casan hoy con `REOPEN_TRANSITION_NAMES`.
    - Un `POST .../comment` con estado `< 400` devuelve hoy `{ success: true }` (no entra al path de error).
    - Validaciones: ownership inválido → `404` "Ticket not found or not yours"; cuerpo vacío → `400` "Comment is required".
  - Escribir property-based tests (`fast-check`) en `src/lib/__tests__/ticket-reopen-comment.property.test.ts` que capturen patrones de comportamiento observado:
    - **Reapertura inglesa preservada**: generar nombres de transición que casan con la regex inglesa (`reopen`, `re-open`, `to do`, `open`, `backlog`) y verificar que el matcher los empareja (oráculo de equivalencia con el predicado inglés actual). Property-based genera muchos nombres para garantía fuerte (Req 3.3).
    - **Happy path de comentario preservado**: generar `jiraStatus` aleatorios en `[200, 399]` y verificar que el flujo NUNCA entra al path de error (Req 3.2).
  - **NOTA sobre helpers nuevos**: dado que `matchReopenTransition`/`mapJiraErrorStatus` se introducen en el fix, sobre el código sin corregir estas propiedades se validan replicando inline el predicado inglés actual (`REOPEN_TRANSITION_NAMES.some(n => name.toLowerCase().includes(n))`) y la condición `status < 400` como oráculo de baseline; tras el fix (tarea 3.7) los mismos tests apuntan a las funciones exportadas y deben seguir pasando idénticos.
  - Run tests on UNFIXED code: `npm test`.
  - **EXPECTED OUTCOME**: Tests PASS (confirman el baseline a preservar).
  - Marcar la tarea completa cuando los tests estén escritos, ejecutados y pasando sobre el código sin corregir.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 3. Fix for ticket reopen (bilingual + fail-surfacing) and opaque comment error

  - [x] 3.1 Add pure `matchReopenTransition` + exported `REOPEN_TRANSITION_REGEX` in `src/lib/jira.ts`
    - Definir `export type JiraTransition = { id: string; name: string; to?: { statusCategory?: { key?: string } } }`.
    - Exportar `REOPEN_TRANSITION_REGEX` bilingüe (EN/ES) que cubra: `reopen`, `re-open`, `reabr` (Reabrir/Reabierto), `volver a abrir`, `to do`, `por hacer`, `backlog`, `abrir`, `pendiente`, `open`.
    - Implementar `export function matchReopenTransition(transitions: JiraTransition[]): JiraTransition | undefined`:
      1. match por nombre con `REOPEN_TRANSITION_REGEX`;
      2. fallback por categoría del estado destino `to.statusCategory.key ∈ {"new","indeterminate"}`, excluyendo SIEMPRE `"done"`;
      3. `undefined` si nada casa (incl. lista vacía).
    - _Bug_Condition: reopenBug — existsReopenTransition (ES) sin match EN_
    - _Expected_Behavior: empareja la transición de reapertura de forma bilingüe y simétrica al matcher de cierre_
    - _Requirements: 2.1, 3.3_

  - [x] 3.2 Add `jiraTransitionToOpen(issueKey)` → `TransitionResult` in `src/lib/jira.ts`
    - Definir `export type TransitionResult = { ok: boolean; matched: boolean; transitioned: boolean; status?: number; message?: string }`.
    - Simétrico a `jiraTransitionToDone`, pero devolviendo resultado estructurado: `GET .../transitions` (si no-OK → `{ ok:false, matched:false, transitioned:false, status, message }`); aplicar `matchReopenTransition` (si no hay match → `{ ok:false, matched:false, ..., message:"No reopen transition. Available: " + names }`); ejecutar `POST .../transitions` **comprobando `res.ok` (y 204)**, logueando código/cuerpo reales en fallo, devolviendo `{ ok, matched:true, transitioned, status, message }`.
    - _Bug_Condition: reopenExecBug — transitionPostStatus NOT IN {200,204} se ignora_
    - _Expected_Behavior: comprueba res.ok, registra el código/cuerpo reales y señala el fallo en vez de tratarlo como éxito_
    - _Requirements: 2.1, 2.2, 2.3_

  - [x] 3.3 Add pure `mapJiraErrorStatus(jiraStatus)` in `src/lib/jira.ts`
    - `export function mapJiraErrorStatus(jiraStatus: number): number`: `4xx → mismo código`; `>=500 → 502`; cualquier otro inesperado → `502`. Pura, exportada, sin red.
    - _Bug_Condition: commentBug — jiraCommentStatus >= 400 enmascarado con 500 fijo_
    - _Expected_Behavior: propaga 4xx→4xx y 5xx→502 al cliente_
    - _Requirements: 2.5_

  - [x] 3.4 Wire reopen PATCH handler in `src/app/api/jira/my-tickets/route.ts`
    - Eliminar el `jiraTransitionToOpen` stub vacío y la constante local `REOPEN_TRANSITION_NAMES` y el bloque `fetch` inline solo-inglés.
    - Importar y llamar `const result = await jiraTransitionToOpen(jiraKey)` desde `@/lib/jira`.
    - **Contrato de consistencia BD↔Jira (surface the failure)**: si `result.matched === false` o `result.ok === false`, NO ejecutar el `UPDATE ... status='open'`; devolver error reflejando el problema (`502` para fallo upstream de Jira; `409`/`422` cuando no hay transición de reapertura disponible) con `{ error, jiraStatus: result.status, detail: result.message }`.
    - Solo si `result.ok === true`: ejecutar `UPDATE portal_tickets SET status='open', closed_at=NULL, updated_at=NOW()` y devolver `{ success:true, jiraKey, action }`.
    - El camino `action:"close"` (usa `jiraTransitionToDone`) queda intacto.
    - _Bug_Condition: reopenBug OR reopenExecBug_
    - _Expected_Behavior: empareja/ejecuta bilingüe y NO marca la fila open si Jira no transicionó (BD no diverge)_
    - _Preservation: cierre bilingüe con jiraTransitionToDone y status='closed' intacto (3.1); reapertura inglesa sigue funcionando (3.3)_
    - _Requirements: 2.1, 2.2, 2.3, 3.1_

  - [x] 3.5 Wire comment POST handler in `src/app/api/jira/tickets/[key]/comments/route.ts`
    - Ante `!res.ok`: leer el cuerpo (`text`), loguear (como hoy) y devolver al cliente el estado real vía `mapJiraErrorStatus(res.status)` con cuerpo `{ error: <mensaje real de Jira recortado>, jiraStatus: res.status }`, en lugar de `500 {"error":"Failed to add comment"}` fijo.
    - Importar `mapJiraErrorStatus` desde `@/lib/jira`.
    - Mantener ANTES de la llamada a Jira las validaciones `404` (ownership) y `400` (cuerpo vacío). Happy path sigue devolviendo `{ success:true }`. El `GET` (parseo ADF + atribución `💬 Name (email):`) queda intacto.
    - _Bug_Condition: commentBug — jiraCommentStatus >= 400_
    - _Expected_Behavior: expone el código y mensaje reales de Jira; 4xx→4xx, 5xx→502_
    - _Preservation: comentario válido sigue publicándose en ADF con atribución y { success:true } (3.2); validaciones 404/400 intactas (3.4); GET intacto (3.5)_
    - _Requirements: 2.4, 2.5, 3.2, 3.4, 3.5_

  - [x] 3.6 Verify bug condition exploration test now passes
    - **Property 1: Expected Behavior** - Reapertura bilingüe + estado de comentario real
    - **IMPORTANT**: Re-run the SAME test from task 1 — do NOT write a new test.
    - El test de la tarea 1 codifica el comportamiento esperado; al pasar, confirma que el fix lo satisface.
    - Run: `npm test` (el fichero `ticket-reopen-comment-exploration.test.ts`).
    - **EXPECTED OUTCOME**: Test PASSES (confirma que el bug está corregido: `matchReopenTransition` empareja "Volver a abrir incidencia" y `mapJiraErrorStatus` propaga 403→403 / 500→502).
    - _Requirements: 2.1, 2.2, 2.4, 2.5_

  - [x] 3.7 Verify preservation tests still pass
    - **Property 2: Preservation** - Comportamiento no-buggy idéntico al original
    - **IMPORTANT**: Re-run the SAME tests from task 2 — do NOT write new tests (reapuntando los oráculos a las funciones exportadas).
    - Run: `npm test` (el fichero `ticket-reopen-comment.property.test.ts`).
    - **EXPECTED OUTCOME**: Tests PASS (sin regresiones: reapertura inglesa sigue casando, happy path de comentario `< 400` preservado).
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_

- [x] 4. Unit tests for pure helpers `matchReopenTransition` + `mapJiraErrorStatus`
  - Crear `src/lib/__tests__/jira-reopen.test.ts` (`node:test` + `tsx`).
  - `matchReopenTransition`: empareja nombres ES/EN ("Volver a abrir incidencia", "Reabrir", "Reabierto", "Reopen", "To Do"); fallback por categoría (`new`/`indeterminate`) cuando el nombre no casa; NUNCA selecciona una transición con `to.statusCategory.key === "done"`; lista vacía → `undefined`.
  - `mapJiraErrorStatus`: tabla de mapeo `400→400`, `403→403`, `404→404`, `500→502`, `503→502`.
  - _Requirements: 2.1, 2.5, 3.3_

- [x] 5. Unit tests for `jiraTransitionToOpen` branches (mocked fetch)
  - En `src/lib/__tests__/jira-reopen.test.ts` (o fichero hermano), con `fetch`/`jiraFetch` mockeado o inyectado, cubrir las 4 ramas del `TransitionResult`: `GET transitions` no-OK; sin match (`matched:false` + lista en `message`); ejecución `POST` no-OK (`ok:false, matched:true, transitioned:false, status`); ejecución OK 200/204 (`ok:true, matched:true, transitioned:true`).
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 6. Contract test: reopen handler does not update DB on failure
  - Verificar el contrato BD↔Jira de la tarea 3.4: dado un `TransitionResult` con `ok:false`/`matched:false` → el handler NO ejecuta `UPDATE status='open'` y devuelve error con `jiraStatus`/`detail`; dado `ok:true` → ejecuta `UPDATE` y devuelve `{ success:true }`. Probar la decisión de forma pura (mapeando `TransitionResult` → respuesta/efecto), con `pool.query` y `jiraTransitionToOpen` mockeados/inyectados para evitar red y BD.
  - **PBT recomendado**: generar `TransitionResult` arbitrarios y verificar la invariante "se actualiza la fila a `open` ⟺ `result.ok === true`".
  - _Requirements: 2.2, 2.3, 3.1_

- [x] 7. Comment endpoint error propagation test
  - Con `jiraFetch`/`fetch` mockeado: Jira `403` con cuerpo → respuesta `403` con el mensaje real de Jira y `jiraStatus:403`; Jira `500` → `502`; Jira OK (`< 400`) → `{ success:true }` (happy path preservado); cuerpo vacío → `400`; ownership inválido → `404`.
  - **PBT recomendado**: `jiraStatus ∈ [400,599]` → la respuesta del endpoint es `mapJiraErrorStatus(jiraStatus)` y siempre un código HTTP válido.
  - _Requirements: 2.4, 2.5, 3.2, 3.4_

- [x] 8. Checkpoint — run the full suite (`npm test`)
  - Ejecutar `npm test` (`tsx --test src/lib/__tests__/*.test.ts`) y confirmar que TODA la suite pasa.
  - Confirmar **Fix Checking**: la exploración (Property 1) ahora pasa.
  - Confirmar **sin regresiones de Preservation**: Property 2 + el resto de la suite del repo siguen verdes.
  - Si surgen dudas o fallos inesperados, preguntar al usuario antes de continuar.

## Notes

- **Simetría con el cierre**: el fix modela `jiraTransitionToOpen` sobre el patrón bueno de `jiraTransitionToDone` (bilingüe + `res.ok`), pero devuelve `TransitionResult` estructurado para que el handler mantenga la BD consistente.
- **Superficie testeable**: `matchReopenTransition`, `REOPEN_TRANSITION_REGEX` y `mapJiraErrorStatus` son puras y exportadas desde `src/lib/jira.ts`, lo que hace ejecutables de forma determinista (sin red ni BD) las propiedades Fix/Preservation de `bugfix.md` bajo `node:test` + `tsx`.
- **Contrato clave**: la fila de `portal_tickets` solo pasa a `status='open'` cuando Jira transicionó de verdad (`result.ok === true`); así la BD del portal nunca diverge del estado real de Jira.
- **Convenciones**: rama `fix/SRE-XXXX`, commit `[SRE-XXXX] fix: bilingual reopen + propagate jira comment error`. PBT con `fast-check` (ya en devDeps).
