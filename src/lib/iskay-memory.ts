/**
 * Iskay conversational memory.
 *
 * Persists chat turns to `iskay_conversations` so a thread survives page reloads and the
 * agent can be grounded with prior context. Best-effort: a DB failure here must NEVER
 * break the chat response, so every function swallows errors and logs them.
 */

import pool from "@/lib/db";

export interface StoredTurn {
  role: "user" | "assistant";
  content: string;
}

/** Appends a single turn to a conversation thread. Best-effort (never throws). */
export async function appendTurn(
  conversationId: string,
  userEmail: string,
  role: "user" | "assistant",
  content: string,
  toolsUsed: string[] = [],
): Promise<void> {
  if (!conversationId || !content?.trim()) return;
  try {
    await pool.query(
      `INSERT INTO iskay_conversations (conversation_id, user_email, role, content, tools_used)
       VALUES ($1, $2, $3, $4, $5::jsonb)`,
      [conversationId, userEmail.toLowerCase(), role, content, JSON.stringify(toolsUsed)],
    );
  } catch (err) {
    console.warn("[iskay-memory] appendTurn failed:", err instanceof Error ? err.message : err);
  }
}

/**
 * Loads the recent turns of a thread (oldest first), capped to `limit`. Used to seed the
 * model when the client sends only a conversationId (e.g. after a reload). Best-effort:
 * returns [] on any error so the chat still works without memory.
 */
export async function loadThread(
  conversationId: string,
  userEmail: string,
  limit = 20,
): Promise<StoredTurn[]> {
  if (!conversationId) return [];
  try {
    const { rows } = await pool.query(
      `SELECT role, content FROM (
         SELECT role, content, created_at
         FROM iskay_conversations
         WHERE conversation_id = $1 AND user_email = $2
         ORDER BY created_at DESC
         LIMIT $3
       ) recent
       ORDER BY created_at ASC`,
      [conversationId, userEmail.toLowerCase(), limit],
    );
    return rows
      .filter((r: any) => r.content && (r.role === "user" || r.role === "assistant"))
      .map((r: any) => ({ role: r.role as "user" | "assistant", content: String(r.content) }));
  } catch (err) {
    console.warn("[iskay-memory] loadThread failed:", err instanceof Error ? err.message : err);
    return [];
  }
}
