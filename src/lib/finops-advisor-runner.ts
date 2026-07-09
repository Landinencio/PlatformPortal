import { fetchInventory } from "@/lib/aws-inventory";
import { collectMetricsForAccount } from "@/lib/aws-cloudwatch-metrics";
import { buildFinOpsPrompt, getFinOpsSystemPrompt, type FinOpsAdvisorInput } from "@/lib/finops-advisor";
import {
  buildFinOpsAdvisorInsights,
  type FinOpsAdvisorCollectionIssue,
  type FinOpsAdvisorCosts,
  type FinOpsAdvisorInsights,
} from "@/lib/finops-advisor-insights";
import type { CurResourceCost } from "@/lib/finops-resource-costs";
import { AWS_ACCOUNT_NAMES } from "@/lib/aws-accounts";
import { buildAwsAccountNameMap, fetchAwsAccountCatalog, filterLiveAwsAccounts } from "@/lib/aws-account-catalog";
import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

const OLLAMA_API = "http://ollama.ollama.svc.cluster.local:11434";
const FINOPS_ATHENA_LAMBDA_URL = process.env.FINOPS_ATHENA_LAMBDA_URL || "https://jzcrsycqa2plblvxdeck37r6am0kxeqw.lambda-url.eu-north-1.on.aws/";

const BEDROCK_REGION = process.env.AWS_BEDROCK_REGION || process.env.BEDROCK_REGION || "eu-west-1";
const BEDROCK_MODEL = process.env.FINOPS_ADVISOR_MODEL_ID || process.env.AWS_BEDROCK_MODEL_ID || "anthropic.claude-sonnet-4-20250514-v1:0";
const USE_BEDROCK = process.env.FINOPS_USE_BEDROCK !== "false";

export type FinOpsAdvisorStage =
  | "queued"
  | "fetching_inventory"
  | "collecting_metrics"
  | "fetching_costs"
  | "building_prompt"
  | "generating_report"
  | "completed"
  | "failed";

export interface FinOpsAdvisorProgress {
  stage: FinOpsAdvisorStage;
  progressPct: number;
  message: string;
}

export interface FinOpsAdvisorRunInput {
  accountIds: string[];
  includeMetrics: boolean;
  includeCosts: boolean;
  metricsDays: number;
  startDate: string;
  endDate: string;
  model: string;
  locale: string;
}

export interface FinOpsAdvisorRunResult {
  analysis: string;
  model: string;
  provider: "bedrock" | "ollama";
  promptTokens: number;
  metricsCollected: number;
  metricsDays: number;
  costsIncluded: boolean;
  costWindow: { startDate: string; endDate: string } | null;
  inventorySummary: {
    totalResources: number;
    accounts: number;
    services: number;
  };
  insights: FinOpsAdvisorInsights;
  warnings: string[];
  timestamp: string;
}

function isIsoDate(input: unknown): input is string {
  return typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input);
}

function getDefaultCostWindow() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return {
    startDate: `${year}-${month}-01`,
    endDate: `${year}-${month}-${day}`,
  };
}

function parseAthenaPayload(payload: unknown): any {
  if (typeof payload !== "object" || payload === null) {
    return {};
  }

  const maybeWrapped = payload as { body?: unknown };
  if (typeof maybeWrapped.body === "string") {
    try {
      return JSON.parse(maybeWrapped.body);
    } catch {
      return {};
    }
  }

  if (typeof maybeWrapped.body === "object" && maybeWrapped.body !== null) {
    return maybeWrapped.body;
  }

  return payload;
}

async function callOllama(prompt: string, model: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 240_000);

  const response = await fetch(`${OLLAMA_API}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: true,
      options: { temperature: 0.3, num_predict: 4096 },
    }),
    signal: controller.signal,
  });

  clearTimeout(timeout);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Ollama returned ${response.status}: ${errText}`);
  }

  let fullResponse = "";
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const chunk = JSON.parse(line);
        if (chunk.response) fullResponse += chunk.response;
      } catch {
        // Ignore malformed JSON chunks
      }
    }
  }

  if (buffer.trim()) {
    try {
      const chunk = JSON.parse(buffer);
      if (chunk.response) fullResponse += chunk.response;
    } catch {
      // Ignore malformed final chunk
    }
  }

  return fullResponse;
}

async function callBedrock(prompt: string, systemPrompt?: string): Promise<string> {
  // Skip cross-account role if FINOPS_ADVISOR_SKIP_ROLE=true (use pod IRSA credentials directly)
  const skipRole = process.env.FINOPS_ADVISOR_SKIP_ROLE?.trim() === "true";
  const bedrockRoleArn = skipRole ? null : (process.env.FINOPS_ADVISOR_ROLE_ARN?.trim() || process.env.AWS_BEDROCK_ROLE_ARN?.trim() || null);
  let credentials: any = undefined;

  if (bedrockRoleArn) {
    const sts = new STSClient({ region: BEDROCK_REGION });
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: bedrockRoleArn,
      RoleSessionName: "portal-finops-bedrock",
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
    system: systemPrompt ? [{ text: systemPrompt }] : undefined,
    messages: [{ role: "user", content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens: 8192, temperature: 0.2 },
  });

  const response = await client.send(command);
  const outputContent = response.output?.message?.content || [];

  return outputContent
    .filter((block: any) => "text" in block)
    .map((block: any) => block.text)
    .join("\n") || "";
}

