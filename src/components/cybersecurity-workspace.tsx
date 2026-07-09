"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";
import {
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  Shield,
  UserX,
  Wifi,
} from "lucide-react";
import type {
  CyberReportType,
  CybersecurityDashboardResponse,
  CybersecurityReportResponse,
  CyberRunSummary,
} from "@/lib/cybersecurity";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

type CyberTab = "overview" | "inactive" | "mfa" | "vpn";

const REPORT_TO_TAB: Record<CyberReportType, Exclude<CyberTab, "overview">> = {
  inactive_users_90d: "inactive",
  users_without_mfa_group: "mfa",
  vpn_groups: "vpn",
};

function formatIsoDate(value: string | null | undefined, withTime = true) {
  if (!value) return "Sin dato";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Sin dato";
  return format(parsed, withTime ? "dd/MM/yyyy HH:mm" : "dd/MM/yyyy");
}

function formatRelative(value: string | null | undefined) {
  if (!value) return "Sin dato";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Sin dato";
  return formatDistanceToNowStrict(parsed, { addSuffix: true });
}

function safeText(value: string | null | undefined, fallback = "Sin dato") {
  if (!value) return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function getSummaryNumber(run: CyberRunSummary | null, keys: string[]) {
  if (!run) return 0;
  for (const key of keys) {
    const raw = run.summary?.[key];
    if (typeof raw === "number" && Number.isFinite(raw)) return raw;
    if (typeof raw === "string" && raw.trim()) {
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return 0;
}

function buildRunOptions(history: CyberRunSummary[]) {
  return history.map((run) => ({
    value: String(run.runId),
    label: `${formatIsoDate(run.generatedAt)} · ${run.recordsCount} registros`,
  }));
}

function extractDepartments<T extends { department: string | null }>(items: T[]) {
  return Array.from(new Set(items.map((item) => safeText(item.department, "Sin departamento")))).sort((a, b) =>
    a.localeCompare(b, "es")
  );
}

export function CybersecurityWorkspace() {
  const [activeTab, setActiveTab] = useState<CyberTab>("overview");
  const [dashboard, setDashboard] = useState<CybersecurityDashboardResponse | null>(null);
  const [reports, setReports] = useState<Partial<Record<CyberReportType, CybersecurityReportResponse>>>({});
  const [loadingDashboard, setLoadingDashboard] = useState(true);
  const [loadingReports, setLoadingReports] = useState<Partial<Record<CyberReportType, boolean>>>({});
  const [error, setError] = useState<string | null>(null);
  const [inactiveRunId, setInactiveRunId] = useState<string>("latest");
  const [mfaRunId, setMfaRunId] = useState<string>("latest");
  const [vpnRunId, setVpnRunId] = useState<string>("latest");
  const [inactiveSearch, setInactiveSearch] = useState("");
  const [inactiveDepartment, setInactiveDepartment] = useState("all");
  const [mfaSearch, setMfaSearch] = useState("");
  const [mfaDepartment, setMfaDepartment] = useState("all");
  const [vpnSearch, setVpnSearch] = useState("");
  const [vpnGroup, setVpnGroup] = useState("all");
  const [isExporting, setIsExporting] = useState(false);

  const loadReport = useCallback(async (reportType: CyberReportType, runId?: number) => {
    setLoadingReports((current) => ({ ...current, [reportType]: true }));
    try {
      const params = new URLSearchParams({ reportType });
      if (runId) params.set("runId", String(runId));

      const response = await fetch(`/api/cybersecurity/report?${params.toString()}`, {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`No se pudo cargar el informe ${reportType}`);
      }

      const json = (await response.json()) as CybersecurityReportResponse;
      setReports((current) => ({ ...current, [reportType]: json }));
      setError(null);
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : `No se pudo cargar el informe ${reportType}`;
      setError(message);
    } finally {
      setLoadingReports((current) => ({ ...current, [reportType]: false }));
    }
  }, []);

  const loadDashboard = useCallback(async () => {
    setLoadingDashboard(true);
    setError(null);
    setReports({});

    try {
      const response = await fetch("/api/cybersecurity/dashboard", {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error("No se pudo cargar el espacio de Ciberseguridad");
      }

      const json = (await response.json()) as CybersecurityDashboardResponse;
      setDashboard(json);

      const promises: Array<Promise<void>> = [];
      for (const reportType of ["inactive_users_90d", "users_without_mfa_group", "vpn_groups"] as const) {
        const latestRunId = json.reports[reportType].latestRun?.runId;
        if (latestRunId) {
          promises.push(loadReport(reportType, latestRunId));
        }
      }

      await Promise.all(promises);
    } catch (loadError) {
      const message =
        loadError instanceof Error ? loadError.message : "No se ha podido cargar Ciberseguridad";
      setError(message);
    } finally {
      setLoadingDashboard(false);
    }
  }, [loadReport]);

  useEffect(() => {
    void loadDashboard();
  }, [loadDashboard]);

  const inactiveReport = reports.inactive_users_90d?.kind === "inactive_users" ? reports.inactive_users_90d : null;
  const mfaReport = reports.users_without_mfa_group?.kind === "mfa_gaps" ? reports.users_without_mfa_group : null;
  const vpnReport = reports.vpn_groups?.kind === "vpn_groups" ? reports.vpn_groups : null;

  const inactiveDepartments = useMemo(
    () => (inactiveReport ? extractDepartments(inactiveReport.items) : []),
    [inactiveReport]
  );
  const mfaDepartments = useMemo(() => (mfaReport ? extractDepartments(mfaReport.items) : []), [mfaReport]);
  const vpnGroups = useMemo(
    () => (vpnReport ? vpnReport.groups.map((group) => ({ value: group.groupId, label: group.groupName })) : []),
    [vpnReport]
  );

  const filteredInactiveUsers = useMemo(() => {
    if (!inactiveReport) return [];
    const query = inactiveSearch.trim().toLowerCase();
    return inactiveReport.items.filter((user) => {
      const matchesDepartment =
        inactiveDepartment === "all" || safeText(user.department, "Sin departamento") === inactiveDepartment;
      if (!matchesDepartment) return false;
      if (!query) return true;
      return [
        user.displayName,
        user.mail,
        user.userPrincipalName,
        user.department,
        user.company,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [inactiveDepartment, inactiveReport, inactiveSearch]);

  const filteredMfaUsers = useMemo(() => {
    if (!mfaReport) return [];
    const query = mfaSearch.trim().toLowerCase();
    return mfaReport.items.filter((user) => {
      const matchesDepartment =
        mfaDepartment === "all" || safeText(user.department, "Sin departamento") === mfaDepartment;
      if (!matchesDepartment) return false;
      if (!query) return true;
      return [
        user.displayName,
        user.mail,
        user.userPrincipalName,
        user.department,
        user.company,
        user.jobTitle,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [mfaDepartment, mfaReport, mfaSearch]);

  const filteredVpnGroups = useMemo(() => {
    if (!vpnReport) return [];
    const query = vpnSearch.trim().toLowerCase();
    return vpnReport.groups.filter((group) => {
      if (vpnGroup !== "all" && group.groupId !== vpnGroup) return false;
      if (!query) return true;
      return [group.groupName, group.description]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [vpnGroup, vpnReport, vpnSearch]);

  const filteredVpnMembers = useMemo(() => {
    if (!vpnReport) return [];
    const allowedGroups = new Set(filteredVpnGroups.map((group) => group.groupId));
    const query = vpnSearch.trim().toLowerCase();
    return vpnReport.members.filter((member) => {
      if (!allowedGroups.has(member.groupId)) return false;
      if (!query) return true;
      return [
        member.displayName,
        member.mail,
        member.userPrincipalName,
        member.department,
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query));
    });
  }, [filteredVpnGroups, vpnReport, vpnSearch]);

  const exportInactiveUsers = async () => {
    if (!inactiveReport) return;
    setIsExporting(true);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.utils.book_new();
      const summarySheet = XLSX.utils.json_to_sheet([
        {
          "Reporte": "Usuarios inactivos +90d",
          "Ejecución": formatIsoDate(inactiveReport.run.generatedAt),
          "Usuarios visibles": filteredInactiveUsers.length,
          "Total run": inactiveReport.items.length,
          "Departamento": inactiveDepartment === "all" ? "Todos" : inactiveDepartment,
          "Búsqueda": inactiveSearch || "Sin filtro",
        },
      ]);
      const detailSheet = XLSX.utils.json_to_sheet(
        filteredInactiveUsers.map((user) => ({
          "Display Name": safeText(user.displayName),
          "UPN": user.userPrincipalName,
          "Email": safeText(user.mail),
          "Departamento": safeText(user.department),
          "Empresa": safeText(user.company),
          "Creado": formatIsoDate(user.createdAt),
          "Último login": formatIsoDate(user.lastLoginAt),
          "Último no interactivo": formatIsoDate(user.lastNonInteractiveAt),
          "Días inactivo": user.daysInactive ?? "",
          "Nunca login": user.neverLoggedIn ? "Sí" : "No",
        }))
      );

      XLSX.utils.book_append_sheet(workbook, summarySheet, "Resumen");
      XLSX.utils.book_append_sheet(workbook, detailSheet, "Usuarios");
      XLSX.writeFile(workbook, `cyber-inactive-users-${format(new Date(), "yyyyMMdd-HHmm")}.xlsx`);
    } finally {
      setIsExporting(false);
    }
  };

  const exportMfaGaps = async () => {
    if (!mfaReport) return;
    setIsExporting(true);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.utils.book_new();
      const summarySheet = XLSX.utils.json_to_sheet([
        {
          "Reporte": "Usuarios fuera de MFA",
          "Ejecución": formatIsoDate(mfaReport.run.generatedAt),
          "Usuarios visibles": filteredMfaUsers.length,
          "Total run": mfaReport.items.length,
          "Departamento": mfaDepartment === "all" ? "Todos" : mfaDepartment,
          "Búsqueda": mfaSearch || "Sin filtro",
        },
      ]);
      const detailSheet = XLSX.utils.json_to_sheet(
        filteredMfaUsers.map((user) => ({
          "Display Name": safeText(user.displayName),
          "UPN": user.userPrincipalName,
          "Email": safeText(user.mail),
          "Departamento": safeText(user.department),
          "Puesto": safeText(user.jobTitle),
          "Empresa": safeText(user.company),
          "Creado": formatIsoDate(user.createdAt),
          "Último login": formatIsoDate(user.lastLoginAt),
          "Último no interactivo": formatIsoDate(user.lastNonInteractiveAt),
          "Días sin login": user.daysSinceLogin ?? "",
          "Nunca login": user.neverLoggedIn ? "Sí" : "No",
        }))
      );

      XLSX.utils.book_append_sheet(workbook, summarySheet, "Resumen");
      XLSX.utils.book_append_sheet(workbook, detailSheet, "Usuarios");
      XLSX.writeFile(workbook, `cyber-mfa-gaps-${format(new Date(), "yyyyMMdd-HHmm")}.xlsx`);
    } finally {
      setIsExporting(false);
    }
  };

  const exportVpnGroups = async () => {
    if (!vpnReport) return;
    setIsExporting(true);
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.utils.book_new();
      const summarySheet = XLSX.utils.json_to_sheet(
        filteredVpnGroups.map((group) => ({
          "Grupo": group.groupName,
          "Group ID": group.groupId,
          "Descripción": safeText(group.description),
          "Miembros": group.memberCount,
        }))
      );
      const memberSheet = XLSX.utils.json_to_sheet(
        filteredVpnMembers.map((member) => ({
          "Grupo": vpnReport.groups.find((group) => group.groupId === member.groupId)?.groupName || member.groupId,
          "UPN": member.userPrincipalName,
          "Display Name": safeText(member.displayName),
          "Email": safeText(member.mail),
          "Departamento": safeText(member.department),
          "Creado": formatIsoDate(member.createdAt),
          "Último login": formatIsoDate(member.lastLoginAt),
          "Último no interactivo": formatIsoDate(member.lastNonInteractiveAt),
          "Nunca login": member.neverLoggedIn ? "Sí" : "No",
        }))
      );
      XLSX.utils.book_append_sheet(workbook, summarySheet, "Grupos");
      XLSX.utils.book_append_sheet(workbook, memberSheet, "Miembros");
      XLSX.writeFile(workbook, `cyber-vpn-groups-${format(new Date(), "yyyyMMdd-HHmm")}.xlsx`);
    } finally {
      setIsExporting(false);
    }
  };

  const handleRunSelection = async (reportType: CyberReportType, value: string) => {
    const runId = value === "latest" ? undefined : Number(value);
    if (reportType === "inactive_users_90d") setInactiveRunId(value);
    if (reportType === "users_without_mfa_group") setMfaRunId(value);
    if (reportType === "vpn_groups") setVpnRunId(value);
    await loadReport(reportType, runId);
  };

  const latestInactiveRun = dashboard?.reports.inactive_users_90d.latestRun || null;
  const latestMfaRun = dashboard?.reports.users_without_mfa_group.latestRun || null;
  const latestVpnRun = dashboard?.reports.vpn_groups.latestRun || null;
  const liveMode =
    latestInactiveRun?.source === "azure_ad_live" ||
    latestMfaRun?.source === "azure_ad_live" ||
    latestVpnRun?.source === "azure_ad_live";

  const renderRunBadge = (run: CyberRunSummary | null) => {
    if (!run) {
      return <Badge variant="outline" className="border-amber-200 text-amber-700">Sin ingestas</Badge>;
    }
    if (run.status === "completed") {
      return <Badge className="bg-emerald-100 text-emerald-700 hover:bg-emerald-100">Completo</Badge>;
    }
    if (run.status === "partial") {
      return <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">Parcial</Badge>;
    }
    return <Badge className="bg-red-100 text-red-700 hover:bg-red-100">Fallido</Badge>;
  };

  return (
    <div className="space-y-8">
      <section className="relative overflow-hidden rounded-[32px] border border-border/60 bg-gradient-to-br from-stone-50 via-background to-sky-50 p-6 shadow-sm sm:p-8">
        <div className="absolute inset-y-0 right-0 w-1/2 bg-[radial-gradient(circle_at_top_right,rgba(14,165,233,0.16),transparent_58%)]" />
        <div className="relative space-y-6">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-3xl space-y-3">
              <div className="inline-flex items-center gap-2 rounded-full border border-sky-200 bg-white/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-sky-700">
                <Shield className="h-3.5 w-3.5" />
                Ciberseguridad
              </div>
              <div className="space-y-2">
                <h1 className="text-4xl font-black tracking-tight text-foreground sm:text-5xl">
                  Identidades, cobertura MFA y accesos VPN en una vista operativa.
                </h1>
                <p className="max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">
                  Este espacio consulta Azure AD a través de automatizaciones n8n y presenta el resultado en vivo en el
                  portal. Ciber deja de depender del email como canal principal, pero mantiene los flujos clásicos como
                  respaldo operativo.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3 lg:w-[520px]">
              <Card className="border-border/60 bg-white/80 shadow-none">
                <CardContent className="flex items-start gap-3 p-4">
                  <UserX className="mt-0.5 h-4 w-4 text-amber-600" />
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Inactividad</div>
                    <div className="mt-1 text-sm font-medium text-foreground">
                      {getSummaryNumber(latestInactiveRun, ["totalInactive", "totalUsers"])} usuarios
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="border-border/60 bg-white/80 shadow-none">
                <CardContent className="flex items-start gap-3 p-4">
                  <KeyRound className="mt-0.5 h-4 w-4 text-red-600" />
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Cobertura MFA</div>
                    <div className="mt-1 text-sm font-medium text-foreground">
                      {getSummaryNumber(latestMfaRun, ["totalUsers", "totalGaps"])} gaps abiertos
                    </div>
                  </div>
                </CardContent>
              </Card>
              <Card className="border-border/60 bg-white/80 shadow-none">
                <CardContent className="flex items-start gap-3 p-4">
                  <Wifi className="mt-0.5 h-4 w-4 text-sky-600" />
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">VPN</div>
                    <div className="mt-1 text-sm font-medium text-foreground">
                      {getSummaryNumber(latestVpnRun, ["totalGroups"])} grupos · {getSummaryNumber(latestVpnRun, ["totalMembers"])} miembros
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </div>

          <div className="grid gap-4 lg:grid-cols-4">
            <Card className="border-border/60 bg-white/70 shadow-none">
              <CardHeader className="pb-2">
                <CardDescription>Última actualización</CardDescription>
                <CardTitle className="text-2xl">{formatIsoDate(dashboard?.meta.lastUpdated || null)}</CardTitle>
              </CardHeader>
              <CardContent className="text-xs text-muted-foreground">
                {dashboard?.meta.lastUpdated ? formatRelative(dashboard.meta.lastUpdated) : "Sin ejecuciones todavía"}
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-white/70 shadow-none">
              <CardHeader className="pb-2">
                <CardDescription>Usuarios inactivos</CardDescription>
                <CardTitle className="text-2xl">{getSummaryNumber(latestInactiveRun, ["totalInactive", "totalUsers"])}</CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{getSummaryNumber(latestInactiveRun, ["neverLogin"])} sin login</span>
                {renderRunBadge(latestInactiveRun)}
              </CardContent>
            </Card>
            <Card className="border-border/60 bg-white/70 shadow-none">
              <CardHeader className="pb-2">
                <CardDescription>Gaps MFA</CardDescription>
                <CardTitle className="text-2xl">{getSummaryNumber(latestMfaRun, ["totalUsers", "totalGaps"])}</CardTitle>
              </CardHeader>
              <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{getSummaryNumber(latestMfaRun, ["over90d"])} con &gt;90d</span>
                {renderRunBadge(latestMfaRun)}
              </CardContent>
            </Card>
              <Card className="border-border/60 bg-white/70 shadow-none">
                <CardHeader className="pb-2">
                  <CardDescription>{liveMode ? "Fuentes activas" : "Runs retenidas"}</CardDescription>
                  <CardTitle className="text-2xl">{dashboard?.meta.totalRuns ?? 0}</CardTitle>
                </CardHeader>
                <CardContent className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>{liveMode ? "Consultas live disponibles" : "Histórico en BBDD"}</span>
                  <Button variant="outline" size="sm" onClick={loadDashboard} disabled={loadingDashboard} className="gap-2">
                    <RefreshCw className={`h-4 w-4 ${loadingDashboard ? "animate-spin" : ""}`} />
                    Recargar
                </Button>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {error && (
        <Card className="border-red-300 bg-red-50">
          <CardContent className="pt-6 text-sm text-red-700">{error}</CardContent>
        </Card>
      )}

      <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as CyberTab)} className="space-y-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <h2 className="text-2xl font-bold tracking-tight text-foreground">Workspace de ciberseguridad</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Solo visible para administradores. Cada bloque consume datos en vivo, permite filtrar el alcance actual y
              exporta exactamente lo que ves en pantalla.
            </p>
          </div>
          <TabsList className="h-auto gap-1 rounded-2xl border border-border/60 bg-card p-1">
            <TabsTrigger value="overview" className="rounded-xl px-4 py-2.5">Resumen</TabsTrigger>
            <TabsTrigger value="inactive" className="rounded-xl px-4 py-2.5">Inactivos</TabsTrigger>
            <TabsTrigger value="mfa" className="rounded-xl px-4 py-2.5">MFA</TabsTrigger>
            <TabsTrigger value="vpn" className="rounded-xl px-4 py-2.5">VPN</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="space-y-4">
          <div className="grid gap-4 xl:grid-cols-3">
            {(["inactive_users_90d", "users_without_mfa_group", "vpn_groups"] as const).map((reportType) => {
              const reportCard = dashboard?.reports[reportType];
              const latestRun = reportCard?.latestRun || null;
              return (
                <Card key={reportType} className="border-border/60 bg-card/90 shadow-sm">
                  <CardHeader>
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <CardTitle className="text-xl">{reportCard?.label}</CardTitle>
                        <CardDescription className="mt-2">{reportCard?.description}</CardDescription>
                      </div>
                      {renderRunBadge(latestRun)}
                    </div>
                  </CardHeader>
                  <CardContent className="space-y-4 text-sm">
                    <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">Última ejecución</div>
                      <div className="mt-2 text-base font-semibold text-foreground">
                        {latestRun ? formatIsoDate(latestRun.generatedAt) : "Sin ejecuciones"}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {latestRun ? `${latestRun.recordsCount} registros · ${formatRelative(latestRun.generatedAt)}` : "Todavía no se ha ingerido este reporte"}
                      </p>
                    </div>

                    <div className="space-y-2">
                      <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted-foreground">
                        {liveMode ? "Modo de consulta" : "Histórico reciente"}
                      </div>
                      {liveMode ? (
                        <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-3 text-sm text-sky-800">
                          Consulta en vivo desde n8n. No se retiene histórico en BBDD por ahora.
                        </div>
                      ) : reportCard?.history.length ? (
                        <div className="space-y-2">
                          {reportCard.history.slice(0, 5).map((run) => (
                            <button
                              key={run.runId}
                              type="button"
                              onClick={() => {
                                const tab = REPORT_TO_TAB[reportType];
                                setActiveTab(tab);
                                void handleRunSelection(reportType, String(run.runId));
                              }}
                              className="flex w-full items-center justify-between rounded-xl border border-border/60 bg-background px-3 py-2 text-left transition-colors hover:border-foreground/15 hover:bg-muted/20"
                            >
                              <div>
                                <div className="text-sm font-medium text-foreground">{formatIsoDate(run.generatedAt)}</div>
                                <div className="text-xs text-muted-foreground">{run.recordsCount} registros</div>
                              </div>
                              <span className="text-xs text-muted-foreground">{formatRelative(run.generatedAt)}</span>
                            </button>
                          ))}
                        </div>
                      ) : (
                        <p className="text-sm text-muted-foreground">Todavía no hay histórico disponible para este reporte.</p>
                      )}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </TabsContent>

        <TabsContent value="inactive" className="space-y-4">
          <Card className="border-border/60 bg-card/90 shadow-sm">
            <CardHeader>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <CardTitle className="text-xl">Usuarios inactivos +90 días</CardTitle>
                  <CardDescription className="mt-2">
                    Usuarios habilitados con ausencia prolongada o sin login observado.
                  </CardDescription>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  {liveMode ? (
                    <Badge className="h-10 rounded-md border border-sky-200 bg-sky-50 px-3 text-sky-700 hover:bg-sky-50">
                      Live vía n8n
                    </Badge>
                  ) : (
                    <Select value={inactiveRunId} onValueChange={(value) => void handleRunSelection("inactive_users_90d", value)}>
                      <SelectTrigger className="w-[280px]">
                        <SelectValue placeholder="Elegir ejecución" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="latest">Última ejecución</SelectItem>
                        {buildRunOptions(dashboard?.reports.inactive_users_90d.history || []).map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Button variant="outline" onClick={exportInactiveUsers} disabled={!inactiveReport || isExporting} className="gap-2">
                    {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    Exportar Excel
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-4">
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription>Usuarios visibles</CardDescription>
                    <CardTitle className="text-2xl">{filteredInactiveUsers.length}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Run total: {inactiveReport?.items.length || 0}
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription>Sin login</CardDescription>
                    <CardTitle className="text-2xl">{filteredInactiveUsers.filter((user) => user.neverLoggedIn).length}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Cobertura de acceso observada
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription>Departamentos</CardDescription>
                    <CardTitle className="text-2xl">{new Set(filteredInactiveUsers.map((user) => safeText(user.department))).size}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Sobre el alcance visible
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription>Última ejecución</CardDescription>
                    <CardTitle className="text-lg">{formatIsoDate(inactiveReport?.run.generatedAt || null)}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    {formatRelative(inactiveReport?.run.generatedAt || null)}
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
                <Input
                  value={inactiveSearch}
                  onChange={(event) => setInactiveSearch(event.target.value)}
                  placeholder="Buscar por nombre, UPN, email o departamento"
                />
                <Select value={inactiveDepartment} onValueChange={setInactiveDepartment}>
                  <SelectTrigger>
                    <SelectValue placeholder="Departamento" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los departamentos</SelectItem>
                    {inactiveDepartments.map((department) => (
                      <SelectItem key={department} value={department}>
                        {department}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Usuario</TableHead>
                    <TableHead>Departamento</TableHead>
                    <TableHead>Creado</TableHead>
                    <TableHead>Último login</TableHead>
                    <TableHead>Días inactivo</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadingReports.inactive_users_90d ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                      </TableCell>
                    </TableRow>
                  ) : filteredInactiveUsers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        No hay usuarios dentro del alcance actual.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredInactiveUsers.map((user) => (
                      <TableRow key={user.userPrincipalName}>
                        <TableCell>
                          <div className="font-medium text-foreground">{safeText(user.displayName, user.userPrincipalName)}</div>
                          <div className="text-xs text-muted-foreground">{user.userPrincipalName}</div>
                        </TableCell>
                        <TableCell>{safeText(user.department)}</TableCell>
                        <TableCell>{formatIsoDate(user.createdAt, false)}</TableCell>
                        <TableCell>
                          {user.neverLoggedIn ? (
                            <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">Nunca</Badge>
                          ) : (
                            <div>
                              <div>{formatIsoDate(user.lastLoginAt)}</div>
                              <div className="text-xs text-muted-foreground">{formatRelative(user.lastLoginAt)}</div>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>{user.daysInactive ?? "Sin dato"}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="mfa" className="space-y-4">
          <Card className="border-border/60 bg-card/90 shadow-sm">
            <CardHeader>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <CardTitle className="text-xl">Usuarios fuera de grupos MFA</CardTitle>
                  <CardDescription className="mt-2">
                    Usuarios habilitados que no están cubiertos por los grupos corporativos de MFA conocidos.
                  </CardDescription>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  {liveMode ? (
                    <Badge className="h-10 rounded-md border border-sky-200 bg-sky-50 px-3 text-sky-700 hover:bg-sky-50">
                      Live vía n8n
                    </Badge>
                  ) : (
                    <Select value={mfaRunId} onValueChange={(value) => void handleRunSelection("users_without_mfa_group", value)}>
                      <SelectTrigger className="w-[280px]">
                        <SelectValue placeholder="Elegir ejecución" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="latest">Última ejecución</SelectItem>
                        {buildRunOptions(dashboard?.reports.users_without_mfa_group.history || []).map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Button variant="outline" onClick={exportMfaGaps} disabled={!mfaReport || isExporting} className="gap-2">
                    {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    Exportar Excel
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-4">
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription>Usuarios visibles</CardDescription>
                    <CardTitle className="text-2xl">{filteredMfaUsers.length}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Run total: {mfaReport?.items.length || 0}
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription>Sin login</CardDescription>
                    <CardTitle className="text-2xl">{filteredMfaUsers.filter((user) => user.neverLoggedIn).length}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Dentro del alcance visible
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription>&gt; 90 días</CardDescription>
                    <CardTitle className="text-2xl">
                      {filteredMfaUsers.filter((user) => (user.daysSinceLogin || 0) >= 90).length}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Sobre el alcance filtrado
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription>Última ejecución</CardDescription>
                    <CardTitle className="text-lg">{formatIsoDate(mfaReport?.run.generatedAt || null)}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    {formatRelative(mfaReport?.run.generatedAt || null)}
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_220px]">
                <Input
                  value={mfaSearch}
                  onChange={(event) => setMfaSearch(event.target.value)}
                  placeholder="Buscar por nombre, UPN, email o departamento"
                />
                <Select value={mfaDepartment} onValueChange={setMfaDepartment}>
                  <SelectTrigger>
                    <SelectValue placeholder="Departamento" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los departamentos</SelectItem>
                    {mfaDepartments.map((department) => (
                      <SelectItem key={department} value={department}>
                        {department}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Usuario</TableHead>
                    <TableHead>Departamento</TableHead>
                    <TableHead>Puesto</TableHead>
                    <TableHead>Último login</TableHead>
                    <TableHead>Días</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {loadingReports.users_without_mfa_group ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                      </TableCell>
                    </TableRow>
                  ) : filteredMfaUsers.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground">
                        No hay usuarios dentro del alcance actual.
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredMfaUsers.map((user) => (
                      <TableRow key={user.userPrincipalName}>
                        <TableCell>
                          <div className="font-medium text-foreground">{safeText(user.displayName, user.userPrincipalName)}</div>
                          <div className="text-xs text-muted-foreground">{user.userPrincipalName}</div>
                        </TableCell>
                        <TableCell>{safeText(user.department)}</TableCell>
                        <TableCell>{safeText(user.jobTitle)}</TableCell>
                        <TableCell>
                          {user.neverLoggedIn ? (
                            <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">Nunca</Badge>
                          ) : (
                            <div>
                              <div>{formatIsoDate(user.lastLoginAt)}</div>
                              <div className="text-xs text-muted-foreground">{formatRelative(user.lastLoginAt)}</div>
                            </div>
                          )}
                        </TableCell>
                        <TableCell>{user.daysSinceLogin ?? "Sin dato"}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="vpn" className="space-y-4">
          <Card className="border-border/60 bg-card/90 shadow-sm">
            <CardHeader>
              <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
                <div>
                  <CardTitle className="text-xl">Grupos VPN y miembros</CardTitle>
                  <CardDescription className="mt-2">
                    Cobertura de grupos `AZ_VPN` y detalle de sus miembros con fecha de alta y última actividad.
                  </CardDescription>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row">
                  {liveMode ? (
                    <Badge className="h-10 rounded-md border border-sky-200 bg-sky-50 px-3 text-sky-700 hover:bg-sky-50">
                      Live vía n8n
                    </Badge>
                  ) : (
                    <Select value={vpnRunId} onValueChange={(value) => void handleRunSelection("vpn_groups", value)}>
                      <SelectTrigger className="w-[280px]">
                        <SelectValue placeholder="Elegir ejecución" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="latest">Última ejecución</SelectItem>
                        {buildRunOptions(dashboard?.reports.vpn_groups.history || []).map((option) => (
                          <SelectItem key={option.value} value={option.value}>
                            {option.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                  <Button variant="outline" onClick={exportVpnGroups} disabled={!vpnReport || isExporting} className="gap-2">
                    {isExporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
                    Exportar Excel
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 lg:grid-cols-4">
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription>Grupos visibles</CardDescription>
                    <CardTitle className="text-2xl">{filteredVpnGroups.length}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Run total: {vpnReport?.groups.length || 0}
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription>Miembros visibles</CardDescription>
                    <CardTitle className="text-2xl">{filteredVpnMembers.length}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Sobre grupos filtrados
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription>Sin login</CardDescription>
                    <CardTitle className="text-2xl">{filteredVpnMembers.filter((member) => member.neverLoggedIn).length}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    Dentro del alcance filtrado
                  </CardContent>
                </Card>
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-2">
                    <CardDescription>Última ejecución</CardDescription>
                    <CardTitle className="text-lg">{formatIsoDate(vpnReport?.run.generatedAt || null)}</CardTitle>
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">
                    {formatRelative(vpnReport?.run.generatedAt || null)}
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_260px]">
                <Input
                  value={vpnSearch}
                  onChange={(event) => setVpnSearch(event.target.value)}
                  placeholder="Buscar grupo, miembro, UPN o departamento"
                />
                <Select value={vpnGroup} onValueChange={setVpnGroup}>
                  <SelectTrigger>
                    <SelectValue placeholder="Filtrar grupo" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Todos los grupos</SelectItem>
                    {vpnGroups.map((group) => (
                      <SelectItem key={group.value} value={group.value}>
                        {group.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,0.95fr)_minmax(0,1.05fr)]">
                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Resumen por grupo</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Grupo</TableHead>
                          <TableHead>Miembros</TableHead>
                          <TableHead>Descripción</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {loadingReports.vpn_groups ? (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center text-muted-foreground">
                              <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                            </TableCell>
                          </TableRow>
                        ) : filteredVpnGroups.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center text-muted-foreground">
                              No hay grupos dentro del alcance actual.
                            </TableCell>
                          </TableRow>
                        ) : (
                          filteredVpnGroups.map((group) => (
                            <TableRow key={group.groupId}>
                              <TableCell>
                                <div className="font-medium text-foreground">{group.groupName}</div>
                                <div className="text-xs text-muted-foreground">{group.groupId}</div>
                              </TableCell>
                              <TableCell>{group.memberCount}</TableCell>
                              <TableCell>{safeText(group.description)}</TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>

                <Card className="border-border/60 shadow-none">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Miembros visibles</CardTitle>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Usuario</TableHead>
                          <TableHead>Grupo</TableHead>
                          <TableHead>Último login</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {loadingReports.vpn_groups ? (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center text-muted-foreground">
                              <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                            </TableCell>
                          </TableRow>
                        ) : filteredVpnMembers.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={3} className="text-center text-muted-foreground">
                              No hay miembros dentro del alcance actual.
                            </TableCell>
                          </TableRow>
                        ) : (
                          filteredVpnMembers.map((member) => (
                            <TableRow key={`${member.groupId}-${member.userPrincipalName}`}>
                              <TableCell>
                                <div className="font-medium text-foreground">{safeText(member.displayName, member.userPrincipalName)}</div>
                                <div className="text-xs text-muted-foreground">{member.userPrincipalName}</div>
                              </TableCell>
                              <TableCell>{vpnReport?.groups.find((group) => group.groupId === member.groupId)?.groupName || member.groupId}</TableCell>
                              <TableCell>
                                {member.neverLoggedIn ? (
                                  <Badge className="bg-amber-100 text-amber-700 hover:bg-amber-100">Nunca</Badge>
                                ) : (
                                  <div>
                                    <div>{formatIsoDate(member.lastLoginAt)}</div>
                                    <div className="text-xs text-muted-foreground">{formatRelative(member.lastLoginAt)}</div>
                                  </div>
                                )}
                              </TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </CardContent>
                </Card>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
