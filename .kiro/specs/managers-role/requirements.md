# Requirements Document

## Introduction

Este documento especifica la introducción de un nuevo rol RBAC llamado `managers` en el Platform Portal (Next.js 14, TypeScript). El portal deriva los roles de un usuario del claim `roles` del JWT de Azure AD, que a su vez proviene de los `appRoles` de la Enterprise App "PlatformPortal". El helper `resolveAppRole` en `src/lib/rbac.ts` selecciona el rol de mayor prioridad según el mapa lineal `ROLE_PRIORITY`.

El objetivo de negocio es dar a los managers (los aprobadores operativos de hoy) exactamente la capacidad de un `staff` MÁS acceso a Kiro Analytics MÁS visibilidad del buzón de aprobaciones (`/infra-requests`), sin concederles el panel de administración ni ninguna otra capacidad exclusiva de `directores`. En concreto, la capacidad de **aprobar** solicitudes NO se concede por rol: sigue gobernada por las listas de aprobadores por email/equipo (`src/lib/team-approvers.ts`, `src/lib/infra-approvers.ts`); el rol `managers` solo aporta la **visibilidad** del buzón.

La feature abarca dos planos: (1) el aprovisionamiento en Azure AD (nueva security group, nuevo appRole, asignación) y (2) los cambios en el código del portal (tipo de rol, jerarquía, aliases, mapa de secciones, gates de Kiro Analytics, navegación, tarjetas de home, fixtures de tests del AI Portal Explorer, e i18n).

La jerarquía decidida inserta `managers` entre `staff` y `directores`, con la renumeración `externos(1) < desarrolladores(2) < staff(3) < managers(4) < directores(5) < admin(6)`.

## Glossary

- **Portal**: la aplicación Platform Portal (Next.js 14 App Router), objeto de esta especificación.
- **AppRole**: el tipo unión de TypeScript en `src/lib/rbac.ts` que enumera los roles RBAC válidos del Portal. Hoy: `admin`, `directores`, `staff`, `desarrolladores`, `externos`.
- **Rol `managers`**: el nuevo AppRole introducido por esta feature.
- **ROLE_PRIORITY**: el mapa en `src/lib/rbac.ts` que asigna a cada AppRole un entero de prioridad; a mayor número, mayor acceso. Define la jerarquía lineal de roles.
- **ROLE_ALIASES**: el mapa en `src/lib/rbac.ts` que traduce valores de rol de Azure AD (y aliases legacy) a un AppRole.
- **resolveAppRole**: función pura en `src/lib/rbac.ts` que, dado el array de roles crudos del JWT, devuelve el AppRole de mayor prioridad presente (o `externos` si no hay ninguno reconocido).
- **hasMinimumRole**: función pura en `src/lib/rbac.ts` que devuelve verdadero si la prioridad de un rol es mayor o igual que la de un rol mínimo requerido. Base del modelo de acceso por rol mínimo.
- **SECTION_ACCESS**: el mapa en `src/lib/rbac.ts` que asocia cada `PortalSection` con la lista de AppRoles que pueden acceder a esa sección. Base del modelo de acceso por sección.
- **canAccessSection**: función pura y total en `src/lib/rbac.ts` que indica si un rol puede acceder a una sección concreta según `SECTION_ACCESS`.
- **PortalSection**: el tipo unión de secciones del Portal (p.ej. `home`, `metrics`, `finops`, `create-infra`, `access-management`, `incidents`, `requests`, `sonarqube`, `synthetics`, `infra-requests`, `kiro-analytics`, `admin`).
- **Modelo de acceso por sección**: el mecanismo de control basado en `SECTION_ACCESS` + `canAccessSection`, usado por la navegación (`src/components/portal-shell.tsx`), las tarjetas de home (`src/app/page.tsx`) y el `rbac-validator.ts` del AI Portal Explorer.
- **Modelo de acceso por rol mínimo**: el mecanismo de control basado en `hasMinimumRole`, usado por `middleware.ts` (`ROLE_RULES` para páginas y `API_ROLE_RULES` para APIs) y por los gates de Kiro Analytics.
- **Kiro Analytics**: la sección `/kiro-analytics` del Portal, hoy protegida por rol mínimo `directores` en la página (`src/app/kiro-analytics/page.tsx`), en la API (`src/app/api/kiro-analytics/_shared.ts`), en `middleware.ts` y en el ítem de navegación.
- **Buzón de aprobaciones**: la página `/infra-requests` del Portal, que lista solicitudes de infra y acceso; su sección es `SECTION_ACCESS["infra-requests"]` y su acceso en navegación es el ítem `notifications`.
- **Listas de aprobadores**: las listas por email/equipo en `src/lib/team-approvers.ts` e `src/lib/infra-approvers.ts`, con los helpers `isApprover`, `isTeamApprover` y `teamsApprovedBy`, que gobiernan quién puede aprobar solicitudes.
- **Enterprise App "PlatformPortal"**: la aplicación empresarial de Azure AD (appId `ac7af294-f64a-4345-924b-5bfc652b639d`, tenant `19e73cc9-78d1-4540-862c-5a89572ef80e`) cuyos `appRoles` originan el claim `roles` del JWT.
- **Security group `platformmanagers-analytics`**: la nueva security group de Azure AD que se asigna al nuevo appRole `managers`. Debe ser distinta de la group existente `platformmanagers` (que mapea a `directores`).
- **appRole `managers`**: el nuevo appRole con `value` exactamente `managers` sobre la Enterprise App "PlatformPortal".
- **ALL_APP_ROLES**: la constante en `src/lib/explorer/__tests__/arbitraries.ts` que enumera todos los AppRoles y debe ser espejo exacto de `AppRole`.
- **Operador**: persona del equipo SRE/Platform que realiza el aprovisionamiento en Azure AD y la gestión de miembros de la security group.
- **Rol staff-equivalente**: el conjunto de secciones accesibles hoy por `staff`: `home`, `metrics`, `finops`, `create-infra`, `access-management`, `incidents`, `requests`, `sonarqube`, `synthetics`.

