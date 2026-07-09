# Requirements Document

## Introduction

Este documento define los requisitos de un **estudio FinOps de ahorro** (no una funcionalidad de software) sobre las ~30 cuentas AWS de IskayPet. El objetivo es producir un **informe de ahorro defendible y totalmente reproducible** que el SRE Lead usará para fijar objetivos presentables a dirección.

La exigencia número uno es la **fiabilidad total**: cada cifra del informe debe ser trazable a su consulta CUR (con fecha y mes de referencia) y al recurso real que la origina; y cada estimación de ahorro debe declarar su supuesto de descuento, el porcentaje direccionable, el riesgo, el esfuerzo y el responsable. El estudio debe distinguir de forma explícita entre **ahorro garantizado** (desperdicio puro, verificado contra recursos vivos) y **ahorro estimado** (compromisos, rightsizing, reducción de logs; con supuestos explícitos y rangos honestos).

El estudio parte de una base de datos ya recopilada vía CUR 2.0 (Athena, DB `athenacurcfn_finnops` tabla `data`, cuenta `600700800900`, rol `Cur-AWSS3CURLambdaExecutor`, región eu-west-1, salida `s3://finnops-iskaypet/athena-query-results/`), con **MAYO 2026** como mes de referencia (último mes completo; el CUR cubre 2025-07 → 2026-06). Esa base debe ser re-validada y ampliada por el estudio, no asumida como definitiva.

El entregable es analítico (informe + evidencias + consultas reproducibles), no código de aplicación. Las tareas posteriores serán pasos de análisis y verificación.

## Glossary

- **Estudio**: El proceso de evaluación FinOps de ahorro completo sobre las cuentas AWS de IskayPet, incluyendo extracción de datos, verificación, clasificación y elaboración del informe.
- **Informe**: El entregable final del Estudio: documento de ahorro defendible con cifras, evidencias, supuestos y derivación de objetivos.
- **Catálogo_Evidencias**: El conjunto estructurado de registros de evidencia que respaldan cada cifra del Informe (consulta CUR, fecha, mes de referencia, recurso y, cuando aplica, verificación contra recurso vivo).
- **Palanca**: Una oportunidad de ahorro concreta y direccionable (p. ej. cobertura de compromiso RDS, eliminación de Extended Support, migración gp2→gp3).
- **Sub_Palanca**: Una división de una Palanca cuya naturaleza de ahorro es mixta, separando la parte de desperdicio puro (candidata a Ahorro_Garantizado) de la parte sujeta a supuestos (Ahorro_Estimado), de modo que cada parte se clasifique y cuantifique de forma independiente.
- **Mes_Referencia**: El mes completo de CUR sobre el que se calculan las cifras base del Estudio. Valor inicial: mayo 2026 (periodo 2026-05, del 1 al 31 de mayo de 2026 inclusive, en zona horaria de facturación AWS UTC).
- **CUR**: Cost and Usage Report 2.0 de AWS, consultado vía Athena (DB `athenacurcfn_finnops`, tabla `data`, eu-west-1).
- **Dataset_Congelado**: La instantánea del CUR del Mes_Referencia fijada a una fecha de extracción concreta, identificada por una versión, sobre la que se calculan todas las cifras base del Estudio para garantizar reproducibilidad.
- **Ahorro_Garantizado**: Ahorro derivado de desperdicio puro, eliminable sin pérdida de capacidad y verificado contra el recurso vivo (p. ej. Extended Support de motor EOL, volúmenes EBS huérfanos).
- **Ahorro_Estimado**: Ahorro que depende de supuestos (tasa de descuento de compromiso, porcentaje direccionable, perfil de uso) y que se expresa como rango, no como cifra única.
- **Ahorro_Estimado_Total**: Suma de los ahorros clasificados como Ahorro_Estimado, expresada como rango (suma de Rango_Conservador y suma de Rango_Agresivo).
- **Barrido_Utilizacion**: Análisis de utilización real (cobertura de compromiso, perfil 24/7 vs intermitente, p95 de CPU/RAM, horas Spot) que debe completarse antes de convertir un Ahorro_Estimado en un objetivo comprometido.
- **Verificacion_Recurso_Vivo**: Comprobación mediante llamadas de descripción de solo lectura (describe/list/get, p. ej. `describe-db-instances`, `describe-volumes`) que confirma que un candidato derivado del CUR existe y tiene las características asumidas, sin ejecutar ninguna operación mutante.
- **Palanca_Comercial**: Oportunidad de ahorro de naturaleza contractual/negociación (p. ej. el contrato Marketplace), señalada de forma separada y no contabilizada como ahorro técnico.
- **Rango_Conservador**: Límite inferior de un Ahorro_Estimado, con los supuestos más prudentes.
- **Rango_Agresivo**: Límite superior de un Ahorro_Estimado, con los supuestos más favorables defendibles.

