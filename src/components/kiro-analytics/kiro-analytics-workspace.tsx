"use client";

import { Sparkles } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { useI18n } from "@/lib/i18n";
import { ENABLE_KIRO_USER_ACTIVITY } from "@/lib/feature-flags";
import { KiroOverviewDashboard } from "./overview-dashboard";
import { KiroAiInsightsDashboard } from "./ai-insights-dashboard";
import { KiroUserActivityDashboard } from "./user-activity-dashboard";

export function KiroAnalyticsWorkspace() {
  const { t } = useI18n();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-500/10">
          <Sparkles className="h-5 w-5 text-violet-500" />
        </div>
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{t("kiroAnalytics.title", "Kiro Analytics")}</h1>
          <p className="text-sm text-muted-foreground">
            {t("kiroAnalytics.subtitle", "Analítica de uso de Kiro IDE: adopción, prompts clasificados y actividad.")}
          </p>
        </div>
      </div>

      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList>
          <TabsTrigger value="overview">{t("kiroAnalytics.tab.overview", "Resumen")}</TabsTrigger>
          <TabsTrigger value="ai-insights">{t("kiroAnalytics.tab.aiInsights", "AI Insights")}</TabsTrigger>
          {ENABLE_KIRO_USER_ACTIVITY && (
            <TabsTrigger value="user-activity">{t("kiroAnalytics.tab.userActivity", "Actividad por usuario")}</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="overview">
          <KiroOverviewDashboard />
        </TabsContent>
        <TabsContent value="ai-insights">
          <KiroAiInsightsDashboard />
        </TabsContent>
        {ENABLE_KIRO_USER_ACTIVITY && (
          <TabsContent value="user-activity">
            <KiroUserActivityDashboard />
          </TabsContent>
        )}
      </Tabs>
    </div>
  );
}
