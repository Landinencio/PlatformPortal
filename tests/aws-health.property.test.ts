/**
 * Unit + property-based tests for the pure helpers of aws-health.
 *
 * Feature: finops-ai-observability
 * Validates the design's correctness properties that are checkable on pure logic:
 *   - Property 5: inferSeverity(category, status) is TOTAL and deterministic, always
 *     returning one of { alta, media, baja } for any input (unknown category -> baja,
 *     any closed -> baja).                                  **Validates: Requirements 3.3**
 *
 * The normalizeHealthEvent invariants exercised here support Property 6 (per-arn
 * upsert) by guaranteeing a stable, well-typed AwsNewsItem (arn always present,
 * category/statusCode constrained to the typed unions, severity consistent with the
 * raw inputs). The DB-side upsert/degradation (Properties 6 & 8) is verified manually
 * against PostgreSQL per the design's Testing Strategy.
 *
 * Only the pure helpers are exercised here (no SQS / DB I/O).
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  inferSeverity,
  normalizeHealthEvent,
  type AwsNewsItem,
} from "../src/lib/aws-health";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

const SEVERITIES = ["alta", "media", "baja"] as const;
const KNOWN_CATEGORIES = ["issue", "scheduledChange", "accountNotification"] as const;
const KNOWN_STATUSES = ["open", "upcoming", "closed"] as const;

/** Any string for category/status, plus the known values weighted in. */
const categoryArb = fc.oneof(
  fc.constantFrom(...KNOWN_CATEGORIES),
  fc.string(),
  fc.constantFrom("", "ISSUE", "unknownCategory", "scheduled_change"),
);

const statusArb = fc.oneof(
  fc.constantFrom(...KNOWN_STATUSES),
  fc.string(),
  fc.constantFrom("", "OPEN", "Closed", "resolved", "active"),
);

const accountIdArb = fc.constantFrom(
  "444455556666",
  "600700800900",
  "111222333444",
  "111122223333",
);

/** A loosely-structured aws.health detail, with arbitrary/missing fields. */
const detailArb = fc.record(
  {
    eventArn: fc.option(fc.string(), { nil: undefined }),
    service: fc.option(fc.constantFrom("EC2", "RDS", "LAMBDA", "S3", ""), { nil: undefined }),
    eventRegion: fc.option(fc.constantFrom("eu-west-1", "us-east-1"), { nil: undefined }),
    eventTypeCategory: categoryArb,
    statusCode: statusArb,
    eventTypeCode: fc.option(fc.string(), { nil: undefined }),
    account: fc.option(accountIdArb, { nil: undefined }),
    startTime: fc.option(
      fc.constantFrom("2026-06-01T10:00:00Z", "invalid-date", "2026-06-03T00:00:00Z"),
      { nil: undefined },
    ),
    endTime: fc.option(fc.constantFrom("2026-06-02T10:00:00Z", ""), { nil: undefined }),
    lastUpdatedTime: fc.option(fc.constantFrom("2026-06-01T12:00:00Z"), { nil: undefined }),
    eventDescription: fc.option(
      fc.array(fc.record({ latestDescription: fc.string() })),
      { nil: undefined },
    ),
  },
  { requiredKeys: ["eventTypeCategory", "statusCode"] },
);

const accountNameMapArb = fc.constant({
  "444455556666": "dp-tooling",
  "600700800900": "root-iskaypet",
  "111222333444": "digital-prod",
});

/* ------------------------------------------------------------------ */
/*  Property 5: severity is deterministic and total                   */
/*  **Validates: Requirements 3.3**                                    */
/* ------------------------------------------------------------------ */

test("Property 5: inferSeverity always returns one of {alta, media, baja}", () => {
  fc.assert(
    fc.property(categoryArb, statusArb, (category, status) => {
      const severity = inferSeverity(category, status);
      assert.ok(
        (SEVERITIES as readonly string[]).includes(severity),
        `unexpected severity '${severity}' for (${JSON.stringify(category)}, ${JSON.stringify(status)})`,
      );
    }),
    { numRuns: 500 },
  );
});

test("Property 5: inferSeverity is deterministic (same input -> same output)", () => {
  fc.assert(
    fc.property(categoryArb, statusArb, (category, status) => {
      assert.equal(inferSeverity(category, status), inferSeverity(category, status));
    }),
    { numRuns: 300 },
  );
});

test("Property 5: any closed status -> baja regardless of category", () => {
  fc.assert(
    fc.property(categoryArb, (category) => {
      assert.equal(inferSeverity(category, "closed"), "baja");
    }),
    { numRuns: 300 },
  );
});

test("Property 5: unknown/empty category (not closed) -> baja", () => {
  fc.assert(
    fc.property(
      fc.string().filter((s) => !KNOWN_CATEGORIES.includes(s as any)),
      fc.constantFrom("open", "upcoming", "active", ""),
      (category, status) => {
        assert.equal(inferSeverity(category, status), "baja");
      },
    ),
    { numRuns: 300 },
  );
});