## Requirements

### Requirement 1: Definición del rol y jerarquía

**User Story:** Como ingeniero de plataforma, quiero un nuevo rol `managers` situado entre `staff` y `directores`, para que los managers hereden los gates de rol mínimo de nivel staff y superen el gate de Kiro Analytics sin obtener capacidades de administración.

#### Acceptance Criteria

1. THE Portal SHALL incluir el valor `managers` en el tipo `AppRole` de `src/lib/rbac.ts`.
2. THE Portal SHALL asignar en `ROLE_PRIORITY` las prioridades `externos=1`, `desarrolladores=2`, `staff=3`, `managers=4`, `directores=5`, `admin=6`.
3. THE Portal SHALL mapear en `ROLE_ALIASES` el valor `managers` (normalizado a minúsculas) al AppRole `managers`.
4. WHEN el claim `roles` del JWT contiene de forma explícita el valor `managers` y ningún rol de prioridad superior, THE Portal SHALL resolver el AppRole del usuario como `managers` mediante `resolveAppRole`; en ausencia explícita del valor `managers`, `resolveAppRole` SHALL aplicar la resolución normal por prioridad máxima (o `externos` si no hay rol reconocido).
5. WHEN se evalúa `hasMinimumRole(managers, staff)`, THE Portal SHALL devolver verdadero.
6. WHEN se evalúa `hasMinimumRole(managers, directores)`, THE Portal SHALL devolver falso.
7. WHEN se evalúa `hasMinimumRole(directores, managers)` o `hasMinimumRole(admin, managers)`, THE Portal SHALL devolver verdadero.
8. WHEN se evalúa `hasMinimumRole(staff, managers)` o `hasMinimumRole(desarrolladores, managers)` o `hasMinimumRole(externos, managers)`, THE Portal SHALL devolver falso.

### Requirement 2: Aprovisionamiento en Azure AD

**User Story:** Como operador, quiero aprovisionar el rol `managers` en Azure AD desde cero, para que los usuarios miembros de la nueva security group reciban el claim de rol `managers` al iniciar sesión en el Portal.

#### Acceptance Criteria

