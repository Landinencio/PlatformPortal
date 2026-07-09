# Requirements Document

## Introduction

Esta especificación deriva del diseño aprobado `design.md` y documenta los requisitos para elevar **Iskay** —el chat FinOps del portal (Bedrock Sonnet 4, tool-calling, streaming SSE, **solo lectura**, acceso admin/directores)— al nivel de **chatbot FinOps especialista**, con el fin de poder abrirlo a toda la compañía cuando su comportamiento sea fiable al 100%.

La spec cubre **dos frentes**:

- **Frente A — Export a Excel**: una nueva tool `build_report` que Iskay invoca cuando el usuario pide un informe/Excel/fichero descargable. La tool NO recibe cifras del modelo: recibe una especificación de informe (rango, cuentas, secciones) y **vuelve a obtener los datos exactos** mediante los helpers de tools existentes, construyendo un `.xlsx` multi-hoja con la librería `XLSX`. El workbook se persiste en la tabla `finops_reports` (BYTEA + TTL) para que la descarga funcione desde cualquiera de las dos réplicas, servido por `GET /api/finops/report/[id]` con autenticación y comprobación de propiedad por email.
- **Frente B — Precisión y fiabilidad**: un harness de evaluación (golden-set) en `ops/iskay-evals/` que demuestre con datos que Iskay responde bien, más endurecimiento de grounding (guard de citas de cifras en modo "loguea y mide", refuerzo del system prompt, tests unitarios de `prettyServiceName` y resolución de fechas/cuentas).

El alcance es estrictamente **solo lectura**: no se añaden tools de escritura/acción, no se cambia el RBAC (sigue admin/directores) y no se modifica la arquitectura de datos (Athena/Lambda) ni el runner de tests ni el modelo.

## Glossary

- **Iskay**: chatbot FinOps del portal servido por `POST /api/ai/finops-chat`, basado en Bedrock Sonnet 4 con tool-calling y streaming SSE, solo lectura.
- **Report_Builder**: subsistema que implementa la tool `build_report` en `src/lib/finops-tools.ts`, encargado de re-obtener datos y construir el workbook `.xlsx`.
- **Report_Spec**: estructura de entrada de `build_report` con `title`, `startDate`, `endDate`, `accountIds` (opcional) y `sections`.
- **Report_Section**: cada sección solicitada de un informe, miembro del conjunto `{summary, by_account, by_service, by_domain, top_resources, net_breakdown, hidden_costs, marketplace}`. Cada sección se materializa como una hoja del Excel.
- **Report_Store**: módulo `src/lib/finops-report-store.ts` que persiste y recupera workbooks en la tabla `finops_reports`.
- **finops_reports**: tabla PostgreSQL con columnas `id UUID PK`, `filename TEXT`, `content BYTEA`, `user_email TEXT`, `created_at TIMESTAMPTZ`, `expires_at TIMESTAMPTZ` e índice por `expires_at`.
- **Report_Download_Endpoint**: ruta `GET /api/finops/report/[id]` que sirve el workbook como descarga.
- **prettyServiceName**: función existente que traduce códigos opacos del CUR (p.ej. `cg*` → "Marketplace (contrato)", ids de inference-profile → "Bedrock (GenAI)") a nombres legibles.
- **FinOps_Chat_UI**: componente `src/components/finops/finops-chat.tsx` que renderiza la conversación y el botón de descarga.
- **Eval_Harness**: conjunto de casos golden y runner en `ops/iskay-evals/` (Node + tsx) que evalúa el comportamiento de Iskay sin tocar producción.
- **Eval_Runner**: ejecutor (`run.ts`) que corre cada caso contra el loop del agente y aplica las assertions.
- **Eval_Case**: caso golden (`cases.ts`) con `id`, `question`, `expectTools`, `forbidTools` y `assertions`.
- **Citation_Guard**: verificación en servidor que comprueba que los importes monetarios del texto final aparecen en algún `toolResult` de la conversación.
- **Opaque_Id**: identificador crudo no legible del CUR, como códigos `cg…` o ids de inference-profile de Bedrock.
- **Authorized_User**: usuario con rol `admin` o `directores`, único autorizado a usar Iskay y a descargar informes.

## Requirements

### Requirement 1: Invocación de la tool `build_report`

