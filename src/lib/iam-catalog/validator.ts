/**
 * Validador_IAM anti-admin (feature: iam-role-least-privilege).
 *
 * Componente determinista, TOTAL y default-deny que inspecciona una política IAM
 * (documento HCL/JSON) o un ARN de managed policy y emite un veredicto que es
 * exactamente uno de { "aceptable", "Politica_Admin" }. NUNCA lanza excepciones:
 * ante cualquier entrada vacía o malformada devuelve Politica_Admin (default-deny).
 *
 * Reglas de rechazo (Politica_Admin):
 *  - entrada vacía o malformada / ARN de managed policy inválido            (5.2)
 *  - el segmento tras la última "/" termina en "FullAccess" (case-insens.)  (5.4)
 *  - el segmento tras la última "/" contiene "Administrator" (case-insens.) (5.5)
 *  - un Statement Effect:Allow concede Action "*" o "<svc>:*" sobre
 *    Resource "*" (Action/Resource como cadena o elemento de lista)         (5.6)
 *
 * Módulo puro: sin dependencias de React ni de `node:*`.
 */

// Reutiliza el clasificador del plano de datos RDS (action-levels.ts, task 1.1).
// Se re-exporta para que los consumidores del validador (p.ej. la ruta de
// modificación, Requirement 6.8) dispongan de la detección de acciones RDS
// desde la misma superficie de validación IAM.
export { isRdsDataPlaneAction } from "./action-levels";

/** Veredicto del Validador_IAM (5.1). */
export type IamVerdict = "aceptable" | "Politica_Admin";

/** Regla concreta que disparó Politica_Admin (para el error, 5.3). */
export type IamAdminRule =
  | "empty_or_malformed"
  | "managed_full_access"
  | "managed_administrator"
  | "wildcard_action_on_all_resources"
  | "invalid_managed_arn";

export interface IamValidationResult {
  verdict: IamVerdict;
  /** Presente sii `verdict === "Politica_Admin"`. */
  rule?: IamAdminRule;
  detail?: string;
}

const ACCEPTABLE: IamValidationResult = { verdict: "aceptable" };

function admin(rule: IamAdminRule, detail: string): IamValidationResult {
  return { verdict: "Politica_Admin", rule, detail };
}

/** Segmento del nombre situado tras la última "/". */
function lastPathSegment(name: string): string {
  const idx = name.lastIndexOf("/");
  return idx === -1 ? name : name.slice(idx + 1);
}

/**
 * Aplica las reglas basadas en el NOMBRE de una managed policy (5.4, 5.5) sobre
 * el segmento tras la última "/". Devuelve null si el nombre no dispara ninguna.
 */
function checkManagedName(name: string): IamValidationResult | null {
  const segment = lastPathSegment(name).trim();
  const lower = segment.toLowerCase();
  if (lower.endsWith("fullaccess")) {
    return admin(
      "managed_full_access",
      `Managed policy '${segment}' ends in FullAccess`,
    );
  }
  if (lower.includes("administrator")) {
    return admin(
      "managed_administrator",
      `Managed policy '${segment}' contains Administrator`,
    );
  }
  return null;
}

/**
 * Devuelve el substring delimitado por `open`/`close` empezando en `start`
 * (que debe apuntar a un `open`), respetando cadenas entre comillas dobles y
 * escapes. Incluye ambos delimitadores. Devuelve null si no cierra.
 */
function matchDelimited(
  text: string,
  start: number,
  open: string,
  close: string,
): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") {
        i++;
        continue;
      }
      if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === open) {
      depth++;
    } else if (c === close) {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

/** Extrae los objetos `{...}` de primer nivel dentro del contenido de un array. */
function splitTopLevelObjects(inner: string): string[] {
  const objs: string[] = [];
  let i = 0;
  while (i < inner.length) {
    if (inner[i] === "{") {
      const obj = matchDelimited(inner, i, "{", "}");
      if (obj === null) break;
      objs.push(obj);
      i += obj.length;
    } else {
      i++;
    }
  }
  return objs;
}

/** Extrae los objetos-Statement de un documento de política (HCL o JSON). */
function extractStatementObjects(text: string): string[] {
  const m = /["']?Statement["']?\s*[=:]\s*\[/.exec(text);
  if (!m) return [];
  const arrStart = m.index + m[0].length - 1; // índice del '['
  const arr = matchDelimited(text, arrStart, "[", "]");
  if (arr === null) return [];
  return splitTopLevelObjects(arr.slice(1, -1));
}

/**
 * Extrae los valores string de un campo (`Effect`/`Action`/`Resource`) de un
 * objeto-Statement, contemplando tanto una cadena como una lista de cadenas.
 */
function extractField(objText: string, field: string): string[] {
  const re = new RegExp(`["']?${field}["']?\\s*[=:]\\s*`);
  const m = re.exec(objText);
  if (!m) return [];
  let idx = m.index + m[0].length;
  while (idx < objText.length && /\s/.test(objText[idx])) idx++;
  if (objText[idx] === "[") {
    const arr = matchDelimited(objText, idx, "[", "]");
    if (arr === null) return [];
    return [...arr.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]);
  }
  if (objText[idx] === '"') {
    const sm = /"((?:[^"\\]|\\.)*)"/.exec(objText.slice(idx));
    return sm ? [sm[1]] : [];
  }
  return [];
}

