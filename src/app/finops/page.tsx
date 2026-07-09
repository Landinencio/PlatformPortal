import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { hasSessionMinimumRole } from "@/lib/session-role";
import { FinOpsWorkspace } from "@/components/finops-workspace";

export default async function FinOpsPage() {
  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/");
  }

  if (!hasSessionMinimumRole(session, "desarrolladores")) {
    redirect("/?forbidden=editor");
  }

  return (
    <div className="container mx-auto py-8 space-y-8">
      <FinOpsWorkspace />
    </div>
  );
}
