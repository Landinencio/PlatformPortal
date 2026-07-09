"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Download,
  Gauge,
  GitBranch,
  GitPullRequest,
  HeartHandshake,
  Home,
  Layers3,
  Loader2,
  RefreshCcw,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Users,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { MultiSelect } from "@/components/ui/multi-select";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { MetricsActions } from "@/components/metrics/metrics-actions";
import {
  SectionShell,
  MetricCard,
  ChartCard,
  MiniStat,
  EmptyState,
  ScopeBanner,
  DeploymentLevelBadge,
  DoraEmptyState,
  AttributionCoverageNotice,
  DoraPerformanceBadge,
  DoraPerformanceSummary,
  DoraBenchmarksTable,
} from "@/components/metrics/shared";
import { TeamActivityTab } from "@/components/metrics/team-activity-tab";
import { PeriodComparison } from "@/components/metrics/period-comparison";
import {
  formatDuration,
  formatDisplayDate,
  formatTimestamp,
  shortSha,
  formatAxisCount,
  formatAxisPercent,
  formatAxisDurationTick,
  signed,
  trendStateClass,
  describeLeadTime,
} from "@/lib/format-utils";
import { useI18n } from "@/lib/i18n";
import { expandAuthorUsernames } from "@/lib/metrics-window";
import type {
  Group,
  Project,
  MetricTrend,
  MetricStatus,
  AuditCheck,
  AuditSummary,
  StatsSummary,
  Contributor,
  MergeRequest,
  SonarProject,
  SonarAvailableProject,
  SectionState,
} from "@/types/metrics";

/**
 * Not-available indicator for a DORA metric under an author filter. Mirrors the
 * server-side `DoraNotAvailable` (src/lib/metrics-dashboard.ts). Distinct from the
 * numeric value `0`, so the UI can tell "no attributable activity" from "measured zero".
 */
type DoraNotAvailable = { available: false };

/** Author-scope summary returned under `summary.authorScope`. */
type DoraAuthorScope = {
  authors: { key: string; name: string }[];
  attributionCoverage: number | null;
  attributionCoverageThreshold: number;
  active: boolean;
};

/** Flags marking which metrics are deployment/pipeline level under an author filter. */
type DoraDeploymentLevelFlags = {
  changeFailureRate: boolean;
  pipelineRecoveryTime: boolean;
};

type DoraCoreResponse = {
  summary: {
    deploymentFrequency: MetricTrend;
    leadTimeForChanges: MetricTrend | DoraNotAvailable;
    leadTimeCommit: MetricTrend;
    leadTimeFirstCommit: MetricTrend;
    leadTimeFromMr: MetricTrend;
    changeFailureRate: MetricTrend | DoraNotAvailable;
    mttr: MetricTrend | DoraNotAvailable;
    authorScope: DoraAuthorScope;
    deploymentLevel: DoraDeploymentLevelFlags;
    anomalies: {
      deploymentFrequency: boolean;
    };
    totals: {
      deployments: number;
      uniqueDeployments: number;
      rollbacks: number;
      hotfixes: number;
      features: number;
      failures: number;
    };
    methodology: {
      version: string;
      leadTimeReference: {
        key: "first_commit" | "mr_created" | "last_commit" | "none";
        label: string;
        description: string;
      };
      samples: {
        deployments: number;
        leadTimeFirstCommit: number;
        leadTimeFromMr: number;
        leadTimeFromLastCommit: number;
        gitlabFailures: number;
        gitlabRecoveries: number;
      };
    };
    audit: AuditSummary;
    compliance: {
      available: boolean;
      reason: string | null;
      latestSnapshot: string | null;
      projects: number;
      averageScore: number;
      controls: {
        defaultBranchProtected: MetricStatus;
        pushRulesConfigured: MetricStatus;
        branchRegexOk: MetricStatus;
        deployProdReady: MetricStatus;
        prodEnvironmentStandard: MetricStatus;
        serviceCatalogLinked: MetricStatus;
        runtimeMappingOk: MetricStatus;
        sonarLinked: MetricStatus;
        qualityGateReporting: MetricStatus;
        doraTraceabilityReady: MetricStatus;
      };
      projectsWithGaps: Array<{
        snapshotDate: string;
        projectId: number;
        projectName: string;
        projectPath: string;
        team: string | null;
        score: number;
        gapCount: number;
        latestQualityGateStatus: string | null;
        deployProd: {
          declarationSource: "none" | "local" | "expanded";
          status: "observed" | "declared_no_recent_activity" | "no_evidence";
          includesDetected: boolean;
        };
        statuses: {
          defaultBranchProtected: boolean;
          pushRulesConfigured: boolean;
          branchRegexOk: boolean;
          deployProdDeclared: boolean;
          deployProdObserved: boolean;
          prodEnvironmentStandardOk: boolean;
          serviceCatalogLinked: boolean;
          runtimeMappingOk: boolean;
          sonarLinked: boolean;
          qualityGateReporting: boolean;
          doraTraceabilityReady: boolean;
        };
      }>;
    };
    traceability: {
      available: boolean;
      reason: string | null;
      leadTimeGuardHours: number;
      deployments: number;
      deploymentsWithMr: number;
      uniqueCommits: number;
      uniqueMrs: number;
      averageMrCommitCount: number;
      leadTimeSamples: {
        firstCommit: number;
        mr: number;
        lastCommit: number;
      };
      discardedOutliers: {
        firstCommit: number;
        mr: number;
        lastCommit: number;
      };
      recentDeployments: Array<{
        snapshotDate: string;
        team: string | null;
        projectId: number;
        projectName: string;
        deployId: string;
        deployCreatedAt: string;
        deployType: "feature" | "hotfix" | "rollback";
        deployTypeReason: string | null;
        deployEnvironment: string | null;
        commitSha: string | null;
        commitCreatedAt: string | null;
        commitAuthorEmail: string | null;
        mrId: number | null;
        mrIid: number | null;
        mrCreatedAt: string | null;
        mrMergedAt: string | null;
        mrTitle: string | null;
        mrSourceBranch: string | null;
        mrFirstCommitAt: string | null;
        mrLastCommitAt: string | null;
        mrCommitCount: number;
        leadTimes: {
          firstCommitHours: number | null;
          mrHours: number | null;
          lastCommitHours: number | null;
        };
        rawLeadTimes: {
          firstCommitHours: number | null;
          mrHours: number | null;
          lastCommitHours: number | null;
        };
        discarded: {
          firstCommit: boolean;
          mr: boolean;
          lastCommit: boolean;
        };
      }>;
    };
    reliabilitySignals: {
      available: boolean;
      scoped: boolean;
      source: "gitlab" | "hybrid";
      cfrSource: "gitlab" | "hybrid";
      mttrSource: "gitlab" | "hybrid";
      reason: string | null;
      confidenceThreshold: number;
      minCoveragePct: number;
      coveragePct: number;
      previousCoveragePct: number;
      correlatedDeployments: number;
      runtimeFailures: number;
      mttrIncidents: number;
      averageConfidence: number;
      hybridChangeFailureRate: MetricTrend;
      hybridMttr: MetricTrend;
    };
    clusterSignals: {
      available: boolean;
      scoped: boolean;
      reason: string | null;
      daysWithData: number;
      totals: {
        rollouts: number;
        failedWorkloads: number;
        unavailableReplicas: number;
        containerRestarts: number;
        totalApps: number;
        healthyApps: number;
        degradedApps: number;
        outOfSyncApps: number;
      };
      rolloutsPerDay: MetricTrend;
      failedWorkloadsPerDay: MetricTrend;
      degradedAppsPerDay: MetricTrend;
      healthRate: MetricTrend;
      outOfSyncAppsPerDay: MetricTrend;
    };
    performanceBands: Record<string, string>;
  };
  trend: Array<{
    date: string;
    deploymentFrequency: number;
    deployments: number;
    uniqueDeployments: number;
    rollbacks: number;
    hotfixes: number;
    features: number;
    leadTimeHours: number;
    leadTimeEffectiveHours: number;
    leadTimeFirstCommitHours: number;
    leadTimeMrHours: number;
    changeFailureRate: number;
    mttrHours: number;
    clusterRollouts: number;
    clusterFailedWorkloads: number;
    clusterDegradedApps: number;
    clusterOutOfSyncApps: number;
    clusterHealthRate: number;
    gitlabChangeFailureRate?: number;
    gitlabMttrHours?: number;
    runtimeChangeFailureRate?: number;
    runtimeMttrHours?: number;
    correlatedDeployments?: number;
    correlationCoverage?: number;
    correlationConfidence?: number;
    cfrSource?: "gitlab" | "hybrid";
    mttrSource?: "gitlab" | "hybrid";
  }>;
  meta: {
    daysRequested: number;
    daysWithData: number;
    latestSnapshot: string | null;
  };
};

// MetricTrend, MetricStatus, AuditCheck, AuditSummary imported from @/types/metrics

/** Type guard: a DORA metric is the explicit "not available" indicator (not a numeric 0). */
function isDoraNotAvailable(
  value: MetricTrend | DoraNotAvailable
): value is DoraNotAvailable {
  return (
    typeof value === "object" &&
    value !== null &&
    "available" in value &&
    (value as DoraNotAvailable).available === false
  );
}

/** Current value of a possibly not-available metric, or 0 when not available. */
function metricCurrentOrZero(value: MetricTrend | DoraNotAvailable): number {
  return isDoraNotAvailable(value) ? 0 : value.current;
}

/** Change value of a possibly not-available metric, or undefined when not available. */
function metricChangeOrUndefined(
  value: MetricTrend | DoraNotAvailable
): number | undefined {
  return isDoraNotAvailable(value) ? undefined : value.change;
}

