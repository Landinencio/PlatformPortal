# Requirements Document

## Introduction

Esta feature entrega una notificación a un canal de Teams **dedicado** cada vez que se produce un deploy a producción en GitLab (org-wide, grupo `iskaypetcom`). El intento previo con ArgoCD notifications generaba demasiado ruido, por lo que la solución reutiliza la infraestructura ya existente del portal: el receptor de webhooks de GitLab (`/api/webhooks/gitlab`) que ya procesa eventos `pipeline` y detecta jobs de deploy a prod (hoy log-only), y el helper de tarjetas de Teams (`src/lib/teams-notify.ts`).

La lógica nueva vive en un módulo puro y testeable (`src/lib/deploy-notify.ts`), enganchado con una llamada mínima en `processPipeline()`. La notificación se emite **exclusivamente desde `portal-prod`**, gobernada por un gate de entorno, con deduplicación atómica en base de datos como segunda capa. El mensaje es una Adaptive Card con la máxima información del deploy (microservicio, entorno, timestamp, ref, commit, autor, MR, pipeline) y botones de acción a GitLab.

Las explicaciones se redactan en español; los identificadores, nombres de funciones, variables de entorno y código en inglés.

## Glossary

- **Deploy_Notifier**: el módulo `src/lib/deploy-notify.ts`, responsable de detectar deploys a prod, deduplicar, enriquecer y enviar la notificación. Función orquestadora `notifyProdDeploy`.
- **Prod_Deploy_Detector**: función pura `detectProdDeploy(payload)` que determina si un evento `pipeline` representa un deploy a producción exitoso.
- **Deploy_Info_Builder**: función `buildDeployInfo(payload, client)` que enriquece el payload con datos de MR y commit (best-effort).
- **Deploy_Card_Builder**: función pura `buildDeployCard(info)` que construye la Adaptive Card.
- **Webhook_Receiver**: el route existente `/api/webhooks/gitlab` y su función `processPipeline()`.
- **Teams_Sender**: el helper `sendTeamsCard` de `src/lib/teams-notify.ts`.
- **GitLab_Client**: el cliente `gitlabClient` (`src/lib/gitlab.ts`) usado para el enriquecimiento de MR/commit.
- **Dedup_Store**: la tabla PostgreSQL `deploy_notifications`, con clave primaria `(pipeline_id, project_id)`.
- **Prod_Gate**: la variable de entorno `DEPLOY_NOTIFY_ENABLED`, que habilita el envío solo cuando vale `"true"` (definida únicamente en `values-prod.yaml`).
- **Deploy_Webhook_URL**: la variable de entorno `DEPLOY_TEAMS_WEBHOOK_URL`, la URL del webhook dedicado de Teams, materializada vía ESO desde la propiedad `deploy_webhook` del secreto `dp/tooling/portal_teams`.
- **DEPLOY_JOB_NAMES**: el conjunto canónico de patrones de nombre/stage de jobs de deploy a prod, derivado de `DORA_DEPLOY_JOB_NAMES` (compartido con `dora-snapshot.ts`).
- **Notify_Result**: el objeto de retorno `{ sent: boolean; reason: string }` de `notifyProdDeploy`.
- **Adaptive_Card**: el objeto JSON con estructura `{ type: "message", attachments: [{ contentType, content }] }` que Teams renderiza.

## Requirements

### Requirement 1: Detección de deploy a producción exitoso

**User Story:** Como compañero suscrito al canal, quiero que el sistema reconozca con precisión cuándo un evento de pipeline representa un deploy a producción exitoso, para recibir notificaciones solo de deploys reales a prod y no de otros eventos.

#### Acceptance Criteria

