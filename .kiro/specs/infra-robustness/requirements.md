# Requirements Document

## Introduction

This document specifies hardening improvements to the existing infrastructure request system (infra-request-v2). The system allows teams to generate, preview, approve, and execute Terraform infrastructure changes via an AI assistant. These requirements address reliability issues (race conditions, partial failures, validation gaps), security concerns (rate limiting, secret detection, input validation), and UX improvements (cost estimation accuracy, expanded modification options, structured logging).

## Glossary

- **Execute_Handler**: The API route at `src/app/api/infra-assistant/execute/[id]/route.ts` that performs write operations (branch creation, file commit, MR creation) after an infra request is approved.
- **Generate_Route**: The API route at `src/app/api/infra-request-v2/generate/route.ts` that accepts structured form data and produces a Terraform preview via the InfraAgent.
- **Modify_Route**: The API route at `src/app/api/infra-request-v2/modify/route.ts` that reads an existing resource file and applies AI-generated modifications.
- **Terraform_Validator**: The module at `src/lib/terraform-validator.ts` that performs lightweight HCL syntax validation without requiring the terraform binary.
- **Cost_Estimator**: The module at `src/lib/infra-cost-estimator.ts` that calculates estimated monthly costs for infrastructure resources.
- **GitLab_Client**: The module at `src/lib/gitlab.ts` that wraps GitLab API calls for branch, file, and MR operations.
- **InfraAgent**: The AI agent at `src/lib/infra-agent.ts` that uses Bedrock ConverseCommand with tool-use to generate Terraform code.
- **Shared_File**: A Terraform file that contains multiple resource blocks (e.g., `s3.tf`, `roles.tf`, `policies.tf`) where new resources are appended rather than creating a new file.
- **Optimistic_Locking**: A concurrency control strategy where the file's last commit SHA is read before modification and passed to the update API to detect concurrent changes.
- **Rate_Limiter**: An in-memory mechanism that tracks request counts per user within a time window and rejects requests exceeding the threshold.
- **Structured_Logger**: A logging utility that outputs JSON-formatted log entries with consistent fields (requestId, userId, timestamp, action, duration).

## Requirements

### Requirement 1: Optimistic Locking for Shared File Updates

**User Story:** As a platform engineer, I want shared file updates to detect concurrent modifications, so that simultaneous approvals do not overwrite each other's changes.

#### Acceptance Criteria

1. WHEN the Execute_Handler appends to a Shared_File, THE GitLab_Client SHALL read the file content together with the last commit SHA for that file.
2. WHEN the Execute_Handler updates a Shared_File, THE GitLab_Client SHALL pass the `last_commit_id` parameter to the GitLab update file API.
3. IF the GitLab API returns a conflict error (HTTP 409 or message indicating the file was modified), THEN THE Execute_Handler SHALL retry the operation by re-reading the file with the new commit SHA and re-appending the content.
4. THE Execute_Handler SHALL retry a maximum of 3 times before marking the request as `execute_failed`.
5. WHEN a retry succeeds, THE Execute_Handler SHALL continue execution normally without user intervention.

### Requirement 2: Enhanced Terraform Validation

**User Story:** As a platform engineer, I want the Terraform validator to catch more common AI generation errors, so that invalid code is rejected before committing.

#### Acceptance Criteria

1. WHEN validating HCL content, THE Terraform_Validator SHALL verify that variable references match the pattern `var.<identifier>` where identifier contains only alphanumeric characters and underscores.
2. WHEN validating HCL content, THE Terraform_Validator SHALL verify that resource names contain only alphanumeric characters, underscores, and hyphens.
3. WHEN validating HCL content, THE Terraform_Validator SHALL verify that `count` expressions are syntactically valid (contain balanced parentheses and use recognized operators).
4. IF any validation check fails, THEN THE Terraform_Validator SHALL return a descriptive error message identifying the specific issue and line number.

### Requirement 3: Modify Flow Change Scope Verification

**User Story:** As a platform engineer, I want the modify flow to verify that only the target resource was changed, so that AI modifications do not accidentally alter unrelated resources.

#### Acceptance Criteria

