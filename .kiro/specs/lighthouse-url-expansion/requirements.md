# Requirements Document

## Introduction

La pestaña Lighthouse de la sección de monitorización (`/synthetics`) audita hoy un
conjunto reducido de rutas por marca. El equipo necesita monitorizar muchas más URLs
de las cinco webs de IskayPet. Para ello se ha añadido en la raíz del proyecto el
fichero `web_core_vitals_urls.csv`, un listado curado (~599 filas) de URLs a auditar,
con su tipo de página y un peso de importancia.

Esta feature cubre la **ingesta del CSV curado** en la tabla `lighthouse_targets` para
que el escáner Lighthouse existente (`ops/lighthouse-scan.js`) las audite, junto con los
cambios de soporte mínimos: derivación de la ruta a partir de la URL completa, mapeo del
tipo de página, derivación de la prioridad a partir del peso, deduplicación, etiquetado
del origen para protegerlas del refresco de sitemap, decisión sobre las URLs de
localizador de tiendas alojadas en subdominios distintos, y gestión del límite de rutas
por marca durante el escaneo.

Queda **fuera de alcance** reescribir el escáner Lighthouse, modificar el cronjob de
escaneo más allá del límite de rutas, o cambiar el dashboard de visualización.

## Glossary

- **CSV_Curado**: Fichero `web_core_vitals_urls.csv` en la raíz del proyecto, separado por
  punto y coma, con cabecera `url;type;n`.
- **CSV_Parser**: Componente que lee el CSV_Curado y produce una lista de registros
  estructurados (`url`, `type`, `n`).
- **Ingester**: Componente (script en `ops/`) que orquesta el parseo, la transformación y
  la escritura de los registros del CSV_Curado en la tabla `lighthouse_targets`.
- **Host_Mapper**: Función que asocia el host de una URL a un `monitor_id` de la tabla
  `synthetic_monitors`.
- **Route_Deriver**: Función que transforma una URL completa en la ruta relativa (`route`)
  que el escáner concatena a la URL base de la marca.
- **Type_Mapper**: Función que traduce el valor de la columna `type` del CSV_Curado al
  valor `page_type` almacenado en `lighthouse_targets`.
- **Priority_Mapper**: Función que deriva el valor `priority` de `lighthouse_targets` a
  partir del peso `n` del CSV_Curado.
- **Deduplicator**: Función que elimina registros duplicados antes de la escritura.
- **lighthouse_targets**: Tabla PostgreSQL con clave única `(monitor_id, route)` que el
  escáner consulta para decidir qué URLs auditar.
- **Monitor_Base_Host**: Host de la URL base de un monitor en `synthetic_monitors`
  (p. ej. `www.tiendanimal.es` para `monitor_id=4`).
- **URL_Cross_Subdominio**: URL del CSV_Curado cuyo host difiere del Monitor_Base_Host de
  cualquier monitor (p. ej. `tiendas.tiendanimal.es`, `magasin.animalis.com`).
- **Fuente_CSV**: Valor de la columna `source` (`'csv'`) que identifica las filas
  insertadas por el Ingester, para distinguirlas de `'sitemap'` y `'manual'`.
- **Refresco_Sitemap**: Job `ops/lighthouse-targets-refresh.js` (cron
  `lighthouse-targets-refresh`) que descubre URLs por sitemap y deshabilita filas
  `source='sitemap'` no vistas en 14 días.
- **MAX_ROUTES_PER_BRAND**: Variable de entorno que limita el número de rutas auditadas
  por marca y ejecución del escáner (valor por defecto actual: 50).

## Requirements

### Requirement 1: Parseo del CSV curado

**User Story:** Como SRE, quiero parsear el fichero `web_core_vitals_urls.csv`, para
obtener registros estructurados que el Ingester pueda transformar e insertar.

#### Acceptance Criteria

1. WHEN el Ingester recibe el CSV_Curado, THE CSV_Parser SHALL producir un registro por
   cada línea de datos no vacía con los campos `url`, `type` y `n`.
