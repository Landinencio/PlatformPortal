# Requirements Document

## Introduction

Endurecimiento transversal de la experiencia de sesión y de la navegación del Platform Portal (Next.js 14 App Router, TypeScript, NextAuth + Azure AD, desplegado como `portal-prod` en ns `n8n` y `portal-dev` en ns `platformportal` del cluster `dp-tooling`). Esta feature cubre DOS frentes relacionados que hoy provocan que el usuario quede "bloqueado" o con la UI a medias:

- **Frente A — Robustez de sesión/login.** La sesión NextAuth usa estrategia `jwt` con `session.maxAge` y `jwt.maxAge` de 30 minutos en modo rolling (`src/lib/auth.ts`). Cuando la sesión caduca por inactividad, el cliente NO reacciona: `<SessionProvider>` se monta sin props (`src/components/providers.tsx`), no hay reacción a `status === "unauthenticated"`, y no existe interceptor global de `fetch`. El resultado es que las llamadas a `/api/*` protegidas devuelven 401/403 JSON (el middleware sólo redirige las navegaciones de página, `src/middleware.ts` → `middleware.ts`), la UI muestra datos vacíos o errores silenciosos, y el usuario sigue "dentro" de una sesión muerta. Esta feature detecta la expiración en cliente, avisa al usuario, intercepta de forma transversal las respuestas 401/403 de las APIs y redirige a login/home de forma limpia, preservando la ruta previa cuando aplica.

- **Frente B — Navegación consistente.** El mecanismo de "volver" está duplicado e inconsistente entre páginas (distintos iconos `ArrowLeft`/`ChevronLeft`/`Home`, distintos textos, mezcla de español e inglés, distintos destinos, todo inline y sin componente reutilizable). Ejemplos verificados: `synthetic-dashboard.tsx` ("Volver al inicio"), `create-repo/page.tsx` ("Back to Dashboard"), `user-onboarding/page.tsx` ("Back to Menu"), `infra-page-client.tsx` ("Volver al portal"), `cybersecurity-workspace.tsx` (icono Home + "Volver al portal"), `tickets/page.tsx` (ChevronLeft + "Volver a mis tickets"), `finops/comparison-explorer.tsx` ("Volver" interno de niveles). Además hay páginas sin salida: el usuario tiene que editar la URL a mano. Esta feature introduce un componente único de "volver", con estilo, icono, texto e idioma consistentes vía i18n en los 4 locales (`es`, `en`, `pt`, `fr`), aplicado a todas las páginas internas.

Diagnóstico ya verificado (no reinvestigar): el problema NO es el refresh token de Azure. El portal no persiste `access_token`/`refresh_token` de Azure ni implementa flujo de refresh; los roles viven en el JWT propio. El foco es la UX de expiración en cliente + interceptación de 401/403 + navegación uniforme. No se introduce refresh token de Azure en esta feature.

La feature se enmarca en el contexto arquitectónico de `.kiro/steering/portal-architecture.md` (§1 identidad/despliegue, §2 RBAC, gotcha §8 sobre closures de i18n). No modifica el modelo RBAC ni el `maxAge` de sesión salvo que un criterio lo declare explícitamente.

## Glossary

