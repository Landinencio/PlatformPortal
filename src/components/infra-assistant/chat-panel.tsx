"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Send, Loader2, ChevronDown, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { TerraformPreview, ConversationMessage } from "@/lib/infra-agent";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ChatPanelProps {
  team: string;
  onPreviewReady: (preview: TerraformPreview) => void;
  onSubmitReady: (conversationId: string, conversation: ConversationMessage[]) => void;
}

type MessageRole = "user" | "assistant" | "tool_call";

interface UIMessage {
  id: string;
  role: MessageRole;
  content: string;
  toolName?: string;
  isStreaming?: boolean;
}

// ─── ToolCallMessage ──────────────────────────────────────────────────────────

function ToolCallMessage({ toolName }: { toolName: string }) {
  const [open, setOpen] = useState(false);
  return (
    <button
      onClick={() => setOpen((v) => !v)}
      className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors py-1"
    >
      {open ? (
        <ChevronDown className="w-3 h-3 shrink-0" />
      ) : (
        <ChevronRight className="w-3 h-3 shrink-0" />
      )}
      <span>🔍 Reading repo...</span>
      {open && (
        <span className="ml-1 font-mono bg-muted px-1.5 py-0.5 rounded text-[11px]">
          {toolName}
        </span>
      )}
    </button>
  );
}

// ─── ChatPanel ────────────────────────────────────────────────────────────────

export function ChatPanel({ team, onPreviewReady, onSubmitReady }: ChatPanelProps) {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [input, setInput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [currentAssistantMessage, setCurrentAssistantMessage] = useState("");

  // Full conversation history for the API (user + assistant only)
  const historyRef = useRef<ConversationMessage[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  const sendMessage = useCallback(
    async (text?: string) => {
      const messageText = (text ?? input).trim();
      if (!messageText || isStreaming) return;

      setInput("");
      setIsStreaming(true);

      // Add user message to UI
      const userMsgId = `user-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: userMsgId, role: "user", content: messageText },
      ]);

      // Track user message in history
      const userHistoryMsg: ConversationMessage = {
        role: "user",
        content: messageText,
        timestamp: new Date().toISOString(),
      };
      historyRef.current = [...historyRef.current, userHistoryMsg];

      // Placeholder for the streaming assistant message
      const assistantMsgId = `assistant-${Date.now()}`;
      setMessages((prev) => [
        ...prev,
        { id: assistantMsgId, role: "assistant", content: "", isStreaming: true },
      ]);
      setCurrentAssistantMessage("");

      let accumulatedReply = "";

      try {
        const response = await fetch("/api/infra-assistant/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: messageText,
            team,
            conversationId,
            history: historyRef.current.slice(0, -1), // exclude the just-added user msg
          }),
        });

        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const line = part.trim();
            if (!line.startsWith("data: ")) continue;

            let event: Record<string, unknown>;
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              continue;
            }

            const type = event.type as string;

            if (type === "token") {
              const token = (event.content as string) ?? "";
              accumulatedReply += token;
              setCurrentAssistantMessage(accumulatedReply);
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, content: accumulatedReply }
                    : m
                )
              );
            } else if (type === "tool_call") {
              const toolName = (event.tool as string) ?? "unknown";
              const toolMsgId = `tool-${Date.now()}-${Math.random()}`;
              setMessages((prev) => [
                ...prev.filter((m) => m.id !== assistantMsgId),
                { id: toolMsgId, role: "tool_call", content: "", toolName },
                { id: assistantMsgId, role: "assistant", content: accumulatedReply, isStreaming: true },
              ]);
            } else if (type === "preview") {
              const preview = event.preview as TerraformPreview;
              if (preview) {
                onPreviewReady(preview);
              }
            } else if (type === "done") {
              const doneConvId = event.conversationId as string;
              const finalReply = (event.reply as string) ?? accumulatedReply;

              if (doneConvId) setConversationId(doneConvId);

              // Finalize the assistant message
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? { ...m, content: finalReply || accumulatedReply, isStreaming: false }
                    : m
                )
              );

              // Update history with assistant reply
              const assistantHistoryMsg: ConversationMessage = {
                role: "assistant",
                content: finalReply || accumulatedReply,
                timestamp: new Date().toISOString(),
              };
              historyRef.current = [...historyRef.current, assistantHistoryMsg];

              // Notify parent that submit is ready
              if (doneConvId) {
                onSubmitReady(doneConvId, historyRef.current);
              }
            }
          }
        }
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : "Unexpected error. Please try again.";
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId
              ? { ...m, content: `Error: ${errMsg}`, isStreaming: false }
              : m
          )
        );
      } finally {
        setIsStreaming(false);
        setCurrentAssistantMessage("");
        inputRef.current?.focus();
      }
    },
    [input, isStreaming, team, conversationId, onPreviewReady, onSubmitReady]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center text-muted-foreground">
            <p className="text-sm">
              Describe the infrastructure you need and the AI will read your team&apos;s repo to generate Terraform.
            </p>
            <p className="text-xs mt-2 opacity-60">Team: {team}</p>
          </div>
        )}

        {messages.map((msg) => {
          if (msg.role === "tool_call") {
            return (
              <div key={msg.id} className="flex justify-start pl-1">
                <ToolCallMessage toolName={msg.toolName ?? "tool"} />
              </div>
            );
          }

          if (msg.role === "user") {
            return (
              <div key={msg.id} className="flex justify-end">
                <Card className="max-w-[75%] px-3 py-2 bg-primary text-primary-foreground text-sm">
                  {msg.content}
                </Card>
              </div>
            );
          }

          // assistant
          return (
            <div key={msg.id} className="flex justify-start">
              <Card
                className={cn(
                  "max-w-[85%] px-3 py-2 bg-muted/50 text-sm",
                  msg.isStreaming && "border-primary/30"
                )}
              >
                {msg.content ? (
                  <div className="prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-li:my-0 prose-pre:my-2 prose-code:text-xs prose-code:bg-black/10 dark:prose-code:bg-white/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    <span className="text-xs">Thinking...</span>
                  </div>
                )}
              </Card>
            </div>
          );
        })}

        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="border-t border-border p-3">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Describe the infrastructure you need..."
            className="flex-1 px-3 py-2 text-sm rounded-md border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
            disabled={isStreaming}
          />
          <Button
            size="sm"
            onClick={() => sendMessage()}
            disabled={isStreaming || !input.trim()}
          >
            {isStreaming ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Send className="w-4 h-4" />
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