2. THE CSV_Parser SHALL interpretar el punto y coma (`;`) como único separador de campos.
3. WHEN la primera línea del CSV_Curado, tras eliminar espacios iniciales y finales, es
   `url;type;n`, THE CSV_Parser SHALL tratar esa línea como cabecera y excluirla de los
   registros de datos.
4. THE CSV_Parser SHALL eliminar los espacios iniciales y finales de cada uno de los tres
   campos (`url`, `type`, `n`) antes de exponerlos.
5. WHEN una línea de datos contiene un valor de `n` que representa un entero en el rango
   0 a 2.147.483.647, THE CSV_Parser SHALL exponer `n` como valor entero.
6. IF una línea de datos tiene un número de campos distinto de tres, THEN THE CSV_Parser
   SHALL excluirla de los registros de datos indicando el error y preservando los
   registros válidos.
7. IF el campo `n` de una línea de datos no representa un entero válido, THEN THE
   CSV_Parser SHALL excluir esa línea indicando el error y continuar con las restantes.
8. WHEN una línea del CSV_Curado está vacía o contiene solo espacios en blanco, THE
   CSV_Parser SHALL omitirla sin registrarla como error.
9. FOR ALL listas de registros válidos, serializar la lista a formato CSV y volver a
   parsear el resultado SHALL producir una lista de registros equivalente a la original
   (propiedad de ida y vuelta).

### Requirement 2: Asociación de URL a monitor

**User Story:** Como SRE, quiero que cada URL se asocie al monitor correcto, para que el
escáner audite la URL bajo la marca adecuada.

#### Acceptance Criteria

1. WHEN el host de una URL, normalizado a minúsculas, coincide exactamente con el
   Monitor_Base_Host de un monitor, THE Host_Mapper SHALL devolver el `monitor_id` de ese
   monitor.
2. THE Host_Mapper SHALL asociar `www.animalis.com` a `monitor_id=1`, `www.kiwoko.com` a
   `monitor_id=2`, `www.kiwoko.pt` a `monitor_id=3`, `www.tiendanimal.es` a `monitor_id=4`
   y `www.tiendanimal.pt` a `monitor_id=5`.
3. IF el host de una URL no coincide exactamente con ningún Monitor_Base_Host (incluyendo
   hosts apex sin `www.` y otros subdominios como `tiendas.` o `magasin.`), THEN THE
   Host_Mapper SHALL marcar la URL como URL_Cross_Subdominio.
4. IF una URL está mal formada o no permite extraer un host, THEN THE Host_Mapper SHALL
   excluir la URL indicando el error y continuar con las restantes.

### Requirement 3: Derivación de la ruta

**User Story:** Como SRE, quiero convertir cada URL completa en la ruta relativa que el
escáner espera, para que la construcción de la URL final sea correcta.

#### Acceptance Criteria

1. WHEN una URL pertenece a un monitor, THE Route_Deriver SHALL producir una `route` que
   comience por `/` y contenga el pathname de la URL preservándolo tal cual (incluida la
   barra final si la URL la tiene).
2. WHERE el pathname de la URL está vacío, THE Route_Deriver SHALL producir `route="/"`.
3. WHERE la URL incluye una cadena de consulta (query string), THE Route_Deriver SHALL
   incluir la cadena de consulta en la `route` precedida de `?`, preservando el orden y el
   contenido de los parámetros.
4. THE Route_Deriver SHALL excluir el fragmento (`#...`) de la `route`, ya que el escáner
   reconstruye una URL de servidor.
5. FOR ALL rutas derivadas, concatenar el Monitor_Base_Host (sin barra final) con la
   `route` SHALL reconstruir una URL equivalente a la URL de origen una vez excluido el
   fragmento (propiedad de ida y vuelta).
6. THE Route_Deriver SHALL preservar dos URLs del mismo monitor que difieran únicamente en
   su cadena de consulta como dos rutas distintas.

### Requirement 4: Mapeo del tipo de página

**User Story:** Como SRE, quiero traducir el tipo de página del CSV al valor `page_type`
del modelo, para que la agrupación por tipo en la UI siga siendo coherente.

#### Acceptance Criteria

