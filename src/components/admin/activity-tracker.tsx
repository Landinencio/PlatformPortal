"use client";

import { useEffect, useRef } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { trackClientActivity } from "@/lib/activity-client";

const SESSION_ID_KEY = "portal.activity.session.id";
const SESSION_START_KEY = "portal.activity.session.start";
const SESSION_STARTED_SENT_PREFIX = "portal.activity.session.start.sent.";

const buildPathWithQuery = (pathname: string, query: string): string =>
    query ? `${pathname}?${query}` : pathname;

const ensureSessionId = (): string => {
    if (typeof window === "undefined") return "";
    const existing = window.sessionStorage.getItem(SESSION_ID_KEY);
    if (existing) return existing;

    const generated = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    window.sessionStorage.setItem(SESSION_ID_KEY, generated);
    return generated;
};

const ensureSessionStart = (): number => {
    if (typeof window === "undefined") return Date.now();
    const existing = Number(window.sessionStorage.getItem(SESSION_START_KEY) || "");
    if (Number.isFinite(existing) && existing > 0) {
        return existing;
    }

    const now = Date.now();
    window.sessionStorage.setItem(SESSION_START_KEY, String(now));
    return now;
};

export function ActivityTracker() {
    const { data: session, status } = useSession();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const lastTrackedPath = useRef<string>("");
    const endSentRef = useRef<boolean>(false);

    useEffect(() => {
        if (status !== "authenticated" || !session?.user?.email) return;

        const sessionId = ensureSessionId();
        ensureSessionStart();

        const startFlagKey = `${SESSION_STARTED_SENT_PREFIX}${sessionId}`;
        const hasSentStart = window.sessionStorage.getItem(startFlagKey) === "1";
        if (!hasSentStart) {
            trackClientActivity({
                eventType: "session_start",
                portalSessionId: sessionId,
                path: pathname || "/",
                metadata: {
                    role: session.user.appRole,
                },
            });
            window.sessionStorage.setItem(startFlagKey, "1");
        }
    }, [pathname, session?.user?.appRole, session?.user?.email, status]);

    useEffect(() => {
        if (status !== "authenticated" || !session?.user?.email) return;

        const sessionId = ensureSessionId();
        const query = searchParams?.toString() || "";
        const fullPath = buildPathWithQuery(pathname || "/", query);

        if (lastTrackedPath.current === fullPath) return;
        lastTrackedPath.current = fullPath;

        trackClientActivity({
            eventType: "page_view",
            portalSessionId: sessionId,
            path: fullPath,
            metadata: {
                role: session.user.appRole,
            },
        });
    }, [pathname, searchParams, session?.user?.appRole, session?.user?.email, status]);

    useEffect(() => {
        if (status !== "authenticated" || !session?.user?.email) return;

        const onSessionEnd = () => {
            if (endSentRef.current) return;
            endSentRef.current = true;

            const sessionId = ensureSessionId();
            const startedAt = ensureSessionStart();
            const durationSeconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
            const query = window.location.search.startsWith("?")
                ? window.location.search.slice(1)
                : window.location.search;

            trackClientActivity(
                {
                    eventType: "session_end",
                    portalSessionId: sessionId,
                    path: buildPathWithQuery(window.location.pathname, query),
                    durationSeconds,
                    metadata: {
                        role: session.user.appRole,
                    },
                },
                true
            );
        };

        window.addEventListener("pagehide", onSessionEnd);
        window.addEventListener("beforeunload", onSessionEnd);

        return () => {
            window.removeEventListener("pagehide", onSessionEnd);
            window.removeEventListener("beforeunload", onSessionEnd);
        };
    }, [session?.user?.appRole, session?.user?.email, status]);

    return null;
}