1. THE Operador SHALL crear un appRole con `value` exactamente `managers` sobre la Enterprise App "PlatformPortal" (appId `ac7af294-f64a-4345-924b-5bfc652b639d`).
2. THE Operador SHALL crear una security group de Azure AD con nombre exactamente `platformmanagers-analytics`.
3. THE Operador SHALL asignar la security group `platformmanagers-analytics` al appRole `managers` de la Enterprise App "PlatformPortal".
4. THE Operador SHALL poblar la membresía de la security group `platformmanagers-analytics` con los usuarios aprobadores actuales.
5. THE Operador SHALL crear `platformmanagers-analytics` de forma independiente e incondicional, sin colisionar con ni modificar la security group existente `platformmanagers` ni su asignación al appRole `directores`.
6. WHEN un usuario miembro de `platformmanagers-analytics` inicia sesión, THE Portal SHALL recibir el valor `managers` en el claim `roles` del JWT.

### Requirement 3: Acceso por sección del rol managers

**User Story:** Como manager, quiero acceder a las mismas secciones que un staff más Kiro Analytics y el buzón de aprobaciones, para poder desempeñar mis funciones operativas sin acceso de administración.

#### Acceptance Criteria

1. THE Portal SHALL incluir `managers` en las listas de `SECTION_ACCESS` de las secciones `home`, `metrics`, `finops`, `create-infra`, `access-management`, `incidents`, `requests`, `sonarqube` y `synthetics`.
2. THE Portal SHALL incluir `managers` en la lista de `SECTION_ACCESS` de la sección `kiro-analytics`.
3. THE Portal SHALL incluir `managers` en la lista de `SECTION_ACCESS` de la sección `infra-requests`.
4. THE Portal SHALL excluir `managers` de la lista de `SECTION_ACCESS` de la sección `admin`.
5. WHEN se evalúa `canAccessSection(managers, s)` para CADA sección `s` del conjunto rol staff-equivalente más `kiro-analytics` más `infra-requests`, THE Portal SHALL devolver verdadero para todas ellas (todas, no alguna).
6. WHEN se evalúa `canAccessSection(managers, "admin")`, THE Portal SHALL devolver falso.
7. THE conjunto de secciones devuelto por `getAccessibleSections(managers)` SHALL ser exactamente igual al de `staff` más `kiro-analytics` más `infra-requests`.

### Requirement 4: Cambio del gate de Kiro Analytics de directores a managers

**User Story:** Como ingeniero de plataforma, quiero que el gate de rol mínimo de Kiro Analytics pase de `directores` a `managers`, para que los roles `managers`, `directores` y `admin` accedan y `staff` no.

#### Acceptance Criteria

1. THE Portal SHALL fijar el rol mínimo de la página `src/app/kiro-analytics/page.tsx` a `managers`.
2. THE Portal SHALL fijar la constante `KIRO_ANALYTICS_MIN_ROLE` de `src/app/api/kiro-analytics/_shared.ts` a `managers`.
3. THE Portal SHALL fijar la regla de `ROLE_RULES` de `middleware.ts` para el prefijo `/kiro-analytics` a rol mínimo `managers`.
4. THE Portal SHALL fijar la regla de `API_ROLE_RULES` de `middleware.ts` para el prefijo `/api/kiro-analytics` a rol mínimo `managers`.
5. WHEN un usuario con rol `managers`, `directores` o `admin` solicita `/kiro-analytics` o cualquier endpoint bajo `/api/kiro-analytics`, THE Portal SHALL permitir el acceso.
6. IF un usuario con rol `staff`, `desarrolladores` o `externos` solicita `/kiro-analytics`, THEN THE Portal SHALL redirigir a la home con el parámetro de acceso denegado.
7. IF un usuario con rol `staff`, `desarrolladores` o `externos` solicita un endpoint bajo `/api/kiro-analytics`, THEN THE Portal SHALL responder con estado 403.

### Requirement 5: Separación entre visibilidad del buzón y capacidad de aprobación

**User Story:** Como responsable de seguridad, quiero que el rol `managers` solo otorgue visibilidad del buzón de aprobaciones y no la capacidad de aprobar, para que aprobar siga gobernado exclusivamente por las listas de aprobadores.

