"use client";

import { useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  CalendarClock,
  Cloud,
  ExternalLink,
  Info,
  Loader2,
  RefreshCw,
  Server,
  ChevronRight,
  Building2,
} from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
  SheetFooter,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

/** Mirrors the AwsNewsItem shape served by GET /api/aws-health/news. */
interface AffectedAccount {
  accountId: string;
  accountName: string;
}

interface AwsNewsItem {
  arn: string;
  service: string;
  region: string | null;
  category: "issue" | "scheduledChange" | "accountNotification";
  statusCode: "open" | "upcoming" | "closed";
  severity: "alta" | "media" | "baja";
  startTime: string | null;
  endTime: string | null;
  lastUpdated: string | null;
  affectedAccounts: AffectedAccount[];
  description: string;
}

/** Severity badge colours: alta -> red/danger, media -> orange/warning, baja -> green/muted. */
function severityClass(severity: AwsNewsItem["severity"]): string {
  switch (severity) {
    case "alta":
      return "bg-danger/15 text-danger border-danger/40";
    case "media":
      return "bg-warning/15 text-warning border-warning/40";
    default:
      return "bg-success/15 text-success border-success/40";
  }
}

/** Left accent bar colour by severity. */
function severityAccent(severity: AwsNewsItem["severity"]): string {
  switch (severity) {
    case "alta":
      return "bg-danger";
    case "media":
      return "bg-warning";
    default:
      return "bg-success";
  }
}

/** Status badge colours: open -> danger-ish, upcoming -> info, closed -> muted. */
function statusClass(status: AwsNewsItem["statusCode"]): string {
  switch (status) {
    case "open":
      return "bg-danger/10 text-danger border-danger/30";
    case "upcoming":
      return "bg-info/10 text-info border-info/30";
    default:
      return "bg-muted text-muted-foreground border-border/60";
  }
}

/** Formats an ISO date to a short, locale-aware label, or a dash when absent. */
function shortDateTime(value: string | null): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Deep link to the AWS Health Dashboard event detail in the console. */
function consoleUrl(item: AwsNewsItem): string {
  const region = item.region || "eu-west-1";
  return `https://health.console.aws.amazon.com/health/home?region=${region}#/account/dashboard/open-issues`;
}

/** Compact, clickable news row. */
function NewsRow({
  item,
  t,
  onSelect,
}: {
  item: AwsNewsItem;
  t: (key: string, fallback?: string) => string;
  onSelect: () => void;
}) {
  const accounts = item.affectedAccounts ?? [];
  const categoryLabel = t(`home.news.category.${item.category}`, item.category);
  const statusLabel = t(`home.news.status.${item.statusCode}`, item.statusCode);
  const severityLabel = t(`home.news.severity.${item.severity}`, item.severity);
  const dateValue = item.lastUpdated ?? item.startTime;
  const accountSummary =
    accounts.length === 0
      ? "—"
      : accounts.length === 1
        ? accounts[0].accountName
        : `${accounts.length} ${t("home.news.accountsAffected", "cuentas afectadas")}`;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="group relative w-full overflow-hidden rounded-lg border border-border/60 bg-card pl-3 pr-2.5 py-2.5 text-left transition-all hover:border-primary/40 hover:shadow-sm"
    >
      {/* severity accent bar */}
      <span className={cn("absolute inset-y-0 left-0 w-1", severityAccent(item.severity))} />

      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-1.5">
          <Server className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold">{item.service}</span>
          {item.region && (
            <span className="shrink-0 text-[10px] text-muted-foreground">· {item.region}</span>
          )}
        </div>
        <Badge variant="outline" className={cn("shrink-0 text-[10px]", severityClass(item.severity))}>
          {severityLabel}
        </Badge>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="border-border/60 text-[10px] text-muted-foreground">
          {categoryLabel}
        </Badge>
        <Badge variant="outline" className={cn("text-[10px]", statusClass(item.statusCode))}>
          {statusLabel}
        </Badge>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="flex min-w-0 items-center gap-1">
          <Building2 className="h-3 w-3 shrink-0" />
          <span className="truncate">{accountSummary}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1">
          <CalendarClock className="h-3 w-3" />
          {shortDateTime(dateValue)}
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 transition-transform group-hover:translate-x-0.5 group-hover:text-primary" />
        </span>
      </div>
    </button>
  );
}