## Requirements

### Requirement 1: Alcance y mes de referencia

**User Story:** Como SRE Lead, quiero que el Estudio cubra todas las cuentas con un mes de referencia y unas fronteras de alcance claras, para que el ahorro sea comparable y defendible.

#### Acceptance Criteria

1. THE Estudio SHALL analizar todas las cuentas AWS de la organización IskayPet listadas en el mapa de cuentas de `portal-architecture.md` (secciones 3 y 7), incluyendo en el alcance cada cuenta listada aunque presente cero filas en el CUR del Mes_Referencia.
2. THE Estudio SHALL designar mayo 2026 (periodo del 1 al 31 de mayo de 2026, ambos inclusive, en zona horaria de facturación AWS UTC) como Mes_Referencia inicial para todas las cifras base.
3. WHEN se calcula una cifra base de coste, THE Estudio SHALL declarar junto a esa cifra el Mes_Referencia, la fecha de extracción del CUR y la moneda, que SHALL ser USD.
4. THE Estudio SHALL documentar, en una lista explícita de partidas, cuáles quedan dentro del alcance del ahorro técnico y cuáles fuera, de modo que cada partida del CUR del Mes_Referencia esté asignada exactamente a uno de los dos conjuntos.
5. WHERE una partida es de naturaleza contractual o de negociación, THE Estudio SHALL clasificarla como Palanca_Comercial y excluirla del total de ahorro técnico.
6. THE Estudio SHALL separar las cifras de infraestructura AWS del contrato Marketplace, de la sobrecarga PAYG del mismo producto, de Tax y de las suscripciones de tarifa plana, presentando cada uno de estos cinco grupos como importe independiente en USD.
7. IF una cuenta del alcance presenta cero filas en el CUR del Mes_Referencia, THEN THE Estudio SHALL registrarla con coste base de 0,00 USD y marcarla como "sin datos de coste en el Mes_Referencia", en lugar de excluirla.
8. IF el analista no puede acceder a una cuenta para verificación en vivo, THEN THE Estudio SHALL derivar las cifras de esa cuenta únicamente del CUR, marcarla como "verificación en vivo no disponible" y mantenerla en el alcance.
9. IF en la fecha de extracción los datos del CUR de mayo 2026 están incompletos, THEN THE Estudio SHALL indicar el grado de completitud (días cubiertos respecto a 31) y abstenerse de presentar como definitiva cualquier cifra base afectada hasta disponer del mes cerrado.

### Requirement 2: Trazabilidad de cada cifra (barra de evidencia)

**User Story:** Como SRE Lead, quiero que cada número del Informe sea trazable a su origen, para poder defender el Estudio ante dirección sin ambigüedad.

#### Acceptance Criteria

