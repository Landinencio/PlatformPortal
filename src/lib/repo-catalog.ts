import pool from './db'

export interface RepoCatalogEntry {
  id: number
  team: string
  gitlabProjectId: number
  defaultBranch: string
  infraRootPath: string
  description: string | null
  active: boolean
  createdAt: string
  updatedAt: string
}

type RepoCatalogRow = {
  id: number
  team: string
  gitlab_project_id: number
  default_branch: string
  infra_root_path: string
  description: string | null
  active: boolean
  created_at: string
  updated_at: string
}

function rowToEntry(row: RepoCatalogRow): RepoCatalogEntry {
  return {
    id: row.id,
    team: row.team,
    gitlabProjectId: row.gitlab_project_id,
    defaultBranch: row.default_branch,
    infraRootPath: row.infra_root_path,
    description: row.description,
    active: row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

class RepoCatalog {
  /** Returns all entries regardless of active status (Requirement 6.2) */
  async getAll(): Promise<RepoCatalogEntry[]> {
    const result = await pool.query<RepoCatalogRow>(
      'SELECT * FROM repo_catalog ORDER BY team ASC'
    )
    return result.rows.map(rowToEntry)
  }

  /** Returns the matching active entry, or null if none exists (Requirement 6.3).
   *  Case-insensitive match on `team` so it works whether the caller passes a
   *  slug ("digital") or a label ("Digital"/"MarTech"). Avoids 422s caused by
   *  the slug/label mismatch between the create form and the modify form. */
  async getByTeam(team: string): Promise<RepoCatalogEntry | null> {
    const result = await pool.query<RepoCatalogRow>(
      'SELECT * FROM repo_catalog WHERE LOWER(team) = LOWER($1) AND active = true ORDER BY id ASC LIMIT 1',
      [team]
    )
    return result.rows.length > 0 ? rowToEntry(result.rows[0]) : null
  }

  /** Upserts an entry and returns the saved record (Requirement 6.4) */
  async upsert(
    entry: Omit<RepoCatalogEntry, 'id' | 'createdAt' | 'updatedAt'>
  ): Promise<RepoCatalogEntry> {
    const result = await pool.query<RepoCatalogRow>(
      `INSERT INTO repo_catalog (team, gitlab_project_id, default_branch, infra_root_path, description, active)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (team) DO UPDATE SET
         gitlab_project_id = EXCLUDED.gitlab_project_id,
         default_branch    = EXCLUDED.default_branch,
         infra_root_path   = EXCLUDED.infra_root_path,
         description       = EXCLUDED.description,
         active            = EXCLUDED.active,
         updated_at        = NOW()
       RETURNING *`,
      [
        entry.team,
        entry.gitlabProjectId,
        entry.defaultBranch,
        entry.infraRootPath,
        entry.description ?? null,
        entry.active,
      ]
    )
    return rowToEntry(result.rows[0])
  }

  /** Sets active = false for the team; subsequent getByTeam returns null (Requirement 6.5) */
  async deactivate(team: string): Promise<void> {
    await pool.query(
      'UPDATE repo_catalog SET active = false, updated_at = NOW() WHERE team = $1',
      [team]
    )
  }
}

export const repoCatalog = new RepoCatalog()
