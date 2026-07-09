# Requirements Document

## Introduction

The Infrastructure Request Form v2 replaces both the existing rigid form (`InfraRequestForm` at `/create-infra`) and the free-form AI chat interface (`ChatPanel`) with a single guided wizard-style form. Developers select a team and resource type, fill in resource-specific fields with sensible defaults and validation, and click "Generate Terraform". The AI (Amazon Nova Pro via Bedrock) works behind the scenes — reading the team's GitLab infra repo to understand conventions, then generating contextually correct Terraform. The developer sees a Terraform preview (reusing the existing `TerraformPreviewPanel`), can regenerate or submit for approval. After approval, the existing execute flow (createBranch → createFile → createMR → Jira → Teams) runs unchanged.

The form supports three resource types initially: RDS (PostgreSQL), S3, and IAM Role. The UI is in Spanish (matching the rest of the portal) and uses existing shadcn/ui components with Tailwind CSS. No free-text chat is exposed to the developer — the AI prompt is constructed entirely from the structured form fields.

## Glossary

- **Form_V2**: The new guided wizard-style infrastructure request form component that replaces both the old `InfraRequestForm` and the `ChatPanel`
- **Resource_Wizard**: The dynamic section of Form_V2 that renders resource-specific fields based on the selected resource type
- **Prompt_Builder**: The server-side module that constructs the AI prompt from structured form field values, without any free-text user input
- **InfraAgent**: The existing server-side orchestrator (`src/lib/infra-agent.ts`) that manages the Bedrock tool-use loop for Terraform generation
- **Generate_API**: The `POST /api/infra-request-v2/generate` endpoint that accepts structured form data, builds the AI prompt, runs the InfraAgent, and returns a TerraformPreview
- **Submit_API**: The existing `POST /api/infra-assistant/submit` endpoint that persists a request for approval
- **Execute_API**: The existing `POST /api/infra-assistant/execute/:id` internal endpoint that performs all write operations after approval
- **RepoCatalog**: The `repo_catalog` database table and its accessor class that maps team names to GitLab project IDs
- **TerraformPreviewPanel**: The existing React component (`src/components/infra-assistant/terraform-preview.tsx`) that renders HCL with syntax highlighting and action buttons
- **Cost_Estimator**: The existing `estimateInfraCost` function (`src/lib/infra-cost-estimator.ts`) that calculates estimated monthly cost from resource parameters
- **Developer**: An authenticated portal user who initiates an infrastructure request
- **Approver**: A designated reviewer from `SELECTABLE_APPROVERS` who approves or rejects infrastructure requests
- **Nova_Pro**: The Amazon Nova Pro model (`eu.amazon.nova-pro-v1:0`) used via AWS Bedrock for Terraform generation

---

## Requirements

### Requirement 1: Team and Resource Type Selection

**User Story:** As a developer, I want to select my team and the type of resource I need from dropdowns, so that the form shows me only the relevant fields for my request.

#### Acceptance Criteria

1. WHEN a Developer opens Form_V2, THE Form_V2 SHALL display a team dropdown populated with all active teams from the RepoCatalog
2. WHEN a Developer selects a team, THE Form_V2 SHALL display a resource type selector with exactly three options: RDS (PostgreSQL), S3, and IAM Role
3. WHEN a Developer selects a resource type, THE Resource_Wizard SHALL render the resource-specific fields for that type within 100ms
4. WHEN a Developer changes the resource type selection, THE Resource_Wizard SHALL replace the current resource-specific fields with the fields for the newly selected type and reset all resource-specific field values to their defaults
5. IF a Developer has not selected a team, THEN THE Form_V2 SHALL disable the resource type selector and the "Generar Terraform" button
6. IF a Developer has not selected a resource type, THEN THE Form_V2 SHALL disable the "Generar Terraform" button

---

### Requirement 2: RDS Resource Fields

**User Story:** As a developer, I want to fill in RDS-specific fields with guided options and sensible defaults, so that I can request a PostgreSQL database without knowing Terraform syntax.

#### Acceptance Criteria

