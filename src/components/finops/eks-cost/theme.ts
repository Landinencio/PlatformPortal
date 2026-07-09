/**
 * Shared visual language for the EKS Cost Optimization dashboard.
 *
 * Centralises the palette, gradient definitions and small helpers so every
 * chart / KPI card renders with the same colours and depth. The dashboard
 * lives inside the FinOps section, so we reuse the portal's semantic HSL
 * tokens (`--primary`, `--success`, `--warning`, `--danger`, `--info`) and
 * layer per-cluster / per-squad accents on top.
 *
 * All exports are pure data — safe to import from both client components
 * ("use client") and RSCs.
 */

import type {
  EnvironmentName,
  RecommendationKind,
} from "@/lib/eks-cost/types";

/**
 * One HSL colour per canonical environment. Picked so the four clusters
 * remain distinguishable on both light and dark themes and the ordering
 * from cold (dev) to hot (prod) is preserved.
 */
export const ENV_COLOR: Record<EnvironmentName, string> = {
  dev: "hsl(200 88% 55%)",     // sky blue
  uat: "hsl(38 92% 55%)",      // amber
  prod: "hsl(346 82% 55%)",    // rose / raspberry
  tooling: "hsl(160 74% 45%)", // emerald
};

/**
 * Companion "darker" tone for each environment — used for the second stop
 * of a linear gradient so bars/donut slices get a subtle depth.
 */
export const ENV_COLOR_DARK: Record<EnvironmentName, string> = {
  dev: "hsl(210 88% 40%)",
  uat: "hsl(28 92% 45%)",
  prod: "hsl(336 82% 40%)",
  tooling: "hsl(170 74% 32%)",
};

/** Palette used for squad rows (fallback cycle when no squad-specific hue). */
export const SQUAD_PALETTE: readonly [string, string][] = [
  ["hsl(258 82% 60%)", "hsl(268 82% 45%)"], // violet
  ["hsl(190 84% 50%)", "hsl(200 84% 38%)"], // cyan
  ["hsl(24 92% 58%)", "hsl(14 92% 45%)"],  // orange
  ["hsl(140 74% 48%)", "hsl(150 74% 34%)"], // green
  ["hsl(320 76% 60%)", "hsl(330 76% 45%)"], // magenta
  ["hsl(48 92% 55%)", "hsl(38 92% 42%)"],  // gold
  ["hsl(210 88% 60%)", "hsl(220 88% 45%)"], // blue
  ["hsl(0 76% 60%)", "hsl(0 76% 45%)"],    // red
] as const;

/**
 * Deterministic colour lookup for a squad name — hashes the string so a
 * given squad keeps the same accent across renders and reloads.
 */
export function colorForSquad(name: string): readonly [string, string] {
  let h = 0;
  for (let i = 0; i < name.length; i++) {
    h = (h * 31 + name.charCodeAt(i)) >>> 0;
  }
  return SQUAD_PALETTE[h % SQUAD_PALETTE.length];
}

/**
 * Colour per recommendation kind. Green family for `over-*` (savings) and
 * amber/red for `under-*` (risk). Two stops per kind so gradients look
 * layered rather than flat.
 */
export const KIND_COLOR: Record<
  RecommendationKind,
  { fg: string; bg: string; ring: string }
> = {
  "over-cpu": {
    fg: "hsl(158 74% 30%)",
    bg: "hsl(158 74% 92%)",
    ring: "hsl(158 74% 45%)",
  },
  "over-mem": {
    fg: "hsl(140 74% 28%)",
    bg: "hsl(140 74% 92%)",
    ring: "hsl(140 74% 42%)",
  },
  "under-cpu": {
    fg: "hsl(28 92% 40%)",
    bg: "hsl(38 92% 94%)",
    ring: "hsl(38 92% 52%)",
  },
  "under-mem": {
    fg: "hsl(0 76% 42%)",
    bg: "hsl(0 76% 94%)",
    ring: "hsl(0 76% 55%)",
  },
};

