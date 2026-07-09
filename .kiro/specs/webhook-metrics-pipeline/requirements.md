# Documento de Requisitos — Webhook Metrics Pipeline

## Introducción

El Platform Portal actualmente recopila métricas de ingeniería (DORA, actividad de desarrolladores, trazabilidad de despliegues) mediante un snapshot monolítico diario que consulta la API de GitLab secuencialmente para más de 351 proyectos. Este enfoque es frágil, lento (horas de ejecución), falla frecuentemente durante backfills y solo proporciona datos con un día de retraso.

Este documento define los requisitos para rediseñar la recopilación de métricas usando **webhooks de GitLab** como fuente primaria de datos en tiempo real, complementados por un **snapshot incremental** como red de seguridad. Además, se establece un **entorno de desarrollo** aislado en Kubernetes para construir y probar el nuevo pipeline sin afectar producción.

## Glosario

- **Portal**: La aplicación Next.js del Platform Portal que muestra métricas de ingeniería y herramientas de plataforma.
- **Webhook_Receiver**: El endpoint HTTP dentro del Portal que recibe y procesa eventos webhook de GitLab.
- **Event_Store**: La tabla de base de datos que almacena los eventos webhook crudos (raw) para auditoría y replay.
- **Event_Processor**: El componente que transforma eventos webhook crudos en registros de métricas agregadas.
- **Gap_Detector**: El componente del snapshot incremental que identifica proyectos/días con datos faltantes.
- **Incremental_Snapshot**: El job nocturno ligero que solo re-procesa los huecos detectados por el Gap_Detector.
- **Dev_Environment**: El namespace de Kubernetes `platformportal` con su propia base de datos PostgreSQL y URL de ingress separada.
- **Prod_Environment**: El despliegue actual del Portal en el namespace `n8n` del clúster EKS.
- **GitLab_Group**: Un grupo de GitLab (Digital, Retail, Helios, Backoffice, DataBI, SRE-Infra, etc.) que contiene proyectos a monitorizar.
- **Webhook_Secret**: Token secreto compartido entre GitLab y el Webhook_Receiver para verificar la autenticidad de los eventos.
- **DORA_Metrics**: Las cuatro métricas clave de DevOps Research and Assessment: frecuencia de despliegue, lead time, tasa de fallos de cambio y tiempo de recuperación (MTTR).
- **Metric_Tables**: Las tablas de métricas agregadas: `dora_metrics_daily`, `developer_activity_daily`, `deployment_traces` y tablas relacionadas.

---

## Requisitos

### Requisito 1: Entorno de Desarrollo — Réplica Exacta del Portal de Producción

**User Story:** Como ingeniero de plataforma, quiero un entorno de desarrollo que sea una réplica total y absoluta del portal de producción, para poder desarrollar y probar cambios con total confianza antes de promoverlos.

#### Criterios de Aceptación

