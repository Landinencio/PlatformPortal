# Requirements Document

## Introduction

Esta feature rehace de cero la pestaña de análisis de coste de EKS del Platform Portal (hoy
"EKS Allocation" en `/finops`, componente `k8s-allocation-dashboard.tsx`). El problema actual es
que la vista es "una locura de tablas con números infinitos que nadie mira". El objetivo es una
experiencia visual al estilo del resto de FinOps del portal (gráficas con Recharts), centrada en
un mensaje claro: **el coste real de EKS es el NODO**, y el ahorro nace de reducir el número de
nodos ajustando `requests`/`limits` de los workloads (rightsizing) para que el cluster-autoscaler
pueda escalar hacia abajo.

La feature debe conectar de forma explícita la cadena de valor:
`recursos sobre-provisionados → nodos de más → coste en € → recomendación concreta de ajuste → ahorro estimado en €`.

Aprovecha la infraestructura de datos ya existente: métricas de OpenCost + recomendaciones VPA +
métricas de coste de nodo en Grafana Cloud (Prometheus/Mimir), cableadas vía
`src/lib/grafana-metrics.ts` y `src/lib/k8s-finops.ts`. Los nuevos nodegroups por IaC garantizan
afinidad pod→nodegroup ("cada pod en su nodo"), lo que permite atribuir el coste de un nodo a un
workload/equipo de forma fiable.

Alcance: los 4 clusters EKS (dp-dev, dp-uat, dp-prd, dp-tooling, todos en eu-west-1). La pestaña es
accesible a rol `desarrolladores` o superior; los `externos` no tienen acceso a FinOps.

Fuera de alcance (para esta iteración): coste de EBS/PV (métrica `kubecost_pv_info` sin series hoy),
aplicación automática de recomendaciones (la feature solo recomienda; el usuario aplica el cambio
en su chart de Helm), y el análisis de coste AWS ajeno a Kubernetes (que ya cubre la pestaña Costes).

## Glossary

- **EKS_Cost_Dashboard**: componente frontend de la pestaña rediseñada de análisis de coste de EKS.
- **Node_Cost_Service**: servicio backend que calcula el coste por nodo, nodegroup, entorno y equipo
  a partir de las métricas de OpenCost. Sustituye/reescribe la lógica de `src/lib/k8s-finops.ts`.
- **Rightsizing_Engine**: componente backend que genera recomendaciones de ajuste de `requests`/`limits`
  y estima el ahorro en euros, combinando uso real (p95) y recomendaciones VPA.
- **Metrics_Provider**: origen de datos de runtime, Grafana Cloud (Prometheus/Mimir) con las métricas
  de OpenCost y de VPA, accedido vía `grafanaMetricsClient`.
- **Cost_API**: endpoint HTTP del portal que expone los datos calculados al frontend
  (evoluciona `GET /api/finops/k8s-allocation`).
- **Nodegroup**: grupo de nodos EKS gestionado por IaC, identificado por su nombre y asociado a un
  cluster/entorno. Es la unidad de coste que el usuario reconoce como "sus nodos".
- **Cluster**: cluster EKS identificado por la etiqueta `k8s_cluster_name` (dp-dev, dp-uat, dp-prd,
  dp-tooling). Cada cluster representa un entorno.
- **Environment**: entorno lógico (dev, uat, prod, tooling), derivado del `Cluster`.
- **Workload**: deployment/statefulset/daemonset agrupado por nombre normalizado de pod.
- **Squad**: equipo propietario de un workload, derivado de una etiqueta de propiedad
  (label de squad/namespace).
- **Recommendation**: propuesta concreta de cambio de `requests`/`limits` para un workload, con su
  ahorro estimado en euros mensuales y su clasificación (sobre-provisionado / infra-provisionado).
- **Overprovisioning**: situación en la que las `requests` asignadas de un workload superan de forma
  significativa su uso real observado (p95).
- **Underprovisioning**: situación en la que las `requests` asignadas de un workload quedan por debajo
  del uso real observado (p95), con riesgo de throttling u OOM.
