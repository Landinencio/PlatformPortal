/**
 * Unit tests for Microsoft Graph API client.
 *
 * Uses node:test with mocked global fetch to test:
 * - Token acquisition and caching
 * - User lookup with domain fallback
 * - Group listing
 * - Add user to group (idempotent)
 * - Error handling (rate limiting, failures)
 */

import test from "node:test";
import assert from "node:assert/strict";

import { GraphClient } from "../../src/lib/graph-client";
import type { GraphUser, GraphGroup } from "../../src/lib/graph-client";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Minimal Headers-like object for Node 16 (no global Headers) */
class FakeHeaders {
  private map: Record<string, string>;
  constructor(init?: Record<string, string>) {
    this.map = {};
    if (init) {
      for (const [k, v] of Object.entries(init)) {
        this.map[k.toLowerCase()] = v;
      }
    }
  }
  get(name: string): string | null {
    return this.map[name.toLowerCase()] ?? null;
  }
}

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new FakeHeaders(headers),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function tokenResponse(accessToken = "test-token", expiresIn = 3600) {
  return jsonResponse({ access_token: accessToken, expires_in: expiresIn });
}

/** Helper to assert a promise rejects with a message containing the given substring */
async function assertRejectsWithMessage(
  fn: () => Promise<unknown>,
  substring: string
) {
  try {
    await fn();
    assert.fail(`Expected rejection containing "${substring}" but resolved`);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes("Expected rejection")) {
      throw err;
    }
    assert.ok(
      err instanceof Error,
      `Expected Error instance, got ${typeof err}`
    );
    assert.ok(
      err.message.includes(substring),
      `Expected message to include "${substring}", got: "${err.message}"`
    );
  }
}

const TEST_USER: GraphUser = {
  id: "user-id-123",
  displayName: "Test User",
  mail: "test@iskaypet.com",
  userPrincipalName: "test@iskaypet.com",
};

const TEST_GROUPS: GraphGroup[] = [
  { id: "g1", displayName: "AWS-Dev", description: "Dev group" },
  { id: "g2", displayName: "AWS-Prod", description: "Prod group" },
];

/** Save original global fetch */
const originalFetch = globalThis.fetch;

function withMockedFetch(
  impl: (url: string, init?: RequestInit) => Promise<Response>
): { client: GraphClient; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const client = new GraphClient({
    tenantId: "test-tenant",
    clientId: "test-client-id",
    clientSecret: "test-client-secret",
  });

  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as any).url;
    calls.push({ url, init });
    return impl(url, init);
  }) as typeof globalThis.fetch;

  return { client, calls };
}

function restoreFetch() {
  globalThis.fetch = originalFetch;
}

/* ------------------------------------------------------------------ */
/*  Token acquisition                                                  */
/* ------------------------------------------------------------------ */

test("getToken: acquires token via client credentials POST", async () => {
  const { client, calls } = withMockedFetch(async (url, init) => {
    if (url.includes("oauth2/v2.0/token")) {
      const body = init?.body?.toString() ?? "";
      assert.ok(body.includes("client_id=test-client-id"));
      assert.ok(body.includes("client_secret=test-client-secret"));
      assert.ok(body.includes("grant_type=client_credentials"));
      assert.ok(
        body.includes("scope=https%3A%2F%2Fgraph.microsoft.com%2F.default")
      );
      return tokenResponse("my-access-token", 3600);
    }
    return jsonResponse({}, 404);
  });

  try {
    const token = await client.getToken();
    assert.equal(token, "my-access-token");
    assert.equal(calls.length, 1);
  } finally {
    restoreFetch();
  }
});

test("getToken: uses correct token endpoint URL with tenant", async () => {
  const { client } = withMockedFetch(async (url) => {
    assert.ok(
      url.includes(
        "login.microsoftonline.com/test-tenant/oauth2/v2.0/token"
      ),
      `Expected tenant in URL, got: ${url}`
    );
    return tokenResponse();
  });

  try {
    await client.getToken();
  } finally {
    restoreFetch();
  }
});

test("getToken: caches token and reuses on subsequent calls", async () => {
  const { client, calls } = withMockedFetch(async () =>
    tokenResponse("cached-token", 3600)
  );

  try {
    const token1 = await client.getToken();
    const token2 = await client.getToken();

    assert.equal(token1, "cached-token");
    assert.equal(token2, "cached-token");
    // Only one fetch call — second call used cache
    assert.equal(calls.length, 1);
  } finally {
    restoreFetch();
  }
});

