import { NextResponse } from 'next/server'
import { getServerSession } from "next-auth/next"
import { authOptions } from "@/lib/auth";
import { getSessionRole } from "@/lib/session-role";
import { trackUserActivity } from "@/lib/user-activity";

export async function POST(req: Request) {
    try {
        const session = await getServerSession(authOptions)

        // Optional: Protect route
        if (!session?.user?.email) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
        }

        const role = getSessionRole(session);

        const body = await req.json()
        const webhookUrl = process.env.N8N_ONBOARDING_WEBHOOK

        if (!webhookUrl) {
            return NextResponse.json({ error: 'Webhook URL not configured' }, { status: 500 })
        }

        const res = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body)
        })

        if (!res.ok) {
            throw new Error(`n8n responded with ${res.status}`)
        }

        try {
            await trackUserActivity({
                eventType: "api_action",
                userEmail: session.user.email,
                userName: session.user.name || null,
                userRole: role,
                authSub: session.user.oid || null,
                path: "/api/user-onboarding",
                action: "user_onboarding_request",
                metadata: {
                    appName: typeof body?.app_name === "string" ? body.app_name : null,
                    targetGroupId: typeof body?.target_group_id === "string" ? body.target_group_id : null,
                },
            });
        } catch (trackError) {
            console.error("Failed to track user-onboarding activity:", trackError);
        }

        const data = await res.json()
        return NextResponse.json(data)
    } catch (error) {
        console.error('Proxy Error:', error)
        return NextResponse.json({ error: 'Failed to process request' }, { status: 500 })
    }
}
