# Tasks

## Task 1: Create Structured Logger

- [x] 1.1 Create `src/lib/logger.ts` with `InfraLogger` class that outputs single-line JSON with fields: timestamp, level, requestId (UUID v4), userId, action, message, optional duration and metadata
- [x] 1.2 Implement `done()` method that calculates duration in milliseconds from construction time
- [x] 1.3 Write property-based test `src/lib/__tests__/logger.property.test.ts` validating Property 16 (output is valid JSON, contains required fields, duration is non-negative)

## Task 2: Create Rate Limiter

- [x] 2.1 Create `src/lib/rate-limiter.ts` with `RateLimiter` class using in-memory Map with sliding window (default: 10 requests per 1-hour window)
- [x] 2.2 Implement `check(key)` method returning `{ allowed, remaining, retryAfterSeconds }` with lazy expiration of old timestamps
- [x] 2.3 Write property-based test `src/lib/__tests__/rate-limiter.property.test.ts` validating Property 13 (first 10 allowed, subsequent rejected with positive retryAfterSeconds)

## Task 3: Create Secret Scanner

- [x] 3.1 Create `src/lib/secret-scanner.ts` with `scanForSecrets(content)` function detecting AWS access keys, AWS secret keys, password assignments, and bearer tokens
- [x] 3.2 Implement false-positive exclusions for `var.password`, `random_password.*.result`, and Terraform variable references
- [x] 3.3 Write property-based test `src/lib/__tests__/secret-scanner.property.test.ts` validating Property 14 (detection of all pattern types) and Property 15 (findings never contain actual secret values)

## Task 4: Enhance Terraform Validator

- [x] 4.1 Add `validateVariableReferences(content)` to `src/lib/terraform-validator.ts` — verify `var.<identifier>` uses only `[a-zA-Z_][a-zA-Z0-9_]*`
- [x] 4.2 Add `validateResourceNames(content)` — verify resource names use only `[a-zA-Z0-9_-]+`
- [x] 4.3 Add `validateCountExpressions(content)` — verify balanced parentheses in `count = ...` expressions
- [x] 4.4 Update `validateHclSyntax` to call all new validators and return errors with line numbers
- [x] 4.5 Write property-based test `src/lib/__tests__/terraform-validator.property.test.ts` validating Properties 1, 2, and 3

## Task 5: Create Field Validators

- [x] 5.1 Add `validateRdsFields(fields)` to `src/app/api/infra-request-v2/generate/route.ts` — reject identifiers starting/ending with hyphen or exceeding 63 chars
- [x] 5.2 Add `validateS3Fields(fields)` — reject names containing "aws"/"amazon" (case-insensitive), enforce 3-63 chars, lowercase+numbers+hyphens+periods only
- [x] 5.3 Add `validateIamRoleFields(fields)` — validate namespace as K8s namespace pattern (starts with letter, lowercase alphanumeric + hyphens, max 63)
- [x] 5.4 Integrate validators into the Generate_Route POST handler, returning HTTP 400 with field name and violated rule on failure
- [x] 5.5 Write property-based test `src/lib/__tests__/field-validators.property.test.ts` validating Properties 9, 10, 11, and 12 (extract validators to a shared module `src/lib/field-validators.ts` for testability)

## Task 6: Enhance GitLab Client for Optimistic Locking

- [x] 6.1 Add `getRepositoryFileWithMeta(projectId, filePath, ref)` method to `src/lib/gitlab.ts` that calls `/repository/files/:path` (non-raw) endpoint and returns `{ content, lastCommitId }`
- [x] 6.2 Update `updateFile` method signature to accept optional `lastCommitId` parameter and include it in the PUT request body when provided

## Task 7: Implement Optimistic Locking in Execute Handler

- [x] 7.1 In `src/app/api/infra-assistant/execute/[id]/route.ts`, replace `getRepositoryFileRaw` with `getRepositoryFileWithMeta` for shared file reads
- [x] 7.2 Pass `lastCommitId` to `updateFile` when appending to shared files
- [x] 7.3 Implement retry loop (max 3 attempts) that catches 409 conflicts, re-reads the file with new commit SHA, and re-appends content
- [x] 7.4 Mark request as `execute_failed` after 3 failed retries

## Task 8: Implement Branch Rollback with try/finally

