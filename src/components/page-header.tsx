"use client";

import { usePathname } from "next/navigation";
import { Activity, DollarSign, GitBranch, Home, Play, Ticket, UserCog, Users, Zap } from "lucide-react";
import { useI18n } from "@/lib/i18n";

type PageMeta = {
  titleKey: string;
  descriptionKey: string;
  icon: React.ComponentType<{ className?: string }>;
};

const PAGE_MAP: Record<string, PageMeta> = {
  "/metrics": { titleKey: "page.metrics.title", descriptionKey: "page.metrics.description", icon: Activity },
  "/synthetics": { titleKey: "page.synthetics.title", descriptionKey: "page.synthetics.description", icon: Zap },
  "/finops": { titleKey: "page.finops.title", descriptionKey: "page.finops.description", icon: DollarSign },
  "/finops-athena": { titleKey: "page.finops.title", descriptionKey: "page.finops.description", icon: DollarSign },
  "/create-repo": { titleKey: "page.createRepo.title", descriptionKey: "page.createRepo.description", icon: GitBranch },
  "/user-onboarding": { titleKey: "page.onboarding.title", descriptionKey: "page.onboarding.description", icon: Users },
  "/admin": { titleKey: "page.admin.title", descriptionKey: "page.admin.description", icon: UserCog },
  "/automations": { titleKey: "page.automations.title", descriptionKey: "page.automations.description", icon: Play },
  "/jira": { titleKey: "page.jira.title", descriptionKey: "page.jira.description", icon: Ticket },
};

function resolvePageMeta(pathname: string): PageMeta | null {
  if (PAGE_MAP[pathname]) return PAGE_MAP[pathname];
  for (const [prefix, meta] of Object.entries(PAGE_MAP)) {
    if (pathname.startsWith(`${prefix}/`)) return meta;
  }
  return null;
}

export function PageHeader() {
  const pathname = usePathname();
  const meta = resolvePageMeta(pathname);
  const { t } = useI18n();

  if (!meta) return null;

  const Icon = meta.icon;

  return (
    <div className="border-b border-border/40 bg-background/60 backdrop-blur-sm px-6 py-4">
      <div className="flex items-center gap-3">
        <div className="rounded-xl bg-primary/8 p-2">
          <Icon className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="font-display text-lg font-semibold tracking-tight">{t(meta.titleKey)}</h1>
          <p className="text-xs text-muted-foreground">{t(meta.descriptionKey)}</p>
        </div>
      </div>
    </div>
  );
}
