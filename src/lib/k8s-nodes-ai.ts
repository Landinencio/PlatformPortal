/**
 * AI-powered nodegroup analysis. Sends NG snapshot + pod composition + AWS
 * pricing context to Bedrock Sonnet 4 and asks for a deterministic, validated
 * recommendation at NODEGROUP level (not per node).
 *
 * The model receives the candidate types we have already validated as fitting
 * (from the deterministic engine in k8s-nodes.ts). It chooses the best one and
 * justifies it; it cannot invent a target type that doesn't fit.
 */

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  fetchNodegroup,
  INSTANCE_CATALOG,
  findInstance,
  type NodegroupAnalysis,
  type InstanceSpec,
  HOURS_PER_MONTH,
} from "@/lib/k8s-nodes";

const BEDROCK_REGION = process.env.AWS_BEDROCK_REGION || "eu-west-1";
// Use the FinOps chat model since this is a similar analysis task and we
// already validated the role chain for it.
const BEDROCK_MODEL = process.env.FINOPS_CHAT_MODEL_ID
  || process.env.AWS_BEDROCK_MODEL_ID
  || "eu.anthropic.claude-sonnet-4-20250514-v1:0";

export interface AiNodeRecommendation {
  cluster: string;
  nodegroup: string;
  modelId: string;
  generatedAt: string;
  // The structured output the model returns (parsed from the markdown response)
  // along with the raw markdown for the UI to render.
  raw: string;
  /** Plain-text "headline" extracted from the response (first non-empty line). */
  headline: string;
}

const SYSTEM_PROMPT = `Eres un consultor FinOps senior especializado en Kubernetes/EKS en AWS, con 10+ años optimizando coste de clusters productivos.

Tu trabajo es analizar UN nodegroup de EKS (managed node group, una única instance type por NG) y proponer una recomendación CONCRETA y SEGURA para reducir coste sin comprometer carga.

Reglas obligatorias:
1. Una recomendación a nivel NODEGROUP, no por nodo individual. EKS managed node groups tienen una única instance type — no se cambia un nodo en aislado.
2. Si propones bajar de tipo, asegúrate de que TODOS los pods caben en la instancia más pequeña (validación: el pod más grande debe caber con 30% margen, y la suma de requests * 1.3 < capacidad agregada del nuevo NG).
3. Considera spot solo para workloads tolerantes (jobs, dev/uat, replicas no-críticas).
4. Si hay HPA y el NG está al límite, NO recomiendes bajar — riesgo de pressure cuando el HPA escala.
5. Sé transparente con los blockers: si algo descarta una opción, dilo.
6. NUNCA inventes precios — solo usa los que recibes en el contexto.
7. Estructura tu respuesta en markdown:
   - **Recomendación principal** (1 línea)
   - **Por qué**: razonamiento corto, 2-3 líneas
   - **Plan de migración**: 3-5 pasos accionables (canary, drain, etc.)
   - **Riesgos y mitigaciones**: bullets
   - **Ahorro estimado**: cifra USD/mes con cálculo
8. Usa nombres reales de instance types (m6i.large, r6i.xlarge, etc.) y respeta la familia: si están en m7i, no propongas m5; si están en r6i, no propongas m6i (RAM ratio distinta).`;

interface BedrockCallOptions {
  maxTokens?: number;
  temperature?: number;
}

async function callBedrock(prompt: string, opts: BedrockCallOptions = {}): Promise<string> {
  const skipRole = process.env.FINOPS_ADVISOR_SKIP_ROLE?.trim() === "true";
  const bedrockRoleArn = skipRole
    ? null
    : (process.env.FINOPS_ADVISOR_ROLE_ARN?.trim()
      || process.env.AWS_BEDROCK_ROLE_ARN?.trim()
      || null);

  let credentials: any = undefined;
  if (bedrockRoleArn) {
    const sts = new STSClient({ region: BEDROCK_REGION });
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: bedrockRoleArn,
      RoleSessionName: "portal-k8s-nodes-ai",
      DurationSeconds: 900,
    }));
    credentials = {
      accessKeyId: assumed.Credentials!.AccessKeyId!,
      secretAccessKey: assumed.Credentials!.SecretAccessKey!,
      sessionToken: assumed.Credentials!.SessionToken!,
    };
  }

  const client = new BedrockRuntimeClient({ region: BEDROCK_REGION, credentials });
  const command = new ConverseCommand({
    modelId: BEDROCK_MODEL,
    system: [{ text: SYSTEM_PROMPT }],
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: {
      maxTokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.2,
    },
  });

  const response = await client.send(command);
  const outputContent = response.output?.message?.content || [];
  return outputContent
    .filter((block: any) => "text" in block)
    .map((block: any) => block.text)
    .join("\n") || "";
}

