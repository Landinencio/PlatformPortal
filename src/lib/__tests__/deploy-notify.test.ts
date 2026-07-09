/**
 * Tests for the prod-deploy → Teams notification.
 *
 * Feature: prod-deploy-teams-notify — src/lib/deploy-notify.ts
 *
 * Covers:
 *  - detectProdDeploy: success+match, no-match, failed deploy job, non-prod jobs,
 *    mobile stages, missing object_attributes, missing/empty/null builds.
 *  - buildDeployInfo: MR from payload, MR via commit lookup, fallback on API error.
 *  - buildDeployCard: facts present, conditional actions, message/attachments shape.
 *  - notifyProdDeploy: disabled, not-prod-deploy, already-notified, claim-error,
 *    no-webhook, send-failed, happy path, concurrency (1st sends, 2nd does not).
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  detectProdDeploy,
  buildDeployInfo,
  buildDeployCard,
  notifyProdDeploy,
  type DeployInfo,
  type ClaimResult,
} from "../deploy-notify";

/* ------------------------------------------------------------------ */
/*  Fixtures                                                           */
/* ------------------------------------------------------------------ */

function pipelinePayload(opts: {
  status?: string;
  builds?: Array<{ name?: string | null; stage?: string | null; status?: string; finished_at?: string | null }>;
  mr?: any;
} = {}): any {
  return {
    object_kind: "pipeline",
    object_attributes: { id: 9001, ref: "main", status: opts.status ?? "success", url: "https://gitlab.com/iskaypetcom/digital/marketplace/marketplace-products-api/-/pipelines/9001" },
    project: {
      id: 4242,
      path_with_namespace: "iskaypetcom/digital/marketplace/marketplace-products-api",
      web_url: "https://gitlab.com/iskaypetcom/digital/marketplace/marketplace-products-api",
    },
    commit: { id: "abcdef1234567890", message: "fix: resolve null pointer\n\nbody", author: { name: "Jane Dev", email: "jane@iskaypet.com" } },
    builds: opts.builds ?? [{ name: "deploy_prod", stage: "deploy", status: "success", finished_at: "2026-06-10T10:00:00Z" }],
    merge_request: opts.mr,
  };
}

/* ------------------------------------------------------------------ */
/*  detectProdDeploy                                                   */
/* ------------------------------------------------------------------ */

test("detectProdDeploy: success pipeline + successful deploy_prod build → true", () => {
  const d = detectProdDeploy(pipelinePayload());
  assert.equal(d.isProdDeploy, true);
  assert.equal(d.job?.name, "deploy_prod");
});

test("detectProdDeploy: success pipeline, no deploy build → false", () => {
  const d = detectProdDeploy(pipelinePayload({ builds: [{ name: "test", stage: "test", status: "success" }] }));
  assert.equal(d.isProdDeploy, false);
  assert.equal(d.job, null);
});

test("detectProdDeploy: deploy build present but failed → false", () => {
  const d = detectProdDeploy(pipelinePayload({ builds: [{ name: "deploy_prod", stage: "deploy", status: "failed" }] }));
  assert.equal(d.isProdDeploy, false);
});

test("detectProdDeploy: non-prod deploy jobs → false", () => {
  const d = detectProdDeploy(
    pipelinePayload({ builds: [{ name: "deploy_dev", stage: "deploy", status: "success" }, { name: "deploy_uat", stage: "deploy", status: "success" }] }),
  );
  assert.equal(d.isProdDeploy, false);
});

test("detectProdDeploy: mobile store stage → true", () => {
  const d = detectProdDeploy(pipelinePayload({ builds: [{ name: "android_playstore_prod", stage: "publish", status: "success" }] }));
  assert.equal(d.isProdDeploy, true);
});

test("detectProdDeploy: matches by stage when name does not", () => {
  const d = detectProdDeploy(pipelinePayload({ builds: [{ name: "release", stage: "deploy_prod", status: "success" }] }));
  assert.equal(d.isProdDeploy, true);
});

