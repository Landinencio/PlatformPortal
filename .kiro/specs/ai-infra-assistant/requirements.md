# Requirements Document

## Introduction

The AI Infrastructure Assistant replaces the existing rigid form + n8n webhook pipeline with a conversational AI chat interface. Developers describe their infrastructure needs in natural language; the system reads the team's actual GitLab infra repo, generates contextually correct Terraform, presents a diff preview for review, and — after human approval — automatically creates a GitLab branch, commits the Terraform, opens a Merge Request, creates a Jira ticket, and notifies Teams. The n8n flow is retired entirely.

## Glossary

- **AI_Assistant**: The conversational AI system backed by Claude Sonnet via AWS Bedrock that generates Terraform code
- **InfraAgent**: The server-side orchestrator (`src/lib/infra-agent.ts`) that manages the Bedrock tool-use loop
- **Chat_API**: The `POST /api/infra-assistant/chat` endpoint that streams agent responses as SSE
- **Submit_API**: The `POST /api/infra-assistant/submit` endpoint that persists a request for approval
- **Execute_API**: The `POST /api/infra-assistant/execute/:id` internal endpoint that performs all write operations after approval
- **Review_API**: The existing `POST /api/infra-requests/:id/review` endpoint, modified to trigger the Execute_API on approval
- **RepoCatalog**: The `repo_catalog` database table and its accessor class that maps team names to GitLab project IDs
- **TerraformPreview**: The structured object containing the generated HCL content, file path, resource metadata, and target environments
- **Conversation**: The ordered list of `ConversationMessage` objects representing the full chat history between the developer and the AI_Assistant
- **Developer**: An authenticated portal user who initiates an infrastructure request
- **Approver**: A designated reviewer who approves or rejects infrastructure requests
- **Admin**: A portal administrator who manages the RepoCatalog
- **GitLab_Client**: The extended `GitLabClient` class with methods for reading repo trees, creating branches, committing files, and creating MRs
- **Jira_Client**: The extended Jira client with the `jiraCreateIssue` function
- **Teams_Webhook**: The Microsoft Teams incoming webhook endpoint for notifications
- **SSE**: Server-Sent Events — the streaming protocol used by the Chat_API

---

## Requirements

### Requirement 1: Conversational Infrastructure Request

**User Story:** As a developer, I want to describe my infrastructure needs in natural language chat, so that I can request infrastructure without filling out rigid forms or knowing Terraform syntax.

#### Acceptance Criteria

1. WHEN a Developer sends a non-empty message to the Chat_API, THE Chat_API SHALL return a response as an SSE stream
2. WHEN the Chat_API receives a message, THE InfraAgent SHALL begin processing using the team's registered GitLab project from the RepoCatalog
3. WHEN the InfraAgent is processing, THE Chat_API SHALL emit SSE events of type `token`, `tool_call`, `tool_result`, `preview`, and `done`
4. WHEN the InfraAgent produces a complete TerraformPreview, THE Chat_API SHALL emit a `preview` SSE event containing the full TerraformPreview object
5. WHEN the SSE stream ends, THE Chat_API SHALL emit a `done` event containing the `conversationId` and the final `reply` text
6. IF a Developer sends an empty or whitespace-only message, THEN THE Chat_API SHALL reject the request with a 400 status code

---

### Requirement 2: AI-Driven Terraform Generation from Repo Context

**User Story:** As a developer, I want the AI to read my team's actual infra repo and generate Terraform that matches our existing patterns, so that the generated code is immediately usable without manual adaptation.

#### Acceptance Criteria

1. WHEN the InfraAgent starts processing a request, THE InfraAgent SHALL call the `read_repo_tree` tool with the team's `infraRootPath` before generating any Terraform
2. WHEN the InfraAgent has the repo tree, THE InfraAgent SHALL call the `read_file` tool on at least one existing `.tf` file in the relevant directory to extract naming conventions and module versions
3. WHEN the resource type is known, THE InfraAgent SHALL call the `read_tf_module_readme` tool to retrieve required variables for the relevant Terraform module
4. WHEN the InfraAgent generates a TerraformPreview, THE TerraformPreview SHALL contain a non-empty `filePath`, `content`, `resourceType`, `resourceName`, and `targetEnvironments` array
5. WHEN the InfraAgent generates Terraform content, THE generated HCL SHALL include the `count = contains(var.target_environments, var.environment) ? 1 : 0` pattern for multi-environment support
6. IF the InfraAgent tool call returns an error, THEN THE InfraAgent SHALL include the error as the tool result and continue the conversation, asking the Developer to provide missing details manually

