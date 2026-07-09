/**
 * Tests for the daily FinOps digest (deterministic, no Bedrock).
 *
 * Feature: finops-ai-observability — src/lib/finops-daily-digest.ts
 *
 * Covers:
 *  - Property 9: never throws on a partial failure; if the cost summary fails but there
 *    are news, returns { finopsSent:false, newsSent:true }.   **Validates: Req 5.8**
 *  - Property 10: sent EXCLUSIVELY to FINOPS_TEAMS_WEBHOOK_URL. **Validates: Req 5.4**
 *  - costWindows: MTD vs same-days-of-previous-month is well-formed.
 *  - buildFinopsSummary: month-over-month delta + big-charge highlighting (Grafana case).
 *  - resolveDigestMode + single/split wiring.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  runDailyFinOpsDigest,
  resolveDigestMode,
  costWindows,
  buildFinopsSummary,
  monthProjection,
  prettyService,
  buildSingleCard,
  buildFinopsCard,
  buildNewsCard,
  buildNewsMarkdown,
  type DigestDependencies,
  type FinopsSummary,
} from "../finops-daily-digest";
import type { AwsNewsItem } from "../aws-health";

const FINOPS_WEBHOOK = "https://fake.webhook.invalid/finops";
const SRE_WEBHOOK = "https://fake.webhook.invalid/sre";
const DASHBOARD = "https://portal.today.tooling.dp.iskaypet.com/finops";
const HOME = "https://portal.today.tooling.dp.iskaypet.com";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

/** A Lambda `costs` payload stub: total + per-account/service breakdown. */
function costsPayload(total: number, services: Record<string, number> = {}, flaggedDays: any[] = []) {
  return {
    summary: { totalCost: total },
    accounts: [{ accountId: "111111111111", services: Object.entries(services).map(([name, cost]) => ({ name, cost })) }],
    anomalies: { flaggedDays },
  };
}

const newsItemArb: fc.Arbitrary<AwsNewsItem> = fc.record({
  arn: fc.string({ minLength: 1, maxLength: 30 }),
  service: fc.constantFrom("EC2", "RDS", "S3", "Lambda", "EKS"),
  region: fc.constantFrom("eu-west-1", "us-east-1", null),
  category: fc.constantFrom("issue", "scheduledChange", "accountNotification"),
  statusCode: fc.constantFrom("open", "upcoming", "closed"),
  severity: fc.constantFrom("alta", "media", "baja"),
  startTime: fc.constant(null),
  endTime: fc.constant(null),
  lastUpdated: fc.constant(null),
  affectedAccounts: fc.array(
    fc.record({ accountId: fc.string({ minLength: 1, maxLength: 12 }), accountName: fc.string({ maxLength: 20 }) }),
    { maxLength: 3 },
  ),
  description: fc.string({ maxLength: 200 }),
});

