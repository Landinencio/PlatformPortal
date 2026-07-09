# Requirements Document

## Introduction

El Portal de Plataforma genera código Terraform para nuevas instancias RDS a través del
flujo self-service de infraestructura (`/infra-requests`, modo v2). En un incidente real
(creación de `marketplace-payments-api-db`) el portal generó un fichero `.tf`
**autocontenido y desactualizado**: módulo `terraform-aws-modules/rds/aws` `6.6.0`,
`engine_version = "16"`, `family = "postgres16"` y valores literales incrustados en el `.tf`.

El repositorio destino (`iskaypetcom/digital/platform-engineering/aws/oms`, directorio
`iac/databases/`) había migrado entretanto a una **convención parametrizada**: la versión
de motor (`engine_version`), la familia (`family`), `major_engine_version`,
`allow_major_version_upgrade` y `apply_immediately` se gobiernan mediante **variables**
declaradas en `iac/databases/variables.tf` y se fijan por entorno en
`iac/databases/vars/{dev,uat,pro}.tfvars`. El estándar actual para bases de datos
PostgreSQL nuevas es **PostgreSQL 18 (familia `postgres18`)**. Por **decisión
organizativa, las RDS nuevas solo pueden usar PostgreSQL**: MySQL no es un motor
seleccionable y el Generador_RDS lo rechaza. El fichero generado no seguía esa convención y tuvo que
reescribirse a mano, dejando una Merge_Request inconsistente respecto al patrón del repo.

Esta feature mejora cómo el Portal genera el Terraform de RDS y el formulario de solicitud
asociado, para que el resultado coincida con las convenciones vigentes del repositorio
destino (parametrización vía variables + tfvars por entorno), aplique los valores estándar
de versión por motor, exponga la selección de motor y versión en el formulario, preserve la
rotación obligatoria de contraseña master y mantenga las validaciones existentes.

El alcance se limita al flujo de creación/generación de RDS y su formulario en el portal
(`platformportal`). Queda **fuera de alcance** cambiar las convenciones del repositorio
`oms` y los tipos de recurso no-RDS (S3/IAM), salvo donde el formulario comparta estructura.

## Glossary

- **Portal**: La aplicación Platform Portal (`platformportal`, Next.js), que ofrece el flujo
  self-service de infraestructura.
- **Generador_RDS**: El conjunto de componentes del Portal que produce el Terraform de una
  RDS nueva: el constructor de prompt (`buildRdsPrompt` en `src/lib/infra-prompt-builder.ts`)
  y el agente de IA (`InfraAgent` con su `SYSTEM_PROMPT` en `src/lib/infra-agent.ts`).
- **Formulario_RDS**: El panel de campos de RDS del formulario v2
  (`src/components/infra-request-v2/rds-fields.tsx`) y su contenedor
  (`infra-request-form-v2.tsx`).
- **Validador_RDS**: La función `validateRdsPasswordRotation` y la validación de sintaxis HCL
  en `src/lib/terraform-validator.ts`, invocadas en el endpoint de ejecución
  (`src/app/api/infra-assistant/execute/[id]/route.ts`).
- **Repositorio_Destino**: El repositorio Terraform del equipo donde se crea la RDS
  (para Digital es `iskaypetcom/digital/platform-engineering/aws/oms`), directorio
  `iac/databases/`.
- **Convención_Parametrizada**: El patrón vigente del Repositorio_Destino en el que
  `engine_version`, `family`, `major_engine_version`, `allow_major_version_upgrade` y
  `apply_immediately` se definen como variables en `iac/databases/variables.tf` y se asignan
  por entorno en `iac/databases/vars/{dev,uat,pro}.tfvars`, en lugar de literales en el `.tf`.
- **Fichero_Variables**: El fichero `iac/databases/variables.tf` del Repositorio_Destino que
  declara las variables de motor/versión/flags.
- **Fichero_Tfvars**: Cada uno de los ficheros de valores por entorno
  `iac/databases/vars/dev.tfvars`, `iac/databases/vars/uat.tfvars` y
  `iac/databases/vars/pro.tfvars`.
- **Motor**: El motor de base de datos solicitado. Único valor soportado: `postgres`. Por decisión organizativa `mysql` NO es seleccionable para RDS nuevas.
- **Version_Motor**: La versión mayor del Motor (p.ej. `18` para PostgreSQL).
- **Familia**: El parameter group family asociado a la Version_Motor (p.ej. `postgres18`).
- **Version_Estandar**: El valor por defecto de Version_Motor por Motor: PostgreSQL `18`
  (Familia `postgres18`).
