import pool from "@/lib/db";
import { createSonarGitLabResolver } from "@/lib/sonarqube-mapping";
import { sonarQubeClient } from "@/lib/sonarqube";

export async function generateSonarSnapshot(snapshotDate: string) {
  console.log(`Starting SonarQube metrics snapshot for ${snapshotDate}...`);

  const projects = await sonarQubeClient.getAllProjects();
  const gitlabResolver = await createSonarGitLabResolver();
  console.log(`Found ${projects.length} projects in SonarQube`);

  let processedProjects = 0;
  const errors: string[] = [];
  const mappingStats = {
    manual: 0,
    auto: 0,
    autoPersisted: 0,
    unmapped: 0,
    external: 0,
    pendingReview: 0,
  };

  const BATCH_SIZE = 5;
  for (let i = 0; i < projects.length; i += BATCH_SIZE) {
    const batch = projects.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (project) => {
        const metrics = await sonarQubeClient.getProjectMetrics(project.key);
        if (!metrics) return null;

        const qualityGate = await sonarQubeClient.getQualityGateStatus(project.key);
        const mapping = gitlabResolver.resolveProject(project);

        return { project, metrics, qualityGate, mapping };
      })
    );

    for (const result of results) {
      if (result.status === "rejected") {
        errors.push(`Batch error: ${result.reason}`);
        continue;
      }
      if (!result.value) continue;

      const { project, metrics, qualityGate, mapping } = result.value;

      try {
        if (mapping.source === "manual") {
          mappingStats.manual++;
        } else if (mapping.source === "auto") {
          mappingStats.auto++;
          const persisted = await gitlabResolver.persistAutoMapping(mapping);
          if (persisted) {
            mappingStats.autoPersisted++;
          }
        } else {
          mappingStats.unmapped++;
          if (mapping.reason === "non_digital_namespace") {
            mappingStats.external++;
          } else {
            mappingStats.pendingReview++;
          }
        }

        await pool.query(
        `INSERT INTO sonarqube_metrics_daily (
            snapshot_date, sonar_project_key, sonar_project_name,
            gitlab_project_id, gitlab_project_path,
            coverage, bugs, vulnerabilities, code_smells, tech_debt_minutes,
            security_hotspots, duplicated_lines_density, quality_gate_status
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
        ON CONFLICT (snapshot_date, sonar_project_key) DO UPDATE SET
            sonar_project_name = EXCLUDED.sonar_project_name,
            gitlab_project_id = EXCLUDED.gitlab_project_id,
            gitlab_project_path = EXCLUDED.gitlab_project_path,
            coverage = EXCLUDED.coverage,
            bugs = EXCLUDED.bugs,
            vulnerabilities = EXCLUDED.vulnerabilities,
            code_smells = EXCLUDED.code_smells,
            tech_debt_minutes = EXCLUDED.tech_debt_minutes,
            security_hotspots = EXCLUDED.security_hotspots,
            duplicated_lines_density = EXCLUDED.duplicated_lines_density,
            quality_gate_status = EXCLUDED.quality_gate_status,
            calculated_at = NOW()`,
        [
          snapshotDate,
          project.key,
          project.name,
          mapping.gitlabProjectId,
          mapping.gitlabProjectPath,
          metrics.coverage,
          metrics.bugs,
          metrics.vulnerabilities,
          metrics.code_smells,
          metrics.tech_debt_minutes,
          metrics.security_hotspots,
          metrics.duplicated_lines_density,
          qualityGate,
        ]
      );

      processedProjects++;
      } catch (projectError) {
        errors.push(`Error processing ${project.key}: ${projectError}`);
      }
    }
  }

  console.log(`SonarQube snapshot complete: ${processedProjects}/${projects.length}`);
  console.log(
    `Sonar/GitLab mapping: manual=${mappingStats.manual}, auto=${mappingStats.auto}, persisted=${mappingStats.autoPersisted}, unmapped=${mappingStats.unmapped}, external=${mappingStats.external}, pendingReview=${mappingStats.pendingReview}`
  );

  return {
    success: true,
    projectsProcessed: processedProjects,
    totalProjects: projects.length,
    mapping: mappingStats,
    errors: errors.length > 0 ? errors : undefined,
    date: snapshotDate,
  };
}
