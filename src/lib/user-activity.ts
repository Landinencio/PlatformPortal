import pool from "@/lib/db";
import { AppRole } from "@/lib/rbac";

export type UserActivityEventType =
    | "login"
    | "session_start"
    | "session_end"
    | "page_view"
    | "feature_click"
    | "api_action";

export type TrackUserActivityInput = {
    eventType: UserActivityEventType;
    userEmail: string;
    userName?: string | null;
    userRole: AppRole;
    authSub?: string | null;
    portalSessionId?: string | null;
    path?: string | null;
    action?: string | null;
    durationSeconds?: number | null;
    metadata?: Record<string, unknown> | null;
    ipAddress?: string | null;
    userAgent?: string | null;
};

type TotalsRow = {
    events: string;
    unique_users: string;
    sessions: string;
    page_views: string;
    clicks: string;
    logins: string;
};

type SessionStatsRow = {
    avg_session_seconds: string | null;
};

type UserRow = {
    user_email: string;
    user_name: string | null;
    user_role: AppRole;
    last_seen: string;
    total_events: string;
    total_sessions: string;
};

type UserDurationRow = {
    user_email: string;
    total_minutes: string;
};

type PathRow = {
    path: string;
    views: string;
    unique_users: string;
};

type ActionRow = {
    action: string;
    count: string;
};

type DailyRow = {
    date: string;
    users: string;
    events: string;
    sessions: string;
};

type EventRow = {
    id: string;
    occurred_at: string;
    event_type: UserActivityEventType;
    user_email: string;
    user_name: string | null;
    user_role: AppRole;
    portal_session_id: string | null;
    path: string | null;
    action: string | null;
    duration_seconds: number | null;
    metadata: Record<string, unknown> | null;
    ip_address: string | null;
    user_agent: string | null;
};

type EventCountRow = {
    total: string;
};

export type UserActivitySummary = {
    periodDays: number;
    totals: {
        events: number;
        uniqueUsers: number;
        sessions: number;
        avgSessionMinutes: number;
        pageViews: number;
        clicks: number;
        logins: number;
    };
    users: Array<{
        email: string;
        name: string;
        role: AppRole;
        lastSeen: string;
        totalEvents: number;
        totalSessions: number;
        totalMinutes: number;
    }>;
    topPaths: Array<{
        path: string;
        views: number;
        uniqueUsers: number;
    }>;
    topActions: Array<{
        action: string;
        count: number;
    }>;
    daily: Array<{
        date: string;
        users: number;
        events: number;
        sessions: number;
    }>;
};

export type UserActivityEvent = {
    id: string;
    occurredAt: string;
    eventType: UserActivityEventType;
    userEmail: string;
    userName: string;
    userRole: AppRole;
    sessionId: string | null;
    path: string | null;
    action: string | null;
    durationSeconds: number | null;
    metadata: Record<string, unknown>;
    ipAddress: string | null;
    userAgent: string | null;
};

