"use strict";

/**
 * Pure, deterministic transformation module for the Lighthouse URL expansion
 * feature. It parses the curated CSV (`web_core_vitals_urls.csv`) and
 * transforms its records into rows for the `lighthouse_targets` table.
 *
 * This module is **CommonJS plain Node** (no build step): it is `require`-able
 * as-is from `ops/lighthouse-seed-csv.js` at runtime, and is exercised by the
 * property-based tests under `src/lib/__tests__/` (tsx imports CommonJS `.js`
 * without any problem).
 *
 * Error style is **structured result (no exceptions)**: every function returns
 * the valid value or a discard/error object, so a single invalid record never
 * aborts processing of the rest. Discards are accumulated with their reason and
 * aggregated into the final summary by the ingester.
 *
 * NOTE: `parseCsv`/`serializeCsv` (task 1.1), `mapHostToMonitor`/`deriveRoute`
 * (task 1.3) and `mapPageType`/`derivePriorityFromWeight`/`derivePriority`
 * (task 1.6) are implemented here. The remaining transformations
 * (dedupeTargets, buildTargets) are added by later tasks.
 */

/**
 * @typedef {Object} CsvRecord
 * @property {string} url   - URL completa (trim aplicado)
 * @property {string} type  - tipo de página del CSV (trim aplicado)
 * @property {number} n     - peso entero
 */

/**
 * @typedef {Object} Target
 * @property {number} monitorId
 * @property {string} route       - path (+ query), empieza por "/"
 * @property {string} pageType    - home|plp|pdp|brand|blog|store_locator|services|other
 * @property {number} priority    - 1..5
 * @property {string} source      - siempre "csv"
 */

/**
 * @typedef {Object} Discard
 * @property {string} reason  - "duplicate"|"cross_subdomain"|"invalid_format"|"unrecognized_type"
 * @property {string} detail  - contexto legible (host, valor, línea)
 */

/** Cabecera canónica del CSV_Curado (tras trim de la línea). */
const CSV_HEADER = "url;type;n";

/** Separador único de campos del CSV_Curado. */
const FIELD_SEPARATOR = ";";

/** Máximo entero admitido para el peso `n` (INT32 de PostgreSQL). */
const MAX_N = 2147483647;

/**
 * Parsea el contenido bruto del CSV_Curado en registros estructurados.
 *
 * - Separador único `;` (Req 1.2).
 * - La cabecera `url;type;n` (tras trim de la línea) se descarta (Req 1.3).
 * - Líneas vacías o solo-espacios se omiten sin error (Req 1.8).
 * - Trim de los tres campos antes de exponerlos (Req 1.4).
 * - `n` debe ser un entero en el rango `0..2147483647` (Req 1.5).
 * - Líneas con ≠ 3 campos → descarte `invalid_format`, preservando las
 *   válidas (Req 1.6).
 * - `n` no entero / fuera de rango → descarte `invalid_format`, se continúa
 *   (Req 1.7).
 *
 * @param {string} text  - contenido bruto del CSV
 * @returns {{ records: CsvRecord[], errors: Discard[] }}
 */
function parseCsv(text) {
  /** @type {CsvRecord[]} */
  const records = [];
  /** @type {Discard[]} */
  const errors = [];

  if (typeof text !== "string" || text.length === 0) {
    return { records, errors };
  }

  const lines = text.split(/\r?\n/);

  for (const rawLine of lines) {
    // Req 1.8: líneas vacías o solo-espacios se omiten sin error.
    if (rawLine.trim() === "") {
      continue;
    }

    // Req 1.3: la cabecera (tras trim de la línea) se descarta sin error.
    if (rawLine.trim() === CSV_HEADER) {
      continue;
    }

    const fields = rawLine.split(FIELD_SEPARATOR);

    // Req 1.6: número de campos distinto de tres → descarte.
    if (fields.length !== 3) {
      errors.push({
        reason: "invalid_format",
        detail: `expected 3 fields, got ${fields.length}: "${rawLine}"`,
      });
      continue;
    }

    // Req 1.4: trim de los tres campos.
    const url = fields[0].trim();
    const type = fields[1].trim();
    const nStr = fields[2].trim();

    // Req 1.5, 1.7: `n` debe representar un entero en el rango 0..MAX_N.
    if (!isValidWeight(nStr)) {
      errors.push({
        reason: "invalid_format",
        detail: `invalid weight n="${nStr}": "${rawLine}"`,
      });
      continue;
    }

    records.push({ url, type, n: Number(nStr) });
  }

  return { records, errors };
}

