/**
 * Validation test for the `ai-portal-explorer` CronJob manifest declared in the
 * generic-chart values consumed by GitOps (argocd/tooling shared-apps/portal-{dev,prod}).
 *
 * Feature: ai-portal-explorer (task 17.1) — Requirements 9.3, 9.5.
 *
 * The portal's local Helm values (.helm/values.yaml + values-{dev,prod}.yaml) are the
 * source for the GitOps repo. The cronjobs are declared once (shared) under
 * `generic-chart.cronjobs.jobs`, disabled by default and enabled only in prod
 * (values-prod.yaml `cronjobs.enabled: true`). The chart injects the ESO secret
 * `portal-env` into every cronjob via `envFrom: secretRef` derived from
 * `secret_manager.targetSecretName`.
 *
 * This test parses the values YAML and asserts that the ai-portal-explorer entry
 * exists with: the portal-explorer aux image (built from ops/Dockerfile.portal-explorer),
 * concurrencyPolicy Forbid, a bounded activeDeadlineSeconds, a schedule, and that the
 * portal-env secret is wired in as the envFrom secret for the cronjobs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
// js-yaml is available in node_modules (transitive dep) and used to parse the values.
import yaml from "js-yaml";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HELM_DIR = resolve(__dirname, "../../../.helm");

const CHART_KEY = "generic-chart";
const JOB_NAME = "ai-portal-explorer";

function loadValues(file: string): any {
  const raw = readFileSync(resolve(HELM_DIR, file), "utf8");
  return yaml.load(raw) as any;
}

function findJob(values: any, name: string): any {
  const jobs = values?.[CHART_KEY]?.cronjobs?.jobs;
  assert.ok(Array.isArray(jobs), `${CHART_KEY}.cronjobs.jobs must be an array`);
  return jobs.find((j: any) => j?.name === name);
}

test("base values declare the ai-portal-explorer cronjob with the required fields", () => {
  const values = loadValues("values.yaml");
  const job = findJob(values, JOB_NAME);

  assert.ok(job, `cronjob '${JOB_NAME}' must exist in ${CHART_KEY}.cronjobs.jobs`);

  // Image: the portal-explorer aux image (ops/Dockerfile.portal-explorer).
  assert.equal(typeof job.image, "string", "image must be a string");
  assert.match(
    job.image,
    /portal-explorer/,
    "image must reference the portal-explorer aux image",
  );

  // concurrencyPolicy: Forbid — never overlap a previous still-running crawl.
  assert.equal(
    job.concurrencyPolicy,
    "Forbid",
    "concurrencyPolicy must be Forbid",
  );

  // activeDeadlineSeconds: present, a positive integer, and bounded (<= 24h).
  assert.equal(
    typeof job.activeDeadlineSeconds,
    "number",
    "activeDeadlineSeconds must be a number",
  );
  assert.ok(
    Number.isInteger(job.activeDeadlineSeconds),
    "activeDeadlineSeconds must be an integer",
  );
  assert.ok(
    job.activeDeadlineSeconds > 0 && job.activeDeadlineSeconds <= 86400,
    "activeDeadlineSeconds must be bounded (0 < x <= 86400)",
  );

  // schedule: a non-empty cron expression.
  assert.equal(typeof job.schedule, "string", "schedule must be a string");
  assert.match(
    job.schedule,
    /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s*$/,
    "schedule must be a 5-field cron expression",
  );

  // restartPolicy: Never (batch one-shot, matches the other aux-image jobs).
  assert.equal(job.restartPolicy, "Never", "restartPolicy must be Never");

  // command: MUST NOT be overridden. The job relies on the image CMD
  // (`npx tsx ops/portal-explorer/run.ts`, ops/Dockerfile.portal-explorer) as the
  // single source of truth for the entrypoint (task 19.1 reconciliation). A
  // `command:` override (e.g. the old `["node","/app/run.js"]`) would point at a
  // path that does not exist in the image.
  assert.equal(
    job.command,
    undefined,
    "command must NOT be overridden — the job uses the image CMD (npx tsx ops/portal-explorer/run.ts)",
  );
});

test("the portal-env ESO secret is the envFrom secret wired into every cronjob", () => {
  const values = loadValues("values.yaml");
  // The chart renders `envFrom: - secretRef: name: <secret_manager.targetSecretName>`
  // for every cronjob, so the ai-portal-explorer job inherits portal-env (NEXTAUTH_SECRET,
  // INTERNAL_API_SECRET, DATABASE_URL, ...).
  const sm = values?.[CHART_KEY]?.secret_manager;
  assert.ok(sm, "secret_manager must be defined");
  assert.equal(sm.enabled, true, "secret_manager must be enabled");
  assert.equal(
    sm.targetSecretName,
    "portal-env",
    "the cronjob envFrom secret must be portal-env",
  );
});

test("cronjobs (incl. ai-portal-explorer) are enabled in prod and disabled by default", () => {
  const base = loadValues("values.yaml");
  const prod = loadValues("values-prod.yaml");

  // Shared base keeps cronjobs disabled; prod overlay turns them on.
  assert.equal(
    base?.[CHART_KEY]?.cronjobs?.enabled,
    false,
    "base values must keep cronjobs disabled by default",
  );
  assert.equal(
    prod?.[CHART_KEY]?.cronjobs?.enabled,
    true,
    "prod overlay must enable cronjobs",
  );
});