- **Catalogo_Versiones**: El conjunto de pares (Version_Motor, Familia) permitidos por Motor
  que el Portal ofrece y acepta.
- **Bloque_Rotacion**: Los cuatro atributos obligatorios del módulo RDS:
  `manage_master_user_password = true`, `manage_master_user_password_rotation = true`,
  `master_user_password_rotate_immediately = false` y
  `master_user_password_rotation_schedule_expression = "rate(15 days)"`.
- **Entornos_Destino**: El subconjunto de entornos (`dev`, `uat`, `prod`) seleccionado por el
  solicitante para la RDS. Nota: el entorno `prod` del Portal se corresponde con el
  Fichero_Tfvars `pro.tfvars` del Repositorio_Destino.
- **Version_Modulo**: La versión del módulo `terraform-aws-modules/rds/aws` usada en el `.tf`
  generado.
- **Preview_Terraform**: El objeto `TerraformPreview` (filePath, content, resourceType,
  resourceName, targetEnvironments) que produce el Generador_RDS y que se persiste y ejecuta.

## Requirements

### Requirement 1: Selección de motor de base de datos

**User Story:** Como solicitante de infraestructura, quiero que el motor de base de datos
sea siempre PostgreSQL, para que el portal genere la RDS con el motor estándar aprobado por
la organización (MySQL no está permitido para RDS nuevas).

#### Acceptance Criteria

1. THE Formulario_RDS SHALL presentar un selector de Motor que ofrezca exactamente una opción seleccionable, `postgres`, sin permitir la selección de ningún valor fuera de ese conjunto (en particular, NO debe ofrecer `mysql`).
2. WHEN el Formulario_RDS se carga y el solicitante aún no ha seleccionado un Motor, THE Formulario_RDS SHALL establecer `postgres` como Motor seleccionado por defecto.
3. WHEN el solicitante cambia el Motor, THE Formulario_RDS SHALL reemplazar el Catalogo_Versiones ofrecido por el conjunto de pares (version, family) válidos para el Motor seleccionado, mostrando únicamente esos pares y ninguno de otro Motor.
4. WHEN el solicitante cambia el Motor y la version seleccionada previamente no pertenece al Catalogo_Versiones del nuevo Motor, THE Formulario_RDS SHALL descartar la version seleccionada y requerir una nueva selección de version antes de permitir el envío.
5. IF el Motor recibido por el Generador_RDS no pertenece al conjunto {`postgres`}, THEN THE Generador_RDS SHALL rechazar la solicitud sin generar ninguna RDS y devolver un mensaje de error que identifique el Motor inválido recibido (incluido `mysql`) y enumere los valores admitidos.
6. WHEN el Generador_RDS produce un Preview_Terraform, THE Preview_Terraform SHALL incluir en sus metadatos el Motor seleccionado.

### Requirement 2: Selección y valores por defecto de versión de motor

**User Story:** Como solicitante de infraestructura, quiero seleccionar la versión del motor
desde un conjunto vigente con un valor por defecto estándar, para que las bases de datos
nuevas usen la versión recomendada por la organización.

#### Acceptance Criteria

1. WHEN el solicitante selecciona un Motor, THE Formulario_RDS SHALL ofrecer como Version_Motor exclusivamente las versiones del Catalogo_Versiones correspondiente a ese Motor.
2. WHERE el Motor es `postgres`, THE Formulario_RDS SHALL preseleccionar, antes de cualquier interacción del solicitante con el selector, la Version_Motor `18` con Familia `postgres18` como Version_Estandar.
3. WHERE el Motor es `postgres`, THE Formulario_RDS SHALL ofrecer únicamente versiones de PostgreSQL del Catalogo_Versiones; THE Catalogo_Versiones NO SHALL contener ninguna versión de MySQL.
4. WHEN el Generador_RDS produce el Preview_Terraform, THE Generador_RDS SHALL derivar la Familia usando exactamente la correspondencia Version_Motor→Familia definida en el Catalogo_Versiones.
5. IF la Version_Motor recibida por el Generador_RDS no pertenece al Catalogo_Versiones del Motor, THEN THE Generador_RDS SHALL rechazar la solicitud sin producir Preview_Terraform y devolver un mensaje de error que identifique la versión inválida y el Motor recibido.
6. IF el Catalogo_Versiones del Motor seleccionado está vacío, THEN THE Formulario_RDS SHALL deshabilitar el envío de la solicitud y mostrar un mensaje de error indicando que no hay versiones disponibles para ese Motor.
7. THE Formulario_RDS SHALL mostrar el Motor y la Version_Motor seleccionados de forma continua en todo momento previo al envío de la solicitud.

