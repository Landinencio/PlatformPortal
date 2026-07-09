# Plan de Implementación: Bedrock FinOps Agent

## Visión General

Migración del chatbot FinOps actual (Converse API + text-to-SQL manual) a un AWS Bedrock Agent completo. La implementación se divide en: configuración del framework de testing, infraestructura Terraform (agente, Lambda, roles IAM), refactorización de la Chat API, actualización de la Chat UI, y cableado final con tests de integración.

## Tareas

- [ ] 1. Configurar framework de testing y dependencias
  - Instalar `vitest`, `fast-check` y `@aws-sdk/client-bedrock-agent-runtime` en el proyecto
  - Crear `vitest.config.ts` en la raíz del proyecto con soporte para path aliases (`@/`) y TypeScript
  - Añadir script `"test": "vitest --run"` en `package.json`
  - Verificar que el test existente (`tests/metrics-formulas.test.ts`) sigue funcionando (migrar a vitest o mantener separado)
  - _Requisitos: 3.1 (dependencia SDK), diseño (sección Estrategia de Testing)_

- [ ] 2. Crear módulo Terraform del Bedrock Agent
  - [ ] 2.1 Crear `infra/bedrock-finops-agent/variables.tf` con las variables parametrizables
    - Definir variables: `foundation_model_id`, `athena_database`, `athena_output_bucket`, `cur_role_arn`, `bedrock_region`, `agent_name`, `idle_session_ttl`
    - Incluir valores por defecto según el diseño (modelo Claude 3 Sonnet, región eu-west-1, base de datos athenacurcfn_finnops)
    - _Requisitos: 11.3_

  - [ ] 2.2 Crear `infra/bedrock-finops-agent/main.tf` con los recursos principales
    - Definir `aws_bedrockagent_agent` con el system prompt completo (migrado desde `route.ts` SYSTEM_PROMPT)
    - Definir `aws_iam_role` del agente con trust policy para `bedrock.amazonaws.com`
    - Definir `aws_iam_role` de la Lambda con permisos para AssumeRole al CUR account y ejecución Athena
    - Definir `aws_lambda_function` para `finops-athena-executor` (Node.js 20.x, 256MB, timeout 120s)
    - Definir `aws_bedrockagent_agent_action_group` referenciando el esquema OpenAPI y la Lambda
    - Definir `aws_bedrockagent_agent_alias` para invocación estable
    - Definir `aws_lambda_permission` para que Bedrock pueda invocar la Lambda
    - _Requisitos: 1.1, 1.2, 1.3, 2.2, 2.5, 2.6, 11.1, 11.2, 11.4_

  - [ ] 2.3 Crear `infra/bedrock-finops-agent/outputs.tf`
    - Exportar: `agent_id`, `agent_alias_id`, `lambda_arn`
    - _Requisitos: 11.2_

  - [ ] 2.4 Crear `infra/bedrock-finops-agent/openapi.json` con el esquema del action group
    - Definir la operación `executeAthenaQuery` con parámetros `sql_query` (string, requerido) y `max_rows` (integer, default 50)
    - Definir el schema de respuesta con campos `status`, `row_count`, `rows`, `execution_time_ms`, `error_message`
    - _Requisitos: 1.3, 2.1, 2.3_

