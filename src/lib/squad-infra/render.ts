/**
 * Unified renderer: given a resource type + validated config + squad context,
 * produces the HCL content, the target file path, optional variables.tf
 * additions, and the list of sensitive CI/CD variables that must be configured
 * in GitLab (for secrets).
 */

import {
  renderSqs, renderSecret, renderSecretVariables, renderDynamo, renderSns, renderEventBridge,
  type SquadResourceType, type SquadTagContext,
} from "./templates";
import type { SquadRepoEntry } from "./squad-catalog";

export interface RenderResult {
  hcl: string;
  filePath: string;
  /** Content to append to variables.tf, if any (secrets). */
  variablesHcl?: string;
  /** CI/CD variables that must exist in GitLab (values provided by user at request time). */
  ciVars?: Array<{ key: string; masked: boolean; protected: boolean }>;
}

function sanitizeFileName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function renderResource(
  resourceType: SquadResourceType,
  config: any,
  squad: SquadRepoEntry
): RenderResult {
  const ctx: SquadTagContext = { projectTag: squad.projectTag, ownerTag: "Digital" };
  const root = squad.infraRootPath.replace(/\/+$/, "");

  switch (resourceType) {
    case "sqs": {
      const hcl = renderSqs(config, ctx);
      return { hcl, filePath: `${root}/${sanitizeFileName(config.name)}.tf` };
    }
    case "secret": {
      const hcl = renderSecret(config, ctx);
      const variablesHcl = renderSecretVariables(config);
      const ciVars = (config.keys as Array<{ tfVar: string }>).map((k) => ({
        key: `TF_VAR_${k.tfVar}`,
        masked: true,
        protected: true,
      }));
      // Secret file name derived from the last path segment.
      const lastSeg = String(config.name).split("/").pop() || "secret";
      return { hcl, filePath: `${root}/${sanitizeFileName(lastSeg)}-secret.tf`, variablesHcl, ciVars };
    }
    case "dynamodb": {
      const hcl = renderDynamo(config, ctx);
      return { hcl, filePath: `${root}/${sanitizeFileName(config.name)}.tf` };
    }
    case "sns": {
      const hcl = renderSns(config, ctx);
      return { hcl, filePath: `${root}/${sanitizeFileName(config.name)}-sns.tf` };
    }
    case "eventbridge": {
      const hcl = renderEventBridge(config, ctx);
      return { hcl, filePath: `${root}/${sanitizeFileName(config.name)}-eventbridge.tf` };
    }
    default:
      throw new Error(`Unsupported resource type: ${resourceType}`);
  }
}