/**
 * Comprueba si una cadena representa un entero válido para el peso `n`:
 * solo dígitos (entero no negativo) dentro del rango `0..MAX_N`.
 *
 * @param {string} nStr
 * @returns {boolean}
 */
function isValidWeight(nStr) {
  if (!/^\d+$/.test(nStr)) {
    return false;
  }
  const n = Number(nStr);
  return Number.isInteger(n) && n >= 0 && n <= MAX_N;
}

/**
 * Serializa una lista de registros a formato CSV_Curado. Es la inversa de
 * `parseCsv` para la propiedad de ida y vuelta (Req 1.9): incluye la cabecera
 * `url;type;n` (que `parseCsv` descarta) y una línea por registro.
 *
 * @param {CsvRecord[]} records
 * @returns {string}
 */
function serializeCsv(records) {
  const lines = [CSV_HEADER];
  if (Array.isArray(records)) {
    for (const record of records) {
      lines.push(
        `${record.url}${FIELD_SEPARATOR}${record.type}${FIELD_SEPARATOR}${record.n}`
      );
    }
  }
  return lines.join("\n");
}

/**
 * Asocia el host de una URL a un `monitor_id` (Req 2).
 *
 * - Extrae el host con `new URL(url)` y lo normaliza a minúsculas (Req 2.1).
 * - Coincidencia exacta con un `Monitor_Base_Host` → `{ monitorId }`
 *   (Req 2.1, 2.2).
 * - Host que no coincide con ninguno (apex sin `www.`, u otros subdominios como
 *   `tiendas.`, `magasin.`) → `{ crossSubdomain:true, host }` (Req 2.3).
 * - URL mal formada o sin host → `{ error }`, se continúa con el resto
 *   (Req 2.4).
 *
 * @param {string} url
 * @param {{ id:number, host:string }[]} monitors  - host = Monitor_Base_Host normalizado
 * @returns {{ monitorId:number }|{ crossSubdomain:true, host:string }|{ error:string }}
 */
function mapHostToMonitor(url, monitors) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `malformed URL: "${url}"` };
  }

  const host = (parsed.hostname || "").toLowerCase();
  if (host === "") {
    return { error: `URL without host: "${url}"` };
  }

  const list = Array.isArray(monitors) ? monitors : [];
  for (const monitor of list) {
    if (
      monitor &&
      typeof monitor.host === "string" &&
      monitor.host.toLowerCase() === host
    ) {
      return { monitorId: monitor.id };
    }
  }

  return { crossSubdomain: true, host };
}

/**
 * Deriva la ruta relativa (`route`) que el escáner concatena al host base
 * (Req 3, 12).
 *
 * - `route` = `pathname` (preservado tal cual, incluida la barra final) +
 *   `search` (query con `?`, orden y contenido preservados) (Req 3.1, 3.3).
 * - El fragmento `#...` se excluye (Req 3.4).
 * - pathname vacío → `route="/"` (Req 3.2).
 * - Esquema distinto de `http`/`https` → `{ error }` `invalid_format`
 *   (Req 12.1).
 * - Query mal formada (múltiples `?`) → `{ error }` `invalid_format`
 *   (Req 12.2). `new URL` colapsa los `?` extra dentro del valor de la query,
 *   así que para detectarlo se inspecciona la cadena bruta (se cuentan los `?`
 *   antes del fragmento).
 *
 * @param {string} url
 * @returns {{ route:string }|{ error:string }}
 */
