import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth"
import { NextResponse } from "next/server"
import { getSessionRole } from "@/lib/session-role";
import { trackUserActivity } from "@/lib/user-activity";

// This would be your n8n webhook URL
// Internal K8s Service URL for n8n
const N8N_INFRA_WEBHOOK_URL = "http://n8n.n8n.svc.cluster.local/webhook/create-infra"

export async function POST(req: Request) {
    const session = await getServerSession(authOptions)

    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
        const role = getSessionRole(session);
        const body = await req.json()

        // Enrich with user metadata
        const payload = {
            ...body,
            requestor: session.user?.name,
            requestor_email: session.user?.email,
            timestamp: new Date().toISOString()
        }

        // Send to n8n
        const response = await fetch(N8N_INFRA_WEBHOOK_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        })

        if (!response.ok) {
            throw new Error(`n8n responded with ${response.status}: ${response.statusText}`)
        }

        console.log("Sent payload to n8n:", JSON.stringify(payload, null, 2))

        try {
            await trackUserActivity({
                eventType: "api_action",
                userEmail: session.user?.email || "unknown@unknown.local",
                userName: session.user?.name || null,
                userRole: role,
                authSub: session.user?.oid || null,
                path: "/api/create-infra",
                action: "create_infra_request",
                metadata: {
                    resourceType: typeof body?.resource_type === "string" ? body.resource_type : null,
                    project: typeof body?.project_name === "string" ? body.project_name : null,
                },
            });
        } catch (trackError) {
            console.error("Failed to track create-infra activity:", trackError);
        }

        return NextResponse.json({ success: true, message: "Request forwarded to n8n" })

    } catch (error) {
        console.error("Error creating infra request:", error)
        return NextResponse.json(
            { error: "Failed to process request" },
            { status: 500 }
        )
    }
}
