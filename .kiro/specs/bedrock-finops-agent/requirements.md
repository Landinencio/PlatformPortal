# Documento de Requisitos — Bedrock FinOps Agent

## Introducción

El Platform Portal de IskayPet dispone actualmente de un chatbot FinOps básico que utiliza un enfoque text-to-SQL con la API Converse de Bedrock (modelo Nova Lite). Este enfoque falla frecuentemente, no entiende muchas preguntas y da respuestas inconsistentes. Se requiere reemplazar este chatbot por un **AWS Bedrock Agent** profesional que actúe como asistente FinOps completo, capaz de responder cualquier pregunta sobre costes AWS, recursos, servicios, cuentas, Savings Plans, Reserved Instances, tendencias, anomalías y optimización. El agente debe consultar el CUR (Cost and Usage Report) vía Athena, mantener memoria conversacional multi-turno, y estar integrado en la UI existente del portal. Los datos del CUR comienzan en enero 2025, todos los costes son en USD, y el portal opera sobre 22 cuentas AWS con nombres amigables.

## Glosario

- **Bedrock_Agent**: Agente de AWS Bedrock configurado con instrucciones, action groups y knowledge bases para responder consultas FinOps de forma autónoma
- **Action_Group**: Conjunto de acciones (funciones Lambda o esquemas OpenAPI) que el Bedrock_Agent puede invocar para ejecutar operaciones como consultas SQL contra Athena
- **Knowledge_Base**: Base de conocimiento de Bedrock que almacena documentación FinOps, esquema CUR, mapa de cuentas y mejores prácticas para enriquecer las respuestas del agente
- **CUR**: Cost and Usage Report de AWS, almacenado en Athena (base de datos: athenacurcfn_finnops, tabla: data) con el esquema completo de columnas de facturación
- **Athena_Client**: Módulo del portal que ejecuta queries SQL contra AWS Athena asumiendo el rol cross-account hacia la cuenta CUR (600700800900)
- **Session_Manager**: Componente que gestiona las sesiones de conversación del Bedrock_Agent, permitiendo memoria multi-turno y contexto persistente
- **Chat_API**: Endpoint API del portal (Next.js Route Handler) que recibe mensajes del usuario y los envía al Bedrock_Agent
- **Chat_UI**: Componente React del portal que presenta la interfaz de chat flotante en el workspace FinOps
- **Account_Map**: Diccionario que mapea los 22 IDs de cuentas AWS a nombres amigables (ej: "111222333444" → "Digital Prod")
- **Portal**: Platform Portal de IskayPet, aplicación Next.js desplegada en EKS (cuenta 444455556666)
- **System_Prompt**: Instrucciones del agente que definen su personalidad, conocimiento del esquema CUR, reglas SQL y formato de respuesta

## Requisitos

### Requisito 1: Creación y configuración del Bedrock Agent

**User Story:** Como equipo de plataforma, quiero un Bedrock Agent configurado en AWS con instrucciones FinOps completas, para que el agente pueda responder consultas de costes de forma autónoma y fiable.

#### Criterios de Aceptación

1. THE Bedrock_Agent SHALL estar configurado en la región eu-west-1 con un modelo fundacional de capacidad superior a Nova Lite (Claude 3 Sonnet, Claude 3.5 Sonnet o equivalente)
2. THE Bedrock_Agent SHALL tener un System_Prompt que incluya el esquema completo del CUR, el Account_Map con las 22 cuentas, las reglas SQL obligatorias para Athena/Presto y las instrucciones de formato de respuesta
3. THE Bedrock_Agent SHALL tener al menos un Action_Group que permita ejecutar queries SQL contra Athena a través del Athena_Client
4. WHEN el Bedrock_Agent reciba una pregunta sobre costes, THE Bedrock_Agent SHALL generar y ejecutar la query SQL apropiada sin intervención del usuario
5. THE Bedrock_Agent SHALL filtrar por defecto con `line_item_line_item_type IN ('Usage', 'Tax', 'Fee')` para evitar duplicación de costes por líneas de Savings Plan
6. THE Bedrock_Agent SHALL usar `SUM(line_item_unblended_cost)` como métrica de coste por defecto, consistente con el dashboard del portal

### Requisito 2: Action Group para consultas Athena