---

### Requirement 3: Terraform Diff Preview and Pre-Submission Review

**User Story:** As a developer, I want to review the generated Terraform diff before submitting for approval, so that I can verify correctness and request changes if needed.

#### Acceptance Criteria

1. WHEN a TerraformPreview is available, THE Chat_UI SHALL display the HCL content with syntax highlighting alongside the conversation
2. WHEN displaying a TerraformPreview, THE Chat_UI SHALL show the `filePath`, `resourceType`, `resourceName`, `targetEnvironments`, and `estimatedCostMonthly` (when available)
3. WHEN a Developer clicks "Ask to change...", THE Chat_UI SHALL send a follow-up message to the Chat_API with the change request, continuing the existing conversation
4. WHEN a Developer clicks "Submit for approval", THE Chat_UI SHALL call the Submit_API with the current `conversationId`, full `conversation` array, `terraformPreview`, `team`, and selected `approver`
5. WHEN the Submit_API receives a valid submission, THE Submit_API SHALL persist the request to `infra_requests` with `status = 'pending'`, `ai_conversation`, and `terraform_preview` populated
6. WHEN the Submit_API persists the request, THE Submit_API SHALL trigger the existing approval notification flow to notify the selected Approver via email and in-app notification

---

### Requirement 4: Approver Review with Full Context

**User Story:** As an approver, I want to review the full conversation history and Terraform diff before deciding, so that I understand exactly what will be committed and why.

#### Acceptance Criteria

1. WHEN an Approver opens the infra requests review page, THE Review_UI SHALL display all pending requests with their `status`, `team`, `requestorEmail`, and submission timestamp
2. WHEN an Approver opens a specific request, THE Review_UI SHALL render the full `ai_conversation` history in chronological order
3. WHEN an Approver opens a specific request, THE Review_UI SHALL display the `terraform_preview` content in read-only mode with syntax highlighting
4. WHEN an Approver submits an approval via the Review_API with `action: "approve"`, THE Review_API SHALL update the request `status` to `'approved'` and immediately invoke the Execute_API
5. WHEN an Approver submits a rejection via the Review_API with `action: "reject"`, THE Review_API SHALL update the request `status` to `'rejected'` and notify the Developer

---

### Requirement 5: Automated Post-Approval Execution

**User Story:** As a developer, I want the system to automatically create the branch, commit the Terraform, open an MR, create a Jira ticket, and notify Teams after approval, so that I don't have to perform these steps manually.

#### Acceptance Criteria

1. WHEN the Execute_API is invoked for an approved request, THE Execute_API SHALL create a GitLab branch named `feat/infra-{jiraKey}` in the team's registered project using `GitLab_Client.createBranch`
2. WHEN the branch is created, THE Execute_API SHALL commit the stored `terraform_preview.content` verbatim to `terraform_preview.filePath` on that branch using `GitLab_Client.createFile`
3. WHEN the file is committed, THE Execute_API SHALL create a GitLab Merge Request from the feature branch to the default branch using `GitLab_Client.createMR`
4. WHEN the MR is created, THE Execute_API SHALL create a Jira issue using `Jira_Client.jiraCreateIssue` and store the returned `jiraKey`
5. WHEN the Jira issue is created, THE Execute_API SHALL POST an adaptive card notification to the Teams_Webhook
6. WHEN all steps complete, THE Execute_API SHALL update the `infra_requests` row with `gitlab_mr_url`, `gitlab_branch`, `jira_key`, `executed_at`, and `status = 'executed'`
7. WHEN execution completes, THE Execute_API SHALL send an in-app notification to the Developer containing the GitLab MR URL
8. WHEN the Execute_API is called for a request where `executed_at IS NOT NULL`, THE Execute_API SHALL return HTTP 200 immediately without re-executing any steps
9. IF `GitLab_Client.createBranch` fails, THEN THE Execute_API SHALL set `status = 'execute_failed'` and notify the Developer of the failure
10. IF `Jira_Client.jiraCreateIssue` fails, THEN THE Execute_API SHALL log a warning and continue execution without blocking the remaining steps
11. IF the Teams_Webhook POST fails, THEN THE Execute_API SHALL log a warning and continue execution without blocking the remaining steps

