/**
 * Property-based tests for InfraLogger.
 *
 * Feature: infra-robustness
 * Property 16: Structured log output correctness
 *
 * **Validates: Requirements 12.1, 12.5, 12.6**
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { InfraLogger } from "../logger";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** UUID v4 regex pattern */
const UUID_V4_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** ISO 8601 date-time regex (simplified, covers toISOString output) */
const ISO_8601_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;

/**
 * Capture stdout output from a callback.
 */
function captureStdout(fn: () => void): string[] {
  const lines: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    lines.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  }) as typeof process.stdout.write;
  try {
    fn();
  } finally {
    process.stdout.write = originalWrite;
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a non-empty action string */
const actionArb = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz._".split("")), {
    minLength: 1,
    maxLength: 40,
  })
  .map((chars) => chars.join(""));

/** Generate a user email */
const userIdArb = fc
  .tuple(
    fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), {
        minLength: 1,
        maxLength: 20,
      })
      .map((chars) => chars.join("")),
    fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
        minLength: 2,
        maxLength: 10,
      })
      .map((chars) => chars.join(""))
  )
  .map(([local, domain]) => `${local}@${domain}.com`);

/** Generate a log message (printable ASCII, no newlines) */
const messageArb = fc
  .array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")),
    { minLength: 1, maxLength: 80 }
  )
  .map((chars) => chars.join(""));

/** Generate optional metadata */
const metadataArb = fc.oneof(
  fc.constant(undefined),
  fc.dictionary(
    fc
      .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
        minLength: 1,
        maxLength: 10,
      })
      .map((chars) => chars.join("")),
    fc.oneof(fc.string(), fc.integer(), fc.boolean())
  )
);

/** Generate a log level method name */
const levelMethodArb = fc.constantFrom("info" as const, "warn" as const, "error" as const);

/* ------------------------------------------------------------------ */
/*  Property 16: Structured log output correctness                     */
/*  **Validates: Requirements 12.1, 12.5, 12.6**                       */
/* ------------------------------------------------------------------ */

test("Property 16: log output is valid single-line JSON", () => {
  fc.assert(
    fc.property(
      actionArb,
      userIdArb,
      levelMethodArb,
      messageArb,
      metadataArb,
      (action, userId, level, message, metadata) => {
        const logger = new InfraLogger(action, userId);
        const lines = captureStdout(() => {
          logger[level](message, metadata);
        });

        assert.equal(lines.length, 1, "Expected exactly one line of output");
        const line = lines[0].trimEnd();

        // Must not contain newlines (single-line)
        assert.ok(
          !line.includes("\n"),
          "Output must be single-line"
        );

        // Must be valid JSON
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          assert.fail(`Output is not valid JSON: ${line}`);
        }

        // Verify it's an object
        assert.equal(typeof parsed, "object");
        assert.notEqual(parsed, null);
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 16: log output contains all required fields", () => {
  fc.assert(
    fc.property(
      actionArb,
      userIdArb,
      levelMethodArb,
      messageArb,
      metadataArb,
      (action, userId, level, message, metadata) => {
        const logger = new InfraLogger(action, userId);
        const lines = captureStdout(() => {
          logger[level](message, metadata);
        });

        const parsed = JSON.parse(lines[0].trimEnd());

        // Required fields
        assert.ok("timestamp" in parsed, "Missing timestamp field");
        assert.ok("level" in parsed, "Missing level field");
        assert.ok("requestId" in parsed, "Missing requestId field");
        assert.ok("userId" in parsed, "Missing userId field");
        assert.ok("action" in parsed, "Missing action field");
        assert.ok("message" in parsed, "Missing message field");

        // Field value correctness
        assert.match(
          parsed.timestamp as string,
          ISO_8601_REGEX,
          `timestamp is not ISO 8601: ${parsed.timestamp}`
        );
        assert.equal(parsed.level, level);
        assert.match(
          parsed.requestId as string,
          UUID_V4_REGEX,
          `requestId is not a valid UUID v4: ${parsed.requestId}`
        );
        assert.equal(parsed.userId, userId);
        assert.equal(parsed.action, action);
        assert.equal(parsed.message, message);
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 16: requestId is consistent across multiple log calls", () => {
  fc.assert(
    fc.property(
      actionArb,
      userIdArb,
      messageArb,
      messageArb,
      (action, userId, msg1, msg2) => {
        const logger = new InfraLogger(action, userId);
        const lines = captureStdout(() => {
          logger.info(msg1);
          logger.warn(msg2);
        });

        const entry1 = JSON.parse(lines[0].trimEnd());
        const entry2 = JSON.parse(lines[1].trimEnd());

        assert.equal(
          entry1.requestId,
          entry2.requestId,
          "requestId must be consistent across calls"
        );
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 16: done() includes non-negative duration in milliseconds", () => {
  fc.assert(
    fc.property(
      actionArb,
      userIdArb,
      messageArb,
      metadataArb,
      (action, userId, message, metadata) => {
        const logger = new InfraLogger(action, userId);
        const lines = captureStdout(() => {
          logger.done(message, metadata);
        });

        const parsed = JSON.parse(lines[0].trimEnd());

        // duration must be present
        assert.ok("duration" in parsed, "done() output must include duration field");

        // duration must be a number
        assert.equal(
          typeof parsed.duration,
          "number",
          `duration must be a number, got: ${typeof parsed.duration}`
        );

        // duration must be non-negative
        assert.ok(
          parsed.duration >= 0,
          `duration must be non-negative, got: ${parsed.duration}`
        );
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 16: done() sets level to info", () => {
  fc.assert(
    fc.property(
      actionArb,
      userIdArb,
      messageArb,
      (action, userId, message) => {
        const logger = new InfraLogger(action, userId);
        const lines = captureStdout(() => {
          logger.done(message);
        });

        const parsed = JSON.parse(lines[0].trimEnd());
        assert.equal(parsed.level, "info", "done() should emit at info level");
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 16: metadata is included when provided", () => {
  fc.assert(
    fc.property(
      actionArb,
      userIdArb,
      messageArb,
      fc
        .array(
          fc.tuple(
            fc
              .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
                minLength: 1,
                maxLength: 10,
              })
              .map((chars) => chars.join("")),
            fc.oneof(fc.string(), fc.integer(), fc.boolean())
          ),
          { minLength: 1, maxLength: 5 }
        )
        .map((entries) => Object.fromEntries(entries)),
      (action, userId, message, metadata) => {
        const logger = new InfraLogger(action, userId);
        const lines = captureStdout(() => {
          logger.info(message, metadata);
        });

        const parsed = JSON.parse(lines[0].trimEnd());
        assert.ok("metadata" in parsed, "metadata field should be present when provided");

        // Compare via JSON to avoid prototype differences
        assert.equal(
          JSON.stringify(parsed.metadata),
          JSON.stringify(metadata)
        );
      }
    ),
    { numRuns: 100 }
  );
});
