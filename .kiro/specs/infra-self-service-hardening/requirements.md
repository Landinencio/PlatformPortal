# Requirements Document

## Introduction

Endurecimiento del flujo self-service de infraestructura del Platform Portal (formulario V2 en `/infra-requests`, endpoints `POST /api/infra-request-v2/{generate,modify}` y `POST /api/infra-assistant/execute/[id]`) tras el incidente del 24-jun-2026 (request id=32 de Gonzalo) en el que:

- Se generó y aprobó un preview para crear una RDS con `identifier` ya existente en `main` (`marketplace-payments-api-db.tf`, creado por la request id=31).
- El execute falló en `gitlabClient.createFile` con "file already exists"; el rollback dejó la request en `execute_failed`.
- La notificación al solicitante fue el genérico "No se pudo crear el archivo", sin explicar la causa raíz ni sugerir el flujo alternativo (formulario de modificación con la operación de ampliar entornos).

Esta feature refuerza el flujo en cinco ejes: (1) sustituir el catálogo estático de motores/versiones/familias RDS (`src/lib/rds/version-catalog.ts`) por listado dinámico contra AWS RDS (`rds:DescribeDBEngineVersions`) con caché y degradación; (2) detección proactiva de colisiones de fichero antes del preview y como salvaguarda antes del commit; (3) ampliación del formulario de modificación con la operación "añadir/quitar entorno" (que hoy no existe y es el caso real del incidente); (4) mensajes de error accionables en el execute, persistidos en la fila `infra_requests` para auditoría; (5) simetría del comportamiento en los recursos S3 e IAM que también genera el flujo V2.

La feature se enmarca en el contexto arquitectónico ya documentado en `.kiro/steering/portal-architecture.md` §18 (flujo IaC self-service) y §19 (self-service infra de squad), y en la spec previa `.kiro/specs/infra-request-form-v2/` (formulario V2). No duplica lo ya especificado allí: extiende la generación determinista (`src/lib/rds/rds-generator.ts`), la ruta de modificación (`src/app/api/infra-request-v2/modify/route.ts`) y el execute (`src/app/api/infra-assistant/execute/[id]/route.ts`).

## Glossary

- **Portal**: Plataforma Next.js 14 App Router desplegada como `portal-prod` (ns `n8n`) y `portal-dev` (ns `platformportal`) en el cluster `dp-tooling` (`arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling`).
- **Generador_RDS**: Módulo determinista `src/lib/rds/rds-generator.ts` que produce el `TerraformPreview` para nuevas RDS.
- **Formulario_V2**: Formulario guiado en `/infra-requests` (spec `infra-request-form-v2`) que llama a `POST /api/infra-request-v2/generate`.
- **Formulario_Modify**: Formulario de modificación de recursos existentes que llama a `POST /api/infra-request-v2/modify`.
- **Execute_API**: Endpoint interno `POST /api/infra-assistant/execute/[id]` que crea rama, escribe ficheros, abre MR, crea Jira y notifica Teams tras la aprobación.
- **Catalogo_Dinamico**: Servicio nuevo que resuelve engines, versiones y families elegibles llamando a `rds:DescribeDBEngineVersions` de la API de AWS RDS en la región del entorno destino, sustituyendo al catálogo estático `src/lib/rds/version-catalog.ts`.
- **Cache_Catalogo**: Almacén en memoria del proceso con TTL para las respuestas de `rds:DescribeDBEngineVersions`, con prefijo `rds-catalog:` en el módulo `src/lib/cache.ts`.
- **Fallback_Catalogo**: Última respuesta cacheada válida por (engine, región) que el Catalogo_Dinamico devuelve cuando la llamada actual a AWS falla.
- **Repositorio_Destino**: Repositorio GitLab del equipo solicitante (p.ej. `iskaypetcom/sre-infra/platform-engineering/aws/oms`, project id 45379727 para `digital`), catalogado en `repo_catalog` y accesible vía `src/lib/repo-catalog.ts`.
- **Guardia_Duplicado**: Comprobación que evita generar o commitear un fichero cuya ruta ya existe en la rama por defecto (`main`) del Repositorio_Destino.
- **Operacion_Entornos**: Nueva operación del Formulario_Modify que ajusta el conjunto de entornos donde vive un recurso (RDS/S3/IAM), sin tocar el resto del `.tf`.
- **Solicitante**: Usuario autenticado del portal que envía la solicitud; su email se guarda en `infra_requests.requestor_email`.
- **Aprobador**: Persona con permiso para aprobar la request según las reglas de `src/lib/team-approvers.ts` + `src/lib/infra-approvers.ts` (ver `.kiro/steering/portal-architecture.md` §17).
- **Mensaje_Accionable**: Texto de error que declara la causa concreta detectada por el portal (código y descripción) y sugiere al Solicitante el siguiente paso concreto (usar el Formulario_Modify, reintentar, contactar SRE, etc.).
- **Error_Persistido**: Estructura JSON `{code, message, step, timestamp}` guardada en la fila `infra_requests` (columna nueva o clave del `payload`, decisión de diseño) cuando el execute falla.
- **Portal_IRSA**: Rol AWS `arn:aws:iam::444455556666:role/portal-inventory-irsa` que asume el ServiceAccount `portal-sa` del portal.
- **N8n_Cost_Reader**: Rol cross-account read-only presente en 22 cuentas de IskayPet, asumible por Portal_IRSA para inventario y detección infra-live (ver `.kiro/steering/portal-architecture.md` §7).
- **AWS_Region_Destino**: Región AWS donde se desplegará el recurso. Fija a `eu-west-1` para todas las cuentas objetivo del flujo IaC del portal.

