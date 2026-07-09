# Requirements Document

## Introduction

Esta funcionalidad traslada los dashboards de analítica de uso de Kiro IDE —hoy en una aplicación standalone (repo `kiro-analytics-dashboard`, React + Vite + AWS Amplify Hosting con autenticación Cognito)— al portal de ingeniería `platformportal` (Next.js 14 App Router). El objetivo es ofrecer las mismas vistas analíticas (Overview, AI Insights y, opcionalmente, User Activity) reutilizando los patrones del portal: shadcn/ui + Tailwind, tema claro/oscuro, Recharts, sidebar de navegación con RBAC (next-auth/Azure AD), i18n en 4 idiomas, caché por dominio y acceso a Athena vía AssumeRole.

La migración elimina la dependencia de Cognito y de Amplify Hosting: los dashboards quedan protegidos por la sesión next-auth del portal y por el RBAC de secciones. Los datos siguen residiendo en Athena (base `kiro_analytics`, workgroup `kiro-analytics`) en la cuenta tooling (444455556666), consultados desde el portal con un cliente análogo a `athena-cur.ts` / `kiro-licenses.ts`.

Este documento se centra en historias de usuario y criterios de aceptación en formato EARS, sin prescribir detalles de implementación de bajo nivel. Varios puntos de decisión se recogen explícitamente en la sección "Decisiones pendientes".

## Glossary

- **Kiro_Analytics**: El conjunto de dashboards analíticos de uso de Kiro IDE migrados al portal, accesibles bajo una ruta del portal (p.ej. `/kiro-analytics`).
- **Portal**: La aplicación `platformportal` (Next.js 14 App Router) destino de la migración.
- **Overview_Dashboard**: La vista de resumen ejecutivo de uso (KPIs y tendencias agregadas) de Kiro_Analytics.
- **AI_Insights_Dashboard**: La vista de analítica de prompts clasificados y sesiones de IA de Kiro_Analytics.
- **User_Activity_Dashboard**: La vista detallada de actividad por usuario de Kiro_Analytics (página implementada en el origen pero no enrutada).
- **Kiro_Analytics_API**: El conjunto de rutas internas del Portal (`src/app/api/kiro-analytics/.../route.ts`) que sirven datos a los dashboards de Kiro_Analytics.
- **Kiro_Athena_Client**: El módulo de servidor del Portal que ejecuta consultas contra la base Athena `kiro_analytics` mediante AssumeRole, análogo a `athena-cur.ts`.
- **Athena_Dataset**: La base de datos Athena `kiro_analytics` (workgroup `kiro-analytics`), con las tablas `user_activity_raw`, `classified_prompts`, `classified_sessions` y `user_metadata`.
- **Identity_Store**: El AWS IAM Identity Store `d-93670801b4` (cuenta root 600700800900) que resuelve `user_id` a email, nombre y grupo, vía el patrón ya usado en `kiro-licenses.ts`.
- **RBAC**: El control de acceso por roles del Portal definido en `src/lib/rbac.ts` (jerarquía `admin > directores > staff > desarrolladores > externos`) y `SECTION_ACCESS`.
- **Minimum_Role**: El rol mínimo requerido para acceder a la sección Kiro_Analytics, configurado en `NAV_ITEMS` y `SECTION_ACCESS`.
- **User_Filter**: El control de UI que filtra los widgets por uno o varios usuarios de Kiro.
- **Date_Range**: El rango de fechas (`startDate`/`endDate`) aplicado a los widgets del Overview_Dashboard.
- **Session_User**: El usuario autenticado en el Portal mediante next-auth (Azure AD).
- **Classified_Prompt**: Un registro de la tabla `classified_prompts` con metadatos de clasificación IA (work_type, intent, category, complexity, specificity) y, potencialmente, texto del prompt.
- **WAU**: Weekly Active Users (usuarios activos semanales).

## Requirements

### Requirement 1: Acceso y autorización vía RBAC del portal

**User Story:** Como ingeniero de plataforma, quiero acceder a los dashboards de Kiro dentro del portal usando mi sesión corporativa, para no depender de Cognito ni de credenciales separadas.

#### Acceptance Criteria

