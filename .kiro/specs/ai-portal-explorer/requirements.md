# Requirements Document

## Introduction

El Platform Portal (Next.js 14 App Router, cluster dp-tooling) crece a gran velocidad: nuevas pestañas (FinOps, métricas DORA/Gestión, synthetics, admin, access-management, infra-requests, tickets, kiro-analytics), endpoints `/api/*` y reglas RBAC por rol se añaden de forma continua. No existe hoy ningún mecanismo automatizado que recorra el portal completo, como lo haría un usuario de cada rol, para detectar de forma proactiva errores de UI, fallos de API, regresiones de RBAC, estados rotos o degradaciones de rendimiento antes de que los sufra una persona.

Esta feature introduce el **AI Portal Explorer**: un sistema (ejecutable como job on-demand y como CronJob) que navega el portal de forma exhaustiva y **estrictamente de solo lectura**, recorriéndolo bajo cada rol RBAC mediante una sesión sintética, captura evidencia técnica de cada ruta visitada (errores de consola JavaScript, peticiones de red fallidas, estados de error o vacío en el DOM, latencias y capturas de pantalla), y a continuación pasa **únicamente las anomalías detectadas** por Amazon Bedrock para producir un triage estructurado (severidad, categoría, causa probable, fix sugerido y evidencia). El resultado es un informe estructurado y un histórico que permiten mantener el portal "fino fino fino": detectar qué puede fallar, dónde y para qué rol, con contexto accionable.

La seguridad es el eje innegociable de esta feature: el Explorer **nunca** debe ejecutar mutaciones (enviar formularios que creen infra o solicitudes de acceso, aprobar, ejecutar, borrar). Opera contra el entorno de desarrollo del portal (`portal-dev`), no contra producción.

### Reutilización del estado actual (contexto de diseño)

- **Auth sintética**: el portal usa NextAuth + Azure AD (OIDC) con cookie de sesión cifrada (JWE) con `NEXTAUTH_SECRET`. La decisión recomendada es **acuñar** dicha cookie para un usuario sintético por cada rol, evitando el login OIDC real (frágil por MFA) y permitiendo testear UI + RBAC, algo que el header `x-internal-secret` (solo APIs internas) no cubre.
- **RBAC**: jerarquía `admin > directores > staff > desarrolladores > externos`, definida en `src/lib/rbac.ts` (`SECTION_ACCESS`), `middleware.ts`, `src/lib/api-auth.ts`, `src/lib/session-role.ts`.
- **Descubrimiento de rutas**: `NAV_ITEMS` de `portal-shell.tsx` para rutas de UI y los endpoints conocidos `/api/*`.
- **Bedrock**: `src/lib/bedrock.ts` (ConverseCommand, modelo `eu.anthropic.claude-sonnet-4-20250514-v1:0`).
- **Infra de jobs**: CronJobs declarados por GitOps en `generic-chart` (patrón de `mr-metrics-snapshot`, `lighthouse-scanner` con runtime tipo Playwright, `aws-health-sync`). Imágenes auxiliares construidas por el pipeline con context `ops/`.
- **Persistencia**: PostgreSQL (`src/lib/db.ts`). Notificaciones Teams vía webhooks (`src/lib/teams-notify.ts`).

### Alcance fuera de esta feature (Out of Scope)

- Ejecutar el Explorer contra el entorno de producción del portal.
- Cualquier interacción de escritura/mutación sobre el portal o sus sistemas integrados (GitLab, Jira, Azure AD, AWS, n8n).
- Sustituir las auditorías de rendimiento Lighthouse existentes (synthetics) o los tests unitarios/property del repositorio.
- Corrección automática (auto-fix) de los problemas detectados: el Explorer detecta y propone, no aplica cambios.
- Pruebas de carga o estrés (eso es k6).
- Reentrenar o ajustar (fine-tuning) modelos de Bedrock.

## Glossary