function makeDeps(overrides: Partial<DigestDependencies>): Partial<DigestDependencies> {
  return {
    resolveAccountIds: async () => ["111111111111", "222222222222"],
    fetchCosts: async () => costsPayload(1000),
    fetchNews: async () => [],
    sendCard: async () => true,
    webhookUrl: FINOPS_WEBHOOK,
    mode: "split",
    dashboardUrl: DASHBOARD,
    homeUrl: HOME,
    now: () => new Date("2026-06-15T08:20:00.000Z"),
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  resolveDigestMode                                                  */
/* ------------------------------------------------------------------ */

test("resolveDigestMode: only exact 'single' -> single; everything else -> split", () => {
  fc.assert(
    fc.property(fc.oneof(fc.string(), fc.constantFrom("single", "SINGLE", "split", "", undefined)), (raw) => {
      const mode = resolveDigestMode(raw as any);
      assert.ok(mode === "single" || mode === "split");
      assert.equal(mode, String(raw ?? "").trim().toLowerCase() === "single" ? "single" : "split");
    }),
    { numRuns: 200 },
  );
});

/* ------------------------------------------------------------------ */
/*  costWindows                                                        */
/* ------------------------------------------------------------------ */

test("costWindows: yesterday, MTD and prev-month-same-days are well-formed", () => {
  const w = costWindows(new Date("2026-06-15T08:20:00.000Z"));
  assert.equal(w.yesterday, "2026-06-14");
  assert.equal(w.mtdStart, "2026-06-01");
  assert.equal(w.mtdEnd, "2026-06-14");
  assert.equal(w.prevStart, "2026-05-01");
  assert.equal(w.prevEnd, "2026-05-14"); // same day-of-month as yesterday
});

test("costWindows: clamps to previous month length (Mar 31 -> Feb 28)", () => {
  // now = Apr 1 -> yesterday = Mar 31 -> prev month Feb (28 days in 2026)
  const w = costWindows(new Date("2026-04-01T06:00:00.000Z"));
  assert.equal(w.yesterday, "2026-03-31");
  assert.equal(w.prevStart, "2026-02-01");
  assert.equal(w.prevEnd, "2026-02-28");
});

test("costWindows: handles year boundary (Jan -> Dec prev year)", () => {
  const w = costWindows(new Date("2026-01-10T06:00:00.000Z"));
  assert.equal(w.yesterday, "2026-01-09");
  assert.equal(w.prevStart, "2025-12-01");
  assert.equal(w.prevEnd, "2025-12-09");
});

/* ------------------------------------------------------------------ */
/*  buildFinopsSummary                                                 */
/* ------------------------------------------------------------------ */

test("buildFinopsSummary: month-over-month delta is correct", () => {
  const w = costWindows(new Date("2026-06-15T00:00:00.000Z"));
  const s = buildFinopsSummary(w, costsPayload(300), costsPayload(12000), costsPayload(10000));
  assert.equal(s.yesterday.cost, 300);
  assert.equal(s.monthToDate.cost, 12000);
  assert.equal(s.prevMonthSameDays.cost, 10000);
  assert.equal(s.momDeltaAbs, 2000);
  assert.ok(s.momDeltaPct !== null && Math.abs(s.momDeltaPct - 20) < 1e-9);
});

test("buildFinopsSummary: surfaces a big one-off charge (Grafana marketplace ~80k)", () => {
  const w = costWindows(new Date("2026-06-15T00:00:00.000Z"));
  const mtd = costsPayload(100000, { cgdwha66labso75ke7c05fbaz: 82000, AmazonEC2: 18000 });
  const prev = costsPayload(20000, { cgdwha66labso75ke7c05fbaz: 2000, AmazonEC2: 18000 });
  const s = buildFinopsSummary(w, costsPayload(0), mtd, prev);
  const mover = s.topMovers.find((m) => m.label === "Marketplace (contrato)");
  assert.ok(mover, "Marketplace jump must be highlighted");
  assert.equal(mover!.deltaAbs, 80000);
  // EC2 flat -> not a mover
  assert.equal(s.topMovers.find((m) => m.label === "EC2"), undefined);
});

test("buildFinopsSummary: momDeltaPct is null when previous period is zero", () => {
  const w = costWindows(new Date("2026-06-15T00:00:00.000Z"));
  const s = buildFinopsSummary(w, costsPayload(0), costsPayload(5000), costsPayload(0));
  assert.equal(s.momDeltaPct, null);
});

/* ------------------------------------------------------------------ */
/*  Projection, infra/marketplace split, top accounts (new)           */
/* ------------------------------------------------------------------ */

test("monthProjection: run-rate extrapolates MTD to the full month", () => {
  // MTD end = 2026-06-14 -> 14 of 30 days elapsed.
  const w = costWindows(new Date("2026-06-15T00:00:00.000Z"));
  const p = monthProjection(w, 14000);
  assert.equal(p.daysElapsed, 14);
  assert.equal(p.daysInMonth, 30);
  assert.equal(p.runRateDaily, 1000);     // 14000 / 14
  assert.equal(p.monthEnd, 30000);        // 1000 * 30
});

test("buildFinopsSummary: projection is attached and consistent with run-rate", () => {
  const w = costWindows(new Date("2026-06-15T00:00:00.000Z"));
  const s = buildFinopsSummary(w, costsPayload(300), costsPayload(14000), costsPayload(10000));
  assert.equal(s.projection.daysElapsed, 14);
  assert.equal(s.projection.runRateDaily, 1000);
  assert.equal(s.projection.monthEnd, 30000);
});

test("buildFinopsSummary: infra MoM excludes the marketplace contract (clean headline)", () => {
  const w = costWindows(new Date("2026-06-15T00:00:00.000Z"));
  // This month: marketplace not yet billed; last month: 80k annual prepay on day 1.
  const mtd = costsPayload(20000, { AmazonEC2: 20000 });
  const prev = costsPayload(100000, { cgdwha66labso75ke7c05fbaz: 80000, AmazonEC2: 20000 });
  const s = buildFinopsSummary(w, costsPayload(0), mtd, prev);

  // Total MoM looks like a scary -80k / -80%...
  assert.equal(s.momDeltaAbs, -80000);
  // ...but infra (sin contratos) is FLAT — the real story.
  assert.equal(s.infra.mtd, 20000);
  assert.equal(s.infra.prev, 20000);
  assert.equal(s.infra.deltaAbs, 0);
  assert.equal(s.infra.deltaPct, 0);
  // Marketplace is separated out.
  assert.equal(s.marketplace.mtd, 0);
  assert.equal(s.marketplace.prev, 80000);
  assert.equal(s.marketplace.deltaAbs, -80000);
});

test("buildFinopsSummary: topAccounts ranks accounts by MTD spend (desc, max 3)", () => {
  const w = costWindows(new Date("2026-06-15T00:00:00.000Z"));
  const mtd = {
    summary: { totalCost: 600 },
    accounts: [
      { accountName: "digital-prod", services: [{ name: "AmazonEC2", cost: 300 }] },
      { accountName: "retail-prod", services: [{ name: "AmazonRDS", cost: 200 }] },
      { accountName: "data-dev", services: [{ name: "Bedrock", cost: 100 }] },
      { accountName: "sandbox", services: [{ name: "AmazonS3", cost: 5 }] },
    ],
    anomalies: { flaggedDays: [] },
  };
  const s = buildFinopsSummary(w, costsPayload(0), mtd, costsPayload(0));
  assert.deepEqual(
    s.topAccounts.map((a) => a.label),
    ["digital-prod", "retail-prod", "data-dev"],
    "top 3 accounts by MTD spend, descending",
  );
  assert.equal(s.topAccounts[0].cost, 300);
});

/* ------------------------------------------------------------------ */
/*  prettyService                                                      */
/* ------------------------------------------------------------------ */

test("prettyService: maps opaque CUR codes to friendly labels", () => {
  // Marketplace contract product codes start with "cg".
  assert.equal(prettyService("cgdwha66labso75ke7c05fbaz"), "Marketplace (contrato)");
  // Bedrock inference-profile ids are long opaque alphanumerics.
  assert.equal(prettyService("7g37zhparap7eesm9k78jrzqc"), "Bedrock (GenAI)");
  // AWS prefixes are trimmed.
  assert.equal(prettyService("AmazonEC2"), "EC2");
  assert.equal(prettyService("AWSCloudFormation"), "CloudFormation");
  // Empty -> Otros.
  assert.equal(prettyService(""), "Otros");
});

test("buildFinopsSummary: a big DROP (marketplace -85k) is surfaced as a mover", () => {
  const w = costWindows(new Date("2026-06-15T00:00:00.000Z"));
  // Marketplace contract present last month, gone this month.
  const mtd = costsPayload(5000, { AmazonEC2: 5000 });
  const prev = costsPayload(90000, { cgdwha66labso75ke7c05fbaz: 85000, AmazonEC2: 5000 });
  const s = buildFinopsSummary(w, costsPayload(0), mtd, prev);
  const mover = s.topMovers.find((m) => m.label === "Marketplace (contrato)");
  assert.ok(mover, "the -85k marketplace drop must be highlighted");
  assert.equal(mover!.deltaAbs, -85000);
});

test("buildFinopsSummary: folds multiple Bedrock ids into one 'Bedrock (GenAI)' row", () => {
  const w = costWindows(new Date("2026-06-15T00:00:00.000Z"));
  const mtd = costsPayload(2000, { "7g37zhparap7eesm9k78jrzqc": 900, "17khu2002f6qgpo5v4c48l86p7": 1100 });
  const prev = costsPayload(0, {});
  const s = buildFinopsSummary(w, costsPayload(0), mtd, prev);
  const mover = s.topMovers.find((m) => m.label === "Bedrock (GenAI)");
  assert.ok(mover, "Bedrock ids must fold into one row");
  assert.equal(mover!.deltaAbs, 2000);
});

/* ------------------------------------------------------------------ */
/*  Cards always carry the dashboard link                              */
/* ------------------------------------------------------------------ */

test("every card variant includes an OpenUrl action and is JSON-serialisable", () => {
  const w = costWindows(new Date("2026-06-15T00:00:00.000Z"));
  const summary = buildFinopsSummary(w, costsPayload(300), costsPayload(12000), costsPayload(10000));
  fc.assert(
    fc.property(fc.array(newsItemArb, { maxLength: 20 }), (news) => {
      // FinOps-flavoured cards link to the dashboard.
      for (const card of [
        buildSingleCard(summary, news, DASHBOARD),
        buildFinopsCard(summary, news.length, DASHBOARD),
        buildSingleCard(null, news, DASHBOARD),
      ]) {
        const content = (card as any).attachments[0].content;
        assert.ok(Array.isArray(content.actions) && content.actions.length === 1);
        assert.equal(content.actions[0].url, DASHBOARD);
        assert.doesNotThrow(() => JSON.stringify(card));
      }
      // The AWS news card links to the HOME (where the sidebar lives), not the dashboard.
      const newsCard = buildNewsCard(news, HOME) as any;
      const newsContent = newsCard.attachments[0].content;
      assert.equal(newsContent.actions[0].url, HOME);
      assert.equal(newsContent.actions[0].title, "Ver en el portal");
    }),
    { numRuns: 100 },
  );
});

test("buildNewsMarkdown: folds repeated events into a single ×N line", () => {
  const vpn = (arn: string): AwsNewsItem => ({
    arn, service: "VPN", region: "eu-west-1", category: "accountNotification", statusCode: "open",
    severity: "baja", startTime: null, endTime: null, lastUpdated: null,
    affectedAccounts: [{ accountId: "300400500600", accountName: "infraestructura" }], description: "tunnel replaced",
  });
  const md = buildNewsMarkdown([vpn("a"), vpn("b"), vpn("c"), vpn("d"), vpn("e")]);
  // Five identical VPN events collapse to one line with ×5, header still says 5.
  assert.ok(md.includes("×5"), `expected a ×5 group, got:\n${md}`);
  assert.ok(md.includes("5 novedades AWS"));
  const vpnLines = md.split("\n").filter((l) => l.startsWith("- ") && l.includes("VPN"));
  assert.equal(vpnLines.length, 1, "the 5 VPN events must render as a single line");
});

test("buildNewsMarkdown: high-severity events lead and trigger an attention header", () => {
  const item = (
    service: string,
    severity: AwsNewsItem["severity"],
  ): AwsNewsItem => ({
    arn: `${service}-${severity}`,
    service,
    region: "eu-west-1",
    category: "issue",
    statusCode: "open",
    severity,
    startTime: null,
    endTime: null,
    lastUpdated: null,
    affectedAccounts: [{ accountId: "1", accountName: "prod" }],
    description: "x",
  });
  // Provided low-first; the renderer must reorder high-severity to the top.
  const md = buildNewsMarkdown([item("S3", "baja"), item("RDS", "media"), item("EC2", "alta")]);

  // Attention header present with the count of high-severity events.
  assert.ok(/severidad ALTA/i.test(md), `expected an ALTA attention header, got:\n${md}`);

  // The first bullet line is the alta (EC2), before media/baja.
  const bullets = md.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(bullets[0].includes("EC2"), `alta must lead, got: ${bullets[0]}`);
  assert.ok(bullets[1].includes("RDS"), "media second");
  assert.ok(bullets[2].includes("S3"), "baja last");
});

test("buildNewsMarkdown: no attention header when there are no high-severity events", () => {
  const baja: AwsNewsItem = {
    arn: "x", service: "VPN", region: "eu-west-1", category: "accountNotification", statusCode: "open",
    severity: "baja", startTime: null, endTime: null, lastUpdated: null,
    affectedAccounts: [], description: "x",
  };
  const md = buildNewsMarkdown([baja]);
  assert.ok(!/severidad ALTA/i.test(md), "no ALTA header when nothing is high-severity");
});

/* ------------------------------------------------------------------ */
/*  Property 9: never throws on partial failure                        */
/* ------------------------------------------------------------------ */

test("Property 9: cost summary fails but news present -> { finopsSent:false, newsSent:true }", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(newsItemArb, { minLength: 1, maxLength: 15 }),
      fc.constantFrom<"single" | "split">("single", "split"),
      async (news, mode) => {
        const result = await runDailyFinOpsDigest(
          makeDeps({
            mode,
            fetchCosts: async () => {
              throw new Error("lambda down");
            },
            fetchNews: async () => news,
          }),
        );
        assert.equal(result.finopsSent, false);
        assert.equal(result.newsSent, true);
        assert.ok(result.errors.some((e) => e.includes("finops summary")));
      },
    ),
    { numRuns: 80 },
  );
});