**User Story:** Como usuario autorizado de Iskay, quiero pedir un informe en Excel en lenguaje natural, para obtener un fichero descargable con los datos de coste que necesito.

#### Acceptance Criteria

1. THE Report_Builder SHALL exponer la tool `build_report` dentro de `FINOPS_TOOLS` con un handler registrado en `executeFinopsTool`.
2. THE Report_Builder SHALL aceptar un Report_Spec con los campos requeridos `title`, `startDate`, `endDate` y `sections`, y los campos opcionales `accountIds`.
3. IF un Report_Spec omite alguno de los campos requeridos `title`, `startDate`, `endDate` o `sections`, THEN THE Report_Builder SHALL devolver un error de validación sin construir el workbook.
4. IF un Report_Spec incluye una sección que no pertenece al conjunto `{summary, by_account, by_service, by_domain, top_resources, net_breakdown, hidden_costs, marketplace}`, THEN THE Report_Builder SHALL devolver un error de validación sin construir el workbook.
5. IF un Report_Spec contiene un `startDate` posterior a su `endDate`, THEN THE Report_Builder SHALL devolver un error de validación sin construir el workbook.

### Requirement 2: Obtención de cifras exactas (cero alucinación)

**User Story:** Como responsable FinOps, quiero que el Excel contenga exclusivamente cifras exactas obtenidas de las fuentes de datos, para poder confiar en el fichero sin riesgo de cifras inventadas por el modelo.

#### Acceptance Criteria

1. WHEN el Report_Builder construye una Report_Section, THE Report_Builder SHALL obtener los datos llamando a los helpers de tools de lectura existentes con el rango y las cuentas del Report_Spec.
2. THE Report_Builder SHALL ignorar cualquier cifra monetaria que provenga del Report_Spec o del texto del modelo al poblar las celdas del workbook.
3. WHEN un Report_Spec incluye `accountIds`, THE Report_Builder SHALL acotar la obtención de datos de cada sección a esas cuentas.

### Requirement 3: Construcción del workbook multi-hoja

**User Story:** Como usuario autorizado de Iskay, quiero un Excel con una hoja por sección y una hoja de resumen, para navegar el informe de forma ordenada.

#### Acceptance Criteria

1. WHEN el Report_Builder genera un workbook, THE Report_Builder SHALL crear una hoja por cada Report_Section solicitada en el Report_Spec.
2. THE Report_Builder SHALL incluir una hoja "Resumen" con metadatos del informe: rango de fechas, cuentas, usuario que lo generó y timestamp de generación.
3. WHEN el Report_Builder escribe nombres de servicio en cualquier celda, THE Report_Builder SHALL aplicar `prettyServiceName` de forma que ningún Opaque_Id aparezca en el workbook.
4. THE Report_Builder SHALL serializar el workbook a un buffer `.xlsx` mediante la librería `XLSX`.
5. WHEN el Report_Builder completa la construcción, THE Report_Builder SHALL devolver `reportId`, `filename`, `sheetCount`, `rowCounts` y `downloadUrl` con el formato `/api/finops/report/<id>`.

### Requirement 4: Informe parcial ante fallo de sección

**User Story:** Como usuario autorizado de Iskay, quiero recibir un informe parcial cuando una sección falla, para no perder el resto de datos correctos.

#### Acceptance Criteria

1. IF la obtención de datos de una Report_Section falla, THEN THE Report_Builder SHALL incluir la hoja correspondiente con una nota de error y continuar con las secciones restantes.
2. IF la obtención de datos de todas las Report_Section solicitadas falla, THEN THE Report_Builder SHALL devolver un error que el modelo pueda comunicar al usuario.

### Requirement 5: Persistencia del informe en `finops_reports`

**User Story:** Como usuario autorizado de Iskay, quiero que la descarga funcione independientemente de la réplica que atienda mi petición, para evitar errores de descarga en un despliegue con dos réplicas.

#### Acceptance Criteria

