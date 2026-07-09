"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2, Brain, Sparkles, RefreshCw, ChevronDown, ChevronUp, History, ShieldAlert, Coins, Gauge, Search, Database } from "lucide-react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { FinOpsAdvisorInsights } from "@/lib/finops-advisor-insights";
import { useI18n } from "@/lib/i18n";

type JobStatus = "queued" | "running" | "completed" | "failed";

type JobStage =
  | "queued"
  | "fetching_inventory"
  | "collecting_metrics"
  | "fetching_costs"
  | "building_prompt"
  | "generating_report"
  | "completed"
  | "failed";

interface AdvisorResponse {
  analysis: string;
  model: string;
  provider?: string;
  metricsCollected: number;
  metricsDays?: number;
  costsIncluded?: boolean;
  costWindow?: { startDate: string; endDate: string } | null;
  warnings?: string[];
  inventorySummary: { totalResources: number; accounts: number; services: number };
  insights: FinOpsAdvisorInsights;
  timestamp: string;
}

interface AdvisorJobResponse {
  jobId: string;
  status: JobStatus;
  stage: JobStage;
  stageMessage: string | null;
  progressPct: number;
  result: AdvisorResponse | null;
  errorMessage: string | null;
}

interface AdvisorJobListItem {
  jobId: string;
  requestedByEmail: string;
  requestedByName: string | null;
  status: JobStatus;
  stage: JobStage;
  stageMessage: string | null;
  progressPct: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  updatedAt: string;
  errorMessage: string | null;
  resultMeta: {
    model: string | null;
    provider: string | null;
    metricsCollected: number | null;
    costsIncluded: boolean | null;
    costWindow: { startDate: string; endDate: string } | null;
    timestamp: string | null;
  };
}

interface FinOpsAdvisorProps {
  selectedAccountIds: string[];
  startDate?: string;
  endDate?: string;
  title?: string;
  description?: string;
  defaultIncludeMetrics?: boolean;
  defaultIncludeCosts?: boolean;
}

const STAGE_LABEL_KEYS: Record<JobStage, string> = {
  queued: "advisor.stageQueued",
  fetching_inventory: "advisor.stageInventory",
  collecting_metrics: "advisor.stageMetrics",
  fetching_costs: "advisor.stageCosts",
  building_prompt: "advisor.stageContext",
  generating_report: "advisor.stageGenerating",
  completed: "advisor.stageCompleted",
  failed: "advisor.stageFailed",
};

const STATUS_STYLES: Record<JobStatus, string> = {
  queued: "bg-muted text-muted-foreground border-border",
  running: "bg-info/10 text-info border-info/25",
  completed: "bg-success/10 text-success border-success/25",
  failed: "bg-danger/10 text-danger border-danger/25",
};

const QUALITY_STYLES: Record<FinOpsAdvisorInsights["summary"]["qualityLevel"], string> = {
  high: "border-success/25 bg-success/10 text-success",
  medium: "border-warning/25 bg-warning/10 text-warning",
  low: "border-danger/25 bg-danger/10 text-danger",
};

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: value >= 100 ? 0 : 2,
  }).format(value);
}

function formatPct(value: number | null | undefined, t: (key: string) => string) {
  if (value === null || value === undefined || !Number.isFinite(value)) return t("advisor.notIncluded");
  return `${value.toFixed(1)}%`;
}

function getOpportunityPrimaryLabel(item: FinOpsAdvisorInsights["topOpportunities"][number]) {
  return item.resourceName && item.resourceName !== "-" ? item.resourceName : item.resourceId;
}

function getOpportunitySecondaryLabel(item: FinOpsAdvisorInsights["topOpportunities"][number]) {
  if (item.resourceName && item.resourceName !== "-" && item.resourceName !== item.resourceId) {
    return item.resourceId;
  }
  return item.service;
}

function formatRatio(part: number, total: number) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return "-";
  return `${part}/${total}`;
}