---

## Requirements

### Requirement 1: Catálogo dinámico de engines/versiones/familias RDS desde AWS

**User Story:** Como Solicitante que crea una RDS por el Formulario_V2, quiero que las versiones ofrecidas para cada engine sean exactamente las que AWS RDS soporta hoy en la región destino, para no depender de commits del portal cada vez que AWS publica una versión nueva.

Fuentes: `.kiro/steering/portal-architecture.md` §18, `src/lib/rds/version-catalog.ts` (catálogo estático actual), `src/lib/rds/rds-generator.ts` (consumidor del catálogo).

#### Acceptance Criteria

1. THE Catalogo_Dinamico SHALL exponer una función `listRdsEngineOptions(engine, region)` que devuelva una lista de tuplas con los campos `version`, `family`, `deprecated` y `defaultForEngine`, obtenidas exclusivamente a partir del resultado de `rds:DescribeDBEngineVersions` (parámetro `Engine=engine`) ejecutada contra la región `region` de la API de AWS RDS.
2. WHEN el Formulario_V2 abre el selector de versión para un valor de `engine` incluido en la lista de engines habilitados del Catalogo_Dinamico, THE Formulario_V2 SHALL poblar las opciones de versión invocando `listRdsEngineOptions(engine, "eu-west-1")` y presentando únicamente los elementos cuyo campo `deprecated` sea `false`.
3. WHEN el Generador_RDS deriva la `family` para el par (engine, version) seleccionado por el Solicitante, THE Generador_RDS SHALL asignar como valor de `family` el contenido literal del campo `DBParameterGroupFamily` devuelto por `rds:DescribeDBEngineVersions` para esa versión concreta, sin construir el nombre por concatenación ni por transformación textual.
4. WHERE una versión devuelta por el Catalogo_Dinamico tenga el campo `deprecated` igual a `true`, THE Formulario_V2 SHALL excluir dicha versión del selector de versión.
5. THE Catalogo_Dinamico SHALL almacenar cada respuesta exitosa de `rds:DescribeDBEngineVersions` en Cache_Catalogo bajo la clave `(engine, region)`, con un TTL de 86.400.000 milisegundos (24 horas) contados desde el timestamp de la respuesta.
6. WHEN el Catalogo_Dinamico recibe una petición cuya clave `(engine, region)` existe en Cache_Catalogo y cuya antigüedad es inferior al TTL de 86.400.000 milisegundos, THE Catalogo_Dinamico SHALL devolver el valor cacheado sin invocar la API de AWS.
7. IF la llamada a `rds:DescribeDBEngineVersions` termina con error o su duración supera 8.000 milisegundos, THEN THE Catalogo_Dinamico SHALL devolver como Fallback_Catalogo la última respuesta almacenada en Cache_Catalogo para esa clave `(engine, region)`, adjuntando el campo `stale` con valor `true` y el campo `staleSince` con el timestamp (ISO 8601 UTC) de dicha respuesta cacheada.
8. IF la llamada a `rds:DescribeDBEngineVersions` termina con error o supera 8.000 milisegundos y Cache_Catalogo no contiene ninguna respuesta previa para esa clave `(engine, region)`, THEN THE Catalogo_Dinamico SHALL devolver al llamador un objeto de error estructurado con los campos `code` (valor `"catalog_unavailable"`), `engine` y `region`, sin propagar excepción.
9. WHEN el Formulario_V2 recibe una respuesta del Catalogo_Dinamico con `stale` igual a `true`, THE Formulario_V2 SHALL mostrar un aviso visual que no impida seleccionar una versión y que incluya textualmente que la lista mostrada es la última conocida y el valor de `staleSince` formateado como fecha y hora locales del navegador.
10. THE Catalogo_Dinamico SHALL obtener las credenciales AWS asumiendo el rol Portal_IRSA como opción por defecto, o el rol N8n_Cost_Reader mediante `sts:AssumeRole` en la cuenta destino cuando la variable de configuración que selecciona el rol lo indique, sin incluir credenciales AWS estáticas ni en el código fuente ni en la imagen de contenedor construida.
11. IF el parámetro `engine` recibido por el Catalogo_Dinamico no pertenece a su lista de engines habilitados (valor inicial de la lista: `postgres`; extensible a `mysql`, `mariadb`, `aurora-postgresql` y `aurora-mysql` modificando únicamente esa lista, sin cambios en la lógica de resolución de versión ni de familia), THEN THE Catalogo_Dinamico SHALL devolver un objeto de error estructurado con los campos `code` (valor `"engine_not_supported"`) y `engine`, sin invocar `rds:DescribeDBEngineVersions`.
12. THE Catalogo_Dinamico SHALL emitir mediante InfraLogger un registro estructurado por cada resolución que incluya al menos los campos `engine`, `region` y `outcome`, con nivel `info` cuando la respuesta se sirve desde Cache_Catalogo, nivel `warn` cuando se sirve como Fallback_Catalogo con `stale` igual a `true`, y nivel `error` cuando se devuelve el error `catalog_unavailable`.

