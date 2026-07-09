# Requirements Document

> Feature: FinOps AI Observability

## Introduction

El Platform Portal de IskayPet dispone hoy de un análisis FinOps potente (pestañas Costes, Inventario, EKS Allocation, Asesor + chat Iskay) que consulta el CUR vía Athena y OpenCost vía Grafana. Sin embargo tiene tres carencias que esta feature resuelve:

1. **Falta de histórico real del coste de IA** (licencias Kiro + inferencia Bedrock). Hoy `kiro-licenses.ts` y el `BedrockCard` solo muestran ventanas puntuales del CUR. El CUR devuelve agregados por rango, no una serie temporal estable, y no hay persistencia diaria; por eso no se puede ver tendencia ni detectar picos como el que ocurrió en las cuentas de Data (un job EMR consumió ~700€ de Bedrock en un día).

2. **Aluvión de emails de AWS sin consolidar.** AWS envía notificaciones (eventos de salud de servicios, mantenimientos programados, cambios que afectan a recursos, fin de soporte, etc.) por correo. Hoy nadie las consolida en el portal. La fuente elegida es **EventBridge** (`source: "aws.health"`), que emite esos eventos en cada cuenta **sin necesidad de plan de soporte de pago** (verificado: la cuenta root está en Basic Support, por lo que la AWS Health API programática NO está disponible; EventBridge sí). Se hace fan-in cross-account a un bus central en dp-tooling y de ahí a una cola SQS que el portal consume.

3. **No hay un resumen FinOps proactivo.** El Asesor FinOps existe pero es bajo demanda (el usuario lanza el job). No hay una entrega diaria automática a un canal de equipo con los hallazgos relevantes del día (anomalías, top movers, oportunidades de ahorro, novedades AWS).

Esta feature añade: (a) **persistencia de snapshots diarios del coste de IA** + visualización de tendencia histórica en la pestaña Costes; (b) una **sidebar admin-only de "Novedades AWS"** en la home alimentada por AWS Health organizational view; y (c) un **resumen FinOps diario automático** (análisis profundo + novedades AWS del día) enviado a un grupo de Teams vía webhook dedicado.

Reutiliza piezas existentes: `finops-advisor-runner.ts` (job async Bedrock), `athena-cur.ts` (CUR directo), `kiro-licenses.ts` (resolución de licencias), `aws-assume-role`/role chain hacia root, el patrón de cronjobs nocturnos (`platform-snapshot.ts`), el patrón de tablas snapshot (`finops_daily_context`), y el patrón de notificación Teams.

## Glossary

