/**
 * Extractor de cableado de red — pure, total discovery of the VPC / subnet /
 * security-group wiring that a Repositorio_Destino already uses for its RDS
 * modules, so the deterministic Generador_RDS can REPLICATE it instead of
 * hardcoding repo-specific variable names.
 *
 * Feature: infra-self-service-hardening (SRE-001).
 *
 * ## Why this exists (verified incident)
 *
 * An RDS created by the portal (`mkp-ur-connector`, prod digital account
 * 111222333444) landed in the account's DEFAULT VPC and was unreachable: the
 * rendered `.tf` had NO network block (no `aws_security_group`, no
 * `vpc_security_group_ids`, no `create_db_subnet_group`/`subnet_ids`), so the
 * upstream `terraform-aws-modules/rds/aws` module defaulted to the default VPC.
 *
 * Correct RDS in the same repos (e.g. `core-rds-postgres`,
 * `marketplace-payments-api-db`) DO wire a security group + `subnet_ids` +
 * `vpc_security_group_ids`. Different team repos (digital/oms, retail, data,
 * marktech) name their network variables differently (`var.oms_pvt_subnet`,
 * `var.vpc_id`, …), so the generator MUST discover the wiring from the target
 * repo's own existing RDS instead of assuming a name.
 *
 * ## Contract
 *
 * `extractNetworkWiring` is PURE and TOTAL: it never performs I/O and never
 * throws on arbitrary input. It returns the MAJORITY wiring found across the
 * repo's `.tf` contents, or `null` when no existing RDS module yields a
 * complete wiring (the caller treats `null` as a fail-safe: block generation,
 * never fall back to the default VPC).
 */

/** Raw right-hand-side expressions discovered from an existing RDS module. */
export interface NetworkWiring {
  /** Raw RHS of the security group's `vpc_id`, e.g. `"var.vpc_id"`. */
  vpcIdExpr: string;
  /** Raw RHS of the module's `subnet_ids`, e.g. `"var.oms_pvt_subnet"`. */
  subnetIdsExpr: string;
  /**
   * Raw RHS of the SG ingress `cidr_blocks`, e.g.
   * `"concat(var.eks_vpc_private_subnet_cidrs, var.new_vpn_route, ...)"`.
   */
  ingressCidrExpr: string;
  /** Port taken from the SG ingress `from_port`, e.g. `5432`. */
  port: number;
}

const RDS_MODULE_SOURCE = "terraform-aws-modules/rds/aws";

/**
 * Returns the index just past the `}` that matches the `{` at `openBrace`.
 * Total: on an unbalanced/truncated body it returns `content.length`.
 */
function matchBraces(content: string, openBrace: number): number {
  let depth = 0;
  for (let i = openBrace; i < content.length; i++) {
    const ch = content[i];
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return content.length;
}

/**
 * Extracts every `module "<name>" { ... }` body (including the outermost
 * braces) using brace matching so nested blocks stay together. Adapted from
 * `extractModuleBlocks` in repo-introspection.ts.
 */
function extractModuleBlocks(content: string): string[] {
  const blocks: string[] = [];
  const header = /module\s+"[^"]*"\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(content)) !== null) {
    const openBrace = match.index + match[0].length - 1;
    const end = matchBraces(content, openBrace);
    blocks.push(content.slice(openBrace, end));
    header.lastIndex = end;
  }
  return blocks;
}

/**
 * Extracts every `resource "aws_security_group" "<name>" { ... }` body keyed by
 * its `<name>`, using brace matching. Later declarations with the same name
 * overwrite earlier ones (last wins) — deterministic for well-formed HCL where
 * names are unique.
 */
function extractSecurityGroupBlocks(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const header = /resource\s+"aws_security_group"\s+"([^"]*)"\s*\{/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(content)) !== null) {
    const name = match[1];
    const openBrace = match.index + match[0].length - 1;
    const end = matchBraces(content, openBrace);
    map.set(name, content.slice(openBrace, end));
    header.lastIndex = end;
  }
  return map;
}

/**
 * Extracts the single-line right-hand side of `attr = <rhs>` from a block body.
 * The attribute must start its own line (after optional indentation) so
 * `subnet_ids` never matches `vpc_security_group_ids` and `vpc_id` never
 * matches a longer name. Returns the trimmed RHS or `null`.
 */
function extractRhs(body: string, attr: string): string | null {
  const re = new RegExp(`(?:^|\\n)[ \\t]*${attr}[ \\t]*=[ \\t]*([^\\n]+)`);
  const m = body.match(re);
  return m ? m[1].trim() : null;
}

/**
 * Returns the body (including outer braces) of the first `ingress { ... }`
 * block inside a security-group body, or `null` when none is present.
 */
