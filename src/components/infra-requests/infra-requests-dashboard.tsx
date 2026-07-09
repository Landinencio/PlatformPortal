"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useI18n } from "@/lib/i18n";
import { Check, X, Clock, Database, HardDrive, Cpu, Shield, Loader2, ChevronDown, ChevronRight, ExternalLink, AlertTriangle, Rocket, Ban, ShieldCheck, Key, MessageSquare, Radio, Network, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { useSession } from "next-auth/react";
import { ConversationReview } from "@/components/infra-assistant/conversation-review";
import type { ConversationMessage, TerraformPreview } from "@/lib/infra-agent";
import { suggestionForCode, type ErrorCode, type ExecuteStep } from "@/lib/infra/error-classifier";
import { useToast } from "@/components/ui/toast";

interface InfraRequest {
  id: number;
  _type?: "infra" | "access";
  status: string;
  resource_type: string;
  team: string;
  requestor_email: string;
  requestor_name: string | null;
  payload: any;
  reviewer_email: string | null;
  reviewer_name: string | null;
  review_comment: string | null;
  created_at: string;
  reviewed_at: string | null;
  ai_conversation: ConversationMessage[] | null;
  terraform_preview: TerraformPreview | null;
  gitlab_mr_url: string | null;
  gitlab_branch: string | null;
  jira_key: string | null;
  executed_at: string | null;
  /**
   * Error_Persistido written by the Execute_API when a request transitions to
   * `execute_failed` (spec `infra-self-service-hardening`, Req 5.6). Null for
   * legacy rows (pre-migration) or when the persistence UPDATE itself failed
   * (Req 5.9 — the flow continues with code "unknown").
   */
  error_message: {
    code: ErrorCode;
    message: string;
    step: ExecuteStep;
    timestamp: string;
  } | null;
  // Access request specific fields
  target_user_email?: string;
  platform?: string;
  request_type?: string;
  group_name?: string;
  role?: string;
  approver_email?: string;
}

const RESOURCE_ICONS: Record<string, typeof Database> = {
  rds: Database,
  s3: HardDrive,
  lambda: Cpu,
  iam_role: Shield,
  // Squad self-service infra
  "squad-sqs": MessageSquare,
  "squad-secret": Key,
  "squad-secret-update": Key,
  "squad-dynamodb": Database,
  "squad-sns": Radio,
  "squad-eventbridge": Network,
  // Access request platforms
  aws: Shield,
  argocd: Rocket,
  sonarqube: Database,
  gitlab: Key,
  kiro: Key,
  access: ShieldCheck,
};

const STATUS_CONFIG: Record<string, { color: string; label: string; icon: typeof Clock }> = {
  pending: { color: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400", label: "infra.status.pending", icon: Clock },
  approved: { color: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400", label: "infra.status.approved", icon: Check },
  executing: { color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400", label: "infra.status.executing", icon: Loader2 },
  rejected: { color: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400", label: "infra.status.rejected", icon: X },
  cancelled: { color: "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-400", label: "infra.status.cancelled", icon: Ban },
  executed: { color: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400", label: "infra.status.executed", icon: Rocket },
  execute_failed: { color: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400", label: "infra.status.execute_failed", icon: AlertTriangle },
};

export function InfraRequestsDashboard() {
  const [requests, setRequests] = useState<InfraRequest[]>([]);
  const [isApprover, setIsApprover] = useState(false);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<string>("all");
  const [reviewingId, setReviewingId] = useState<number | null>(null);
  const [comment, setComment] = useState("");
  const [expandedRequestId, setExpandedRequestId] = useState<number | null>(null);
  const { t } = useI18n();
  const { data: session } = useSession();
  const { toast } = useToast();
  const currentEmail = session?.user?.email?.toLowerCase() || "";
  const normalizedCurrentEmail = currentEmail.replace("@emefinpetcare.com", "@iskaypet.com");

  const normalize = (e: string) => e.toLowerCase().replace("@emefinpetcare.com", "@iskaypet.com");

  const fetchRequests = useCallback(async () => {
    try {
      const url = filter === "all" ? "/api/infra-requests" : `/api/infra-requests?status=${filter}`;
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setRequests(data.requests);
        setIsApprover(data.isApprover);
      }
    } catch {} finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => { fetchRequests(); }, [fetchRequests]);

  const handleReview = async (id: number, action: "approve" | "reject", reqType?: "infra" | "access") => {
    setReviewingId(id);
    try {
      const endpoint = reqType === "access"
        ? `/api/access-management/${id}/review`
        : `/api/infra-requests/${id}/review`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, comment: comment || undefined }),
      });
      if (res.ok) {
        setComment("");
        fetchRequests();
      }
    } catch {} finally {
      setReviewingId(null);
    }
  };

  const handleCancel = async (id: number, reqType?: "infra" | "access") => {
    if (!window.confirm(t("infra.requests.cancelConfirm", "¿Estás seguro de que quieres cancelar esta solicitud?"))) {
      return;
    }
    try {
      const endpoint = reqType === "access"
        ? `/api/access-management/${id}/cancel`
        : `/api/infra-requests/${id}/cancel`;
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        fetchRequests();
      }
    } catch {}
  };

  /**
   * Copy the full Error_Persistido JSON to the user's clipboard (Req 5.7).
   * Falls back gracefully when the browser lacks clipboard permissions (older
   * browsers, insecure contexts, iframe restrictions).
   */
  const handleCopyErrorDetail = async (errorPayload: InfraRequest["error_message"]) => {
    if (!errorPayload) return;
    const json = JSON.stringify(errorPayload, null, 2);
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(json);
        toast("success", t("infra.requests.copyDetailSuccess", "Detalle del error copiado al portapapeles"));
        return;
      }
      throw new Error("clipboard-unavailable");
    } catch {
      toast("error", t("infra.requests.copyDetailError", "No se pudo copiar al portapapeles"));
    }
  };

  const getResourceName = (req: InfraRequest) => {
    if (req._type === "access") {
      const requestType = req.request_type || "grant";
      if (requestType === "kiro-license") return `Licencia Kiro — ${req.target_user_email}`;
      if (requestType === "onboard") return `Alta GitLab — ${req.target_user_email}`;
      if (requestType === "offboard") return `Baja GitLab — ${req.target_user_email}`;
      return `${(req.platform || "").toUpperCase()} — ${req.group_name || req.target_user_email}`;
    }
    const p = typeof req.payload === "string" ? JSON.parse(req.payload) : req.payload;
    // Squad infra stores the resource name in payload.resourceName
    if (req.resource_type?.startsWith("squad-")) {
      return p?.resourceName || p?.identifier || "-";
    }
    return p.bucket_name || p.identifier || p.function_name || p.role_name || "-";
  };

  const timeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  };

  const pendingCount = requests.filter((r) => r.status === "pending").length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-foreground">{t("infra.requests.title")}</h1>
        <p className="text-sm text-muted-foreground mt-1">{t("infra.requests.subtitle")}</p>
      </div>

      {/* Filters */}
      <div className="flex gap-2">
        {["all", "pending", "approved", "rejected", "cancelled", "executed", "execute_failed"].map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={cn(
              "px-3 py-1.5 text-xs font-medium rounded-lg transition-colors",
              filter === f
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/80"
            )}
          >
            {f === "all" ? t("common.all") : t(`infra.status.${f}`)}
            {f === "pending" && pendingCount > 0 && (
              <span className="ml-1.5 bg-amber-500 text-white text-[10px] px-1.5 py-0.5 rounded-full">{pendingCount}</span>
            )}
          </button>
        ))}
      </div>

      {/* List */}
      {loading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : requests.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-sm text-muted-foreground">
            {t("infra.requests.empty")}
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {requests.map((req) => {
            const Icon = RESOURCE_ICONS[req.resource_type] || Database;
            const statusCfg = STATUS_CONFIG[req.status] || STATUS_CONFIG.pending;
            const resourceName = getResourceName(req);

            return (
              <Card key={req.id} className="border-border/70">
                <CardContent className="p-4">
                  <div className="flex items-start gap-4">
                    <div className="shrink-0 rounded-xl bg-primary/10 p-2.5 mt-0.5">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>

                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-sm font-semibold text-foreground">{resourceName}</span>
                        <Badge variant="outline" className="text-[10px]">{req.resource_type.toUpperCase()}</Badge>
                        <Badge variant="outline" className="text-[10px]">{req.team}</Badge>
                        <span className={cn("text-[10px] font-medium px-2 py-0.5 rounded-full", statusCfg.color)}>
                          {t(statusCfg.label)}
                        </span>
                      </div>

                      <p className="text-xs text-muted-foreground mt-1">
                        {t("infra.requests.requestedBy")} {req.requestor_name || req.requestor_email} · {timeAgo(req.created_at)}
                      </p>
                      {(() => {
                        if (req._type === "access") {
                          // Access request details
                          return (
                            <div className="mt-1.5 space-y-0.5">
                              {req.target_user_email && <p className="text-[11px] text-muted-foreground">Usuario: <strong>{req.target_user_email}</strong></p>}
                              {req.group_name && <p className="text-[11px] text-muted-foreground">Grupo: {req.group_name}</p>}
                              {req.role && <p className="text-[11px] text-muted-foreground">Rol: {req.role}</p>}
                            </div>
                          );
                        }
                        const p = typeof req.payload === "string" ? JSON.parse(req.payload) : req.payload;
                        const specs = p.cost_specs;
                        const cost = p.estimated_cost_monthly;
                        const envs = (p.target_environments || []).join(", ");
                        const warning = p.cost_billing_warning;
                        const reco = p.cost_recommendation;
                        return (
                          <div className="mt-1.5 space-y-1">
                            {specs && <p className="text-[11px] font-mono text-muted-foreground bg-muted/50 rounded px-1.5 py-0.5 inline-block">{specs}</p>}
                            {envs && <p className="text-[11px] text-muted-foreground">Entornos: {envs}</p>}
                            {cost > 0 && <p className="text-xs font-semibold text-foreground">~${cost}/mes</p>}
                            {p.cost_breakdown && <p className="text-[11px] text-muted-foreground">{p.cost_breakdown}</p>}
                            {warning && <p className="text-[11px] text-red-600 dark:text-red-400">{warning}</p>}
                            {reco && <p className="text-[11px] text-amber-600 dark:text-amber-400">💡 {reco}</p>}
                          </div>
                        );
                      })()}

                      {req.reviewer_email && (
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {req.status === "approved" || req.status === "executed" ? "✅" : req.status === "rejected" ? "❌" : "⏳"} {req.reviewer_name || req.reviewer_email}
                          {req.review_comment && ` — "${req.review_comment}"`}
                        </p>
                      )}

                      {/* Executed: show MR link (Requirement 7.3) */}
                      {req.status === "executed" && req.gitlab_mr_url && (
                        <a
                          href={req.gitlab_mr_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline mt-1"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Ver Merge Request
                        </a>
                      )}

                      {/* Execute failed: render Error_Persistido with code + step + suggestion + copy button (Req 5.7, 6.3, 10.2) */}
                      {req.status === "execute_failed" && (() => {
                        const err = req.error_message;
                        // Fallback (Req 10.2): if error_message is missing/empty (legacy row
                        // or persistence failed per Req 5.9), show a minimal notice with the
                        // status i18n string. Never throw client-side.
                        const hasStructuredError =
                          err &&
                          typeof err === "object" &&
                          typeof err.code === "string" &&
                          err.code.trim() !== "";
                        if (!hasStructuredError) {
                          return (
                            <div className="mt-2 flex items-center gap-1.5 text-xs text-red-600 dark:text-red-400">
                              <AlertTriangle className="h-3 w-3" />
                              <span>{t("infra.status.execute_failed", "Error en ejecución")}</span>
                            </div>
                          );
                        }
                        const suggestion = suggestionForCode(err.code);
                        return (
                          <div className="mt-2 rounded-lg border border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-3">
                            <div className="flex items-start gap-2">
                              <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400 shrink-0 mt-0.5" />
                              <div className="flex-1 min-w-0 space-y-1">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs font-semibold text-red-800 dark:text-red-300">
                                    {t("infra.requests.errorDetail", "Detalle del error")}
                                  </span>
                                  <Badge variant="outline" className="text-[10px] border-red-300 dark:border-red-700 text-red-700 dark:text-red-300">
                                    {err.code}
                                  </Badge>
                                  <Badge variant="outline" className="text-[10px] border-red-300 dark:border-red-700 text-red-700 dark:text-red-300">
                                    {t("infra.requests.errorStep", "Paso")}: {err.step}
                                  </Badge>
                                </div>
                                <p className="text-xs text-red-900 dark:text-red-200">{suggestion}</p>
                                {err.message && (
                                  <p className="text-[11px] font-mono text-red-800/80 dark:text-red-300/80 break-all">
                                    {err.message}
                                  </p>
                                )}
                                <button
                                  type="button"
                                  onClick={() => handleCopyErrorDetail(err)}
                                  className="mt-1 inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-md border border-red-300 dark:border-red-700 bg-white dark:bg-red-950/60 text-red-700 dark:text-red-300 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors"
                                >
                                  <Copy className="h-3 w-3" /> {t("infra.requests.copyDetail", "Copiar detalle")}
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })()}

                      {/* AI Conversation & Terraform Preview toggle */}
                      {(req.ai_conversation || req.terraform_preview) && (
                        <div className="mt-2">
                          <button
                            onClick={() =>
                              setExpandedRequestId((prev) =>
                                prev === req.id ? null : req.id
                              )
                            }
                            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {expandedRequestId === req.id ? (
                              <ChevronDown className="h-3 w-3" />
                            ) : (
                              <ChevronRight className="h-3 w-3" />
                            )}
                            <span>AI Details</span>
                          </button>
                          {expandedRequestId === req.id && (
                            <ConversationReview
                              conversation={req.ai_conversation || []}
                              terraformPreview={req.terraform_preview}
                            />
                          )}
                        </div>
                      )}

                      {/* Approve/Reject buttons. Normally the requester cannot approve
                          their own request, EXCEPT when they are the designated approver
                          of an access request — only possible for a one-person team's sole
                          approver (the form self-selects them; the backend authorises it). */}
                      {req.status === "pending" && (
                        (req.requestor_email.replace("@emefinpetcare.com", "@iskaypet.com") !== normalizedCurrentEmail && isApprover) ||
                        (req._type === "access" && req.approver_email && normalize(req.approver_email) === normalizedCurrentEmail)
                      ) && (
                        <div className="flex items-center gap-2 mt-3">
                          <input
                            type="text"
                            placeholder={t("infra.requests.commentPlaceholder")}
                            value={reviewingId === req.id ? comment : ""}
                            onChange={(e) => { setReviewingId(req.id); setComment(e.target.value); }}
                            className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-border bg-background text-foreground placeholder:text-muted-foreground"
                          />
                          <button
                            onClick={() => handleReview(req.id, "approve", req._type)}
                            disabled={reviewingId !== null && reviewingId !== req.id}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 transition-colors"
                          >
                            <Check className="h-3 w-3" /> {t("infra.requests.approve")}
                          </button>
                          <button
                            onClick={() => handleReview(req.id, "reject", req._type)}
                            disabled={reviewingId !== null && reviewingId !== req.id}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 transition-colors"
                          >
                            <X className="h-3 w-3" /> {t("infra.requests.reject")}
                          </button>
                        </div>
                      )}

                      {/* Cancel button for own pending requests */}
                      {req.status === "pending" && normalize(req.requestor_email) === normalizedCurrentEmail && (
                        <div className="mt-3">
                          <button
                            onClick={() => handleCancel(req.id, req._type)}
                            className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                          >
                            <Ban className="h-3 w-3" /> {t("infra.requests.cancel", "Cancelar")}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