**User Story:** Como Bedrock Agent, quiero poder ejecutar queries SQL contra el CUR en Athena, para que pueda obtener datos reales de costes y responder con cifras concretas.

#### Criterios de Aceptación

1. THE Action_Group SHALL exponer una acción que acepte una query SQL como parámetro y la ejecute contra la base de datos athenacurcfn_finnops en Athena
2. THE Action_Group SHALL asumir el rol cross-account `arn:aws:iam::600700800900:role/Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur` para acceder a Athena
3. THE Action_Group SHALL devolver los resultados de la query en formato estructurado (JSON) con un máximo de 50 filas por defecto
4. IF la query SQL falla con un error de Athena, THEN THE Action_Group SHALL devolver el mensaje de error al Bedrock_Agent para que pueda reformular la query
5. THE Action_Group SHALL tener un timeout máximo de 120 segundos para la ejecución de queries
6. THE Action_Group SHALL almacenar los resultados de Athena en `s3://finnops-iskaypet/athena-query-results/`

### Requisito 3: Integración API del portal con Bedrock Agent

**User Story:** Como desarrollador del portal, quiero un endpoint API que conecte la UI de chat con el Bedrock Agent, para que los usuarios puedan interactuar con el agente desde el portal.

#### Criterios de Aceptación

1. THE Chat_API SHALL reemplazar la implementación actual de Converse API por invocaciones al Bedrock_Agent usando el SDK `@aws-sdk/client-bedrock-agent-runtime`
2. THE Chat_API SHALL asumir el rol de Bedrock (`AWS_BEDROCK_ROLE_ARN`) para invocar al agente en eu-west-1
3. WHEN el Chat_API reciba un mensaje del usuario, THE Chat_API SHALL enviarlo al Bedrock_Agent con el sessionId correspondiente para mantener contexto multi-turno
4. THE Chat_API SHALL devolver la respuesta del Bedrock_Agent al frontend en formato JSON con el campo `reply`
5. IF el Bedrock_Agent no responde en 120 segundos, THEN THE Chat_API SHALL devolver un mensaje de error descriptivo al usuario
6. THE Chat_API SHALL requerir autenticación de usuario mediante `requireUserAuth` antes de procesar cualquier mensaje

### Requisito 4: Memoria conversacional multi-turno

**User Story:** Como usuario del portal, quiero que el asistente recuerde el contexto de la conversación, para que pueda hacer preguntas de seguimiento sin repetir información.

#### Criterios de Aceptación

1. THE Session_Manager SHALL generar un sessionId único por conversación de usuario y mantenerlo durante toda la sesión de chat
2. WHEN el usuario envíe un mensaje de seguimiento, THE Bedrock_Agent SHALL tener acceso al historial completo de la conversación actual a través del sessionId
3. WHEN el usuario haga clic en "Nueva conversación" en la Chat_UI, THE Session_Manager SHALL generar un nuevo sessionId, descartando el contexto anterior
4. THE Session_Manager SHALL mantener las sesiones activas durante al menos 30 minutos de inactividad
5. WHEN el usuario pregunte "¿qué me dijiste antes?" o haga referencia a respuestas anteriores, THE Bedrock_Agent SHALL responder con información coherente basada en el historial de la sesión

### Requisito 5: Cobertura de consultas FinOps

**User Story:** Como usuario FinOps, quiero poder preguntar cualquier cosa sobre costes AWS, para que pueda tomar decisiones informadas de optimización.

#### Criterios de Aceptación

