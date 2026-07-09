# Implementation Plan: AI Infrastructure Assistant

## Overview

Three-day incremental implementation: Day 1 builds the backend AI layer (DB, agent, streaming API), Day 2 adds the Chat UI and approval integration, Day 3 wires in Jira/Teams notifications, extends the approver view, and validates end-to-end.

## Tasks

- [x] 1. Database migrations
  - [x] 1.1 Create `repo_catalog` table migration
    - Write `migrations/2026-XX-XX_repo_catalog.sql` with the `CREATE TABLE` DDL and seed `INSERT` for the 6 known teams (Digital, Helios, Retail, Commerce, Clusters, Tooling)
    - _Requirements: 6.1_

  - [x] 1.2 Extend `infra_requests` table migration
    - Write `migrations/2026-XX-XX_infra_requests_ai_columns.sql` adding `ai_conversation JSONB`, `terraform_preview JSONB`, `gitlab_mr_url TEXT`, `gitlab_branch TEXT`, `jira_key TEXT`, `executed_at TIMESTAMPTZ`
    - Add `'execute_failed'` to the `status` CHECK constraint
    - _Requirements: 7.2, 5.6_

- [x] 2. RepoCatalog class
  - [x] 2.1 Implement `src/lib/repo-catalog.ts`
    - Write `RepoCatalogEntry` interface and `RepoCatalog` class with `getAll()`, `getByTeam(team)`, `upsert(entry)`, and `deactivate(team)` methods backed by the `repo_catalog` table
    - Export singleton `repoCatalog`
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 2.2 Write property test for RepoCatalog upsert round-trip
    - **Property 10: RepoCatalog upsert round-trip**
    - **Validates: Requirements 6.4**

  - [ ]* 2.3 Write property test for RepoCatalog deactivation
    - **Property 11: RepoCatalog deactivation hides team from lookups**
    - **Validates: Requirements 6.5**

- [x] 3. GitLab client extensions
  - [x] 3.1 Add `listRepoTree`, `createBranch`, `createFile`, and `createMR` methods to `src/lib/gitlab.ts`
    - Implement `GitLabTreeItem` interface and the four new methods on the existing `GitLabClient` class
    - _Requirements: 5.1, 5.2, 5.3_

  - [ ]* 3.2 Write unit tests for GitLab client new methods
    - Mock `fetch`, assert correct URL construction and request bodies for each new method
    - _Requirements: 5.1, 5.2, 5.3_

- [x] 4. InfraAgent core
  - [x] 4.1 Implement `src/lib/infra-agent.ts` with tool-use loop
    - Write `AgentRunOptions`, `AgentRunResult`, `TerraformPreview`, and `ConversationMessage` interfaces
    - Implement `InfraAgent.run()` with the Bedrock `ConverseCommand` tool-use loop: call Bedrock → parse tool calls → execute read-only tools → feed `<tool_result>` XML-wrapped results back → repeat until final answer
    - Parse `<terraform_preview>` XML tag from the final assistant message to produce a structured `TerraformPreview`
    - Enforce 32k token budget via `inferenceConfig`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 8.1, 8.6, 8.7_

  - [x] 4.2 Implement `InfraAgent.runStream()` as an async generator
    - Yield `AgentStreamChunk` objects of type `token`, `tool_call`, `tool_result`, `preview`, and `done`
    - _Requirements: 1.3, 1.4, 1.5_

  - [ ]* 4.3 Write property test: agent tool calls are read-only
    - **Property 13: Agent is read-only during chat phase**
    - **Validates: Requirements 8.1**

  - [ ]* 4.4 Write property test: tool results are XML-wrapped
    - **Property 12: Agent tool results are XML-wrapped before Bedrock submission**
    - **Validates: Requirements 8.6**

  - [ ]* 4.5 Write property test: agent tool failures do not terminate conversation
    - **Property 5: Agent tool failures do not terminate the conversation**
    - **Validates: Requirements 2.6**

  - [ ]* 4.6 Write property test: generated Terraform contains multi-environment count pattern
    - **Property 3: Generated Terraform contains the multi-environment count pattern**
    - **Validates: Requirements 2.5**

  - [ ]* 4.7 Write property test: TerraformPreview always has all required fields
    - **Property 4: TerraformPreview always has all required fields populated**
    - **Validates: Requirements 2.4, 3.2**

- [x] 5. Chat API endpoint (SSE streaming)
  - [x] 5.1 Create `src/app/api/infra-assistant/chat/route.ts`
    - Validate request body (non-empty `message`, `team`); return 400 for empty/whitespace message
    - Look up team via `repoCatalog.getByTeam(team)`; return error message if team not registered
    - Instantiate `InfraAgent`, call `runStream()`, and pipe chunks as SSE events (`token`, `tool_call`, `tool_result`, `preview`, `done`)
    - Protect with `requireUserAuth`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.6, 6.7, 8.8_

  - [ ]* 5.2 Write property test: Chat API streams valid SSE for non-empty messages
    - **Property 1: Chat API always streams a valid SSE response for non-empty messages**
    - **Validates: Requirements 1.1, 1.3, 1.5**

  - [ ]* 5.3 Write property test: Agent reads repo before generating Terraform
    - **Property 2: Agent reads repo before generating Terraform**
    - **Validates: Requirements 2.1, 2.2**