const markdownComponents: Components = {
  table: ({ ...props }) => (
    <div className="my-4 overflow-x-auto rounded-xl border border-border/60">
      <table className="min-w-full border-collapse text-sm" {...props} />
    </div>
  ),
  thead: ({ ...props }) => <thead className="bg-muted/60" {...props} />,
  th: ({ ...props }) => (
    <th
      className="border-b border-border/60 px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground"
      {...props}
    />
  ),
  td: ({ ...props }) => (
    <td
      className="border-t border-border/40 px-3 py-2 align-top text-sm leading-6 text-foreground/90 break-words"
      {...props}
    />
  ),
  hr: ({ ...props }) => <hr className="my-6 border-border/60" {...props} />,
  h1: ({ ...props }) => <h1 className="text-4xl font-bold tracking-tight text-foreground" {...props} />,
  h2: ({ ...props }) => <h2 className="mt-8 text-2xl font-semibold tracking-tight text-foreground" {...props} />,
  h3: ({ ...props }) => <h3 className="mt-6 text-xl font-semibold text-foreground" {...props} />,
  p: ({ ...props }) => <p className="leading-7 text-foreground/90" {...props} />,
  li: ({ ...props }) => <li className="leading-7 text-foreground/90" {...props} />,
  blockquote: ({ ...props }) => (
    <blockquote className="border-l-4 border-primary/30 pl-4 italic text-muted-foreground" {...props} />
  ),
};

