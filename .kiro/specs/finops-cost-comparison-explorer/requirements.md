# Requirements Document

## Introduction

Esta funcionalidad cubre dos necesidades dentro de la sección FinOps del Platform Portal de IskayPet, pestaña "Costes" (`/finops`):

**PARTE A — Corrección de alcance por cuenta (bug de scoping).** Actualmente, en la pestaña de análisis de costes, independientemente de la(s) cuenta(s) seleccionada(s) en el filtro global, el apartado "Optimización y costes ocultos" y, en concreto, la tabla de instancias EC2 (`ec2Fleet`) muestran datos pertenecientes a cuentas distintas a las seleccionadas. El requisito es que TODO el contenido presentado en pantalla quede ceñido exactamente a la(s) cuenta(s) seleccionada(s) en el filtro del dashboard, sin filtrar datos de otras cuentas en ninguna sección.

**PARTE B — Explorador de comparativas FinOps (nueva capacidad).** Se incorpora un apartado nuevo, presentado como vista dedicada o ventana emergente (modal), que permite comparar dos o más meses con un fuerte énfasis en comparativas y progresiones claras. El explorador presenta una tabla acompañada de gráficas y ofrece navegación jerárquica (drill-down) en tres niveles: cuenta → servicio → objeto/recurso. En cada nivel se muestran los importes de cada mes comparado, la variación absoluta (Δ€) y porcentual (Δ%), y la tendencia. El explorador respeta la(s) misma(s) cuenta(s) seleccionada(s) que el resto del dashboard (coherente con la PARTE A).

Ambas partes reutilizan los mecanismos existentes de selección de cuentas y rango de fechas del dashboard, así como la ruta de datos del CUR (`/api/finops/cur-direct` + `src/lib/athena-cur.ts`) que devuelve `CurFullSnapshot`. Queda fuera de alcance cambiar la fuente de datos del CUR, modificar otras pestañas distintas de "Costes" y añadir capacidades de forecasting.

## Glossary

- **Costs_Dashboard**: Componente de la pestaña "Costes" (`src/components/finops/costs-dashboard.tsx`) que aloja el filtro global de cuentas, el rango de fechas y todas las secciones de análisis de coste.
- **Filtro_Cuentas**: Selector global de cuentas AWS del Costs_Dashboard (`AccountMultiSelect`) que define el conjunto de cuentas activas (`selectedAccountIds`) sobre el que se debe presentar la información.
- **Rango_Fechas**: Par de fechas (`startDate`, `endDate`) seleccionado en el Costs_Dashboard que delimita el periodo de los datos mostrados.
- **CurFullSnapshot**: Estructura de datos devuelta por `/api/finops/cur-direct` (definida en `src/lib/athena-cur.ts`) que contiene `byAccount`, `byService`, `dailyCosts`, `topResources`, `hiddenCosts`, `ec2Fleet`, `byDomain`, `byEnvironment` y otras dimensiones de coste leídas del CUR vía Athena.
- **Costes_Ocultos**: Apartado "Optimización y costes ocultos" del Costs_Dashboard (`hiddenCosts` en `CurFullSnapshot`, renderizado por `cur-deep-insights.tsx`) que agrupa quick wins detectados automáticamente (gp2, extended support, CloudWatch Logs, NAT gateways, Bedrock, snapshots, inter-AZ).
- **EC2_Fleet**: Tabla de distribución de gasto de instancias EC2 por instance type (`ec2Fleet` en `CurFullSnapshot`), mostrada dentro del apartado de optimización.
- **Explorador_Comparativas**: Nueva vista dedicada o modal que permite comparar el coste de dos o más meses con drill-down jerárquico y gráficas.
- **Nivel**: Cada uno de los tres planos jerárquicos del Explorador_Comparativas: `cuenta`, `servicio` y `objeto` (recurso individual del CUR, equivalente a `topResources`).
- **Mes_Comparado**: Cada mes natural seleccionado por el usuario para incluir en la comparativa del Explorador_Comparativas.
- **Variación**: Diferencia de coste de una entidad (cuenta, servicio u objeto) entre dos Mes_Comparado, expresada como variación absoluta en euros (Δ€) y como variación porcentual (Δ%).
- **Entidad**: Elemento concreto de un Nivel sobre el que se calcula la comparativa: una cuenta en el nivel cuenta, un servicio en el nivel servicio, o un recurso en el nivel objeto.