---

### Requirement 2: Detección proactiva de duplicados en la generación de recursos

**User Story:** Como Solicitante, quiero que el portal rechace en el momento de generar el preview cualquier solicitud cuyo fichero `.tf` de destino ya exista en `main` del Repositorio_Destino, para evitar previews imposibles y aprender inmediatamente que el caso correcto es el Formulario_Modify.

Fuentes: `src/app/api/infra-request-v2/generate/route.ts`, `src/lib/rds/rds-generator.ts` (RDS), path convencional `iac/databases/<identifier>.tf`; `.kiro/steering/portal-architecture.md` §18.

#### Acceptance Criteria

1. WHEN `POST /api/infra-request-v2/generate` recibe una solicitud de tipo `rds`, THE Generate_API SHALL, antes de invocar al Generador_RDS, comprobar si el fichero `iac/databases/<identifier>.tf` existe en la rama por defecto del Repositorio_Destino, resolviendo esa rama a partir de la propiedad `default_branch` devuelta por `repo_catalog.getByTeam(team)` (equivalente por equipo según `src/lib/repo-catalog.ts`) en lugar de asumir el literal `"main"`.
2. WHEN `POST /api/infra-request-v2/generate` recibe una solicitud de tipo `s3`, THE Generate_API SHALL, antes de generar el preview, comprobar si el bloque `resource "aws_s3_bucket" "<bucket_name>"` ya está declarado en cualquier fichero `.tf` del directorio compartido de S3 del Repositorio_Destino declarado por `repo_catalog.getByTeam(team)` (el equivalente por equipo, típicamente `iac/s3/s3.tf`).
3. WHEN `POST /api/infra-request-v2/generate` recibe una solicitud de tipo `iam_role`, THE Generate_API SHALL, antes de generar el preview, comprobar si el bloque `resource "aws_iam_role" "<role_name>"` ya está declarado en el fichero compartido de roles del Repositorio_Destino declarado por `repo_catalog.getByTeam(team)` (el equivalente por equipo, típicamente `iac/roles/roles.tf`).
4. IF cualquiera de las comprobaciones de los criterios 1, 2 o 3 detecta que el recurso ya existe, THEN THE Generate_API SHALL responder HTTP 409 con un cuerpo `{ code: "resource_exists", resourceType, identifier, filePath, suggestion: "modify" }` y SHALL NO invocar al Generador_RDS ni al `InfraAgent`.
5. WHEN el Formulario_V2 recibe una respuesta HTTP 409 con `code: "resource_exists"`, THE Formulario_V2 SHALL mostrar un mensaje que declara el identificador ya en uso, la ruta del fichero existente, y un enlace que abre el Formulario_Modify precargado con ese mismo `team`, `resourceType` e `identifier`.
6. THE Guardia_Duplicado SHALL usar la lectura de árbol de GitLab (`GET /projects/:id/repository/tree` recursivo) o `GET /projects/:id/repository/files/:path/raw`, y SHALL cachear el resultado por `(projectId, ref, filePath)` con TTL de 60 segundos para evitar múltiples llamadas dentro de una misma sesión de formulario.
7. IF una llamada a la API de GitLab realizada por la Guardia_Duplicado devuelve un status HTTP mayor o igual a 400 (excluyendo el status 404 sobre la ruta del fichero compartido de los criterios 2 y 3, que SHALL tratarse como "no duplicado" y permitirá continuar la generación), o la duración total de la comprobación supera 5.000 milisegundos, THEN THE Generate_API SHALL responder HTTP 503 con `{ code: "duplicate_check_unavailable", detail }` y SHALL NO invocar al Generador_RDS ni al `InfraAgent`.
8. THE Guardia_Duplicado SHALL normalizar el `identifier`, `bucket_name` o `role_name` recibido a minúsculas antes de comparar, y SHALL validar que casa con el patrón `^[a-z0-9][a-z0-9-]{0,62}$`; IF no casa con ese patrón, THEN THE Generate_API SHALL responder HTTP 422 con `{ code: "invalid_identifier_charset" }` sin invocar a la Guardia_Duplicado.
9. THE Guardia_Duplicado SHALL consultar únicamente la rama por defecto del Repositorio_Destino (nunca otras ramas del proyecto) al comprobar la existencia del fichero, para evitar clasificar como duplicado un recurso que exista solamente en una merge request abierta.
10. WHEN el Execute_API completa con éxito una llamada `createFile` sobre una ruta `filePath` en el Repositorio_Destino con `projectId` y `ref` concretos, THE Execute_API SHALL invalidar la entrada de Cache_Catalogo asociada a la clave `(projectId, ref, filePath)` de la Guardia_Duplicado, para evitar falsos negativos cuando dos peticiones distintas se resuelven en secuencia dentro de la misma ventana de 60 segundos.
11. WHERE la solicitud recibida por `POST /api/infra-request-v2/generate` tenga un `resource_type` cuyo valor empieza por `squad-` (rutas de la spec §19 del steering), THE Guardia_Duplicado SHALL omitirse y el flujo actual de squad-self-service SHALL continuar sin cambios.

