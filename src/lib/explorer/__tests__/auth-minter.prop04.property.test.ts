// Feature: ai-portal-explorer, Property 4: Las sesiones sintéticas round-trip al rol pedido y se marcan sintéticas
/**
 * Property-based test for the Auth_Minter.
 *
 * Feature: ai-portal-explorer — src/lib/explorer/auth-minter.ts
 *
 * Property 4: Las sesiones sintéticas round-trip al rol pedido y se marcan sintéticas.
 *   - Para CUALQUIER Role, `mintSyntheticSession(role)` produce una cookie JWE
 *     cifrada con `NEXTAUTH_SECRET` que, al decodificarse con el MISMO `decode`
 *     de `next-auth/jwt` (el que usan `middleware.ts` / `api-auth.ts`), recupera
 *     unos claims que ROUND-TRIP al Role pedido:
 *       · `appRole === role`
 *       · `roles` incluye `role`
 *       · `synthetic === true` (identidad sintética, no real — Req 2.4)
 *       · `email === explorer+<role>@synthetic.invalid` (identidad reservada)
 *   - `canMintSessions()` es true cuando `NEXTAUTH_SECRET` está presente.
 *
 * **Validates: Requirements 2.1, 2.2, 2.4**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/auth-minter.prop04.property.test.ts
 */

// El Auth_Minter lee NEXTAUTH_SECRET en tiempo de llamada (no de import), pero lo
// fijamos antes de cualquier uso para que el minting/decoding funcione en el test.
process.env.NEXTAUTH_SECRET =
  process.env.NEXTAUTH_SECRET ?? "test-nextauth-secret-ai-portal-explorer-prop04";

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";
import { decode } from "next-auth/jwt";

import { mintSyntheticSession, canMintSessions } from "../auth-minter";
import { arbAppRole } from "./arbitraries";

const SECRET = process.env.NEXTAUTH_SECRET as string;

/* ------------------------------------------------------------------ */
/*  Property 4                                                         */
/* ------------------------------------------------------------------ */

test("Property 4: synthetic sessions round-trip to the requested role and are marked synthetic", async () => {
  // Precondición del entorno: con NEXTAUTH_SECRET presente, se puede acuñar.
  assert.equal(canMintSessions(), true);

  await fc.assert(
    fc.asyncProperty(arbAppRole, async (role) => {
      const session = await mintSyntheticSession(role);

      // La sesión declara el Role pedido y se marca sintética en su superficie.
      assert.equal(session.role, role);
      assert.equal(session.synthetic, true);
      assert.ok(session.cookieValue.length > 0);

      // Decodificar el JWE con el MISMO decode de next-auth/jwt (el del portal).
      const claims = await decode({ token: session.cookieValue, secret: SECRET });
      assert.ok(claims, "el JWE acuñado debe decodificarse con NEXTAUTH_SECRET");

      // Round-trip al Role pedido.
      assert.equal(claims!.appRole, role);
      assert.ok(
        Array.isArray(claims!.roles) && (claims!.roles as unknown[]).includes(role),
        `roles debe incluir ${role}`,
      );

      // Identidad sintética reservada (no corresponde a persona real — Req 2.4).
      assert.equal(claims!.synthetic, true);
      assert.equal(claims!.email, `explorer+${role}@synthetic.invalid`);
    }),
    { numRuns: 100 },
  );
});