## Requirements

### Requirement 1: Alcance estricto por cuenta en todo el dashboard (PARTE A)

**User Story:** Como analista FinOps, quiero que todo lo que se muestra en la pestaña "Costes" corresponda únicamente a las cuentas que he seleccionado, para no tomar decisiones basadas en datos de cuentas que no estoy analizando.

#### Acceptance Criteria

1. WHEN el usuario ejecuta un análisis con un conjunto de cuentas en el Filtro_Cuentas, THE Costs_Dashboard SHALL presentar en cada sección visible únicamente datos cuyas cuentas pertenezcan al conjunto seleccionado en el Filtro_Cuentas.
2. WHEN el usuario ejecuta un análisis, THE Costs_Dashboard SHALL incluir en el apartado Costes_Ocultos únicamente registros cuyas cuentas pertenezcan al conjunto seleccionado en el Filtro_Cuentas.
3. WHEN el usuario ejecuta un análisis, THE Costs_Dashboard SHALL mostrar en la tabla EC2_Fleet únicamente instancias cuyas cuentas pertenezcan al conjunto seleccionado en el Filtro_Cuentas.
4. IF una sección no tiene datos para las cuentas seleccionadas en el Filtro_Cuentas, THEN THE Costs_Dashboard SHALL mostrar un estado vacío o valor cero para esa sección sin presentar datos de cuentas no seleccionadas.
5. WHEN el usuario modifica el conjunto de cuentas en el Filtro_Cuentas y vuelve a ejecutar el análisis, THE Costs_Dashboard SHALL recalcular todas las secciones para reflejar exclusivamente el nuevo conjunto de cuentas seleccionado.

### Requirement 2: Consistencia del filtro de cuentas entre datos y presentación (PARTE A)

**User Story:** Como analista FinOps, quiero que el filtrado por cuenta sea coherente entre los datos que devuelve el backend y lo que se renderiza en pantalla, para que no aparezcan instancias o costes de cuentas que el origen de datos no debería haber devuelto.

#### Acceptance Criteria

1. WHEN el Costs_Dashboard solicita datos a `/api/finops/cur-direct`, THE Costs_Dashboard SHALL transmitir el conjunto de cuentas seleccionado en el Filtro_Cuentas mediante el parámetro `accountIds`.
2. WHEN `/api/finops/cur-direct` recibe el parámetro `accountIds` con un conjunto explícito de cuentas, THE Cur_Direct_Endpoint SHALL devolver un CurFullSnapshot cuyas secciones contengan únicamente datos de las cuentas indicadas en `accountIds`.
3. IF el CurFullSnapshot recibido contiene en alguna sección registros cuya cuenta no pertenece al conjunto seleccionado en el Filtro_Cuentas, THEN THE Costs_Dashboard SHALL excluir esos registros antes de renderizar la sección.
4. WHERE una sección del CurFullSnapshot identifica cada registro por cuenta, THE Costs_Dashboard SHALL aplicar el mismo conjunto de cuentas del Filtro_Cuentas como criterio de inclusión para esa sección.

### Requirement 3: Apertura del Explorador de comparativas (PARTE B)

**User Story:** Como responsable FinOps, quiero abrir un explorador de comparativas desde la pestaña "Costes", para analizar la evolución del coste entre meses sin saturar la vista principal del dashboard.

#### Acceptance Criteria

1. THE Costs_Dashboard SHALL presentar un control que permita abrir el Explorador_Comparativas.
2. WHEN el usuario activa el control de apertura, THE Explorador_Comparativas SHALL mostrarse como vista dedicada o ventana emergente diferenciada de las secciones embebidas de la pestaña "Costes".
3. WHEN el Explorador_Comparativas se abre, THE Explorador_Comparativas SHALL inicializarse con el mismo conjunto de cuentas seleccionado en el Filtro_Cuentas del Costs_Dashboard.
4. WHEN el usuario cierra el Explorador_Comparativas, THE Costs_Dashboard SHALL conservar el estado previo del Filtro_Cuentas y del Rango_Fechas.

### Requirement 4: Selección de meses a comparar (PARTE B)

**User Story:** Como responsable FinOps, quiero seleccionar dos o más meses, para compararlos entre sí dentro del explorador.

#### Acceptance Criteria

