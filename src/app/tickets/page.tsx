"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import {
  CheckCircle2,
  RotateCcw,
  AlertTriangle,
  Ticket,
  Plus,
  MessageSquare,
  Send,
  Loader2,
} from "lucide-react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface PortalTicket {
  id: number;
  jira_key: string;
  type: "incident" | "request";
  title: string;
  description: string;
  priority: string;
  business_team: string;
  status: string;
  has_attachments: boolean;
  created_at: string;
  closed_at: string | null;
}

interface Comment {
  id: string;
  author: string;
  authorEmail: string;
  body: string;
  created: string;
  updated: string;
}

export default function TicketsPage() {
  const { data: session } = useSession();
  const [tickets, setTickets] = useState<PortalTicket[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<"all" | "open" | "closed">("all");
  const [typeFilter, setTypeFilter] = useState<"all" | "incident" | "request">("all");
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  // Detail view
  const [selectedTicket, setSelectedTicket] = useState<PortalTicket | null>(null);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(false);
  const [newComment, setNewComment] = useState("");
  const [sendingComment, setSendingComment] = useState(false);
  const commentsEndRef = useRef<HTMLDivElement>(null);

  const fetchTickets = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (filter !== "all") params.set("status", filter);
      if (typeFilter !== "all") params.set("type", typeFilter);
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
  }, [filter, typeFilter]);

  useEffect(() => {
    fetchTickets();
  }, [fetchTickets]);

  const fetchComments = async (jiraKey: string) => {
    setCommentsLoading(true);
    try {
      const res = await fetch(`/api/jira/tickets/${jiraKey}/comments`);
      if (res.ok) {
        const data = await res.json();
        setComments(data.comments || []);
      }
    } catch (err) {
      console.error("Error fetching comments:", err);
    } finally {
      setCommentsLoading(false);
    }
  };

  const openDetail = (ticket: PortalTicket) => {
    setSelectedTicket(ticket);
    setComments([]);
    setNewComment("");
    fetchComments(ticket.jira_key);
  };

  const handleSendComment = async () => {
    if (!newComment.trim() || !selectedTicket || sendingComment) return;
    setSendingComment(true);
    try {
      const res = await fetch(`/api/jira/tickets/${selectedTicket.jira_key}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ comment: newComment.trim() }),
      });
      if (res.ok) {
        setNewComment("");
        await fetchComments(selectedTicket.jira_key);
        setTimeout(() => commentsEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
      }
    } catch (err) {
      console.error("Error sending comment:", err);
    } finally {
      setSendingComment(false);
    }
  };

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
        if (selectedTicket?.jira_key === jiraKey) {
          setSelectedTicket((prev) => prev ? { ...prev, status: action === "close" ? "closed" : "open" } : null);
        }
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
    return date.toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric" });
  };

  const formatCommentDate = (dateStr: string) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString("es-ES", {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  const openCount = tickets.filter((t) => t.status !== "closed").length;
  const closedCount = tickets.filter((t) => t.status === "closed").length;

  // ─── Detail view ───────────────────────────────────────────────────
  if (selectedTicket) {
    return (
      <div className="container mx-auto py-6 max-w-4xl">
        {/* Ticket header */}
        <Card className="p-5 mb-4">
          <div className="flex items-start justify-between">
            <div className="flex-1">
              <div className="flex items-center gap-2 mb-1">
                <span className="text-xs font-mono text-muted-foreground">{selectedTicket.jira_key}</span>
                <span className={cn(
                  "px-1.5 py-0.5 rounded text-[10px] font-medium uppercase",
                  selectedTicket.type === "incident"
                    ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                    : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                )}>
                  {selectedTicket.type === "incident" ? "Incidencia" : "Petición"}
                </span>
                <span className={cn("px-1.5 py-0.5 rounded text-[10px] font-medium", priorityBadge(selectedTicket.priority))}>
                  {selectedTicket.priority}
                </span>
                <span className={cn(
                  "px-1.5 py-0.5 rounded text-[10px] font-medium",
                  selectedTicket.status === "closed"
                    ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                )}>
                  {selectedTicket.status === "closed" ? "Cerrada" : "Abierta"}
                </span>
              </div>
              <h2 className="text-lg font-semibold">{selectedTicket.title}</h2>
              <div className="flex items-center gap-2 mt-1 text-xs text-muted-foreground">
                <span>{selectedTicket.business_team}</span>
                <span>·</span>
                <span>Creada {formatDate(selectedTicket.created_at)}</span>
              </div>
              {selectedTicket.description && (
                <p className="mt-3 text-sm text-muted-foreground whitespace-pre-wrap">{selectedTicket.description}</p>
              )}
            </div>
            <div className="flex gap-2 shrink-0 ml-4">
              {selectedTicket.status !== "closed" ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleAction(selectedTicket.jira_key, "close")}
                  disabled={actionLoading === selectedTicket.jira_key}
                  className="gap-1.5 border-green-200 text-green-700 hover:bg-green-50 dark:border-green-800 dark:text-green-300"
                >
                  <CheckCircle2 className="h-3.5 w-3.5" />
                  Cerrar
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleAction(selectedTicket.jira_key, "reopen")}
                  disabled={actionLoading === selectedTicket.jira_key}
                  className="gap-1.5"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reabrir
                </Button>
              )}
            </div>
          </div>
        </Card>

        {/* Comments section */}
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-4">
            <MessageSquare className="h-4 w-4 text-muted-foreground" />
            <h3 className="text-sm font-semibold">Comentarios</h3>
            <span className="text-xs text-muted-foreground">({comments.length})</span>
          </div>

          {commentsLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : comments.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-6">
              No hay comentarios todavía. Escribe uno para comunicarte con el equipo de soporte.
            </p>
          ) : (
            <div className="space-y-3 max-h-[400px] overflow-y-auto mb-4 pr-1">
              {comments.map((c) => (
                <div key={c.id} className="rounded-lg border border-border/60 p-3 bg-muted/20">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-foreground">{c.author}</span>
                    <span className="text-[10px] text-muted-foreground">{formatCommentDate(c.created)}</span>
                  </div>
                  <p className="text-sm text-foreground/90 whitespace-pre-wrap">{c.body}</p>
                </div>
              ))}
              <div ref={commentsEndRef} />
            </div>
          )}

          {/* New comment input */}
          <div className="flex gap-2 mt-3 pt-3 border-t border-border">
            <textarea
              value={newComment}
              onChange={(e) => setNewComment(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSendComment();
                }
              }}
              placeholder="Escribe un comentario..."
              className="flex-1 px-3 py-2 text-sm rounded-lg border border-border bg-background resize-y focus:outline-none focus:ring-2 focus:ring-primary/50 min-h-[80px] max-h-[200px]"
              rows={4}
            />
            <Button
              size="sm"
              onClick={handleSendComment}
              disabled={!newComment.trim() || sendingComment}
              className="self-end gap-1.5"
            >
              {sendingComment ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              Enviar
            </Button>
          </div>
        </Card>
      </div>
    );
  }

  // ─── List view ─────────────────────────────────────────────────────
  return (
    <div className="container mx-auto py-6 max-w-4xl">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Mis tickets</h1>
          <p className="text-muted-foreground text-sm mt-1">
            Gestiona tus incidencias y peticiones abiertas desde el portal.
          </p>
        </div>
        <div className="flex gap-2">
          <Link href="/incidents">
            <Button variant="outline" size="sm" className="gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5" />
              Nueva incidencia
            </Button>
          </Link>
          <Link href="/requests">
            <Button size="sm" className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              Nueva petición
            </Button>
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-6">
        <Card className="p-4">
          <div className="text-2xl font-bold">{tickets.length}</div>
          <div className="text-xs text-muted-foreground">Total</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-amber-600">{openCount}</div>
          <div className="text-xs text-muted-foreground">Abiertas</div>
        </Card>
        <Card className="p-4">
          <div className="text-2xl font-bold text-green-600">{closedCount}</div>
          <div className="text-xs text-muted-foreground">Cerradas</div>
        </Card>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-3 mb-4">
        <div className="flex gap-1 rounded-lg border border-border p-0.5">
          {(["all", "open", "closed"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                filter === f
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f === "all" ? "Todas" : f === "open" ? "Abiertas" : "Cerradas"}
            </button>
          ))}
        </div>
        <div className="flex gap-1 rounded-lg border border-border p-0.5">
          {(["all", "incident", "request"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setTypeFilter(f)}
              className={cn(
                "px-3 py-1.5 text-xs font-medium rounded-md transition-colors",
                typeFilter === f
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {f === "all" ? "Todos" : f === "incident" ? "Incidencias" : "Peticiones"}
            </button>
          ))}
        </div>
      </div>

      {/* Ticket list */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 rounded-lg bg-muted/40 animate-pulse" />
          ))}
        </div>
      ) : tickets.length === 0 ? (
        <Card className="p-8 text-center">
          <Ticket className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-sm text-muted-foreground">
            No tienes tickets registrados.
          </p>
          <div className="flex gap-2 justify-center mt-4">
            <Link href="/incidents">
              <Button variant="outline" size="sm">Abrir incidencia</Button>
            </Link>
            <Link href="/requests">
              <Button size="sm">Abrir petición</Button>
            </Link>
          </div>
        </Card>
      ) : (
        <div className="space-y-2">
          {tickets.map((ticket) => (
            <div
              key={ticket.id}
              onClick={() => openDetail(ticket)}
              className={cn(
                "flex items-center gap-3 rounded-lg border p-4 transition-colors cursor-pointer",
                ticket.status === "closed"
                  ? "border-border/50 bg-muted/20 opacity-75 hover:opacity-100"
                  : "border-border bg-card hover:bg-card/80 hover:border-primary/30"
              )}
            >
              {/* Icon */}
              <div className={cn(
                "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
                ticket.status === "closed"
                  ? "bg-green-100 dark:bg-green-950"
                  : ticket.type === "incident"
                  ? "bg-red-100 dark:bg-red-950"
                  : "bg-primary/10"
              )}>
                {ticket.status === "closed" ? (
                  <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400" />
                ) : ticket.type === "incident" ? (
                  <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
                ) : (
                  <Ticket className="h-4 w-4 text-primary" />
                )}
              </div>

              {/* Content */}
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-mono text-muted-foreground">{ticket.jira_key}</span>
                  <span className={cn(
                    "px-1.5 py-0.5 rounded text-[10px] font-medium uppercase",
                    ticket.type === "incident"
                      ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
                      : "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  )}>
                    {ticket.type === "incident" ? "Incidencia" : "Petición"}
                  </span>
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
                      <span className="text-green-600">Cerrada {formatDate(ticket.closed_at)}</span>
                    </>
                  )}
                </div>
              </div>

              {/* Arrow indicator */}
              <div className="shrink-0 text-muted-foreground">
                <MessageSquare className="h-4 w-4" />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