- **Portal**: La aplicación Next.js del Platform Portal sometida a exploración, desplegada en el entorno `portal-dev`.
- **Explorer**: El sistema completo objeto de esta feature, ejecutable como job on-demand y como CronJob, que descubre, navega, captura, analiza y reporta.
- **Target_Environment**: El entorno de despliegue del Portal contra el que el Explorer ejecuta, fijado al entorno de desarrollo (`portal-dev`, namespace `platformportal`).
- **Safety_Guard**: El componente del Explorer que clasifica cada interacción candidata y permite solo las de la Allowlist, bloqueando las de la Blocklist.
- **Allowlist**: El conjunto de interacciones de solo lectura permitidas (navegar a una ruta, leer contenido, abrir paneles/acordeones/tabs/tooltips, paginar lecturas, peticiones HTTP de método seguro GET/HEAD).
- **Blocklist**: El conjunto de interacciones de mutación prohibidas (enviar formularios, peticiones HTTP de métodos POST/PUT/PATCH/DELETE de mutación, y acciones cuyo control o etiqueta indique submit, delete, approve, reject, execute, cancel, create, rotate, modify, sync o equivalentes).
- **Synthetic_Session**: Una sesión de usuario sintética materializada como cookie de sesión NextAuth cifrada (JWE con `NEXTAUTH_SECRET`) para un usuario que no corresponde a una persona real.
- **Auth_Minter**: El componente que genera una Synthetic_Session válida para un Role concreto.
- **Role**: Uno de los roles RBAC del Portal: `admin`, `directores`, `staff`, `desarrolladores`, `externos`.
- **RBAC_Expectation**: La matriz esperada de acceso por Role y por sección, derivada de `SECTION_ACCESS` en `src/lib/rbac.ts`.
- **RBAC_Finding**: Una discrepancia detectada entre el acceso observado para un Role en una ruta y su RBAC_Expectation.
- **Route**: Una dirección navegable del Portal, ya sea una ruta de UI (de `NAV_ITEMS` y sus descendientes alcanzables) o un endpoint de API (`/api/*`).
- **Route_Inventory**: El conjunto de Routes a explorar, compuesto por rutas de UI y endpoints de API descubiertos.
- **Crawler**: El componente del Explorer que visita cada Route bajo una Synthetic_Session y captura evidencia técnica.
- **Visit**: El acto de cargar y observar una Route con un Role concreto, produciendo un Visit_Result.
- **Visit_Result**: El registro de una Visit con su Route, Role, código de estado, latencia, errores de consola, peticiones fallidas, estados de DOM observados y referencia a la captura de pantalla.
- **Console_Error**: Un mensaje de nivel error emitido en la consola JavaScript del navegador durante una Visit.
- **Failed_Request**: Una petición de red iniciada durante una Visit que devuelve un código HTTP 4xx o 5xx o que no completa.
- **DOM_Error_State**: Un estado de error o vacío detectable en el DOM (mensaje de error, página en blanco, estado vacío no esperado, excepción de render).
- **Latency**: El tiempo transcurrido, en milisegundos, entre el inicio de la Visit y el evento de carga estable de la Route.
- **Screenshot**: Una captura de pantalla del estado renderizado de una Route durante una Visit.
- **Anomaly**: Una observación de una Visit clasificada como potencialmente problemática (Console_Error, Failed_Request, DOM_Error_State, Latency por encima del umbral configurado, o RBAC_Finding).
- **Triage_Engine**: El componente que envía cada Anomaly a Bedrock y obtiene un Triage_Result estructurado.
- **Triage_Result**: La salida estructurada de Bedrock para una Anomaly, con los campos: `id`, `route`, `role`, `severity`, `category`, `probable_cause`, `suggested_fix`, `evidence`.
- **Severity**: El nivel de gravedad de una Anomaly, en el conjunto ordenado `{critical, high, medium, low, info}`.
- **Exploration_Run**: Una ejecución completa del Explorer, identificada de forma única, que cubre el Route_Inventory para el conjunto de Roles configurado.
- **Report**: El artefacto estructurado producido por un Exploration_Run, persistido en almacenamiento y exportable como documento Markdown consumible por el asistente.
- **Report_Store**: El almacenamiento persistente de los Reports y sus Exploration_Runs (PostgreSQL y/o S3).
- **Teams_Notifier**: El componente que publica un resumen del Exploration_Run en un canal de Teams vía webhook.
- **Regression**: Una Anomaly presente en el Exploration_Run actual que no estaba presente para la misma Route y Role en el Exploration_Run previo comparable.
- **Bedrock_Budget**: El límite configurable de invocaciones a Bedrock por Exploration_Run.
- **Internal_Secret**: El secreto `INTERNAL_API_SECRET` que el Portal valida en la cabecera `x-internal-secret` para endpoints internos.

## Requirements

### Requisito 1: Seguridad de solo lectura innegociable

**Historia de Usuario:** Como SRE responsable del portal, quiero que el Explorer sea estrictamente de solo lectura y nunca dispare mutaciones, para poder ejecutarlo de forma recurrente sin riesgo de crear infraestructura, solicitudes de acceso o acciones destructivas.

#### Criterios de Aceptación