1. WHEN the Modify_Route receives a modified file from the InfraAgent, THE Modify_Route SHALL diff the modified content against the original file content.
2. THE Modify_Route SHALL extract all resource and module block names from both the original and modified content.
3. IF any resource block other than the target resource and its related resources (subnet_group, security_group, policy_attachment with matching name prefix) was added, removed, or modified, THEN THE Modify_Route SHALL reject the result.
4. IF the modification is rejected, THEN THE Modify_Route SHALL retry the AI generation once with an explicit instruction to only modify the target resource.
5. IF the retry also produces out-of-scope changes, THEN THE Modify_Route SHALL return an error response with status 422 and a message describing which resources were unexpectedly changed.

### Requirement 4: Consistent Branch Rollback on Partial Failure

**User Story:** As a platform engineer, I want branches to be cleaned up on any failure after creation, so that abandoned branches do not accumulate in the repository.

#### Acceptance Criteria

1. WHEN the Execute_Handler creates a branch successfully, THE Execute_Handler SHALL ensure the branch is deleted if any subsequent operation (file create/update, MR creation, DB update) fails fatally.
2. THE Execute_Handler SHALL use a try/finally pattern that wraps all operations after branch creation.
3. IF branch deletion itself fails during rollback, THEN THE Execute_Handler SHALL log the failure but still mark the request as `execute_failed`.
4. THE Execute_Handler SHALL not attempt branch deletion for non-fatal failures (MR creation failure, Jira creation failure, Teams notification failure).

### Requirement 5: Improved Cost Estimation

**User Story:** As a developer requesting infrastructure, I want cost estimates to include commonly overlooked charges, so that I can make informed decisions about resource provisioning.

#### Acceptance Criteria

1. WHEN estimating RDS costs, THE Cost_Estimator SHALL include automated backup storage cost calculated as 30% of the instance monthly cost.
2. WHEN estimating S3 costs, THE Cost_Estimator SHALL display a realistic minimum monthly cost range of $1-5 for typical usage patterns.
3. WHEN estimating costs for any resource with data transfer potential, THE Cost_Estimator SHALL include a data transfer warning with the per-GB egress price ($0.09/GB).
4. THE Cost_Estimator SHALL display the backup storage cost as a separate line item in the breakdown string.

### Requirement 6: Stricter Field Validation

**User Story:** As a developer requesting infrastructure, I want field validation to catch naming errors early, so that I do not wait for AI generation only to have execution fail.

#### Acceptance Criteria

1. THE Generate_Route SHALL validate that RDS identifiers do not start or end with a hyphen and are at most 63 characters long.
2. THE Generate_Route SHALL validate that S3 bucket names do not contain the substrings "aws" or "amazon" (case-insensitive).
3. THE Generate_Route SHALL validate that S3 bucket names match the pattern: 3-63 characters, lowercase letters, numbers, hyphens, and periods only.
4. THE Generate_Route SHALL validate that IAM role namespace fields match the pattern of a valid Kubernetes namespace (lowercase alphanumeric and hyphens, max 63 characters, must start with a letter).
5. IF any field validation fails, THEN THE Generate_Route SHALL return HTTP 400 with a specific error message identifying the invalid field and the rule that was violated.

### Requirement 7: Configurable Bedrock Model

**User Story:** As a platform engineer, I want the InfraAgent model to be configurable via environment variable, so that I can switch models without code changes.

#### Acceptance Criteria

1. WHEN the InfraAgent resolves its model ID and no explicit `modelId` option is provided, THE InfraAgent SHALL read from the `AWS_BEDROCK_MODEL_ID` environment variable.
2. IF the `AWS_BEDROCK_MODEL_ID` environment variable is not set, THEN THE InfraAgent SHALL fall back to a hardcoded default model ID.
3. WHEN the InfraAgent initializes a Bedrock request, THE InfraAgent SHALL log the model ID being used at info level.
4. THE Generate_Route and Modify_Route SHALL not hardcode a model ID, allowing the InfraAgent to resolve it from the environment.

### Requirement 8: Expanded Modify Flow Options

**User Story:** As a developer, I want to modify additional resource properties through the modify flow, so that I can adjust infrastructure without creating new requests.

