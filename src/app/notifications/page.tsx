import { redirect } from "next/navigation";

/**
 * Redirect to the unified requests/notifications page.
 * All notifications and approvals are now managed from /infra-requests.
 */
export default function NotificationsPage() {
  redirect("/infra-requests");
}