#### Acceptance Criteria

1. THE Portal SHALL determinar la capacidad de aprobar solicitudes únicamente mediante las listas de aprobadores (`isApprover`, `isTeamApprover`, `teamsApprovedBy`) y no mediante el AppRole del usuario.
2. WHEN un usuario con rol `managers` que figura en las listas de aprobadores del equipo de una solicitud intenta aprobarla, THE Portal SHALL permitir la aprobación según las reglas de aprobación vigentes.
3. IF un usuario con rol `managers` que no figura en ninguna lista de aprobadores intenta aprobar una solicitud, THEN THE Portal SHALL rechazar la aprobación con estado 403.
4. WHERE un usuario con rol `managers` accede al buzón de aprobaciones sin figurar en las listas de aprobadores, THE Portal SHALL mostrar el buzón sin exponer el control de aprobación.
5. THE Portal SHALL preservar las reglas de aprobación actuales para todos los roles, de modo que el rol `managers` no añada ninguna capacidad de aprobación por sí mismo.

### Requirement 6: Visibilidad en navegación y home

**User Story:** Como manager, quiero ver en la navegación y en la home las entradas correspondientes a mi acceso, para localizar Kiro Analytics y el buzón de aprobaciones.

#### Acceptance Criteria

1. THE Portal SHALL fijar el `minimumRole` del ítem de navegación `kiro-analytics` de `src/components/portal-shell.tsx` a `managers`.
2. THE Portal SHALL fijar el `minimumRole` del ítem de navegación `notifications` (destino `/infra-requests`) de `src/components/portal-shell.tsx` a `managers`.
3. THE Portal SHALL incluir `managers` en la lista `visibleFor` de la tarjeta de home `kiro-analytics` de `src/app/page.tsx`.
4. WHEN un usuario con rol `managers` visualiza la navegación, THE Portal SHALL mostrar los ítems `kiro-analytics` y `notifications` además de los ítems accesibles por `staff`.
5. WHEN un usuario con rol `managers` visualiza la home, THE Portal SHALL mostrar la tarjeta `kiro-analytics`.
6. THE Portal SHALL mantener oculto para el rol `managers` el ítem de navegación `admin` y la tarjeta de home del panel de administración.
7. THE Portal SHALL mantener completamente restringidos para los roles `staff`, `desarrolladores` y `externos` los ítems y funcionalidades exclusivos de manager (`kiro-analytics` y el buzón de aprobaciones/`notifications`), sin mostrarlos en navegación ni en home.
8. THE Portal SHALL gatear cada ítem de navegación de forma independiente según su propio `minimumRole`, mostrando de inmediato cada ítem accesible sin ocultar el resto de ítems de manager cuando falte alguno.

### Requirement 7: Fixtures de tests y fuente única de verdad de roles

**User Story:** Como ingeniero de plataforma, quiero que las fixtures de roles de los tests reflejen el nuevo rol, para que la fuente única de verdad de roles no diverja y las sesiones sintéticas cubran `managers`.

#### Acceptance Criteria

1. THE Portal SHALL incluir `managers` en la constante `ALL_APP_ROLES` de `src/lib/explorer/__tests__/arbitraries.ts`.
2. THE Portal SHALL incluir `managers` en toda enumeración de roles del AI Portal Explorer que hoy liste los AppRoles, incluido el array de roles de `src/app/api/explorer/run/route.ts`.
3. THE Portal SHALL generar una sesión sintética válida para el rol `managers` en el minter de autenticación del AI Portal Explorer.
4. THE conjunto de valores de `ALL_APP_ROLES` SHALL ser exactamente igual al conjunto de miembros del tipo `AppRole`.
5. WHEN el `rbac-validator.ts` del AI Portal Explorer valida el acceso por sección del rol `managers`, THE Portal SHALL producir el mismo resultado que `canAccessSection` para ese rol y sección porque `rbac-validator.ts` deriva sus expectativas de `canAccessSection` (fuente única de verdad), sin mantener una lista paralela divergente.

### Requirement 8: Etiquetas i18n del rol

