"use client";

import { useState, useEffect } from "react";
import { Code, Download, FileSpreadsheet, Loader2, TrendingUp, TrendingDown, Minus, AlertCircle, CheckCircle2, XCircle, Link2Off } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MultiSelect } from "@/components/ui/multi-select";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";

interface SonarQubeProject {
  key: string;
  name: string;
  gitlabProjectId?: number | null;
  mappedToGitLab?: boolean;
}

interface UnmappedProject {
  key: string;
  name: string;
  suggestions?: Array<{ projectId: number; path: string; similarity: number }>;
}

interface ProjectMetrics {
  projectKey: string;
  current: {
    coverage: number;
    bugs: number;
    vulnerabilities: number;
    code_smells: number;
    tech_debt_minutes: number;
  } | null;
  qualityGate: string | null;
  trends?: {
    coverageChange: number;
    bugsChange: number;
    vulnerabilitiesChange: number;
  };
  error?: string;
}

export function EnhancedSonarQubePanel() {
  const { t } = useI18n();
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [allProjects, setAllProjects] = useState<SonarQubeProject[]>([]);
  const [selectedProjects, setSelectedProjects] = useState<string[]>([]);
  const [metricsData, setMetricsData] = useState<ProjectMetrics[]>([]);
  const [timeRange, setTimeRange] = useState(30);

  // Derived: unmapped projects and mapping coverage
  const unmappedProjects: UnmappedProject[] = allProjects
    .filter((p) => !p.mappedToGitLab && !p.gitlabProjectId)
    .map((p) => ({ key: p.key, name: p.name }));
  const mappedCount = allProjects.filter((p) => p.mappedToGitLab || p.gitlabProjectId).length;
  const mappingCoveragePct = allProjects.length > 0
    ? ((mappedCount / allProjects.length) * 100).toFixed(0)
    : "0";

  // Load all projects on mount
  useEffect(() => {
    loadAllProjects();
  }, []);

  const loadAllProjects = async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/sonarqube/projects?limit=500');
      const data = await res.json();
      setAllProjects(data.projects || []);
    } catch (error) {
      console.error('Error loading projects:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadMetrics = async () => {
    if (selectedProjects.length === 0) return;

    try {
      setLoading(true);
      const res = await fetch(
        `/api/sonarqube/export?projectKeys=${selectedProjects.join(',')}&days=${timeRange}`
      );
      const data = await res.json();
      setMetricsData(data.projects || []);
    } catch (error) {
      console.error('Error loading metrics:', error);
    } finally {
      setLoading(false);
    }
  };

  const exportToExcel = async () => {
    if (metricsData.length === 0) return;

    try {
      setExporting(true);

      // Prepare data for Excel
      const excelData = metricsData.map((project) => {
        const metrics = project.current;
        const trends = project.trends;
        
        return {
          'Project': project.projectKey,
          'Quality Gate': project.qualityGate || 'N/A',
          'Coverage (%)': metrics?.coverage?.toFixed(2) || '0',
          'Coverage Change': trends?.coverageChange?.toFixed(2) || '0',
          'Bugs': metrics?.bugs || 0,
          'Bugs Change': trends?.bugsChange || 0,
          'Vulnerabilities': metrics?.vulnerabilities || 0,
          'Vulnerabilities Change': trends?.vulnerabilitiesChange || 0,
          'Code Smells': metrics?.code_smells || 0,
          'Tech Debt (hours)': metrics?.tech_debt_minutes ? (metrics.tech_debt_minutes / 60).toFixed(1) : '0',
        };
      });

      // Create workbook
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.json_to_sheet(excelData);

      // Auto-size columns
      const colWidths = Object.keys(excelData[0] || {}).map(key => ({
        wch: Math.max(key.length, 15)
      }));
      ws['!cols'] = colWidths;

      XLSX.utils.book_append_sheet(wb, ws, 'SonarQube Metrics');

      // Generate filename with timestamp
      const timestamp = new Date().toISOString().split('T')[0];
      const filename = `sonarqube-metrics-${timestamp}.xlsx`;

      // Download
      XLSX.writeFile(wb, filename);
    } catch (error) {
      console.error('Error exporting to Excel:', error);
    } finally {
      setExporting(false);
    }
  };

  const projectOptions = allProjects.map(p => ({
    value: p.key,
    label: p.name,
  }));

  const getTrendIcon = (change: number) => {
    if (change > 0) return <TrendingUp className="w-3 h-3 text-success" />;
    if (change < 0) return <TrendingDown className="w-3 h-3 text-danger" />;
    return <Minus className="w-3 h-3 text-muted-foreground" />;
  };

  const getQualityGateIcon = (status: string | null) => {
    if (status === 'OK') return <CheckCircle2 className="w-5 h-5 text-success" />;
    if (status === 'ERROR') return <XCircle className="w-5 h-5 text-danger" />;
    return <AlertCircle className="w-5 h-5 text-warning" />;
  };

  return (
    <div className="space-y-6">
      {/* Header Card */}
      <Card className="border-none shadow-lg bg-gradient-to-br from-primary/10 to-info/10">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Code className="w-6 h-6 text-primary" />
            SonarQube Analytics
          </CardTitle>
          <CardDescription>
            Análisis de calidad de código para múltiples proyectos
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-3">
            {/* Project Selection */}
            <div className="md:col-span-2">
              <label className="text-sm font-medium mb-2 block">Seleccionar Proyectos</label>
              <MultiSelect
                options={projectOptions}
                selected={selectedProjects}
                onChange={setSelectedProjects}
                placeholder={t("sonar.selectProjects")}
                searchPlaceholder={t("sonar.searchProjects")}
                emptyMessage={t("sonar.noProjectsFound")}
                className="w-full"
              />
            </div>

            {/* Time Range */}
            <div>
              <label className="text-sm font-medium mb-2 block">Periodo de Comparación</label>
              <select
                value={timeRange}
                onChange={(e) => setTimeRange(parseInt(e.target.value))}
                className="w-full px-3 py-2 border rounded-lg bg-background"
              >
                <option value={7}>7 días</option>
                <option value={15}>15 días</option>
                <option value={30}>30 días</option>
                <option value={90}>90 días</option>
              </select>
            </div>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3 mt-4">
            <Button
              onClick={loadMetrics}
              disabled={loading || selectedProjects.length === 0}
              className="flex-1"
            >
              {loading ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Cargando...
                </>
              ) : (
                <>
                  <Code className="w-4 h-4 mr-2" />
                  Cargar Métricas
                </>
              )}
            </Button>

            <Button
              onClick={exportToExcel}
              disabled={exporting || metricsData.length === 0}
              variant="outline"
              className="flex-1"
            >
              {exporting ? (
                <>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  Exportando...
                </>
              ) : (
                <>
                  <FileSpreadsheet className="w-4 h-4 mr-2" />
                  Exportar a Excel
                </>
              )}
            </Button>
          </div>

          {selectedProjects.length > 0 && (
            <div className="mt-3 text-sm text-muted-foreground">
              {selectedProjects.length} proyecto(s) seleccionado(s)
            </div>
          )}
        </CardContent>
      </Card>

      {/* Metrics Display */}
      {metricsData.length > 0 && (
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
          {metricsData.map((project) => (
            <Card key={project.projectKey} className="border-none shadow-lg hover:shadow-xl transition-all">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <CardTitle className="text-lg">{project.projectKey}</CardTitle>
                    <div className="flex items-center gap-2 mt-2">
                      {getQualityGateIcon(project.qualityGate)}
                      <span className={cn(
                        "text-sm font-medium",
                        project.qualityGate === 'OK' && "text-success",
                        project.qualityGate === 'ERROR' && "text-danger",
                        !project.qualityGate && "text-warning"
                      )}>
                        {project.qualityGate || 'Unknown'}
                      </span>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                {project.error ? (
                  <div className="text-sm text-danger flex items-center gap-2">
                    <AlertCircle className="w-4 h-4" />
                    {project.error}
                  </div>
                ) : project.current ? (
                  <div className="space-y-3">
                    {/* Coverage */}
                    <div className="flex items-center justify-between p-2 rounded-lg bg-success/10">
                      <div>
                        <div className="text-xs text-muted-foreground">Coverage</div>
                        <div className="text-2xl font-bold text-success">
                          {project.current.coverage.toFixed(1)}%
                        </div>
                      </div>
                      {project.trends && (
                        <div className="flex items-center gap-1 text-xs">
                          {getTrendIcon(project.trends.coverageChange)}
                          <span>{Math.abs(project.trends.coverageChange).toFixed(1)}%</span>
                        </div>
                      )}
                    </div>

                    {/* Bugs */}
                    <div className="flex items-center justify-between p-2 rounded-lg bg-danger/10">
                      <div>
                        <div className="text-xs text-muted-foreground">Bugs</div>
                        <div className="text-2xl font-bold text-danger">
                          {project.current.bugs}
                        </div>
                      </div>
                      {project.trends && (
                        <div className="flex items-center gap-1 text-xs">
                          {getTrendIcon(-project.trends.bugsChange)}
                          <span>{Math.abs(project.trends.bugsChange)}</span>
                        </div>
                      )}
                    </div>

                    {/* Vulnerabilities */}
                    <div className="flex items-center justify-between p-2 rounded-lg bg-danger/10">
                      <div>
                        <div className="text-xs text-muted-foreground">Vulnerabilities</div>
                        <div className="text-2xl font-bold text-danger">
                          {project.current.vulnerabilities}
                        </div>
                      </div>
                      {project.trends && (
                        <div className="flex items-center gap-1 text-xs">
                          {getTrendIcon(-project.trends.vulnerabilitiesChange)}
                          <span>{Math.abs(project.trends.vulnerabilitiesChange)}</span>
                        </div>
                      )}
                    </div>

                    {/* Code Smells & Tech Debt */}
                    <div className="grid grid-cols-2 gap-2">
                      <div className="p-2 rounded-lg bg-warning/10 text-center">
                        <div className="text-xs text-muted-foreground">Code Smells</div>
                        <div className="text-lg font-bold text-warning">
                          {project.current.code_smells}
                        </div>
                      </div>
                      <div className="p-2 rounded-lg bg-info/10 text-center">
                        <div className="text-xs text-muted-foreground">Tech Debt</div>
                        <div className="text-lg font-bold text-info">
                          {Math.round(project.current.tech_debt_minutes / 60)}h
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">No metrics available</div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && metricsData.length === 0 && selectedProjects.length > 0 && (
        <Card className="border-2 border-dashed">
          <CardContent className="flex flex-col items-center justify-center p-12 text-center">
            <Code className="w-16 h-16 text-muted-foreground mb-4" />
            <h3 className="text-xl font-semibold mb-2">Selecciona proyectos</h3>
            <p className="text-muted-foreground max-w-md">
              Haz clic en "Cargar Métricas" para ver los datos de los proyectos seleccionados
            </p>
          </CardContent>
        </Card>
      )}

      {/* Unmapped Projects Section */}
      {unmappedProjects.length > 0 && (
        <Card className="border-border/70">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Link2Off className="h-5 w-5 text-warning" />
              {t("sonar.unmappedProjects")}
            </CardTitle>
            <CardDescription className="flex items-center gap-2">
              {t("sonar.mappingCoverage")}: {mappingCoveragePct}%
              <span className="text-muted-foreground">
                ({mappedCount}/{allProjects.length})
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {unmappedProjects.slice(0, 20).map((project) => (
                <div key={project.key} className="flex items-center justify-between p-2 rounded-lg bg-muted/30 text-sm">
                  <div>
                    <span className="font-medium">{project.name}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{project.key}</span>
                  </div>
                  {project.suggestions && project.suggestions.length > 0 && (
                    <span className="text-xs text-info">
                      {t("sonar.possibleMatch")}: {project.suggestions[0].path}
                    </span>
                  )}
                </div>
              ))}
              {unmappedProjects.length > 20 && (
                <div className="text-xs text-muted-foreground text-center pt-2">
                  +{unmappedProjects.length - 20} {t("common.loadMore")}
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
