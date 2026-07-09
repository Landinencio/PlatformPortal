import { NextResponse } from 'next/server';
import { getServerSession } from 'next-auth';
import { authOptions } from '@/lib/auth';
import { getSessionRole } from '@/lib/session-role';
import { getToolsForClaude } from '@/lib/ai-agent-tools';
import { executeTool } from '@/lib/ai-agent-executors';
import {
  BedrockRuntimeClient,
  ConverseCommand,
  type Message as ConverseMessage,
  type ContentBlock,
  type SystemContentBlock,
  type ToolConfiguration,
  type Tool,
} from '@aws-sdk/client-bedrock-runtime';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

const MAX_TOOL_ROUNDS = 5;

const SYSTEM_PROMPT = `Eres "El Becario", el asistente de plataforma de Iskaypet. Tienes acceso a herramientas reales que consultan datos en tiempo real. SIEMPRE debes usar tus herramientas para responder — NUNCA digas que no tienes acceso o que no puedes consultar algo si tienes una herramienta disponible.

REGLA FUNDAMENTAL: Ante cualquier pregunta sobre infraestructura, métricas, proyectos o estado de servicios, USA UNA HERRAMIENTA. No respondas de memoria ni inventes datos.

HERRAMIENTAS Y CUÁNDO USARLAS:

1. GITLAB (proyectos, pipelines, MRs):
   - gitlab_search_projects: Buscar proyectos. Úsala SIEMPRE que mencionen un proyecto para obtener su ID.
   - gitlab_list_pipelines: Pipelines de un proyecto (necesitas project ID o path encoded).
   - gitlab_get_pipeline_jobs: Jobs de un pipeline.
   - gitlab_get_job_log: Log de un job específico.
   - gitlab_list_merge_requests: MRs de un proyecto.

2. PROMETHEUS/GRAFANA (métricas de K8s, estado de namespaces, pods, CPU, memoria):
   - grafana_query_prometheus: Query PromQL instantánea. TIENES ACCESO A GRAFANA — úsala siempre.
   - grafana_query_range: Query PromQL con rango temporal.
   IMPORTANTE: Tienes acceso completo a Grafana/Prometheus. Cuando pregunten por el estado de un namespace, pods, CPU, memoria, etc., USA grafana_query_prometheus.

3. DORA (métricas de ingeniería):
   - dora_get_metrics_summary: Resumen DORA (deployment frequency, lead time, CFR, MTTR).
   - dora_get_project_ranking: Ranking de proyectos por métrica DORA.

4. AWS (cuentas, EC2, RDS):
   - aws_list_accounts: Lista cuentas AWS.
   - aws_list_ec2_instances: EC2 en una cuenta.
   - aws_list_rds_instances: RDS en una cuenta.

QUERIES PROMETHEUS — COPIA EXACTA (reemplaza NOMBRE por el namespace real):
- Pods en namespace: kube_pod_info{k8s_cluster_name="dp-prod", namespace="NOMBRE"}
- Contar pods: count(kube_pod_info{k8s_cluster_name="dp-prod", namespace="NOMBRE"})
- CPU namespace: sum by (pod) (rate(container_cpu_usage_seconds_total{k8s_cluster_name="dp-prod", namespace="NOMBRE"}[5m]))
- Memoria namespace: sum by (pod) (container_memory_working_set_bytes{k8s_cluster_name="dp-prod", namespace="NOMBRE"})
- Pods CrashLoop: kube_pod_container_status_waiting_reason{k8s_cluster_name="dp-prod", reason="CrashLoopBackOff"}
- Pods no ready: kube_pod_status_ready{k8s_cluster_name="dp-prod", namespace="NOMBRE", condition="true"}
- Replicas deployment: kube_deployment_status_replicas{k8s_cluster_name="dp-prod", namespace="NOMBRE"}
- Replicas disponibles: kube_deployment_status_replicas_available{k8s_cluster_name="dp-prod", namespace="NOMBRE"}
- Restarts: sum by (pod) (kube_pod_container_status_restarts_total{k8s_cluster_name="dp-prod", namespace="NOMBRE"})
- ArgoCD sync: argocd_app_info{k8s_cluster_name="dp-prod"}
- Todos los namespaces: count by (namespace) (kube_pod_info{k8s_cluster_name="dp-prod"})

ESTRATEGIA PARA PREGUNTAS SOBRE NAMESPACES/K8S:
Cuando pregunten "¿cómo está el namespace X?" o "¿qué pasa en X?", haz VARIAS queries:
1. Primero: kube_pod_info{k8s_cluster_name="dp-prod", namespace="X"} para ver los pods
2. Luego: kube_pod_container_status_restarts_total{k8s_cluster_name="dp-prod", namespace="X"} para ver restarts
3. Si hay problemas: kube_pod_container_status_waiting_reason{k8s_cluster_name="dp-prod", namespace="X"} para ver errores

REGLAS:
- Responde SIEMPRE en español
- Formatea SIEMPRE tus respuestas en Markdown: usa **negritas**, listas con -, headers con ##, bloques de código, tablas cuando sea útil
- Sé conciso y directo, usa datos reales de las herramientas
- Usa emojis para mejorar legibilidad
- NUNCA digas "no tengo acceso a Grafana" o "no puedo consultar métricas" — SÍ PUEDES, usa grafana_query_prometheus
- NUNCA digas "no hay métricas disponibles" sin antes hacer la query
- Si una query devuelve vacío, prueba variaciones (con/sin filtros adicionales)
- Si una herramienta devuelve error, explícalo al usuario y sugiere alternativas
- Los proyectos de GitLab se identifican por path (ej: "group/project") o por ID numérico
- Formatea resultados en listas para claridad
`;

