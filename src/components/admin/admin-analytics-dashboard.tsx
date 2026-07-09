"use client";

import { useState } from "react";
import { RotateCcw } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { OverviewTab } from "@/components/admin/analytics/overview-tab";
import { EngagementTab } from "@/components/admin/analytics/engagement-tab";
import { TicketsTab } from "@/components/admin/analytics/tickets-tab";
import { ApprovalsTab } from "@/components/admin/analytics/approvals-tab";
import { AccessTab } from "@/components/admin/analytics/access-tab";
import { ReposTab } from "@/components/admin/analytics/repos-tab";
import { InfraTab } from "@/components/admin/analytics/infra-tab";

const TIME_RANGES = [
  { label: "7d", value: 7 },
  { label: "30d", value: 30 },
  { label: "90d", value: 90 },
  { label: "6m", value: 180 },
  { label: "1a", value: 365 },
] as const;

export function AdminAnalyticsDashboard() {
  const [days, setDays] = useState(30);
  const [refreshKey, setRefreshKey] = useState(0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Analytics del Portal</h1>
          <p className="text-sm text-muted-foreground">
            Métricas de uso, tickets, accesos e infraestructura
          </p>
        </div>

        <div className="flex items-center gap-2">
          {/* Time Range Selector */}
          <div className="flex items-center rounded-md border bg-muted/40 p-0.5">
            {TIME_RANGES.map((range) => (
              <button
                key={range.value}
                onClick={() => setDays(range.value)}
                className={`px-3 py-1 text-xs font-medium rounded-sm transition-colors ${
                  days === range.value
                    ? "bg-background text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {range.label}
              </button>
            ))}
          </div>

          {/* Refresh Button */}
          <Button
            variant="outline"
            size="icon"
            className="h-8 w-8"
            onClick={() => setRefreshKey((k) => k + 1)}
            title="Actualizar datos"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview" className="space-y-4">
        <TabsList className="flex flex-wrap h-auto gap-1">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="engagement">Engagement</TabsTrigger>
          <TabsTrigger value="tickets">Tickets</TabsTrigger>
          <TabsTrigger value="approvals">Aprobaciones</TabsTrigger>
          <TabsTrigger value="access">Accesos</TabsTrigger>
          <TabsTrigger value="repos">Repos</TabsTrigger>
          <TabsTrigger value="infra">Infra</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <OverviewTab days={days} refreshKey={refreshKey} />
        </TabsContent>
        <TabsContent value="engagement">
          <EngagementTab days={days} refreshKey={refreshKey} />
        </TabsContent>
        <TabsContent value="tickets">
          <TicketsTab days={days} refreshKey={refreshKey} />
        </TabsContent>
        <TabsContent value="approvals">
          <ApprovalsTab days={days} refreshKey={refreshKey} />
        </TabsContent>
        <TabsContent value="access">
          <AccessTab days={days} refreshKey={refreshKey} />
        </TabsContent>
        <TabsContent value="repos">
          <ReposTab days={days} refreshKey={refreshKey} />
        </TabsContent>
        <TabsContent value="infra">
          <InfraTab days={days} refreshKey={refreshKey} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
