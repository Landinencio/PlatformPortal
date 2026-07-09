/**
 * POST /api/access-management/portal-role
 *
 * Assigns a user to a portal role group in Azure AD.
 * No approval flow — direct execution by Admin/Directores.
 * Creates Jira ticket (auto-closed) + Teams notification for traceability.
 *
 * Rules:
 * - Only Admin and Directores can use this endpoint
 * - Directores can assign: Staff, Desarrolladores, Externos
 * - Admins can assign: all roles (Admin, Directores, Staff, Desarrolladores, Externos)
 */

import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import { graphClient } from "@/lib/graph-client";
import { roleFromTokenData, type AppRole } from "@/lib/rbac";
import { jiraCreateIssue, jiraTransitionToDone, jiraSetReporterByEmail } from "@/lib/jira";

const TEAMS_WEBHOOK_URL = process.env.TEAMS_WEBHOOK_URL || "";

/** Map role values to their Azure AD group IDs */
const PORTAL_ROLE_GROUPS: Record<string, { groupId: string; label: string }> = {
  Admin: { groupId: "21d068e7-f5b4-4594-b8a5-2812aab20984", label: "Admin" },
  Directores: { groupId: "a273419d-c768-4667-9624-b7822684ed27", label: "Directores" },
  Staff: { groupId: "ae7b9e18-f1a6-480f-8c96-842bf9da4c4f", label: "Staff" },
  Desarrolladores: { groupId: "a79abcc0-dae8-4ba3-b8e9-7da79db95a4f", label: "Desarrolladores" },
  Externos: { groupId: "fe12dcbb-6f2c-4da6-af08-bcfab93c7392", label: "Externos" },
};

/** Roles that Directores can assign */
const DIRECTORES_ASSIGNABLE = ["Staff", "Desarrolladores", "Externos"];

/** All roles (Admin can assign all) */
const ALL_ROLES = ["Admin", "Directores", "Staff", "Desarrolladores", "Externos"];

/* ------------------------------------------------------------------ */
/*  Helper: send Teams notification                                    */
/* ------------------------------------------------------------------ */

async function sendTeamsNotification(
  targetEmail: string,
  roleName: string,
  assignedBy: string,
): Promise<void> {
  if (!TEAMS_WEBHOOK_URL) return;

  const card = {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: {
          $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
          type: "AdaptiveCard",
          version: "1.4",
          msteams: { width: "Full" },
          body: [
            {
              type: "Container",
              items: [
                {
                  type: "TextBlock",
                  text: "🛡️ Gestión de Accesos — Portal",
                  weight: "Bolder",
                  size: "Medium",
                  color: "Accent",
                },
                {
                  type: "TextBlock",
                  text: "PORTAL",
                  weight: "Bolder",
                  size: "ExtraLarge",
                  spacing: "None",
                },
                {
                  type: "FactSet",
                  facts: [
                    { title: "Acción:", value: "Asignación de rol" },
                    { title: "Usuario:", value: targetEmail },
                    { title: "Rol:", value: roleName },
                    { title: "Asignado por:", value: assignedBy },
                    { title: "Estado:", value: "✅ Ejecutado (sin aprobación)" },
                  ],
                },
              ],
            },
          ],
        },
      },
    ],
  };

  try {
    await fetch(TEAMS_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
    });
  } catch (err) {
    console.error("[portal-role] Teams notification error:", err);
  }
}

/* ------------------------------------------------------------------ */
/*  GET — list assignable roles                                        */
/* ------------------------------------------------------------------ */

export async function GET(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const userRole = roleFromTokenData({
    appRole: (auth.session.user as any).appRole,
    roles: (auth.session.user as any).roles,
  });

  if (userRole !== "admin" && userRole !== "directores") {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const assignableRoles = userRole === "admin" ? ALL_ROLES : DIRECTORES_ASSIGNABLE;

  const groups = assignableRoles.map((role) => ({
    id: role,
    displayName: PORTAL_ROLE_GROUPS[role].label,
  }));

  return NextResponse.json({ groups });
}

/* ------------------------------------------------------------------ */
/*  POST — assign role (direct execution + Jira + Teams)               */
/* ------------------------------------------------------------------ */

export async function POST(request: Request) {
  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const userRole = roleFromTokenData({
    appRole: (auth.session.user as any).appRole,
    roles: (auth.session.user as any).roles,
  });

  if (userRole !== "admin" && userRole !== "directores") {
    return NextResponse.json({ error: "Insufficient permissions" }, { status: 403 });
  }

  const body = await request.json();
  const { targetUserEmail, role } = body as { targetUserEmail: string; role: string };

  if (!targetUserEmail || !role) {
    return NextResponse.json({ error: "targetUserEmail and role are required" }, { status: 400 });
  }

  // Check permission to assign this role
  const assignableRoles = userRole === "admin" ? ALL_ROLES : DIRECTORES_ASSIGNABLE;
  if (!assignableRoles.includes(role)) {
    return NextResponse.json(
      { error: `No tienes permiso para asignar el rol "${role}"` },
      { status: 403 }
    );
  }

  const roleConfig = PORTAL_ROLE_GROUPS[role];
  if (!roleConfig) {
    return NextResponse.json({ error: `Rol "${role}" no válido` }, { status: 400 });
  }

  const assignedByEmail = (auth.session.user as any).email || "unknown";

  try {
    // 1. Find user in Azure AD
    const user = await graphClient.findUserByEmail(targetUserEmail);

    // 2. Add user to the role group
    await graphClient.addUserToGroup(roleConfig.groupId, user.id);

    // 3. Create Jira ticket (non-blocking)
    try {
      const jiraSummary = `[Accesos] Portal — Rol ${roleConfig.label} — ${targetUserEmail}`;
      const jiraDescription = [
        `h2. Asignación de Rol en Portal`,
        ``,
        `||Campo||Valor||`,
        `|Plataforma|Portal|`,
        `|Usuario|${targetUserEmail}|`,
        `|Rol asignado|${roleConfig.label}|`,
        `|Asignado por|${assignedByEmail}|`,
        `|Aprobación|No requerida (ejecución directa)|`,
        `|Estado|Ejecutado|`,
        ``,
        `_Creado automáticamente desde el Portal de Plataforma._`,
      ].join("\n");

      const jiraResult = await jiraCreateIssue({
        projectKey: "SRE",
        issueTypeId: "10048",
        summary: jiraSummary,
        description: jiraDescription,
        labels: ["SRE", "portal", "portal-role"],
        reporterEmail: assignedByEmail,
      });

      // Fallback: ensure reporter is set via PUT (awaited)
      await jiraSetReporterByEmail(jiraResult.key, assignedByEmail);

      // Transition to Done immediately
      try {
        await jiraTransitionToDone(jiraResult.key);
      } catch (transErr) {
        console.error("[portal-role] Jira transition to Done failed:", transErr);
      }
    } catch (jiraErr) {
      console.error("[portal-role] Jira ticket creation failed (non-blocking):", jiraErr);
    }

    // 4. Send Teams notification (non-blocking)
    sendTeamsNotification(targetUserEmail, roleConfig.label, assignedByEmail).catch(() => {});

    return NextResponse.json({
      success: true,
      message: `Usuario ${user.displayName} (${targetUserEmail}) asignado al rol ${roleConfig.label}`,
      user: { id: user.id, displayName: user.displayName, email: targetUserEmail },
      role: roleConfig.label,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[portal-role] Error:", msg);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
