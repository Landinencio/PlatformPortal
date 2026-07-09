"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Home,
  Sparkles,
  Play,
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Server,
  Shield,
  DollarSign,
  Terminal,
  ShoppingCart,
  Workflow,
  ExternalLink,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

type AwxTemplate = {
  id: number;
  name: string;
  description: string;
  project: string;
  inventory: string;
  status: string;
  lastRun: string | null;
  surveyEnabled: boolean;
  askVariables: boolean;
  askLimit: boolean;
};

type GroupConfig = {
  key: string;
  labelKey: string;
  descKey: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  filter: (t: AwxTemplate) => boolean;
};

const AWX_GROUPS: GroupConfig[] = [
  {
    key: "finops",
    labelKey: "auto.group.finops",
    descKey: "auto.group.finopsDesc",
    icon: DollarSign,
    color: "text-success",
    filter: (t) => t.project === "AWS-FinOps",
  },
  {
    key: "stores",
    labelKey: "auto.group.stores",
    descKey: "auto.group.storesDesc",
    icon: Server,
    color: "text-info",
    filter: (t) => t.project === "Soporte Tiendas",
  },
  {
    key: "oms",
    labelKey: "auto.group.oms",
    descKey: "auto.group.omsDesc",
    icon: ShoppingCart,
    color: "text-warning",
    filter: (t) => t.project === "OMS",
  },
  {
    key: "comerzzia",
    labelKey: "auto.group.comerzzia",
    descKey: "auto.group.comerzziaDesc",
    icon: Terminal,
    color: "text-primary",
    filter: (t) => t.project === "Comerzzia",
  },
  {
    key: "other",
    labelKey: "auto.group.other",
    descKey: "auto.group.otherDesc",
    icon: Workflow,
    color: "text-muted-foreground",
    filter: (t) =>
      !["AWS-FinOps", "Soporte Tiendas", "OMS", "Comerzzia", "Demo Project"].includes(t.project),
  },
];

const CYBER_WORKFLOWS = [
  { id: "cyber-inactive-users", labelKey: "auto.cyber.inactiveUsers", descKey: "auto.cyber.inactiveUsersDesc" },
  { id: "cyber-mfa-users", labelKey: "auto.cyber.mfaUsers", descKey: "auto.cyber.mfaUsersDesc" },
  { id: "cyber-vpn-groups", labelKey: "auto.cyber.vpnGroups", descKey: "auto.cyber.vpnGroupsDesc" },
];

function statusIcon(status: string) {
  if (status === "successful") return <CheckCircle2 className="h-3.5 w-3.5 text-success" />;
  if (status === "failed") return <XCircle className="h-3.5 w-3.5 text-danger" />;
  if (status === "running") return <Loader2 className="h-3.5 w-3.5 text-info animate-spin" />;
  return <Clock className="h-3.5 w-3.5 text-muted-foreground" />;
}

function statusBadgeClass(status: string) {
  if (status === "successful") return "bg-success/12 text-success border-success/25";
  if (status === "failed") return "bg-danger/12 text-danger border-danger/25";
  if (status === "running") return "bg-info/12 text-info border-info/25";
  return "bg-muted/50 text-muted-foreground border-border/50";
}

