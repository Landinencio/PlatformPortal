/**
 * Microsoft Graph API client.
 *
 * Uses OAuth2 client credentials flow to authenticate with Azure AD
 * and perform group/user operations via the Graph API v1.0.
 *
 * Required environment variables (materialized by External Secrets from
 * AWS Secrets Manager `dp/tooling/portal_*` into the `portal-env` secret):
 *   - AZURE_AD_TENANT_ID      — Azure AD tenant ID (ConfigMap)
 *   - AZURE_AD_GRAPH_CLIENT_ID     — Graph app client ID (dp/tooling/portal_graph)
 *   - AZURE_AD_GRAPH_CLIENT_SECRET — Graph app client secret (dp/tooling/portal_graph)
 *
 * NOTE: Falls back to AZURE_AD_CLIENT_ID / AZURE_AD_CLIENT_SECRET (NextAuth app) if
 * the dedicated Graph credentials are not set. The Graph app (iskaypet-automation-n8n)
 * has the required permissions (Directory.Read.All, GroupMember.ReadWrite.All,
 * User.Read.All) for the access-management feature.
 */

import { getAlternateDomainEmail } from "@/lib/access-management/domain-normalizer";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface GraphGroup {
  id: string;
  displayName: string;
  description?: string;
}

export interface GraphUser {
  id: string;
  displayName: string;
  mail: string;
  userPrincipalName: string;
}

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const TOKEN_SCOPE = "https://graph.microsoft.com/.default";
const TOKEN_PRE_EXPIRY_SECONDS = 5 * 60; // refresh 5 minutes before expiry
const MAX_RETRIES = 3;
const INITIAL_BACKOFF_MS = 1000;

/* ------------------------------------------------------------------ */
/*  GraphClient                                                        */
/* ------------------------------------------------------------------ */

export class GraphClient {
  private tokenCache: { token: string; expiresAt: number } | null = null;

  private tenantId: string;
  private clientId: string;
  private clientSecret: string;

  constructor(opts?: {
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
  }) {
    this.tenantId = opts?.tenantId ?? process.env.AZURE_AD_TENANT_ID ?? "";
    this.clientId = opts?.clientId ?? process.env.AZURE_AD_GRAPH_CLIENT_ID ?? process.env.AZURE_AD_CLIENT_ID ?? "";
    this.clientSecret =
      opts?.clientSecret ?? process.env.AZURE_AD_GRAPH_CLIENT_SECRET ?? process.env.AZURE_AD_CLIENT_SECRET ?? "";
  }