const WILDCARD_ACTION = /^[A-Za-z0-9_-]+:\*$/;

function isWildcardAction(action: string): boolean {
  return action === "*" || WILDCARD_ACTION.test(action);
}

/**
 * True sii algún Statement con Effect:Allow concede una acción comodín
 * (`"*"` o `"<svc>:*"`) sobre Resource `"*"` (5.6), tratando Action y Resource
 * tanto como cadena como elemento de lista.
 */
function hasWildcardAllowOnAllResources(text: string): boolean {
  for (const st of extractStatementObjects(text)) {
    const effect = extractField(st, "Effect")[0];
    if (!effect || effect.toLowerCase() !== "allow") continue;
    const actions = extractField(st, "Action");
    const resources = extractField(st, "Resource");
    const wildcardAction = actions.some(isWildcardAction);
    const wildcardResource = resources.some((r) => r === "*");
    if (wildcardAction && wildcardResource) return true;
  }
  return false;
}

/**
 * Valida un documento de política IAM (HCL o JSON) o un ARN/nombre de managed
 * policy. TOTAL y default-deny; NUNCA lanza (5.1, 5.2).
 */
export function validateIamPolicyAdmin(input: string): IamValidationResult {
  try {
    if (typeof input !== "string") {
      return admin("empty_or_malformed", "Input is not a string");
    }
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return admin("empty_or_malformed", "Empty policy input");
    }

    // Documento JSON: debe parsear; si no, es malformado → default-deny (5.2).
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        JSON.parse(trimmed);
      } catch {
        return admin("empty_or_malformed", "Malformed JSON policy document");
      }
      return hasWildcardAllowOnAllResources(trimmed)
        ? admin(
            "wildcard_action_on_all_resources",
            "Statement allows wildcard action on all resources",
          )
        : ACCEPTABLE;
    }

    // Documento HCL (contiene un bloque `{`): escaneo textual del Statement.
    if (trimmed.includes("{")) {
      return hasWildcardAllowOnAllResources(trimmed)
        ? admin(
            "wildcard_action_on_all_resources",
            "Statement allows wildcard action on all resources",
          )
        : ACCEPTABLE;
    }

    // ARN o nombre de managed policy: reglas por nombre (5.4, 5.5).
    return checkManagedName(trimmed) ?? ACCEPTABLE;
  } catch {
    // Cualquier fallo inesperado se resuelve como default-deny (5.2).
    return admin("empty_or_malformed", "Unexpected validation failure");
  }
}

const MANAGED_POLICY_ARN = /^arn:aws:iam::(?:aws|\d{12}):policy\/(.+)$/;

/**
 * Valida específicamente un ARN de managed policy (usado por modify, 6.4/6.5).
 * ARN con formato inválido → Politica_Admin (`invalid_managed_arn`, 5.2); en
 * otro caso aplica las reglas por nombre (FullAccess/Administrator). TOTAL.
 */
export function validateManagedPolicyArn(arn: string): IamValidationResult {
  try {
    if (typeof arn !== "string" || arn.trim().length === 0) {
      return admin("invalid_managed_arn", "Empty managed policy ARN");
    }
    const match = MANAGED_POLICY_ARN.exec(arn.trim());
    if (!match) {
      return admin(
        "invalid_managed_arn",
        `Invalid managed policy ARN: ${arn.trim()}`,
      );
    }
    return checkManagedName(match[1]) ?? ACCEPTABLE;
  } catch {
    return admin("invalid_managed_arn", "Unexpected validation failure");
  }
}