function deriveRoute(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { error: `invalid_format: malformed URL "${url}"` };
  }

  // Req 12.1: solo se admite http/https.
  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return {
      error: `invalid_format: unsupported scheme "${parsed.protocol}" in "${url}"`,
    };
  }

  // Req 12.2: query mal formada (múltiples `?`). `new URL` colapsa el segundo
  // `?` dentro del valor de la query, por lo que hay que contar sobre la cadena
  // bruta (la porción anterior al fragmento `#`).
  const beforeFragment = String(url).split("#", 1)[0];
  const questionMarks = (beforeFragment.match(/\?/g) || []).length;
  if (questionMarks > 1) {
    return { error: `invalid_format: malformed query (multiple "?") in "${url}"` };
  }

  // Req 3.2: pathname vacío → "/". Para esquemas http/https `new URL` ya
  // normaliza a "/", pero se mantiene la guarda por robustez.
  const pathname = parsed.pathname === "" ? "/" : parsed.pathname;
  const route = `${pathname}${parsed.search}`;

  return { route };
}

/**
 * Mapa de `type` del CSV_Curado (normalizado a trim + minúsculas) al `page_type`
 * almacenado en `lighthouse_targets` (Req 4.1, 4.2).
 */
const PAGE_TYPE_MAP = {
  home: "home",
  plp: "plp",
  pdp: "pdp",
  blog: "blog",
  brand: "brand",
  "store locator": "store_locator",
  servicios: "services",
  "new pdp": "pdp",
};

/** `page_type` por defecto cuando el tipo no se reconoce o está vacío. */
const DEFAULT_PAGE_TYPE = "other";

/** Prioridad por defecto (menor importancia) para registros no clasificados. */
const DEFAULT_PRIORITY = 5;

/**
 * Traduce el valor `type` del CSV_Curado al `page_type` del modelo (Req 4).
 *
 * - Normaliza: trim + minúsculas antes de aplicar el mapeo (Req 4.4).
 * - Mapa: `home→home`, `plp→plp`, `pdp→pdp`, `blog→blog`, `brand→brand`,
 *   `store locator→store_locator`, `servicios→services`, `new pdp→pdp`
 *   (Req 4.1, 4.2).
 * - No reconocido / vacío / solo espacios → `{ pageType:"other", recognized:false }`
 *   para que el ingester registre el evento sin descartar la fila (Req 4.3, 4.5).
 *
 * @param {string} type
 * @returns {{ pageType:string, recognized:boolean }}
 */
function mapPageType(type) {
  const normalized = typeof type === "string" ? type.trim().toLowerCase() : "";

  if (normalized === "") {
    return { pageType: DEFAULT_PAGE_TYPE, recognized: false };
  }

  if (Object.prototype.hasOwnProperty.call(PAGE_TYPE_MAP, normalized)) {
    return { pageType: PAGE_TYPE_MAP[normalized], recognized: true };
  }

  return { pageType: DEFAULT_PAGE_TYPE, recognized: false };
}

/**
 * Núcleo de derivación de prioridad basado **solo** en el peso `n` (Req 5).
 *
 * - Devuelve un entero `priority` en el rango `1..5` (Req 5.1).
 * - Es **monótona no creciente** respecto a `n`: mayor peso ⇒ número de
 *   prioridad menor o igual (Req 5.2). Mapeo:
 *
 *   | `n`  | priority |
 *   |------|----------|
 *   | ≥ 5  | 1        |
 *   | 4    | 2        |
 *   | 3    | 3        |
 *   | 2    | 4        |
 *   | 0–1  | 5        |
 *
 * - Determinista para el mismo `n` (Req 5.3).
 * - `n` ausente / no entero / fuera del rango `0..MAX_N` →
 *   `{ priority:5, classified:false }` (Req 5.5).
 *
 * @param {number} n
 * @returns {{ priority:number, classified:boolean }}
 */