test("Property 5 (examples): the design's canonical mapping", () => {
  assert.equal(inferSeverity("issue", "open"), "alta");
  assert.equal(inferSeverity("scheduledChange", "upcoming"), "media");
  assert.equal(inferSeverity("scheduledChange", "open"), "media");
  assert.equal(inferSeverity("accountNotification", "open"), "baja");
  assert.equal(inferSeverity("issue", "closed"), "baja");
  assert.equal(inferSeverity("scheduledChange", "closed"), "baja");
  assert.equal(inferSeverity("totallyUnknown", "open"), "baja");
  assert.equal(inferSeverity("", ""), "baja");
});

/* ------------------------------------------------------------------ */
/*  normalizeHealthEvent invariants (supporting Property 6)            */
/* ------------------------------------------------------------------ */

test("normalize: arn is always a non-empty string", () => {
  fc.assert(
    fc.property(detailArb, accountNameMapArb, (detail, map) => {
      const item = normalizeHealthEvent(detail, map);
      assert.equal(typeof item.arn, "string");
      assert.ok(item.arn.length > 0, "arn must be non-empty");
    }),
    { numRuns: 300 },
  );
});

test("normalize: category and statusCode are constrained to the typed unions", () => {
  fc.assert(
    fc.property(detailArb, accountNameMapArb, (detail, map) => {
      const item = normalizeHealthEvent(detail, map);
      assert.ok(["issue", "scheduledChange", "accountNotification"].includes(item.category));
      assert.ok(["open", "upcoming", "closed"].includes(item.statusCode));
      assert.ok((SEVERITIES as readonly string[]).includes(item.severity));
    }),
    { numRuns: 300 },
  );
});

test("normalize: severity matches inferSeverity on the RAW inputs", () => {
  fc.assert(
    fc.property(detailArb, accountNameMapArb, (detail, map) => {
      const item = normalizeHealthEvent(detail, map);
      const expected = inferSeverity(
        String(detail.eventTypeCategory ?? ""),
        String(detail.statusCode ?? ""),
      );
      assert.equal(item.severity, expected);
    }),
    { numRuns: 300 },
  );
});

test("normalize: missing eventArn yields a deterministic synthetic arn", () => {
  const detail = {
    service: "EC2",
    eventTypeCategory: "issue",
    statusCode: "open",
    eventTypeCode: "AWS_EC2_OPERATIONAL_ISSUE",
    account: "444455556666",
    startTime: "2026-06-01T10:00:00Z",
  };
  const a = normalizeHealthEvent(detail, {});
  const b = normalizeHealthEvent(detail, {});
  assert.equal(a.arn, b.arn, "synthetic arn must be deterministic");
  assert.ok(a.arn.startsWith("synthetic:aws-health:"), `unexpected arn ${a.arn}`);
});

test("normalize: present eventArn is used verbatim (stable PK for upsert)", () => {
  const detail = {
    eventArn: "arn:aws:health:eu-west-1::event/EC2/AWS_EC2_OPERATIONAL_ISSUE/abc123",
    service: "EC2",
    eventTypeCategory: "issue",
    statusCode: "open",
    account: "444455556666",
  };
  const item = normalizeHealthEvent(detail, {});
  assert.equal(item.arn, detail.eventArn);
});

test("normalize: maps the originating account to a friendly name", () => {
  const detail = {
    eventArn: "arn:aws:health:eu-west-1::event/RDS/x/y",
    service: "RDS",
    eventTypeCategory: "scheduledChange",
    statusCode: "upcoming",
    account: "111222333444",
  };
  const item = normalizeHealthEvent(detail, { "111222333444": "digital-prod" });
  assert.deepEqual(item.affectedAccounts, [
    { accountId: "111222333444", accountName: "digital-prod" },
  ]);
});

test("normalize: unknown account falls back to id as name", () => {
  const detail = {
    eventArn: "arn:aws:health:eu-west-1::event/RDS/x/z",
    service: "RDS",
    eventTypeCategory: "accountNotification",
    statusCode: "open",
    account: "999999999999",
  };
  const item = normalizeHealthEvent(detail, {});
  assert.deepEqual(item.affectedAccounts, [
    { accountId: "999999999999", accountName: "999999999999" },
  ]);
});

test("normalize: tolerates null/garbage detail without throwing", () => {
  for (const bad of [null, undefined, 42, "string", [], {}]) {
    const item = normalizeHealthEvent(bad as any, {});
    assert.equal(typeof item.arn, "string");
    assert.ok(item.arn.length > 0);
    assert.equal(item.service, "unknown");
    assert.ok((SEVERITIES as readonly string[]).includes(item.severity));
  }
});

test("normalize: concatenates eventDescription latestDescription entries", () => {
  const item = normalizeHealthEvent(
    {
      eventArn: "arn:aws:health:eu-west-1::event/EC2/x/d",
      service: "EC2",
      eventTypeCategory: "issue",
      statusCode: "open",
      eventDescription: [
        { latestDescription: "First update." },
        { latestDescription: "Second update." },
      ],
    },
    {},
  );
  assert.equal(item.description, "First update.\n\nSecond update.");
});

test("normalize: invalid timestamps become null (no Invalid Date)", () => {
  const item: AwsNewsItem = normalizeHealthEvent(
    {
      eventArn: "arn:aws:health:eu-west-1::event/EC2/x/t",
      service: "EC2",
      eventTypeCategory: "issue",
      statusCode: "open",
      startTime: "not-a-date",
      endTime: "",
    },
    {},
  );
  assert.equal(item.startTime, null);
  assert.equal(item.endTime, null);
});