type ManagerResponse = {
  audit: AuditSummary;
  options: {
    authors: Array<{
      key: string;
      label: string;
      name: string;
      email: string | null;
      usernames: string[];
    }>;
    projects: Array<{ id: number; name: string; team: string }>;
  };
  summary: {
    totalMRs: number;
    mergedMRs: number;
    openMRs: number;
    contributors: number;
    throughputMerged: number;
    reviewDensity: number;
    feedbackCollective: number;
    lifetimeMedianHours: number;
    leadTimeMedianHours: number;
    reviewTimeMedianHours: number;
    changeSizeMedian: number | null;
    changeSizeP90: number | null;
    openAging: {
      over3d: number;
      over7d: number;
      over14d: number;
    };
    productionChangesDeployed: number;
    productionDeploymentsTouched: number;
    productionContributors: number;
    productionLeadTimeMedianHours: number;
    productionHotfixDeployments: number;
    productionRollbackDeployments: number;
    totalLinesAdded: number;
    totalLinesRemoved: number;
  };
  stats: {
    lifetime: StatsSummary;
    leadTime: StatsSummary;
    reviewTime: StatsSummary;
    reviewTimeAnalysis: {
      gap: number;
      hasOutliers: boolean;
      stability: "volatile" | "very_stable" | "stable";
      stdDevRatio: number;
    };
    gaussian: Array<{ x: number; y: number }>;
  };
  weekly: Array<{
    week: string;
    weekDate: string;
    volume: number;
    reviewTimeMedianHours: number;
    reviewTimeTotalHours: number;
    leadTimeMedianHours: number;
  }>;
  bottlenecks: MergeRequest[];
  contributors: Contributor[];
  productionDelivery: {
    summary: {
      changesDeployed: number;
      deploymentsTouched: number;
      contributors: number;
      medianLeadTimeHours: number;
      hotfixDeployments: number;
      rollbackDeployments: number;
    };
    weekly: Array<{
      week: string;
      weekDate: string;
      deployments: number;
      changesDeployed: number;
      contributors: number;
      medianLeadTimeHours: number;
    }>;
    contributors: Array<{
      canonicalKey: string;
      email: string;
      name: string;
      teams: string[];
      changesDeployed: number;
      deploymentsTouched: number;
      projectsActive: number;
      medianLeadTimeHours: number;
      hotfixDeployments: number;
      rollbackDeployments: number;
      lastDeployedAt: string | null;
      linesAdded: number;
      linesRemoved: number;
    }>;
    teams: Array<{
      team: string;
      deployments: number;
      changesDeployed: number;
      contributors: number;
      hotfixDeployments: number;
      rollbackDeployments: number;
      medianLeadTimeHours: number;
    }>;
    focusContributor: {
      canonicalKey: string;
      email: string;
      name: string;
      teams: string[];
      changesDeployed: number;
      deploymentsTouched: number;
      projectsActive: number;
      medianLeadTimeHours: number;
      hotfixDeployments: number;
      rollbackDeployments: number;
      lastDeployedAt: string | null;
      linesAdded: number;
      linesRemoved: number;
      recentChanges: Array<{
        canonicalKey: string;
        authorName: string;
        authorEmail: string;
        team: string;
        projectId: number;
        projectName: string;
        deploymentId: number;
        deployCompletedAt: string;
        deployType: "feature" | "hotfix" | "rollback";
        deployTypeReason: string | null;
        deployEnvironment: string | null;
        gitlabJobId: string | null;
        gitlabPipelineId: string | null;
        commitSha: string;
        mrIid: number | null;
        leadTimeHours: number;
      }>;
    } | null;
    recentChanges: Array<{
      canonicalKey: string;
      authorName: string;
      authorEmail: string;
      team: string;
      projectId: number;
      projectName: string;
      deploymentId: number;
      deployCompletedAt: string;
      deployType: "feature" | "hotfix" | "rollback";
      deployTypeReason: string | null;
      deployEnvironment: string | null;
      gitlabJobId: string | null;
      gitlabPipelineId: string | null;
      commitSha: string;
      mrIid: number | null;
      leadTimeHours: number;
    }>;
  };
  meta: {
    latestSnapshot: string | null;
  };
  recentMergeRequests: MergeRequest[];
};

// StatsSummary, Contributor, MergeRequest imported from @/types/metrics

type SonarResponse = {
  audit: AuditSummary;
  availableProjects: SonarAvailableProject[];
  summary: {
    projectCount: number;
    averageCoverage: number;
    averageDuplication: number;
    totalBugs: number;
    totalVulnerabilities: number;
    totalCodeSmells: number;
    totalSecurityHotspots: number;
    techDebtHours: number;
    mappedProjects: number;
    unmappedProjects: number;
    mappingCoveragePct: number;
    qualityGate: {
      ok: number;
      error: number;
      warn: number;
      passRate: number;
    };
    latestSnapshot: string | null;
  };
  meta: {
    latestSnapshotInWindow: string | null;
    latestSnapshotOverall: string | null;
    stale: boolean;
  };
  trend: Array<{
    date: string;
    coverage: number;
    duplication: number;
    bugs: number;
    vulnerabilities: number;
    codeSmells: number;
    techDebtHours: number;
    securityHotspots: number;
    qualityGateOk: number;
    qualityGateError: number;
    qualityGateWarn: number;
  }>;
  projects: SonarProject[];
  reports: {
    weakestCoverage: SonarProject[];
    highestRisk: SonarProject[];
    mostDebt: SonarProject[];
  };
};

// SonarAvailableProject, SonarProject imported from @/types/metrics

type SnapshotTone = "default" | "info" | "success" | "warning";

const SELECTABLE_DAYS = ["7", "15", "30", "90", "180", "custom"];
const ACTIVE_PROJECT_LOOKBACK_DAYS = 180;

type SonarExportColumnKey =
  | "projectName"
  | "projectKey"
  | "gitlabProjectPath"
  | "mappingStatus"
  | "qualityGate"
  | "coverage"
  | "duplication"
  | "bugs"
  | "vulnerabilities"
  | "securityHotspots"
  | "codeSmells"
  | "techDebtHours"
  | "coverageDelta";

const SONAR_EXPORT_COLUMNS: Array<{ key: SonarExportColumnKey; label: string }> = [
  { key: "projectName", label: "eng.sonarExportCol.project" },
  { key: "projectKey", label: "eng.sonarExportCol.sonarKey" },
  { key: "gitlabProjectPath", label: "eng.sonarExportCol.gitlabProject" },
  { key: "mappingStatus", label: "eng.sonarExportCol.mappingStatus" },
  { key: "qualityGate", label: "eng.sonarExportCol.qualityGate" },
  { key: "coverage", label: "eng.sonarExportCol.coverage" },
  { key: "duplication", label: "eng.sonarExportCol.duplication" },
  { key: "bugs", label: "eng.sonarExportCol.bugs" },
  { key: "vulnerabilities", label: "eng.sonarExportCol.vulnerabilities" },
  { key: "securityHotspots", label: "eng.sonarExportCol.hotspots" },
  { key: "codeSmells", label: "eng.sonarExportCol.codeSmells" },
  { key: "techDebtHours", label: "eng.sonarExportCol.techDebt" },
  { key: "coverageDelta", label: "eng.sonarExportCol.coverageDelta" },
];

const DEFAULT_SONAR_EXPORT_COLUMNS: Record<SonarExportColumnKey, boolean> = {
  projectName: true,
  projectKey: true,
  gitlabProjectPath: true,
  mappingStatus: true,
  qualityGate: true,
  coverage: true,
  duplication: true,
  bugs: true,
  vulnerabilities: true,
  securityHotspots: false,
  codeSmells: false,
  techDebtHours: true,
  coverageDelta: true,
};

