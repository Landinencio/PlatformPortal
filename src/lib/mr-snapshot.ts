import pool from "@/lib/db";
import { gitlabClient } from "@/lib/gitlab";

const SNAPSHOT_GROUP_IDS = (process.env.DORA_SNAPSHOT_GROUP_IDS || "66347331")
  .split(",").map((id) => parseInt(id.trim(), 10)).filter((id) => id > 0);

interface MRNote {
  id: number;
  body: string;
  author: {
    username: string;
    name: string;
    avatar_url: string;
  };
  created_at: string;
  system: boolean;
}

export async function generateMrAnalyticsSnapshot(snapshotDate: string) {
  console.log(`Starting MR Analytics snapshot for ${snapshotDate}...`);

  const allProjects: any[] = [];
  for (const groupId of SNAPSHOT_GROUP_IDS) {
    const groupProjects = await gitlabClient.getProjects(groupId);
    console.log(`Fetched ${groupProjects.length} projects from group ${groupId}`);
    allProjects.push(...groupProjects);
  }
  // Deduplicate by project ID
  const projectMap = new Map(allProjects.map((p) => [p.id, p]));
  const projects = [...projectMap.values()];
  console.log(`Found ${projects.length} unique projects across ${SNAPSHOT_GROUP_IDS.length} group(s)`);

  let processedMRs = 0;
  const errors: string[] = [];

  for (const project of projects) {
    try {
      const pathParts = project.path_with_namespace.split("/");
      const team = pathParts.length >= 3 ? pathParts[2] : pathParts[1] || pathParts[0];

      const ninetyDaysAgo = new Date();
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const allMRs = await gitlabClient.getMergeRequests(project.id, "all", ninetyDaysAgo.toISOString().split("T")[0]);

      console.log(`Project ${project.name}: ${allMRs.length} MRs to process`);

      for (const mr of allMRs) {
        try {
          const commits = await gitlabClient.getMergeRequestCommits(project.id, mr.iid);
          const notes = await gitlabClient.getMergeRequestNotes(project.id, mr.iid);
          const metrics = calculateMRMetrics(mr, notes, commits.length);

          await upsertMRAnalytics(snapshotDate, project, team, mr, metrics);
          processedMRs++;
        } catch (mrError) {
          console.error(`Error processing MR ${mr.iid} in ${project.name}:`, mrError);
          errors.push(`${project.name} MR#${mr.iid}: ${mrError instanceof Error ? mrError.message : "Unknown error"}`);
        }
      }
    } catch (projectError) {
      console.error(`Error processing project ${project.name}:`, projectError);
      errors.push(`${project.name}: ${projectError instanceof Error ? projectError.message : "Unknown error"}`);
    }
  }

  console.log(`MR Analytics snapshot completed. Processed ${processedMRs} MRs.`);

  return {
    success: true,
    snapshotDate,
    projectsProcessed: projects.length,
    mrsProcessed: processedMRs,
    errors: errors.length > 0 ? errors : undefined,
  };
}

