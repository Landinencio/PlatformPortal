import type { PoolClient } from "pg";
import { z } from "zod";
import pool from "@/lib/db";

export const CYBER_REPORT_TYPES = [
  "vpn_groups",
  "inactive_users_90d",
  "users_without_mfa_group",
] as const;

export type CyberReportType = (typeof CYBER_REPORT_TYPES)[number];

type JsonObject = Record<string, unknown>;

export interface CyberRunSummary {
  runId: number;
  source: string;
  reportType: CyberReportType;
  status: "completed" | "partial" | "failed";
  schemaVersion: string;
  sourceRunId: string | null;
  generatedAt: string;
  ingestedAt: string;
  recordsCount: number;
  summary: JsonObject;
  meta: JsonObject;
}

export interface CyberInactiveUser {
  userId: string | null;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string;
  department: string | null;
  company: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  lastNonInteractiveAt: string | null;
  daysInactive: number | null;
  neverLoggedIn: boolean;
}

export interface CyberMfaGap {
  userId: string | null;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string;
  department: string | null;
  jobTitle: string | null;
  company: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  lastNonInteractiveAt: string | null;
  daysSinceLogin: number | null;
  neverLoggedIn: boolean;
}

export interface CyberVpnMember {
  groupId: string;
  userId: string | null;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string;
  department: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  lastNonInteractiveAt: string | null;
  neverLoggedIn: boolean;
}

export interface CyberVpnGroup {
  groupId: string;
  groupName: string;
  description: string | null;
  memberCount: number;
  members: CyberVpnMember[];
}

export interface CybersecurityDashboardResponse {
  meta: {
    lastUpdated: string | null;
    totalRuns: number;
  };
  reports: Record<CyberReportType, {
    label: string;
    description: string;
    latestRun: CyberRunSummary | null;
    history: CyberRunSummary[];
  }>;
}

export type CybersecurityReportResponse =
  | {
      kind: "inactive_users";
      reportType: "inactive_users_90d";
      run: CyberRunSummary;
      items: CyberInactiveUser[];
    }
  | {
      kind: "mfa_gaps";
      reportType: "users_without_mfa_group";
      run: CyberRunSummary;
      items: CyberMfaGap[];
    }
  | {
      kind: "vpn_groups";
      reportType: "vpn_groups";
      run: CyberRunSummary;
      groups: CyberVpnGroup[];
      members: CyberVpnMember[];
    };

type CyberRunRow = {
  id: string | number;
  source: string;
  report_type: CyberReportType;
  status: "completed" | "partial" | "failed";
  schema_version: string;
  source_run_id: string | null;
  generated_at: string;
  ingested_at: string;
  records_count: string | number;
  summary_json: JsonObject | null;
  meta_json: JsonObject | null;
};

type InactiveUserRow = {
  user_id: string | null;
  display_name: string | null;
  mail: string | null;
  user_principal_name: string;
  department: string | null;
  company: string | null;
  created_at_azure: string | null;
  last_login_at: string | null;
  last_non_interactive_at: string | null;
  days_inactive: string | number | null;
  never_logged_in: boolean;
};

type MfaGapRow = {
  user_id: string | null;
  display_name: string | null;
  mail: string | null;
  user_principal_name: string;
  department: string | null;
  job_title: string | null;
  company: string | null;
  created_at_azure: string | null;
  last_login_at: string | null;
  last_non_interactive_at: string | null;
  days_since_login: string | number | null;
  never_logged_in: boolean;
};

type VpnGroupRow = {
  group_id: string;
  group_name: string;
  description: string | null;
  member_count: string | number;
};

type VpnMemberRow = {
  group_id: string;
  user_id: string | null;
  display_name: string | null;
  mail: string | null;
  user_principal_name: string;
  department: string | null;
  created_at_azure: string | null;
  last_login_at: string | null;
  last_non_interactive_at: string | null;
  never_logged_in: boolean;
};

