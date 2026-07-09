# Requirements Document

## Introduction

Centralized access management system for the Platform Portal that replaces the current n8n webhook flow (`add-user-to-group.json`) for granting users access to enterprise tools. The system supports four platforms — AWS, ArgoCD, and SonarQube (all SSO via Azure AD groups) and GitLab (license-based via GitLab API) — with a unified request form, approval workflow, automated execution, Jira ticketing, and Teams notifications.

## Glossary

- **Portal**: The Platform Portal Next.js application (DevPortal IskayPet)
- **Access_Request_Form**: The UI component on the `/access-management` page where a requestor submits an access request
- **Access_Request**: A database record representing a request to grant a user access to a platform group or role
- **Requestor**: The authenticated portal user who submits an access request
- **Target_User**: The user (identified by email) who will receive access to the platform
- **Approver**: A user from the selectable approvers list who reviews and approves or rejects an access request
- **Platform**: One of the four supported tools: AWS, ArgoCD, SonarQube, or GitLab
- **Azure_AD_Group**: A security group in Microsoft Entra ID (Azure AD) used for SSO access to AWS, ArgoCD, or SonarQube
- **Graph_API_Client**: The server-side module that authenticates with Microsoft Graph API v1.0 using OAuth2 client credentials and performs group/user operations
- **GitLab_Access_Client**: The server-side module that uses the existing `gitlabClient` to add users to GitLab groups/projects with a specific role
- **Security_Filter**: The logic that hides groups containing "admin", "Admin", "owner", or "Owner" in their display name from the selectable list
- **Domain_Normalizer**: The utility that treats `@iskaypet.com` and `@emefinpetcare.com` as equivalent email domains
- **Execution_Engine**: The server-side process triggered after approval that performs the platform-specific access grant, creates a Jira ticket, and sends a Teams notification
- **Onboarding_Email**: The email sent to a Target_User after GitLab access is granted, containing login instructions, 2FA setup guide, instance link, and support contact
- **GitLab_License**: A GitLab seat (license) assigned to a user that allows them to use the GitLab instance; must be provisioned before granting group/project access and can be revoked to free up seats

## Requirements

### Requirement 1: Access Request Form

**User Story:** As a portal user, I want to submit an access request for a specific platform through a form, so that I can request access for myself or another user without leaving the portal.

#### Acceptance Criteria

1. THE Access_Request_Form SHALL display a platform selector with four options: AWS, ArgoCD, SonarQube, and GitLab
2. WHEN the Requestor selects a platform, THE Access_Request_Form SHALL display an email input field pre-filled with the Requestor session email
3. WHEN the Requestor selects AWS, ArgoCD, or SonarQube as the platform, THE Access_Request_Form SHALL fetch and display available Azure_AD_Groups from Microsoft Graph API filtered by the platform naming convention prefix
4. WHEN the Requestor selects GitLab as the platform, THE Access_Request_Form SHALL fetch and display available GitLab groups and projects from the GitLab API
5. THE Access_Request_Form SHALL display an approver selector populated with the same selectable approvers list used by the infrastructure request flow (`SELECTABLE_APPROVERS`)
6. WHEN the Requestor has selected a platform, entered a target user email, selected a group or role, and selected an approver, THE Access_Request_Form SHALL enable the submit button
7. WHEN the Requestor selects GitLab as the platform, THE Access_Request_Form SHALL display a role selector with GitLab access levels (Guest, Reporter, Developer, Maintainer)
8. WHEN the Requestor selects GitLab as the platform, THE Access_Request_Form SHALL display a request type selector with options: "Add access" (grant group/project access with license) and "Remove license" (revoke a GitLab license/seat from a user)
9. WHEN the Requestor selects "Remove license" as the GitLab request type, THE Access_Request_Form SHALL hide the group selector and role selector and only require the target user email and approver

### Requirement 2: Dynamic Group Listing with Security Filter

**User Story:** As a platform administrator, I want the portal to dynamically list available groups from Azure AD and GitLab while hiding privileged groups, so that users cannot self-service into admin or owner roles.

