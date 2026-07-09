"use client";

import { useState, useCallback } from "react";
import { Home, Cpu, CheckCircle2, XCircle, Loader2 } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ChatPanel } from "@/components/infra-assistant/chat-panel";
import { TerraformPreviewPanel } from "@/components/infra-assistant/terraform-preview";
import type { TerraformPreview, ConversationMessage } from "@/lib/infra-agent";

// ─── Types ────────────────────────────────────────────────────────────────────

interface Approver {
  email: string;
  name: string;
}

interface InfraAssistantClientProps {
  teams: string[];
  approvers: Approver[];
  userEmail: string;
}

type SubmitState = "idle" | "submitting" | "success" | "error";

// ─── InfraAssistantClient ─────────────────────────────────────────────────────

export function InfraAssistantClient({
  teams,
  approvers,
  userEmail,
}: InfraAssistantClientProps) {
  const [selectedTeam, setSelectedTeam] = useState<string>(teams[0] ?? "");
  const [selectedApprover, setSelectedApprover] = useState<string>(
    approvers[0]?.email ?? ""
  );

  // Preview state — set when onPreviewReady fires
  const [preview, setPreview] = useState<TerraformPreview | null>(null);

  // Submit-ready state — set when onSubmitReady fires
  const [submitPayload, setSubmitPayload] = useState<{
    conversationId: string;
    conversation: ConversationMessage[];
  } | null>(null);

  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submittedId, setSubmittedId] = useState<number | null>(null);

  // ── Callbacks from ChatPanel ───────────────────────────────────────────────

  const handlePreviewReady = useCallback((p: TerraformPreview) => {
    setPreview(p);
  }, []);

  const handleSubmitReady = useCallback(
    (conversationId: string, conversation: ConversationMessage[]) => {
      setSubmitPayload({ conversationId, conversation });
    },
    []
  );

  // ── Submit for approval ────────────────────────────────────────────────────

  const handleSubmit = useCallback(async () => {
    if (!submitPayload || !preview) return;

    setSubmitState("submitting");
    setSubmitError(null);

    try {
      const res = await fetch("/api/infra-assistant/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          conversationId: submitPayload.conversationId,
          conversation: submitPayload.conversation,
          terraformPreview: preview,
          team: selectedTeam,
          approver: selectedApprover,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }

      const data = await res.json();
      setSubmittedId(data.id ?? null);
      setSubmitState("success");
    } catch (err) {
      setSubmitError(
        err instanceof Error ? err.message : "Unexpected error. Please try again."
      );
      setSubmitState("error");
    }
  }, [submitPayload, preview, selectedTeam, selectedApprover]);

  // ── "Ask to change" — just focus the chat input (ChatPanel handles it) ─────
  const handleEdit = useCallback(() => {
    // The user can type a follow-up in the chat; no extra action needed here
  }, []);

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-screen overflow-hidden">
      {/* ── Header ── */}
      <div className="shrink-0 border-b border-border px-6 py-3">
        <div className="flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2">
              <Home className="w-4 h-4" />
              Home
            </Button>
          </Link>
          <span className="text-muted-foreground">/</span>
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-blue-500" />
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              AI Infra Assistant
            </h1>
            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-600 font-medium">
              BETA
            </span>
          </div>
        </div>
        <p className="text-sm text-muted-foreground mt-0.5">
          Describe the infrastructure you need — the AI will read your repo and generate Terraform.
        </p>
      </div>

      {/* ── Selectors bar ── */}
      <div className="shrink-0 border-b border-border px-6 py-3 flex flex-wrap items-center gap-4">
        {/* Team selector */}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground whitespace-nowrap">
            Team
          </label>
          <Select value={selectedTeam} onValueChange={setSelectedTeam}>
            <SelectTrigger className="w-40">
              <SelectValue placeholder="Select team" />
            </SelectTrigger>
            <SelectContent>
              {teams.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Approver selector */}
        <div className="flex items-center gap-2">
          <label className="text-sm font-medium text-foreground whitespace-nowrap">
            Approver
          </label>
          <Select value={selectedApprover} onValueChange={setSelectedApprover}>
            <SelectTrigger className="w-52">
              <SelectValue placeholder="Select approver" />
            </SelectTrigger>
            <SelectContent>
              {approvers.map((a) => (
                <SelectItem key={a.email} value={a.email}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {/* Submission status feedback */}
        {submitState === "success" && (
          <div className="flex items-center gap-1.5 text-sm text-emerald-600 ml-auto">
            <CheckCircle2 className="w-4 h-4" />
            Request submitted{submittedId ? ` (#${submittedId})` : ""}. Awaiting approval.
          </div>
        )}
        {submitState === "error" && (
          <div className="flex items-center gap-1.5 text-sm text-destructive ml-auto">
            <XCircle className="w-4 h-4" />
            {submitError}
          </div>
        )}
      </div>

      {/* ── Split pane ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Chat */}
        <div className="flex-1 min-w-0 border-r border-border overflow-hidden">
          {selectedTeam ? (
            <ChatPanel
              team={selectedTeam}
              onPreviewReady={handlePreviewReady}
              onSubmitReady={handleSubmitReady}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              Select a team to start.
            </div>
          )}
        </div>

        {/* Right: Terraform preview */}
        <div className="w-[480px] shrink-0 overflow-auto p-4">
          {preview ? (
            <>
              <TerraformPreviewPanel
                preview={preview}
                onApprove={handleSubmit}
                onEdit={handleEdit}
                readOnly={submitState === "success"}
              />
              {/* Submit button below the preview when submit is ready but not yet submitted */}
              {submitPayload && submitState !== "success" && (
                <div className="mt-3">
                  <Button
                    className="w-full gap-2"
                    onClick={handleSubmit}
                    disabled={submitState === "submitting"}
                  >
                    {submitState === "submitting" ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Submitting...
                      </>
                    ) : (
                      <>
                        <CheckCircle2 className="w-4 h-4" />
                        Submit for approval
                      </>
                    )}
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground gap-2">
              <Cpu className="w-8 h-8 opacity-30" />
              <p className="text-sm">
                The Terraform preview will appear here once the AI generates it.
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
