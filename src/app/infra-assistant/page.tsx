import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { repoCatalog } from "@/lib/repo-catalog";
import { InfraAssistantClient } from "./client";

// Hardcoded approver list — can be made dynamic later
const APPROVERS = [
  { email: "platform-lead@iskaypet.com", name: "Platform Lead" },
  { email: "sre-lead@iskaypet.com", name: "SRE Lead" },
];

export default async function InfraAssistantPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/");
  }

  // Fetch active teams from repo_catalog
  const allEntries = await repoCatalog.getAll();
  const teams = allEntries
    .filter((e) => e.active)
    .map((e) => e.team);

  return (
    <InfraAssistantClient
      teams={teams}
      approvers={APPROVERS}
      userEmail={session.user?.email ?? ""}
    />
  );
}
