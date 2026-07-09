// AWS Bedrock AI Client — SDK integration with mock fallback

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

export interface MetricsContext {
  team?: string;
  projects: Array<{ id: number; name: string }>;
  period: string;
  metrics: {
    deploymentFreq: number;
    deployFreqChange: number;
    leadTime: number;
    leadTimeChange: number;
    cfr: number;
    cfrChange: number;
    mttr: number;
    mttrChange: number;
  };
  developers: number;
  totalDeploys: number;
  incidents: number;
  recentTraces?: any[];
}

export interface AIInsight {
  type: 'success' | 'warning' | 'info' | 'danger';
  title: string;
  message: string;
  priority: number;
  actionable?: {
    label: string;
    action: string;
  };
}

export interface Anomaly {
  metric: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  detectedAt: string;
  affectedProjects: string[];
  suggestedAction: string;
  confidence: number;
}

export interface RiskAssessment {
  level: 'low' | 'medium' | 'high' | 'critical';
  probability: number;
  reasons: string[];
  recommendations: string[];
  historicalSimilarities: Array<{
    date: string;
    outcome: string;
    similarity: number;
  }>;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
}

export interface AIProviderStatus {
  mode: 'mock' | 'bedrock-sdk' | 'bedrock-http-proxy' | 'bedrock-sdk-pending';
  ready: boolean;
  configured: boolean;
  missing: string[];
  endpoint: string | null;
  region: string | null;
  modelId: string | null;
  notes: string[];
}

const SYSTEM_PROMPT_METRICS_ANALYST = `
Eres un experto en métricas DORA y DevOps con 15 años de experiencia.
Tu rol es analizar métricas de ingeniería y generar insights accionables.

Contexto:
- DORA metrics: Deployment Frequency, Lead Time, Change Failure Rate, MTTR
- Elite performers: DF >1/día, LT <1h, CFR <5%, MTTR <1h
- High performers: DF 1/semana-1/mes, LT <1 día, CFR 5-15%, MTTR <1 día
- Medium performers: DF 1/mes-1/6meses, LT <1 semana, CFR 15-45%, MTTR <1 semana
- Low performers: DF <1/6meses, LT >1 semana, CFR >45%, MTTR >1 semana

Siempre proporciona recomendaciones específicas y priorizadas.

Formato de respuesta:
1. Resumen ejecutivo (2-3 líneas)
2. Análisis detallado con datos
3. Recomendaciones accionables (máximo 3, priorizadas)
4. Usa emojis para mejorar legibilidad

Tono: Profesional pero accesible, data-driven, constructivo.
`;

function resolveProviderStatus(): AIProviderStatus {
  const region = process.env.AWS_BEDROCK_REGION?.trim() || process.env.BEDROCK_REGION?.trim() || process.env.AWS_REGION?.trim() || null;
  const modelId = process.env.AWS_BEDROCK_MODEL_ID?.trim() || process.env.BEDROCK_MODEL_ID?.trim() || 'anthropic.claude-3-haiku-20240307-v1:0';

  // SDK mode: region is enough (credentials come from IRSA / env / instance profile)
  if (region) {
    return {
      mode: 'bedrock-sdk',
      ready: true,
      configured: true,
      missing: [],
      endpoint: null,
      region,
      modelId,
      notes: ['Bedrock SDK mode activo. Credenciales vía IRSA / environment.'],
    };
  }

  return {
    mode: 'mock',
    ready: false,
    configured: false,
    missing: ['AWS_BEDROCK_REGION o AWS_REGION'],
    endpoint: null,
    region: null,
    modelId: null,
    notes: ['IA en modo mock. Configura AWS_BEDROCK_REGION para activar Bedrock.'],
  };
}

class BedrockClient {
  private useMock: boolean;
  private status: AIProviderStatus;

  constructor() {
    this.status = resolveProviderStatus();
    this.useMock = !this.status.ready;

    if (this.useMock) {
      console.log(`⚠️ Bedrock client running in MOCK mode. Current mode: ${this.status.mode}.`);
    } else {
      console.log(`✓ Bedrock configured (region: ${this.status.region}, model: ${this.status.modelId})`);
    }
  }

  getStatus(): AIProviderStatus {
    this.status = resolveProviderStatus();
    this.useMock = !this.status.ready;
    return this.status;
  }