export function FinOpsAdvisor({
  selectedAccountIds,
  startDate,
  endDate,
  title,
  description,
  defaultIncludeMetrics = true,
  defaultIncludeCosts = true,
}: FinOpsAdvisorProps) {
  const { t, locale } = useI18n();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AdvisorResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeMetrics, setIncludeMetrics] = useState(defaultIncludeMetrics);
  const [includeCosts, setIncludeCosts] = useState(defaultIncludeCosts);
  const [showOptions, setShowOptions] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [jobStatus, setJobStatus] = useState<JobStatus | null>(null);
  const [jobStage, setJobStage] = useState<JobStage>("queued");
  const [jobProgress, setJobProgress] = useState(0);
  const [jobMessage, setJobMessage] = useState<string>(t("advisor.preparing"));
  const [showHistory, setShowHistory] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyJobs, setHistoryJobs] = useState<AdvisorJobListItem[]>([]);

  const stageTitle = useMemo(() => t(STAGE_LABEL_KEYS[jobStage]) || t("advisor.processing"), [jobStage, t]);

  const loadHistory = async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const res = await fetch("/api/ai/finops-advisor/jobs?limit=8", { cache: "no-store" });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`No se pudo cargar historial (${res.status}): ${text}`);
      }
      const payload = await res.json();
      setHistoryJobs(Array.isArray(payload.jobs) ? payload.jobs : []);
    } catch (historyLoadError) {
      setHistoryError(historyLoadError instanceof Error ? historyLoadError.message : "Error al cargar historial");
    } finally {
      setHistoryLoading(false);
    }
  };

  useEffect(() => {
    if (!jobId || !jobStatus || (jobStatus !== "queued" && jobStatus !== "running")) {
      return;
    }

    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(`/api/ai/finops-advisor/jobs/${jobId}`, { cache: "no-store" });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`No se pudo consultar el job (${res.status}): ${text}`);
        }

        const job: AdvisorJobResponse = await res.json();
        if (cancelled) return;

        setJobStatus(job.status);
        setJobStage(job.stage);
        setJobProgress(job.progressPct);
        setJobMessage(job.stageMessage || t("advisor.processing"));

        if (job.status === "completed" && job.result) {
          setResult(job.result);
          setLoading(false);
          setJobId(null);
          setError(null);
          if (showHistory) {
            void loadHistory();
          }
        }

        if (job.status === "failed") {
          setError(job.errorMessage || "El análisis ha fallado.");
          setLoading(false);
          setJobId(null);
          if (showHistory) {
            void loadHistory();
          }
        }
      } catch (pollError) {
        if (cancelled) return;
        setError(pollError instanceof Error ? pollError.message : "Error consultando progreso del análisis");
        setLoading(false);
        setJobId(null);
      }
    };

    void poll();
    const timer = setInterval(() => {
      void poll();
    }, 3500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [jobId, jobStatus, showHistory]);

  const analyze = async () => {
    if (selectedAccountIds.length === 0) {
      setError(t("advisor.selectAtLeastOne"));
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    setJobId(null);
    setJobStatus("queued");
    setJobStage("queued");
    setJobProgress(0);
    setJobMessage(t("advisor.queuing"));

    try {
      const res = await fetch("/api/ai/finops-advisor/jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          accountIds: selectedAccountIds,
          includeMetrics,
          includeCosts,
          startDate,
          endDate,
          metricsDays: 14,
          locale,
        }),
      });

      if (!res.ok) {
        const text = await res.text();
        let errMsg = "Error en el análisis";
        try {
          errMsg = JSON.parse(text).error || errMsg;
        } catch {
          errMsg = `Error ${res.status}: respuesta no válida del servidor`;
        }
        throw new Error(errMsg);
      }

      const job = await res.json();
      setJobId(job.jobId);
      setJobStatus(job.status);
      setJobStage(job.stage || "queued");
      setJobProgress(job.progressPct || 0);
      setJobMessage(t("advisor.jobQueued"));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
      setLoading(false);
      setJobId(null);
      setJobStatus(null);
    }
  };

  const cleanAnalysis = (text: string) => text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

  return (
    <Card className="border-border/70 bg-card">
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-gradient-to-br from-violet-500/20 to-purple-500/20">
              <Brain className="w-5 h-5 text-violet-500" />
            </div>
            <div>
              <CardTitle className="text-lg">{title || t("advisor.title")}</CardTitle>
              <CardDescription>{description || t("advisor.description")}</CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowOptions(!showOptions)}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              type="button"
            >
              {t("advisor.options")} {showOptions ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
            </button>
            <button
              onClick={() => {
                const next = !showHistory;
                setShowHistory(next);
                if (next) {
                  void loadHistory();
                }
              }}
              className="text-xs text-muted-foreground hover:text-foreground flex items-center gap-1"
              type="button"
            >
              <History className="w-3 h-3" />
              {t("advisor.history")}
            </button>
            <Button
              onClick={analyze}
              disabled={loading || selectedAccountIds.length === 0}
              size="sm"
              className="gap-2 bg-gradient-to-r from-violet-600 to-purple-600 hover:from-violet-700 hover:to-purple-700"
            >
              {loading ? (
                <><Loader2 className="w-4 h-4 animate-spin" />{t("advisor.analyzing")}</>
              ) : result ? (
                <><RefreshCw className="w-4 h-4" />{t("advisor.reanalyze")}</>
              ) : (
                <><Sparkles className="w-4 h-4" />{t("advisor.analyze")}</>
              )}
            </Button>
          </div>
        </div>

        {showOptions && (
          <div className="mt-3 p-3 rounded-md bg-muted/50 space-y-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={includeMetrics}
                onChange={() => setIncludeMetrics(!includeMetrics)}
                className="rounded border-border"
              />
              <span className="text-foreground">{t("advisor.includeMetrics")}</span>
            </label>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={includeCosts}
                onChange={() => setIncludeCosts(!includeCosts)}
                className="rounded border-border"
              />
              <span className="text-foreground">{t("advisor.includeCosts")}</span>
            </label>
            <p className="text-xs text-muted-foreground">
              {t("advisor.fullModeNote")}
            </p>
          </div>
        )}
      </CardHeader>

      <CardContent>
        {error && (
          <div className="p-3 rounded-md bg-destructive/10 border border-destructive/30 text-sm text-destructive">
            {error}
          </div>
        )}

        {loading && (
          <div className="flex flex-col items-center justify-center py-12 space-y-4">
            <div className="relative">
              <div className="w-16 h-16 rounded-full border-4 border-violet-500/20 border-t-violet-500 animate-spin" />
              <Brain className="w-6 h-6 text-violet-500 absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2" />
            </div>
            <div className="text-center space-y-2">
              <p className="text-sm font-medium text-foreground">{stageTitle}</p>
              <p className="text-xs text-muted-foreground">{jobMessage}</p>
              <div className="w-64 max-w-full h-2 rounded-full bg-muted overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-violet-600 to-purple-600 transition-all duration-300"
                  style={{ width: `${Math.max(5, jobProgress)}%` }}
                />
              </div>
              <p className="text-xs text-muted-foreground">{jobProgress}%</p>
            </div>
          </div>
        )}

        {result && !loading && (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-3 text-xs text-muted-foreground pb-3 border-b border-border/50">
              <span>{result.provider === "bedrock" ? "Bedrock" : "Ollama"}: {result.model}</span>
              <span>•</span>
              <span>{result.inventorySummary.totalResources} {t("advisor.resources")}</span>
              <span>•</span>
              <span>{result.inventorySummary.accounts} {t("advisor.accounts")}</span>
              {result.metricsCollected > 0 && (
                <>
                  <span>•</span>
                  <span>{result.metricsCollected} {t("advisor.metrics")} ({result.metricsDays || 14}d)</span>
                </>
              )}
              {result.costsIncluded && result.costWindow && (
                <>
                  <span>•</span>
                  <span>CUR {result.costWindow.startDate} → {result.costWindow.endDate}</span>
                </>
              )}
              <span>•</span>
              <span>{new Date(result.timestamp).toLocaleString()}</span>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
              <div className={`rounded-2xl border px-4 py-4 ${QUALITY_STYLES[result.insights.summary.qualityLevel]}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em]">{t("advisor.solidness")}</div>
                    <div className="mt-2 text-2xl font-bold">{result.insights.summary.qualityScore}%</div>
                    <div className="mt-1 text-xs">
                      {result.insights.summary.qualityLevel === "high" ? t("advisor.coverageHigh") : result.insights.summary.qualityLevel === "medium" ? t("advisor.coverageMedium") : t("advisor.coverageLow")}
                    </div>
                  </div>
                  <Gauge className="h-5 w-5 shrink-0" />
                </div>
              </div>

              <div className="rounded-2xl border border-success/25 bg-success/10 px-4 py-4 text-success">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em]">{t("advisor.savingsDetected")}</div>
                    <div className="mt-2 text-2xl font-bold">{formatCurrency(result.insights.summary.totalOpportunitySavingsMonthly)}</div>
                    <div className="mt-1 text-xs">{result.insights.summary.opportunitiesCount} {t("advisor.opportunitiesWithEvidence")}</div>
                  </div>
                  <Coins className="h-5 w-5 shrink-0" />
                </div>
              </div>

              <div className="rounded-2xl border border-info/25 bg-info/10 px-4 py-4 text-info">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em]">{t("advisor.realCostWindow")}</div>
                    <div className="mt-2 text-2xl font-bold">{formatCurrency(result.insights.summary.actualWindowCost)}</div>
                    <div className="mt-1 text-xs">
                      {result.costWindow ? `${result.costWindow.startDate} → ${result.costWindow.endDate}` : t("advisor.notIncluded")}
                    </div>
                  </div>
                  <Database className="h-5 w-5 shrink-0" />
                </div>
              </div>

              <div className="rounded-2xl border border-warning/25 bg-warning/10 px-4 py-4 text-warning">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-[0.22em]">{t("advisor.gapsDetected")}</div>
                    <div className="mt-2 text-2xl font-bold">{result.insights.summary.gapCount}</div>
                    <div className="mt-1 text-xs">{result.insights.permissionHints.length} {t("advisor.permissionHints")}</div>
                  </div>
                  <ShieldAlert className="h-5 w-5 shrink-0" />
                </div>
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-6">
              <div className="rounded-2xl border border-border/70 bg-background/50 px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t("advisor.accountsCovered")}</div>
                <div className="mt-2 text-lg font-semibold text-foreground">
                  {result.insights.summary.inventoryAccounts}/{result.insights.summary.requestedAccounts}
                </div>
                <div className="text-xs text-muted-foreground">{formatPct(result.insights.coverage.accountCoveragePct, t)}</div>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/50 px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">
                  {result.insights.coverage.actualResourceSpendCoveragePct !== null ? t("advisor.spendLinked") : t("advisor.estimatedCost")}
                </div>
                <div className="mt-2 text-lg font-semibold text-foreground">
                  {formatPct(result.insights.coverage.actualResourceSpendCoveragePct ?? result.insights.coverage.estimatedCostCoveragePct, t)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {result.insights.coverage.actualResourceSpendCoveragePct !== null
                    ? `${formatRatio(result.insights.summary.matchedResourceCosts, result.insights.summary.totalResources)} ${t("advisor.resources")} (${formatPct(result.insights.coverage.actualResourceCostCoveragePct, t)}) enlazados a CUR`
                    : result.insights.coverage.modeledVsActualRunRatePct !== null
                    ? `${formatPct(result.insights.coverage.modeledVsActualRunRatePct, t)} del run-rate real aprox.`
                    : "recursos con heurística económica"}
                </div>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/50 px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t("advisor.tagsVisible")}</div>
                <div className="mt-2 text-lg font-semibold text-foreground">{formatPct(result.insights.coverage.tagVisibilityPct, t)}</div>
                <div className="text-xs text-muted-foreground">{t("advisor.tagsTerraformReading")}</div>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/50 px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t("advisor.taggedResources")}</div>
                <div className="mt-2 text-lg font-semibold text-foreground">{formatPct(result.insights.coverage.taggedResourcesPct, t)}</div>
                <div className="text-xs text-muted-foreground">{t("advisor.tagsForOwnership")}</div>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/50 px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t("advisor.metricsLabel")}</div>
                <div className="mt-2 text-lg font-semibold text-foreground">{formatPct(result.insights.coverage.metricsSampleCoveragePct, t)}</div>
                <div className="text-xs text-muted-foreground">
                  {result.insights.summary.metricsCollected}/{result.insights.summary.metricsSampleTarget} {t("advisor.samplesTarget")}
                </div>
              </div>
              <div className="rounded-2xl border border-border/70 bg-background/50 px-4 py-3">
                <div className="text-[11px] font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t("advisor.curRealCost")}</div>
                <div className="mt-2 text-lg font-semibold text-foreground">
                  {result.insights.coverage.actualCostAvailable ? t("advisor.available") : t("advisor.notAvailable")}
                </div>
                <div className="text-xs text-muted-foreground">
                  {result.insights.summary.matchedResourceWindowCost !== null
                    ? `enlazado ${formatCurrency(result.insights.summary.matchedResourceWindowCost)} (${formatPct(result.insights.coverage.actualResourceSpendCoveragePct)}) de la ventana`
                    : result.insights.summary.estimatedWindowCost !== null
                    ? `est. ventana ${formatCurrency(result.insights.summary.estimatedWindowCost)}`
                    : "sin ventana comparable"}
                </div>
              </div>
            </div>

            {result.insights.topOpportunities.length > 0 && (
              <div className="rounded-2xl border border-border/70 bg-background/50 p-5 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-[0.22em] text-muted-foreground">{t("advisor.prioritizedOpportunities")}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t("advisor.prioritizedOpportunitiesDesc")}
                    </p>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-success/25 bg-success/10 px-3 py-1 text-xs font-medium text-success">
                    <Coins className="h-3.5 w-3.5" />
                    {formatCurrency(result.insights.summary.totalOpportunitySavingsMonthly)}{t("advisor.perMonth")}
                  </div>
                </div>

                <div className="mt-4 overflow-x-auto rounded-xl border border-border/60">
                  <table className="min-w-full border-collapse text-sm">
                    <thead className="bg-muted/60">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground">{t("advisor.category")}</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground">{t("advisor.resource")}</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground">{t("advisor.account")}</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground">{t("advisor.action")}</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground">{t("advisor.evidence")}</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-foreground">{t("advisor.savings")}</th>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground">{t("advisor.confidence")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.insights.topOpportunities.map((item) => (
                        <tr key={item.key} className="border-t border-border/40">
                          <td className="px-3 py-2 align-top text-foreground">{item.category}</td>
                          <td className="px-3 py-2 align-top text-foreground">
                            <div className="font-medium">{getOpportunityPrimaryLabel(item)}</div>
                            <div className="text-xs text-muted-foreground">{getOpportunitySecondaryLabel(item)}</div>
                          </td>
                          <td className="px-3 py-2 align-top text-muted-foreground">{item.accountName}</td>
                          <td className="px-3 py-2 align-top text-foreground">{item.action}</td>
                          <td className="px-3 py-2 align-top text-muted-foreground">{item.evidence}</td>
                          <td className="px-3 py-2 text-right align-top font-medium text-foreground">
                            <div>{formatCurrency(item.estimatedMonthlySavings)}</div>
                            {item.currentMonthlyCost !== null && item.currentMonthlyCost !== undefined && (
                              <div className="text-[11px] font-normal text-muted-foreground">
                                {t("advisor.base")} {item.costBasis === "actual" ? "CUR" : "est."} {formatCurrency(item.currentMonthlyCost)}{t("advisor.perMonth")}
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2 align-top">
                            <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${
                              item.confidence === "high"
                                ? "bg-success/10 text-success"
                                : item.confidence === "medium"
                                  ? "bg-warning/10 text-warning"
                                  : "bg-danger/10 text-danger"
                            }`}>
                              {item.confidence}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <Card className="border-border/60 bg-card/90 shadow-sm">
              <CardHeader className="pb-3">
                <div className="flex items-center gap-2">
                  <Brain className="h-5 w-5 text-primary" />
                  <CardTitle className="text-base">{t("advisor.aiReport")}</CardTitle>
                </div>
                <CardDescription>
                  {t("advisor.aiReportDesc")}
                </CardDescription>
                <div className="flex flex-wrap gap-2 pt-2">
                  <Badge variant="outline" className="text-[10px]">{result.model}</Badge>
                  <Badge variant="outline" className="text-[10px]">{result.provider || "ollama"}</Badge>
                  {result.metricsCollected > 0 && <Badge variant="outline" className="text-[10px]">{result.metricsCollected} {t("advisor.metrics")}</Badge>}
                  {result.costsIncluded && <Badge variant="outline" className="text-[10px]">CUR</Badge>}
                </div>
              </CardHeader>
              <CardContent>
                <div className="rounded-2xl border border-border/60 bg-background/50 p-5 shadow-sm sm:p-7">
                  <div className="prose prose-sm max-w-none prose-p:my-3 prose-headings:my-4 prose-ul:my-3 prose-li:my-1 prose-code:text-xs prose-strong:text-foreground">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                      {cleanAnalysis(result.analysis)}
                    </ReactMarkdown>
                  </div>
                </div>
              </CardContent>
            </Card>

            {result.insights.topUnmatchedServices.length > 0 && (
              <div className="rounded-2xl border border-border/60 bg-muted/30 p-5 shadow-sm">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h3 className="text-sm font-semibold uppercase tracking-[0.22em] text-foreground">{t("advisor.unmatchedSpend")}</h3>
                    <p className="mt-2 text-sm text-muted-foreground">
                      {t("advisor.unmatchedSpendDesc")}
                    </p>
                  </div>
                  <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-foreground">
                    {result.insights.topUnmatchedServices.length} {t("advisor.focusServices")}
                  </div>
                </div>

                <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-card/80">
                  <table className="min-w-full border-collapse text-sm">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide text-foreground">{t("advisor.service")}</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-foreground">{t("advisor.unmatchedSpendLabel")}</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-foreground">Cobertura servicio</th>
                        <th className="px-3 py-2 text-right text-xs font-semibold uppercase tracking-wide text-foreground">Rows CUR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.insights.topUnmatchedServices.map((item) => (
                        <tr key={item.service} className="border-t border-border/50">
                          <td className="px-3 py-2 align-top font-medium text-foreground">{item.service}</td>
                          <td className="px-3 py-2 text-right align-top font-medium text-foreground">{formatCurrency(item.unmatchedCost)}</td>
                          <td className="px-3 py-2 text-right align-top text-foreground">
                            <div>{formatPct(item.coveragePct)}</div>
                            <div className="text-[11px] text-muted-foreground">{formatCurrency(item.matchedCost)} de {formatCurrency(item.totalCost)}</div>
                          </td>
                          <td className="px-3 py-2 text-right align-top text-foreground">
                            <div>{formatRatio(item.unmatchedRows, item.resourceRows)} sin match</div>
                            <div className="text-[11px] text-muted-foreground">{item.matchedRows} matched</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {(result.insights.gaps.length > 0 || result.insights.permissionHints.length > 0) && (
              <div className="grid gap-4 xl:grid-cols-2">
                {result.insights.gaps.length > 0 && (
                  <div className="rounded-2xl border border-warning/25 bg-warning/10 p-5">
                    <div className="flex items-center gap-2">
                      <ShieldAlert className="h-4 w-4 text-warning" />
                      <h3 className="text-sm font-semibold uppercase tracking-[0.22em] text-warning">Gaps del dataset</h3>
                    </div>
                    <div className="mt-4 space-y-3">
                      {result.insights.gaps.map((gap) => (
                        <div key={gap.key} className="rounded-xl border border-warning/25 bg-card/70 p-3">
                          <div className="text-sm font-medium text-foreground">{gap.title}</div>
                          <div className="mt-1 text-xs leading-6 text-foreground/90">{gap.description}</div>
                          <div className="mt-2 text-[11px] text-muted-foreground">Impacto: {gap.impact}</div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {gap.recommendedActions.map((action) => (
                              <span key={action} className="inline-flex rounded-full border border-warning/25 bg-warning/15 px-2 py-0.5 text-[11px] text-foreground">
                                {action}
                              </span>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {result.insights.permissionHints.length > 0 && (
                  <div className="rounded-2xl border border-info/25 bg-info/10 p-5">
                  <div className="flex items-center gap-2">
                      <Search className="h-4 w-4 text-info" />
                      <h3 className="text-sm font-semibold uppercase tracking-[0.22em] text-info">Visibilidad / permisos a revisar</h3>
                    </div>
                    <div className="mt-4 space-y-3">
                      {result.insights.permissionHints.map((hint) => (
                        <div key={hint.key} className="rounded-xl border border-info/25 bg-card/70 p-3">
                          <div className="text-sm font-medium text-foreground">{hint.service}</div>
                          <div className="mt-1 text-xs leading-6 text-foreground/90">{hint.reason}</div>
                          <div className="mt-2 flex flex-wrap gap-2">
                            {hint.missingActions.map((action) => (
                              <span key={action} className="inline-flex rounded-full border border-info/25 bg-info/15 px-2 py-0.5 text-[11px] text-foreground">
                                {action}
                              </span>
                            ))}
                          </div>
                          {hint.missingActions.length > 0 && (
                            <button
                              className="mt-2 text-[10px] text-info hover:text-foreground underline underline-offset-2"
                              onClick={() => {
                                const policy = JSON.stringify({
                                  Effect: "Allow",
                                  Action: hint.missingActions,
                                  Resource: "*",
                                }, null, 2);
                                navigator.clipboard.writeText(policy);
                              }}
                            >
                              Copiar snippet IAM
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {result.warnings && result.warnings.length > 0 && (
              <div className="space-y-2">
                {result.warnings.map((warning, index) => (
                  <div
                    key={`${warning}-${index}`}
                    className="rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
                  >
                    {warning}
                  </div>
                ))}
              </div>
            )}

          </div>
        )}

        {!result && !loading && !error && (
          <div className="text-center py-8 text-muted-foreground">
            <Sparkles className="w-8 h-8 mx-auto mb-3 opacity-40" />
            <p className="text-sm">Selecciona cuentas y pulsa Analizar para obtener un informe FinOps accionable.</p>
          </div>
        )}

        {showHistory && (
          <div className="mt-6 border-t pt-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-semibold text-foreground">Ejecuciones recientes</h4>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => void loadHistory()}
                disabled={historyLoading}
                className="h-7 px-2 text-xs"
              >
                {historyLoading ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : null}
                Actualizar
              </Button>
            </div>

            {historyError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                {historyError}
              </div>
            )}

            {!historyLoading && !historyError && historyJobs.length === 0 && (
              <div className="rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                No hay ejecuciones registradas todavía.
              </div>
            )}

            {!historyError && historyJobs.length > 0 && (
              <div className="space-y-2">
                {historyJobs.map((item) => (
                  <div key={item.jobId} className="rounded-md border border-border p-3">
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLES[item.status]}`}>
                        {item.status}
                      </span>
                      <span className="text-xs text-muted-foreground">{STAGE_LABELS[item.stage]}</span>
                      <span className="text-xs text-muted-foreground">•</span>
                      <span className="text-xs text-muted-foreground">{new Date(item.createdAt).toLocaleString()}</span>
                    </div>

                    <div className="text-xs text-muted-foreground mb-1">{item.stageMessage || "Sin detalle de etapa"}</div>
                    <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden mb-2">
                      <div
                        className="h-full bg-gradient-to-r from-violet-600 to-purple-600 transition-all duration-300"
                        style={{ width: `${Math.max(2, item.progressPct)}%` }}
                      />
                    </div>

                    {item.resultMeta && (
                      <div className="text-[11px] text-muted-foreground flex flex-wrap gap-2">
                        {item.resultMeta.provider && item.resultMeta.model && (
                          <span>{item.resultMeta.provider}:{item.resultMeta.model}</span>
                        )}
                        {typeof item.resultMeta.metricsCollected === "number" && (
                          <span>{item.resultMeta.metricsCollected} métricas</span>
                        )}
                        {item.resultMeta.costWindow && (
                          <span>CUR {item.resultMeta.costWindow.startDate} → {item.resultMeta.costWindow.endDate}</span>
                        )}
                      </div>
                    )}

                    {item.errorMessage && (
                      <div className="mt-2 text-[11px] text-destructive">{item.errorMessage}</div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
