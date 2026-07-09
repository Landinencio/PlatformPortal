import { redirect } from "next/navigation"

/**
 * Redirect to the unified infra page.
 * The modify functionality is now integrated into /create-infra with a toggle.
 */
export default function ModifyInfraPage() {
  redirect("/create-infra")
}