  async analyzeMetrics(context: MetricsContext): Promise<AIInsight[]> {
    if (this.useMock) {
      return this.mockAnalyzeMetrics(context);
    }

    try {
      const prompt = this.buildAnalysisPrompt(context);
      const response = await this.invokeModel(prompt, SYSTEM_PROMPT_METRICS_ANALYST);
      return this.parseInsights(response);
    } catch (error) {
      console.error('Bedrock analysis error:', error);
      return this.mockAnalyzeMetrics(context);
    }
  }

  async detectAnomalies(
    metrics: any[],
    context: { team?: string; projects: string[] }
  ): Promise<Anomaly[]> {
    if (this.useMock) {
      return this.mockDetectAnomalies(metrics, context);
    }

    try {
      const prompt = this.buildAnomalyPrompt(metrics, context);
      const response = await this.invokeModel(prompt, SYSTEM_PROMPT_METRICS_ANALYST);
      return this.parseAnomalies(response);
    } catch (error) {
      console.error('Bedrock anomaly detection error:', error);
      return this.mockDetectAnomalies(metrics, context);
    }
  }

  async chatWithMetrics(
    question: string,
    context: MetricsContext,
    history: ChatMessage[] = []
  ): Promise<string> {
    if (this.useMock) {
      return this.mockChatResponse(question, context);
    }

    try {
      const prompt = this.buildChatPrompt(question, context, history);
      const response = await this.invokeModel(prompt, SYSTEM_PROMPT_METRICS_ANALYST);
      return response;
    } catch (error) {
      console.error('Bedrock chat error:', error);
      return this.mockChatResponse(question, context);
    }
  }

  async assessRisk(deployment: {
    projectId: number;
    projectName: string;
    mrIid?: number;
    commitSha: string;
    changes: { additions: number; deletions: number };
    coverage?: number;
    reviewers: number;
    recentFailures: number;
  }): Promise<RiskAssessment> {
    if (this.useMock) {
      return this.mockAssessRisk(deployment);
    }

    try {
      const prompt = this.buildRiskPrompt(deployment);
      const response = await this.invokeModel(prompt, SYSTEM_PROMPT_METRICS_ANALYST);
      return this.parseRiskAssessment(response);
    } catch (error) {
      console.error('Bedrock risk assessment error:', error);
      return this.mockAssessRisk(deployment);
    }
  }

  async generateReport(
    period: string,
    teams: string[],
    metrics: any
  ): Promise<string> {
    if (this.useMock) {
      return this.mockGenerateReport(period, teams, metrics);
    }

    try {
      const prompt = this.buildReportPrompt(period, teams, metrics);
      const response = await this.invokeModel(prompt, SYSTEM_PROMPT_METRICS_ANALYST);
      return response;
    } catch (error) {
      console.error('Bedrock report generation error:', error);
      return this.mockGenerateReport(period, teams, metrics);
    }
  }

  private async invokeModel(prompt: string, systemPrompt: string): Promise<string> {
    const region = this.status.region || 'eu-west-1';
    const modelId = this.status.modelId || 'amazon.nova-lite-v1:0';
    const bedrockRoleArn = process.env.AWS_BEDROCK_ROLE_ARN?.trim() || null;

    let credentials: any = undefined;

    // Cross-account: assume role in the Bedrock account
    if (bedrockRoleArn) {
      const sts = new STSClient({ region });
      const assumed = await sts.send(new AssumeRoleCommand({
        RoleArn: bedrockRoleArn,
        RoleSessionName: 'portal-bedrock',
        DurationSeconds: 900,
      }));
      credentials = {
        accessKeyId: assumed.Credentials!.AccessKeyId!,
        secretAccessKey: assumed.Credentials!.SecretAccessKey!,
        sessionToken: assumed.Credentials!.SessionToken!,
      };
    }

    const client = new BedrockRuntimeClient({ region, credentials });

    const command = new ConverseCommand({
      modelId,
      system: [{ text: systemPrompt }],
      messages: [{ role: 'user', content: [{ text: prompt }] }],
      inferenceConfig: { maxTokens: 4096, temperature: 0.3 },
    });

    const response = await client.send(command);
    const outputContent = response.output?.message?.content || [];
    return outputContent
      .filter((b: any) => 'text' in b)
      .map((b: any) => b.text)
      .join('\n') || '';
  }