- **Portal**: Aplicación Next.js 14 App Router desplegada como `portal-prod` (ns `n8n`) y `portal-dev` (ns `platformportal`) en el cluster `dp-tooling` (`arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling`).
- **Sesion**: Sesión de usuario gestionada por NextAuth con estrategia `jwt`, cuyo `maxAge` es de 1.800 segundos (30 minutos) en modo rolling, definida en `src/lib/auth.ts`.
- **Proveedor_Sesion**: Componente `<SessionProvider>` de `next-auth/react` montado en `src/components/providers.tsx`.
- **Guardia_Sesion**: Componente cliente nuevo que observa el estado de la Sesion (`useSession`) y reacciona a su expiración avisando al Usuario y desencadenando la redirección de re-login.
- **Interceptor_HTTP**: Envoltura transversal nueva de las llamadas `fetch` del cliente del Portal que inspecciona el status de las respuestas de `/api/*` y trata los status 401 y 403 según los criterios de esta feature.
- **Boton_Volver**: Componente React único y reutilizable nuevo que renderiza el control de "volver" con icono, texto y estilo consistentes, consumiendo el texto vía el Proveedor_i18n.
- **Proveedor_i18n**: Sistema de internacionalización del Portal (`useI18n()` y ficheros `src/i18n/{es,en,pt,fr}.json`).
- **Middleware**: Función `middleware` de `middleware.ts` que, para navegaciones de página sin token, redirige a `/`, y para `/api/*` protegidas devuelve 401/403 JSON.
- **Ruta_Protegida**: Ruta del Portal cuyo acceso requiere una Sesion válida (toda ruta de página distinta de la raíz pública `/`).
- **Ruta_Publica**: Ruta accesible sin Sesion válida; en el alcance de esta feature la única Ruta_Publica es la raíz `/` (home).
- **Pagina_Interna**: Cualquier página del Portal renderizada dentro del `PortalShell` (`src/components/portal-shell.tsx` vía `src/components/conditional-shell.tsx`), es decir, toda página autenticada distinta de la Ruta_Publica `/`.
- **Ruta_Previa**: Valor de `pathname` (más su query string) que el Usuario estaba visitando en el instante en que se detecta la expiración de la Sesion o una respuesta 401.
- **Usuario**: Persona autenticada en el Portal mediante NextAuth + Azure AD.
- **Aviso_Expiracion**: Notificación visual no bloqueante mostrada al Usuario informando de que su Sesion está a punto de expirar.
- **Umbral_Aviso**: Intervalo de 120 segundos antes del instante de expiración de la Sesion a partir del cual se muestra el Aviso_Expiracion.

---

## Requirements

### Requirement 1: Detección de expiración de sesión en cliente

**User Story:** Como Usuario del Portal, quiero que la interfaz detecte cuando mi sesión ha caducado, para no quedarme trabajando sobre una sesión muerta con la pantalla a medias.

Fuentes: `src/components/providers.tsx` (SessionProvider sin props), `src/lib/auth.ts` (maxAge 30 min rolling), `.kiro/steering/portal-architecture.md` §1 y §2.

#### Acceptance Criteria

1. THE Proveedor_Sesion SHALL configurarse con un `refetchInterval` de 300 segundos y con `refetchOnWindowFocus` habilitado, de modo que el estado de la Sesion se revalide periódicamente y al recuperar el foco de la ventana.
2. WHEN el valor de `status` expuesto por `useSession` transita a `"unauthenticated"` mientras el Usuario está en una Pagina_Interna, THE Guardia_Sesion SHALL iniciar el flujo de re-login definido en el Requirement 4 en 1.000 milisegundos o menos desde dicha transición.
3. WHILE la Sesion está a menos de 120 segundos (Umbral_Aviso) de su instante de expiración y el Usuario permanece en una Pagina_Interna, THE Guardia_Sesion SHALL mostrar el Aviso_Expiracion en 1.000 milisegundos o menos desde el instante en que la Sesion cruza el Umbral_Aviso, con un texto que declare que la sesión va a caducar, que muestre los segundos restantes hasta la expiración y que ofrezca la acción de continuar la sesión.
4. WHILE el Aviso_Expiracion está visible, THE Guardia_Sesion SHALL mantenerlo visible hasta que la condición del Umbral_Aviso deje de cumplirse o hasta que el Usuario accione la opción de continuar la sesión.
5. WHEN el Usuario acciona la opción de continuar la sesión ofrecida en el Aviso_Expiracion, THE Guardia_Sesion SHALL invocar la revalidación de la Sesion (`update()` de NextAuth) con un timeout de 10.000 milisegundos y, si la revalidación devuelve una Sesion válida dentro de ese timeout, SHALL ocultar el Aviso_Expiracion en 1.000 milisegundos o menos desde la recepción de la Sesion válida.
6. IF la revalidación de la Sesion invocada desde el Aviso_Expiracion falla, agota el timeout de 10.000 milisegundos o devuelve una Sesion no válida o expirada, THEN THE Guardia_Sesion SHALL iniciar el flujo de re-login definido en el Requirement 4 en 1.000 milisegundos o menos e indicarlo al Usuario.
7. WHERE el Usuario se encuentra en la Ruta_Publica `/`, THE Guardia_Sesion SHALL abstenerse de mostrar el Aviso_Expiracion y de iniciar el flujo de re-login.
8. THE Guardia_Sesion SHALL montarse una única vez en el árbol de componentes dentro del Proveedor_Sesion, de forma que su lógica de detección aplique a todas las Pagina_Interna sin requerir integración por página.

### Requirement 2: Interceptación global de respuestas 401 y 403 de las APIs

**User Story:** Como Usuario del Portal, quiero que cuando una llamada a la API falle por sesión caducada o permisos insuficientes la aplicación reaccione de forma clara, para no ver fallos silenciosos ni datos vacíos sin explicación.

