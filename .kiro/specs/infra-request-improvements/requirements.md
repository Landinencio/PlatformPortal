# Documento de Requisitos

## Introducción

Este documento define los requisitos para seis mejoras al flujo existente de solicitudes de infraestructura en el Portal de Plataforma. La funcionalidad de infra-request permite a los desarrolladores solicitar recursos AWS (S3, RDS, IAM Roles) mediante un formulario, que genera código Terraform, pasa por un flujo de aprobación, y crea un Merge Request en GitLab tras la ejecución. Estas mejoras abordan carencias de UX, fiabilidad y visibilidad operativa.

## Glosario

- **Portal**: La aplicación Next.js del Portal de Plataforma
- **Infra_Request**: Un registro en la tabla `infra_requests` que representa la solicitud de un desarrollador para recursos de infraestructura
- **Solicitante**: El usuario autenticado que envía una solicitud de infraestructura
- **Aprobador**: Un usuario con permisos de aprobación definidos en la configuración de infra-approvers
- **Execute_Handler**: El endpoint API en `/api/infra-assistant/execute/[id]` que commitea Terraform a GitLab y crea un Merge Request
- **Pantalla_Exito**: La UI mostrada al Solicitante tras enviar exitosamente una Infra_Request
- **Dashboard_Solicitudes**: La página en `/infra-requests` que lista las solicitudes de infraestructura
- **Pagina_Creacion**: La página en `/create-infra` que contiene el formulario de solicitud de infraestructura
- **Reminder_CronJob**: Un job programado que verifica solicitudes pendientes estancadas y reenvía notificaciones
- **Terraform_Content**: El código HCL generado por el asistente de IA y commiteado a GitLab

## Requisitos

### Requisito 1: Pantalla de Éxito Mejorada

**Historia de Usuario:** Como Solicitante, quiero ver un resumen de mi solicitud enviada y una línea de tiempo visual de los próximos pasos, para entender qué se solicitó y qué sucede después.

#### Criterios de Aceptación

1. WHEN una Infra_Request se envía exitosamente, THE Pantalla_Exito SHALL mostrar un resumen incluyendo el tipo de recurso, nombre del recurso, equipo, aprobador seleccionado y coste estimado (si está disponible)
2. WHEN una Infra_Request se envía exitosamente, THE Pantalla_Exito SHALL mostrar una línea de tiempo visual con las etapas: Pendiente → Aprobación → Ejecución → MR Creado
3. THE Pantalla_Exito SHALL resaltar la etapa actual (Pendiente) como activa en la línea de tiempo
4. THE Pantalla_Exito SHALL mantener los botones de acción existentes "Ver solicitudes" y "Nueva solicitud"

### Requisito 2: Cancelación de Solicitudes

**Historia de Usuario:** Como Solicitante, quiero cancelar mi solicitud de infraestructura pendiente, para poder retirar solicitudes que ya no son necesarias sin esperar a que un aprobador las rechace.

#### Criterios de Aceptación

1. WHILE una Infra_Request tiene status "pending", THE Dashboard_Solicitudes SHALL mostrar un botón "Cancelar" para las solicitudes del Solicitante actual
2. WHEN el Solicitante hace clic en el botón "Cancelar", THE Portal SHALL solicitar confirmación antes de proceder
3. WHEN se confirma la cancelación, THE Portal SHALL enviar una petición POST a `/api/infra-requests/[id]/cancel`
4. WHEN el endpoint de cancelación recibe una petición válida, THE endpoint SHALL verificar que el usuario autenticado coincide con el Solicitante de la Infra_Request
5. WHEN el endpoint de cancelación recibe una petición válida, THE endpoint SHALL verificar que el status de la Infra_Request es "pending"
6. IF el status de la Infra_Request no es "pending", THEN THE endpoint de cancelación SHALL devolver HTTP 409 con un mensaje de error
7. IF el usuario autenticado no es el Solicitante de la Infra_Request, THEN THE endpoint de cancelación SHALL devolver HTTP 403
8. WHEN la cancelación tiene éxito, THE endpoint de cancelación SHALL actualizar el status de la Infra_Request a "cancelled"
9. WHEN la cancelación tiene éxito, THE endpoint de cancelación SHALL notificar al Aprobador asignado mediante el sistema de notificaciones que la solicitud fue cancelada

### Requisito 3: Recordatorio Automático de 24 Horas

