# Requirements Document

## Introduction

Esta feature mejora el flujo self-service de creación y modificación de roles IAM del Platform Portal (`/infra-requests`). Hoy la creación de roles ofrece únicamente 6 categorías de servicio (S3, SecretsManager, SQS, SNS, EventBridge, RDS) marcadas como checkboxes cuyo texto se inyecta en el prompt de un agente Bedrock; es el modelo quien decide las acciones IAM concretas, por lo que el resultado no es determinista y las opciones se perciben como de grano grueso "tipo admin". La modificación de roles ofrece una lista fija de managed policies AWS (`COMMON_IAM_POLICIES`). El único guardarraíl contra permisos amplios es texto en el system prompt del agente, sin comprobación dura.

El objetivo es ofrecer muchas más opciones de permiso pero de **mínimo privilegio (no-admin)**, granulares y deterministas, mediante:

1. Un **catálogo curado y versionado de presets de permisos** (por servicio, con nivel de acceso), como única fuente de verdad compartida por los flujos de crear y modificar.
2. **Scoping a recursos concretos (ARNs)**: acotar cada permiso a buckets/colas/tablas/secretos/topics/buses concretos en lugar del servicio entero.
3. **Generación determinista de la policy** mediante plantillas TypeScript (estilo `src/lib/squad-infra/`), reservando el agente Bedrock (Infra_Agent) solo para casos no cubiertos por el catálogo.
4. Un **validador duro anti-admin** que rechaza de forma determinista cualquier política amplia (`*FullAccess`, `Administrator`, managed policies amplias) tanto al crear como al modificar.

Se respeta la arquitectura existente: patrón IRSA nativo (`aws_iam_role` + `role_templates/iskaypet_dh_access.json.tmpl` + `aws_iam_policy` scoped + `aws_iam_role_policy_attachment`), flujo de aprobación por equipo, y ejecución determinista con branch + MR + Jira.

**Nota fuera de alcance:** La incoherencia de la opción "RDS" en la creación de roles (las aplicaciones conectan a RDS con usuario/contraseña de Secrets Manager, no vía IAM role — steering §19) NO se corrige en esta feature. El Catálogo IAM NO expone presets que concedan permisos de datos RDS, en línea con la política de mínimo privilegio existente, pero el rediseño de esa opción queda para trabajo posterior.

## Glossary

- **Portal**: El Platform Portal (Next.js 14, TypeScript), desplegado en dp-tooling.
- **Catálogo_IAM**: Estructura de datos curada, versionada y de solo lectura que enumera los presets de permisos IAM disponibles. Única fuente de verdad compartida por el flujo de creación y el de modificación. Implementada en `src/lib/`.
- **Preset_IAM**: Entrada del Catálogo_IAM que representa un conjunto acotado de acciones IAM para un servicio AWS y un nivel de acceso concretos (por ejemplo "S3 lectura", "SQS consumidor", "DynamoDB lectura-escritura"). Cada preset tiene identificador estable, servicio, nivel de acceso, lista de acciones IAM y plantilla de ARN de recurso.
- **Nivel_De_Acceso**: Clasificación del alcance de un Preset_IAM. Valores: `read-only` (solo lectura), `read-write` (lectura-escritura), `custom-actions` (conjunto explícito de acciones concretas).
- **Servicio_AWS**: Servicio de AWS al que aplica un Preset_IAM. El Catálogo_IAM cubre dos familias:
  - **Aplicación/microservicio (14):** S3, SQS, SNS, EventBridge, DynamoDB, Secrets Manager, SSM Parameter Store, CloudWatch Logs, CloudWatch Metrics, Kinesis, Lambda, Step Functions, SES, Bedrock.
  - **Data & Analytics (≈9):** Athena, Glue (Data Catalog + jobs), Lake Formation, Kinesis Firehose, Redshift Data API, EMR, MSK/Kafka (IAM auth), SageMaker, y el datalake en S3 (cubierto por presets S3 acotados al bucket del datalake).
  - Total objetivo: al menos 22 Servicios_AWS distintos. Queda explícitamente EXCLUIDo el plano de datos de RDS (las aplicaciones conectan con usuario/contraseña de Secrets Manager, no vía IAM role — steering §19).
