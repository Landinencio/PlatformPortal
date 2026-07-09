"use client";

import { useState, useRef, useCallback } from "react";
import { FileText, MessageSquare, X, Send, ImagePlus, CheckSquare } from "lucide-react";
import { cn } from "@/lib/utils";

const FEEDBACK_CATEGORIES = [
  { value: "datos-incorrectos", label: "Datos incorrectos / en 0" },
  { value: "falta-proyecto", label: "Falta un proyecto" },
  { value: "metrica-confusa", label: "Métrica confusa" },
  { value: "propuesta-mejora", label: "Propuesta de mejora" },
  { value: "otro", label: "Otro" },
];

const CHECKLIST_ITEMS: Record<string, Array<{ id: string; label: string }>> = {
  "datos-incorrectos": [
    { id: "has-deploys", label: "He verificado que el proyecto tiene deploys recientes a producción" },
    { id: "correct-project", label: "He seleccionado el proyecto correcto en los filtros" },
    { id: "time-range", label: "He ampliado la ventana temporal (90d o más)" },
  ],
  "falta-proyecto": [
    { id: "has-pipeline", label: "El proyecto tiene pipeline de CI/CD configurado" },
    { id: "has-deploy-job", label: "El pipeline tiene un job llamado deploy_prod o deploy-production" },
    { id: "recent-activity", label: "El proyecto ha tenido actividad en los últimos 30 días" },
  ],
};

interface AttachedFile {
  id: string;
  file: File;
  preview: string;
}

