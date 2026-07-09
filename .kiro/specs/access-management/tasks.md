# Tasks

## Task 1: Database Migration

- [x] 1.1 Create migration file `migrations/2026-05-XX_access_requests.sql` with the `access_requests` table schema (id, requestor_email, target_user_email, platform, request_type, group_id, group_name, role, approver_email, status, reviewer_email, reviewer_name, review_comment, reviewed_at, executed_at, jira_key, created_at, updated_at) and indexes
- [x] 1.2 Run migration against the database to verify it applies cleanly

## Task 2: Domain Normalizer Module

- [x] 2.1 Create `src/lib/access-management/domain-normalizer.ts` with `normalizeEmail`, `emailsMatch`, and `getAlternateDomainEmail` functions
- [x] 2.2 Write property-based tests for domain normalizer (Property 3: idempotence/consistency, Property 4: alternate domain generation) in `tests/access-management/domain-normalizer.property.test.ts`

## Task 3: Microsoft Graph API Client

- [x] 3.1 Create `src/lib/graph-client.ts` with OAuth2 client credentials token acquisition (POST to token endpoint with AZURE_AD_TENANT_ID, AZURE_AD_CLIENT_ID, AZURE_AD_CLIENT_SECRET), in-memory token caching with 5-minute pre-expiry refresh
- [x] 3.2 Implement `listGroupsByPrefix(prefix: string)` method using `GET /v1.0/groups?$filter=startsWith(displayName,'{prefix}')&$select=id,displayName,description&$top=999`
- [x] 3.3 Implement `findUserByEmail(email: string)` method using `GET /v1.0/users/{email}` with domain fallback retry via `getAlternateDomainEmail`
- [x] 3.4 Implement `addUserToGroup(groupId: string, userId: string)` method using `POST /v1.0/groups/{groupId}/members/$ref` with idempotent handling (treat "already exists" as success)
- [x] 3.5 Write unit tests for Graph client (mocked HTTP) covering token acquisition, user lookup with fallback, and error handling

## Task 4: Security Filter Module

- [x] 4.1 Create `src/lib/access-management/security-filter.ts` with `filterGroups(groups, platform)` and `isGroupSafe(displayName)` functions implementing platform prefix filtering and admin/owner exclusion
- [x] 4.2 Write property-based tests for security filter (Property 1: prefix filter, Property 2: admin/owner exclusion) in `tests/access-management/security-filter.property.test.ts`

## Task 5: GitLab Client Extensions

- [x] 5.1 Add `listGroups()` method to `GitLabClient` in `src/lib/gitlab.ts` — `GET /groups` with pagination, returning `{ id, name, full_path }`
- [x] 5.2 Add `addGroupMember(groupId: number, email: string, accessLevel: number)` method — `POST /groups/{id}/members` with `{ email, access_level }`
- [x] 5.3 Add `findUserByEmail(email: string)` method — `GET /users?search={email}` returning first match
- [x] 5.4 Add `blockUser(userId: number)` / `deleteUser(userId: number)` methods for license revocation (admin API)

## Task 6: Groups API Route

- [x] 6.1 Create `src/app/api/access-management/groups/route.ts` with GET handler: authenticate user, read `platform` query param, fetch groups from Graph API or GitLab, apply security filter, return filtered list
- [x] 6.2 Write unit test verifying the route returns 401 for unauthenticated requests and correct filtered groups for each platform

## Task 7: Access Request Submission API Route

- [x] 7.1 Create `src/app/api/access-management/request/route.ts` with POST handler: authenticate user, validate payload (platform, targetUserEmail, requestType, groupId/groupName for grant, role for GitLab, approverEmail), insert into `access_requests` table with status "pending"
- [x] 7.2 After DB insert, send in-app notification to selected approver and always-notified list (using `getNotifyList` logic from `infra-approvers.ts`)
- [x] 7.3 Track submission as user activity event with action "access_request_submit"
- [x] 7.4 Write unit tests for request submission (validation, DB insert, notifications)

## Task 8: Review API Route

