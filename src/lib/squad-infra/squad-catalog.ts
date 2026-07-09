import pool from "@/lib/db";

export interface SquadRepoEntry {
  id: number;
  squad: string;
  displayName: string;
  businessTeam: string;
  gitlabProjectId: number;
  defaultBranch: string;
  infraRootPath: string;
  awsAccountDev: string | null;
  awsAccountUat: string | null;
  awsAccountPro: string | null;
  accountIdVar: string;
  domainTag: string;
  projectTag: string;
  environments: string[];
  active: boolean;
}

type Row = {
  id: number;
  squad: string;
  display_name: string;
  business_team: string;
  gitlab_project_id: number;
  default_branch: string;
  infra_root_path: string;
  aws_account_dev: string | null;
  aws_account_uat: string | null;
  aws_account_pro: string | null;
  account_id_var: string;
  domain_tag: string;
  project_tag: string;
  environments: string[];
  active: boolean;
};

function toEntry(r: Row): SquadRepoEntry {
  return {
    id: r.id,
    squad: r.squad,
    displayName: r.display_name,
    businessTeam: r.business_team,
    gitlabProjectId: r.gitlab_project_id,
    defaultBranch: r.default_branch,
    infraRootPath: r.infra_root_path,
    awsAccountDev: r.aws_account_dev,
    awsAccountUat: r.aws_account_uat,
    awsAccountPro: r.aws_account_pro,
    accountIdVar: r.account_id_var,
    domainTag: r.domain_tag,
    projectTag: r.project_tag,
    environments: r.environments,
    active: r.active,
  };
}

class SquadCatalog {
  async getAll(): Promise<SquadRepoEntry[]> {
    const res = await pool.query<Row>(
      "SELECT * FROM squad_repo_catalog WHERE active = true ORDER BY display_name ASC"
    );
    return res.rows.map(toEntry);
  }

  async getBySquad(squad: string): Promise<SquadRepoEntry | null> {
    const res = await pool.query<Row>(
      "SELECT * FROM squad_repo_catalog WHERE LOWER(squad) = LOWER($1) AND active = true LIMIT 1",
      [squad]
    );
    return res.rows.length > 0 ? toEntry(res.rows[0]) : null;
  }
}

export const squadCatalog = new SquadCatalog();