/** Human-readable label for each `RecommendationKind`. */
export const KIND_LABEL: Record<RecommendationKind, string> = {
  "over-cpu": "Sobra CPU",
  "over-mem": "Sobra memoria",
  "under-cpu": "Falta CPU",
  "under-mem": "Falta memoria",
};

/** Icon-friendly one-word category per kind, for badges. */
export const KIND_CATEGORY: Record<RecommendationKind, "savings" | "risk"> = {
  "over-cpu": "savings",
  "over-mem": "savings",
  "under-cpu": "risk",
  "under-mem": "risk",
};

/**
 * Colour bucket for a spot-coverage percentage — matches the KPI badge
 * thresholds from the design (>30% verde, 10-30% ámbar, <10% gris) but
 * exposes concrete HSL for chart usage.
 */
export function colorForSpotPct(pct: number): {
  fg: string;
  bg: string;
  ring: string;
} {
  if (!Number.isFinite(pct)) {
    return {
      fg: "hsl(220 10% 40%)",
      bg: "hsl(220 10% 92%)",
      ring: "hsl(220 10% 55%)",
    };
  }
  if (pct > 30) {
    return {
      fg: "hsl(158 74% 30%)",
      bg: "hsl(158 74% 92%)",
      ring: "hsl(158 74% 45%)",
    };
  }
  if (pct >= 10) {
    return {
      fg: "hsl(28 92% 40%)",
      bg: "hsl(38 92% 92%)",
      ring: "hsl(38 92% 55%)",
    };
  }
  return {
    fg: "hsl(220 10% 40%)",
    bg: "hsl(220 10% 92%)",
    ring: "hsl(220 10% 55%)",
  };
}

/**
 * Colour bucket for a workload / nodegroup efficiency percentage.
 * Efficiency = 100 - overprovisioning share; high = green, mid = amber,
 * low = red. Used in the nodegroup breakdown captions and the scatter
 * chart.
 */
export function colorForEfficiency(pct: number): string {
  if (!Number.isFinite(pct)) return "hsl(220 10% 55%)";
  if (pct >= 70) return "hsl(158 74% 42%)";
  if (pct >= 40) return "hsl(38 92% 55%)";
  return "hsl(0 76% 55%)";
}

/** Neutral tone for "sobre-provisionado" segments. */
export const OVERPROVISION_COLOR = "hsl(0 76% 62%)";
export const OVERPROVISION_COLOR_DARK = "hsl(0 76% 42%)";

/** Neutral tone for "right-sized" segments. */
export const RIGHT_SIZED_COLOR = "hsl(158 74% 48%)";
export const RIGHT_SIZED_COLOR_DARK = "hsl(158 74% 30%)";

/**
 * Build a stable, HTML-safe `<defs>` id per key so multiple charts on the
 * same page do not collide when they define linear gradients with the
 * same colour stops.
 */
export function gradientId(chart: string, key: string): string {
  return `eks-grad-${chart}-${key.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
}

/**
 * Display-friendly casing for canonical squad slugs. The internal keys stay
 * lower-case (kept in sync with `NAMESPACE_TO_SQUAD` in `node-cost.ts` and
 * with the rest of the portal for BD/RBAC compatibility) but the UI shows
 * them with proper capitalisation:
 *
 *   - `sre`     → `SRE`
 *   - `martech` → `MarTech`  (steering §15: label visible corregido)
 *   - anything else → first letter capitalised.
 *
 * Falls back to the raw name for empty / undefined input.
 */
export function prettySquadName(name: string): string {
  if (!name) return name;
  const lower = name.toLowerCase();
  if (lower === "sre") return "SRE";
  if (lower === "martech" || lower === "marktech") return "MarTech";
  return name.charAt(0).toUpperCase() + name.slice(1);
}