test("Property 9: every dependency throwing still resolves (no uncaught exception)", async () => {
  const result = await runDailyFinOpsDigest(
    makeDeps({
      fetchCosts: async () => {
        throw new Error("lambda down");
      },
      fetchNews: async () => {
        throw new Error("sqs down");
      },
      sendCard: async () => {
        throw new Error("network down");
      },
    }),
  );
  assert.equal(result.finopsSent, false);
  assert.equal(result.newsSent, false);
  assert.ok(result.errors.length >= 2);
});

/* ------------------------------------------------------------------ */
/*  Property 10: exclusively FINOPS_TEAMS_WEBHOOK_URL                  */
/* ------------------------------------------------------------------ */

test("Property 10: digest is sent exclusively to FINOPS_TEAMS_WEBHOOK_URL", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.array(newsItemArb, { maxLength: 15 }),
      fc.constantFrom<"single" | "split">("single", "split"),
      fc.boolean(),
      async (news, mode, costsOk) => {
        const used: (string | undefined)[] = [];
        await runDailyFinOpsDigest(
          makeDeps({
            mode,
            fetchNews: async () => news,
            fetchCosts: costsOk
              ? async () => costsPayload(1000)
              : async () => {
                  throw new Error("no costs");
                },
            sendCard: async (_card, webhookUrl) => {
              used.push(webhookUrl);
              return true;
            },
            webhookUrl: FINOPS_WEBHOOK,
          }),
        );
        for (const url of used) {
          assert.equal(url, FINOPS_WEBHOOK);
          assert.notEqual(url, SRE_WEBHOOK);
        }
      },
    ),
    { numRuns: 120 },
  );
});

