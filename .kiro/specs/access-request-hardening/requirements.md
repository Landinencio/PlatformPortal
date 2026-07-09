# Requirements Document

## Introduction

Hardening of the `/access-management` request flow following the incident of 2026-06 in
which a Requestor submitted 15 GitLab group requests in a row with a typo in the target
email — `raiff.hazanow@emefinispetcare.com` (extra `i` between "emefin" and "petcare").
The form accepted the value, the server-side `validateAccessRequestPayload` accepted the
value, and the database accepted the value. The Approver then approved 10 of the 15
requests. All 10 failed at execution time with `GitLab API error: user not found`. The
remaining 5 are still pending review with the same broken email. Because the
`access_requests` table has no column for the upstream error message, the only artefact
of these failures is in the pod logs, and the user-facing UI shows the generic message
"Contacta al equipo de plataforma".

This feature delivers four pieces (Option 2 — Complete, as approved):

1. **Identity Verification Service** — a transversal module that resolves any input
   email to a canonical Azure AD identity, retrying across the known domain variants
   (`@emefinpetcare.com`, `@iskaypet.com`, `@ext.emefinpetcare.com`) and caching results
   for short bursts of multi-group submits.
2. **Live form validation + verify-user endpoint** — debounced live lookup in the form
   that surfaces the resolved display name (or a "not in Azure AD" warning) before the
   Requestor can submit, plus a defensive server-side re-check that rejects requests
   whose target email cannot be resolved.
3. **Execution journal** — a new `access_request_events` table that records every state
   transition (`created`, `approved`, `rejected`, `execute_started`, `execute_success`,
   `execute_failed`, `invitation_sent`, `retried`, `cancelled`) with structured
   `details` (including the upstream HTTP status and body for failures), surfaced in
   the admin timeline at `/infra-requests/[id]`.
4. **Idempotent retry from the UI** — a `POST /api/access-management/[id]/retry`
   endpoint that re-runs the original execute function for a request stuck in
   `execute_failed`, safe to call because `GitLabClient.addGroupMember` already treats
   "already a member" as success.

The feature reuses the existing platform modules (`domain-normalizer`,
`GraphClient.findUserByEmail`, `GitLabClient.addGroupMember`, `requireUserAuth`, the
RBAC model defined in `portal-architecture` §17-18) and adds property-based tests in
the established `tests/access-management/*.property.test.ts` layout.

## Glossary

- **Portal**: The Platform Portal Next.js 14 application running in namespace `n8n` of
  the `dp-tooling` EKS cluster.
- **Requestor**: The authenticated portal user who submits an access request through
  `/access-management`.
- **Approver**: A user from `SELECTABLE_APPROVERS` who reviews and approves or rejects
  an access request.
- **Admin**: A user with the `admin` role per the RBAC model defined in
  `portal-architecture` §17-18 (directores and platform admins).
- **target_user_email**: The email address of the person who will receive the access
  grant, stored in column `access_requests.target_user_email`.
- **Canonical_Email**: The version of `target_user_email` that resolves to a real Azure
  AD identity, after applying domain normalization and, if necessary, domain variant
  fallback. This is the value persisted to the database from now on.
- **Alternates**: The set of domain variants the Identity_Verification_Service tries
  when the primary lookup misses: `@emefinpetcare.com`, `@iskaypet.com`,
  `@ext.emefinpetcare.com`.
- **Identity_Verification_Service**: The new module at
  `src/lib/access-management/identity-verification.ts` that exposes `verifyTargetUser`
  and the pure helpers that back it.
- **Verify_User_Endpoint**: `GET /api/access-management/verify-user?email={email}`, the
  HTTP wrapper around `verifyTargetUser`.
- **Access_Request_Form**: The React form component at
  `src/components/access-management/access-request-form.tsx`.
- **Server_Validator**: The existing `validateAccessRequestPayload` function, after
  this feature adds the defensive verify-user call.
- **Domain_Normalizer**: The existing module
  `src/lib/access-management/domain-normalizer.ts` (functions `normalizeEmail`,
  `getAlternateDomainEmail`) that maps legacy domains to canonical ones.
- **Graph_Client**: The existing `GraphClient` class at `src/lib/graph-client.ts`. This
  feature uses only its `findUserByEmail(email)` method.
- **GitLab_Client**: The existing `GitLabClient` class at `src/lib/gitlab.ts`. This
  feature relies on the existing idempotency of `addGroupMember`.
- **Journal**: The new `access_request_events` table together with the helpers that
  write to it. Every state transition of an access request produces one journal entry.
- **Journal_Event_Type**: One of `created`, `approved`, `rejected`, `execute_started`,
  `execute_success`, `execute_failed`, `invitation_sent`, `retried`, `cancelled`.
