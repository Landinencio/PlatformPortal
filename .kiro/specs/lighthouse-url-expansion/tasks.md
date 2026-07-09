# Implementation Plan — Lighthouse URL Expansion (ingesta CSV → lighthouse_targets)

## Overview

Plan para ingerir el CSV curado `web_core_vitals_urls.csv` (~599 filas) en la tabla
existente `lighthouse_targets`, de modo que el escáner Lighthouse audite muchas más URLs
por marca sin reescribir el escáner ni el dashboard.

El núcleo es un módulo **puro CommonJS** `ops/lib/csv-ingest.js` (parseo, mapeo host→monitor,
derivación de ruta, mapeo de tipo, derivación de prioridad, deduplicación y orquestación)
con estilo de **resultado estructurado (sin excepciones)**, más una capa fina e impura de
I/O `ops/lighthouse-seed-csv.js` (lectura de fichero + upsert idempotente en PostgreSQL).
Las propiedades de corrección se validan con property-based testing (`node:test` + `tsx` +
`fast-check`) en `src/lib/__tests__/lighthouse-csv-ingest.property.test.ts`, recogido por el
glob existente de `npm test`. No requiere migración de BD (`source` es TEXT libre,
`priority` ya es SMALLINT 1..5).

Lenguaje de implementación: **JavaScript (CommonJS)** — fijado por el diseño (el módulo se
`require`-a tal cual desde `ops/` en runtime, sin paso de build TS).

## Tasks

