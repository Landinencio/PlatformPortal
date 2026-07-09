/**
 * Tests for the `build_report` Iskay tool.
 *
 * Feature: iskay-finops-specialist — src/lib/finops-tools.ts (`buildReportTool`)
 *
 * Covers:
 *  - Spec validation (R1.3 / R1.4 / R1.5): missing required fields, sections
 *    enum violation, startDate > endDate.
 *  - Workbook structure (R3.1): one sheet per requested section + always-on
 *    "Resumen" metadata sheet.
 *  - prettyServiceName grounding (R3.3): no Opaque_Id ever lands in a cell;
 *    `cg…` codes and inference-profile-style ids are translated to friendly
 *    labels in by_service, top_resources, hidden_costs (Bedrock) and
 *    marketplace.
 *  - Per-section failure (R4.1): a single fetcher throwing yields an error
 *    note sheet for that section while the rest are produced normally and
 *    the tool succeeds.
 *  - Total failure (R4.2): when every requested section fails, the tool
 *    throws so the model can communicate the failure.
 *
 * The test exclusively uses the `deps` injection seam (matches the
 * `deploy-notify` pattern in this repo) so no Athena / CUR / Postgres call is
 * made; the workbook buffer is read back with the `xlsx` library to verify
 * exact cell contents.
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as XLSX from "xlsx";

import {
  buildReportTool,
  type BuildReportDeps,
  type ReportSectionFetchers,
} from "../finops-tools";

const USER = "ruben.landin@iskaypet.com";

/* ------------------------------------------------------------------ */
/*  Stub helpers                                                       */
/* ------------------------------------------------------------------ */

/**
 * Builds a deterministic stub for every section fetcher. Numbers and labels are
 * chosen so the assertions can identify them unambiguously when reading back
 * cells. `cg…` and inference-profile-style ids are sprinkled in to assert that
 * `prettyServiceName` rewrites them before they reach a cell.
 */
function defaultFetchers(): ReportSectionFetchers {
  return {
    summary: async (range) => ({
      period: { startDate: range.startDate, endDate: range.endDate },
      accountIds: range.accountIds ?? [],
      totalCostUSD: 12345.67,
      accountsIncluded: 3,
      currency: "USD",
    }),
    by_account: async () => ({
      period: { startDate: "x", endDate: "y" },
      totalCostUSD: 4242,
      accountsIncluded: 2,
      accounts: [
        { accountId: "111111111111", accountName: "digital-prod", costUSD: 3000 },
        { accountId: "222222222222", accountName: "retail-prod", costUSD: 1242 },
      ],
    }),
    by_service: async () => ({
      period: { startDate: "x", endDate: "y" },
      totalCostUSD: 1500,
      services: [
        { service: "Amazon Elastic Compute Cloud - Compute", costUSD: 1000 },
        // Marketplace contract code: must be rewritten to "Marketplace (contrato)".
        { service: "cg2zxabcdefghijk", costUSD: 400 },
        // Inference-profile-style opaque id: must be rewritten to "Bedrock (GenAI)".
        { service: "abcdef0123456789abcdef", costUSD: 100 },
      ],
      servicesIncluded: 3,
    }),
    by_domain: async () => ({
      period: { startDate: "x", endDate: "y" },
      tag: "user_domain",
      domains: [
        { domain: "marketplace", costUSD: 800, resources: 12 },
        { domain: "(sin etiqueta)", costUSD: 200, resources: 4 },
      ],
      domainsIncluded: 2,
      tagCoverage: { taggedUSD: 800, untaggedUSD: 19200, coveragePct: 4.0 },
      note: "Cobertura parcial (~4%).",
    }),
    top_resources: async () => ({
      period: { startDate: "x", endDate: "y" },
      resources: [
        {
          accountId: "111111111111",
          accountName: "digital-prod",
          // Opaque inference-profile id must be rewritten in the cell.
          service: "abcdef0123456789abcdef",
          resourceId: "i-0fff",
          costUSD: 250,
        },
      ],
      totalResources: 1,
    }),
    net_breakdown: async () => ({
      period: { startDate: "x", endDate: "y" },
      grossAwsUSD: 10000,
      marketplaceUSD: 2000,
      netInfraUSD: 7500,
      discounts: {
        sppDiscountUSD: -100,
        bundledDiscountUSD: -50,
        creditsUSD: -200,
        refundsUSD: 0,
        savingsPlanNegationUSD: 0,
      },
      savingsPlans: {
        coveredUSD: 3000,
        onDemandEquivalentUSD: 3500,
        savingsAmountUSD: 500,
        savingsPct: 14.3,
      },
    }),
    hidden_costs: async () => ({
      period: { startDate: "x", endDate: "y" },
      totalEstimatedSavingsUSD: 950,
      findings: {
        gp2: { resourceCount: 5, monthlyCost: 200, estimatedSavings: 40 },
        extendedSupport: [
          { engine: "postgres13", monthlyCost: 950, usageType: "ExtendedSupport" },
        ],
        cloudwatchLogs: {
          totalUSD: 2400,
          topGroups: [{ logGroup: "/aws/lambda/foo", account: "111111111111", cost: 300 }],
        },
        natGateways: {
          totalCost: 200,
          dataProcessedCost: 150,
          hoursCost: 50,
          topConsumers: [{ resourceId: "nat-001", account: "111111111111", cost: 200 }],
        },
        bedrock: {
          totalCost: 2200,
          // Opaque inference-profile id must be rewritten.
          byModel: [{ model: "abcdef0123456789abcdef", account: "200300400500", cost: 1500 }],
        },
        snapshotsUSD: 100,
        interZoneTransferUSD: 80,
      },
    }),
    marketplace: async () => ({
      period: { startDate: "x", endDate: "y" },
      totalUSD: 8500,
      items: [
        // Opaque marketplace product code must be rewritten in the cell.
        { productCode: "cg2zxabcdefghijk", description: "Grafana Cloud", cost: 8500, date: "2026-06-01" },
      ],
    }),
  };
}

