import { getServerSession } from "next-auth";
import { NextResponse } from "next/server";
import { authOptions } from "@/lib/auth";
import { fetchAwsAccountCatalog } from "@/lib/aws-account-catalog";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }

    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "desarrolladores")) {
      return NextResponse.json({ error: "Editor access required for FinOps" }, { status: 403 });
    }

    const accounts = await fetchAwsAccountCatalog();
    return NextResponse.json({ accounts, count: accounts.length });
  } catch (error) {
    console.error("Error fetching AWS account catalog:", error);
    return NextResponse.json(
      { error: "Failed to fetch AWS account catalog" },
      { status: 500 },
    );
  }
}