#### Acceptance Criteria

1. WHEN the platform is AWS, THE Graph_API_Client SHALL list Azure AD groups whose `displayName` starts with "AWS-"
2. WHEN the platform is ArgoCD, THE Graph_API_Client SHALL list Azure AD groups whose `displayName` starts with "ArgoCD-"
3. WHEN the platform is SonarQube, THE Graph_API_Client SHALL list Azure AD groups whose `displayName` starts with "SonarQube-"
4. THE Security_Filter SHALL exclude from the displayed list any group whose `displayName` contains "admin", "Admin", "owner", or "Owner"
5. WHEN the platform is GitLab, THE GitLab_Access_Client SHALL list available GitLab groups and projects from the GitLab API
6. THE Security_Filter SHALL apply the same admin/owner filtering to GitLab group names

### Requirement 3: Azure AD Authentication

**User Story:** As a system operator, I want the portal to authenticate with Microsoft Graph API using OAuth2 client credentials, so that it can manage Azure AD group memberships programmatically.

#### Acceptance Criteria

1. THE Graph_API_Client SHALL obtain an OAuth2 access token by sending a POST request to `https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token` with client credentials grant
2. THE Graph_API_Client SHALL read the tenant ID from the `AZURE_AD_TENANT_ID` environment variable
3. THE Graph_API_Client SHALL read the client ID from the `AZURE_AD_CLIENT_ID` environment variable
4. THE Graph_API_Client SHALL read the client secret from the `AZURE_AD_CLIENT_SECRET` environment variable
5. THE Graph_API_Client SHALL request the scope `https://graph.microsoft.com/.default`
6. IF the token request fails, THEN THE Graph_API_Client SHALL return a descriptive error including the HTTP status code

### Requirement 4: Access Request Submission and Persistence

**User Story:** As a requestor, I want my access request to be saved and sent for approval, so that an approver can review it before access is granted.

#### Acceptance Criteria

1. WHEN the Requestor submits the Access_Request_Form, THE Portal SHALL create an Access_Request record in the database with status "pending"
2. THE Access_Request record SHALL store: requestor email, target user email, platform, group or role identifier, group or role display name, request type (grant or revoke), selected approver email, and submission timestamp
3. WHEN the Access_Request is created, THE Portal SHALL send an in-app notification to the selected Approver using `createNotification` with type "approval_request"
4. WHEN the Access_Request is created, THE Portal SHALL send in-app notifications to the always-notified list (`ALWAYS_NOTIFIED`) using `createNotificationBatch`, unless the selected approver is an infra admin (same logic as `getNotifyList`)
5. THE Portal SHALL track the submission as a user activity event with action "access_request_submit"

### Requirement 5: Approval Flow

**User Story:** As an approver, I want to review, approve, or reject access requests, so that I can control who gets access to enterprise platforms.

#### Acceptance Criteria

1. WHEN an Approver sends a review action of "approve" or "reject" for an Access_Request, THE Portal SHALL verify the reviewer is in the approvers list using `isApprover`
2. WHEN an Approver attempts to approve their own Access_Request, THE Portal SHALL reject the action with a 403 status (self-approval prevention, using Domain_Normalizer for comparison)
3. WHEN an Approver approves an Access_Request, THE Portal SHALL update the Access_Request status to "approved" and record the reviewer email, reviewer name, and review timestamp
4. WHEN an Approver rejects an Access_Request, THE Portal SHALL update the Access_Request status to "rejected" and record the reviewer email, reviewer name, optional comment, and review timestamp
5. WHEN an Access_Request is approved, THE Portal SHALL trigger the Execution_Engine asynchronously (fire-and-forget)
6. WHEN an Access_Request is reviewed, THE Portal SHALL send an in-app notification to the Requestor with the approval or rejection result
7. IF an Access_Request has already been reviewed (status is not "pending"), THEN THE Portal SHALL return a 409 conflict status

### Requirement 6: Access Grant Execution for Azure AD Platforms