export function EngineeringDashboard() {
  const [activeTab, setActiveTab] = useState("dora-core");
  const [groups, setGroups] = useState<Group[]>([]);
  const [timeRange, setTimeRange] = useState("30");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [showComparison, setShowComparison] = useState(false);
  const { t } = useI18n();
  const [selectedTeams, setSelectedTeams] = useState<string[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [selectedGitlabGroup, setSelectedGitlabGroup] = useState<string>("all");
  const [availableGitlabGroups, setAvailableGitlabGroups] = useState<string[]>([]);

  // Saved project presets (persisted in DB per user)
  type ProjectPreset = { name: string; projectIds: string[]; teamIds: string[] };
  const [presets, setPresets] = useState<ProjectPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [showPresetSave, setShowPresetSave] = useState(false);

  useEffect(() => {
    fetch("/api/preferences?key=project_presets")
      .then((r) => r.json())
      .then((d) => { if (Array.isArray(d.value)) setPresets(d.value); })
      .catch(() => {});
  }, []);

  const persistPresets = (updated: ProjectPreset[]) => {
    setPresets(updated);
    fetch("/api/preferences", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "project_presets", value: updated }),
    }).catch(() => {});
  };

  const savePreset = () => {
    if (!presetName.trim() || selectedProjects.length === 0) return;
    persistPresets([...presets.filter((p) => p.name !== presetName.trim()), { name: presetName.trim(), projectIds: selectedProjects, teamIds: selectedTeams }]);
    setPresetName("");
    setShowPresetSave(false);
  };

  const loadPreset = (preset: ProjectPreset) => {
    setSelectedTeams(preset.teamIds);
    setSelectedProjects(preset.projectIds);
  };

  const deletePreset = (name: string) => {
    persistPresets(presets.filter((p) => p.name !== name));
  };
  const [selectedAuthors, setSelectedAuthors] = useState<string[]>([]);
  const [selectedSonarProjects, setSelectedSonarProjects] = useState<string[]>([]);
  const [sonarSelectionMode, setSonarSelectionMode] = useState<"auto" | "manual">("auto");
  const [sonarExportDialogOpen, setSonarExportDialogOpen] = useState(false);
  const [sonarExporting, setSonarExporting] = useState(false);
  const [sonarExportColumns, setSonarExportColumns] = useState<Record<SonarExportColumnKey, boolean>>(
    DEFAULT_SONAR_EXPORT_COLUMNS
  );
  const [mrState, setMrState] = useState("all");

  const [doraState, setDoraState] = useState<SectionState<DoraCoreResponse>>({
    data: null,
    loading: true,
    error: null,
  });
  const [managerState, setManagerState] = useState<SectionState<ManagerResponse>>({
    data: null,
    loading: true,
    error: null,
  });
  const [sonarState, setSonarState] = useState<SectionState<SonarResponse>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    void fetchProjects();
  }, []);

  useEffect(() => {
    const validProjectIds = new Set(
      availableProjectOptions.map((option) => option.value)
    );
    setSelectedProjects((current) => current.filter((id) => validProjectIds.has(id)));
  }, [groups, selectedTeams]);

  useEffect(() => {
    const validAuthors = new Set((managerState.data?.options.authors || []).map((author) => author.key));
    setSelectedAuthors((current) => {
      const filtered = current.filter((author) => validAuthors.has(author));
      // Only update if actually changed to avoid triggering fetchDashboards
      return filtered.length === current.length ? current : filtered;
    });
  }, [managerState.data]);

  useEffect(() => {
    const validSonarProjects = new Set(sonarState.data?.availableProjects.map((project) => project.key) || []);
    setSelectedSonarProjects((current) => {
      const filtered = current.filter((key) => validSonarProjects.has(key));
      // Only update if actually changed to avoid triggering fetchDashboards
      return filtered.length === current.length ? current : filtered;
    });
  }, [sonarState.data]);

  useEffect(() => {
    if (timeRange === "custom" && (!customFrom || !customTo)) return;
    void fetchDashboards();
  }, [timeRange, customFrom, customTo, selectedTeams, selectedProjects, selectedAuthors, selectedSonarProjects]);

  const teamOptions = useMemo(
    () => {
      const filteredGroups = selectedGitlabGroup === "all"
        ? groups
        : groups.filter((group) =>
            group.projects.some((p: any) => p.gitlabGroup === selectedGitlabGroup)
          );
      return filteredGroups.map((group) => ({ value: group.name, label: `${group.name} (${group.projects.length})` }));
    },
    [groups, selectedGitlabGroup]
  );

  const availableProjectOptions = useMemo(() => {
    const scopedGroups = selectedTeams.length > 0
      ? groups.filter((group) => selectedTeams.includes(group.name))
      : groups;
    const allProjects = scopedGroups.flatMap((group) => group.projects);

    // Filter by GitLab top-level group if selected
    const gitlabFilteredProjects = selectedGitlabGroup === "all"
      ? allProjects
      : allProjects.filter((p: any) => p.gitlabGroup === selectedGitlabGroup);

    // Detect duplicate names to disambiguate with parent path
    const nameCount = new Map<string, number>();
    for (const p of gitlabFilteredProjects) {
      nameCount.set(p.name, (nameCount.get(p.name) || 0) + 1);
    }

    return gitlabFilteredProjects
      .map((project) => {
        const isDuplicate = (nameCount.get(project.name) || 0) > 1;
        const parentGroup = project.full_path
          ? project.full_path.split("/").slice(-2, -1)[0] || ""
          : "";
        return {
          value: String(project.id),
          label: isDuplicate && parentGroup
            ? `${project.name} (${parentGroup})`
            : project.name,
        };
      })
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [groups, selectedTeams, selectedGitlabGroup]);

  const authorOptions = useMemo(
    () => (managerState.data?.options.authors || []).map((author) => ({ value: author.key, label: author.label })),
    [managerState.data]
  );

  // Expand the selected canonical author keys into the GitLab usernames the
  // per-username endpoints (team-activity, mr-details) actually store. Single
  // source of truth: options.authors[].usernames built by the manager dashboard.
  const selectedAuthorUsernames = useMemo(
    () => expandAuthorUsernames(selectedAuthors, managerState.data?.options.authors || []),
    [selectedAuthors, managerState.data]
  );

  const sonarOptions = useMemo(
    () => (sonarState.data?.availableProjects || []).map((project) => ({
      value: project.key,
      label: project.gitlabProjectPath
        ? `${project.name} · ${project.gitlabProjectPath.split("/").slice(-1)[0]}`
        : project.name,
    })),
    [sonarState.data]
  );

  const selectedGitLabProjectsMeta = useMemo(() => {
    const projectsById = new Map<string, Project>();
    for (const group of groups) {
      for (const project of group.projects) {
        projectsById.set(String(project.id), project);
      }
    }

    return selectedProjects
      .map((projectId) => {
        const project = projectsById.get(projectId);
        if (!project) {
          return null;
        }

        return {
          id: project.id,
          name: project.name,
          tokens: new Set<string>([
            normalizeProjectToken(project.name),
            normalizeProjectToken(project.full_path.split("/").slice(-1)[0] || project.name),
          ]),
        };
      })
      .filter((project): project is { id: number; name: string; tokens: Set<string> } => Boolean(project));
  }, [groups, selectedProjects]);

  const selectedGitLabProjectIds = useMemo(
    () => selectedProjects
      .map((projectId) => Number(projectId))
      .filter((projectId) => Number.isInteger(projectId) && projectId > 0),
    [selectedProjects]
  );

  const selectedGitLabProjectTokens = useMemo(() => {
    const tokens = new Set<string>();

    for (const project of selectedGitLabProjectsMeta) {
      for (const token of project.tokens) {
        tokens.add(token);
      }
    }

    return tokens;
  }, [selectedGitLabProjectsMeta]);

  const autoMappedSonarProjects = useMemo(() => {
    if (selectedGitLabProjectIds.length === 0) {
      return [];
    }

    const selectedIds = new Set(selectedGitLabProjectIds);
    return (sonarState.data?.availableProjects || [])
      .filter((project) => {
        if (project.gitlabProjectId !== null && selectedIds.has(project.gitlabProjectId)) {
          return true;
        }

        const inferredRepo = extractSonarRepoCandidate(project.key);
        return inferredRepo ? selectedGitLabProjectTokens.has(inferredRepo) : false;
      })
      .map((project) => project.key)
      .sort((left, right) => left.localeCompare(right));
  }, [selectedGitLabProjectIds, selectedGitLabProjectTokens, sonarState.data]);

  const sonarMappingContext = useMemo(() => {
    const selectedIds = new Set(selectedGitLabProjectIds);
    const mappedAvailable = (sonarState.data?.availableProjects || [])
      .filter((project) => project.gitlabProjectId !== null && selectedIds.has(project.gitlabProjectId));
    const matchedSelectedProjects = new Set<number>();

    for (const project of selectedGitLabProjectsMeta) {
      const hasMappedMatch = mappedAvailable.some((available) => available.gitlabProjectId === project.id);
      const hasInferredMatch = (sonarState.data?.availableProjects || []).some((available) => {
        const inferredRepo = extractSonarRepoCandidate(available.key);
        return inferredRepo ? project.tokens.has(inferredRepo) : false;
      });

      if (hasMappedMatch || hasInferredMatch) {
        matchedSelectedProjects.add(project.id);
      }
    }

    return {
      selectedGitLabProjects: selectedGitLabProjectIds.length,
      mappedSonarProjects: mappedAvailable.length,
      autoSelectedSonarProjects: autoMappedSonarProjects.length,
      unmappedGitLabProjects: Math.max(
        0,
        selectedGitLabProjectsMeta.length - matchedSelectedProjects.size
      ),
      hasAutoSelection: autoMappedSonarProjects.length > 0,
    };
  }, [selectedGitLabProjectIds, selectedGitLabProjectsMeta, sonarState.data, autoMappedSonarProjects]);

  const sonarCatalogMapping = useMemo(() => {
    const availableProjects = sonarState.data?.availableProjects || [];
    const mappedProjects = availableProjects.filter((project) => project.gitlabProjectId !== null).length;
    return {
      mappedProjects,
      unmappedProjects: Math.max(0, availableProjects.length - mappedProjects),
      mappingCoveragePct: availableProjects.length > 0 ? (mappedProjects / availableProjects.length) * 100 : 0,
    };
  }, [sonarState.data]);

  const selectedSonarProjectSet = useMemo(
    () => new Set(selectedSonarProjects),
    [selectedSonarProjects]
  );

  const sonarPortfolioProjects = useMemo(() => {
    if (!sonarState.data || selectedSonarProjects.length === 0) {
      return [];
    }

    return sonarState.data.projects.filter((project) => selectedSonarProjectSet.has(project.key));
  }, [sonarState.data, selectedSonarProjectSet, selectedSonarProjects]);

  const selectedSonarExportColumnCount = useMemo(
    () => SONAR_EXPORT_COLUMNS.filter((column) => sonarExportColumns[column.key]).length,
    [sonarExportColumns]
  );

  useEffect(() => {
    if (sonarSelectionMode !== "auto") {
      return;
    }

    setSelectedSonarProjects((current) =>
      sameStringArray(current, autoMappedSonarProjects) ? current : autoMappedSonarProjects
    );
  }, [sonarSelectionMode, autoMappedSonarProjects]);

  const filteredMergeRequests = useMemo(() => {
    const rows = managerState.data?.recentMergeRequests || [];

    return rows.filter((row) => {
      const matchesState = mrState === "all" ? true : row.state === mrState;
      return matchesState;
    });
  }, [managerState.data, mrState]);

  const latestCoreSnapshot = doraState.data?.meta.latestSnapshot;
  const latestManagerSnapshot = managerState.data?.meta.latestSnapshot || null;
  const sonarScopeEmpty = selectedGitLabProjectIds.length > 0 && selectedSonarProjects.length === 0;
  const latestSonarSnapshot = sonarState.data?.meta.latestSnapshotOverall
    || sonarState.data?.meta.latestSnapshotInWindow
    || null;
  const sonarScopeHint = sonarSelectionMode === "auto"
    ? sonarMappingContext.hasAutoSelection
      ? t("eng.autoSelectedSonar").replace("{count}", String(autoMappedSonarProjects.length))
      : selectedGitLabProjectIds.length > 0
        ? t("eng.noSonarMapped")
        : t("eng.noGitlabSelected")
    : t("eng.manualSonarMode");
  const sonarSnapshotStale = Boolean(sonarState.data?.meta.stale);
  const sonarSnapshotTone: SnapshotTone = sonarScopeEmpty
    ? "info"
    : sonarSnapshotStale
    ? "warning"
    : latestSonarSnapshot
      ? "success"
      : "default";
  const sonarSnapshotHint = sonarScopeEmpty
    ? t("eng.sonarScopeEmptyHint")
    : sonarSnapshotStale
    ? t("eng.outsideWindow").replace("{days}", timeRange)
    : latestSonarSnapshot
      ? t("eng.insideWindow")
      : t("eng.noSnapshots");
  const missingDataSources = [
    latestCoreSnapshot ? null : "DORA",
    latestManagerSnapshot ? null : t("eng.mrAnalytics"),
    sonarScopeEmpty || latestSonarSnapshot ? null : "SonarQube",
  ].filter(Boolean);
  const dataStatusMessage = sonarScopeEmpty
    ? sonarScopeHint
    : missingDataSources.length > 0
    ? t("eng.missingSnapshots").replace("{sources}", missingDataSources.join(", "))
    : sonarSnapshotStale
      ? t("eng.sonarStaleMessage")
      : t("eng.allUpToDate");
  const traceability = doraState.data?.summary.traceability || null;
  const scopeSummary = {
    teams: selectedTeams.length || groups.length,
    projects: selectedProjects.length,
    authors: selectedAuthors.length,
    sonarMode: sonarSelectionMode === "auto" ? "Auto" : "Manual",
  };

  // Alcance para el ScopeBanner de la pestaña DORA (Canonical_Author_Identity legibles).
  // El proyecto se deriva del estado React de los filtros (no lo expone la respuesta).
  const scopeBannerProjects = useMemo(
    () =>
      selectedProjects.map((projectId) => {
        const option = availableProjectOptions.find((o) => o.value === projectId);
        return { id: Number(projectId), name: option?.label || projectId };
      }),
    [selectedProjects, availableProjectOptions]
  );
  // Fallback local de autores (estado React) mientras la respuesta DORA no está cargada.
  const scopeBannerAuthorsLocal = useMemo(
    () =>
      selectedAuthors.map((authorKey) => {
        const option = authorOptions.find((o) => o.value === authorKey);
        return { key: authorKey, name: option?.label || authorKey };
      }),
    [selectedAuthors, authorOptions]
  );

  // Fuente canónica del alcance de autor: la respuesta DORA (`summary.authorScope`),
  // que trae los nombres canónicos resueltos en el backend. Mientras no haya datos
  // cargados, se usa el fallback local para que el banner siga funcionando.
  const respAuthorScope = doraState.data?.summary.authorScope;
  const authorScopeActive = respAuthorScope?.active ?? selectedAuthors.length > 0;
  const scopeBannerAuthors =
    respAuthorScope?.active && respAuthorScope.authors.length > 0
      ? respAuthorScope.authors
      : scopeBannerAuthorsLocal;


  async function fetchProjects() {
    try {
      const response = await fetch(
        `/api/metrics/projects?includeInactive=false&inactiveDays=${ACTIVE_PROJECT_LOOKBACK_DAYS}&days=${ACTIVE_PROJECT_LOOKBACK_DAYS}`
      );
      const payload = await response.json();
      setGroups(payload.groups || []);
      setAvailableGitlabGroups(payload.gitlabGroups || []);
    } catch (error) {
      console.error("Failed to fetch projects", error);
    }
  }

  async function fetchDashboards() {
    const params = new URLSearchParams();
    if (timeRange === "custom" && customFrom && customTo) {
      params.set("from", customFrom);
      params.set("to", customTo);
      // Calculate days for backward compat
      const diffMs = new Date(customTo).getTime() - new Date(customFrom).getTime();
      params.set("days", String(Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)))));
    } else {
      params.set("days", timeRange);
    }
    if (selectedTeams.length > 0) params.set("teams", selectedTeams.join(","));
    if (selectedProjects.length > 0) params.set("projectIds", selectedProjects.join(","));
    if (selectedAuthors.length > 0) params.set("authors", selectedAuthors.join(","));
    if (selectedSonarProjects.length > 0) params.set("projectKeys", selectedSonarProjects.join(","));
    const sonarParams = new URLSearchParams(params);
    if (selectedGitLabProjectIds.length > 0 && selectedSonarProjects.length === 0) {
      sonarParams.set("sonarScope", "none");
    }

    setDoraState((current) => ({ ...current, loading: true, error: null }));
    setManagerState((current) => ({ ...current, loading: true, error: null }));
    setSonarState((current) => ({ ...current, loading: true, error: null }));

    const fetchJson = async <T,>(url: string) => {
      const response = await fetch(url);
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || `La petición ha fallado: ${url}`);
      }
      return response.json() as Promise<T>;
    };

    const [doraResult, managerResult, sonarResult] = await Promise.allSettled([
      fetchJson<DoraCoreResponse>(`/api/metrics/dora-core?${params}`),
      fetchJson<ManagerResponse>(`/api/metrics/manager-dashboard?${params}`),
      fetchJson<SonarResponse>(`/api/sonarqube/dashboard?${sonarParams}`),
    ]);

    if (doraResult.status === "fulfilled") {
      setDoraState({ data: doraResult.value, loading: false, error: null });
    } else {
      setDoraState({ data: null, loading: false, error: doraResult.reason?.message || t("eng.doraNotAvailable") });
    }

    if (managerResult.status === "fulfilled") {
      setManagerState({ data: managerResult.value, loading: false, error: null });
    } else {
      setManagerState({ data: null, loading: false, error: managerResult.reason?.message || t("eng.managerNotAvailable") });
    }

    if (sonarResult.status === "fulfilled") {
      setSonarState({ data: sonarResult.value, loading: false, error: null });
    } else {
      setSonarState({ data: null, loading: false, error: sonarResult.reason?.message || t("eng.sonarNotAvailable") });
    }
  }

  function handleSonarProjectsChange(nextProjects: string[]) {
    setSonarSelectionMode("manual");
    setSelectedSonarProjects(nextProjects);
  }

  function restoreAutoMappedSonarSelection() {
    setSonarSelectionMode("auto");
    setSelectedSonarProjects(autoMappedSonarProjects);
  }

  function toggleSonarExportColumn(column: SonarExportColumnKey) {
    setSonarExportColumns((current) => ({
      ...current,
      [column]: !current[column],
    }));
  }

  async function exportSonarPortfolioToExcel() {
    if (sonarPortfolioProjects.length === 0) {
      return;
    }

    const selectedColumns = SONAR_EXPORT_COLUMNS.filter((column) => sonarExportColumns[column.key]);
    if (selectedColumns.length === 0) {
      alert(t("eng.selectAtLeastOneColumn"));
      return;
    }

    setSonarExporting(true);

    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.utils.book_new();
      const gitLabScopeLabel = selectedGitLabProjectsMeta.length > 0
        ? selectedGitLabProjectsMeta.map((project) => project.name).join(", ")
        : t("eng.noExplicitSelection");
      const sonarProjectsByKey = new Map(
        (sonarState.data?.availableProjects || []).map((project) => [project.key, project.name])
      );
      const sonarScopeLabel = selectedSonarProjects.length > 0
        ? selectedSonarProjects
          .map((projectKey) => sonarProjectsByKey.get(projectKey) || projectKey)
          .join(", ")
        : t("eng.noSelection");

      const summaryRows: Array<Array<string | number>> = [
        [t("eng.sonarReport")],
        [t("eng.generated"), new Date().toLocaleString()],
        [t("eng.window"), `${t("eng.lastNDays").replace("{n}", timeRange)}`],
        [t("eng.sonarMode"), sonarSelectionMode === "auto" ? "Sync GitLab" : "Manual"],
        ["Sonar", sonarPortfolioProjects.length],
        [t("eng.teamsInScopeExport"), selectedTeams.length > 0 ? selectedTeams.join(", ") : t("common.all")],
        [t("eng.gitlabInFocusExport"), gitLabScopeLabel],
        [t("eng.sonarSelection"), sonarScopeLabel],
      ];

      const portfolioHeaders = selectedColumns.map((column) => t(column.label));
      const portfolioRows: Array<Array<string | number>> = [
        portfolioHeaders,
        ...sonarPortfolioProjects.map((project) =>
          selectedColumns.map((column) => sonarExportCellValue(project, column.key, t))
        ),
      ];

      const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
      const portfolioSheet = XLSX.utils.aoa_to_sheet(portfolioRows);

      summarySheet["!cols"] = [{ wch: 24 }, { wch: 80 }];
      portfolioSheet["!cols"] = selectedColumns.map((column) => ({
        wch: Math.max(t(column.label).length + 4, 18),
      }));

      XLSX.utils.book_append_sheet(workbook, summarySheet, t("eng.summary"));
      XLSX.utils.book_append_sheet(workbook, portfolioSheet, t("eng.sonarPortfolioSheet"));

      const filename = `sonar-portfolio-${format(new Date(), "yyyyMMdd-HHmm")}.xlsx`;
      XLSX.writeFile(workbook, filename);
      setSonarExportDialogOpen(false);
    } catch (error) {
      console.error("Error exporting Sonar portfolio:", error);
      alert(t("eng.exportError"));
    } finally {
      setSonarExporting(false);
    }
  }

  return (
    <div className="relative min-h-screen px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-6">
        <Card className="overflow-hidden border-border/70 bg-card/90 shadow-[0_24px_70px_-40px_rgba(75,42,19,0.35)] backdrop-blur">
          <CardContent className="p-0">
            <div className="grid gap-0 lg:grid-cols-[1.5fr_0.9fr]">
              <div className="space-y-4 p-6 sm:p-8">
                <Link
                  href="/"
                  className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
                >
                  <Home className="h-4 w-4" />
                  {t("eng.backToPortal")}
                </Link>
                <div className="space-y-3">
                  <div className="inline-flex items-center gap-2 rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
                    <Sparkles className="h-3.5 w-3.5" />
                    {t("eng.badge")}
                  </div>
                  <div>
                    <h1 className="font-display text-3xl font-semibold tracking-tight sm:text-4xl">
                      {t("eng.title")}
                    </h1>
                    <p className="mt-3 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-base">
                      {t("eng.description")}
                    </p>
                  </div>
                </div>
              </div>

              <div className="grid gap-3 border-t border-border/70 bg-secondary/40 p-6 sm:p-8 lg:border-l lg:border-t-0">
                <SnapshotChip
                  label="DORA"
                  value={latestCoreSnapshot ? formatDisplayDate(latestCoreSnapshot) : t("eng.noData")}
                  tone="default"
                />
                <SnapshotChip
                  label={t("eng.mrAnalytics")}
                  value={latestManagerSnapshot ? formatDisplayDate(latestManagerSnapshot) : t("eng.noData")}
                  tone="info"
                />
                <SnapshotChip
                  label="SonarQube"
                  value={latestSonarSnapshot ? formatDisplayDate(latestSonarSnapshot) : t("eng.noData")}
                  tone={sonarSnapshotTone}
                  hint={sonarSnapshotHint}
                />
                <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                    {t("eng.dataStatus")}
                  </div>
                  <div className="mt-2 text-sm leading-6 text-foreground">
                    {dataStatusMessage}
                  </div>
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        <Card className="border-border/70 bg-card/85 shadow-[0_18px_60px_-40px_rgba(75,42,19,0.45)] backdrop-blur">
          <CardHeader className="pb-4">
            <CardTitle className="text-lg">{t("eng.filtersTitle")}</CardTitle>
            <CardDescription>
              {t("eng.filtersDesc")}
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-4">
            <div className="flex flex-col gap-2">
              <label className="block text-sm font-medium">{t("eng.timeWindow")}</label>
              <Select value={timeRange} onValueChange={setTimeRange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SELECTABLE_DAYS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value === "custom" ? "Personalizado" : t("eng.lastNDays").replace("{n}", value)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {timeRange === "custom" && (
                <div className="flex gap-2 mt-1">
                  <input
                    type="date"
                    value={customFrom}
                    onChange={(e) => setCustomFrom(e.target.value)}
                    className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                  <input
                    type="date"
                    value={customTo}
                    onChange={(e) => setCustomTo(e.target.value)}
                    max={new Date().toISOString().slice(0, 10)}
                    className="flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>
              )}
              <Button
                variant={showComparison ? "default" : "outline"}
                size="sm"
                className="mt-2 gap-1.5 w-full text-xs"
                onClick={() => setShowComparison(!showComparison)}
              >
                <BarChart3 className="h-3 w-3" />
                {showComparison ? "Cerrar comparación" : "Comparar periodos"}
              </Button>
            </div>
            {availableGitlabGroups.length > 1 && (
              <div className="flex flex-col gap-2">
                <label className="block text-sm font-medium">Grupo GitLab</label>
                <Select value={selectedGitlabGroup} onValueChange={(v) => {
                  setSelectedGitlabGroup(v);
                  setSelectedTeams([]);
                  setSelectedProjects([]);
                }}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los grupos</SelectItem>
                    {availableGitlabGroups.map((g) => (
                      <SelectItem key={g} value={g}>{g}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="flex flex-col gap-2">
              <label className="block text-sm font-medium">{t("eng.teams")}</label>
              <MultiSelect
                options={teamOptions}
                selected={selectedTeams}
                onChange={setSelectedTeams}
                placeholder={t("eng.allTeams")}
                searchPlaceholder={t("eng.searchTeam")}
              />
            </div>
            <div className="flex flex-col gap-2 lg:col-span-2">
              <label className="block text-sm font-medium">{t("eng.gitlabProjects")}</label>
              <MultiSelect
                options={availableProjectOptions}
                selected={selectedProjects}
                onChange={setSelectedProjects}
                placeholder={t("eng.allProjects")}
                searchPlaceholder={t("eng.searchProject")}
              />
              {/* Presets */}
              <div className="flex flex-wrap items-center gap-1.5 mt-1">
                {presets.map((preset) => (
                  <button
                    key={preset.name}
                    onClick={() => loadPreset(preset)}
                    className="group flex items-center gap-1 px-2 py-0.5 text-[11px] rounded-md bg-primary/10 text-primary hover:bg-primary/20 transition-colors"
                  >
                    {preset.name}
                    <span
                      onClick={(e) => { e.stopPropagation(); deletePreset(preset.name); }}
                      className="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-destructive ml-0.5 cursor-pointer"
                    >×</span>
                  </button>
                ))}
                {selectedProjects.length > 0 && !showPresetSave && (
                  <button
                    onClick={() => setShowPresetSave(true)}
                    className="px-2.5 py-1 text-[11px] rounded-md border border-primary/40 bg-primary/5 text-primary font-medium hover:bg-primary/15 hover:border-primary transition-colors"
                  >
                    💾 {t("eng.savePreset")}
                  </button>
                )}
                {showPresetSave && (
                  <div className="flex items-center gap-1">
                    <input
                      type="text"
                      value={presetName}
                      onChange={(e) => setPresetName(e.target.value)}
                      onKeyDown={(e) => e.key === "Enter" && savePreset()}
                      placeholder={t("eng.presetNamePlaceholder")}
                      className="px-2 py-0.5 text-[11px] rounded-md border border-border bg-background text-foreground w-28"
                      autoFocus
                    />
                    <button onClick={savePreset} className="px-1.5 py-0.5 text-[11px] rounded bg-primary text-primary-foreground">✓</button>
                    <button onClick={() => setShowPresetSave(false)} className="px-1.5 py-0.5 text-[11px] rounded text-muted-foreground">✕</button>
                  </div>
                )}
              </div>
            </div>
            <div className="flex flex-col gap-2 lg:col-span-2">
              <label className="block text-sm font-medium">{t("eng.filteredAuthors") || "Autores"}</label>
              <MultiSelect
                options={authorOptions}
                selected={selectedAuthors}
                onChange={setSelectedAuthors}
                placeholder="Todos los autores"
                searchPlaceholder="Buscar autor..."
              />
            </div>
            <div className="lg:col-span-4">
              <div className="grid gap-3 rounded-2xl border border-border/70 bg-secondary/30 p-4 md:grid-cols-2 xl:grid-cols-4">
                <MiniStat
                  label={t("eng.teamsInScope")}
                  value={String(scopeSummary.teams)}
                  tone="info"
                  tooltip={t("eng.scopeTeamsTooltip")}
                />
                <MiniStat
                  label={t("eng.gitlabProjectsLabel")}
                  value={scopeSummary.projects > 0 ? String(scopeSummary.projects) : t("common.all")}
                  tone={scopeSummary.projects > 0 ? "success" : "default"}
                  tooltip={t("eng.scopeProjectsTooltip")}
                />
                <MiniStat
                  label={t("eng.filteredAuthors")}
                  value={scopeSummary.authors > 0 ? String(scopeSummary.authors) : t("common.all")}
                  tone={scopeSummary.authors > 0 ? "warning" : "default"}
                  tooltip={t("eng.authorsFilteredTooltip")}
                />
                <MiniStat
                  label={t("eng.syncSonar")}
                  value={scopeSummary.sonarMode}
                  tone={sonarSelectionMode === "auto" ? "success" : "info"}
                  tooltip={sonarScopeHint}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Period Comparison Panel */}
        {showComparison && (
          <PeriodComparison
            teams={selectedTeams}
            projectIds={selectedProjects}
            authors={selectedAuthors}
            onClose={() => setShowComparison(false)}
          />
        )}

        <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-6">
          <TabsList className="grid h-auto w-full grid-cols-1 gap-2 rounded-2xl bg-secondary/60 p-2 md:grid-cols-3">
            <TabsTrigger value="dora-core" className="rounded-xl py-3">
              {t("dora.tab.dora")}
            </TabsTrigger>
            <TabsTrigger value="manager-insights" className="rounded-xl py-3">
              {t("dora.tab.management")}
            </TabsTrigger>
            <TabsTrigger value="sonarqube" className="rounded-xl py-3">
              {t("dora.tab.sonarqube")}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="dora-core" className="space-y-6">
            <SectionShell
              title={t("dora.section.title")}
              description={t("dora.section.description")}
              loading={doraState.loading}
              error={doraState.error}
              actions={<MetricsActions />}
            >
              {doraState.data && (
                <>
                  <ScopeBanner
                    teams={selectedTeams}
                    projects={scopeBannerProjects}
                    authors={scopeBannerAuthors}
                  />
                  {doraState.data.summary.authorScope.active && (
                    <AttributionCoverageNotice
                      coverage={doraState.data.summary.authorScope.attributionCoverage}
                      threshold={
                        doraState.data.summary.authorScope.attributionCoverageThreshold
                      }
                    />
                  )}
                  {doraState.data.summary.authorScope.active &&
                    doraState.data.summary.deploymentFrequency.current === 0 &&
                    isDoraNotAvailable(doraState.data.summary.leadTimeForChanges) && (
                      <DoraEmptyState
                        authors={doraState.data.summary.authorScope.authors}
                      />
                    )}
                  {doraState.data.meta.daysWithData < 7 && selectedProjects.length === 0 && (
                    <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      {t("eng.limitedData")
                        .replace("{n}", String(doraState.data.meta.daysWithData))
                        .replace("{m}", String(doraState.data.meta.daysRequested))}
                    </div>
                  )}
                  {doraState.data.meta.daysRequested > 0 &&
                    doraState.data.meta.daysWithData / doraState.data.meta.daysRequested < 0.7 &&
                    selectedProjects.length === 0 && (
                    <div className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning">
                      <AlertTriangle className="h-4 w-4 shrink-0" />
                      {t("eng.insufficientCoverage")
                        .replace("{n}", String(doraState.data.meta.daysWithData))
                        .replace("{m}", String(doraState.data.meta.daysRequested))}
                    </div>
                  )}
                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                    <MetricCard
                      title="Deployment Frequency"
                      value={doraState.data.summary.deploymentFrequency.current.toFixed(2)}
                      subtitle={t("eng.deployFreqSub")}
                      trend={doraState.data.summary.deploymentFrequency.change}
                      icon={GitBranch}
                      badge={
                        <>
                          <DoraPerformanceBadge metric="deployFreq" value={doraState.data.summary.deploymentFrequency.current} compact />
                          {doraState.data.summary.anomalies?.deploymentFrequency && (
                            <Badge variant="outline" className="border-warning/50 bg-warning/10 text-warning text-[10px] px-1.5 py-0">
                              <AlertTriangle className="mr-1 h-3 w-3" />
                              {t("eng.outlierDetected")}
                            </Badge>
                          )}
                        </>
                      }
                      explanation={t("eng.explainDeployFreq")}
                    />
                    <MetricCard
                      title={t("eng.leadTimeTitle")}
                      value={
                        isDoraNotAvailable(doraState.data.summary.leadTimeForChanges)
                          ? t("metrics.dora.notAvailable", "No disponible")
                          : doraState.data.summary.authorScope.active
                            ? formatDuration(
                                doraState.data.summary.leadTimeForChanges.current
                              )
                            : formatDuration(doraState.data.summary.leadTimeFirstCommit.current)
                      }
                      subtitle={`${t("eng.leadTimeFromMr")}: ${formatDuration(doraState.data.summary.leadTimeFromMr.current)}  |  ${t("eng.leadTimeFromLastCommit")}: ${formatDuration(doraState.data.summary.leadTimeCommit.current)}`}
                      trend={metricChangeOrUndefined(doraState.data.summary.leadTimeForChanges)}
                      inverse
                      icon={Clock3}
                      badge={<DoraPerformanceBadge metric="leadTime" value={metricCurrentOrZero(doraState.data.summary.leadTimeForChanges)} compact />}
                      explanation={t("eng.explainLeadTime")}
                    />
                    <MetricCard
                      title="Change Failure Rate"
                      value={
                        isDoraNotAvailable(doraState.data.summary.changeFailureRate)
                          ? t("metrics.dora.notAvailable", "No disponible")
                          : `${doraState.data.summary.changeFailureRate.current.toFixed(1)}%`
                      }
                      subtitle={`${doraState.data.summary.totals.failures} ${t("eng.cfrSub")}`}
                      trend={metricChangeOrUndefined(doraState.data.summary.changeFailureRate)}
                      inverse
                      icon={AlertTriangle}
                      badge={
                        <>
                          <DoraPerformanceBadge metric="cfr" value={metricCurrentOrZero(doraState.data.summary.changeFailureRate)} compact />
                          <DeploymentLevelBadge metric="cfr" visible={authorScopeActive} />
                        </>
                      }
                      explanation={
                        doraState.data.summary.reliabilitySignals.cfrSource === "hybrid"
                          ? t("eng.explainCfrHybrid").replace("{pct}", doraState.data.summary.reliabilitySignals.coveragePct.toFixed(1))
                          : t("eng.explainCfrGitlab")
                      }
                    />
                    <MetricCard
                      title={t("eng.pipelineRecoveryTime")}
                      value={
                        isDoraNotAvailable(doraState.data.summary.mttr)
                          ? t("metrics.dora.notAvailable", "No disponible")
                          : formatDuration(doraState.data.summary.mttr.current)
                      }
                      subtitle={t("eng.mttrSub")}
                      trend={metricChangeOrUndefined(doraState.data.summary.mttr)}
                      inverse
                      icon={RefreshCcw}
                      badge={
                        <>
                          <DoraPerformanceBadge metric="mttr" value={metricCurrentOrZero(doraState.data.summary.mttr)} compact />
                          <DeploymentLevelBadge metric="recovery" visible={authorScopeActive} />
                        </>
                      }
                      explanation={
                        `${t("eng.pipelineRecoveryTimeDesc")} ${
                          doraState.data.summary.reliabilitySignals.mttrSource === "hybrid"
                            ? t("eng.explainMttrHybrid").replace("{pct}", (doraState.data.summary.reliabilitySignals.averageConfidence * 100).toFixed(1))
                            : t("eng.explainMttrGitlab")
                        }`
                      }
                    />
                  </div>

                  <Card className="border-border/70 bg-card/85">
                    <CardContent className="grid gap-3 p-5 sm:grid-cols-2 xl:grid-cols-3">
                        <MiniStat
                          label={t("eng.successfulDeploys")}
                          value={String(doraState.data.summary.totals.deployments)}
                          tone="success"
                        />
                        <MiniStat
                          label={t("eng.uniqueCommits")}
                          value={String(doraState.data.summary.totals.uniqueDeployments)}
                          tone="info"
                          tooltip={t("eng.uniqueCommitsTooltip")}
                        />
                        <MiniStat
                          label="Hotfixes"
                          value={String(doraState.data.summary.totals.hotfixes)}
                          tone={doraState.data.summary.totals.hotfixes > 0 ? "warning" : "default"}
                        />
                        <MiniStat
                          label="Rollbacks"
                          value={String(doraState.data.summary.totals.rollbacks)}
                          tone={doraState.data.summary.totals.rollbacks > 0 ? "danger" : "default"}
                        />
                        <MiniStat
                          label={t("eng.failures")}
                          value={String(doraState.data.summary.totals.failures)}
                          tone={doraState.data.summary.totals.failures > 0 ? "danger" : "default"}
                        />
                    </CardContent>
                  </Card>

                  {/* DORA Performance Level & Benchmarks */}
                  <Card className="border-border/70 bg-card/85">
                    <CardContent className="space-y-4 p-5">
                      <div className="flex items-center justify-between">
                        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                          {t("dora.performanceLevel")}
                        </div>
                        <DoraPerformanceSummary
                          deployFreq={doraState.data.summary.deploymentFrequency.current}
                          leadTime={metricCurrentOrZero(doraState.data.summary.leadTimeForChanges)}
                          cfr={metricCurrentOrZero(doraState.data.summary.changeFailureRate)}
                          mttr={metricCurrentOrZero(doraState.data.summary.mttr)}
                        />
                      </div>
                      <DoraBenchmarksTable
                        deployFreq={doraState.data.summary.deploymentFrequency.current}
                        leadTime={metricCurrentOrZero(doraState.data.summary.leadTimeForChanges)}
                        cfr={metricCurrentOrZero(doraState.data.summary.changeFailureRate)}
                        mttr={metricCurrentOrZero(doraState.data.summary.mttr)}
                      />
                    </CardContent>
                  </Card>

                  <div className="grid gap-4 xl:grid-cols-2">
                    <ChartCard
                      title={t("dora.deliveryAndLeadTime")}
                      description={t("dora.deliveryAndLeadTimeDesc")}
                    >
                      <ResponsiveContainer width="100%" height={280}>
                        <ComposedChart data={doraState.data.trend}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                          <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                          <YAxis yAxisId="left" tick={{ fontSize: 12 }} tickFormatter={formatAxisCount} />
                          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} tickFormatter={formatAxisDurationTick} />
                          <Tooltip content={<ChartTooltip />} />
                          <Legend />
                          <Bar
                            yAxisId="left"
                            dataKey="deployments"
                            fill="hsl(var(--primary))"
                            name={t("eng.successfulDeploysChart")}
                            unit="count"
                            radius={[6, 6, 0, 0]}
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="leadTimeEffectiveHours"
                            stroke="hsl(var(--warning))"
                            strokeWidth={2.5}
                            dot={false}
                            connectNulls={false}
                            name={t("eng.effectiveLeadTime")}
                            unit="duration"
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </ChartCard>

                    <ChartCard
                      title={t("dora.reliability")}
                      description={t("dora.reliabilityDesc")}
                    >
                      <ResponsiveContainer width="100%" height={280}>
                        <ComposedChart data={doraState.data.trend}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                          <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                          <YAxis yAxisId="left" tick={{ fontSize: 12 }} tickFormatter={formatAxisPercent} />
                          <YAxis yAxisId="right" orientation="right" tick={{ fontSize: 12 }} tickFormatter={formatAxisDurationTick} />
                          <Tooltip content={<ChartTooltip />} />
                          <Legend />
                          <Area
                            yAxisId="left"
                            type="monotone"
                            dataKey="changeFailureRate"
                            stroke="hsl(var(--danger))"
                            fill="hsl(var(--danger) / 0.16)"
                            strokeWidth={2.5}
                            connectNulls={false}
                            name="Change Failure Rate"
                            unit="percent"
                          />
                          <Line
                            yAxisId="right"
                            type="monotone"
                            dataKey="mttrHours"
                            stroke="hsl(var(--warning))"
                            strokeWidth={2.5}
                            dot={false}
                            connectNulls={false}
                            name="Pipeline Recovery Time"
                            unit="duration"
                          />
                        </ComposedChart>
                      </ResponsiveContainer>
                    </ChartCard>
                  </div>

                  {/* Recent deployment traces hidden — too technical for managers */}
                  {/* Tech leads can access this data via the audit panel */}
                </>
              )}
            </SectionShell>
          </TabsContent>

          <TabsContent value="manager-insights" className="space-y-6">
            <SectionShell
              title={t("dora.management.title")}
              description={t("dora.management.description")}
              loading={false}
              error={null}
            >
              <TeamActivityTab
                teams={selectedTeams}
                projectIds={selectedProjects.map(Number).filter(Boolean)}
                days={parseInt(timeRange, 10) || 30}
                from={timeRange === "custom" && customFrom && customTo ? customFrom : undefined}
                to={timeRange === "custom" && customFrom && customTo ? customTo : undefined}
                authorUsernames={selectedAuthorUsernames}
              />
            </SectionShell>
          </TabsContent>


          <TabsContent value="sonarqube" className="space-y-6">
            <SectionShell
              title={t("dora.sonarqube.title")}
              description={t("dora.sonarqube.description")}
              loading={sonarState.loading}
              error={sonarState.error}
            >
              {sonarState.data && (
                <>
                  {sonarState.data.meta.stale && sonarState.data.meta.latestSnapshotOverall && (
                    <Card className="border-warning/30 bg-warning/5">
                      <CardContent className="py-4 text-sm leading-6 text-foreground">
                        No hay snapshots de SonarQube dentro de los últimos {timeRange} días. El último snapshot
                        disponible es del {formatDisplayDate(sonarState.data.meta.latestSnapshotOverall)}; revisa la
                        ejecución nocturna unificada o un fallo parcial del proceso de snapshots.
                      </CardContent>
                    </Card>
                  )}

                  {/* <AuditOverviewCard
                    title="Metodología y calidad del dato"
                    audit={sonarState.data.audit}
                  /> */}

                  <Card className="border-border/70 bg-card/85">
                    <CardContent className="space-y-4 p-5">
                      <div className="grid gap-4 lg:grid-cols-[1fr_0.9fr]">
                        <div className="flex flex-col gap-2">
                          <div className="flex items-center justify-between gap-3">
                            <label className="block text-sm font-medium">{t("eng.sonarProjectsLabel")}</label>
                            <div className="flex items-center gap-2">
                              <Badge className={sonarSelectionMode === "auto" ? "bg-success/15 text-success" : "bg-info/15 text-info"}>
                                {sonarSelectionMode === "auto" ? "Sync GitLab" : "Manual"}
                              </Badge>
                              <button
                                type="button"
                                onClick={restoreAutoMappedSonarSelection}
                                className="text-xs font-medium text-primary transition-colors hover:text-primary/80"
                              >
                                {t("eng.backToMappingLabel")}
                              </button>
                            </div>
                          </div>
                          <MultiSelect
                            options={sonarOptions}
                            selected={selectedSonarProjects}
                            onChange={handleSonarProjectsChange}
                            placeholder={t("eng.sonarByScopeLabel")}
                            searchPlaceholder={t("eng.searchSonarProjectLabel")}
                          />
                        </div>
                        <div className="grid grid-cols-2 gap-3 rounded-2xl border border-border/70 bg-secondary/35 p-4">
                          <MiniStat label="Quality Gate OK" value={String(sonarState.data.summary.qualityGate.ok)} tone="success" />
                          <MiniStat label="Quality Gate ERROR" value={String(sonarState.data.summary.qualityGate.error)} tone="danger" />
                          <MiniStat label="Warn / Unknown" value={String(sonarState.data.summary.qualityGate.warn)} tone="warning" />
                          <MiniStat label={t("eng.complianceRateLabel")} value={`${sonarState.data.summary.qualityGate.passRate.toFixed(1)}%`} tone="info" />
                        </div>
                      </div>

                      <div className="rounded-2xl border border-border/70 bg-background/80 p-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                          <div className="space-y-1">
                            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                              {t("eng.selectionContextLabel")}
                            </div>
                            <div className="text-sm leading-6 text-foreground">
                              {sonarScopeHint}
                            </div>
                          </div>
                          <div className="grid min-w-[280px] grid-cols-2 gap-3 lg:w-[360px]">
                            <MiniStat
                              label={t("eng.mapped")}
                              value={String(sonarCatalogMapping.mappedProjects)}
                              tone="success"
                              tooltip={t("eng.sonarMappedTooltip")}
                            />
                            <MiniStat
                              label={t("eng.noMapping")}
                              value={String(sonarCatalogMapping.unmappedProjects)}
                              tone={sonarCatalogMapping.unmappedProjects > 0 ? "warning" : "default"}
                              tooltip={t("eng.sonarUnmappedTooltip")}
                            />
                            <MiniStat
                              label={t("eng.mappingCoverage")}
                              value={`${sonarCatalogMapping.mappingCoveragePct.toFixed(1)}%`}
                              tone={coverageTone(sonarCatalogMapping.mappingCoveragePct)}
                              tooltip={t("eng.sonarMappingCoverageTooltip")}
                            />
                            <MiniStat
                              label={t("eng.gitlabNoSonar")}
                              value={String(sonarMappingContext.unmappedGitLabProjects)}
                              tone={sonarMappingContext.unmappedGitLabProjects > 0 ? "warning" : "success"}
                              tooltip={t("eng.gitlabNoSonarTooltip")}
                            />
                          </div>
                        </div>
                      </div>

                      <div className="grid gap-3 md:grid-cols-3">
                        <MiniStat
                          label={t("eng.gitlabInFocus")}
                          value={String(sonarMappingContext.selectedGitLabProjects)}
                          tone="info"
                          tooltip={t("eng.gitlabInFocusTooltip")}
                        />
                            <MiniStat
                              label={t("eng.sonarAutoDetected")}
                              value={String(sonarMappingContext.autoSelectedSonarProjects)}
                              tone={sonarMappingContext.hasAutoSelection ? "success" : "default"}
                              tooltip={t("eng.sonarAutoDetectedTooltip")}
                            />
                        <MiniStat
                          label={t("eng.effectiveSelection")}
                          value={selectedSonarProjects.length > 0 ? String(selectedSonarProjects.length) : t("eng.free")}
                          tone={selectedSonarProjects.length > 0 ? "info" : "default"}
                          tooltip={t("eng.effectiveSelectionTooltip")}
                        />
                      </div>
                    </CardContent>
                  </Card>

                  {selectedGitLabProjectIds.length > 0 && selectedSonarProjects.length === 0 ? (
                    <Card className="border-info/25 bg-info/5">
                      <CardContent className="py-4 text-sm leading-6 text-foreground">
                        {t("eng.sonarScopeEmptyInfo")}
                      </CardContent>
                    </Card>
                  ) : null}

                  <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                    <MetricCard
                      title={t("eng.avgCoverage")}
                      value={`${sonarState.data.summary.averageCoverage.toFixed(1)}%`}
                      subtitle={`${sonarState.data.summary.projectCount} ${t("eng.projects")}`}
                      icon={ShieldCheck}
                      explanation={t("eng.explainAvgCoverage")}
                    />
                    <MetricCard
                      title={t("eng.vulnerabilities")}
                      value={String(sonarState.data.summary.totalVulnerabilities)}
                      subtitle={`${sonarState.data.summary.totalSecurityHotspots} hotspots`}
                      icon={ShieldAlert}
                      inverse
                      explanation={t("eng.explainVulnerabilities")}
                    />
                    <MetricCard
                      title={t("eng.techDebt")}
                      value={formatDuration(sonarState.data.summary.techDebtHours)}
                      subtitle={`${sonarState.data.summary.totalCodeSmells} code smells`}
                      inverse
                      icon={Code2}
                      explanation={t("eng.explainTechDebt")}
                    />
                  </div>

                  <div className="grid gap-4 xl:grid-cols-2">
                    <ChartCard
                      title={t("eng.coverageAndDuplication")}
                      description={t("eng.coverageAndDuplicationDesc")}
                    >
                      <ResponsiveContainer width="100%" height={280}>
                        <LineChart data={sonarState.data.trend}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                          <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                          <YAxis tick={{ fontSize: 12 }} tickFormatter={formatAxisPercent} />
                          <Tooltip content={<ChartTooltip />} />
                          <Legend />
                          <Line
                            type="monotone"
                            dataKey="coverage"
                            stroke="hsl(var(--success))"
                            strokeWidth={2.5}
                            dot={false}
                            name={t("eng.coverage")}
                            unit="percent"
                          />
                          <Line
                            type="monotone"
                            dataKey="duplication"
                            stroke="hsl(var(--warning))"
                            strokeWidth={2.5}
                            dot={false}
                            name={t("eng.duplication")}
                            unit="percent"
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </ChartCard>

                    <ChartCard
                      title={t("eng.aggregatedRisk")}
                      description={t("eng.aggregatedRiskDesc")}
                    >
                      <ResponsiveContainer width="100%" height={280}>
                        <BarChart data={sonarState.data.trend}>
                          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                          <XAxis dataKey="date" tick={{ fontSize: 12 }} />
                          <YAxis tick={{ fontSize: 12 }} tickFormatter={formatAxisCount} />
                          <Tooltip content={<ChartTooltip />} />
                          <Legend />
                          <Bar dataKey="bugs" fill="hsl(var(--danger))" radius={[6, 6, 0, 0]} name="Bugs" unit="count" />
                          <Bar dataKey="vulnerabilities" fill="hsl(var(--warning))" radius={[6, 6, 0, 0]} name="Vulnerabilities" unit="count" />
                          <Bar dataKey="securityHotspots" fill="hsl(var(--info))" radius={[6, 6, 0, 0]} name="Hotspots" unit="count" />
                        </BarChart>
                      </ResponsiveContainer>
                    </ChartCard>
                  </div>

                  <div className="grid gap-4 xl:grid-cols-3">
                    <ReportCard
                      title={t("eng.highestRisk")}
                      description={t("eng.highestRiskDesc")}
                      rows={sonarState.data.reports.highestRisk}
                    />
                    <ReportCard
                      title={t("eng.lowestCoverage")}
                      description={t("eng.lowestCoverageDesc")}
                      rows={sonarState.data.reports.weakestCoverage}
                    />
                    <ReportCard
                      title={t("eng.mostDebt")}
                      description={t("eng.mostDebtDesc")}
                      rows={sonarState.data.reports.mostDebt}
                    />
                  </div>

                  <Card className="border-border/70 bg-card/85">
                    <CardHeader className="gap-4 md:flex-row md:items-start md:justify-between">
                      <div>
                        <CardTitle className="text-lg">{t("eng.sonarPortfolio")}</CardTitle>
                        <CardDescription>
                          {t("eng.sonarPortfolioDesc")}
                        </CardDescription>
                      </div>
                      <div className="flex flex-col items-start gap-2 md:items-end">
                        <div className="text-sm text-muted-foreground">
                          {selectedSonarProjects.length === 0
                            ? t("eng.noSonarSelection")
                            : `${sonarPortfolioProjects.length} ${t("eng.projectsReady")}`}
                        </div>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="gap-2"
                          disabled={sonarPortfolioProjects.length === 0}
                          onClick={() => setSonarExportDialogOpen(true)}
                        >
                          <Download className="h-4 w-4" />
                          {t("eng.exportExcel")}
                        </Button>
                      </div>
                    </CardHeader>
                    <CardContent>
                      {selectedSonarProjects.length === 0 ? (
                        <EmptyState message={sonarScopeEmpty
                          ? t("eng.sonarScopeEmptyAutoMsg")
                          : t("eng.sonarSelectManualMsg")} />
                      ) : sonarPortfolioProjects.length === 0 ? (
                        <EmptyState message={t("eng.sonarNoSnapshotMsg")} />
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>{t("eng.project")}</TableHead>
                              <TableHead>{t("eng.gitlabCol")}</TableHead>
                              <TableHead>{t("eng.gateCol")}</TableHead>
                              <TableHead>{t("eng.coverageColTable")}</TableHead>
                              <TableHead>{t("eng.bugsCol")}</TableHead>
                              <TableHead>{t("eng.vulnerabilitiesCol")}</TableHead>
                              <TableHead>{t("eng.debtColTable")}</TableHead>
                              <TableHead>{t("eng.coverageDeltaCol")}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {sonarPortfolioProjects.map((project) => (
                              <TableRow key={project.key}>
                                <TableCell>
                                  <div className="font-medium">{project.name}</div>
                                  <div className="text-xs text-muted-foreground">{project.key}</div>
                                </TableCell>
                                <TableCell>
                                  {project.mappedToGitLab ? (
                                    <div>
                                      <Badge className="bg-success/15 text-success">{t("eng.linked")}</Badge>
                                      <div className="mt-1 text-xs text-muted-foreground">
                                        {project.gitlabProjectPath || `#${project.gitlabProjectId}`}
                                      </div>
                                    </div>
                                  ) : (
                                    <Badge className="bg-muted text-muted-foreground">{t("eng.noMapping")}</Badge>
                                  )}
                                </TableCell>
                                <TableCell>
                                  <Badge className={qualityGateClass(project.qualityGate)}>{project.qualityGate}</Badge>
                                </TableCell>
                                <TableCell>{project.coverage.toFixed(1)}%</TableCell>
                                <TableCell>{project.bugs}</TableCell>
                                <TableCell>{project.vulnerabilities}</TableCell>
                                <TableCell>{formatDuration(project.techDebtHours)}</TableCell>
                                <TableCell className={deltaClass(project.delta.coverage, true)}>
                                  {signed(project.delta.coverage, "%")}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                    </CardContent>
                  </Card>

                  <Dialog open={sonarExportDialogOpen} onOpenChange={setSonarExportDialogOpen}>
                    <DialogContent className="max-w-2xl">
                      <DialogHeader>
                        <DialogTitle>{t("eng.exportSonarPortfolio")}</DialogTitle>
                        <DialogDescription>
                          {t("eng.exportSonarPortfolioDesc")}
                        </DialogDescription>
                      </DialogHeader>

                      <div className="grid gap-4">
                        <div className="grid gap-3 rounded-2xl border border-border/70 bg-secondary/30 p-4 md:grid-cols-3">
                          <MiniStat
                            label={t("eng.projectsInExport")}
                            value={String(sonarPortfolioProjects.length)}
                            tone={sonarPortfolioProjects.length > 0 ? "success" : "default"}
                          />
                          <MiniStat
                            label={t("eng.activeColumns")}
                            value={String(selectedSonarExportColumnCount)}
                            tone={selectedSonarExportColumnCount > 0 ? "info" : "warning"}
                          />
                          <MiniStat
                            label={t("eng.sonarMode")}
                            value={sonarSelectionMode === "auto" ? "Sync GitLab" : "Manual"}
                            tone={sonarSelectionMode === "auto" ? "success" : "info"}
                          />
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                          {SONAR_EXPORT_COLUMNS.map((column) => (
                            <label
                              key={column.key}
                              className="flex items-center gap-3 rounded-2xl border border-border/70 bg-background/80 px-4 py-3"
                            >
                              <Checkbox
                                checked={sonarExportColumns[column.key]}
                                onCheckedChange={() => toggleSonarExportColumn(column.key)}
                              />
                              <span className="text-sm text-foreground">{t(column.label)}</span>
                            </label>
                          ))}
                        </div>
                      </div>

                      <DialogFooter>
                        <Button variant="outline" onClick={() => setSonarExportDialogOpen(false)}>
                          {t("common.cancel")}
                        </Button>
                        <Button
                          onClick={exportSonarPortfolioToExcel}
                          disabled={sonarPortfolioProjects.length === 0 || selectedSonarExportColumnCount === 0 || sonarExporting}
                          className="gap-2"
                        >
                          {sonarExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                          {t("eng.exportExcel")}
                        </Button>
                      </DialogFooter>
                    </DialogContent>
                  </Dialog>
                </>
              )}
            </SectionShell>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

// SectionShell imported from @/components/metrics/shared

// MetricCard, ChartCard imported from @/components/metrics/shared

function AuditOverviewCard({
  title,
  audit,
}: {
  title: string;
  audit: AuditSummary;
}) {
  return (
    <Card className="relative overflow-hidden border-border/70 bg-[linear-gradient(180deg,hsl(var(--card))_0%,hsl(var(--card)/0.97)_100%)] shadow-[0_18px_50px_-36px_rgba(75,42,19,0.55)]">
      <div className="pointer-events-none absolute inset-x-6 top-0 h-px bg-gradient-to-r from-transparent via-info/30 to-transparent" />
      <CardContent className="space-y-4 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="space-y-1">
            <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{title}</div>
            <div className="text-sm font-medium leading-6 text-foreground">{audit.sourceOfTruth}</div>
          </div>
          <Badge className="w-fit bg-info/12 text-info">{audit.methodologyVersion}</Badge>
        </div>

        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          <MiniStat
            label="Confianza"
            value={`${audit.confidenceLabel.toUpperCase()} · ${(audit.confidenceScore * 100).toFixed(0)}%`}
            tone={confidenceTone(audit.confidenceScore)}
          />
          <MiniStat
            label={audit.coverageLabel}
            value={`${audit.coveragePct.toFixed(1)}%`}
            tone={coverageTone(audit.coveragePct)}
          />
          <MiniStat
            label="Anomalías"
            value={String(audit.anomalies)}
            tone={audit.anomalies === 0 ? "success" : audit.anomalies <= 2 ? "warning" : "danger"}
          />
          <MiniStat
            label="Checks"
            value={String(audit.checks.length)}
            tone="info"
          />
        </div>

        <div className="rounded-2xl border border-border/70 bg-background/80 p-4 text-sm leading-6 text-muted-foreground">
          {audit.note}
        </div>

        <div className="flex flex-wrap gap-2">
          {audit.checks.map((check) => (
            <Badge
              key={check.key}
              className={auditCheckBadgeClass(check.status)}
              title={`${check.label}: ${check.value}. ${check.detail}`}
            >
              {check.label}: {check.value}
            </Badge>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function SnapshotChip({
  label,
  value,
  tone,
  hint,
}: {
  label: string;
  value: string;
  tone: SnapshotTone;
  hint?: string;
}) {
  return (
    <div className={cn("rounded-2xl border px-4 py-3", snapshotToneClass(tone))}>
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
      <div className="mt-1 text-sm font-medium">{value}</div>
      {hint ? <div className="mt-1 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  );
}

// MiniStat imported from @/components/metrics/shared

function ReportCard({
  title,
  description,
  rows,
}: {
  title: string;
  description: string;
  rows: SonarProject[];
}) {
  const { t } = useI18n();
  return (
    <Card className="border-border/70 bg-card/85">
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 ? (
          <EmptyState message={t("eng.noHistoricalDataMsg")} />
        ) : (
          rows.map((row) => (
            <div key={row.key} className="rounded-2xl border border-border/70 bg-background/80 p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-medium">{row.name}</div>
                  <div className="text-xs text-muted-foreground">{row.key}</div>
                  {row.mappedToGitLab ? (
                    <div className="mt-2 text-xs text-muted-foreground">
                      GitLab: {row.gitlabProjectPath || `#${row.gitlabProjectId}`}
                    </div>
                  ) : (
                    <div className="mt-2 text-xs text-muted-foreground">{t("eng.noGitlabMapping")}</div>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <Badge className={qualityGateClass(row.qualityGate)}>{row.qualityGate}</Badge>
                  <Badge className={row.mappedToGitLab ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}>
                    {row.mappedToGitLab ? t("eng.linked") : t("eng.notLinked")}
                  </Badge>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                <span>{t("eng.coverageLabel")} {row.coverage.toFixed(1)}%</span>
                <span>{t("eng.debtLabel")} {formatDuration(row.techDebtHours)}</span>
                <span>{t("eng.vulnerabilitiesLabel")} {row.vulnerabilities}</span>
                <span>{t("eng.riskLabel")} {row.riskScore.toFixed(1)}</span>
              </div>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

// EmptyState imported from @/components/metrics/shared

// Format utilities imported from @/lib/format-utils

function formatChartMetricValue(value: unknown, unit?: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return String(value);
  }

  if (unit === "duration") {
    return formatDuration(value);
  }
  if (unit === "percent") {
    return `${value.toFixed(1)}%`;
  }
  if (unit === "count") {
    return String(Math.round(value));
  }

  return value.toFixed(2);
}

function CollapsibleSection({ title, children, defaultOpen = false }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Card className="border-border/70 bg-card/85">
      <CardHeader className="cursor-pointer select-none" onClick={() => setOpen(!open)}>
        <CardTitle className="flex items-center gap-2 text-base">
          {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          {title}
        </CardTitle>
      </CardHeader>
      {open && <CardContent>{children}</CardContent>}
    </Card>
  );
}

function ChartTooltip({ active, payload, label }: any) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-xl border border-border/70 bg-background/95 p-3 shadow-lg">
      <div className="mb-2 text-xs font-semibold uppercase tracking-[0.16em] text-muted-foreground">{label}</div>
      <div className="space-y-1">
        {payload.map((entry: any) => (
          <div key={entry.dataKey} className="flex items-center justify-between gap-4 text-xs">
            <span className="text-muted-foreground">{entry.name || entry.dataKey}</span>
            <span className="font-semibold" style={{ color: entry.color }}>
              {formatChartMetricValue(entry.value, entry.unit)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function sameStringArray(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function extractSonarRepoCandidate(sonarProjectKey: string) {
  const normalizedKey = sonarProjectKey.trim().toLowerCase();
  if (!normalizedKey.startsWith("iskaypetcom")) {
    return null;
  }

  const segments = sonarProjectKey
    .split(":")
    .map((segment) => normalizeProjectToken(segment))
    .filter(Boolean);

  return segments.length >= 2 ? segments[segments.length - 1] : null;
}

function normalizeProjectToken(value: string | null | undefined) {
  return (value || "")
    .trim()
    .toLowerCase()
    .replace(/\.git$/, "");
}

// formatDuration, formatDisplayDate, formatTimestamp, shortSha, describeLeadTime, signed, trendStateClass
// imported from @/lib/format-utils

function stateBadgeClass(state: MergeRequest["state"]) {
  if (state === "merged") return "bg-success/15 text-success";
  if (state === "opened") return "bg-info/15 text-info";
  return "bg-muted text-muted-foreground";
}

function reviewBadgeClass(hours: number) {
  if (hours <= 48) return "bg-success/15 text-success";
  if (hours <= 24 * 7) return "bg-warning/15 text-warning";
  return "bg-danger/15 text-danger";
}

function humanizeMrState(state: MergeRequest["state"], t: (key: string) => string) {
  if (state === "merged") return t("eng.merged");
  if (state === "opened") return t("eng.opened");
  if (state === "closed") return t("eng.closed");
  return t("eng.locked");
}

function qualityGateClass(status: string) {
  if (status === "OK") return "bg-success/15 text-success";
  if (status === "ERROR") return "bg-danger/15 text-danger";
  return "bg-warning/15 text-warning";
}

function deltaClass(value: number, positiveIsGood = false) {
  if (value === 0) return "text-muted-foreground";
  const positive = value > 0;
  const good = positiveIsGood ? positive : !positive;
  return good ? "text-success" : "text-danger";
}

function humanizeStability(stability: string, t: (key: string) => string) {
  if (stability === "very_stable") return t("eng.veryStable");
  if (stability === "volatile") return t("eng.volatile");
  return t("eng.stable");
}

function humanizeDeployType(type: "feature" | "hotfix" | "rollback") {
  if (type === "hotfix") return "Hotfix";
  if (type === "rollback") return "Rollback";
  return "Feature";
}

function stabilityTone(stability: string): "success" | "warning" | "info" {
  if (stability === "very_stable") return "success";
  if (stability === "volatile") return "warning";
  return "info";
}

function stabilityToneFromLeadTime(hours: number): "success" | "warning" | "info" {
  if (hours <= 24) return "success";
  if (hours <= 24 * 7) return "info";
  return "warning";
}

function snapshotToneClass(tone: SnapshotTone) {
  if (tone === "info") return "border-info/25 bg-info/8";
  if (tone === "success") return "border-success/25 bg-success/8";
  if (tone === "warning") return "border-warning/25 bg-warning/8";
  return "border-border/70 bg-background/80";
}

function sonarExportCellValue(project: SonarProject, key: SonarExportColumnKey, t: (key: string) => string): string | number {
  if (key === "projectName") return project.name;
  if (key === "projectKey") return project.key;
  if (key === "gitlabProjectPath") return project.gitlabProjectPath || "";
  if (key === "mappingStatus") return project.mappedToGitLab ? t("eng.linked") : t("eng.noMapping");
  if (key === "qualityGate") return project.qualityGate;
  if (key === "coverage") return Number(project.coverage.toFixed(1));
  if (key === "duplication") return Number(project.duplication.toFixed(1));
  if (key === "bugs") return project.bugs;
  if (key === "vulnerabilities") return project.vulnerabilities;
  if (key === "securityHotspots") return project.securityHotspots;
  if (key === "codeSmells") return project.codeSmells;
  if (key === "techDebtHours") return Number(project.techDebtHours.toFixed(2));
  if (key === "coverageDelta") return Number(project.delta.coverage.toFixed(1));
  return "";
}

// miniStatToneClass moved to shared MiniStat component

function confidenceTone(score: number): "success" | "warning" | "danger" {
  if (score >= 0.8) return "success";
  if (score >= 0.55) return "warning";
  return "danger";
}

function auditCheckBadgeClass(status: AuditCheck["status"]) {
  if (status === "pass") return "bg-success/15 text-success";
  if (status === "warn") return "bg-warning/15 text-warning";
  if (status === "fail") return "bg-danger/15 text-danger";
  return "bg-info/12 text-info";
}

function coverageTone(pct: number): "success" | "warning" | "danger" {
  if (pct >= 85) return "success";
  if (pct >= 60) return "warning";
  return "danger";
}

function deployTypeBadgeClass(type: "feature" | "hotfix" | "rollback") {
  if (type === "hotfix") return "bg-warning/15 text-warning";
  if (type === "rollback") return "bg-danger/15 text-danger";
  return "bg-success/15 text-success";
}