const toInt = (value: string | number | null | undefined): number => {
    if (typeof value === "number") return Number.isFinite(value) ? value : 0;
    if (typeof value === "string") {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
};

let schemaReadyPromise: Promise<void> | null = null;

export async function ensureUserActivitySchema(): Promise<void> {
    if (!schemaReadyPromise) {
        schemaReadyPromise = (async () => {
            await pool.query(`
                CREATE TABLE IF NOT EXISTS portal_user_activity (
                    id BIGSERIAL PRIMARY KEY,
                    occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                    event_type TEXT NOT NULL,
                    user_email TEXT NOT NULL,
                    user_name TEXT,
                    user_role TEXT NOT NULL,
                    auth_sub TEXT,
                    portal_session_id TEXT,
                    path TEXT,
                    action TEXT,
                    duration_seconds INTEGER,
                    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
                    ip_address TEXT,
                    user_agent TEXT
                )
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_portal_user_activity_occurred_at
                    ON portal_user_activity (occurred_at DESC)
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_portal_user_activity_user_email
                    ON portal_user_activity (user_email, occurred_at DESC)
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_portal_user_activity_session
                    ON portal_user_activity (portal_session_id, occurred_at DESC)
            `);

            await pool.query(`
                CREATE INDEX IF NOT EXISTS idx_portal_user_activity_event_type
                    ON portal_user_activity (event_type, occurred_at DESC)
            `);
        })().catch((error) => {
            schemaReadyPromise = null;
            throw error;
        });
    }

    await schemaReadyPromise;
}

export async function trackUserActivity(input: TrackUserActivityInput): Promise<void> {
    await ensureUserActivitySchema();

    await pool.query(
        `
        INSERT INTO portal_user_activity (
            event_type,
            user_email,
            user_name,
            user_role,
            auth_sub,
            portal_session_id,
            path,
            action,
            duration_seconds,
            metadata,
            ip_address,
            user_agent
        ) VALUES (
            $1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12
        )
        `,
        [
            input.eventType,
            input.userEmail,
            input.userName || null,
            input.userRole,
            input.authSub || null,
            input.portalSessionId || null,
            input.path || null,
            input.action || null,
            input.durationSeconds ?? null,
            JSON.stringify(input.metadata || {}),
            input.ipAddress || null,
            input.userAgent || null,
        ]
    );
}

export async function getUserActivitySummary(days: number): Promise<UserActivitySummary> {
    await ensureUserActivitySchema();
    const periodDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;

    const totalsResult = await pool.query<TotalsRow>(
        `
        SELECT
            COUNT(*)::text as events,
            COUNT(DISTINCT user_email)::text as unique_users,
            COUNT(DISTINCT portal_session_id)::text as sessions,
            COUNT(*) FILTER (WHERE event_type = 'page_view')::text as page_views,
            COUNT(*) FILTER (WHERE event_type = 'feature_click')::text as clicks,
            COUNT(*) FILTER (WHERE event_type = 'login')::text as logins
        FROM portal_user_activity
        WHERE occurred_at >= NOW() - ($1::text || ' days')::interval
        `,
        [periodDays]
    );

    const sessionStatsResult = await pool.query<SessionStatsRow>(
        `
        WITH scoped AS (
            SELECT *
            FROM portal_user_activity
            WHERE occurred_at >= NOW() - ($1::text || ' days')::interval
        ),
        session_bounds AS (
            SELECT
                portal_session_id,
                MIN(occurred_at) as started_at,
                MAX(occurred_at) as ended_at,
                MAX(duration_seconds) FILTER (WHERE event_type = 'session_end') as explicit_duration_seconds
            FROM scoped
            WHERE portal_session_id IS NOT NULL
            GROUP BY portal_session_id
        )
        SELECT
            AVG(
                COALESCE(
                    explicit_duration_seconds::double precision,
                    EXTRACT(EPOCH FROM (ended_at - started_at))
                )
            )::text as avg_session_seconds
        FROM session_bounds
        `
        ,
        [periodDays]
    );

    const usersResult = await pool.query<UserRow>(
        `
        SELECT
            user_email,
            MAX(user_name) as user_name,
            MAX(user_role)::text as user_role,
            MAX(occurred_at)::text as last_seen,
            COUNT(*)::text as total_events,
            COUNT(DISTINCT portal_session_id)::text as total_sessions
        FROM portal_user_activity
        WHERE occurred_at >= NOW() - ($1::text || ' days')::interval
        GROUP BY user_email
        ORDER BY MAX(occurred_at) DESC
        LIMIT 100
        `,
        [periodDays]
    );

    const userDurationResult = await pool.query<UserDurationRow>(
        `
        WITH scoped AS (
            SELECT *
            FROM portal_user_activity
            WHERE occurred_at >= NOW() - ($1::text || ' days')::interval
        ),
        session_bounds AS (
            SELECT
                portal_session_id,
                MAX(user_email) as user_email,
                COALESCE(
                    MAX(duration_seconds) FILTER (WHERE event_type = 'session_end')::double precision,
                    EXTRACT(EPOCH FROM (MAX(occurred_at) - MIN(occurred_at)))
                ) as duration_seconds
            FROM scoped
            WHERE portal_session_id IS NOT NULL
            GROUP BY portal_session_id
        )
        SELECT
            user_email,
            ROUND((SUM(duration_seconds) / 60.0)::numeric, 2)::text as total_minutes
        FROM session_bounds
        GROUP BY user_email
        `,
        [periodDays]
    );

    const topPathsResult = await pool.query<PathRow>(
        `
        SELECT
            path,
            COUNT(*)::text as views,
            COUNT(DISTINCT user_email)::text as unique_users
        FROM portal_user_activity
        WHERE occurred_at >= NOW() - ($1::text || ' days')::interval
          AND event_type = 'page_view'
          AND path IS NOT NULL
          AND path <> ''
        GROUP BY path
        ORDER BY COUNT(*) DESC
        LIMIT 12
        `,
        [periodDays]
    );

    const topActionsResult = await pool.query<ActionRow>(
        `
        SELECT
            action,
            COUNT(*)::text as count
        FROM portal_user_activity
        WHERE occurred_at >= NOW() - ($1::text || ' days')::interval
          AND action IS NOT NULL
          AND action <> ''
        GROUP BY action
        ORDER BY COUNT(*) DESC
        LIMIT 12
        `,
        [periodDays]
    );

    const dailyResult = await pool.query<DailyRow>(
        `
        SELECT
            to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') as date,
            COUNT(DISTINCT user_email)::text as users,
            COUNT(*)::text as events,
            COUNT(DISTINCT portal_session_id)::text as sessions
        FROM portal_user_activity
        WHERE occurred_at >= NOW() - ($1::text || ' days')::interval
        GROUP BY 1
        ORDER BY 1 ASC
        `,
        [periodDays]
    );

    const totals = totalsResult.rows[0] || {
        events: "0",
        unique_users: "0",
        sessions: "0",
        page_views: "0",
        clicks: "0",
        logins: "0",
    };
    const avgSessionSeconds = toInt(sessionStatsResult.rows[0]?.avg_session_seconds);
    const durationsByEmail = new Map<string, number>();
    for (const row of userDurationResult.rows) {
        durationsByEmail.set(row.user_email, toInt(row.total_minutes));
    }

    return {
        periodDays,
        totals: {
            events: toInt(totals.events),
            uniqueUsers: toInt(totals.unique_users),
            sessions: toInt(totals.sessions),
            avgSessionMinutes: Number((avgSessionSeconds / 60).toFixed(2)),
            pageViews: toInt(totals.page_views),
            clicks: toInt(totals.clicks),
            logins: toInt(totals.logins),
        },
        users: usersResult.rows.map((row) => ({
            email: row.user_email,
            name: row.user_name || row.user_email.split("@")[0],
            role: row.user_role,
            lastSeen: row.last_seen,
            totalEvents: toInt(row.total_events),
            totalSessions: toInt(row.total_sessions),
            totalMinutes: durationsByEmail.get(row.user_email) || 0,
        })),
        topPaths: topPathsResult.rows.map((row) => ({
            path: row.path,
            views: toInt(row.views),
            uniqueUsers: toInt(row.unique_users),
        })),
        topActions: topActionsResult.rows.map((row) => ({
            action: row.action,
            count: toInt(row.count),
        })),
        daily: dailyResult.rows.map((row) => ({
            date: row.date,
            users: toInt(row.users),
            events: toInt(row.events),
            sessions: toInt(row.sessions),
        })),
    };
}

export async function getUserActivityEvents(days: number, limit: number): Promise<{ events: UserActivityEvent[]; total: number }> {
    await ensureUserActivitySchema();
    const periodDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 30;
    const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 200;

    const eventsResult = await pool.query<EventRow>(
        `
        SELECT
            id::text,
            occurred_at::text,
            event_type,
            user_email,
            user_name,
            user_role::text as user_role,
            portal_session_id,
            path,
            action,
            duration_seconds,
            metadata,
            ip_address,
            user_agent
        FROM portal_user_activity
        WHERE occurred_at >= NOW() - ($1::text || ' days')::interval
        ORDER BY occurred_at DESC
        LIMIT $2
        `,
        [periodDays, safeLimit]
    );

    const countResult = await pool.query<EventCountRow>(
        `
        SELECT COUNT(*)::text as total
        FROM portal_user_activity
        WHERE occurred_at >= NOW() - ($1::text || ' days')::interval
        `,
        [periodDays]
    );

    return {
        events: eventsResult.rows.map((row) => ({
            id: row.id,
            occurredAt: row.occurred_at,
            eventType: row.event_type,
            userEmail: row.user_email,
            userName: row.user_name || row.user_email.split("@")[0],
            userRole: row.user_role,
            sessionId: row.portal_session_id,
            path: row.path,
            action: row.action,
            durationSeconds: row.duration_seconds,
            metadata: row.metadata || {},
            ipAddress: row.ip_address,
            userAgent: row.user_agent,
        })),
        total: toInt(countResult.rows[0]?.total),
    };
}