function extractIngressBlock(sgBody: string): string | null {
  const header = /ingress\s*\{/g;
  const match = header.exec(sgBody);
  if (!match) return null;
  const openBrace = match.index + match[0].length - 1;
  const end = matchBraces(sgBody, openBrace);
  return sgBody.slice(openBrace, end);
}

/**
 * Is this module block an RDS module (`source = "terraform-aws-modules/rds/aws"`)?
 */
function isRdsModule(moduleBody: string): boolean {
  const sourceMatch = moduleBody.match(/source\s*=\s*"([^"]+)"/);
  return !!sourceMatch && sourceMatch[1] === RDS_MODULE_SOURCE;
}

/**
 * Discovers the network wiring from the target repo's existing RDS modules.
 *
 * For each `terraform-aws-modules/rds/aws` module that ALSO declares
 * `subnet_ids = <expr>` and `vpc_security_group_ids = [aws_security_group.<NAME>[0].id]`
 * (the `[0]` index is tolerated but optional), it resolves the referenced
 * `aws_security_group "<NAME>"` block and reads its `vpc_id`, the `ingress`
 * `cidr_blocks` and the `from_port`. A module that resolves ALL four values
 * produces a candidate wiring.
 *
 * The MAJORITY candidate (most frequent identical wiring across the repo) is
 * returned. Ties are broken deterministically (smallest `subnetIdsExpr`, then
 * the full serialized wiring). Returns `null` when no module yields a complete
 * wiring.
 *
 * Pure and total: never performs I/O, never throws on arbitrary input.
 */
export function extractNetworkWiring(tfContents: string[]): NetworkWiring | null {
  if (!Array.isArray(tfContents)) return null;

  // Collect ALL security-group blocks and ALL RDS module bodies across every
  // file, so a module in one file can reference an SG declared in another.
  const sgBlocks = new Map<string, string>();
  const rdsModuleBodies: string[] = [];

  for (const content of tfContents) {
    if (typeof content !== "string" || content.length === 0) continue;
    for (const [name, body] of extractSecurityGroupBlocks(content)) {
      sgBlocks.set(name, body);
    }
    for (const body of extractModuleBlocks(content)) {
      if (isRdsModule(body)) rdsModuleBodies.push(body);
    }
  }

  const candidates: NetworkWiring[] = [];

  for (const moduleBody of rdsModuleBodies) {
    const subnetIdsExpr = extractRhs(moduleBody, "subnet_ids");
    if (!subnetIdsExpr) continue;

    // vpc_security_group_ids = [aws_security_group.<NAME>[0].id]  (with/without [0])
    const sgMatch = moduleBody.match(
      /vpc_security_group_ids\s*=\s*\[\s*aws_security_group\.([A-Za-z0-9_]+)(?:\[0\])?\.id\s*\]/,
    );
    if (!sgMatch) continue;
    const sgName = sgMatch[1];

    const sgBody = sgBlocks.get(sgName);
    if (!sgBody) continue;

    const vpcIdExpr = extractRhs(sgBody, "vpc_id");
    if (!vpcIdExpr) continue;

    const ingressBody = extractIngressBlock(sgBody);
    if (!ingressBody) continue;

    const ingressCidrExpr = extractRhs(ingressBody, "cidr_blocks");
    if (!ingressCidrExpr) continue;

    const portMatch = ingressBody.match(/(?:^|\n)[ \t]*from_port[ \t]*=[ \t]*(\d+)/);
    if (!portMatch) continue;
    const port = parseInt(portMatch[1], 10);
    if (!Number.isFinite(port)) continue;

    candidates.push({ vpcIdExpr, subnetIdsExpr, ingressCidrExpr, port });
  }

  if (candidates.length === 0) return null;

  // Majority selection: group identical wirings, pick the most frequent.
  const groups = new Map<string, { wiring: NetworkWiring; count: number }>();
  for (const c of candidates) {
    const key = JSON.stringify([c.vpcIdExpr, c.subnetIdsExpr, c.ingressCidrExpr, c.port]);
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { wiring: c, count: 1 });
  }

  let best: { wiring: NetworkWiring; count: number } | null = null;
  let bestTie = "";
  for (const g of groups.values()) {
    // Deterministic tie-break: smallest subnetIdsExpr first, then full wiring.
    const tie = `${g.wiring.subnetIdsExpr}\u0000${g.wiring.vpcIdExpr}\u0000${g.wiring.ingressCidrExpr}\u0000${g.wiring.port}`;
    if (
      best === null ||
      g.count > best.count ||
      (g.count === best.count && tie < bestTie)
    ) {
      best = g;
      bestTie = tie;
    }
  }

  return best ? best.wiring : null;
}
