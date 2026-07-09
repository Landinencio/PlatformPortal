/**
 * Shared type definitions for metrics dashboards.
 * Extracted from engineering-dashboard.tsx for reuse across components.
 */

export type Group = {
  name: string;
  path: string;
  projects: Project[];
};

export type Project = {
  id: number;
  name: string;
  full_path: string;
  lastActivity?: string;
};

export type MetricTrend = {
  current: number;
  previous: number;
  change: number;
};

export type MetricStatus = {
  count: number;
  pct: number;
};

export type AuditCheck = {
  key: string;
  label: string;
  status: "pass" | "warn" | "fail" | "info";
  value: string;
  detail: string;
};

export type AuditSummary = {
  methodologyVersion: string;
  sourceOfTruth: string;
  note: string;
  coverageLabel: string;
  coveragePct: number;
  confidenceScore: number;
  confidenceLabel: "alta" | "media" | "baja";
  anomalies: number;
  checks: AuditCheck[];
};

export type StatsSummary = {
  mean: number;
  median: number;
  stdDev: number;
  min: number;
  max: number;
  p25: number;
  p75: number;
  p90: number;
  p95: number;
  count: number;
};

export type Contributor = {
  canonicalKey: string;
  username: string;
  name: string;
  avatarUrl: string | null;
  mrsCreated: number;
  reviewsGiven: number;
  commentsGiven: number;
  collaborationSize: number;
  reviewRatio: number;
  linesAdded: number;
  linesRemoved: number;
};

export type MergeRequest = {
  project_id: number;
  project_name: string;
  team: string;
  mr_id: number;
  mr_iid: number;
  title: string;
  state: "opened" | "merged" | "closed" | "locked";
  web_url: string | null;
  author_name: string;
  author_username: string;
  author_email: string | null;
  author_avatar_url: string | null;
  canonical_author_key: string;
  canonical_author_name: string;
  created_at: string;
  merged_at: string | null;
  lifetime_hours: number;
  lead_time_hours: number;
  review_time_hours: number;
  commit_count: number;
  changes_count: number;
  review_count: number;
  reviewer_count: number;
  reviewers: Array<{
    name: string;
    username: string;
    avatar_url: string | null;
    comments: number;
  }>;
};

export type SonarProject = {
  key: string;
  name: string;
  gitlabProjectId?: number | null;
  gitlabProjectPath?: string | null;
  mappedToGitLab?: boolean;
  coverage: number;
  bugs: number;
  vulnerabilities: number;
  codeSmells: number;
  techDebtHours: number;
  duplication: number;
  securityHotspots: number;
  qualityGate: string;
  riskScore: number;
  delta: {
    coverage: number;
    bugs: number;
    vulnerabilities: number;
    codeSmells: number;
    techDebtHours: number;
  };
};

export type SonarAvailableProject = {
  key: string;
  name: string;
  gitlabProjectId: number | null;
  gitlabProjectPath: string | null;
};

export type SectionState<T> = {
  data: T | null;
  loading: boolean;
  error: string | null;
};
