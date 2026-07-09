# Requirements Document

## Introduction

La pestaña de métricas DORA del Portal de Plataforma (`/metrics`) ofrece un filtro global de autores que el usuario percibe como aplicable a toda la página. Sin embargo, ese filtro (`filters.authors`) solo afecta al dashboard de manager/MR; la función núcleo de DORA (`getDoraCoreDashboard` en `src/lib/metrics-dashboard.ts`) ni recibe ni aplica la dimensión de autor (solo filtra por fecha, equipo y proyecto), y la clave de caché de DORA tampoco incluye `authors`. El resultado es que **añadir o quitar autores no cambia las métricas DORA**: el control es un no-op en esa pestaña, lo que genera desconfianza en la sección.

Esta feature añade la dimensión de autor de extremo a extremo a las métricas DORA, con una semántica honesta por métrica, reutilizando la identidad canónica de autor que ya emplea el lado de MR (helper consolidado en `src/lib/mr-metrics-canonical.ts` e identidad en `src/lib/developer-identity.ts` / `src/lib/dashboard-utils.ts`). La autoría de cada despliegue se deriva de los cambios reales asociados (`deployment_changes` sobre `production_deployments`/`deployment_traces`). Adicionalmente, la feature cierra los huecos de confianza que dejó abierta la spec previa `dora-metrics-production-readiness` (property tests de cálculos puros y checkpoints sin completar) para que las métricas DORA no vuelvan a romperse en silencio.

Esta spec **no** reabre la dirección de diseño (ya aprobada por el usuario) ni duplica los 15 problemas ya implementados en `dora-metrics-production-readiness`. Donde aplique, referencia esa spec previa.

### Alcance fuera de esta feature (Out of Scope)

- Rehacer los 15 puntos ya implementados en `dora-metrics-production-readiness` (lead time canónico, renombrado MTTR→Pipeline Recovery Time, `MIN_CORRELATION_CONFIDENCE`, confidence score, audit summary, caché por prefijo, índices, endpoint `/api/metrics/executive-summary`).
- Cambios en SonarQube o en la asignación (allocation) de Kubernetes.
- Introducir un MTTR real basado en incidentes de producción (queda documentado como evolución futura en la spec previa).

## Glossary

- **Portal**: La aplicación Next.js del Portal de Plataforma.
- **DORA_Tab**: La pestaña DORA dentro de `/metrics` que presenta Deployment Frequency, Lead Time, Change Failure Rate y Pipeline Recovery Time.
- **DORA_Core**: La función `getDoraCoreDashboard` y su implementación `_getDoraCoreDashboardImpl` en `src/lib/metrics-dashboard.ts` que calcula las métricas DORA.
- **Metrics_Dashboard**: El módulo `src/lib/metrics-dashboard.ts`.
- **Author_Filter**: El conjunto de autores seleccionados, transportado en `filters.authors` (parámetro de consulta `authors`/`author`).
- **Scope**: El alcance de cálculo de una métrica DORA, definido como la intersección `(fecha ∩ equipo ∩ proyecto ∩ autores)`.
- **Deployment_Changes**: La tabla `deployment_changes`, que asocia cada despliegue productivo con los cambios (commits) y su autoría real.
- **Production_Deployment**: Un despliegue exitoso a producción registrado en `production_deployments`/`deployment_traces`.
- **Canonical_Author_Identity**: La identidad de autor unificada (commit-email ↔ gitlab-username) resuelta mediante `resolveAuthorIdentitySeed` (`src/lib/dashboard-utils.ts`) y `mergeDevelopersByIdentity` (`src/lib/developer-identity.ts`), idéntica a la usada en el lado MR.
- **Deployment_Frequency**: Métrica DORA que cuenta los despliegues a producción en el alcance.
- **Lead_Time**: Métrica DORA por-cambio que mide el tiempo desde un evento de desarrollo (variante canónica `first_commit`) hasta el despliegue en producción.
- **Change_Failure_Rate** (CFR): Métrica DORA que mide la proporción de despliegues/pipelines que fallan, a nivel despliegue/pipeline.
- **Pipeline_Recovery_Time**: Métrica que mide el tiempo entre un pipeline fallido y el siguiente exitoso (renombrada desde MTTR en la spec previa).
- **Deployment_Level_Metric**: Una métrica calculada sobre el conjunto de despliegues/pipelines en alcance, sin atribución a una persona concreta (aplica a CFR y Pipeline Recovery Time bajo filtro de autor).
- **Scope_Banner**: El indicador en la UI de DORA_Tab que muestra qué dimensiones de alcance (equipo, proyecto, autores) están aplicadas.
- **Author_Attribution_Coverage**: El porcentaje de Production_Deployments del alcance cuya autoría es resoluble a partir de Deployment_Changes.
- **DORA_Cache_Key**: La clave de caché construida en `getDoraCoreDashboard`.
- **Previous_Spec**: La spec `dora-metrics-production-readiness`, cuyos property tests y checkpoints de correctitud quedaron pendientes.

