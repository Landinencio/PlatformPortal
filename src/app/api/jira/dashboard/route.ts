import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { jiraSearchJql, jiraGetProjects, jiraGetServiceDesks, jiraGetQueues, compactIssue, type JiraIssueCompact } from "@/lib/jira";
import { differenceInBusinessDays, parseISO } from "date-fns";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: "Auth required" }, { status: 401 });
    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "staff")) return NextResponse.json({ error: "Editor required" }, { status: 403 });

    const { searchParams } = new URL(request.url);
    const projectKeys = searchParams.get("projects")?.split(",").filter(Boolean) || [];
    const days = Math.min(365, Math.max(7, parseInt(searchParams.get("days") || "90", 10)));

    // Fetch projects list
    const allProjects = await jiraGetProjects();
    const projectOptions = allProjects
      .filter((p: any) => ["software", "service_desk"].includes(p.projectTypeKey))
      .map((p: any) => ({ key: p.key, name: p.name, type: p.projectTypeKey }))
      .sort((a: any, b: any) => a.name.localeCompare(b.name));

    // If no projects selected, return just the project list
    if (projectKeys.length === 0) {
      return NextResponse.json({ projects: projectOptions, data: null });
    }

    const projectFilter = projectKeys.map((k) => `"${k}"`).join(", ");
    const jqlBase = `project IN (${projectFilter})`;

    // Fetch issues created in the window
    const recentJql = `${jqlBase} AND created >= -${days}d ORDER BY created DESC`;
    const allIssues: JiraIssueCompact[] = [];
    let pageToken: string | undefined;
    while (true) {
      const batch = await jiraSearchJql(recentJql, undefined, 100, pageToken);
      allIssues.push(...batch.issues.map(compactIssue));
      if (!batch.nextPageToken || batch.issues.length < 100) break;
      pageToken = batch.nextPageToken;
      if (allIssues.length > 2000) break; // safety cap
    }

    // Fetch open/unresolved issues (regardless of creation date)
    const openJql = `${jqlBase} AND resolution = Unresolved ORDER BY priority DESC, created ASC`;
    const openResult = await jiraSearchJql(openJql, undefined, 100);
    const openIssues = openResult.issues.map(compactIssue);

    // Compute stats
    const now = new Date();
    const resolved = allIssues.filter((i) => i.resolved);
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    const byPriority: Record<string, number> = {};
    const byAssignee: Record<string, { total: number; resolved: number; open: number }> = {};
    const weeklyCreated: Record<string, number> = {};
    const weeklyResolved: Record<string, number> = {};

    for (const issue of allIssues) {
      byStatus[issue.status] = (byStatus[issue.status] || 0) + 1;
      byType[issue.type] = (byType[issue.type] || 0) + 1;
      byPriority[issue.priority] = (byPriority[issue.priority] || 0) + 1;

      const assignee = issue.assignee || "Unassigned";
      if (!byAssignee[assignee]) byAssignee[assignee] = { total: 0, resolved: 0, open: 0 };
      byAssignee[assignee].total++;
      if (issue.resolved) byAssignee[assignee].resolved++;
      else byAssignee[assignee].open++;

      // Weekly buckets
      const weekKey = issue.created.slice(0, 7); // YYYY-MM
      weeklyCreated[weekKey] = (weeklyCreated[weekKey] || 0) + 1;
      if (issue.resolved) {
        const rWeek = issue.resolved.slice(0, 7);
        weeklyResolved[rWeek] = (weeklyResolved[rWeek] || 0) + 1;
      }
    }

    // Cycle time for resolved issues (created → resolved in business days)
    const cycleTimes = resolved
      .filter((i) => i.resolved && i.created)
      .map((i) => {
        try {
          return differenceInBusinessDays(parseISO(i.resolved!), parseISO(i.created));
        } catch {
          return null;
        }
      })
      .filter((d): d is number => d !== null && d >= 0)
      .sort((a, b) => a - b);

    const medianCycleTime = cycleTimes.length > 0 ? cycleTimes[Math.floor(cycleTimes.length / 2)] : null;
    const avgCycleTime = cycleTimes.length > 0 ? Math.round(cycleTimes.reduce((a, b) => a + b, 0) / cycleTimes.length) : null;

    // Aging of open issues
    const aging = openIssues.map((i) => {
      try {
        return differenceInBusinessDays(now, parseISO(i.created));
      } catch {
        return 0;
      }
    });
    const agingOver7 = aging.filter((d) => d > 7).length;
    const agingOver14 = aging.filter((d) => d > 14).length;
    const agingOver30 = aging.filter((d) => d > 30).length;

    // Monthly trend
    const months = Object.keys({ ...weeklyCreated, ...weeklyResolved }).sort();
    const trend = months.map((m) => ({
      month: m,
      created: weeklyCreated[m] || 0,
      resolved: weeklyResolved[m] || 0,
    }));

    // Assignee ranking
    const assigneeRanking = Object.entries(byAssignee)
      .map(([name, stats]) => ({ name, ...stats }))
      .sort((a, b) => b.total - a.total);

    // Service desk queues
    let queues: any[] = [];
    try {
      const desks = await jiraGetServiceDesks();
      const relevantDesks = desks.filter((d: any) => projectKeys.includes(d.projectKey));
      for (const desk of relevantDesks) {
        const deskQueues = await jiraGetQueues(desk.id);
        queues.push(...deskQueues.map((q: any) => ({
          id: q.id,
          name: q.name,
          projectKey: desk.projectKey,
          projectName: desk.projectName,
          issueCount: q.issueCount,
        })));
      }
    } catch (e) {
      // Service desk API may not be available for all projects
    }

    return NextResponse.json({
      projects: projectOptions,
      data: {
        summary: {
          totalIssues: allIssues.length,
          openIssues: openIssues.length,
          resolvedIssues: resolved.length,
          medianCycleTimeDays: medianCycleTime,
          avgCycleTimeDays: avgCycleTime,
          aging: { over7: agingOver7, over14: agingOver14, over30: agingOver30 },
        },
        byStatus: Object.entries(byStatus).map(([status, count]) => ({ status, count })).sort((a, b) => b.count - a.count),
        byType: Object.entries(byType).map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
        byPriority: Object.entries(byPriority).map(([priority, count]) => ({ priority, count })).sort((a, b) => b.count - a.count),
        assigneeRanking: assigneeRanking.slice(0, 20),
        trend,
        recentIssues: allIssues.slice(0, 20),
        openIssues: openIssues.slice(0, 30),
        queues,
        days,
        projectKeys,
      },
    });
  } catch (error) {
    console.error("Jira dashboard error:", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Jira API error" }, { status: 500 });
  }
}
