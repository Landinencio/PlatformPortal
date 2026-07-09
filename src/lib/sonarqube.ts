// SonarQube API client
import { parsePositiveEnvInt } from "@/lib/metrics-formulas";

const SONARQUBE_API_BASE = process.env.SONARQUBE_URL || 'http://sonarqube-sonarqube.sonarqube.svc.cluster.local:9000/api';
const SONARQUBE_TOKEN = process.env.SONARQUBE_TOKEN || '';
const SONAR_FETCH_TIMEOUT_MS = 15_000; // 15s per request

/** Máximo de páginas a iterar en getAllProjects.
 * Configurable via SONAR_MAX_PAGES. Default: 50 (= 5000 proyectos con pageSize=100). */
export const MAX_SONAR_PAGES: number =
  parsePositiveEnvInt("SONAR_MAX_PAGES") ?? 50;

export interface SonarQubeMetrics {
    coverage: number;
    bugs: number;
    vulnerabilities: number;
    code_smells: number;
    tech_debt_minutes: number;
    security_hotspots: number;
    duplicated_lines_density: number;
}

class SonarQubeClient {
    private headers: HeadersInit;

    constructor() {
        const auth = Buffer.from(`${SONARQUBE_TOKEN}:`).toString('base64');
        this.headers = {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
        };
    }

    private async fetchWithTimeout(url: string, timeoutMs = SONAR_FETCH_TIMEOUT_MS): Promise<Response> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            return await fetch(url, { headers: this.headers, signal: controller.signal });
        } finally {
            clearTimeout(timer);
        }
    }

    async getProjectMetrics(projectKey: string): Promise<SonarQubeMetrics | null> {
        const metrics = 'coverage,bugs,vulnerabilities,code_smells,sqale_index,security_hotspots,duplicated_lines_density';
        const url = `${SONARQUBE_API_BASE}/measures/component?component=${projectKey}&metricKeys=${metrics}`;

        const response = await this.fetchWithTimeout(url);

        if (!response.ok) {
            if (response.status === 404) {
                return null;
            }
            const errorText = await response.text();
            console.error(`SonarQube API error for ${projectKey} (Status: ${response.status}): ${errorText.substring(0, 200)}`);
            return {
                coverage: 0,
                bugs: 0,
                vulnerabilities: 0,
                code_smells: 0,
                tech_debt_minutes: 0,
                security_hotspots: 0,
                duplicated_lines_density: 0,
            };
        }

        const data = await response.json();
        const measures = data.component?.measures || [];

        return {
            coverage: this.extractMetric(measures, 'coverage'),
            bugs: this.extractMetric(measures, 'bugs'),
            vulnerabilities: this.extractMetric(measures, 'vulnerabilities'),
            code_smells: this.extractMetric(measures, 'code_smells'),
            tech_debt_minutes: this.extractMetric(measures, 'sqale_index'),
            security_hotspots: this.extractMetric(measures, 'security_hotspots'),
            duplicated_lines_density: this.extractMetric(measures, 'duplicated_lines_density'),
        };
    }

    private extractMetric(measures: any[], key: string): number {
        const measure = measures.find((m) => m.metric === key);
        return measure ? parseFloat(measure.value) : 0;
    }

    async searchProject(query: string): Promise<string | null> {
        const url = `${SONARQUBE_API_BASE}/components/search?qualifiers=TRK&q=${encodeURIComponent(query)}`;

        try {
            const response = await this.fetchWithTimeout(url);
            if (!response.ok) return null;

            const data = await response.json();
            const components = data.components || [];

            if (components.length > 0) {
                return components[0].key;
            }
            return null;
        } catch (error) {
            console.error(`Error searching SonarQube project ${query}:`, error);
            return null;
        }
    }

    async searchProjects(query: string, page = 1, pageSize = 50): Promise<SonarQubeProject[]> {
        const url = `${SONARQUBE_API_BASE}/components/search?qualifiers=TRK&q=${encodeURIComponent(query)}&p=${page}&ps=${pageSize}`;

        try {
            const response = await this.fetchWithTimeout(url);
            if (!response.ok) return [];

            const data = await response.json();
            return (data.components || []).map((c: any) => ({
                key: c.key,
                name: c.name,
                qualifier: c.qualifier,
            }));
        } catch (error) {
            console.error(`Error searching SonarQube projects:`, error);
            return [];
        }
    }

    async getAllProjects(): Promise<SonarQubeProject[]> {
        const allProjects: SonarQubeProject[] = [];
        let page = 1;
        const pageSize = 100;

        while (true) {
            if (page > MAX_SONAR_PAGES) {
                console.warn(
                    `[SonarQube] Reached maximum page limit (${MAX_SONAR_PAGES}). ` +
                    `Some projects may not have been retrieved. ` +
                    `Total fetched so far: ${allProjects.length}. ` +
                    `Increase SONAR_MAX_PAGES env var if needed.`
                );
                break;
            }

            const url = `${SONARQUBE_API_BASE}/components/search?qualifiers=TRK&p=${page}&ps=${pageSize}`;

            try {
                const response = await this.fetchWithTimeout(url);
                if (!response.ok) break;

                const data = await response.json();
                const components = data.components || [];

                if (components.length === 0) break;

                allProjects.push(...components.map((c: any) => ({
                    key: c.key,
                    name: c.name,
                    qualifier: c.qualifier,
                })));

                if (components.length < pageSize) break;
                page++;
            } catch (error) {
                console.error(`Error fetching all SonarQube projects (page ${page}):`, error);
                break;
            }
        }

        console.log(`[SonarQube] getAllProjects completed: ${allProjects.length} projects fetched in ${page > MAX_SONAR_PAGES ? MAX_SONAR_PAGES : page} pages.`);
        return allProjects;
    }

    async getQualityGateStatus(projectKey: string): Promise<string | null> {
        const url = `${SONARQUBE_API_BASE}/qualitygates/project_status?projectKey=${encodeURIComponent(projectKey)}`;

        try {
            const response = await this.fetchWithTimeout(url);
            if (!response.ok) return null;

            const data = await response.json();
            return data.projectStatus?.status || null;
        } catch (error) {
            console.error(`Error fetching quality gate for ${projectKey}:`, error);
            return null;
        }
    }
}

