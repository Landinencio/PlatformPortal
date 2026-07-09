// POST /api/infra-request-v2/list-resources
// Lists existing infrastructure resources from the team's GitLab repo

import { NextResponse } from 'next/server'
import { requireUserAuth } from '@/lib/api-auth'
import { repoCatalog } from '@/lib/repo-catalog'
import { gitlabClient } from '@/lib/gitlab'
import {
  parseRdsResources,
  parseS3Resources,
  parseIamRoleResources,
  type ParsedResource,
} from '@/lib/infra-resource-parser'

export const dynamic = 'force-dynamic'

const RESOURCE_PATHS: Record<string, { dir?: string; file?: string }> = {
  rds: { dir: 'iac/databases' },
  s3: { file: 'iac/storage/s3.tf' },
  iam_role: { file: 'iac/services/roles.tf' },
}

export async function POST(request: Request) {
  console.log(`[list-resources] ▶ Request received`)
  const auth = await requireUserAuth(request)
  if (auth.error) return auth.error

  const body = await request.json()
  const { team, resourceType } = body as { team?: string; resourceType?: string }

  if (!team || !resourceType) {
    return NextResponse.json({ error: 'team and resourceType required' }, { status: 400 })
  }

  const catalog = await repoCatalog.getByTeam(team)
  if (!catalog) {
    return NextResponse.json({ error: `Team "${team}" not found` }, { status: 422 })
  }

  const { gitlabProjectId: projectId, defaultBranch } = catalog
  const pathConfig = RESOURCE_PATHS[resourceType]
  if (!pathConfig) {
    return NextResponse.json({ error: `Invalid resourceType: ${resourceType}` }, { status: 400 })
  }

  try {
    let resources: ParsedResource[] = []

    if (resourceType === 'rds' && pathConfig.dir) {
      // List all .tf files in databases dir, read each one
      const tree = await gitlabClient.listRepoTree(projectId, pathConfig.dir, defaultBranch, false)
      const tfFiles = tree.filter(f => f.type === 'blob' && f.path.endsWith('.tf'))

      const skip = ['backend.tf', 'provider.tf', 'variables.tf', 'identifiers.tf', 'rbac.tf']
      const relevantFiles = tfFiles.filter(f => !skip.includes(f.name))

      const filesWithContent: { path: string; content: string }[] = []
      for (const file of relevantFiles.slice(0, 30)) {
        const content = await gitlabClient.getRepositoryFileRaw(projectId, file.path, defaultBranch)
        if (content) filesWithContent.push({ path: file.path, content })
      }

      resources = parseRdsResources(filesWithContent)
    } else if (pathConfig.file) {
      const content = await gitlabClient.getRepositoryFileRaw(projectId, pathConfig.file, defaultBranch)
      if (!content) {
        return NextResponse.json({ resources: [] })
      }

      if (resourceType === 's3') {
        resources = parseS3Resources(pathConfig.file, content)
      } else if (resourceType === 'iam_role') {
        resources = parseIamRoleResources(pathConfig.file, content)
      }
    }

    console.log(`[list-resources] ✓ Found ${resources.length} resources for ${team}/${resourceType}`)
    return NextResponse.json({ resources })
  } catch (err) {
    console.error('[list-resources] error:', err)
    return NextResponse.json({ error: 'Error listing resources' }, { status: 500 })
  }
}