- **Execute_Module**: The set of functions invoked by
  `src/app/api/access-management/execute/[id]/route.ts` — `executeGitLabGrant`,
  `executeGitLabRevoke`, `executeAzureAD`, `executeGitLabOnboard`, `executeGitLabOffboard`,
  and the shared `markFailed` helper.
- **Retry_Endpoint**: The new `POST /api/access-management/[id]/retry` endpoint.
- **Retry_Idempotency**: The property that calling the Retry_Endpoint N times on a
  request whose underlying side effect already succeeded (e.g., the user is already a
  member of the target GitLab group) leaves the system in the same final state and
  succeeds.
- **Admin_UI**: The admin-facing view at `/infra-requests/[id]`.
- **Requester_UI**: The non-admin view at `/access-management` showing the Requestor's
  own history.
- **Backfill_Job**: The migration step that synthesizes journal entries from existing
  `access_requests` rows using `created_at`, `reviewed_at`, and `executed_at`.

## Requirements

### Requirement 1: Identity Verification Service

**User Story:** As a Requestor, I want the Portal to verify that the target email
exists in Azure AD before persisting and executing my request, so that a typo does not
produce ten silent execution failures days later.

#### Acceptance Criteria

1. WHEN `verifyTargetUser(email)` is invoked, THE Identity_Verification_Service SHALL
   normalize the input email using `Domain_Normalizer.normalizeEmail` before performing
   any lookup
2. WHEN the normalized email resolves via `Graph_Client.findUserByEmail` on the first
   attempt, THE Identity_Verification_Service SHALL return an object with fields
   `canonicalEmail`, `displayName`, `source` set to `"primary"`, and `alternatesTried`
   set to the empty list
3. IF the normalized email does not resolve on the first attempt, THEN THE
   Identity_Verification_Service SHALL try the Alternates `@emefinpetcare.com`,
   `@iskaypet.com`, `@ext.emefinpetcare.com` in that order and SHALL stop at the first
   successful resolution
4. WHEN an Alternate lookup succeeds, THE Identity_Verification_Service SHALL return an
   object with fields `canonicalEmail`, `displayName`, `source` set to `"alternate"`,
   and `alternatesTried` set to the ordered list of addresses attempted up to and
   including the successful one
5. IF no Alternate resolves to a real user, THEN THE Identity_Verification_Service
   SHALL return `null` and SHALL NOT throw an exception
6. WHILE a verification result for a given normalized input email is less than 600
   seconds old, THE Identity_Verification_Service SHALL return the cached value instead
   of invoking `Graph_Client.findUserByEmail`
7. WHEN 600 seconds have elapsed since a cached entry was stored, THE
   Identity_Verification_Service SHALL evict that entry on the next lookup
8. THE Identity_Verification_Service SHALL expose the normalization helper and the
   Alternates-expansion helper as pure functions so that property-based tests can
   verify them in isolation
9. FOR ALL emails `e`, applying `Domain_Normalizer.normalizeEmail` twice SHALL produce
   the same result as applying it once (idempotence property)
10. FOR ALL pairs of input emails that differ only by an Alternates mapping (for
    example `user@iskaypet.com` and `user@emefinpetcare.com`), THE
    Identity_Verification_Service SHALL produce the same `canonicalEmail` when both
    resolve (metamorphic property)

### Requirement 2: Live Form Validation and Verify-User Endpoint

**User Story:** As a Requestor, I want the form to confirm in real time that the target
user exists in Azure AD, so that I cannot submit fifteen requests with the same typo.

#### Acceptance Criteria

1. THE Portal SHALL expose `GET /api/access-management/verify-user?email={email}` as
   the Verify_User_Endpoint
2. WHEN the lookup succeeds, THE Verify_User_Endpoint SHALL return HTTP 200 with a JSON
   body containing `found: true`, `canonicalEmail`, and `displayName`
3. WHEN the lookup returns null, THE Verify_User_Endpoint SHALL return HTTP 200 with a
   JSON body containing `found: false` and `suggestion: null`
4. IF the caller is not authenticated, THEN THE Verify_User_Endpoint SHALL return HTTP
   401
5. IF the `email` query parameter is missing or syntactically invalid, THEN THE
   Verify_User_Endpoint SHALL return HTTP 400 with an error message identifying the
   invalid input
6. WHEN the Requestor pauses typing in the target email field for 400 milliseconds,
   THE Access_Request_Form SHALL invoke the Verify_User_Endpoint with the current value
7. WHEN the Verify_User_Endpoint response indicates `found: true`, THE
   Access_Request_Form SHALL display the resolved `displayName` in a green confirmation
   line below the email field
