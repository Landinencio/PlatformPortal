/**
 * Secret Scanner
 *
 * Regex-based scanner for common credential patterns in Terraform content.
 * Detects AWS access keys, AWS secret keys, hardcoded password assignments,
 * and bearer tokens. Intentionally excludes Terraform variable references
 * (var.password, random_password.*.result) to avoid false positives.
 */

export interface ScanResult {
  clean: boolean;
  findings: Array<{
    patternType: string;
    line: number;
  }>;
}

interface PatternDef {
  patternType: string;
  regex: RegExp;
  /** Optional function to check if a match is a false positive */
  isFalsePositive?: (lineContent: string, match: RegExpMatchArray) => boolean;
}

/**
 * Returns true if a password assignment line is actually a Terraform variable
 * reference (var.password, random_password.*.result) rather than a hardcoded secret.
 */
function isPasswordFalsePositive(lineContent: string): boolean {
  // Matches: password = "var.something" or password = var.something
  if (/password\s*=\s*"?var\./.test(lineContent)) return true;
  // Matches: password = "random_password.xxx.result" or password = random_password.xxx.result
  if (/password\s*=\s*"?random_password\.\w+\.result/.test(lineContent)) return true;
  // Matches: password = var.password (without quotes)
  if (/password\s*=\s*var\./.test(lineContent)) return true;
  // Matches: password = random_password.xxx.result (without quotes)
  if (/password\s*=\s*random_password\.\w+\.result/.test(lineContent)) return true;
  return false;
}

const PATTERNS: PatternDef[] = [
  {
    patternType: "aws_access_key",
    regex: /AKIA[0-9A-Z]{16}/,
  },
  {
    patternType: "aws_secret_key",
    regex: /[=:]\s*["']?[A-Za-z0-9+/]{40}["']?/,
  },
  {
    patternType: "password",
    regex: /password\s*=\s*"[^"]+"/,
    isFalsePositive: (lineContent: string) => isPasswordFalsePositive(lineContent),
  },
  {
    patternType: "bearer_token",
    regex: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/,
  },
];

/**
 * Scans content for common secret patterns.
 *
 * Returns a ScanResult with clean=true if no secrets found, or clean=false
 * with findings listing each detected pattern type and line number.
 * Findings intentionally do NOT include the matched secret value.
 */
export function scanForSecrets(content: string): ScanResult {
  const findings: Array<{ patternType: string; line: number }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const lineContent = lines[i];
    const lineNumber = i + 1;

    for (const pattern of PATTERNS) {
      if (pattern.regex.test(lineContent)) {
        // Check for false positives
        if (pattern.isFalsePositive && pattern.isFalsePositive(lineContent)) {
          continue;
        }
        findings.push({
          patternType: pattern.patternType,
          line: lineNumber,
        });
      }
    }
  }

  return {
    clean: findings.length === 0,
    findings,
  };
}