  private buildAnalysisPrompt(context: MetricsContext): string {
    return `
Analiza las siguientes métricas DORA${context.team ? ` del equipo "${context.team}"` : ''}:

Periodo: ${context.period}
Deployment Frequency: ${context.metrics.deploymentFreq.toFixed(2)}/día (cambio: ${context.metrics.deployFreqChange > 0 ? '+' : ''}${context.metrics.deployFreqChange.toFixed(1)}%)
Lead Time: ${context.metrics.leadTime.toFixed(2)}h (cambio: ${context.metrics.leadTimeChange > 0 ? '+' : ''}${context.metrics.leadTimeChange.toFixed(1)}%)
Change Failure Rate: ${context.metrics.cfr.toFixed(2)}% (cambio: ${context.metrics.cfrChange > 0 ? '+' : ''}${context.metrics.cfrChange.toFixed(1)}%)
MTTR: ${context.metrics.mttr.toFixed(2)}h (cambio: ${context.metrics.mttrChange > 0 ? '+' : ''}${context.metrics.mttrChange.toFixed(1)}%)

Contexto adicional:
- Proyectos activos: ${context.projects.length}
- Developers activos: ${context.developers}
- Deploys totales: ${context.totalDeploys}
- Incidentes: ${context.incidents}

Genera 3-5 insights accionables en formato JSON:
[
  {
    "type": "success|warning|info|danger",
    "title": "Título corto",
    "message": "Mensaje detallado con datos específicos",
    "priority": 1-5,
    "actionable": { "label": "Acción sugerida", "action": "url o comando" }
  }
]
`;
  }

  private buildAnomalyPrompt(metrics: any[], context: any): string {
    return `
Analiza estas métricas temporales y detecta anomalías:

${JSON.stringify(metrics, null, 2)}

Contexto: ${JSON.stringify(context, null, 2)}

Identifica patrones anómalos y genera alertas en formato JSON.
`;
  }

  private buildChatPrompt(
    question: string,
    context: MetricsContext,
    history: ChatMessage[]
  ): string {
    const historyText = history
      .map((msg) => `${msg.role}: ${msg.content}`)
      .join('\n');

    return `
Contexto de métricas:
${JSON.stringify(context, null, 2)}

Historial de conversación:
${historyText}

Usuario: ${question}

Responde de forma conversacional, usando los datos del contexto.
`;
  }

  private buildRiskPrompt(deployment: any): string {
    return `
Evalúa el riesgo de este deployment:

${JSON.stringify(deployment, null, 2)}

Genera un risk assessment en formato JSON con nivel, probabilidad, razones y recomendaciones.
`;
  }

  private buildReportPrompt(period: string, teams: string[], metrics: any): string {
    return `
Genera un reporte ejecutivo para el periodo ${period}:

Teams: ${teams.join(', ')}
Métricas: ${JSON.stringify(metrics, null, 2)}

Formato: Markdown con secciones de highlights, concerns, top contributors y recommendations.
`;
  }

  // ============ MOCK IMPLEMENTATIONS ============