export interface SonarQubeProject {
    key: string;
    name: string;
    qualifier: string;
    properties?: Record<string, string>;
}

/** Estrategias de auto-mapeo SonarQube → GitLab */
export type MappingStrategy = "exact-name" | "normalized-path" | "gitlab-project-id";

export interface MappingResult {
    sonarKey: string;
    gitlabProjectId: number | null;
    gitlabProjectPath: string | null;
    strategy: MappingStrategy | null;
    suggestions: Array<{ projectId: number; path: string; similarity: number }>;
}

/**
 * Calcula el porcentaje de cobertura de mapeo.
 * Para N proyectos con M mapeados, retorna exactamente (M/N)*100.
 * Retorna 0 si total es 0.
 */
export function calculateMappingCoveragePct(total: number, mapped: number): number {
    if (total <= 0) return 0;
    return (mapped / total) * 100;
}

/**
 * Normaliza un nombre/path para comparación:
 * - Convierte a minúsculas
 * - Reemplaza separadores comunes (_, -, ., /) por un separador uniforme
 * - Elimina prefijos comunes de organización (e.g., "org/")
 */
function normalizeName(name: string): string {
    return name
        .toLowerCase()
        .replace(/[_\-./\\]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * Calcula la similitud entre dos strings usando coeficiente de Sørensen-Dice
 * basado en bigramas. Retorna un valor entre 0 y 1.
 */
function calculateSimilarity(a: string, b: string): number {
    const normA = normalizeName(a);
    const normB = normalizeName(b);

    if (normA === normB) return 1;
    if (normA.length < 2 || normB.length < 2) return 0;

    const bigramsA = new Set<string>();
    for (let i = 0; i < normA.length - 1; i++) {
        bigramsA.add(normA.substring(i, i + 2));
    }

    const bigramsB = new Set<string>();
    for (let i = 0; i < normB.length - 1; i++) {
        bigramsB.add(normB.substring(i, i + 2));
    }

    let intersection = 0;
    for (const bigram of bigramsA) {
        if (bigramsB.has(bigram)) intersection++;
    }

    return (2 * intersection) / (bigramsA.size + bigramsB.size);
}

/**
 * Intenta auto-mapear un proyecto SonarQube a GitLab usando múltiples estrategias:
 * 1. exact-name: coincidencia exacta de nombre (case-insensitive)
 * 2. normalized-path: coincidencia por path normalizado (key del proyecto SonarQube vs path de GitLab)
 * 3. gitlab-project-id: coincidencia por propiedad `gitlab_project_id` en el proyecto SonarQube
 *
 * Si no hay match exacto, genera sugerencias por similitud de nombre.
 */
export function autoMapSonarProject(
    sonarProject: { key: string; name: string; properties?: Record<string, string> },
    gitlabProjects: Array<{ id: number; path: string; name: string }>
): MappingResult {
    const result: MappingResult = {
        sonarKey: sonarProject.key,
        gitlabProjectId: null,
        gitlabProjectPath: null,
        strategy: null,
        suggestions: [],
    };

    // Strategy 1: exact-name (case-insensitive)
    const exactMatch = gitlabProjects.find(
        (gp) => gp.name.toLowerCase() === sonarProject.name.toLowerCase()
    );
    if (exactMatch) {
        result.gitlabProjectId = exactMatch.id;
        result.gitlabProjectPath = exactMatch.path;
        result.strategy = "exact-name";
        return result;
    }

    // Strategy 2: normalized-path
    const normalizedSonarKey = normalizeName(sonarProject.key);
    const pathMatch = gitlabProjects.find(
        (gp) => normalizeName(gp.path) === normalizedSonarKey
    );
    if (pathMatch) {
        result.gitlabProjectId = pathMatch.id;
        result.gitlabProjectPath = pathMatch.path;
        result.strategy = "normalized-path";
        return result;
    }

    // Strategy 3: gitlab-project-id from SonarQube project properties
    const gitlabIdProp = sonarProject.properties?.["gitlab_project_id"] ??
        sonarProject.properties?.["sonar.gitlab.project_id"];
    if (gitlabIdProp) {
        const gitlabId = parseInt(gitlabIdProp, 10);
        if (Number.isFinite(gitlabId)) {
            const idMatch = gitlabProjects.find((gp) => gp.id === gitlabId);
            if (idMatch) {
                result.gitlabProjectId = idMatch.id;
                result.gitlabProjectPath = idMatch.path;
                result.strategy = "gitlab-project-id";
                return result;
            }
        }
    }

    // No match found — generate suggestions by similarity
    const SUGGESTION_THRESHOLD = 0.3;
    const MAX_SUGGESTIONS = 3;

    const similarities = gitlabProjects
        .map((gp) => ({
            projectId: gp.id,
            path: gp.path,
            similarity: Math.max(
                calculateSimilarity(sonarProject.name, gp.name),
                calculateSimilarity(sonarProject.key, gp.path)
            ),
        }))
        .filter((s) => s.similarity >= SUGGESTION_THRESHOLD)
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, MAX_SUGGESTIONS);

    result.suggestions = similarities;

    // Log unmapped project with reason
    const reason = gitlabProjects.length === 0
        ? "no GitLab projects available"
        : similarities.length > 0
            ? `no exact match; best suggestion: ${similarities[0].path} (similarity: ${(similarities[0].similarity * 100).toFixed(1)}%)`
            : "no match found and no similar projects";

    console.warn(
        `[SonarQube] Project "${sonarProject.key}" could not be auto-mapped: ${reason}`
    );

    return result;
}

export const sonarQubeClient = new SonarQubeClient();