- [x] 1. Módulo puro de transformación `ops/lib/csv-ingest.js`
  - [x] 1.1 Crear el módulo con typedefs JSDoc y el parseo de CSV
    - Crear `ops/lib/csv-ingest.js` (CommonJS) con los typedefs JSDoc `CsvRecord`, `Target`, `Discard`.
    - Implementar `parseCsv(text)` → `{ records, errors }`: separador único `;`, descartar cabecera `url;type;n` tras trim, omitir líneas vacías/solo-espacios sin error, trim de los tres campos, `n` entero en rango `0..2147483647`; líneas con ≠3 campos o `n` no entero → `Discard` `invalid_format` preservando las válidas.
    - Implementar `serializeCsv(records)` como inversa para la propiedad de ida y vuelta.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [x] 1.2 Property test: round-trip de parseo CSV
    - **Feature: lighthouse-url-expansion, Property 1: Round-trip de parseo CSV**
    - `parseCsv(serializeCsv(records)) ≡ records` para listas de `CsvRecord` válidos; generadores que mezclan líneas válidas e inválidas. Mínimo 100 runs.
    - **Validates: Requirements 1.9** (y por extensión 1.2, 1.4, 1.6, 1.7)

  - [x] 1.3 Implementar `mapHostToMonitor` y `deriveRoute`
    - `mapHostToMonitor(url, monitors)`: extrae host con `new URL`, normaliza a minúsculas, coincidencia exacta con `Monitor_Base_Host` → `{ monitorId }`; host no coincidente (apex sin `www.`, `tiendas.`, `magasin.`) → `{ crossSubdomain:true, host }`; URL mal formada/sin host → `{ error }`.
    - `deriveRoute(url)`: `route` = `pathname` (preservado, incluida barra final) + `search` (query con `?`), fragmento `#...` excluido; pathname vacío → `/`; esquema ≠ `http`/`https` o query mal formada (múltiples `?`) → `{ error }` `invalid_format`.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.6, 12.1, 12.2_

  - [x] 1.4 Property test: round-trip de derivación de ruta
    - **Feature: lighthouse-url-expansion, Property 2: Round-trip de derivación de ruta**
    - Para URLs `http(s)` cuyo host es un `Monitor_Base_Host`, `host + deriveRoute(url).route` reconstruye la URL de origen sin fragmento (preservando pathname con barra final y query). Mínimo 100 runs.
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6**

  - [x] 1.5 Unit tests: mapeo de host y casos límite de ruta
    - Cada `Monitor_Base_Host` → su `monitor_id` (1..5); apex sin `www.`, `tiendas.`, `magasin.` → cross-subdominio; URL sin host → error; esquema no http(s) y query con múltiples `?` → error.
    - _Requirements: 2.2, 2.3, 12.1, 12.2_

  - [x] 1.6 Implementar `mapPageType`, `derivePriorityFromWeight` y `derivePriority`
    - `mapPageType(type)`: trim + minúsculas; mapa `home/plp/pdp/blog/brand/store locator→store_locator/servicios→services/new pdp→pdp`; no reconocido o vacío → `{ pageType:'other', recognized:false }`.
    - `derivePriorityFromWeight(n)`: entero `1..5`, monótona no creciente en `n` (≥5→1, 4→2, 3→3, 2→4, 0–1→5), determinista; `n` ausente/fuera de rango/no entero → `{ priority:5, classified:false }`.
    - `derivePriority({ n, pageType })`: aplica encima la regla `home ⇒ priority=1`.
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 1.7 Property test: invariantes de derivación de prioridad
    - **Feature: lighthouse-url-expansion, Property 3: Invariantes de derivación de prioridad**
    - Sobre `derivePriorityFromWeight(n)`: rango `1..5` + monotonía no creciente (`n1>n2 ⇒ priority(n1)<=priority(n2)`) + determinismo. Generadores con `n` entero, negativo, fuera de rango y no entero. Mínimo 100 runs.
    - **Validates: Requirements 5.1, 5.2, 5.3**

  - [x] 1.8 Unit tests: entradas del mapa de tipos y reglas de prioridad
    - Cada entrada del mapa de `page_type` (incluido `new pdp→pdp`, `store locator→store_locator`, `servicios→services`); tipo vacío/no reconocido → `other`; regla `home ⇒ priority=1`; peso ausente/fuera de rango → `priority=5`, `classified=false`.
    - _Requirements: 4.1, 4.2, 4.3, 4.5, 5.4, 5.5_

  - [x] 1.9 Implementar `dedupeTargets` y `buildTargets`
    - `dedupeTargets(targets)`: agrupa por `(monitorId, route)` conservando uno (el de menor `priority`), salida determinista (orden estable por `monitorId`, `route`), idempotente.
    - `buildTargets(records, monitors)`: pipeline map host → derive route → map type → derive priority → dedupe, acumulando `discards` por motivo; cross-subdominio → `cross_subdomain` con host; un registro inválido no aborta el resto; devuelve `{ targets, discards }`.
    - _Requirements: 6.1, 6.2, 6.3, 7.1, 7.2, 7.3, 12.3, 13.2_

  - [x] 1.10 Property test: deduplicación conserva unicidad y prioridad mínima
    - **Feature: lighthouse-url-expansion, Property 4: Deduplicación conserva unicidad y prioridad mínima**
    - `dedupeTargets(targets)` devuelve exactamente un target por par `(monitorId, route)` y, ante duplicados, conserva el de **menor** `priority`. Generadores de `Target` con pares repetidos y prioridades distintas. Mínimo 100 runs.
    - **Validates: Requirements 6.1, 6.2**

  - [x] 1.11 Property test: idempotencia de deduplicación y de la ingesta pura
    - **Feature: lighthouse-url-expansion, Property 5: Idempotencia de la deduplicación y de la ingesta pura**
    - `dedupeTargets(dedupeTargets(t)) ≡ dedupeTargets(t)` y `buildTargets(records, monitors)` dos veces ≡. Mínimo 100 runs.
    - **Validates: Requirements 6.3, 10.1**

- [x] 2. Checkpoint — Asegurar que el módulo puro y sus tests pasan
  - Ensure all tests pass, ask the user if questions arise.