- **Scope_De_Recurso**: Restricción de un Preset_IAM seleccionado a uno o más ARNs de recurso concretos, en lugar del comodín de servicio completo.
- **ARN**: Amazon Resource Name que identifica un recurso AWS concreto.
- **Generador_De_Politica**: Componente determinista que transforma una selección de presets (con su Scope_De_Recurso) en HCL Terraform de mínimo privilegio, sin invocar al Infra_Agent. Implementado con plantillas TypeScript en `src/lib/`.
- **HCL**: HashiCorp Configuration Language, el lenguaje de Terraform.
- **Politica_Generada**: El bloque `aws_iam_policy` (documento de política IAM) producido por el Generador_De_Politica a partir de los presets seleccionados.
- **Validador_IAM**: Componente determinista que inspecciona una política IAM (recién generada o proporcionada como ARN de managed policy) y decide si es aceptable bajo la regla de mínimo privilegio. Extiende `src/lib/terraform-validator.ts`.
- **Politica_Admin**: Política prohibida por su amplitud: cualquier managed policy cuyo nombre termine en `FullAccess`, cualquier política `AdministratorAccess` o que contenga `Administrator`, o cualquier documento de política que conceda `Action: "*"` o `"<servicio>:*"` sobre `Resource: "*"`.
- **Formulario_Creacion**: Panel de creación de rol IAM (`src/components/infra-request-v2/iam-role-fields.tsx`).
- **Formulario_Modificacion**: Panel de modificación de rol IAM (`src/components/infra-request-v2/modify-infra-form.tsx`).
- **Infra_Agent**: Agente Bedrock (`src/lib/infra-agent.ts`) que genera HCL leyendo el repo del equipo. Se reserva como mecanismo de respaldo para casos no cubiertos por el Catálogo_IAM.
- **Patron_IRSA**: Patrón nativo de rol para microservicios en EKS: `aws_iam_role` + trust `role_templates/iskaypet_dh_access.json.tmpl` + `aws_iam_policy` scoped + `aws_iam_role_policy_attachment`.
- **Solicitud_Infra**: Registro en la tabla `infra_requests` que atraviesa el flujo `pending → approved → executing → executed`.

## Requirements

### Requirement 1: Catálogo curado de presets IAM

**User Story:** Como desarrollador que solicita un rol IAM, quiero elegir entre muchos presets de permiso de mínimo privilegio por servicio y nivel de acceso, para conceder a mi servicio exactamente lo que necesita sin permisos de administrador.

#### Acceptance Criteria

1. THE Catálogo_IAM SHALL exponer una colección de Preset_IAM donde cada Preset_IAM define un identificador único y estable (inmutable entre versiones del catálogo), un Servicio_AWS, un Nivel_De_Acceso, una lista de 1 a 50 acciones IAM sin duplicados y una plantilla de ARN de recurso no vacía.
2. THE Catálogo_IAM SHALL incluir al menos dos Preset_IAM por cada Servicio_AWS soportado, cubriendo como mínimo los niveles `read-only` y `read-write`.
3. THE Catálogo_IAM SHALL exponer al menos 40 Preset_IAM que cubran al menos 22 Servicios_AWS distintos (las dos familias definidas en el glosario: aplicación/microservicio y Data & Analytics), muy por encima de las 6 categorías de servicio actuales del Formulario_Creacion.
4. THE Catálogo_IAM SHALL declarar una versión de esquema representada como un entero monotónicamente creciente iniciado en 1.
5. WHERE un Preset_IAM tiene Nivel_De_Acceso `read-only`, THE Preset_IAM SHALL enumerar únicamente acciones IAM cuyo nivel de acceso AWS sea List o Read, y SHALL excluir toda acción de nivel Write, Permissions management o Tagging.
6. THE Catálogo_IAM SHALL ser importable tanto por el Formulario_Creacion como por el Formulario_Modificacion, exponiendo su colección como estructura inmutable que ningún consumidor puede modificar en tiempo de ejecución.
7. IF un Preset_IAM incluye una o más acciones IAM del plano de datos de RDS (acciones que otorgan autenticación o acceso a los datos de la base, como la conexión IAM a la base de datos), THEN THE Catálogo_IAM SHALL excluir ese Preset_IAM de la colección publicada.
8. WHEN el conjunto de Preset_IAM publicados o la estructura de cualquier Preset_IAM cambie, THE Catálogo_IAM SHALL incrementar el valor de la versión de esquema en al menos 1.
9. IF dos o más Preset_IAM comparten el mismo identificador o un Preset_IAM presenta una lista de acciones IAM vacía, THEN THE Catálogo_IAM SHALL excluir esos Preset_IAM de la colección publicada.