8. WHEN the Verify_User_Endpoint response indicates `found: false`, THE
   Access_Request_Form SHALL display an amber warning line below the email field with
   the message "no está en Azure AD" and a toggle labelled "invitar de todas formas"
9. IF the target email field contains a value that does not match the email format
   regex, THEN THE Access_Request_Form SHALL display a red error below the field and
   SHALL disable the submit button
10. WHEN the Server_Validator runs as part of `POST /api/access-management/request`,
    THE Server_Validator SHALL invoke `verifyTargetUser` on the supplied target email
11. IF `verifyTargetUser` returns null and the payload does not contain
    `allowInvite: true`, THEN THE Server_Validator SHALL reject the request with HTTP
    400 and an error message identifying the missing user
12. WHEN the Server_Validator persists a new access request, THE Server_Validator SHALL
    write the `Canonical_Email` returned by `verifyTargetUser` into
    `access_requests.target_user_email` and SHALL NOT write the raw user input

### Requirement 3: Execution Journal

**User Story:** As an SRE responding to an incident, I want every state transition of
an access request recorded with structured details, so that I can diagnose execution
failures without grepping pod logs.

#### Acceptance Criteria

1. THE Portal SHALL create a database table named `access_request_events` with the
   columns: `id` (primary key), `request_id` (foreign key to `access_requests.id`),
   `event_type`, `status_from`, `status_to`, `actor_email`, `actor_kind`, `message`,
   `details` (JSONB), and `occurred_at` (timestamp with timezone)
2. THE migration that creates `access_request_events` SHALL be idempotent
   (`CREATE TABLE IF NOT EXISTS`) and SHALL be placed at
   `migrations/YYYY-MM-DD_access_request_events.sql`
3. THE `event_type` column SHALL accept only the Journal_Event_Types listed in the
   Glossary
4. THE `actor_kind` column SHALL accept only the values `requester`, `approver`,
   `admin`, and `system`
5. WHEN `POST /api/access-management/request` persists a new access request, THE
   Portal SHALL emit a `created` event into the Journal with `status_from` null,
   `status_to` equal to `pending_review`, and `actor_kind` equal to `requester`
6. WHEN `POST /api/access-management/[id]/review` approves a request, THE Portal SHALL
   emit an `approved` event with `actor_kind` equal to `approver`
7. WHEN `POST /api/access-management/[id]/review` rejects a request, THE Portal SHALL
   emit a `rejected` event with `actor_kind` equal to `approver`
8. WHEN `POST /api/access-management/[id]/cancel` cancels a request, THE Portal SHALL
   emit a `cancelled` event with `actor_kind` equal to `requester`
9. WHEN any of the functions `executeGitLabGrant`, `executeGitLabRevoke`,
   `executeAzureAD`, `executeGitLabOnboard`, or `executeGitLabOffboard` completes
   successfully, THE Execute_Module SHALL emit an `execute_success` event with
   `actor_kind` equal to `system`
10. WHEN the `markFailed` helper is invoked, THE Execute_Module SHALL ALSO emit an
    `execute_failed` event whose `details` JSONB contains `http_status`, `body`, and
    `stack` taken from the upstream error
11. THE Execute_Module SHALL NOT write Azure AD tokens, GitLab tokens, `Authorization`
    headers, or session cookies into the `details` JSONB
12. WHEN the Admin_UI loads `/infra-requests/[id]`, THE Admin_UI SHALL render the
    Journal entries for that request as a chronological timeline showing event type,
    actor, timestamp, and message
13. THE Requester_UI SHALL continue to display only the user-friendly `message`
    column and SHALL NOT expose the `details` JSONB
14. WHEN the migration runs against a database with existing `access_requests` rows,
    THE Backfill_Job SHALL insert one `created` event per row using `created_at`, one
    `approved` event using `reviewed_at` for rows whose status is `approved`,
    `executed`, or `execute_failed`, one `rejected` event using `reviewed_at` for rows
    whose status is `rejected`, and one `execute_success` event using `executed_at`
    for rows whose status is `executed`
15. THE Backfill_Job SHALL NOT fabricate `execute_failed` events for historical
    failures because the original upstream error is unavailable
16. WHEN an `execute_failed` or `execute_success` event is written, THE Execute_Module
    SHALL also emit a single structured log line with key `access_request.event` and
    fields `request_id`, `event_type`, `status_to`, and `actor_email`

### Requirement 4: Idempotent Retry from the UI

**User Story:** As an Approver, I want to retry a failed access request from the UI
without resubmitting it, so that we can recover from transient GitLab failures without
producing duplicate requests.

#### Acceptance Criteria

1. THE Portal SHALL expose `POST /api/access-management/[id]/retry` as the
   Retry_Endpoint