### Requirement 3: Generación parametrizada acorde al repositorio destino

**User Story:** Como ingeniero de plataforma, quiero que el portal genere el Terraform de RDS
siguiendo la Convención_Parametrizada del repositorio destino, para que la Merge_Request sea
consistente con el patrón establecido y `terraform plan` no produzca ruido.

#### Acceptance Criteria

1. WHEN el Generador_RDS produce el `.tf` de una RDS nueva, THE Generador_RDS SHALL referenciar `engine_version`, `family`, `major_engine_version`, `allow_major_version_upgrade` y `apply_immediately` mediante referencias a variables Terraform (cero literales para esos cinco atributos), nombradas con el prefijo por base de datos `<db>_` (p. ej. `<db>_rds_version`, `<db>_family`, `<db>_allow_major_version_upgrade`, `<db>_apply_immediately`).
2. WHEN el Generador_RDS produce el Preview_Terraform, THE Generador_RDS SHALL incluir en el Fichero_Variables la declaración de cada variable de motor/versión/flags referenciada que no exista ya en el Repositorio_Destino, manteniendo el prefijo `<db>_`.
3. WHEN el Generador_RDS produce el Preview_Terraform, THE Generador_RDS SHALL añadir en cada uno de los tres Fichero_Tfvars una entrada por cada variable de motor/versión/flags con el valor para ese entorno, de forma que tras la generación las variables existan en los tres ficheros.
4. WHEN el Generador_RDS va a generar el `.tf`, THE Generador_RDS SHALL leer previamente la estructura de `iac/databases/` del Repositorio_Destino para reproducir la Convención_Parametrizada vigente.
5. IF el directorio `iac/databases/` no existe o no puede leerse, THEN THE Generador_RDS SHALL abortar la generación sin producir Preview_Terraform y devolver un error indicando que no se pudo determinar la Convención_Parametrizada.
6. IF el `.tf` generado contiene un valor literal en lugar de referencia a variable para `engine_version`, `family`, `major_engine_version`, `allow_major_version_upgrade` o `apply_immediately`, THEN THE Generador_RDS SHALL bloquear la emisión del Preview_Terraform y regenerar usando la referencia a variable.

### Requirement 4: Alineación de la versión del módulo RDS

**User Story:** Como ingeniero de plataforma, quiero que el portal use la versión del módulo
RDS que el repositorio destino emplea actualmente, para no introducir versiones obsoletas en
las Merge_Requests.

#### Acceptance Criteria

1. WHEN el Generador_RDS produce el `.tf` de una RDS nueva, THE Generador_RDS SHALL fijar una Version_Modulo exacta (sin rangos ni operadores de versión) idéntica a la Version_Modulo empleada en los ficheros existentes de `iac/databases/` del Repositorio_Destino.
2. WHEN el Generador_RDS va a generar el `.tf`, THE Generador_RDS SHALL leer la Version_Modulo del fichero de referencia, entendido como el atributo `version` de un bloque `module` cuyo `source` es `terraform-aws-modules/rds/aws` dentro de un fichero `.tf` de `iac/databases/`.
3. IF en el Repositorio_Destino existen varias Version_Modulo distintas entre los bloques `module` con `source` `terraform-aws-modules/rds/aws`, THEN THE Generador_RDS SHALL seleccionar la Version_Modulo más frecuente y, en caso de empate, la mayor según orden semver.
4. IF no se encuentra ningún bloque `module` con `source` `terraform-aws-modules/rds/aws` y atributo `version` en el Repositorio_Destino, THEN THE Generador_RDS SHALL registrar la incidencia y usar la Version_Modulo estándar configurada del Portal.
5. IF falla la lectura del Repositorio_Destino, THEN THE Generador_RDS SHALL usar la Version_Modulo estándar configurada del Portal sin interrumpir la generación y registrar la incidencia.

### Requirement 5: Preservación de la rotación obligatoria de contraseña master

**User Story:** Como responsable de seguridad, quiero que toda RDS generada incluya la
rotación obligatoria de contraseña master, para mantener el estándar de seguridad de IskayPet.

#### Acceptance Criteria