  private mockAnalyzeMetrics(context: MetricsContext): AIInsight[] {
    const insights: AIInsight[] = [];

    // Deployment Frequency analysis
    if (context.metrics.deployFreqChange > 10) {
      insights.push({
        type: 'success',
        title: '🚀 Excelente velocidad de deployment',
        message: `Tu deployment frequency aumentó un ${context.metrics.deployFreqChange.toFixed(1)}% hasta ${context.metrics.deploymentFreq.toFixed(2)} deploys/día. ${context.metrics.deploymentFreq > 1 ? 'Estás en el nivel Elite (top 7%).' : 'Sigue así para alcanzar el nivel Elite (>1/día).'}`,
        priority: 1,
      });
    } else if (context.metrics.deployFreqChange < -10) {
      insights.push({
        type: 'warning',
        title: '⚠️ Deployment frequency bajó',
        message: `La frecuencia de deploys cayó un ${Math.abs(context.metrics.deployFreqChange).toFixed(1)}%. Posibles causas: code freeze, vacaciones del equipo, o incidentes que bloquearon deploys. Revisa la actividad de los últimos días.`,
        priority: 2,
      });
    }

    // Change Failure Rate analysis
    if (context.metrics.cfr > 15) {
      insights.push({
        type: 'danger',
        title: '🔴 Change Failure Rate elevado',
        message: `Tu CFR es ${context.metrics.cfr.toFixed(1)}% (objetivo: <5% para Elite, <15% para High). Con ${context.incidents} incidentes en ${context.totalDeploys} deploys. Recomiendo: aumentar cobertura de tests, implementar feature flags, y evitar deploys los viernes.`,
        priority: 1,
        actionable: {
          label: 'Ver proyectos con más fallos',
          action: '/metrics/projects?sortBy=cfr',
        },
      });
    } else if (context.metrics.cfr < 5) {
      insights.push({
        type: 'success',
        title: '✅ Excelente estabilidad',
        message: `Tu CFR de ${context.metrics.cfr.toFixed(1)}% está en nivel Elite. Solo ${context.incidents} incidentes en ${context.totalDeploys} deploys. El equipo está haciendo un trabajo excepcional en calidad.`,
        priority: 3,
      });
    }

    // Lead Time analysis
    if (context.metrics.leadTime < 1) {
      insights.push({
        type: 'success',
        title: '⚡ Lead time excepcional',
        message: `Lead time de ${context.metrics.leadTime.toFixed(2)} horas (nivel Elite). Los cambios llegan a producción en menos de 1 hora. Esto indica un pipeline altamente optimizado.`,
        priority: 2,
      });
    } else if (context.metrics.leadTime > 24) {
      insights.push({
        type: 'info',
        title: '📊 Lead time puede mejorar',
        message: `Lead time de ${context.metrics.leadTime.toFixed(2)} horas. Para alcanzar nivel Elite (<1h), considera: automatizar más pasos del pipeline, implementar feature flags para desacoplar deploy de release, y reducir el tamaño de los cambios.`,
        priority: 3,
        actionable: {
          label: 'Ver deployment traces',
          action: '/metrics/traces',
        },
      });
    }

    // MTTR analysis
    if (context.metrics.mttr > 1 && context.incidents > 0) {
      insights.push({
        type: 'warning',
        title: '⏱️ MTTR puede mejorar',
        message: `MTTR de ${context.metrics.mttr.toFixed(2)} horas. Para nivel Elite (<1h), recomiendo: implementar automated rollback, mejorar monitoring/alerting, y tener runbooks actualizados para incidentes comunes.`,
        priority: 2,
      });
    }

    // Team performance summary
    const performanceLevel = this.calculatePerformanceLevel(context.metrics);
    insights.push({
      type: performanceLevel === 'Elite' ? 'success' : 'info',
      title: `📈 Nivel de performance: ${performanceLevel}`,
      message: this.getPerformanceMessage(performanceLevel, context),
      priority: 4,
    });

    return insights.sort((a, b) => a.priority - b.priority);
  }

  private mockDetectAnomalies(metrics: any[], context: any): Anomaly[] {
    const anomalies: Anomaly[] = [];

    // Simulate anomaly detection
    if (metrics.length > 7) {
      const recent = metrics.slice(-3);
      const previous = metrics.slice(-10, -3);

      const recentAvg = recent.reduce((sum, m) => sum + (m.value || 0), 0) / recent.length;
      const previousAvg = previous.reduce((sum, m) => sum + (m.value || 0), 0) / previous.length;

      if (recentAvg > previousAvg * 2) {
        anomalies.push({
          metric: 'MTTR',
          severity: 'high',
          description: `MTTR aumentó de ${previousAvg.toFixed(2)}h a ${recentAvg.toFixed(2)}h en los últimos 3 días (${((recentAvg / previousAvg - 1) * 100).toFixed(0)}% de incremento).`,
          detectedAt: new Date().toISOString(),
          affectedProjects: context.projects.slice(0, 2),
          suggestedAction: 'Revisar los deployment traces de los últimos incidentes para identificar patrones comunes.',
          confidence: 0.87,
        });
      }
    }

    return anomalies;
  }

