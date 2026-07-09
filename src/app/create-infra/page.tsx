import { getServerSession } from "next-auth"
import { redirect } from "next/navigation"
import { authOptions } from "@/lib/auth"
import { repoCatalog } from "@/lib/repo-catalog"
import pool from "@/lib/db"
import { InfraPageClient } from "@/components/infra-request-v2/infra-page-client"

export default async function CreateInfraPage() {
  const session = await getServerSession(authOptions)

  if (!session) {
    redirect("/")
  }

  const allEntries = await repoCatalog.getAll()
  const teams = [...new Set(allEntries.filter((e) => e.active).map((e) => e.team))]

  // Fetch user's 5 most recent infra requests
  const userEmail = session.user?.email?.toLowerCase() || ""
  let recentRequests: { id: number; resource_type: string; team: string; status: string; created_at: string }[] = []
  try {
    const { rows } = await pool.query(
      `SELECT id, resource_type, team, status, created_at
       FROM infra_requests
       WHERE LOWER(requestor_email) = $1
       ORDER BY created_at DESC
       LIMIT 5`,
      [userEmail]
    )
    recentRequests = rows
  } catch (err) {
    console.error("[create-infra] Failed to fetch recent requests:", err)
  }

  return <InfraPageClient teams={teams} recentRequests={recentRequests} />
}
