import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { hasSessionMinimumRole } from "@/lib/session-role";
import { KiroAnalyticsWorkspace } from "@/components/kiro-analytics/kiro-analytics-workspace";

// Kiro Analytics holds per-person productivity data → managers+ only.
const MIN_ROLE = "managers" as const;

export default async function KiroAnalyticsPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/");
  }

  if (!hasSessionMinimumRole(session, MIN_ROLE)) {
    redirect("/?forbidden=managers");
  }

  return (
    <div className="container mx-auto py-8">
      <KiroAnalyticsWorkspace />
    </div>
  );
}