1. WHEN el Type_Mapper procesa el valor `type` de una fila del CSV, THE Type_Mapper SHALL
   traducir `HOME` a `home`, `PLP` a `plp`, `PDP` a `pdp`, `BLOG` a `blog` y `BRAND` a
   `brand`.
2. WHEN el Type_Mapper procesa el valor `type` de una fila del CSV, THE Type_Mapper SHALL
   traducir `STORE LOCATOR` a `store_locator`, `SERVICIOS` a `services` y `NEW PDP` a
   `pdp`.
3. IF el valor de `type` normalizado no coincide con ninguna entrada definida en el
   mapeo, THEN THE Type_Mapper SHALL asignar `page_type` igual a `other` y registrar un
   evento que incluya el valor original no reconocido.
4. THE Type_Mapper SHALL normalizar el valor `type` antes de aplicar el mapeo, eliminando
   los espacios iniciales y finales y comparando de forma insensible a mayúsculas y
   minúsculas.
5. IF el valor de `type` está ausente, vacío o contiene únicamente espacios en blanco tras
   la normalización, THEN THE Type_Mapper SHALL asignar `page_type` igual a `other` y
   registrar un evento que identifique la fila afectada.

### Requirement 5: Derivación de la prioridad

**User Story:** Como SRE, quiero derivar la prioridad de auditoría a partir del peso `n`,
para que las páginas más importantes se auditen primero dentro del límite por marca.

#### Acceptance Criteria

1. THE Priority_Mapper SHALL producir un valor `priority` entero comprendido en el rango 1
   a 5, ambos inclusive, admitido por la columna `priority` de `lighthouse_targets` (donde
   1 indica la mayor prioridad y se audita primero).
2. WHEN un registro tiene un peso `n` mayor que el de otro registro, THE Priority_Mapper
   SHALL asignar al primero un valor `priority` menor o igual que al segundo (mayor peso
   implica mayor importancia y menor número de prioridad).
3. WHEN dos registros tienen el mismo peso `n`, THE Priority_Mapper SHALL asignarles el
   mismo valor `priority`, de forma que la derivación sea determinista y repetible para una
   misma entrada.
4. WHERE el tipo de página es `home`, THE Priority_Mapper SHALL asignar `priority=1`.
5. IF un registro carece de peso `n` o su valor está fuera del rango esperado, THEN THE
   Priority_Mapper SHALL asignarle `priority=5` (menor importancia), marcar el registro
   como no clasificado y continuar procesando el resto de registros.

### Requirement 6: Deduplicación de registros

**User Story:** Como SRE, quiero eliminar las filas duplicadas del CSV, para no insertar
entradas redundantes ni provocar conflictos de clave única.

#### Acceptance Criteria

1. WHEN dos o más registros producen el mismo par `(monitor_id, route)`, THE Deduplicator
   SHALL conservar exactamente un registro para ese par.
2. WHERE existen registros duplicados con distinta prioridad derivada, THE Deduplicator
   SHALL conservar el registro con el menor valor `priority`.
3. FOR ALL conjuntos de registros, aplicar la deduplicación sobre un conjunto ya
   deduplicado SHALL producir el mismo conjunto (idempotencia).

### Requirement 7: Tratamiento de URLs en subdominios distintos

**User Story:** Como SRE, quiero una decisión explícita sobre las URLs de localizador de
tiendas alojadas en subdominios distintos, para evitar generar URLs de escaneo
incorrectas.

#### Acceptance Criteria

1. IF una URL es una URL_Cross_Subdominio, THEN THE Ingester SHALL excluirla de la
   inserción en `lighthouse_targets`.
2. WHEN el Ingester excluye una o más URL_Cross_Subdominio, THE Ingester SHALL registrar
   el número de URLs excluidas y los hosts afectados.
3. THE Ingester SHALL insertar las URLs de localizador de tiendas cuyo host coincide con
   un Monitor_Base_Host aplicando las mismas reglas que al resto de URLs.

### Requirement 8: Ingesta en la tabla de objetivos

**User Story:** Como SRE, quiero insertar las URLs curadas en `lighthouse_targets` con el
origen identificado, para que el escáner las audite y se distingan de las demás fuentes.