1. WHEN el Report_Builder genera un workbook, THE Report_Store SHALL persistir el buffer en la tabla `finops_reports` con un `id` UUID, el `filename`, el `content` BYTEA, el `user_email` del solicitante, el `created_at` y un `expires_at`.
2. THE Report_Store SHALL recuperar un workbook persistido a partir de su `id`.
3. WHEN se sirve o consulta un informe cuyo `expires_at` ya pasó, THE Report_Store SHALL tratarlo como inexistente.
4. THE finops_reports SHALL disponer de un índice por `expires_at` para soportar la limpieza por TTL.
5. THE migración `migrations/2026-06-1X_finops_reports.sql` SHALL crear la tabla `finops_reports` con sus columnas e índice por `expires_at`.

### Requirement 6: Endpoint de descarga del informe

**User Story:** Como usuario autorizado de Iskay, quiero descargar mi informe mediante una URL protegida, para obtener el fichero `.xlsx` solo cuando estoy autorizado y soy su propietario.

#### Acceptance Criteria

1. WHEN una petición llega a `GET /api/finops/report/[id]`, THE Report_Download_Endpoint SHALL exigir autenticación de Authorized_User mediante el gate existente admin/directores.
2. WHEN un Authorized_User solicita un informe del que es propietario, THE Report_Download_Endpoint SHALL responder con el `content` BYTEA, la cabecera `Content-Disposition: attachment` con el `filename`, y el `Content-Type` correspondiente a `.xlsx`.
3. IF el informe solicitado no existe o ha expirado, THEN THE Report_Download_Endpoint SHALL responder con estado 404.
4. IF el email del usuario autenticado no coincide con el `user_email` propietario del informe, THEN THE Report_Download_Endpoint SHALL denegar el acceso al informe.

### Requirement 7: Entrega del enlace de descarga vía SSE y UI

**User Story:** Como usuario autorizado de Iskay, quiero ver un botón de descarga bajo la respuesta del chat, para acceder al Excel sin copiar URLs a mano.

#### Acceptance Criteria

1. WHEN la última tool ejecutada en un turno es `build_report`, THE Iskay SHALL incluir en el evento SSE `done` un objeto `report` con `downloadUrl` y `filename`.
2. WHEN un mensaje del asistente contiene un objeto `report`, THE FinOps_Chat_UI SHALL renderizar un botón de descarga del Excel bajo la respuesta.
3. WHEN el usuario activa el botón de descarga, THE FinOps_Chat_UI SHALL dirigir la descarga al `downloadUrl` del informe.

### Requirement 8: Harness de evaluación golden-set

**User Story:** Como responsable de Iskay, quiero un harness de evaluación con casos golden, para demostrar con datos que el chatbot responde correctamente antes de abrirlo a la compañía.

#### Acceptance Criteria

1. THE Eval_Harness SHALL residir en `ops/iskay-evals/` y ejecutarse con Node + tsx sin modificar datos de producción.
2. THE Eval_Harness SHALL definir cada Eval_Case con los campos `id`, `question`, `expectTools`, `forbidTools` (opcional) y `assertions`.
3. WHEN el Eval_Runner ejecuta un Eval_Case, THE Eval_Runner SHALL correr el loop del agente reutilizando `executeFinopsTool` y el mismo system prompt, capturando el `trace` de la conversación.
4. IF un Eval_Case lanza un error durante su ejecución, THEN THE Eval_Runner SHALL marcar ese caso como fallido y continuar con los casos restantes.
5. WHEN el Eval_Runner termina, THE Eval_Runner SHALL emitir un resultado pass/fail por caso y un score agregado.

### Requirement 9: Assertions deterministas de los evals

**User Story:** Como responsable de Iskay, quiero assertions deterministas sin depender de un LLM, para evaluar el comportamiento de forma reproducible y barata.

#### Acceptance Criteria

1. WHEN un Eval_Case define `expectTools`, THE Eval_Runner SHALL verificar que esas tools fueron invocadas durante la ejecución del caso.
2. WHEN un Eval_Case define `forbidTools`, THE Eval_Runner SHALL verificar que ninguna de esas tools fue invocada durante la ejecución del caso.
3. WHEN la assertion `citesToolFigures` está activa, THE Eval_Runner SHALL verificar que cada importe monetario citado en la respuesta aparece en algún `toolResult` de la conversación.
4. WHEN la assertion `noOpaqueIds` está activa, THE Eval_Runner SHALL verificar que la respuesta no contiene ningún Opaque_Id crudo.
5. WHEN un Eval_Case define `period`, THE Eval_Runner SHALL verificar que el rango de fechas resuelto coincide con el `start` y `end` esperados.
6. WHEN la assertion `outOfScopeRedirect` está activa, THE Eval_Runner SHALL verificar que una pregunta fuera del ámbito FinOps produce una redirección limpia sin datos inventados.