function derivePriorityFromWeight(n) {
  if (!Number.isInteger(n) || n < 0 || n > MAX_N) {
    return { priority: DEFAULT_PRIORITY, classified: false };
  }

  let priority;
  if (n >= 5) {
    priority = 1;
  } else if (n === 4) {
    priority = 2;
  } else if (n === 3) {
    priority = 3;
  } else if (n === 2) {
    priority = 4;
  } else {
    // n === 0 || n === 1
    priority = 5;
  }

  return { priority, classified: true };
}

/**
 * Deriva la prioridad final de un registro aplicando, encima del núcleo basado
 * en el peso, la regla de negocio de página: `home ⇒ priority=1` (Req 5.4).
 *
 * `home` representa la página de mayor importancia, así que se le asigna la
 * prioridad mínima (1) con independencia de su peso; en el dataset `home` lleva
 * el peso máximo (`n=5`, que ya mapea a 1), por lo que la regla es consistente
 * con la monotonía global.
 *
 * @param {{ n:number, pageType:string }} record
 * @returns {{ priority:number, classified:boolean }}
 */
function derivePriority(record) {
  const pageType = record && typeof record.pageType === "string" ? record.pageType : "";

  // Req 5.4: home siempre prioridad 1 (clasificado por regla de negocio).
  if (pageType === "home") {
    return { priority: 1, classified: true };
  }

  return derivePriorityFromWeight(record ? record.n : undefined);
}

/**
 * Construye la clave de agrupación de un target por el par `(monitorId, route)`.
 * Se usa `\u0000` como separador (carácter que no puede aparecer en una ruta
 * derivada) para evitar colisiones entre, p. ej., `(1, "/2/a")` y `(12, "/a")`.
 *
 * @param {Target} target
 * @returns {string}
 */
function targetKey(target) {
  return `${target.monitorId}\u0000${target.route}`;
}

/**
 * Comparador determinista y estable de targets: ordena por `monitorId`
 * ascendente y, a igualdad, por `route` ascendente.
 *
 * @param {Target} a
 * @param {Target} b
 * @returns {number}
 */
function compareTargets(a, b) {
  if (a.monitorId !== b.monitorId) {
    return a.monitorId - b.monitorId;
  }
  if (a.route < b.route) {
    return -1;
  }
  if (a.route > b.route) {
    return 1;
  }
  return 0;
}

/**
 * Deduplica una lista de targets por el par `(monitorId, route)` (Req 6).
 *
 * - Agrupa por `(monitorId, route)` y conserva exactamente un target por par
 *   (Req 6.1).
 * - Ante prioridad distinta conserva el de **menor** valor `priority` (Req 6.2);
 *   a igualdad de prioridad conserva el primero encontrado (estable).
 * - Salida determinista: ordenada por `monitorId` y luego por `route`.
 * - Idempotente: aplicar sobre un conjunto ya deduplicado devuelve el mismo
 *   conjunto (Req 6.3), porque cada par ya es único y el orden es estable.
 *
 * @param {Target[]} targets
 * @returns {Target[]}
 */
function dedupeTargets(targets) {
  /** @type {Map<string, Target>} */
  const byKey = new Map();

  const list = Array.isArray(targets) ? targets : [];
  for (const target of list) {
    if (!target || typeof target.monitorId !== "number") {
      continue;
    }
    const key = targetKey(target);
    const existing = byKey.get(key);
    // Conserva el de menor priority; a igualdad, el primero (no se reemplaza).
    if (existing === undefined || target.priority < existing.priority) {
      byKey.set(key, target);
    }
  }

  return Array.from(byKey.values()).sort(compareTargets);
}