1. THE Kiro_Analytics SHALL authenticate users exclusively through the Portal next-auth session, without using AWS Cognito.
2. WHILE a request lacks a valid Portal session, THE Portal SHALL redirect the request to the Portal login flow before rendering Kiro_Analytics.
3. WHERE the Session_User role is below the configured Minimum_Role, THE Portal SHALL deny access to the Kiro_Analytics section.
4. WHEN the Kiro_Analytics_API receives a request from a Session_User whose role is below the Minimum_Role, THE Kiro_Analytics_API SHALL respond with HTTP status 403.
5. WHERE the Session_User role is at or above the Minimum_Role, THE Portal SHALL display the Kiro_Analytics navigation entry in the sidebar.

### Requirement 2: Navegación e integración en el portal

**User Story:** Como usuario del portal, quiero encontrar Kiro Analytics en el menú de navegación, para acceder a los dashboards desde la misma estructura que el resto de secciones.

#### Acceptance Criteria

1. THE Portal SHALL register a Kiro_Analytics navigation entry in `NAV_ITEMS` with a `sectionKey`, a `minimumRole`, and a localized label key.
2. THE Portal SHALL register a corresponding section in `SECTION_ACCESS` listing the roles that match the Minimum_Role policy.
3. WHEN the Session_User selects the Kiro_Analytics navigation entry, THE Portal SHALL route to the Kiro_Analytics page under the App Router (`src/app/kiro-analytics/`).
4. THE Kiro_Analytics SHALL render within the existing Portal shell (sidebar, header, theme toggle, language selector) without introducing Amplify-specific layout or styling.

### Requirement 3: Acceso a datos de Athena `kiro_analytics`

**User Story:** Como responsable de datos, quiero que el portal consulte la base Athena `kiro_analytics` de forma segura, para mantener una única vía de acceso controlada por IAM.

#### Acceptance Criteria

1. THE Kiro_Athena_Client SHALL query the Athena_Dataset using an AssumeRole credential chain, following the pattern established in `athena-cur.ts`.
2. THE Kiro_Athena_Client SHALL read the target role ARN, Athena workgroup, database name, region, and S3 output location from environment variables.
3. WHEN a Kiro_Analytics_API endpoint requests data, THE Kiro_Athena_Client SHALL execute the corresponding Athena query against workgroup `kiro-analytics` and database `kiro_analytics`.
4. IF an Athena query fails or times out, THEN THE Kiro_Analytics_API SHALL respond with an error status and a descriptive error message, without exposing raw query internals or credentials.
5. THE Kiro_Analytics_API SHALL exclude AWS credentials, role ARNs, and raw query internals from all responses, regardless of whether the query succeeds or fails.
6. THE Kiro_Athena_Client SHALL run as a top-level server module import, compatible with the Next.js `standalone` output.

### Requirement 4: Saneado del filtro de usuarios

**User Story:** Como responsable de seguridad, quiero que los identificadores de usuario usados para filtrar se validen, para evitar inyección en las consultas Athena.

#### Acceptance Criteria

1. WHEN a Kiro_Analytics_API endpoint receives a user identifier filter value, THE Kiro_Analytics_API SHALL accept the value only if it matches the pattern `^[0-9a-fA-F-]+$`.
2. IF a user identifier filter value does not match the pattern `^[0-9a-fA-F-]+$`, THEN THE Kiro_Analytics_API SHALL reject the request with HTTP status 400.
3. WHEN constructing an Athena query that includes user-supplied date values, THE Kiro_Analytics_API SHALL validate each date against the `YYYY-MM-DD` format before query construction.
4. IF a supplied date value does not match the `YYYY-MM-DD` format, THEN THE Kiro_Analytics_API SHALL reject the request with HTTP status 400.

### Requirement 5: Overview Dashboard (KPIs y tendencias de uso)

**User Story:** Como manager de ingeniería, quiero un resumen de adopción de Kiro, para evaluar el uso global y el ahorro estimado.

#### Acceptance Criteria

