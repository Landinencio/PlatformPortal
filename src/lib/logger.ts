import { randomUUID } from "crypto";

export interface LogEntry {
  timestamp: string;
  level: "info" | "warn" | "error";
  requestId: string;
  userId: string;
  action: string;
  message: string;
  duration?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Structured JSON logger for infrastructure request operations.
 *
 * Outputs single-line JSON to stdout, suitable for Kubernetes-based
 * observability stacks (Fluentd/Fluent Bit).
 */
export class InfraLogger {
  private readonly requestId: string;
  private readonly userId: string;
  private readonly action: string;
  private readonly startTime: number;

  constructor(action: string, userId: string) {
    this.requestId = randomUUID();
    this.userId = userId;
    this.action = action;
    this.startTime = Date.now();
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.emit("info", message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.emit("warn", message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.emit("error", message, metadata);
  }

  done(message: string, metadata?: Record<string, unknown>): void {
    const duration = Date.now() - this.startTime;
    this.emit("info", message, metadata, duration);
  }

  private emit(
    level: LogEntry["level"],
    message: string,
    metadata?: Record<string, unknown>,
    duration?: number
  ): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      requestId: this.requestId,
      userId: this.userId,
      action: this.action,
      message,
    };

    if (duration !== undefined) {
      entry.duration = duration;
    }

    if (metadata !== undefined) {
      entry.metadata = metadata;
    }

    process.stdout.write(JSON.stringify(entry) + "\n");
  }
}
