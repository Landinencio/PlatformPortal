export const ENABLE_CYBERSECURITY = false;
export const ENABLE_AUTOMATIONS = false;
export const ENABLE_JIRA = false;
/** Kiro Analytics: expose the optional User Activity view (Requirement 7 scope flag). */
export const ENABLE_KIRO_USER_ACTIVITY = true;

/**
 * EKS Cost Optimization v2: gate the new `/finops` "EKS Allocation" dashboard
 * (`<EksCostDashboard />` + `GET /api/finops/k8s-cost`) built by the
 * eks-cost-optimization spec. Env-overridable so Helm can flip it per environment
 * without a code redeploy (Requirement 9.5, rollout Fase 3 → dev, Fase 4 → prod).
 * Default `false` — the legacy `<K8sAllocationDashboard />` keeps rendering
 * until the flag is explicitly turned on in `.helm/values-{dev,prod}.yaml`.
 */
export const ENABLE_EKS_COST_V2 = process.env.ENABLE_EKS_COST_V2 === "true";

/**
 * Infra Self-Service Hardening v1: gates the hardening bundle of the infra
 * self-service flow (spec `infra-self-service-hardening`). Currently governs
 * the Catalogo_Dinamico consumption in `src/lib/rds/rds-generator.ts` (Req 1.3,
 * 10.4) and the new read-only route
 * `GET /api/infra-request-v2/modify/environments` (task 7.1) — subsequent
 * phases (Guardia_Duplicado, Operacion_Entornos writes, Execute reforzado)
 * will consult this same flag. Default `false`: while the flag is off the
 * generator resolves `family` from the static `version-catalog.ts` exactly as
 * `portal-prod v0.23.0-rc.1`, preserving byte-exact `TerraformPreview`
 * (Req 7.3), and the new routes respond 404 (route effectively hidden).
 * Env-overridable so Helm flips it per environment without a code redeploy
 * during the ≥7 días de observación (design § "Ventana de convivencia").
 */
export const ENABLE_INFRA_HARDENING_V1 = process.env.ENABLE_INFRA_HARDENING_V1 === "true";