---

### Requirement 6: Repo Catalog Management

**User Story:** As an admin, I want to manage the team → GitLab project mapping through the portal, so that new teams can be onboarded without code changes.

#### Acceptance Criteria

1. THE RepoCatalog SHALL store each entry with `team`, `gitlabProjectId`, `defaultBranch`, `infraRootPath`, `description`, and `active` fields
2. WHEN an Admin calls `RepoCatalog.getAll()`, THE RepoCatalog SHALL return all entries regardless of `active` status
3. WHEN an Admin calls `RepoCatalog.getByTeam(team)`, THE RepoCatalog SHALL return the matching active entry, or `null` if no active entry exists for that team
4. WHEN an Admin calls `RepoCatalog.upsert(entry)`, THE RepoCatalog SHALL persist the entry and return the saved record with `id`, `createdAt`, and `updatedAt` populated
5. WHEN an Admin calls `RepoCatalog.deactivate(team)`, THE RepoCatalog SHALL set `active = false` for that team's entry, and subsequent `getByTeam` calls for that team SHALL return `null`
6. WHEN the InfraAgent looks up a team, THE InfraAgent SHALL use `RepoCatalog.getByTeam` to resolve the `gitlabProjectId`, `defaultBranch`, and `infraRootPath`
7. IF the InfraAgent calls `RepoCatalog.getByTeam` for an unregistered team, THEN THE Chat_API SHALL return an error message instructing the Developer to contact an Admin

---

### Requirement 7: Infrastructure Request Status Tracking

**User Story:** As a developer, I want to track the status of my infrastructure requests, so that I know when my request has been approved, executed, or rejected.

#### Acceptance Criteria

1. WHEN a Developer views the infra requests list, THE Portal SHALL display all requests submitted by that Developer with their current `status`
2. THE infra_requests table SHALL enforce that `status` is one of: `'pending'`, `'approved'`, `'rejected'`, `'executed'`, `'execute_failed'`
3. WHEN a request has `status = 'executed'`, THE Portal SHALL display the `gitlab_mr_url` as a clickable link
4. WHEN a request has `status = 'execute_failed'`, THE Portal SHALL display an error indicator and the failure reason
5. WHEN a request transitions to any terminal status (`'rejected'`, `'executed'`, `'execute_failed'`), THE Portal SHALL send an in-app notification to the Developer

---

### Requirement 8: Security and Access Control

**User Story:** As a platform engineer, I want the AI assistant to be read-only during the chat phase and require human approval before any write operations, so that no infrastructure changes are made without explicit authorization.

#### Acceptance Criteria

1. WHILE the InfraAgent is in the chat phase, THE InfraAgent SHALL only invoke read-only tools (`read_repo_tree`, `read_file`, `list_existing_tf_resources`, `read_tf_module_readme`) and SHALL NOT call any GitLab write operations
2. WHEN the Execute_API receives a request, THE Execute_API SHALL verify that the corresponding `infra_requests` row has `status = 'approved'` before executing any write operations
3. IF the Execute_API receives a request for a row with `status != 'approved'`, THEN THE Execute_API SHALL return HTTP 403 without executing any steps
4. WHEN the Execute_API receives a request, THE Execute_API SHALL verify the `x-internal-secret` header matches the configured secret
5. IF the Execute_API receives a request without a valid `x-internal-secret` header, THEN THE Execute_API SHALL return HTTP 401
6. WHEN the InfraAgent feeds tool results back to Bedrock, THE InfraAgent SHALL wrap each tool result in a `<tool_result>` XML envelope to prevent prompt injection from repo file contents
7. WHEN the InfraAgent processes a conversation, THE InfraAgent SHALL enforce a maximum token budget of 32,000 tokens per conversation via `inferenceConfig`
8. WHEN the InfraAgent accesses GitLab, THE InfraAgent SHALL only access the `gitlabProjectId` registered for the Developer's team in the RepoCatalog