const cyberPayloadSchema = z.object({
  source: z.string().min(1).default("azure_ad"),
  reportType: z.enum(CYBER_REPORT_TYPES),
  status: z.enum(["completed", "partial", "failed"]).default("completed"),
  schemaVersion: z.string().default("1"),
  sourceRunId: z.string().optional(),
  generatedAt: z.union([z.string(), z.date()]).optional(),
  meta: z.record(z.any()).optional(),
  summary: z.record(z.any()).optional(),
  records: z.array(z.record(z.any())).default([]),
});

type CyberIngestPayload = z.infer<typeof cyberPayloadSchema>;

type NormalizedInactiveUser = {
  userId: string | null;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string;
  department: string | null;
  company: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  lastNonInteractiveAt: string | null;
  daysInactive: number | null;
  neverLoggedIn: boolean;
};

type NormalizedMfaGap = {
  userId: string | null;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string;
  department: string | null;
  jobTitle: string | null;
  company: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  lastNonInteractiveAt: string | null;
  daysSinceLogin: number | null;
  neverLoggedIn: boolean;
};

type NormalizedVpnMember = {
  groupId: string;
  userId: string | null;
  displayName: string | null;
  mail: string | null;
  userPrincipalName: string;
  department: string | null;
  createdAt: string | null;
  lastLoginAt: string | null;
  lastNonInteractiveAt: string | null;
  neverLoggedIn: boolean;
};

type NormalizedVpnGroup = {
  groupId: string;
  groupName: string;
  description: string | null;
  memberCount: number;
  members: NormalizedVpnMember[];
};

const REPORT_DEFINITIONS: Record<CyberReportType, { label: string; description: string }> = {
  vpn_groups: {
    label: "Grupos VPN",
    description: "Miembros por grupo AZ_VPN con contexto de alta y último acceso observado.",
  },
  inactive_users_90d: {
    label: "Usuarios inactivos +90d",
    description: "Usuarios habilitados sin login o con actividad superior a 90 días.",
  },
  users_without_mfa_group: {
    label: "Usuarios fuera de MFA",
    description: "Usuarios habilitados fuera de los grupos corporativos de cobertura MFA.",
  },
};

const INSERT_CHUNK_SIZE = 250;

function toIsoString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = new Date(trimmed);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }
  return null;
}

function pickString(record: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function pickNumber(record: JsonObject, keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pickBoolean(record: JsonObject, keys: string[]): boolean | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.trim().toLowerCase();
      if (normalized === "true") return true;
      if (normalized === "false") return false;
    }
  }
  return null;
}

function pickDate(record: JsonObject, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    const iso = toIsoString(value);
    if (iso) return iso;
  }
  return null;
}

function toInteger(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.round(value);
}

function mapRunRow(row: CyberRunRow): CyberRunSummary {
  return {
    runId: Number(row.id),
    source: row.source,
    reportType: row.report_type,
    status: row.status,
    schemaVersion: row.schema_version,
    sourceRunId: row.source_run_id,
    generatedAt: new Date(row.generated_at).toISOString(),
    ingestedAt: new Date(row.ingested_at).toISOString(),
    recordsCount: Number(row.records_count || 0),
    summary: row.summary_json || {},
    meta: row.meta_json || {},
  };
}

