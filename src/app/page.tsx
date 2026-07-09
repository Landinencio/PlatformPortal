"use client"

import { Suspense } from "react";
import { useSession } from "next-auth/react"
import { LoginButton } from "@/components/login-button"
import { LogoutButton } from "@/components/logout-button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { GitBranch, Zap, Lock, Cloud, Shield, ShieldCheck, Users, DollarSign, Activity, UserCog, Play, Ticket, Bell, AlertTriangle, Sparkles } from "lucide-react"
import Link from "next/link"
import { cn } from "@/lib/utils"
import { AppRole } from "@/lib/rbac";
import { trackClientActivity } from "@/lib/activity-client";
import { ENABLE_AUTOMATIONS, ENABLE_JIRA } from "@/lib/feature-flags";
import { useSearchParams } from "next/navigation";
import type { ComponentType } from "react";

import { ThemeToggle } from "@/components/theme-toggle";
import { LanguageSelector } from "@/components/language-selector";
import { NotificationBell } from "@/components/notification-bell";
import { NewsSidebar } from "@/components/home/news-sidebar";
import { useI18n } from "@/lib/i18n";

type FeatureCard = {
  id: string;
  titleKey: string;
  descriptionKey: string;
  icon: ComponentType<{ className?: string }>;
  href: string;
  active: boolean;
  visibleFor: AppRole[];
  underConstruction?: boolean;
  sectionKey: string;
  hidden?: boolean;
};