1. WHEN a Developer selects the RDS resource type, THE Resource_Wizard SHALL display fields for: identifier (text input), database name (text input), instance class (dropdown), storage size in GB (number input), Multi-AZ toggle (checkbox), and target environments (checkbox group)
2. THE Resource_Wizard SHALL set the following default values for RDS fields: instance class = `db.t4g.micro`, storage size = 20 GB, Multi-AZ = disabled
3. THE Resource_Wizard SHALL offer the following instance class options in the dropdown: `db.t4g.micro` (2 vCPU, 1 GB), `db.t4g.small` (2 vCPU, 2 GB), `db.t4g.medium` (2 vCPU, 4 GB), `db.t4g.large` (2 vCPU, 8 GB)
4. WHEN a Developer enters an RDS identifier, THE Form_V2 SHALL validate that the identifier contains only lowercase alphanumeric characters and hyphens, is between 3 and 63 characters, and starts with a letter
5. WHEN a Developer enters a database name, THE Form_V2 SHALL validate that the database name contains only lowercase alphanumeric characters and underscores, is between 1 and 63 characters, and starts with a letter
6. THE Resource_Wizard SHALL display target environment checkboxes for: dev, uat, prod; and THE Developer SHALL select at least one environment
7. WHEN the selected team is "Tooling", THE Resource_Wizard SHALL auto-select the "tooling" environment and hide the standard environment checkboxes

---

### Requirement 3: S3 Resource Fields

**User Story:** As a developer, I want to fill in S3-specific fields with guided options, so that I can request a bucket with the right configuration.

#### Acceptance Criteria

1. WHEN a Developer selects the S3 resource type, THE Resource_Wizard SHALL display fields for: bucket name (text input), versioning (toggle, default off), encryption type (dropdown, default AES-256), lifecycle rules (optional text area), and target environments (checkbox group)
2. WHEN a Developer enters a bucket name, THE Form_V2 SHALL validate that the bucket name contains only lowercase alphanumeric characters, hyphens, and dots, is between 3 and 63 characters, and starts and ends with a letter or number
3. THE Resource_Wizard SHALL offer the following encryption options: AES-256 (default), aws:kms
4. THE Resource_Wizard SHALL display target environment checkboxes for: dev, uat, prod; and THE Developer SHALL select at least one environment
5. WHEN the selected team is "Tooling", THE Resource_Wizard SHALL auto-select the "tooling" environment and hide the standard environment checkboxes

---

### Requirement 4: IAM Role Resource Fields

**User Story:** As a developer, I want to fill in IAM Role-specific fields with guided options, so that I can request a role with the right permissions for my service.

#### Acceptance Criteria

1. WHEN a Developer selects the IAM Role resource type, THE Resource_Wizard SHALL display fields for: role name (text input), service principal (text input), policy type (dropdown: IRSA or standard, default IRSA), namespace (text input, shown only when policy type is IRSA), permission checkboxes (S3, SecretsManager, SQS, SNS, EventBridge, RDS), and target environments (checkbox group)
2. WHEN a Developer enters a role name, THE Form_V2 SHALL validate that the role name contains only alphanumeric characters, hyphens, and underscores, is between 3 and 64 characters, and starts with a letter
3. WHEN a Developer selects policy type IRSA, THE Resource_Wizard SHALL display the namespace field as required
4. WHEN a Developer selects policy type standard, THE Resource_Wizard SHALL hide the namespace field
5. WHEN a Developer enters a namespace, THE Form_V2 SHALL validate that the namespace contains only lowercase alphanumeric characters and hyphens, is between 1 and 63 characters
6. THE Resource_Wizard SHALL display target environment checkboxes for: dev, uat, prod; and THE Developer SHALL select at least one environment

---

### Requirement 5: Cost Estimation Display

**User Story:** As a developer, I want to see an estimated monthly cost as I fill in the form, so that I can make informed decisions about resource sizing before submitting.

#### Acceptance Criteria

1. WHILE a Developer has selected a resource type and at least one target environment, THE Form_V2 SHALL display an estimated monthly cost panel using the Cost_Estimator
2. WHEN the Developer changes any field that affects cost (instance class, storage size, Multi-AZ, target environments), THE Form_V2 SHALL recalculate and update the cost estimate within 50ms
3. WHEN the Cost_Estimator returns a billing warning, THE Form_V2 SHALL display the warning text in a visually distinct alert below the cost estimate
4. WHEN the Cost_Estimator returns a recommendation, THE Form_V2 SHALL display the recommendation text with a lightbulb icon below the cost estimate
5. WHEN the resource type is IAM Role or S3, THE Form_V2 SHALL display the cost panel with $0/mes and the relevant billing explanation from the Cost_Estimator