### Requirement 10: Casos golden iniciales sobre gotchas FinOps conocidos

**User Story:** Como responsable de Iskay, quiero casos iniciales que cubran los errores FinOps conocidos, para detectar regresiones en los puntos donde el chatbot suele equivocarse.

#### Acceptance Criteria

1. THE Eval_Harness SHALL incluir un caso donde "¿Cuánto cuesta AWS?" requiere usar `get_net_cost_breakdown` y prohíbe quedarse en el total bruto de `get_total_cost`.
2. THE Eval_Harness SHALL incluir un caso donde "¿Qué departamento gasta más en IA?" requiere usar `get_cost_by_domain` y prohíbe usar `get_cost_by_service`.
3. THE Eval_Harness SHALL incluir un caso donde un pico de gasto del día 1 se atribuye a cargos de marketplace y no a infraestructura.
4. THE Eval_Harness SHALL incluir un caso fuera de ámbito (p.ej. "dame los logs de oms") que exige redirección al dashboard sin inventar datos.
5. THE Eval_Harness SHALL incluir un caso de cita exacta donde la respuesta cita el mismo importe devuelto por la tool.

### Requirement 11: LLM-as-judge opcional

**User Story:** Como responsable de Iskay, quiero una evaluación cualitativa opcional mediante LLM, para puntuar claridad y correctud sin encarecer cada corrida.

#### Acceptance Criteria

1. WHERE el modo LLM-as-judge está activado, THE Eval_Runner SHALL puntuar la respuesta de cada caso contra una rúbrica mediante una llamada a Bedrock.
2. WHERE el modo LLM-as-judge está desactivado, THE Eval_Runner SHALL ejecutar únicamente las assertions deterministas.

### Requirement 12: Guard de citas de cifras en modo "loguea y mide"

**User Story:** Como responsable de Iskay, quiero medir las discrepancias entre cifras citadas y cifras verificadas, para endurecer el grounding con datos antes de bloquear respuestas.

#### Acceptance Criteria

1. WHEN el loop del agente produce la respuesta final, THE Citation_Guard SHALL comprobar que cada importe monetario del texto final aparece en algún `toolResult` de la conversación.
2. IF un importe monetario del texto final no aparece en ningún `toolResult`, THEN THE Citation_Guard SHALL registrar la discrepancia como telemetría sin bloquear la respuesta conversacional.

### Requirement 13: Refuerzo del system prompt

**User Story:** Como responsable de Iskay, quiero reforzar el system prompt con los hallazgos de los evals, para mejorar la resolución de fechas relativas, el manejo de out-of-scope y la prohibición de IDs opacos.

#### Acceptance Criteria

1. THE Iskay SHALL incluir en su system prompt instrucciones sobre la resolución de fechas relativas, el manejo de preguntas fuera de ámbito y la prohibición de exponer Opaque_Id.

### Requirement 14: Tests unitarios de helpers de grounding

**User Story:** Como desarrollador del portal, quiero tests unitarios de los helpers puros de Iskay, para validar la traducción de nombres y la resolución de fechas/cuentas de forma automatizada.

#### Acceptance Criteria

1. THE Testing_Suite SHALL incluir tests unitarios de `prettyServiceName` que verifiquen la traducción de Opaque_Id a nombres legibles.
2. THE Testing_Suite SHALL incluir tests unitarios de la resolución de fechas y de cuentas que verifiquen los rangos y cuentas resueltos a partir de la entrada.

### Requirement 15: Restricción de alcance solo lectura

**User Story:** Como responsable del portal, quiero que Iskay siga siendo estrictamente de solo lectura y limitado a admin/directores, para mantener el riesgo acotado mientras se prepara la apertura a la compañía.

#### Acceptance Criteria

1. THE Iskay SHALL operar únicamente con tools de lectura, sin exponer ninguna tool de escritura o de acción sobre recursos.
2. WHEN una petición a `POST /api/ai/finops-chat` proviene de un usuario sin rol `admin` ni `directores`, THE Iskay SHALL denegar el acceso con estado 403.