**Historia de Usuario:** Como Solicitante, quiero que se recuerde a los aprobadores sobre mi solicitud pendiente después de 24 horas, para que las solicitudes no queden olvidadas.

#### Criterios de Aceptación

1. THE Reminder_CronJob SHALL ejecutarse cada hora
2. WHEN el Reminder_CronJob se ejecuta, THE Reminder_CronJob SHALL consultar las Infra_Requests con status "pending" y `created_at` anterior a 24 horas que no hayan recibido ya un recordatorio
3. FOR EACH Infra_Request pendiente estancada encontrada, THE Reminder_CronJob SHALL enviar una notificación al Aprobador usando el sistema de notificaciones existente
4. FOR EACH Infra_Request pendiente estancada encontrada, THE Reminder_CronJob SHALL registrar que se envió un recordatorio para prevenir recordatorios duplicados en ejecuciones posteriores
5. THE Reminder_CronJob SHALL ser desplegable como un Kubernetes CronJob con schedule `0 * * * *`
6. IF el Reminder_CronJob encuentra un error de base de datos, THEN THE Reminder_CronJob SHALL registrar el error en log y salir con un código distinto de cero

### Requisito 4: Historial de Solicitudes en la Página de Creación

**Historia de Usuario:** Como Solicitante, quiero ver mis solicitudes de infraestructura recientes en la página de creación, para poder consultar mi actividad reciente sin navegar a otra página.

#### Criterios de Aceptación

1. WHEN la Pagina_Creacion se carga, THE Pagina_Creacion SHALL obtener las 5 Infra_Requests más recientes del Solicitante
2. THE Pagina_Creacion SHALL mostrar las solicitudes recientes debajo del formulario, mostrando: tipo de recurso, equipo, status y fecha de creación para cada solicitud
3. WHEN se hace clic en una solicitud de la lista del historial, THE Portal SHALL navegar al Dashboard_Solicitudes
4. IF el Solicitante no tiene solicitudes previas, THEN THE Pagina_Creacion SHALL no renderizar la sección de historial

### Requisito 5: Validación de Terraform Antes del Commit

**Historia de Usuario:** Como Solicitante, quiero que el Terraform generado sea validado antes de commitearse a GitLab, para que HCL inválido no produzca Merge Requests rotos.

#### Criterios de Aceptación

1. WHEN el Execute_Handler va a commitear Terraform_Content a GitLab, THE Execute_Handler SHALL validar la sintaxis del Terraform_Content antes de crear la rama
2. THE Execute_Handler SHALL validar usando `terraform fmt -check` o una verificación de sintaxis HCL equivalente
3. IF el Terraform_Content falla la validación, THEN THE Execute_Handler SHALL actualizar el status de la Infra_Request a "execute_failed"
4. IF el Terraform_Content falla la validación, THEN THE Execute_Handler SHALL notificar al Solicitante con un mensaje indicando que la sintaxis de Terraform era inválida
5. IF el Terraform_Content falla la validación, THEN THE Execute_Handler SHALL no crear una rama ni commitear ningún archivo a GitLab
6. WHEN el Terraform_Content pasa la validación, THE Execute_Handler SHALL proceder con el flujo de ejecución normal (creación de rama, commit de archivo, creación de MR)

### Requisito 6: Ejecución Idempotente

**Historia de Usuario:** Como operador de plataforma, quiero que el endpoint de ejecución sea idempotente, para que llamadas duplicadas (por reintentos o condiciones de carrera) no creen ramas o Merge Requests duplicados.

#### Criterios de Aceptación

1. WHEN el Execute_Handler recibe una petición para una Infra_Request con status "executed", THE Execute_Handler SHALL devolver HTTP 200 con un mensaje indicando que ya fue ejecutada, sin realizar ningún efecto secundario
2. WHEN el Execute_Handler recibe una petición para una Infra_Request con status "execute_failed", THE Execute_Handler SHALL devolver HTTP 200 con un mensaje indicando el fallo previo, sin re-ejecutar
3. THE Execute_Handler SHALL realizar la verificación de idempotencia antes de cualquier creación de rama, operación de archivos o llamadas a APIs externas
4. THE Execute_Handler SHALL usar la columna `status` (no solo `executed_at`) como guarda de idempotencia para cubrir tanto el estado "executed" como "execute_failed"
