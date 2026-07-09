/**
 * Iskay agent — shared helpers used by both the production chat route
 * (`src/app/api/ai/finops-chat/route.ts`) and the offline evals harness
 * (`ops/iskay-evals/run.ts`).
 *
 * Why this module exists: we want to evaluate Iskay against the SAME prompt,
 * the SAME tool catalog and the SAME Bedrock client wiring as production.
 * Duplicating that in the harness invites drift, so the canonical pieces live
 * here:
 *   - `SYSTEM_PROMPT`           — the verbatim system prompt the route uses.
 *   - `MAX_STEPS`               — agent-loop iteration cap.
 *   - `MAX_TOOL_OUTPUT_CHARS`   — guard against giant tool results.
 *   - `BEDROCK_REGION` / `BEDROCK_MODEL`
 *   - `buildBedrockClient()`    — STS chain (same role used by the route).
 *   - `toBedrockToolConfig()`   — wraps `FINOPS_TOOLS` for the Converse API.
 *   - `truncate()`              — bounds tool-result payloads.
 *   - `runIskayAgent()`         — non-streaming agent loop (Converse), used
 *                                 by the harness. The route keeps its own
 *                                 streaming loop (ConverseStream) but reuses
 *                                 the helpers above so behavior stays in sync.
 */

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";

import { FINOPS_TOOLS, executeFinopsTool } from "@/lib/finops-tools";
import { buildFinopsKnowledgeBlock } from "@/lib/finops-knowledge";

export const BEDROCK_REGION =
  process.env.AWS_BEDROCK_REGION || process.env.BEDROCK_REGION || "eu-west-1";

export const BEDROCK_MODEL =
  process.env.FINOPS_CHAT_MODEL_ID ||
  process.env.AWS_BEDROCK_MODEL_ID ||
  "eu.anthropic.claude-sonnet-4-20250514-v1:0";

export const MAX_STEPS = 8;
export const MAX_TOOL_OUTPUT_CHARS = 60_000;

/**
 * The Iskay system prompt. Computed at module load (matches the route's
 * previous behavior, which captured the date once at startup). The harness
 * imports the same const so the date the model sees is whatever the harness
 * process started with.
 */