- [ ] 3. Implementar la Lambda del Action Group
  - [ ] 3.1 Crear `infra/bedrock-finops-agent/lambda/index.mjs`
    - Implementar el handler que parsea el evento de Bedrock action group (extraer `sql_query` y `max_rows` del `requestBody`)
    - Implementar validación SQL: rechazar queries con INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE (case-insensitive)
    - Implementar AssumeRole cross-account al `CUR_ROLE_ARN` con credenciales temporales (900s)
    - Implementar ejecución Athena: `StartQueryExecution` → polling `GetQueryExecution` → `GetQueryResults`
    - Implementar limitación de filas al valor de `max_rows` (default 50, máximo 200)
    - Implementar formato de respuesta de action group de Bedrock (`messageVersion`, `response.actionGroup`, `httpStatusCode`)
    - Implementar manejo de errores: timeout de polling (110s), errores de Athena, errores de AssumeRole
    - Variables de entorno: `CUR_ROLE_ARN`, `ATHENA_DATABASE`, `ATHENA_OUTPUT`, `ATHENA_REGION`, `MAX_ROWS_DEFAULT`, `QUERY_TIMEOUT_MS`
    - _Requisitos: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 10.3, 10.5_

  - [ ]* 3.2 Escribir property test — Validación SQL (solo SELECT)
    - **Propiedad 1: Validación SQL — solo SELECT permitido**
    - Generar strings SQL aleatorios (SELECT válidos, INSERT/UPDATE/DELETE/DROP maliciosos, strings vacíos, intentos de SQL injection)
    - Verificar que la función de validación solo acepta SELECT y rechaza operaciones de mutación
    - **Valida: Requisitos 2.1, 10.5**

  - [ ]* 3.3 Escribir property test — Limitación de filas en resultados
    - **Propiedad 2: Limitación de filas en resultados**
    - Generar arrays de resultados de tamaño aleatorio (0 a 500 filas) con `max_rows` aleatorio (1 a 200)
    - Verificar que el output nunca excede `max_rows` y que `row_count` coincide con el número real de filas devueltas
    - **Valida: Requisitos 2.3**

  - [ ]* 3.4 Escribir property test — Propagación de errores de Athena
    - **Propiedad 3: Propagación de errores de Athena**
    - Generar mensajes de error aleatorios y verificar que la Lambda los envuelve correctamente en el formato de action group response
    - Verificar que `status` es "error", `error_message` contiene el mensaje original, y el formato Bedrock es válido (`messageVersion`, `httpStatusCode` 200)
    - **Valida: Requisitos 2.4**

  - [ ]* 3.5 Escribir unit tests para la Lambda
    - Tests con eventos mock de Bedrock action group verificando parsing de parámetros
    - Tests de formato de respuesta (success y error)
    - Tests de edge cases: query vacía, max_rows = 0, resultado vacío (0 filas)
    - _Requisitos: 2.1, 2.3, 2.4_

- [ ] 4. Checkpoint — Verificar infraestructura y Lambda
  - Ejecutar `terraform validate` sobre el módulo `infra/bedrock-finops-agent/`
  - Asegurar que todos los tests pasan, preguntar al usuario si surgen dudas.

- [ ] 5. Refactorizar la Chat API para usar Bedrock Agent
  - [ ] 5.1 Refactorizar `src/app/api/ai/finops-chat/route.ts`
    - Reemplazar imports de `BedrockRuntimeClient`/`ConverseCommand` por `BedrockAgentRuntimeClient`/`InvokeAgentCommand` de `@aws-sdk/client-bedrock-agent-runtime`
    - Eliminar la lógica de `extractSql()`, `executeSqlWithRetry()`, `buildConversationContext()` y `callBedrock()`
    - Implementar nueva función `invokeBedrockAgent(message, sessionId, context)` que use `InvokeAgentCommand`
    - Leer variables de entorno: `AWS_BEDROCK_AGENT_ID`, `AWS_BEDROCK_AGENT_ALIAS_ID`, `AWS_BEDROCK_ROLE_ARN`, `AWS_BEDROCK_REGION`
    - Implementar AssumeRole para obtener credenciales temporales de Bedrock
    - Inyectar contexto de PostgreSQL via `sessionState.promptSessionAttributes` (portal_context, current_date, user_name)
    - Cambiar el payload esperado de `{ messages: Message[] }` a `{ message: string, sessionId?: string }`
    - Devolver `{ reply: string, sessionId: string }` en la respuesta
    - Mantener `requireUserAuth` y validación de input
    - Mantener `getFinOpsContext()` para cargar contexto de la DB
    - Implementar manejo de errores: AssumeRole falla, InvokeAgent timeout, respuesta vacía, error genérico (todos devuelven HTTP 200 con `reply` descriptivo excepto auth/validation)
    - _Requisitos: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 7.1, 7.2, 7.3, 7.4, 9.3, 9.5, 10.1, 10.4_

  - [ ]* 5.2 Escribir property test — Formato de respuesta de la Chat API
    - **Propiedad 4: Formato de respuesta de la Chat API**
    - Generar strings de respuesta aleatorios (markdown, emojis, caracteres especiales, strings vacíos, strings largos)
    - Verificar que la API los envuelve en `{ reply, sessionId }` con HTTP 200
    - **Valida: Requisitos 3.4**

  - [ ]* 5.3 Escribir unit tests para la Chat API refactorizada
    - Tests con requests mock verificando autenticación (401 sin auth)
    - Tests de validación de input (400 sin message)
    - Tests de manejo de errores (AssumeRole falla, timeout, respuesta vacía)
    - Tests de carga de contexto con DB mock
    - _Requisitos: 3.1, 3.4, 3.5, 3.6, 9.3, 9.5, 10.1_