## Requirements

### Requisito 1: Filtro de autores aplicado a Deployment Frequency y Lead Time

**Historia de Usuario:** Como engineering manager, quiero que al seleccionar autores en la pestaña DORA cambien Deployment Frequency y Lead Time según la autoría real de los cambios, para poder analizar la contribución de personas concretas a la entrega.

#### Criterios de Aceptación

1. WHEN DORA_Core recibe filtros con Author_Filter no vacío, THE DORA_Core SHALL calcular todas las métricas DORA sobre el Scope `(fecha ∩ equipo ∩ proyecto ∩ autores)`.
2. WHILE Author_Filter contiene uno o más autores, THE DORA_Core SHALL contar en Deployment_Frequency cada Production_Deployment una sola vez cuando incluya al menos un cambio en Deployment_Changes cuya Canonical_Author_Identity pertenezca a Author_Filter, con independencia de cuántos cambios coincidentes contenga ese despliegue.
3. WHILE Author_Filter contiene uno o más autores, THE DORA_Core SHALL calcular Lead_Time como la mediana de los Lead_Time (variante canónica `first_commit`) de los cambios en Deployment_Changes cuya Canonical_Author_Identity pertenezca a Author_Filter, tomando como mediana el valor central cuando el número de cambios es impar y la media aritmética de los dos valores centrales cuando es par.
4. WHEN un Production_Deployment incluye cambios de autores dentro y fuera de Author_Filter, THE DORA_Core SHALL incluir ese despliegue una sola vez en el conteo de Deployment_Frequency.
5. WHEN DORA_Core calcula Lead_Time bajo Author_Filter, THE DORA_Core SHALL incluir solo los cambios cuya Canonical_Author_Identity pertenece a Author_Filter y excluir los cambios de autores no seleccionados.
6. WHEN DORA_Core evalúa si un cambio de Deployment_Changes pertenece a Author_Filter, THE DORA_Core SHALL considerar que pertenece si y solo si la clave canónica de su Canonical_Author_Identity coincide con la clave canónica de al menos un autor de Author_Filter.

### Requisito 2: Semántica de nivel despliegue/pipeline para CFR y Pipeline Recovery Time

**Historia de Usuario:** Como engineering manager, quiero que Change Failure Rate y Pipeline Recovery Time bajo un filtro de autor se calculen a nivel despliegue/pipeline y se etiqueten como tal, para no atribuir incorrectamente un fallo a una persona cuando un despliegue mezcla autores.

#### Criterios de Aceptación

1. WHILE Author_Filter contiene uno o más autores, THE DORA_Core SHALL calcular Change_Failure_Rate como un valor porcentual entre 0 y 100 sobre el conjunto de Production_Deployments del Scope `(fecha ∩ equipo ∩ proyecto)` como Deployment_Level_Metric, sin intersecar el conjunto por Author_Filter ni atribuir el fallo a un autor individual.
2. WHILE Author_Filter contiene uno o más autores, THE DORA_Core SHALL calcular Pipeline_Recovery_Time como una duración no negativa expresada en minutos sobre el conjunto de pipelines del Scope `(fecha ∩ equipo ∩ proyecto)` como Deployment_Level_Metric, sin atribuir la recuperación a un autor individual.
3. WHILE Author_Filter contiene uno o más autores y se renderizan Change_Failure_Rate y Pipeline_Recovery_Time, THE DORA_Tab SHALL mostrar de forma visible y adyacente a cada una de esas métricas una etiqueta que indique que es de nivel despliegue/pipeline y no de atribución personal.
4. WHEN el usuario sitúa el puntero encima o pone el foco de teclado en la etiqueta de Change_Failure_Rate o de Pipeline_Recovery_Time bajo Author_Filter, THE DORA_Tab SHALL mostrar un tooltip accesible que explique que un despliegue fallido puede mezclar varios autores y que la métrica no responsabiliza a una persona, y SHALL mantenerlo visible mientras dure el hover o el foco.
5. IF Author_Filter contiene uno o más autores y el Scope no contiene Production_Deployments ni pipelines, THEN THE DORA_Core SHALL devolver Change_Failure_Rate y Pipeline_Recovery_Time como no disponibles en lugar de cero o de un valor indefinido.

