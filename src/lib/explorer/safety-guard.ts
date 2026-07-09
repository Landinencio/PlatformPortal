/**
 * AI Portal Explorer — Safety_Guard.
 *
 * Feature: ai-portal-explorer
 *
 * Componente que garantiza la seguridad de SOLO LECTURA innegociable del Explorer:
 *  - Clasifica cada interacción candidata y permite SOLO las de la Allowlist
 *    (default-deny): navegar, leer, abrir paneles/tabs, paginar lecturas y
 *    peticiones HTTP de método seguro (GET/HEAD).
 *  - Bloquea toda mutación: envío de formularios, clics de botón cuya etiqueta o
 *    atributos casen con la Blocklist (MUTATION_KEYWORDS) y cualquier petición
 *    HTTP de método no seguro.
 *  - Valida que la base URL corresponde al Target_Environment de desarrollo
 *    (`portal-dev`), nunca producción.
 *
 * Lógica pura y determinista (testeable por property-based tests).
 *
 * _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_
 */

/** Métodos HTTP de solo lectura permitidos. */
export const SAFE_METHODS = ["GET", "HEAD"] as const;

/** Patrones de etiqueta/control que indican mutación (Blocklist). */
export const MUTATION_KEYWORDS = [
  "submit",
  "delete",
  "approve",
  "reject",
  "execute",
  "cancel",
  "create",
  "rotate",
  "modify",
  "sync",
  "remove",
  "save",
  "send",
];

/**
 * Host canónico del Target_Environment de desarrollo (`portal-dev`).
 * El Explorer SOLO debe ejecutar contra este entorno (Req 1.2).
 */
export const DEV_TARGET_HOST = "portal.today.dev.tooling.dp.iskaypet.com";

/** Una interacción candidata que el Crawler quiere ejecutar durante una Visit. */
export interface InteractionCandidate {
  kind:
    | "navigate"
    | "read"
    | "open-panel"
    | "paginate"
    | "http"
    | "submit-form"
    | "click-button";
  httpMethod?: string; // para kind === "http"
  controlLabel?: string; // texto del botón/control
  controlAttributes?: Record<string, string>;
}

/** Resultado de la evaluación del Safety_Guard para una interacción. */
export interface GuardDecision {
  allowed: boolean;
  reason: string;
}

/** Tipos de interacción de solo lectura que pertenecen a la Allowlist sin condición. */
const READ_ONLY_KINDS = new Set<InteractionCandidate["kind"]>([
  "navigate",
  "read",
  "open-panel",
  "paginate",
]);

/**
 * Normaliza un método HTTP y decide si es seguro (solo lectura). (Req 1.5, 1.6)
 * Normalización case-insensitive: "get", " Get ", "HEAD" → seguros.
 */
export function isSafeMethod(method: string): boolean {
  if (typeof method !== "string") return false;
  const normalized = method.trim().toUpperCase();
  return (SAFE_METHODS as readonly string[]).includes(normalized);
}

/**
 * Comprueba si un texto casa (substring, case-insensitive) con algún
 * MUTATION_KEYWORD de la Blocklist. Devuelve la keyword detectada o null.
 */
function matchedMutationKeyword(text: string | undefined): string | null {
  if (!text) return null;
  const haystack = text.toLowerCase();
  for (const keyword of MUTATION_KEYWORDS) {
    if (haystack.includes(keyword)) return keyword;
  }
  return null;
}

/**
 * Busca un MUTATION_KEYWORD en la etiqueta del control y en los valores (y claves)
 * de sus atributos. Devuelve la primera keyword detectada o null.
 */
function findMutationSignal(candidate: InteractionCandidate): string | null {
  const labelMatch = matchedMutationKeyword(candidate.controlLabel);
  if (labelMatch) return labelMatch;

  if (candidate.controlAttributes) {
    for (const [key, value] of Object.entries(candidate.controlAttributes)) {
      const keyMatch = matchedMutationKeyword(key);
      if (keyMatch) return keyMatch;
      const valueMatch = matchedMutationKeyword(value);
      if (valueMatch) return valueMatch;
    }
  }
  return null;
}

/**
 * Decide si una interacción candidata pertenece a la Allowlist. (Req 1.3, 1.4, 1.7, 1.8)
 *
 * Default-deny: SOLO se permiten
 *   - `navigate`, `read`, `open-panel`, `paginate`
 *   - `http` con método seguro (GET/HEAD)
 * Todo lo demás se bloquea con su motivo:
 *   - `submit-form` (envío de formulario = mutación)
 *   - `click-button` (clic de botón fuera de la Allowlist; con motivo específico
 *     si su etiqueta/atributos casan con MUTATION_KEYWORDS)
 *   - `http` con método no seguro
 *   - cualquier `kind` desconocido
 */
export function evaluateInteraction(candidate: InteractionCandidate): GuardDecision {
  // Allowlist de solo lectura: navegar, leer, abrir paneles/tabs, paginar.
  if (READ_ONLY_KINDS.has(candidate.kind)) {
    return { allowed: true, reason: `read-only interaction '${candidate.kind}' is in the Allowlist` };
  }

  // Peticiones HTTP: permitidas si y solo si el método es seguro (GET/HEAD).
  if (candidate.kind === "http") {
    const method = candidate.httpMethod ?? "";
    if (isSafeMethod(method)) {
      return {
        allowed: true,
        reason: `safe HTTP method '${method.trim().toUpperCase()}' is in the Allowlist`,
      };
    }
    return {
      allowed: false,
      reason: `unsafe HTTP method '${method || "(none)"}' is blocked (only GET/HEAD allowed)`,
    };
  }

  // Envío de formulario: siempre mutación, siempre bloqueado.
  if (candidate.kind === "submit-form") {
    return { allowed: false, reason: "form submission is a mutation and is in the Blocklist" };
  }

  // Clic de botón: fuera de la Allowlist. Bloqueado siempre; motivo específico
  // si la etiqueta o atributos casan con la Blocklist de mutación.
  if (candidate.kind === "click-button") {
    const keyword = findMutationSignal(candidate);
    if (keyword) {
      return {
        allowed: false,
        reason: `button click matches mutation keyword '${keyword}' (Blocklist)`,
      };
    }
    return {
      allowed: false,
      reason: "button click is not in the Allowlist (default-deny)",
    };
  }

  // Cualquier otro tipo no contemplado: default-deny.
  return { allowed: false, reason: `interaction kind '${candidate.kind}' is not in the Allowlist (default-deny)` };
}

/**
 * Valida que la base URL corresponde al Target_Environment de desarrollo
 * (`portal-dev`). (Req 1.2)
 *
 * Devuelve true si y solo si la URL es una URL http(s) válida cuyo host es el
 * host canónico de desarrollo. Producción (`portal.today.tooling.dp.iskaypet.com`,
 * sin segmento `dev`) y cualquier dominio externo son rechazados.
 */
export function isDevTargetEnvironment(baseUrl: string): boolean {
  if (typeof baseUrl !== "string" || baseUrl.trim() === "") return false;

  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    return false;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;

  return parsed.hostname.toLowerCase() === DEV_TARGET_HOST;
}
