"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { Bot, Loader2, Send, User, Wrench, Sparkles } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type Role = "user" | "assistant";

interface ToolCall {
  name: string;
  input?: unknown;
  output?: unknown;
  errorMessage?: string;
}

interface ReportAttachment {
  downloadUrl: string;
  filename: string;
}

interface Message {
  id: string;
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  pending?: boolean;
  report?: ReportAttachment;
}

const SUGGESTIONS = [
  "¿Cuánto hemos gastado este mes?",
  "Top 5 cuentas con más coste en mayo",
  "Compara el gasto de mayo vs abril",
  "Forecast de los próximos 3 meses",
  "Servicios que más cuestan este mes",
  "Top 10 recursos más caros del trimestre",
];

const BECARIO_AVATAR = "/avatars/becario-sre.png";

interface FinOpsChatProps {
  /** When true the chat fills the parent container instead of using its own card height. */
  embedded?: boolean;
  /** Override the default suggestions shown when the conversation is empty. */
  suggestions?: string[];
  /** Optional context line shown in the header subtitle (e.g. "Cuentas: 2"). */
  contextHint?: string;
}

function formatToolInput(input: unknown): string {
  try {
    return JSON.stringify(input ?? {}, null, 0).slice(0, 200);
  } catch {
    return "";
  }
}