---

### Requirement 3: Salvaguarda de duplicados en el execute

**User Story:** Como Solicitante, quiero que si entre la generación del preview y su ejecución otra request creó el mismo fichero, el execute lo detecte y lo declare explícitamente en vez de fallar con un mensaje genérico y borrar la rama.

Fuentes: `src/app/api/infra-assistant/execute/[id]/route.ts` (paso `createFile`), incidente id=32 (24-jun-2026).

#### Acceptance Criteria

1. WHEN Execute_API procesa una request con `resource_type` en {`rds`, `s3`, `iam_role`} y con `terraform_preview.isModification` con valor `false` o ausente, THE Execute_API SHALL, tras crear la rama y antes de llamar a `createFile`, comprobar si `terraform_preview.filePath` existe en la rama por defecto del Repositorio_Destino, aplicando un timeout total de 5.000 milisegundos a esta comprobación (precheck).
2. IF la comprobación del criterio 1 encuentra el fichero, THEN THE Execute_API SHALL ejecutar en orden las siguientes cuatro sub-acciones: (a) transitar la fila de `infra_requests` a `execute_failed`; (b) persistir Error_Persistido con `code: "resource_exists_at_execute"` incluyendo en el campo `message` el `filePath` en conflicto; (c) borrar la rama recién creada en el Repositorio_Destino; (d) notificar al Solicitante en menos de 30 segundos con un Mensaje_Accionable que declare el conflicto y sugiera el Formulario_Modify.
3. IF el precheck del criterio 1 falla por causa transitoria (duración superior a 5.000 milisegundos o respuesta HTTP con status 5xx de la API de GitLab), THEN THE Execute_API SHALL transitar la fila de `infra_requests` a `execute_failed`, persistir Error_Persistido con `code: "precheck_unavailable"`, borrar la rama recién creada, y notificar al Solicitante con un Mensaje_Accionable que sugiera reintentar la solicitud; THE Execute_API SHALL NO continuar hacia la llamada `createFile` en este escenario.
4. IF la llamada a `gitlabClient.createFile` (recursos nuevos) devuelve un error cuyo cuerpo contiene literalmente la subcadena `"A file with this name already exists"` cuando el status HTTP es 400, o cuyo cuerpo contiene literalmente la subcadena `"already exists"` para cualquier otro status, THEN THE Execute_API SHALL clasificar el error como `resource_exists_at_execute` y aplicar el mismo tratamiento en cuatro sub-acciones que el criterio 2.
5. THE Execute_API SHALL mantener las siguientes tres propiedades de idempotencia y at-most-once: (a) el claim atómico se realiza mediante `UPDATE infra_requests SET status='executing' WHERE id=$1 AND status='approved'` y sólo prosigue si `rowCount = 1`; (b) el `try/finally` de rollback de rama que borra la rama recién creada ante cualquier error SHALL seguir vigente sin modificaciones; (c) las transiciones desde los estados terminales `executed` y `execute_failed` hacia `executing` SHALL estar prohibidas.
6. WHILE otra invocación del Execute_API para el mismo `id` de request está en estado `executing`, THE Execute_API SHALL responder HTTP 409 con `{ code: "concurrent_execute" }` sin realizar ningún cambio en el Repositorio_Destino ni enviar ninguna notificación.

---

### Requirement 4: Operación "añadir/quitar entorno" en el Formulario_Modify

**User Story:** Como Solicitante que ya tiene una RDS/S3/IAM viviendo en `dev` y quiere ampliarla a `uat` o `prod`, quiero declararlo como una modificación del recurso existente en vez de crear uno nuevo, para que el flujo respete la realidad (el recurso ya existe) y no colisione con la Guardia_Duplicado.

Fuentes: `src/app/api/infra-request-v2/modify/route.ts` (operaciones soportadas: `instanceClass`, `storageGb`, `maxStorageGb`, `multiAz`, `engineVersion`, `backupRetentionDays`, `performanceInsights` para RDS; `versioning`, `lifecycleRules` para S3; `addPermissions`, `removePermissions` para IAM), `src/lib/rds/render-rds.ts` (`upsertTfvarsEntries`), `.kiro/steering/portal-architecture.md` §18 y §17.

#### Acceptance Criteria