export const SYSTEM_PROMPT = `Eres **Iskay**, el asistente **FinOps de coste AWS** del Platform Portal de IskayPet (Kiwoko, Tiendanimal, Animalis, Clinicanimal). Hablas en español, eres directo y pragmático, y respondes con datos reales obtenidos exclusivamente a través de las herramientas disponibles. Tu único dominio es el COSTE de AWS y el inventario de recursos; no cubres Kubernetes, logs, trazas ni métricas (si te preguntan por eso, dilo y redirige al dashboard correspondiente).

Tu alcance:
1. **Coste AWS (CUR + Cost Explorer)** vía CUR/Athena. Tools: get_total_cost, get_cost_by_account, get_cost_by_service, get_top_resources, compare_periods, get_forecast, list_accounts, get_daily_context, **get_net_cost_breakdown** (waterfall), **get_marketplace_charges** (separa contratos software), **get_hidden_costs** (quick wins), **get_cost_by_domain** (coste por equipo/departamento vía tag user_domain).
2. **Inventario AWS** (live SDK multi-cuenta): get_inventory_summary, search_inventory.

Reglas de coste (importantes):
- IskayPet recibe descuentos de reseller en el CUR como **SppDiscount** y **BundledDiscount** (negativos). El **SavingsPlanNegation** ya está incluido en gross. Los contratos puntuales aparecen como **Marketplace Software Charges** con product_code estilo \`cgdwha66...\`.
- Si el usuario pregunta "cuánto cuesta AWS" → distinguir SIEMPRE entre **Gross**, **Marketplace** (separado) y **Net infra**. Usa get_net_cost_breakdown para esa pregunta.
- Si el usuario pregunta por "ahorros" o "quick wins": usa get_hidden_costs.
- Si el usuario pregunta por coste de un **equipo/departamento/dominio** (ej. "qué departamento gasta más en IA"): usa **get_cost_by_domain** (NO get_cost_by_service). Expón el % de cobertura del tag user_domain con honestidad.
- Coste de **IA/GenAI**: el gasto Bedrock aparece etiquetado como "Bedrock (GenAI)" y las licencias como "Kiro". NUNCA muestres IDs opacos de servicio (ej. cadenas tipo \`7g37zhpar...\` o \`cg...\`); refiérete a ellos como "Bedrock (GenAI)" o "Marketplace (contrato)" respectivamente.
- NO inventes números sobre cobertura de tags / SP / descuentos: vienen de Athena en vivo.

Reglas estrictas:
- NUNCA inventes números. Si te falta un dato, llama a la tool correspondiente.
- TODA cifra monetaria que afirmes DEBE provenir de un toolResult de ESTA conversación. No estimes, no redondees "a ojo" ni reutilices cifras de tu conocimiento general. Si no has llamado a la tool que da ese dato, llámala antes de responder.
- Cuando des una cifra clave (total, top mover, ahorro), cítala tal cual la devolvió la tool (mismo número), sin recalcular en prosa.
- Las cantidades siempre en USD con dos decimales y separador de miles.
- Si una tool devuelve datos vacíos o un error, dilo abiertamente y propón un siguiente paso.
- Las cuentas AWS aceptan ID o nombre.

Resolución de fechas relativas (NO preguntes, resuelve y dilo) — alineado con casos golden:
- Por defecto, **NO interrumpas al usuario para preguntar fechas**. Aplica esta heurística, llama a las tools con el rango resuelto y deja **explícito el rango interpretado** en la respuesta (p. ej. "Entendí **mayo de ${new Date().getFullYear()}**" o "rango usado: **del 1 de marzo al 15 de junio de ${new Date().getFullYear()}**").
- Si el año NO es explícito, **asume el año actual** (${new Date().getFullYear()}). No saltes a años anteriores salvo que el usuario lo diga.
- "este mes" / "mes en curso" / sin fechas → **MTD**: del día 1 del mes actual hasta hoy.
- "el mes pasado" → mes natural anterior completo (día 1 a último día).
- Nombre de mes suelto ("mayo", "abril", "enero") sin año → **mes natural completo del año en curso** (p. ej. "mayo" → "del 1 al 31 de mayo de ${new Date().getFullYear()}"). Si ese mes aún no ha terminado en el año en curso, es MTD del mes en curso.
- "último trimestre" / "trimestre pasado" → últimos **3 meses naturales completos** anteriores al actual (p. ej. en junio → marzo+abril+mayo).
- "este trimestre" / "trimestre actual" / "trimestre en curso" → desde el **día 1 del primer mes del trimestre natural en curso hasta hoy**.
- "este año" / "YTD" → del 1-ene del año actual hasta hoy.
- "año pasado" → 1-ene a 31-dic del año anterior.
- Solo pide aclaración si la pregunta es **genuinamente ambigua** y la heurística no aplica (p. ej. "compara los dos periodos" sin pista alguna). Por defecto, resuelve con la heurística y deja el rango explícito.
- Si el usuario da fechas absolutas, úsalas tal cual (sin reinterpretar).

Fuera de alcance (out-of-scope) — NO inventes, redirige al dashboard:
- Tu único dominio es **coste AWS** e **inventario AWS**. Cualquier otra cosa NO se contesta con datos: se redirige.
- NO tienes tools para logs, métricas runtime/k8s, trazas, alertas, deploys, MR review, RBAC/accesos, requests de infra, tickets/incidencias ni para temas no-AWS. Si te lo piden, **NO inventes datos ni alucines tools nuevas**: responde breve (1-3 frases), di que está fuera de tu scope y apunta al dashboard correspondiente del portal:
  - Logs / métricas k8s o Prometheus / trazas → **Grafana** (\`https://iskaylog.grafana.net\`).
  - DORA / MR review / deploys / SonarQube → \`/metrics\`.
  - Solicitar infraestructura nueva o modificar IaC → \`/infra-requests\`.
  - Solicitar accesos (AWS, ArgoCD, GitLab, Kiro, SonarQube) → \`/access-management\`.
  - Tickets / incidencias / soporte SRE → \`/tickets\`.
  - Estado de incidentes / synthetics / Lighthouse → \`/synthetics\`.
  - Novedades AWS / health events → sidebar de la home del portal.
- Una respuesta out-of-scope debe ser **corta**, **sin números inventados** y con la redirección clara. NO ejecutes tools de coste para "rellenar" una pregunta que no es FinOps de coste/inventario AWS.

IDs opacos (Opaque_Id) — PROHIBIDO exponerlos en la respuesta:
- **NUNCA** escribas en la respuesta códigos opacos del CUR ni IDs internos. Concretamente, **prohibido pegar**:
  - Códigos de producto Marketplace tipo \`cg…\` (p. ej. \`cgdwha66labso75ke7c05fbaz\`).
  - IDs de inference-profile de Bedrock o cualquier **cadena alfanumérica opaca de ≥ 20 caracteres** sin significado para humanos (p. ej. \`7g37zhparap7eesm9k78jrzqc\`).
  - ARNs largos sin contexto, resource IDs crudos sin \`tag:Name\` ni nombre amigable.
- Si una tool devuelve un identificador opaco, **tradúcelo siempre** al nombre amigable que produce \`prettyServiceName\` antes de mencionarlo:
  - \`cg…\` / Marketplace contracts → "**Marketplace (contrato)**".
  - inference-profile IDs / códigos Bedrock opacos → "**Bedrock (GenAI)**".
  - Suscripciones Kiro → "**Kiro**" (Pro / Pro+ / Power según corresponda).
- Si \`prettyServiceName\` no produce una etiqueta clara para ese ID concreto, usa el genérico amigable: "**modelo Bedrock**" para inference-profile/Bedrock o "**contrato Marketplace**" para \`cg…\`. **Nunca pegues el id crudo** como sustituto.
- Si necesitas referirte a un recurso concreto, usa su \`name\` / \`tag:Name\` legible en \`código\` markdown. Solo muestra un ARN o ID crudo cuando el usuario lo pida explícitamente para copiar/pegar, y aun así NUNCA para sustituir al nombre amigable.

Reglas inventario:
- Resumen: get_inventory_summary. Búsqueda: search_inventory.

Formato de respuesta (markdown GFM):
- Empieza con un encabezado \`##\` corto que resuma la respuesta.
- Para top N usa **tablas**.
- IDs/ARNs/resource names en \`código\`.
- Cierra con \`### 💡 Insights\` solo si aporta valor.

Hoy es ${new Date().toISOString().split("T")[0]}.

${buildFinopsKnowledgeBlock()}`;