1. THE Dev_Environment SHALL ejecutarse en el namespace de Kubernetes `platformportal` dentro del clúster EKS de la cuenta 444455556666.
2. THE Dev_Environment SHALL desplegar exactamente la misma imagen de contenedor que el Prod_Environment desde el registro Harbor (`harbor.tooling.dp.iskaypet.com/tooling/platformportal`), incluyendo la misma versión de la aplicación Next.js.
3. THE Dev_Environment SHALL replicar la configuración completa del Prod_Environment: todas las variables de entorno, ConfigMaps (`platformportal-config`), secretos (`platformportal-secrets`, `n8n-webhooks-env`), ServiceAccount con IRSA, y configuración de recursos (CPU/memoria).
4. THE Dev_Environment SHALL utilizar una instancia de PostgreSQL independiente, separada de la base de datos de producción, con el mismo esquema de tablas y migraciones aplicadas.
5. THE Dev_Environment SHALL ser accesible mediante la URL de ingress `portal.today.dev.tooling.dp.iskaypet.com`.
6. THE Dev_Environment SHALL usar valores específicos de desarrollo para: DATABASE_URL (apuntando a la PostgreSQL de dev), NEXTAUTH_URL (con la URL de dev) y NEXTAUTH_SECRET (secreto propio de dev).
7. THE Dev_Environment SHALL activar las funcionalidades que están deshabilitadas en producción mediante feature flags: `ENABLE_AUTOMATIONS` y `ENABLE_JIRA` deberán estar habilitadas (`true`) en el entorno de desarrollo. La funcionalidad de Cybersecurity (`ENABLE_CYBERSECURITY`) queda excluida de ambos entornos.
8. WHILE el Dev_Environment está operativo, THE Prod_Environment SHALL continuar funcionando sin modificaciones en el namespace `n8n`.
9. THE Dev_Environment SHALL incluir las nuevas tablas del pipeline de webhooks coexistiendo con las tablas existentes del esquema actual.
10. THE Dev_Environment SHALL poder ser eliminado o promovido a producción sin afectar el Prod_Environment.
11. THE Dev_Environment SHALL replicar las probes de salud (liveness y readiness) y la configuración de Grafana scraping del Prod_Environment.

---

### Requisito 2: Recepción y Almacenamiento de Eventos Webhook

**User Story:** Como ingeniero de plataforma, quiero recibir eventos de GitLab en tiempo real mediante webhooks, para tener datos de métricas disponibles en minutos en lugar de al día siguiente.

#### Criterios de Aceptación

1. THE Webhook_Receiver SHALL exponer un endpoint HTTP POST en la ruta `/api/webhooks/gitlab` para recibir eventos de GitLab.
2. WHEN un evento webhook es recibido, THE Webhook_Receiver SHALL verificar la autenticidad del evento usando el header `X-Gitlab-Token` comparándolo con el Webhook_Secret configurado.
3. IF un evento webhook no supera la verificación de autenticidad, THEN THE Webhook_Receiver SHALL responder con código HTTP 401 y descartar el evento.
4. WHEN un evento webhook válido es recibido, THE Webhook_Receiver SHALL almacenar el payload completo en el Event_Store antes de procesarlo.
5. THE Event_Store SHALL registrar para cada evento: el tipo de evento (`object_kind`), el ID del proyecto GitLab, el ID del grupo GitLab, el payload JSON completo, la marca de tiempo de recepción y el estado de procesamiento.
6. WHEN un evento webhook válido es almacenado, THE Webhook_Receiver SHALL responder con código HTTP 200 en un tiempo máximo de 5 segundos para evitar timeouts de GitLab.
7. THE Webhook_Receiver SHALL aceptar los siguientes tipos de eventos de GitLab: `deployment`, `merge_request`, `pipeline` y `push`.
8. IF el almacenamiento del evento en el Event_Store falla, THEN THE Webhook_Receiver SHALL responder con código HTTP 500 y registrar el error en los logs de la aplicación.

---

### Requisito 3: Procesamiento Atómico de Eventos

**User Story:** Como ingeniero de plataforma, quiero que cada evento webhook se procese de forma independiente, para que el fallo de un evento no afecte el procesamiento de otros.

#### Criterios de Aceptación