- [x] 8.1 In `src/app/api/infra-assistant/execute/[id]/route.ts`, add a `branchCreated` boolean flag set after successful `createBranch`
- [x] 8.2 Wrap all operations after branch creation (file ops, MR, DB update) in a try/finally block
- [x] 8.3 In the finally block, if `branchCreated` is true and request status is not `executed`, call `deleteBranch` with error suppression (log but don't throw)
- [x] 8.4 Remove the existing inline `deleteBranch` call in the file operation catch block (now handled by finally)
- [x] 8.5 Ensure non-fatal failures (MR, Jira, Teams) do NOT trigger branch deletion — they occur inside the try block but don't change the execution flow

## Task 9: Integrate Secret Scanner into Execute Handler

- [x] 9.1 In `src/app/api/infra-assistant/execute/[id]/route.ts`, import and call `scanForSecrets(content)` after Terraform validation but before any file operation
- [x] 9.2 If secrets detected: log security warning (pattern type only, not value), mark `execute_failed`, notify requestor, return 422
- [x] 9.3 Ensure the secret scan happens before branch creation to avoid unnecessary branch cleanup

## Task 10: Integrate Rate Limiter into Generate Route

- [x] 10.1 In `src/app/api/infra-request-v2/generate/route.ts`, import `RateLimiter` and create a module-level instance
- [x] 10.2 After authentication, call `rateLimiter.check(userEmail)` — if not allowed, return 429 with `Retry-After` header and log the event
- [x] 10.3 Verify rate limiter does not block requests when under threshold

## Task 11: Implement Modify Scope Verification

- [x] 11.1 Create `extractResourceBlocks(content)` utility function in `src/app/api/infra-request-v2/modify/route.ts` (or a shared lib) that parses resource/module block names from HCL
- [x] 11.2 Create `verifyModifyScope(original, modified, targetResource)` that compares blocks and allows changes only to target + related resources (name prefix match)
- [x] 11.3 After receiving AI result, call scope verifier — if invalid, retry once with explicit "only modify target" instruction
- [x] 11.4 If retry also fails scope check, return 422 with list of unexpectedly changed resources
- [x] 11.5 Write property-based test `src/lib/__tests__/resource-scope-verifier.property.test.ts` validating Properties 4 and 5

## Task 12: Enhance Cost Estimator

- [x] 12.1 In `src/lib/infra-cost-estimator.ts`, update `estimateRdsCostV2` to add backup storage cost (30% of base instance monthly cost) as a separate line item in breakdown
- [x] 12.2 Add data transfer warning string containing "$0.09/GB" to RDS and S3 estimates
- [x] 12.3 Update `estimateS3Cost` to return `monthlyCost` of 1-5 (range indicator) instead of 0
- [x] 12.4 Write property-based test `src/lib/__tests__/infra-cost-estimator.property.test.ts` validating Properties 6, 7, and 8

## Task 13: Expand Modify Route Options

- [x] 13.1 In `src/app/api/infra-request-v2/modify/route.ts`, extend the `modifications` type to include `addPermissions`, `removePermissions` (string arrays) and `lifecycleRules` (object with expirationDays, transitions)
- [x] 13.2 Add prompt-building logic for IAM permission modifications (add/remove managed policy ARNs)
- [x] 13.3 Add prompt-building logic for S3 lifecycle rule modifications
- [x] 13.4 Ensure existing `storageGb` and `multiAz` parameters continue to work (already partially supported)

## Task 14: Make Bedrock Model Configurable

- [x] 14.1 Verify `src/lib/infra-agent.ts` `resolveModelId()` already reads `AWS_BEDROCK_MODEL_ID` env var (it does — confirm no changes needed)
- [x] 14.2 Remove hardcoded `modelId` from `src/app/api/infra-request-v2/generate/route.ts` InfraAgent constructor — let it resolve from env
- [x] 14.3 Remove hardcoded `modelId` from `src/app/api/infra-request-v2/modify/route.ts` InfraAgent constructor — let it resolve from env
- [x] 14.4 Add logging of resolved model ID in InfraAgent (use structured logger if available, otherwise console.log with model ID)

## Task 15: Replace console.log with Structured Logger

- [x] 15.1 In `src/app/api/infra-assistant/execute/[id]/route.ts`, replace all `console.log`/`console.error` calls with `InfraLogger` methods
- [x] 15.2 In `src/app/api/infra-request-v2/generate/route.ts`, replace all `console.log`/`console.error`/`console.warn` calls with `InfraLogger` methods
- [x] 15.3 In `src/app/api/infra-request-v2/modify/route.ts`, replace all `console.log`/`console.error`/`console.warn` calls with `InfraLogger` methods
