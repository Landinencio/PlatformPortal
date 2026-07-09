"use client";

import React, { useState } from "react";
import {
  Loader2,
  Home,
  Server,
  Globe,
  Building2,
  Search,
  Package,
  ChevronDown,
  ChevronUp,
  Download,
  Check,
  X,
  Copy,
  RefreshCw,
  AlertTriangle,
} from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AccountMultiSelect } from "@/components/finops/AccountMultiSelect";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import type { InventoryResponse, ResourceDetail, TerraformStatus } from "@/types/inventory";
import { useAwsAccounts } from "@/hooks/use-aws-accounts";
import { InventoryKpiBar } from "@/components/inventory/inventory-kpi-bar";
import { formatAwsServiceName, splitInventoryServiceKey, truncateMiddle } from "@/lib/finops-format";
import { useI18n } from "@/lib/i18n";

const TERRAFORM_STYLES: Record<TerraformStatus, string> = {
  managed: "bg-success/10 text-success",
  "not-managed": "bg-rose-500/10 text-rose-600",
  unknown: "bg-warning/10 text-warning",
};

function getMetaString(detail: ResourceDetail, key: string): string | null {
  const value = detail.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getMetaBoolean(detail: ResourceDetail, key: string): boolean | null {
  const value = detail.metadata?.[key];
  return typeof value === "boolean" ? value : null;
}

function getMetaNumber(detail: ResourceDetail, key: string): number | null {
  const value = detail.metadata?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatCurrency(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }

  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  })}`;
}

function formatTerraformLabel(status: TerraformStatus | undefined) {
  if (status === "managed") return "Terraform";
  if (status === "not-managed") return "No Terraform";
  return "Desconocido";
}

function formatTagsPreview(detail: ResourceDetail) {
  const entries = Object.entries(detail.tags || {});
  if (entries.length === 0) return null;
  return entries
    .slice(0, 2)
    .map(([key, value]) => `${key}=${value}`)
    .join(" · ");
}

/**
 * Renders structured context chips for a resource detail row.
 * Each resource type shows the most relevant fields in a clean, readable format.
 */
function ResourceContextChips({ detail }: { detail: ResourceDetail }) {
  const chips: Array<{ label: string; value: string; warn?: boolean }> = [];

  const service = getMetaString(detail, "service") || "";
  const resourceType = getMetaString(detail, "resourceType") || "";
  const key = `${service} ${resourceType}`.toLowerCase();

  // ── EC2 Instances ──────────────────────────────────────────────────────────
  if (key.includes("ec2") && key.includes("instance")) {
    const az = getMetaString(detail, "availabilityZone");
    const ip = getMetaString(detail, "privateIpAddress");
    const pubIp = getMetaString(detail, "publicIpAddress");
    const amiName = getMetaString(detail, "amiName");
    const amiId = getMetaString(detail, "amiId");
    const platform = getMetaString(detail, "platform");
    const ebsOpt = getMetaBoolean(detail, "ebsOptimized");
    const launchTime = getMetaString(detail, "launchTime");
    const isAl2 = detail.metadata?.isAmazonLinux2 === true;
    const isAl2023 = detail.metadata?.isAmazonLinux2023 === true;

    if (az) chips.push({ label: "AZ", value: az });
    if (ip) chips.push({ label: "IP privada", value: ip });
    if (pubIp) chips.push({ label: "IP pública", value: pubIp });
    if (amiName) chips.push({ label: "AMI", value: amiName, warn: isAl2 });
    else if (amiId) chips.push({ label: "AMI", value: amiId, warn: isAl2 });    if (platform && platform !== "linux") chips.push({ label: "SO", value: platform });
    if (ebsOpt !== null) chips.push({ label: "EBS Opt.", value: ebsOpt ? "Sí" : "No" });
    if (launchTime) chips.push({ label: "Lanzado", value: new Date(launchTime).toLocaleDateString("es-ES") });
    if (isAl2) chips.push({ label: "EOL", value: "Jun 2026", warn: true });
    else if (isAl2023) chips.push({ label: "AL2023", value: "✓" });
  }

  // ── EBS Volumes ────────────────────────────────────────────────────────────
  else if (key.includes("ebs") || key.includes("volume")) {
    const az = getMetaString(detail, "availabilityZone");
    const encrypted = getMetaBoolean(detail, "encrypted");
    const iops = getMetaNumber(detail, "iops");
    const throughput = getMetaNumber(detail, "throughput");
    const attached = getMetaString(detail, "attachedInstanceId");

    if (az) chips.push({ label: "AZ", value: az });
    if (encrypted !== null) chips.push({ label: "Cifrado", value: encrypted ? "Sí" : "No", warn: !encrypted });
    if (iops !== null) chips.push({ label: "IOPS", value: String(iops) });
    if (throughput !== null) chips.push({ label: "Throughput", value: `${throughput} MB/s` });
    if (attached) chips.push({ label: "Instancia", value: attached.replace("i-", "i-").slice(0, 12) });
    else chips.push({ label: "Adjunto", value: "No", warn: true });
  }

  // ── RDS DB Instances / Clusters ────────────────────────────────────────────
  else if (key.includes("rds") || key.includes("db instance") || key.includes("db cluster")) {
    const engine = getMetaString(detail, "engine");
    const engineVersion = getMetaString(detail, "engineVersion");
    const instanceClass = getMetaString(detail, "instanceClass");
    const multiAz = getMetaBoolean(detail, "multiAz");
    const storageGb = getMetaNumber(detail, "allocatedStorageGb");
    const storageType = getMetaString(detail, "storageType");
    const encrypted = getMetaBoolean(detail, "storageEncrypted");
    const deletionProtection = getMetaBoolean(detail, "deletionProtection");
    const backupDays = getMetaNumber(detail, "backupRetentionDays");
    const isEol = detail.metadata?.isEngineEol === true;
    const eolLabel = detail.metadata?.engineEolLabel as string | null;

    if (engine) chips.push({ label: "Engine", value: engineVersion ? `${engine} ${engineVersion}` : engine, warn: isEol });
    if (instanceClass) chips.push({ label: "Clase", value: instanceClass });
    if (multiAz !== null) chips.push({ label: "Multi-AZ", value: multiAz ? "Sí" : "No", warn: !multiAz });
    if (storageGb !== null) chips.push({ label: "Storage", value: `${storageGb} GiB${storageType ? ` (${storageType})` : ""}` });
    if (encrypted !== null) chips.push({ label: "Cifrado", value: encrypted ? "Sí" : "No", warn: !encrypted });
    if (deletionProtection !== null) chips.push({ label: "Prot. borrado", value: deletionProtection ? "Sí" : "No", warn: !deletionProtection });
    if (backupDays !== null) chips.push({ label: "Backup", value: `${backupDays}d`, warn: backupDays === 0 });
    if (isEol && eolLabel) chips.push({ label: "EOL", value: eolLabel, warn: true });
  }

  // ── Lambda ─────────────────────────────────────────────────────────────────
  else if (key.includes("lambda")) {
    const runtime = getMetaString(detail, "runtime");
    const memoryMb = getMetaNumber(detail, "memorySizeMb");
    const timeoutSec = getMetaNumber(detail, "timeoutSeconds");
    const lastModified = getMetaString(detail, "lastModified");
    const codeSize = getMetaNumber(detail, "codeSizeBytes");

    if (runtime) chips.push({ label: "Runtime", value: runtime });
    if (memoryMb !== null) chips.push({ label: "Memoria", value: `${memoryMb} MB` });
    if (timeoutSec !== null) chips.push({ label: "Timeout", value: `${timeoutSec}s` });
    if (codeSize !== null) chips.push({ label: "Código", value: `${(codeSize / 1024 / 1024).toFixed(1)} MB` });
    if (lastModified) chips.push({ label: "Modificado", value: new Date(lastModified).toLocaleDateString("es-ES") });
  }

  // ── ELB Load Balancers ─────────────────────────────────────────────────────
  else if (key.includes("elb") || key.includes("load balancer")) {
    const scheme = getMetaString(detail, "scheme");
    const lbType = getMetaString(detail, "loadBalancerType");
    const dnsName = getMetaString(detail, "dnsName");
    const vpcId = getMetaString(detail, "vpcId");

    if (lbType) chips.push({ label: "Tipo", value: lbType });
    if (scheme) chips.push({ label: "Esquema", value: scheme });
    if (vpcId) chips.push({ label: "VPC", value: vpcId.slice(0, 12) });
    if (dnsName) chips.push({ label: "DNS", value: dnsName.slice(0, 30) });
  }

  // ── EKS Clusters ──────────────────────────────────────────────────────────
  else if (key.includes("eks")) {
    const version = getMetaString(detail, "version");
    const endpoint = getMetaString(detail, "endpoint");
    const roleArn = getMetaString(detail, "roleArn");

    if (version) chips.push({ label: "K8s", value: version });
    if (endpoint) chips.push({ label: "Endpoint", value: endpoint.slice(0, 30) });
    if (roleArn) chips.push({ label: "Role", value: roleArn.split("/").pop() || roleArn });
  }

  // ── S3 Buckets ─────────────────────────────────────────────────────────────
  else if (key.includes("s3")) {
    const region = getMetaString(detail, "region");
    const createdAt = getMetaString(detail, "createdAt");

    if (region) chips.push({ label: "Región", value: region });
    if (createdAt) chips.push({ label: "Creado", value: new Date(createdAt).toLocaleDateString("es-ES") });
  }

  // ── VPC / Networking ───────────────────────────────────────────────────────
  else if (key.includes("vpc") || key.includes("subnet") || key.includes("security group")) {
    const vpcId = getMetaString(detail, "vpcId");
    const az = getMetaString(detail, "availabilityZone");
    const encrypted = getMetaBoolean(detail, "encrypted");

    if (vpcId) chips.push({ label: "VPC", value: vpcId.slice(0, 14) });
    if (az) chips.push({ label: "AZ", value: az });
    if (encrypted !== null) chips.push({ label: "Cifrado", value: encrypted ? "Sí" : "No" });
  }

  // ── Generic fallback ───────────────────────────────────────────────────────
  else {
    const az = getMetaString(detail, "availabilityZone");
    const vpcId = getMetaString(detail, "vpcId");
    const encrypted = getMetaBoolean(detail, "encrypted") ?? getMetaBoolean(detail, "storageEncrypted");
    const engine = getMetaString(detail, "engine");
    const engineVersion = getMetaString(detail, "engineVersion");

    if (engine) chips.push({ label: "Engine", value: engineVersion ? `${engine} ${engineVersion}` : engine });
    if (az) chips.push({ label: "AZ", value: az });
    if (vpcId) chips.push({ label: "VPC", value: vpcId.slice(0, 14) });
    if (encrypted !== null) chips.push({ label: "Cifrado", value: encrypted ? "Sí" : "No" });
  }

  if (chips.length === 0) return <span className="text-muted-foreground">—</span>;

  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {chips.map((chip, i) => (
        <span
          key={i}
          className={`inline-flex items-baseline gap-1 text-[11px] leading-snug ${
            chip.warn ? "text-orange-600 dark:text-orange-400" : "text-muted-foreground"
          }`}
          title={`${chip.label}: ${chip.value}`}
        >
          <span className={`font-medium ${chip.warn ? "text-orange-700 dark:text-orange-300" : "text-foreground/50"}`}>
            {chip.label}
          </span>
          <span className={chip.warn ? "font-semibold" : ""}>
            {chip.value.length > 38 ? `${chip.value.slice(0, 38)}…` : chip.value}
          </span>
        </span>
      ))}
    </div>
  );
}

export function AwsInventoryDashboard({ embedded = false }: { embedded?: boolean }) {
  const { accounts: availableAccounts, loading: accountsLoading } = useAwsAccounts({ includeHistoric: false });
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<InventoryResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedServiceFamily, setSelectedServiceFamily] = useState("all");
  const [selectedResourceType, setSelectedResourceType] = useState("all");
  const [selectedTag, setSelectedTag] = useState("all");
  const [filterAl2Eol, setFilterAl2Eol] = useState(false);
  const [filterEolOnly, setFilterEolOnly] = useState(false);
  const [filterUntagged, setFilterUntagged] = useState(false);
  const [snapshotMeta, setSnapshotMeta] = useState<{ fromCache: boolean; createdAt?: string; isStale?: boolean } | null>(null);
  const [expandedAccount, setExpandedAccount] = useState<string | null>(null);
  const [expandedService, setExpandedService] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [showExportModal, setShowExportModal] = useState(false);
  // Map resource keys (id, name, ARN suffix) -> real CUR monthly cost
  const [curCostMap, setCurCostMap] = useState<Map<string, number>>(new Map());
  const [exportCols, setExportCols] = useState({
    service: true,
    family: true,
    resourceType: true,
    count: true,
    account: true,
    region: true,
    id: true,
    name: true,
    type: true,
    state: true,
    terraform: true,
    cost: true,
    tags: true,
  });

  const fetchData = async (forceRefresh = false) => {
    if (selectedAccountIds.length === 0) {
      setError("Selecciona al menos una cuenta.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams();
      params.append("accountIds", selectedAccountIds.join(","));
      if (forceRefresh) params.append("refresh", "true");
      // Cost-of-month window: from day 1 to today
      const today = new Date();
      const yyyy = today.getFullYear();
      const mm = String(today.getMonth() + 1).padStart(2, "0");
      const dd = String(today.getDate()).padStart(2, "0");
      const startDate = `${yyyy}-${mm}-01`;
      const endDate = `${yyyy}-${mm}-${dd}`;

      const [invRes, curRes] = await Promise.all([
        fetch(`/api/inventory/athena?${params.toString()}`),
        fetch(`/api/finops/cur-direct?accountIds=${selectedAccountIds.join(",")}&startDate=${startDate}&endDate=${endDate}`).catch(() => null),
      ]);

      if (!invRes.ok) throw new Error(t("inventory.loadError"));
      const result: InventoryResponse & { _meta?: { fromCache: boolean; snapshotMeta?: { createdAt: string; isStale: boolean } } } = await invRes.json();
      setData(result);
      if (result._meta) {
        setSnapshotMeta({
          fromCache: result._meta.fromCache,
          createdAt: result._meta.snapshotMeta?.createdAt,
          isStale: result._meta.snapshotMeta?.isStale,
        });
      }

      // Build CUR cost lookup if available
      if (curRes?.ok) {
        const curData = await curRes.json();
        const map = new Map<string, number>();
        for (const r of curData?.topResources || []) {
          if (!r.resourceId) continue;
          const id = String(r.resourceId).toLowerCase();
          const cost = Number(r.cost) || 0;
          if (cost <= 0) continue;
          // Index by full id, by last segment (after `/` or `:`), and by resource name patterns
          map.set(id, cost);
          const lastSlash = id.split("/").pop();
          if (lastSlash) map.set(lastSlash, cost);
          const lastColon = id.split(":").pop();
          if (lastColon) map.set(lastColon, cost);
        }
        // Also flatten gp2Detail / extendedSupportDetail
        for (const v of curData?.hiddenCosts?.gp2Detail || []) {
          const id = String(v.resourceId || "").toLowerCase();
          if (id) {
            map.set(id, Number(v.cost) || 0);
            const last = id.split("/").pop();
            if (last) map.set(last, Number(v.cost) || 0);
          }
        }
        for (const v of curData?.hiddenCosts?.extendedSupportDetail || []) {
          const id = String(v.resourceId || "").toLowerCase();
          if (id) {
            map.set(id, Number(v.cost) || 0);
            const last = id.split(":db:").pop() || id.split("/").pop();
            if (last) map.set(last.toLowerCase(), Number(v.cost) || 0);
          }
        }
        setCurCostMap(map);
      } else {
        setCurCostMap(new Map());
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Se ha producido un error inesperado.");
    } finally {
      setLoading(false);
    }
  };

  const copyValue = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedId(value);
      window.setTimeout(() => setCopiedId((current) => (current === value ? null : current)), 1800);
    } catch (copyError) {
      console.error("Copy failed", copyError);
    }
  };

  // Resolve real cost from CUR map; falls back to heuristic if no match.
  // Returns { cost, isReal } where isReal=true if it came from CUR data.
  const resolveCost = (detail: ResourceDetail): { cost: number | null | undefined; isReal: boolean } => {
    if (curCostMap.size > 0) {
      const id = (detail.id || "").toLowerCase();
      const name = (detail.name || "").toLowerCase();
      const candidates = [id, name, id.split("/").pop() || "", id.split(":").pop() || ""];
      for (const c of candidates) {
        if (!c) continue;
        const real = curCostMap.get(c);
        if (typeof real === "number" && real > 0) return { cost: real, isReal: true };
      }
    }
    return { cost: detail.estimatedMonthlyCost, isReal: false };
  };

  const normalizedSearch = searchTerm.trim().toLowerCase();
  const serviceOptions = Array.from(new Set((data?.byService || []).map((service) => service.serviceFamily || splitInventoryServiceKey(service.service).serviceFamily))).sort();
  const resourceTypeOptions = Array.from(
    new Set(
      (data?.byService || [])
        .filter((service) => selectedServiceFamily === "all" || (service.serviceFamily || splitInventoryServiceKey(service.service).serviceFamily) === selectedServiceFamily)
        .map((service) => service.resourceType || splitInventoryServiceKey(service.service).resourceType)
    )
  ).sort();

  // Extract all unique tag keys and their values for filtering
  const tagIndex = React.useMemo(() => {
    const keys = new Map<string, Set<string>>();
    for (const service of data?.byService || []) {
      for (const detail of service.details || []) {
        // Tags can be in detail.tags or detail.metadata.tags
        const tags = detail.tags || (detail.metadata?.tags as Record<string, string> | undefined);
        if (tags && typeof tags === "object") {
          for (const [key, value] of Object.entries(tags)) {
            if (!key || key.startsWith("aws:")) continue;
            if (!keys.has(key)) keys.set(key, new Set());
            if (value) keys.get(key)!.add(String(value));
          }
        }
      }
    }
    return keys;
  }, [data]);

  const tagKeyOptions = Array.from(tagIndex.keys()).sort();
  const selectedTagParts = selectedTag !== "all" ? selectedTag.split("=", 2) : null;
  const selectedTagKey = selectedTagParts?.[0] || null;
  const selectedTagValue = selectedTagParts?.[1] || null;
  const tagValueOptions = selectedTagKey ? Array.from(tagIndex.get(selectedTagKey) || []).sort() : [];

  const filteredServices = (data?.byService || []).filter((service) => {
    const serviceFamily = service.serviceFamily || splitInventoryServiceKey(service.service).serviceFamily;
    const resourceType = service.resourceType || splitInventoryServiceKey(service.service).resourceType;
    const familyLabel = formatAwsServiceName(serviceFamily);
    const typeLabel = resourceType;

    const matchesFamily = selectedServiceFamily === "all" || serviceFamily === selectedServiceFamily;
    const matchesResourceType = selectedResourceType === "all" || resourceType === selectedResourceType;
    const matchesSearch = normalizedSearch === "" ||
      service.service.toLowerCase().includes(normalizedSearch) ||
      familyLabel.toLowerCase().includes(normalizedSearch) ||
      typeLabel.toLowerCase().includes(normalizedSearch) ||
      service.details.some((detail) => {
        const tagSummary = getMetaString(detail, "tagSummary") || "";
        return (
          detail.id.toLowerCase().includes(normalizedSearch) ||
          detail.name.toLowerCase().includes(normalizedSearch) ||
          detail.type.toLowerCase().includes(normalizedSearch) ||
          detail.state.toLowerCase().includes(normalizedSearch) ||
          (getMetaString(detail, "accountName") || "").toLowerCase().includes(normalizedSearch) ||
          (getMetaString(detail, "accountId") || "").toLowerCase().includes(normalizedSearch) ||
          (getMetaString(detail, "region") || "").toLowerCase().includes(normalizedSearch) ||
          tagSummary.toLowerCase().includes(normalizedSearch)
        );
      });

    const matchesTag = selectedTag === "all" || service.details.some((detail) => {
      const tags = detail.tags || (detail.metadata?.tags as Record<string, string> | undefined);
      if (!tags || !selectedTagKey) return false;
      if (selectedTagValue) return tags[selectedTagKey] === selectedTagValue;
      return selectedTagKey in tags;
    });

    const matchesAl2 = !filterAl2Eol || service.details.some((detail) => detail.metadata?.isAmazonLinux2 === true);
    const matchesEolOnly = !filterEolOnly || service.details.some((detail) =>
      detail.metadata?.isAmazonLinux2 === true || detail.metadata?.isEngineEol === true
    );
    const matchesUntagged = !filterUntagged || service.details.some((detail) => {
      const tags = detail.tags || (detail.metadata?.tags as Record<string, string> | undefined);
      return !tags || Object.keys(tags).filter((k) => !k.startsWith("aws:")).length === 0;
    });

    return matchesFamily && matchesResourceType && matchesSearch && matchesTag && matchesAl2 && matchesEolOnly && matchesUntagged;
  });

  const visibleServiceKeys = new Set(filteredServices.map((service) => service.service));
  const filteredAccounts = (data?.accounts || [])
    .map((account) => {
      const services = account.services.filter((service) => visibleServiceKeys.has(service.name));
      const totalResources = services.reduce((sum, service) => sum + service.resourceCount, 0);
      const estimatedMonthlyCost = services.reduce((sum, service) => sum + (service.estimatedMonthlyCost || 0), 0);
      return { ...account, services, totalResources, estimatedMonthlyCost };
    })
    .filter((account) => account.services.length > 0);

  const visibleDetails = filteredServices.flatMap((service) => service.details);
  const knownTerraformCount = visibleDetails.filter((detail) => detail.terraformStatus && detail.terraformStatus !== "unknown").length;
  const managedTerraformCount = visibleDetails.filter((detail) => detail.terraformStatus === "managed").length;
  const terraformCoverage = knownTerraformCount > 0 ? Math.round((managedTerraformCount / knownTerraformCount) * 100) : 0;
  const tagCoverage = visibleDetails.length > 0
    ? Math.round((knownTerraformCount / visibleDetails.length) * 100)
    : 0;
  const totalEstimatedCost = filteredServices.reduce((sum, service) => sum + (service.estimatedMonthlyCost || 0), 0);
  const filteredRegions = Array.from(new Set(filteredServices.flatMap((service) => service.regions))).sort();

  const topServiceFamiliesChart = Object.values(filteredServices.reduce<Record<string, { name: string; resources: number; estimatedCost: number }>>((acc, service) => {
    const family = service.serviceFamily || splitInventoryServiceKey(service.service).serviceFamily;
    const label = formatAwsServiceName(family);
    if (!acc[family]) {
      acc[family] = { name: label, resources: 0, estimatedCost: 0 };
    }
    acc[family].resources += service.resourceCount;
    acc[family].estimatedCost += service.estimatedMonthlyCost || 0;
    return acc;
  }, {}))
    .sort((a, b) => b.resources - a.resources)
    .slice(0, 10);

  const accountsChart = filteredAccounts
    .slice()
    .sort((a, b) => b.totalResources - a.totalResources)
    .slice(0, 15)
    .map((account) => ({
      name: account.accountName.length > 18 ? `${account.accountName.slice(0, 18)}…` : account.accountName,
      resources: account.totalResources,
      estimatedCost: account.estimatedMonthlyCost,
    }));

  const regionChart = filteredRegions.map((region) => ({
    name: region,
    resources: filteredServices
      .filter((service) => service.regions.includes(region))
      .reduce((sum, service) => sum + service.details.filter((detail) => getMetaString(detail, "region") === region).length, 0),
  })).filter((region) => region.resources > 0);

  const exportToExcel = async () => {
    if (!data) return;
    setIsExporting(true);
    setShowExportModal(false);

    try {
      const XLSX = await import("xlsx");
      const cols = exportCols;

      const summaryData = [
        [t("inventory.title")],
        [t("eng.generated"), new Date().toLocaleString()],
        ["", data.dateRange.start],
        [],
        [t("inventory.visibleResources"), visibleDetails.length],
        [t("inventory.visibleAccounts"), filteredAccounts.length],
        [t("inventory.visibleServices"), filteredServices.length],
        [t("inventory.visibleEstCost"), formatCurrency(totalEstimatedCost)],
      ];

      const detailHeaders: string[] = [];
      if (cols.service) detailHeaders.push(t("inventory.fullService"));
      if (cols.family) detailHeaders.push(t("inventory.awsFamily"));
      if (cols.resourceType) detailHeaders.push(t("inventory.resourceType"));
      if (cols.count) detailHeaders.push(t("inventory.resources"));
      if (cols.account) detailHeaders.push(t("inventory.account"));
      if (cols.region) detailHeaders.push(t("inventory.region"));
      if (cols.id) detailHeaders.push(t("inventory.idArn"));
      if (cols.name) detailHeaders.push(t("inventory.name"));
      if (cols.type) detailHeaders.push(t("inventory.classType"));
      if (cols.state) detailHeaders.push(t("inventory.state"));
      if (cols.terraform) detailHeaders.push(t("inventory.terraform"));
      if (cols.cost) detailHeaders.push(t("inventory.estMonthlyCost"));
      if (cols.tags) detailHeaders.push(t("inventory.tags"));

      const detailRows: (string | number | boolean)[][] = [detailHeaders];
      for (const service of filteredServices) {
        const family = formatAwsServiceName(service.serviceFamily || splitInventoryServiceKey(service.service).serviceFamily);
        const resourceType = service.resourceType || splitInventoryServiceKey(service.service).resourceType;
        for (const detail of service.details) {
          const row: (string | number | boolean)[] = [];
          if (cols.service) row.push(service.service);
          if (cols.family) row.push(family);
          if (cols.resourceType) row.push(resourceType);
          if (cols.count) row.push(service.resourceCount);
          if (cols.account) row.push(getMetaString(detail, "accountName") || getMetaString(detail, "accountId") || "-");
          if (cols.region) row.push(getMetaString(detail, "region") || "-");
          if (cols.id) row.push(detail.id);
          if (cols.name) row.push(detail.name);
          if (cols.type) row.push(detail.type);
          if (cols.state) row.push(detail.state);
          if (cols.terraform) row.push(formatTerraformLabel(detail.terraformStatus));
          if (cols.cost) row.push(detail.estimatedMonthlyCost ?? "");
          if (cols.tags) row.push(getMetaString(detail, "tagSummary") || "");
          detailRows.push(row);
        }
      }

      const accountsData: (string | number)[][] = [[t("inventory.accountId"), t("inventory.accountName"), t("inventory.service"), t("inventory.resources"), t("inventory.estMonthlyCost")]];
      filteredAccounts.forEach((account) => {
        account.services.forEach((service) => {
          accountsData.push([
            account.accountId,
            account.accountName,
            service.name,
            service.resourceCount,
            service.estimatedMonthlyCost || 0,
          ]);
        });
      });

      const regionsData = [[t("inventory.region"), t("inventory.resources")], ...regionChart.map((region) => [region.name, region.resources])];

      const wb = XLSX.utils.book_new();
      const wsSummary = XLSX.utils.aoa_to_sheet(summaryData);
      const wsDetails = XLSX.utils.aoa_to_sheet(detailRows);
      const wsAccounts = XLSX.utils.aoa_to_sheet(accountsData);
      const wsRegions = XLSX.utils.aoa_to_sheet(regionsData);

      wsSummary["!cols"] = [{ wch: 24 }, { wch: 36 }];
      wsDetails["!cols"] = detailHeaders.map(() => ({ wch: 28 }));
      wsAccounts["!cols"] = [{ wch: 16 }, { wch: 26 }, { wch: 40 }, { wch: 12 }, { wch: 18 }];
      wsRegions["!cols"] = [{ wch: 25 }, { wch: 12 }];

      XLSX.utils.book_append_sheet(wb, wsSummary, t("inventory.summarySheet"));
      XLSX.utils.book_append_sheet(wb, wsDetails, t("inventory.resourcesSheet"));
      XLSX.utils.book_append_sheet(wb, wsAccounts, t("inventory.byAccountSheet"));
      XLSX.utils.book_append_sheet(wb, wsRegions, t("inventory.regionsSheet"));
      XLSX.writeFile(wb, `AWS_Inventory_${data.dateRange.start}.xlsx`);
    } catch (exportError) {
      console.error("Export failed:", exportError);
      alert(t("inventory.exportError"));
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {!embedded && (
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <Link href="/">
                <Button variant="ghost" size="sm" className="gap-2">
                  <Home className="w-4 h-4" />
                  {t("inventory.home")}
                </Button>
              </Link>
              <span className="text-muted-foreground">/</span>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">{t("inventory.title")}</h1>
            </div>
            <p className="text-muted-foreground">{t("inventory.description")}</p>
          </div>
        </div>
      )}

      <Card className="border-border/70 bg-card">
        <CardContent className="pt-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-end">
            <div className="flex-1">
              <label className="mb-2 block text-sm font-medium text-foreground">{t("inventory.awsAccounts")}</label>
              <AccountMultiSelect
                accounts={availableAccounts}
                selectedIds={selectedAccountIds}
                onChange={setSelectedAccountIds}
                placeholder={accountsLoading ? t("inventory.loadingAccounts") : t("inventory.selectAccounts")}
              />
            </div>
            <Button onClick={() => fetchData(false)} disabled={loading || selectedAccountIds.length === 0} className="gap-2">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Package className="h-4 w-4" />}
              {t("inventory.loadInventory")}
            </Button>
            {data && (
              <Button onClick={() => fetchData(true)} disabled={loading} variant="outline" size="sm" className="gap-2" title="Forzar actualización desde AWS">
                <RefreshCw className="h-4 w-4" />
                Actualizar
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="space-y-4 text-center">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-primary" />
            <p className="text-muted-foreground">{t("inventory.querying")}</p>
          </div>
        </div>
      )}

      {data && !loading && (
        <>
          {/* Unified KPI Bar */}
          <InventoryKpiBar data={data} />

          {/* Cache indicator */}
          {snapshotMeta && (
            <div className={`flex items-center gap-2 rounded-lg border px-4 py-2 text-sm ${
              snapshotMeta.isStale
                ? "border-warning/40 bg-warning/10 text-warning"
                : "border-success/40 bg-success/10 text-success"
            }`}>
              {snapshotMeta.isStale ? <AlertTriangle className="h-4 w-4 shrink-0" /> : <Check className="h-4 w-4 shrink-0" />}
              {snapshotMeta.fromCache
                ? snapshotMeta.isStale
                  ? `Datos del inventario desactualizados (guardados el ${snapshotMeta.createdAt ? new Date(snapshotMeta.createdAt).toLocaleString("es-ES") : "fecha desconocida"}). Pulsa "Actualizar" para refrescar desde AWS.`
                  : `Inventario cargado desde caché (${snapshotMeta.createdAt ? new Date(snapshotMeta.createdAt).toLocaleString("es-ES") : "reciente"}). Los datos son frescos.`
                : "Inventario actualizado desde AWS y guardado en caché."
              }
            </div>
          )}

          {/* Filters + Export */}
          <Card className="border-border/70 bg-card">
            <CardContent className="pt-6 space-y-4">
              {/* Search + Service filters */}
              <div className="grid gap-4 lg:grid-cols-[1fr_180px_180px]">
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">{t("common.search")}</label>
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <input
                      type="text"
                      placeholder={t("inventory.searchPlaceholder")}
                      value={searchTerm}
                      onChange={(event) => setSearchTerm(event.target.value)}
                      className="w-full rounded-md border border-border bg-card py-2 pl-10 pr-4 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                    />
                  </div>
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">{t("inventory.awsFamily")}</label>
                  <select
                    value={selectedServiceFamily}
                    onChange={(event) => {
                      setSelectedServiceFamily(event.target.value);
                      setSelectedResourceType("all");
                    }}
                    className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
                  >
                    <option value="all">{t("inventory.allFamilies")}</option>
                    {serviceOptions.map((family) => (
                      <option key={family} value={family}>{formatAwsServiceName(family)}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="mb-2 block text-sm font-medium text-foreground">{t("inventory.resourceType")}</label>
                  <select
                    value={selectedResourceType}
                    onChange={(event) => setSelectedResourceType(event.target.value)}
                    className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
                  >
                    <option value="all">{t("inventory.allTypes")}</option>
                    {resourceTypeOptions.map((resourceType) => (
                      <option key={resourceType} value={resourceType}>{resourceType}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Tag filter + Export */}
              <div className="flex flex-wrap items-end gap-4">
                <div className="w-48">
                  <label className="mb-2 block text-sm font-medium text-foreground">{t("inventory.tagKey")}</label>
                  <select
                    value={selectedTagKey || "all"}
                    onChange={(event) => {
                      const key = event.target.value;
                      setSelectedTag(key === "all" ? "all" : key);
                    }}
                    className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
                  >
                    <option value="all">{t("inventory.allTags")}</option>
                    {tagKeyOptions.map((key) => (
                      <option key={key} value={key}>{key} ({tagIndex.get(key)?.size || 0})</option>
                    ))}
                  </select>
                </div>
                {selectedTagKey && tagValueOptions.length > 0 && (
                  <div className="w-48">
                    <label className="mb-2 block text-sm font-medium text-foreground">{t("inventory.tagValue")}</label>
                    <select
                      value={selectedTagValue || ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        setSelectedTag(value ? `${selectedTagKey}=${value}` : selectedTagKey!);
                      }}
                      className="w-full rounded-md border border-border bg-card px-3 py-2 text-sm text-foreground"
                    >
                      <option value="">{t("inventory.anyValue")}</option>
                      {tagValueOptions.map((value) => (
                        <option key={value} value={value}>{value}</option>
                      ))}
                    </select>
                  </div>
                )}
                <div className="ml-auto flex items-end gap-2">
                  <Button onClick={() => setShowExportModal(true)} disabled={isExporting} variant="outline" size="sm" className="gap-2">
                    {isExporting ? <><Loader2 className="h-4 w-4 animate-spin" />{t("inventory.exporting")}</> : <><Download className="h-4 w-4" />{t("inventory.exportExcel")}</>}
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
            <Card className="border-border/70 bg-card">
              <CardHeader>
                <CardTitle className="text-lg">{t("inventory.topServices")}</CardTitle>
                <CardDescription>{t("inventory.topServicesDesc")}</CardDescription>
              </CardHeader>
              <CardContent>
                {topServiceFamiliesChart.length === 0 ? (
                  <div className="flex h-[320px] items-center justify-center text-sm text-muted-foreground">
                    {t("inventory.noServicesMatch")}
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={topServiceFamiliesChart} layout="vertical" margin={{ left: 8, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis type="number" tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} />
                      <YAxis type="category" dataKey="name" width={180} tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }}
                        formatter={(value, key) => key === "estimatedCost"
                          ? [formatCurrency(Number(value ?? 0)), t("inventory.estimatedCost")]
                          : [Number(value ?? 0).toLocaleString(), t("inventory.resources")]}
                      />
                      <Bar dataKey="resources" fill="#f97316" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>

            <Card className="border-border/70 bg-card">
              <CardHeader>
                <CardTitle className="text-lg">{t("inventory.resourcesByAccount")}</CardTitle>
                <CardDescription>{t("inventory.resourcesByAccountDesc")}</CardDescription>
              </CardHeader>
              <CardContent>
                {accountsChart.length === 0 ? (
                  <div className="flex h-[320px] items-center justify-center text-sm text-muted-foreground">
                    {t("inventory.noAccountsMatch")}
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={320}>
                    <BarChart data={accountsChart} layout="vertical" margin={{ left: 8, right: 20 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis type="number" tick={{ fontSize: 12, fill: "hsl(var(--muted-foreground))" }} />
                      <YAxis type="category" dataKey="name" width={150} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} />
                      <Tooltip
                        contentStyle={{ backgroundColor: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: "8px" }}
                        formatter={(value) => [Number(value ?? 0).toLocaleString(), t("inventory.resources")]}
                      />
                      <Bar dataKey="resources" fill="#3b82f6" radius={[0, 4, 4, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                )}
              </CardContent>
            </Card>
          </div>

          {/* EOL & Governance summary — replaces the redundant region chart */}
          {(() => {
            const allDetails = filteredServices.flatMap((s) => s.details);
            const al2Count = allDetails.filter((d) => d.metadata?.isAmazonLinux2 === true).length;
            const rdsEolCount = allDetails.filter((d) => d.metadata?.isEngineEol === true).length;
            const untaggedCount = allDetails.filter((d) => {
              const tags = d.tags || (d.metadata?.tags as Record<string, string> | undefined);
              return !tags || Object.keys(tags).filter((k) => !k.startsWith("aws:")).length === 0;
            }).length;
            const notManagedCount = allDetails.filter((d) => d.terraformStatus === "not-managed").length;
            if (al2Count === 0 && rdsEolCount === 0 && untaggedCount === 0 && notManagedCount === 0) return null;
            return (
              <Card className="border-border/70 bg-card">
                <CardHeader>
                  <CardTitle className="text-lg">Alertas de Governance</CardTitle>
                  <CardDescription>Recursos que requieren atención: versiones EOL, sin tags o sin gestión Terraform.</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                    {al2Count > 0 && (
                      <button onClick={() => { setFilterAl2Eol(true); setFilterEolOnly(false); setFilterUntagged(false); }} className="flex flex-col gap-1 rounded-xl border border-orange-500/30 bg-orange-500/10 p-4 text-left transition-colors hover:bg-orange-500/20">
                        <span className="text-2xl font-bold text-orange-600 dark:text-orange-400">{al2Count}</span>
                        <span className="text-sm font-medium text-orange-700 dark:text-orange-300">EC2 con Amazon Linux 2</span>
                        <span className="text-xs text-orange-600/70 dark:text-orange-400/70">EOL: 30 Jun 2026</span>
                      </button>
                    )}
                    {rdsEolCount > 0 && (
                      <button onClick={() => { setFilterEolOnly(true); setFilterAl2Eol(false); setFilterUntagged(false); }} className="flex flex-col gap-1 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-left transition-colors hover:bg-red-500/20">
                        <span className="text-2xl font-bold text-red-600 dark:text-red-400">{rdsEolCount}</span>
                        <span className="text-sm font-medium text-red-700 dark:text-red-300">RDS con engine EOL</span>
                        <span className="text-xs text-red-600/70 dark:text-red-400/70">MySQL 5.7, PG 11, etc.</span>
                      </button>
                    )}
                    {untaggedCount > 0 && (
                      <button onClick={() => { setFilterUntagged(true); setFilterAl2Eol(false); setFilterEolOnly(false); }} className="flex flex-col gap-1 rounded-xl border border-yellow-500/30 bg-yellow-500/10 p-4 text-left transition-colors hover:bg-yellow-500/20">
                        <span className="text-2xl font-bold text-yellow-600 dark:text-yellow-400">{untaggedCount}</span>
                        <span className="text-sm font-medium text-yellow-700 dark:text-yellow-300">Recursos sin tags</span>
                        <span className="text-xs text-yellow-600/70 dark:text-yellow-400/70">Sin etiquetas de negocio</span>
                      </button>
                    )}
                    {notManagedCount > 0 && (
                      <div className="flex flex-col gap-1 rounded-xl border border-rose-500/30 bg-rose-500/10 p-4">
                        <span className="text-2xl font-bold text-rose-600 dark:text-rose-400">{notManagedCount}</span>
                        <span className="text-sm font-medium text-rose-700 dark:text-rose-300">Sin gestión Terraform</span>
                        <span className="text-xs text-rose-600/70 dark:text-rose-400/70">Recursos fuera de IaC</span>
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            );
          })()}

          <Card className="border-border/70 bg-card">
            <CardHeader>
              <CardTitle className="text-lg">{t("inventory.serviceBreakdown")}</CardTitle>
              <CardDescription>{t("inventory.serviceBreakdownDesc")}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border">
                      <th className="w-8"></th>
                      <th className="py-3 px-4 text-left font-medium text-muted-foreground">{t("inventory.service")}</th>
                      <th className="py-3 px-4 text-left font-medium text-muted-foreground">{t("inventory.type")}</th>
                      <th className="py-3 px-4 text-right font-medium text-muted-foreground">{t("inventory.resources")}</th>
                      <th className="py-3 px-4 text-right font-medium text-muted-foreground">{t("inventory.estCost")}</th>
                      <th className="py-3 px-4 text-center font-medium text-muted-foreground">{t("inventory.terraform")}</th>
                      <th className="py-3 px-4 text-left font-medium text-muted-foreground">{t("inventory.regions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredServices.map((service) => {
                      const isExpanded = expandedService === service.service;
                      const tfKnown = service.details.filter((detail) => detail.terraformStatus && detail.terraformStatus !== "unknown").length;
                      const tfManaged = service.details.filter((detail) => detail.terraformStatus === "managed").length;
                      const serviceFamily = formatAwsServiceName(service.serviceFamily || splitInventoryServiceKey(service.service).serviceFamily);
                      const resourceType = service.resourceType || splitInventoryServiceKey(service.service).resourceType;
                      return (
                        <React.Fragment key={service.service}>
                          <tr
                            className="cursor-pointer border-b border-border/50 transition-colors hover:bg-muted/50"
                            onClick={() => setExpandedService(isExpanded ? null : service.service)}
                          >
                            <td className="px-2 py-3 text-center">
                              {isExpanded ? <ChevronUp className="inline h-4 w-4 text-muted-foreground" /> : <ChevronDown className="inline h-4 w-4 text-muted-foreground" />}
                            </td>
                            <td className="px-4 py-3 font-medium text-foreground">{serviceFamily}</td>
                            <td className="px-4 py-3 text-muted-foreground">{resourceType}</td>
                            <td className="px-4 py-3 text-right text-foreground">{service.resourceCount.toLocaleString()}</td>
                            <td className="px-4 py-3 text-right text-foreground">{formatCurrency(service.estimatedMonthlyCost)}</td>
                            <td className="px-4 py-3 text-center">
                              <span className="inline-flex rounded-full bg-success/10 px-2 py-0.5 text-xs text-success">
                                {tfKnown > 0 ? `${tfManaged}/${tfKnown}` : "—"}
                              </span>
                            </td>
                            <td className="px-4 py-3">
                              <div className="flex flex-wrap gap-1">
                                {service.regions.map((region) => (
                                  <span key={region} className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{region}</span>
                                ))}
                              </div>
                            </td>
                          </tr>
                          {isExpanded && service.details.length > 0 && (
                            <tr>
                              <td colSpan={7} className="p-0">
                                <div className="bg-muted/30 px-6 py-3">
                                  <table className="w-full text-xs">
                                    <thead>
                                      <tr className="border-b border-border/40">
                                        <th className="px-2 py-2 text-left font-medium text-muted-foreground">{t("inventory.idArn")}</th>
                                        <th className="px-2 py-2 text-left font-medium text-muted-foreground">{t("inventory.name")}</th>
                                        <th className="px-2 py-2 text-left font-medium text-muted-foreground">{t("inventory.account")}</th>
                                        <th className="px-2 py-2 text-left font-medium text-muted-foreground">{t("inventory.region")}</th>
                                        <th className="px-2 py-2 text-left font-medium text-muted-foreground">{t("inventory.type")}</th>
                                        <th className="px-2 py-2 text-left font-medium text-muted-foreground">{t("inventory.state")}</th>
                                        <th className="px-2 py-2 text-right font-medium text-muted-foreground">{t("inventory.estCost")}</th>
                                        <th className="px-2 py-2 text-left font-medium text-muted-foreground">{t("inventory.terraform")}</th>
                                        <th className="px-2 py-2 text-left font-medium text-muted-foreground">{t("inventory.context")}</th>
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {service.details
                                        .filter((detail) => {
                                          if (filterAl2Eol) return detail.metadata?.isAmazonLinux2 === true;
                                          if (filterEolOnly) return detail.metadata?.isAmazonLinux2 === true || detail.metadata?.isEngineEol === true;
                                          if (filterUntagged) {
                                            const tags = detail.tags || (detail.metadata?.tags as Record<string, string> | undefined);
                                            return !tags || Object.keys(tags).filter((k) => !k.startsWith("aws:")).length === 0;
                                          }
                                          return true;
                                        })
                                        .map((detail) => {
                                        const tagPreview = formatTagsPreview(detail);
                                        const terraformStatus = detail.terraformStatus || "unknown";
                                        return (
                                          <tr key={`${service.service}-${detail.id}`} className="border-b border-border/20 hover:bg-muted/40 align-top">
                                            <td className="max-w-[320px] px-2 py-2 font-mono text-[11px] text-foreground">
                                              <div className="flex items-center gap-2">
                                                <span className="truncate" title={detail.id}>{truncateMiddle(detail.id, 28, 18)}</span>
                                                <button
                                                  type="button"
                                                  onClick={(event) => {
                                                    event.stopPropagation();
                                                    void copyValue(detail.id);
                                                  }}
                                                  className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                                                  title="Copiar identificador"
                                                >
                                                  {copiedId === detail.id ? <Check className="h-3.5 w-3.5 text-success" /> : <Copy className="h-3.5 w-3.5" />}
                                                </button>
                                              </div>
                                            </td>
                                            <td className="max-w-[220px] px-2 py-2 text-foreground">
                                              <div className="font-medium">{detail.name}</div>
                                              {tagPreview && <div className="mt-0.5 truncate text-[11px] text-muted-foreground" title={getMetaString(detail, "tagSummary") || ""}>{tagPreview}</div>}
                                            </td>
                                            <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">{getMetaString(detail, "accountName") || "-"}</td>
                                            <td className="whitespace-nowrap px-2 py-2 text-muted-foreground">{getMetaString(detail, "region") || "-"}</td>
                                            <td className="px-2 py-2 text-muted-foreground">{detail.type}</td>
                                            <td className="px-2 py-2 text-muted-foreground">
                                              <div className="flex items-center gap-1.5">
                                                <span>{detail.state}</span>
                                                {detail.metadata?.isAmazonLinux2 && (
                                                  <span className="inline-flex items-center rounded-full bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-orange-600 dark:text-orange-400" title="Amazon Linux 2 — End of Support: 30 Jun 2026">
                                                    AL2 EOL
                                                  </span>
                                                )}
                                                {detail.metadata?.isAmazonLinux2023 && (
                                                  <span className="inline-flex items-center rounded-full bg-green-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-green-600 dark:text-green-400" title="Amazon Linux 2023">
                                                    AL2023
                                                  </span>
                                                )}
                                                {detail.metadata?.isEngineEol && detail.metadata?.engineEolLabel && (
                                                  <span className="inline-flex items-center rounded-full bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-red-600 dark:text-red-400" title={`${detail.metadata.engineEolLabel as string} — versión sin soporte`}>
                                                    {detail.metadata.engineEolLabel as string}
                                                  </span>
                                                )}
                                              </div>
                                            </td>
                                            <td className="px-2 py-2 text-right text-foreground">
                                              {(() => {
                                                const r = resolveCost(detail);
                                                return (
                                                  <div className="flex items-center justify-end gap-1.5">
                                                    <span className={r.isReal ? "font-semibold" : ""}>{formatCurrency(r.cost)}</span>
                                                    {r.isReal ? (
                                                      <span className="rounded bg-success/15 px-1 text-[9px] font-bold uppercase text-success" title="Coste real CUR (Athena)">CUR</span>
                                                    ) : r.cost != null ? (
                                                      <span className="rounded bg-muted px-1 text-[9px] uppercase text-muted-foreground" title="Coste estimado heurístico">est</span>
                                                    ) : null}
                                                  </div>
                                                );
                                              })()}
                                            </td>
                                            <td className="px-2 py-2">
                                              <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] ${TERRAFORM_STYLES[terraformStatus]}`}>
                                                {formatTerraformLabel(terraformStatus)}
                                              </span>
                                            </td>
                                            <td className="min-w-[220px] max-w-[320px] px-2 py-2 align-top text-muted-foreground">
                                              <ResourceContextChips detail={{ ...detail, metadata: { ...detail.metadata, service: service.service, resourceType: service.resourceType || splitInventoryServiceKey(service.service).resourceType } }} />
                                            </td>
                                          </tr>
                                        );
                                      })}
                                    </tbody>
                                  </table>
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>

          <Card className="border-border/70 bg-card">
            <CardHeader>
              <CardTitle className="text-lg">Desglose por cuentas</CardTitle>
              <CardDescription>Detalle visible por cuenta, con servicios y coste estimado agregado.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {filteredAccounts.map((account) => (
                  <div key={account.accountId} className="overflow-hidden rounded-lg border border-border/50">
                    <button
                      onClick={() => setExpandedAccount(expandedAccount === account.accountId ? null : account.accountId)}
                      className="flex w-full items-center justify-between px-4 py-3 text-left transition-colors hover:bg-muted/50"
                    >
                      <div className="flex items-center gap-3">
                        <Building2 className="h-4 w-4 text-primary" />
                        <div>
                          <span className="font-medium text-foreground">{account.accountName}</span>
                          <span className="ml-2 text-xs text-muted-foreground">{account.accountId}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-6">
                        <span className="text-sm font-medium text-foreground">{account.totalResources.toLocaleString()} {t("inventory.resources")}</span>
                        <span className="text-sm text-muted-foreground">{formatCurrency(account.estimatedMonthlyCost)}</span>
                        {expandedAccount === account.accountId ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                      </div>
                    </button>
                    {expandedAccount === account.accountId && (
                      <div className="border-t border-border/50 px-4 pb-4">
                        <table className="mt-3 w-full text-sm">
                          <thead>
                            <tr className="border-b border-border/50">
                              <th className="px-2 py-2 text-left font-medium text-muted-foreground">{t("inventory.service")}</th>
                              <th className="px-2 py-2 text-left font-medium text-muted-foreground">{t("inventory.type")}</th>
                              <th className="px-2 py-2 text-right font-medium text-muted-foreground">{t("inventory.resources")}</th>
                              <th className="px-2 py-2 text-right font-medium text-muted-foreground">{t("inventory.estCost")}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {account.services.map((service) => (
                              <tr key={service.name} className="border-b border-border/30 hover:bg-muted/30">
                                <td className="px-2 py-2 text-foreground">{formatAwsServiceName(service.serviceFamily || splitInventoryServiceKey(service.name).serviceFamily)}</td>
                                <td className="px-2 py-2 text-muted-foreground">{service.resourceType || splitInventoryServiceKey(service.name).resourceType}</td>
                                <td className="px-2 py-2 text-right text-foreground">{service.resourceCount.toLocaleString()}</td>
                                <td className="px-2 py-2 text-right text-foreground">{formatCurrency(service.estimatedMonthlyCost)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </>
      )}

      {showExportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setShowExportModal(false)}>
          <div className="w-[520px] max-w-[92vw] rounded-lg border border-border bg-card p-6 shadow-xl" onClick={(event) => event.stopPropagation()}>
            <div className="mb-4 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-foreground">{t("inventory.exportColumns")}</h3>
              <button onClick={() => setShowExportModal(false)} className="text-muted-foreground hover:text-foreground">
                <X className="h-5 w-5" />
              </button>
            </div>
            <p className="mb-4 text-sm text-muted-foreground">{t("inventory.exportColumnsDesc")}</p>

            {/* Column selection */}
            <div className="space-y-1">
              {([
                ["service", t("inventory.fullService")],
                ["family", t("inventory.awsFamily")],
                ["resourceType", t("inventory.resourceType")],
                ["count", t("inventory.resourceCount")],
                ["account", t("inventory.account")],
                ["region", t("inventory.region")],
                ["id", t("inventory.idArn")],
                ["name", t("inventory.name")],
                ["type", t("inventory.classType")],
                ["state", t("inventory.state")],
                ["terraform", t("inventory.terraformState")],
                ["cost", t("inventory.estMonthlyCost")],
                ["tags", t("inventory.tags")],
              ] as [keyof typeof exportCols, string][]).map(([key, label]) => (
                <label key={key} className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted/50">
                  <input
                    type="checkbox"
                    checked={exportCols[key]}
                    onChange={() => setExportCols((prev) => ({ ...prev, [key]: !prev[key] }))}
                    className="rounded border-border"
                  />
                  <span className="text-sm text-foreground">{label}</span>
                </label>
              ))}
            </div>

            {/* Export filters */}
            <div className="mt-5 border-t border-border pt-4">
              <p className="mb-3 text-sm font-medium text-foreground">Filtrar recursos a exportar</p>
              <div className="space-y-1">
                <label className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted/50">
                  <input type="radio" name="exportFilter" checked={!filterAl2Eol && !filterEolOnly && !filterUntagged} onChange={() => { setFilterAl2Eol(false); setFilterEolOnly(false); setFilterUntagged(false); }} className="border-border" />
                  <span className="text-sm text-foreground">Todos los recursos visibles</span>
                </label>
                <label className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted/50">
                  <input type="radio" name="exportFilter" checked={filterAl2Eol} onChange={() => { setFilterAl2Eol(true); setFilterEolOnly(false); setFilterUntagged(false); }} className="border-border" />
                  <span className="text-sm text-foreground">Solo EC2 con Amazon Linux 2 (EOL Jun 2026)</span>
                </label>
                <label className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted/50">
                  <input type="radio" name="exportFilter" checked={filterEolOnly} onChange={() => { setFilterEolOnly(true); setFilterAl2Eol(false); setFilterUntagged(false); }} className="border-border" />
                  <span className="text-sm text-foreground">Solo recursos con versiones EOL (EC2 + RDS)</span>
                </label>
                <label className="flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 hover:bg-muted/50">
                  <input type="radio" name="exportFilter" checked={filterUntagged} onChange={() => { setFilterUntagged(true); setFilterAl2Eol(false); setFilterEolOnly(false); }} className="border-border" />
                  <span className="text-sm text-foreground">Solo recursos sin tags de negocio</span>
                </label>
              </div>
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setShowExportModal(false)}>{t("common.cancel")}</Button>
              <Button size="sm" onClick={exportToExcel} className="gap-2">
                <Download className="h-4 w-4" />
                {t("inventory.export")}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