1. THE Event_Processor SHALL procesar cada evento del Event_Store de forma independiente, sin dependencias entre eventos.
2. IF el procesamiento de un evento falla, THEN THE Event_Processor SHALL marcar ese evento como `failed` en el Event_Store, registrar el error y continuar con el siguiente evento.
3. WHEN un evento de tipo `deployment` es procesado, THE Event_Processor SHALL extraer: el ID del proyecto, el SHA del commit, el entorno de despliegue, el estado del despliegue y la marca de tiempo, y actualizar las Metric_Tables correspondientes.
4. WHEN un evento de tipo `merge_request` es procesado, THE Event_Processor SHALL extraer: el ID del proyecto, el autor, las fechas de creación y merge, la rama origen, las etiquetas y el conteo de commits, y actualizar las Metric_Tables correspondientes.
5. WHEN un evento de tipo `pipeline` es procesado, THE Event_Processor SHALL extraer: el ID del proyecto, el estado del pipeline, la duración, la rama y el SHA del commit, y actualizar las Metric_Tables correspondientes.
6. WHEN un evento de tipo `push` es procesado, THE Event_Processor SHALL extraer: el ID del proyecto, los commits incluidos (SHA, autor, líneas añadidas/eliminadas) y actualizar las Metric_Tables correspondientes.
7. THE Event_Processor SHALL actualizar las Metric_Tables de forma incremental usando operaciones UPSERT, sin requerir recalcular el día completo.
8. WHEN un evento es procesado exitosamente, THE Event_Processor SHALL marcar el evento como `processed` en el Event_Store con la marca de tiempo de procesamiento.
9. IF un evento marcado como `failed` es reprocesado manualmente, THEN THE Event_Processor SHALL intentar procesarlo nuevamente y actualizar su estado según el resultado.

---

### Requisito 4: Configuración de Webhooks Multi-Grupo

**User Story:** Como ingeniero de plataforma, quiero configurar webhooks a nivel de grupo en múltiples grupos de GitLab, para cubrir todos los equipos de la organización y no solo el grupo Digital.

#### Criterios de Aceptación

1. THE Portal SHALL soportar la recepción de eventos webhook de los siguientes GitLab_Groups: Digital, Retail, Helios, Backoffice, DataBI, SRE-Infra, EducaPet-IT y Friendly Companies.
2. WHEN un evento webhook es recibido, THE Webhook_Receiver SHALL identificar el GitLab_Group de origen a partir del campo `project.namespace` o `project.path_with_namespace` del payload.
3. THE Event_Processor SHALL derivar la asignación de equipo (team) a partir de la ruta del grupo/subgrupo del proyecto (campo `path_with_namespace`), usando el segundo o tercer segmento de la ruta según la profundidad de la jerarquía.
4. THE Webhook_Receiver SHALL utilizar un Webhook_Secret único por cada GitLab_Group configurado, permitiendo rotación independiente de secretos.
5. WHEN se añade un nuevo GitLab_Group, THE Portal SHALL poder incorporarlo configurando el webhook en GitLab y añadiendo el secreto correspondiente, sin requerir cambios en el código fuente.
6. THE Portal SHALL mantener un registro de los GitLab_Groups configurados con sus IDs, nombres y estado de activación.

---

### Requisito 5: Esquema de Métricas v2 para Actualizaciones Incrementales

**User Story:** Como ingeniero de plataforma, quiero un esquema de base de datos que soporte actualizaciones incrementales desde webhooks, para que las métricas se actualicen en tiempo real sin necesidad de recalcular snapshots completos.

#### Criterios de Aceptación

1. THE Event_Store SHALL utilizar una tabla `webhook_events_raw` con las columnas: `id` (serial), `received_at` (timestamp), `gitlab_event_type` (text), `gitlab_project_id` (integer), `gitlab_group_id` (integer), `payload` (jsonb), `processing_status` (text), `processed_at` (timestamp), `error_message` (text) y `retry_count` (integer).
2. THE Metric_Tables SHALL soportar operaciones UPSERT que permitan actualizar contadores individuales (deployment_count, total_commits, total_mrs) sin sobrescribir el registro completo del día.
3. THE Metric_Tables SHALL incluir una columna `data_source` que distinga entre datos provenientes de webhooks (`webhook`) y datos del snapshot incremental (`snapshot_v2`).
4. THE Metric_Tables SHALL incluir una columna `last_webhook_at` (timestamp) que registre la marca de tiempo del último evento webhook procesado para cada combinación proyecto/día.
5. THE deployment_traces table SHALL soportar inserciones individuales por evento de despliegue, en lugar de requerir el contexto completo del día.
6. THE developer_activity_daily table SHALL soportar incrementos atómicos (por ejemplo, `commits_count = commits_count + 1`) en lugar de reemplazos completos del registro.

