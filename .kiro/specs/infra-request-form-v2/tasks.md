# Implementation Plan: Infrastructure Request Form V2

## Overview

Replace the existing `InfraRequestForm` and AI chat interface with a wizard-style form at `/create-infra`. The implementation adds a Prompt Builder, Cost Estimator enhancement, Generate API endpoint, and Form V2 components (resource field panels + cost panel), then swaps the page and adds i18n keys. All backend reuse (Submit API, Execute API, approval flow, `infra_requests` table) remains unchanged.

## Tasks

- [x] 1. Modify InfraAgent to accept optional modelId
  - [x] 1.1 Add optional `modelId`, `temperature`, and `maxTokens` to `InfraAgent` constructor
    - Refactor the constructor to accept an `InfraAgentOptions` object: `{ projectId, defaultBranch, modelId?, temperature?, maxTokens? }`
    - Update `resolveModelId()` to prioritize `this.modelId` over env variables
    - Update `inferenceConfig` in both `run()` and `runStream()` to use `this.temperature` and `this.maxTokens` when provided
    - Ensure backward compatibility: existing callers (`createInfraAgent`) continue working without changes
    - Update the `createInfraAgent` factory function signature to pass through the new options
    - _Requirements: 12.1, 12.2, 12.3_

  - [ ]* 1.2 Write unit tests for InfraAgent modelId override
    - Test that `resolveModelId()` returns constructor `modelId` when provided
    - Test that `resolveModelId()` falls back to env variable when `modelId` is not provided
    - Test that temperature and maxTokens overrides are applied to `inferenceConfig`
    - _Requirements: 12.1, 12.2, 12.3_

- [x] 2. Implement Prompt Builder module
  - [x] 2.1 Create `src/lib/infra-prompt-builder.ts` with types and `buildPrompt()` function
    - Define `RdsFields`, `S3Fields`, `IamRoleFields`, `ResourceFields`, and `BuildPromptInput` interfaces
    - Implement `buildPrompt(input: BuildPromptInput): string` with templates for each resource type
    - RDS template: include identifier, dbName, instanceClass, storageGb, multiAz, targetEnvironments
    - S3 template: include bucketName, versioning, encryptionType, lifecycleRules, targetEnvironments
    - IAM Role template: include roleName, servicePrincipal, policyType, namespace (if IRSA), permissions list, targetEnvironments
    - Every prompt must include instruction to read repo tree and existing `.tf` files
    - Every prompt must include the `count = contains(var.target_environments, var.environment) ? 1 : 0` pattern instruction
    - No free-text user input is ever included in the prompt
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 6.2, 6.3_

  - [ ]* 2.2 Write property test: Prompt Builder includes all field values (Property 2)
    - **Property 2: Prompt Builder includes all field values for any resource type**
    - Generate random valid field objects for each resource type using fast-check arbitraries
    - Verify the returned prompt string contains every field value and all target environment names
    - **Validates: Requirements 6.2, 6.3, 11.2, 11.3, 11.4**

  - [ ]* 2.3 Write property test: Prompt Builder includes required instructions (Property 3)
    - **Property 3: Prompt Builder includes required instructions in every prompt**
    - Generate random valid inputs to `buildPrompt()`
    - Verify the prompt contains an instruction to read the repo tree and existing `.tf` files
    - Verify the prompt contains the string `count = contains(var.target_environments, var.environment) ? 1 : 0`
    - **Validates: Requirements 11.5, 11.6**

- [x] 3. Enhance Cost Estimator for V2 granular fields
  - [x] 3.1 Add `estimateRdsCostV2()` to `src/lib/infra-cost-estimator.ts`
    - Add per-instance-class pricing map: `db.t4g.micro` ($12/mo), `db.t4g.small` ($25/mo), `db.t4g.medium` ($47/mo), `db.t4g.large` ($95/mo)
    - Add storage pricing: $0.115/GB/month for gp3
    - Implement `estimateRdsCostV2(params: RdsCostParams): CostEstimate` that calculates cost from instanceClass, storageGb, multiAz, and targetEnvironments
    - Multi-AZ doubles compute cost per environment
    - Keep existing `estimateInfraCost` unchanged for backward compatibility
    - Add S3 and IAM Role cost helpers that return $0 with appropriate billing explanations
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [ ]* 3.2 Write unit tests for `estimateRdsCostV2`
    - Test various instance class / storage / Multi-AZ / environment combinations
    - Test that S3 and IAM Role return $0 with billing explanations
    - _Requirements: 5.1, 5.5_