1. THE Overview_Dashboard SHALL display the following KPI values for the selected Date_Range: weekly active users, total unique users, total prompts, AI-generated lines of code, chat messages, estimated hours saved, and estimated monetary savings.
2. THE Overview_Dashboard SHALL compute estimated monetary savings as estimated hours saved multiplied by a configurable hourly rate, defaulting to 26 euros per hour.
3. WHEN the Session_User changes the Date_Range, THE Overview_Dashboard SHALL refresh all displayed widgets to reflect the selected `startDate` and `endDate`.
4. WHEN the Session_User applies a User_Filter selection, THE Overview_Dashboard SHALL refresh the affected widgets to reflect the selected users.
5. WHILE Overview_Dashboard data is loading, THE Overview_Dashboard SHALL display a loading state for each pending widget.
6. IF an Overview_Dashboard data request returns no records for the selected filters, THEN THE Overview_Dashboard SHALL display an empty-state message for the affected widget.

### Requirement 6: AI Insights Dashboard (prompts clasificados y sesiones)

**User Story:** Como analista, quiero ver la clasificación de prompts y las métricas de sesiones de IA, para entender cómo se usa Kiro.

#### Acceptance Criteria

1. THE AI_Insights_Dashboard SHALL display the following KPI values: weekly active users, unique chat users, total prompts, total sessions, and average session duration.
2. THE AI_Insights_Dashboard SHALL display trend charts for weekly active users, weekly AI lines of code, prompts per session, and 90-day daily usage.
3. THE AI_Insights_Dashboard SHALL display distribution charts for feature adoption, work type, intent, category, complexity, and specificity.
4. THE AI_Insights_Dashboard SHALL display a paginated table of Classified_Prompt records.
5. WHEN the Session_User changes the page of the Classified_Prompt table, THE AI_Insights_Dashboard SHALL load and display the corresponding page of records.
6. WHEN the Session_User applies a User_Filter selection, THE AI_Insights_Dashboard SHALL refresh the affected widgets to reflect the selected users.

### Requirement 7: User Activity Dashboard

**User Story:** Como manager, quiero ver la actividad detallada por usuario, para identificar adopción individual y equipos.

#### Acceptance Criteria

1. WHERE the User_Activity_Dashboard is enabled by the migration scope decision, THE Kiro_Analytics SHALL expose a User Activity view accessible from the Kiro_Analytics navigation.
2. THE User_Activity_Dashboard SHALL display per-user activity metrics, including activity by group and ranking by code contribution.
3. WHEN the Session_User applies a User_Filter selection, THE User_Activity_Dashboard SHALL refresh the displayed metrics to reflect the selected users.

### Requirement 8: Filtro de usuarios y resolución de identidad

**User Story:** Como usuario, quiero filtrar los dashboards por persona y ver nombres legibles en lugar de identificadores, para interpretar los datos con facilidad.

#### Acceptance Criteria

1. THE User_Filter SHALL present the list of Kiro users available for selection, retrieved from the `/users` data source.
2. WHEN the Kiro_Analytics displays a user identity, THE Kiro_Analytics SHALL resolve the Kiro `user_id` to a display name and email using the Identity_Store resolution pattern established in `kiro-licenses.ts`.
3. IF a Kiro `user_id` cannot be resolved to a display name (resolution fails or returns no match), THEN THE Kiro_Analytics SHALL display the raw `user_id` as a fallback label.
4. WHEN the Session_User clears the User_Filter selection, THE Kiro_Analytics SHALL display data aggregated across all users.

### Requirement 9: Reutilización de componentes de UI del portal

**User Story:** Como mantenedor del portal, quiero que los dashboards usen los componentes visuales existentes, para conservar coherencia visual y evitar arrastrar el CSS de Amplify.

#### Acceptance Criteria

1. THE Kiro_Analytics SHALL render statistic cards, donut charts, trend charts, ranking charts, bar charts, and data tables using the Portal's shadcn/ui and Recharts component patterns.
2. THE Kiro_Analytics SHALL respect the Portal's light and dark theme via the existing theme mechanism.
3. THE Kiro_Analytics SHALL NOT introduce AWS Amplify UI dependencies or Amplify-specific styling into the Portal.

### Requirement 10: Internacionalización (i18n)

**User Story:** Como usuario internacional, quiero ver la interfaz de Kiro Analytics en mi idioma, para entender las métricas en mi lengua.

#### Acceptance Criteria