const READ_ONLY_ADDENDUM = `
RESTRICCIÓN DE ROL: Este usuario tiene acceso de SOLO LECTURA.
- Solo proporciona información y análisis
- NO sugieras ni ejecutes acciones de escritura/modificación/eliminación
- Si pide algo que implique cambios, explica que necesita permisos de administrador
`;

async function getBedrockClient() {
  const region = process.env.AWS_BEDROCK_REGION || 'eu-west-1';
  const roleArn = process.env.AWS_BEDROCK_ROLE_ARN?.trim() || null;

  let credentials: any = undefined;
  if (roleArn) {
    const sts = new STSClient({ region });
    const assumed = await sts.send(new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: 'portal-chat-agent',
      DurationSeconds: 900,
    }));
    credentials = {
      accessKeyId: assumed.Credentials!.AccessKeyId!,
      secretAccessKey: assumed.Credentials!.SecretAccessKey!,
      sessionToken: assumed.Credentials!.SessionToken!,
    };
  }
  return new BedrockRuntimeClient({ region, credentials });
}

// Convert our tool definitions to Bedrock Converse format
function buildToolConfig(): ToolConfiguration {
  const agentTools = getToolsForClaude();
  const tools: Tool[] = agentTools.map(t => ({
    toolSpec: {
      name: t.name,
      description: t.description,
      inputSchema: {
        json: t.input_schema as any,
      },
    },
  }));
  return { tools };
}

// Detect if a user question likely needs a tool call
function detectToolNeed(text: string): boolean {
  const toolPatterns = [
    /namespace/i, /pods?/i, /cpu/i, /memoria/i, /memory/i,
    /cluster/i, /dp-prod/i, /dp-dev/i, /dp-uat/i,
    /pipeline/i, /gitlab/i, /merge.?request/i, /mr\b/i,
    /proyecto/i, /project/i,
    /dora/i, /deploy/i, /lead.?time/i, /cfr/i, /mttr/i,
    /ec2/i, /rds/i, /instancia/i, /cuenta/i, /aws/i,
    /estado/i, /cómo está/i, /como esta/i, /qué pasa/i, /que pasa/i,
    /cuántos/i, /cuantos/i, /lista/i, /busca/i,
    /prometheus/i, /grafana/i, /métricas/i, /metricas/i,
    /crash/i, /restart/i, /error/i, /fallo/i,
  ];
  return toolPatterns.some(p => p.test(text));
}

