import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { NextResponse } from "next/server";
import { getSessionRole } from "@/lib/session-role";
import { trackUserActivity } from "@/lib/user-activity";
import { buildGitLabRepositoryCompliancePayload } from "@/lib/gitlab-governance";

export async function POST(req: Request) {
    const session = await getServerSession(authOptions);

    if (!session) {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    try {
        const role = getSessionRole(session);
        const body = await req.json();
        const { name, description, namespace_id, template, businessTeam } = body;
        const gitlabCompliance = buildGitLabRepositoryCompliancePayload();

        // Validate input (basic)
        if (!name || !namespace_id || !template || !businessTeam) {
            return NextResponse.json({ error: "Missing required fields (name, namespace_id, template, businessTeam)" }, { status: 400 });
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
                businessTeam,
                gitlabCompliance,
                timestamp: new Date().toISOString(),
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            console.error("n8n error:", text);
            return NextResponse.json({ error: "Failed to trigger automation" }, { status: 502 });
        }

        try {
            await trackUserActivity({
                eventType: "api_action",
                userEmail: session.user?.email || "unknown@unknown.local",
                userName: session.user?.name || null,
                userRole: role,
                authSub: session.user?.oid || null,
                path: "/api/create-repo",
                action: "create_repo_request",
                metadata: {
                    repository: name,
                    namespaceId: namespace_id,
                    template,
                    businessTeam,
                    branchNamingAdr: gitlabCompliance.adrId,
                    branchNameRegex: gitlabCompliance.branchNaming.regex,
                    deployStage: gitlabCompliance.dora.productionDeployStage,
                },
            });
        } catch (trackError) {
            console.error("Failed to track create-repo activity:", trackError);
        }

        const data = await response.json();
        return NextResponse.json({ success: true, data });

    } catch (error) {
        console.error("API Error:", error);
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
    }
}