1. WHEN el Informe presenta una cifra de coste, THE Estudio SHALL registrar en el Catálogo_Evidencias la consulta CUR exacta, el Mes_Referencia en formato AAAA-MM y la fecha de extracción con marca temporal y zona horaria que producen esa cifra.
2. WHEN una cifra se atribuye a un recurso concreto, THE Estudio SHALL registrar el identificador del recurso real en formato explícito (ARN completo, identificador de instancia o identificador de volumen) que la origina.
3. WHEN una cifra agrega el coste de múltiples recursos, THE Estudio SHALL registrar la lista de identificadores de recurso incluidos junto con la dimensión y el valor de agregación aplicados.
4. WHEN una cifra no es atribuible a un recurso (p. ej. impuestos, descuentos o totales agregados), THE Estudio SHALL registrar la consulta CUR que la produce y etiquetarla como "no atribuible a recurso".
5. THE Estudio SHALL fijar todas las cifras base al Dataset_Congelado del Mes_Referencia, registrando su identificador de versión en el Catálogo_Evidencias.
6. IF una cifra no puede vincularse a una consulta CUR documentada ni a un recurso identificable ni a un registro de "no atribuible a recurso", THEN THE Estudio SHALL excluir esa cifra del Informe o marcarla explícitamente como no verificada.
7. THE Catálogo_Evidencias SHALL mantener una correspondencia uno-a-uno al 100% entre cada cifra publicada en el Informe y su registro de evidencia.

### Requirement 3: Clasificación garantizado vs estimado

**User Story:** Como SRE Lead, quiero distinguir el ahorro seguro del ahorro sujeto a supuestos, para no comprometer ante dirección cifras que aún no están confirmadas.

#### Acceptance Criteria

1. THE Estudio SHALL clasificar cada Palanca como Ahorro_Garantizado o Ahorro_Estimado, de forma que la clasificación sea mutuamente excluyente y exhaustiva (cada Palanca pertenece a exactamente una de las dos categorías).
2. WHERE una Palanca se clasifica como Ahorro_Garantizado, THE Estudio SHALL aportar la Verificacion_Recurso_Vivo que confirma que es desperdicio eliminable sin pérdida de capacidad, con una frescura igual o inferior a 30 días respecto a la fecha de publicación del Informe.
3. WHERE una Palanca se clasifica como Ahorro_Estimado, THE Estudio SHALL expresar su ahorro como un rango entre Rango_Conservador y Rango_Agresivo cumpliendo la invariante 0 < Rango_Conservador ≤ Rango_Agresivo, nunca como una cifra única.
4. WHERE una Palanca combina desperdicio puro y ahorro sujeto a supuestos, THE Estudio SHALL dividirla en Sub_Palancas, clasificando la parte de desperdicio como Ahorro_Garantizado y la parte sujeta a supuestos como Ahorro_Estimado.
5. IF la Verificacion_Recurso_Vivo de una Palanca clasificada como Ahorro_Garantizado falla, THEN THE Estudio SHALL reclasificarla como Ahorro_Estimado o retirarla del ahorro contabilizado, registrando el motivo en el Catálogo_Evidencias.
6. THE Informe SHALL presentar el total de Ahorro_Garantizado por separado del total de Ahorro_Estimado.

### Requirement 4: Documentación por palanca

**User Story:** Como SRE Lead, quiero que cada palanca documente sus supuestos y su plan, para poder priorizar y asignar trabajo de forma justificada.

#### Acceptance Criteria

1. WHEN el Estudio documenta una Palanca, THE Estudio SHALL declarar el supuesto de descuento o de reducción aplicado como porcentaje entre 0 y 100 con un decimal.
2. WHEN el Estudio documenta una Palanca, THE Estudio SHALL declarar el porcentaje del coste direccionable por esa Palanca, entre 0 y 100 con un decimal, junto con el coste base mensual afectado en USD.
3. WHEN el Estudio documenta una Palanca, THE Estudio SHALL declarar el origen del supuesto de descuento, indicando si procede de "precio público AWS" o de "tarifa negociada", junto con la fecha del dato.
4. WHEN el Estudio documenta una Palanca, THE Estudio SHALL declarar el riesgo asociado a su implantación en la escala bajo/medio/alto.
5. WHEN el Estudio documenta una Palanca, THE Estudio SHALL declarar el esfuerzo estimado de implantación en la escala bajo/medio/alto.
6. WHEN el Estudio documenta una Palanca, THE Estudio SHALL asignar un responsable (owner) a esa Palanca mediante su correo corporativo; en caso de Palanca transversal, THE Estudio SHALL enumerar los equipos responsables.
7. IF el riesgo no es evaluable, el esfuerzo no es estimable o el owner es desconocido o transversal sin equipos identificados, THEN THE Estudio SHALL registrar ese campo como "pendiente" en lugar de omitirlo.