function normalizeInactiveUsers(records: JsonObject[]): NormalizedInactiveUser[] {
  return records.map((record, index) => {
    const userPrincipalName = pickString(record, ["userPrincipalName", "upn", "user_principal_name"]);
    if (!userPrincipalName) {
      throw new Error(`Inactive users payload has no userPrincipalName on row ${index + 1}`);
    }

    const lastLoginAt = pickDate(record, [
      "lastLogin",
      "lastLoginAt",
      "last_login_at",
      "lastInteractiveLogin",
    ]);

    const lastNonInteractiveAt = pickDate(record, [
      "lastNonInteractiveLogin",
      "lastNonInteractiveAt",
      "last_non_interactive_at",
    ]);

    const neverLoggedIn =
      pickBoolean(record, ["neverLoggedIn", "never_logged_in"]) ??
      (!lastLoginAt && !lastNonInteractiveAt);

    return {
      userId: pickString(record, ["id", "userId", "user_id"]),
      displayName: pickString(record, ["displayName", "display_name"]),
      mail: pickString(record, ["mail", "email"]),
      userPrincipalName,
      department: pickString(record, ["department"]),
      company: pickString(record, ["company", "companyName"]),
      createdAt: pickDate(record, ["createdDate", "created", "createdDateTime", "created_at"]),
      lastLoginAt,
      lastNonInteractiveAt,
      daysInactive: toInteger(pickNumber(record, ["daysInactive", "days", "days_since_login"])),
      neverLoggedIn,
    };
  });
}

function normalizeMfaGaps(records: JsonObject[]): NormalizedMfaGap[] {
  return records.map((record, index) => {
    const userPrincipalName = pickString(record, ["userPrincipalName", "upn", "user_principal_name"]);
    if (!userPrincipalName) {
      throw new Error(`MFA gaps payload has no userPrincipalName on row ${index + 1}`);
    }

    const lastLoginAt = pickDate(record, [
      "lastLogin",
      "lastLoginAt",
      "last_login_at",
      "lastInteractiveLogin",
    ]);

    const lastNonInteractiveAt = pickDate(record, [
      "lastNonInteractiveLogin",
      "lastNonInteractiveAt",
      "last_non_interactive_at",
    ]);

    const neverLoggedIn =
      pickBoolean(record, ["neverLoggedIn", "never_logged_in"]) ??
      (!lastLoginAt && !lastNonInteractiveAt);

    return {
      userId: pickString(record, ["id", "userId", "user_id"]),
      displayName: pickString(record, ["displayName", "display_name", "name"]),
      mail: pickString(record, ["mail", "email"]),
      userPrincipalName,
      department: pickString(record, ["department"]),
      jobTitle: pickString(record, ["jobTitle", "job_title"]),
      company: pickString(record, ["company", "companyName"]),
      createdAt: pickDate(record, ["createdDate", "created", "createdDateTime", "created_at"]),
      lastLoginAt,
      lastNonInteractiveAt,
      daysSinceLogin: toInteger(pickNumber(record, ["days", "daysSinceLogin", "days_since_login"])),
      neverLoggedIn,
    };
  });
}

function normalizeVpnGroups(records: JsonObject[]): NormalizedVpnGroup[] {
  return records.map((record, index) => {
    const groupId = pickString(record, ["groupId", "id", "group_id"]);
    const groupName = pickString(record, ["groupName", "displayName", "group_name", "name"]);
    if (!groupId || !groupName) {
      throw new Error(`VPN groups payload is missing group identity on row ${index + 1}`);
    }

    const memberObjects = Array.isArray(record.members)
      ? record.members.filter((item): item is JsonObject => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];

    const members = memberObjects.map((member, memberIndex) => {
      const userPrincipalName = pickString(member, ["userPrincipalName", "upn", "user_principal_name"]);
      if (!userPrincipalName) {
        throw new Error(`VPN member payload is missing userPrincipalName on group ${groupName} row ${memberIndex + 1}`);
      }

      const lastLoginAt = pickDate(member, [
        "lastLogin",
        "lastLoginAt",
        "last_login_at",
        "lastInteractiveLogin",
      ]);

      const lastNonInteractiveAt = pickDate(member, [
        "lastNonInteractiveLogin",
        "lastNonInteractiveAt",
        "last_non_interactive_at",
      ]);

      return {
        groupId,
        userId: pickString(member, ["id", "userId", "user_id"]),
        displayName: pickString(member, ["displayName", "display_name", "name"]),
        mail: pickString(member, ["mail", "email"]),
        userPrincipalName,
        department: pickString(member, ["department"]),
        createdAt: pickDate(member, ["createdDate", "created", "createdDateTime", "created_at"]),
        lastLoginAt,
        lastNonInteractiveAt,
        neverLoggedIn:
          pickBoolean(member, ["neverLoggedIn", "never_logged_in"]) ??
          (!lastLoginAt && !lastNonInteractiveAt),
      };
    });

    return {
      groupId,
      groupName,
      description: pickString(record, ["description"]),
      memberCount: toInteger(pickNumber(record, ["memberCount", "member_count"])) ?? members.length,
      members,
    };
  });
}

