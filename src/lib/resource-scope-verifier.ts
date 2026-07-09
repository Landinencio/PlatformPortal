/**
 * Resource Scope Verifier
 *
 * Utilities for extracting resource/module blocks from HCL content
 * and verifying that modifications only affect the target resource
 * and its related resources (identified by name prefix matching).
 */

/**
 * Extracts all resource and module block names from HCL content.
 * Returns a Map of "type.name" -> block content (the full block body).
 *
 * Handles:
 * - resource "type" "name" { ... }
 * - module "name" { ... }
 */
export function extractResourceBlocks(content: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const lines = content.split('\n');

  // Regex to match resource or module block declarations
  const resourcePattern = /^(resource)\s+"([^"]+)"\s+"([^"]+)"\s*\{/;
  const modulePattern = /^(module)\s+"([^"]+)"\s*\{/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();

    let blockName: string | null = null;
    let matchedResource = line.match(resourcePattern);
    let matchedModule = line.match(modulePattern);

    if (matchedResource) {
      // resource "type" "name" -> "type.name"
      blockName = `${matchedResource[2]}.${matchedResource[3]}`;
    } else if (matchedModule) {
      // module "name" -> "module.name"
      blockName = `module.${matchedModule[2]}`;
    }

    if (blockName) {
      // Find the matching closing brace by counting braces
      let braceCount = 1;
      let blockContent = lines[i];
      let j = i + 1;

      while (j < lines.length && braceCount > 0) {
        const currentLine = lines[j];
        blockContent += '\n' + currentLine;

        // Count braces (ignoring those inside strings)
        for (let k = 0; k < currentLine.length; k++) {
          const ch = currentLine[k];
          if (ch === '"') {
            // Skip string content
            k++;
            while (k < currentLine.length && currentLine[k] !== '"') {
              if (currentLine[k] === '\\') k++; // skip escaped chars
              k++;
            }
          } else if (ch === '{') {
            braceCount++;
          } else if (ch === '}') {
            braceCount--;
          }
        }
        j++;
      }

      blocks.set(blockName, blockContent);
      i = j;
    } else {
      i++;
    }
  }

  return blocks;
}

/**
 * Verifies that modifications between original and modified HCL content
 * only affect the target resource and its related resources.
 *
 * "Related resources" are identified by name prefix matching:
 * e.g., target "my_db" allows changes to "my_db_subnet_group",
 * "my_db_security_group", "my_db_policy_attachment".
 *
 * @param original - The original HCL file content
 * @param modified - The modified HCL file content
 * @param targetResource - The name of the target resource (just the name part, not type)
 * @returns Object with valid flag and list of unexpected changes
 */
export function verifyModifyScope(
  original: string,
  modified: string,
  targetResource: string
): { valid: boolean; unexpectedChanges: string[] } {
  const originalBlocks = extractResourceBlocks(original);
  const modifiedBlocks = extractResourceBlocks(modified);

  const unexpectedChanges: string[] = [];

  /**
   * Check if a block name is related to the target resource.
   * A block is related if its resource name starts with the target resource name.
   * Block name format: "type.name" or "module.name"
   */
  function isRelatedToTarget(blockName: string): boolean {
    // Extract the resource name part (after the dot)
    const dotIndex = blockName.indexOf('.');
    if (dotIndex === -1) return false;
    const resourceName = blockName.substring(dotIndex + 1);
    return resourceName.startsWith(targetResource);
  }

  // Check for blocks that were modified (content changed)
  for (const [name, modifiedContent] of modifiedBlocks) {
    const originalContent = originalBlocks.get(name);
    if (originalContent !== undefined && originalContent !== modifiedContent) {
      // Block was modified — check if it's allowed
      if (!isRelatedToTarget(name)) {
        unexpectedChanges.push(name);
      }
    }
  }

  // Check for blocks that were added in modified but not in original
  for (const [name] of modifiedBlocks) {
    if (!originalBlocks.has(name)) {
      if (!isRelatedToTarget(name)) {
        unexpectedChanges.push(name);
      }
    }
  }

  // Check for blocks that were removed (in original but not in modified)
  for (const [name] of originalBlocks) {
    if (!modifiedBlocks.has(name)) {
      if (!isRelatedToTarget(name)) {
        unexpectedChanges.push(name);
      }
    }
  }

  return {
    valid: unexpectedChanges.length === 0,
    unexpectedChanges,
  };
}