- [x] 3. Ingester impuro `ops/lighthouse-seed-csv.js`
  - [x] 3.1 Implementar el orquestador de I/O
    - Crear `ops/lighthouse-seed-csv.js`: leer CSV (`fs.readFileSync`, env `CSV_PATH` por defecto `web_core_vitals_urls.csv`), `SELECT id, url FROM synthetic_monitors WHERE id IN (1,2,3,4,5)` y normalizar host, invocar `parseCsv` → `buildTargets`.
    - Upsert idempotente por target con `INSERT ... ON CONFLICT (monitor_id, route) DO UPDATE` fijando `source='csv'`, `enabled=TRUE`, `last_seen_at=NOW()`; error de upsert por fila se registra y no aborta el resto.
    - Soportar `DRY_RUN=1` (ejecuta pipeline + resumen sin escribir en DB); fail-fast si falta `DATABASE_URL` o el CSV es ilegible.
    - Emitir el resumen final: filas upsertadas por `monitor_id` y descartes por motivo (duplicada, cross-subdominio, formato inválido, tipo no reconocido).
    - _Requirements: 7.2, 8.1, 8.2, 8.3, 8.4, 9.1, 9.2, 10.1, 10.2, 13.1, 13.2_

  - [x] 3.2 Integration tests del ingester (DRY_RUN / deps inyectadas)
    - Con cliente de DB y lectura de fichero simulados (sin DB real): upsert idempotente (segunda ejecución deja el mismo estado, sin violación de clave única), resumen por `monitor_id` y desglose de descartes por motivo.
    - _Requirements: 8.4, 10.1, 10.2, 13.1, 13.2_

- [x] 4. Checkpoint — Asegurar que la suite completa pasa
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. (Ops/config — repo GitOps `argocd/tooling`) Elevar `MAX_ROUTES_PER_BRAND` a 120
  - En los values de GitOps (`argocd/tooling`, `shared-apps/portal-prod`), añadir/ajustar el env `MAX_ROUTES_PER_BRAND=120` en los 5 cronjobs `lighthouse-{animalis,kiwoko-es,kiwoko-pt,tiendanimal-es,tiendanimal-pt}` (`generic-chart` `cronjobs.jobs`), para cubrir la marca más grande (~75 rutas) con margen.
  - Cambio de configuración en **otro repo** (no es una tarea de código del portal); se aplica vía commit + ArgoCD. No toca el escáner.
  - _Requirements: 11.1, 11.2_

- [x] 6. (Ops — toca BD de PRODUCCIÓN) Ejecutar la ingesta para sembrar `lighthouse_targets`
  - Ejecutar `ops/lighthouse-seed-csv.js` primero con `DRY_RUN=1` para validar el resumen, y después sin `DRY_RUN` apuntando a la BD de producción para sembrar las filas `source='csv'`.
  - **Atención: esta ejecución escribe en la base de datos de producción.** Verificar el resumen (filas por `monitor_id` + descartes) antes y después; la sentencia `ON CONFLICT` la hace segura de reejecutar.
  - _Requirements: 8.1, 8.2, 8.3, 10.1, 13.1, 13.2_

## Notes

- Tareas marcadas con `*` son opcionales (tests) y pueden saltarse para un MVP más rápido; las tareas de implementación nunca van marcadas con `*`.
- El módulo es **CommonJS puro** y `require`-able desde `ops/` sin build; los tests lo importan por ruta relativa (`../../../ops/lib/csv-ingest.js`) y el glob `npm test` los recoge.
- Cada propiedad de la sección Correctness Properties se implementa como un único test de propiedad (mínimo 100 runs) etiquetado `Feature: lighthouse-url-expansion, Property N: ...`.
- Las tareas 5 y 6 son pasos **ops/config**, no tareas automatizables por el agente de código: la 5 vive en el repo GitOps y la 6 escribe en la BD de producción. Por eso quedan fuera del grafo de dependencias.
- No hay migración de BD: `source` es TEXT libre y `priority` ya admite 1..5.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.3", "1.2"] },
    { "id": 2, "tasks": ["1.6", "1.4", "1.5"] },
    { "id": 3, "tasks": ["1.9", "1.7", "1.8"] },
    { "id": 4, "tasks": ["3.1", "1.10"] },
    { "id": 5, "tasks": ["3.2", "1.11"] }
  ]
}
```