function deriveSummary(reportType: CyberReportType, payload: CyberIngestPayload, records: JsonObject[]): JsonObject {
  if (payload.summary && Object.keys(payload.summary).length > 0) {
    return payload.summary;
  }

  if (reportType === "inactive_users_90d") {
    const users = normalizeInactiveUsers(records);
    return {
      totalInactive: users.length,
      neverLogin: users.filter((user) => user.neverLoggedIn).length,
      oldLogin: users.filter((user) => !user.neverLoggedIn).length,
    };
  }

  if (reportType === "users_without_mfa_group") {
    const users = normalizeMfaGaps(records);
    return {
      totalUsers: users.length,
      neverLogin: users.filter((user) => user.neverLoggedIn).length,
      over90d: users.filter((user) => (user.daysSinceLogin || 0) >= 90).length,
    };
  }

  const groups = normalizeVpnGroups(records);
  return {
    totalGroups: groups.length,
    totalMembers: groups.reduce((sum, group) => sum + group.members.length, 0),
    groupsWithMembers: groups.filter((group) => group.memberCount > 0).length,
  };
}

async function ensureCybersecuritySchemaReady() {
  const result = await pool.query<{ run_table: string | null }>(`
    SELECT to_regclass('public.cybersecurity_runs')::text AS run_table
  `);

  if (!result.rows[0]?.run_table) {
    throw new Error("cybersecurity schema is not ready");
  }
}

function buildMultiInsert(
  tableName: string,
  columns: string[],
  rows: Array<Array<string | number | boolean | null>>
) {
  if (rows.length === 0) {
    return null;
  }

  const values: Array<string | number | boolean | null> = [];
  const placeholders = rows.map((row, rowIndex) => {
    const base = rowIndex * columns.length;
    row.forEach((value) => values.push(value));
    return `(${row.map((_, cellIndex) => `$${base + cellIndex + 1}`).join(", ")})`;
  });

  return {
    text: `INSERT INTO ${tableName} (${columns.join(", ")}) VALUES ${placeholders.join(", ")}`,
    values,
  };
}

function chunkRows<T>(rows: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += size) {
    chunks.push(rows.slice(index, index + size));
  }
  return chunks;
}

async function insertInactiveUsers(client: PoolClient, runId: number, records: JsonObject[]) {
  const users = normalizeInactiveUsers(records);
  for (const batch of chunkRows(users, INSERT_CHUNK_SIZE)) {
    const batchInsert = buildMultiInsert(
      "cyber_azure_inactive_users",
      [
        "run_id",
        "user_id",
        "display_name",
        "mail",
        "user_principal_name",
        "department",
        "company",
        "created_at_azure",
        "last_login_at",
        "last_non_interactive_at",
        "days_inactive",
        "never_logged_in",
      ],
      batch.map((user) => [
        runId,
        user.userId,
        user.displayName,
        user.mail,
        user.userPrincipalName,
        user.department,
        user.company,
        user.createdAt,
        user.lastLoginAt,
        user.lastNonInteractiveAt,
        user.daysInactive,
        user.neverLoggedIn,
      ])
    );

    if (batchInsert) {
      await client.query(batchInsert.text, batchInsert.values);
    }
  }

  return users.length;
}

