export type ClientActivityPayload = {
    eventType: "session_start" | "session_end" | "page_view" | "feature_click" | "api_action";
    portalSessionId?: string;
    path?: string;
    action?: string;
    durationSeconds?: number;
    metadata?: Record<string, unknown>;
};

const endpoint = "/api/admin/activity/track";

export function trackClientActivity(payload: ClientActivityPayload, keepalive = false): void {
    const body = JSON.stringify(payload);

    if (keepalive && typeof navigator !== "undefined" && typeof navigator.sendBeacon === "function") {
        const blob = new Blob([body], { type: "application/json" });
        navigator.sendBeacon(endpoint, blob);
        return;
    }

    void fetch(endpoint, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body,
        keepalive,
    }).catch(() => {
        // Best-effort telemetry; ignore network failures on client side.
    });
}
