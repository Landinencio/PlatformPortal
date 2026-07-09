/**
 * Unit tests for POST /api/access-management/request route.
 *
 * Tests the validation logic directly since the route depends on Next.js
 * internals (getServerSession, NextResponse). Uses node:test runner.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { validateAccessRequestPayload } from "../../src/lib/access-management/request-validation";

/* ------------------------------------------------------------------ */
/*  Valid payload helpers                                               */
/* ------------------------------------------------------------------ */

function validGrantPayload(overrides: Record<string, any> = {}) {
  return {
    platform: "aws",
    targetUserEmail: "user@iskaypet.com",
    requestType: "grant",
    groupId: "group-123",
    groupName: "AWS-Dev",
    approverEmail: "ariel.porporatto@iskaypet.com",
    ...overrides,
  };
}

function validRevokePayload(overrides: Record<string, any> = {}) {
  return {
    platform: "gitlab",
    targetUserEmail: "user@emefinpetcare.com",
    requestType: "revoke",
    approverEmail: "jaime.palomo@iskaypet.com",
    ...overrides,
  };
}

function validGitlabGrantPayload(overrides: Record<string, any> = {}) {
  return {
    platform: "gitlab",
    targetUserEmail: "dev@iskaypet.com",
    requestType: "grant",
    groupId: "42",
    groupName: "platform-team",
    role: "developer",
    approverEmail: "ariel.porporatto@iskaypet.com",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Valid payloads                                                      */
/* ------------------------------------------------------------------ */

test("accepts valid AWS grant payload", () => {
  const error = validateAccessRequestPayload(validGrantPayload());
  assert.equal(error, null);
});

test("accepts valid ArgoCD grant payload", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ platform: "argocd" }));
  assert.equal(error, null);
});

test("accepts valid SonarQube grant payload", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ platform: "sonarqube" }));
  assert.equal(error, null);
});

test("accepts valid GitLab grant payload with role", () => {
  const error = validateAccessRequestPayload(validGitlabGrantPayload());
  assert.equal(error, null);
});

test("accepts valid revoke payload (no groupId/groupName/role required)", () => {
  const error = validateAccessRequestPayload(validRevokePayload());
  assert.equal(error, null);
});

test("accepts all valid GitLab roles", () => {
  for (const role of ["guest", "reporter", "developer", "maintainer"]) {
    const error = validateAccessRequestPayload(validGitlabGrantPayload({ role }));
    assert.equal(error, null, `role '${role}' should be valid`);
  }
});

/* ------------------------------------------------------------------ */
/*  Platform validation                                                */
/* ------------------------------------------------------------------ */

test("rejects missing platform", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ platform: undefined }));
  assert.ok(error);
  assert.ok(error.includes("platform"));
});

test("rejects invalid platform", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ platform: "azure" }));
  assert.ok(error);
  assert.ok(error.includes("platform"));
});

/* ------------------------------------------------------------------ */
/*  Target user email validation                                       */
/* ------------------------------------------------------------------ */

test("rejects missing targetUserEmail", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ targetUserEmail: undefined }));
  assert.ok(error);
  assert.ok(error.includes("targetUserEmail"));
});

test("rejects invalid targetUserEmail format", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ targetUserEmail: "not-an-email" }));
  assert.ok(error);
  assert.ok(error.includes("targetUserEmail"));
});

test("rejects empty targetUserEmail", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ targetUserEmail: "" }));
  assert.ok(error);
  assert.ok(error.includes("targetUserEmail"));
});

/* ------------------------------------------------------------------ */
/*  Request type validation                                            */
/* ------------------------------------------------------------------ */

test("rejects missing requestType", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ requestType: undefined }));
  assert.ok(error);
  assert.ok(error.includes("requestType"));
});

test("rejects invalid requestType", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ requestType: "update" }));
  assert.ok(error);
  assert.ok(error.includes("requestType"));
});

/* ------------------------------------------------------------------ */
/*  Grant-specific validation (groupId, groupName)                     */
/* ------------------------------------------------------------------ */

test("rejects grant without groupId", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ groupId: undefined }));
  assert.ok(error);
  assert.ok(error.includes("groupId"));
});

test("rejects grant without groupName", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ groupName: undefined }));
  assert.ok(error);
  assert.ok(error.includes("groupName"));
});

test("rejects grant with empty groupId", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ groupId: "" }));
  assert.ok(error);
  assert.ok(error.includes("groupId"));
});

test("rejects grant with empty groupName", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ groupName: "" }));
  assert.ok(error);
  assert.ok(error.includes("groupName"));
});

/* ------------------------------------------------------------------ */
/*  GitLab grant role validation                                       */
/* ------------------------------------------------------------------ */

test("rejects GitLab grant without role", () => {
  const error = validateAccessRequestPayload(validGitlabGrantPayload({ role: undefined }));
  assert.ok(error);
  assert.ok(error.includes("role"));
});

test("rejects GitLab grant with invalid role", () => {
  const error = validateAccessRequestPayload(validGitlabGrantPayload({ role: "admin" }));
  assert.ok(error);
  assert.ok(error.includes("role"));
});

test("does not require role for non-GitLab grant", () => {
  // AWS grant should not require role
  const error = validateAccessRequestPayload(validGrantPayload({ role: undefined }));
  assert.equal(error, null);
});

/* ------------------------------------------------------------------ */
/*  Approver email validation                                          */
/*  approverEmail is optional by design: managers execute directly     */
/*  without an approval step, so it is no longer validated.            */
/* ------------------------------------------------------------------ */

test("accepts payload without approverEmail (approval not required)", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ approverEmail: undefined }));
  assert.equal(error, null);
});

test("does not validate approverEmail format (field is optional)", () => {
  const error = validateAccessRequestPayload(validGrantPayload({ approverEmail: "not-email" }));
  assert.equal(error, null);
});

/* ------------------------------------------------------------------ */
/*  Edge cases                                                         */
/* ------------------------------------------------------------------ */

test("rejects null body", () => {
  const error = validateAccessRequestPayload(null);
  assert.ok(error);
});

test("rejects non-object body", () => {
  const error = validateAccessRequestPayload("string");
  assert.ok(error);
});

test("revoke does not require groupId, groupName, or role", () => {
  const payload = {
    platform: "aws",
    targetUserEmail: "user@iskaypet.com",
    requestType: "revoke",
    approverEmail: "ariel.porporatto@iskaypet.com",
  };
  const error = validateAccessRequestPayload(payload);
  assert.equal(error, null);
});