### Requisito 3: Identidad canónica de autor consistente con el lado MR

**Historia de Usuario:** Como engineering manager, quiero que la identidad de cada autor en DORA se resuelva igual que en la pestaña de MR, para que un mismo desarrollador no aparezca duplicado por usar distintos emails de commit o usernames.

#### Criterios de Aceptación

1. WHEN DORA_Core deriva la autoría de un cambio de Deployment_Changes, THE DORA_Core SHALL resolver la Canonical_Author_Identity de forma determinista e independiente del orden de entrada usando los mismos helpers de identidad que el lado MR (`resolveAuthorIdentitySeed` y `mergeDevelopersByIdentity`).
2. WHEN dos cambios tienen distinto commit-email o gitlab-username pero corresponden a la misma Canonical_Author_Identity, THE DORA_Core SHALL agruparlos bajo una única identidad de autor, con un resultado independiente del orden en que se procesen.
3. WHEN un Production_Deployment contiene N≥1 cambios cuya Canonical_Author_Identity es la misma, THE DORA_Core SHALL contar a ese autor una sola vez para ese despliegue, considerando equivalentes las filas que resuelven a la misma clave canónica de identidad.
4. WHEN DORA_Tab presenta la lista de autores seleccionables para el filtro, THE DORA_Tab SHALL ofrecer las Canonical_Author_Identity derivadas de la autoría de los Production_Deployments en alcance, sin duplicados y en un orden determinista.
5. IF un cambio de Deployment_Changes no tiene commit-email ni gitlab-username resolubles a una Canonical_Author_Identity, THEN THE DORA_Core SHALL clasificarlo como autoría no resoluble, excluirlo de la agrupación por autor y del match con Author_Filter, y conservar su Production_Deployment en el resto de cálculos no dependientes de autor (ver Requisito 7).

### Requisito 4: Clave de caché de DORA con la dimensión de autor

**Historia de Usuario:** Como desarrollador de plataforma, quiero que la clave de caché de DORA incluya los autores y el resto de dimensiones, para que el portal no sirva datos cacheados de un alcance distinto al solicitado.

#### Criterios de Aceptación

1. THE DORA_Core SHALL incluir Author_Filter en la DORA_Cache_Key junto con las dimensiones de fecha, equipo y proyecto ya existentes, de modo que la clave identifique de forma única el Scope `(fecha ∩ equipo ∩ proyecto ∩ autores)`.
2. WHEN dos consultas comparten fecha, equipo y proyecto y difieren únicamente en el conjunto de Canonical_Author_Identity de Author_Filter, THE DORA_Core SHALL generar una DORA_Cache_Key distinta para cada consulta.
3. WHEN dos consultas tienen el mismo conjunto de Canonical_Author_Identity en Author_Filter, independientemente del orden de los autores y de entradas duplicadas que resuelvan a la misma identidad canónica, THE DORA_Core SHALL generar la misma DORA_Cache_Key.
4. WHILE Author_Filter está vacío, THE DORA_Core SHALL generar una DORA_Cache_Key idéntica a la que produciría una consulta con idénticos filtros de fecha, equipo y proyecto, sin que la dimensión de autor introduzca variación en la clave.
5. WHEN se invalida la caché de DORA, THE Metrics_Dashboard SHALL usar el prefijo `dora:` canónico definido en la Previous_Spec.

### Requisito 5: Indicador de alcance en la UI de DORA

**Historia de Usuario:** Como engineering manager, quiero ver qué alcance está aplicado a las métricas DORA, para entender de un vistazo si estoy mirando todo el equipo o un subconjunto de autores.

#### Criterios de Aceptación