**User Story:** As a system operator, I want approved access requests for AWS, ArgoCD, and SonarQube to be automatically executed by adding the user to the Azure AD group, so that access is granted without manual intervention.

#### Acceptance Criteria

1. WHEN an Access_Request for AWS, ArgoCD, or SonarQube is approved, THE Execution_Engine SHALL resolve the Target_User in Azure AD by calling `GET https://graph.microsoft.com/v1.0/users/{email}`
2. IF the Target_User email uses `@emefinpetcare.com` and is not found, THEN THE Execution_Engine SHALL retry with the equivalent `@iskaypet.com` email (and vice versa) using the Domain_Normalizer
3. WHEN the Target_User is resolved, THE Execution_Engine SHALL add the user to the Azure_AD_Group by calling `POST https://graph.microsoft.com/v1.0/groups/{groupId}/members/$ref` with the user's directory object ID
4. IF the user lookup fails, THEN THE Execution_Engine SHALL update the Access_Request status to "execute_failed" and notify the Requestor
5. IF the group membership addition fails, THEN THE Execution_Engine SHALL update the Access_Request status to "execute_failed" and notify the Requestor
6. WHEN the access grant succeeds, THE Execution_Engine SHALL update the Access_Request status to "executed" with an execution timestamp

### Requirement 7: Access Grant Execution for GitLab

**User Story:** As a system operator, I want approved GitLab access requests to be executed via the GitLab API and an onboarding email sent to the user, so that GitLab access is granted with proper instructions.

#### Acceptance Criteria

1. WHEN an Access_Request for GitLab is approved, THE Execution_Engine SHALL add the Target_User to the specified GitLab group or project with the requested role using the existing `gitlabClient`
2. WHEN the GitLab access grant succeeds, THE Execution_Engine SHALL send an Onboarding_Email to the Target_User via AWS SES using the existing `sendEmail` helper
3. THE Onboarding_Email SHALL contain: login instructions, 2FA setup guide, a link to the GitLab instance, and a support contact
4. THE Onboarding_Email SHALL be sent from `portal@tooling.dp.iskaypet.com` (the existing SES verified domain)
5. IF the GitLab API call fails, THEN THE Execution_Engine SHALL update the Access_Request status to "execute_failed" and notify the Requestor
6. WHEN the GitLab access grant succeeds, THE Execution_Engine SHALL update the Access_Request status to "executed" with an execution timestamp

### Requirement 8: Jira Ticket Creation

**User Story:** As a platform team member, I want a Jira ticket created for every approved access request, so that there is an audit trail of all access grants.

#### Acceptance Criteria

1. WHEN an Access_Request is successfully executed, THE Execution_Engine SHALL create a Jira issue in the SRE project (key "SRE", issue type ID "10048") using the existing `jiraCreateIssue` helper
2. THE Jira issue summary SHALL follow the format: `[Access] Solicitud de acceso a {PLATFORM} para {target_user_email}`
3. THE Jira issue SHALL include the label "AccessRequest"
4. THE Jira issue description SHALL contain: platform name, target user email, group or role name, requestor email, approver email, and execution timestamp
5. IF the Jira issue creation fails, THEN THE Execution_Engine SHALL log the error and continue (non-blocking)

### Requirement 9: Teams Notification

**User Story:** As a platform team member, I want a Teams notification sent for every executed access request, so that the team is informed in real time.

#### Acceptance Criteria

1. WHEN an Access_Request is successfully executed, THE Execution_Engine SHALL send an adaptive card to the Teams webhook URL configured in the `TEAMS_WEBHOOK_URL` environment variable
2. THE Teams adaptive card SHALL display: a title "🔐 Solicitud de Acceso", the platform name, the target user email, the group or role name, the status "✅ Acceso Concedido", and a link to the Jira ticket
3. IF the Teams webhook URL is not configured, THEN THE Execution_Engine SHALL log a warning and skip the notification
4. IF the Teams webhook call fails, THEN THE Execution_Engine SHALL log the error and continue (non-blocking)

### Requirement 10: Domain Migration Support