1. WHEN el usuario pregunte por costes de una cuenta específica, THE Bedrock_Agent SHALL consultar el CUR filtrando por `line_item_usage_account_id` y responder con cifras en USD redondeadas a 2 decimales
2. WHEN el usuario pregunte por tendencias o evolución, THE Bedrock_Agent SHALL generar queries con agrupación temporal (`date_trunc`) y calcular variaciones porcentuales entre periodos
3. WHEN el usuario pregunte por Savings Plans o Reserved Instances, THE Bedrock_Agent SHALL consultar las columnas `savings_plan_*` o `reservation_*` del CUR y calcular ahorros respecto al precio On-Demand
4. WHEN el usuario pregunte por los recursos más caros, THE Bedrock_Agent SHALL agrupar por `line_item_resource_id` incluyendo servicio y tipo de instancia, filtrando recursos nulos
5. WHEN el usuario pregunte por comparativas entre cuentas, servicios o periodos, THE Bedrock_Agent SHALL generar queries que obtengan datos de ambos elementos y presentar la comparación con diferencias absolutas y porcentuales
6. WHEN el usuario pregunte por anomalías o picos de coste, THE Bedrock_Agent SHALL analizar la variación diaria o semanal e identificar desviaciones significativas respecto a la media del periodo
7. WHEN el usuario haga una pregunta genérica como "¿cómo vamos de costes?", THE Bedrock_Agent SHALL generar un resumen ejecutivo con total del mes, top 5 cuentas, top 5 servicios y tendencia respecto al mes anterior

### Requisito 6: Formato y calidad de respuestas

**User Story:** Como usuario del portal, quiero respuestas claras, bien formateadas y en mi idioma, para que pueda entender rápidamente la información de costes.

#### Criterios de Aceptación

1. THE Bedrock_Agent SHALL responder en el mismo idioma en que el usuario formula la pregunta
2. THE Bedrock_Agent SHALL sustituir todos los IDs de cuenta AWS por nombres amigables del Account_Map en las respuestas
3. THE Bedrock_Agent SHALL sustituir ARNs largos por el nombre corto del recurso (última parte del ARN) en las respuestas
4. WHEN el Bedrock_Agent presente rankings de hasta 5 elementos, THE Bedrock_Agent SHALL usar listas numeradas con emoji; para más de 5 elementos, THE Bedrock_Agent SHALL usar tablas markdown con máximo 4 columnas
5. THE Bedrock_Agent SHALL mostrar costes con formato `$X,XXX.XX` (USD) con 2 decimales
6. THE Bedrock_Agent SHALL indicar en cada respuesta qué tipo de coste muestra: "(coste bruto)" o "(coste neto post-partner)"
7. WHEN el Bedrock_Agent detecte datos interesantes como picos, anomalías o tendencias, THE Bedrock_Agent SHALL mencionarlos proactivamente en la respuesta
8. THE Bedrock_Agent SHALL omitir la query SQL en la respuesta final al usuario

### Requisito 7: Enriquecimiento con contexto del portal

**User Story:** Como usuario del portal, quiero que el asistente tenga acceso al contexto adicional almacenado en la base de datos del portal, para que sus respuestas sean más completas y relevantes.

#### Criterios de Aceptación

1. WHEN se inicie una sesión de chat, THE Chat_API SHALL cargar el contexto FinOps más reciente de la base de datos PostgreSQL del portal (snapshots diarios, inventario, oportunidades de ahorro)
2. THE Bedrock_Agent SHALL tener acceso al último análisis del FinOps Advisor (tabla `finops_advisor_jobs`) para enriquecer sus recomendaciones de optimización
3. THE Bedrock_Agent SHALL tener acceso al inventario de recursos (EC2 running/stopped, RDS, S3, Lambda, EBS sin adjuntar) para contextualizar respuestas sobre recursos
4. IF no hay datos de contexto disponibles en la base de datos del portal, THEN THE Bedrock_Agent SHALL responder basándose exclusivamente en queries directas al CUR

### Requisito 8: Actualización de la interfaz de chat

**User Story:** Como usuario del portal, quiero que la interfaz de chat existente funcione con el nuevo Bedrock Agent sin perder funcionalidad, para que la transición sea transparente.

#### Criterios de Aceptación

1. THE Chat_UI SHALL mantener el diseño actual del panel flotante (botón en esquina inferior derecha, panel de 460x620px con header, mensajes y input)
2. THE Chat_UI SHALL enviar mensajes al nuevo endpoint del Chat_API que invoca al Bedrock_Agent en lugar de la API Converse directa
3. THE Chat_UI SHALL gestionar el sessionId de la conversación, generando uno nuevo al abrir el chat o al hacer clic en "Nueva conversación"
4. THE Chat_UI SHALL mantener las preguntas rápidas predefinidas (resumen de costes, top cuentas, top recursos, evolución mensual, ahorro con SP, comparativa mes anterior)
5. THE Chat_UI SHALL mostrar un indicador de carga mientras el Bedrock_Agent procesa la consulta
6. THE Chat_UI SHALL seguir siendo accesible solo para usuarios con rol "admin"
7. THE Chat_UI SHALL renderizar las respuestas en markdown con soporte para tablas, listas, código y emojis, manteniendo los estilos actuales

