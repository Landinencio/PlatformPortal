/**
 * Clasificador determinista de errores del Execute_API (Req 5).
 *
 * Módulo puro, sin dependencias externas: acepta un `unknown` cualquiera
 * (el `err` capturado por el `try/catch` del route) más el `step` en el que
 * se produjo, y devuelve un `ErrorCode` estable. La tabla `suggestionForCode`
 * es total y determinista sobre `ErrorCode`, textos en español (Req 5.3).
 *
 * Deliberadamente NO importa `InfraLogger` para no acoplar la clasificación
 * al ciclo de logging: los criterios 5.1 (log `error` con stacktrace cuando
 * el código clasificado es `"unknown"`) y 7.2 (log complementario con `code`,
 * `step`, `requestId` tras persistir el `Error_Persistido`) los cumple el
 * llamador (`execute/[id]/route.ts`), que sí tiene contexto de sesión y
 * requestId para instanciar un `InfraLogger`.
 */

/**
 * Códigos de error persistibles y notificables al Solicitante.
 *
 * Los 10 primeros son los originales del Requirement 5.1. Los 14 siguientes
 * son los introducidos por esta feature (`infra-self-service-hardening`) y
 * están mapeados uno a uno con los criterios de aceptación indicados en cada
 * comentario. La tabla `suggestionForCode` cubre TODOS los códigos.
 */