### Requirement 5: Verificación contra recursos vivos

**User Story:** Como SRE Lead, quiero que los candidatos derivados del CUR se confirmen contra los recursos reales, para no contar ahorros sobre supuestos erróneos.

#### Acceptance Criteria

1. WHEN una Palanca se basa en un candidato derivado del CUR, THE Estudio SHALL ejecutar una Verificacion_Recurso_Vivo empleando exclusivamente operaciones de solo lectura (describe/list/get) y sin ejecutar ninguna operación mutante (create/update/delete/modify) antes de contabilizar su ahorro.
2. WHEN un candidato referencia un recurso en una región distinta de eu-west-1 (p. ej. us-east-1 para WAF o CloudFront), THE Estudio SHALL ejecutar la Verificacion_Recurso_Vivo en la región donde reside el recurso.
3. IF la Verificacion_Recurso_Vivo no confirma la existencia o las características asumidas del recurso, THEN THE Estudio SHALL excluir ese candidato del ahorro contabilizado y registrar el motivo de exclusión.
4. IF la Verificacion_Recurso_Vivo no puede completarse porque la cuenta deniega los permisos de solo lectura necesarios, THEN THE Estudio SHALL marcar el candidato como "no verificable", excluirlo del ahorro contabilizado y registrar la causa.
5. THE Estudio SHALL registrar en el Catálogo_Evidencias el resultado de cada Verificacion_Recurso_Vivo, incluyendo fecha y hora en UTC, la cuenta consultada, la región consultada y el estado (confirmado / excluido / no verificable).

### Requirement 6: Modelo de confianza y anualización

**User Story:** Como SRE Lead, quiero rangos honestos y cifras anualizadas, para presentar objetivos realistas a dirección.

#### Acceptance Criteria

1. THE Estudio SHALL expresar cada Ahorro_Estimado mediante un Rango_Conservador y un Rango_Agresivo, donde cada rango tiene límite inferior y superior en la misma moneda y el inferior es menor o igual que el superior.
2. THE Estudio SHALL presentar cada Ahorro_Estimado en base mensual y en base anualizada, de forma diferenciada y etiquetada.
3. WHEN el Estudio anualiza un ahorro, THE Estudio SHALL calcularlo como el ahorro mensual del Mes_Referencia multiplicado por doce (12).
4. WHEN el Estudio presenta una cifra anualizada por multiplicación directa por doce, THE Estudio SHALL acompañarla de una advertencia explícita de que el método asume que el Mes_Referencia es representativo y no captura estacionalidad.
5. IF el ahorro corresponde a un compromiso de captura progresiva, THEN THE Estudio SHALL presentar el ahorro del primer año como captura parcial prorrateada según los meses efectivos de aplicación, diferenciada de la cifra en régimen estacionario, indicando el supuesto de prorrateo.
6. THE Informe SHALL presentar el total de ahorro como rango (suma de Rango_Conservador y suma de Rango_Agresivo), nunca como cifra puntual.
7. THE Estudio SHALL expresar todos los importes en una única moneda declarada (USD), redondeados a 2 decimales con redondeo half-up, sumando antes de redondear el total.

### Requirement 7: Reproducibilidad

**User Story:** Como SRE Lead, quiero que cualquier persona pueda re-ejecutar el Estudio, para que las cifras sean verificables de forma independiente.

#### Acceptance Criteria