async function fetchCurCosts(
  accountIds: string[],
  startDate: string,
  endDate: string,
  accountNameMap: Record<string, string>,
): Promise<FinOpsAdvisorCosts | null> {
  const response = await fetch(FINOPS_ATHENA_LAMBDA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: {
        accountIds: accountIds.join(","),
        startDate,
        endDate,
        includeTrends: false,
        includeResourceCosts: true,
        resourceCostLimit: 1500,
      },
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Athena lambda returned ${response.status}: ${text}`);
  }

  const rawPayload = await response.json();
  const payload = parseAthenaPayload(rawPayload);
  const accountRows = Array.isArray(payload.accounts) ? payload.accounts : [];

  const byAccount = accountRows.map((row: any) => ({
    accountId: String(row.accountId || ""),
    accountName: String(
      row.accountName ||
      accountNameMap[String(row.accountId || "")] ||
      AWS_ACCOUNT_NAMES[String(row.accountId || "")] ||
      row.accountId ||
      "Unknown",
    ),
    cost: Number(row.totalCost || 0),
  }))
    .filter((row: any) => row.accountId && Number.isFinite(row.cost))
    .sort((a: any, b: any) => b.cost - a.cost);

  const serviceMap = new Map<string, number>();
  for (const row of accountRows) {
    const services = Array.isArray(row.services) ? row.services : [];
    for (const service of services) {
      const name = String(service.name || "Unknown");
      const cost = Number(service.cost || 0);
      if (!Number.isFinite(cost)) continue;
      serviceMap.set(name, (serviceMap.get(name) || 0) + cost);
    }
  }

  const byService = [...serviceMap.entries()]
    .map(([service, cost]) => ({ service, cost }))
    .sort((a, b) => b.cost - a.cost);

  const summaryTotal = Number(payload?.summary?.totalCost || 0);
  const totalCost = Number.isFinite(summaryTotal) && summaryTotal > 0
    ? summaryTotal
    : byAccount.reduce((sum: number, row: any) => sum + row.cost, 0);
  const resourceCosts = (Array.isArray(payload.resourceCosts) ? payload.resourceCosts : [])
    .map((row: any): CurResourceCost | null => {
      const accountId = String(row.accountId || row.account_id || "");
      const resourceId = String(row.resourceId || row.resource_id || "");
      const service = String(row.service || "Unknown");
      const cost = Number(row.cost || 0);
      const lineItems = Number(row.lineItems || row.line_items || 0);
      if (!accountId || !resourceId || !Number.isFinite(cost) || cost <= 0) {
        return null;
      }
      return {
        accountId,
        service,
        resourceId,
        cost,
        lineItems: Number.isFinite(lineItems) && lineItems > 0 ? Math.round(lineItems) : undefined,
      };
    })
    .filter((row: CurResourceCost | null): row is CurResourceCost => Boolean(row));

  if (totalCost <= 0) {
    return null;
  }

  return {
    totalCost,
    byAccount,
    byService,
    resourceCosts,
    executive: payload.executive || null,
  };
}

export async function normalizeFinOpsAdvisorInput(rawBody: unknown): Promise<FinOpsAdvisorRunInput> {
  const body = (typeof rawBody === "object" && rawBody !== null ? rawBody : {}) as any;
  const defaultWindow = getDefaultCostWindow();

  const accountIds = Array.isArray(body.accountIds) && body.accountIds.length > 0
    ? body.accountIds.map((item: unknown) => String(item)).filter(Boolean)
    : filterLiveAwsAccounts(await fetchAwsAccountCatalog()).map((account) => account.id);
  const includeMetrics = body.includeMetrics !== false;
  const includeCosts = body.includeCosts !== false;
  const metricsDays = Number.isFinite(body.metricsDays) ? Math.min(30, Math.max(3, Math.round(body.metricsDays))) : 14;
  const startDate = isIsoDate(body.startDate) ? body.startDate : defaultWindow.startDate;
  const endDate = isIsoDate(body.endDate) ? body.endDate : defaultWindow.endDate;
  const model = typeof body.model === "string" && body.model.trim().length > 0 ? body.model.trim() : "deepseek-r1:8b";

  if (startDate > endDate) {
    throw new Error("Invalid date range. startDate must be <= endDate.");
  }

  const locale = typeof body.locale === "string" && ["es", "en", "fr", "pt"].includes(body.locale) ? body.locale : "es";

  return {
    accountIds,
    includeMetrics,
    includeCosts,
    metricsDays,
    startDate,
    endDate,
    model,
    locale,
  };
}

export async function runFinOpsAdvisorAnalysis(
  input: FinOpsAdvisorRunInput,
  onProgress?: (progress: FinOpsAdvisorProgress) => Promise<void> | void,
): Promise<FinOpsAdvisorRunResult> {
  const warnings: string[] = [];
  const collectionIssues: FinOpsAdvisorCollectionIssue[] = [];

  const emitProgress = async (stage: FinOpsAdvisorStage, progressPct: number, message: string) => {
    if (!onProgress) return;
    await onProgress({ stage, progressPct: Math.max(0, Math.min(100, progressPct)), message });
  };

  await emitProgress("fetching_inventory", 10, "Recopilando inventario AWS multi-cuenta...");
  const accountCatalog = await fetchAwsAccountCatalog();
  const accountNameMap = buildAwsAccountNameMap(accountCatalog);
  const inventory = await fetchInventory(input.accountIds, { accountNameMap });

  let allMetrics: FinOpsAdvisorInput["metrics"] = [];
  if (input.includeMetrics) {
    await emitProgress("collecting_metrics", 28, "Recopilando métricas CloudWatch (avg/p95/max)...");
    const BATCH = 3;
    const totalBatches = Math.max(1, Math.ceil(inventory.accounts.length / BATCH));

    for (let i = 0; i < inventory.accounts.length; i += BATCH) {
      const batch = inventory.accounts.slice(i, i + BATCH);
      const batchResults = await Promise.allSettled(
        batch.map((account) => collectMetricsForAccount(account.accountId, account.services, input.metricsDays)),
      );
      for (let index = 0; index < batchResults.length; index++) {
        const result = batchResults[index];
        const account = batch[index];
        if (result.status === "fulfilled") {
          allMetrics.push(...result.value);
        } else {
          collectionIssues.push({
            accountId: account.accountId,
            accountName: account.accountName,
            area: "metrics",
            reason: result.reason instanceof Error ? result.reason.message : "Error desconocido en métricas",
          });
        }
      }

      const batchIndex = Math.floor(i / BATCH) + 1;
      const progress = 28 + Math.round((batchIndex / totalBatches) * 32);
      await emitProgress("collecting_metrics", progress, `Métricas CloudWatch: lote ${batchIndex}/${totalBatches}`);
    }
  }

  let costs: FinOpsAdvisorInput["costs"] = null;
  if (input.includeCosts) {
    await emitProgress("fetching_costs", 65, "Consultando costes reales CUR/Athena...");
    try {
      costs = await fetchCurCosts(input.accountIds, input.startDate, input.endDate, accountNameMap);
    } catch (error) {
      console.warn("Could not fetch CUR costs, continuing without them", error);
      warnings.push("No se pudieron recuperar costes CUR para este análisis. Informe generado con inventario y métricas.");
    }
  }

  await emitProgress("building_prompt", 78, "Preparando contexto FinOps y priorización por impacto...");
  const insights = buildFinOpsAdvisorInsights({
    inventory,
    metrics: allMetrics,
    costs,
    requestedAccountIds: input.accountIds,
    includeMetrics: input.includeMetrics,
    includeCosts: input.includeCosts,
    metricsDays: input.metricsDays,
    startDate: input.startDate,
    endDate: input.endDate,
    collectionIssues,
  });

  if (insights.summary.qualityLevel !== "high") {
    warnings.push(
      `La solidez del análisis es ${insights.summary.qualityLevel === "medium" ? "media" : "baja"} (${insights.summary.qualityScore}%). Revisa cobertura, métricas y permisos antes de ejecutar cambios de alto impacto.`,
    );
  }

  if (insights.permissionHints.length > 0) {
    warnings.push(`Se han detectado ${insights.permissionHints.length} gaps probables de permisos/visibilidad que reducen la calidad del análisis.`);
  }

  const metricIssueCount = collectionIssues.filter((issue) => issue.area === "metrics").length;
  if (metricIssueCount > 0) {
    warnings.push(`La recogida de métricas falló o quedó degradada en ${metricIssueCount} cuentas del alcance.`);
  }

  const prompt = buildFinOpsPrompt({ inventory, metrics: allMetrics, costs }, insights, input.locale);
  const systemPrompt = getFinOpsSystemPrompt(input.locale);

  await emitProgress("generating_report", 88, `Generando informe con ${USE_BEDROCK ? "Bedrock" : "Ollama"}...`);
  const modelUsed = USE_BEDROCK ? BEDROCK_MODEL : input.model;
  const fullResponse = USE_BEDROCK
    ? await callBedrock(prompt, systemPrompt)
    : await callOllama(prompt, input.model);

  await emitProgress("completed", 100, "Informe completado.");

  return {
    analysis: fullResponse,
    model: modelUsed,
    provider: USE_BEDROCK ? "bedrock" : "ollama",
    promptTokens: prompt.length,
    metricsCollected: allMetrics.length,
    metricsDays: input.metricsDays,
    costsIncluded: Boolean(costs && costs.totalCost > 0),
    costWindow: input.includeCosts ? { startDate: input.startDate, endDate: input.endDate } : null,
    inventorySummary: {
      totalResources: inventory.totalResources,
      accounts: inventory.accounts.length,
      services: inventory.byService.length,
    },
    insights,
    warnings,
    timestamp: new Date().toISOString(),
  };
}
