"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  Activity,
  DollarSign,
  GitBranch,
  Home,
  Search,
  UserCog,
  Users,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AppRole, hasMinimumRole } from "@/lib/rbac";
import { useI18n } from "@/lib/i18n";
import { ENABLE_AUTOMATIONS, ENABLE_JIRA } from "@/lib/feature-flags";

type CommandItem = {
  id: string;
  labelKey: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  minimumRole: AppRole;
  keywords: string[];
  hidden?: boolean;
};

const COMMANDS: CommandItem[] = [
  { id: "home", labelKey: "nav.home", href: "/", icon: Home, minimumRole: "externos", keywords: ["home", "inicio", "portal"] },
  { id: "metrics", labelKey: "nav.metrics", href: "/metrics", icon: Activity, minimumRole: "desarrolladores", keywords: ["dora", "metricas", "deploy", "lead time"] },
  { id: "synthetics", labelKey: "nav.synthetics", href: "/synthetics", icon: Zap, minimumRole: "desarrolladores", keywords: ["monitor", "sinteticos", "uptime", "ssl"] },
  { id: "jira", labelKey: "nav.jira", href: "/jira", icon: Zap, minimumRole: "desarrolladores", keywords: ["jira", "tickets", "issues", "backlog", "sprint"], hidden: !ENABLE_JIRA },
  { id: "finops", labelKey: "nav.finops", href: "/finops", icon: DollarSign, minimumRole: "desarrolladores", keywords: ["costes", "aws", "finops", "billing"] },
  { id: "automations", labelKey: "nav.automations", href: "/automations", icon: Zap, minimumRole: "admin", keywords: ["automatizaciones", "awx", "ansible", "playbook", "n8n"], hidden: !ENABLE_AUTOMATIONS },
  { id: "create-repo", labelKey: "nav.createRepo", href: "/create-repo", icon: GitBranch, minimumRole: "externos", keywords: ["repo", "gitlab", "crear"] },
  { id: "onboarding", labelKey: "nav.onboarding", href: "/user-onboarding", icon: Users, minimumRole: "desarrolladores", keywords: ["altas", "accesos", "onboarding"] },
  { id: "admin", labelKey: "nav.admin", href: "/admin", icon: UserCog, minimumRole: "admin", keywords: ["admin", "actividad", "sesiones"] },
];

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const router = useRouter();
  const { data: session } = useSession();
  const role: AppRole = (session?.user as any)?.appRole || "externos";
  const { t } = useI18n();

  const visibleCommands = COMMANDS.filter((cmd) => !cmd.hidden && hasMinimumRole(role, cmd.minimumRole));

  const filtered = query.trim()
    ? visibleCommands.filter((cmd) => {
        const q = query.toLowerCase();
        const label = t(cmd.labelKey).toLowerCase();
        return (
          label.includes(q) ||
          cmd.keywords.some((kw) => kw.includes(q))
        );
      })
    : visibleCommands;

  const handleSelect = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery("");
      router.push(href);
    },
    [router]
  );

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
      if (e.key === "Escape") {
        setOpen(false);
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center pt-[20vh]">
      <div className="fixed inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setOpen(false)} />
      <div className="relative w-full max-w-md rounded-2xl border border-border/70 bg-card shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
        <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3">
          <Search className="h-4 w-4 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("nav.search")}
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
          <kbd className="hidden sm:inline-flex items-center gap-0.5 rounded-md border border-border/50 bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
            ESC
          </kbd>
        </div>
        <div className="max-h-64 overflow-y-auto p-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted-foreground">
              {t("common.noData")}
            </div>
          ) : (
            filtered.map((cmd) => (
              <button
                key={cmd.id}
                onClick={() => handleSelect(cmd.href)}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-sm text-foreground hover:bg-primary/8 transition-colors"
              >
                <cmd.icon className="h-4 w-4 text-muted-foreground" />
                <span>{t(cmd.labelKey)}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