2. IF the caller is not authenticated, THEN THE Retry_Endpoint SHALL return HTTP 401
3. IF the caller is neither the original Approver of the request nor an Admin, THEN
   THE Retry_Endpoint SHALL return HTTP 403
4. IF the request status is not `execute_failed`, THEN THE Retry_Endpoint SHALL return
   HTTP 409 with the message "solo se puede reintentar una request en estado
   execute_failed"
5. WHEN all preconditions hold, THE Retry_Endpoint SHALL re-invoke the same Execute
   function used in the original execution
6. WHEN the retry succeeds, THE Retry_Endpoint SHALL update the request status to
   `executed` and SHALL emit a `retried` event followed by an `execute_success` event
   into the Journal
7. WHEN the retry fails, THE Retry_Endpoint SHALL leave the request status as
   `execute_failed` and SHALL emit a `retried` event followed by an `execute_failed`
   event whose `details` JSONB contains the new upstream error
8. FOR ALL retries on a request whose target user is already a member of the target
   GitLab group, THE Retry_Endpoint SHALL succeed (Retry_Idempotency property,
   inherited from the existing idempotency of `GitLab_Client.addGroupMember`)
9. THE Admin_UI SHALL render a button labelled "Reintentar" next to every request
   whose status is `execute_failed` in the `/infra-requests` list
10. WHEN the Admin_UI Reintentar button is clicked, THE Admin_UI SHALL call the
    Retry_Endpoint and SHALL refresh the request row with the new status and the new
    Journal entries on completion

### Requirement 5: Testing, Observability and Privacy

**User Story:** As a maintainer, I want the new modules covered by property-based
tests and the existing tests untouched, so that we keep the project's testing standard
and avoid regression.

#### Acceptance Criteria

1. THE Identity_Verification_Service SHALL be covered by a property-based test file at
   `tests/access-management/identity-verification.property.test.ts` containing at
   least: a normalization idempotence property, an Alternates-equivalence metamorphic
   property, and a cache hit-then-miss property
2. THE Retry_Endpoint SHALL be covered by a property-based test file at
   `tests/access-management/retry.property.test.ts` containing at least a
   Retry_Idempotency property over arbitrary sequences of retries on a request whose
   underlying side effect already succeeded
3. THE Journal SHALL be covered by a property-based test file at
   `tests/access-management/journal.property.test.ts` containing at least: an event
   ordering property (`occurred_at` monotonic per `request_id`) and a redaction
   property (no token-like or cookie-like strings appear in `details`)
4. THE seven existing access-management test files
   (`security-filter.property.test.ts`, `domain-normalizer.property.test.ts`,
   `graph-client.test.ts`, `review.property.test.ts`, `request-route.test.ts`,
   `execute-content.property.test.ts`, `onboarding-email.property.test.ts`) SHALL
   continue to pass without modification to their source
5. WHEN the test suite is executed via the project's standard command, THE new
   property-based tests SHALL complete in under 30 seconds in aggregate
6. THE Verify_User_Endpoint SHALL emit one structured log line per invocation with
   key `access_request.verify_user` and fields `request_id` (when available),
   `email_input_normalized`, `found`, `source`, `alternates_tried_count`, and SHALL
   NOT log the raw input email
7. THE Journal `details` JSONB SHALL NOT contain Azure AD access tokens, GitLab
   personal access tokens, `Authorization` header values, NextAuth session cookies,
   or any other secret-shaped string

## Out of Scope

The following items are intentionally not addressed by this feature and remain as
candidates for future specs:

- Refactoring the internals of `executeGitLabGrant`, `executeGitLabRevoke`,
  `executeAzureAD`, `executeGitLabOnboard`, or `executeGitLabOffboard` beyond the
  addition of Journal emission at success and failure points
- Any change to the RBAC model defined in `portal-architecture` §17-18 (admins,
  directores, team approvers, requesters keep their current capabilities)
- Any change to the `access_requests` table schema beyond storing the Canonical_Email
  in `target_user_email` (no new columns on `access_requests`; all new structured
  state lives in `access_request_events`)
- UI redesign of the `/access-management` page beyond adding the live verify-user
  check on the target email field
- Applying the Journal and Retry patterns to `/infra-requests` (the non-access-
  management infrastructure request flow) or to `/squad-infra`
- Replacing or extending `src/lib/access-management/domain-normalizer.ts` or
  `GraphClient.findUserByEmail` (these modules are reused as-is)
- Modifying `GitLabClient.addGroupMember` (already idempotent, kept as-is)
- Implementing an Azure AD invitation flow for the `allowInvite: true` payload flag
  (the Server_Validator only needs to recognise the flag as a bypass of the
  not-found rejection; the actual invitation issuance is out of scope)
- Adding an `error_message` column to `access_requests` (the failure detail lives
  in `access_request_events.details` going forward)
