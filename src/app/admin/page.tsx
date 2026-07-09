import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { hasSessionMinimumRole } from "@/lib/session-role";
import { AdminAnalyticsDashboard } from "@/components/admin/admin-analytics-dashboard";

export default async function AdminPage() {
    const session = await getServerSession(authOptions);

    if (!session) {
        redirect("/");
    }

    if (!hasSessionMinimumRole(session, "admin")) {
        redirect("/");
    }

    return (
        <div className="p-6">
            <AdminAnalyticsDashboard />
        </div>
    );
}
