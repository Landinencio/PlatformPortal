/**
 * FinOps domain knowledge for Iskay (the FinOps chat agent).
 *
 * This is the curated, IskayPet-specific "ground truth" that turns Iskay from a generic
 * AWS assistant into one that knows *this* organisation's bill: the reseller discount
 * model, the day-1 marketplace prepaid contracts, known high-spend items, and which
 * squad owns which account.
 *
 * Keep this in sync with the canonical steering doc (.kiro/steering/portal-architecture.md
 * §3 CUR, §7 accounts, §11 spending to watch). It is injected into the chat system prompt
 * so the model reasons WITH these facts instead of guessing.
 *
 * IMPORTANT: these are stable, structural facts (ownership, billing mechanics, known
 * recurring charges). Live numbers ALWAYS come from the tools — never hardcode amounts
 * the model should present as "current".
 */

/** Maps each AWS account id to the squad/domain that owns it. */
export interface AccountOwnership {
  accountId: string;
  squad: string;
  env: "dev" | "uat" | "prod" | "tooling" | "shared" | "sandbox";
}

/** Account → squad/env ownership (so Iskay can answer "which team owns X / spends most"). */
export const ACCOUNT_OWNERSHIP: AccountOwnership[] = [
  { accountId: "111222333444", squad: "Digital", env: "prod" },
  { accountId: "000011112222", squad: "Digital", env: "uat" },
  { accountId: "999900001111", squad: "Digital", env: "dev" },
  { accountId: "888899990000", squad: "Digital", env: "shared" },
  { accountId: "666777888999", squad: "Retail", env: "prod" },
  { accountId: "555666777888", squad: "Retail", env: "uat" },
  { accountId: "444555666777", squad: "Retail", env: "dev" },
  { accountId: "777788889999", squad: "Helios", env: "prod" },
  { accountId: "666677778888", squad: "Helios", env: "uat" },
  { accountId: "555566667777", squad: "Helios", env: "dev" },
  { accountId: "200300400500", squad: "Data", env: "prod" },
  { accountId: "100200300400", squad: "Data", env: "dev" },
  { accountId: "333344445555", squad: "Platform/SRE (EKS)", env: "prod" },
  { accountId: "222233334444", squad: "Platform/SRE (EKS)", env: "uat" },
  { accountId: "111122223333", squad: "Platform/SRE (EKS)", env: "dev" },
  { accountId: "444455556666", squad: "Platform/SRE (Tooling)", env: "tooling" },
  { accountId: "300400500600", squad: "Platform/SRE (Infra)", env: "shared" },
  { accountId: "600700800900", squad: "Billing/MPA (root)", env: "shared" },
  { accountId: "333444555666", squad: "Ecommerce", env: "shared" },
  { accountId: "222333444555", squad: "Ecommerce (Tiendanimal)", env: "shared" },
  { accountId: "500600700800", squad: "Sistemas (Tiendanimal)", env: "shared" },
  { accountId: "999000111222", squad: "Clinicanimal", env: "prod" },
  { accountId: "400500600700", squad: "SAP", env: "shared" },
];

/** Recurring high-spend items worth flagging (from steering §11). These are CONTEXT,
 *  not live figures — Iskay must confirm current amounts with the tools. */
export const SPEND_WATCH_LIST: Array<{ item: string; approxMonthly: string; note: string }> = [
  { item: "Marketplace contracts (software anual prepagado)", approxMonthly: "~$85k", note: "Se cargan el DÍA 1 del periodo de contrato → producen falsos picos. Product codes tipo cg…. Ej: el contrato de Grafana. Sepáralos SIEMPRE del coste de infra real." },
  { item: "PostgreSQL 13 Extended Support", approxMonthly: "~$950", note: "Pagamos por NO migrar. Quick win: migrar a versión soportada." },
  { item: "CloudWatch Logs us-east-1 (WAF)", approxMonthly: "~$2.4k", note: "4 log groups por brand. Revisar retención." },
  { item: "Bedrock Haiku (GenAI)", approxMonthly: "~$2.2k", note: "Repartido entre Iskaypet Data (200300400500) y Data dev (100200300400). Aparece como inference profiles con ids opacos → 'Bedrock (GenAI)'." },
  { item: "NAT Gateways", approxMonthly: "~$200+ top", note: "9 activos. Top consumer nat-02fa21f2db24ee28f en prod." },
  { item: "EBS gp2 (sin migrar a gp3)", approxMonthly: "ahorro ~20%", note: "Quick win directo con get_hidden_costs." },
];

/** How IskayPet's bill is structured (reseller model + CUR mechanics). */
export const BILLING_MODEL_NOTES = [
  "IskayPet compra AWS a través de un reseller: los descuentos llegan en el CUR como SppDiscount y BundledDiscount (líneas NEGATIVAS).",
  "El SavingsPlanNegation ya está incluido en el gross cost.",
  "Pregunta '¿cuánto cuesta AWS?' → distinguir SIEMPRE: Gross AWS, Marketplace (separado), y Net infra (lo que cuesta la infra de verdad). Usar get_net_cost_breakdown.",
  "La cobertura del tag user_domain es BAJA (~3-4% del coste). Al dar coste por dominio/departamento, expón el % de cobertura; el resto no está atribuido.",
  "Las licencias Kiro IDE vienen como FlatRateSubscription (Pro $20, Pro+ $40, Power $200), NO como Fee.",
];

/**
 * Builds the FinOps knowledge block injected into the chat system prompt.
 * Compact on purpose (it rides in every request); the prompt cache amortises it.
 */
export function buildFinopsKnowledgeBlock(): string {
  const ownership = ACCOUNT_OWNERSHIP.map(
    (o) => `  - ${o.accountId} → ${o.squad} (${o.env})`,
  ).join("\n");

  const watch = SPEND_WATCH_LIST.map(
    (w) => `  - ${w.item} (${w.approxMonthly}): ${w.note}`,
  ).join("\n");

  const billing = BILLING_MODEL_NOTES.map((n) => `  - ${n}`).join("\n");

  return `## Conocimiento FinOps de IskayPet (contexto curado — confirma cifras vivas con las tools)

### Modelo de facturación
${billing}

### Propiedad de cuentas (cuenta → squad / entorno)
${ownership}

### Gasto recurrente a vigilar (cifras orientativas, NO las presentes como actuales sin verificar)
${watch}

Usa este contexto para razonar sobre la factura de IskayPet, atribuir gasto a squads y explicar anomalías (p. ej. un pico en día 1 suele ser un contrato marketplace, no infra). Las cantidades EXACTAS y actuales SIEMPRE provienen de las herramientas.`;
}