// ──────────────────────────────────────────────────────────────────────────
// Prompt builder
// ──────────────────────────────────────────────────────────────────────────

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GiB`;
  return `${Math.round(bytes / 1024 ** 2)}MiB`;
}

function fmtCpu(cores: number): string {
  if (cores >= 1) return `${cores.toFixed(2)} cores`;
  return `${Math.round(cores * 1000)}m`;
}

function buildPrompt(g: NodegroupAnalysis, candidates: InstanceSpec[]): string {
  const current = findInstance(g.primaryInstanceType);

  const lines: string[] = [];
  lines.push(`## Nodegroup: ${g.nodegroup} (cluster ${g.cluster})`);
  lines.push("");
  lines.push(`**Composición actual:**`);
  lines.push(`- ${g.nodeCount} nodos · tipo principal **${g.primaryInstanceType}** (${current ? `${current.cpu}vCPU / ${current.memGb}GiB · ~$${current.approxOnDemandUsdHour.toFixed(3)}/h on-demand` : "tipo no en catálogo"})`);
  if (g.spotCount > 0) {
    lines.push(`- ${g.spotCount} de los nodos son Spot.`);
  }
  if (Object.keys(g.instanceTypes).length > 1) {
    lines.push(`- Mezcla detectada: ${Object.entries(g.instanceTypes).map(([t, n]) => `${t}×${n}`).join(", ")}`);
  }
  lines.push(`- **Coste actual: $${g.totalCostMonthly.toFixed(0)}/mes**`);
  lines.push("");
  lines.push(`**Capacidad agregada del NG:**`);
  lines.push(`- CPU allocatable: ${fmtCpu(g.totalCpuAllocatable)} · requested: ${fmtCpu(g.totalCpuRequested)} (${g.avgCpuRequestPct.toFixed(1)}%) · uso p95 24h: ${fmtCpu(g.peakCpuUsedP95)} (${g.avgCpuUsagePct.toFixed(1)}%)`);
  lines.push(`- RAM allocatable: ${fmtBytes(g.totalRamAllocatable)} · requested: ${fmtBytes(g.totalRamRequestedBytes)} (${g.avgRamRequestPct.toFixed(1)}%) · uso p95 24h: ${fmtBytes(g.peakRamUsedP95Bytes)} (${g.avgRamUsagePct.toFixed(1)}%)`);
  lines.push("");
  lines.push(`**Pods:**`);
  lines.push(`- Total de pods en el NG: ${g.nodes.reduce((s, n) => s + n.podCount, 0)}`);
  lines.push(`- Pod más grande: ${fmtCpu(g.maxPodCpuRequest)} CPU / ${fmtBytes(g.maxPodRamRequest)} RAM (factor limitante para downsize)`);
  lines.push("");

  if (candidates.length > 0) {
    lines.push(`**Tipos de instancia candidatos (validados por el motor determinista — los pods caben con 30% margen):**`);
    for (const c of candidates) {
      const monthly = c.approxOnDemandUsdHour * HOURS_PER_MONTH;
      lines.push(`- \`${c.type}\` · ${c.cpu}vCPU / ${c.memGb}GiB · ~$${monthly.toFixed(0)}/mes/nodo (on-demand) · gen ${c.generation}`);
    }
    lines.push("");
  } else {
    lines.push(`**Tipos candidatos:** ninguno encontrado dentro de la familia ${current?.family ?? "?"} que sea más pequeño y donde quepan todos los pods.`);
    lines.push("");
  }

  lines.push(`**Recomendación del motor determinista (referencia, puedes mejorarla):**`);
  lines.push(`- ${g.recommendation.headline}`);
  lines.push(`- ${g.recommendation.detail}`);
  if (g.recommendation.blockers.length > 0) {
    lines.push(`- Blockers detectados: ${g.recommendation.blockers.join("; ")}`);
  }
  lines.push("");
  lines.push(`---`);
  lines.push(``);
  lines.push(`**Tu tarea:** Da una recomendación final accionable a nivel nodegroup. Si el motor determinista ya acertó, valida y enriquécela con el plan de migración. Si propones algo distinto, justifica con datos del contexto. Cifra el ahorro mensual con los precios de arriba.`);

  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// Public API
// ──────────────────────────────────────────────────────────────────────────

export async function analyzeNodegroupWithAI(cluster: string, nodegroup: string): Promise<AiNodeRecommendation> {
  const g = await fetchNodegroup(cluster, nodegroup);
  if (!g) {
    throw new Error(`Nodegroup ${nodegroup} no encontrado en ${cluster}`);
  }

  // Pre-filter candidate types — same logic as deterministic engine but expose all.
  const current = findInstance(g.primaryInstanceType);
  let candidates: InstanceSpec[] = [];
  if (current) {
    candidates = INSTANCE_CATALOG
      .filter((i) => i.family === current.family && i.cpu < current.cpu)
      .sort((a, b) => b.cpu - a.cpu);
  }

  const prompt = buildPrompt(g, candidates);
  const raw = await callBedrock(prompt, { maxTokens: 4096, temperature: 0.2 });

  // First non-empty line as headline
  const firstLine = raw.split("\n").map((l) => l.replace(/^#+\s*/, "").trim()).find((l) => l.length > 0) ?? "Análisis completado";

  return {
    cluster,
    nodegroup,
    modelId: BEDROCK_MODEL,
    generatedAt: new Date().toISOString(),
    raw,
    headline: firstLine,
  };
}
