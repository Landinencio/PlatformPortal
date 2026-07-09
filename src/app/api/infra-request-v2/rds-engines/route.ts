// GET /api/infra-request-v2/rds-engines
//
// Feature: infra-self-service-hardening — task 11.1
//
// Minimal read-only proxy that exposes the Catalogo_Dinamico
// (`listRdsEngineOptions()` in `src/lib/rds/aws-engine-catalog.ts`) to the
// Formulario_V2 so it can render the `stale` notice on the version selector
// (Req 1.9). The route deliberately mirrors only what the client needs:
//   - engine (whitelisted by `aws-engine-catalog.ENABLED_ENGINES`)
//   - region defaults to `eu-west-1` (design § "AWS_Region_Destino")
//
// The AWS call, IRSA credentials, cache/stale/fallback semantics live entirely
// in `aws-engine-catalog.ts`; this handler just serialises the result and
// keeps the surface small (no query composition, no cross-cutting concerns).
//
// Contract:
//   Query params:
//     - engine (string, required) — currently only `postgres` (Req 1.11)
//
//   Responses:
//     200 { ok: true, options: EngineOption[] }
//     400 { code: "missing_parameter" }
//     401                                        (unauthenticated)
//     404 { code: "route_disabled" }             (feature flag off)
//     422 { code: "engine_not_supported" }
//     502 { code: "catalog_unavailable" }
//     502 { code: "credentials_unavailable" }
//
// Notes:
//   - Gated behind ENABLE_INFRA_HARDENING_V1 (default `false`); when disabled
//     the route responds 404 so the endpoint is effectively hidden and the
//     Formulario_V2 falls back to the static catalog silently.
//   - `EngineOption` already whitelists fields to `{version, family,
//     deprecated, defaultForEngine, stale?, staleSince?}` (Req 8.5), so this
//     handler returns the array verbatim.

import { NextResponse } from "next/server";
import { requireUserAuth } from "@/lib/api-auth";
import {
  listRdsEngineOptions,
  ENABLED_ENGINES,
} from "@/lib/rds/aws-engine-catalog";
import { ENABLE_INFRA_HARDENING_V1 } from "@/lib/feature-flags";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** Region fixed by the design (AWS_Region_Destino, `.kiro/specs/.../design.md`). */
const DEFAULT_REGION = "eu-west-1";

export async function GET(request: Request) {
  // Feature-flag gate — flag off keeps the route hidden and the form falls
  // back to the static `version-catalog.ts` without any UI change (Req 7.3).
  if (!ENABLE_INFRA_HARDENING_V1) {
    return NextResponse.json({ code: "route_disabled" }, { status: 404 });
  }

  const auth = await requireUserAuth(request);
  if (auth.error) return auth.error;

  const url = new URL(request.url);
  const engine = url.searchParams.get("engine")?.trim() ?? "";

  if (!engine) {
    return NextResponse.json({ code: "missing_parameter" }, { status: 400 });
  }

  // Fast reject before reaching the AWS SDK — mirrors Req 1.11 semantics.
  if (!ENABLED_ENGINES.includes(engine)) {
    return NextResponse.json(
      { code: "engine_not_supported", engine },
      { status: 422 },
    );
  }

  const result = await listRdsEngineOptions(engine, DEFAULT_REGION);
  if (!result.ok) {
    // 502 signals an upstream (AWS) failure without a valid fallback; the UI
    // will silently fall back to the static catalog (no version list shown
    // from the API path).
    return NextResponse.json(result.error, { status: 502 });
  }

  return NextResponse.json(
    { ok: true, options: result.options },
    { status: 200 },
  );
}
