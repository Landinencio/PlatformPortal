/**
 * FinOps Chat — Bedrock tool-calling agent.
 *
 * Approach: standard agent loop with the AWS Bedrock Converse API.
 * 1. Send conversation + tool catalog to the model.
 * 2. If the model returns `toolUse` blocks, execute the corresponding tools
 *    in parallel, append `toolResult` blocks, and continue the loop.
 * 3. Stop when the model returns a final text answer (or after MAX_STEPS to
 *    prevent runaway loops).
 *
 * No MCP server: the portal is the only consumer, so we keep tools as
 * regular TS functions. See `src/lib/finops-tools.ts` for the tool catalog.
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { ConverseStreamCommand } from "@aws-sdk/client-bedrock-runtime";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { executeFinopsTool } from "@/lib/finops-tools";
import { verifyCitations } from "@/lib/finops-citation-guard";
import { appendTurn, loadThread } from "@/lib/iskay-memory";
import {
  BEDROCK_MODEL,
  MAX_STEPS,
  SYSTEM_PROMPT,
  buildBedrockClient,
  toBedrockToolConfig,
  truncate,
  type AgentStep,
} from "@/lib/iskay-agent";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

function toBedrockHistory(history: ChatTurn[], userMessage: string) {
  const trimmed: ChatTurn[] = [];
  for (const turn of history.slice(-12)) {
    if (!turn.content || typeof turn.content !== "string") continue;
    trimmed.push({ role: turn.role === "assistant" ? "assistant" : "user", content: turn.content });
  }
  return [
    ...trimmed.map((t) => ({ role: t.role, content: [{ text: t.content }] })),
    { role: "user" as const, content: [{ text: userMessage }] },
  ];
}

export async function POST(request: NextRequest) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    }
    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "directores")) {
      return NextResponse.json({ error: "Iskay (FinOps chat) restricted to admin/directores" }, { status: 403 });
    }

    const body = await request.json().catch(() => ({}));
    const userMessage = String(body?.message || "").trim();
    const clientHistory: ChatTurn[] = Array.isArray(body?.history) ? body.history : [];
    const conversationId = String(body?.conversationId || "").trim();
    const userEmail = session.user.email || "";

    if (!userMessage) {
      return NextResponse.json({ error: "message is required" }, { status: 400 });
    }

    // Memory: if the client sent a conversationId but no inline history (e.g. after a
    // page reload), rehydrate the thread from the DB so Iskay keeps context.
    let history = clientHistory;
    if (conversationId && clientHistory.length === 0) {
      history = await loadThread(conversationId, userEmail);
    }

    // Persist the user's turn (best-effort, never blocks the response).
    if (conversationId) {
      void appendTurn(conversationId, userEmail, "user", userMessage);
    }

    const client = await buildBedrockClient();

    // Mutable conversation passed back into the model on every loop iteration.
    const messages: any[] = toBedrockHistory(history, userMessage);

    const encoder = new TextEncoder();

    // Server-Sent Events stream. Events:
    //   { type: "tool", name, phase: "call"|"result", input?, errorMessage? }
    //   { type: "delta", text }          → incremental assistant text
    //   { type: "done", reply, stopReason, trace, conversationId }
    //   { type: "error", error }
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (obj: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
        };

        const trace: AgentStep[] = [];
        let finalText = "";
        let stopReason = "max_iterations";

        /** Runs one ConverseStream turn, streaming text deltas to the client. Returns the
         *  assembled assistant message (content blocks) + this turn's stopReason. */
        async function streamTurn(withTools: boolean): Promise<{ message: any; stopReason: string }> {
          const cmd = new ConverseStreamCommand({
            modelId: BEDROCK_MODEL,
            system: [{ text: SYSTEM_PROMPT }, { cachePoint: { type: "default" } } as any],
            messages,
            ...(withTools ? { toolConfig: toBedrockToolConfig() as any } : {}),
            inferenceConfig: { maxTokens: 4096, temperature: 0.2 },
          });
          const resp = await client.send(cmd);

          // Reassemble content blocks from the event stream. Tool-use inputs arrive as
          // JSON fragments across multiple deltas; accumulate per block index.
          const contentBlocks: any[] = [];
          const toolJsonByIndex = new Map<number, string>();
          let turnStop = "end_turn";

          for await (const event of resp.stream ?? []) {
            if (event.contentBlockStart?.start?.toolUse) {
              const tu = event.contentBlockStart.start.toolUse;
              const idx = event.contentBlockStart.contentBlockIndex ?? contentBlocks.length;
              contentBlocks[idx] = { toolUse: { toolUseId: tu.toolUseId, name: tu.name, input: {} } };
              toolJsonByIndex.set(idx, "");
            } else if (event.contentBlockDelta?.delta) {
              const idx = event.contentBlockDelta.contentBlockIndex ?? 0;
              const delta = event.contentBlockDelta.delta as any;
              if (typeof delta.text === "string") {
                const text = delta.text as string;
                if (!contentBlocks[idx]) contentBlocks[idx] = { text: "" };
                contentBlocks[idx].text = (contentBlocks[idx].text || "") + text;
                // Stream the visible text to the client as it arrives.
                send({ type: "delta", text });
              } else if (delta.toolUse?.input !== undefined) {
                toolJsonByIndex.set(idx, (toolJsonByIndex.get(idx) || "") + (delta.toolUse.input || ""));
              }
            } else if (event.messageStop) {
              turnStop = event.messageStop.stopReason || "end_turn";
            }
          }

          // Finalise accumulated tool-use inputs (parse the streamed JSON fragments).
          for (const [idx, json] of toolJsonByIndex) {
            if (contentBlocks[idx]?.toolUse) {
              try {
                contentBlocks[idx].toolUse.input = json ? JSON.parse(json) : {};
              } catch {
                contentBlocks[idx].toolUse.input = {};
              }
            }
          }

          return { message: { role: "assistant", content: contentBlocks.filter(Boolean) }, stopReason: turnStop };
        }

        try {
          for (let step = 0; step < MAX_STEPS; step++) {
            const { message, stopReason: turnStop } = await streamTurn(true);
            messages.push(message);

            const blocks = message.content || [];
            const toolUseBlocks = blocks.filter((b: any) => "toolUse" in b);
            for (const b of blocks) {
              if ("text" in b && b.text?.trim()) {
                trace.push({ type: "text", text: b.text });
                finalText = b.text;
              }
            }

            if (turnStop === "tool_use" || toolUseBlocks.length > 0) {
              const toolResults = await Promise.all(
                toolUseBlocks.map(async (block: any) => {
                  const tool = block.toolUse;
                  const name = tool.name as string;
                  const input = tool.input;
                  trace.push({ type: "tool_call", name, input });
                  send({ type: "tool", name, phase: "call", input });
                  try {
                    // Pass the session userEmail so tools that need session-scoped
                    // data (e.g. `build_report`, which persists the workbook + scopes
                    // the download to the requester) can read it from the context.
                    const output = await executeFinopsTool(name, input, { userEmail });
                    const json = JSON.stringify(output);
                    trace.push({ type: "tool_result", name, output });
                    send({ type: "tool", name, phase: "result" });
                    return {
                      toolResult: {
                        toolUseId: tool.toolUseId,
                        content: [{ json: JSON.parse(truncate(json)) }],
                        status: "success",
                      },
                    };
                  } catch (error: any) {
                    const errMsg = error?.message || String(error);
                    trace.push({ type: "tool_result", name, errorMessage: errMsg });
                    send({ type: "tool", name, phase: "result", errorMessage: errMsg });
                    return {
                      toolResult: {
                        toolUseId: tool.toolUseId,
                        content: [{ text: `Error executing tool ${name}: ${errMsg}` }],
                        status: "error",
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

          // Forced final answer (no tools) if the loop exhausted while still tool-calling.
          if (stopReason === "max_iterations") {
            messages.push({
              role: "user",
              content: [{
                text:
                  "Has alcanzado el límite de consultas. Responde AHORA al usuario en español, " +
                  "de forma cerrada y útil, SOLO con los datos que ya has obtenido de las herramientas. " +
                  "No pidas más datos ni menciones IDs internos opacos.",
              }],
            });
            const { message } = await streamTurn(false);
            const text = (message.content || [])
              .filter((b: any) => "text" in b)
              .map((b: any) => b.text)
              .join("\n")
              .trim();
            if (text) {
              finalText = text;
              stopReason = "forced_final";
              trace.push({ type: "text", text });
            }
          }

          // Persist the assistant reply (best-effort).
          const toolsUsed = [...new Set(trace.filter((s) => s.type === "tool_call" && s.name).map((s) => s.name as string))];
          if (conversationId && finalText.trim()) {
            void appendTurn(conversationId, userEmail, "assistant", finalText.trim(), toolsUsed);
          }

          // If `build_report` ran in this turn, surface its download metadata in
          // the SSE `done` event so the UI can render a "⬇️ Descargar Excel"
          // button under the assistant reply. We pick the LATEST successful
          // build_report result (a turn can technically generate more than one).
          let report: { downloadUrl: string; filename: string } | undefined;
          for (let i = trace.length - 1; i >= 0; i--) {
            const entry = trace[i];
            if (entry.type !== "tool_result" || entry.name !== "build_report") continue;
            const out = entry.output as { downloadUrl?: unknown; filename?: unknown } | undefined;
            if (out && typeof out.downloadUrl === "string" && typeof out.filename === "string") {
              report = { downloadUrl: out.downloadUrl, filename: out.filename };
              break;
            }
          }

          // Citation_Guard — "loguea y mide" mode (R12.1, R12.2). Verify that
          // every monetary amount in the final answer is backed by a number
          // returned by some tool in this conversation. Discrepancies are
          // logged as telemetry only — they NEVER mutate or block the
          // response. Wrapped in try/catch so a guard bug can never surface
          // to the user.
          let citationGuard: { citedCount: number; missingCount: number } | undefined;
          try {
            const toolOutputs = trace
              .filter((s) => s.type === "tool_result" && s.output !== undefined)
              .map((s) => s.output);
            const guard = verifyCitations(finalText, toolOutputs);
            citationGuard = {
              citedCount: guard.cited.length,
              missingCount: guard.missing.length,
            };
            if (guard.missing.length > 0) {
              console.warn("[iskay] citation-guard: missing matches", {
                cited: guard.cited,
                matched: guard.matched,
                missing: guard.missing,
                toolsUsed,
                conversationId: conversationId || null,
              });
            }
          } catch (guardErr: any) {
            // Defensive: never let the guard interfere with the response.
            console.warn("[iskay] citation-guard: error", guardErr?.message || guardErr);
          }

          send({
            type: "done",
            reply: finalText.trim() || "(sin respuesta)",
            stopReason,
            trace,
            model: BEDROCK_MODEL,
            conversationId: conversationId || null,
            ...(report ? { report } : {}),
            ...(citationGuard ? { citationGuard } : {}),
          });
        } catch (err: any) {
          console.error("[finops-chat] stream error:", err?.message || err);
          send({ type: "error", error: err?.message || "Internal error" });
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error: any) {
    console.error("[finops-chat] error:", error);
    return NextResponse.json(
      { error: error?.message || "Internal error" },
      { status: 500 },
    );
  }
}