### Requirement 2: Fuente de verdad única compartida

**User Story:** Como responsable de plataforma, quiero que la creación y la modificación de roles usen el mismo catálogo de permisos, para evitar divergencias entre ambos flujos y mantener una sola definición.

#### Acceptance Criteria

1. WHEN se renderiza el Formulario_Creacion, THE Formulario_Creacion SHALL poblar sus opciones de permiso disponibles exclusivamente a partir del Catálogo_IAM.
2. WHEN se renderiza el Formulario_Modificacion, THE Formulario_Modificacion SHALL poblar sus opciones de permiso disponibles exclusivamente a partir del Catálogo_IAM, sin referenciar la lista fija `COMMON_IAM_POLICIES`.
3. THE Portal SHALL derivar del Catálogo_IAM toda lista de permisos presentada al usuario, sin listas de permisos codificadas de forma independiente en los componentes de formulario.
4. WHEN se añade, elimina o modifica un Preset_IAM en el Catálogo_IAM, THE Portal SHALL presentar el conjunto de opciones actualizado en el Formulario_Creacion y en el Formulario_Modificacion sin cambios de código en dichos componentes.
5. THE Portal SHALL presentar en el Formulario_Creacion y en el Formulario_Modificacion un conjunto de opciones de permiso idéntico en contenido y orden, derivado del mismo Catálogo_IAM.
6. IF la lectura del Catálogo_IAM falla o devuelve una colección vacía, THEN THE Portal SHALL mostrar en el formulario afectado un mensaje de error indicando que las opciones de permiso no están disponibles, impedir el envío del formulario y no recurrir a ninguna lista de permisos codificada.

### Requirement 3: Scoping a recursos concretos (ARNs)

**User Story:** Como desarrollador, quiero acotar cada permiso a los ARNs concretos que mi servicio usa, para no conceder acceso a todos los recursos de un servicio.

#### Acceptance Criteria

1. WHERE un Preset_IAM seleccionado admite Scope_De_Recurso, THE Formulario_Creacion SHALL permitir al usuario introducir entre 1 y 50 ARNs de recurso destino para ese preset, cada uno con una longitud de 1 a 2048 caracteres.
2. WHEN el usuario proporciona un Scope_De_Recurso válido para un Preset_IAM, THE Generador_De_Politica SHALL emitir el campo `Resource` de la Politica_Generada con exactamente esos ARNs, sin duplicados y en un orden determinista reproducible entre generaciones sobre la misma entrada.
3. IF un ARN introducido para el Scope_De_Recurso no cumple el formato `arn:aws:<servicio>:<region>:<cuenta>:<recurso>` con segmentos válidos (servicio no vacío; region y cuenta pueden ir vacías para servicios globales como S3; cuenta de 12 dígitos cuando exista; recurso no vacío), THEN THE Portal SHALL rechazar la entrada, conservar los demás ARNs introducidos, no generar la Politica_Generada y mostrar un mensaje de validación que identifique el ARN rechazado y el motivo del rechazo.
4. WHERE un Preset_IAM seleccionado no recibe ningún Scope_De_Recurso, o todos los ARNs introducidos están en blanco o contienen solo espacios, THE Generador_De_Politica SHALL tratar la entrada como ausencia de Scope_De_Recurso y aplicar la plantilla de ARN por defecto definida en el preset.
5. IF un Scope_De_Recurso incluye un ARN de un servicio distinto al Servicio_AWS del Preset_IAM, THEN THE Portal SHALL rechazar la entrada, conservar los demás ARNs introducidos, no generar la Politica_Generada y mostrar un mensaje de validación que identifique el ARN rechazado y el motivo del rechazo.
6. WHERE el Preset_IAM seleccionado permite comodines en el Scope_De_Recurso, THE Portal SHALL aceptar ARNs que contengan los comodines permitidos por el preset como entrada válida.
7. IF el usuario introduce más de 50 ARNs en el Scope_De_Recurso, THEN THE Portal SHALL rechazar la entrada, conservar los ARNs dentro del límite, no generar la Politica_Generada y mostrar un mensaje de validación que indique que se ha excedido el límite máximo de 50 ARNs.

### Requirement 4: Generación determinista de la política

