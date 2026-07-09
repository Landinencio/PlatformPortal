import pool from "@/lib/db";
import { gitlabClient, type GitLabProject } from "@/lib/gitlab";
import type { SonarQubeProject } from "@/lib/sonarqube";

const DIGITAL_GROUP_ID = Number.parseInt(
  process.env.SONAR_GITLAB_GROUP_ID || process.env.DORA_GITLAB_GROUP_ID || "66347331",
  10
) || 66347331;

type ProjectSonarMappingRow = {
  gitlab_project_id: string | number | null;
  gitlab_project_path: string | null;
  sonar_project_key: string;
};

type GitLabProjectCatalog = {
  byId: Map<number, GitLabProject>;
  byName: Map<string, GitLabProject[]>;
  byPathLeaf: Map<string, GitLabProject[]>;
};

export type SonarGitLabMappingReason =
  | "manual_mapping"
  | "auto_exact_match"
  | "non_digital_namespace"
  | "missing_repo_suffix"
  | "repo_not_found"
  | "ambiguous_repo_name"
  | "gitlab_project_already_claimed";

export type SonarGitLabMapping = {
  sonarProjectKey: string;
  sonarProjectName: string | null;
  candidateRepo: string | null;
  gitlabProjectId: number | null;
  gitlabProjectPath: string | null;
  source: "manual" | "auto" | "unmapped";
  reason: SonarGitLabMappingReason;
};

export async function createSonarGitLabResolver() {
  const [gitlabProjects, mappingRows] = await Promise.all([
    loadDigitalGitLabProjects(),
    loadProjectSonarMappings(),
  ]);

  const catalog = buildGitLabProjectCatalog(gitlabProjects);
  const mappingsBySonarKey = new Map<string, ProjectSonarMappingRow>();
  const claimedGitLabProjects = new Map<number, string>();

  for (const row of mappingRows) {
    mappingsBySonarKey.set(row.sonar_project_key, row);

    const gitlabProjectId = toPositiveInt(row.gitlab_project_id);
    if (gitlabProjectId) {
      claimedGitLabProjects.set(gitlabProjectId, row.sonar_project_key);
    }
  }

  const resolveProject = (project: Pick<SonarQubeProject, "key" | "name">): SonarGitLabMapping => {
    const manualMapping = mappingsBySonarKey.get(project.key);
    const candidateRepo = extractGitLabRepoCandidateFromSonarKey(project.key);

    if (manualMapping) {
      const gitlabProjectId = toPositiveInt(manualMapping.gitlab_project_id);
      const mappedProject = gitlabProjectId ? catalog.byId.get(gitlabProjectId) : null;

      return {
        sonarProjectKey: project.key,
        sonarProjectName: project.name || null,
        candidateRepo,
        gitlabProjectId,
        gitlabProjectPath: manualMapping.gitlab_project_path || mappedProject?.path_with_namespace || null,
        source: "manual",
        reason: "manual_mapping",
      };
    }

    if (!candidateRepo) {
      return {
        sonarProjectKey: project.key,
        sonarProjectName: project.name || null,
        candidateRepo: null,
        gitlabProjectId: null,
        gitlabProjectPath: null,
        source: "unmapped",
        reason: isDigitalSonarProject(project.key) ? "missing_repo_suffix" : "non_digital_namespace",
      };
    }

    const matches = findGitLabProjectsByRepoName(catalog, candidateRepo);
    if (matches.length === 0) {
      return {
        sonarProjectKey: project.key,
        sonarProjectName: project.name || null,
        candidateRepo,
        gitlabProjectId: null,
        gitlabProjectPath: null,
        source: "unmapped",
        reason: "repo_not_found",
      };
    }

    if (matches.length > 1) {
      return {
        sonarProjectKey: project.key,
        sonarProjectName: project.name || null,
        candidateRepo,
        gitlabProjectId: null,
        gitlabProjectPath: null,
        source: "unmapped",
        reason: "ambiguous_repo_name",
      };
    }

    const matchedProject = matches[0];
    const claimedBy = claimedGitLabProjects.get(matchedProject.id);
    if (claimedBy && claimedBy !== project.key) {
      return {
        sonarProjectKey: project.key,
        sonarProjectName: project.name || null,
        candidateRepo,
        gitlabProjectId: null,
        gitlabProjectPath: null,
        source: "unmapped",
        reason: "gitlab_project_already_claimed",
      };
    }

    return {
      sonarProjectKey: project.key,
      sonarProjectName: project.name || null,
      candidateRepo,
      gitlabProjectId: matchedProject.id,
      gitlabProjectPath: matchedProject.path_with_namespace,
      source: "auto",
      reason: "auto_exact_match",
    };
  };

  const persistAutoMapping = async (mapping: SonarGitLabMapping) => {
    if (mapping.source !== "auto" || !mapping.gitlabProjectId) {
      return false;
    }

    const existingForKey = mappingsBySonarKey.get(mapping.sonarProjectKey);
    if (existingForKey) {
      return false;
    }

    const claimedBy = claimedGitLabProjects.get(mapping.gitlabProjectId);
    if (claimedBy && claimedBy !== mapping.sonarProjectKey) {
      return false;
    }

    try {
      await pool.query(
        `
          INSERT INTO project_sonar_mapping (
            gitlab_project_id,
            gitlab_project_path,
            sonar_project_key,
            updated_at
          )
          VALUES ($1, $2, $3, NOW())
          ON CONFLICT (sonar_project_key) DO UPDATE
          SET
            gitlab_project_path = EXCLUDED.gitlab_project_path,
            updated_at = NOW()
          WHERE project_sonar_mapping.gitlab_project_id = EXCLUDED.gitlab_project_id
        `,
        [mapping.gitlabProjectId, mapping.gitlabProjectPath, mapping.sonarProjectKey]
      );

      mappingsBySonarKey.set(mapping.sonarProjectKey, {
        gitlab_project_id: mapping.gitlabProjectId,
        gitlab_project_path: mapping.gitlabProjectPath,
        sonar_project_key: mapping.sonarProjectKey,
      });
      claimedGitLabProjects.set(mapping.gitlabProjectId, mapping.sonarProjectKey);

      return true;
    } catch (error) {
      console.error(`Error persisting Sonar mapping for ${mapping.sonarProjectKey}:`, error);
      return false;
    }
  };

  return {
    gitlabProjects,
    resolveProject,
    persistAutoMapping,
  };
}