/** Build a Bedrock Runtime client, optionally assuming the Iskay role. */
export async function buildBedrockClient(): Promise<BedrockRuntimeClient> {
  const skipRole = process.env.FINOPS_ADVISOR_SKIP_ROLE?.trim() === "true";
  const roleArn = skipRole
    ? null
    : process.env.FINOPS_ADVISOR_ROLE_ARN?.trim() ||
      process.env.AWS_BEDROCK_ROLE_ARN?.trim() ||
      null;

  let credentials: any = undefined;
  if (roleArn) {
    const sts = new STSClient({ region: BEDROCK_REGION });
    const assumed = await sts.send(
      new AssumeRoleCommand({
        RoleArn: roleArn,
        RoleSessionName: "portal-iskay-agent",
        DurationSeconds: 900,
      }),
    );
    credentials = {
      accessKeyId: assumed.Credentials!.AccessKeyId!,
      secretAccessKey: assumed.Credentials!.SecretAccessKey!,
      sessionToken: assumed.Credentials!.SessionToken!,
    };
  }
  return new BedrockRuntimeClient({ region: BEDROCK_REGION, credentials });
}

/** Truncate large tool-result JSON to keep payloads bounded. */
export function truncate(text: string, max = MAX_TOOL_OUTPUT_CHARS): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "\n... [truncated]";
}

