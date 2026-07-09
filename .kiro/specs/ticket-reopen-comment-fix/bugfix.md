# Bugfix Requirements Document

## Introduction

Tras cerrar un ticket del portal y reabrirlo, al añadir un comentario y pulsar "Enviar" la
operación falla y el comentario no se agrega. La llamada `POST /api/jira/tickets/{key}/comments`
devuelve `HTTP 500` con cuerpo opaco `{"error":"Failed to add comment"}`, sin pista del motivo
real en el cliente ni en la pestaña de red.

La investigación en vivo contra el workflow real de Jira Service Management del proyecto SRE
revela que el síntoma del comentario es la punta de un problema de raíz en el flujo de
**reapertura**:

- El handler de "Reabrir" vive en `src/app/api/jira/my-tickets/route.ts` (PATCH,
  `action: "reopen"`). Obtiene las transiciones de la incidencia y busca una cuyo nombre
  contenga alguno de `REOPEN_TRANSITION_NAMES = ["reopen","re-open","to do","open","backlog"]`
  (solo inglés).
- En el proyecto SRE el estado Done se llama **"Finalizado"**, y la ÚNICA transición disponible
  desde él es **"Volver a abrir incidencia"** (verificado vía
  `GET /rest/api/3/issue/SRE-2152/transitions`), que mueve al estado "Reabierto".
  `"volver a abrir incidencia".toLowerCase()` no contiene ninguno de los nombres en inglés →
  ninguna transición casa → la reapertura es un **no-op silencioso** en Jira. La fila del portal
  se actualiza a `status='open', closed_at=NULL` mientras la incidencia de Jira permanece en
  "Finalizado".
- **Asimetría**: el camino de cierre (`jiraTransitionToDone` en `src/lib/jira.ts`) SÍ es bilingüe
  (`/done|cerrado|resolved|complete|hecho/i`) y comprueba `res.ok` tras ejecutar la transición;
  el camino de reapertura es solo-inglés y NO comprueba `res.ok` al ejecutar la transición, por
  lo que cualquier fallo se traga en silencio.
- El `POST` de comentarios (`src/app/api/jira/tickets/[key]/comments/route.ts`) devuelve un `500`
  genérico y opaco que descarta el código de estado real de Jira y el cuerpo de la respuesta
  (solo se loguean en servidor), haciendo el fallo indiagnosticable desde el cliente.
- `mypermissions?permissions=ADD_COMMENTS` devuelve `havePermission: true` sobre una incidencia
  "Finalizado", así que un bloqueo de permisos a nivel de proyecto NO es la causa obvia; el error
  real de Jira está enmascarado y la incidencia queda en estado inconsistente (la BD dice "open",
  Jira dice "Finalizado").

Este bugfix aborda tres defectos relacionados: (1) el emparejamiento de la transición de
reapertura debe ser bilingüe/robusto para el workflow SRE; (2) la ejecución de la transición de
reapertura debe comprobar `res.ok` y no dejar divergir el estado de la BD respecto al de Jira; y
(3) el endpoint de comentarios debe exponer el código y mensaje de error reales de Jira (no un 500
genérico) y propagar el estado adecuado (4xx vs 5xx).

## Bug Analysis

### Current Behavior (Defect)

Lo que ocurre hoy cuando se dispara el bug:

1.1 WHEN se reabre un ticket cuya incidencia Jira solo ofrece la transición "Volver a abrir incidencia" (workflow SRE en español) THEN el sistema no encuentra ninguna transición que case con `REOPEN_TRANSITION_NAMES` (solo-inglés) y no ejecuta ninguna transición en Jira (no-op silencioso)

1.2 WHEN la ejecución `POST .../transitions` de reapertura devuelve un estado no-OK THEN el sistema ignora `res.ok` y trata la reapertura como exitosa sin registrar ni propagar el fallo

1.3 WHEN la reapertura no transiciona la incidencia en Jira THEN el sistema actualiza igualmente la fila del portal a `status='open', closed_at=NULL`, dejando la BD del portal divergente del estado real de Jira ("Finalizado")

1.4 WHEN se añade un comentario sobre una incidencia que sigue en "Finalizado" tras una reapertura fallida y Jira rechaza el `POST .../comment` THEN el sistema devuelve `HTTP 500` con cuerpo genérico `{"error":"Failed to add comment"}`, descartando el código de estado y el mensaje reales de Jira (solo quedan en logs de servidor)

1.5 WHEN Jira responde con un error de cliente (4xx) al añadir el comentario THEN el sistema devuelve siempre `HTTP 500`, ocultando la naturaleza real del error (4xx vs 5xx) al cliente

### Expected Behavior (Correct)

Lo que debería ocurrir en su lugar:

2.1 WHEN se reabre un ticket cuya incidencia Jira solo ofrece la transición "Volver a abrir incidencia" (u otras variantes en español como "Reabrir"/"Reabierto") THEN el sistema SHALL emparejar y ejecutar la transición de reapertura correcta, de forma bilingüe y simétrica al matcher de cierre