- **AI_Cost**: Coste combinado de inteligencia artificial = licencias Kiro (CUR `line_item_product_code='Kiro'`, tipo `FlatRateSubscription`) + inferencia Bedrock (CUR, dentro de `hiddenCosts.bedrock`, por modelo y cuenta).
- **AI_Cost_Snapshot**: Registro diario persistido con el desglose de AI_Cost de un día concreto (por cuenta, por modelo Bedrock, por plan Kiro), que permite construir una serie temporal histórica.
- **AI_Cost_History**: Serie temporal de AI_Cost_Snapshot consultable por rango de fechas para mostrar tendencia.
- **AWS_Health_Event**: Evento de salud de AWS emitido a EventBridge en cada cuenta con `source: "aws.health"` (categorías `issue`, `scheduledChange`, `accountNotification`). Estos eventos se emiten en Basic Support (no requieren la AWS Health API de pago); lo que requiere plan Business/Enterprise es la API programática y la vista de organización, que NO se usan.
- **Health_Hub_Bus**: Bus de EventBridge central (`portal-aws-health`) en la cuenta dp-tooling (`444455556666`) que recibe, vía fan-in cross-account, los eventos `aws.health` de todas las cuentas de la organización.
- **Health_Queue**: Cola SQS (`portal-aws-health-events`) en dp-tooling a la que el Health_Hub_Bus enruta los eventos, y de la que el portal hace polling para persistirlos.
- **AWS_News_Item**: Representación normalizada de un AWS_Health_Event para mostrarse en la sidebar de la home y/o en el resumen Teams (servicio, región, categoría, estado, cuentas afectadas, fechas, descripción, severidad inferida).
- **News_Sidebar**: Componente de la home, visible solo para `admin`, que lista los AWS_News_Item recientes.
- **Daily_FinOps_Digest**: Resumen FinOps generado automáticamente cada día (análisis del Asesor FinOps + novedades AWS del día) que se envía a un grupo de Teams.
- **FinOps_Teams_Webhook**: Webhook entrante de Teams dedicado para el Daily_FinOps_Digest (`FINOPS_TEAMS_WEBHOOK_URL`), distinto del `TEAMS_WEBHOOK_URL` usado por requests/aprobaciones SRE.
- **Health_Role**: No se usa la AWS Health API. La ingesta es vía EventBridge → SQS en dp-tooling (sin coste de soporte). El portal lee la SQS con su IRSA / rol existente.
- **Snapshot_Cronjob**: CronJob de Kubernetes que dispara la persistencia diaria del AI_Cost_Snapshot y/o el cacheo de AWS_News_Item.
- **Digest_Cronjob**: CronJob de Kubernetes que dispara la generación y envío del Daily_FinOps_Digest.
- **Portal**: Platform Portal de IskayPet (Next.js, EKS dp-tooling, namespace `n8n`, deployment `n8n-webhooks`).
- **Internal_Secret**: Header `x-internal-secret` (`INTERNAL_API_SECRET`) que autentica las llamadas internas de cronjobs/n8n a los endpoints del portal, excluidos del middleware de usuario.

## Requirements

### Requisito 1: Persistencia de snapshots diarios del coste de IA

**User Story:** Como responsable de FinOps, quiero que el portal guarde cada día el desglose del coste de IA (Kiro + Bedrock), para poder ver la tendencia histórica y detectar picos de gasto en cuentas concretas.

#### Criterios de Aceptación

1. THE Portal SHALL persistir un AI_Cost_Snapshot diario con, al menos: fecha del snapshot, coste total Kiro, coste total Bedrock, desglose Bedrock por modelo y cuenta, desglose Kiro por plan y cuenta, y el coste neto de IA del día.
2. WHEN el Snapshot_Cronjob se ejecute, THE Portal SHALL calcular el AI_Cost del día anterior consultando el CUR vía `athena-cur.ts` y `kiro-licenses.ts` y guardarlo como AI_Cost_Snapshot.
3. IF ya existe un AI_Cost_Snapshot para la fecha solicitada, THEN THE Portal SHALL actualizarlo (upsert idempotente) en lugar de duplicarlo.
4. THE Snapshot_Cronjob SHALL autenticarse contra el endpoint de persistencia mediante el Internal_Secret y estar excluido del middleware de usuario.
5. WHEN el snapshot de un día falle (CUR no disponible, error de role), THE Portal SHALL registrar el error y permitir reintento sin corromper snapshots previos.
6. THE Portal SHALL permitir un backfill manual (rango de fechas) para reconstruir AI_Cost_History a partir del histórico del CUR.

### Requisito 2: Visualización de tendencia histórica del coste de IA

**User Story:** Como responsable de FinOps, quiero ver en la pestaña Costes una gráfica de evolución del coste de IA en el tiempo, para entender si el gasto crece, cae o tiene picos anómalos.

#### Criterios de Aceptación

1. THE Portal SHALL exponer un endpoint que devuelva AI_Cost_History para un rango de fechas, con la serie temporal de coste Kiro, coste Bedrock y coste total de IA por día.
2. THE pestaña Costes SHALL mostrar la AI_Cost_History como una gráfica temporal (líneas o área apilada) junto al `KiroLicensesCard` y al `BedrockCard` existentes.
3. WHEN el usuario seleccione un subconjunto de cuentas en el dashboard FinOps, THE gráfica de AI_Cost_History SHALL filtrar la serie por esas cuentas.
4. WHEN no haya snapshots persistidos todavía, THE Portal SHALL mostrar un estado vacío informativo (en lugar de una gráfica rota) e indicar que el histórico se está construyendo.
5. THE gráfica SHALL resaltar visualmente los días cuyo coste de IA supere un umbral de anomalía relativo a la media del periodo.
6. THE visualización SHALL respetar el control de acceso FinOps existente (los roles sin acceso a FinOps no la ven; `externos` no acceden a FinOps).