export const ERROR_CODES = [
  // Códigos originales (Req 5.1)
  "terraform_invalid",
  "rds_rotation_missing",
  "secret_detected",
  "resource_exists_at_execute",
  "shared_file_conflict",
  "create_branch_failed",
  "create_file_failed",
  "aux_file_failed",
  "repo_not_found",
  "unknown",
  // Códigos nuevos de esta feature
  "precheck_unavailable", // Req 3.3, 9.7
  "concurrent_execute", // Req 3.6
  "error_persist_failed", // Req 5.9
  "credentials_unavailable", // Req 8.6
  "invalid_identifier_charset", // Req 2.8
  "invalid_target_environments", // Req 4.2
  "environments_expression_not_parseable", // Req 4.4
  "no_op_target_environments", // Req 4.7
  "missing_tfvars_file", // Req 4.8
  "unexpected_engine_field", // Req 6.6
  "duplicate_check_unavailable", // Req 2.7
  "resource_exists", // Req 2.4 (generate; execute usa resource_exists_at_execute)
  "engine_not_supported", // Req 1.11
  "catalog_unavailable", // Req 1.8
  // Código de la feature `iam-role-least-privilege`
  "iam_policy_admin", // Req 5.7, 5.8, 5.9 — Validador_IAM anti-admin en execute
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Pasos discretos del Execute_API donde puede producirse un fallo (Req 5.2b).
 * El orden en el enum refleja el orden temporal aproximado dentro del route.
 */
export const EXECUTE_STEPS = [
  "precheck",
  "create_branch",
  "create_file",
  "update_file",
  "aux_file",
  "create_mr",
  "create_jira",
  "notify_teams",
  "db_update",
] as const;

export type ExecuteStep = (typeof EXECUTE_STEPS)[number];

/**
 * Registro persistido en `infra_requests.error_message` (Req 5.2, 5.6).
 *
 * Invariantes estructurales validados en `buildErrorPersisted`:
 * - `code ∈ ErrorCode`.
 * - `step ∈ ExecuteStep`.
 * - `message.length ∈ [10, 500]` (Req 5.2c).
 * - `timestamp` ISO 8601 UTC parseable por `Date.parse` y termina en `Z`
 *   (Req 5.2a).
 */
export interface ErrorPersisted {
  code: ErrorCode;
  message: string;
  step: ExecuteStep;
  timestamp: string;
}

/** Longitud mínima admitida para `ErrorPersisted.message` (Req 5.2c). */
export const ERROR_MESSAGE_MIN_LENGTH = 10;
/** Longitud máxima admitida para `ErrorPersisted.message` (Req 5.2c). */
export const ERROR_MESSAGE_MAX_LENGTH = 500;

// ---------------------------------------------------------------------------
// classifyExecuteError
// ---------------------------------------------------------------------------

/**
 * Extrae un mensaje textual de un `unknown` de forma defensiva.
 *
 * Soporta `Error`, `string`, y objetos con propiedad `message: string`.
 * Devuelve cadena vacía como último recurso; el llamador se encarga de
 * proteger la longitud mínima cuando corresponde (Req 5.2c).
 */
function extractMessage(err: unknown): string {
  if (err instanceof Error) {
    return typeof err.message === "string" ? err.message : "";
  }
  if (typeof err === "string") {
    return err;
  }
  if (err !== null && typeof err === "object") {
    const candidate = (err as { message?: unknown }).message;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return "";
}

/**
 * Coincide con códigos HTTP 5xx expresados como texto libre dentro del
 * mensaje del error (patrón habitual de las respuestas de GitLab que
 * envuelven un status con `"status: 502"` o `"HTTP 503"`).
 */
function containsServerError(msg: string): boolean {
  return (
    msg.includes(" 500") ||
    msg.includes(" 502") ||
    msg.includes(" 503") ||
    msg.includes(" 504") ||
    msg.includes("5xx") ||
    msg.includes("bad gateway") ||
    msg.includes("service unavailable") ||
    msg.includes("gateway timeout")
  );
}

/**
 * Clasifica el error del Execute_API en un `ErrorCode` determinista.
 *
 * **Total**: nunca lanza; el retorno es siempre un miembro de `ErrorCode`.
 * El código `"unknown"` es el fallback de último recurso (Req 5.1) — el
 * llamador debe emitir un log de nivel `error` con el stacktrace cuando
 * reciba este código para preservar auditabilidad.
 *
 * La regla concreta cubierta por la Property 3 del diseño es:
 * `err instanceof Error && err.message.includes("already exists") && step === "create_file"`
 * ⇒ `"resource_exists_at_execute"`.
 */
export function classifyExecuteError(
  err: unknown,
  step: ExecuteStep
): ErrorCode {
  const rawMessage = extractMessage(err);
  const message = rawMessage.toLowerCase();

  // -------------------------------------------------------------------------
  // Signatures fuertes por contenido del mensaje. Se evalúan primero porque
  // capturan la intención semántica del fallo por encima de la mera etapa.
  // -------------------------------------------------------------------------

  // "already exists" en cualquier paso del ciclo del recurso (Req 3.4, 5.1).
  // Property 3 exige que create_file + "already exists" ⇒ resource_exists_at_execute.
  if (message.includes("already exists")) {
    return "resource_exists_at_execute";
  }

  // Guardia_Duplicado del generate lanzando desde el propio execute (Req 2.4).
  if (message.includes("resource_exists") && !message.includes("at_execute")) {
    return "resource_exists";
  }

  // Preview rechazado por el validador Terraform.
  if (
    message.includes("terraform") &&
    (message.includes("invalid") ||
      message.includes("syntax") ||
      message.includes("parse"))
  ) {
    return "terraform_invalid";
  }

  // Falta la rotación obligatoria del master password de RDS.
  if (
    message.includes("rotation") ||
    message.includes("manage_master_user_password") ||
    message.includes("rotate_immediately") ||
    message.includes("rotation_schedule")
  ) {
    return "rds_rotation_missing";
  }

  // Secret Scanner detectó un valor sensible en el preview.
  if (
    message.includes("secret") &&
    (message.includes("detected") ||
      message.includes("scanner") ||
      message.includes("looks like"))
  ) {
    return "secret_detected";
  }

  // Fallo al asumir credenciales AWS (STS/IRSA). Req 8.6 obliga a no exponer
  // ARNs ni tokens: aquí sólo tocamos el clasificado, el mensaje persistido
  // llega desde el error crudo — la política de sanitización es del llamador.
  if (
    message.includes("assumerole") ||
    message.includes("sts:") ||
    message.includes("could not load credentials") ||
    message.includes("invalidprovider")
  ) {
    return "credentials_unavailable";
  }

  // Repo/proyecto no encontrado (404 GitLab).
  if (
    (message.includes("not found") || message.includes("404")) &&
    (message.includes("repo") ||
      message.includes("project") ||
      message.includes("branch"))
  ) {
    return "repo_not_found";
  }

  // Conflicto de fichero compartido (s3.tf / roles.tf).
  if (
    (step === "update_file" || step === "aux_file") &&
    (message.includes("conflict") ||
      message.includes("409") ||
      message.includes("mid-air"))
  ) {
    return "shared_file_conflict";
  }

  // -------------------------------------------------------------------------
  // Precheck (Req 3.3, 9.7): fallo transitorio ⇒ precheck_unavailable.
  // -------------------------------------------------------------------------
  if (step === "precheck") {
    if (
      message.includes("timeout") ||
      message.includes("timed out") ||
      message.includes("aborterror") ||
      message.includes("abort") ||
      containsServerError(message)
    ) {
      return "precheck_unavailable";
    }
    // Cualquier otro fallo transitorio en precheck se degrada al mismo código
    // para no bloquear el rollback; casos "already exists"/"not found" ya
    // fueron capturados arriba.
    return "precheck_unavailable";
  }

  // -------------------------------------------------------------------------
  // Fallback por paso (Req 5.1): mapeo determinista.
  // -------------------------------------------------------------------------
  switch (step) {
    case "create_branch":
      return "create_branch_failed";
    case "create_file":
      return "create_file_failed";
    case "aux_file":
      return "aux_file_failed";
    case "update_file":
      return "shared_file_conflict";
    case "create_mr":
    case "create_jira":
    case "notify_teams":
    case "db_update":
      return "unknown";
    default:
      // Defensa en profundidad: si en el futuro se añaden pasos y este switch
      // se queda desactualizado, el TypeScript nunca compilará (`step` es
      // never aquí), pero en runtime devolvemos "unknown" para preservar la
      // totalidad prometida por la firma.
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// suggestionForCode
// ---------------------------------------------------------------------------

/**
 * Tabla determinista de sugerencias en español (Req 5.3).
 *
 * Total sobre `ErrorCode`: cualquier código nuevo debe añadir su entrada aquí.
 * Todas las cadenas tienen longitud ≥ 10 caracteres, requisito verificado por
 * la propiedad 3 del diseño.
 *
 * Los textos de los 10 códigos originales están tomados literalmente del
 * Requirement 5.3. Los 14 códigos nuevos usan una redacción congruente con
 * el resto del portal (español, imperativa, accionable) y coherente con la
 * intención descrita en cada requisito referenciado en el enum.
 */
const SUGGESTIONS: Readonly<Record<ErrorCode, string>> = {
  // Códigos originales (Req 5.3) — cadenas verbatim.
  terraform_invalid: "Revisa el HCL generado y reenvía la solicitud.",
  rds_rotation_missing:
    "El preview no incluye la rotación obligatoria de master. Reenvía.",
  secret_detected:
    "El preview contiene un valor que parece un secreto. Revisa y reenvía.",
  resource_exists_at_execute:
    "El recurso ya existe. Usa el formulario de modificación.",
  shared_file_conflict:
    "Otro cambio se solapó con el tuyo. Reintenta en unos segundos.",
  create_branch_failed:
    "Fallo transitorio de GitLab. Reintenta la solicitud.",
  create_file_failed: "Fallo transitorio de GitLab. Reintenta la solicitud.",
  aux_file_failed: "Fallo transitorio de GitLab. Reintenta la solicitud.",
  repo_not_found:
    "El equipo no tiene repositorio asociado. Contacta con SRE.",
  unknown:
    "Fallo inesperado. Contacta con SRE incluyendo el ID de la solicitud.",

  // Códigos nuevos de la feature.
  precheck_unavailable:
    "No se pudo verificar el estado previo del repositorio. Reintenta en unos segundos.",
  concurrent_execute:
    "Otra ejecución de esta solicitud está en curso. Espera a que termine y reintenta.",
  error_persist_failed:
    "No se pudo guardar el detalle del error. Contacta con SRE incluyendo el ID de la solicitud.",
  credentials_unavailable:
    "El portal no pudo asumir credenciales AWS para consultar el catálogo. Contacta con SRE.",
  invalid_identifier_charset:
    "El identificador solo puede contener minúsculas, dígitos y guiones, y no puede empezar por guion.",
  invalid_target_environments:
    "La lista de entornos no es válida: usa un subconjunto no vacío de dev, uat, prod.",
  environments_expression_not_parseable:
    "La expresión de entornos del recurso no es analizable automáticamente. Contacta con SRE.",
  no_op_target_environments:
    "Los entornos solicitados coinciden con los actuales; no hay cambios que aplicar.",
  missing_tfvars_file:
    "Falta el fichero de variables (tfvars) para uno de los entornos solicitados. Contacta con SRE.",
  unexpected_engine_field:
    "Este tipo de recurso no admite los campos engine/engineVersion/family. Corrige el formulario y reenvía.",
  duplicate_check_unavailable:
    "No se pudo comprobar si el recurso ya existe. Reintenta en unos segundos.",
  resource_exists:
    "Ya existe un recurso con ese identificador. Usa el formulario de modificación.",
  engine_not_supported:
    "El motor de base de datos solicitado no está soportado por el catálogo actual. Contacta con SRE.",
  catalog_unavailable:
    "El catálogo de versiones AWS no está disponible. Reintenta en unos minutos.",
  iam_policy_admin:
    "La política IAM concede permisos de administrador y fue rechazada. Usa permisos de mínimo privilegio (sin *FullAccess ni Administrator) y reenvía.",
};

/**
 * Devuelve la sugerencia accionable en español asociada al código.
 *
 * Total sobre `ErrorCode`: si un `code` no está en la tabla (imposible en
 * TypeScript, pero blindaje defensivo por si el enum se amplía sin actualizar
 * esta tabla), devuelve la sugerencia de `"unknown"`.
 */
export function suggestionForCode(code: ErrorCode): string {
  return SUGGESTIONS[code] ?? SUGGESTIONS.unknown;
}

// ---------------------------------------------------------------------------
// buildErrorPersisted
// ---------------------------------------------------------------------------

/**
 * Construye un `ErrorPersisted` a partir de un `unknown` y el `step`,
 * garantizando los invariantes estructurales del Req 5.2 (verificados por
 * la Property 8 del diseño):
 *
 * - `code` es el argumento explícito si se pasa (útil cuando el llamador ya
 *   conoce el código por contexto — p.ej. `concurrent_execute` del gate 409),
 *   o el resultado de `classifyExecuteError(err, step)` en su defecto.
 * - `message` clampado a `[10, 500]` caracteres. Cuando el mensaje extraído
 *   del `err` es más corto que el mínimo, se prefija con `"[<step>] "` (mínimo
 *   11 caracteres) y se rellena con la sugerencia determinista del `code` si
 *   sigue haciendo falta. Cuando es más largo que el máximo, se trunca por
 *   la derecha.
 * - `timestamp` en ISO 8601 UTC terminado en `"Z"`, siempre parseable por
 *   `Date.parse`. El argumento `now` (número o Date) permite tests
 *   deterministas; por defecto `Date.now()`.
 *
 * Función pura: no muta ni el `err` recibido ni el `SUGGESTIONS` interno.
 */
export function buildErrorPersisted(
  err: unknown,
  step: ExecuteStep,
  code?: ErrorCode,
  now?: number | Date
): ErrorPersisted {
  const resolvedCode: ErrorCode = code ?? classifyExecuteError(err, step);
  const message = normalizeMessage(err, step, resolvedCode);
  const timestamp = normalizeTimestamp(now);
  return { code: resolvedCode, message, step, timestamp };
}

/**
 * Extrae y clampa el mensaje del error a `[10, 500]` caracteres.
 *
 * Reglas de composición:
 * 1. Base: mensaje del `err` (trim); si vacío, `"Fallo desconocido"`.
 * 2. Se antepone siempre `"[<step>] "` para uniformidad visual — garantiza
 *    al menos 11 caracteres cualquiera sea la base.
 * 3. Si tras el prefijo la longitud sigue por debajo del mínimo (imposible
 *    con los steps actuales pero blindado por si en el futuro se añaden
 *    steps más cortos), se rellena con la sugerencia determinista del code.
 * 4. Si supera el máximo, se trunca por la derecha.
 */
function normalizeMessage(
  err: unknown,
  step: ExecuteStep,
  code: ErrorCode
): string {
  const raw = extractMessage(err).trim();
  const base = raw.length > 0 ? raw : "Fallo desconocido";
  let composed = `[${step}] ${base}`;
  if (composed.length < ERROR_MESSAGE_MIN_LENGTH) {
    // Blindaje: rellenamos con la sugerencia determinista.
    composed = `${composed} ${SUGGESTIONS[code] ?? SUGGESTIONS.unknown}`;
  }
  if (composed.length < ERROR_MESSAGE_MIN_LENGTH) {
    // Último recurso: pad con puntos suspensivos hasta el mínimo.
    composed = composed.padEnd(ERROR_MESSAGE_MIN_LENGTH, ".");
  }
  if (composed.length > ERROR_MESSAGE_MAX_LENGTH) {
    composed = composed.slice(0, ERROR_MESSAGE_MAX_LENGTH);
  }
  return composed;
}

/**
 * Devuelve `now` como ISO 8601 UTC (`toISOString`), siempre terminando en `Z`.
 * `Date.parse(t) === new Date(t).getTime()` se cumple por construcción.
 */
function normalizeTimestamp(now?: number | Date): string {
  if (now instanceof Date) {
    return now.toISOString();
  }
  if (typeof now === "number" && Number.isFinite(now)) {
    return new Date(now).toISOString();
  }
  return new Date().toISOString();
}
