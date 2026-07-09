import { z } from "zod";
import type {
  CyberInactiveUser,
  CyberMfaGap,
  CyberReportType,
  CyberRunSummary,
  CyberVpnGroup,
  CyberVpnMember,
  CybersecurityDashboardResponse,
  CybersecurityReportResponse,
} from "@/lib/cybersecurity";

const reportTypeSchema = z.enum(["vpn_groups", "inactive_users_90d", "users_without_mfa_group"]);

const liveBaseSchema = z.object({
  source: z.string().default("azure_ad_live"),
  reportType: reportTypeSchema,
  status: z.enum(["completed", "partial", "failed"]).default("completed"),
  schemaVersion: z.string().default("1"),
  generatedAt: z.string(),
  meta: z.record(z.any()).default({}),
  summary: z.record(z.any()).default({}),
});

const inactiveRecordSchema = z.object({
  id: z.string().nullable().optional(),
  displayName: z.string().optional().nullable(),
  mail: z.string().optional().nullable(),
  userPrincipalName: z.string(),
  department: z.string().optional().nullable(),
  company: z.string().optional().nullable(),
  createdDate: z.string().nullable().optional(),
  lastLogin: z.string().nullable().optional(),
  lastNonInteractiveLogin: z.string().nullable().optional(),
  daysInactive: z.number().nullable().optional(),
  neverLoggedIn: z.boolean().default(false),
});

const mfaRecordSchema = z.object({
  id: z.string().nullable().optional(),
  displayName: z.string().optional().nullable(),
  mail: z.string().optional().nullable(),
  upn: z.string(),
  department: z.string().optional().nullable(),
  jobTitle: z.string().optional().nullable(),
  company: z.string().optional().nullable(),
  created: z.string().nullable().optional(),
  lastLogin: z.string().nullable().optional(),
  lastNonInteractive: z.string().nullable().optional(),
  days: z.number().nullable().optional(),
  neverLoggedIn: z.boolean().default(false),
});

const vpnMemberSchema = z.object({
  id: z.string().nullable().optional(),
  displayName: z.string().optional().nullable(),
  mail: z.string().optional().nullable(),
  userPrincipalName: z.string(),
  department: z.string().optional().nullable(),
  createdDate: z.string().nullable().optional(),
  lastLogin: z.string().nullable().optional(),
  lastNonInteractiveLogin: z.string().nullable().optional(),
  neverLoggedIn: z.boolean().default(false),
});

const vpnGroupSchema = z.object({
  groupId: z.string(),
  groupName: z.string(),
  description: z.string().optional().nullable(),
  memberCount: z.number().default(0),
  members: z.array(vpnMemberSchema).default([]),
});

const inactivePayloadSchema = liveBaseSchema.extend({
  reportType: z.literal("inactive_users_90d"),
  records: z.array(inactiveRecordSchema),
});

const mfaPayloadSchema = liveBaseSchema.extend({
  reportType: z.literal("users_without_mfa_group"),
  records: z.array(mfaRecordSchema),
});

const vpnPayloadSchema = liveBaseSchema.extend({
  reportType: z.literal("vpn_groups"),
  records: z.array(vpnGroupSchema),
});

function resolveN8nBaseUrl() {
  return process.env.CYBERSECURITY_N8N_BASE_URL || "http://n8n-webhooks.n8n.svc.cluster.local:3000";
}

function getWebhookPath(reportType: CyberReportType) {
  switch (reportType) {
    case "inactive_users_90d":
      return "/webhook/azure-inactive-users-portal";
    case "users_without_mfa_group":
      return "/webhook/azure-mfa-check-portal";
    case "vpn_groups":
      return "/webhook/azure-vpn-groups-report-portal";
  }
}