1. THE Formulario_Modify SHALL exponer una operación `targetEnvironments` que acepta un array con entre 1 y 3 elementos, todos ellos únicos (sin duplicados) y cada uno perteneciente al dominio cerrado `{"dev", "uat", "prod"}`, representando el conjunto deseado tras la modificación (no deltas).
2. IF el payload `targetEnvironments` recibido no cumple las restricciones del criterio 1 (array vacío, elementos duplicados, cualquier valor fuera del dominio `{"dev", "uat", "prod"}`, o tipo distinto de array), THEN THE Modify_API SHALL responder HTTP 400 con `{ code: "invalid_target_environments" }` y NO producirá ningún preview.
3. WHEN el Solicitante envía una modificación de tipo `rds` con `targetEnvironments`, THE Modify_API SHALL leer el `.tf` actual del recurso, calcular el conjunto de entornos actualmente activos a partir del literal de la expresión canónica `count = contains([...], var.environment) ? 1 : 0` (o un equivalente sintáctico documentado en la spec de diseño), y producir un nuevo preview donde ese literal quede reemplazado por el array solicitado, preservando el resto del bloque `resource`/`module` sin modificaciones.
4. IF el `.tf` del recurso no contiene la expresión canónica descrita en el criterio 3 ni un equivalente sintáctico documentado, y la Modify_API no puede parsear los entornos actuales, THEN THE Modify_API SHALL responder HTTP 422 con `{ code: "environments_expression_not_parseable" }` y NO producirá ningún preview.
5. WHEN el Solicitante envía una modificación de tipo `s3` o `iam_role` con `targetEnvironments`, THE Modify_API SHALL aplicar la misma lógica que en el criterio 3 sobre el bloque `resource` afectado, preservando byte-exacto el resto del contenido del fichero compartido.
6. WHEN la Modify_API genera el preview de una modificación con `targetEnvironments` sobre un recurso de tipo `rds`, THE Modify_API SHALL actualizar las entradas de `iac/databases/vars/<env>.tfvars` invocando `upsertTfvarsEntries` de `src/lib/rds/render-rds.ts` para añadir las entradas de los entornos nuevos y eliminar las entradas del recurso en los entornos retirados.
7. IF `targetEnvironments` resulta ser exactamente el mismo conjunto que el ya declarado en el `.tf` actual, THEN THE Modify_API SHALL responder HTTP 400 con `{ code: "no_op_target_environments" }` y NO generará MR.
8. IF `targetEnvironments` incluye un entorno para el que no existe el fichero `vars/<env>.tfvars` en el repo, THEN THE Modify_API SHALL responder HTTP 422 con `{ code: "missing_tfvars_file", environment }`.
9. WHEN la operación `targetEnvironments` retira un entorno donde el recurso está actualmente activo, THE Modify_API SHALL incluir en el array `warnings` del preview una entrada con la estructura `{ code: "environment_removal_warning", removedEnvironments: [<lista de entornos retirados>], message: "El próximo terraform apply destruirá el recurso en estos entornos; verifica antes de aprobar." }`.
10. WHILE la Modify_API procesa una operación `targetEnvironments`, THE Modify_API SHALL aplicar la validación `teamsApprovedBy()` documentada en `.kiro/steering/portal-architecture.md` §17 sin habilitar auto-aprobación y sin permitir que el propio Solicitante actúe como Aprobador de su misma request.
11. WHEN el Formulario_Modify presenta la operación `targetEnvironments`, THE Formulario_Modify SHALL mostrar los entornos actualmente activos obtenidos mediante lectura previa vía la Modify_API y permitir marcar/desmarcar entornos.

---

### Requirement 5: Mensajes de error accionables y persistidos en el execute

**User Story:** Como Solicitante cuya request ha fallado en el execute, quiero recibir una notificación que diga exactamente qué paso falló, por qué, y qué debería hacer a continuación, y que ese detalle quede guardado para que SRE pueda auditarlo sin abrir logs.

Fuentes: `src/app/api/infra-assistant/execute/[id]/route.ts` (transiciones a `execute_failed` con mensaje genérico), `src/lib/notifications.ts`, schema `infra_requests` (sin columna `error_message`).

#### Acceptance Criteria

