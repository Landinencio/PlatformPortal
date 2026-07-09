// GitLab API client
const GITLAB_API_BASE = 'https://gitlab.com/api/v4';
const GITLAB_TOKEN = process.env.GITLAB_TOKEN || '';

export interface FileWithMeta {
  content: string
  lastCommitId: string
}

export interface GitLabTreeItem {
  id: string
  name: string
  type: 'blob' | 'tree'
  path: string
  mode: string
}

export interface GitLabProject {
    id: number;
    name: string;
    path_with_namespace: string;
    default_branch: string;
}

export interface GitLabPushRule {
    branch_name_regex?: string | null;
}

export interface GitLabProtectedBranch {
    name: string;
}

export interface GitLabExpandedCiJob {
    name?: string;
    stage?: string;
}

export interface GitLabExpandedCiConfig {
    valid?: boolean;
    merged_yaml?: string | null;
    jobs?: GitLabExpandedCiJob[];
    errors?: string[];
    warnings?: string[];
}

export interface GitLabCommit {
    id: string;
    created_at: string;
    author_email: string;
    author_name?: string;
    title: string;
    stats?: {
        additions: number;
        deletions: number;
        total: number;
    };
}

export interface GitLabDeployment {
    id: number;
    created_at: string;
    finished_at?: string | null;
    updated_at?: string;
    status?: string;
    environment: {
        name: string;
    };
    deployable: {
        commit?: {
            id: string;
            created_at: string;
        };
    };
}

export interface GitLabMergeRequest {
    id: number;
    iid: number;
    created_at: string;
    merged_at: string | null;
    title: string;
    source_branch: string;
    labels: string[];
    author: {
        email?: string;
        username?: string;
        name?: string;
    };
}

export interface GitLabMergeRequestForCommit {
    id: number;
    iid: number;
    created_at: string;
    merged_at: string | null;
    title: string;
    source_branch: string;
    labels: string[];
}

type GitLabCompareResponse = {
    commits: GitLabCommit[];
};

class GitLabClient {
    private token: string;
    private baseUrl: string;
    private headers: HeadersInit;

    constructor() {
        this.token = GITLAB_TOKEN;
        this.baseUrl = GITLAB_API_BASE;
        this.headers = {
            'PRIVATE-TOKEN': this.token,
            'Content-Type': 'application/json',
        };
    }