1. WHILE DORA_Tab está visible, THE DORA_Tab SHALL mostrar de forma permanente un Scope_Banner que indique las tres dimensiones de alcance (equipo, proyecto y autores), incluyendo cada dimensión aunque no tenga filtro activo.
2. WHILE Author_Filter contiene uno o más autores, THE Scope_Banner SHALL mostrar los nombres de Canonical_Author_Identity de hasta 5 autores aplicados al alcance y, si Author_Filter contiene más de 5 autores, un indicador con el número de autores restantes no mostrados.
3. WHILE Author_Filter está vacío, THE Scope_Banner SHALL indicar de forma explícita que no hay filtro de autor aplicado y que las métricas reflejan todo el equipo o proyecto seleccionado.
4. WHEN el usuario modifica Author_Filter, equipo o proyecto y DORA_Core completa el recálculo de las métricas, THE Scope_Banner SHALL reflejar el alcance actualizado en la misma vista sin requerir recarga manual de la página.
5. WHILE ni equipo ni proyecto están seleccionados y Author_Filter está vacío, THE Scope_Banner SHALL indicar que el alcance abarca todos los equipos y proyectos.

### Requisito 6: Estado vacío honesto bajo filtro de autor

**Historia de Usuario:** Como engineering manager, quiero que si un autor no tiene despliegues ni cambios en el alcance se muestren valores vacíos o cero, para no confundir la ausencia de actividad con los datos de todo el equipo.

#### Criterios de Aceptación

1. WHEN Author_Filter contiene uno o más autores y el Scope resultante contiene cero Production_Deployments, THE DORA_Core SHALL devolver Deployment_Frequency con valor numérico exacto igual a cero.
2. WHEN Author_Filter contiene uno o más autores y el Scope resultante contiene cero cambios atribuibles a Author_Filter, THE DORA_Core SHALL devolver Lead_Time con un indicador explícito de no disponible distinto del valor numérico cero, y no el Lead_Time del alcance sin filtro de autor.
3. WHEN Author_Filter contiene uno o más autores y el Scope resultante contiene cero Production_Deployments o cero pipelines, THE DORA_Core SHALL devolver Change_Failure_Rate y Pipeline_Recovery_Time con un indicador explícito de no disponible distinto del valor numérico cero.
4. IF Author_Filter contiene uno o más autores y el Scope resultante no tiene actividad atribuible, THEN THE DORA_Core SHALL no sustituir ninguna métrica DORA por los valores del alcance sin filtro de autor (equipo o proyecto completo).
5. WHILE las métricas DORA están vacías por ausencia de actividad de Author_Filter en el Scope, THE DORA_Tab SHALL mostrar un estado vacío que identifique los autores seleccionados, indique cero Production_Deployments y cero cambios atribuibles en el alcance, y se distinga visualmente de un estado de error o de carga.

### Requisito 7: Cobertura y confianza de la atribución por autor

**Historia de Usuario:** Como engineering manager, quiero saber qué porcentaje de despliegues tiene autoría resoluble, para entender hasta qué punto la atribución por autor es fiable o best-effort.

#### Criterios de Aceptación

1. THE DORA_Core SHALL calcular Author_Attribution_Coverage como el porcentaje resultante de dividir el número de Production_Deployments del alcance con autoría resoluble entre el número total de Production_Deployments del alcance y multiplicar por 100, redondeado a 1 decimal y acotado al rango 0.0–100.0.
2. WHERE un Production_Deployment del alcance no tiene cambios en Deployment_Changes o ninguno de sus cambios resuelve a una Canonical_Author_Identity, THE DORA_Core SHALL considerarlo de autoría no resoluble a efectos de Author_Attribution_Coverage.
3. IF el alcance contiene cero Production_Deployments, THEN THE DORA_Core SHALL devolver Author_Attribution_Coverage como no disponible y no como 0.0.
4. WHEN Author_Filter contiene uno o más autores, THE DORA_Core SHALL incluir Author_Attribution_Coverage en el resumen de auditoría de la respuesta DORA.
5. IF Author_Attribution_Coverage es estrictamente menor que un umbral configurable con valor por defecto 80.0%, THEN THE DORA_Tab SHALL mostrar una advertencia visible indicando que la atribución por autor es best-effort y puede estar incompleta.
6. WHEN DORA_Tab muestra métricas bajo Author_Filter, THE DORA_Tab SHALL indicar que la atribución por autor se basa en los cambios registrados en Deployment_Changes.