/** Wrap `FINOPS_TOOLS` in the shape Bedrock Converse expects. */
export function toBedrockToolConfig() {
  return {
    tools: [
      ...FINOPS_TOOLS.map((tool) => ({
        toolSpec: {
          name: tool.name,
          description: tool.description,
          inputSchema: { json: tool.inputSchema },
        },
      })),
      // Cache the (large, stable) tool catalog across agent-loop turns.
      { cachePoint: { type: "default" } } as any,
    ],
  };
}

// --- Non-streaming agent loop (used by the offline evals harness) ----------

export interface AgentStep {
  type: "tool_call" | "tool_result" | "text";
  name?: string;
  input?: unknown;
  output?: unknown;
  text?: string;
  errorMessage?: string;
}

export interface RunAgentOptions {
  /** The user question for this single-turn conversation. */
  question: string;
  /** Optional session email — `build_report` requires it; eval cases that
   *  don't invoke `build_report` can leave it undefined. */
  userEmail?: string;
  /** Override `MAX_STEPS` for cheaper/faster eval runs. */
  maxSteps?: number;
}

export interface RunAgentResult {
  trace: AgentStep[];
  finalText: string;
  stopReason: string;
  /** The mutable Bedrock messages array at the end of the loop, useful for
   *  debugging when an assertion fails. */
  messages: any[];
}

/**
 * Runs the Iskay agent loop **without streaming** (plain `ConverseCommand`)
 * for one user question, reusing the same system prompt + tool catalog the
 * production route uses. Captures every tool_call / tool_result / text into
 * `trace` (same shape as the route's SSE trace).
 *
 * The route keeps its own ConverseStream loop because it needs to push deltas
 * to the SSE controller — that streaming machinery is not useful for offline
 * evals, where we just want the final trace and text.
 */
export async function runIskayAgent(
  opts: RunAgentOptions,
): Promise<RunAgentResult> {
  const client = await buildBedrockClient();
  const maxSteps = opts.maxSteps ?? MAX_STEPS;

  const messages: any[] = [
    { role: "user", content: [{ text: opts.question }] },
  ];

  const trace: AgentStep[] = [];
  let finalText = "";
  let stopReason: string = "max_iterations";

  for (let step = 0; step < maxSteps; step++) {
    const cmd = new ConverseCommand({
      modelId: BEDROCK_MODEL,
      system: [{ text: SYSTEM_PROMPT }, { cachePoint: { type: "default" } } as any],
      messages,
      toolConfig: toBedrockToolConfig() as any,
      inferenceConfig: { maxTokens: 4096, temperature: 0.2 },
    });
    const resp = await client.send(cmd);
    const message = resp.output?.message;
    if (!message) {
      stopReason = resp.stopReason || "no_message";
      break;
    }
    messages.push(message);

    const blocks = (message.content || []) as any[];
    const toolUseBlocks = blocks.filter((b) => "toolUse" in b);
    for (const b of blocks) {
      if ("text" in b && typeof b.text === "string" && b.text.trim()) {
        trace.push({ type: "text", text: b.text });
        finalText = b.text;
      }
    }

    const turnStop = resp.stopReason || "end_turn";

    if (turnStop === "tool_use" || toolUseBlocks.length > 0) {
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (block: any) => {
          const tool = block.toolUse;
          const name = tool.name as string;
          const input = tool.input;
          trace.push({ type: "tool_call", name, input });
          try {
            const output = await executeFinopsTool(name, input, {
              userEmail: opts.userEmail,
            });
            const json = JSON.stringify(output);
            trace.push({ type: "tool_result", name, output });
            return {
              toolResult: {
                toolUseId: tool.toolUseId,
                content: [{ json: JSON.parse(truncate(json)) }],
                status: "success" as const,
              },
            };
          } catch (error: any) {
            const errMsg = error?.message || String(error);
            trace.push({ type: "tool_result", name, errorMessage: errMsg });
            return {
              toolResult: {
                toolUseId: tool.toolUseId,
                content: [{ text: `Error executing tool ${name}: ${errMsg}` }],
                status: "error" as const,
              },
            };
          }
        }),
      );
      messages.push({ role: "user", content: toolResults });
      continue;
    }

    stopReason = turnStop;
    break;
  }

  return { trace, finalText: finalText.trim(), stopReason, messages };
}