1. THE Estudio SHALL documentar cada consulta CUR utilizada, en forma re-ejecutable contra la DB `athenacurcfn_finnops` tabla `data` en eu-west-1.
2. THE Estudio SHALL documentar la cadena de acceso a datos (rol `Cur-AWSS3CURLambdaExecutor`, cuenta `600700800900`, salida `s3://finnops-iskaypet/athena-query-results/`).
3. WHEN se re-ejecuta una consulta documentada sobre el mismo Dataset_Congelado y la misma fecha de extracción, THE Estudio SHALL producir la misma cifra que la publicada en el Informe, entendida como una diferencia de 0,00 USD.
4. IF la re-ejecución usa un CUR con datos de llegada tardía o reexpresados respecto a la fecha de extracción anclada, THEN THE Estudio SHALL fijar la comparación a la fecha de extracción del Dataset_Congelado y aceptar una varianza relativa máxima del 1%, marcando la cifra como discrepante si se supera ese umbral.
5. THE Estudio SHALL documentar las llamadas de descripción de solo lectura usadas en cada Verificacion_Recurso_Vivo, de forma re-ejecutable, referenciando las credenciales por nombre de rol o clave de secreto y sin incrustar credenciales ni tokens en las consultas documentadas.
6. WHEN una Verificacion_Recurso_Vivo se re-ejecuta en un momento posterior, THE Estudio SHALL tratar el drift del recurso vivo entre la verificación original y la re-ejecución (reflejado en las marcas temporales) como esperado, sin que invalide las cifras ancladas al Dataset_Congelado.

### Requirement 8: Análisis de cobertura de compromiso

**User Story:** Como SRE Lead, quiero analizar la cobertura de compromiso en cómputo y bases de datos, para cuantificar el ahorro por Savings Plans y Reserved Instances.

#### Acceptance Criteria

1. THE Estudio SHALL cuantificar la cobertura de compromiso de EC2, separando el coste cubierto por Savings Plans del coste on-demand, expresando la cobertura como importe en USD con 2 decimales y como porcentaje entre 0 y 100.
2. THE Estudio SHALL cuantificar la cobertura de compromiso de RDS, separando el cómputo de instancia del almacenamiento y los backups, e identificando el coste de cómputo sin cobertura RI/SP.
3. THE Estudio SHALL cuantificar la cobertura de compromiso de ElastiCache, OpenSearch y el cómputo de Fargate y Lambda cubrible por Compute Savings Plans.
4. THE Estudio SHALL definir "uso estable" como un uso presente en al menos el 90% de las horas dentro de una ventana de observación de al menos 30 días, y basar el porcentaje direccionable en ese criterio frente al uso intermitente.
5. WHEN el Estudio estima ahorro por compromiso, THE Estudio SHALL declarar la tasa de descuento supuesta, el plazo del compromiso (1 año y 3 años) y la opción de pago.
6. IF un uso on-demand es intermitente o de tipo ráfaga y no cumple el criterio de uso estable, THEN THE Estudio SHALL excluirlo del ahorro por compromiso y enrutarlo a las palancas de Spot o scheduling.
7. WHERE un Savings Plan o una Reserved Instance expira dentro del horizonte de anualización, THE Estudio SHALL listarlo con su fecha de expiración y el coste que quedaría sin cobertura, como coste direccionable a renovación.
8. THE Estudio SHALL garantizar la ausencia de doble conteo, asignando cada unidad de cómputo a una sola Palanca de ahorro.

### Requirement 9: Extended Support de motores EOL

**User Story:** Como SRE Lead, quiero cuantificar el coste de Extended Support de motores en fin de vida, para eliminarlo mediante actualización de motor.

#### Acceptance Criteria

1. THE Estudio SHALL cuantificar el coste total de RDS Extended Support facturado en el Mes_Referencia, en USD, agregado para todas las cuentas del alcance.
2. THE Estudio SHALL desglosar el coste de Extended Support por tramo de precio anual, diferenciando Año 1–Año 2 del Año 3.
3. THE Estudio SHALL identificar cada instancia con motor EOL sujeta a Extended Support, registrando al menos: identificador de recurso, cuenta, motor, versión y fecha de fin de soporte estándar.
4. WHERE una instancia incurre en Extended Support y su actualización no está bloqueada, THE Estudio SHALL clasificar su eliminación como Ahorro_Garantizado condicionada a la actualización de motor, indicando esfuerzo de migración estimado y nivel de riesgo (alto/medio/bajo).
5. WHERE la eliminación depende de una actualización de motor, THE Estudio SHALL marcar el Ahorro_Garantizado como condicionado a la validación previa de compatibilidad de la aplicación con la versión destino.
6. IF la actualización de motor está bloqueada por una dependencia, THEN THE Estudio SHALL excluir su ahorro de Ahorro_Garantizado, reclasificarlo como ahorro no realizable a corto plazo e identificar la dependencia.