- **Monthly_Cost**: coste proyectado a 30 días (convención 730 horas/mes) en euros.
- **Estimated_Savings**: ahorro mensual estimado en euros derivado de aplicar una `Recommendation`.
- **Session_Role**: rol RBAC del usuario autenticado (admin, directores, staff, desarrolladores, externos).

## Requirements

### Requirement 1: Vista de coste centrada en el nodo por entorno

**User Story:** Como desarrollador o miembro de SRE, quiero ver de un vistazo lo que cuestan los nodos
de cada entorno y nodegroup, para entender dónde está el gasto real de EKS sin leer tablas infinitas.

#### Acceptance Criteria

1. WHEN un usuario abre el EKS_Cost_Dashboard, THE EKS_Cost_Dashboard SHALL mostrar el Monthly_Cost total de nodos agregado por Environment.
2. WHEN el EKS_Cost_Service calcula el coste de un Environment, THE Node_Cost_Service SHALL desglosar el Monthly_Cost por Nodegroup dentro de ese Environment.
3. THE Node_Cost_Service SHALL calcular el Monthly_Cost de nodos multiplicando el coste horario de nodo (`node_total_hourly_cost`) por 730 horas.
4. WHEN el EKS_Cost_Dashboard muestra el coste de un Nodegroup, THE EKS_Cost_Dashboard SHALL incluir el número de nodos y el número de nodos spot de ese Nodegroup.
5. WHERE un Nodegroup contiene nodos spot, THE EKS_Cost_Dashboard SHALL mostrar el porcentaje de cobertura spot de ese Nodegroup.
6. IF un Nodegroup no tiene nodos spot en ejecución, THEN THE EKS_Cost_Dashboard SHALL mostrar 0% de cobertura spot.
7. THE EKS_Cost_Dashboard SHALL presentar el coste por Environment y por Nodegroup mediante gráficas Recharts en lugar de tablas de datos primarias.

### Requirement 2: Atribución de coste de nodo a workload y equipo

**User Story:** Como desarrollador, quiero ver el coste atribuido a mis workloads y a mi squad, para
saber cuánto cuesta lo que mi equipo despliega y priorizar la optimización.

#### Acceptance Criteria

1. WHEN el Node_Cost_Service atribuye coste, THE Node_Cost_Service SHALL asignar el coste de cada nodo a los Workloads que se ejecutan en ese nodo según su asignación de CPU y memoria (`container_cpu_allocation`, `container_memory_allocation_bytes`).
2. THE Node_Cost_Service SHALL agregar el Monthly_Cost por Squad usando la etiqueta de propiedad del Workload.
3. IF un Workload no tiene Squad identificable, THEN THE Node_Cost_Service SHALL clasificar su coste bajo un Squad de valor "sin asignar".
4. WHEN el EKS_Cost_Dashboard muestra la atribución por Squad, THE EKS_Cost_Dashboard SHALL ordenar los Squads de mayor a menor Monthly_Cost.
5. THE Node_Cost_Service SHALL preservar la división por bytes dentro de la agregación PromQL (`/(1024*1024*1024)` dentro del `sum by`) para conservar las etiquetas.

### Requirement 3: Detección de over-provisioning

**User Story:** Como responsable de un equipo, quiero saber qué workloads piden más recursos de los
que usan, para reducir sus `requests` y bajar el número de nodos.

#### Acceptance Criteria

1. WHEN el Rightsizing_Engine evalúa un Workload, THE Rightsizing_Engine SHALL comparar las `requests` asignadas de CPU y memoria contra el uso real p95 de los últimos 7 días.
2. IF las `requests` de CPU de un Workload superan su target de CPU calculado, THEN THE Rightsizing_Engine SHALL clasificar ese Workload como Overprovisioning en CPU.
3. IF las `requests` de memoria de un Workload superan su target de memoria calculado, THEN THE Rightsizing_Engine SHALL clasificar ese Workload como Overprovisioning en memoria.
4. THE Rightsizing_Engine SHALL calcular el target de CPU como el máximo entre `p95_cpu_7d / 0.5` y `0.1` cores multiplicado por el número de pods del Workload.
5. THE Rightsizing_Engine SHALL calcular el target de memoria como el máximo entre `p95_ram_7d / 0.7` y `0.125` GiB multiplicado por el número de pods del Workload.
6. WHERE existe una recomendación VPA para un Workload, THE Rightsizing_Engine SHALL usar el `upperbound` de memoria del VPA como valor recomendado de memoria para evitar riesgo de OOM.
7. IF un Workload tiene menos de 60 minutos de tiempo de vida acumulado en 7 días, THEN THE Rightsizing_Engine SHALL excluir ese Workload de la detección de Overprovisioning.