Fuentes: `middleware.ts` (rutas `/api/*` protegidas devuelven 401/403 JSON), `src/components/providers.tsx` (sin interceptor global de fetch).

#### Acceptance Criteria

1. THE Interceptor_HTTP SHALL interceptar de forma transversal las respuestas de las llamadas `fetch` originadas en el cliente o navegador del Portal, dirigidas al mismo origen que el Portal, cuyo path comienza por `/api/`, tanto si la URL es relativa como si es absoluta al origen del Portal, y con independencia del método HTTP empleado.
2. WHEN una respuesta interceptada dirigida a una ruta `/api/*` tiene status HTTP 401, THE Interceptor_HTTP SHALL iniciar el flujo de re-login definido en el Requirement 4 en 1.000 milisegundos o menos desde la recepción de la respuesta, tratando el estado como Sesion expirada y aplicando la deduplicación definida en el criterio 6.
3. WHEN una respuesta interceptada dirigida a una ruta `/api/*` tiene status HTTP 403, THE Interceptor_HTTP SHALL mostrar al Usuario, en menos de 1.000 milisegundos desde la recepción de la respuesta, una notificación no bloqueante que declare que carece de permisos para esa operación, SHALL mantener al Usuario en la Ruta_Previa sin redirigir a login, y SHALL mantener dicha notificación visible durante 5.000 milisegundos o más o hasta que el Usuario la descarte.
4. THE Interceptor_HTTP SHALL excluir de su tratamiento las llamadas cuyo path comienza por `/api/auth/`, para no interferir con el propio flujo de autenticación de NextAuth.
5. THE Interceptor_HTTP SHALL preservar el contrato de la API `fetch` estándar, devolviendo al llamador un objeto `Response` con las mismas propiedades observables (`status`, `ok`, `headers`, cuerpo) que devolvería la llamada sin interceptar, para los status no tratados por los criterios 2 y 3, conservando el cuerpo de la respuesta íntegro y legible sin consumir ni bloquear su stream.
6. WHEN el Interceptor_HTTP recibe una respuesta con status 401 sin que exista un flujo de re-login activo, THE Interceptor_HTTP SHALL iniciar una ventana de deduplicación de 5.000 milisegundos y SHALL disparar el flujo de re-login una sola vez para todas las respuestas 401 recibidas dentro de esa ventana.
7. WHEN una respuesta interceptada tiene un status HTTP distinto de 401 y de 403, THE Interceptor_HTTP SHALL entregar la respuesta al llamador sin alterar su contenido, su status ni sus cabeceras.
8. IF una llamada `fetch` interceptada termina en un error de red o rechazo sin respuesta HTTP asociada, THEN THE Interceptor_HTTP SHALL propagar dicho error al llamador sin alterarlo y sin iniciar el flujo de re-login ni mostrar notificación alguna.

### Requirement 3: Reacción del middleware ante peticiones sin sesión

**User Story:** Como Usuario del Portal, quiero que las peticiones a páginas protegidas sin sesión válida me lleven a un punto de entrada claro, para no quedar en una pantalla sin salida.

Fuentes: `middleware.ts` (redirección a `/` en páginas, 401/403 JSON en APIs).

#### Acceptance Criteria

1. WHEN el Middleware recibe una petición de navegación a una Ruta_Protegida y no hay token de Sesion válido, THE Middleware SHALL redirigir la petición a la Ruta_Publica `/` sin renderizar ni exponer el contenido de la Ruta_Protegida.
2. WHEN el Middleware redirige una navegación a una Ruta_Protegida por ausencia de token, THE Middleware SHALL adjuntar a la URL de destino un parámetro de query `next` cuyo valor es la Ruta_Previa (pathname más query string) codificada como componente de URL con una longitud máxima de 2048 caracteres.
3. WHEN el Portal recibe un valor de parámetro `next` válido, entendido como una cadena que comienza por un único `/`, no comienza por `//` ni por `/\`, no contiene `://`, no contiene caracteres de control (`\r`, `\n` o `\t`) y no supera 2048 caracteres, THE Portal SHALL aceptar dicho valor como destino de navegación tras el login.
4. IF el valor del parámetro `next` recibido está vacío, no comienza por un único `/`, comienza por `//` o por `/\`, contiene `://`, contiene caracteres de control (`\r`, `\n` o `\t`) o supera 2048 caracteres, THEN THE Portal SHALL descartar dicho valor y usar la Ruta_Publica `/` como destino tras el login.
5. IF el Middleware recibe una petición a una ruta `/api/*` protegida sin token de Sesion válido, THEN THE Middleware SHALL responder con status HTTP 401 sin ejecutar el handler de la API.
6. IF el Middleware recibe una petición a una ruta `/api/*` con token de Sesion válido pero rol insuficiente, THEN THE Middleware SHALL responder con status HTTP 403 sin ejecutar el handler de la API.