1. WHEN el Generador_RDS produce el `.tf` de una RDS, THE Generador_RDS SHALL incluir en el bloque `module` los cuatro atributos del Bloque_Rotacion con sus valores exactos: `manage_master_user_password = true`, `manage_master_user_password_rotation = true`, `master_user_password_rotate_immediately = false` y `master_user_password_rotation_schedule_expression = "rate(15 days)"`.
2. WHEN el Validador_RDS evalúa un `.tf` de RDS durante la ejecución, THE Validador_RDS SHALL verificar la presencia y el valor exacto de los cuatro atributos del Bloque_Rotacion.
3. IF el `.tf` omite uno o más de los cuatro atributos del Bloque_Rotacion o alguno presenta un valor distinto, THEN THE Validador_RDS SHALL rechazar la ejecución con código 422, preservar el repositorio sin cambios (sin rama, commit ni MR) e incluir un mensaje que liste cada atributo ausente o con valor incorrecto.
4. WHEN el Generador_RDS produce el `.tf`, THE Generador_RDS SHALL omitir todo atributo `password` en texto plano (cero ocurrencias de `password` con valor literal).

### Requirement 6: Generación consistente multi-entorno con tfvars

**User Story:** Como ingeniero de plataforma, quiero que las variables requeridas estén
presentes en los tres tfvars aunque la base de datos se limite a algunos entornos, para
evitar errores de `terraform plan` por variables sin valor.

#### Acceptance Criteria

1. WHEN el Generador_RDS añade una variable de motor/versión/flags, THE Generador_RDS SHALL escribir esa variable con un valor no vacío y válido para su tipo en cada Fichero_Tfvars (`dev.tfvars`, `uat.tfvars`, `pro.tfvars`), independientemente de los Entornos_Destino seleccionados.
2. WHEN el Generador_RDS produce el Preview_Terraform, THE Generador_RDS SHALL garantizar que ninguna variable de motor/versión/flags queda sin valor en ninguno de los tres Fichero_Tfvars, de forma que `terraform plan` no falle por variables sin asignar.
3. WHERE los Entornos_Destino no incluyen los tres entornos (`dev`, `uat`, `prod`), THE Generador_RDS SHALL limitar la creación del recurso RDS a los Entornos_Destino seleccionados mediante el patrón condicional vigente del Repositorio_Destino (`count = contains([...envs], var.environment) ? 1 : 0`), preservando los valores de las variables en los entornos no seleccionados.
4. WHEN el solicitante selecciona el entorno `prod` en los Entornos_Destino, THE Generador_RDS SHALL aplicar el valor correspondiente en el Fichero_Tfvars `pro.tfvars`.
5. IF los Entornos_Destino están vacíos, THEN THE Formulario_RDS SHALL impedir el envío de la solicitud y mostrar un mensaje solicitando al menos un entorno.
6. IF alguna variable de motor/versión/flags quedaría sin valor en alguno de los tres Fichero_Tfvars, THEN THE Generador_RDS SHALL abortar la generación sin modificar el Repositorio_Destino y devolver un error que identifique la variable y el Fichero_Tfvars afectados.

### Requirement 7: Coherencia entre el formulario y el código generado

**User Story:** Como solicitante de infraestructura, quiero que los campos que elijo en el
formulario se reflejen exactamente en el Terraform generado, para que el resultado sea
predecible y sin sorpresas.

#### Acceptance Criteria

1. WHEN el Formulario_RDS envía una solicitud, THE Formulario_RDS SHALL transmitir al Generador_RDS el Motor, la Version_Motor y los Entornos_Destino seleccionados sin omitir ninguno de los tres campos.
2. THE Generador_RDS SHALL usar exactamente los valores de Motor, Version_Motor y Entornos_Destino recibidos del Formulario_RDS al construir el Preview_Terraform, sin sustituirlos por valores por defecto.
3. THE Generador_RDS SHALL generar el `.tf` con la Familia derivada del Catalogo_Versiones para la Version_Motor de PostgreSQL seleccionada, de forma que la Familia empiece por `postgres`.
4. THE Formulario_RDS SHALL etiquetar el tipo de recurso con un texto que contenga la cadena "PostgreSQL" y que NO ofrezca MySQL como motor.
5. IF el Motor, la Version_Motor o la Familia del Preview_Terraform no coinciden con los seleccionados en el Formulario_RDS, THEN THE Generador_RDS SHALL rechazar la generación con un mensaje que identifique el campo discrepante y no persistir el Preview_Terraform.