#### Acceptance Criteria

1. WHEN modifying an RDS resource, THE Modify_Route SHALL accept `storageGb` as a modification parameter to change allocated storage.
2. WHEN modifying an RDS resource, THE Modify_Route SHALL accept `multiAz` as a modification parameter to enable or disable Multi-AZ deployment.
3. WHEN modifying an IAM role, THE Modify_Route SHALL accept `addPermissions` and `removePermissions` as modification parameters containing lists of AWS managed policy ARNs or service names.
4. WHEN modifying an S3 bucket, THE Modify_Route SHALL accept `lifecycleRules` as a modification parameter containing expiration days and transition rules.
5. THE Modify_Route SHALL build appropriate AI prompts for each new modification type that instruct the model to apply only the specified change.

### Requirement 9: Rate Limiting on Generate Endpoint

**User Story:** As a platform engineer, I want the generate endpoint to be rate-limited per user, so that a single user cannot exhaust AI compute resources.

#### Acceptance Criteria

1. THE Generate_Route SHALL track the number of requests per authenticated user email within a rolling 1-hour window.
2. IF a user exceeds 10 requests within the 1-hour window, THEN THE Generate_Route SHALL return HTTP 429 with a `Retry-After` header indicating seconds until the window resets.
3. THE Rate_Limiter SHALL use an in-memory Map with automatic entry expiration after 1 hour.
4. THE Rate_Limiter SHALL not persist state across server restarts (in-memory only is acceptable).
5. WHEN a request is rate-limited, THE Generate_Route SHALL log the event with the user email and current count.

### Requirement 10: Terraform Content Sanitization

**User Story:** As a security engineer, I want generated Terraform content to be scanned for secrets before committing, so that credentials are never committed to the repository.

#### Acceptance Criteria

1. WHEN the Execute_Handler receives Terraform content for commit, THE Execute_Handler SHALL scan the content for common secret patterns before any file operation.
2. THE secret scanner SHALL detect: AWS access key IDs (pattern `AKIA[0-9A-Z]{16}`), AWS secret keys (40-character base64 strings preceded by assignment), generic password assignments, and bearer tokens.
3. IF any secret pattern is detected, THEN THE Execute_Handler SHALL reject the request with status 422 and mark it as `execute_failed`.
4. WHEN a secret is detected, THE Execute_Handler SHALL log a security warning with the pattern type found but not the actual secret value.
5. THE Execute_Handler SHALL notify the requestor that the generated content contained potential secrets and was rejected.

### Requirement 11: Consistent Rollback with try/finally

**User Story:** As a platform engineer, I want all failure paths in the execute handler to clean up created branches, so that no code path can leave orphaned branches.

#### Acceptance Criteria

1. THE Execute_Handler SHALL wrap all operations after successful branch creation in a try/finally block.
2. WITHIN the finally block, IF the request status is not `executed`, THEN THE Execute_Handler SHALL delete the created branch.
3. THE Execute_Handler SHALL track whether the branch was successfully created using a boolean flag set immediately after the createBranch call succeeds.
4. IF the branch deletion in the finally block fails, THEN THE Execute_Handler SHALL log the error but not throw, allowing the original error to propagate.

### Requirement 12: Structured Logging

**User Story:** As a platform engineer, I want all infra-request logs to be structured JSON with consistent fields, so that I can query and correlate logs in our observability stack.

#### Acceptance Criteria

1. THE Structured_Logger SHALL output log entries as single-line JSON objects with fields: `timestamp`, `level`, `requestId`, `userId`, `action`, `message`, and optional `duration` and `metadata`.
2. THE Execute_Handler SHALL use the Structured_Logger for all log statements, replacing existing `console.log` calls.
3. THE Generate_Route SHALL use the Structured_Logger for all log statements, replacing existing `console.log` calls.
4. THE Modify_Route SHALL use the Structured_Logger for all log statements, replacing existing `console.log` calls.
5. WHEN an operation completes, THE Structured_Logger SHALL include the `duration` field in milliseconds measuring the time from request start to completion.
6. THE Structured_Logger SHALL generate a unique `requestId` (UUID v4) at the start of each API request and include it in all subsequent log entries for that request.
