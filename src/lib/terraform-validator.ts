/**
 * Lightweight HCL syntax validator.
 * Catches common AI generation errors without requiring terraform binary.
 */

export interface ValidationError {
  line: number;
  message: string;
  rule: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Validates that all `var.<identifier>` references use only valid identifiers.
 * Valid identifiers match: [a-zA-Z_][a-zA-Z0-9_]*
 */
export function validateVariableReferences(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    // Find all var.X references
    const varRefPattern = /\bvar\.([^\s\.\,\)\}\]\"\'\`\;]+)/g;
    let match: RegExpExecArray | null;
    while ((match = varRefPattern.exec(line)) !== null) {
      const identifier = match[1];
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
        errors.push({
          line: i + 1,
          message: `Invalid variable reference 'var.${identifier}': identifier must match [a-zA-Z_][a-zA-Z0-9_]*`,
          rule: "invalid_var_reference",
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates that resource names use only valid characters.
 * Valid resource names match: [a-zA-Z0-9_-]+
 */
export function validateResourceNames(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    // Match resource "type" "name" declarations
    const resourcePattern = /^resource\s+"[^"]*"\s+"([^"]*)"/;
    const match = trimmed.match(resourcePattern);
    if (match) {
      const name = match[1];
      if (!/^[a-zA-Z0-9_\-]+$/.test(name)) {
        errors.push({
          line: i + 1,
          message: `Invalid resource name '${name}': must match [a-zA-Z0-9_-]+`,
          rule: "invalid_resource_name",
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates that count expressions have balanced parentheses.
 */
export function validateCountExpressions(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    // Match count = <expression> lines
    const countPattern = /^\s*count\s*=\s*(.+)$/;
    const match = line.match(countPattern);
    if (match) {
      const expression = match[1];
      let depth = 0;
      for (const char of expression) {
        if (char === "(") depth++;
        if (char === ")") depth--;
        if (depth < 0) break;
      }
      if (depth !== 0) {
        errors.push({
          line: i + 1,
          message: `Unbalanced parentheses in count expression: '${expression.trim()}'`,
          rule: "invalid_count_expression",
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * The four mandatory attributes of the Bloque_Rotacion, with their exact
 * expected values (IskayPet standard: master credential managed by Secrets
 * Manager, rotated every 15 days, never rotated immediately on apply).
 */
const ROTATION_ATTRIBUTES: ReadonlyArray<{
  name: string;
  expected: string;
  /** bool → value is a bare keyword (true/false); string → a double-quoted literal. */
  kind: "bool" | "string";
}> = [
  { name: "manage_master_user_password", expected: "true", kind: "bool" },
  { name: "manage_master_user_password_rotation", expected: "true", kind: "bool" },
  { name: "master_user_password_rotate_immediately", expected: "false", kind: "bool" },
  {
    name: "master_user_password_rotation_schedule_expression",
    expected: '"rate(15 days)"',
    kind: "string",
  },
];

/**
 * Locates an attribute assignment (`<name> = <value>`) in the file and returns
 * its 1-based line number plus the raw assigned value. The name is matched with
 * identifier boundaries so that e.g. `manage_master_user_password` does not
 * spuriously match `manage_master_user_password_rotation`. Comment lines are
 * skipped. Returns null when the attribute is absent.
 */
function findRotationAttribute(
  lines: string[],
  attr: { name: string; kind: "bool" | "string" },
): { line: number; value: string } | null {
  const valueCapture = attr.kind === "string" ? '("[^"]*")' : "([A-Za-z0-9_]+)";
  const re = new RegExp(
    `(?<![A-Za-z0-9_])${attr.name}(?![A-Za-z0-9_])\\s*=\\s*${valueCapture}`,
  );
  // Presence check: the name is assigned (`= ...`) even if the value shape is unexpected.
  const presenceRe = new RegExp(
    `(?<![A-Za-z0-9_])${attr.name}(?![A-Za-z0-9_])\\s*=\\s*(\\S.*)$`,
  );

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;

    const match = lines[i].match(re);
    if (match) {
      return { line: i + 1, value: match[1] };
    }
    const presence = lines[i].match(presenceRe);
    if (presence) {
      // Assigned, but the value did not match the expected shape (e.g. a non-bool
      // keyword or an unquoted/garbled value). Report the raw value as-is.
      return { line: i + 1, value: presence[1].trim() };
    }
  }
  return null;
}

/**
 * Validates that a generated RDS Terraform file includes the mandatory master
 * password rotation block (Bloque_Rotacion) managed by Secrets Manager
 * (IskayPet standard). Verifies both the presence AND the exact value of all
 * four attributes; only meaningful for resource_type 'rds'.
 *
 * Required attributes (exact values):
 *   manage_master_user_password                       = true
 *   manage_master_user_password_rotation              = true
 *   master_user_password_rotate_immediately           = false
 *   master_user_password_rotation_schedule_expression = "rate(15 days)"
 *
 * Returns invalid listing every attribute that is absent or has an incorrect
 * value, so the caller can surface a complete diagnostic.
 */
export function validateRdsPasswordRotation(content: string): ValidationResult {
  const errors: ValidationError[] = [];
  const lines = content.split("\n");

  for (const attr of ROTATION_ATTRIBUTES) {
    const found = findRotationAttribute(lines, attr);

    if (!found) {
      errors.push({
        line: 0,
        message: `RDS is missing required rotation attribute: ${attr.name} = ${attr.expected}`,
        rule: "rds_rotation_missing",
      });
      continue;
    }

    if (found.value !== attr.expected) {
      errors.push({
        line: found.line,
        message: `RDS rotation attribute ${attr.name} must be ${attr.expected} but found ${found.value}`,
        rule: "rds_rotation_invalid_value",
      });
    }
  }

  return { valid: errors.length === 0, errors };
}
export function validateHclSyntax(content: string): { valid: boolean; errors: ValidationError[] } {
  const errors: ValidationError[] = [];

  if (!content || content.trim().length === 0) {
    errors.push({ line: 0, message: "Empty Terraform content", rule: "empty_content" });
    return { valid: false, errors };
  }

  // Check balanced braces
  let braceCount = 0;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    for (const char of line) {
      if (char === "{") braceCount++;
      if (char === "}") braceCount--;
      if (braceCount < 0) {
        errors.push({ line: i + 1, message: "Unexpected closing brace", rule: "unbalanced_braces" });
        return { valid: false, errors };
      }
    }
  }
  if (braceCount !== 0) {
    errors.push({
      line: lines.length,
      message: `Unbalanced braces: ${braceCount} unclosed`,
      rule: "unbalanced_braces",
    });
    return { valid: false, errors };
  }

  // Check for unclosed strings
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("#") || line.startsWith("//")) continue;
    const quoteCount = (line.match(/(?<!\\)"/g) || []).length;
    if (quoteCount % 2 !== 0) {
      if (!line.includes("<<")) {
        errors.push({
          line: i + 1,
          message: `Unclosed string on line ${i + 1}`,
          rule: "unclosed_string",
        });
        return { valid: false, errors };
      }
    }
  }

  // Check for valid block structure
  const blockPattern =
    /^(resource|variable|data|module|output|locals|terraform|provider)\s/m;
  if (!blockPattern.test(content)) {
    errors.push({
      line: 1,
      message: "No valid Terraform block found (resource, variable, data, module, etc.)",
      rule: "no_valid_block",
    });
    return { valid: false, errors };
  }

  // Run new validators
  const varResult = validateVariableReferences(content);
  errors.push(...varResult.errors);

  const resourceResult = validateResourceNames(content);
  errors.push(...resourceResult.errors);

  const countResult = validateCountExpressions(content);
  errors.push(...countResult.errors);

  return { valid: errors.length === 0, errors };
}

// Validador_IAM anti-admin (feature: iam-role-least-privilege). Se re-exporta
// desde aquí para que el `execute` lo consuma junto al resto de validadores
// (validateHclSyntax → validateRdsPasswordRotation → ... → validateIamPolicyAdmin).
export { validateIamPolicyAdmin, validateManagedPolicyArn } from "./iam-catalog/validator";