2.2 WHEN la ejecución `POST .../transitions` de reapertura devuelve un estado no-OK THEN el sistema SHALL comprobar `res.ok`, registrar el código y cuerpo reales, y propagar/señalar el fallo en lugar de tratarlo como exitoso

2.3 WHEN la reapertura no logra transicionar la incidencia en Jira THEN el sistema SHALL evitar marcar la fila del portal como `open` (o reflejar el fallo), de modo que el estado de la BD del portal no diverja del estado real de Jira

2.4 WHEN Jira rechaza el `POST .../comment` THEN el sistema SHALL exponer el código de estado y el mensaje de error reales de Jira al cliente para que el fallo sea diagnosticable

2.5 WHEN Jira responde con un error de cliente (4xx) al añadir el comentario THEN el sistema SHALL propagar un código de estado apropiado (4xx para errores de cliente, 5xx para errores de servidor) en lugar de devolver siempre `500`

### Unchanged Behavior (Regression Prevention)

Comportamiento existente que debe preservarse:

3.1 WHEN se cierra un ticket (`action: "close"`) THEN el sistema SHALL CONTINUE TO transicionar la incidencia a Done mediante el matcher bilingüe `jiraTransitionToDone` y actualizar la fila a `status='closed', closed_at=NOW()`

3.2 WHEN se añade un comentario válido sobre una incidencia que sí acepta comentarios THEN el sistema SHALL CONTINUE TO publicarlo en Jira en formato ADF con la línea de atribución `💬 Name (email):` y devolver `{ success: true }`

3.3 WHEN se reabre un ticket cuya incidencia Jira ofrece una transición de reapertura en inglés (p.ej. "Reopen"/"To Do") THEN el sistema SHALL CONTINUE TO emparejarla y ejecutarla correctamente

3.4 WHEN la petición de comentario o de reapertura corresponde a un ticket que no pertenece al usuario, o el cuerpo del comentario está vacío THEN el sistema SHALL CONTINUE TO devolver los errores de validación existentes (`404` "Ticket not found or not yours", `400` "Comment is required")

3.5 WHEN se listan los comentarios de un ticket (`GET .../comments`) THEN el sistema SHALL CONTINUE TO devolver los comentarios parseados desde ADF con la atribución de autor del portal extraída del cuerpo

### Bug Condition (C(X)) y Propiedad

Definiciones:
- **F**: el flujo actual (sin corregir) de reapertura + comentario.
- **F'**: el flujo corregido.

Función que identifica los inputs que disparan el bug:

```pascal
FUNCTION isBugCondition(X)
  INPUT: X = { issue, action, comment }
  OUTPUT: boolean

  // (a) Reapertura cuyo workflow Jira NO ofrece transición en inglés
  //     pero SÍ una de reapertura en español (p.ej. "Volver a abrir incidencia").
  reopenBug ←
      X.action = "reopen"
      AND NOT existsTransitionMatching(X.issue, REOPEN_TRANSITION_NAMES_EN)
      AND existsReopenTransition(X.issue)   // p.ej. "Volver a abrir incidencia" / "Reabrir"

  // (b) La ejecución de la transición de reapertura devuelve no-OK
  reopenExecBug ←
      X.action = "reopen"
      AND transitionPostStatus(X.issue) NOT IN { 200, 204 }

  // (c) Jira rechaza el POST del comentario (incl. incidencia en "Finalizado")
  commentBug ←
      X.action = "comment"
      AND jiraCommentStatus(X.issue, X.comment) >= 400

  RETURN reopenBug OR reopenExecBug OR commentBug
END FUNCTION
```

Propiedad — Fix Checking (comportamiento deseado para los inputs buggy):

```pascal
// Property: Fix Checking
FOR ALL X WHERE isBugCondition(X) DO
  result ← F'(X)

  // (a) Reapertura bilingüe: la incidencia transiciona de verdad en Jira
  IF X.action = "reopen" AND existsReopenTransition(X.issue) THEN
    ASSERT jiraIssueStatus(X.issue) cambió fuera de "Finalizado"

  // (b)/(c) Fallos surface-ados, no tragados ni enmascarados
  IF transitionFailed(X) THEN
    ASSERT portalRow(X.issue).status NO diverge del estado real de Jira
    ASSERT result expone el código/mensaje real (no 500 genérico)

  IF X.action = "comment" AND jiraCommentStatus(X) >= 400 THEN
    ASSERT result.status = jiraCommentStatus(X)   // 4xx propaga 4xx, 5xx propaga 5xx
    AND result.body incluye el mensaje real de Jira
END FOR
```

Propiedad — Preservation Checking (los inputs no-buggy se comportan igual):

```pascal
// Property: Preservation Checking
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT F(X) = F'(X)
END FOR
```

Esto garantiza que para todo input no-buggy (cierres, reaperturas con transición en inglés,
comentarios aceptados, validaciones de ownership/cuerpo vacío y listado de comentarios) el flujo
corregido se comporta idénticamente al original.