function calculateMRMetrics(mr: any, notes: MRNote[], commitCount: number) {
  const createdAt = new Date(mr.created_at);
  const mergedAt = mr.merged_at ? new Date(mr.merged_at) : null;
  const now = new Date();

  const humanNotes = notes
    .filter((note) => !note.system && note.author.username !== mr.author?.username)
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

  const firstCommentAt = humanNotes.length > 0 ? new Date(humanNotes[0].created_at) : null;
  const endDate = mergedAt || (mr.state === "opened" ? now : null);

  // Lifetime: created_at → merged_at (or now if open)
  const lifetimeHours = endDate ? differenceInHours(endDate, createdAt) : 0;

  // Lead time: created_at → merged_at (time from opening to merge)
  // This is the MR-level lead time, not the commit-to-deploy lead time
  const leadTimeHours = mergedAt ? differenceInHours(mergedAt, createdAt) : lifetimeHours;

  // Review time: first_comment → merged_at (time spent in review)
  let reviewTimeHours = 0;
  if (firstCommentAt) {
    const reviewEndDate = mergedAt || (mr.state === "opened" ? now : null);
    reviewTimeHours = reviewEndDate ? Math.max(0, differenceInHours(reviewEndDate, firstCommentAt)) : 0;
  }

  // changes_count: GitLab returns this directly on the MR object
  // It represents the number of files changed (not lines)
  const changesCount = typeof mr.changes_count === "number"
    ? mr.changes_count
    : typeof mr.changes_count === "string"
      ? parseInt(mr.changes_count, 10) || 0
      : 0;

  const reviewers = new Map<string, { name: string; username: string; avatar_url: string; comments: number }>();
  humanNotes.forEach((note) => {
    const existing = reviewers.get(note.author.username);
    if (existing) {
      existing.comments++;
      return;
    }

    reviewers.set(note.author.username, {
      name: note.author.name,
      username: note.author.username,
      avatar_url: note.author.avatar_url,
      comments: 1,
    });
  });

  return {
    lifetimeHours,
    leadTimeHours,
    reviewTimeHours,
    firstCommentAt,
    commitCount,
    changesCount,
    reviewCount: humanNotes.length,
    reviewerCount: reviewers.size,
    reviewers: Array.from(reviewers.values()),
  };
}

function differenceInHours(later: Date, earlier: Date) {
  return Math.max(0, Math.floor((later.getTime() - earlier.getTime()) / (1000 * 60 * 60)));
}

async function upsertMRAnalytics(
  snapshotDate: string,
  project: any,
  team: string,
  mr: any,
  metrics: any
) {
  const query = `
    INSERT INTO gitlab_mr_analytics (
      snapshot_date,
      project_id,
      project_name,
      team,
      mr_id,
      mr_iid,
      title,
      state,
      web_url,
      author_name,
      author_username,
      author_email,
      author_avatar_url,
      created_at,
      merged_at,
      updated_at,
      first_comment_at,
      lifetime_hours,
      lead_time_hours,
      review_time_hours,
      commit_count,
      changes_count,
      review_count,
      reviewer_count,
      reviewers,
      labels,
      source_branch,
      target_branch
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
      $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
      $21, $22, $23, $24, $25, $26, $27, $28
    )
    ON CONFLICT (snapshot_date, project_id, mr_iid)
    DO UPDATE SET
      title = EXCLUDED.title,
      state = EXCLUDED.state,
      updated_at = EXCLUDED.updated_at,
      merged_at = EXCLUDED.merged_at,
      first_comment_at = EXCLUDED.first_comment_at,
      lifetime_hours = EXCLUDED.lifetime_hours,
      lead_time_hours = EXCLUDED.lead_time_hours,
      review_time_hours = EXCLUDED.review_time_hours,
      commit_count = EXCLUDED.commit_count,
      changes_count = EXCLUDED.changes_count,
      review_count = EXCLUDED.review_count,
      reviewer_count = EXCLUDED.reviewer_count,
      reviewers = EXCLUDED.reviewers,
      labels = EXCLUDED.labels,
      calculated_at = NOW()
  `;

  await pool.query(query, [
    snapshotDate,
    project.id,
    project.name,
    team,
    mr.id,
    mr.iid,
    mr.title,
    mr.state,
    mr.web_url,
    mr.author?.name || "Unknown",
    mr.author?.username || "unknown",
    mr.author?.email || null,
    mr.author?.avatar_url || null,
    mr.created_at,
    mr.merged_at,
    mr.updated_at,
    metrics.firstCommentAt,
    metrics.lifetimeHours,
    metrics.leadTimeHours,
    metrics.reviewTimeHours,
    metrics.commitCount,
    metrics.changesCount,
    metrics.reviewCount,
    metrics.reviewerCount,
    JSON.stringify(metrics.reviewers),
    mr.labels || [],
    mr.source_branch,
    mr.target_branch,
  ]);
}