#### Acceptance Criteria

1. WHEN el Ingester procesa un registro válido asociado a un monitor, THE Ingester SHALL
   insertar o actualizar una fila en `lighthouse_targets` con `monitor_id`, `route`,
   `page_type` y `priority` derivados.
2. THE Ingester SHALL fijar `source` al valor Fuente_CSV (`'csv'`) en todas las filas que
   inserta o actualiza.
3. THE Ingester SHALL fijar `enabled=TRUE` en todas las filas que inserta o actualiza.
4. WHEN una fila con el mismo par `(monitor_id, route)` ya existe, THE Ingester SHALL
   actualizar `page_type`, `priority` y `source` sin crear una fila duplicada.

### Requirement 9: Protección frente al refresco de sitemap

**User Story:** Como SRE, quiero que las URLs curadas no se deshabiliten por el job de
refresco de sitemap, para que la cobertura curada se mantenga estable.

#### Acceptance Criteria

1. THE filas con `source` igual a Fuente_CSV SHALL permanecer con `enabled=TRUE` tras una
   ejecución del Refresco_Sitemap que no las vuelva a descubrir.
2. WHERE una URL existe tanto en el CSV_Curado como en el sitemap de la marca, THE sistema
   SHALL conservar una única fila por par `(monitor_id, route)` sin que el Refresco_Sitemap
   la deshabilite.

### Requirement 10: Idempotencia de la ingesta

**User Story:** Como SRE, quiero poder reejecutar la ingesta sin efectos colaterales, para
poder repetir la carga de forma segura.

#### Acceptance Criteria

1. WHEN el Ingester se ejecuta dos veces consecutivas sobre el mismo CSV_Curado sin
   cambios, THE estado de las filas Fuente_CSV en `lighthouse_targets` SHALL ser
   equivalente tras la primera y la segunda ejecución.
2. THE Ingester SHALL completar la reejecución sin generar errores de violación de la
   clave única `(monitor_id, route)`.

### Requirement 11: Gestión del límite de rutas por marca

**User Story:** Como SRE, quiero gestionar el límite de rutas auditadas por marca, para
poder cubrir el mayor volumen de URLs curadas sin desbordar el tiempo de escaneo.

#### Acceptance Criteria

1. WHERE el número de URLs curadas habilitadas por marca supera el valor por defecto de
   MAX_ROUTES_PER_BRAND, THE sistema SHALL permitir configurar MAX_ROUTES_PER_BRAND a un
   valor que cubra las URLs curadas de esa marca.
2. WHEN el número de rutas habilitadas de una marca supera MAX_ROUTES_PER_BRAND, THE
   escáner SHALL auditar las rutas en orden ascendente de `priority`.
3. THE documentación de la feature SHALL indicar el coste estimado de escaneo por marca en
   función del número de rutas y del tiempo máximo por página (hasta 2 minutos).

### Requirement 12: Tratamiento de filas con formato inválido

**User Story:** Como SRE, quiero que las filas mal formadas no aborten la ingesta, para que
una entrada incorrecta no impida cargar el resto.

#### Acceptance Criteria

1. IF una línea de datos no contiene una URL con esquema `http` o `https`, THEN THE
   Ingester SHALL excluir esa línea y registrar el motivo.
2. IF una URL contiene una cadena de consulta mal formada (p. ej. múltiples símbolos `?`),
   THEN THE Ingester SHALL excluir esa línea y registrar el motivo.
3. WHEN el Ingester encuentra una línea inválida, THE Ingester SHALL continuar procesando
   las líneas restantes.

### Requirement 13: Resumen de la ingesta

**User Story:** Como SRE, quiero un resumen al finalizar la ingesta, para verificar cuántas
URLs se cargaron por marca y cuántas se descartaron.

#### Acceptance Criteria

1. WHEN el Ingester finaliza, THE Ingester SHALL emitir el número de filas insertadas o
   actualizadas por `monitor_id`.
2. WHEN el Ingester finaliza, THE Ingester SHALL emitir el número total de filas
   descartadas, desglosado por motivo (duplicada, cross-subdominio, formato inválido,
   tipo no reconocido).
