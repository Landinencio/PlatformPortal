"use client";

import { useState, useRef, useCallback } from "react";
import { useSession } from "next-auth/react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { BUSINESS_TEAMS, BUSINESS_TEAM_LABELS } from "@/lib/team-approvers";
import { Ticket, ImagePlus, X } from "lucide-react";
import Link from "next/link";
import { MyTicketsList } from "@/components/tickets/my-tickets-list";

interface AttachedFile {
  id: string;
  file: File;
  preview: string;
}

export default function RequestsPage() {
  const { data: session } = useSession();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [priority, setPriority] = useState("media");
  const [businessTeam, setBusinessTeam] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ key: string; url: string } | null>(null);
  const [error, setError] = useState("");
  const [attachments, setAttachments] = useState<AttachedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResult(null);

    try {
      const formData = new FormData();
      formData.append("type", "request");
      formData.append("title", title);
      formData.append("description", description);
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
      setTitle("");
      setDescription("");
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
        <Ticket className="h-6 w-6 text-primary" />
        <h1 className="text-2xl font-bold">Peticiones</h1>
      </div>
      <p className="text-muted-foreground mb-8">
        Solicita recursos o configuraciones que aún no están automatizadas: API gateways, repos de infraestructura, etc.
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Nueva petición</CardTitle>
          <CardDescription>Rellena los campos y se creará un ticket en Jira automáticamente.</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="team">Equipo</Label>
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

            <div className="space-y-2">
              <Label htmlFor="title">Título</Label>
              <Input
                id="title"
                placeholder="Describe brevemente lo que necesitas"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Descripción</Label>
              <textarea
                id="description"
                className="flex min-h-[100px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Detalla qué recurso o configuración necesitas... (puedes pegar imágenes con Ctrl+V)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onPaste={handlePaste}
                onDrop={handleDrop}
                onDragOver={handleDragOver}
                required
              />
            </div>

            {/* Attachments area */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Imágenes adjuntas</Label>
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
                  className="rounded-lg border-2 border-dashed border-border/60 p-4 text-center text-xs text-muted-foreground cursor-pointer hover:border-primary/40 hover:bg-primary/5 transition-colors"
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                >
                  Arrastra imágenes aquí, pégalas con Ctrl+V, o haz clic para seleccionar
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label htmlFor="priority">Prioridad</Label>
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

            <Button type="submit" disabled={loading || !title || !description || !businessTeam} className="w-full">
              {loading ? "Creando..." : "Crear petición"}
            </Button>
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