**User Story:** Como responsable de plataforma, quiero que la política Terraform se genere de forma determinista a partir de los presets seleccionados, para obtener resultados reproducibles y sin alucinaciones del modelo.

#### Acceptance Criteria

1. WHEN el usuario confirma una selección de Preset_IAM cubierta por el Catálogo_IAM, THE Generador_De_Politica SHALL producir el HCL del rol sin invocar al Infra_Agent.
2. WHEN el Generador_De_Politica recibe la misma selección de Preset_IAM y el mismo Scope_De_Recurso, THE Generador_De_Politica SHALL producir HCL idéntico byte a byte, con independencia del orden de entrada de los Preset_IAM y de los ARNs y con independencia del proceso o ejecución que lo genere, emitiendo las acciones IAM y los ARNs en un orden determinista.
3. THE Generador_De_Politica SHALL producir HCL que siga el Patron_IRSA (`aws_iam_role` + trust `role_templates/iskaypet_dh_access.json.tmpl` + `aws_iam_policy` scoped + `aws_iam_role_policy_attachment`).
4. THE Politica_Generada SHALL contener únicamente las acciones IAM declaradas por los Preset_IAM seleccionados.
5. IF la solicitud contiene un requisito de permiso no representable por ningún Preset_IAM del Catálogo_IAM, THEN THE Portal SHALL delegar la generación de ese caso en el Infra_Agent.
6. WHEN el Generador_De_Politica genera HCL para un subconjunto propio de los entornos disponibles, THE Generador_De_Politica SHALL incluir en cada recurso condicionado la expresión exacta `count = contains([<entornos_destino>], var.environment) ? 1 : 0`.
7. THE Generador_De_Politica SHALL producir HCL que supere `validateHclSyntax` de `src/lib/terraform-validator.ts`.
8. WHEN el Generador_De_Politica genera HCL y los entornos destino son todos los entornos disponibles, THE Generador_De_Politica SHALL omitir la expresión `count` en los recursos generados.
9. IF la selección referencia un identificador de Preset_IAM inexistente en el Catálogo_IAM, THEN THE Generador_De_Politica SHALL abortar la generación sin producir HCL y devolver un error que identifique el identificador inexistente.

### Requirement 5: Validador duro anti-admin

**User Story:** Como responsable de seguridad de plataforma, quiero que el sistema bloquee de forma determinista cualquier política de administrador, para que ningún rol self-service pueda conceder permisos amplios aunque el prompt del agente falle.

#### Acceptance Criteria

1. WHEN el Validador_IAM inspecciona una Politica_Generada o un ARN de managed policy, THE Validador_IAM SHALL emitir un veredicto que sea exactamente uno de {aceptable, Politica_Admin}.
2. IF la entrada al Validador_IAM está vacía o malformada, o el ARN de managed policy es inválido, THEN THE Validador_IAM SHALL emitir el veredicto Politica_Admin por defecto (default-deny) sin lanzar excepciones.
3. IF una política obtiene el veredicto Politica_Admin, THEN THE Validador_IAM SHALL rechazarla y devolver un error que identifique la regla concreta que disparó el rechazo.
4. IF el segmento del nombre de una managed policy situado tras la última `/` termina en `FullAccess` mediante comparación insensible a mayúsculas y minúsculas, THEN THE Validador_IAM SHALL emitir el veredicto Politica_Admin.
5. IF el segmento del nombre de una política situado tras la última `/` contiene `Administrator` mediante comparación insensible a mayúsculas y minúsculas, THEN THE Validador_IAM SHALL emitir el veredicto Politica_Admin.
6. IF un `Statement` de un documento de política tiene `Effect: Allow` y concede `Action` con valor `"*"` o `"<servicio>:*"` sobre `Resource` con valor `"*"`, contemplando `Action` y `Resource` tanto cuando son una cadena como cuando son un elemento de una lista, THEN THE Validador_IAM SHALL emitir el veredicto Politica_Admin.
7. WHEN se ejecuta una Solicitud_Infra de creación de rol IAM, THE Portal SHALL invocar al Validador_IAM sobre la política resultante antes de crear el branch y el MR.
8. WHEN se ejecuta una Solicitud_Infra de modificación de rol IAM que añade permisos, THE Portal SHALL invocar al Validador_IAM sobre cada permiso añadido antes de crear el branch y el MR.
9. IF el Validador_IAM emite el veredicto Politica_Admin durante la ejecución, THEN THE Portal SHALL detener la ejecución, marcar la Solicitud_Infra como `execute_failed` indicando la regla concreta que disparó el rechazo, y no crear el branch, el MR ni el ticket Jira.