async function insertMfaGaps(client: PoolClient, runId: number, records: JsonObject[]) {
  const users = normalizeMfaGaps(records);
  for (const batch of chunkRows(users, INSERT_CHUNK_SIZE)) {
    const insert = buildMultiInsert(
      "cyber_azure_mfa_gaps",
      [
        "run_id",
        "user_id",
        "display_name",
        "mail",
        "user_principal_name",
        "department",
        "job_title",
        "company",
        "created_at_azure",
        "last_login_at",
        "last_non_interactive_at",
        "days_since_login",
        "never_logged_in",
      ],
      batch.map((user) => [
        runId,
        user.userId,
        user.displayName,
        user.mail,
        user.userPrincipalName,
        user.department,
        user.jobTitle,
        user.company,
        user.createdAt,
        user.lastLoginAt,
        user.lastNonInteractiveAt,
        user.daysSinceLogin,
        user.neverLoggedIn,
      ])
    );

    if (insert) {
      await client.query(insert.text, insert.values);
    }
  }

  return users.length;
}

async function insertVpnGroups(client: PoolClient, runId: number, records: JsonObject[]) {
  const groups = normalizeVpnGroups(records);
  for (const batch of chunkRows(groups, INSERT_CHUNK_SIZE)) {
    const groupInsert = buildMultiInsert(
      "cyber_azure_vpn_groups",
      ["run_id", "group_id", "group_name", "description", "member_count"],
      batch.map((group) => [runId, group.groupId, group.groupName, group.description, group.memberCount])
    );

    if (groupInsert) {
      await client.query(groupInsert.text, groupInsert.values);
    }
  }

  const members = groups.flatMap((group) => group.members);
  for (const batch of chunkRows(members, INSERT_CHUNK_SIZE)) {
    const memberInsert = buildMultiInsert(
      "cyber_azure_vpn_group_members",
      [
        "run_id",
        "group_id",
        "user_id",
        "display_name",
        "mail",
        "user_principal_name",
        "department",
        "created_at_azure",
        "last_login_at",
        "last_non_interactive_at",
        "never_logged_in",
      ],
      batch.map((member) => [
        runId,
        member.groupId,
        member.userId,
        member.displayName,
        member.mail,
        member.userPrincipalName,
        member.department,
        member.createdAt,
        member.lastLoginAt,
        member.lastNonInteractiveAt,
        member.neverLoggedIn,
      ])
    );

    if (memberInsert) {
      await client.query(memberInsert.text, memberInsert.values);
    }
  }

  return groups.length;
}

