"use client";

import { PortalShell } from "@/components/portal-shell";
import { InfraRequestsDashboard } from "@/components/infra-requests/infra-requests-dashboard";

export default function InfraRequestsPage() {
  return (
    <PortalShell>
      <div className="p-6 md:p-10 max-w-6xl mx-auto">
        <InfraRequestsDashboard />
      </div>
    </PortalShell>
  );
}
