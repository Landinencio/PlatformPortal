"use client";

import { useState, useEffect, useCallback } from "react";
import { ExternalLink, ChevronLeft, ChevronRight, Clock, MessageSquare, GitCommit, Users, Code2, Search } from "lucide-react";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface MRDetail {
  id: number;
  projectPath: string;
  team: string;
  mrIid: number;
  title: string;
  url: string;
  author: string;
  authorUsername: string;
  createdAt: string;
  mergedAt: string | null;
  firstCommitAt: string | null;
  timeToPrHours: number | null;
  reviewTimeHours: number | null;
  commitCount: number;
  commentCount: number;
  reviewerCount: number;
  linesAdded: number;
  linesRemoved: number;
}

interface MRSummary {
  totalMRs: number;
  avgReviewTime: number;
  avgTimeToPr: number;
  avgComments: number;
  avgCommits: number;
  avgReviewers: number;
  medianReviewTime: number;
  medianTimeToPr: number;
}

interface Props {
  days: number;
  teams: string[];
  projectIds: number[];
  authors: string[];
  from?: string;
  to?: string;
}

function formatHours(hours: number | null): string {
  if (hours === null) return "-";
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  return new Date(dateStr).toLocaleDateString("es-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function MRDetailsTable({ days, teams, projectIds, authors, from, to }: Props) {
  const [mrs, setMrs] = useState<MRDetail[]>([]);
  const [summary, setSummary] = useState<MRSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ page: String(page), limit: "50" });
      if (from && to) {
        params.set("from", from);
        params.set("to", to);
      } else {
        params.set("days", String(days));
      }
      if (teams.length > 0) params.set("teams", teams.join(","));
      if (projectIds.length > 0) params.set("projectIds", projectIds.join(","));
      if (authors.length > 0) params.set("authors", authors.join(","));

      const res = await fetch(`/api/metrics/mr-details?${params}`);
      if (res.ok) {
        const data = await res.json();
        setMrs(data.mrs || []);
        setSummary(data.summary || null);
        setTotalPages(data.pagination?.totalPages || 1);
        setTotal(data.pagination?.total || 0);
      }
    } catch (err) {
      console.error("Error fetching MR details:", err);
    } finally {
      setLoading(false);
    }
  }, [days, teams, projectIds, authors, page, from, to]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { setPage(1); }, [days, teams, projectIds, authors]);

  if (loading) {
    return (
      <div className="space-y-3 animate-pulse">
        <div className="h-20 bg-muted/40 rounded-lg" />
        <div className="h-64 bg-muted/40 rounded-lg" />
      </div>
    );
  }

  if (!summary || total === 0) {
    return (
      <Card className="p-6 text-center text-sm text-muted-foreground">
        No hay datos de MRs para el periodo seleccionado. Los datos se actualizan cada noche.
      </Card>
    );
  }

  const filteredMrs = search.trim()
    ? mrs.filter((mr) => {
        const q = search.toLowerCase();
        return (
          mr.title?.toLowerCase().includes(q) ||
          mr.author?.toLowerCase().includes(q) ||
          mr.authorUsername?.toLowerCase().includes(q) ||
          mr.projectPath?.toLowerCase().includes(q) ||
          String(mr.mrIid).includes(q)
        );
      })
    : mrs;

  return (
    <div className="space-y-4">
      {/* Summary KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-3">
          <div className="text-[10px] font-medium text-muted-foreground uppercase">Avg Review Time</div>
          <div className="text-lg font-bold">{formatHours(summary.avgReviewTime)}</div>
          <div className="text-[10px] text-muted-foreground">mediana: {formatHours(summary.medianReviewTime)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] font-medium text-muted-foreground uppercase">Avg Time to PR</div>
          <div className="text-lg font-bold">{formatHours(summary.avgTimeToPr)}</div>
          <div className="text-[10px] text-muted-foreground">mediana: {formatHours(summary.medianTimeToPr)}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] font-medium text-muted-foreground uppercase">Avg Comentarios</div>
          <div className="text-lg font-bold">{summary.avgComments}</div>
        </Card>
        <Card className="p-3">
          <div className="text-[10px] font-medium text-muted-foreground uppercase">Total MRs</div>
          <div className="text-lg font-bold">{total}</div>
        </Card>
      </div>

      {/* MR Table */}
      <Card className="p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">Detalle por MR</h3>
          <div className="flex items-center gap-3">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por título, autor o proyecto..."
              className="px-3 py-1.5 text-xs rounded-md border border-border bg-background w-64 focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            <span className="text-xs text-muted-foreground">Página {page}/{totalPages}</span>
            <button
              onClick={() => setPage(Math.max(1, page - 1))}
              disabled={page <= 1}
              className="p-1 rounded hover:bg-muted disabled:opacity-30"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
            </button>
            <button
              onClick={() => setPage(Math.min(totalPages, page + 1))}
              disabled={page >= totalPages}
              className="p-1 rounded hover:bg-muted disabled:opacity-30"
            >
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-xs" style={{ minWidth: "1100px" }}>
            <thead>
              <tr className="border-b text-left text-muted-foreground">
                <th className="pb-2 font-medium" style={{ width: "35%" }}>MR</th>
                <th className="pb-2 font-medium" style={{ width: "12%" }}>Autor</th>
                <th className="pb-2 font-medium text-center" title="Time to PR (primer commit → MR creada)">
                  <Clock className="h-3 w-3 inline mr-0.5" />T→PR
                </th>
                <th className="pb-2 font-medium text-center" title="Review Time (MR creada → merged)">
                  <Clock className="h-3 w-3 inline mr-0.5" />Review
                </th>
                <th className="pb-2 font-medium text-center" title="Comentarios">
                  <MessageSquare className="h-3 w-3 inline mr-0.5" />
                </th>
                <th className="pb-2 font-medium text-center" title="Commits">
                  <GitCommit className="h-3 w-3 inline mr-0.5" />
                </th>
                <th className="pb-2 font-medium text-center" title="Líneas +/-">
                  <Code2 className="h-3 w-3 inline mr-0.5" />
                </th>
                <th className="pb-2 font-medium text-center" title="Reviewers">
                  <Users className="h-3 w-3 inline mr-0.5" />
                </th>
                <th className="pb-2 font-medium text-right">Creada</th>
                <th className="pb-2 font-medium text-right">Merged</th>
              </tr>
            </thead>
            <tbody>
              {filteredMrs.map((mr) => (
                <tr key={mr.id} className="border-b last:border-0 hover:bg-muted/30">
                  <td className="py-2">
                    <a
                      href={mr.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-1 text-primary hover:underline"
                    >
                      !{mr.mrIid}
                      <ExternalLink className="h-2.5 w-2.5 shrink-0" />
                    </a>
                    <div className="text-[10px] text-muted-foreground mt-0.5 leading-tight">{mr.title}</div>
                  </td>
                  <td className="py-2 truncate max-w-[120px]" title={mr.author}>{mr.author}</td>
                  <td className="py-2 text-center">
                    <span className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] font-medium",
                      (mr.timeToPrHours || 0) > 48 ? "bg-red-100 text-red-700" :
                      (mr.timeToPrHours || 0) > 24 ? "bg-amber-100 text-amber-700" :
                      "bg-green-100 text-green-700"
                    )}>
                      {formatHours(mr.timeToPrHours)}
                    </span>
                  </td>
                  <td className="py-2 text-center">
                    <span className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] font-medium",
                      (mr.reviewTimeHours || 0) > 48 ? "bg-red-100 text-red-700" :
                      (mr.reviewTimeHours || 0) > 24 ? "bg-amber-100 text-amber-700" :
                      "bg-green-100 text-green-700"
                    )}>
                      {formatHours(mr.reviewTimeHours)}
                    </span>
                  </td>
                  <td className="py-2 text-center">{mr.commentCount}</td>
                  <td className="py-2 text-center">{mr.commitCount}</td>
                  <td className="py-2 text-center text-muted-foreground">
                    <span className="text-green-600">+{mr.linesAdded}</span>
                    {mr.linesRemoved > 0 && <span className="text-red-600 ml-1">-{mr.linesRemoved}</span>}
                  </td>
                  <td className="py-2 text-center">{mr.reviewerCount}</td>
                  <td className="py-2 text-right text-muted-foreground">{formatDate(mr.createdAt)}</td>
                  <td className="py-2 text-right text-muted-foreground">{formatDate(mr.mergedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