export async function ingestCybersecurityReport(input: unknown) {
  await ensureCybersecuritySchemaReady();
  const payload = cyberPayloadSchema.parse(input);
  const generatedAt = toIsoString(payload.generatedAt) || new Date().toISOString();
  const summary = deriveSummary(payload.reportType, payload, payload.records);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const runInsert = await client.query<{ id: string | number }>(
      `
        INSERT INTO cybersecurity_runs (
          source,
          report_type,
          status,
          schema_version,
          source_run_id,
          generated_at,
          records_count,
          summary_json,
          meta_json,
          raw_payload_json
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10::jsonb)
        RETURNING id
      `,
      [
        payload.source,
        payload.reportType,
        payload.status,
        payload.schemaVersion,
        payload.sourceRunId || null,
        generatedAt,
        payload.records.length,
        JSON.stringify(summary),
        JSON.stringify(payload.meta || {}),
        JSON.stringify(payload),
      ]
    );

    const runId = Number(runInsert.rows[0]?.id);
    let insertedCount = 0;

    if (payload.reportType === "inactive_users_90d") {
      insertedCount = await insertInactiveUsers(client, runId, payload.records);
    } else if (payload.reportType === "users_without_mfa_group") {
      insertedCount = await insertMfaGaps(client, runId, payload.records);
    } else {
      insertedCount = await insertVpnGroups(client, runId, payload.records);
    }

    await client.query("COMMIT");

    return {
      ok: true,
      runId,
      reportType: payload.reportType,
      generatedAt,
      recordsCount: payload.records.length,
      insertedCount,
      summary,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function emptyDashboardReport(reportType: CyberReportType) {
  return {
    label: REPORT_DEFINITIONS[reportType].label,
    description: REPORT_DEFINITIONS[reportType].description,
    latestRun: null,
    history: [],
  };
}

export async function getCybersecurityDashboard(): Promise<CybersecurityDashboardResponse> {
  await ensureCybersecuritySchemaReady();

  const [runsResult, countResult] = await Promise.all([
    pool.query<CyberRunRow>(
      `
        SELECT
          id,
          source,
          report_type,
          status,
          schema_version,
          source_run_id,
          generated_at,
          ingested_at,
          records_count,
          summary_json,
          meta_json
        FROM cybersecurity_runs
        ORDER BY generated_at DESC, id DESC
        LIMIT 120
      `
    ),
    pool.query<{ total: string | number }>(`SELECT COUNT(*)::bigint AS total FROM cybersecurity_runs`),
  ]);

  const grouped = new Map<CyberReportType, CyberRunSummary[]>();
  let lastUpdated: string | null = null;

  for (const row of runsResult.rows) {
    const mapped = mapRunRow(row);
    const current = grouped.get(mapped.reportType) || [];
    if (current.length < 12) {
      current.push(mapped);
      grouped.set(mapped.reportType, current);
    }

    if (!lastUpdated || mapped.generatedAt > lastUpdated) {
      lastUpdated = mapped.generatedAt;
    }
  }

  return {
    meta: {
      lastUpdated,
      totalRuns: Number(countResult.rows[0]?.total || 0),
    },
    reports: {
      inactive_users_90d: {
        ...emptyDashboardReport("inactive_users_90d"),
        latestRun: grouped.get("inactive_users_90d")?.[0] || null,
        history: grouped.get("inactive_users_90d") || [],
      },
      users_without_mfa_group: {
        ...emptyDashboardReport("users_without_mfa_group"),
        latestRun: grouped.get("users_without_mfa_group")?.[0] || null,
        history: grouped.get("users_without_mfa_group") || [],
      },
      vpn_groups: {
        ...emptyDashboardReport("vpn_groups"),
        latestRun: grouped.get("vpn_groups")?.[0] || null,
        history: grouped.get("vpn_groups") || [],
      },
    },
  };
}

async function getRunForReport(reportType: CyberReportType, runId?: number): Promise<CyberRunSummary | null> {
  const params: Array<number | CyberReportType> = [reportType];
  const where = runId ? "report_type = $1 AND id = $2" : "report_type = $1";
  if (runId) params.push(runId);

  const result = await pool.query<CyberRunRow>(
    `
      SELECT
        id,
        source,
        report_type,
        status,
        schema_version,
        source_run_id,
        generated_at,
        ingested_at,
        records_count,
        summary_json,
        meta_json
      FROM cybersecurity_runs
      WHERE ${where}
      ORDER BY generated_at DESC, id DESC
      LIMIT 1
    `,
    params
  );

  if (result.rows.length === 0) return null;
  return mapRunRow(result.rows[0]);
}

export async function getCybersecurityReport(
  reportType: CyberReportType,
  runId?: number
): Promise<CybersecurityReportResponse | null> {
  await ensureCybersecuritySchemaReady();
  const run = await getRunForReport(reportType, runId);
  if (!run) return null;

  if (reportType === "inactive_users_90d") {
    const result = await pool.query<InactiveUserRow>(
      `
        SELECT
          user_id,
          display_name,
          mail,
          user_principal_name,
          department,
          company,
          created_at_azure,
          last_login_at,
          last_non_interactive_at,
          days_inactive,
          never_logged_in
        FROM cyber_azure_inactive_users
        WHERE run_id = $1
        ORDER BY never_logged_in DESC, days_inactive DESC NULLS LAST, user_principal_name ASC
      `,
      [run.runId]
    );

    return {
      kind: "inactive_users",
      reportType,
      run,
      items: result.rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        mail: row.mail,
        userPrincipalName: row.user_principal_name,
        department: row.department,
        company: row.company,
        createdAt: row.created_at_azure ? new Date(row.created_at_azure).toISOString() : null,
        lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        lastNonInteractiveAt: row.last_non_interactive_at ? new Date(row.last_non_interactive_at).toISOString() : null,
        daysInactive: row.days_inactive === null ? null : Number(row.days_inactive),
        neverLoggedIn: row.never_logged_in,
      })),
    };
  }

  if (reportType === "users_without_mfa_group") {
    const result = await pool.query<MfaGapRow>(
      `
        SELECT
          user_id,
          display_name,
          mail,
          user_principal_name,
          department,
          job_title,
          company,
          created_at_azure,
          last_login_at,
          last_non_interactive_at,
          days_since_login,
          never_logged_in
        FROM cyber_azure_mfa_gaps
        WHERE run_id = $1
        ORDER BY never_logged_in DESC, days_since_login DESC NULLS LAST, user_principal_name ASC
      `,
      [run.runId]
    );

    return {
      kind: "mfa_gaps",
      reportType,
      run,
      items: result.rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
        mail: row.mail,
        userPrincipalName: row.user_principal_name,
        department: row.department,
        jobTitle: row.job_title,
        company: row.company,
        createdAt: row.created_at_azure ? new Date(row.created_at_azure).toISOString() : null,
        lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
        lastNonInteractiveAt: row.last_non_interactive_at ? new Date(row.last_non_interactive_at).toISOString() : null,
        daysSinceLogin: row.days_since_login === null ? null : Number(row.days_since_login),
        neverLoggedIn: row.never_logged_in,
      })),
    };
  }

  const [groupsResult, membersResult] = await Promise.all([
    pool.query<VpnGroupRow>(
      `
        SELECT group_id, group_name, description, member_count
        FROM cyber_azure_vpn_groups
        WHERE run_id = $1
        ORDER BY member_count DESC, group_name ASC
      `,
      [run.runId]
    ),
    pool.query<VpnMemberRow>(
      `
        SELECT
          group_id,
          user_id,
          display_name,
          mail,
          user_principal_name,
          department,
          created_at_azure,
          last_login_at,
          last_non_interactive_at,
          never_logged_in
        FROM cyber_azure_vpn_group_members
        WHERE run_id = $1
        ORDER BY group_id ASC, never_logged_in DESC, user_principal_name ASC
      `,
      [run.runId]
    ),
  ]);

  const members = membersResult.rows.map((row) => ({
    groupId: row.group_id,
    userId: row.user_id,
    displayName: row.display_name,
    mail: row.mail,
    userPrincipalName: row.user_principal_name,
    department: row.department,
    createdAt: row.created_at_azure ? new Date(row.created_at_azure).toISOString() : null,
    lastLoginAt: row.last_login_at ? new Date(row.last_login_at).toISOString() : null,
    lastNonInteractiveAt: row.last_non_interactive_at ? new Date(row.last_non_interactive_at).toISOString() : null,
    neverLoggedIn: row.never_logged_in,
  }));

  const membersByGroup = new Map<string, CyberVpnMember[]>();
  for (const member of members) {
    const current = membersByGroup.get(member.groupId) || [];
    current.push(member);
    membersByGroup.set(member.groupId, current);
  }

  return {
    kind: "vpn_groups",
    reportType,
    run,
    groups: groupsResult.rows.map((row) => ({
      groupId: row.group_id,
      groupName: row.group_name,
      description: row.description,
      memberCount: Number(row.member_count || 0),
      members: membersByGroup.get(row.group_id) || [],
    })),
    members,
  };
}