1. THE Execute_API SHALL clasificar cada fallo en uno de los códigos siguientes: `terraform_invalid`, `rds_rotation_missing`, `secret_detected`, `resource_exists_at_execute`, `shared_file_conflict`, `create_branch_failed`, `create_file_failed`, `aux_file_failed`, `repo_not_found`, `unknown`; THE Execute_API SHALL usar `code: "unknown"` únicamente cuando el error no pueda clasificarse en ninguno de los otros nueve códigos y, en ese caso, SHALL emitir un log de nivel `error` que incluya el stacktrace completo del error original.
2. WHEN THE Execute_API transita una request a `execute_failed`, THE Execute_API SHALL persistir un Error_Persistido con la forma `{ code, message, step, timestamp }` en la fila de `infra_requests` correspondiente al `id` de la request, cumpliendo: (a) `timestamp` en formato ISO 8601 UTC; (b) `step` con uno de los valores `precheck`, `create_branch`, `create_file`, `update_file`, `aux_file`, `create_mr`, `create_jira`, `notify_teams`, `db_update`; (c) `message` con longitud entre 10 y 500 caracteres.
3. WHEN THE Execute_API notifica al Solicitante un fallo de execute, THE notificación SHALL contener el `code` del fallo, una descripción en español legible, el paso concreto donde falló, y la sugerencia accionable determinista definida por la tabla siguiente: `terraform_invalid` → "Revisa el HCL generado y reenvía la solicitud."; `rds_rotation_missing` → "El preview no incluye la rotación obligatoria de master. Reenvía."; `secret_detected` → "El preview contiene un valor que parece un secreto. Revisa y reenvía."; `resource_exists_at_execute` → "El recurso ya existe. Usa el formulario de modificación."; `shared_file_conflict` → "Otro cambio se solapó con el tuyo. Reintenta en unos segundos."; `create_branch_failed`, `create_file_failed`, `aux_file_failed` → "Fallo transitorio de GitLab. Reintenta la solicitud."; `repo_not_found` → "El equipo no tiene repositorio asociado. Contacta con SRE."; `unknown` → "Fallo inesperado. Contacta con SRE incluyendo el ID de la solicitud."
4. WHERE el fallo es `resource_exists_at_execute`, THE notificación SHALL incluir un enlace determinista al Formulario_Modify con la forma `/infra-requests?prefill={team,resourceType,identifier}` (los tres valores tomados de la request fallida y serializados como parámetros de query).
5. WHERE el fallo es `terraform_invalid`, `rds_rotation_missing` o `secret_detected`, THE notificación SHALL declarar que el preview fue rechazado antes de tocar el repositorio y que el Solicitante puede corregir el preview y reenviar.
6. THE feature SHALL incluir una migración SQL en `migrations/YYYY-MM-DD_infra_requests_error_message.sql` que añada la columna `error_message JSONB` a `infra_requests` (o, si la spec de diseño lo decide, defina la clave canónica `payload.executionError` con el mismo esquema).
7. WHEN la UI de `/infra-requests` muestra una request en estado `execute_failed`, THE UI SHALL renderizar el `code` y la sugerencia legibles a partir del Error_Persistido, y SHALL exponer un botón "Copiar detalle" que copie el JSON completo del Error_Persistido al portapapeles del usuario que pulsa el botón.
8. THE Execute_API SHALL mantener los logs estructurados actuales (`InfraLogger`) y el envío a Teams inalterados; THE persistencia del Error_Persistido en la fila `infra_requests` SHALL preceder en el flujo a la notificación al Solicitante, garantizando auditabilidad aunque la notificación falle posteriormente.
9. IF la persistencia del Error_Persistido en `infra_requests` falla (por error de conexión, timeout de base de datos o cualquier excepción de escritura), THEN THE Execute_API SHALL emitir un log de nivel `error` con `code: "error_persist_failed"` y SHALL enviar la notificación al Solicitante con `code: "unknown"` y la sugerencia genérica del criterio 3, sin bloquear el resto del flujo de rollback (borrado de rama, transición de estado).

---

### Requirement 6: Simetría de comportamiento en S3 e IAM

**User Story:** Como Solicitante de un bucket S3 o un rol IAM, quiero la misma calidad de trato (detección de duplicados, mensajes accionables, operación de ampliar entornos) que en RDS, para que el flujo self-service no tenga "esquinas oscuras" por tipo de recurso.

Fuentes: Generate_API actual (rama S3/IAM pasa por `InfraAgent`), Execute_API (mismo fichero para los tres tipos), Formulario_V2 y Formulario_Modify.

#### Acceptance Criteria

1. THE Guardia_Duplicado del Requirement 2 SHALL aplicarse a los tres tipos de recurso `rds`, `s3` e `iam_role` con la lógica descrita en los criterios 2.1, 2.2 y 2.3, usando como campo-clave `identifier` para `rds`, `bucketName` para `s3` y `roleName` para `iam_role`.
2. THE salvaguarda del Requirement 3 en el execute SHALL aplicarse a los tres tipos de recurso `rds`, `s3` e `iam_role`, bloqueando la ejecución cuando el recurso ya existe en la rama destino con el identificador correspondiente (`identifier`, `bucketName` o `roleName`).
3. THE clasificación de errores y persistencia de los criterios 5.1, 5.2 y 5.3 del Requirement 5 SHALL aplicarse a los tres tipos de recurso `rds`, `s3` e `iam_role`.
4. THE Operacion_Entornos del Requirement 4 SHALL aplicarse a los tres tipos de recurso, con las adaptaciones específicas de fichero compartido para S3/IAM descritas en 4.3.
5. WHERE el `resource_type` de la Solicitud es `s3` o `iam_role`, THE Solicitud SHALL omitir la invocación del Catalogo_Dinamico del Requirement 1 (no existe concepto de "versión de engine" para esos tipos).
6. IF el Formulario_V2 envía a `POST /api/infra-request-v2/generate` un payload con `resourceType` perteneciente a `{"s3", "iam_role"}` y ese mismo payload incluye alguna de las claves `engineVersion`, `engine` o `family`, THEN THE Generate_API SHALL responder HTTP 422 con `{ code: "unexpected_engine_field" }` y NO invocará al Generador_RDS ni al `InfraAgent`.