async function callWorkflow(reportType: CyberReportType): Promise<unknown> {
  const baseUrl = resolveN8nBaseUrl().replace(/\/$/, "");
  const response = await fetch(`${baseUrl}${getWebhookPath(reportType)}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    cache: "no-store",
    body: JSON.stringify({ source: "platform_portal" }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`n8n returned ${response.status}${body ? `: ${body}` : ""}`);
  }

  return response.json();
}

function buildRunSummary(
  source: string,
  reportType: CyberReportType,
  status: "completed" | "partial" | "failed",
  schemaVersion: string,
  generatedAt: string,
  summary: Record<string, unknown>,
  meta: Record<string, unknown>,
  recordsCount: number
): CyberRunSummary {
  const parsed = new Date(generatedAt);
  const iso = Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
  const runId = Math.abs(Math.floor(parsed.getTime() / 1000)) || Math.floor(Date.now() / 1000);

  return {
    runId,
    source,
    reportType,
    status,
    schemaVersion,
    sourceRunId: null,
    generatedAt: iso,
    ingestedAt: iso,
    recordsCount,
    summary,
    meta,
  };
}

function toIsoOrNull(value?: string | null) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export async function getCybersecurityLiveReport(
  reportType: CyberReportType
): Promise<CybersecurityReportResponse> {
  const payload = await callWorkflow(reportType);

  if (reportType === "inactive_users_90d") {
    const parsed = inactivePayloadSchema.parse(payload);
    const run = buildRunSummary(
      parsed.source,
      parsed.reportType,
      parsed.status,
      parsed.schemaVersion,
      parsed.generatedAt,
      parsed.summary,
      parsed.meta,
      parsed.records.length
    );

    const items: CyberInactiveUser[] = parsed.records.map((row) => ({
      userId: row.id || null,
      displayName: row.displayName || null,
      mail: row.mail || null,
      userPrincipalName: row.userPrincipalName,
      department: row.department || null,
      company: row.company || null,
      createdAt: toIsoOrNull(row.createdDate),
      lastLoginAt: toIsoOrNull(row.lastLogin),
      lastNonInteractiveAt: toIsoOrNull(row.lastNonInteractiveLogin),
      daysInactive: row.daysInactive ?? null,
      neverLoggedIn: row.neverLoggedIn,
    }));

    return {
      kind: "inactive_users",
      reportType,
      run,
      items,
    };
  }

  if (reportType === "users_without_mfa_group") {
    const parsed = mfaPayloadSchema.parse(payload);
    const run = buildRunSummary(
      parsed.source,
      parsed.reportType,
      parsed.status,
      parsed.schemaVersion,
      parsed.generatedAt,
      parsed.summary,
      parsed.meta,
      parsed.records.length
    );

    const items: CyberMfaGap[] = parsed.records.map((row) => ({
      userId: row.id || null,
      displayName: row.displayName || null,
      mail: row.mail || null,
      userPrincipalName: row.upn,
      department: row.department || null,
      jobTitle: row.jobTitle || null,
      company: row.company || null,
      createdAt: toIsoOrNull(row.created),
      lastLoginAt: toIsoOrNull(row.lastLogin),
      lastNonInteractiveAt: toIsoOrNull(row.lastNonInteractive),
      daysSinceLogin: row.days ?? null,
      neverLoggedIn: row.neverLoggedIn,
    }));

    return {
      kind: "mfa_gaps",
      reportType,
      run,
      items,
    };
  }

  const parsed = vpnPayloadSchema.parse(payload);
  const run = buildRunSummary(
    parsed.source,
    parsed.reportType,
    parsed.status,
    parsed.schemaVersion,
    parsed.generatedAt,
    parsed.summary,
    parsed.meta,
    parsed.records.length
  );

  const groups: CyberVpnGroup[] = parsed.records.map((group) => ({
    groupId: group.groupId,
    groupName: group.groupName,
    description: group.description || null,
    memberCount: group.memberCount,
    members: group.members.map((member) => ({
      groupId: group.groupId,
      userId: member.id || null,
      displayName: member.displayName || null,
      mail: member.mail || null,
      userPrincipalName: member.userPrincipalName,
      department: member.department || null,
      createdAt: toIsoOrNull(member.createdDate),
      lastLoginAt: toIsoOrNull(member.lastLogin),
      lastNonInteractiveAt: toIsoOrNull(member.lastNonInteractiveLogin),
      neverLoggedIn: member.neverLoggedIn,
    })),
  }));

  const members: CyberVpnMember[] = groups.flatMap((group) => group.members);

  return {
    kind: "vpn_groups",
    reportType,
    run,
    groups,
    members,
  };
}

export async function getCybersecurityLiveDashboard(): Promise<CybersecurityDashboardResponse> {
  const reportDefinitions = {
    inactive_users_90d: {
      label: "Usuarios inactivos +90d",
      description: "Usuarios habilitados sin login o con actividad superior a 90 días.",
    },
    users_without_mfa_group: {
      label: "Usuarios fuera de MFA",
      description: "Usuarios habilitados fuera de los grupos corporativos de cobertura MFA.",
    },
    vpn_groups: {
      label: "Grupos VPN",
      description: "Miembros por grupo AZ_VPN con contexto de alta y último acceso observado.",
    },
  } as const;

  const [inactiveResult, mfaResult, vpnResult] = await Promise.allSettled([
    getCybersecurityLiveReport("inactive_users_90d"),
    getCybersecurityLiveReport("users_without_mfa_group"),
    getCybersecurityLiveReport("vpn_groups"),
  ]);

  const reports = {
    inactive_users_90d: {
      ...reportDefinitions.inactive_users_90d,
      latestRun:
        inactiveResult.status === "fulfilled"
          ? inactiveResult.value.run
          : null,
      history: [] as CyberRunSummary[],
    },
    users_without_mfa_group: {
      ...reportDefinitions.users_without_mfa_group,
      latestRun:
        mfaResult.status === "fulfilled"
          ? mfaResult.value.run
          : null,
      history: [] as CyberRunSummary[],
    },
    vpn_groups: {
      ...reportDefinitions.vpn_groups,
      latestRun:
        vpnResult.status === "fulfilled"
          ? vpnResult.value.run
          : null,
      history: [] as CyberRunSummary[],
    },
  };

  const dates = Object.values(reports)
    .map((report) => report.latestRun?.generatedAt || null)
    .filter((value): value is string => Boolean(value));

  return {
    meta: {
      lastUpdated: dates.sort().reverse()[0] || null,
      totalRuns: Object.values(reports).filter((report) => report.latestRun).length,
    },
    reports,
  };
}