- [x] 4. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Implement Generate API endpoint
  - [x] 5.1 Create `src/app/api/infra-request-v2/generate/route.ts`
    - Implement `POST` handler with `requireUserAuth` authentication
    - Parse and validate request body: `{ team, resourceType, fields, targetEnvironments }`
    - Validate `resourceType` is one of `"rds"`, `"s3"`, `"iam_role"` — return HTTP 400 if invalid
    - Look up team via `repoCatalog.getByTeam(team)` — return HTTP 422 if not found
    - Call `buildPrompt({ resourceType, fields, targetEnvironments })` to construct the AI prompt
    - Create `InfraAgent` with `{ projectId, defaultBranch, modelId: "eu.amazon.nova-pro-v1:0", temperature: 0.2, maxTokens: 32000 }`
    - Call `agent.run()` with the constructed prompt, empty history, team, and requestor email
    - Return `{ terraformPreview, aiReply: result.reply }` on success
    - Return `{ terraformPreview: null, aiReply }` if agent completes without preview
    - Return HTTP 500 on unrecoverable agent errors
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 6.1, 6.4, 6.9, 12.1, 12.2, 12.3_

  - [ ]* 5.2 Write unit tests for Generate API route
    - Mock `repoCatalog.getByTeam`, `InfraAgent.run`, and `requireUserAuth`
    - Test HTTP 200 with valid data and successful agent run
    - Test HTTP 200 with `terraformPreview: null` when agent returns no preview
    - Test HTTP 400 for invalid `resourceType`
    - Test HTTP 422 for unknown team
    - Test HTTP 500 for agent errors
    - Test HTTP 401 for unauthenticated requests
    - _Requirements: 10.1, 10.2, 10.3, 10.5, 10.6, 10.7, 10.8_

  - [ ]* 5.3 Write property test: Generate API rejects unknown teams with HTTP 422 (Property 5)
    - **Property 5: Generate API rejects unknown teams with HTTP 422**
    - Generate random team names not in the catalog, verify 422 response
    - **Validates: Requirements 10.2**

  - [ ]* 5.4 Write property test: Generate API rejects invalid resource types with HTTP 400 (Property 6)
    - **Property 6: Generate API rejects invalid resource types with HTTP 400**
    - Generate random strings not in `{"rds", "s3", "iam_role"}`, verify 400 response
    - **Validates: Requirements 10.3**

