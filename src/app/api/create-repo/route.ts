import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const body = await req.json();
        const { name, description, namespace_id, template } = body;

        // Validate input (basic)
        if (!name || !namespace_id || !template) {
            return NextResponse.json({ error: "Missing required fields (name, namespace_id, template)" }, { status: 400 });
        }

        const n8nUrl = process.env.N8N_WEBHOOK_URL;
        if (!n8nUrl) {
            console.error("N8N_WEBHOOK_URL is not defined");
            return NextResponse.json({ error: "Internal Server Error: Webhook configuration missing" }, { status: 500 });
        }

        // Forward to n8n
        const response = await fetch(n8nUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                userEmail: session.user?.email,
                userName: session.user?.name,
                name,
                description,
                namespace_id,
                template,
                timestamp: new Date().toISOString(),
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            console.error("n8n error:", text);
            return NextResponse.json({ error: "Failed to trigger automation" }, { status: 502 });
        }

        const data = await response.json();
        return NextResponse.json({ success: true, data });

    } catch (error) {
        console.error("API Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
