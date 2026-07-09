"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession, signOut } from "next-auth/react";
import {
  Activity,
  AlertTriangle,
  Bell,
  ChevronLeft,
  ClipboardList,
  DollarSign,
  GitBranch,
  Home,
  LogOut,
  Menu,
  MonitorCheck,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Ticket,
  UserCog,
  Users,
  Zap,
  Settings,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { AppRole, hasMinimumRole } from "@/lib/rbac";
import { BotonVolver } from "@/components/navigation/boton-volver";
import { DataFreshness } from "@/components/data-freshness";
import { PageHeader } from "@/components/page-header";
import { StaleDataBanner } from "@/components/stale-data-banner";
import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageSelector } from "@/components/language-selector";
import { useI18n } from "@/lib/i18n";
import { ENABLE_AUTOMATIONS, ENABLE_JIRA } from "@/lib/feature-flags";
import { NotificationBell } from "@/components/notification-bell";

type NavItem = {
  id: string;
  labelKey: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  minimumRole: AppRole;
  sectionKey?: string;
  hidden?: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { id: "home", labelKey: "nav.home", href: "/", icon: Home, minimumRole: "externos" },
  { id: "create-repo", labelKey: "nav.createRepo", href: "/create-repo", icon: GitBranch, minimumRole: "externos", sectionKey: "nav.section.selfservice" },
  { id: "access-management", labelKey: "nav.accessManagement", href: "/access-management", icon: ShieldCheck, minimumRole: "externos", sectionKey: "nav.section.selfservice" },
  { id: "infra-requests", labelKey: "nav.infraRequests", href: "/create-infra", icon: ClipboardList, minimumRole: "staff", sectionKey: "nav.section.selfservice" },
  { id: "incidents", labelKey: "nav.incidents", href: "/incidents", icon: AlertTriangle, minimumRole: "externos", sectionKey: "nav.section.selfservice" },
  { id: "requests", labelKey: "nav.requests", href: "/requests", icon: Ticket, minimumRole: "externos", sectionKey: "nav.section.selfservice" },
  { id: "metrics", labelKey: "nav.metrics", href: "/metrics", icon: Activity, minimumRole: "externos", sectionKey: "nav.section.engineering" },
  { id: "synthetics", labelKey: "nav.synthetics", href: "/synthetics", icon: Zap, minimumRole: "externos", sectionKey: "nav.section.engineering" },
  { id: "jira", labelKey: "nav.jira", href: "/jira", icon: MonitorCheck, minimumRole: "staff", sectionKey: "nav.section.engineering", hidden: !ENABLE_JIRA },
  { id: "finops", labelKey: "nav.finops", href: "/finops", icon: DollarSign, minimumRole: "desarrolladores", sectionKey: "nav.section.operations" },
  { id: "kiro-analytics", labelKey: "nav.kiroAnalytics", href: "/kiro-analytics", icon: Sparkles, minimumRole: "managers", sectionKey: "nav.section.operations" },
  { id: "automations", labelKey: "nav.automations", href: "/automations", icon: Zap, minimumRole: "admin", sectionKey: "nav.section.operations", hidden: !ENABLE_AUTOMATIONS },
  { id: "notifications", labelKey: "nav.notifications", href: "/infra-requests", icon: Bell, minimumRole: "managers", sectionKey: "nav.section.admin" },
  { id: "my-tickets", labelKey: "nav.myTickets", href: "/tickets", icon: Ticket, minimumRole: "externos", sectionKey: "nav.section.admin" },
  { id: "admin", labelKey: "nav.admin", href: "/admin", icon: UserCog, minimumRole: "admin", sectionKey: "nav.section.admin" },
];

