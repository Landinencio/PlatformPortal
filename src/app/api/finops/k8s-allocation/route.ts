/**
 * GET /api/finops/k8s-allocation — legacy alias (deprecated).
 *
 * Fase 3 cutover del spec `eks-cost-optimization`: este endpoint sigue
 * sirviendo el contrato `K8sFinOpsSummary` durante dos releases para no
 * romper consumidores externos (dashboards guardados, scripts internos).
 * Bajo el capó ya NO consulta el pipeline OpenCost original: llama al
 * nuevo `fetchEksCostSummary` y lo re-modela con `legacyAdapter` para
 * preservar la forma antigua.
 *
 * El sucesor canónico es `GET /api/finops/k8s-cost` — se anuncia vía
 * cabeceras `Deprecation: true` + `Link: …; rel="successor-version"`
 * (Requirements 7.1, 7.2, 7.3). Cada llamada emite además una traza
 * `[k8s-allocation] legacy call from <email>` (Requirement 7.4) para poder
 * decidir cuándo retirarlo definitivamente.
 *
 * See:
 *   - `.kiro/specs/eks-cost-optimization/design.md`
 *     §Backend > `/api/finops/k8s-allocation` legacy
 *   - `.kiro/specs/eks-cost-optimization/tasks.md` §Fase 3 > task 15.3
 */

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { getSessionRole, hasMinimumRole } from "@/lib/session-role";
import { cached } from "@/lib/cache";
import { fetchEksCostSummary } from "@/lib/eks-cost";
import { legacyAdapter } from "@/lib/eks-cost/legacy-adapter";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Deprecation headers advertised on every response — success or error.
 * `Deprecation: true` is the boolean form defined by RFC 8594 (draft) and
 * `Link` with `rel="successor-version"` points consumers to the new
 * endpoint per RFC 5988.
 */
const DEPRECATION_HEADERS = {
  Deprecation: "true",
  Link: '</api/finops/k8s-cost>; rel="successor-version"',
} as const;

export async function GET() {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) {
      return NextResponse.json(
        { error: "Authentication required" },
        { status: 401, headers: DEPRECATION_HEADERS },
      );
    }
    const role = getSessionRole(session);
    if (!hasMinimumRole(role, "desarrolladores")) {
      return NextResponse.json(
        { error: "Editor access required" },
        { status: 403, headers: DEPRECATION_HEADERS },
      );
    }

    // Legacy usage telemetry (Requirement 7.4): logueado en cada llamada
    // autenticada para poder decidir cuándo retirar el alias definitivamente.
    console.info("[k8s-allocation] legacy call from", session.user.email);

    const summary = await cached(
      "finops-k8s-allocation",
      async () => legacyAdapter(await fetchEksCostSummary({})),
      CACHE_TTL_MS,
    );
    return NextResponse.json(summary, { headers: DEPRECATION_HEADERS });
  } catch (error: any) {
    console.error("[k8s-allocation] error:", error);
    return NextResponse.json(
      { error: error?.message || "Failed to fetch k8s allocation" },
      { status: 500, headers: DEPRECATION_HEADERS },
    );
  }
}