### Requirement 10: EBS gp2, volúmenes huérfanos y snapshots

**User Story:** Como SRE Lead, quiero cuantificar el desperdicio en almacenamiento EBS, para eliminarlo o migrarlo.

#### Acceptance Criteria

1. THE Estudio SHALL cuantificar, por cuenta, el coste de volúmenes EBS aún en gp2 y el ahorro NETO de la migración a gp3, expresándolo como importe en USD y como porcentaje.
2. WHERE un volumen gp2 tiene un rendimiento aprovisionado superior a la línea base de gp3 (IOPS superiores a 3000 o throughput superior a 125 MiB/s), THE Estudio SHALL reducir el ahorro neto restando el coste del rendimiento extra que habría que aprovisionar en gp3.
3. THE Estudio SHALL identificar los volúmenes EBS en estado "available" (huérfanos) mediante Verificacion_Recurso_Vivo, registrando cuenta, identificador, tamaño en GiB y antigüedad desde la desasociación.
4. THE Estudio SHALL separar el coste de snapshots EBS elegibles para eliminación del coste de snapshots no elegibles en el Mes_Referencia.
5. IF un snapshot respalda una AMI o está cubierto por una política de retención, THEN THE Estudio SHALL marcarlo como no elegible y excluirlo del ahorro.
6. WHERE un volumen huérfano confirmado por Verificacion_Recurso_Vivo no presenta etiquetas de warm-spare, forense ni retención, THE Estudio SHALL clasificar su eliminación como Ahorro_Garantizado.
7. IF un volumen huérfano presenta etiquetas de warm-spare o forense, THEN THE Estudio SHALL marcarlo como pendiente de confirmación manual y excluirlo de Ahorro_Garantizado.

### Requirement 11: Logs de CloudWatch y WAF

**User Story:** Como SRE Lead, quiero cuantificar el coste de ingestión de logs de CloudWatch y WAF, para reducirlo redirigiendo a S3 y aplicando muestreo.

#### Acceptance Criteria

1. THE Estudio SHALL cuantificar el coste de logs de CloudWatch en el Mes_Referencia, identificando la cuenta y la región de origen de las mayores fuentes.
2. THE Estudio SHALL identificar el coste de logs de WAF de CloudFront ejecutando la Verificacion_Recurso_Vivo asociada en la región us-east-1, junto con su cuenta de origen.
3. WHERE un log group alimenta procesos de compliance o seguridad con retención obligatoria, THE Estudio SHALL marcarlo como no eliminable y considerar únicamente su redirección o muestreo.
4. WHEN el Estudio estima ahorro por reducción de logs, THE Estudio SHALL distinguir la reducción atribuible a redirección a S3, a muestreo y a metric filters, declarando para cada una el supuesto aplicado y el porcentaje direccionable.

### Requirement 12: Lifecycle e Intelligent-Tiering en S3

**User Story:** Como SRE Lead, quiero cuantificar el ahorro por políticas de ciclo de vida y tiering en S3, para optimizar el almacenamiento.

#### Acceptance Criteria

1. THE Estudio SHALL cuantificar el coste de S3 en clase Standard frente al coste en Intelligent-Tiering y Glacier en el Mes_Referencia.
2. WHERE un bucket contiene objetos de acceso frecuente en los que la cuota de monitorización de Intelligent-Tiering puede superar el ahorro de tiering, THE Estudio SHALL excluir esos objetos del ahorro y registrar el motivo.
3. WHERE un bucket tiene versionado activo o cargas multiparte (MPU) incompletas, THE Estudio SHALL considerar su impacto en el almacenamiento facturable al estimar el ahorro.
4. WHEN el Estudio estima ahorro por lifecycle o Intelligent-Tiering, THE Estudio SHALL declarar el supuesto de transición de clase, respetar la duración mínima de almacenamiento de las clases IA y Glacier, y declarar el porcentaje direccionable.

