export const ADR_BRANCH_NAMING_ID = "ADR-001";
export const ADR_BRANCH_NAME_REGEX = "^(feat|fix|hotfix|perf|refactor|chore|build|ci|docs|test)\\/[A-Z]+-[0-9]+$";
export const ADR_BRANCH_NAME_EXAMPLE = "feat/OMS-342";

export const DEFAULT_PRODUCTION_DEPLOY_STAGE = "deploy_prod";
export const DEFAULT_PRODUCTION_DEPLOY_JOB_PATTERNS = [
  "deploy_prod",
  "deploy-production",
  "deploy_prd",
  "deploy-prd",
  "deploy_artifact",
  "deploy-artifact",
  "android_playstore_prod",
  "ios_appstore_prod",
  "playstore_prod",
  "appstore_prod",
  "distribute_prod",
] as const;
export const DEFAULT_PRODUCTION_ENVIRONMENTS = ["production", "prod"] as const;

export function buildGitLabRepositoryCompliancePayload() {
  return {
    adrId: ADR_BRANCH_NAMING_ID,
    branchNaming: {
      required: true,
      regex: ADR_BRANCH_NAME_REGEX,
      example: ADR_BRANCH_NAME_EXAMPLE,
      pushRuleTarget: "Settings > Repository > Push rules > Branch name",
      validation: {
        ciRecommended: true,
      },
    },
    dora: {
      productionDeployStage: DEFAULT_PRODUCTION_DEPLOY_STAGE,
      productionEnvironments: [...DEFAULT_PRODUCTION_ENVIRONMENTS],
      deployDefinition:
        "A production deployment is counted when the deploy_prod job finishes successfully after ArgoCD/Kubernetes verification.",
    },
  };
}