### Requirement 4: Flujo de re-login limpio y retorno a la ruta previa

**User Story:** Como Usuario cuya sesión ha caducado, quiero que la aplicación me lleve a autenticarme de nuevo de forma ordenada y me devuelva a donde estaba, para no perder el contexto de trabajo ni tener que reescribir la URL.

Fuentes: Requirements 1 y 2 (disparadores), `next-auth/react` (`signIn`), `middleware.ts` (redirecciones).

#### Acceptance Criteria

1. WHEN se inicia el flujo de re-login, THE Portal SHALL capturar la Ruta_Previa como el pathname más la query string vigentes en el instante de detección, y SHALL retener ese valor inmutable durante todo el flujo de re-login.
2. WHEN se inicia el flujo de re-login desde una Pagina_Interna y la Ruta_Previa capturada es una ruta interna válida, entendida como una cadena que comienza por un único `/` y no es una URL absoluta hacia otro host, THE Portal SHALL redirigir al Usuario al inicio de sesión de NextAuth con un `callbackUrl` igual a la Ruta_Previa capturada.
3. IF la Ruta_Previa capturada al iniciar el re-login no es una ruta interna válida según el criterio 2, THEN THE Portal SHALL usar la Ruta_Publica `/` como `callbackUrl` del inicio de sesión de NextAuth.
4. WHEN el Usuario completa con éxito el re-login iniciado desde una Pagina_Interna y la Ruta_Previa capturada es una ruta interna válida según el criterio 2, THE Portal SHALL devolver al Usuario a la Ruta_Previa.
5. IF la Ruta_Previa capturada al iniciar el re-login es la Ruta_Publica `/` o no es una ruta interna válida según el criterio 2, THEN THE Portal SHALL devolver al Usuario a la Ruta_Publica `/` tras el re-login.
6. WHEN se inicia el flujo de re-login, THE Portal SHALL mostrar al Usuario, en 500 milisegundos o menos desde el inicio del flujo, un mensaje que declare que la sesión ha caducado y que va a redirigirse para autenticarse de nuevo, y SHALL ejecutar la redirección en 3.000 milisegundos o menos desde que se muestra dicho mensaje.
7. WHILE existe un flujo de re-login iniciado en los últimos 5.000 milisegundos, THE Portal SHALL disparar la redirección de re-login una única vez, con independencia de si el disparador fue el Guardia_Sesion (Requirement 1) o el Interceptor_HTTP (Requirement 2) y de si los disparos son concurrentes.

### Requirement 5: Componente único de navegación "volver"

**User Story:** Como Usuario del Portal, quiero un botón de "volver" con aspecto y comportamiento idénticos en todas las páginas, para orientarme siempre igual sin sorpresas.

Fuentes: componentes con botón inline inconsistente (`synthetic-dashboard.tsx`, `create-repo/page.tsx`, `user-onboarding/page.tsx`, `infra-page-client.tsx`, `cybersecurity-workspace.tsx`, `tickets/page.tsx`, `finops/comparison-explorer.tsx`), stack UI shadcn/ui + Tailwind + lucide-react, gotcha i18n §8.

#### Acceptance Criteria

1. THE Portal SHALL proveer un único componente Boton_Volver reutilizable que renderice el control de "volver" para toda Pagina_Interna.
2. THE Boton_Volver SHALL renderizar el icono `ArrowLeft` de `lucide-react` como único icono del control de "volver".
3. THE Boton_Volver SHALL obtener su texto visible exclusivamente a través del Proveedor_i18n mediante una clave de i18n dedicada, sin literales de texto incrustados en el componente.
4. THE Boton_Volver SHALL exponer un nombre accesible y SHALL activarse tanto por puntero como por teclado mediante las teclas Enter y Barra espaciadora.
5. THE Boton_Volver SHALL aceptar una propiedad opcional que fije el destino de navegación.
6. WHERE la propiedad de destino está presente, WHEN el Boton_Volver es activado, THE Boton_Volver SHALL navegar a la ruta interna indicada por esa propiedad.
7. WHERE la propiedad de destino está ausente, WHEN el Boton_Volver es activado, THE Boton_Volver SHALL navegar a la Ruta_Publica `/` (inicio del Portal).
8. IF la propiedad de destino presente no es una ruta interna válida, entendida como una cadena que comienza por un único `/` y no es una URL absoluta hacia otro host, THEN THE Boton_Volver SHALL navegar a la Ruta_Publica `/`.
9. THE Boton_Volver SHALL renderizar el mismo conjunto de clases de estilo (tipografía, espaciado, color e interacción) definido en un único lugar, en todas las Pagina_Interna donde se use.