### Requirement 4: Detección de under-provisioning

**User Story:** Como desarrollador, quiero que me avisen cuando un workload pide menos recursos de los
que consume, para subir sus `requests` y evitar throttling o caídas por OOM.

#### Acceptance Criteria

1. IF el uso real p95 de CPU de un Workload supera sus `requests` de CPU asignadas, THEN THE Rightsizing_Engine SHALL clasificar ese Workload como Underprovisioning en CPU.
2. IF el uso real p95 de memoria de un Workload supera sus `requests` de memoria asignadas, THEN THE Rightsizing_Engine SHALL clasificar ese Workload como Underprovisioning en memoria.
3. WHEN el Rightsizing_Engine detecta Underprovisioning de memoria y Underprovisioning de CPU en el mismo Workload, THE Rightsizing_Engine SHALL priorizar la recomendación de memoria por su mayor riesgo de OOM.
4. WHEN el Rightsizing_Engine recomienda subir un recurso, THE Rightsizing_Engine SHALL indicar el valor `request` actual y el valor recomendado.

### Requirement 5: Recomendaciones concretas con ahorro estimado y conexión al coste de nodo

**User Story:** Como desarrollador, quiero recomendaciones concretas de ajuste con el ahorro en euros
y la explicación de por qué mi nodegroup no baja de nodos, para actuar con datos y no a ciegas.

#### Acceptance Criteria

1. WHEN el Rightsizing_Engine genera una Recommendation de Overprovisioning, THE Rightsizing_Engine SHALL calcular el Estimated_Savings como la diferencia entre coste asignado y coste del target, multiplicada por el coste unitario del recurso.
2. THE Rightsizing_Engine SHALL limitar el Estimated_Savings reportado al 70% del Monthly_Cost actual del Workload.
3. WHEN el EKS_Cost_Dashboard muestra una Recommendation, THE EKS_Cost_Dashboard SHALL mostrar el valor `request` actual, el valor recomendado y el Estimated_Savings en euros mensuales.
4. WHEN el EKS_Cost_Dashboard muestra las recomendaciones de un Nodegroup, THE EKS_Cost_Dashboard SHALL mostrar el Estimated_Savings agregado de ese Nodegroup.
5. THE EKS_Cost_Dashboard SHALL mostrar un mensaje explicativo que relacione el Overprovisioning agregado del Nodegroup con el exceso de nodos que impide al autoscaler reducir el Nodegroup.
6. WHERE un Workload dispone de una Recommendation aplicable, THE EKS_Cost_Dashboard SHALL ofrecer un bloque de configuración `resources` (formato YAML de Kubernetes) listo para copiar.

### Requirement 6: Filtrado y navegación

**User Story:** Como usuario, quiero filtrar la vista por entorno, nodegroup y equipo, para centrarme
en lo que me interesa.

#### Acceptance Criteria

1. WHEN un usuario selecciona un Environment en el EKS_Cost_Dashboard, THE EKS_Cost_Dashboard SHALL filtrar el coste, la atribución y las recomendaciones mostradas a ese Environment.
2. WHERE un usuario selecciona un Nodegroup, THE EKS_Cost_Dashboard SHALL filtrar la vista a los Workloads de ese Nodegroup.
3. WHERE un usuario selecciona un Squad, THE EKS_Cost_Dashboard SHALL filtrar la vista a los Workloads de ese Squad.
4. WHEN un usuario no ha aplicado ningún filtro, THE EKS_Cost_Dashboard SHALL mostrar los datos agregados de todos los Environments.
5. IF una operación de filtrado falla por un problema técnico, THEN THE EKS_Cost_Dashboard SHALL permitir al usuario continuar con los datos sin filtrar.