### Requisito 8: Cierre de property tests y checkpoints de correctitud pendientes

**Historia de Usuario:** Como desarrollador de plataforma, quiero completar los property tests de los cálculos DORA puros que la spec previa dejó pendientes, para que los cálculos DORA tengan propiedades de correctitud verificables y no se rompan en silencio.

#### Criterios de Aceptación

1. THE Portal SHALL incluir property tests que verifiquen la selección de Lead_Time con fallback canónico (`selectLeadTimeWithVariant`), cubriendo el property pendiente de la Previous_Spec, comprobando que cuando la variante canónica `first_commit` está disponible se selecciona esa variante y que, en su ausencia, se aplica el fallback documentado devolviendo un Lead_Time definido o un valor explícito de no disponible, sin lanzar excepción.
2. THE Portal SHALL incluir property tests que verifiquen que el confidence score producido se mantiene dentro del rango cerrado [0, 100] (ambos extremos inclusive) para cualquier combinación de entradas dentro del dominio de entrada documentado de la función de confidence score, incluyendo los valores límite (mínimos, máximos, cero y entradas vacías).
3. THE Portal SHALL incluir property tests que verifiquen el filtrado por confianza de correlaciones usado en Change_Failure_Rate comprobando que (a) el resultado es un subconjunto del conjunto original sin añadir ni modificar elementos, y (b) conserva todas y solo las entradas cuyo score es mayor o igual al umbral `MIN_CORRELATION_CONFIDENCE`, descartando toda entrada con score inferior a dicho umbral.
4. THE Portal SHALL incluir un property test que verifique que el conteo de Production_Deployments atribuidos a un Author_Filter es invariante ante la duplicación de filas equivalentes en Deployment_Changes, deduplicando por Canonical_Author_Identity y por la fecha de despliegue correcta, de modo que N filas equivalentes produzcan el mismo conteo que una sola fila.
5. THE Portal SHALL ejecutar cada property test de cálculos DORA puros con un mínimo de 100 casos generados por property y con una semilla fija que garantice resultados reproducibles e idénticos entre ejecuciones sucesivas.
6. WHEN se ejecuta la suite de tests del Portal, THE Portal SHALL ejecutar los property tests de cálculos DORA puros definidos en los criterios 1 a 4 y completar sin ningún caso generado ni aserción fallida.

### Requisito 9: Regresión cero sin filtro de autor

**Historia de Usuario:** Como engineering manager, quiero que cuando no haya filtro de autor las métricas DORA se comporten exactamente como hoy, para no introducir regresiones en el flujo habitual por equipo, proyecto y fecha.

#### Criterios de Aceptación

1. WHILE Author_Filter está vacío, THE DORA_Core SHALL calcular Deployment_Frequency, Lead_Time, Change_Failure_Rate y Pipeline_Recovery_Time aplicando exactamente el Scope `(fecha ∩ equipo ∩ proyecto)`, sin que la dimensión de autor reduzca, amplíe ni reordene el conjunto de Production_Deployments ni de cambios considerados.
2. WHILE Author_Filter está vacío, THE DORA_Core SHALL producir, para idénticos filtros de fecha, equipo y proyecto, valores idénticos a los de la implementación previa a la dimensión de autor: Deployment_Frequency con el mismo conteo entero exacto, y Lead_Time, Change_Failure_Rate y Pipeline_Recovery_Time con una diferencia absoluta no superior a 0,01 respecto al valor de referencia.
3. WHILE Author_Filter está vacío, IF el valor de referencia de Lead_Time es vacío o no disponible, THEN THE DORA_Core SHALL devolver Lead_Time igualmente como vacío o no disponible, y no el Lead_Time de un alcance distinto.
4. WHILE Author_Filter está vacío, THE DORA_Tab SHALL no mostrar las etiquetas ni los tooltips de nivel despliegue/pipeline propios del modo de atribución por autor descritos en el Requisito 2.
5. WHEN Author_Filter está vacío, THE DORA_Core SHALL construir la DORA_Cache_Key con un valor de autor vacío equivalente, de modo que dos consultas sin filtro de autor con idénticas dimensiones de fecha, equipo y proyecto compartan la misma entrada de caché.