function HomeContent() {
  const { data: session } = useSession()
  const searchParams = useSearchParams();
  const forbiddenRole = searchParams?.get("forbidden");
  const currentRole: AppRole = session?.user?.appRole || "externos";
  const { t } = useI18n();

  const features: FeatureCard[] = [
    {
      id: "create-repository",
      titleKey: "feature.createRepo.title",
      descriptionKey: "feature.createRepo.description",
      icon: GitBranch,
      href: "/create-repo",
      active: true,
      visibleFor: ["externos", "desarrolladores", "staff", "managers", "directores", "admin"],
      sectionKey: "nav.section.selfservice",
    },
    {
      id: "request-infrastructure",
      titleKey: "feature.infra.title",
      descriptionKey: "feature.infra.description",
      icon: Cloud,
      href: "/create-infra",
      active: true,
      visibleFor: ["externos", "desarrolladores", "staff", "managers", "directores", "admin"],
      sectionKey: "nav.section.selfservice",
    },
    {
      id: "access-management",
      titleKey: "feature.accessManagement.title",
      descriptionKey: "feature.accessManagement.description",
      icon: ShieldCheck,
      href: "/access-management",
      active: true,
      visibleFor: ["externos", "desarrolladores", "staff", "managers", "directores", "admin"],
      sectionKey: "nav.section.selfservice",
    },
    {
      id: "incidents",
      titleKey: "feature.incidents.title",
      descriptionKey: "feature.incidents.description",
      icon: AlertTriangle,
      href: "/incidents",
      active: true,
      visibleFor: ["externos", "desarrolladores", "staff", "managers", "directores", "admin"],
      sectionKey: "nav.section.selfservice",
    },
    {
      id: "requests",
      titleKey: "feature.requests.title",
      descriptionKey: "feature.requests.description",
      icon: Ticket,
      href: "/requests",
      active: true,
      visibleFor: ["externos", "desarrolladores", "staff", "managers", "directores", "admin"],
      sectionKey: "nav.section.selfservice",
    },
    {
      id: "dora-metrics",
      titleKey: "feature.dora.title",
      descriptionKey: "feature.dora.description",
      icon: Activity,
      href: "/metrics",
      active: true,
      visibleFor: ["externos", "desarrolladores", "staff", "managers", "directores", "admin"],
      sectionKey: "nav.section.engineering",
    },
    {
      id: "synthetic-monitoring",
      titleKey: "feature.synthetics.title",
      descriptionKey: "feature.synthetics.description",
      icon: Zap,
      href: "/synthetics",
      active: true,
      visibleFor: ["externos", "desarrolladores", "staff", "managers", "directores", "admin"],
      sectionKey: "nav.section.engineering",
    },
    {
      id: "jira-dashboard",
      titleKey: "feature.jira.title",
      descriptionKey: "feature.jira.description",
      icon: Ticket,
      href: "/jira",
      active: true,
      visibleFor: ["staff", "managers", "directores", "admin"],
      sectionKey: "nav.section.engineering",
      hidden: !ENABLE_JIRA,
    },
    {
      id: "finops-analytics",
      titleKey: "feature.finops.title",
      descriptionKey: "feature.finops.description",
      icon: DollarSign,
      href: "/finops",
      active: true,
      visibleFor: ["desarrolladores", "staff", "managers", "directores", "admin"],
      sectionKey: "nav.section.operations",
    },
    {
      id: "kiro-analytics",
      titleKey: "feature.kiroAnalytics.title",
      descriptionKey: "feature.kiroAnalytics.description",
      icon: Sparkles,
      href: "/kiro-analytics",
      active: true,
      visibleFor: ["managers", "directores", "admin"],
      sectionKey: "nav.section.operations",
    },
    {
      id: "automations",
      titleKey: "feature.automations.title",
      descriptionKey: "feature.automations.description",
      icon: Play,
      href: "/automations",
      active: true,
      visibleFor: ["admin"],
      sectionKey: "nav.section.operations",
      hidden: !ENABLE_AUTOMATIONS,
    },
    {
      id: "admin-activity",
      titleKey: "feature.admin.title",
      descriptionKey: "feature.admin.description",
      icon: UserCog,
      href: "/admin",
      active: true,
      visibleFor: ["admin"],
      sectionKey: "nav.section.admin",
    },
    {
      id: "notifications",
      titleKey: "feature.notifications.title",
      descriptionKey: "feature.notifications.description",
      icon: Bell,
      href: "/infra-requests",
      active: true,
      visibleFor: ["externos", "desarrolladores", "staff", "managers", "directores", "admin"],
      sectionKey: "nav.section.admin",
    },
    {
      id: "my-tickets",
      titleKey: "feature.myTickets.title",
      descriptionKey: "feature.myTickets.description",
      icon: Ticket,
      href: "/tickets",
      active: true,
      visibleFor: ["externos", "desarrolladores", "staff", "managers", "directores", "admin"],
      sectionKey: "nav.section.admin",
    },
  ]

  const visibleFeatures = features.filter((feature) => !feature.hidden && feature.visibleFor.includes(currentRole));
  const isAdmin = currentRole === "admin";

  return (
    <div className={cn("w-full space-y-8", isAdmin && session ? "max-w-7xl" : "max-w-5xl")}>
      {/* Header Section */}
      <div className="text-center space-y-4">
        <div className="flex justify-center mb-6">
          <img src="/logo.svg" alt="IskayPet Logo" className="h-16" />
        </div>
        <h1 className="text-4xl font-bold tracking-tight text-foreground">
          {t("app.title")}
        </h1>

        {!session ? (
          <div className="mt-8 flex justify-center">
              <Card className="w-full max-w-md bg-card border-border/70 shadow-md">
              <CardHeader>
                <div className="w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mx-auto mb-4">
                  <Lock className="w-6 h-6 text-primary" />
                </div>
                <CardTitle>{t("app.login.title")}</CardTitle>
                <CardDescription>
                  {t("app.login.description")}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <LoginButton />
              </CardContent>
            </Card>
          </div>
        ) : (
            <div className="space-y-2">
            <div className="flex justify-between items-center max-w-2xl mx-auto">
              <p className="text-xl text-muted-foreground">
                {t("app.greeting")} <span className="font-semibold text-foreground">{session.user?.name?.split(" ")[0]}.</span>
              </p>
              <span className="text-xs font-medium px-2 py-1 rounded-full bg-primary/10 text-primary capitalize">
                {currentRole}
              </span>
              <LogoutButton />
            </div>
            <p className="text-muted-foreground max-w-2xl mx-auto pt-2">
              {t("app.subtitle")}
            </p>
            {forbiddenRole && (
              <p className="text-sm text-amber-700 max-w-2xl mx-auto bg-amber-50 border border-amber-200 rounded-md p-3">
                {t("app.forbidden")} <span className="font-semibold">{forbiddenRole}</span>.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Dashboard — grouped by section, with admin-only AWS news sidebar */}
      {session && (
        <div className={cn("mt-8", isAdmin && "lg:grid lg:grid-cols-[minmax(0,1fr)_320px] lg:gap-6 lg:items-start")}>
          <div className="space-y-8">
            {(() => {
              const sections = new Map<string, FeatureCard[]>();
              for (const f of visibleFeatures) {
                if (!sections.has(f.sectionKey)) sections.set(f.sectionKey, []);
                sections.get(f.sectionKey)!.push(f);
              }
              return [...sections.entries()].map(([sectionKey, items]) => (
                <div key={sectionKey}>
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground/70 mb-3 px-1">
                    {t(sectionKey)}
                  </div>
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                    {items.map((feature) => {
                      const isBlocked = feature.underConstruction && currentRole !== "admin";
                      return (
                        <Link
                          key={feature.id}
                          href={feature.active && !isBlocked ? feature.href : "#"}
                          className={cn(
                            "block transition-all duration-200",
                            isBlocked ? "cursor-not-allowed" : feature.active ? "hover:scale-[1.02] cursor-pointer" : "cursor-not-allowed opacity-60 grayscale-[0.5]"
                          )}
                          onClick={(e) => {
                            if (isBlocked || !feature.active) { e.preventDefault(); return; }
                            trackClientActivity({
                              eventType: "feature_click",
                              action: `open_feature:${feature.id}`,
                              path: feature.href,
                              metadata: { active: feature.active, role: currentRole },
                            });
                          }}
                        >
                          <Card className={cn(
                            "h-full border-border/70 hover:border-primary/40 hover:shadow-md transition-all duration-300 bg-card",
                            isBlocked && "opacity-75"
                          )}>
                            <CardContent className="flex items-start gap-4 p-5">
                              <div className="shrink-0 rounded-xl bg-primary/10 p-2.5">
                                <feature.icon className="h-5 w-5 text-primary" />
                              </div>
                              <div className="min-w-0 space-y-1">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-semibold text-foreground">{t(feature.titleKey)}</span>
                                  {!feature.active && (
                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
                                      {t("common.comingSoon")}
                                    </span>
                                  )}
                                </div>
                                <p className="text-xs leading-5 text-muted-foreground line-clamp-2">
                                  {t(feature.descriptionKey)}
                                </p>
                              </div>
                            </CardContent>
                          </Card>
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ));
            })()}
          </div>

          {/* Admin-only sidebar (renders null for non-admins via its own client gate) */}
          {isAdmin && (
            <aside className="mt-8 lg:mt-0">
              <NewsSidebar />
            </aside>
          )}
        </div>
      )}
    </div>
  )
}

export default function Home() {
  return (
    <main className="min-h-screen flex flex-col items-center p-8 md:p-24 relative">
      <div className="fixed top-4 right-4 z-50 flex items-center gap-2">
        <NotificationBell />
        <LanguageSelector collapsed />
        <ThemeToggle collapsed />
      </div>
      <Suspense fallback={<div>Cargando panel...</div>}>
        <HomeContent />
      </Suspense>
    </main>
  );
}