1. THE Explorer SHALL ejecutar todas sus Visits contra el Target_Environment fijado al entorno de desarrollo del Portal (`portal-dev`, namespace `platformportal`).
2. IF la configuración de ejecución indica una URL base que no corresponde al Target_Environment de desarrollo, THEN THE Explorer SHALL abortar el Exploration_Run antes de realizar ninguna Visit y registrar el motivo del aborto.
3. WHEN el Crawler evalúa una interacción candidata durante una Visit, THE Safety_Guard SHALL permitir la interacción si y solo si pertenece a la Allowlist.
4. IF una interacción candidata pertenece a la Blocklist o no pertenece a la Allowlist, THEN THE Safety_Guard SHALL bloquear la interacción y registrar la interacción bloqueada con su Route y su motivo.
5. THE Crawler SHALL emitir hacia el Portal únicamente peticiones HTTP de método GET o HEAD.
6. IF una Visit requiriese una petición HTTP de método POST, PUT, PATCH o DELETE para progresar, THEN THE Crawler SHALL omitir esa interacción y continuar con la siguiente Visit sin enviarla.
7. WHEN el Crawler encuentra un formulario en una Route, THE Crawler SHALL leer y registrar la presencia y los campos del formulario sin enviarlo.
8. THE Explorer SHALL completar un Exploration_Run sin crear, modificar, aprobar, rechazar, ejecutar, cancelar ni borrar ningún recurso del Portal ni de los sistemas integrados.

### Requisito 2: Sesión sintética multi-rol

**Historia de Usuario:** Como SRE, quiero que el Explorer recorra el portal como cada rol RBAC usando una sesión sintética, para validar la experiencia y los accesos de admin, directores, staff, desarrolladores y externos sin depender de un login OIDC real con MFA.

#### Criterios de Aceptación

1. WHEN el Explorer inicia la exploración para un Role, THE Auth_Minter SHALL generar una Synthetic_Session válida para ese Role como cookie de sesión NextAuth cifrada con `NEXTAUTH_SECRET`.
2. THE Auth_Minter SHALL generar una Synthetic_Session para cada Role del conjunto `{admin, directores, staff, desarrolladores, externos}` configurado para el Exploration_Run.
3. WHEN el Crawler realiza una Visit, THE Crawler SHALL adjuntar la Synthetic_Session correspondiente al Role activo de esa Visit.
4. THE Auth_Minter SHALL marcar la identidad de cada Synthetic_Session como sintética y no correspondiente a una persona real.
5. IF el Auth_Minter no dispone de `NEXTAUTH_SECRET` o no puede generar una Synthetic_Session válida para un Role, THEN THE Explorer SHALL omitir las Visits de ese Role, registrar el motivo y continuar con los Roles restantes.
6. WHEN un Exploration_Run finaliza, THE Explorer SHALL descartar las Synthetic_Sessions generadas sin persistirlas en el Report.

### Requisito 3: Validación de RBAC por rol

**Historia de Usuario:** Como SRE, quiero que el Explorer compruebe que cada rol ve exactamente las secciones que le corresponden, para detectar fugas de acceso o bloqueos indebidos antes de que afecten a usuarios reales.

#### Criterios de Aceptación

1. THE Explorer SHALL derivar la RBAC_Expectation por Role y sección a partir de `SECTION_ACCESS` definido en `src/lib/rbac.ts`.
2. WHEN el Crawler completa una Visit de una Route para un Role, THE Explorer SHALL comparar el acceso observado (concedido o denegado) con la RBAC_Expectation de ese Role para esa Route.
3. IF un Role obtiene acceso a una Route para la que la RBAC_Expectation indica denegación, THEN THE Explorer SHALL registrar un RBAC_Finding de tipo acceso-no-autorizado con Severity mínima `high`.
4. IF un Role obtiene denegación de acceso a una Route para la que la RBAC_Expectation indica concesión, THEN THE Explorer SHALL registrar un RBAC_Finding de tipo acceso-indebidamente-bloqueado.
5. WHEN el Explorer registra un RBAC_Finding, THE Explorer SHALL incluir la Route, el Role, el acceso observado y el acceso esperado.
6. THE Explorer SHALL tratar cada RBAC_Finding como una Anomaly a efectos de triage y reporting.

### Requisito 4: Descubrimiento del inventario de rutas

**Historia de Usuario:** Como SRE, quiero que el Explorer descubra automáticamente las rutas de UI y los endpoints de API del portal, para que la cobertura se mantenga al día sin mantener listas manuales.

#### Criterios de Aceptación

