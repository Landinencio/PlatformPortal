/**
 * Field validators for infrastructure request form data.
 *
 * Each validator returns `null` if valid, or a descriptive error string
 * identifying the field and violated rule.
 */

/**
 * Validates RDS identifier fields.
 * Rules:
 * - Must not start with a hyphen
 * - Must not end with a hyphen
 * - Must not exceed 63 characters
 */
export function validateRdsFields(fields: Record<string, any>): string | null {
  const identifierFields = ['identifier', 'dbIdentifier', 'name'];

  for (const fieldName of identifierFields) {
    const value = fields[fieldName];
    if (typeof value !== 'string' || value === '') continue;

    if (value.startsWith('-')) {
      return `Field "${fieldName}" must not start with a hyphen`;
    }
    if (value.endsWith('-')) {
      return `Field "${fieldName}" must not end with a hyphen`;
    }
    if (value.length > 63) {
      return `Field "${fieldName}" must not exceed 63 characters (got ${value.length})`;
    }
  }

  return null;
}

/**
 * Validates S3 bucket name fields.
 * Rules:
 * - Must not contain "aws" or "amazon" (case-insensitive)
 * - Must be 3-63 characters long
 * - Must contain only lowercase letters, numbers, hyphens, and periods
 */
export function validateS3Fields(fields: Record<string, any>): string | null {
  const bucketFields = ['bucketName', 'name', 'bucket'];

  for (const fieldName of bucketFields) {
    const value = fields[fieldName];
    if (typeof value !== 'string' || value === '') continue;

    if (value.length < 3) {
      return `Field "${fieldName}" must be at least 3 characters long (got ${value.length})`;
    }
    if (value.length > 63) {
      return `Field "${fieldName}" must not exceed 63 characters (got ${value.length})`;
    }
    if (/aws/i.test(value)) {
      return `Field "${fieldName}" must not contain "aws"`;
    }
    if (/amazon/i.test(value)) {
      return `Field "${fieldName}" must not contain "amazon"`;
    }
    if (!/^[a-z0-9.\-]+$/.test(value)) {
      return `Field "${fieldName}" must contain only lowercase letters, numbers, hyphens, and periods`;
    }
  }

  return null;
}

/**
 * Validates IAM role namespace fields.
 * Rules (Kubernetes namespace pattern):
 * - Must start with a lowercase letter
 * - Must contain only lowercase alphanumeric characters and hyphens
 * - Must not exceed 63 characters
 */
export function validateIamRoleFields(fields: Record<string, any>): string | null {
  // Role name validation (mirrors client ROLE_NAME_RE in iam-role-fields.tsx):
  // starts with a letter, alphanumeric/hyphen/underscore, 3-64 chars total.
  const roleNameFields = ['roleName', 'role_name', 'name'];
  for (const fieldName of roleNameFields) {
    const value = fields[fieldName];
    if (typeof value !== 'string' || value === '') continue;
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{2,63}$/.test(value)) {
      return `Field "${fieldName}" must start with a letter and contain only alphanumerics, hyphens or underscores (3-64 chars)`;
    }
  }

  const namespaceFields = ['namespace', 'k8sNamespace'];

  for (const fieldName of namespaceFields) {
    const value = fields[fieldName];
    if (typeof value !== 'string' || value === '') continue;

    if (value.length > 63) {
      return `Field "${fieldName}" must not exceed 63 characters (got ${value.length})`;
    }
    if (!/^[a-z]/.test(value)) {
      return `Field "${fieldName}" must start with a lowercase letter`;
    }
    if (!/^[a-z][a-z0-9\-]*$/.test(value)) {
      return `Field "${fieldName}" must contain only lowercase alphanumeric characters and hyphens`;
    }
  }

  return null;
}
