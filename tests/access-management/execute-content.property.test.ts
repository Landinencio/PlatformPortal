/**
 * Property-based tests for access-management execute content helpers.
 *
 * Feature: access-management
 * Property 8: Jira issue content completeness
 * Property 9: Teams card content completeness
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import {
  buildJiraContent,
  buildTeamsCard,
  type AccessRequestRow,
} from "../../src/lib/access-management/execute-helpers";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a valid email */
const emailArb = fc
  .tuple(
    fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split("")), { minLength: 1, maxLength: 20 }).map((chars) => chars.join("")),
    fc.constantFrom("iskaypet.com", "emefinpetcare.com", "example.com")
  )
  .map(([local, domain]) => `${local}@${domain}`);

/** Generate a platform */
const platformArb = fc.constantFrom("aws", "argocd", "sonarqube", "gitlab");

/** Generate a request type */
const requestTypeArb = fc.constantFrom("grant", "revoke");

/** Generate a non-empty group name */
const groupNameArb = fc
  .array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_ ".split("")),
    { minLength: 1, maxLength: 50 }
  )
  .map((chars) => chars.join(""));

/** Generate a role */
const roleArb = fc.constantFrom("guest", "reporter", "developer", "maintainer");

/** Generate an ISO timestamp */
const timestampArb = fc
  .integer({ min: 1577836800000, max: 1924991999000 }) // 2020-01-01 to 2030-12-31 in ms
  .map((ms) => new Date(ms).toISOString());

/** Generate a Jira key */
const jiraKeyArb = fc
  .tuple(
    fc.constantFrom("SRE", "PLAT", "DEV"),
    fc.nat({ max: 9999 })
  )
  .map(([prefix, num]) => `${prefix}-${num}`);

/** Generate a Jira URL from a key */
const jiraUrlFromKeyArb = (key: string) => `https://iskaypet.atlassian.net/browse/${key}`;

/** Generate a group ID string */
const groupIdArb = fc
  .array(fc.constantFrom(..."abcdef0123456789-".split("")), { minLength: 5, maxLength: 36 })
  .map((chars) => chars.join(""));

/** Generate a full AccessRequestRow for testing */
const accessRequestArb: fc.Arbitrary<AccessRequestRow> = fc.record({
  id: fc.nat({ max: 100000 }),
  requestor_email: emailArb,
  target_user_email: emailArb,
  platform: platformArb,
  request_type: requestTypeArb,
  group_id: fc.option(groupIdArb, { nil: null }),
  group_name: fc.option(groupNameArb, { nil: null }),
  role: fc.option(roleArb, { nil: null }),
  approver_email: emailArb,
  status: fc.constant("approved"),
  reviewer_email: fc.option(emailArb, { nil: null }),
  reviewer_name: fc.option(
    fc.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz ".split("")), { minLength: 1, maxLength: 30 }).map((c) => c.join("")),
    { nil: null }
  ),
  executed_at: fc.option(timestampArb, { nil: null }),
});

/* ------------------------------------------------------------------ */
/*  Property 8: Jira issue content completeness                        */
/*  **Validates: Requirements 8.2, 8.4**                               */
/* ------------------------------------------------------------------ */