export function AutomationsWorkspace() {
  const { t } = useI18n();
  const [templates, setTemplates] = useState<AwxTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set(["finops", "cyber"]));
  const [launching, setLaunching] = useState<number | string | null>(null);
  const [lastResult, setLastResult] = useState<{ id: number | string; success: boolean; message: string } | null>(null);

  useEffect(() => {
    fetchTemplates();
  }, []);

  async function fetchTemplates() {
    try {
      setLoading(true);
      const res = await fetch("/api/automations/awx");
      if (!res.ok) {
        console.warn(`AWX API returned ${res.status} — showing n8n workflows only`);
        setTemplates([]);
        return;
      }
      const data = await res.json();
      setTemplates(data.templates || []);
    } catch (err) {
      console.warn("AWX not reachable — showing n8n workflows only", err);
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }

  async function launchAwx(templateId: number) {
    setLaunching(templateId);
    setLastResult(null);
    try {
      const res = await fetch("/api/automations/awx", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ templateId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Launch failed");
      setLastResult({ id: templateId, success: true, message: `Job #${data.jobId} ${t("auto.launched")}` });
    } catch (err) {
      setLastResult({ id: templateId, success: false, message: err instanceof Error ? err.message : "Error" });
    } finally {
      setLaunching(null);
    }
  }

  async function launchN8n(workflowId: string) {
    setLaunching(workflowId);
    setLastResult(null);
    try {
      const res = await fetch("/api/automations/n8n", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workflowId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Trigger failed");
      setLastResult({ id: workflowId, success: true, message: t("auto.triggered") });
    } catch (err) {
      setLastResult({ id: workflowId, success: false, message: err instanceof Error ? err.message : "Error" });
    } finally {
      setLaunching(null);
    }
  }

  function toggleGroup(key: string) {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  return (
    <div className="relative min-h-screen px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-6">
        {/* Header */}
        <Card className="overflow-hidden border-border/70 bg-card/90 shadow-[0_24px_70px_-40px_rgba(75,42,19,0.35)] backdrop-blur">
          <CardContent className="p-0">
            <div className="space-y-4 p-6 sm:p-8">
              <Link href="/" className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
                <Home className="h-4 w-4" />
                {t("eng.backToPortal")}
              </Link>
              <div className="space-y-3">
                <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                  <Sparkles className="h-3.5 w-3.5" />
                  {t("auto.badge")}
                </div>
                <div>
                  <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">{t("auto.title")}</h1>
                  <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">{t("auto.description")}</p>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}

        {error && (
          <div className="rounded-xl border border-danger/30 bg-danger/10 p-4 text-sm text-danger">{error}</div>
        )}

        {!loading && !error && (
          <div className="space-y-4">
            {/* Cybersecurity group */}
            <Card className="border-border/70 bg-card/85">
              <button className="flex w-full items-center justify-between p-5 text-left" onClick={() => toggleGroup("cyber")}>
                <div className="flex items-center gap-3">
                  <Shield className="h-5 w-5 text-danger" />
                  <div>
                    <div className="text-base font-semibold">{t("auto.group.cyber")}</div>
                    <div className="text-xs text-muted-foreground">{t("auto.group.cyberDesc")}</div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{CYBER_WORKFLOWS.length}</Badge>
                  {expandedGroups.has("cyber") ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                </div>
              </button>
              {expandedGroups.has("cyber") && (
                <CardContent className="border-t border-border/50 pt-4">
                  <div className="grid gap-3 md:grid-cols-3">
                    {CYBER_WORKFLOWS.map((wf) => (
                      <div key={wf.id} className="rounded-2xl border border-border/70 bg-background/80 p-4 space-y-3">
                        <div>
                          <div className="text-sm font-semibold">{t(wf.labelKey)}</div>
                          <div className="mt-1 text-xs text-muted-foreground">{t(wf.descKey)}</div>
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            size="sm"
                            className="gap-2"
                            disabled={launching === wf.id}
                            onClick={() => launchN8n(wf.id)}
                          >
                            {launching === wf.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                            {t("auto.run")}
                          </Button>
                          {lastResult?.id === wf.id && (
                            <span className={cn("text-xs", lastResult.success ? "text-success" : "text-danger")}>
                              {lastResult.message}
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </CardContent>
              )}
            </Card>

            {/* AWX groups */}
            {AWX_GROUPS.map((group) => {
              const groupTemplates = templates.filter(group.filter);
              if (groupTemplates.length === 0) return null;
              const isExpanded = expandedGroups.has(group.key);

              return (
                <Card key={group.key} className="border-border/70 bg-card/85">
                  <button className="flex w-full items-center justify-between p-5 text-left" onClick={() => toggleGroup(group.key)}>
                    <div className="flex items-center gap-3">
                      <group.icon className={cn("h-5 w-5", group.color)} />
                      <div>
                        <div className="text-base font-semibold">{t(group.labelKey)}</div>
                        <div className="text-xs text-muted-foreground">{t(group.descKey)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant="outline">{groupTemplates.length}</Badge>
                      {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                    </div>
                  </button>
                  {isExpanded && (
                    <CardContent className="border-t border-border/50 pt-4">
                      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {groupTemplates.map((tmpl) => (
                          <div key={tmpl.id} className="rounded-2xl border border-border/70 bg-background/80 p-4 space-y-3">
                            <div className="flex items-start justify-between gap-2">
                              <div className="min-w-0">
                                <div className="text-sm font-semibold truncate">{tmpl.name}</div>
                                {tmpl.description && <div className="mt-0.5 text-xs text-muted-foreground truncate">{tmpl.description}</div>}
                              </div>
                              <Badge className={cn("shrink-0 text-[10px]", statusBadgeClass(tmpl.status))}>
                                {statusIcon(tmpl.status)}
                              </Badge>
                            </div>
                            <div className="flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
                              {tmpl.inventory && <Badge variant="outline" className="text-[10px]">{tmpl.inventory}</Badge>}
                              {tmpl.lastRun && (
                                <span>{new Date(tmpl.lastRun).toLocaleDateString()}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-2">
                              <Button
                                size="sm"
                                variant="outline"
                                className="gap-2"
                                disabled={launching === tmpl.id}
                                onClick={() => launchAwx(tmpl.id)}
                              >
                                {launching === tmpl.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                                {t("auto.run")}
                              </Button>
                              {lastResult?.id === tmpl.id && (
                                <span className={cn("text-xs", lastResult.success ? "text-success" : "text-danger")}>
                                  {lastResult.message}
                                </span>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
