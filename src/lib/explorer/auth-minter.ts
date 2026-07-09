/**
 * AI Portal Explorer — Auth_Minter.
 *
 * Feature: ai-portal-explorer
 *
 * Acuña sesiones sintéticas (cookies NextAuth/JWE) válidas para cada Role RBAC
 * sin pasar por el login OIDC real (Azure AD + MFA). Reutiliza el MISMO `encode`
 * de `next-auth/jwt` con `NEXTAUTH_SECRET`, replicando los claims que produce el
 * callback `jwt()` de `src/lib/auth.ts` (`appRole`, `roles`, `oid`), de modo que
 * el JWE round-trips con el `decode`/`getToken` que usan `middleware.ts` y
 * `api-auth.ts`.
 *
 * Estrictamente de solo lectura: la identidad es sintética (email reservado
 * `explorer+<role>@synthetic.invalid`, claim `synthetic: true`) y no corresponde
 * a ninguna persona real.
 *
 * _Requirements: 2.1, 2.2, 2.4, 2.5_
 */

import { encode } from "next-auth/jwt";

import type { AppRole } from "@/lib/rbac";

/**
 * Vida de la sesión sintética, alineada con `authOptions.session.maxAge` /
 * `authOptions.jwt.maxAge` de `src/lib/auth.ts` (30 minutos).
 */
const SESSION_MAX_AGE_SECONDS = 30 * 60;

/** Cookie de sesión NextAuth en entornos HTTPS (default del portal). */
const SECURE_COOKIE_NAME = "__Secure-next-auth.session-token";

/** Cookie de sesión NextAuth en entornos HTTP. */
const INSECURE_COOKIE_NAME = "next-auth.session-token";

/** Una sesión de usuario sintética materializada como cookie NextAuth (JWE). */
export interface SyntheticSession {
  role: AppRole;
  cookieName: string; // next-auth.session-token / __Secure-next-auth.session-token
  cookieValue: string; // JWE cifrado con NEXTAUTH_SECRET
  synthetic: true; // marca de identidad sintética (Req 2.4)
}

/**
 * True si el entorno puede acuñar sesiones, es decir, si `NEXTAUTH_SECRET` está
 * presente. Sin el secreto no es posible cifrar un JWE que el portal pueda
 * descifrar, por lo que el Explorer debe omitir el Role. (Req 2.5)
 */
export function canMintSessions(): boolean {
  return Boolean(process.env.NEXTAUTH_SECRET);
}

/**
 * Decide el nombre de cookie de NextAuth según el entorno. NextAuth usa el
 * prefijo `__Secure-` cuando opera sobre HTTPS (default del portal-dev/prod) y
 * el nombre sin prefijo sobre HTTP. Se deriva de `NEXTAUTH_URL`; por defecto se
 * asume HTTPS (el caso del portal).
 */
function resolveCookieName(): string {
  const nextAuthUrl = process.env.NEXTAUTH_URL;
  if (nextAuthUrl && nextAuthUrl.startsWith("http://")) {
    return INSECURE_COOKIE_NAME;
  }
  return SECURE_COOKIE_NAME;
}

/**
 * Construye los claims sintéticos para un Role (identidad no-real). Replica los
 * claims que el callback `jwt()` de `src/lib/auth.ts` deja en el token:
 *  - `roles`: array de roles Azure (el propio Role; `ROLE_ALIASES` lo mapea 1:1)
 *  - `appRole`: el Role resuelto
 *  - `oid`: object id (sintético)
 * más la identidad reservada (`name`/`email`/`sub`) y la marca `synthetic: true`.
 *
 * No incluye `iat`/`exp`/`jti`: `encode` los añade automáticamente.
 */
export function buildSyntheticClaims(role: AppRole): Record<string, unknown> {
  const email = `explorer+${role}@synthetic.invalid`;
  return {
    name: `Portal Explorer (${role})`,
    email,
    sub: `synthetic-explorer-${role}`,
    // Claims del callback jwt() de src/lib/auth.ts:
    roles: [role],
    appRole: role,
    oid: `synthetic-oid-${role}`,
    // Marca de identidad sintética, no correspondiente a una persona real (Req 2.4):
    synthetic: true,
  };
}

/**
 * Acuña una cookie de sesión NextAuth (JWE) válida para un Role, sin login OIDC.
 * Usa el mismo `encode` de `next-auth/jwt` con `NEXTAUTH_SECRET`, replicando los
 * claims que produce el callback `jwt()` de `src/lib/auth.ts`. (Req 2.1, 2.2, 2.4)
 *
 * @throws si `NEXTAUTH_SECRET` no está presente. El llamante debe comprobar
 *   `canMintSessions()` antes y omitir el Role en caso contrario. (Req 2.5)
 */
export async function mintSyntheticSession(role: AppRole): Promise<SyntheticSession> {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new Error(
      "NEXTAUTH_SECRET no está presente: no se puede acuñar una Synthetic_Session",
    );
  }

  const token = buildSyntheticClaims(role);

  const cookieValue = await encode({
    token,
    secret,
    maxAge: SESSION_MAX_AGE_SECONDS,
  });

  return {
    role,
    cookieName: resolveCookieName(),
    cookieValue,
    synthetic: true,
  };
}