- [ ] 6. Actualizar la Chat UI para sessionId
  - [ ] 6.1 Modificar `src/components/finops/finops-chat.tsx`
    - Añadir estado `sessionId` generado con `crypto.randomUUID()` al abrir el chat
    - Cambiar el payload del fetch de `{ messages: apiMessages }` a `{ message: msg, sessionId }`
    - Regenerar `sessionId` en la función `clearChat()` (botón "Nueva conversación")
    - Eliminar la lógica de enviar todo el historial de mensajes al API (el agente gestiona la memoria via sessionId)
    - Mantener el historial local de mensajes solo para renderizado en la UI
    - Leer `sessionId` de la respuesta del API y actualizarlo si difiere
    - Mantener el diseño visual, preguntas rápidas, indicador de carga y restricción de rol admin sin cambios
    - _Requisitos: 4.1, 4.3, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7_

  - [ ]* 6.2 Escribir property test — Unicidad de Session IDs
    - **Propiedad 5: Unicidad de Session IDs**
    - Generar N session IDs (N >= 2, hasta 1000) usando `crypto.randomUUID()`
    - Verificar que todos son distintos entre sí y tienen formato UUID v4
    - **Valida: Requisitos 4.1**

  - [ ]* 6.3 Escribir unit tests para gestión de sessionId
    - Test de generación de sessionId al abrir el chat
    - Test de renovación de sessionId al limpiar conversación
    - Test de formato del payload enviado al API
    - _Requisitos: 4.1, 4.3, 8.3_

- [ ] 7. Checkpoint — Verificar integración completa
  - Asegurar que todos los tests pasan, preguntar al usuario si surgen dudas.
  - Verificar que `npm run build` compila sin errores

- [ ] 8. Cableado final y limpieza
  - [ ] 8.1 Verificar que la Chat API importa correctamente `@aws-sdk/client-bedrock-agent-runtime`
    - Confirmar que el import resuelve y que el build de Next.js no falla
    - Eliminar imports no usados de `@aws-sdk/client-bedrock-runtime` (ConverseCommand, BedrockRuntimeClient) si ya no se usan en ningún otro archivo
    - _Requisitos: 3.1_

  - [ ] 8.2 Documentar variables de entorno necesarias
    - Añadir las nuevas variables (`AWS_BEDROCK_AGENT_ID`, `AWS_BEDROCK_AGENT_ALIAS_ID`) al README o archivo de configuración de entorno existente
    - _Requisitos: 11.4_

  - [ ]* 8.3 Escribir tests de integración
    - Test end-to-end con mock del Bedrock Agent verificando el flujo completo: request → auth → context → invoke → response
    - Test de multi-turno: verificar que el sessionId se mantiene entre mensajes
    - _Requisitos: 4.2, 4.5, 12.2_

- [ ] 9. Checkpoint final — Verificar que todo compila y los tests pasan
  - Ejecutar `npm run build` para verificar compilación
  - Ejecutar `npm run test` para verificar todos los tests
  - Asegurar que todos los tests pasan, preguntar al usuario si surgen dudas.

## Notas

- Las tareas marcadas con `*` son opcionales y se pueden omitir para un MVP más rápido
- Cada tarea referencia requisitos específicos para trazabilidad
- Los checkpoints aseguran validación incremental
- Los property tests validan las 5 propiedades de corrección universales definidas en el diseño
- Los unit tests validan ejemplos específicos y edge cases
- El system prompt del agente se migra íntegramente desde el `SYSTEM_PROMPT` actual en `route.ts` al campo `instruction` del recurso Terraform
- La Lambda reutiliza la lógica de `athena-cur.ts` (AssumeRole + polling Athena) pero adaptada al formato de action group de Bedrock