**User Story:** Como usuario del Portal, quiero ver una etiqueta legible del rol `managers` en mi idioma, para entender el nombre del rol cuando se muestre en la interfaz.

#### Acceptance Criteria

1. WHERE el nombre del rol `managers` se muestra en la interfaz, THE Portal SHALL proporcionar una etiqueta para el rol `managers` en los locales `es`, `en`, `pt` y `fr`.
2. WHERE el nombre del rol `managers` se muestra en la interfaz, THE Portal SHALL mantener la clave i18n del rol `managers` consistente en los cuatro locales `es`, `en`, `pt` y `fr`.

### Requirement 9: No escalada de privilegios

**User Story:** Como responsable de seguridad, quiero garantizar que el rol `managers` no obtenga privilegios de administración ni capacidades exclusivas de directores más allá de la visibilidad del buzón, para evitar la escalada de privilegios.

#### Acceptance Criteria

1. THE Portal SHALL denegar al rol `managers` el acceso a la sección `admin` y a las rutas bajo `/admin` y `/api/admin`.
2. THE Portal SHALL denegar al rol `managers` el acceso a las rutas cuyo rol mínimo sea `directores` o superior, salvo Kiro Analytics (rebajada a `managers`) y la visibilidad del buzón de aprobaciones.
3. THE Portal SHALL otorgar al rol `managers` la capacidad de aprobación solo cuando el usuario figure en las listas de aprobadores, nunca por su AppRole.
4. THE conjunto de secciones accesibles por `managers` SHALL ser un subconjunto propio del conjunto accesible por `admin`.

### Requirement 10: Compatibilidad hacia atrás de roles existentes

**User Story:** Como usuario existente del Portal, quiero que mi acceso permanezca inalterado tras la introducción del rol `managers`, para que ningún rol pierda ni gane secciones de forma no intencionada.

#### Acceptance Criteria

1. THE Portal SHALL preservar el conjunto de secciones accesibles por cada uno de los roles `externos`, `desarrolladores`, `staff`, `directores` y `admin` exactamente igual que antes de introducir el rol `managers`.
2. THE Portal SHALL preservar los aliases legacy existentes en `ROLE_ALIASES` sin alterar su mapeo a los AppRoles previos.
3. WHEN se resuelve el AppRole de un JWT que no contiene el valor `managers`, THE Portal SHALL devolver el mismo AppRole que antes de introducir el rol `managers`.
4. THE Portal SHALL preservar el orden relativo de prioridad de los roles `externos`, `desarrolladores`, `staff`, `directores` y `admin` en `ROLE_PRIORITY`.
5. WHEN se evalúan los gates de rol mínimo cuyo mínimo es `staff` o inferior, THE Portal SHALL producir para los roles preexistentes el mismo resultado de acceso que antes de introducir el rol `managers`.

### Requirement 11: Consistencia y totalidad del modelo de roles

**User Story:** Como ingeniero de plataforma, quiero que la resolución de roles y el acceso por sección sean puros, totales y consistentes entre los dos modelos de control, para que el comportamiento sea determinista y testeable.

#### Acceptance Criteria

1. THE función `resolveAppRole` SHALL ser pura y total, devolviendo un AppRole válido para cualquier array de cadenas de entrada.
2. THE función `canAccessSection` SHALL ser pura y total, devolviendo un booleano para cualquier par (AppRole, PortalSection) incluido el rol `managers`.
3. WHEN se evalúa la sección `kiro-analytics`, THE Portal SHALL mantener el modelo por sección (`canAccessSection`) y el modelo por rol mínimo (`hasMinimumRole` con mínimo `managers`) produciendo resultados IDÉNTICOS para todos los roles (equivalencia por construcción, sin semántica de denegación por discrepancia ni lógica OR).
4. THE conjunto de roles autorizados en `SECTION_ACCESS["kiro-analytics"]` SHALL ser exactamente `{managers, directores, admin}`.
5. THE Portal SHALL definir el rol `managers` en `AppRole`, `ROLE_PRIORITY`, `ROLE_ALIASES` y `SECTION_ACCESS` de forma que ninguna de estas estructuras omita el rol `managers`.
