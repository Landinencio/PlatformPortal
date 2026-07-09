import pool from "@/lib/db";

export type NotificationType = "info" | "approval_request" | "approval_result" | "system";

export interface CreateNotificationInput {
  userEmail: string;
  type: NotificationType;
  title: string;
  message: string;
  link?: string;
  metadata?: Record<string, unknown>;
}

export async function createNotification(input: CreateNotificationInput): Promise<number> {
  const { rows } = await pool.query(
    `INSERT INTO user_notifications (user_email, type, title, message, link, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      input.userEmail,
      input.type,
      input.title,
      input.message,
      input.link || null,
      JSON.stringify(input.metadata || {}),
    ]
  );
  return rows[0].id;
}

export async function createNotificationBatch(inputs: CreateNotificationInput[]): Promise<void> {
  if (inputs.length === 0) return;
  const values: any[] = [];
  const placeholders: string[] = [];
  let idx = 1;
  for (const input of inputs) {
    placeholders.push(`($${idx}, $${idx + 1}, $${idx + 2}, $${idx + 3}, $${idx + 4}, $${idx + 5})`);
    values.push(input.userEmail, input.type, input.title, input.message, input.link || null, JSON.stringify(input.metadata || {}));
    idx += 6;
  }
  await pool.query(
    `INSERT INTO user_notifications (user_email, type, title, message, link, metadata) VALUES ${placeholders.join(", ")}`,
    values
  );
}