export function FinOpsChat({ embedded = false, suggestions, contextHint }: FinOpsChatProps = {}) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // Stable conversation id for this chat thread, so the backend can persist + recall it.
  const conversationIdRef = useRef<string>(
    `iskay-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  );

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  async function sendMessage(text: string) {
    const trimmed = text.trim();
    if (!trimmed || loading) return;

    const userMsg: Message = {
      id: `u-${Date.now()}`,
      role: "user",
      content: trimmed,
    };
    const placeholder: Message = {
      id: `a-${Date.now()}`,
      role: "assistant",
      content: "",
      pending: true,
    };

    const history = messages
      .filter((m) => !m.pending)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, userMsg, placeholder]);
    setInput("");
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/ai/finops-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: trimmed, history, conversationId: conversationIdRef.current }),
      });

      if (!response.ok || !response.body) {
        let errMsg = `HTTP ${response.status}`;
        try {
          const j = await response.json();
          errMsg = j?.error || errMsg;
        } catch { /* not JSON */ }
        throw new Error(errMsg);
      }

      // Stream the SSE response: paint text deltas live and show tool badges as they run.
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const toolCalls: ToolCall[] = [];
      let acc = "";       // accumulated assistant text
      let buffer = "";    // partial SSE buffer
      let report: ReportAttachment | undefined;

      const applyUpdate = () => {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === placeholder.id
              ? {
                  ...m,
                  content: acc,
                  pending: acc.length === 0,
                  toolCalls: [...toolCalls],
                  ...(report ? { report } : {}),
                }
              : m,
          ),
        );
      };

      const handleEvent = (payload: any) => {
        if (!payload || typeof payload !== "object") return;
        if (payload.type === "delta" && typeof payload.text === "string") {
          acc += payload.text;
          applyUpdate();
        } else if (payload.type === "tool" && payload.phase === "call") {
          toolCalls.push({ name: payload.name, input: payload.input });
          applyUpdate();
        } else if (payload.type === "tool" && payload.phase === "result") {
          const last = [...toolCalls].reverse().find((c) => c.name === payload.name && c.output === undefined && c.errorMessage === undefined);
          if (last) last.errorMessage = payload.errorMessage;
          applyUpdate();
        } else if (payload.type === "done") {
          if (payload.reply && !acc) acc = payload.reply;
          if (
            payload.report &&
            typeof payload.report.downloadUrl === "string" &&
            typeof payload.report.filename === "string"
          ) {
            report = {
              downloadUrl: payload.report.downloadUrl,
              filename: payload.report.filename,
            };
          }
          applyUpdate();
        } else if (payload.type === "error") {
          throw new Error(payload.error || "stream error");
        }
      };

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE frames are separated by a blank line.
        const frames = buffer.split("\n\n");
        buffer = frames.pop() || "";
        for (const frame of frames) {
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          try {
            handleEvent(JSON.parse(line.slice(6)));
          } catch { /* ignore malformed frame */ }
        }
      }

      // Finalise the placeholder (clear pending, keep accumulated text + tools).
      setMessages((prev) =>
        prev.map((m) =>
          m.id === placeholder.id
            ? {
                ...m,
                content: acc || "(sin respuesta)",
                pending: false,
                toolCalls,
                ...(report ? { report } : {}),
              }
            : m,
        ),
      );
    } catch (err: any) {
      const msg = err?.message || "Error desconocido";
      setError(msg);
      setMessages((prev) =>
        prev.map((m) =>
          m.id === placeholder.id
            ? { ...m, content: `❌ ${msg}`, pending: false }
            : m,
        ),
      );
    } finally {
      setLoading(false);
      inputRef.current?.focus();
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    void sendMessage(input);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  }

  return (
    <Card className={cn("flex flex-col overflow-hidden border-border/60", embedded ? "h-full" : "h-[640px]")}>
      <div className="flex items-center justify-between border-b border-border/60 bg-gradient-to-r from-primary/5 via-violet-500/5 to-transparent px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="relative h-10 w-10 overflow-hidden rounded-full ring-2 ring-primary/30">
            <Image src={BECARIO_AVATAR} alt="Iskay" fill className="object-cover" sizes="40px" />
          </div>
          <div>
            <div className="text-sm font-semibold text-foreground">Iskay · FinOps</div>
            <div className="text-xs text-muted-foreground">
              {contextHint || "CUR · Cost Explorer · OpenCost · Inventario"}
            </div>
          </div>
        </div>
        <Badge variant="outline" className="gap-1 text-[10px] uppercase tracking-wider">
          <Bot className="h-3 w-3" />
          Sonnet 4
        </Badge>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-4 py-8 text-center">
            <div className="relative h-16 w-16 overflow-hidden rounded-full ring-2 ring-primary/30">
              <Image src={BECARIO_AVATAR} alt="Iskay" fill className="object-cover" sizes="64px" />
            </div>
            <div>
              <div className="text-sm font-semibold text-foreground">
                Hola, soy Iskay. Pregúntame por coste AWS, EKS o inventario.
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                Consulto CUR, Cost Explorer, OpenCost (EKS) e inventario AWS por ti.
              </div>
            </div>
            <div className="mt-2 grid w-full max-w-xl gap-2 sm:grid-cols-2">
              {(suggestions || SUGGESTIONS).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => sendMessage(s)}
                  className="rounded-lg border border-border/60 bg-card px-3 py-2 text-left text-xs text-foreground transition hover:border-foreground/30 hover:bg-muted/40"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="space-y-4">
          {messages.map((message) => (
            <MessageBubble key={message.id} message={message} />
          ))}
        </div>
      </div>

      {error && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={handleSubmit} className="border-t border-border/60 bg-background px-3 py-3">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={loading}
            rows={2}
            placeholder="Escribe tu pregunta sobre el coste AWS..."
            className="flex-1 resize-none rounded-lg border border-border/60 bg-card px-3 py-2 text-sm focus:border-foreground/40 focus:outline-none focus:ring-2 focus:ring-primary/20 disabled:opacity-60"
          />
          <Button type="submit" disabled={loading || !input.trim()} className="h-auto self-stretch px-4">
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
        <div className="mt-1 px-1 text-[11px] text-muted-foreground">
          Enter para enviar · Shift+Enter para salto de línea
        </div>
      </form>
    </Card>
  );
}

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex gap-3", isUser && "flex-row-reverse")}>
      {isUser ? (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
          <User className="h-4 w-4" />
        </div>
      ) : (
        <div className="relative h-8 w-8 shrink-0 overflow-hidden rounded-lg ring-1 ring-primary/20">
          <Image src={BECARIO_AVATAR} alt="" fill className="object-cover" sizes="32px" />
        </div>
      )}
      <div className={cn("flex max-w-[85%] flex-col gap-2", isUser && "items-end")}>
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {message.toolCalls.map((call, idx) => (
              <Badge
                key={`${call.name}-${idx}`}
                variant="outline"
                className={cn(
                  "gap-1 text-[10px] font-mono",
                  call.errorMessage ? "border-destructive/40 text-destructive" : "border-info/40 text-info",
                )}
                title={formatToolInput(call.input)}
              >
                <Wrench className="h-3 w-3" />
                {call.name}
              </Badge>
            ))}
          </div>
        )}
        <div
          className={cn(
            "rounded-lg px-3 py-2 text-sm leading-relaxed",
            isUser
              ? "bg-primary text-primary-foreground whitespace-pre-wrap"
              : "bg-muted/40 text-foreground",
            message.pending && "animate-pulse",
          )}
        >
          {message.pending && !message.content ? (
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              <Loader2 className="h-3 w-3 animate-spin" />
              Consultando datos...
            </span>
          ) : isUser ? (
            message.content
          ) : (
            <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1.5 prose-headings:my-2 prose-headings:font-semibold prose-h1:text-base prose-h2:text-sm prose-h3:text-sm prose-h4:text-sm prose-ul:my-1.5 prose-ol:my-1.5 prose-li:my-0.5 prose-table:my-2 prose-table:text-xs prose-th:px-2 prose-th:py-1 prose-td:px-2 prose-td:py-1 prose-th:bg-muted prose-th:font-semibold prose-th:text-left prose-table:border prose-table:border-border prose-th:border prose-th:border-border prose-td:border prose-td:border-border prose-hr:my-3 prose-strong:text-foreground prose-code:text-xs prose-code:bg-muted prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
            </div>
          )}
        </div>
        {!isUser && message.report && !message.pending && (
          <Button
            asChild
            variant="outline"
            size="sm"
            className="h-8 gap-1.5 self-start border-primary/40 bg-primary/5 text-xs font-medium text-primary hover:bg-primary/10 hover:text-primary"
          >
            <a
              href={message.report.downloadUrl}
              download={message.report.filename}
              target="_blank"
              rel="noopener noreferrer"
            >
              <span aria-hidden="true">⬇️</span>
              Descargar Excel
            </a>
          </Button>
        )}
      </div>
    </div>
  );
}