test("getToken: refreshes token when within 5-minute pre-expiry window", async () => {
  let callCount = 0;
  const { client } = withMockedFetch(async () => {
    callCount++;
    if (callCount === 1) {
      // Return a token that expires in 4 minutes (within the 5-min pre-expiry window)
      return tokenResponse("old-token", 240);
    }
    return tokenResponse("new-token", 3600);
  });

  try {
    const token1 = await client.getToken();
    assert.equal(token1, "old-token");

    // Second call should refresh because 240s < 300s pre-expiry buffer
    const token2 = await client.getToken();
    assert.equal(token2, "new-token");
    assert.equal(callCount, 2);
  } finally {
    restoreFetch();
  }
});

test("getToken: throws on failed token request", async () => {
  const { client } = withMockedFetch(async () =>
    jsonResponse({ error: "invalid_client" }, 401)
  );

  try {
    await assertRejectsWithMessage(
      () => client.getToken(),
      "401"
    );
  } finally {
    restoreFetch();
  }
});

test("getToken: does not cache failed tokens", async () => {
  let callCount = 0;
  const { client } = withMockedFetch(async () => {
    callCount++;
    if (callCount === 1) {
      return jsonResponse({ error: "invalid_client" }, 401);
    }
    return tokenResponse("recovered-token", 3600);
  });

  try {
    // First call fails
    await assertRejectsWithMessage(() => client.getToken(), "401");

    // Second call should try again (not use cached failure)
    const token = await client.getToken();
    assert.equal(token, "recovered-token");
    assert.equal(callCount, 2);
  } finally {
    restoreFetch();
  }
});

/* ------------------------------------------------------------------ */
/*  listGroupsByPrefix                                                 */
/* ------------------------------------------------------------------ */

test("listGroupsByPrefix: returns groups matching prefix", async () => {
  const { client } = withMockedFetch(async (url) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    if (url.includes("/groups")) {
      assert.ok(
        url.includes("startsWith(displayName"),
        `Expected filter in URL: ${url}`
      );
      assert.ok(url.includes("$select=id,displayName,description"));
      assert.ok(url.includes("$top=999"));
      return jsonResponse({ value: TEST_GROUPS });
    }
    return jsonResponse({}, 404);
  });

  try {
    const groups = await client.listGroupsByPrefix("AWS-");
    assert.equal(groups.length, 2);
    assert.equal(groups[0].displayName, "AWS-Dev");
    assert.equal(groups[1].displayName, "AWS-Prod");
  } finally {
    restoreFetch();
  }
});

test("listGroupsByPrefix: throws on API error", async () => {
  const { client } = withMockedFetch(async (url) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    return jsonResponse({ error: "Forbidden" }, 403);
  });

  try {
    await assertRejectsWithMessage(
      () => client.listGroupsByPrefix("AWS-"),
      "403"
    );
  } finally {
    restoreFetch();
  }
});

/* ------------------------------------------------------------------ */
/*  findUserByEmail                                                    */
/* ------------------------------------------------------------------ */

test("findUserByEmail: returns user on successful lookup", async () => {
  const { client } = withMockedFetch(async (url) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    if (url.includes("/users/")) return jsonResponse(TEST_USER);
    return jsonResponse({}, 404);
  });

  try {
    const user = await client.findUserByEmail("test@iskaypet.com");
    assert.equal(user.id, "user-id-123");
    assert.equal(user.displayName, "Test User");
  } finally {
    restoreFetch();
  }
});

test("findUserByEmail: retries with alternate domain on 404 for @emefinpetcare.com", async () => {
  const userCalls: string[] = [];

  const { client } = withMockedFetch(async (url) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    if (url.includes("/users/")) {
      userCalls.push(url);
      // First call with emefinpetcare → 404
      if (url.includes("emefinpetcare")) {
        return jsonResponse(
          { error: { code: "Request_ResourceNotFound" } },
          404
        );
      }
      // Second call with iskaypet → success
      return jsonResponse(TEST_USER);
    }
    return jsonResponse({}, 404);
  });

  try {
    const user = await client.findUserByEmail("test@emefinpetcare.com");
    assert.equal(user.id, "user-id-123");
    assert.equal(userCalls.length, 2);
    assert.ok(userCalls[0].includes("emefinpetcare"));
    assert.ok(userCalls[1].includes("iskaypet"));
  } finally {
    restoreFetch();
  }
});

test("findUserByEmail: retries with alternate domain on 404 for @iskaypet.com", async () => {
  const userCalls: string[] = [];

  const { client } = withMockedFetch(async (url) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    if (url.includes("/users/")) {
      userCalls.push(url);
      // First call with iskaypet → 404
      if (url.includes("iskaypet")) {
        return jsonResponse(
          { error: { code: "Request_ResourceNotFound" } },
          404
        );
      }
      // Second call with emefinpetcare → success
      return jsonResponse(TEST_USER);
    }
    return jsonResponse({}, 404);
  });

  try {
    const user = await client.findUserByEmail("test@iskaypet.com");
    assert.equal(user.id, "user-id-123");
    assert.equal(userCalls.length, 2);
    assert.ok(userCalls[0].includes("iskaypet"));
    assert.ok(userCalls[1].includes("emefinpetcare"));
  } finally {
    restoreFetch();
  }
});