---

### Requirement 6: AI-Driven Terraform Generation from Form Fields

**User Story:** As a developer, I want to click "Generate Terraform" and have the AI generate contextually correct Terraform based on my form inputs and my team's repo patterns, so that I get production-ready code without writing it myself.

#### Acceptance Criteria

1. WHEN a Developer clicks "Generar Terraform" with all required fields valid, THE Form_V2 SHALL send the structured form data to the Generate_API
2. WHEN the Generate_API receives valid form data, THE Prompt_Builder SHALL construct an AI prompt that includes: the resource type, all field values, the target environments, and an instruction to generate Terraform matching the team's existing repo patterns
3. WHEN the Prompt_Builder constructs the prompt, THE Prompt_Builder SHALL NOT include any free-text user input — the prompt SHALL be built entirely from structured form field values
4. WHEN the Generate_API processes the request, THE InfraAgent SHALL read the team's GitLab repo tree and at least one existing `.tf` file before generating Terraform
5. WHEN the InfraAgent generates a TerraformPreview, THE TerraformPreview SHALL contain a non-empty `filePath`, `content`, `resourceType`, `resourceName`, and `targetEnvironments` array
6. WHEN the InfraAgent generates Terraform content, THE generated HCL SHALL include the `count = contains(var.target_environments, var.environment) ? 1 : 0` pattern for multi-environment support
7. WHILE the Generate_API is processing, THE Form_V2 SHALL display a loading state with a progress indicator and disable the "Generar Terraform" button
8. IF the Generate_API returns an error, THEN THE Form_V2 SHALL display the error message in a dismissible alert and re-enable the "Generar Terraform" button
9. WHEN the Generate_API uses the Bedrock model, THE Generate_API SHALL use the model ID `eu.amazon.nova-pro-v1:0` (Amazon Nova Pro)

---

### Requirement 7: Terraform Preview and Actions

**User Story:** As a developer, I want to review the generated Terraform in a preview panel before submitting, so that I can verify it looks correct or regenerate if needed.

#### Acceptance Criteria

1. WHEN the Generate_API returns a TerraformPreview, THE Form_V2 SHALL display the TerraformPreviewPanel component with the generated HCL, file path, resource type, resource name, target environments, and estimated cost
2. WHEN the TerraformPreviewPanel is displayed, THE Form_V2 SHALL show two action buttons: "Enviar para aprobación" and "Regenerar"
3. WHEN a Developer clicks "Regenerar", THE Form_V2 SHALL call the Generate_API again with the same form data and replace the current preview with the new result
4. WHEN a Developer clicks "Enviar para aprobación", THE Form_V2 SHALL display an approver selection dropdown populated from `SELECTABLE_APPROVERS`
5. WHEN a Developer selects an approver and confirms submission, THE Form_V2 SHALL call the Submit_API with the TerraformPreview, team, selected approver, and a generated conversation array containing the constructed prompt and the AI response
6. WHEN the Submit_API returns successfully, THE Form_V2 SHALL display a success message with the request ID and a link to the infra requests dashboard
7. IF the Submit_API returns an error, THEN THE Form_V2 SHALL display the error message in a dismissible alert

---

### Requirement 8: Form Validation and UX

**User Story:** As a developer, I want the form to validate my inputs in real-time and guide me through the process, so that I avoid errors and submit correct requests efficiently.

#### Acceptance Criteria

1. THE Form_V2 SHALL validate all required fields on blur and on submit, displaying inline error messages below each invalid field
2. THE Form_V2 SHALL disable the "Generar Terraform" button until all required fields for the selected resource type pass validation
3. WHEN a Developer submits the form successfully, THE Form_V2 SHALL reset all resource-specific fields to their defaults while preserving the team selection
4. THE Form_V2 SHALL render all labels, placeholders, descriptions, error messages, and button text in Spanish using the existing i18n system (`useI18n`)
5. THE Form_V2 SHALL use existing shadcn/ui components (Select, Input, Checkbox, Button, Card, Badge, Form) and Tailwind CSS classes consistent with the rest of the portal

