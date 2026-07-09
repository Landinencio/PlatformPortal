// Utility for parsing multi-select query parameters

import { z } from "zod";

export interface MetricFilters {
    teams: string[];
    projectIds: number[];
    developers: string[];
    days: number;
    from?: string; // ISO date string (YYYY-MM-DD)
    to?: string;   // ISO date string (YYYY-MM-DD)
}

const MAX_DAYS = 365;
const MAX_ITEMS = 200;

/** Zod schema for metric filter query params */
const metricFiltersSchema = z.object({
    teams: z.array(z.string().max(100)).max(MAX_ITEMS).default([]),
    projectIds: z.array(z.number().int().positive()).max(MAX_ITEMS).default([]),
    developers: z.array(z.string().email().or(z.string().max(100))).max(MAX_ITEMS).default([]),
    days: z.number().int().min(1).max(MAX_DAYS).default(30),
});

function parseCsvParam(value: string | null): string[] {
    if (!value || value === "all") return [];
    return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function parseCsvInts(value: string | null): number[] {
    if (!value) return [];
    return value
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n) && n > 0);
}

export function parseMetricFilters(searchParams: URLSearchParams): MetricFilters {
    const raw = {
        teams: parseCsvParam(searchParams.get("teams") || searchParams.get("team")),
        projectIds: parseCsvInts(searchParams.get("projectIds") || searchParams.get("projectId")),
        developers: parseCsvParam(searchParams.get("developers") || searchParams.get("developer")),
        days: parseInt(searchParams.get("days") || "30", 10) || 30,
    };

    const fromParam = searchParams.get("from");
    const toParam = searchParams.get("to");

    const result = metricFiltersSchema.safeParse(raw);
    const filters: MetricFilters = result.success ? result.data : {
        teams: raw.teams.slice(0, MAX_ITEMS),
        projectIds: raw.projectIds.slice(0, MAX_ITEMS),
        developers: raw.developers.slice(0, MAX_ITEMS),
        days: Math.min(Math.max(raw.days, 1), MAX_DAYS),
    };

    // Add custom date range if provided
    if (fromParam && /^\d{4}-\d{2}-\d{2}$/.test(fromParam)) {
        filters.from = fromParam;
    }
    if (toParam && /^\d{4}-\d{2}-\d{2}$/.test(toParam)) {
        filters.to = toParam;
    }

    return filters;
}

export function buildWhereClause(
    filters: MetricFilters,
    startParamIndex: number = 1,
    options: { teamColumn?: string; projectColumn?: string; developerColumn?: string } = {}
): { clause: string; params: any[] } {
    const { teamColumn = 'team', projectColumn = 'project_id', developerColumn = 'developer_email' } = options;
    const conditions: string[] = [];
    const params: any[] = [];
    let paramIndex = startParamIndex;

    if (filters.teams.length > 0) {
        conditions.push(`${teamColumn} = ANY($${paramIndex})`);
        params.push(filters.teams);
        paramIndex++;
    }

    if (filters.projectIds.length > 0) {
        conditions.push(`${projectColumn} = ANY($${paramIndex})`);
        params.push(filters.projectIds);
        paramIndex++;
    }

    if (filters.developers.length > 0) {
        conditions.push(`${developerColumn} = ANY($${paramIndex})`);
        params.push(filters.developers);
        paramIndex++;
    }

    return {
        clause: conditions.length > 0 ? ' AND ' + conditions.join(' AND ') : '',
        params,
    };
}