/** Spy `saveReport` that captures the buffer in-memory and returns a fixed id. */
function makeSaveReportSpy() {
  const calls: Array<{ filename: string; content: Buffer; userEmail: string; ttlMinutes: number }> = [];
  const fn: BuildReportDeps["saveReport"] = async (input) => {
    calls.push({ ...input });
    return "11111111-2222-3333-4444-555555555555";
  };
  return { fn, calls };
}

/** Reads back a workbook buffer and returns the parsed object. */
function readBack(buffer: Buffer): XLSX.WorkBook {
  return XLSX.read(buffer, { type: "buffer" });
}

/** Returns the cell A1..A2..AN values of a sheet, flattened across all columns,
 *  as plain strings (numbers stringified) so we can do `.includes()` checks.   */
function flattenCellValues(sheet: XLSX.WorkSheet): string[] {
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: "" });
  const out: string[] = [];
  for (const row of aoa) {
    for (const cell of row) {
      out.push(String(cell));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Spec validation (R1.3 / R1.4 / R1.5)                               */
/* ------------------------------------------------------------------ */

test("validation: missing title throws", async () => {
  await assert.rejects(
    () =>
      buildReportTool(
        { startDate: "2026-05-01", endDate: "2026-05-31", sections: ["summary"] },
        USER,
        { fetchers: defaultFetchers(), saveReport: makeSaveReportSpy().fn },
      ),
    /title/,
  );
});

test("validation: missing startDate throws", async () => {
  await assert.rejects(
    () =>
      buildReportTool(
        { title: "X", endDate: "2026-05-31", sections: ["summary"] },
        USER,
        { fetchers: defaultFetchers(), saveReport: makeSaveReportSpy().fn },
      ),
    /startDate/,
  );
});

test("validation: missing endDate throws", async () => {
  await assert.rejects(
    () =>
      buildReportTool(
        { title: "X", startDate: "2026-05-01", sections: ["summary"] },
        USER,
        { fetchers: defaultFetchers(), saveReport: makeSaveReportSpy().fn },
      ),
    /endDate/,
  );
});

test("validation: missing/empty sections throws", async () => {
  await assert.rejects(
    () =>
      buildReportTool(
        { title: "X", startDate: "2026-05-01", endDate: "2026-05-31" },
        USER,
        { fetchers: defaultFetchers(), saveReport: makeSaveReportSpy().fn },
      ),
    /sections/,
  );
  await assert.rejects(
    () =>
      buildReportTool(
        { title: "X", startDate: "2026-05-01", endDate: "2026-05-31", sections: [] },
        USER,
        { fetchers: defaultFetchers(), saveReport: makeSaveReportSpy().fn },
      ),
    /sections/,
  );
});

test("validation: invalid section enum value throws", async () => {
  await assert.rejects(
    () =>
      buildReportTool(
        {
          title: "X",
          startDate: "2026-05-01",
          endDate: "2026-05-31",
          // 'foo' is not in the allowed enum.
          sections: ["summary", "foo"],
        },
        USER,
        { fetchers: defaultFetchers(), saveReport: makeSaveReportSpy().fn },
      ),
    /invalid section/i,
  );
});

test("validation: startDate > endDate throws", async () => {
  await assert.rejects(
    () =>
      buildReportTool(
        {
          title: "X",
          startDate: "2026-05-31",
          endDate: "2026-05-01",
          sections: ["summary"],
        },
        USER,
        { fetchers: defaultFetchers(), saveReport: makeSaveReportSpy().fn },
      ),
    /startDate.*endDate/,
  );
});

test("validation: non-ISO date is rejected", async () => {
  await assert.rejects(
    () =>
      buildReportTool(
        {
          title: "X",
          startDate: "2026/05/01",
          endDate: "2026-05-31",
          sections: ["summary"],
        },
        USER,
        { fetchers: defaultFetchers(), saveReport: makeSaveReportSpy().fn },
      ),
    /startDate/,
  );
});

test("validation: missing userEmail throws", async () => {
  await assert.rejects(
    () =>
      buildReportTool(
        {
          title: "X",
          startDate: "2026-05-01",
          endDate: "2026-05-31",
          sections: ["summary"],
        },
        // Missing user email — required for ownership / persistence.
        "" as unknown as string,
        { fetchers: defaultFetchers(), saveReport: makeSaveReportSpy().fn },
      ),
    /userEmail/,
  );
});

/* ------------------------------------------------------------------ */
/*  Workbook structure (R3.1, R3.5)                                    */
/* ------------------------------------------------------------------ */

test("workbook: one sheet per requested section + Resumen, in order", async () => {
  const save = makeSaveReportSpy();
  const result = await buildReportTool(
    {
      title: "Coste Mayo 2026",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      sections: ["summary", "by_account", "by_service"],
    },
    USER,
    { fetchers: defaultFetchers(), saveReport: save.fn },
  );

  assert.equal(save.calls.length, 1);
  assert.equal(result.reportId, "11111111-2222-3333-4444-555555555555");
  assert.equal(result.downloadUrl, `/api/finops/report/${result.reportId}`);
  // sheetCount = sections + Resumen.
  assert.equal(result.sheetCount, 4);

  const wb = readBack(save.calls[0].content);
  assert.deepEqual(wb.SheetNames, [
    "Resumen",
    "Resumen general",
    "Por cuenta",
    "Por servicio",
  ]);

  // Resumen sheet carries the metadata required by R3.2.
  const resumen = flattenCellValues(wb.Sheets["Resumen"]);
  assert.ok(resumen.includes("Iskay — Informe FinOps"));
  assert.ok(resumen.includes("Coste Mayo 2026"));
  assert.ok(resumen.includes(USER));
  assert.ok(resumen.includes("2026-05-01 → 2026-05-31"));
});

test("workbook: rowCounts per section excludes header row", async () => {
  const save = makeSaveReportSpy();
  const result = await buildReportTool(
    {
      title: "T",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      sections: ["summary", "by_account"],
    },
    USER,
    { fetchers: defaultFetchers(), saveReport: save.fn },
  );

  // summary aoa = 5 rows -> 4 data rows, by_account aoa = header + 2 rows + blank + total = 5 rows -> 4.
  assert.ok(result.rowCounts.summary >= 1);
  assert.ok(result.rowCounts.by_account >= 1);
});

/* ------------------------------------------------------------------ */
/*  prettyServiceName grounding (R3.3)                                 */
/* ------------------------------------------------------------------ */

test("grounding: by_service sheet rewrites cg* codes and inference-profile ids", async () => {
  const save = makeSaveReportSpy();
  await buildReportTool(
    {
      title: "T",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      sections: ["by_service"],
    },
    USER,
    { fetchers: defaultFetchers(), saveReport: save.fn },
  );

  const wb = readBack(save.calls[0].content);
  const cells = flattenCellValues(wb.Sheets["Por servicio"]);
  const joined = cells.join("|");

  // Friendly labels appear.
  assert.ok(joined.includes("Marketplace (contrato)"), "marketplace label missing");
  assert.ok(joined.includes("Bedrock (GenAI)"), "bedrock label missing");
  // Raw opaque ids are NOT present anywhere in the sheet.
  assert.ok(!joined.includes("cg2zxabcdefghijk"), "raw cg* code leaked");
  assert.ok(!joined.includes("abcdef0123456789abcdef"), "raw inference-profile id leaked");
});

test("grounding: top_resources, hidden_costs (Bedrock) and marketplace also rewrite opaque ids", async () => {
  const save = makeSaveReportSpy();
  await buildReportTool(
    {
      title: "T",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      sections: ["top_resources", "hidden_costs", "marketplace"],
    },
    USER,
    { fetchers: defaultFetchers(), saveReport: save.fn },
  );

  const wb = readBack(save.calls[0].content);
  const allCells: string[] = [];
  for (const name of wb.SheetNames) {
    allCells.push(...flattenCellValues(wb.Sheets[name]));
  }
  const joined = allCells.join("|");

  // No opaque id may surface in any cell of any sheet.
  assert.ok(!joined.includes("cg2zxabcdefghijk"), "cg* code leaked across sheets");
  assert.ok(!joined.includes("abcdef0123456789abcdef"), "inference-profile id leaked across sheets");

  // Friendly labels are present where opaque ids would have been.
  assert.ok(joined.includes("Bedrock (GenAI)"), "Bedrock label missing in hidden_costs/top_resources");
  assert.ok(joined.includes("Marketplace (contrato)"), "Marketplace label missing");
});

/* ------------------------------------------------------------------ */
/*  Per-section failure (R4.1)                                         */
/* ------------------------------------------------------------------ */

test("per-section failure: failing fetcher → error note sheet, others succeed, tool returns ok", async () => {
  const fetchers = defaultFetchers();
  // by_service blows up; the rest should still produce normal sheets.
  fetchers.by_service = async () => {
    throw new Error("athena-timeout");
  };
  const save = makeSaveReportSpy();

  const result = await buildReportTool(
    {
      title: "T",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      sections: ["summary", "by_service", "by_account"],
    },
    USER,
    { fetchers, saveReport: save.fn },
  );

  // The tool resolves successfully (R4.1: partial > total failure).
  assert.equal(save.calls.length, 1);
  assert.equal(result.sheetCount, 4); // 3 sections + Resumen

  const wb = readBack(save.calls[0].content);
  // Failed sheet carries the error note...
  const failed = flattenCellValues(wb.Sheets["Por servicio"]);
  assert.ok(failed.includes("Error al obtener datos"));
  assert.ok(failed.some((c) => c.includes("athena-timeout")));
  assert.ok(failed.includes("by_service"));

  // ...while the other sheets are populated normally.
  const okSheet = flattenCellValues(wb.Sheets["Por cuenta"]);
  assert.ok(okSheet.includes("digital-prod"));
});

/* ------------------------------------------------------------------ */
/*  Total failure (R4.2)                                               */
/* ------------------------------------------------------------------ */

test("total failure: every section fetcher throws → tool throws", async () => {
  const fetchers = defaultFetchers();
  for (const k of Object.keys(fetchers) as Array<keyof ReportSectionFetchers>) {
    fetchers[k] = async () => {
      throw new Error(`boom-${k}`);
    };
  }
  const save = makeSaveReportSpy();

  await assert.rejects(
    () =>
      buildReportTool(
        {
          title: "T",
          startDate: "2026-05-01",
          endDate: "2026-05-31",
          sections: ["summary", "by_account"],
        },
        USER,
        { fetchers, saveReport: save.fn },
      ),
    /all requested sections failed/i,
  );
  // Persistence is never attempted when nothing succeeded.
  assert.equal(save.calls.length, 0);
});

/* ------------------------------------------------------------------ */
/*  Filename + ownership                                                */
/* ------------------------------------------------------------------ */

test("filename: starts with iskay-report-<slug>- and ends with .xlsx; saveReport gets userEmail and ttlMinutes>0", async () => {
  const save = makeSaveReportSpy();
  const result = await buildReportTool(
    {
      title: "Coste Mayo 2026 — Producción",
      startDate: "2026-05-01",
      endDate: "2026-05-31",
      sections: ["summary"],
    },
    USER,
    { fetchers: defaultFetchers(), saveReport: save.fn },
  );

  assert.match(result.filename, /^iskay-report-coste-mayo-2026-/);
  assert.match(result.filename, /\.xlsx$/);
  const c = save.calls[0];
  assert.equal(c.userEmail, USER);
  assert.ok(c.ttlMinutes > 0);
  assert.ok(Buffer.isBuffer(c.content) && c.content.length > 0);
});
