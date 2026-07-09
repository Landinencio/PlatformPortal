/**
 * EUR formatting helpers for the EKS Cost Optimization frontend.
 *
 * The whole cost pipeline of `src/lib/eks-cost/*` runs in EUR (the module
 * converts USD hourly cost coming from OpenCost via `NodeCostContext.usdToEur`
 * before returning any figure), so the UI never has to convert currencies —
 * it only has to render them. These two helpers standardise the visual
 * formatting across `<KpiBar>`, `<FiltersBar>`, the Recharts tooltips, the
 * recommendations table and the detail panel.
 *
 * Two flavours:
 *   - `formatEur(value)`   → full form, `es-ES` locale, EUR symbol trailing.
 *                            E.g. `128456.32` → `"128.456,32 €"`.
 *   - `formatEurK(value)`  → compact form for dense widgets (KPI cards,
 *                            chart axes, chart tooltips). E.g.
 *                              `42`         → `"42 €"`
 *                              `12345.67`   → `"12,3k €"`
 *                              `128456.32`  → `"128,5k €"`
 *                              `2500000`    → `"2,5M €"`
 *                            Negatives keep their sign (`-128,5k €`).
 *
 * Design notes (see `.kiro/specs/eks-cost-optimization/design.md` §Frontend):
 *   - Both helpers use the `es-ES` locale so the decimal separator is a
 *     comma and the thousands separator is a dot, matching the rest of the
 *     FinOps section of the portal (`costs-dashboard.tsx` uses `en-US` for
 *     USD, this module purposefully uses `es-ES` for EUR).
 *   - The symbol is always trailing (`… €`) with a non-breaking space, as
 *     `Intl.NumberFormat` does natively for `es-ES` — we preserve that
 *     behaviour in the compact form for visual consistency.
 *   - Non-finite inputs (`NaN`, `±Infinity`, `null`-ish) render as `"—"`.
 *     Consumers can rely on this to avoid inline guards.
 *
 * 100% pure module: no I/O, no side effects, no `Intl` caching required
 * (`Intl.NumberFormat` is cheap enough to instantiate per call in this
 * hot path — the dashboard renders at most a few hundred cells per view).
 *
 * Validates:
 *   - Requirement 1.7 (visual presentation via Recharts + KPI cards)
 *   - Requirement 9.4 (`generatedAt` timestamp label uses the same locale)
 */

/** Non-breaking space (`U+00A0`) used by `Intl.NumberFormat("es-ES")`. */
const NBSP = "\u00A0";

/** Sentinel string returned when the input is not a finite number. */
const NA = "—";

/**
 * Format a EUR amount with the full `es-ES` currency style
 * (two decimals, thousands separator, trailing symbol).
 *
 * Examples:
 *   formatEur(0)            → "0,00 €"
 *   formatEur(42)           → "42,00 €"
 *   formatEur(128456.32)    → "128.456,32 €"
 *   formatEur(-12.5)        → "-12,50 €"
 *   formatEur(Number.NaN)   → "—"
 */
export function formatEur(value: number): string {
  if (!Number.isFinite(value)) return NA;
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Format a EUR amount in a compact form suitable for KPI cards, chart axes
 * and chart tooltips. Uses `k` for thousands and `M` for millions, one
 * decimal, `es-ES` conventions (comma as decimal separator).
 *
 * Rounding always keeps at most one decimal so labels stay narrow.
 *
 * Examples:
 *   formatEurK(0)            → "0 €"
 *   formatEurK(42)           → "42 €"
 *   formatEurK(999.4)        → "999 €"
 *   formatEurK(1000)         → "1,0k €"
 *   formatEurK(12345.67)     → "12,3k €"
 *   formatEurK(128456.32)    → "128,5k €"
 *   formatEurK(2_500_000)    → "2,5M €"
 *   formatEurK(-128456.32)   → "-128,5k €"
 *   formatEurK(Number.NaN)   → "—"
 *
 * `es-ES` conventions apply the thousands separator only for numbers with
 * five digits or more (`10.000` yes, `1000` no), matching Spanish typography
 * rules and the built-in behaviour of `Intl.NumberFormat`.
 */
export function formatEurK(value: number): string {
  if (!Number.isFinite(value)) return NA;

  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";

  // Below 1 000 €: render as integer (no decimals) — cents are irrelevant
  // at this magnitude in a KPI/chart tooltip. Uses `es-ES` so a rounded-up
  // boundary like `999.6` renders as `"1.000 €"` (with the thousands
  // separator), not `"1000 €"`.
  if (abs < 1_000) {
    const rounded = new Intl.NumberFormat("es-ES", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(abs);
    return `${sign}${rounded}${NBSP}€`;
  }

  // Below 1 000 000 €: `k` suffix with one decimal (`es-ES` comma).
  if (abs < 1_000_000) {
    const num = new Intl.NumberFormat("es-ES", {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }).format(abs / 1_000);
    return `${sign}${num}k${NBSP}€`;
  }

  // 1 000 000 € or more: `M` suffix with one decimal.
  const num = new Intl.NumberFormat("es-ES", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(abs / 1_000_000);
  return `${sign}${num}M${NBSP}€`;
}
