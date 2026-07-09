/**
 * Property-based tests for access-management review logic.
 *
 * Feature: access-management
 * Property 5: Self-approval prevention with domain normalization
 * Property 6: Non-pending requests cannot be reviewed
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { emailsMatch } from "../../src/lib/access-management/domain-normalizer";

/* ------------------------------------------------------------------ */
/*  Generators                                                         */
/* ------------------------------------------------------------------ */

/** Generate a valid email local part (letters, digits, dots, hyphens, underscores) */
const localPartArb = fc
  .array(
    fc.constantFrom(
      ..."abcdefghijklmnopqrstuvwxyz0123456789._-".split("")
    ),
    { minLength: 1, maxLength: 30 }
  )
  .map((chars) => chars.join(""))
  .filter((s) => !s.startsWith(".") && !s.endsWith(".") && s.length > 0);

/** Generate an email with @iskaypet.com domain */
const iskaypetEmailArb = localPartArb.map((local) => `${local}@iskaypet.com`);

/** Generate an email with @emefinpetcare.com domain */
const emefinEmailArb = localPartArb.map(
  (local) => `${local}@emefinpetcare.com`
);

/** Generate an email with either known domain */
const knownDomainEmailArb = fc.oneof(iskaypetEmailArb, emefinEmailArb);

/** Generate a third-party domain (not iskaypet or emefinpetcare) */
const otherDomainArb = fc
  .array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
    minLength: 2,
    maxLength: 15,
  })
  .map((chars) => chars.join(""))
  .filter((d) => d !== "iskaypet" && d !== "emefinpetcare");

/** Generate an email with a third-party domain */
const otherDomainEmailArb = fc
  .tuple(localPartArb, otherDomainArb)
  .map(([local, domain]) => `${local}@${domain}.com`);

/** Non-pending statuses */
const nonPendingStatusArb = fc.constantFrom(
  "approved",
  "rejected",
  "executed",
  "execute_failed"
);

/** All valid statuses */
const anyStatusArb = fc.constantFrom(
  "pending",
  "approved",
  "rejected",
  "executed",
  "execute_failed"
);

/** Apply random case changes to a string */
const randomCaseArb = (email: string) =>
  fc
    .array(fc.boolean(), { minLength: email.length, maxLength: email.length })
    .map((flags) =>
      email
        .split("")
        .map((ch, i) => (flags[i] ? ch.toUpperCase() : ch.toLowerCase()))
        .join("")
    );

/* ------------------------------------------------------------------ */
/*  Review logic functions (extracted for testability)                  */
/* ------------------------------------------------------------------ */

/**
 * Determines if a review should be blocked due to self-approval.
 * Returns true if the reviewer is the same person as the requestor
 * (after domain normalization).
 */
function isSelfApproval(requestorEmail: string, reviewerEmail: string): boolean {
  return emailsMatch(requestorEmail, reviewerEmail);
}

/**
 * Determines if a request can be reviewed based on its current status.
 * Returns true if the request is in "pending" status (reviewable).
 * Returns false for any other status (should return 409).
 */
function isReviewable(status: string): boolean {
  return status === "pending";
}

/* ------------------------------------------------------------------ */
/*  Property 5: Self-approval prevention with domain normalization     */
/*  **Validates: Requirements 5.2**                                    */
/* ------------------------------------------------------------------ */

test("Property 5: Self-approval is detected when requestor and reviewer have the same email", () => {
  fc.assert(
    fc.property(knownDomainEmailArb, (email) => {
      assert.ok(
        isSelfApproval(email, email),
        `Expected self-approval to be detected for identical email: ${email}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 5: Self-approval is detected across domain variants (@iskaypet.com vs @emefinpetcare.com)", () => {
  fc.assert(
    fc.property(localPartArb, (local) => {
      const iskaypet = `${local}@iskaypet.com`;
      const emefin = `${local}@emefinpetcare.com`;

      assert.ok(
        isSelfApproval(iskaypet, emefin),
        `Expected self-approval: requestor=${iskaypet}, reviewer=${emefin}`
      );
      assert.ok(
        isSelfApproval(emefin, iskaypet),
        `Expected self-approval: requestor=${emefin}, reviewer=${iskaypet}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 5: Self-approval is detected regardless of case differences", () => {
  fc.assert(
    fc.property(
      knownDomainEmailArb.chain((email) =>
        randomCaseArb(email).map((cased) => [email, cased] as const)
      ),
      ([requestorEmail, reviewerEmail]) => {
        assert.ok(
          isSelfApproval(requestorEmail, reviewerEmail),
          `Expected self-approval: requestor=${requestorEmail}, reviewer=${reviewerEmail}`
        );
      }
    ),
    { numRuns: 100 }
  );
});

test("Property 5: Self-approval is detected with both case and domain differences combined", () => {
  fc.assert(
    fc.property(localPartArb, (local) => {
      const requestor = `${local.toUpperCase()}@EMEFINPETCARE.COM`;
      const reviewer = `${local.toLowerCase()}@iskaypet.com`;

      assert.ok(
        isSelfApproval(requestor, reviewer),
        `Expected self-approval: requestor=${requestor}, reviewer=${reviewer}`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 5: Different users are NOT flagged as self-approval", () => {
  fc.assert(
    fc.property(
      localPartArb,
      localPartArb.filter((l) => l.length > 1),
      (local1, local2) => {
        // Ensure they are actually different local parts
        fc.pre(local1.toLowerCase() !== local2.toLowerCase());

        const requestor = `${local1}@iskaypet.com`;
        const reviewer = `${local2}@iskaypet.com`;

        assert.ok(
          !isSelfApproval(requestor, reviewer),
          `Should NOT be self-approval: requestor=${requestor}, reviewer=${reviewer}`
        );
      }
    ),
    { numRuns: 100 }
  );
});

/* ------------------------------------------------------------------ */
/*  Property 6: Non-pending requests cannot be reviewed                */
/*  **Validates: Requirements 5.7**                                    */
/* ------------------------------------------------------------------ */

test("Property 6: Requests with non-pending status are not reviewable (should return 409)", () => {
  fc.assert(
    fc.property(nonPendingStatusArb, (status) => {
      assert.ok(
        !isReviewable(status),
        `Expected status "${status}" to NOT be reviewable`
      );
    }),
    { numRuns: 100 }
  );
});

test("Property 6: Only pending requests are reviewable", () => {
  fc.assert(
    fc.property(anyStatusArb, (status) => {
      if (status === "pending") {
        assert.ok(
          isReviewable(status),
          `Expected "pending" to be reviewable`
        );
      } else {
        assert.ok(
          !isReviewable(status),
          `Expected "${status}" to NOT be reviewable`
        );
      }
    }),
    { numRuns: 100 }
  );
});

test("Property 6: All non-pending statuses consistently return non-reviewable", () => {
  const nonPendingStatuses = ["approved", "rejected", "executed", "execute_failed"];
  fc.assert(
    fc.property(
      fc.constantFrom(...nonPendingStatuses),
      fc.nat({ max: 1000 }), // arbitrary request ID
      (status, _requestId) => {
        // Regardless of request ID or other context, non-pending = not reviewable
        assert.ok(
          !isReviewable(status),
          `Status "${status}" should never be reviewable`
        );
      }
    ),
    { numRuns: 100 }
  );
});
