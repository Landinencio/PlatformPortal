# Tasks

## 1. Database Migration & Schema Changes
- [x] 1.1 Create migration file `migrations/2026-05-04_infra_request_improvements.sql` adding `reminder_sent_at TIMESTAMPTZ` column and partial index for pending reminders
- [x] 1.2 Add "cancelled" to the STATUS_CONFIG map in `src/components/infra-requests/infra-requests-dashboard.tsx`
- [x] 1.3 Add i18n keys (`infra.status.cancelled`, `infra.requests.cancel`, `infra.requests.cancelConfirm`, `infra.requests.cancelSuccess`, `infra.requests.history`, `infra.success.*`) to all 4 locale files (`src/i18n/es.json`, `en.json`, `fr.json`, `pt.json`)

## 2. Enhanced Success Screen
- [x] 2.1 Create `src/components/infra-request-v2/success-timeline.tsx` component with horizontal timeline (Pendiente → Aprobación → Ejecución → MR Creado) and active stage highlighting
- [x] 2.2 Modify the success state in `src/components/infra-request-v2/infra-request-form-v2.tsx` to show request summary (resource type, name, team, approver, cost) and integrate the timeline component

## 3. Cancellation Feature
- [x] 3.1 Create API route `src/app/api/infra-requests/[id]/cancel/route.ts` with POST handler: auth check, ownership verification (403), status check (409), update to "cancelled", and approver notification
- [x] 3.2 Add Cancel button to `src/components/infra-requests/infra-requests-dashboard.tsx` for pending requests owned by current user, with confirmation dialog and API call
- [x] 3.3 Add "cancelled" filter option to the dashboard filter bar

## 4. 24-Hour Reminder
- [x] 4.1 Create API route `src/app/api/infra-requests/reminders/route.ts` with POST handler: internal auth, query stale pending requests (>24h, no reminder), send notifications, update `reminder_sent_at`
- [x] 4.2 Create K8s CronJob YAML `ops/k8s/infra-reminder-cronjob.yaml` with schedule `0 * * * *`, using curl to POST to the reminders endpoint with `x-internal-secret` header

## 5. Request History on Create Page
- [x] 5.1 Create `src/components/infra-request-v2/recent-requests.tsx` component displaying a compact list of requests with resource type icon, team, status badge, and relative time
- [x] 5.2 Modify `src/app/create-infra/page.tsx` to fetch the user's 5 most recent requests server-side and render the `RecentRequests` component below the form card (hidden if empty)

## 6. Terraform Validation
- [x] 6.1 Create `src/lib/terraform-validator.ts` with `validateHclSyntax(content: string): { valid: boolean; error?: string }` function performing regex-based HCL syntax checks (balanced braces, valid block structure, unclosed strings)
- [x] 6.2 Integrate validation into `src/app/api/infra-assistant/execute/[id]/route.ts` after loading content and before branch creation — on failure: set status to "execute_failed", notify requestor, return early

## 7. Idempotent Execution
- [x] 7.1 Modify `src/app/api/infra-assistant/execute/[id]/route.ts` to replace the `executed_at` check with a status-based guard: return 200 for "executed" and "execute_failed" statuses before any external operations

## 8. Property-Based Tests
- [ ] 8.1 Write property test for cancellation authorization guard (fast-check): generate random user/request combinations, verify correct HTTP responses based on ownership and status
- [ ] 8.2 Write property test for reminder targeting: generate random request sets with varying ages/statuses/reminder flags, verify the query logic returns exactly the correct subset
- [ ] 8.3 Write property test for Terraform validation gate: generate random valid/invalid HCL strings, verify the handler blocks or proceeds correctly
- [ ] 8.4 Write property test for idempotent execution: generate requests with terminal statuses, verify no side effects
- [ ] 8.5 Write property test for request history bounded and ordered: generate random request lists, verify output is ≤5 items sorted by created_at DESC