1. THE Crawler SHALL construir el Route_Inventory de rutas de UI a partir de `NAV_ITEMS` de `portal-shell.tsx` y de los enlaces internos del Portal alcanzables desde esas rutas.
2. THE Crawler SHALL incluir en el Route_Inventory los endpoints de API conocidos bajo `/api/*` accesibles mediante método GET.
3. WHEN el Crawler descubre un enlace interno durante una Visit, THE Crawler SHALL añadir la Route destino al Route_Inventory si no estaba presente.
4. THE Crawler SHALL visitar cada Route del Route_Inventory una sola vez por Role en un mismo Exploration_Run.
5. WHERE una Route requiere parámetros de ruta o de consulta para resolverse, THE Crawler SHALL usar valores de ejemplo seguros definidos en la configuración del Exploration_Run sin enviar mutaciones.
6. THE Crawler SHALL excluir del Route_Inventory las URLs externas al dominio del Target_Environment.

### Requisito 5: Captura de evidencia técnica por visita

**Historia de Usuario:** Como SRE, quiero que cada visita capture errores de consola, peticiones fallidas, estados de error del DOM, latencias y capturas de pantalla, para disponer de evidencia técnica suficiente para diagnosticar cada problema.

#### Criterios de Aceptación

1. WHEN el Crawler realiza una Visit, THE Crawler SHALL registrar un Visit_Result con la Route, el Role, el código de estado HTTP de la respuesta principal y la Latency.
2. WHEN durante una Visit la consola JavaScript emite un mensaje de nivel error, THE Crawler SHALL registrar ese Console_Error asociado al Visit_Result.
3. WHEN durante una Visit una petición de red devuelve un código HTTP 4xx o 5xx o no completa, THE Crawler SHALL registrar esa Failed_Request con su URL, método y código asociada al Visit_Result.
4. WHEN durante una Visit el DOM presenta un DOM_Error_State, THE Crawler SHALL registrar ese DOM_Error_State asociado al Visit_Result.
5. WHEN el Crawler completa una Visit, THE Crawler SHALL capturar un Screenshot del estado renderizado y asociar su referencia al Visit_Result.
6. IF la Latency de una Visit supera el umbral de latencia configurable del Exploration_Run, THEN THE Crawler SHALL marcar el Visit_Result como Anomaly de categoría rendimiento.
7. THE Crawler SHALL clasificar como Anomaly todo Visit_Result que contenga al menos un Console_Error, una Failed_Request o un DOM_Error_State.

### Requisito 6: Triage de anomalías con Bedrock

**Historia de Usuario:** Como SRE, quiero que cada anomalía pase por Bedrock para obtener severidad, categoría, causa probable y fix sugerido, para priorizar y resolver los problemas con contexto accionable.

#### Criterios de Aceptación

1. WHEN el Triage_Engine procesa una Anomaly, THE Triage_Engine SHALL invocar Bedrock con la evidencia de la Anomaly y obtener un Triage_Result.
2. THE Triage_Engine SHALL producir cada Triage_Result con los campos `id`, `route`, `role`, `severity`, `category`, `probable_cause`, `suggested_fix` y `evidence`.
3. THE Triage_Engine SHALL asignar a cada Triage_Result un valor de `severity` dentro del conjunto `{critical, high, medium, low, info}`.
4. THE Triage_Engine SHALL enviar a Bedrock únicamente las Anomalies y no los Visit_Results sin anomalía, para acotar el coste.
5. IF la invocación a Bedrock para una Anomaly falla, THEN THE Triage_Engine SHALL conservar la Anomaly con un Triage_Result marcado como triage-no-disponible y continuar con las Anomalies restantes.
6. WHILE el número de invocaciones a Bedrock del Exploration_Run alcanza el Bedrock_Budget, THE Triage_Engine SHALL dejar de invocar Bedrock para nuevas Anomalies y marcarlas como triage-omitido-por-presupuesto.
7. THE Triage_Engine SHALL producir un Triage_Result cuya estructura serializada a JSON y deserializada de nuevo produzca un Triage_Result equivalente (propiedad round-trip).

### Requisito 7: Informe estructurado y notificación

**Historia de Usuario:** Como SRE, quiero un informe estructurado del barrido más un resumen en Teams, para revisar los hallazgos y compartirlos con el equipo, y para que el asistente pueda consumir el contexto completo.

#### Criterios de Aceptación