### Requirement 6: Aplicación uniforme del botón "volver" en todas las páginas internas

**User Story:** Como Usuario del Portal, quiero que ninguna página interna me deje sin salida, para no tener que cambiar la URL a mano nunca.

Fuentes: `src/components/conditional-shell.tsx` (`STANDALONE_PATHS = ["/"]`), `src/components/portal-shell.tsx`, páginas con botón ausente o duplicado.

#### Acceptance Criteria

1. THE Portal SHALL presentar exactamente un Boton_Volver en cada Pagina_Interna, entendida como toda página autenticada renderizada dentro del `PortalShell` y distinta de la Ruta_Publica `/`.
2. WHERE una página es la Ruta_Publica `/` (home), THE Portal SHALL presentar cero Boton_Volver en esa página.
3. THE Portal SHALL sustituir cada control de "volver" inline preexistente en `synthetic-dashboard.tsx`, `create-repo/page.tsx`, `user-onboarding/page.tsx`, `infra-page-client.tsx`, `cybersecurity-workspace.tsx` y `tickets/page.tsx` por el Boton_Volver único, dejando cero controles de "volver" inline duplicados tras la sustitución.
4. WHERE un control de navegación opera entre niveles internos de una misma vista y no es el control de "volver" a nivel de página (caso de la navegación de niveles de `finops/comparison-explorer.tsx`), THE Portal SHALL permitir que ese control conserve su comportamiento de navegación interna reutilizando el Boton_Volver con una propiedad de destino explícita.
5. WHEN el Boton_Volver sin propiedad de destino es activado en una Pagina_Interna, THE Portal SHALL navegar a la página anterior del historial de navegación.
6. IF el historial de navegación está vacío o la Pagina_Interna se ha abierto por acceso directo mediante URL, THEN THE Portal SHALL navegar a la Ruta_Publica `/` al activar el Boton_Volver sin propiedad de destino.
7. WHEN el Boton_Volver se presenta en una Pagina_Interna, THE Portal SHALL anclarlo en una posición verificable relativa al título o encabezado de la página, idéntica en todas las Pagina_Interna.

### Requirement 7: Consistencia de idioma del botón "volver" en los cuatro locales

**User Story:** Como Usuario del Portal en cualquiera de los idiomas soportados, quiero que el texto de "volver" aparezca correctamente en mi idioma, para no encontrarme mezclas de español e inglés.

Fuentes: `src/i18n/{es,en,pt,fr}.json`, gotcha §8 (los helpers fuera del componente necesitan su propio `const { t } = useI18n()`).

#### Acceptance Criteria

1. THE Portal SHALL definir una única clave de i18n compartida para el texto del Boton_Volver, presente en los cuatro ficheros de locale `src/i18n/es.json`, `src/i18n/en.json`, `src/i18n/pt.json` y `src/i18n/fr.json`.
2. THE Boton_Volver SHALL resolver su texto mediante `useI18n()` dentro del propio cuerpo del componente, sin depender de closures de i18n definidos fuera del componente.
3. THE Boton_Volver SHALL obtener su texto visible exclusivamente de la clave de i18n compartida, sin cadenas literales de texto embebidas en el componente.
4. WHILE el Usuario tiene seleccionado el locale español, THE Boton_Volver SHALL mostrar el texto en español definido para su clave de i18n.
5. WHILE el locale activo es `en`, `pt` o `fr`, THE Boton_Volver SHALL mostrar el texto correspondiente a ese locale definido para su clave de i18n.
6. IF la clave de i18n del Boton_Volver falta o está vacía en el locale activo, THEN THE Boton_Volver SHALL mostrar el texto definido para esa clave en el locale español.
7. THE valor de la clave de i18n del Boton_Volver SHALL contener al menos un carácter distinto de espacio en blanco en cada uno de los cuatro ficheros de locale.
