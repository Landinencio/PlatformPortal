import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth"
import { NextResponse } from "next/server"

// This would be your n8n webhook URL
// Internal K8s Service URL for n8n
const N8N_INFRA_WEBHOOK_URL = "http://n8n.n8n.svc.cluster.local/webhook/create-infra"

export async function POST(req: Request) {
    const session = await getServerSession(authOptions)

    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    try {
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

        return NextResponse.json({ success: true, message: "Request forwarded to n8n" })

    } catch (error) {
        console.error("Error creating infra request:", error)
        return NextResponse.json(
            { error: "Failed to process request" },
            { status: 500 }
        )
    }
}