  private mockChatResponse(question: string, context: MetricsContext): string {
    const lowerQ = question.toLowerCase();

    if (lowerQ.includes('por qué') || lowerQ.includes('porque')) {
      if (lowerQ.includes('bajó') || lowerQ.includes('bajo') || lowerQ.includes('cayó')) {
        return `Analicé los datos y encontré ${Math.floor(Math.random() * 3) + 1} factores principales:\n\n1. **Actividad del equipo**: ${context.developers} developers activos en el periodo, posiblemente algunos en vacaciones o enfocados en otros proyectos.\n\n2. **Distribución de proyectos**: De ${context.projects.length} proyectos, algunos pueden estar en fase de planificación o code freeze.\n\n3. **Incidentes**: ${context.incidents} incidentes registrados que pudieron bloquear deploys temporalmente.\n\n¿Quieres que profundice en algún aspecto específico?`;
      }
      if (lowerQ.includes('subió') || lowerQ.includes('aumentó')) {
        return `¡Buena pregunta! El aumento se debe principalmente a:\n\n1. **Mayor actividad**: ${context.totalDeploys} deploys en el periodo, indicando un equipo muy activo.\n\n2. **Mejoras en el proceso**: El cambio de ${context.metrics.deployFreqChange > 0 ? '+' : ''}${context.metrics.deployFreqChange.toFixed(1)}% sugiere optimizaciones en el pipeline.\n\n3. **Momentum del equipo**: ${context.developers} developers contribuyendo activamente.\n\n¿Te gustaría ver qué proyectos contribuyeron más?`;
      }
    }

    if (lowerQ.includes('cómo') || lowerQ.includes('como')) {
      if (lowerQ.includes('mejorar')) {
        return `Para mejorar tus métricas DORA, te recomiendo:\n\n**Deployment Frequency** (actual: ${context.metrics.deploymentFreq.toFixed(2)}/día):\n- Reduce el tamaño de los cambios (small batches)\n- Implementa feature flags\n- Automatiza más pasos del pipeline\n\n**Lead Time** (actual: ${context.metrics.leadTime.toFixed(2)}h):\n- Paraleliza tests\n- Reduce dependencias entre servicios\n- Implementa trunk-based development\n\n**Change Failure Rate** (actual: ${context.metrics.cfr.toFixed(1)}%):\n- Aumenta cobertura de tests\n- Implementa canary deployments\n- Mejora code review process\n\n¿Quieres que profundice en alguna métrica específica?`;
      }
    }

    if (lowerQ.includes('comparar') || lowerQ.includes('vs') || lowerQ.includes('versus')) {
      return `Comparando con los benchmarks de DORA 2024:\n\n**Tu equipo**:\n- Deployment Frequency: ${context.metrics.deploymentFreq.toFixed(2)}/día\n- Lead Time: ${context.metrics.leadTime.toFixed(2)}h\n- CFR: ${context.metrics.cfr.toFixed(1)}%\n- MTTR: ${context.metrics.mttr.toFixed(2)}h\n\n**Nivel**: ${this.calculatePerformanceLevel(context.metrics)}\n\n**Elite threshold**:\n- DF: >1/día ${context.metrics.deploymentFreq > 1 ? '✅' : '⚠️'}\n- LT: <1h ${context.metrics.leadTime < 1 ? '✅' : '⚠️'}\n- CFR: <5% ${context.metrics.cfr < 5 ? '✅' : '⚠️'}\n- MTTR: <1h ${context.metrics.mttr < 1 ? '✅' : '⚠️'}\n\n¿Quieres un plan para alcanzar el nivel Elite?`;
    }

    // Default response
    return `Basándome en tus métricas actuales:\n\n- **${context.totalDeploys} deploys** en el periodo\n- **${context.developers} developers** activos\n- **${context.projects.length} proyectos** en seguimiento\n- **${context.incidents} incidentes** registrados\n\nTu equipo está en nivel **${this.calculatePerformanceLevel(context.metrics)}**.\n\n¿Hay algo específico que quieras saber? Puedo ayudarte con:\n- Análisis de tendencias\n- Comparación con benchmarks\n- Recomendaciones de mejora\n- Detalles de proyectos específicos`;
  }

  private mockAssessRisk(deployment: any): RiskAssessment {
    let riskScore = 0;
    const reasons: string[] = [];
    const recommendations: string[] = [];

    // Analyze change size
    const totalChanges = deployment.changes.additions + deployment.changes.deletions;
    if (totalChanges > 500) {
      riskScore += 30;
      reasons.push(`Cambio grande: ${totalChanges} líneas modificadas (2x el promedio)`);
      recommendations.push('Considera dividir el MR en cambios más pequeños');
    }

    // Analyze coverage
    if (deployment.coverage && deployment.coverage < 70) {
      riskScore += 25;
      reasons.push(`Cobertura baja: ${deployment.coverage}% (objetivo: >80%)`);
      recommendations.push('Añade tests antes de mergear');
    }

    // Analyze reviewers
    if (deployment.reviewers < 2) {
      riskScore += 20;
      reasons.push('Solo 1 reviewer (recomendado: 2+)');
      recommendations.push('Solicita review de un senior engineer');
    }

    // Analyze recent failures
    if (deployment.recentFailures > 2) {
      riskScore += 25;
      reasons.push(`${deployment.recentFailures} fallos recientes en este proyecto`);
      recommendations.push('Revisa los logs de fallos anteriores antes de deployar');
    }

    const level: RiskAssessment['level'] =
      riskScore > 70 ? 'critical' : riskScore > 50 ? 'high' : riskScore > 30 ? 'medium' : 'low';

    if (reasons.length === 0) {
      reasons.push('Cambio pequeño y bien revisado');
      reasons.push('Cobertura de tests adecuada');
      reasons.push('Sin fallos recientes en el proyecto');
    }

    if (recommendations.length === 0) {
      recommendations.push('El deployment parece seguro, procede con confianza');
      recommendations.push('Monitorea las métricas post-deploy');
    }

    return {
      level,
      probability: Math.min(riskScore, 95),
      reasons,
      recommendations,
      historicalSimilarities: [
        {
          date: '2026-02-15',
          outcome: riskScore > 50 ? 'failed' : 'success',
          similarity: 0.78,
        },
      ],
    };
  }

