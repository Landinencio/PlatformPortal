"use client";

import { usePathname } from "next/navigation";
import { useSession } from "next-auth/react";
import { PortalShell } from "@/components/portal-shell";

/** Pages that render their own layout (no sidebar) */
const STANDALONE_PATHS = ["/"];

export function ConditionalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const { data: session, status } = useSession();

  const isStandalone = STANDALONE_PATHS.includes(pathname);
  const isAuthenticated = status === "authenticated" && !!session;

  if (isStandalone || !isAuthenticated) {
    return <>{children}</>;
  }

  return <PortalShell>{children}</PortalShell>;
}
