"use client";

import { useState, useRef, useCallback } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BUSINESS_TEAMS, BUSINESS_TEAM_LABELS } from "@/lib/team-approvers";
import { AlertTriangle, ImagePlus, X, CheckSquare } from "lucide-react";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { MyTicketsList } from "@/components/tickets/my-tickets-list";

interface AttachedFile {
  id: string;
  file: File;
  preview: string;
}

const INVESTIGATION_CHECKS = [
  { id: "logs", label: "He revisado los logs del pod/servicio" },
  { id: "deploy", label: "He comprobado que no hay deploy reciente que lo cause" },
  { id: "code_vs_infra", label: "He verificado que no es un error de código (4xx vs 5xx)" },
  { id: "other_env", label: "He probado en otro entorno (dev/uat) y funciona correctamente" },
] as const;

const MIN_CHECKS_REQUIRED = 2;

export default function IncidentsPage() {
  const { data: session } = useSession();
  const [serviceName, setServiceName] = useState("");
  const [sinceDatetime, setSinceDatetime] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("media");
  const [businessTeam, setBusinessTeam] = useState("");
  const [impact, setImpact] = useState("");
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ key: string; url: string } | null>(null);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const checksCompleted = Object.values(checks).filter(Boolean).length;
  const checksValid = checksCompleted >= MIN_CHECKS_REQUIRED;

  const toggleCheck = (id: string) => {
    setChecks((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const addFiles = useCallback((files: FileList | File[]) => {
    const newAttachments: AttachedFile[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > 10 * 1024 * 1024) continue;
      const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const preview = URL.createObjectURL(file);
      newAttachments.push({ id, file, preview });
    }
    setAttachments((prev) => [...prev, ...newAttachments]);
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

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer.files.length > 0) {
      addFiles(e.dataTransfer.files);
    }
  }, [addFiles]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };

  const isFormValid = () => {
    return serviceName && title && description && businessTeam && impact && checksValid;
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isFormValid()) return;
    setLoading(true);
    setError("");
    setResult(null);

    // Build structured description
    const checkedItems = INVESTIGATION_CHECKS
      .filter((c) => checks[c.id])
      .map((c) => `✅ ${c.label}`)
      .join("\n");
    const uncheckedItems = INVESTIGATION_CHECKS
      .filter((c) => !checks[c.id])
      .map((c) => `❌ ${c.label}`)
      .join("\n");

    const structuredDescription = [
      `Servicio afectado: ${serviceName}`,
      sinceDatetime ? `Desde: ${sinceDatetime}` : "",
      `Impacto: ${impact}`,
      "",
      "--- Investigación previa ---",
      checkedItems,
      uncheckedItems,
      "",
      "--- Descripción del error ---",
      description,
    ].filter(Boolean).join("\n");

    try {
      const formData = new FormData();
      formData.append("type", "incident");
      formData.append("title", `[${serviceName}] ${title}`);
      formData.append("description", structuredDescription);
      formData.append("priority", priority);
      formData.append("businessTeam", businessTeam);
      for (const att of attachments) {
        formData.append("attachments", att.file);
      }

      const res = await fetch("/api/jira/create-ticket", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Error creating ticket");
      setResult({ key: data.key, url: data.url });
      setServiceName("");
      setSinceDatetime("");
      setTitle("");
      setDescription("");
      setImpact("");
      setChecks({});
      setAttachments([]);
    } catch (err: any) {
      setError(err.message || "Error inesperado");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Incidencias</h1>
      </div>
      <p className="text-muted-foreground mb-8">
        Reporta fallos en infraestructura o servicios. Antes de abrir el ticket, verifica que el problema no es de código.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Nueva incidencia</CardTitle>
          <CardDescription>
            Completa la investigación previa para que SRE pueda actuar rápidamente.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Team */}
            <div className="space-y-2">
              <Label>Equipo</Label>
              <Select value={businessTeam} onValueChange={setBusinessTeam}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecciona equipo" />
                </SelectTrigger>
                <SelectContent>
                  {BUSINESS_TEAMS.map((team) => (
                    <SelectItem key={team} value={team}>
                      {BUSINESS_TEAM_LABELS[team]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Service name */}
            <div className="space-y-2">
              <Label>Servicio / Microservicio afectado</Label>
              <Input
                placeholder="ej: basket-bff, loyalty-api, payments-service..."
                value={serviceName}
                onChange={(e) => setServiceName(e.target.value)}
                required
              />
            </div>

            {/* Since when */}
            <div className="space-y-2">
              <Label>¿Desde cuándo ocurre? (aproximado)</Label>
              <Input
                type="datetime-local"
                value={sinceDatetime}
                onChange={(e) => setSinceDatetime(e.target.value)}
              />
            </div>

            {/* Impact */}
            <div className="space-y-2">
              <Label>Impacto</Label>
              <Select value={impact} onValueChange={setImpact}>
                <SelectTrigger>
                  <SelectValue placeholder="¿Cuál es el impacto?" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="produccion_caida">🔴 Producción caída (servicio inaccesible)</SelectItem>
                  <SelectItem value="degradacion">🟡 Degradación (funciona pero con errores/lentitud)</SelectItem>
                  <SelectItem value="solo_desarrollo">🟢 Solo afecta a desarrollo/UAT</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {/* Investigation checklist */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-2">
                  <CheckSquare className="h-4 w-4" />
                  Investigación previa
                </Label>
                <span className={cn(
                  "text-xs font-medium px-2 py-0.5 rounded-full",
                  checksValid
                    ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300"
                )}>
                  {checksCompleted}/{INVESTIGATION_CHECKS.length} (mín. {MIN_CHECKS_REQUIRED})
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Marca lo que hayas verificado antes de escalar a SRE. Mínimo {MIN_CHECKS_REQUIRED} comprobaciones.
              </p>
              <div className="space-y-2 rounded-lg border border-border p-3 bg-muted/20">
                {INVESTIGATION_CHECKS.map((check) => (
                  <label
                    key={check.id}
                    className={cn(
                      "flex items-start gap-3 rounded-md px-3 py-2.5 cursor-pointer transition-colors",
                      checks[check.id]
                        ? "bg-green-50 dark:bg-green-950/30"
                        : "hover:bg-secondary/60"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={!!checks[check.id]}
                      onChange={() => toggleCheck(check.id)}
                      className="mt-0.5 rounded border-border"
                    />
                    <span className="text-sm">{check.label}</span>
                  </label>
                ))}
              </div>
              {!checksValid && checksCompleted > 0 && (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  Necesitas marcar al menos {MIN_CHECKS_REQUIRED} comprobaciones para poder enviar.
                </p>
              )}
            </div>

            {/* Title */}
            <div className="space-y-2">
              <Label>Título del problema</Label>
              <Input
                placeholder="Describe brevemente el error"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            {/* Description */}
            <div className="space-y-2">
              <Label>¿Qué error ves exactamente?</Label>
              <textarea
                className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Pega el error, describe el comportamiento esperado vs actual... (puedes pegar imágenes con Ctrl+V)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                required
              />
            </div>

            {/* Attachments */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Capturas / evidencias</Label>
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 text-xs text-primary hover:text-primary/80 font-medium"
                >
                  <ImagePlus className="h-3.5 w-3.5" />
                  Añadir imagen
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(e) => {
                    if (e.target.files) addFiles(e.target.files);
                    e.target.value = "";
                  }}
                />
              </div>

              {attachments.length > 0 ? (
                <div className="grid grid-cols-3 gap-2">
                  {attachments.map((att) => (
                    <div key={att.id} className="relative group rounded-lg border border-border overflow-hidden">
                      <img src={att.preview} alt={att.file.name} className="w-full h-20 object-cover" />
                      <button
                        type="button"
                        onClick={() => removeAttachment(att.id)}
                        className="absolute top-1 right-1 p-0.5 rounded-full bg-black/60 text-white opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X className="h-3 w-3" />
                      </button>
                      <div className="absolute bottom-0 inset-x-0 bg-black/50 px-1.5 py-0.5 text-[10px] text-white truncate">
                        {att.file.name}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  className="rounded-lg border-2 border-dashed border-border/60 p-3 text-center text-xs text-muted-foreground cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                >
                  Arrastra capturas aquí, pégalas con Ctrl+V, o haz clic
                </div>
              )}
            </div>

            {/* Priority */}
            <div className="space-y-2">
              <Label>Prioridad</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecciona prioridad" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="alta">Alta</SelectItem>
                  <SelectItem value="media">Media</SelectItem>
                  <SelectItem value="baja">Baja</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <Button
              type="submit"
              disabled={loading || !isFormValid()}
              className="w-full"
            >
              {loading ? "Creando..." : "Crear incidencia"}
            </Button>

            {!checksValid && (
              <p className="text-center text-xs text-muted-foreground">
                Completa la investigación previa para poder enviar
              </p>
            )}
          </form>

          {result && (
            <div className="mt-4 p-3 rounded-md bg-green-50 border border-green-200 text-green-800 dark:bg-green-950 dark:border-green-800 dark:text-green-200">
              Ticket creado:{" "}
              <Link href={result.url} target="_blank" className="font-semibold underline">
                {result.key}
              </Link>
            </div>
          )}

          {error && (
            <div className="mt-4 p-3 rounded-md bg-red-50 border border-red-200 text-red-800 dark:bg-red-950 dark:border-red-800 dark:text-red-200">
              {error}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
