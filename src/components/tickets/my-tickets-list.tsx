"use client";

import { useState, useEffect, useCallback } from "react";
import { cn } from "@/lib/utils";
import { CheckCircle2, RotateCcw, Clock, AlertTriangle, Ticket } from "lucide-react";

interface PortalTicket {
  id: number;
  jira_key: string;
  type: "incident" | "request";
  title: string;
  priority: string;
  business_team: string;
  status: string;
  has_attachments: boolean;
  created_at: string;
  closed_at: string | null;
}

interface MyTicketsListProps {
  type: "incident" | "request";
}

export function MyTicketsList({ type }: MyTicketsListProps) {
  const [tickets, setTickets] = useState<PortalTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "open" | "closed">("all");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ type });
      if (filter !== "all") params.set("status", filter);
      const res = await fetch(`/api/jira/my-tickets?${params}`);
      if (res.ok) {
        const data = await res.json();
        setTickets(data.tickets || []);
      }
    } catch (err) {
      console.error("Error fetching tickets:", err);
    } finally {
      setLoading(false);
    }
  }, [type, filter]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const handleAction = async (jiraKey: string, action: "close" | "reopen") => {
    setActionLoading(jiraKey);
    try {
      const res = await fetch("/api/jira/my-tickets", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jiraKey, action }),
      });
      if (res.ok) {
        fetchTickets();
      }
    } catch (err) {
      console.error("Error updating ticket:", err);
    } finally {
      setActionLoading(null);
    }
  };

  const priorityBadge = (priority: string) => {
    switch (priority) {
      case "alta": return "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300";
      case "media": return "bg-yellow-100 text-yellow-700 dark:bg-yellow-950 dark:text-yellow-300";
      case "baja": return "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300";
      default: return "bg-muted text-muted-foreground";
    }
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffHours / 24);

    if (diffHours < 1) return "Hace unos minutos";
    if (diffHours < 24) return `Hace ${diffHours}h`;
    if (diffDays < 7) return `Hace ${diffDays}d`;
    return date.toLocaleDateString("es-ES", { day: "numeric", month: "short" });
  };

  if (loading) {
    return (
      <div className="space-y-3 mt-6">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-16 rounded-lg bg-muted/40 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="mt-8 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">
          {type === "incident" ? "Mis incidencias" : "Mis peticiones"}
        </h3>
        <div className="flex gap-1 rounded-lg border border-border p-0.5">
          {(["all", "open", "closed"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "px-3 py-1 text-xs font-medium rounded-md transition-colors",
                filter === f
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f === "all" ? "Todas" : f === "open" ? "Abiertas" : "Cerradas"}
            </button>
          ))}
        </div>
      </div>

      {tickets.length === 0 ? (
        <div className="text-center py-8 text-sm text-muted-foreground">
          {filter === "all"
            ? `No tienes ${type === "incident" ? "incidencias" : "peticiones"} registradas`
            : `No hay ${type === "incident" ? "incidencias" : "peticiones"} ${filter === "open" ? "abiertas" : "cerradas"}`}
        </div>
      ) : (
        <div className="space-y-2">
          {tickets.map((ticket) => (
            <div
              key={ticket.id}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-3 transition-colors",
                ticket.status === "closed"
                  ? "border-border/50 bg-muted/20 opacity-75"
                  : "border-border bg-card hover:bg-card/80"
              )}
            >
              {/* Icon */}
              <div className={cn(
                "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg",
                ticket.status === "closed" ? "bg-green-100 dark:bg-green-950" : "bg-primary/10"
              )}>
                {ticket.status === "closed" ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                ) : type === "incident" ? (
                  <AlertTriangle className="h-4 w-4 text-primary" />
                ) : (
                  <Ticket className="h-4 w-4 text-primary" />
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-muted-foreground">{ticket.jira_key}</span>
                  <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", priorityBadge(ticket.priority))}>
                    {ticket.priority}
                  </span>
                  {ticket.has_attachments && (
                    <span className="text-[10px] text-muted-foreground">📎</span>
                  )}
                </div>
                <p className="text-sm font-medium text-foreground truncate mt-0.5">{ticket.title}</p>
                <div className="flex items-center gap-2 mt-0.5 text-[11px] text-muted-foreground">
                  <span>{ticket.business_team}</span>
                  <span>·</span>
                  <span>{formatDate(ticket.created_at)}</span>
                  {ticket.closed_at && (
                    <>
                      <span>·</span>
                      <span>Cerrada {formatDate(ticket.closed_at)}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-1.5 shrink-0">
                {ticket.status !== "closed" ? (
                  <button
                    onClick={() => handleAction(ticket.jira_key, "close")}
                    disabled={actionLoading === ticket.jira_key}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md border border-green-200 text-green-700 hover:bg-green-50 dark:border-green-800 dark:text-green-300 dark:hover:bg-green-950/50 transition-colors disabled:opacity-50"
                    title="Marcar como resuelta"
                  >
                    <CheckCircle2 className="h-3 w-3" />
                    Cerrar
                  </button>
                ) : (
                  <button
                    onClick={() => handleAction(ticket.jira_key, "reopen")}
                    disabled={actionLoading === ticket.jira_key}
                    className="inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md border border-border text-muted-foreground hover:bg-secondary/60 transition-colors disabled:opacity-50"
                    title="Reabrir"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Reabrir
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