---

### Requirement 7: Observabilidad, auditoría y no-regresión

**User Story:** Como equipo de SRE, quiero que las nuevas rutas de código emitan la misma calidad de logs y métricas que el resto del portal, para poder diagnosticar incidentes futuros sin instrumentación adicional.

Fuentes: `src/lib/logger.ts` (`InfraLogger`), `.kiro/steering/portal-architecture.md` §18 y §17.

#### Acceptance Criteria

1. WHEN la Guardia_Duplicado, el Catalogo_Dinamico o la Operacion_Entornos completan una operación (con resultado de éxito o de fallo), THE módulo correspondiente SHALL emitir un log estructurado mediante `InfraLogger` incluyendo, como mínimo, los campos `userEmail`, `team`, `resourceType`, `identifier`, `outcome` (`hit`/`miss`/`stale`/`error`/`duplicate`/`ok`) y `latencyMs` (cuantificado como la duración en milisegundos desde el primer instante de invocación del handler hasta su retorno).
2. WHEN el Execute_API persiste un Error_Persistido, THE Execute_API SHALL emitir además un log de nivel `error` que incluya el mismo `code` y `step` del Error_Persistido junto con el campo `requestId` correspondiente al `id` de la fila de `infra_requests`.
3. THE feature NO SHALL modificar los contratos existentes de `POST /api/infra-request-v2/generate` para los casos "sin duplicado": para una misma request de entrada, el `TerraformPreview` de salida SHALL ser estructuralmente idéntico al baseline `v0.23.0-rc.1` bajo igualdad JSON canónica (ordenación estable de claves y whitespace normalizado).
4. THE feature NO SHALL introducir dependencias con features que no estén desplegadas actualmente en `portal-prod` versión `v0.23.0-rc.1` sin declaración explícita en la spec de diseño.
5. IF una dependencia de código introducida por esta feature requiere una versión del portal más reciente que `v0.23.0-rc.1`, THEN la spec de diseño SHALL declarar el rango mínimo requerido de versión del portal y la ventana de despliegue previa que debe completarse antes de activar la feature en producción.
6. THE suite `npm run test` del portal SHALL completarse con exit code 0 tras la implementación de esta feature, con un tiempo total de ejecución inferior a 900.000 milisegundos (15 minutos) medido en el runner de referencia del portal.
7. THE módulos puros Catalogo_Dinamico, comparador de conjuntos de entornos y clasificador de errores SHALL tener tests basados en propiedades con `fast-check` configurados con `{ numRuns: 100 }` según la convención del portal.

---

### Requirement 8: Seguridad y control de acceso

**User Story:** Como responsable de seguridad del portal, quiero que las nuevas capacidades no amplíen la superficie de riesgo ni degraden las garantías de RBAC ya vigentes.

Fuentes: `.kiro/steering/portal-architecture.md` §17 (RBAC), `.kiro/steering/tool-access.md` (regla de tokens), Portal_IRSA + `n8n-cost-reader-role`.

#### Acceptance Criteria

1. THE Catalogo_Dinamico SHALL obtener credenciales AWS exclusivamente mediante la cadena documentada Portal_IRSA (opción por defecto) o `sts:AssumeRole` sobre N8n_Cost_Reader en la cuenta destino, y SHALL NO leer ni transmitir credenciales AWS provenientes de otras fuentes, incluyendo variables de entorno con valores literales, ficheros del repositorio, la imagen de contenedor construida ni respuestas falsificadas del metadata service.
2. THE policy IAM asociada al rol asumido por el Catalogo_Dinamico SHALL prohibir el uso de wildcards (`*`) tanto en el campo `Action` como en el campo `Resource`, y SHALL prohibir cualquier acción cuya operación sea de escritura o modificación (verbos `Create`, `Modify`, `Delete`, `Put`, `Update`, `Restore`); el único permiso concedido SHALL ser `rds:DescribeDBEngineVersions` con `Resource: "*"`, justificado por el hecho de que la API de AWS no soporta ARN-scoping para esa acción.
3. IF una petición a `POST /api/infra-request-v2/generate` no incluye una sesión autenticada válida (contract existente `requireUserAuth`), THEN THE Generate_API SHALL responder HTTP 401 sin invocar al Catalogo_Dinamico ni a la Guardia_Duplicado.
4. IF `teamsApprovedBy(reviewer)` no incluye el equipo de la request y el Aprobador no es un Aprobador global (`ALL_APPROVER_EMAILS`), THEN THE Modify_API SHALL responder HTTP 403 sin alterar el estado de la request.
5. THE Catalogo_Dinamico SHALL exponer al llamador únicamente los campos `version`, `family`, `deprecated` y `defaultForEngine` extraídos de la respuesta de `rds:DescribeDBEngineVersions`; cualquier otro campo devuelto por la API de AWS SHALL descartarse antes de la serialización al cliente.
6. IF la asunción del rol Portal_IRSA falla (por ejemplo, error de STS, rol no encontrado, trust policy inválida), THEN THE Catalogo_Dinamico SHALL responder al llamador con un objeto de error estructurado `{ code: "credentials_unavailable" }` sin realizar fallback a credenciales alternativas y SHALL NO registrar en ningún log los valores de tokens, ARNs de rol asumidos ni el contenido de la respuesta de STS.