---

### Requirement 9: Page Replacement and Navigation

**User Story:** As a developer, I want the new form to be at the same location as the old one, so that my bookmarks and navigation still work.

#### Acceptance Criteria

1. THE Form_V2 SHALL replace the existing `InfraRequestForm` component at the `/create-infra` route
2. WHEN a Developer navigates to `/create-infra`, THE portal SHALL render the Form_V2 page instead of the old form
3. THE Form_V2 page SHALL include a back navigation link to the portal home page, consistent with the existing page layout
4. THE Form_V2 page SHALL include a link to the infra requests dashboard (`/infra-requests`) so developers can check the status of their requests

---

### Requirement 10: Generate API Endpoint

**User Story:** As a platform engineer, I want a dedicated API endpoint that accepts structured form data and returns generated Terraform, so that the AI generation is decoupled from the chat interface.

#### Acceptance Criteria

1. THE Generate_API SHALL accept POST requests at `/api/infra-request-v2/generate` with a JSON body containing: `team` (string), `resourceType` (string), `fields` (object with resource-specific values), and `targetEnvironments` (string array)
2. WHEN the Generate_API receives a request, THE Generate_API SHALL validate that the team exists in the RepoCatalog and return HTTP 422 with an error message if the team is not found
3. WHEN the Generate_API receives a request, THE Generate_API SHALL validate that `resourceType` is one of `rds`, `s3`, or `iam_role` and return HTTP 400 if invalid
4. WHEN the Generate_API receives valid data, THE Generate_API SHALL construct the prompt via the Prompt_Builder, create an InfraAgent instance with the team's project ID and default branch, and run the agent
5. WHEN the InfraAgent completes successfully with a TerraformPreview, THE Generate_API SHALL return HTTP 200 with the TerraformPreview object and the AI reply text
6. IF the InfraAgent completes without producing a TerraformPreview, THEN THE Generate_API SHALL return HTTP 200 with `terraformPreview: null` and the AI reply text explaining what additional information is needed
7. IF the InfraAgent encounters an unrecoverable error, THEN THE Generate_API SHALL return HTTP 500 with an error message
8. THE Generate_API SHALL enforce authentication via `requireUserAuth`

---

### Requirement 11: Prompt Builder

**User Story:** As a platform engineer, I want the AI prompt to be constructed deterministically from form fields, so that the generation is predictable and the developer never needs to write free text.

#### Acceptance Criteria

1. THE Prompt_Builder SHALL accept a resource type and a fields object and return a single string prompt for the InfraAgent
2. WHEN the resource type is `rds`, THE Prompt_Builder SHALL construct a prompt requesting a PostgreSQL RDS instance with the specified identifier, database name, instance class, storage size, Multi-AZ setting, and target environments
3. WHEN the resource type is `s3`, THE Prompt_Builder SHALL construct a prompt requesting an S3 bucket with the specified bucket name, versioning setting, encryption type, lifecycle rules, and target environments
4. WHEN the resource type is `iam_role`, THE Prompt_Builder SHALL construct a prompt requesting an IAM role with the specified role name, service principal, policy type, namespace (if IRSA), selected permissions, and target environments
5. THE Prompt_Builder SHALL include in every prompt an instruction to read the team's repo structure and existing `.tf` files before generating Terraform
6. THE Prompt_Builder SHALL include in every prompt an instruction to use the `count = contains(var.target_environments, var.environment) ? 1 : 0` pattern

---

### Requirement 12: Model Configuration

**User Story:** As a platform engineer, I want the v2 form to use Amazon Nova Pro for Terraform generation, so that we use the model best suited for tool-use and code generation.

#### Acceptance Criteria

1. THE Generate_API SHALL configure the InfraAgent to use the model ID `eu.amazon.nova-pro-v1:0` for all Terraform generation requests, overriding the default `AWS_BEDROCK_MODEL_ID` environment variable
2. THE Generate_API SHALL set the inference temperature to 0.2 for Terraform generation to produce more deterministic output
3. THE Generate_API SHALL enforce a maximum token budget of 32,000 tokens per generation request via `inferenceConfig`