### Requirement 13: Rightsizing y Graviton por utilización real

**User Story:** Como SRE Lead, quiero que el rightsizing y la migración a Graviton se basen en utilización real, para no proponer recortes que rompan capacidad.

#### Acceptance Criteria

1. WHEN el Estudio propone rightsizing, THE Estudio SHALL basar la propuesta en métricas de utilización real (p95 de CPU y RAM) y no solo en el coste del CUR.
2. IF no hay métricas de utilización disponibles para un recurso candidato, THEN THE Estudio SHALL no proponer su rightsizing y marcarlo como pendiente de Barrido_Utilizacion.
3. THE Estudio SHALL identificar instancias candidatas a Graviton, con su familia de instancia y su perfil de uso, declarando como riesgo la necesidad de compatibilidad con arquitectura arm64.
4. WHERE un recurso pertenece a una familia burstable (tipo t), THE Estudio SHALL señalar que ya es de bajo coste y moderar la oportunidad de rightsizing en consecuencia.
5. WHEN el Estudio estima ahorro por rightsizing o Graviton, THE Estudio SHALL declarar el supuesto de reducción y el riesgo de impacto en capacidad.
6. THE Estudio SHALL clasificar el ahorro por rightsizing y Graviton como Ahorro_Estimado.

### Requirement 14: Red — NAT, VPN, EIP y VPC endpoints

**User Story:** Como SRE Lead, quiero revisar el coste de red ocioso, para eliminar recursos no utilizados.

#### Acceptance Criteria

1. THE Estudio SHALL cuantificar el coste de direcciones IPv4 ociosas, NAT Gateways, conexiones VPN IPsec y VPC endpoints en el Mes_Referencia.
2. THE Estudio SHALL identificar mediante Verificacion_Recurso_Vivo qué recursos de red están ociosos, duplicados o sin uso.
3. WHERE un NAT Gateway proporciona egress a subredes privadas en uso, THE Estudio SHALL tratarlo como necesario y considerar como desperdicio únicamente los NAT Gateways ociosos o duplicados.
4. WHERE un túnel VPN cumple función de backup o disaster recovery, o una redundancia de VPC endpoints por zona de disponibilidad es intencionada, THE Estudio SHALL excluir ese recurso del ahorro y registrar el motivo.
5. WHERE un recurso de red se confirma ocioso por Verificacion_Recurso_Vivo y no cumple función necesaria, THE Estudio SHALL clasificar su eliminación como Ahorro_Garantizado.

### Requirement 15: Entornos no productivos — scheduling y Spot

**User Story:** Como SRE Lead, quiero cuantificar el ahorro por apagar/programar y por usar Spot en entornos no productivos, para reducir el coste fuera de producción.

#### Acceptance Criteria

1. THE Estudio SHALL identificar recursos no productivos que se ejecutan 24/7 mediante Verificacion_Recurso_Vivo, con su cuenta e identificador.
2. WHERE un recurso no productivo debe permanecer disponible 24/7 (p. ej. entornos de QA compartidos o jobs nocturnos programados), THE Estudio SHALL excluirlo del ahorro por scheduling y registrar el motivo.
3. THE Estudio SHALL cuantificar el uso actual de Spot y la oportunidad de ampliarlo en entornos no productivos, declarando la tolerancia a interrupción requerida.
4. IF un workload es stateful o no tolera interrupciones, THEN THE Estudio SHALL excluirlo de la oportunidad de Spot y registrar el motivo.
5. WHEN el Estudio estima ahorro por scheduling o Spot, THE Estudio SHALL declarar el supuesto de horas reducidas y el riesgo asociado.
6. THE Estudio SHALL clasificar el ahorro por scheduling y Spot como Ahorro_Estimado.

### Requirement 16: Bedrock

**User Story:** Como SRE Lead, quiero cuantificar y optimizar el coste de Bedrock, para reducir el gasto de IA generativa.

#### Acceptance Criteria

