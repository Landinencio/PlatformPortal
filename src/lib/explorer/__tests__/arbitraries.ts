/**
 * AI Portal Explorer — shared fast-check arbitraries.
 *
 * Feature: ai-portal-explorer
 *
 * Generadores compartidos por los property-based tests del Explorer. Empezamos
 * con el arbitrary base de roles (`arbAppRole`); los módulos posteriores añaden
 * aquí sus generadores (arbInteractionCandidate, arbVisitResult, etc.).
 *
 * _Requirements: 2.2, 6.2_
 */

import * as fc from "fast-check";

import type { AppRole } from "@/lib/rbac";

/** Todos los roles RBAC del portal (espejo de AppRole en src/lib/rbac.ts). */
export const ALL_APP_ROLES: readonly AppRole[] = [
  "admin",
  "directores",
  "managers",
  "staff",
  "desarrolladores",
  "externos",
] as const;

/** Arbitrary base: un AppRole válido cualquiera. */
export const arbAppRole: fc.Arbitrary<AppRole> = fc.constantFrom(...ALL_APP_ROLES);

/* ------------------------------------------------------------------ */
/*  Safety_Guard arbitraries (Properties 2 & 3 — tasks 2.3 / 2.4)      */
/* ------------------------------------------------------------------ */

import type { InteractionCandidate } from "../safety-guard";
import { MUTATION_KEYWORDS } from "../safety-guard";

/** Los kinds de InteractionCandidate, espejo de la union en safety-guard.ts. */
export const ALL_INTERACTION_KINDS: readonly InteractionCandidate["kind"][] = [
  "navigate",
  "read",
  "open-panel",
  "paginate",
  "http",
  "submit-form",
  "click-button",
] as const;

/**
 * Arbitrary de métodos HTTP: incluye los seguros (GET/HEAD) y los no seguros
 * (POST/PUT/PATCH/DELETE/OPTIONS/...) en mayúsculas, minúsculas y con espacios
 * sobrantes para ejercitar la normalización case-insensitive de `isSafeMethod`.
 * Reutilizado por la Property 3 (task 2.4).
 */
export const arbHttpMethod: fc.Arbitrary<string> = fc.oneof(
  // Seguros, variando capitalización y espacios.
  fc.constantFrom("GET", "HEAD", "get", "head", "Get", "Head", " GET ", " head "),
  // No seguros, variando capitalización.
  fc.constantFrom(
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
    "OPTIONS",
    "TRACE",
    "CONNECT",
    "post",
    "put",
    "patch",
    "delete",
    "Post",
    " DELETE ",
  ),
  // Basura arbitraria (debe tratarse como no seguro).
  fc.string({ maxLength: 8 }),
);

/**
 * Fragmento de etiqueta/atributo que SÍ contiene un MUTATION_KEYWORD (en
 * cualquier capitalización y posiblemente rodeado de otro texto), para forzar
 * coincidencias de la Blocklist.
 */
const arbLabelWithMutationKeyword: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...MUTATION_KEYWORDS),
    fc.string({ maxLength: 5 }),
    fc.string({ maxLength: 5 }),
    fc.boolean(),
  )
  .map(([keyword, pre, post, upper]) => {
    const kw = upper ? keyword.toUpperCase() : keyword;
    return `${pre}${kw}${post}`;
  });

/**
 * Fragmento de etiqueta/atributo que NO contiene ningún MUTATION_KEYWORD.
 * Filtramos contra la Blocklist para garantizar que es "limpio".
 */
const arbCleanLabel: fc.Arbitrary<string> = fc
  .constantFrom(
    "open",
    "view",
    "details",
    "next",
    "previous",
    "expand",
    "show more",
    "tab",
    "filter",
    "search",
    "refresh view",
    "",
  )
  .filter((s) => {
    const low = s.toLowerCase();
    return !MUTATION_KEYWORDS.some((kw) => low.includes(kw));
  });

const arbControlAttributes: fc.Arbitrary<Record<string, string> | undefined> = fc.option(
  fc.dictionary(
    fc.constantFrom("type", "aria-label", "data-action", "title", "name"),
    fc.oneof(arbCleanLabel, arbLabelWithMutationKeyword),
    { maxKeys: 3 },
  ),
  { nil: undefined },
);

/**
 * Arbitrary de InteractionCandidate que cubre toda la union de kinds, métodos
 * HTTP seguros y no seguros (mixed case) y etiquetas/atributos que a veces
 * contienen MUTATION_KEYWORDS y a veces no. Reutilizado por las Properties 2 y 3.
 */
export const arbInteractionCandidate: fc.Arbitrary<InteractionCandidate> = fc.record(
  {
    kind: fc.constantFrom(...ALL_INTERACTION_KINDS),
    httpMethod: fc.option(arbHttpMethod, { nil: undefined }),
    controlLabel: fc.option(fc.oneof(arbCleanLabel, arbLabelWithMutationKeyword), {
      nil: undefined,
    }),
    controlAttributes: arbControlAttributes,
  },
  { requiredKeys: ["kind"] },
) as fc.Arbitrary<InteractionCandidate>;