  /* ---------------------------------------------------------------- */
  /*  Token acquisition with caching                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Obtain an OAuth2 access token via client credentials grant.
   * Caches the token in memory and refreshes 5 minutes before expiry.
   */
  async getToken(): Promise<string> {
    const now = Date.now();

    if (
      this.tokenCache &&
      this.tokenCache.expiresAt - TOKEN_PRE_EXPIRY_SECONDS * 1000 > now
    ) {
      return this.tokenCache.token;
    }

    const tokenUrl = `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`;

    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      grant_type: "client_credentials",
      scope: TOKEN_SCOPE,
    });

    const res = await fetch(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Graph token request failed (${res.status}): ${text.slice(0, 300)}`
      );
    }

    const data = await res.json();
    const expiresIn: number = data.expires_in ?? 3600;

    this.tokenCache = {
      token: data.access_token,
      expiresAt: now + expiresIn * 1000,
    };

    return this.tokenCache.token;
  }

  /* ---------------------------------------------------------------- */
  /*  Internal fetch with auth + retry on 429                          */
  /* ---------------------------------------------------------------- */

  private async graphFetch(
    url: string,
    options?: RequestInit
  ): Promise<Response> {
    const token = await this.getToken();

    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      lastResponse = await fetch(url, {
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...options?.headers,
        },
      });

      if (lastResponse.status !== 429 || attempt === MAX_RETRIES) {
        return lastResponse;
      }

      // Exponential backoff on 429
      const retryAfter = lastResponse.headers.get("Retry-After");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : INITIAL_BACKOFF_MS * Math.pow(2, attempt);

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    // Should not reach here, but satisfy TypeScript
    return lastResponse!;
  }

  /* ---------------------------------------------------------------- */
  /*  listGroupsByPrefix                                               */
  /* ---------------------------------------------------------------- */

  /**
   * List Azure AD groups whose displayName starts with the given prefix.
   *
   * NOTE: The startsWith filter requires ConsistencyLevel: eventual header
   * and $count=true query parameter for advanced queries in Microsoft Graph.
   */
  async listGroupsByPrefix(prefix: string): Promise<GraphGroup[]> {
    const filter = encodeURIComponent(
      `startsWith(displayName,'${prefix}')`
    );
    const select = "id,displayName,description";
    const url = `${GRAPH_BASE}/groups?$filter=${filter}&$orderby=displayName&$select=${select}&$top=999&$count=true`;

    const token = await this.getToken();

    let lastResponse: Response | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      lastResponse = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ConsistencyLevel: "eventual",
        },
      });

      if (lastResponse.status !== 429 || attempt === MAX_RETRIES) {
        break;
      }

      const retryAfter = lastResponse.headers.get("Retry-After");
      const waitMs = retryAfter
        ? parseInt(retryAfter, 10) * 1000
        : INITIAL_BACKOFF_MS * Math.pow(2, attempt);

      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const res = lastResponse!;

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Graph listGroupsByPrefix failed (${res.status}): ${text.slice(0, 300)}`
      );
    }

    const data = await res.json();
    return (data.value ?? []) as GraphGroup[];
  }

  /* ---------------------------------------------------------------- */
  /*  findUserByEmail                                                  */
  /* ---------------------------------------------------------------- */

  /**
   * Find a user by email. If the first lookup returns 404, retries with
   * the alternate domain email (@iskaypet.com ↔ @emefinpetcare.com).
   */
  async findUserByEmail(email: string): Promise<GraphUser> {
    const url = `${GRAPH_BASE}/users/${encodeURIComponent(email)}`;
    const res = await this.graphFetch(url);

    if (res.ok) {
      return (await res.json()) as GraphUser;
    }

    // If 404, try alternate domain
    if (res.status === 404) {
      const alternate = getAlternateDomainEmail(email);

      if (alternate) {
        const altUrl = `${GRAPH_BASE}/users/${encodeURIComponent(alternate)}`;
        const altRes = await this.graphFetch(altUrl);

        if (altRes.ok) {
          return (await altRes.json()) as GraphUser;
        }

        const altText = await altRes.text().catch(() => "");
        throw new Error(
          `Graph user not found for "${email}" or "${alternate}" (${altRes.status}): ${altText.slice(0, 300)}`
        );
      }

      const text = await res.text().catch(() => "");
      throw new Error(
        `Graph user not found for "${email}" (${res.status}): ${text.slice(0, 300)}`
      );
    }

    const text = await res.text().catch(() => "");
    throw new Error(
      `Graph findUserByEmail failed for "${email}" (${res.status}): ${text.slice(0, 300)}`
    );
  }

  /* ---------------------------------------------------------------- */
  /*  addUserToGroup                                                   */
  /* ---------------------------------------------------------------- */

  /**
   * Add a user to an Azure AD group. Treats "already exists" (400) as success.
   */
  async addUserToGroup(groupId: string, userId: string): Promise<void> {
    const url = `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/members/$ref`;

    const res = await this.graphFetch(url, {
      method: "POST",
      body: JSON.stringify({
        "@odata.id": `${GRAPH_BASE}/directoryObjects/${userId}`,
      }),
    });

    if (res.status === 204 || res.ok) {
      return;
    }

    // Treat "already exists" as success (idempotent)
    if (res.status === 400) {
      const body = await res.text().catch(() => "");
      if (
        body.includes("already exist") ||
        body.includes("One or more added object references already exist")
      ) {
        return;
      }
      throw new Error(
        `Graph addUserToGroup failed (${res.status}): ${body.slice(0, 300)}`
      );
    }

    const text = await res.text().catch(() => "");
    throw new Error(
      `Graph addUserToGroup failed (${res.status}): ${text.slice(0, 300)}`
    );
  }

  /* ---------------------------------------------------------------- */
  /*  removeUserFromGroup                                              */
  /* ---------------------------------------------------------------- */

  /**
   * Remove a user from an Azure AD group. Treats "not found" (404) as success.
   */
  async removeUserFromGroup(groupId: string, userId: string): Promise<void> {
    const url = `${GRAPH_BASE}/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/$ref`;

    const res = await this.graphFetch(url, { method: "DELETE" });

    if (res.status === 204 || res.ok) {
      return;
    }

    // Treat "not found" as success (idempotent — user already removed)
    if (res.status === 404) {
      return;
    }

    const text = await res.text().catch(() => "");
    throw new Error(
      `Graph removeUserFromGroup failed (${res.status}): ${text.slice(0, 300)}`
    );
  }

  /** Clear the cached token (useful for testing) */
  clearTokenCache(): void {
    this.tokenCache = null;
  }
}

/** Default singleton instance (reads env vars) */
export const graphClient = new GraphClient();