### Requisito 9: Gestión de errores y resiliencia

**User Story:** Como usuario del portal, quiero que el asistente maneje errores de forma elegante, para que siempre reciba una respuesta útil incluso cuando algo falle.

#### Criterios de Aceptación

1. IF una query de Athena falla, THEN THE Bedrock_Agent SHALL intentar reformular la query corrigiendo el error hasta un máximo de 2 reintentos
2. IF todos los reintentos de query fallan, THEN THE Bedrock_Agent SHALL responder al usuario explicando que no pudo obtener los datos y sugiriendo reformular la pregunta
3. IF el Bedrock_Agent no puede asumir el rol cross-account, THEN THE Chat_API SHALL devolver un mensaje de error indicando un problema de conectividad temporal
4. IF el usuario pregunta por un periodo sin datos (anterior a enero 2025), THEN THE Bedrock_Agent SHALL informar que los datos del CUR comienzan en enero 2025 y sugerir un periodo válido
5. IF la respuesta del Bedrock_Agent está vacía o es inválida, THEN THE Chat_API SHALL devolver un mensaje genérico de error al usuario

### Requisito 10: Seguridad y control de acceso

**User Story:** Como equipo de seguridad, quiero que el acceso al agente FinOps esté controlado y sea seguro, para que solo usuarios autorizados puedan consultar datos de costes.

#### Criterios de Aceptación

1. THE Chat_API SHALL validar la autenticación del usuario mediante `requireUserAuth` antes de enviar cualquier mensaje al Bedrock_Agent
2. THE Chat_UI SHALL renderizar el componente de chat solo para usuarios con rol "admin"
3. THE Action_Group SHALL usar credenciales temporales (AssumeRole con duración máxima de 900 segundos) para acceder a Athena y Bedrock
4. THE Chat_API SHALL no registrar en logs el contenido completo de las queries SQL ni los resultados de Athena en producción, limitándose a metadatos (número de filas, tiempo de ejecución)
5. THE Bedrock_Agent SHALL rechazar consultas que intenten modificar datos (INSERT, UPDATE, DELETE, DROP) y solo permitir operaciones SELECT de lectura

### Requisito 11: Infraestructura como código del Bedrock Agent

**User Story:** Como equipo de plataforma, quiero que la configuración del Bedrock Agent esté definida como código, para que sea reproducible, versionable y desplegable de forma automatizada.

#### Criterios de Aceptación

1. THE Portal SHALL incluir la definición del Bedrock_Agent en archivos de infraestructura como código (CloudFormation, CDK o Terraform) dentro del repositorio
2. THE definición de infraestructura SHALL incluir: el agente, el action group con su esquema OpenAPI, el rol IAM del agente, y la configuración del modelo fundacional
3. THE definición de infraestructura SHALL parametrizar el ID del modelo, la región, los ARNs de roles cross-account y el nombre de la base de datos Athena como variables configurables
4. WHEN se despliegue la infraestructura, THE Bedrock_Agent SHALL quedar operativo y accesible desde el portal sin configuración manual adicional

### Requisito 12: Extensibilidad para dominios futuros

**User Story:** Como equipo de plataforma, quiero que la arquitectura del agente sea extensible, para que en el futuro pueda cubrir otros dominios como DORA metrics, infraestructura y monitorización.

#### Criterios de Aceptación

1. THE Bedrock_Agent SHALL estar diseñado con action groups modulares, de forma que se puedan añadir nuevos action groups para dominios adicionales (DORA, infraestructura, monitorización) sin modificar los existentes
2. THE Chat_API SHALL abstraer la invocación al Bedrock_Agent de forma que el mismo endpoint pueda servir a diferentes contextos del portal (FinOps, DORA, infraestructura) mediante parámetros de configuración
3. THE System_Prompt SHALL estar estructurado en secciones claramente separadas (identidad, esquema de datos, reglas, formato) para facilitar la adición de nuevos dominios de conocimiento