1. THE Explorador_Comparativas SHALL permitir al usuario seleccionar dos o más Mes_Comparado.
2. IF el usuario intenta generar la comparativa con menos de dos Mes_Comparado seleccionados, THEN THE Explorador_Comparativas SHALL impedir la generación y mostrar un mensaje indicando que se requieren al menos dos meses.
3. WHEN el usuario confirma una selección de dos o más Mes_Comparado, THE Explorador_Comparativas SHALL obtener los datos de coste de cada Mes_Comparado para las cuentas seleccionadas en el Filtro_Cuentas reutilizando la ruta de datos del CUR existente.
4. WHEN el usuario añade o elimina un Mes_Comparado de la selección, THE Explorador_Comparativas SHALL recalcular la comparativa para reflejar el conjunto de meses vigente.

### Requirement 5: Navegación jerárquica por niveles (PARTE B)

**User Story:** Como responsable FinOps, quiero desgranar la comparativa de cuenta a servicio y de servicio a objeto, para localizar el origen concreto de las variaciones de coste.

#### Acceptance Criteria

1. WHEN el Explorador_Comparativas presenta la comparativa inicial, THE Explorador_Comparativas SHALL mostrar el Nivel cuenta.
2. WHEN el usuario selecciona una Entidad del Nivel cuenta, THE Explorador_Comparativas SHALL mostrar el Nivel servicio correspondiente a la cuenta seleccionada.
3. WHEN el usuario selecciona una Entidad del Nivel servicio, THE Explorador_Comparativas SHALL mostrar el Nivel objeto correspondiente al servicio y cuenta seleccionados.
4. WHILE el usuario se encuentra en el Nivel servicio o en el Nivel objeto, THE Explorador_Comparativas SHALL ofrecer un control para regresar al Nivel inmediatamente superior.
5. WHILE el usuario navega entre niveles, THE Explorador_Comparativas SHALL mantener fija la selección de Mes_Comparado y de cuentas del Filtro_Cuentas.

### Requirement 6: Comparativa de importes y variación por fila (PARTE B)

**User Story:** Como responsable FinOps, quiero ver para cada fila el coste de cada mes junto a su variación absoluta y porcentual, para cuantificar de un vistazo cómo ha evolucionado cada elemento.

#### Acceptance Criteria

1. WHILE el Explorador_Comparativas muestra cualquier Nivel, THE Explorador_Comparativas SHALL mostrar para cada Entidad el importe de coste correspondiente a cada Mes_Comparado seleccionado.
2. WHILE el Explorador_Comparativas muestra cualquier Nivel, THE Explorador_Comparativas SHALL mostrar para cada Entidad la Variación absoluta en euros (Δ€) entre los Mes_Comparado.
3. WHILE el Explorador_Comparativas muestra cualquier Nivel, THE Explorador_Comparativas SHALL mostrar para cada Entidad la Variación porcentual (Δ%) entre los Mes_Comparado.
4. WHERE se comparan exactamente dos Mes_Comparado, THE Explorador_Comparativas SHALL calcular la Variación como la diferencia entre el mes más reciente y el mes más antiguo de la selección.
5. WHERE se comparan más de dos Mes_Comparado, THE Explorador_Comparativas SHALL mostrar la progresión de los importes a lo largo de los meses ordenados cronológicamente.
6. IF la Variación porcentual no es calculable porque el importe del mes base es cero, THEN THE Explorador_Comparativas SHALL indicar la Variación porcentual como no aplicable en lugar de mostrar un valor numérico erróneo.

### Requirement 7: Gráficas de comparación y progresión (PARTE B)

**User Story:** Como responsable FinOps, quiero ver gráficas además de la tabla en cada nivel, para percibir visualmente las comparativas y las progresiones entre meses.

#### Acceptance Criteria

1. WHILE el Explorador_Comparativas muestra cualquier Nivel, THE Explorador_Comparativas SHALL presentar una tabla acompañada de al menos una gráfica de comparación o progresión de coste entre los Mes_Comparado.
2. WHEN el usuario cambia de Nivel mediante drill-down, THE Explorador_Comparativas SHALL actualizar las gráficas para reflejar las Entidades del Nivel activo.
3. WHEN el usuario modifica la selección de Mes_Comparado, THE Explorador_Comparativas SHALL actualizar las gráficas para reflejar el conjunto de meses vigente.

### Requirement 8: Respeto del filtro de cuentas en el explorador (PARTE B)