test("detectProdDeploy: pipeline status not success → false", () => {
  assert.equal(detectProdDeploy(pipelinePayload({ status: "running" })).isProdDeploy, false);
});

test("detectProdDeploy: missing object_attributes → false, no throw", () => {
  assert.equal(detectProdDeploy({ builds: [{ name: "deploy_prod", status: "success" }] }).isProdDeploy, false);
});

test("detectProdDeploy: builds missing / empty / null fields → false, no throw", () => {
  assert.equal(detectProdDeploy({ object_attributes: { status: "success" } }).isProdDeploy, false);
  assert.equal(detectProdDeploy(pipelinePayload({ builds: [] })).isProdDeploy, false);
  assert.equal(
    detectProdDeploy(pipelinePayload({ builds: [{ name: null, stage: null, status: "success" }] })).isProdDeploy,
    false,
  );
});

/* ------------------------------------------------------------------ */
/*  buildDeployInfo                                                    */
/* ------------------------------------------------------------------ */

test("buildDeployInfo: uses MR from payload when present", async () => {
  const payload = pipelinePayload({
    mr: { iid: 55, title: "Add pagination", author: { name: "Jane Dev" }, url: "https://gitlab.com/x/-/merge_requests/55" },
  });
  const info = await buildDeployInfo(payload, { getMergeRequestsForCommit: async () => { throw new Error("should not be called"); } });
  assert.equal(info.mr?.iid, 55);
  assert.equal(info.mr?.title, "Add pagination");
  assert.equal(info.projectName, "marketplace-products-api");
  assert.equal(info.team, "marketplace");
  assert.equal(info.commitShort, "abcdef12");
});

test("buildDeployInfo: falls back to commit→MR lookup when no payload MR", async () => {
  const payload = pipelinePayload();
  const info = await buildDeployInfo(payload, {
    getMergeRequestsForCommit: async () => [{ iid: 77, title: "From lookup" }],
  });
  assert.equal(info.mr?.iid, 77);
  assert.equal(info.mr?.title, "From lookup");
});

test("buildDeployInfo: never throws on GitLab API failure → mr null", async () => {
  const payload = pipelinePayload();
  const info = await buildDeployInfo(payload, {
    getMergeRequestsForCommit: async () => { throw new Error("api down"); },
  });
  assert.equal(info.mr, null);
  assert.equal(info.commitMessage, "fix: resolve null pointer");
});

/* ------------------------------------------------------------------ */
/*  buildDeployCard                                                    */
/* ------------------------------------------------------------------ */

const sampleInfo: DeployInfo = {
  projectName: "marketplace-products-api",
  projectPath: "iskaypetcom/digital/marketplace/marketplace-products-api",
  team: "marketplace",
  environment: "production",
  deployedAt: "2026-06-10T10:00:00Z",
  jobName: "deploy_prod",
  ref: "main",
  commitSha: "abcdef1234567890",
  commitShort: "abcdef12",
  commitMessage: "fix: resolve null pointer",
  commitAuthor: "Jane Dev",
  pipelineId: 9001,
  pipelineUrl: "https://gitlab.com/x/-/pipelines/9001",
  projectWebUrl: "https://gitlab.com/x",
  mr: { iid: 55, title: "Add pagination", author: "Jane Dev", url: "https://gitlab.com/x/-/merge_requests/55" },
};

test("buildDeployCard: message/attachments shape + facts + 3 actions", () => {
  const card = buildDeployCard(sampleInfo) as any;
  assert.equal(card.type, "message");
  assert.equal(card.attachments[0].contentType, "application/vnd.microsoft.card.adaptive");
  const content = card.attachments[0].content;
  assert.equal(content.type, "AdaptiveCard");
  const factSet = content.body.find((b: any) => b.type === "FactSet");
  const titles = factSet.facts.map((f: any) => f.title);
  for (const t of ["Microservicio", "Entorno", "Cuándo", "Rama/Tag", "Commit", "Autor", "MR", "Pipeline"]) {
    assert.ok(titles.includes(t), `missing fact ${t}`);
  }
  assert.equal(content.actions.length, 3); // MR + pipeline + project
});

