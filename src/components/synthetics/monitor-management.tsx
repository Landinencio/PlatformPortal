"use client";

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Edit2, Plus, Trash2, XCircle } from "lucide-react";
import { cn } from '@/lib/utils';

interface MonitorRow {
    id: number;
    name: string;
    url: string;
    active: boolean;
    interval_seconds: number;
    method: 'GET' | 'HEAD';
    timeout_ms: number;
    expected_status_min: number;
    expected_status_max: number;
    expected_keyword: string | null;
    expected_content_regex: string | null;
    allow_insecure: boolean;
    tags: string[];
    custom_headers: Record<string, string>;
}

const defaultForm: Omit<MonitorRow, 'id'> = {
    name: '',
    url: '',
    active: true,
    interval_seconds: 60,
    method: 'GET',
    timeout_ms: 10000,
    expected_status_min: 200,
    expected_status_max: 399,
    expected_keyword: '',
    expected_content_regex: '',
    allow_insecure: false,
    tags: [],
    custom_headers: {},
};

export default function MonitorManagement() {
    const [monitors, setMonitors] = useState<MonitorRow[]>([]);
    const [loading, setLoading] = useState(true);
    const [dialogOpen, setDialogOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [form, setForm] = useState(defaultForm);

    const fetchMonitors = async () => {
        try {
            const res = await fetch('/api/synthetics/monitors');
            if (!res.ok) throw new Error('No se han podido cargar los monitores.');
            const data = await res.json();
            setMonitors(data);
        } catch (err) {
            console.error(err);
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        fetchMonitors();
    }, []);

    const openCreate = () => {
        setEditingId(null);
        setForm(defaultForm);
        setError(null);
        setDialogOpen(true);
    };

    const openEdit = (monitor: MonitorRow) => {
        setEditingId(monitor.id);
        setForm({
            ...monitor,
            expected_keyword: monitor.expected_keyword || '',
            expected_content_regex: monitor.expected_content_regex || '',
            tags: monitor.tags || [],
            custom_headers: monitor.custom_headers || {},
        });
        setError(null);
        setDialogOpen(true);
    };

    const handleSave = async () => {
        setSaving(true);
        setError(null);

        if (!form.name.trim() || !form.url.trim()) {
            setError('El nombre y la URL son obligatorios.');
            setSaving(false);
            return;
        }

        if (form.expected_status_min > form.expected_status_max) {
            setError('El rango de estados esperados no es válido.');
            setSaving(false);
            return;
        }

        const payload = {
            ...form,
            expected_keyword: form.expected_keyword?.trim() || null,
        };

        try {
            const res = await fetch(`/api/synthetics/monitors${editingId ? `/${editingId}` : ''}`,
                {
                    method: editingId ? 'PATCH' : 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                }
            );
            if (!res.ok) {
                const message = await res.json();
                throw new Error(message?.error || 'No se ha podido guardar el monitor.');
            }
            await fetchMonitors();
            setDialogOpen(false);
        } catch (err: any) {
            setError(err?.message || 'No se ha podido guardar el monitor.');
        } finally {
            setSaving(false);
        }
    };

    const handleDelete = async (monitor: MonitorRow) => {
        const confirmed = window.confirm(`¿Eliminar el monitor "${monitor.name}"? También se eliminará su histórico.`);
        if (!confirmed) return;

        try {
            const res = await fetch(`/api/synthetics/monitors/${monitor.id}`, { method: 'DELETE' });
            if (!res.ok) throw new Error('No se ha podido eliminar el monitor.');
            await fetchMonitors();
        } catch (err) {
            console.error(err);
        }
    };

    return (
        <Card>
            <CardHeader className="pb-3">
                <div className="flex items-center justify-between gap-2">
                    <div>
                        <CardTitle className="text-lg">Configuración de monitores</CardTitle>
                        <CardDescription>Gestiona objetivos, intervalos y expectativas de servicio. El scheduler se ejecuta cada 30 s, por lo que los intervalos inferiores se limitarán.</CardDescription>
                    </div>
                    <Button onClick={openCreate} size="sm">
                        <Plus className="h-4 w-4 mr-2" />
                        Añadir monitor
                    </Button>
                </div>
            </CardHeader>
            <CardContent>
                {loading ? (
                    <div className="text-sm text-muted-foreground">Cargando monitores...</div>
                ) : (
                    <div className="border rounded-lg overflow-hidden">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Nombre</TableHead>
                                    <TableHead>URL</TableHead>
                                    <TableHead>Estado</TableHead>
                                    <TableHead className="text-right">Intervalo</TableHead>
                                    <TableHead className="text-right">Timeout</TableHead>
                                    <TableHead className="text-right">Esperado</TableHead>
                                    <TableHead className="text-right">Palabra clave</TableHead>
                                    <TableHead className="text-right">Acciones</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {monitors.map((monitor) => (
                                    <TableRow key={monitor.id}>
                                        <TableCell>
                                            <div className="font-medium">{monitor.name}</div>
                                            {monitor.tags?.length > 0 && (
                                                <div className="flex flex-wrap gap-1 mt-1">
                                                    {monitor.tags.map((tag) => (
                                                        <span key={tag} className="inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">{tag}</span>
                                                    ))}
                                                </div>
                                            )}
                                        </TableCell>
                                        <TableCell className="text-xs text-muted-foreground truncate max-w-[260px]">{monitor.url}</TableCell>
                                        <TableCell>
                                            <Badge variant="outline" className={cn("text-xs", monitor.active ? 'border-success/30 bg-success/10 text-success' : 'border-danger/30 bg-danger/10 text-danger')}>
                                                {monitor.active ? 'ACTIVO' : 'PAUSADO'}
                                            </Badge>
                                        </TableCell>
                                        <TableCell className="text-right text-xs">{monitor.interval_seconds}s</TableCell>
                                        <TableCell className="text-right text-xs">{monitor.timeout_ms}ms</TableCell>
                                        <TableCell className="text-right text-xs">{monitor.method} {monitor.expected_status_min}-{monitor.expected_status_max}</TableCell>
                                        <TableCell className="text-right text-xs">{monitor.expected_keyword || '-'}</TableCell>
                                        <TableCell className="text-right">
                                            <div className="flex items-center justify-end gap-2">
                                                <Button variant="ghost" size="icon" onClick={() => openEdit(monitor)}>
                                                    <Edit2 className="h-4 w-4" />
                                                </Button>
                                                <Button variant="ghost" size="icon" onClick={() => handleDelete(monitor)}>
                                                    <Trash2 className="h-4 w-4 text-danger" />
                                                </Button>
                                            </div>
                                        </TableCell>
                                    </TableRow>
                                ))}
                            </TableBody>
                        </Table>
                    </div>
                )}
            </CardContent>

            <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
                <DialogContent className="max-w-2xl">
                    <DialogHeader>
                        <DialogTitle>{editingId ? 'Editar monitor' : 'Nuevo monitor'}</DialogTitle>
                        <DialogDescription>Define cómo se comprobarán la alcanzabilidad y el estado del servicio.</DialogDescription>
                    </DialogHeader>

                    <div className="grid gap-4">
                        <div className="grid gap-2">
                            <Label>Nombre</Label>
                            <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
                        </div>
                        <div className="grid gap-2">
                            <Label>URL</Label>
                            <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label>Método</Label>
                                <Select value={form.method} onValueChange={(value) => setForm({ ...form, method: value as 'GET' | 'HEAD' })}>
                                    <SelectTrigger>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="GET">GET</SelectItem>
                                        <SelectItem value="HEAD">HEAD</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                            <div className="grid gap-2">
                                <Label>Intervalo (segundos)</Label>
                                <Input type="number" value={form.interval_seconds}
                                    onChange={(e) => setForm({ ...form, interval_seconds: Number(e.target.value) })}
                                />
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label>Timeout (ms)</Label>
                                <Input type="number" value={form.timeout_ms}
                                    onChange={(e) => setForm({ ...form, timeout_ms: Number(e.target.value) })}
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label>Estado</Label>
                                <Button
                                    variant="outline"
                                    className="justify-start"
                                    onClick={() => setForm({ ...form, active: !form.active })}
                                >
                                    {form.active ? (
                                        <span className="inline-flex items-center gap-2 text-success">
                                            <CheckCircle2 className="h-4 w-4" /> Activo
                                        </span>
                                    ) : (
                                        <span className="inline-flex items-center gap-2 text-danger">
                                            <XCircle className="h-4 w-4" /> Pausado
                                        </span>
                                    )}
                                </Button>
                            </div>
                        </div>
                        <div className="grid grid-cols-2 gap-4">
                            <div className="grid gap-2">
                                <Label>Estado esperado mínimo</Label>
                                <Input type="number" value={form.expected_status_min}
                                    onChange={(e) => setForm({ ...form, expected_status_min: Number(e.target.value) })}
                                />
                            </div>
                            <div className="grid gap-2">
                                <Label>Estado esperado máximo</Label>
                                <Input type="number" value={form.expected_status_max}
                                    onChange={(e) => setForm({ ...form, expected_status_max: Number(e.target.value) })}
                                />
                            </div>
                        </div>
                        <div className="grid gap-2">
                            <Label>Palabra clave esperada (opcional)</Label>
                            <Input value={form.expected_keyword || ''} onChange={(e) => setForm({ ...form, expected_keyword: e.target.value })} />
                        </div>
                        <div className="grid gap-2">
                            <Label>Regex de validación (opcional)</Label>
                            <Input value={form.expected_content_regex || ''} onChange={(e) => setForm({ ...form, expected_content_regex: e.target.value })} placeholder='ej: "status":\s*"ok"' />
                            <p className="text-[10px] text-muted-foreground">Expresión regular que debe coincidir en el body de la respuesta. Se evalúa además de la palabra clave.</p>
                        </div>
                        <div className="grid gap-2">
                            <Label>Tags (separados por coma)</Label>
                            <Input
                                value={(form.tags || []).join(', ')}
                                onChange={(e) => setForm({ ...form, tags: e.target.value.split(',').map(t => t.trim()).filter(Boolean) })}
                                placeholder="ej: produccion, ecommerce, critico"
                            />
                            <p className="text-[10px] text-muted-foreground">Etiquetas para filtrar y agrupar monitores.</p>
                        </div>
                        <div className="grid gap-2">
                            <Label>Headers personalizados (JSON)</Label>
                            <Input
                                value={Object.keys(form.custom_headers || {}).length > 0 ? JSON.stringify(form.custom_headers) : ''}
                                onChange={(e) => {
                                    try {
                                        const parsed = e.target.value.trim() ? JSON.parse(e.target.value) : {};
                                        setForm({ ...form, custom_headers: parsed });
                                    } catch { /* ignore invalid JSON while typing */ }
                                }}
                                placeholder='ej: {"User-Agent": "MyBot/1.0", "X-Custom": "value"}'
                            />
                            <p className="text-[10px] text-muted-foreground">Headers HTTP adicionales en formato JSON. Sobreescriben los por defecto.</p>
                        </div>
                        <div className="grid gap-2">
                            <Label>Permitir TLS no seguro</Label>
                            <Button
                                variant="outline"
                                className="justify-start"
                                onClick={() => setForm({ ...form, allow_insecure: !form.allow_insecure })}
                            >
                                {form.allow_insecure ? 'Activado (se permiten certificados autofirmados)' : 'Desactivado (TLS estricto)'}
                            </Button>
                        </div>

                        {error && <div className="text-sm text-danger">{error}</div>}

                        <div className="flex justify-end gap-2 pt-2">
                            <Button variant="ghost" onClick={() => setDialogOpen(false)} disabled={saving}>Cancelar</Button>
                            <Button onClick={handleSave} disabled={saving}>{saving ? 'Guardando...' : 'Guardar monitor'}</Button>
                        </div>
                    </div>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