    private buildQuery(params: Record<string, string | number | boolean | undefined>): string {
        const searchParams = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
            if (value === undefined || value === null) continue;
            searchParams.set(key, String(value));
        }
        return searchParams.toString();
    }

    private async fetchJson<T>(endpoint: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
        const query = this.buildQuery(params);
        const url = `${this.baseUrl}${endpoint}${query ? `?${query}` : ''}`;
        const response = await fetch(url, { headers: this.headers });

        if (!response.ok) {
            throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
        }

        return response.json() as Promise<T>;
    }

    private async fetchAll<T>(endpoint: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T[]> {
        const results: T[] = [];
        let page = 1;
        const perPage = 100;

        while (true) {
            const query = this.buildQuery({ ...params, per_page: perPage, page });
            const url = `${this.baseUrl}${endpoint}?${query}`;
            const response = await fetch(url, { headers: this.headers });

            if (!response.ok) {
                throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
            }

            const data = (await response.json()) as T[];
            results.push(...data);

            const linkHeader = response.headers.get('link');
            if (!linkHeader || !linkHeader.includes('rel="next"')) {
                break;
            }

            page += 1;
            if (page > 100) {
                console.warn(`Reached maximum page limit (100 pages, ${results.length} items) for ${endpoint}`);
                break;
            }
        }
        return results;
    }

    async getProjects(groupId: number): Promise<GitLabProject[]> {
        try {
            const projects = await this.fetchAll<GitLabProject>(`/groups/${groupId}/projects`, {
                include_subgroups: true,
                archived: false,
            });
            console.log(`Fetched ${projects.length} projects from group ${groupId}`);
            return projects;
        } catch (error) {
            console.error('Error fetching projects:', error);
            throw error;
        }
    }

    async getProjectPushRule(projectId: number): Promise<GitLabPushRule | null> {
        try {
            return await this.fetchJson<GitLabPushRule>(`/projects/${projectId}/push_rule`);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("404")) {
                return null;
            }
            console.error(`Error fetching push rule for project ${projectId}:`, error);
            return null;
        }
    }

    async getProtectedBranches(projectId: number): Promise<GitLabProtectedBranch[]> {
        try {
            return await this.fetchAll<GitLabProtectedBranch>(`/projects/${projectId}/protected_branches`);
        } catch (error) {
            console.error(`Error fetching protected branches for project ${projectId}:`, error);
            return [];
        }
    }

    async getRepositoryFileRaw(projectId: number, filePath: string, ref: string): Promise<string | null> {
        try {
            const encodedPath = encodeURIComponent(filePath);
            const query = this.buildQuery({ ref });
            const url = `${this.baseUrl}/projects/${projectId}/repository/files/${encodedPath}/raw?${query}`;
            const response = await fetch(url, { headers: this.headers });

            if (response.status === 404) {
                return null;
            }
            if (!response.ok) {
                throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
            }

            return response.text();
        } catch (error) {
            console.error(`Error fetching raw file ${filePath} for project ${projectId}:`, error);
            return null;
        }
    }

    async getRepositoryFileWithMeta(
        projectId: number,
        filePath: string,
        ref: string
    ): Promise<FileWithMeta | null> {
        try {
            const encodedPath = encodeURIComponent(filePath);
            const query = this.buildQuery({ ref });
            const url = `${this.baseUrl}/projects/${projectId}/repository/files/${encodedPath}?${query}`;
            const response = await fetch(url, { headers: this.headers });

            if (response.status === 404) {
                return null;
            }
            if (!response.ok) {
                throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
            }

            const data = await response.json() as { content: string; encoding: string; last_commit_id: string };
            const content = Buffer.from(data.content, 'base64').toString('utf-8');
            return {
                content,
                lastCommitId: data.last_commit_id,
            };
        } catch (error) {
            console.error(`Error fetching file with meta ${filePath} for project ${projectId}:`, error);
            return null;
        }
    }

    async getExpandedCiConfig(projectId: number, ref: string): Promise<GitLabExpandedCiConfig | null> {
        try {
            return await this.fetchJson<GitLabExpandedCiConfig>(`/projects/${projectId}/ci/lint`, {
                content_ref: ref,
                dry_run: true,
                dry_run_ref: ref,
                include_jobs: true,
            });
        } catch (error) {
            console.error(`Error fetching expanded CI config for project ${projectId}:`, error);
            return null;
        }
    }

    async getCommits(projectId: number, since: string, until?: string, withStats = false): Promise<GitLabCommit[]> {
        return this.fetchAll<GitLabCommit>(`/projects/${projectId}/repository/commits`, {
            since,
            until,
            with_stats: withStats,
        });
    }

    async getDeployments(projectId: number, since?: Date): Promise<GitLabDeployment[]> {
        const deployments: GitLabDeployment[] = [];
        let page = 1;
        const perPage = 100;

        while (true) {
            const data = await this.fetchJson<GitLabDeployment[]>(`/projects/${projectId}/deployments`, {
                order_by: 'created_at',
                sort: 'desc',
                per_page: perPage,
                page,
            });

            if (data.length === 0) {
                break;
            }

            for (const deployment of data) {
                if (since) {
                    const createdAt = new Date(deployment.created_at);
                    if (createdAt < since) {
                        return deployments;
                    }
                }
                deployments.push(deployment);
            }

            if (data.length < perPage) {
                break;
            }

            page += 1;
            if (page > 100) {
                console.warn(`Reached maximum page limit (100 pages) for deployments in project ${projectId}`);
                break;
            }
        }

        return deployments;
    }

    async getLatestDeployments(projectId: number, limit = 50): Promise<GitLabDeployment[]> {
        const deployments: GitLabDeployment[] = [];
        let page = 1;
        const perPage = Math.min(Math.max(limit, 1), 100);

        while (deployments.length < limit) {
            const data = await this.fetchJson<GitLabDeployment[]>(`/projects/${projectId}/deployments`, {
                order_by: 'created_at',
                sort: 'desc',
                per_page: perPage,
                page,
            });

            if (data.length === 0) {
                break;
            }

            deployments.push(...data);

            if (data.length < perPage) {
                break;
            }

            page += 1;
            if (page > 20) {
                console.warn(`Reached maximum page limit (20 pages) for latest deployments in project ${projectId}`);
                break;
            }
        }

        return deployments.slice(0, limit);
    }

    async getPipelines(projectId: number, since: string, ref?: string): Promise<any[]> {
        const params: any = {
            updated_after: since,
            order_by: 'updated_at',
            sort: 'desc'
        };
        if (ref) {
            params.ref = ref;
        }
        return this.fetchAll<any>(`/projects/${projectId}/pipelines`, params);
    }

    async getPipelineJobs(
        projectId: number,
        since: string,
        stageNames: string[] = ['deploy_prod'],
        statuses: string[] = ['success'],
        options?: { includeRetried?: boolean }
    ): Promise<any[]> {
        try {
            // Get pipelines updated after 'since'
            const pipelines = await this.fetchAll<any>(`/projects/${projectId}/pipelines`, {
                updated_after: since,
                order_by: 'updated_at',
                sort: 'desc' // Process newest first
            });

            const deployJobs: any[] = [];

            // Process pipelines in batches to avoid rate limiting while improving speed
            const batchSize = 5;
            for (let i = 0; i < pipelines.length; i += batchSize) {
                const batch = pipelines.slice(i, i + batchSize);
                const results = await Promise.allSettled(batch.map(async (pipeline) => {
                    try {
                        const jobs = await this.fetchAll<any>(`/projects/${projectId}/pipelines/${pipeline.id}/jobs`, {
                            include_retried: options?.includeRetried ?? false,
                        });
                        return jobs.filter(
                            (job: any) =>
                                statuses.includes(job.status) &&
                                (stageNames.some(name => job.stage.includes(name) || job.name.includes(name)))
                        );
                    } catch (error) {
                        console.error(`Error fetching jobs for pipeline ${pipeline.id}:`, error);
                        return [];
                    }
                }));

                for (const result of results) {
                    if (result.status === 'fulfilled') {
                        deployJobs.push(...result.value);
                    }
                }
            }

            return deployJobs;
        } catch (error) {
            console.error(`Error fetching pipeline jobs for project ${projectId}:`, error);
            return [];
        }
    }

    async getMergeRequestsMerged(projectId: number, since: string, until?: string): Promise<GitLabMergeRequest[]> {
        return this.fetchAll<GitLabMergeRequest>(`/projects/${projectId}/merge_requests`, {
            state: 'merged',
            updated_after: since,
            updated_before: until,
        });
    }

    async getMergeRequestsCreated(projectId: number, since: string, until?: string): Promise<GitLabMergeRequest[]> {
        return this.fetchAll<GitLabMergeRequest>(`/projects/${projectId}/merge_requests`, {
            state: 'all',
            created_after: since,
            created_before: until,
        });
    }

    async getIssues(projectId: number, labels: string, updatedAfter?: string) {
        return this.fetchAll<any>(`/projects/${projectId}/issues`, {
            labels,
            updated_after: updatedAfter,
        });
    }

    async getMergeRequestsForCommit(projectId: number, commitSha: string): Promise<GitLabMergeRequestForCommit[]> {
        try {
            return await this.fetchJson<GitLabMergeRequestForCommit[]>(
                `/projects/${projectId}/repository/commits/${commitSha}/merge_requests`
            );
        } catch (error) {
            console.error(`Error fetching MRs for commit ${commitSha}:`, error);
            return [];
        }
    }

    async getLastDeployedCommit(projectId: number, environment: string): Promise<string | null> {
        try {
            const deployments = await this.fetchJson<GitLabDeployment[]>(
                `/projects/${projectId}/deployments`,
                {
                    environment,
                    status: 'success',
                    order_by: 'created_at',
                    sort: 'desc',
                    per_page: 2,
                }
            );
            // Return the second most recent (the one before current)
            if (deployments.length >= 2 && deployments[1].deployable?.commit?.id) {
                return deployments[1].deployable.commit.id;
            }
            return null;
        } catch (error) {
            console.error(`Error fetching last deployed commit:`, error);
            return null;
        }
    }

    async getSuccessfulDeploymentCommitHistory(
        projectId: number,
        environment: string,
        limit = 20
    ): Promise<string[]> {
        try {
            const deployments = await this.fetchJson<GitLabDeployment[]>(
                `/projects/${projectId}/deployments`,
                {
                    environment,
                    status: 'success',
                    order_by: 'created_at',
                    sort: 'desc',
                    per_page: limit,
                }
            );

            return deployments
                .map((deployment) => deployment.deployable?.commit?.id)
                .filter((commitId): commitId is string => Boolean(commitId));
        } catch (error) {
            console.error(`Error fetching successful deployment history:`, error);
            return [];
        }
    }

    async getCommitInfo(projectId: number, commitSha: string): Promise<GitLabCommit | null> {
        try {
            return await this.fetchJson<GitLabCommit>(
                `/projects/${projectId}/repository/commits/${commitSha}`
            );
        } catch (error) {
            console.error(`Error fetching commit ${commitSha}:`, error);
            return null;
        }
    }

    async getCompareCommits(projectId: number, fromSha: string, toSha: string): Promise<GitLabCommit[]> {
        try {
            const response = await this.fetchJson<GitLabCompareResponse>(
                `/projects/${projectId}/repository/compare`,
                {
                    from: fromSha,
                    to: toSha,
                    straight: true,
                }
            );
            return response.commits || [];
        } catch (error) {
            console.error(`Error comparing commits ${fromSha}..${toSha}:`, error);
            return [];
        }
    }

    async getMergeRequests(projectId: number, state: 'all' | 'opened' | 'merged' | 'closed' = 'all', updatedAfter?: string): Promise<any[]> {
        const params: any = { state };
        if (updatedAfter) {
            params.updated_after = updatedAfter;
        }
        return this.fetchAll<any>(`/projects/${projectId}/merge_requests`, params);
    }

    async getMergeRequestCommits(projectId: number, mrIid: number): Promise<GitLabCommit[]> {
        try {
            return await this.fetchAll<GitLabCommit>(
                `/projects/${projectId}/merge_requests/${mrIid}/commits`
            );
        } catch (error) {
            console.error(`Error fetching commits for MR ${mrIid}:`, error);
            return [];
        }
    }

    async getMergeRequestNotes(projectId: number, mrIid: number): Promise<any[]> {
        try {
            return await this.fetchAll<any>(
                `/projects/${projectId}/merge_requests/${mrIid}/notes`
            );
        } catch (error) {
            console.error(`Error fetching notes for MR ${mrIid}:`, error);
            return [];
        }
    }

    async listRepoTree(
        projectId: number,
        path: string,
        ref: string,
        recursive?: boolean
    ): Promise<GitLabTreeItem[]> {
        return this.fetchAll<GitLabTreeItem>(`/projects/${projectId}/repository/tree`, {
            path,
            ref,
            recursive: recursive ?? false,
        });
    }

    async createBranch(
        projectId: number,
        branchName: string,
        ref: string
    ): Promise<{ name: string; web_url: string }> {
        const url = `${this.baseUrl}/projects/${projectId}/repository/branches`;
        const response = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ branch: branchName, ref }),
        });
        if (!response.ok) {
            throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
        }
        return response.json() as Promise<{ name: string; web_url: string }>;
    }

    async createFile(
        projectId: number,
        filePath: string,
        branch: string,
        content: string,
        commitMessage: string
    ): Promise<{ file_path: string; branch: string }> {
        const encodedPath = encodeURIComponent(filePath);
        const url = `${this.baseUrl}/projects/${projectId}/repository/files/${encodedPath}`;
        const base64Content = Buffer.from(content).toString('base64');
        const response = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                branch,
                content: base64Content,
                encoding: 'base64',
                commit_message: commitMessage,
            }),
        });
        if (!response.ok) {
            // Include the response body in the error message so downstream
            // classifiers can recognise substrings like "A file with this
            // name already exists" (infra-self-service-hardening Req 3.4).
            const body = await response.text().catch(() => "");
            const suffix = body ? ` - ${body.slice(0, 500)}` : "";
            throw new Error(`GitLab API error: ${response.status} ${response.statusText}${suffix}`);
        }
        return response.json() as Promise<{ file_path: string; branch: string }>;
    }

    async updateFile(
        projectId: number,
        filePath: string,
        branch: string,
        content: string,
        commitMessage: string,
        lastCommitId?: string
    ): Promise<{ file_path: string; branch: string }> {
        const encodedPath = encodeURIComponent(filePath);
        const url = `${this.baseUrl}/projects/${projectId}/repository/files/${encodedPath}`;
        const base64Content = Buffer.from(content).toString('base64');
        const body: Record<string, string> = {
            branch,
            content: base64Content,
            encoding: 'base64',
            commit_message: commitMessage,
        };
        if (lastCommitId) {
            body.last_commit_id = lastCommitId;
        }
        const response = await fetch(url, {
            method: 'PUT',
            headers: this.headers,
            body: JSON.stringify(body),
        });
        if (!response.ok) {
            throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
        }
        return response.json() as Promise<{ file_path: string; branch: string }>;
    }

    async createMR(
        projectId: number,
        sourceBranch: string,
        targetBranch: string,
        title: string,
        description: string
    ): Promise<{ iid: number; web_url: string }> {
        const url = `${this.baseUrl}/projects/${projectId}/merge_requests`;
        const response = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({
                source_branch: sourceBranch,
                target_branch: targetBranch,
                title,
                description,
            }),
        });
        if (!response.ok) {
            throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
        }
        return response.json() as Promise<{ iid: number; web_url: string }>;
    }

    /**
     * Create or update a project-level CI/CD variable. Used by squad infra
     * automation to inject sensitive secret values (TF_VAR_*) without ever
     * storing them in the portal database. Idempotent: if the variable exists
     * it is updated (PUT), otherwise created (POST).
     */
    async upsertCiVariable(
        projectId: number,
        key: string,
        value: string,
        opts: { masked?: boolean; protected?: boolean; raw?: boolean; environmentScope?: string } = {}
    ): Promise<void> {
        const body = {
            key,
            value,
            variable_type: 'env_var',
            masked: opts.masked ?? true,
            protected: opts.protected ?? false,
            raw: opts.raw ?? true,
            environment_scope: opts.environmentScope ?? '*',
        };

        // Check if the variable already exists for this environment scope.
        const scope = encodeURIComponent(opts.environmentScope ?? '*');
        const getUrl = `${this.baseUrl}/projects/${projectId}/variables/${encodeURIComponent(key)}?filter[environment_scope]=${scope}`;
        const existing = await fetch(getUrl, { headers: this.headers });

        if (existing.ok) {
            // Update
            const putUrl = `${this.baseUrl}/projects/${projectId}/variables/${encodeURIComponent(key)}?filter[environment_scope]=${scope}`;
            const res = await fetch(putUrl, {
                method: 'PUT',
                headers: this.headers,
                body: JSON.stringify(body),
            });
            if (!res.ok) {
                throw new Error(`GitLab CI var update error (${key}): ${res.status} ${await res.text()}`);
            }
            return;
        }

        // Create
        const postUrl = `${this.baseUrl}/projects/${projectId}/variables`;
        const res = await fetch(postUrl, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const txt = await res.text();
            // If it raced and already exists, retry as update.
            if (txt.toLowerCase().includes('has already been taken')) {
                const putUrl = `${this.baseUrl}/projects/${projectId}/variables/${encodeURIComponent(key)}?filter[environment_scope]=${scope}`;
                const retry = await fetch(putUrl, { method: 'PUT', headers: this.headers, body: JSON.stringify(body) });
                if (!retry.ok) throw new Error(`GitLab CI var upsert error (${key}): ${retry.status} ${await retry.text()}`);
                return;
            }
            throw new Error(`GitLab CI var create error (${key}): ${res.status} ${txt}`);
        }
    }

    /** Trigger a pipeline on a branch (used after committing squad infra). */
    async triggerPipeline(projectId: number, ref: string): Promise<{ id: number; web_url: string } | null> {
        const url = `${this.baseUrl}/projects/${projectId}/pipeline`;
        const res = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ ref }),
        });
        if (!res.ok) {
            console.error(`GitLab trigger pipeline error: ${res.status} ${await res.text()}`);
            return null;
        }
        return res.json() as Promise<{ id: number; web_url: string }>;
    }
    async listGroups(): Promise<{ id: number; name: string; full_path: string }[]> {
        try {
            const groups = await this.fetchAll<{ id: number; name: string; full_path: string }>(
                '/groups',
                { top_level_only: true }
            );
            return groups.map(({ id, name, full_path }) => ({ id, name, full_path }));
        } catch (error) {
            console.error('Error fetching GitLab groups:', error);
            throw error;
        }
    }

    /** List subgroups of a given group */
    async listSubgroups(groupId: number): Promise<{ id: number; name: string; full_path: string }[]> {
        try {
            const subgroups = await this.fetchAll<{ id: number; name: string; full_path: string }>(
                `/groups/${groupId}/subgroups`,
                {}
            );
            return subgroups.map(({ id, name, full_path }) => ({ id, name, full_path }));
        } catch (error) {
            console.error(`Error fetching subgroups for group ${groupId}:`, error);
            throw error;
        }
    }

    /** List projects within a group (non-recursive) */
    async listGroupProjects(groupId: number): Promise<{ id: number; name: string; path_with_namespace: string }[]> {
        try {
            const projects = await this.fetchAll<{ id: number; name: string; path_with_namespace: string }>(
                `/groups/${groupId}/projects`,
                { include_subgroups: false, archived: false }
            );
            return projects.map(({ id, name, path_with_namespace }) => ({ id, name, path_with_namespace }));
        } catch (error) {
            console.error(`Error fetching projects for group ${groupId}:`, error);
            throw error;
        }
    }

    /** Add a member to a GitLab group with a specific access level.
     *  If the user doesn't exist in GitLab, uses the invite API which
     *  automatically provisions a license/seat for the new user.
     */
    async addGroupMember(groupId: number, email: string, accessLevel: number): Promise<void> {
        // First try direct member addition (works if user already exists)
        const url = `${this.baseUrl}/groups/${groupId}/members`;
        const response = await fetch(url, {
            method: 'POST',
            headers: this.headers,
            body: JSON.stringify({ email, access_level: accessLevel }),
        });

        if (response.ok) return;

        const body = await response.text();

        // Treat "already a member" as success (idempotent)
        if (body.toLowerCase().includes('already a member') || body.toLowerCase().includes('already exists')) {
            return;
        }

        // If user not found, try invite API (provisions license for new users)
        if (response.status === 404 || body.toLowerCase().includes('not found')) {
            const inviteUrl = `${this.baseUrl}/groups/${groupId}/invitations`;
            const inviteResponse = await fetch(inviteUrl, {
                method: 'POST',
                headers: this.headers,
                body: JSON.stringify({ email, access_level: accessLevel }),
            });

            if (inviteResponse.ok) return;

            const inviteBody = await inviteResponse.text();
            if (inviteBody.toLowerCase().includes('already invited') || inviteBody.toLowerCase().includes('already a member')) {
                return;
            }
            throw new Error(`GitLab invite API error: ${inviteResponse.status} - ${inviteBody}`);
        }

        throw new Error(`GitLab API error: ${response.status} ${response.statusText} - ${body}`);
    }

    /** Find a GitLab user by email */
    async findUserByEmail(email: string): Promise<{ id: number; username: string } | null> {
        try {
            const users = await this.fetchJson<{ id: number; username: string }[]>('/users', {
                search: email,
            });
            if (users.length === 0) {
                return null;
            }
            return { id: users[0].id, username: users[0].username };
        } catch (error) {
            console.error(`Error finding GitLab user by email ${email}:`, error);
            throw error;
        }
    }

    /** Block a GitLab user (admin API) */
    async blockUser(userId: number): Promise<void> {
        const url = `${this.baseUrl}/users/${userId}/block`;
        const response = await fetch(url, {
            method: 'POST',
            headers: this.headers,
        });
        if (!response.ok) {
            throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
        }
    }

    /** Delete a GitLab user for license revocation (admin API) */
    async deleteUser(userId: number): Promise<void> {
        const url = `${this.baseUrl}/users/${userId}`;
        const response = await fetch(url, {
            method: 'DELETE',
            headers: this.headers,
        });
        if (!response.ok) {
            throw new Error(`GitLab API error: ${response.status} ${response.statusText}`);
        }
    }
}

export const gitlabClient = new GitLabClient();