**User Story:** Como responsable FinOps, quiero que el explorador respete las mismas cuentas que el resto del dashboard, para mantener coherencia con el análisis de la pestaña "Costes".

#### Acceptance Criteria

1. WHILE el Explorador_Comparativas está abierto, THE Explorador_Comparativas SHALL presentar en todos los niveles únicamente datos cuyas cuentas pertenezcan al conjunto seleccionado en el Filtro_Cuentas.
2. WHEN el Explorador_Comparativas solicita datos de un Mes_Comparado, THE Explorador_Comparativas SHALL transmitir el conjunto de cuentas seleccionado en el Filtro_Cuentas mediante el parámetro `accountIds`.
3. WHEN el Nivel cuenta del Explorador_Comparativas se muestra, THE Explorador_Comparativas SHALL listar como Entidades únicamente las cuentas pertenecientes al conjunto seleccionado en el Filtro_Cuentas.

### Requirement 9: Tratamiento de datos ausentes entre meses (PARTE B)

**User Story:** Como responsable FinOps, quiero que las cuentas, servicios u objetos que no tienen datos en alguno de los meses se traten como cero, para que la comparativa sea consistente y no oculte altas o bajas de coste.

#### Acceptance Criteria

1. IF una Entidad tiene datos de coste en al menos un Mes_Comparado pero carece de datos en otro Mes_Comparado, THEN THE Explorador_Comparativas SHALL representar el coste de la Entidad en el mes sin datos como cero.
2. WHEN una Entidad aparece únicamente en el mes más reciente de la selección, THE Explorador_Comparativas SHALL mostrar la Entidad como un alta de coste con valor cero en el mes anterior.
3. WHEN una Entidad aparece únicamente en el mes más antiguo de la selección, THE Explorador_Comparativas SHALL mostrar la Entidad como una baja de coste con valor cero en el mes más reciente.
4. WHEN el Explorador_Comparativas calcula la Variación de una Entidad con un mes a cero, THE Explorador_Comparativas SHALL calcular la Variación absoluta usando el valor cero como importe de ese mes.

### Requirement 10: Reutilización de endpoints y caché (PARTE B)

**User Story:** Como ingeniero de plataforma, quiero que el explorador reutilice la ruta de datos del CUR existente con un comportamiento de caché razonable, para no introducir nuevas fuentes de datos ni penalizar el rendimiento.

#### Acceptance Criteria

1. THE Explorador_Comparativas SHALL obtener los datos de coste de cada Mes_Comparado a través de la ruta de datos del CUR existente (`/api/finops/cur-direct` y `src/lib/athena-cur.ts`) sin introducir una fuente de datos distinta del CUR.
2. WHEN el usuario solicita una comparativa con un conjunto de meses y cuentas ya consultado previamente, THE Cur_Direct_Endpoint SHALL servir el resultado desde la caché existente mientras la entrada de caché siga vigente.
3. WHILE el Explorador_Comparativas está recuperando datos de uno o varios Mes_Comparado, THE Explorador_Comparativas SHALL mostrar un indicador de carga hasta que los datos estén disponibles.
4. IF la recuperación de datos de un Mes_Comparado falla, THEN THE Explorador_Comparativas SHALL mostrar un mensaje de error para ese mes sin impedir la visualización de los meses recuperados correctamente.

### Requirement 11: Accesibilidad básica del explorador (PARTE B)

**User Story:** Como usuario del portal, quiero que el modal, la tabla y las gráficas del explorador sean accesibles, para poder operarlos con teclado y con tecnologías de apoyo.

#### Acceptance Criteria

1. WHEN el Explorador_Comparativas se presenta como ventana emergente, THE Explorador_Comparativas SHALL exponer un rol y un título accesibles que identifiquen la ventana.
2. WHILE el Explorador_Comparativas está abierto como ventana emergente, THE Explorador_Comparativas SHALL permitir cerrarlo mediante teclado.
3. THE Explorador_Comparativas SHALL exponer la tabla comparativa con encabezados de columna asociados a sus celdas de datos.
4. THE Explorador_Comparativas SHALL proporcionar para cada gráfica una alternativa textual o una tabla equivalente que comunique los valores representados.
5. WHILE el usuario navega entre niveles mediante drill-down, THE Explorador_Comparativas SHALL permitir activar los controles de navegación mediante teclado.
