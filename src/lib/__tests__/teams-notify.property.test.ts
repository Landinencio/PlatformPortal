/**
 * Tests for the Teams notification helper.
 *
 * Feature: finops-ai-observability
 * Task 10 — src/lib/teams-notify.ts
 *
 * Covers Property 10 indirectly (digest webhook routing relies on sendTeamsCard
 * never throwing and honouring the provided webhook URL) and the structural
 * contract of buildDigestCard used by Requirements 5.6 / 5.9.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { sendTeamsCard, buildDigestCard } from "../teams-notify";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

const factArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 40 }),
  value: fc.string({ minLength: 0, maxLength: 200 }),
});

const buildOptsArb = fc.record({
  title: fc.string({ minLength: 1, maxLength: 80 }),
  markdownSummary: fc.string({ minLength: 0, maxLength: 500 }),
  facts: fc.array(factArb, { minLength: 0, maxLength: 10 }),
  linkUrl: fc.constantFrom(
    "https://portal.today.tooling.dp.iskaypet.com/finops",
    "https://portal.today.tooling.dp.iskaypet.com/finops?tab=costs",
    "",
  ),
});

/* ------------------------------------------------------------------ */
/*  buildDigestCard — structural contract                              */
/* ------------------------------------------------------------------ */

test("buildDigestCard always returns a valid Teams adaptive-card envelope", () => {
  fc.assert(
    fc.property(buildOptsArb, (opts) => {
      const card = buildDigestCard(opts) as any;

      assert.equal(card.type, "message");
      assert.ok(Array.isArray(card.attachments) && card.attachments.length === 1);

      const attachment = card.attachments[0];
      assert.equal(attachment.contentType, "application/vnd.microsoft.card.adaptive");

      const content = attachment.content;
      assert.equal(content.type, "AdaptiveCard");
      assert.equal(content.version, "1.4");
      assert.ok(Array.isArray(content.body) && content.body.length >= 1);

      // First body element is always the bold title carrying the provided text.
      assert.equal(content.body[0].type, "TextBlock");
      assert.equal(content.body[0].text, opts.title);

      // Card must serialise to JSON (Teams transport requirement).
      assert.doesNotThrow(() => JSON.stringify(card));
    }),
    { numRuns: 200 },
  );
});

test("buildDigestCard renders a FactSet iff facts are provided", () => {
  fc.assert(
    fc.property(buildOptsArb, (opts) => {
      const content = (buildDigestCard(opts) as any).attachments[0].content;
      const factSet = (content.body as any[]).find((b) => b.type === "FactSet");

      if (opts.facts.length > 0) {
        assert.ok(factSet, "expected a FactSet when facts are non-empty");
        assert.equal(factSet.facts.length, opts.facts.length);
        // Facts map {name,value} -> {title,value} preserving order.
        factSet.facts.forEach((f: any, i: number) => {
          assert.equal(f.title, opts.facts[i].name);
          assert.equal(f.value, opts.facts[i].value);
        });
      } else {
        assert.equal(factSet, undefined, "no FactSet expected for empty facts");
      }
    }),
    { numRuns: 200 },
  );
});

test("buildDigestCard adds an OpenUrl action only when linkUrl is non-empty", () => {
  fc.assert(
    fc.property(buildOptsArb, (opts) => {
      const content = (buildDigestCard(opts) as any).attachments[0].content;
      if (opts.linkUrl) {
        assert.ok(Array.isArray(content.actions) && content.actions.length === 1);
        assert.equal(content.actions[0].type, "Action.OpenUrl");
        assert.equal(content.actions[0].url, opts.linkUrl);
      } else {
        assert.equal(content.actions, undefined);
      }
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  sendTeamsCard — graceful degradation                               */
/* ------------------------------------------------------------------ */

test("sendTeamsCard returns false and never throws when webhook URL is empty", async () => {
  await fc.assert(
    fc.asyncProperty(fc.constantFrom("", undefined), async (url) => {
      const result = await sendTeamsCard({ type: "message" }, url as string | undefined);
      assert.equal(result, false);
    }),
    { numRuns: 10 },
  );
});

/** Minimal fetch Response stub (Node 16 has no global Response). */
function stubResponse(status: number, body = "") {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

test("sendTeamsCard returns true on a 2xx response", async () => {
  const original = globalThis.fetch;
  (globalThis as any).fetch = async () => stubResponse(200, "1");
  try {
    const ok = await sendTeamsCard({ type: "message" }, "https://example.invalid/webhook");
    assert.equal(ok, true);
  } finally {
    globalThis.fetch = original;
  }
});

test("sendTeamsCard returns false on a non-2xx response without throwing", async () => {
  const original = globalThis.fetch;
  (globalThis as any).fetch = async () => stubResponse(429, "rejected");
  try {
    const ok = await sendTeamsCard({ type: "message" }, "https://example.invalid/webhook");
    assert.equal(ok, false);
  } finally {
    globalThis.fetch = original;
  }
});

test("sendTeamsCard returns false when fetch rejects (network/timeout)", async () => {
  const original = globalThis.fetch;
  (globalThis as any).fetch = async () => {
    throw new Error("network down");
  };
  try {
    const ok = await sendTeamsCard({ type: "message" }, "https://example.invalid/webhook");
    assert.equal(ok, false);
  } finally {
    globalThis.fetch = original;
  }
});