1. WHEN un evento `pipeline` tiene `object_attributes.status` igual a `"success"` y contiene al menos un build cuyo `name` o `stage` incluye (como subcadena, sin distinción de mayúsculas/minúsculas) un patrón de DEPLOY_JOB_NAMES y tiene `status` igual a `"success"`, THE Prod_Deploy_Detector SHALL devolver `isProdDeploy` igual a `true` y el primer build de deploy coincidente al recorrer `builds` en orden.
2. WHEN un evento `pipeline` tiene `object_attributes.status` igual a `"success"` pero ningún build incluye un patrón de DEPLOY_JOB_NAMES en su `name` o `stage`, THE Prod_Deploy_Detector SHALL devolver `isProdDeploy` igual a `false`.
3. WHEN un evento `pipeline` contiene builds que coinciden con un patrón de DEPLOY_JOB_NAMES pero ninguno de los coincidentes tiene `status` igual a `"success"`, THE Prod_Deploy_Detector SHALL devolver `isProdDeploy` igual a `false`.
4. WHEN un evento `pipeline` contiene únicamente builds cuyo `name` y `stage` no incluyen ningún patrón de DEPLOY_JOB_NAMES, THE Prod_Deploy_Detector SHALL devolver `isProdDeploy` igual a `false`.
5. WHEN un evento `pipeline` con `object_attributes.status` igual a `"success"` contiene un build de stage móvil (Play Store / App Store) cuyo `name` o `stage` incluye un patrón de deploy a prod de DEPLOY_JOB_NAMES y tiene `status` igual a `"success"`, THE Prod_Deploy_Detector SHALL devolver `isProdDeploy` igual a `true`.
6. IF el payload carece de `object_attributes` o su `status` no es `"success"`, THEN THE Prod_Deploy_Detector SHALL devolver `isProdDeploy` igual a `false` sin lanzar excepción.
7. IF `builds` está ausente, no es un array o está vacío, o un build tiene `name` y `stage` nulos, THEN THE Prod_Deploy_Detector SHALL tratar esos builds como no coincidentes y devolver `isProdDeploy` igual a `false` sin lanzar excepción.

### Requirement 2: Gate prod-only de emisión

**User Story:** Como operador del portal, quiero que las notificaciones se emitan exclusivamente desde el entorno de producción del portal, para evitar tarjetas duplicadas entre `portal-dev` y `portal-prod`, que tienen bases de datos separadas.

#### Acceptance Criteria

1. IF Prod_Gate tiene un valor distinto de `"true"`, THEN THE Deploy_Notifier SHALL retornar un Notify_Result con `sent` igual a `false` y `reason` igual a `"disabled"` sin ejecutar detección, deduplicación ni envío.
2. WHILE Prod_Gate vale `"true"`, THE Deploy_Notifier SHALL continuar con la detección del deploy a producción.
3. THE Prod_Gate SHALL estar definido con valor `"true"` únicamente en `values-prod.yaml` mediante la clave `configMap.DEPLOY_NOTIFY_ENABLED`.

### Requirement 3: Deduplicación de notificaciones

**User Story:** Como compañero suscrito al canal, quiero recibir exactamente una notificación por cada deploy a producción, para que las múltiples entregas del evento `pipeline` y las dos réplicas del portal no generen tarjetas repetidas.

#### Acceptance Criteria

1. WHEN se procesa un deploy a producción detectado, THE Deploy_Notifier SHALL ejecutar, antes de intentar el envío de la notificación, un claim atómico en Dedup_Store sobre el par `(pipeline_id, project_id)` mediante una única sentencia `INSERT ... ON CONFLICT (pipeline_id, project_id) DO NOTHING`.
2. WHEN el claim atómico inserta exactamente una fila para el par `(pipeline_id, project_id)`, THE Deploy_Notifier SHALL enviar la notificación y retornar un Notify_Result con `sent` igual a `true`.
3. IF el claim atómico en Dedup_Store devuelve cero filas afectadas para un par `(pipeline_id, project_id)` ya registrado, THEN THE Deploy_Notifier SHALL omitir el envío y retornar un Notify_Result con `sent` igual a `false` y `reason` igual a `"already-notified"`.
4. WHEN dos o más invocaciones concurrentes procesan el mismo par `(pipeline_id, project_id)`, THE Deploy_Notifier SHALL permitir que exactamente una invocación (la que obtiene la fila insertada) envíe la notificación, y las invocaciones restantes SHALL retornar un Notify_Result con `sent` igual a `false` y `reason` igual a `"already-notified"`.
5. IF la consulta de claim a Dedup_Store falla por error de base de datos, THEN THE Deploy_Notifier SHALL omitir el envío sin reintentar, registrar el error en el log del sistema y retornar un Notify_Result con `sent` igual a `false` y `reason` igual a `"claim-error"`.
6. IF el claim atómico inserta la fila correctamente pero el envío posterior de la notificación falla, THEN THE Deploy_Notifier SHALL conservar la fila reclamada en Dedup_Store sin revertirla, omitir cualquier reintento del envío y retornar un Notify_Result con `sent` igual a `false` y `reason` igual a `"send-failed"`.
7. THE Dedup_Store SHALL tener clave primaria compuesta por `(pipeline_id, project_id)`.

### Requirement 4: Enriquecimiento del deploy (best-effort)

**User Story:** Como compañero suscrito al canal, quiero que la notificación incluya información de la MR y el commit que originaron el deploy, para entender qué se cambió en esa subida concreta.

#### Acceptance Criteria