1. THE Kiro_Analytics SHALL render user-facing labels, headings, and explanatory text through the Portal i18n mechanism (`src/lib/i18n.tsx`).
2. THE Kiro_Analytics SHALL provide translation entries for the four supported locales: English, Spanish, French, and Portuguese.
3. WHEN the Session_User changes the active locale, THE Kiro_Analytics SHALL display its labels in the selected locale.

### Requirement 11: Caché de consultas

**User Story:** Como operador del portal, quiero que las consultas costosas a Athena se cacheen, para reducir latencia y coste de consulta.

#### Acceptance Criteria

1. THE Kiro_Analytics_API SHALL cache Athena query results using the Portal cache (`src/lib/cache.ts`) under a dedicated `kiro-analytics` cache prefix.
2. THE Kiro_Analytics_API SHALL build cache keys that incorporate the User_Filter selection and Date_Range so that distinct filter combinations are cached separately.
3. WHILE a cached result for a given filter combination is valid, THE Kiro_Analytics_API SHALL return the cached result without re-executing the Athena query.

### Requirement 12: Privacidad del contenido de prompts

**User Story:** Como responsable de privacidad, quiero controlar si se muestra el texto de los prompts clasificados, para evitar exponer información sensible de productividad por persona.

#### Acceptance Criteria

1. WHERE the prompt-content privacy decision is to hide prompt text, THE AI_Insights_Dashboard SHALL display only classification metadata for each Classified_Prompt and SHALL omit the raw prompt text.
2. WHERE the prompt-content privacy decision is to show prompt text, THE AI_Insights_Dashboard SHALL display the prompt text only to Session_Users at or above the configured Minimum_Role for prompt content.
3. THE Kiro_Analytics SHALL exclude raw prompt text from cache keys and from error messages.

### Requirement 13: Paridad funcional de endpoints

**User Story:** Como usuario de los dashboards actuales, quiero que las vistas migradas muestren los mismos datos, para no perder información en la migración.

#### Acceptance Criteria

1. THE Kiro_Analytics_API SHALL provide data endpoints equivalent to the origin application's `/api/overview`, `/api/user-activity` family, `/api/classified` family, and `/api/users` endpoints required by the migrated dashboards.
2. WHEN a migrated dashboard requests a metric that the origin application displayed, THE Kiro_Analytics_API SHALL return data of equivalent meaning for the same filter inputs.
3. IF a Kiro_Analytics_API endpoint depends on the optional `user_metadata` table and that table is unavailable, THEN THE Kiro_Analytics_API SHALL fall back to Identity_Store resolution and continue serving the request.
4. IF both the `user_metadata` table and Identity_Store resolution are unavailable, THEN THE Kiro_Analytics_API SHALL respond with an error status rather than serving data without user identity information.

## Decisiones pendientes (a confirmar antes del diseño)

Estos puntos afectan a varios criterios de aceptación y deben confirmarse con el usuario. Las suposiciones por defecto se indican entre paréntesis.

1. **Rol mínimo de acceso (Requirement 1, 2, 12):** ¿Quién puede ver Kiro_Analytics? Los datos incluyen productividad por persona (potencialmente sensible). Opciones: `desarrolladores+`, `staff+`, o solo `admin`/`directores`. (Suposición por defecto: `directores+` por sensibilidad de datos por persona; el contenido de prompts, si se muestra, restringido a `admin`.)
2. **Alcance de vistas migradas (Requirement 7):** ¿Se portan solo Overview + AI Insights, o también User Activity? (Suposición por defecto: portar las tres, con User Activity tras un flag de alcance.)
3. **Acceso a Athena tooling/región (Requirement 3):** ¿Rol nuevo de AssumeRole en la cuenta tooling 444455556666? ¿Región final eu-central-1 o se migra a eu-west-1? ¿Nombres de variables de entorno y secreto? (Suposición por defecto: nuevo rol dedicado + variables `KIRO_ATHENA_*`, región a confirmar.)
4. **Privacidad de prompts (Requirement 12):** ¿Se muestra el texto del prompt o solo metadatos de clasificación? (Suposición por defecto: solo metadatos; texto del prompt oculto.)
5. **Tasa horaria de ahorro (Requirement 5):** ¿26 €/h fijo o configurable? (Suposición por defecto: configurable vía variable de entorno, valor por defecto 26 €/h.)