---

### Requirement 9: Rate limits, timeouts y latencias

**User Story:** Como Solicitante, quiero que la respuesta del formulario siga siendo rápida aunque ahora consulte AWS y GitLab, para que el flujo de creación no degrade con la nueva lógica.

Fuentes: `src/lib/rate-limiter.ts` (10 requests por usuario por minuto en `POST /api/infra-request-v2/generate`), `maxDuration = 120` del route actual.

#### Acceptance Criteria

1. THE Generate_API SHALL mantener el rate-limiter existente de 10 requests por Solicitante por minuto sobre `POST /api/infra-request-v2/generate`; IF el Solicitante supera ese límite, THEN THE Generate_API SHALL responder HTTP 429 con la cabecera `Retry-After` y sin invocar a la Guardia_Duplicado ni al Catalogo_Dinamico.
2. WHEN el Formulario_V2 abre el selector de versión de engine, THE Catalogo_Dinamico SHALL mantener una latencia p95 de respuesta igual o inferior a 200 milisegundos en el caso de hit-caché, medida sobre una ventana móvil de 5 minutos.
3. WHEN el Formulario_V2 abre el selector de versión de engine, THE Catalogo_Dinamico SHALL mantener una latencia p95 de respuesta igual o inferior a 3.000 milisegundos en el caso de miss-caché con AWS disponible, medida sobre una ventana móvil de 5 minutos (excluye el timeout de 8.000 milisegundos hacia AWS del Requirement 1).
4. THE Guardia_Duplicado SHALL mantener una duración total p95 igual o inferior a 5.000 milisegundos, medida sobre una ventana móvil de 5 minutos.
5. IF una invocación individual a la Guardia_Duplicado supera los 5.000 milisegundos, THEN THE Generate_API SHALL cortar la operación con el error HTTP 503 del criterio 2.7 sin esperar a la respuesta de GitLab.
6. THE Execute_API SHALL mantener su `maxDuration` configurado a 120 segundos.
7. THE salvaguarda del precheck del Requirement 3 SHALL contar contra el presupuesto total de `maxDuration` del Execute_API y SHALL abortar con `code: "precheck_unavailable"` si consume más de 5.000 milisegundos del presupuesto total.

---

### Requirement 10: Compatibilidad y ruta de migración

**User Story:** Como Solicitante con requests ya creadas antes de esta feature, quiero que las requests históricas se sigan pudiendo consultar y las nuevas no rompan la UI, para que la migración sea invisible para el usuario final.

Fuentes: `migrations/2026-04-07_infra_requests.sql` y siguientes; UI de `/infra-requests`; portal-prod `v0.23.0-rc.1`.

#### Acceptance Criteria

1. THE migración SQL del criterio 5.6 SHALL ser aditiva (`ADD COLUMN ... IF NOT EXISTS` o clave nueva del `payload`), lo que implica que NO SHALL renombrar columnas existentes, NO SHALL cambiar el tipo de ninguna columna existente, NO SHALL eliminar columnas existentes y NO SHALL modificar constraints ni índices existentes; THE migración SHALL preservar la validez del esquema previo tras aplicarse.
2. IF una request antigua está en estado `execute_failed` y su Error_Persistido está ausente (interpretado como `null`, ausente en el JSONB, o cadena vacía tras aplicar `trim`), THEN THE UI de `/infra-requests` SHALL renderizar la fila sin excepciones cliente y sin celdas indefinidas, mostrando como texto de fallback el literal internacionalizado `infra.status.execute_failed` cuando no hay mensaje legado disponible.
3. WHEN se solicite eliminar el catálogo estático `src/lib/rds/version-catalog.ts`, THE eliminación SHALL producirse únicamente después de verificar que el Catalogo_Dinamico ha respondido con éxito (100 % de las invocaciones con `outcome = "success"` según la métrica declarada en el design) durante los 7 días naturales continuos inmediatamente anteriores a la solicitud de eliminación; durante ese periodo el catálogo estático SHALL permanecer como Fallback_Catalogo inicial (semilla).
4. IF durante la ventana de convivencia el Catalogo_Dinamico no puede resolver un engine soportado (interpretado como cualquiera de los siguientes escenarios: respuesta de error estructurado, duración superior al timeout de 8.000 milisegundos, o lista vacía de versiones), THEN THE Generador_RDS SHALL usar el catálogo estático `src/lib/rds/version-catalog.ts` como fallback intermedio, la request NO SHALL abortar, y THE Generador_RDS SHALL emitir un log de nivel `warn` que identifique el `engine`, la `region` y cuál de las dos fuentes (Catalogo_Dinamico o `src/lib/rds/version-catalog.ts`) proporciona la respuesta usada.
