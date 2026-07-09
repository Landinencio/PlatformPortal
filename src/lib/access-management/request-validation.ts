/**
 * Validation logic for access request payloads.
 * Extracted into a separate module for testability without Next.js dependencies.
 */

export const VALID_PLATFORMS = ["aws", "argocd", "sonarqube", "gitlab", "kiro"] as const;
export const VALID_REQUEST_TYPES = ["grant", "revoke", "onboard", "offboard", "kiro-license"] as const;
export const VALID_GITLAB_ROLES = ["guest", "reporter", "developer", "maintainer"] as const;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Platform = (typeof VALID_PLATFORMS)[number];
export type RequestType = (typeof VALID_REQUEST_TYPES)[number];
export type GitLabRole = (typeof VALID_GITLAB_ROLES)[number];

export interface AccessRequestPayload {
  platform: Platform;
  targetUserEmail: string;
  requestType: RequestType;
  groupId?: string;
  groupName?: string;
  role?: string;
  approverEmail: string;
}

/**
 * Validate the access request payload.
 * Returns an error message string if invalid, or null if valid.
 */
export function validateAccessRequestPayload(body: any): string | null {
  if (!body || typeof body !== "object") {
    return "Request body is required";
  }

  const { platform, targetUserEmail, requestType, groupId, groupName, role, approverEmail } = body;

  // Platform validation
  if (!platform || !(VALID_PLATFORMS as readonly string[]).includes(platform)) {
    return `platform must be one of: ${VALID_PLATFORMS.join(", ")}`;
  }

  // Target user email validation
  if (!targetUserEmail || typeof targetUserEmail !== "string") {
    return "targetUserEmail is required";
  }
  // For kiro-license, targetUserEmail can be comma-separated list
  if (requestType !== "kiro-license") {
    if (!EMAIL_REGEX.test(targetUserEmail.trim())) {
      return "targetUserEmail must be a valid email";
    }
  }

  // Request type validation
  if (!requestType || !(VALID_REQUEST_TYPES as readonly string[]).includes(requestType)) {
    return `requestType must be one of: ${VALID_REQUEST_TYPES.join(", ")}`;
  }

  // For "onboard" / "offboard": only targetUserEmail is needed (no group/role)
  if (requestType === "onboard" || requestType === "offboard") {
    // Platform must be gitlab for onboard/offboard
    if (platform !== "gitlab") {
      return "onboard/offboard requests are only supported for GitLab";
    }
    // No additional fields required beyond targetUserEmail (already validated above)
    return null;
  }

  // For "kiro-license": only targetUserEmail (can be comma-separated) and businessTeam needed
  if (requestType === "kiro-license") {
    if (platform !== "kiro") {
      return "kiro-license requests are only supported for the kiro platform";
    }
    return null;
  }

  // For "grant": groupId and groupName are required
  if (requestType === "grant") {
    if (!groupId || typeof groupId !== "string") {
      return "groupId is required for grant requests";
    }
    if (!groupName || typeof groupName !== "string") {
      return "groupName is required for grant requests";
    }
    // For GitLab grant: role is also required
    if (platform === "gitlab") {
      if (!role || !(VALID_GITLAB_ROLES as readonly string[]).includes(role)) {
        return `role must be one of: ${VALID_GITLAB_ROLES.join(", ")} for GitLab grant requests`;
      }
    }
  }

  // Approver email validation (optional — auto-approved by manager)
  // No longer required since managers execute directly without approval

  return null;
}
