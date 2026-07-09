// Feature: ai-portal-explorer, Property 2: El Safety_Guard solo permite interacciones de solo lectura (default-deny)
/**
 * Property-based test for the Safety_Guard Allowlist (default-deny).
 *
 * Feature: ai-portal-explorer — src/lib/explorer/safety-guard.ts
 *
 * Property 2: El Safety_Guard solo permite interacciones de solo lectura
 *   (default-deny). `evaluateInteraction` permite una interacción SI Y SOLO SI:
 *     - su `kind` es de solo lectura (`navigate` | `read` | `open-panel` |
 *       `paginate`), O
 *     - su `kind` es `http` Y su `httpMethod` es un método seguro (GET/HEAD,
 *       case-insensitive).
 *   Cualquier otra interacción se BLOQUEA con un motivo no vacío:
 *     - `submit-form` SIEMPRE (envío de formulario = mutación, Req 1.7).
 *     - `click-button` SIEMPRE (fuera de la Allowlist), con motivo específico si
 *       su etiqueta/atributos casan con MUTATION_KEYWORDS.
 *     - `http` con método no seguro (POST/PUT/PATCH/DELETE/…) SIEMPRE.
 *   Es decir, NUNCA se permite una mutación (default-deny, Req 1.8).
 *
 * **Validates: Requirements 1.3, 1.4, 1.7, 1.8**
 *
 * Run: TSX_TSCONFIG_PATH=tsconfig.test.json npx tsx --test \
 *   src/lib/explorer/__tests__/safety-guard.prop02.property.test.ts
 */

import test from "node:test";
import assert from "node:assert/strict";
import * as fc from "fast-check";

import { evaluateInteraction, isSafeMethod } from "../safety-guard";
import type { InteractionCandidate } from "../safety-guard";
import { arbInteractionCandidate } from "./arbitraries";

/* ------------------------------------------------------------------ */
/*  Independent oracle (mirrors the spec, not the implementation)      */
/* ------------------------------------------------------------------ */

const READ_ONLY_KINDS: ReadonlySet<InteractionCandidate["kind"]> = new Set([
  "navigate",
  "read",
  "open-panel",
  "paginate",
]);

/**
 * Oráculo de la Allowlist según la especificación (Property 2):
 * allowed === true IFF (kind ∈ read-only) OR (kind === "http" AND método seguro).
 */
function shouldAllow(candidate: InteractionCandidate): boolean {
  if (READ_ONLY_KINDS.has(candidate.kind)) return true;
  if (candidate.kind === "http") return isSafeMethod(candidate.httpMethod ?? "");
  return false;
}

/* ------------------------------------------------------------------ */
/*  Property 2                                                         */
/* ------------------------------------------------------------------ */

test("Property 2: evaluateInteraction allows read-only interactions IFF in the Allowlist", () => {
  fc.assert(
    fc.property(arbInteractionCandidate, (candidate) => {
      const decision = evaluateInteraction(candidate);
      const expected = shouldAllow(candidate);

      // Equivalencia exacta con el oráculo de la Allowlist (IFF).
      assert.equal(
        decision.allowed,
        expected,
        `kind=${candidate.kind} method=${candidate.httpMethod ?? "(none)"} ` +
          `label=${candidate.controlLabel ?? "(none)"} → allowed=${decision.allowed}, expected=${expected}`,
      );

      // El motivo nunca es vacío (trazabilidad de la decisión).
      assert.ok(decision.reason.length > 0, "la decisión debe llevar un motivo no vacío");

      // Las mutaciones NUNCA se permiten (default-deny innegociable).
      if (candidate.kind === "submit-form") {
        assert.equal(decision.allowed, false, "submit-form debe bloquearse siempre");
      }
      if (candidate.kind === "click-button") {
        assert.equal(decision.allowed, false, "click-button debe bloquearse siempre");
      }
      if (candidate.kind === "http" && !isSafeMethod(candidate.httpMethod ?? "")) {
        assert.equal(decision.allowed, false, "http con método no seguro debe bloquearse");
      }
    }),
    { numRuns: 100 },
  );
});

/* ------------------------------------------------------------------ */
/*  Directed examples                                                  */
/* ------------------------------------------------------------------ */

test("Property 2 (example): read-only kinds are allowed", () => {
  for (const kind of ["navigate", "read", "open-panel", "paginate"] as const) {
    const d = evaluateInteraction({ kind });
    assert.equal(d.allowed, true, `${kind} debe permitirse`);
  }
});

test("Property 2 (example): http GET/HEAD allowed, mutating methods blocked", () => {
  assert.equal(evaluateInteraction({ kind: "http", httpMethod: "GET" }).allowed, true);
  assert.equal(evaluateInteraction({ kind: "http", httpMethod: "head" }).allowed, true);
  assert.equal(evaluateInteraction({ kind: "http", httpMethod: " Get " }).allowed, true);
  assert.equal(evaluateInteraction({ kind: "http", httpMethod: "POST" }).allowed, false);
  assert.equal(evaluateInteraction({ kind: "http", httpMethod: "DELETE" }).allowed, false);
  assert.equal(evaluateInteraction({ kind: "http" }).allowed, false); // sin método
});

test("Property 2 (example): submit-form and click-button are always blocked", () => {
  assert.equal(evaluateInteraction({ kind: "submit-form" }).allowed, false);
  // click-button con keyword de mutación → motivo específico.
  const approve = evaluateInteraction({ kind: "click-button", controlLabel: "Approve request" });
  assert.equal(approve.allowed, false);
  assert.match(approve.reason, /mutation keyword/);
  // click-button "limpio" → bloqueado igualmente (default-deny).
  const view = evaluateInteraction({ kind: "click-button", controlLabel: "View details" });
  assert.equal(view.allowed, false);
});
