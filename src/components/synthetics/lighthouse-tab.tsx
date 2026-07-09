"use client";

import { useState, useEffect, useCallback } from "react";
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  ResponsiveContainer,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { Gauge, Zap, Eye, Search, Globe, ChevronDown, ChevronRight, AlertTriangle as WarningIcon } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface LighthouseSite {
  id: number;
  name: string;
  url: string;
}

interface LighthouseSummary {
  monitorId: number;
  siteName: string;
  siteUrl: string;
  scanDate: string;
  totalRoutes: number;
  avgPerformance: number;
  avgAccessibility: number;
  avgBestPractices: number;
  avgSeo: number;
  avgLcpMs: number;
  avgCls: number;
  avgTbtMs: number;
}

interface LighthouseTypeAgg {
  monitorId: number;
  siteName: string;
  scanDate: string;
  pageType: string;
  routes: number;
  avgPerformance: number;
  avgAccessibility: number;
  avgBestPractices: number;
  avgSeo: number;
  avgLcpMs: number;
  avgCls: number | null;
  avgTbtMs: number;
}

interface LighthouseRoute {
  monitorId: number;
  siteName: string;
  route: string;
  pageType: string | null;
  scanDate: string;
  performance: number | null;
  accessibility: number | null;
  bestPractices: number | null;
  seo: number | null;
  lcpMs: number | null;
  cls: number | null;
  tbtMs: number | null;
  fcpMs: number | null;
  siMs: number | null;
  ttfbMs: number | null;
  pageSizeKb: number | null;
  requestCount: number | null;
  pageTitle: string | null;
  opportunities: Array<{
    id: string;
    title: string;
    description: string;
    savingsMs: number | null;
    savingsBytes: number | null;
    score: number | null;
  }>;
  diagnostics: Array<{
    id: string;
    title: string;
    displayValue: string | null;
    value: number | null;
  }>;
}

function ScoreBadge({ score, label }: { score: number | null; label: string }) {
  if (score === null) return null;
  const color = score >= 90 ? "text-green-600 bg-green-50 dark:bg-green-950/30" :
    score >= 50 ? "text-amber-600 bg-amber-50 dark:bg-amber-950/30" :
    "text-red-600 bg-red-50 dark:bg-red-950/30";
  return (
    <div className={cn("rounded-lg p-3 text-center", color)}>
      <div className="text-2xl font-bold">{score}</div>
      <div className="text-[10px] font-medium uppercase tracking-wide opacity-80">{label}</div>
    </div>
  );
}