// Build a nudge message to force the model to use the right tool
function buildNudgeMessage(text: string): { message: string; tool: string } | null {
  // K8s / namespace questions → Prometheus
  if (/namespace|pods?|cluster|dp-prod|dp-dev|dp-uat|estado.*namespace|como.*esta.*namespace/i.test(text)) {
    const nsMatch = text.match(/namespace\s+["']?(\w[\w-]*)["']?/i) || text.match(/(?:en|del?)\s+(\w[\w-]*)\s+(?:en|de)\s+dp/i);
    const ns = nsMatch?.[1] || '';
    return {
      tool: 'grafana_query_prometheus',
      message: ns
        ? `No respondas sin datos. Usa la herramienta grafana_query_prometheus con la query: kube_pod_info{k8s_cluster_name="dp-prod", namespace="${ns}"} para obtener los pods del namespace "${ns}". Después muestra los resultados.`
        : `No respondas sin datos. Usa la herramienta grafana_query_prometheus con la query: count by (namespace) (kube_pod_info{k8s_cluster_name="dp-prod"}) para obtener información del cluster. Después muestra los resultados.`,
    };
  }

  // GitLab questions
  if (/gitlab|pipeline|merge.?request|proyecto|busca.*proyecto/i.test(text)) {
    const searchMatch = text.match(/(?:proyecto|project|busca)\s+["']?(.+?)["']?$/i);
    return {
      tool: 'gitlab_search_projects',
      message: searchMatch
        ? `No respondas sin datos. Usa la herramienta gitlab_search_projects con query "${searchMatch[1]}" para buscar el proyecto. Después muestra los resultados.`
        : `No respondas sin datos. Usa las herramientas de GitLab disponibles para responder la pregunta del usuario.`,
    };
  }

  // DORA questions
  if (/dora|deploy.*frequency|lead.?time|cfr|mttr|métricas.*ingeniería/i.test(text)) {
    return {
      tool: 'dora_get_metrics_summary',
      message: `No respondas sin datos. Usa la herramienta dora_get_metrics_summary para obtener las métricas DORA. Después muestra los resultados.`,
    };
  }

  // AWS questions
  if (/ec2|rds|instancia|cuenta.*aws/i.test(text)) {
    return {
      tool: 'aws_list_accounts',
      message: `No respondas sin datos. Usa las herramientas de AWS disponibles para responder la pregunta del usuario.`,
    };
  }

  // Generic metrics/Prometheus
  if (/prometheus|grafana|métricas|metricas|cpu|memoria/i.test(text)) {
    return {
      tool: 'grafana_query_prometheus',
      message: `No respondas sin datos. Usa la herramienta grafana_query_prometheus para consultar las métricas solicitadas. Recuerda filtrar por k8s_cluster_name="dp-prod".`,
    };
  }

  return null;
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    const serverRole = getSessionRole(session);
    const body = await request.json();

    const clientRole = body.userRole || 'viewer';
    const effectiveRole = session ? serverRole : clientRole;
    const isReadOnly = effectiveRole !== 'admin';

    const systemPrompt = SYSTEM_PROMPT + (isReadOnly ? READ_ONLY_ADDENDUM : '');

    // Build messages from either format
    let converseMessages: ConverseMessage[] = [];

    if (body.messages) {
      // Platform Chat format
      const filtered = body.messages.filter((m: any) => m.role === 'user' || m.role === 'assistant');
      for (const m of filtered) {
        converseMessages.push({
          role: m.role,
          content: [{ text: m.content }],
        });
      }
      // Converse API requires first message to be 'user' — drop leading assistant messages (greeting)
      while (converseMessages.length > 0 && converseMessages[0].role === 'assistant') {
        converseMessages.shift();
      }
    } else if (body.message) {
      // Chat Widget format
      const { message, context, history = [] } = body;
      if (context?.metrics) {
        converseMessages.push({
          role: 'user',
          content: [{ text: `[Contexto de métricas]\n${JSON.stringify(context.metrics, null, 2)}\nProyectos: ${context.projects?.length || 0}` }],
        });
        converseMessages.push({
          role: 'assistant',
          content: [{ text: 'Entendido, tengo el contexto. ¿En qué puedo ayudarte?' }],
        });
      }
      for (const msg of history) {
        converseMessages.push({
          role: msg.role,
          content: [{ text: msg.content }],
        });
      }
      converseMessages.push({ role: 'user', content: [{ text: message }] });
    } else {
      return NextResponse.json({ error: 'Message is required' }, { status: 400 });
    }

    if (!converseMessages.length || !converseMessages.some(m => m.role === 'user')) {
      return NextResponse.json({ error: 'No user message found' }, { status: 400 });
    }

    const region = process.env.AWS_BEDROCK_REGION;
    if (!region) {
      return NextResponse.json({
        response: '⚠️ Bedrock no está configurado.',
        timestamp: new Date().toISOString(),
        role: effectiveRole,
      });
    }

    const client = await getBedrockClient();
    const modelId = process.env.AWS_BEDROCK_MODEL_ID || 'amazon.nova-lite-v1:0';
    const toolConfig = buildToolConfig();
    const toolsUsed: string[] = [];
    const systemBlocks: SystemContentBlock[] = [{ text: systemPrompt }];

    // Detect if the user question likely needs a tool call
    const lastUserMsg = converseMessages.filter(m => m.role === 'user').pop();
    const lastUserText = lastUserMsg?.content?.map((b: any) => b.text || '').join(' ').toLowerCase() || '';
    const needsToolCall = detectToolNeed(lastUserText);

    // Agent loop
    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      const command = new ConverseCommand({
        modelId,
        system: systemBlocks,
        messages: converseMessages,
        toolConfig,
        inferenceConfig: { maxTokens: 4096, temperature: 0.3 },
      });

      const result = await client.send(command);
      const outputContent = result.output?.message?.content || [];
      const stopReason = result.stopReason;

      // Add assistant response to conversation
      converseMessages.push({
        role: 'assistant',
        content: outputContent,
      });

      // If no tool use, check if we should nudge the model to use tools
      if (stopReason !== 'tool_use') {
        const finalText = outputContent
          .filter((b: ContentBlock) => 'text' in b)
          .map((b: any) => b.text)
          .join('\n');

        // NUDGE: If round 0, no tools used, and the question clearly needs data,
        // inject a correction and retry
        if (round === 0 && toolsUsed.length === 0 && needsToolCall) {
          const nudge = buildNudgeMessage(lastUserText);
          if (nudge) {
            console.log(`[El Becario] Nudging model to use tools: ${nudge.tool}`);
            converseMessages.push({
              role: 'user',
              content: [{ text: nudge.message }],
            });
            continue; // retry with the nudge
          }
        }

        return NextResponse.json({
          response: finalText || 'No pude generar una respuesta.',
          toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
          timestamp: new Date().toISOString(),
          role: effectiveRole,
        });
      }

      // Execute tools
      const toolUseBlocks = outputContent.filter((b: ContentBlock) => 'toolUse' in b);
      const toolResultBlocks: ContentBlock[] = [];

      for (const block of toolUseBlocks) {
        const tu = (block as any).toolUse;
        const toolName = tu.name;
        const toolInput = tu.input || {};
        toolsUsed.push(toolName);

        console.log(`[El Becario] Tool: ${toolName}`, toolInput);
        const toolResult = await executeTool(toolName, toolInput);

        toolResultBlocks.push({
          toolResult: {
            toolUseId: tu.toolUseId,
            content: [{ text: JSON.stringify(toolResult.success ? toolResult.data : { error: toolResult.error }) }],
            status: toolResult.success ? 'success' : 'error',
          },
        } as any);
      }

      // Feed tool results back
      converseMessages.push({
        role: 'user',
        content: toolResultBlocks,
      });
    }

    // Exhausted rounds — one final call without tools
    const finalCommand = new ConverseCommand({
      modelId,
      system: systemBlocks,
      messages: converseMessages,
      inferenceConfig: { maxTokens: 4096, temperature: 0.3 },
    });
    const finalResult = await client.send(finalCommand);
    const finalText = (finalResult.output?.message?.content || [])
      .filter((b: ContentBlock) => 'text' in b)
      .map((b: any) => b.text)
      .join('\n');

    return NextResponse.json({
      response: finalText || 'He agotado las rondas de herramientas.',
      toolsUsed: toolsUsed.length > 0 ? toolsUsed : undefined,
      timestamp: new Date().toISOString(),
      role: effectiveRole,
    });
  } catch (error) {
    console.error('AI chat error:', error);
    const errMsg = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      { error: 'Failed to process chat message', details: errMsg },
      { status: 500 }
    );
  }
}