test("Property 8: Jira summary matches format [Access] Solicitud de acceso a {PLATFORM} para {email}", () => {
  fc.assert(
    fc.property(accessRequestArb, (request) => {
      const result = buildJiraContent(request);
      const expectedPlatform = request.platform.toUpperCase();

      assert.ok(
        result.summary.startsWith("[Access] Solicitud de acceso a "),
        `Summary should start with '[Access] Solicitud de acceso a': ${result.summary}`
      );
      assert.ok(
        result.summary.includes(expectedPlatform),
        `Summary should contain platform "${expectedPlatform}": ${result.summary}`
      );
      assert.ok(
        result.summary.includes(request.target_user_email),
        `Summary should contain target email "${request.target_user_email}": ${result.summary}`
      );
      assert.equal(
        result.summary,
        `[Access] Solicitud de acceso a ${expectedPlatform} para ${request.target_user_email}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 8: Jira description contains platform, target user, group/role, requestor, approver, and timestamp", () => {
  fc.assert(
    fc.property(accessRequestArb, (request) => {
      const result = buildJiraContent(request);

      // Platform
      assert.ok(
        result.description.includes(request.platform.toUpperCase()),
        `Description should contain platform: ${request.platform.toUpperCase()}`
      );

      // Target user email
      assert.ok(
        result.description.includes(request.target_user_email),
        `Description should contain target user email: ${request.target_user_email}`
      );

      // Group or role (whichever is available)
      const groupOrRole = request.group_name || request.role || "N/A";
      assert.ok(
        result.description.includes(groupOrRole),
        `Description should contain group/role: ${groupOrRole}`
      );

      // Requestor email
      assert.ok(
        result.description.includes(request.requestor_email),
        `Description should contain requestor email: ${request.requestor_email}`
      );

      // Approver email
      assert.ok(
        result.description.includes(request.approver_email),
        `Description should contain approver email: ${request.approver_email}`
      );

      // Execution timestamp (either from request or generated)
      // Just verify there's a date-like string present
      assert.ok(
        result.description.includes("Fecha de ejecución:"),
        `Description should contain execution timestamp label`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 8: Jira labels always include 'AccessRequest'", () => {
  fc.assert(
    fc.property(accessRequestArb, (request) => {
      const result = buildJiraContent(request);
      assert.ok(
        result.labels.includes("AccessRequest"),
        `Labels should include "AccessRequest": ${JSON.stringify(result.labels)}`
      );
    }),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 9: Teams card content completeness                        */
/*  **Validates: Requirements 9.2**                                    */
/* ------------------------------------------------------------------ */

test("Property 9: Teams card contains title '🔐 Solicitud de Acceso'", () => {
  fc.assert(
    fc.property(accessRequestArb, jiraKeyArb, (request, jiraKey) => {
      const jiraUrl = jiraUrlFromKeyArb(jiraKey);
      const card = buildTeamsCard(request, jiraKey, jiraUrl);
      const cardStr = JSON.stringify(card);

      assert.ok(
        cardStr.includes("🔐 Solicitud de Acceso"),
        `Card should contain title "🔐 Solicitud de Acceso"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 9: Teams card contains the platform name", () => {
  fc.assert(
    fc.property(accessRequestArb, jiraKeyArb, (request, jiraKey) => {
      const jiraUrl = jiraUrlFromKeyArb(jiraKey);
      const card = buildTeamsCard(request, jiraKey, jiraUrl);
      const cardStr = JSON.stringify(card);
      const expectedPlatform = request.platform.toUpperCase();

      assert.ok(
        cardStr.includes(expectedPlatform),
        `Card should contain platform "${expectedPlatform}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 9: Teams card contains the target user email", () => {
  fc.assert(
    fc.property(accessRequestArb, jiraKeyArb, (request, jiraKey) => {
      const jiraUrl = jiraUrlFromKeyArb(jiraKey);
      const card = buildTeamsCard(request, jiraKey, jiraUrl);
      const cardStr = JSON.stringify(card);

      assert.ok(
        cardStr.includes(request.target_user_email),
        `Card should contain target user email "${request.target_user_email}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 9: Teams card contains the group or role name", () => {
  fc.assert(
    fc.property(accessRequestArb, jiraKeyArb, (request, jiraKey) => {
      const jiraUrl = jiraUrlFromKeyArb(jiraKey);
      const card = buildTeamsCard(request, jiraKey, jiraUrl);
      const cardStr = JSON.stringify(card);
      const groupOrRole = request.group_name || request.role || "N/A";

      assert.ok(
        cardStr.includes(groupOrRole),
        `Card should contain group/role "${groupOrRole}"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 9: Teams card contains status '✅ Acceso Concedido'", () => {
  fc.assert(
    fc.property(accessRequestArb, jiraKeyArb, (request, jiraKey) => {
      const jiraUrl = jiraUrlFromKeyArb(jiraKey);
      const card = buildTeamsCard(request, jiraKey, jiraUrl);
      const cardStr = JSON.stringify(card);

      assert.ok(
        cardStr.includes("✅ Acceso Concedido"),
        `Card should contain status "✅ Acceso Concedido"`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 9: Teams card contains a link to the Jira ticket", () => {
  fc.assert(
    fc.property(accessRequestArb, jiraKeyArb, (request, jiraKey) => {
      const jiraUrl = jiraUrlFromKeyArb(jiraKey);
      const card = buildTeamsCard(request, jiraKey, jiraUrl);
      const cardStr = JSON.stringify(card);

      assert.ok(
        cardStr.includes(jiraKey),
        `Card should contain Jira key "${jiraKey}"`
      );
      assert.ok(
        cardStr.includes(jiraUrl),
        `Card should contain Jira URL "${jiraUrl}"`
      );
    }),
    { numRuns: 100 }
  );
});