---

### Requisito 6: Snapshot Incremental como Red de Seguridad

**User Story:** Como ingeniero de plataforma, quiero un job nocturno que detecte y rellene huecos en los datos, para garantizar la completitud de las métricas incluso cuando los webhooks fallen.

#### Criterios de Aceptación

1. THE Gap_Detector SHALL ejecutarse como un job nocturno programado y comparar los datos recibidos por webhooks contra la lista de proyectos activos de cada GitLab_Group.
2. THE Gap_Detector SHALL identificar como "hueco" cualquier combinación de proyecto/día donde no se hayan recibido eventos webhook en las últimas 48 horas y el proyecto tenga actividad reciente (commits o despliegues en los últimos 30 días).
3. WHEN el Gap_Detector identifica huecos, THE Incremental_Snapshot SHALL re-procesar únicamente los proyectos y días específicos con datos faltantes, usando la API de GitLab.
4. THE Incremental_Snapshot SHALL completar su ejecución en menos de 30 minutos para el caso típico (menos de 50 proyectos/días con huecos).
5. THE Incremental_Snapshot SHALL registrar un resumen de ejecución con: número de huecos detectados, número de huecos rellenados exitosamente, número de fallos y tiempo total de ejecución.
6. IF el Incremental_Snapshot falla al procesar un proyecto/día específico, THEN THE Incremental_Snapshot SHALL continuar con los demás huecos y reportar los fallos individuales en el resumen.
7. THE Incremental_Snapshot SHALL respetar los rate limits de la API de GitLab, espaciando las peticiones para no exceder los límites configurados.

---

### Requisito 7: Detección de Despliegues Mejorada

**User Story:** Como ingeniero de plataforma, quiero que la detección de despliegues a producción funcione de forma fiable para todos los proyectos, sin depender de nombres específicos de jobs de CI.

#### Criterios de Aceptación

1. WHEN un evento de tipo `deployment` es recibido con entorno que coincide con los patrones de producción (production, prod, prd, live), THE Event_Processor SHALL registrarlo como un despliegue a producción.
2. THE Event_Processor SHALL clasificar cada despliegue como `feature`, `hotfix` o `rollback` usando la rama origen, las etiquetas del MR asociado y el historial de commits desplegados.
3. WHEN un evento de tipo `pipeline` con estado `success` es recibido y contiene un job cuyo nombre coincide con los patrones de deploy configurados, THE Event_Processor SHALL registrarlo como un despliegue a producción.
4. THE Event_Processor SHALL calcular el lead time de cada despliegue como la diferencia entre la marca de tiempo del despliegue y la marca de tiempo del primer commit del MR asociado.
5. IF un despliegue no tiene MR asociado (push directo), THEN THE Event_Processor SHALL usar la marca de tiempo del commit desplegado como referencia para el lead time.
6. THE Event_Processor SHALL calcular el MTTR (Mean Time To Recovery) rastreando pares de eventos fallo/recuperación en los pipelines y despliegues de cada proyecto.

---

### Requisito 8: Identidad de Desarrollador Mejorada

**User Story:** Como ingeniero de plataforma, quiero que la identidad de los desarrolladores se resuelva correctamente incluso con emails privados de GitLab, para que las métricas de actividad sean precisas.

#### Criterios de Aceptación