/**
 * Orquestación pura del pipeline de transformación (Req 2, 3, 7, 12, 13):
 * `mapHostToMonitor → deriveRoute → mapPageType → derivePriority → dedupeTargets`,
 * acumulando los descartes con su motivo.
 *
 * Para cada `CsvRecord`:
 * - `mapHostToMonitor`: si la URL es inválida/sin host → descarte
 *   `invalid_format` (Req 2.4); si es cross-subdominio → descarte
 *   `cross_subdomain` con el host afectado (Req 7.1, 7.2); si mapea a un
 *   monitor, continúa.
 * - `deriveRoute`: si el esquema no es http(s) o la query está mal formada →
 *   descarte `invalid_format` (Req 12.1, 12.2).
 * - `mapPageType`: si el tipo no se reconoce / está vacío, se asigna `other` y
 *   se registra un descarte `unrecognized_type` **sin** descartar la fila
 *   (Req 4.3, 4.5) — el target se conserva.
 * - `derivePriority`: deriva la prioridad final (regla `home ⇒ 1`).
 * - Produce un `Target` con `source:"csv"`.
 *
 * Un registro inválido nunca aborta el resto (Req 12.3). Finalmente se
 * deduplican los targets (Req 6) y los pares colapsados se contabilizan como
 * descartes `duplicate` para el resumen por motivo (Req 13.2).
 *
 * @param {CsvRecord[]} records
 * @param {{ id:number, host:string }[]} monitors
 * @returns {{ targets: Target[], discards: Discard[] }}
 */
function buildTargets(records, monitors) {
  /** @type {Target[]} */
  const collected = [];
  /** @type {Discard[]} */
  const discards = [];

  const list = Array.isArray(records) ? records : [];
  for (const record of list) {
    if (!record || typeof record.url !== "string") {
      discards.push({
        reason: "invalid_format",
        detail: `missing url in record: ${JSON.stringify(record)}`,
      });
      continue;
    }

    // Paso 1: asociar host → monitor.
    const hostResult = mapHostToMonitor(record.url, monitors);
    if ("error" in hostResult) {
      discards.push({ reason: "invalid_format", detail: hostResult.error });
      continue;
    }
    if ("crossSubdomain" in hostResult) {
      discards.push({ reason: "cross_subdomain", detail: hostResult.host });
      continue;
    }
    const monitorId = hostResult.monitorId;

    // Paso 2: derivar la ruta.
    const routeResult = deriveRoute(record.url);
    if ("error" in routeResult) {
      discards.push({ reason: "invalid_format", detail: routeResult.error });
      continue;
    }
    const route = routeResult.route;

    // Paso 3: mapear el tipo de página (no descarta la fila si no se reconoce).
    const { pageType, recognized } = mapPageType(record.type);
    if (!recognized) {
      discards.push({
        reason: "unrecognized_type",
        detail: `type="${record.type}" url="${record.url}"`,
      });
    }

    // Paso 4: derivar la prioridad final.
    const { priority } = derivePriority({ n: record.n, pageType });

    collected.push({ monitorId, route, pageType, priority, source: "csv" });
  }

  // Paso 5: deduplicar y contabilizar los pares colapsados como `duplicate`.
  const targets = dedupeTargets(collected);

  /** @type {Map<string, number>} */
  const seen = new Map();
  for (const target of collected) {
    const key = targetKey(target);
    const count = seen.get(key) || 0;
    if (count >= 1) {
      // Cada aparición adicional del mismo par es un duplicado colapsado.
      discards.push({
        reason: "duplicate",
        detail: `monitorId=${target.monitorId} route="${target.route}"`,
      });
    }
    seen.set(key, count + 1);
  }

  return { targets, discards };
}

module.exports = {
  CSV_HEADER,
  FIELD_SEPARATOR,
  MAX_N,
  PAGE_TYPE_MAP,
  DEFAULT_PAGE_TYPE,
  DEFAULT_PRIORITY,
  parseCsv,
  serializeCsv,
  mapHostToMonitor,
  deriveRoute,
  mapPageType,
  derivePriorityFromWeight,
  derivePriority,
  dedupeTargets,
  buildTargets,
};