export function MetricsActions() {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState("otro");
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const currentChecklist = CHECKLIST_ITEMS[category] || [];
  const checksCompleted = currentChecklist.filter((c) => checks[c.id]).length;
  const checklistValid = currentChecklist.length === 0 || checksCompleted >= currentChecklist.length;

  const addFiles = useCallback((files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) continue;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const preview = URL.createObjectURL(file);
      setAttachments((prev) => [...prev, { id, file, preview }]);
    }
  }, []);

  const removeAttachment = (id: string) => {
    setAttachments((prev) => {
      const item = prev.find((a) => a.id === id);
      if (item) URL.revokeObjectURL(item.preview);
      return prev.filter((a) => a.id !== id);
    });
  };

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const imageFiles: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    if (imageFiles.length > 0) {
      e.preventDefault();
      addFiles(imageFiles);
    }
  }, [addFiles]);

  const handleSubmitFeedback = async () => {
    if (!message.trim() || message.trim().length < 5) return;
    setSending(true);
    try {
      // Build structured message with checklist results
      let fullMessage = message.trim();
      if (currentChecklist.length > 0) {
        const checkResults = currentChecklist
          .map((c) => `${checks[c.id] ? "✅" : "❌"} ${c.label}`)
          .join("\n");
        fullMessage = `${fullMessage}\n\n--- Verificaciones ---\n${checkResults}`;
      }

      if (attachments.length > 0) {
        // Use FormData for file uploads
        const formData = new FormData();
        formData.append("message", fullMessage);
        formData.append("category", category);
        for (const att of attachments) {
          formData.append("attachments", att.file);
        }
        const res = await fetch("/api/metrics/feedback", {
          method: "POST",
          body: formData,
        });
        if (res.ok) {
          setSent(true);
          setTimeout(() => { setFeedbackOpen(false); setSent(false); setMessage(""); setAttachments([]); setChecks({}); }, 2000);
        }
      } else {
        const res = await fetch("/api/metrics/feedback", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message: fullMessage, category }),
        });
        if (res.ok) {
          setSent(true);
          setTimeout(() => { setFeedbackOpen(false); setSent(false); setMessage(""); setChecks({}); }, 2000);
        }
      }
    } catch {} finally {
      setSending(false);
    }
  };

  return (
    <>
      {/* Action buttons */}
      <a
        href="/docs/metricas-dora-metodologia.html"
        target="_blank"
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
      >
        <FileText className="h-3.5 w-3.5" />
        Metodología
      </a>
      <button
        onClick={() => setFeedbackOpen(true)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-border text-muted-foreground hover:bg-secondary/60 hover:text-foreground transition-colors"
      >
        <MessageSquare className="h-3.5 w-3.5" />
        Feedback
      </button>

      {/* Feedback modal */}
      {feedbackOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={() => setFeedbackOpen(false)}>
          <div className="bg-card border border-border rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 space-y-4 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-foreground">Feedback sobre métricas</h3>
              <button onClick={() => setFeedbackOpen(false)} className="p-1 rounded-lg text-muted-foreground hover:text-foreground">
                <X className="h-4 w-4" />
              </button>
            </div>

            {sent ? (
              <div className="py-8 text-center">
                <p className="text-green-600 font-medium">✅ Feedback enviado correctamente</p>
                <p className="text-xs text-muted-foreground mt-1">Se ha creado un ticket y notificado al equipo.</p>
              </div>
            ) : (
              <>
                {/* Category */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">¿Qué ocurre?</label>
                  <select
                    value={category}
                    onChange={(e) => { setCategory(e.target.value); setChecks({}); }}
                    className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
                  >
                    {FEEDBACK_CATEGORIES.map((c) => (
                      <option key={c.value} value={c.value}>{c.label}</option>
                    ))}
                  </select>
                </div>

                {/* Guided checklist */}
                {currentChecklist.length > 0 && (
                  <div className="space-y-2">
                    <label className="text-sm font-medium text-foreground flex items-center gap-1.5">
                      <CheckSquare className="h-3.5 w-3.5" />
                      Antes de enviar, verifica
                    </label>
                    <div className="space-y-1.5 rounded-lg border border-border p-3 bg-muted/20">
                      {currentChecklist.map((check) => (
                        <label
                          key={check.id}
                          className={cn(
                            "flex items-start gap-2.5 rounded-md px-2.5 py-2 cursor-pointer transition-colors text-sm",
                            checks[check.id] ? "bg-green-50 dark:bg-green-950/30" : "hover:bg-secondary/60"
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={!!checks[check.id]}
                            onChange={() => setChecks((prev) => ({ ...prev, [check.id]: !prev[check.id] }))}
                            className="mt-0.5 rounded border-border"
                          />
                          <span className="text-xs leading-relaxed">{check.label}</span>
                        </label>
                      ))}
                    </div>
                    {!checklistValid && (
                      <p className="text-[11px] text-amber-600">Completa todas las verificaciones para poder enviar.</p>
                    )}
                  </div>
                )}

                {/* Message */}
                <div className="space-y-2">
                  <label className="text-sm font-medium text-foreground">Descripción</label>
                  <textarea
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onPaste={handlePaste}
                    placeholder="Describe lo que ves, qué proyecto es, qué esperabas ver... (puedes pegar capturas con Ctrl+V)"
                    className="w-full min-h-[100px] rounded-md border border-border bg-background px-3 py-2 text-sm resize-y focus:outline-none focus:ring-2 focus:ring-primary/50"
                  />
                </div>

                {/* Attachments */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-foreground">Capturas</label>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:text-primary/80 font-medium"
                    >
                      <ImagePlus className="h-3 w-3" />
                      Añadir imagen
                    </button>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      className="hidden"
                      onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }}
                    />
                  </div>
                  {attachments.length > 0 && (
                    <div className="flex gap-2 flex-wrap">
                      {attachments.map((att) => (
                        <div key={att.id} className="relative group w-16 h-16 rounded-md border overflow-hidden">
                          <img src={att.preview} alt="" className="w-full h-full object-cover" />
                          <button
                            type="button"
                            onClick={() => removeAttachment(att.id)}
                            className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Submit */}
                <button
                  onClick={handleSubmitFeedback}
                  disabled={sending || message.trim().length < 5 || !checklistValid}
                  className={cn(
                    "w-full flex items-center justify-center gap-2 rounded-md px-4 py-2.5 text-sm font-medium text-white transition-colors",
                    message.trim().length >= 5 && !sending && checklistValid
                      ? "bg-primary hover:bg-primary/90"
                      : "bg-primary/50 cursor-not-allowed"
                  )}
                >
                  <Send className="h-4 w-4" />
                  {sending ? "Enviando..." : "Enviar feedback"}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