1. WHEN un evento webhook contiene un email de autor, THE Event_Processor SHALL normalizar el email a minúsculas y eliminar espacios antes de usarlo como identificador.
2. WHEN un evento webhook contiene un email privado de GitLab (formato `*@users.noreply.gitlab.com`), THE Event_Processor SHALL intentar resolver la identidad real usando el campo `username` o `author.username` del payload.
3. THE Event_Processor SHALL mantener una tabla de mapeo de identidades (`developer_identity_map`) que asocie múltiples emails y usernames a un identificador canónico por desarrollador.
4. WHEN se detecta un nuevo email o username no mapeado, THE Event_Processor SHALL crear una entrada provisional en la tabla de identidades y marcarla para revisión.
5. THE Portal SHALL proporcionar una interfaz de administración para revisar y fusionar identidades de desarrolladores duplicadas.

---

### Requisito 9: Replay y Auditoría de Eventos

**User Story:** Como ingeniero de plataforma, quiero poder re-procesar eventos históricos desde el Event_Store, para corregir errores de procesamiento o recalcular métricas con lógica actualizada.

#### Criterios de Aceptación

1. THE Event_Store SHALL retener los eventos webhook crudos durante un mínimo de 90 días.
2. THE Portal SHALL exponer un endpoint de administración que permita re-procesar eventos del Event_Store filtrando por: rango de fechas, tipo de evento, ID de proyecto y estado de procesamiento.
3. WHEN se ejecuta un replay de eventos, THE Event_Processor SHALL procesar los eventos seleccionados en orden cronológico y actualizar las Metric_Tables con los resultados.
4. THE Event_Store SHALL registrar cada intento de procesamiento (original y replays) con su marca de tiempo y resultado, sin sobrescribir el historial de intentos anteriores.
5. IF un replay de eventos afecta métricas ya calculadas, THEN THE Event_Processor SHALL recalcular los agregados diarios afectados para mantener la consistencia.

---

### Requisito 10: Seguridad del Endpoint de Webhooks

**User Story:** Como ingeniero de plataforma, quiero que el endpoint de webhooks esté protegido contra accesos no autorizados, para garantizar la integridad de los datos de métricas.

#### Criterios de Aceptación

1. THE Webhook_Receiver SHALL validar el header `X-Gitlab-Token` en cada petición entrante antes de procesar el evento.
2. THE Webhook_Receiver SHALL rechazar con código HTTP 401 cualquier petición que no incluya un `X-Gitlab-Token` válido.
3. THE Webhook_Receiver SHALL validar que el `Content-Type` de la petición sea `application/json`.
4. IF una petición contiene un payload JSON malformado, THEN THE Webhook_Receiver SHALL responder con código HTTP 400 y registrar el intento en los logs.
5. THE Webhook_Receiver SHALL implementar rate limiting por IP de origen, permitiendo un máximo de 100 peticiones por minuto por dirección IP.
6. THE Portal SHALL almacenar los Webhook_Secrets como secretos de Kubernetes, separados del código fuente y de las variables de entorno en texto plano.

---

### Requisito 11: Observabilidad del Pipeline

**User Story:** Como ingeniero de plataforma, quiero tener visibilidad sobre el estado del pipeline de webhooks, para detectar y resolver problemas rápidamente.

#### Criterios de Aceptación

1. THE Portal SHALL exponer métricas Prometheus en el endpoint `/api/webhooks/metrics` con los siguientes contadores: eventos recibidos por tipo, eventos procesados exitosamente, eventos fallidos y latencia de procesamiento.
2. THE Portal SHALL proporcionar un dashboard de administración que muestre: el número de eventos recibidos en las últimas 24 horas por grupo y tipo, el número de eventos pendientes de procesamiento, el número de eventos fallidos y la latencia promedio de procesamiento.
3. WHEN el número de eventos pendientes de procesamiento supera los 1000, THE Portal SHALL registrar una alerta en los logs con nivel WARNING.
4. WHEN el número de eventos fallidos en la última hora supera los 50, THE Portal SHALL registrar una alerta en los logs con nivel ERROR.
5. THE Gap_Detector SHALL registrar en los logs el resultado de cada ejecución nocturna, incluyendo el número de huecos detectados y rellenados.