### Requisito 3: Ingesta de novedades AWS (EventBridge `aws.health`, sin coste de soporte)

**User Story:** Como administrador de plataforma, quiero que el portal recoja las notificaciones de AWS Health de todas las cuentas vía EventBridge, para no depender del aluvión de emails y tener una vista consolidada, sin pagar plan de soporte.

#### Criterios de Aceptación

1. THE Portal SHALL recibir los AWS_Health_Event mediante reglas de EventBridge (`source: "aws.health"`) desplegadas en cada cuenta de la organización, con fan-in cross-account hacia el Health_Hub_Bus en dp-tooling y enrutado a la Health_Queue (SQS).
2. THE Portal SHALL hacer polling de la Health_Queue, recuperando los eventos de las categorías `issue`, `scheduledChange` y `accountNotification`, incluyendo las cuentas afectadas de cada evento.
3. THE Portal SHALL normalizar cada AWS_Health_Event a un AWS_News_Item con: servicio AWS, región, categoría, estado del evento (`open`/`upcoming`/`closed`), cuentas afectadas (con nombre amigable vía `aws-account-catalog`), fecha de inicio/fin/última actualización, descripción y severidad inferida (`issue` abierto → alta, `scheduledChange` → media, `accountNotification` → baja).
4. THE Portal SHALL persistir los AWS_News_Item en base de datos (upsert por ARN del evento) para no depender de la retención de la cola y servir la sidebar sin latencia.
5. IF la cola no está disponible o no hay credenciales, THEN THE Portal SHALL degradar con elegancia (sidebar sirve lo último persistido o estado vacío) sin romper la home ni borrar lo ya almacenado.
6. THE rol/credenciales de lectura de la Health_Queue SHALL limitarse a las acciones SQS necesarias (`sqs:ReceiveMessage`, `sqs:DeleteMessage`, `sqs:GetQueueAttributes`) sobre esa cola.
7. THE despliegue de las reglas EventBridge en las cuentas SHALL ser automatizable con un script idempotente siguiendo el patrón de `ops/apply-infra-live-policy.sh` (rollout multi-cuenta por perfil AWS).

### Requisito 4: Sidebar de Novedades AWS en la home (admin-only)

**User Story:** Como administrador de plataforma, quiero ver las novedades de AWS sobre nuestras cuentas en la home del portal, para enterarme de mantenimientos, incidencias y cambios sin abrir el correo.

#### Criterios de Aceptación

1. THE News_Sidebar SHALL ser visible únicamente para usuarios con rol `admin`; el resto de roles no la ven ni pueden invocar su endpoint.
2. THE News_Sidebar SHALL listar los AWS_News_Item recientes ordenados por relevancia (eventos abiertos/próximos primero, luego por fecha de actualización descendente).
3. THE News_Sidebar SHALL mostrar por cada item: servicio, categoría, estado, cuentas afectadas (nombres amigables), fecha y un resumen corto, con indicación visual de severidad.
4. WHEN un AWS_News_Item afecte a varias cuentas, THE News_Sidebar SHALL indicar el número de cuentas afectadas y permitir ver el detalle.
5. THE News_Sidebar SHALL permitir filtrar u ocultar eventos ya cerrados (`closed`) para centrarse en lo accionable.
6. WHEN no haya novedades, THE News_Sidebar SHALL mostrar un estado vacío ("sin novedades de AWS") en lugar de desaparecer abruptamente.
7. THE endpoint que sirve la News_Sidebar SHALL validar el rol `admin` en el servidor (no solo ocultar en cliente).

### Requisito 5: Resumen FinOps diario a Teams (Daily_FinOps_Digest)

