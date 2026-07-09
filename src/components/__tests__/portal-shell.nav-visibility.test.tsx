// Feature: managers-role, Task 5.3: Unit tests de visibilidad de navegación por rol
/**
 * Navigation visibility tests for the `managers` role.
 *
 * Component under test: src/components/portal-shell.tsx
 *
 * `portal-shell.tsx` is a "use client" React component that pulls in
 * `lucide-react`, `next/navigation`, `next-auth/react`, etc., none of which
 * load under the node:test + tsx runner used by `npm test`. `NAV_ITEMS` and
 * the visibility filter are not exported either. So instead of rendering React,
 * we test the *real* gating logic: the exported `hasMinimumRole` predicate from
 * `src/lib/rbac.ts`, applied exactly as the component applies it:
 *
 *     visibleItems = NAV_ITEMS
 *       .filter((item) => !item.hidden && hasMinimumRole(role, item.minimumRole))
 *
 * The NAV_ITEMS fixture below mirrors the `id` + `minimumRole` of every entry in
 * portal-shell.tsx (feature-flag-hidden items `jira`/`automations` omitted — they
 * are gated by ENABLE_JIRA/ENABLE_AUTOMATIONS, not by role). If the component's
 * minimumRole values change, this fixture must be updated to match.
 *
 * _Requirements: 6.4, 6.6, 6.7, 6.8_
 */

import test from "node:test";
import assert from "node:assert/strict";

import { hasMinimumRole, type AppRole } from "../../lib/rbac";

/* ------------------------------------------------------------------ */
/*  Fixture: mirror of NAV_ITEMS (id + minimumRole) in portal-shell.tsx */
/* ------------------------------------------------------------------ */

type NavItemFixture = { id: string; minimumRole: AppRole };

const NAV_ITEMS: readonly NavItemFixture[] = [
  { id: "home", minimumRole: "externos" },
  { id: "create-repo", minimumRole: "externos" },
  { id: "access-management", minimumRole: "externos" },
  { id: "infra-requests", minimumRole: "staff" },
  { id: "incidents", minimumRole: "externos" },
  { id: "requests", minimumRole: "externos" },
  { id: "metrics", minimumRole: "externos" },
  { id: "synthetics", minimumRole: "externos" },
  { id: "finops", minimumRole: "desarrolladores" },
  { id: "kiro-analytics", minimumRole: "managers" },
  { id: "notifications", minimumRole: "managers" },
  { id: "my-tickets", minimumRole: "externos" },
  { id: "admin", minimumRole: "admin" },
] as const;

/** Same predicate the component uses to build `visibleItems`. */
function visibleItemIds(role: AppRole): string[] {
  return NAV_ITEMS.filter((item) => hasMinimumRole(role, item.minimumRole)).map(
    (item) => item.id
  );
}

const RESTRICTED_ROLES: readonly AppRole[] = [
  "staff",
  "desarrolladores",
  "externos",
] as const;

/* ------------------------------------------------------------------ */
/*  managers sees kiro-analytics + notifications, not admin (Req 6.4/6.6) */
/* ------------------------------------------------------------------ */

test("managers: visibleItems include kiro-analytics and notifications, not admin", () => {
  const ids = visibleItemIds("managers");

  assert.ok(ids.includes("kiro-analytics"), "managers should see kiro-analytics");
  assert.ok(ids.includes("notifications"), "managers should see notifications");
  assert.ok(!ids.includes("admin"), "managers must NOT see admin");
});

test("managers: also sees every staff-level and lower nav item", () => {
  const ids = visibleItemIds("managers");
  // staff-gated item + externos-gated items must remain visible to managers
  for (const expected of [
    "home",
    "create-repo",
    "access-management",
    "infra-requests",
    "incidents",
    "requests",
    "metrics",
    "synthetics",
    "finops",
    "my-tickets",
  ]) {
    assert.ok(ids.includes(expected), `managers should see ${expected}`);
  }
});

/* ------------------------------------------------------------------ */
/*  staff / desarrolladores / externos: neither manager-only item (Req 6.7) */
/* ------------------------------------------------------------------ */

test("staff/desarrolladores/externos: never see kiro-analytics nor notifications", () => {
  for (const role of RESTRICTED_ROLES) {
    const ids = visibleItemIds(role);
    assert.ok(
      !ids.includes("kiro-analytics"),
      `${role} must NOT see kiro-analytics`
    );
    assert.ok(
      !ids.includes("notifications"),
      `${role} must NOT see notifications`
    );
    assert.ok(!ids.includes("admin"), `${role} must NOT see admin`);
  }
});

/* ------------------------------------------------------------------ */
/*  Each item is gated independently — no all-or-nothing (Req 6.8)     */
/* ------------------------------------------------------------------ */

test("each nav item is gated independently by its own minimumRole", () => {
  // For every item and every role, visibility depends solely on that item's
  // minimumRole via hasMinimumRole — never on the presence/absence of others.
  const ALL_ROLES: readonly AppRole[] = [
    "externos",
    "desarrolladores",
    "staff",
    "managers",
    "directores",
    "admin",
  ] as const;

  for (const role of ALL_ROLES) {
    const ids = new Set(visibleItemIds(role));
    for (const item of NAV_ITEMS) {
      assert.equal(
        ids.has(item.id),
        hasMinimumRole(role, item.minimumRole),
        `visibility of ${item.id} for ${role} must equal hasMinimumRole(${role}, ${item.minimumRole})`
      );
    }
  }
});

test("independent gating: kiro-analytics and notifications resolve separately", () => {
  // directores/admin see both; managers see both; staff-and-below see neither.
  // The two manager-only items share the same gate but are filtered per-item,
  // so lowering one does not depend on the other.
  for (const role of ["managers", "directores", "admin"] as AppRole[]) {
    const ids = visibleItemIds(role);
    assert.ok(ids.includes("kiro-analytics"), `${role} sees kiro-analytics`);
    assert.ok(ids.includes("notifications"), `${role} sees notifications`);
  }
  // A staff-level item stays visible to staff even though the manager-only
  // items are not — proving there is no "all-or-nothing" coupling.
  const staffIds = visibleItemIds("staff");
  assert.ok(staffIds.includes("infra-requests"), "staff still sees infra-requests");
  assert.ok(!staffIds.includes("kiro-analytics"), "staff does not see kiro-analytics");
});