/** Slide-over detail panel for a single event. */
function NewsDetail({
  item,
  t,
}: {
  item: AwsNewsItem;
  t: (key: string, fallback?: string) => string;
}) {
  const categoryLabel = t(`home.news.category.${item.category}`, item.category);
  const statusLabel = t(`home.news.status.${item.statusCode}`, item.statusCode);
  const severityLabel = t(`home.news.severity.${item.severity}`, item.severity);
  const accounts = item.affectedAccounts ?? [];

  const facts: Array<{ label: string; value: string }> = [
    { label: t("home.news.detail.service", "Servicio"), value: item.service },
    { label: t("home.news.detail.region", "Región"), value: item.region || "—" },
    { label: t("home.news.detail.category", "Categoría"), value: categoryLabel },
    { label: t("home.news.detail.start", "Inicio"), value: shortDateTime(item.startTime) },
    { label: t("home.news.detail.end", "Fin"), value: shortDateTime(item.endTime) },
    { label: t("home.news.detail.updated", "Actualizado"), value: shortDateTime(item.lastUpdated) },
  ];

  return (
    <>
      <SheetHeader>
        <div className="flex items-center gap-2">
          <Badge variant="outline" className={cn("text-[10px]", severityClass(item.severity))}>
            {severityLabel}
          </Badge>
          <Badge variant="outline" className={cn("text-[10px]", statusClass(item.statusCode))}>
            {statusLabel}
          </Badge>
          <Badge variant="outline" className="border-border/60 text-[10px] text-muted-foreground">
            {categoryLabel}
          </Badge>
        </div>
        <SheetTitle className="flex items-center gap-2">
          <Server className="h-4 w-4 text-primary" />
          {item.service}
          {item.region && <span className="text-sm font-normal text-muted-foreground">· {item.region}</span>}
        </SheetTitle>
        <SheetDescription>{t("home.news.detail.subtitle", "Detalle del evento de salud de AWS")}</SheetDescription>
      </SheetHeader>

      <div className="flex-1 space-y-5 overflow-y-auto pr-1">
        {/* Fact grid */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border border-border/60 p-4">
          {facts.map((f) => (
            <div key={f.label} className="min-w-0">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{f.label}</div>
              <div className="truncate text-sm font-medium" title={f.value}>{f.value}</div>
            </div>
          ))}
        </div>

        {/* Affected accounts */}
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Building2 className="h-3.5 w-3.5" />
            {t("home.news.detail.accounts", "Cuentas afectadas")} ({accounts.length})
          </div>
          {accounts.length === 0 ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {accounts.map((acc) => (
                <span
                  key={acc.accountId}
                  className="rounded-full border border-border/60 bg-muted/40 px-2.5 py-1 text-xs font-medium"
                  title={acc.accountId}
                >
                  {acc.accountName}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Description */}
        {item.description && (
          <div>
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {t("home.news.detail.description", "Descripción")}
            </div>
            <div className="whitespace-pre-wrap rounded-xl border border-border/60 bg-muted/20 p-4 text-xs leading-relaxed text-foreground/90">
              {item.description}
            </div>
          </div>
        )}
      </div>

      <SheetFooter>
        <a
          href={consoleUrl(item)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <ExternalLink className="h-4 w-4" />
          {t("home.news.detail.viewConsole", "Ver en consola AWS")}
        </a>
      </SheetFooter>
    </>
  );
}

/**
 * Admin-only "AWS news" sidebar for the home page (req 4.1-4.7). Renders nothing for
 * non-admins (client gate); the endpoint also enforces admin server-side. Lists recent
 * AwsNewsItem with severity/category/status badges and friendly account names, a
 * "hide closed" toggle, and a slide-over detail panel on click.
 */
export function NewsSidebar() {
  const { t } = useI18n();
  const { data: session } = useSession();
  const isAdmin = session?.user?.appRole === "admin";

  const [items, setItems] = useState<AwsNewsItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [hideClosed, setHideClosed] = useState(true);
  const [selected, setSelected] = useState<AwsNewsItem | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    const params = new URLSearchParams();
    params.set("includeClosed", hideClosed ? "false" : "true");
    fetch(`/api/aws-health/news?${params.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error("request failed");
        return r.json();
      })
      .then((json: AwsNewsItem[]) => {
        if (!cancelled) setItems(Array.isArray(json) ? json : []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin, hideClosed, reloadKey]);

  const openCount = useMemo(
    () => (items ?? []).filter((i) => i.statusCode === "open" || i.statusCode === "upcoming").length,
    [items],
  );

  // Client gate: only admins see the sidebar (the endpoint also validates admin server-side).
  if (!isAdmin) return null;

  return (
    <>
      <Card className="border-border/70">
        <CardHeader className="pb-3">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-base">
                <Cloud className="h-4 w-4 text-primary" />
                {t("home.news.title", "Novedades AWS")}
              </CardTitle>
              <CardDescription>{t("home.news.description", "Eventos de salud de AWS sobre nuestras cuentas")}</CardDescription>
            </div>
            {!loading && !error && openCount > 0 && (
              <Badge variant="outline" className={cn("shrink-0 text-[10px]", severityClass("media"))}>
                {openCount} {t("home.news.actionable", "accionables")}
              </Badge>
            )}
          </div>
          <div className="mt-2 flex items-center justify-between">
            <label className="flex cursor-pointer select-none items-center gap-2 text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={hideClosed}
                onChange={(e) => setHideClosed(e.target.checked)}
                className="h-3.5 w-3.5 rounded border-border accent-primary"
              />
              {t("home.news.hideClosed", "Ocultar cerrados")}
            </label>
            <button
              type="button"
              onClick={() => setReloadKey((k) => k + 1)}
              className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-primary"
              title={t("home.news.retry", "Reintentar")}
            >
              <RefreshCw className={cn("h-3 w-3", loading && "animate-spin")} />
            </button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <AlertTriangle className="mb-2 h-7 w-7 text-danger/50" />
              <p className="text-xs text-muted-foreground">{t("home.news.error", "Error cargando las novedades de AWS")}</p>
              <button
                type="button"
                onClick={() => setReloadKey((k) => k + 1)}
                className="mt-2 flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <RefreshCw className="h-3 w-3" />
                {t("home.news.retry", "Reintentar")}
              </button>
            </div>
          ) : !items || items.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-center">
              <Info className="mb-2 h-8 w-8 text-primary/30" />
              <p className="text-sm font-medium">{t("home.news.empty", "Sin novedades de AWS")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("home.news.emptyHint", "No hay eventos de salud recientes para nuestras cuentas.")}</p>
            </div>
          ) : (
            <div className="max-h-[70vh] space-y-2 overflow-y-auto pr-1">
              {items.map((item) => (
                <NewsRow key={item.arn} item={item} t={t} onSelect={() => setSelected(item)} />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Slide-over detail */}
      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right" className="w-full sm:max-w-lg">
          {selected && <NewsDetail item={selected} t={t} />}
        </SheetContent>
      </Sheet>
    </>
  );
}