export function PortalShell({ children }: { children: React.ReactNode }) {
  const { data: session } = useSession();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const { t } = useI18n();

  const role: AppRole = ((session?.user as any)?.appRole || "externos").toLowerCase() as AppRole;
  const userName = session?.user?.name?.split(" ")[0] || "Usuario";

  const visibleItems = NAV_ITEMS.filter((item) => !item.hidden && hasMinimumRole(role, item.minimumRole));

  // Group items by section
  const sections = new Map<string, NavItem[]>();
  for (const item of visibleItems) {
    const section = item.sectionKey || "";
    if (!sections.has(section)) sections.set(section, []);
    sections.get(section)!.push(item);
  }

  const isActive = (href: string) => {
    if (href === "/") return pathname === "/";
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex flex-col border-r border-border/70 bg-card/95 backdrop-blur transition-all duration-300",
          collapsed ? "w-[68px]" : "w-[240px]",
          mobileOpen ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        )}
      >
        {/* Logo area */}
        <div className={cn(
          "flex h-16 items-center border-b border-border/50 px-4",
          collapsed ? "justify-center" : "gap-3"
        )}>
          <img src="/logo.svg" alt="IskayPet" className="h-7 w-7 shrink-0" />
          {!collapsed && (
            <span className="font-display text-sm font-semibold tracking-tight text-foreground truncate">
              DevPortal
            </span>
          )}
        </div>

        {/* Search hint */}
        {!collapsed && (
          <div className="px-3 pt-3 pb-1">
            <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground/60 cursor-pointer hover:bg-muted/50 transition-colors"
                 onClick={() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}>
              <Search className="h-3 w-3" />
              <span className="flex-1">{t("nav.search")}</span>
              <kbd className="rounded border border-border/40 bg-background/60 px-1 py-0.5 text-[9px]">⌘K</kbd>
            </div>
          </div>
        )}

        {/* Navigation */}
        <nav className="flex-1 overflow-y-auto px-2 py-4 space-y-1">
          {[...sections.entries()].map(([section, items]) => (
            <div key={section || "root"}>
              {section && !collapsed && (
                <div className="px-3 pt-4 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground/70">
                  {t(section)}
                </div>
              )}
              {section && collapsed && <div className="my-2 mx-3 border-t border-border/40" />}
              {items.map((item) => {
                const active = isActive(item.href);
                return (
                  <Link
                    key={item.id}
                    href={item.href}
                    onClick={() => setMobileOpen(false)}
                    title={collapsed ? t(item.labelKey) : undefined}
                    className={cn(
                      "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                      active
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground hover:bg-secondary/80 hover:text-foreground"
                    )}
                  >
                    <item.icon className={cn("h-[18px] w-[18px] shrink-0", active && "text-primary")} />
                    {!collapsed && <span className="truncate">{t(item.labelKey)}</span>}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        {/* User + collapse */}
        <div className="border-t border-border/50 p-3 space-y-2">
          <DataFreshness collapsed={collapsed} />
          {!collapsed ? (
            <div className="flex items-center gap-2 px-1">
              <div className="h-7 w-7 rounded-full bg-primary/15 flex items-center justify-center text-xs font-semibold text-primary">
                {userName[0]}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-foreground truncate">{userName}</div>
                <div className="text-[10px] text-muted-foreground capitalize">{role}</div>
              </div>
              <NotificationBell />
              <button
                onClick={() => signOut({ callbackUrl: "/" })}
                className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
                title="Cerrar sesión"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-2">
              <NotificationBell collapsed />
            </div>
          )}
          <LanguageSelector collapsed={collapsed} />
          <ThemeToggle collapsed={collapsed} />
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="hidden lg:flex w-full items-center justify-center gap-2 rounded-lg py-1.5 text-xs text-muted-foreground hover:bg-secondary/80 transition-colors"
          >
            <ChevronLeft className={cn("h-3.5 w-3.5 transition-transform", collapsed && "rotate-180")} />
            {!collapsed && <span>{t("nav.collapse")}</span>}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main
        className={cn(
          "flex-1 overflow-y-auto transition-all duration-300",
          collapsed ? "lg:ml-[68px]" : "lg:ml-[240px]"
        )}
      >
        {/* Mobile header */}
        <div className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border/50 bg-background/80 backdrop-blur px-4 lg:hidden">
          <button
            onClick={() => setMobileOpen(true)}
            className="p-2 rounded-lg text-muted-foreground hover:bg-secondary/80"
          >
            <Menu className="h-5 w-5" />
          </button>
          <img src="/logo.svg" alt="IskayPet" className="h-6" />
          <span className="font-display text-sm font-semibold">DevPortal</span>
        </div>

        <div className="min-h-[calc(100vh-3.5rem)] lg:min-h-screen">
          <StaleDataBanner />
          {/* session-nav-hardening (D4): ancla única del Boton_Volver, junto al
              PageHeader y en posición idéntica en toda Pagina_Interna (R6.1, R6.7).
              PortalShell no se renderiza en "/" (STANDALONE_PATHS), garantizando
              cero botones de volver en la home (R6.2). */}
          <div className="px-6 pt-4">
            <BotonVolver />
          </div>
          <PageHeader />
          {children}
        </div>
      </main>
    </div>
  );
}
