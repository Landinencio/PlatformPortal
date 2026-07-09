"use client";

import { useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Activity, ArrowRight, Brain, Boxes, DatabaseZap, DollarSign, Home, Network, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { CostsDashboard } from "@/components/finops/costs-dashboard";
import { AwsInventoryDashboard } from "@/components/inventory/aws-inventory-dashboard";
import { FinOpsAdvisorPage } from "@/components/inventory/finops-advisor-page";
import { EksCostDashboard } from "@/components/finops/eks-cost/eks-cost-dashboard";
import { FinOpsChatFloating } from "@/components/finops/finops-chat-floating";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type FinOpsTab = "costs" | "inventory" | "advisor" | "k8s";

const TAB_DEFS: {
  value: FinOpsTab;
  labelKey: string;
  titleKey: string;
  descKey: string;
  icon: typeof DollarSign;
}[] = [
  {
    value: "costs",
    labelKey: "finops.workspace.tabCosts",
    titleKey: "finops.workspace.tabCostsTitle",
    descKey: "finops.workspace.tabCostsDesc",
    icon: DollarSign,
  },
  {
    value: "inventory",
    labelKey: "finops.workspace.tabInventory",
    titleKey: "finops.workspace.tabInventoryTitle",
    descKey: "finops.workspace.tabInventoryDesc",
    icon: Boxes,
  },
  {
    value: "k8s",
    labelKey: "finops.workspace.tabK8s",
    titleKey: "finops.workspace.tabK8sTitle",
    descKey: "finops.workspace.tabK8sDesc",
    icon: Network,
  },
  {
    value: "advisor",
    labelKey: "finops.workspace.tabAdvisor",
    titleKey: "finops.workspace.tabAdvisorTitle",
    descKey: "finops.workspace.tabAdvisorDesc",
    icon: Brain,
  },
];

function isFinOpsTab(value: string | null): value is FinOpsTab {
  return value === "costs" || value === "inventory" || value === "advisor" || value === "k8s";
}

export function FinOpsWorkspace() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { t } = useI18n();

  const TABS = TAB_DEFS.map((tab) => ({
    ...tab,
    label: t(tab.labelKey),
    title: t(tab.titleKey),
    description: t(tab.descKey),
  }));

  const activeTab = useMemo<FinOpsTab>(() => {
    const rawTab = searchParams?.get("tab") || null;
    return isFinOpsTab(rawTab) ? rawTab : "costs";
  }, [searchParams]);

  const setActiveTab = (tab: string) => {
    if (!isFinOpsTab(tab)) return;
    const params = new URLSearchParams(searchParams?.toString());
    params.set("tab", tab);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const activeDefinition = TABS.find((item) => item.value === activeTab) || TABS[0];

  // Tab-aware suggestions for the floating chat
  const tabContext: Record<FinOpsTab, { hint: string; suggestions: string[] }> = {
    costs: {
      hint: "Vista: análisis de costes (CUR + Cost Explorer)",
      suggestions: [
        "Resumen del coste de este mes",
        "Top 5 servicios más caros",
        "Top 5 cuentas con más coste",
        "Compara este mes con el anterior",
        "Forecast para los próximos 3 meses",
        "Hay anomalías recientes?",
      ],
    },
    inventory: {
      hint: "Vista: inventario AWS",
      suggestions: [
        "Resumen del inventario (cuántas EC2/RDS/Lambda/S3)",
        "Recursos en EOL (Amazon Linux 2 + RDS engines)",
        "Cobertura Terraform por cuenta",
        "Recursos sin tags de negocio",
        "RDS sin Multi-AZ",
        "Busca todas las EBS sin adjuntar",
      ],
    },
    k8s: {
      hint: "Vista: EKS Allocation (nodo-céntrica)",
      suggestions: [
        "Qué entorno tiene más coste EKS este mes?",
        "Cuántos nodos de más hay en cada nodegroup?",
        "Top 5 squads por coste mensual",
        "Recomendaciones con más ahorro potencial",
        "Qué cobertura de spot tiene dp-prd?",
        "Workloads infra-provisionados con riesgo de OOM",
      ],
    },
    advisor: {
      hint: "Vista: Asesor FinOps",
      suggestions: [
        "Resume las oportunidades del último análisis",
        "Top 3 acciones inmediatas",
        "Qué cuenta tiene más ahorro potencial",
        "Hay candidatos a Graviton (m5→m6g, r5→r6g)?",
        "Estado de cobertura de Savings Plans",
      ],
    },
  };
  const ctx = tabContext[activeTab];

  return (
    <>
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-[32px] border border-border/60 bg-gradient-to-br from-card via-background to-card p-6 shadow-sm sm:p-8">
        <div className="absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_top_right,hsl(var(--primary)/0.12),transparent_55%)]" />
        <div className="relative space-y-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <Link
                href="/"
                className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                <Home className="h-4 w-4" />
                {t("finops.workspace.backToPortal")}
              </Link>
              <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-primary">
                <DatabaseZap className="h-3.5 w-3.5" />
                {t("finops.workspace.badge")}
              </div>
              <div className="space-y-2">
                <h1 className="text-4xl font-black tracking-tight text-foreground sm:text-5xl">
                  {t("finops.workspace.title")}
                </h1>
                <p className="max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">
                  {t("finops.workspace.description")}
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 lg:w-[460px]">
              <Card className="border-border/60 bg-card/80 shadow-none">
                <CardContent className="flex items-start gap-3 p-4">
                  <DollarSign className="mt-0.5 h-4 w-4 text-primary" />
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("finops.workspace.realCosts")}</div>
                    <div className="mt-1 text-sm font-medium text-foreground">{t("finops.workspace.realCostsDesc")}</div>
                  </div>
                </CardContent>
              </Card>
              <Card className="border-border/60 bg-card/80 shadow-none">
                <CardContent className="flex items-start gap-3 p-4">
                  <Boxes className="mt-0.5 h-4 w-4 text-info" />
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("finops.workspace.coverage")}</div>
                    <div className="mt-1 text-sm font-medium text-foreground">{t("finops.workspace.coverageDesc")}</div>
                  </div>
                </CardContent>
              </Card>
              <Card className="border-border/60 bg-card/80 shadow-none">
                <CardContent className="flex items-start gap-3 p-4">
                  <ShieldCheck className="mt-0.5 h-4 w-4 text-success" />
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t("finops.workspace.advisor")}</div>
                    <div className="mt-1 text-sm font-medium text-foreground">{t("finops.workspace.advisorDesc")}</div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-4">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              const isActive = tab.value === activeTab;
              return (
                <button
                  key={tab.value}
                  type="button"
                  onClick={() => setActiveTab(tab.value)}
                  className={cn(
                    "rounded-2xl border p-5 text-left transition-all duration-200",
                    isActive
                      ? "border-foreground/15 bg-card shadow-sm"
                      : "border-border/60 bg-card/60 hover:border-foreground/15 hover:bg-card/80",
                  )}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="space-y-2">
                      <div className="inline-flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-foreground">
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <div className="text-lg font-semibold text-foreground">{tab.title}</div>
                        <p className="mt-1 text-sm leading-6 text-muted-foreground">{tab.description}</p>
                      </div>
                    </div>
                    <ArrowRight className={cn("h-4 w-4 shrink-0 transition-transform", isActive && "translate-x-1")} />
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      </section>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-foreground">{activeDefinition.title}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{activeDefinition.description}</p>
          </div>
          <TabsList className="h-auto gap-1 rounded-2xl border border-border/60 bg-card p-1">
            {TABS.map((tab) => {
              const Icon = tab.icon;
              return (
                <TabsTrigger key={tab.value} value={tab.value} className="gap-2 rounded-xl px-4 py-2.5">
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </TabsTrigger>
              );
            })}
          </TabsList>
        </div>

        <TabsContent value="costs" className="space-y-4">
          <CostsDashboard />
        </TabsContent>

        <TabsContent value="inventory" className="space-y-4">
          <AwsInventoryDashboard embedded />
        </TabsContent>

        <TabsContent value="k8s" className="space-y-4">
          <EksCostDashboard />
        </TabsContent>

        <TabsContent value="advisor" className="space-y-4">
          <FinOpsAdvisorPage embedded />
        </TabsContent>
      </Tabs>

      <div className="flex items-center justify-between rounded-2xl border border-dashed border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        <span>
          {t("finops.workspace.legacyNote")}
        </span>
        <Link href="/finops?tab=advisor" className="inline-flex items-center gap-2 font-medium text-foreground hover:text-primary">
          {t("finops.workspace.goToAdvisor")}
          <Activity className="h-4 w-4" />
        </Link>
      </div>
    </div>
    <FinOpsChatFloating contextHint={ctx.hint} suggestions={ctx.suggestions} />
    </>
  );
}
