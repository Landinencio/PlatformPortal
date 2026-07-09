/**
 * Property-based tests for GitLab onboarding email content.
 *
 * Feature: access-management
 * Property 7: Onboarding email contains all required sections
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { buildGitLabOnboardingEmail } from "../../src/lib/access-management/gitlab-onboarding-email";

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

/** Generate a group name */
const groupNameArb = fc
  .array(
    fc.constantFrom(..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_ ".split("")),
    { minLength: 1, maxLength: 50 }
  )
  .map((chars) => chars.join(""));

/** Generate a role name */
const roleNameArb = fc.constantFrom("Guest", "Reporter", "Developer", "Maintainer");

/** Generate full params for the email builder */
const emailParamsArb = fc.record({
  targetEmail: emailArb,
  groupName: groupNameArb,
  roleName: roleNameArb,
});

/* ------------------------------------------------------------------ */
/*  Property 7: Onboarding email contains all required sections        */
/*  **Validates: Requirements 7.3**                                    */
/* ------------------------------------------------------------------ */

test("Property 7: Onboarding email body contains login instructions", () => {
  fc.assert(
    fc.property(emailParamsArb, (params) => {
      const result = buildGitLabOnboardingEmail(params);

      // Check HTML body contains access/login instructions
      assert.ok(
        result.bodyHtml.includes("Acceso a GitLab") || result.bodyHtml.includes("Accede a"),
        `HTML body should contain login instructions`
      );

      // Check text body contains access/login instructions
      assert.ok(
        result.bodyText.includes("Acceso a GitLab") || result.bodyText.includes("Accede a"),
        `Text body should contain login instructions`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 7: Onboarding email body contains MFA setup guide", () => {
  fc.assert(
    fc.property(emailParamsArb, (params) => {
      const result = buildGitLabOnboardingEmail(params);

      // Check HTML body contains MFA instructions
      assert.ok(
        result.bodyHtml.includes("MFA"),
        `HTML body should contain MFA setup guide`
      );
      assert.ok(
        result.bodyHtml.includes("multifactor") || result.bodyHtml.includes("MFA"),
        `HTML body should mention multi-factor authentication`
      );

      // Check text body contains MFA instructions
      assert.ok(
        result.bodyText.includes("MFA"),
        `Text body should contain MFA setup guide`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 7: Onboarding email body contains GitLab instance link", () => {
  fc.assert(
    fc.property(emailParamsArb, (params) => {
      const result = buildGitLabOnboardingEmail(params);
      const gitlabUrl = "https://gitlab.com";

      // Check HTML body contains GitLab link
      assert.ok(
        result.bodyHtml.includes(gitlabUrl),
        `HTML body should contain GitLab instance link: ${gitlabUrl}`
      );

      // Check text body contains GitLab link
      assert.ok(
        result.bodyText.includes(gitlabUrl),
        `Text body should contain GitLab instance link: ${gitlabUrl}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 7: Onboarding email body contains support contact", () => {
  fc.assert(
    fc.property(emailParamsArb, (params) => {
      const result = buildGitLabOnboardingEmail(params);
      const supportEmail = "portal@tooling.dp.iskaypet.com";

      // Check HTML body contains support contact
      assert.ok(
        result.bodyHtml.includes(supportEmail),
        `HTML body should contain support contact: ${supportEmail}`
      );

      // Check text body contains support contact
      assert.ok(
        result.bodyText.includes(supportEmail),
        `Text body should contain support contact: ${supportEmail}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 7: Onboarding email contains all four required sections together", () => {
  fc.assert(
    fc.property(emailParamsArb, (params) => {
      const result = buildGitLabOnboardingEmail(params);

      // All four sections must be present in both HTML and text bodies
      const htmlChecks = [
        result.bodyHtml.includes("Acceso a GitLab") || result.bodyHtml.includes("Accede a"),
        result.bodyHtml.includes("MFA"),
        result.bodyHtml.includes("https://gitlab.com"),
        result.bodyHtml.includes("portal@tooling.dp.iskaypet.com"),
      ];

      const textChecks = [
        result.bodyText.includes("Acceso a GitLab") || result.bodyText.includes("Accede a"),
        result.bodyText.includes("MFA"),
        result.bodyText.includes("https://gitlab.com"),
        result.bodyText.includes("portal@tooling.dp.iskaypet.com"),
      ];

      assert.ok(
        htmlChecks.every(Boolean),
        `HTML body must contain all 4 required sections (login, MFA, link, support)`
      );
      assert.ok(
        textChecks.every(Boolean),
        `Text body must contain all 4 required sections (login, MFA, link, support)`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 7: Onboarding email subject is non-empty and contains group name", () => {
  fc.assert(
    fc.property(emailParamsArb, (params) => {
      const result = buildGitLabOnboardingEmail(params);

      assert.ok(
        result.subject.length > 0,
        `Subject should be non-empty`
      );
      assert.ok(
        result.subject.includes(params.groupName),
        `Subject should contain group name "${params.groupName}": ${result.subject}`
      );
    }),
    { numRuns: 100 }
  );
});
