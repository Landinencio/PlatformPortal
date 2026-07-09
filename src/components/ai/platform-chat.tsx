"use client";

import { useState, useRef, useEffect } from "react";
import { useSession } from "next-auth/react";
import { Send, Loader2, Sparkles, Trash2 } from "lucide-react";
import Image from "next/image";
import ReactMarkdown from "react-markdown";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface Message {
  role: "user" | "assistant";
  content: string;
  toolUsed?: string;
  timestamp: Date;
}

const ROLE_AVATARS: Record<string, string> = {
  admin: "/avatars/admin.png",
  editor: "/avatars/editor.png",
  viewer: "/avatars/viewer.png",
};

const BECARIO_AVATAR = "/avatars/becario-sre.png";

const EXAMPLE_QUESTIONS = [
  "¿Cómo está el namespace oms en dp-prod?",
  "¿Cuáles son las métricas DORA de los últimos 7 días?",
  "Busca proyectos de GitLab que contengan 'platform'",
  "¿Qué namespaces tienen más pods en dp-prod?",
  "¿Cuáles son los pipelines fallidos del proyecto platform/backend?",
  "¿Qué proyectos tienen peor Change Failure Rate?",
];

export function PlatformChat() {
  const { data: session } = useSession();
  const firstName = session?.user?.name?.split(" ")[0] || "usuario";
  const userRole = (session?.user as any)?.appRole || "externos";
  const isAdmin = userRole === "admin";

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [greeted, setGreeted] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Greeting on first open
  useEffect(() => {
    if (!greeted && session?.user) {
      const greeting: Message = {
        role: "assistant",
        content: `¡Hola ${firstName}! 👋 Soy El Becario, tu asistente de plataforma. Puedo consultar AWS, Kubernetes, GitLab, métricas DORA y más. ¿En qué te ayudo?`,
        timestamp: new Date(),
      };
      setMessages([greeting]);
      setGreeted(true);
    }
  }, [session, greeted, firstName]);

  const sendMessage = async (text?: string) => {
    const messageText = text || input.trim();
    if (!messageText || loading) return;

    const userMessage: Message = {
      role: "user",
      content: messageText,
      timestamp: new Date(),
    };

    setMessages((prev) => [...prev, userMessage]);
    setInput("");
    setLoading(true);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 120000); // 2 min timeout

    try {
      const res = await fetch("/api/ai/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: [...messages, userMessage].map((m) => ({
            role: m.role,
            content: m.content,
          })),
          userRole,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Error en la respuesta");
      }

      const data = await res.json();

      const assistantMessage: Message = {
        role: "assistant",
        content: data.response,
        toolUsed: data.toolsUsed?.join(", "),
        timestamp: new Date(),
      };

      setMessages((prev) => [...prev, assistantMessage]);
    } catch (error) {
      clearTimeout(timeoutId);
      let errorMsg = "Error desconocido";
      if (error instanceof Error) {
        if (error.name === "AbortError") {
          errorMsg = "La petición tardó demasiado. Intenta con una pregunta más específica.";
        } else {
          errorMsg = error.message;
        }
      }
      const errorMessage: Message = {
        role: "assistant",
        content: `Error: ${errorMsg}`,
        timestamp: new Date(),
      };
      setMessages((prev) => [...prev, errorMessage]);
    } finally {
      setLoading(false);
    }
  };

  const clearChat = () => {
    setMessages([]);
  };

  return (
    <div className="flex flex-col h-[calc(100vh-12rem)]">
      {/* Messages area */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="w-20 h-20 rounded-full overflow-hidden mb-4 ring-2 ring-blue-500/30">
              <Image src={BECARIO_AVATAR} alt="El Becario" width={80} height={80} className="object-cover" unoptimized />
            </div>
            <h2 className="text-xl font-semibold mb-2">
              ¡Hola {firstName}! 👋
            </h2>
            <p className="text-muted-foreground mb-2 max-w-md">
              Soy El Becario, tu asistente de plataforma. Pregúntame sobre namespaces, pods, GitLab, métricas DORA o AWS.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2 max-w-2xl">
              {EXAMPLE_QUESTIONS.map((q, i) => (
                <button
                  key={i}
                  onClick={() => sendMessage(q)}
                  className="text-left p-3 rounded-lg border border-border/50 hover:border-primary/50 hover:bg-muted/50 transition-colors text-sm"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex gap-3 ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                {msg.role === "assistant" && (
                  <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 ring-1 ring-blue-500/30">
                    <Image src={BECARIO_AVATAR} alt="El Becario" width={32} height={32} className="object-cover" unoptimized />
                  </div>
                )}
                <Card
                  className={`max-w-[80%] p-3 ${
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/50"
                  }`}
                >
                  {msg.toolUsed && (
                    <div className="text-xs text-muted-foreground mb-2 flex items-center gap-1">
                      <Sparkles className="w-3 h-3" />
                      Usó: {msg.toolUsed}
                    </div>
                  )}
                  <div className="text-sm prose prose-sm dark:prose-invert max-w-none prose-p:my-1 prose-headings:my-2 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-pre:my-2 prose-code:text-xs prose-code:bg-black/10 prose-code:dark:bg-white/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded">
                    <ReactMarkdown>{msg.content}</ReactMarkdown>
                  </div>
                </Card>
                {msg.role === "user" && (
                  <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 ring-1 ring-primary/30">
                    <Image src={ROLE_AVATARS[userRole] || ROLE_AVATARS.viewer} alt={userRole} width={32} height={32} className="object-cover" unoptimized />
                  </div>
                )}
              </div>
            ))}
            {loading && (
              <div className="flex gap-3">
                <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0 ring-1 ring-blue-500/30">
                  <Image src={BECARIO_AVATAR} alt="El Becario" width={32} height={32} className="object-cover" unoptimized />
                </div>
                <Card className="p-3 bg-muted/50">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Pensando...
                  </div>
                </Card>
              </div>
            )}
            <div ref={messagesEndRef} />
          </>
        )}
      </div>

      {/* Input area */}
      <div className="border-t border-border p-4">
        <div className="flex gap-2">
          {messages.length > 0 && (
            <Button variant="outline" size="icon" onClick={clearChat} title="Limpiar chat">
              <Trash2 className="w-4 h-4" />
            </Button>
          )}
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && sendMessage()}
            placeholder="Pregunta sobre K8s, GitLab, métricas DORA, AWS..."
            className="flex-1 px-4 py-2 rounded-lg border border-border bg-background focus:outline-none focus:ring-2 focus:ring-primary/50"
            disabled={loading}
          />
          <Button onClick={() => sendMessage()} disabled={loading || !input.trim()}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}