### Requirement 7: Control de acceso RBAC

**User Story:** Como responsable de la plataforma, quiero que solo desarrolladores y roles superiores
accedan al análisis de coste de EKS, para mantener la información de coste fuera del alcance de externos.

#### Acceptance Criteria

1. WHEN un usuario no autenticado solicita la Cost_API, THE Cost_API SHALL responder con estado HTTP 401.
2. IF el Session_Role de un usuario autenticado es inferior a `desarrolladores`, THEN THE Cost_API SHALL responder con estado HTTP 403.
3. IF el Session_Role de un usuario autenticado es inferior a `desarrolladores`, THEN THE Cost_API SHALL omitir cualquier dato de coste en el cuerpo de la respuesta.
4. WHEN un usuario con Session_Role `desarrolladores` o superior solicita la Cost_API, THE Cost_API SHALL devolver los datos de coste calculados.

### Requirement 8: Origen de datos y degradación ante fallos

**User Story:** Como usuario, quiero que la pestaña funcione con los datos disponibles y me informe
cuando falte alguna fuente, para no ver una pantalla rota ni datos silenciosamente incorrectos.

#### Acceptance Criteria

1. IF el Metrics_Provider no está configurado (faltan variables de entorno de credenciales), THEN THE Cost_API SHALL responder con estado HTTP 500 y un mensaje que identifique las variables ausentes por nombre.
2. IF una consulta individual al Metrics_Provider falla, THEN THE Node_Cost_Service SHALL devolver el resto de secciones calculadas y registrar el fallo como aviso en la respuesta.
3. WHEN la respuesta de la Cost_API contiene avisos, THE EKS_Cost_Dashboard SHALL mostrar esos avisos al usuario.
4. WHILE la Cost_API está resolviendo la petición, THE EKS_Cost_Dashboard SHALL mostrar un indicador de carga.
5. IF la Cost_API responde con error, THEN THE EKS_Cost_Dashboard SHALL mostrar el mensaje de error y ofrecer una acción de reintento.

### Requirement 9: Rendimiento y frescura de datos

**User Story:** Como usuario, quiero que la pestaña cargue rápido y muestre datos suficientemente
recientes, para no esperar en cada visita ni tomar decisiones con datos obsoletos.

#### Acceptance Criteria

1. THE Cost_API SHALL cachear la respuesta calculada durante 5 minutos.
2. WHEN un usuario solicita datos dentro de la ventana de caché, THE Cost_API SHALL devolver la respuesta cacheada sin volver a consultar el Metrics_Provider.
3. WHILE la respuesta calculada esté dentro de la ventana de caché, THE Cost_API SHALL devolver la respuesta cacheada aunque el usuario solicite un refresco explícito.
4. WHEN el EKS_Cost_Dashboard muestra los datos, THE EKS_Cost_Dashboard SHALL indicar la marca de tiempo de generación de los datos.
5. WHEN un usuario solicita explícitamente refrescar los datos, THE EKS_Cost_Dashboard SHALL volver a solicitar los datos a la Cost_API.

### Requirement 10: Generación de valores de configuración recomendados

**User Story:** Como desarrollador, quiero copiar directamente los valores `requests`/`limits`
recomendados en formato Kubernetes, para aplicarlos en mi chart sin recalcular a mano.

#### Acceptance Criteria

1. WHEN el Rightsizing_Engine produce un valor recomendado de CPU, THE Rightsizing_Engine SHALL expresarlo en unidades Kubernetes (cores enteros o milicores `m`).
2. WHEN el Rightsizing_Engine produce un valor recomendado de memoria, THE Rightsizing_Engine SHALL expresarlo en unidades Kubernetes (`Mi` o `Gi`).
3. WHEN el EKS_Cost_Dashboard genera el bloque `resources` recomendado, THE EKS_Cost_Dashboard SHALL incluir `requests` de CPU y memoria y `limits` de memoria.
4. FOR ALL valores recomendados de CPU y memoria, convertir un valor de recurso a su representación en unidades Kubernetes y volver a interpretarlo SHALL producir un valor equivalente al original dentro de la tolerancia de redondeo de la unidad (propiedad round-trip).