  private mockGenerateReport(period: string, teams: string[], metrics: any): string {
    return `# 📊 Engineering Report - ${period}

## 🚀 Highlights

- Deployed **${metrics.totalDeploys || 0}** changes across **${teams.length}** teams
- **${metrics.incidents || 0}** production incidents (${metrics.cfr?.toFixed(1) || 0}% failure rate)
- Lead time: **${metrics.leadTime?.toFixed(2) || 0}** hours (${metrics.leadTimeChange > 0 ? '↑' : '↓'}${Math.abs(metrics.leadTimeChange || 0).toFixed(1)}%)

## ⚠️ Areas of Concern

${metrics.cfr > 10 ? `- Change Failure Rate at ${metrics.cfr.toFixed(1)}% (target: <5%)` : ''}
${metrics.mttr > 2 ? `- MTTR at ${metrics.mttr.toFixed(2)} hours (target: <1h)` : ''}
${metrics.leadTime > 24 ? `- Lead time above 24 hours` : ''}

## 📈 Recommendations

1. ${metrics.cfr > 10 ? 'Increase test coverage and implement feature flags' : 'Maintain current quality standards'}
2. ${metrics.leadTime > 24 ? 'Optimize CI/CD pipeline to reduce lead time' : 'Continue with current deployment practices'}
3. ${metrics.mttr > 2 ? 'Improve monitoring and implement automated rollback' : 'Keep up the excellent incident response'}

---
*Generated by AI on ${new Date().toISOString()}*
`;
  }

  private calculatePerformanceLevel(metrics: any): string {
    const { deploymentFreq, leadTime, cfr, mttr } = metrics;

    const isElite =
      deploymentFreq > 1 && leadTime < 1 && cfr < 5 && mttr < 1;
    const isHigh =
      deploymentFreq >= 0.14 && leadTime < 24 && cfr < 15 && mttr < 24;
    const isMedium =
      deploymentFreq >= 0.03 && leadTime < 168 && cfr < 45 && mttr < 168;

    if (isElite) return 'Elite';
    if (isHigh) return 'High';
    if (isMedium) return 'Medium';
    return 'Low';
  }

  private getPerformanceMessage(level: string, context: MetricsContext): string {
    switch (level) {
      case 'Elite':
        return `¡Felicidades! Tu equipo está en el top 7% de la industria. Con ${context.totalDeploys} deploys y solo ${context.incidents} incidentes, demuestran excelencia operacional.`;
      case 'High':
        return `Tu equipo está en el top 25%. Estás cerca del nivel Elite. Enfócate en: ${context.metrics.cfr > 5 ? 'reducir CFR' : context.metrics.leadTime > 1 ? 'optimizar lead time' : 'mantener el momentum'}.`;
      case 'Medium':
        return `Tu equipo está en el top 50%. Hay oportunidades claras de mejora en: ${context.metrics.deploymentFreq < 0.14 ? 'deployment frequency' : 'change failure rate'}. Implementa las recomendaciones para subir de nivel.`;
      default:
        return `Hay mucho margen de mejora. Prioriza: automatización del pipeline, reducción del tamaño de cambios, y mejora en testing. El equipo puede alcanzar niveles superiores con las prácticas correctas.`;
    }
  }

  private parseInsights(response: string): AIInsight[] {
    try {
      return JSON.parse(response);
    } catch {
      return [];
    }
  }

  private parseAnomalies(response: string): Anomaly[] {
    try {
      return JSON.parse(response);
    } catch {
      return [];
    }
  }

  private parseRiskAssessment(response: string): RiskAssessment {
    try {
      return JSON.parse(response);
    } catch {
      return {
        level: 'low',
        probability: 0,
        reasons: [],
        recommendations: [],
        historicalSimilarities: [],
      };
    }
  }
}

export const bedrockClient = new BedrockClient();
