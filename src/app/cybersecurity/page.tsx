import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { hasSessionMinimumRole } from "@/lib/session-role";
import { ENABLE_CYBERSECURITY } from "@/lib/feature-flags";
import { CybersecurityWorkspace } from "@/components/cybersecurity-workspace";

export default async function CybersecurityPage() {
  if (!ENABLE_CYBERSECURITY) {
    redirect("/");
  }

  const session = await getServerSession(authOptions);

  if (!session) {
    redirect("/");
  }

  if (!hasSessionMinimumRole(session, "admin")) {
    redirect("/?forbidden=admin");
  }

  return (
    <div className="container mx-auto py-8 space-y-8">
      <CybersecurityWorkspace />
    </div>
  );
}