/* ------------------------------------------------------------------ */
/*  Mode wiring                                                        */
/* ------------------------------------------------------------------ */

test("split mode sends two cards when both summary and news are present", async () => {
  let sends = 0;
  const result = await runDailyFinOpsDigest(
    makeDeps({
      mode: "split",
      fetchNews: async () => [
        {
          arn: "a1", service: "EC2", region: "eu-west-1", category: "issue", statusCode: "open",
          severity: "alta", startTime: null, endTime: null, lastUpdated: null, affectedAccounts: [], description: "boom",
        },
      ],
      sendCard: async () => { sends += 1; return true; },
    }),
  );
  assert.equal(sends, 2);
  assert.deepEqual({ f: result.finopsSent, n: result.newsSent }, { f: true, n: true });
});

test("single mode sends exactly one combined card", async () => {
  let sends = 0;
  const result = await runDailyFinOpsDigest(
    makeDeps({
      mode: "single",
      fetchNews: async () => [
        {
          arn: "a1", service: "RDS", region: null, category: "scheduledChange", statusCode: "upcoming",
          severity: "media", startTime: null, endTime: null, lastUpdated: null, affectedAccounts: [], description: "maint",
        },
      ],
      sendCard: async () => { sends += 1; return true; },
    }),
  );
  assert.equal(sends, 1);
  assert.equal(result.finopsSent, true);
  assert.equal(result.newsSent, true);
});

test("missing webhook -> nothing sent, error recorded, no throw", async () => {
  let sends = 0;
  const result = await runDailyFinOpsDigest(
    makeDeps({ webhookUrl: undefined, sendCard: async () => { sends += 1; return true; } }),
  );
  assert.equal(sends, 0);
  assert.equal(result.finopsSent, false);
  assert.equal(result.newsSent, false);
  assert.ok(result.errors.some((e) => e.includes("FINOPS_TEAMS_WEBHOOK_URL")));
});