**User Story:** Como equipo de plataforma/FinOps, quiero recibir cada día en un grupo de Teams un resumen profundo del estado FinOps y las novedades de AWS, para enterarme proactivamente de lo relevante sin entrar al portal.

#### Criterios de Aceptación

1. WHEN el Digest_Cronjob se ejecute (una vez al día a las 10:20 hora de Madrid, justo antes de la daily), THE Portal SHALL generar un Daily_FinOps_Digest reutilizando el Asesor FinOps (`finops-advisor-runner.ts`) sobre TODAS las cuentas vivas (mismo default que el advisor: `filterLiveAwsAccounts`).
2. THE Daily_FinOps_Digest SHALL incluir los hallazgos significativos del día: coste total y variación respecto al periodo anterior, top movers, anomalías detectadas, oportunidades de ahorro priorizadas y el coste de IA del día.
3. THE Daily_FinOps_Digest SHALL incluir las novedades AWS del día (AWS_News_Item nuevos o actualizados en las últimas 24h), o indicar explícitamente que no hubo novedades.
4. THE Portal SHALL enviar el Daily_FinOps_Digest al FinOps_Teams_Webhook (`FINOPS_TEAMS_WEBHOOK_URL`), distinto del webhook SRE de requests/aprobaciones.
5. THE Portal SHALL soportar el envío como un único mensaje (FinOps + novedades) o como dos mensajes separados (resumen FinOps y novedades AWS), siendo este comportamiento configurable.
6. WHEN el contenido del digest exceda los límites de tamaño de una MessageCard de Teams, THE Portal SHALL truncar o paginar el contenido de forma controlada sin que falle el envío.
7. THE Digest_Cronjob SHALL autenticarse mediante el Internal_Secret y estar excluido del middleware de usuario.
8. IF la generación del análisis FinOps falla, THEN THE Portal SHALL enviar al menos las novedades AWS (si las hay) y registrar el fallo, en lugar de no enviar nada.
9. THE Daily_FinOps_Digest SHALL respetar el formato de MessageCard/Adaptive Card de Teams ya usado en el portal y enlazar al dashboard FinOps del portal para profundizar.

### Requisito 6: Configuración, secretos y despliegue

**User Story:** Como SRE, quiero que la feature se configure con secretos y variables de entorno claras y se despliegue con los patrones canónicos del portal, para mantenerla operable y segura.

#### Criterios de Aceptación

1. THE Portal SHALL leer el webhook de Teams del digest desde el secret/env `FINOPS_TEAMS_WEBHOOK_URL` y NUNCA hardcodearlo en el código.
2. THE Portal SHALL leer la URL/ARN de la Health_Queue desde una variable de entorno (`AWS_HEALTH_QUEUE_URL`) y la región desde la configuración estándar; las credenciales de lectura SQS se obtienen del IRSA/rol existente del portal.
3. THE Snapshot_Cronjob y el Digest_Cronjob SHALL desplegarse como CronJobs de Kubernetes en el namespace `n8n` del cluster dp-tooling, con manifiestos versionados en `ops/k8s/`.
4. THE feature SHALL exponer sus endpoints internos bajo el patrón existente (validación `x-internal-secret`, exclusión del middleware de usuario).
5. THE nuevos secretos/vars SHALL documentarse en la sección de variables de entorno de la documentación canónica (steering + `docs/PORTAL_DOCUMENTATION.md` + Confluence).

## Decisiones de alcance (out of scope)

- No se sustituye el chat Iskay ni el Asesor FinOps bajo demanda; se reutilizan.
- No se crea un sistema genérico de notificaciones AWS más allá de los eventos `aws.health` de EventBridge (no se integran otros sources de EventBridge en esta iteración).
- No se usa la AWS Health API ni se contrata plan Business/Enterprise Support (decisión de coste: la cuenta root está en Basic Support; EventBridge cubre la necesidad sin gasto fijo).
- No se persiste todo el CUR como serie temporal; solo el AI_Cost_Snapshot diario (el resto del histórico de coste sigue viniendo del CUR bajo demanda).
- El canal de entrega del digest es Teams; Slack queda fuera de esta iteración (ya está como deuda técnica #21).