- [x] 6. Checkpoint — backend AI layer complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Chat UI component
  - [x] 7.1 Create `src/components/infra-assistant/chat-panel.tsx`
    - Implement split-pane layout: left chat messages + input, right Terraform diff preview
    - Render message types: `user` (right-aligned), `assistant` (markdown), `tool_call` (collapsible "🔍 Reading repo..." indicator), `preview` (triggers right pane)
    - Connect to `POST /api/infra-assistant/chat` via `EventSource` / `fetch` SSE reader; append tokens and update preview state on each event
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 7.2 Create `src/components/infra-assistant/terraform-preview.tsx`
    - Render HCL content with syntax highlighting (use `react-syntax-highlighter` or existing code block pattern)
    - Display file path badge, resource type + name, target environment chips, estimated cost when available
    - Expose `onApprove` (triggers submit) and `onEdit` (sends follow-up message to chat) callbacks
    - _Requirements: 3.1, 3.2, 3.3_

  - [x] 7.3 Create `src/app/infra-assistant/page.tsx` (or update existing `src/app/ai/chat/page.tsx`)
    - Wire `ChatPanel` with team selection and approver selection dropdowns
    - Handle `onPreviewReady` and `onSubmitReady` callbacks
    - _Requirements: 3.4_

- [x] 8. Submit API endpoint
  - [x] 8.1 Create `src/app/api/infra-assistant/submit/route.ts`
    - Validate body: `conversationId`, `conversation`, `terraformPreview`, `team`, `approver`
    - INSERT into `infra_requests` with `status = 'pending'`, `ai_conversation`, `terraform_preview`
    - Call `createNotificationBatch` + `sendEmail` to notify the approver (reuse existing helpers)
    - Return `{ id, status: "pending" }`
    - _Requirements: 3.4, 3.5, 3.6_

  - [ ]* 8.2 Write property test: Submit persists conversation and preview with pending status
    - **Property 6: Submit persists conversation and preview with pending status**
    - **Validates: Requirements 3.5**

- [x] 9. Execute API endpoint
  - [x] 9.1 Create `src/app/api/infra-assistant/execute/[id]/route.ts`
    - Validate `x-internal-secret` header; return 401 if missing/invalid
    - Load `infra_requests` row; return 403 if `status != 'approved'`; return 200 immediately if `executed_at IS NOT NULL`
    - Execute steps in order: `createBranch` → `createFile` → `createMR` → `jiraCreateIssue` → Teams webhook POST → UPDATE row → `createNotification` to requestor
    - Wrap each step in try/catch per the error-handling table in the design (createBranch failure → `execute_failed`; Jira/Teams failures → log + continue)
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9, 5.10, 5.11, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 9.2 Write property test: Execute endpoint is idempotent
    - **Property 7: Execute endpoint is idempotent**
    - **Validates: Requirements 5.8**

  - [ ]* 9.3 Write property test: Execute endpoint enforces approved status
    - **Property 9: Execute endpoint enforces approved status**
    - **Validates: Requirements 8.2, 8.3**

  - [ ]* 9.4 Write property test: Execute endpoint stores all output artifacts
    - **Property 8: Execute endpoint stores all output artifacts**
    - **Validates: Requirements 5.6**

- [x] 10. Modify existing review endpoint to call Execute API
  - [x] 10.1 Update `src/app/api/infra-requests/[id]/review/route.ts`
    - Replace the n8n webhook call with an internal `fetch` to `/api/infra-assistant/execute/:id` including the `x-internal-secret` header when `action === "approve"`
    - _Requirements: 4.4_

- [x] 11. Checkpoint — UI and approval integration complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 12. Extend approver view
  - [x] 12.1 Update the infra-requests review page to show conversation and diff
    - Render the full `ai_conversation` array in chronological order (collapsible)
    - Render `terraform_preview` using `TerraformPreview` component in read-only mode (no action buttons)
    - _Requirements: 4.1, 4.2, 4.3_

- [x] 13. Jira integration in Execute endpoint
  - [x] 13.1 Add `jiraCreateIssue` function to `src/lib/jira.ts`
    - Implement the function with `projectKey`, `issueTypeId`, `summary`, `description`, `labels` parameters; return `{ key, id, url }`
    - _Requirements: 5.4_

  - [ ]* 13.2 Write unit tests for `jiraCreateIssue`
    - Mock fetch, assert correct Jira REST API call and response parsing
    - _Requirements: 5.4_

- [x] 14. Teams notification in Execute endpoint
  - [x] 14.1 Implement Teams adaptive card POST in `src/app/api/infra-assistant/execute/[id]/route.ts`
    - Build the adaptive card payload with MR URL, Jira key, team, and resource summary
    - POST to `TEAMS_WEBHOOK_URL` env var; log warning on failure without blocking
    - _Requirements: 5.5, 5.11_

- [x] 15. Status tracking UI updates
  - [x] 15.1 Update the developer-facing infra requests list to show new statuses
    - Display `gitlab_mr_url` as a clickable link when `status = 'executed'`
    - Display error indicator when `status = 'execute_failed'`
    - _Requirements: 7.1, 7.3, 7.4_

- [x] 16. Final checkpoint — end-to-end validation
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP
- Each task references specific requirements for traceability
- Property tests use fast-check and validate universal correctness properties from the design document
- The execute endpoint is internal-only; middleware should block browser access to `/api/infra-assistant/execute/*`
- The n8n flow (`docs/n8n/infra-request-flow.json`) can be deactivated once task 10 is deployed and verified