export function extractGitLabRepoCandidateFromSonarKey(sonarProjectKey: string) {
  if (!isDigitalSonarProject(sonarProjectKey)) {
    return null;
  }

  const segments = sonarProjectKey
    .split(":")
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length < 2) {
    return null;
  }

  const candidate = normalizeRepoToken(segments[segments.length - 1]);
  return candidate || null;
}

function buildGitLabProjectCatalog(projects: GitLabProject[]): GitLabProjectCatalog {
  const byId = new Map<number, GitLabProject>();
  const byName = new Map<string, GitLabProject[]>();
  const byPathLeaf = new Map<string, GitLabProject[]>();

  for (const project of projects) {
    byId.set(project.id, project);
    pushLookup(byName, normalizeRepoToken(project.name), project);
    pushLookup(byPathLeaf, normalizeRepoToken(getPathLeaf(project.path_with_namespace)), project);
  }

  return {
    byId,
    byName,
    byPathLeaf,
  };
}

function findGitLabProjectsByRepoName(catalog: GitLabProjectCatalog, repoName: string) {
  const normalized = normalizeRepoToken(repoName);
  if (!normalized) return [];

  const uniqueMatches = new Map<number, GitLabProject>();
  const directMatches = catalog.byName.get(normalized) || [];
  const leafMatches = catalog.byPathLeaf.get(normalized) || [];

  for (const project of [...directMatches, ...leafMatches]) {
    uniqueMatches.set(project.id, project);
  }

  return [...uniqueMatches.values()].sort((left, right) =>
    left.path_with_namespace.localeCompare(right.path_with_namespace)
  );
}

function pushLookup(map: Map<string, GitLabProject[]>, key: string, project: GitLabProject) {
  if (!key) return;
  const bucket = map.get(key) || [];
  bucket.push(project);
  map.set(key, bucket);
}

async function loadProjectSonarMappings() {
  try {
    const result = await pool.query<ProjectSonarMappingRow>(`
      SELECT gitlab_project_id, gitlab_project_path, sonar_project_key
      FROM project_sonar_mapping
    `);

    return result.rows;
  } catch (error) {
    console.warn("project_sonar_mapping is not available yet or could not be queried:", error);
    return [];
  }
}

async function loadDigitalGitLabProjects() {
  try {
    return await gitlabClient.getProjects(DIGITAL_GROUP_ID);
  } catch (error) {
    console.error("Could not load GitLab project catalog for Sonar mapping:", error);
    return [];
  }
}

function isDigitalSonarProject(sonarProjectKey: string) {
  return sonarProjectKey.trim().toLowerCase().startsWith("iskaypetcom");
}

function normalizeRepoToken(value: string | null | undefined) {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "");
}

function getPathLeaf(pathWithNamespace: string) {
  const parts = pathWithNamespace.split("/").filter(Boolean);
  return parts[parts.length - 1] || pathWithNamespace;
}

function toPositiveInt(value: string | number | null | undefined) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}