**User Story:** As a portal user whose email domain has migrated, I want the system to treat `@iskaypet.com` and `@emefinpetcare.com` as equivalent, so that access requests work regardless of which domain my account uses.

#### Acceptance Criteria

1. THE Domain_Normalizer SHALL convert `@emefinpetcare.com` to `@iskaypet.com` for all email comparisons (approver checks, self-approval prevention)
2. WHEN resolving a Target_User in Azure AD, THE Graph_API_Client SHALL attempt lookup with both domain variants if the first lookup fails
3. THE Domain_Normalizer SHALL perform case-insensitive email comparisons

### Requirement 11: Sidebar Navigation Entry

**User Story:** As a portal user, I want to find the access management page in the sidebar, so that I can navigate to it from any page in the portal.

#### Acceptance Criteria

1. THE Portal SHALL add a navigation entry in the "Self-service" section of the sidebar with the label key "nav.accessManagement" and the path "/access-management"
2. THE navigation entry SHALL use the `ShieldCheck` icon from lucide-react
3. THE navigation entry SHALL require a minimum role of "editor"
4. THE navigation entry SHALL appear after the "User Onboarding" entry in the Self-service section

### Requirement 12: API Routes

**User Story:** As a frontend developer, I want well-defined API routes for the access management feature, so that the form and approval flow can interact with the backend.

#### Acceptance Criteria

1. THE Portal SHALL expose `GET /api/access-management/groups?platform={platform}` to return the filtered list of available groups for the selected platform
2. THE Portal SHALL expose `POST /api/access-management/request` to create a new Access_Request
3. THE Portal SHALL expose `POST /api/access-management/[id]/review` to approve or reject an Access_Request
4. THE Portal SHALL expose `POST /api/access-management/execute/[id]` as an internal-only endpoint (protected by `x-internal-secret`) to execute an approved Access_Request
5. WHEN an unauthenticated user calls any access management API endpoint, THE Portal SHALL return a 401 status

### Requirement 13: Database Schema

**User Story:** As a developer, I want a database table to persist access requests, so that the approval flow and execution state are tracked reliably.

#### Acceptance Criteria

1. THE Portal SHALL create an `access_requests` table with columns: id (serial primary key), requestor_email, target_user_email, platform, request_type, group_id (nullable), group_name (nullable), role (nullable, for GitLab), approver_email, status, reviewer_email (nullable), reviewer_name (nullable), review_comment (nullable), reviewed_at (nullable), executed_at (nullable), jira_key (nullable), created_at, and updated_at
2. THE `status` column SHALL accept values: "pending", "approved", "rejected", "executed", "execute_failed"
3. THE `platform` column SHALL accept values: "aws", "argocd", "sonarqube", "gitlab"
4. THE `request_type` column SHALL accept values: "grant" (default, add access) and "revoke" (remove license/access)

### Requirement 14: GitLab License Management

**User Story:** As a platform administrator, I want to add and remove GitLab licenses (seats) for users through the portal, so that I can manage GitLab seat usage without manual intervention in the GitLab admin panel.

#### Acceptance Criteria

1. WHEN an Access_Request for GitLab with request type "grant" is approved, THE Execution_Engine SHALL provision a GitLab license (seat) for the Target_User before adding them to the group or project
2. WHEN an Access_Request for GitLab with request type "revoke" is approved, THE Execution_Engine SHALL remove the GitLab license (seat) from the Target_User using the GitLab API
3. WHEN a GitLab license is successfully revoked, THE Execution_Engine SHALL update the Access_Request status to "executed" with an execution timestamp
4. IF the GitLab license provisioning fails, THEN THE Execution_Engine SHALL update the Access_Request status to "execute_failed" and notify the Requestor
5. IF the GitLab license revocation fails, THEN THE Execution_Engine SHALL update the Access_Request status to "execute_failed" and notify the Requestor
6. WHEN a GitLab license is revoked, THE Execution_Engine SHALL create a Jira ticket with the label "AccessRequest" and a summary indicating license removal
7. WHEN a GitLab license is revoked, THE Execution_Engine SHALL send a Teams notification indicating the license was removed