### Requirement 6: Modificación de roles con el catálogo de presets

**User Story:** Como desarrollador, quiero añadir o quitar permisos de un rol existente usando el mismo catálogo de presets de mínimo privilegio, para modificar roles con la misma granularidad y las mismas garantías que al crearlos.

#### Acceptance Criteria

1. THE Formulario_Modificacion SHALL presentar los permisos disponibles como Preset_IAM del Catálogo_IAM, usando el Catálogo_IAM como única fuente de presets y reemplazando por completo la lista COMMON_IAM_POLICIES.
2. WHEN el usuario abre el Formulario_Modificacion para un rol existente, THE Formulario_Modificacion SHALL presentar los permisos actualmente concedidos al rol como una lista de elementos seleccionables para quitar.
3. WHEN el usuario selecciona un Preset_IAM para añadir, THE Formulario_Modificacion SHALL permitir asociar cero o más ARNs de Scope_De_Recurso a ese preset conforme al Requirement 3.
4. WHEN el usuario añade un permiso mediante un ARN de managed policy personalizado, THE Portal SHALL someter ese ARN al Validador_IAM antes de aceptarlo.
5. IF el Validador_IAM clasifica el ARN de managed policy personalizado como Politica_Admin, THEN THE Portal SHALL rechazar únicamente ese ARN, mostrar el motivo del rechazo y conservar el resto de la selección del usuario sin modificar.
6. WHEN el usuario confirma una modificación que añade permisos cubierta por el Catálogo_IAM, THE Generador_De_Politica SHALL producir de forma determinista el HCL de la modificación sin invocar al Infra_Agent.
7. WHEN el usuario confirma una modificación que quita permisos, THE Generador_De_Politica SHALL producir de forma determinista un HCL que omita exactamente los permisos seleccionados para quitar y conserve sin cambios los permisos no seleccionados.
8. IF una modificación solicita permisos de datos sobre el servicio RDS, THEN THE Portal SHALL rechazar la modificación, no crear branch ni MR, y mostrar el motivo del rechazo.

### Requirement 7: Compatibilidad con el flujo de aprobación y ejecución existente

**User Story:** Como responsable de plataforma, quiero que las mejoras de permisos IAM funcionen dentro del flujo actual de aprobación y ejecución, para no romper la trazabilidad ni el control por equipo.

#### Acceptance Criteria

1. THE Portal SHALL gestionar cada Solicitud_Infra de rol IAM mediante los estados `pending`, `approved`, `executing`, `executed`, `rejected`, `cancelled` y `execute_failed`, aplicando el flujo nominal `pending → approved → executing → executed`.
2. WHEN un aprobador aprueba y ejecuta una Solicitud_Infra de rol IAM que se encuentra en estado `approved`, THE Portal SHALL crear un branch `feat/SRE-<id>`, abrir un MR asociado y crear un ticket Jira (auto-Done), reutilizando el flujo de ejecución existente.
3. THE Portal SHALL mantener el nombre de rol, el namespace y los entornos destino como campos obligatorios de la Solicitud_Infra de rol IAM.
4. WHERE el equipo destino es `Tooling`, THE Formulario_Creacion SHALL fijar el campo entorno destino al valor `tooling` y presentarlo como no editable por el solicitante.
5. WHEN un aprobador aprueba y ejecuta una Solicitud_Infra de rol IAM en estado `approved`, THE Portal SHALL reclamar la fila mediante una transición atómica `approved → executing` condicionada al estado actual, de modo que un segundo intento concurrente no inicie una segunda ejecución.
6. IF el solicitante y el aprobador de una Solicitud_Infra de rol IAM son la misma persona (comparando el correo normalizado por dominio), THEN THE Portal SHALL rechazar la aprobación devolviendo un error de autorización e indicando que el self-approval no está permitido, y SHALL conservar la solicitud en estado `pending`.
7. IF la creación del branch, del MR o del ticket Jira falla durante la ejecución de una Solicitud_Infra de rol IAM, THEN THE Portal SHALL revertir el branch creado, transicionar la solicitud a estado `execute_failed` e indicar el fallo al solicitante.