1. THE Estudio SHALL cuantificar el coste de Bedrock en el Mes_Referencia, con la cuenta de origen y el modelo asociado, considerando los inference profiles cross-region.
2. WHERE el consumo de Bedrock corresponde a un producto propiedad del squad Data, THE Estudio SHALL señalar que la optimización puede afectar la calidad del modelo y registrar esa advertencia.
3. THE Estudio SHALL identificar el coste guiado por output tokens como principal direccionador del gasto de Bedrock.
4. WHEN el Estudio estima ahorro en Bedrock, THE Estudio SHALL declarar el supuesto de optimización (p. ej. prompt caching o cambio de modelo) y el porcentaje direccionable.
5. THE Estudio SHALL clasificar el ahorro de Bedrock como Ahorro_Estimado.

### Requirement 17: Palanca comercial Marketplace (señalada, no contabilizada)

**User Story:** Como SRE Lead, quiero que el contrato Marketplace se señale como oportunidad comercial separada, para que dirección lo evalúe sin mezclarlo con el ahorro técnico.

#### Acceptance Criteria

1. THE Estudio SHALL cuantificar el coste mensual y anualizado del contrato Marketplace en el Mes_Referencia, en USD.
2. THE Estudio SHALL cuantificar la sobrecarga PAYG del mismo producto como indicador de un tier de infraestructura mal dimensionado.
3. THE Estudio SHALL clasificar el contrato Marketplace como Palanca_Comercial, separada del total de ahorro técnico.
4. IF la fecha de renovación del contrato Marketplace es desconocida, THEN THE Estudio SHALL registrarla como "pendiente" en lugar de omitirla.
5. THE Informe SHALL presentar la Palanca_Comercial indicando que su realización depende de renegociación o ajuste en renovación.

### Requirement 18: Regla de no comprometer estimados sin barrido de utilización

**User Story:** Como SRE Lead, quiero una salvaguarda explícita contra presentar estimaciones como objetivos comprometidos, para mantener la credibilidad del Estudio.

#### Acceptance Criteria

1. THE Estudio SHALL identificar qué Palancas clasificadas como Ahorro_Estimado requieren Barrido_Utilizacion antes de poder elevarse a objetivo comprometido.
2. IF una Palanca está clasificada como Ahorro_Estimado y no dispone de Barrido_Utilizacion completado, THEN THE Informe SHALL presentar su ahorro únicamente como rango estimado y no como objetivo comprometido.
3. WHERE el Barrido_Utilizacion de una Palanca se ha completado solo de forma parcial, THE Estudio SHALL tratar esa Palanca como pendiente de barrido a efectos de comprometer objetivos.
4. WHEN el Barrido_Utilizacion de una Palanca se completa, THE Estudio SHALL registrar sus resultados en el Catálogo_Evidencias antes de elevar esa Palanca a objetivo comprometido.
5. THE Informe SHALL identificar qué Palancas tienen Barrido_Utilizacion completado y cuáles están pendientes.

### Requirement 19: Informe final y derivación de objetivos

**User Story:** Como SRE Lead, quiero un informe final con formato definido y una derivación clara de objetivos, para presentarlo a dirección.

#### Acceptance Criteria

1. THE Informe SHALL estructurarse como un resumen ejecutivo, una tabla por Palanca y un anexo de evidencias.
2. THE Informe SHALL presentar en el resumen ejecutivo el coste total de la organización, el coste de infraestructura direccionable, el total de Ahorro_Garantizado y el rango de Ahorro_Estimado.
3. THE Informe SHALL presentar, por cada Palanca, su clasificación, su ahorro mensual y anualizado, su supuesto, su porcentaje direccionable, su riesgo, su esfuerzo y su responsable.
4. THE Informe SHALL derivar los objetivos de ahorro a partir del total de Ahorro_Garantizado más el Rango_Conservador del Ahorro_Estimado de las Palancas con Barrido_Utilizacion completado.
5. THE Informe SHALL hacer que cada cifra del resumen ejecutivo referencie su evidencia en el Catálogo_Evidencias (consultas CUR y Verificacion_Recurso_Vivo que la respaldan).
6. THE Informe SHALL identificar qué Palancas quedan pendientes de Barrido_Utilizacion y, por tanto, fuera de los objetivos comprometidos.