test("findUserByEmail: throws when both domains return 404", async () => {
  const { client } = withMockedFetch(async (url) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    return jsonResponse(
      { error: { code: "Request_ResourceNotFound" } },
      404
    );
  });

  try {
    await assertRejectsWithMessage(
      () => client.findUserByEmail("test@iskaypet.com"),
      "not found"
    );
  } finally {
    restoreFetch();
  }
});

test("findUserByEmail: does not retry for non-known domains on 404", async () => {
  let userCallCount = 0;

  const { client } = withMockedFetch(async (url) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    if (url.includes("/users/")) {
      userCallCount++;
      return jsonResponse(
        { error: { code: "Request_ResourceNotFound" } },
        404
      );
    }
    return jsonResponse({}, 404);
  });

  try {
    await assertRejectsWithMessage(
      () => client.findUserByEmail("test@gmail.com"),
      "not found"
    );

    // Only one call — no fallback for non-known domains
    assert.equal(userCallCount, 1);
  } finally {
    restoreFetch();
  }
});

test("findUserByEmail: throws on non-404 errors", async () => {
  const { client } = withMockedFetch(async (url) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    return jsonResponse({ error: "Forbidden" }, 403);
  });

  try {
    await assertRejectsWithMessage(
      () => client.findUserByEmail("test@iskaypet.com"),
      "403"
    );
  } finally {
    restoreFetch();
  }
});

/* ------------------------------------------------------------------ */
/*  addUserToGroup                                                     */
/* ------------------------------------------------------------------ */

test("addUserToGroup: succeeds on 204 response", async () => {
  const { client } = withMockedFetch(async (url, init) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    if (url.includes("/members/$ref")) {
      assert.equal(init?.method, "POST");
      const body = JSON.parse(init?.body as string);
      assert.ok(body["@odata.id"].includes("directoryObjects/user-123"));
      return jsonResponse(null, 204);
    }
    return jsonResponse({}, 404);
  });

  try {
    // Should not throw
    await client.addUserToGroup("group-abc", "user-123");
  } finally {
    restoreFetch();
  }
});

test("addUserToGroup: treats 'already exists' 400 as success (idempotent)", async () => {
  const { client } = withMockedFetch(async (url) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    if (url.includes("/members/$ref")) {
      return jsonResponse(
        {
          error: {
            code: "Request_BadRequest",
            message:
              "One or more added object references already exist for the following modified properties: 'members'.",
          },
        },
        400
      );
    }
    return jsonResponse({}, 404);
  });

  try {
    // Should not throw — already exists is treated as success
    await client.addUserToGroup("group-abc", "user-123");
  } finally {
    restoreFetch();
  }
});

test("addUserToGroup: throws on non-idempotent 400 error", async () => {
  const { client } = withMockedFetch(async (url) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    return jsonResponse(
      { error: { code: "Request_BadRequest", message: "Invalid object" } },
      400
    );
  });

  try {
    await assertRejectsWithMessage(
      () => client.addUserToGroup("group-abc", "user-123"),
      "400"
    );
  } finally {
    restoreFetch();
  }
});

test("addUserToGroup: throws on 404 (group not found)", async () => {
  const { client } = withMockedFetch(async (url) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    return jsonResponse(
      { error: { code: "Request_ResourceNotFound" } },
      404
    );
  });

  try {
    await assertRejectsWithMessage(
      () => client.addUserToGroup("nonexistent-group", "user-123"),
      "404"
    );
  } finally {
    restoreFetch();
  }
});

/* ------------------------------------------------------------------ */
/*  Rate limiting (429 retry)                                          */
/* ------------------------------------------------------------------ */

test("graphFetch: retries on 429 with exponential backoff", async () => {
  let groupCallCount = 0;

  const { client } = withMockedFetch(async (url) => {
    if (url.includes("oauth2/v2.0/token")) return tokenResponse();
    if (url.includes("/groups")) {
      groupCallCount++;
      if (groupCallCount <= 2) {
        return jsonResponse({ error: "Too Many Requests" }, 429);
      }
      return jsonResponse({ value: TEST_GROUPS });
    }
    return jsonResponse({}, 404);
  });

  try {
    const groups = await client.listGroupsByPrefix("AWS-");
    assert.equal(groups.length, 2);
    // 2 retries + 1 success = 3 group calls
    assert.equal(groupCallCount, 3);
  } finally {
    restoreFetch();
  }
});