- [x] 8.1 Create `src/app/api/access-management/[id]/review/route.ts` with POST handler: authenticate user, verify `isApprover`, check self-approval prevention (using domain normalizer), verify request is "pending" (409 if not), update status to approved/rejected
- [x] 8.2 On approval, trigger execute endpoint via `fetch('http://localhost:3000/api/access-management/execute/${id}')` fire-and-forget with `x-internal-secret` header
- [x] 8.3 Send in-app notification to requestor with approval/rejection result
- [x] 8.4 Write property-based tests for review logic (Property 5: self-approval prevention, Property 6: non-pending rejection) in `tests/access-management/review.property.test.ts`

## Task 9: Execute API Route (Azure AD Platforms)

- [x] 9.1 Create `src/app/api/access-management/execute/[id]/route.ts` with POST handler: require internal auth, load access_request row, verify status is "approved" and not already executed
- [x] 9.2 For AWS/ArgoCD/SonarQube: resolve user via `graphClient.findUserByEmail`, add to group via `graphClient.addUserToGroup`, handle errors (mark execute_failed, notify requestor)
- [x] 9.3 On success: create Jira issue (SRE project, "AccessRequest" label, formatted summary/description), send Teams adaptive card, update DB status to "executed"
- [x] 9.4 Write property-based tests for Jira content (Property 8) and Teams card content (Property 9) in `tests/access-management/execute-content.property.test.ts`

## Task 10: Execute API Route (GitLab Platform)

- [x] 10.1 For GitLab grant: add member to group via `gitlabClient.addGroupMember`, send onboarding email via `sendEmail`, handle errors
- [x] 10.2 For GitLab revoke: find user by email, remove license/block user, handle errors
- [x] 10.3 Create Jira issue and Teams notification for GitLab operations (same pattern as Azure AD)
- [x] 10.4 Write property-based test for onboarding email content (Property 7) in `tests/access-management/onboarding-email.property.test.ts`

## Task 11: GitLab Onboarding Email Template

- [x] 11.1 Create `src/lib/access-management/gitlab-onboarding-email.ts` with `buildGitLabOnboardingEmail` function generating HTML email with: login instructions, 2FA setup guide, GitLab instance link, support contact
- [x] 11.2 Verify email is sent from `portal@tooling.dp.iskaypet.com` (uses existing `sendEmail` helper which already sets this)

## Task 12: Access Request Form Component

- [x] 12.1 Create `src/components/access-management/access-request-form.tsx` with platform selector (AWS, ArgoCD, SonarQube, GitLab), target user email input (pre-filled with session email), approver selector (SELECTABLE_APPROVERS)
- [x] 12.2 Implement dynamic group fetching: on platform change, call `GET /api/access-management/groups?platform={platform}` and populate group selector
- [x] 12.3 Implement GitLab-specific fields: request type selector (Add access / Remove license), role selector (Guest, Reporter, Developer, Maintainer), conditional visibility (hide group/role for revoke)
- [x] 12.4 Implement form validation: submit button enabled only when all required fields are filled (platform + email + group + approver for grant; platform + email + approver for revoke)
- [x] 12.5 Implement form submission: POST to `/api/access-management/request`, show success/error states

## Task 13: Access Management Page

- [x] 13.1 Create `src/app/access-management/page.tsx` page component that renders the access request form
- [x] 13.2 Add sidebar navigation entry in the "Self-service" section with label "Gestión de Accesos", path "/access-management", ShieldCheck icon, minimum role "editor", positioned after "User Onboarding"

## Task 14: Environment Variables Configuration

- [x] 14.1 Document required new environment variables: `AZURE_AD_GRAPH_CLIENT_ID`, `AZURE_AD_GRAPH_CLIENT_SECRET` (or reuse existing `AZURE_AD_CLIENT_ID` / `AZURE_AD_CLIENT_SECRET` if they have Graph API permissions)
- [x] 14.2 Verify `AZURE_AD_TENANT_ID`, `TEAMS_WEBHOOK_URL`, `GITLAB_TOKEN`, and `INTERNAL_API_SECRET` are already configured in deploy.yaml