export function LighthouseTab() {
  const [data, setData] = useState<{
    sites: LighthouseSite[];
    summary: LighthouseSummary[];
    byType: LighthouseTypeAgg[];
    latestRoutes: LighthouseRoute[];
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSite, setSelectedSite] = useState<number | null>(null);
  const [expandedRoute, setExpandedRoute] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = selectedSite ? `?monitorId=${selectedSite}` : "";
      const res = await fetch(`/api/synthetics/lighthouse${params}`);
      if (res.ok) {
        setData(await res.json());
      } else {
        // Surface real backend errors instead of silently showing the
        // "no data yet" placeholder (which used to mask 401/403/500).
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error) detail = `${detail} — ${body.error}`;
        } catch {
          /* ignore */
        }
        setError(detail);
      }
    } catch (err: any) {
      setError(err?.message || "Error de red");
    } finally {
      setLoading(false);
    }
  }, [selectedSite]);

  useEffect(() => { fetchData(); }, [fetchData]);

  if (loading) {
    return (
      <div className="space-y-4 animate-pulse">
        <div className="h-10 bg-muted/40 rounded-lg w-1/3" />
        <div className="grid grid-cols-4 gap-3">
          {[1,2,3,4].map(i => <div key={i} className="h-24 bg-muted/40 rounded-lg" />)}
        </div>
        <div className="h-64 bg-muted/40 rounded-lg" />
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-8 text-center border-destructive/40 bg-destructive/5">
        <WarningIcon className="h-10 w-10 mx-auto text-destructive/70 mb-3" />
        <p className="text-sm font-medium text-destructive">No se pudieron cargar los datos de Lighthouse</p>
        <p className="text-xs text-muted-foreground mt-1">{error}</p>
        <p className="text-[11px] text-muted-foreground mt-2">
          Si tu rol es <code>externos</code> o <code>desarrolladores</code> y ves esto, contacta con Platform — la API debería estar accesible para todos los roles.
        </p>
      </Card>
    );
  }

  if (!data || (data.summary.length === 0 && data.latestRoutes.length === 0)) {
    return (
      <Card className="p-8 text-center">
        <Globe className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
        <p className="text-sm text-muted-foreground">
          No hay datos de Lighthouse todavía. El primer escaneo se ejecutará el próximo domingo a las 3:00 AM.
        </p>
      </Card>
    );
  }

  // Get latest summary per site
  const latestBySite = new Map<number, LighthouseSummary>();
  for (const s of data.summary) {
    if (!latestBySite.has(s.monitorId) || s.scanDate > latestBySite.get(s.monitorId)!.scanDate) {
      latestBySite.set(s.monitorId, s);
    }
  }

  // Latest byType for selected site (or all)
  const latestByTypeKey = new Map<string, LighthouseTypeAgg>();
  for (const r of (data.byType || [])) {
    if (selectedSite && r.monitorId !== selectedSite) continue;
    const k = `${r.monitorId}|${r.pageType}`;
    if (!latestByTypeKey.has(k) || r.scanDate > latestByTypeKey.get(k)!.scanDate) {
      latestByTypeKey.set(k, r);
    }
  }
  const latestByType = Array.from(latestByTypeKey.values());

  const PAGE_TYPE_LABELS: Record<string, string> = {
    home: "Home",
    plp: "Categorías (PLP)",
    pdp: "Productos (PDP)",
    brand: "Marcas",
    blog: "Blog/Contenido",
    search: "Búsqueda",
    cart: "Carrito",
    checkout: "Checkout",
    account: "Cuenta",
    login: "Login",
    help: "Ayuda/Contacto",
    legal: "Legal",
    other: "Otros",
  };
  const PAGE_TYPE_ORDER = ["home", "plp", "pdp", "brand", "blog", "search", "cart", "checkout", "account", "login", "help", "legal", "other"];

  // Group routes by pageType for the routes table
  const routesByType = new Map<string, LighthouseRoute[]>();
  for (const r of data.latestRoutes) {
    const t = r.pageType || "other";
    if (!routesByType.has(t)) routesByType.set(t, []);
    routesByType.get(t)!.push(r);
  }
  const orderedTypes = PAGE_TYPE_ORDER.filter((t) => routesByType.has(t));

  // Trend data for selected site (or first site)
  const trendSiteId = selectedSite || data.sites[0]?.id;
  const trendData = data.summary
    .filter(s => s.monitorId === trendSiteId)
    .sort((a, b) => a.scanDate.localeCompare(b.scanDate));

  return (
    <div className="space-y-6">
      {/* Site selector */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setSelectedSite(null)}
          className={cn(
            "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
            !selectedSite ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
          )}
        >
          Todos
        </button>
        {data.sites.map(site => (
          <button
            key={site.id}
            onClick={() => setSelectedSite(site.id)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
              selectedSite === site.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
            )}
          >
            {site.name}
          </button>
        ))}
      </div>

      {/* Score cards per site (latest) */}
      {!selectedSite && (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[...latestBySite.values()].map(site => (
            <Card key={site.monitorId} className="p-4 cursor-pointer hover:border-primary/40 transition-colors" onClick={() => setSelectedSite(site.monitorId)}>
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-semibold">{site.siteName}</span>
                <span className="text-[10px] text-muted-foreground">{site.scanDate} · {site.totalRoutes} rutas</span>
              </div>
              <div className="grid grid-cols-4 gap-2">
                <ScoreBadge score={site.avgPerformance} label="Perf" />
                <ScoreBadge score={site.avgAccessibility} label="A11y" />
                <ScoreBadge score={site.avgBestPractices} label="BP" />
                <ScoreBadge score={site.avgSeo} label="SEO" />
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* Selected site detail */}
      {selectedSite && latestBySite.has(selectedSite) && (
        <>
          {/* Big score cards */}
          <div className="grid grid-cols-4 gap-3">
            <ScoreBadge score={latestBySite.get(selectedSite)!.avgPerformance} label="Performance" />
            <ScoreBadge score={latestBySite.get(selectedSite)!.avgAccessibility} label="Accessibility" />
            <ScoreBadge score={latestBySite.get(selectedSite)!.avgBestPractices} label="Best Practices" />
            <ScoreBadge score={latestBySite.get(selectedSite)!.avgSeo} label="SEO" />
          </div>

          {/* Trend chart */}
          {trendData.length > 1 && (
            <Card className="p-4">
              <h3 className="text-sm font-medium mb-3">Evolución semanal</h3>
              <ResponsiveContainer width="100%" height={300}>
                <LineChart data={trendData}>
                  <CartesianGrid strokeDasharray="3 3" className="opacity-30" />
                  <XAxis dataKey="scanDate" tick={{ fontSize: 11 }} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11 }} />
                  <Tooltip />
                  <Legend />
                  <Line type="monotone" dataKey="avgPerformance" name="Performance" stroke="#ef4444" strokeWidth={2} dot />
                  <Line type="monotone" dataKey="avgAccessibility" name="Accessibility" stroke="#6366f1" strokeWidth={2} dot />
                  <Line type="monotone" dataKey="avgBestPractices" name="Best Practices" stroke="#10b981" strokeWidth={2} dot />
                  <Line type="monotone" dataKey="avgSeo" name="SEO" stroke="#f59e0b" strokeWidth={2} dot />
                </LineChart>
              </ResponsiveContainer>
            </Card>
          )}
        </>
      )}

      {/* Per page-type aggregate */}
      {latestByType.length > 0 && (
        <Card className="p-4">
          <h3 className="text-sm font-medium mb-3 flex items-center gap-2">
            Scores por tipo de página
            <span className="text-muted-foreground font-normal">
              {selectedSite && `— ${latestBySite.get(selectedSite)?.siteName}`}
            </span>
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {PAGE_TYPE_ORDER
              .filter((t) => latestByType.some((r) => r.pageType === t))
              .map((t) => {
                const rows = latestByType.filter((r) => r.pageType === t);
                // If "Todos" view, average across sites
                const totalRoutes = rows.reduce((s, r) => s + r.routes, 0);
                const avgPerf = Math.round(rows.reduce((s, r) => s + r.avgPerformance * r.routes, 0) / totalRoutes);
                const avgA11y = Math.round(rows.reduce((s, r) => s + r.avgAccessibility * r.routes, 0) / totalRoutes);
                const avgBP = Math.round(rows.reduce((s, r) => s + r.avgBestPractices * r.routes, 0) / totalRoutes);
                const avgSeo = Math.round(rows.reduce((s, r) => s + r.avgSeo * r.routes, 0) / totalRoutes);
                return (
                  <div key={t} className="rounded-lg border bg-card/40 p-3">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-semibold">{PAGE_TYPE_LABELS[t] || t}</span>
                      <span className="text-[10px] text-muted-foreground">{totalRoutes} ruta{totalRoutes === 1 ? "" : "s"}</span>
                    </div>
                    <div className="grid grid-cols-4 gap-1.5">
                      <ScoreBadge score={avgPerf} label="Perf" />
                      <ScoreBadge score={avgA11y} label="A11y" />
                      <ScoreBadge score={avgBP} label="BP" />
                      <ScoreBadge score={avgSeo} label="SEO" />
                    </div>
                  </div>
                );
              })}
          </div>
        </Card>
      )}

      {/* Routes table */}
      <Card className="p-4">
        <h3 className="text-sm font-medium mb-3">
          Detalle por ruta {selectedSite && `— ${latestBySite.get(selectedSite)?.siteName}`}
          <span className="text-muted-foreground font-normal ml-2">({data.latestRoutes.length} rutas, agrupadas por tipo)</span>
        </h3>
        <div className="space-y-2">
          {orderedTypes.map((t) => (
            <RouteTypeGroup
              key={t}
              pageType={t}
              label={PAGE_TYPE_LABELS[t] || t}
              routes={routesByType.get(t) || []}
              expandedRoute={expandedRoute}
              setExpandedRoute={setExpandedRoute}
              showSite={!selectedSite}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Per-type collapsible group
// ──────────────────────────────────────────────────────────────────────────

function RouteTypeGroup({
  pageType,
  label,
  routes,
  expandedRoute,
  setExpandedRoute,
  showSite,
}: {
  pageType: string;
  label: string;
  routes: LighthouseRoute[];
  expandedRoute: string | null;
  setExpandedRoute: (k: string | null) => void;
  showSite: boolean;
}) {
  const [open, setOpen] = useState(true);
  const totalRoutes = routes.length;
  const avgPerf = Math.round(
    routes.reduce((s, r) => s + (r.performance ?? 0), 0) / Math.max(1, totalRoutes),
  );

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/30"
      >
        <div className="flex items-center gap-2">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="text-sm font-medium">{label}</span>
          <span className="text-[10px] text-muted-foreground">({totalRoutes} ruta{totalRoutes === 1 ? "" : "s"} · perf medio {avgPerf})</span>
        </div>
        <span className={cn(
          "px-1.5 py-0.5 rounded text-[10px] font-medium",
          avgPerf >= 90 ? "bg-green-100 text-green-700" :
          avgPerf >= 50 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700",
        )}>{avgPerf}</span>
      </button>
      {open && (
        <div className="overflow-x-auto max-h-[400px] overflow-y-auto border-t border-border/40">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-card">
              <tr className="border-b text-left text-muted-foreground">
                {showSite && <th className="pb-2 px-3 font-medium">Sitio</th>}
                <th className="pb-2 px-3 font-medium">Ruta</th>
                <th className="pb-2 px-3 font-medium text-center">Perf</th>
                <th className="pb-2 px-3 font-medium text-center">A11y</th>
                <th className="pb-2 px-3 font-medium text-center">BP</th>
                <th className="pb-2 px-3 font-medium text-center">SEO</th>
                <th className="pb-2 px-3 font-medium text-right">LCP</th>
                <th className="pb-2 px-3 font-medium text-right">CLS</th>
                <th className="pb-2 px-3 font-medium text-right">TBT</th>
                <th className="pb-2 px-3 font-medium text-right">Tamaño</th>
              </tr>
            </thead>
            <tbody>
              {routes.map((route, idx) => {
                const routeKey = `${route.monitorId}-${route.route}`;
                const isExpanded = expandedRoute === routeKey;
                const hasDetails = (route.opportunities?.length || 0) > 0 || (route.diagnostics?.length || 0) > 0;
                return (
                  <RouteRow
                    key={routeKey}
                    route={route}
                    isExpanded={isExpanded}
                    onToggle={() => hasDetails && setExpandedRoute(isExpanded ? null : routeKey)}
                    hasDetails={hasDetails}
                    showSite={showSite}
                  />
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RouteRow({
  route,
  isExpanded,
  onToggle,
  hasDetails,
  showSite,
}: {
  route: LighthouseRoute;
  isExpanded: boolean;
  onToggle: () => void;
  hasDetails: boolean;
  showSite: boolean;
}) {
  return (
    <>
      <tr
        className={cn("border-b last:border-0 hover:bg-muted/30", hasDetails && "cursor-pointer")}
        onClick={onToggle}
      >
        {showSite && <td className="py-1.5 px-3 text-muted-foreground">{route.siteName}</td>}
        <td className="py-1.5 px-3 font-mono truncate max-w-[280px] flex items-center gap-1" title={route.route}>
          {hasDetails && (isExpanded ? <ChevronDown className="h-3 w-3 shrink-0" /> : <ChevronRight className="h-3 w-3 shrink-0" />)}
          {route.route}
        </td>
        <td className="py-1.5 px-3 text-center">
          <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium",
            (route.performance || 0) >= 90 ? "bg-green-100 text-green-700" :
            (route.performance || 0) >= 50 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700",
          )}>{route.performance ?? "-"}</span>
        </td>
        <td className="py-1.5 px-3 text-center">
          <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium",
            (route.accessibility || 0) >= 90 ? "bg-green-100 text-green-700" :
            (route.accessibility || 0) >= 50 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700",
          )}>{route.accessibility ?? "-"}</span>
        </td>
        <td className="py-1.5 px-3 text-center">
          <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium",
            (route.bestPractices || 0) >= 90 ? "bg-green-100 text-green-700" :
            (route.bestPractices || 0) >= 50 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700",
          )}>{route.bestPractices ?? "-"}</span>
        </td>
        <td className="py-1.5 px-3 text-center">
          <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium",
            (route.seo || 0) >= 90 ? "bg-green-100 text-green-700" :
            (route.seo || 0) >= 50 ? "bg-amber-100 text-amber-700" : "bg-red-100 text-red-700",
          )}>{route.seo ?? "-"}</span>
        </td>
        <td className="py-1.5 px-3 text-right text-muted-foreground">{route.lcpMs ? `${(route.lcpMs / 1000).toFixed(1)}s` : "-"}</td>
        <td className="py-1.5 px-3 text-right text-muted-foreground">{route.cls !== null ? route.cls.toFixed(3) : "-"}</td>
        <td className="py-1.5 px-3 text-right text-muted-foreground">{route.tbtMs ? `${route.tbtMs}ms` : "-"}</td>
        <td className="py-1.5 px-3 text-right text-muted-foreground">{route.pageSizeKb ? `${route.pageSizeKb}KB` : "-"}</td>
      </tr>
      {isExpanded && (
        <tr>
          <td colSpan={showSite ? 10 : 9} className="p-0">
            <div className="bg-muted/20 border-t border-b p-4 space-y-3">
              {route.opportunities?.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-amber-700 dark:text-amber-400 mb-2 flex items-center gap-1">
                    <WarningIcon className="h-3 w-3" /> Oportunidades de mejora
                  </h4>
                  <div className="space-y-1.5">
                    {route.opportunities.map((opp, i) => (
                      <div key={i} className="flex items-start gap-2 text-[11px]">
                        <span className="shrink-0 w-16 text-right font-mono text-amber-600">
                          {opp.savingsMs ? `−${(opp.savingsMs / 1000).toFixed(1)}s` : opp.savingsBytes ? `−${opp.savingsBytes}KB` : ""}
                        </span>
                        <span className="text-foreground">{opp.title}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {route.diagnostics?.length > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-muted-foreground mb-2">Diagnósticos</h4>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                    {route.diagnostics.map((diag, i) => (
                      <div key={i} className="text-[11px] bg-background rounded px-2 py-1.5 border">
                        <span className="text-muted-foreground">{diag.title}</span>
                        {diag.displayValue && <span className="ml-1 font-medium text-foreground">{diag.displayValue}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {!route.opportunities?.length && !route.diagnostics?.length && (
                <p className="text-xs text-muted-foreground">Sin detalles disponibles para esta ruta.</p>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