1. WHEN el payload del evento incluye `merge_request`, THE Deploy_Info_Builder SHALL usar el iid, título, autor y URL de esa MR para construir el DeployInfo.
2. WHEN el payload del evento no incluye `merge_request`, THE Deploy_Info_Builder SHALL solicitar la MR asociada al commit mediante GitLab_Client y usar la primera coincidencia si existe.
3. THE Deploy_Info_Builder SHALL poblar los campos de commit (sha, sha corto, mensaje y autor) a partir de `payload.commit`.
4. IF una llamada a GitLab_Client falla durante el enriquecimiento, THEN THE Deploy_Info_Builder SHALL construir el DeployInfo con los datos disponibles en el payload sin propagar la excepción.
5. THE Deploy_Info_Builder SHALL derivar el nombre del microservicio y el equipo a partir de la ruta del proyecto.

### Requirement 5: Construcción de la Adaptive Card

**User Story:** Como compañero suscrito al canal, quiero que la tarjeta muestre toda la información relevante del deploy y enlaces directos a GitLab, para revisar el detalle sin buscarlo manualmente.

#### Acceptance Criteria

1. THE Deploy_Card_Builder SHALL incluir en la tarjeta el nombre del microservicio, el entorno, el timestamp del deploy, el ref, el commit (sha corto y mensaje), el autor del commit y el identificador de pipeline.
2. WHEN el DeployInfo contiene una MR, THE Deploy_Card_Builder SHALL incluir el iid y el título de la MR en la tarjeta.
3. WHEN el DeployInfo contiene una URL de MR, THE Deploy_Card_Builder SHALL incluir una acción `Action.OpenUrl` hacia la MR.
4. THE Deploy_Card_Builder SHALL incluir acciones `Action.OpenUrl` hacia la URL del pipeline y hacia la URL web del proyecto.
5. THE Deploy_Card_Builder SHALL producir un objeto con la estructura `{ type: "message", attachments: [{ contentType, content }] }`.

### Requirement 6: Envío al webhook dedicado de Teams

**User Story:** Como operador del portal, quiero que la notificación se envíe a un webhook de Teams dedicado y nunca a los de SRE o FinOps, para mantener separadas las señales y evitar mezclar canales.

#### Acceptance Criteria

1. WHEN se ha construido la Adaptive Card y existe Deploy_Webhook_URL, THE Deploy_Notifier SHALL enviar la tarjeta a Deploy_Webhook_URL mediante Teams_Sender exactamente una vez.
2. IF Deploy_Webhook_URL no está definido, THEN THE Deploy_Notifier SHALL retornar un Notify_Result con `sent` igual a `false` y `reason` igual a `"no-webhook"`, registrar una advertencia y omitir el envío.
3. THE Deploy_Notifier SHALL obtener Deploy_Webhook_URL desde la propiedad `deploy_webhook` del secreto `dp/tooling/portal_teams` materializada vía ESO.
4. THE Deploy_Notifier SHALL enviar la notificación únicamente a Deploy_Webhook_URL y no a `TEAMS_WEBHOOK_URL` ni a `FINOPS_TEAMS_WEBHOOK_URL`.

### Requirement 7: Contrato best-effort del orquestador

**User Story:** Como desarrollador del portal, quiero que la notificación sea best-effort y nunca interrumpa el procesamiento del webhook, para que un fallo de notificación no afecte al receptor de eventos ni a las métricas DORA.

#### Acceptance Criteria

1. WHEN ocurre cualquier error durante la detección, deduplicación, enriquecimiento, construcción o envío, THE Deploy_Notifier SHALL capturar el error y retornar un Notify_Result en lugar de propagar la excepción.
2. WHEN un deploy detectado se notifica correctamente, THE Deploy_Notifier SHALL retornar un Notify_Result con `sent` igual a `true`.
3. WHEN un evento `pipeline` no representa un deploy a producción, THE Deploy_Notifier SHALL retornar un Notify_Result con `sent` igual a `false` y `reason` igual a `"not-prod-deploy"`.
4. THE Webhook_Receiver SHALL invocar al Deploy_Notifier de forma fire-and-forget desde `processPipeline()` con un manejador `.catch` que registre cualquier error sin bloquear la respuesta a GitLab.

### Requirement 8: Configuración operativa del webhook de GitLab

**User Story:** Como operador del portal, quiero que el group webhook de `iskaypetcom` entregue eventos de pipeline al portal, para que los deploys a producción de toda la organización lleguen al receptor.

#### Acceptance Criteria

1. THE group webhook del grupo `iskaypetcom` SHALL tener habilitado el trigger "Pipeline events".
2. THE group webhook del grupo `iskaypetcom` SHALL tener configurado el secret token validado por el Webhook_Receiver.
3. WHERE el valor del webhook de Power Automate se suministra para almacenarlo en Secrets Manager, THE operador SHALL verificar el valor `sig` exacto antes de guardarlo.