- [x] 6. Checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Implement Form V2 components
  - [x] 7.1 Create RDS fields panel `src/components/infra-request-v2/rds-fields.tsx`
    - Render fields: identifier (text), database name (text), instance class (Select dropdown), storage GB (number input), Multi-AZ (Checkbox), target environments (checkbox group: dev, uat, prod)
    - Set defaults: instanceClass = `db.t4g.micro`, storageGb = 20, multiAz = false
    - Instance class options: `db.t4g.micro` (2 vCPU, 1 GB), `db.t4g.small` (2 vCPU, 2 GB), `db.t4g.medium` (2 vCPU, 4 GB), `db.t4g.large` (2 vCPU, 8 GB)
    - Validate identifier: `/^[a-z][a-z0-9-]{2,62}$/` with inline error in Spanish
    - Validate db name: `/^[a-z][a-z0-9_]{0,62}$/` with inline error in Spanish
    - When team is "Tooling", auto-select "tooling" environment and hide standard checkboxes
    - At least one environment must be selected
    - All labels, placeholders, errors in Spanish via `useI18n`
    - Use shadcn/ui components (Input, Select, Checkbox, Label) + Tailwind
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 8.1, 8.4, 8.5_

  - [x] 7.2 Create S3 fields panel `src/components/infra-request-v2/s3-fields.tsx`
    - Render fields: bucket name (text), versioning (toggle, default off), encryption type (Select: AES-256 default, aws:kms), lifecycle rules (optional textarea), target environments (checkbox group: dev, uat, prod)
    - Validate bucket name: `/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/` with inline error in Spanish
    - When team is "Tooling", auto-select "tooling" environment and hide standard checkboxes
    - At least one environment must be selected
    - All labels, placeholders, errors in Spanish via `useI18n`
    - Use shadcn/ui components + Tailwind
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 8.1, 8.4, 8.5_

  - [x] 7.3 Create IAM Role fields panel `src/components/infra-request-v2/iam-role-fields.tsx`
    - Render fields: role name (text), service principal (text), policy type (Select: IRSA default, standard), namespace (text, shown only when IRSA), permission checkboxes (S3, SecretsManager, SQS, SNS, EventBridge, RDS), target environments (checkbox group: dev, uat, prod)
    - Validate role name: `/^[a-zA-Z][a-zA-Z0-9_-]{2,63}$/` with inline error in Spanish
    - Validate namespace (when IRSA): `/^[a-z][a-z0-9-]{0,62}$/` with inline error in Spanish
    - Show/hide namespace field based on policy type selection
    - At least one environment must be selected
    - All labels, placeholders, errors in Spanish via `useI18n`
    - Use shadcn/ui components + Tailwind
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 8.1, 8.4, 8.5_

  - [x] 7.4 Create cost estimate panel `src/components/infra-request-v2/cost-estimate-panel.tsx`
    - Display estimated monthly cost using `estimateRdsCostV2` for RDS or existing helpers for S3/IAM
    - Show cost breakdown, billing warning (visually distinct alert), and recommendation (lightbulb icon)
    - Recalculate on any field change that affects cost (instance class, storage, Multi-AZ, environments)
    - For IAM Role and S3, display $0/mes with relevant billing explanation
    - Only show when resource type is selected and at least one environment is chosen
    - Use shadcn/ui Card + Badge + Tailwind
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

  - [x] 7.5 Create main form `src/components/infra-request-v2/infra-request-form-v2.tsx`
    - Implement form state machine: `"form" → "generating" → "preview" → "submitting" → "success"`
    - Team dropdown populated from RepoCatalog (fetch active teams on mount)
    - Resource type selector with three options: RDS (PostgreSQL), S3, IAM Role — disabled until team selected
    - Render the appropriate resource field panel based on selected resource type (swap + reset defaults on change)
    - Render cost estimate panel inline
    - "Generar Terraform" button — disabled until all required fields valid; calls Generate API on click
    - Loading state with progress indicator while generating; disable button during generation
    - On error from Generate API: dismissible alert with error message, re-enable button
    - On success: display `TerraformPreviewPanel` with generated HCL, file path, resource type, resource name, environments, cost
    - "Regenerar" button: re-call Generate API with same form data
    - "Enviar para aprobación" button: show approver dropdown from `SELECTABLE_APPROVERS`
    - On approver selection + confirm: call Submit API with terraformPreview, team, approver, and constructed conversation array
    - On submit success: display success message with request ID and link to `/infra-requests`
    - On submit error: dismissible alert with error message
    - On successful submit: reset resource-specific fields to defaults, preserve team selection
    - Validate all fields on blur and on submit with inline error messages in Spanish
    - Use Zod schema with `superRefine` for resource-type-specific validation
    - Use shadcn/ui components (Select, Input, Checkbox, Button, Card, Badge, Form) + Tailwind
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.1, 6.7, 6.8, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 7.7, 8.1, 8.2, 8.3, 8.4, 8.5_

  - [ ]* 7.6 Write property test: Field validation accepts valid and rejects invalid inputs (Property 1)
    - **Property 1: Field validation accepts valid inputs and rejects invalid inputs**
    - Generate random strings for each field type (RDS identifier, RDS db name, S3 bucket name, IAM role name, IAM namespace)
    - Verify validation function accepts the string if and only if it matches the field's regex pattern
    - **Validates: Requirements 2.4, 2.5, 3.2, 4.2, 4.5**

- [x] 8. Update `/create-infra` page to use Form V2
  - [x] 8.1 Replace `InfraRequestForm` with `InfraRequestFormV2` in `src/app/create-infra/page.tsx`
    - Import `InfraRequestFormV2` instead of `InfraRequestForm`
    - Update page title and description to Spanish
    - Keep back navigation link to portal home
    - Add link to infra requests dashboard (`/infra-requests`)
    - Maintain consistent layout: back button, title, card wrapper
    - _Requirements: 9.1, 9.2, 9.3, 9.4_

- [x] 9. Add i18n keys for Form V2
  - [x] 9.1 Add Spanish i18n keys to `src/i18n/es.json`
    - Add keys for all form labels, placeholders, descriptions, error messages, and button text under an `infraV2.*` namespace
    - Include: team selector label, resource type options, field labels for RDS/S3/IAM, validation error messages, button labels ("Generar Terraform", "Regenerar", "Enviar para aprobación"), success/error messages, cost panel labels
    - Add corresponding keys to `en.json`, `pt.json`, `fr.json` with English/Portuguese/French translations
    - _Requirements: 8.4_

- [x] 10. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.
  - Verify the form renders correctly at `/create-infra`
  - Verify team dropdown loads from RepoCatalog
  - Verify resource type switching renders correct field panels
  - Verify validation rules match requirements
  - Verify cost estimation updates in real-time
  - Verify Generate API returns expected response shape

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- The existing Submit API, Execute API, approval flow, and `infra_requests` table are reused unchanged — no migrations needed
- All UI text is in Spanish using the existing `useI18n` system
- The `TerraformPreviewPanel` component is reused as-is from `src/components/infra-assistant/terraform-preview.tsx`