1. WHEN un Exploration_Run finaliza, THE Explorer SHALL persistir un Report en el Report_Store con el identificador del Exploration_Run, su marca temporal, el conjunto de Roles cubierto y la lista de Triage_Results.
2. THE Explorer SHALL generar el Report como un documento Markdown consumible por el asistente además de su forma estructurada en el Report_Store.
3. THE Report SHALL incluir, para cada Triage_Result, su Route, Role, Severity, categoría, causa probable, fix sugerido y referencia a la evidencia.
4. THE Report SHALL incluir un resumen con el número total de Routes visitadas, el número de Anomalies por Severity y el número de RBAC_Findings.
5. WHEN un Exploration_Run finaliza, THE Teams_Notifier SHALL publicar en el canal de Teams configurado un resumen con el número de Anomalies por Severity y un enlace o referencia al Report.
6. IF la publicación del resumen en Teams falla, THEN THE Explorer SHALL conservar el Report persistido y registrar el fallo de notificación sin descartar el Report.
7. THE Explorer SHALL conservar el histórico de Reports de Exploration_Runs anteriores en el Report_Store para permitir la comparación entre ejecuciones.

### Requisito 8: Detección de regresiones entre ejecuciones

**Historia de Usuario:** Como SRE, quiero ver qué anomalías son nuevas respecto a la ejecución anterior, para distinguir las regresiones recién introducidas de los problemas ya conocidos.

#### Criterios de Aceptación

1. WHEN un Exploration_Run finaliza y existe un Exploration_Run previo comparable, THE Explorer SHALL identificar como Regression cada Anomaly presente en el run actual y ausente para la misma Route y Role en el run previo.
2. THE Explorer SHALL incluir en el Report el conjunto de Regressions identificadas en el Exploration_Run.
3. WHEN no existe un Exploration_Run previo comparable, THE Explorer SHALL tratar todas las Anomalies del run actual como no clasificables como Regression y registrar la ausencia de base de comparación.
4. THE Explorer SHALL determinar la equivalencia entre dos Anomalies de runs distintos a partir de su Route, su Role y su categoría.

### Requisito 9: Ejecución on-demand y programada con coste acotado

**Historia de Usuario:** Como SRE, quiero lanzar el Explorer bajo demanda y también de forma programada, con un coste de Bedrock acotado, para integrarlo en la operativa sin gasto descontrolado.

#### Criterios de Aceptación

1. WHEN un operador invoca el endpoint interno del Explorer con la cabecera `x-internal-secret` válida, THE Explorer SHALL iniciar un Exploration_Run on-demand.
2. IF una invocación al endpoint interno del Explorer no presenta un `x-internal-secret` que coincida con el Internal_Secret, THEN THE Explorer SHALL rechazar la invocación sin iniciar un Exploration_Run.
3. THE Explorer SHALL ser ejecutable como CronJob declarado por GitOps en `generic-chart` siguiendo el patrón de los CronJobs existentes del Portal.
4. THE Explorer SHALL limitar las invocaciones a Bedrock de un Exploration_Run al Bedrock_Budget configurable.
5. WHILE un Exploration_Run está en curso, IF se recibe una nueva invocación de inicio, THEN THE Explorer SHALL no iniciar un segundo Exploration_Run concurrente y SHALL registrar el rechazo del inicio duplicado.

### Requisito 10: Observabilidad, idempotencia y degradación elegante

**Historia de Usuario:** Como SRE, quiero que un fallo en una ruta no aborte el barrido completo y que cada ejecución sea observable e idempotente, para confiar en que el Explorer termina y deja trazas útiles aunque algo falle.

#### Criterios de Aceptación

1. IF una Visit falla con una excepción no controlada, THEN THE Crawler SHALL registrar el fallo asociado a esa Route y Role y continuar con la siguiente Visit sin abortar el Exploration_Run.
2. WHEN un Exploration_Run finaliza, THE Explorer SHALL persistir su estado terminal (completado o completado-con-errores) junto con el Report.
3. THE Explorer SHALL registrar trazas de progreso del Exploration_Run que incluyan el número de Routes visitadas y el número de Anomalies detectadas hasta el momento.
4. WHEN un Exploration_Run se ejecuta dos veces sobre un estado idéntico del Portal, THE Explorer SHALL producir Reports con el mismo conjunto de Routes visitadas y el mismo conjunto de Anomalies detectadas, salvo las marcas temporales y el identificador del run.
5. IF la persistencia de un Visit_Result individual falla, THEN THE Explorer SHALL registrar el fallo de persistencia y continuar el Exploration_Run sin descartar los Visit_Results ya persistidos.
6. THE Explorer SHALL acotar la duración de cada Visit mediante un tiempo máximo configurable y, al superarlo, registrar la Visit como Anomaly de categoría timeout y continuar.