test("buildDeployCard: no MR → no 'Ver MR' action and no MR fact", () => {
  const card = buildDeployCard({ ...sampleInfo, mr: null }) as any;
  const content = card.attachments[0].content;
  const actionTitles = (content.actions || []).map((a: any) => a.title);
  assert.ok(!actionTitles.includes("Ver MR"));
  const factSet = content.body.find((b: any) => b.type === "FactSet");
  assert.ok(!factSet.facts.map((f: any) => f.title).includes("MR"));
});

/* ------------------------------------------------------------------ */
/*  notifyProdDeploy                                                   */
/* ------------------------------------------------------------------ */

const okClaim = async (): Promise<ClaimResult> => ({ ok: true });

function baseDeps(over: any = {}) {
  return {
    enabled: "true",
    claim: okClaim,
    buildInfo: async () => sampleInfo,
    sendCard: async () => true,
    webhookUrl: "https://teams.invalid/deploy",
    ...over,
  };
}

test("notifyProdDeploy: gate disabled → {sent:false, reason:disabled}, no send", async () => {
  let sent = false;
  const r = await notifyProdDeploy(pipelinePayload(), baseDeps({ enabled: "false", sendCard: async () => { sent = true; return true; } }));
  assert.deepEqual(r, { sent: false, reason: "disabled" });
  assert.equal(sent, false);
});

test("notifyProdDeploy: not a prod deploy → not-prod-deploy", async () => {
  const r = await notifyProdDeploy(pipelinePayload({ builds: [{ name: "test", status: "success" }] }), baseDeps());
  assert.deepEqual(r, { sent: false, reason: "not-prod-deploy" });
});

test("notifyProdDeploy: claim already taken → already-notified, no send", async () => {
  let sent = false;
  const r = await notifyProdDeploy(pipelinePayload(), baseDeps({ claim: async () => ({ ok: false }), sendCard: async () => { sent = true; return true; } }));
  assert.deepEqual(r, { sent: false, reason: "already-notified" });
  assert.equal(sent, false);
});

test("notifyProdDeploy: claim DB error → claim-error", async () => {
  const r = await notifyProdDeploy(pipelinePayload(), baseDeps({ claim: async () => ({ ok: false, error: true }) }));
  assert.deepEqual(r, { sent: false, reason: "claim-error" });
});

test("notifyProdDeploy: no webhook → no-webhook", async () => {
  const r = await notifyProdDeploy(pipelinePayload(), baseDeps({ webhookUrl: undefined }));
  assert.deepEqual(r, { sent: false, reason: "no-webhook" });
});

test("notifyProdDeploy: send failure → send-failed", async () => {
  const r = await notifyProdDeploy(pipelinePayload(), baseDeps({ sendCard: async () => false }));
  assert.deepEqual(r, { sent: false, reason: "send-failed" });
});

test("notifyProdDeploy: happy path → sent, sendCard called once", async () => {
  let calls = 0;
  const r = await notifyProdDeploy(pipelinePayload(), baseDeps({ sendCard: async () => { calls++; return true; } }));
  assert.deepEqual(r, { sent: true, reason: "sent" });
  assert.equal(calls, 1);
});

test("notifyProdDeploy: concurrency — only the claim winner sends", async () => {
  // Shared claim: first call wins, rest lose (simulates ON CONFLICT DO NOTHING).
  let claimed = false;
  const claim = async (): Promise<ClaimResult> => {
    if (claimed) return { ok: false };
    claimed = true;
    return { ok: true };
  };
  let sends = 0;
  const deps = baseDeps({ claim, sendCard: async () => { sends++; return true; } });
  const [a, b] = await Promise.all([
    notifyProdDeploy(pipelinePayload(), deps),
    notifyProdDeploy(pipelinePayload(), deps),
  ]);
  const sentFlags = [a.sent, b.sent];
  assert.equal(sentFlags.filter(Boolean).length, 1);
  assert.equal(sends, 1);
});
