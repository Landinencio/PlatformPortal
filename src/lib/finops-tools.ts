/**
 * FinOps Tool definitions for the Bedrock tool-calling agent (Iskay).
 *
 * Iskay is PURE AWS-native cost FinOps. Each tool wraps an AWS-native data
 * source: the Athena lambda CUR relay, AWS Cost Explorer forecast via the same
 * lambda, the CUR full snapshot (Athena), the AWS multi-account inventory, the
 * static AWS account catalog, and the `finops_daily_context` snapshot table.
 * The model decides which one to call based on the user's question.
 */

import * as XLSX from "xlsx";

import { fetchAwsAccountCatalog, filterLiveAwsAccounts, buildAwsAccountNameMap } from "@/lib/aws-account-catalog";
import pool from "@/lib/db";
import { AWS_ACCOUNT_NAMES } from "@/lib/aws-accounts";
import { fetchInventory } from "@/lib/aws-inventory";
import { fetchCurFullSnapshot } from "@/lib/athena-cur";
import { saveReport } from "@/lib/finops-report-store";

const FINOPS_ATHENA_LAMBDA_URL =
  process.env.FINOPS_ATHENA_LAMBDA_URL ||
  "https://jzcrsycqa2plblvxdeck37r6am0kxeqw.lambda-url.eu-north-1.on.aws/";

// --- Tool catalog ----------------------------------------------------------

export interface FinOpsToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Tool definitions in JSON Schema. Bedrock Converse API will surface these to
 * the model and emit `toolUse` blocks when it wants to invoke one.
 */
export const FINOPS_TOOLS: FinOpsToolSpec[] = [
  {
    name: "list_accounts",
    description:
      "Lista todas las cuentas AWS disponibles del grupo IskayPet (id y nombre). Úsalo cuando el usuario pregunte qué cuentas existen o quiera saber el id de una cuenta concreta antes de filtrar.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_total_cost",
    description:
      "Devuelve el coste total real (CUR/Athena) en USD para un rango de fechas. Si no se filtra por accountIds devuelve el total de todas las cuentas activas. Es la herramienta principal para responder a '¿cuánto hemos gastado?'.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Fecha inicio en formato YYYY-MM-DD (incluida)" },
        endDate: { type: "string", description: "Fecha fin en formato YYYY-MM-DD (incluida)" },
        accountIds: {
          type: "array",
          description: "Lista opcional de account ids (12 dígitos). Si se omite, todas las cuentas activas.",
          items: { type: "string" },
        },
      },
      required: ["startDate", "endDate"],
      additionalProperties: false,
    },
  },
  {
    name: "get_cost_by_account",
    description:
      "Devuelve el desglose de coste por cuenta AWS para un rango de fechas, ordenado de mayor a menor. Úsalo cuando el usuario pida 'qué cuentas gastan más', 'top accounts', etc.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Fecha inicio YYYY-MM-DD" },
        endDate: { type: "string", description: "Fecha fin YYYY-MM-DD" },
        limit: {
          type: "integer",
          description: "Número máximo de cuentas a devolver (default 10).",
          minimum: 1,
          maximum: 50,
        },
        accountIds: {
          type: "array",
          description: "Lista opcional de account ids para limitar el alcance.",
          items: { type: "string" },
        },
      },
      required: ["startDate", "endDate"],
      additionalProperties: false,
    },
  },
  {
    name: "get_cost_by_service",
    description:
      "Devuelve el coste agregado por servicio AWS (EC2, RDS, S3, ECR, NAT Gateway, etc.) para el rango y cuentas indicadas. Útil para responder 'en qué servicios gastamos más' o 'cuánto cuesta CloudWatch'.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Fecha inicio YYYY-MM-DD" },
        endDate: { type: "string", description: "Fecha fin YYYY-MM-DD" },
        limit: {
          type: "integer",
          description: "Número de servicios top a devolver (default 15, máximo 50).",
          minimum: 1,
          maximum: 50,
        },
        accountIds: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["startDate", "endDate"],
      additionalProperties: false,
    },
  },
  {
    name: "compare_periods",
    description:
      "Compara coste total entre dos periodos (típicamente mes actual vs mes anterior, o pre-Kiro vs post-Kiro). Devuelve total de cada periodo, diferencia absoluta y diferencia porcentual.",
    inputSchema: {
      type: "object",
      properties: {
        currentStart: { type: "string", description: "Inicio periodo actual YYYY-MM-DD" },
        currentEnd: { type: "string", description: "Fin periodo actual YYYY-MM-DD" },
        previousStart: { type: "string", description: "Inicio periodo previo YYYY-MM-DD" },
        previousEnd: { type: "string", description: "Fin periodo previo YYYY-MM-DD" },
        accountIds: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["currentStart", "currentEnd", "previousStart", "previousEnd"],
      additionalProperties: false,
    },
  },
  {
    name: "get_forecast",
    description:
      "Devuelve la previsión de coste futuro de AWS Cost Explorer (todas las cuentas agregadas, MES + 1 a MES + N). Úsalo para preguntas tipo '¿cuánto vamos a gastar este trimestre?'.",
    inputSchema: {
      type: "object",
      properties: {
        months: {
          type: "integer",
          description: "Meses a predecir hacia adelante (1-6). Default 3.",
          minimum: 1,
          maximum: 6,
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_top_resources",
    description:
      "Lista los recursos individuales (instancias EC2, buckets S3, RDS, NAT, etc.) que más han costado en el periodo. Útil para 'qué recurso concreto está costando más'.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "Fecha inicio YYYY-MM-DD" },
        endDate: { type: "string", description: "Fecha fin YYYY-MM-DD" },
        limit: {
          type: "integer",
          description: "Número máximo de recursos (default 20, máximo 100).",
          minimum: 1,
          maximum: 100,
        },
        accountIds: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["startDate", "endDate"],
      additionalProperties: false,
    },
  },
  {
    name: "get_hidden_costs",
    description:
      "Detector automático de costes ocultos / quick wins desde el CUR: EBS gp2 a migrar a gp3, RDS Extended Support pagado, CloudWatch Logs caros, NAT Gateway data processing, Bedrock por modelo, snapshots EBS y tráfico inter-AZ. Devuelve coste actual y ahorro estimado de cada uno.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string", description: "YYYY-MM-DD (default: día 1 del mes en curso)" },
        endDate: { type: "string", description: "YYYY-MM-DD (default: hoy)" },
        accountIds: {
          type: "array",
          items: { type: "string" },
          description: "Cuentas a incluir. Por defecto todas las activas.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_marketplace_charges",
    description:
      "Devuelve los cargos de Marketplace / contratos de software (no son infraestructura AWS). Útil para separar el coste 'de verdad' de AWS de los cargos puntuales como pagos anuales de software.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string" },
        endDate: { type: "string" },
        accountIds: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_net_cost_breakdown",
    description:
      "Waterfall del coste neto: gross AWS bruto, marketplace charges separados, descuentos (SP, SPP, Bundle, Credits, Refunds) y coste neto de infraestructura. Útil para responder 'cuánto cuesta AWS de verdad descontando contratos y descuentos'.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string" },
        endDate: { type: "string" },
        accountIds: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_cost_by_domain",
    description:
      "Devuelve el coste agregado por DOMINIO / EQUIPO / DEPARTAMENTO (tag `user_domain` del CUR) para el rango y cuentas indicadas, ordenado de mayor a menor. Es la herramienta para responder '¿qué departamento/equipo/dominio gasta más?'. Aviso: la cobertura del tag `user_domain` es parcial (~3-4% del coste está etiquetado), así que devuelve también la cobertura para que lo expongas con honestidad. NO uses get_cost_by_service para preguntas por departamento.",
    inputSchema: {
      type: "object",
      properties: {
        startDate: { type: "string" },
        endDate: { type: "string" },
        accountIds: { type: "array", items: { type: "string" } },
        limit: { type: "number", minimum: 1, maximum: 50 },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_daily_context",
    description:
      "Devuelve el snapshot diario más reciente almacenado en la base de datos (`finops_daily_context`). Incluye resumen de inventario (EC2, RDS, EBS), oportunidades de ahorro detectadas y top servicios. Úsalo para preguntas sobre 'cuántas EC2 tenemos', 'EBS huérfanos', 'oportunidades de ahorro'.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: "get_inventory_summary",
    description:
      "Resumen del inventario AWS multi-cuenta: número total de recursos, servicios cubiertos, cobertura Terraform y tags, recursos en EOL (Amazon Linux 2, RDS engines obsoletos). Útil para preguntas de governance e inventario tipo 'cuántas instancias EC2 tenemos', 'cobertura Terraform', 'qué hay en EOL'.",
    inputSchema: {
      type: "object",
      properties: {
        accountIds: {
          type: "array",
          description: "Cuentas a incluir (omitir = todas).",
          items: { type: "string" },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "search_inventory",
    description:
      "Busca recursos AWS por nombre, ID, tipo, familia o tag. Devuelve hasta 30 recursos con metadata clave. Útil para 'busca todas las RDS de oms', 'qué EC2 hay en marketplace', 'lista los NAT Gateway'.",
    inputSchema: {
      type: "object",
      properties: {
        accountIds: {
          type: "array",
          items: { type: "string" },
          description: "Cuentas a incluir (omitir = todas).",
        },
        serviceFamily: {
          type: "string",
          description: "Familia AWS: EC2, RDS, S3, Lambda, ELB, VPC, EKS, ElastiCache, etc.",
        },
        resourceType: {
          type: "string",
          description: "Tipo concreto: instances, ebs volumes, db instances, db clusters, buckets, functions, load balancers, nat gateways, etc.",
        },
        nameContains: {
          type: "string",
          description: "Substring a buscar en el nombre o ID del recurso (case-insensitive).",
        },
        tagKey: { type: "string", description: "Filtra recursos que tienen este tag." },
        tagValue: { type: "string", description: "Valor concreto del tagKey (opcional)." },
        limit: { type: "integer", minimum: 1, maximum: 100, description: "default 30" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "build_report",
    description:
      "Genera un informe Excel (.xlsx) descargable con los datos de coste pedidos. Úsalo cuando el usuario pida 'un informe', 'en Excel', 'descargable', 'un fichero'. NO pongas tú las cifras: indica `title`, `startDate`, `endDate`, opcionalmente `accountIds`, y la lista de `sections`. La herramienta vuelve a obtener los datos exactos de cada sección y construye el workbook (hoja Resumen + una hoja por sección). Devuelve `reportId`, `filename`, `sheetCount`, `rowCounts` y `downloadUrl`.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Título del informe (ej. 'Coste AWS — Mayo 2026').",
        },
        startDate: { type: "string", description: "Fecha inicio YYYY-MM-DD (incluida)." },
        endDate: { type: "string", description: "Fecha fin YYYY-MM-DD (incluida)." },
        accountIds: {
          type: "array",
          description:
            "Lista opcional de account ids para acotar el informe. Si se omite, se incluyen todas las cuentas activas.",
          items: { type: "string" },
        },
        sections: {
          type: "array",
          description:
            "Secciones a incluir; cada una se materializa como una hoja del Excel además de la hoja 'Resumen' con metadatos.",
          minItems: 1,
          items: {
            type: "string",
            enum: [
              "summary",
              "by_account",
              "by_service",
              "by_domain",
              "top_resources",
              "net_breakdown",
              "hidden_costs",
              "marketplace",
            ],
          },
        },
      },
      required: ["title", "startDate", "endDate", "sections"],
      additionalProperties: false,
    },
  },
];

// --- Lambda helpers --------------------------------------------------------

function parseLambdaPayload(payload: unknown): any {
  if (typeof payload !== "object" || payload === null) return {};
  const wrapped = payload as { body?: unknown };
  if (typeof wrapped.body === "string") {
    try {
      return JSON.parse(wrapped.body);
    } catch {
      return {};
    }
  }
  if (typeof wrapped.body === "object" && wrapped.body !== null) return wrapped.body;
  return payload;
}

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

async function callAthena(body: Record<string, unknown>): Promise<any> {
  const response = await fetch(FINOPS_ATHENA_LAMBDA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Athena lambda returned ${response.status}: ${text.slice(0, 200)}`);
  }
  const raw = await response.json();
  return parseLambdaPayload(raw);
}

/**
 * Optional dependency overrides for `resolveAccountIds`. Lets unit tests inject
 * a deterministic catalog instead of hitting the AWS Organizations Lambda.
 * Production callers omit `deps` and the real helpers from
 * `aws-account-catalog.ts` are used.
 */
export interface ResolveAccountIdsDeps {
  fetchAwsAccountCatalog?: typeof fetchAwsAccountCatalog;
  filterLiveAwsAccounts?: typeof filterLiveAwsAccounts;
}

/**
 * Resolves an `accountIds` argument for the FinOps tools. If the caller passed
 * a non-empty array we honour it (after trimming + filtering to numeric ids of
 * 6+ digits). Otherwise we fall back to the live AWS account catalog.
 *
 * Exported for unit tests; the loop in `executeFinopsTool` calls it without
 * `deps` so production behaviour is unchanged.
 */
export async function resolveAccountIds(
  input?: string[] | null,
  deps?: ResolveAccountIdsDeps,
): Promise<string[]> {
  if (Array.isArray(input) && input.length > 0) {
    return input.map((id) => String(id).trim()).filter((id) => /^\d{6,}$/.test(id));
  }
  const fetchCatalog = deps?.fetchAwsAccountCatalog ?? fetchAwsAccountCatalog;
  const filterLive = deps?.filterLiveAwsAccounts ?? filterLiveAwsAccounts;
  const catalog = await fetchCatalog();
  return filterLive(catalog).map((a) => a.id);
}

/**
 * Computes the default CUR-deep window (current month-to-date in UTC) used by
 * `getCurDeep` whenever the caller did not pass `startDate`/`endDate`. Pure
 * helper so unit tests can pin `now` and assert the resulting range without
 * mocking `Date`.
 *
 * Returns ISO `YYYY-MM-DD` strings: `startDate` = day 1 of `now`'s UTC month,
 * `endDate` = `now`'s UTC date.
 */
export function defaultCurWindow(now: Date = new Date()): { startDate: string; endDate: string } {
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  return {
    startDate: `${yyyy}-${mm}-01`,
    endDate: `${yyyy}-${mm}-${dd}`,
  };
}

function nameOf(accountId: string, fallbackMap: Record<string, string>): string {
  return fallbackMap[accountId] || AWS_ACCOUNT_NAMES[accountId] || accountId;
}

/** Maps an opaque CUR service code to a friendly label so the model (and the user)
 *  never see raw ids. Marketplace contracts arrive as `cg…` product codes; Bedrock
 *  inference profiles as long opaque alphanumerics. Mirrors prettyService in the digest.
 *  Exported so unit tests can pin its translation rules without going through the agent. */
export function prettyServiceName(raw: string): string {
  const name = String(raw || "").trim();
  if (!name) return "Otros";
  if (/^cg[a-z0-9]{10,}$/i.test(name)) return "Marketplace (contrato)";
  if (/^[a-z0-9]{20,}$/i.test(name) && !/^amazon|^aws/i.test(name)) return "Bedrock (GenAI)";
  return name;
}

/**
 * Detects whether `text` contains any "Opaque_Id" — a raw CUR identifier that
 * Iskay must NEVER expose to the user. Used by the offline evals harness
 * (`noOpaqueIds` assertion) and reusable from any other guard that needs the
 * same rule.
 *
 * The check is the inverse of `prettyServiceName`'s rules, applied as a
 * substring scan rather than a full-string match (so a sentence containing
 * the id flags, not just a cell whose ENTIRE content is the id):
 *
 *  - `\bcg[a-z0-9]{10,}\b` — Marketplace product codes (`cgdwha66...`).
 *  - `\b[a-z0-9]{20,}\b` not starting with `amazon`/`aws` — long opaque
 *    alphanumerics (Bedrock inference-profile ids and similar). The
 *    `amazon*`/`aws*` exclusion mirrors the `prettyServiceName` carve-out
 *    so legit AWS resource names aren't false-flagged.
 *
 * Pure function. Returns `false` for empty/non-string input. Case-insensitive.
 */
export function containsOpaqueId(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  // Marketplace product codes — `cgXXXXXXXXXX` is opaque regardless of length.
  if (/\bcg[a-z0-9]{10,}\b/i.test(text)) return true;
  // Long alphanumeric tokens (≥ 20 chars) that don't start with amazon/aws —
  // matches Bedrock inference-profile-style ids while leaving normal AWS
  // service names (`AmazonCloudFront…`, `AWS…`) alone.
  const matches = text.match(/\b[a-z0-9]{20,}\b/gi);
  if (!matches) return false;
  for (const m of matches) {
    const lower = m.toLowerCase();
    if (lower.startsWith("amazon") || lower.startsWith("aws")) continue;
    return true;
  }
  return false;
}

// --- Tool executors --------------------------------------------------------

async function listAccountsTool() {
  const catalog = await fetchAwsAccountCatalog();
  const live = filterLiveAwsAccounts(catalog);
  return {
    count: live.length,
    accounts: live.map((a) => ({ id: a.id, name: a.name })),
  };
}

interface CostQueryInput {
  startDate: string;
  endDate: string;
  accountIds?: string[];
}

/** Short-lived cache for Lambda cost queries, keyed by (range, accounts). */
const costQueryCache = new Map<string, { at: number; data: any }>();
const COST_QUERY_CACHE_MS = 5 * 60 * 1000;

async function fetchCostQuery(input: CostQueryInput): Promise<any> {
  if (!isIsoDate(input.startDate) || !isIsoDate(input.endDate)) {
    throw new Error("startDate and endDate must be YYYY-MM-DD");
  }
  if (input.startDate > input.endDate) {
    throw new Error("startDate must be <= endDate");
  }
  const accountIds = await resolveAccountIds(input.accountIds);
  const accountsCsv = accountIds.join(",") || "all";

  // In-conversation cache: the agent often re-queries the SAME window/accounts across
  // tool calls (e.g. get_total_cost then get_cost_by_service). Each miss is a 5-30s
  // Athena round-trip via the Lambda, so cache by (range, accounts) for a few minutes.
  const key = `${input.startDate}::${input.endDate}::${accountsCsv}`;
  const now = Date.now();
  const hit = costQueryCache.get(key);
  if (hit && now - hit.at < COST_QUERY_CACHE_MS) {
    return hit.data;
  }

  const data = await callAthena({
    query: {
      accountIds: accountsCsv,
      startDate: input.startDate,
      endDate: input.endDate,
      includeTrends: false,
      includeResourceCosts: true,
      resourceCostLimit: 1000,
    },
  });

  // Bound the cache so it can't grow unbounded across many distinct windows.
  if (costQueryCache.size >= 50) {
    const oldest = costQueryCache.keys().next().value;
    if (oldest !== undefined) costQueryCache.delete(oldest);
  }
  costQueryCache.set(key, { at: now, data });
  return data;
}

async function getTotalCostTool(args: CostQueryInput) {
  const data = await fetchCostQuery(args);
  const summaryTotal = Number(data?.summary?.totalCost || 0);
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  return {
    period: { startDate: args.startDate, endDate: args.endDate },
    accountIds: await resolveAccountIds(args.accountIds),
    totalCostUSD: Number.isFinite(summaryTotal) ? summaryTotal : 0,
    accountsIncluded: accounts.length,
    currency: "USD",
  };
}

async function getCostByAccountTool(args: CostQueryInput & { limit?: number }) {
  const data = await fetchCostQuery(args);
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];
  const catalog = await fetchAwsAccountCatalog();
  const nameMap = catalog.reduce<Record<string, string>>((acc, a) => {
    acc[a.id] = a.name;
    return acc;
  }, {});

  const sorted = accounts
    .map((a: any) => ({
      accountId: String(a.accountId || ""),
      accountName: a.accountName || nameOf(String(a.accountId || ""), nameMap),
      costUSD: Number(a.totalCost || 0),
    }))
    .filter((a: any) => a.accountId && Number.isFinite(a.costUSD))
    .sort((a: any, b: any) => b.costUSD - a.costUSD);

  const limit = Math.max(1, Math.min(50, Math.round(args.limit ?? 10)));
  const total = sorted.reduce((sum: number, a: any) => sum + a.costUSD, 0);

  return {
    period: { startDate: args.startDate, endDate: args.endDate },
    totalCostUSD: total,
    accounts: sorted.slice(0, limit),
    accountsIncluded: sorted.length,
  };
}

async function getCostByServiceTool(args: CostQueryInput & { limit?: number }) {
  const data = await fetchCostQuery(args);
  const accounts = Array.isArray(data?.accounts) ? data.accounts : [];

  const serviceMap = new Map<string, number>();
  for (const a of accounts) {
    const services = Array.isArray(a.services) ? a.services : [];
    for (const s of services) {
      const name = prettyServiceName(String(s.name || "Unknown"));
      const cost = Number(s.cost || 0);
      if (!Number.isFinite(cost)) continue;
      serviceMap.set(name, (serviceMap.get(name) || 0) + cost);
    }
  }

  const ordered = [...serviceMap.entries()]
    .map(([service, cost]) => ({ service, costUSD: cost }))
    .sort((a, b) => b.costUSD - a.costUSD);

  const limit = Math.max(1, Math.min(50, Math.round(args.limit ?? 15)));
  const total = ordered.reduce((sum, s) => sum + s.costUSD, 0);

  return {
    period: { startDate: args.startDate, endDate: args.endDate },
    totalCostUSD: total,
    services: ordered.slice(0, limit),
    servicesIncluded: ordered.length,
  };
}

async function comparePeriodsTool(args: {
  currentStart: string;
  currentEnd: string;
  previousStart: string;
  previousEnd: string;
  accountIds?: string[];
}) {
  for (const v of [args.currentStart, args.currentEnd, args.previousStart, args.previousEnd]) {
    if (!isIsoDate(v)) throw new Error(`Invalid date: ${v}`);
  }
  const accountIds = await resolveAccountIds(args.accountIds);

  const [current, previous] = await Promise.all([
    fetchCostQuery({ startDate: args.currentStart, endDate: args.currentEnd, accountIds }),
    fetchCostQuery({ startDate: args.previousStart, endDate: args.previousEnd, accountIds }),
  ]);

  const currentTotal = Number(current?.summary?.totalCost || 0);
  const previousTotal = Number(previous?.summary?.totalCost || 0);
  const diff = currentTotal - previousTotal;
  const diffPct = previousTotal > 0 ? (diff / previousTotal) * 100 : null;

  return {
    accountIds,
    current: {
      period: { startDate: args.currentStart, endDate: args.currentEnd },
      totalCostUSD: currentTotal,
    },
    previous: {
      period: { startDate: args.previousStart, endDate: args.previousEnd },
      totalCostUSD: previousTotal,
    },
    diffAbsoluteUSD: diff,
    diffPercent: diffPct,
    direction: diff > 0 ? "increase" : diff < 0 ? "decrease" : "flat",
  };
}

async function getForecastTool(args: { months?: number }) {
  const months = Math.max(1, Math.min(6, Math.round(args.months ?? 3)));
  const data = await callAthena({ action: "forecast", query: { forecastMonths: months } });
  const forecast = data?.forecast || null;
  return {
    months,
    forecast: forecast
      ? {
          period: forecast.period,
          totalForecastUSD: Number(forecast.total?.amount || forecast.total || 0),
          byMonth: forecast.byMonth || [],
        }
      : null,
    errors: Array.isArray(data?.errors) ? data.errors : [],
  };
}

async function getTopResourcesTool(args: CostQueryInput & { limit?: number }) {
  const data = await fetchCostQuery(args);
  const resources = Array.isArray(data?.resourceCosts) ? data.resourceCosts : [];
  const catalog = await fetchAwsAccountCatalog();
  const nameMap = catalog.reduce<Record<string, string>>((acc, a) => {
    acc[a.id] = a.name;
    return acc;
  }, {});

  const sorted = resources
    .map((r: any) => ({
      accountId: String(r.accountId || r.account_id || ""),
      accountName: nameOf(String(r.accountId || r.account_id || ""), nameMap),
      service: prettyServiceName(String(r.service || "Unknown")),
      resourceId: String(r.resourceId || r.resource_id || ""),
      costUSD: Number(r.cost || 0),
    }))
    .filter((r: any) => r.accountId && r.resourceId && Number.isFinite(r.costUSD) && r.costUSD > 0)
    .sort((a: any, b: any) => b.costUSD - a.costUSD);

  const limit = Math.max(1, Math.min(100, Math.round(args.limit ?? 20)));
  return {
    period: { startDate: args.startDate, endDate: args.endDate },
    resources: sorted.slice(0, limit),
    totalResources: sorted.length,
  };
}

async function getDailyContextTool() {
  const result = await pool.query(
    `SELECT snapshot_date, total_accounts, total_resources, total_services,
            cost_summary, inventory_summary, opportunities, metrics_summary
     FROM finops_daily_context
     ORDER BY snapshot_date DESC
     LIMIT 1`,
  );
  if (result.rowCount === 0) {
    return { available: false, reason: "No FinOps daily snapshot found in database." };
  }
  const row = result.rows[0];
  return {
    available: true,
    snapshotDate: row.snapshot_date,
    totals: {
      accounts: row.total_accounts,
      resources: row.total_resources,
      services: row.total_services,
    },
    costSummary: row.cost_summary,
    inventorySummary: row.inventory_summary,
    opportunities: row.opportunities,
    metricsSummary: row.metrics_summary,
  };
}

// ─── Inventory tools ──────────────────────────────────────────────────────

let cachedInventory: { data: Awaited<ReturnType<typeof fetchInventory>>; at: number; key: string } | null = null;
const INVENTORY_CACHE_MS = 10 * 60 * 1000;

async function getInventory(accountIds: string[]) {
  const key = accountIds.slice().sort().join(",");
  const now = Date.now();
  if (cachedInventory && cachedInventory.key === key && now - cachedInventory.at < INVENTORY_CACHE_MS) {
    return cachedInventory.data;
  }
  const catalog = await fetchAwsAccountCatalog();
  const accountNameMap = buildAwsAccountNameMap(catalog);
  const data = await fetchInventory(accountIds, { accountNameMap });
  cachedInventory = { data, at: now, key };
  return data;
}

async function getInventorySummaryTool(args: { accountIds?: string[] }) {
  const ids = await resolveAccountIds(args.accountIds);
  const inv = await getInventory(ids);

  // EOL detection across all details
  let al2Count = 0;
  let al2023Count = 0;
  let rdsEolCount = 0;
  let untaggedCount = 0;
  let terraformManaged = 0;
  let terraformKnown = 0;
  for (const acc of inv.accounts) {
    for (const svc of acc.services) {
      for (const detail of svc.details) {
        if (detail.metadata?.isAmazonLinux2 === true) al2Count++;
        if (detail.metadata?.isAmazonLinux2023 === true) al2023Count++;
        if (detail.metadata?.isEngineEol === true) rdsEolCount++;
        const tags = detail.tags || (detail.metadata?.tags as Record<string, string> | undefined);
        const businessTags = tags && Object.keys(tags).filter((k) => !k.startsWith("aws:"));
        if (!businessTags || businessTags.length === 0) untaggedCount++;
        if (detail.terraformStatus === "managed") terraformManaged++;
        if (detail.terraformStatus && detail.terraformStatus !== "unknown") terraformKnown++;
      }
    }
  }

  return {
    totalAccounts: inv.accounts.length,
    totalResources: inv.totalResources,
    totalServices: inv.byService.length,
    terraformCoveragePct: terraformKnown > 0 ? Math.round((terraformManaged / terraformKnown) * 1000) / 10 : null,
    untaggedResources: untaggedCount,
    untaggedPct: inv.totalResources > 0 ? Math.round((untaggedCount / inv.totalResources) * 1000) / 10 : 0,
    eol: {
      amazonLinux2Count: al2Count,
      amazonLinux2EolDate: "2026-06-30",
      amazonLinux2023Count: al2023Count,
      rdsEngineEolCount: rdsEolCount,
    },
    topServices: inv.byService.slice(0, 20).map((s) => ({
      service: s.service,
      resourceCount: s.resourceCount,
      regions: s.regions,
    })),
    accounts: inv.accounts.map((a) => ({
      accountId: a.accountId,
      accountName: a.accountName,
      totalResources: a.totalResources,
    })),
  };
}

async function searchInventoryTool(args: {
  accountIds?: string[];
  serviceFamily?: string;
  resourceType?: string;
  nameContains?: string;
  tagKey?: string;
  tagValue?: string;
  limit?: number;
}) {
  const ids = await resolveAccountIds(args.accountIds);
  const inv = await getInventory(ids);
  const family = args.serviceFamily?.trim().toLowerCase();
  const rtype = args.resourceType?.trim().toLowerCase();
  const term = args.nameContains?.trim().toLowerCase();
  const tagKey = args.tagKey?.trim();
  const tagVal = args.tagValue?.trim();
  const limit = Math.max(1, Math.min(100, Math.round(args.limit ?? 30)));

  const results: any[] = [];
  for (const svc of inv.byService) {
    const svcFamilyName = (svc.serviceFamily || "").toLowerCase();
    const svcResourceType = (svc.resourceType || "").toLowerCase();
    const svcName = svc.service.toLowerCase();
    if (family && !svcFamilyName.includes(family) && !svcName.includes(family)) continue;
    if (rtype && !svcResourceType.includes(rtype) && !svcName.includes(rtype)) continue;

    for (const detail of svc.details) {
      if (term) {
        const haystack = `${detail.id} ${detail.name} ${detail.type}`.toLowerCase();
        if (!haystack.includes(term)) continue;
      }
      if (tagKey) {
        const tags = detail.tags || (detail.metadata?.tags as Record<string, string> | undefined);
        if (!tags || !(tagKey in tags)) continue;
        if (tagVal && tags[tagKey] !== tagVal) continue;
      }

      results.push({
        service: svc.service,
        accountId: detail.metadata?.accountId,
        accountName: detail.metadata?.accountName,
        region: detail.metadata?.region,
        id: detail.id,
        name: detail.name,
        type: detail.type,
        state: detail.state,
        terraformStatus: detail.terraformStatus,
        estimatedMonthlyCostUSD: typeof detail.estimatedMonthlyCost === "number" ? detail.estimatedMonthlyCost : null,
        eolFlags: {
          amazonLinux2: detail.metadata?.isAmazonLinux2 === true || undefined,
          rdsEngineEol: detail.metadata?.isEngineEol === true || undefined,
        },
        tags: detail.tags || detail.metadata?.tags || null,
      });
      if (results.length >= limit) break;
    }
    if (results.length >= limit) break;
  }

  return {
    matches: results.length,
    truncated: results.length >= limit,
    resources: results,
  };
}

// ─── CUR deep insight tools (rich Athena queries) ────────────────────────

let cachedCurDeep: { key: string; at: number; data: Awaited<ReturnType<typeof fetchCurFullSnapshot>> } | null = null;
const CUR_DEEP_CACHE_MS = 10 * 60 * 1000;

async function getCurDeep(input: { startDate?: string; endDate?: string; accountIds?: string[] }) {
  const ids = await resolveAccountIds(input.accountIds);
  const { startDate: defaultStart, endDate: defaultEnd } = defaultCurWindow();
  const startDate = input.startDate || defaultStart;
  const endDate = input.endDate || defaultEnd;
  const key = `${startDate}::${endDate}::${ids.slice().sort().join(",")}`;
  const now = Date.now();
  if (cachedCurDeep && cachedCurDeep.key === key && now - cachedCurDeep.at < CUR_DEEP_CACHE_MS) {
    return cachedCurDeep.data;
  }
  const catalog = await fetchAwsAccountCatalog();
  const nameMap = buildAwsAccountNameMap(catalog);
  const data = await fetchCurFullSnapshot(ids, startDate, endDate, nameMap);
  cachedCurDeep = { key, at: now, data };
  return data;
}

async function getHiddenCostsTool(args: { startDate?: string; endDate?: string; accountIds?: string[] }) {
  const data = await getCurDeep(args);
  return {
    period: data.window,
    totalEstimatedSavingsUSD: Math.round(
      data.hiddenCosts.gp2Volumes.estimatedSavings +
        data.hiddenCosts.extendedSupport.reduce((s, x) => s + x.monthlyCost, 0),
    ),
    findings: {
      gp2: data.hiddenCosts.gp2Volumes,
      extendedSupport: data.hiddenCosts.extendedSupport,
      cloudwatchLogs: {
        totalUSD: Math.round(data.hiddenCosts.cloudwatchLogs.totalCost),
        topGroups: data.hiddenCosts.cloudwatchLogs.topGroups.slice(0, 10),
      },
      natGateways: data.hiddenCosts.natGateways,
      bedrock: data.hiddenCosts.bedrock,
      snapshotsUSD: Math.round(data.hiddenCosts.snapshotCost),
      interZoneTransferUSD: Math.round(data.hiddenCosts.interZoneTransfer),
    },
  };
}

async function getMarketplaceChargesTool(args: { startDate?: string; endDate?: string; accountIds?: string[] }) {
  const data = await getCurDeep(args);
  return {
    period: data.window,
    totalUSD: Math.round(data.marketplace.cost),
    items: data.marketplace.items,
  };
}

async function getNetCostBreakdownTool(args: { startDate?: string; endDate?: string; accountIds?: string[] }) {
  const data = await getCurDeep(args);
  return {
    period: data.window,
    grossAwsUSD: Math.round(data.totalCost),
    marketplaceUSD: Math.round(data.marketplace.cost),
    netInfraUSD: Math.round(data.netInfraCost),
    discounts: {
      sppDiscountUSD: Math.round(data.discounts.sppDiscount),
      bundledDiscountUSD: Math.round(data.discounts.bundledDiscount),
      creditsUSD: Math.round(data.discounts.credits),
      refundsUSD: Math.round(data.discounts.refunds),
      savingsPlanNegationUSD: Math.round(data.discounts.savingsPlanNegation),
    },
    savingsPlans: {
      coveredUSD: Math.round(data.savingsPlans.coveredCost),
      onDemandEquivalentUSD: Math.round(data.savingsPlans.onDemandEquivalent),
      savingsAmountUSD: Math.round(data.savingsPlans.savingsAmount),
      savingsPct: data.savingsPlans.savingsPct,
    },
  };
}

async function getCostByDomainTool(args: { startDate?: string; endDate?: string; accountIds?: string[]; limit?: number }) {
  const data = await getCurDeep(args);
  const limit = Math.max(1, Math.min(50, Math.round(args.limit ?? 15)));
  const domains = (data.byDomain || [])
    .map((d) => ({ domain: d.domain || "(sin etiqueta)", costUSD: Math.round(d.cost * 100) / 100, resources: d.resources }))
    .sort((a, b) => b.costUSD - a.costUSD);

  const cov = data.tagCoverage;
  const coveragePct =
    cov && (cov.taggedCost + cov.untaggedCost) > 0
      ? Math.round((cov.taggedCost / (cov.taggedCost + cov.untaggedCost)) * 1000) / 10
      : null;

  return {
    period: data.window,
    tag: "user_domain",
    domains: domains.slice(0, limit),
    domainsIncluded: domains.length,
    // Honest coverage so the model never implies the whole spend is attributed.
    tagCoverage: {
      taggedUSD: cov ? Math.round(cov.taggedCost) : null,
      untaggedUSD: cov ? Math.round(cov.untaggedCost) : null,
      coveragePct,
    },
    note:
      "La cobertura del tag user_domain es parcial; los costes no etiquetados no se reparten por dominio. Expón el % de cobertura al usuario.",
  };
}

// ─── build_report tool (Iskay → Excel export) ────────────────────────────

/**
 * Allowed report sections. Each one becomes a sheet in the workbook (alongside
 * the always-present "Resumen" metadata sheet). Keep the list in sync with the
 * enum in the `build_report` JSON schema and with `validateBuildReportSpec`.
 */
const REPORT_SECTIONS = [
  "summary",
  "by_account",
  "by_service",
  "by_domain",
  "top_resources",
  "net_breakdown",
  "hidden_costs",
  "marketplace",
] as const;
type ReportSection = (typeof REPORT_SECTIONS)[number];
const REPORT_SECTION_SET = new Set<string>(REPORT_SECTIONS);

/** Friendly sheet titles per section. Stay <= 31 chars (Excel limit). */
const SHEET_NAME_BY_SECTION: Record<ReportSection, string> = {
  summary: "Resumen general",
  by_account: "Por cuenta",
  by_service: "Por servicio",
  by_domain: "Por dominio",
  top_resources: "Top recursos",
  net_breakdown: "Coste neto",
  hidden_costs: "Costes ocultos",
  marketplace: "Marketplace",
};

interface BuildReportInput {
  title: string;
  startDate: string;
  endDate: string;
  accountIds?: string[];
  sections: ReportSection[];
}

interface BuildReportResult {
  reportId: string;
  filename: string;
  sheetCount: number;
  rowCounts: Record<string, number>;
  downloadUrl: string;
}

/** Slugifies the report title for use in the filename (ASCII-safe, lowercase). */
function reportSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "informe"
  );
}

/** UTC stamp `YYYYMMDD-HHmm` used in the report filename. */
function reportTimestamp(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  return `${y}${m}${dd}-${hh}${mm}`;
}

/**
 * Validates a Report_Spec and returns the normalized input. Throws on:
 *  - missing required fields (title/startDate/endDate/sections)
 *  - non-ISO dates or startDate > endDate
 *  - sections containing values outside the allowed enum
 */
function validateBuildReportSpec(raw: Record<string, any>): BuildReportInput {
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  const startDate = typeof raw.startDate === "string" ? raw.startDate.trim() : "";
  const endDate = typeof raw.endDate === "string" ? raw.endDate.trim() : "";
  const sectionsRaw = Array.isArray(raw.sections) ? raw.sections : null;

  if (!title) throw new Error("build_report: 'title' is required");
  if (!startDate) throw new Error("build_report: 'startDate' is required");
  if (!endDate) throw new Error("build_report: 'endDate' is required");
  if (!sectionsRaw || sectionsRaw.length === 0) {
    throw new Error("build_report: 'sections' must be a non-empty array");
  }

  if (!isIsoDate(startDate)) {
    throw new Error(`build_report: invalid startDate '${startDate}', expected YYYY-MM-DD`);
  }
  if (!isIsoDate(endDate)) {
    throw new Error(`build_report: invalid endDate '${endDate}', expected YYYY-MM-DD`);
  }
  if (startDate > endDate) {
    throw new Error(
      `build_report: startDate (${startDate}) must be <= endDate (${endDate})`,
    );
  }

  const invalid = sectionsRaw.filter(
    (s: unknown) => typeof s !== "string" || !REPORT_SECTION_SET.has(s),
  );
  if (invalid.length > 0) {
    throw new Error(
      `build_report: invalid section(s) ${JSON.stringify(invalid)}. Allowed: ${REPORT_SECTIONS.join(", ")}`,
    );
  }
  // Preserve order, drop duplicates.
  const sections = [...new Set(sectionsRaw as ReportSection[])];

  let accountIds: string[] | undefined;
  if (Array.isArray(raw.accountIds) && raw.accountIds.length > 0) {
    const cleaned = (raw.accountIds as unknown[])
      .map((id) => String(id).trim())
      .filter((id) => /^\d{6,}$/.test(id));
    accountIds = cleaned.length > 0 ? cleaned : undefined;
  }

  return { title, startDate, endDate, accountIds, sections };
}

/** Per-section data fetch. Returns an Array-of-Arrays ready for `aoa_to_sheet`. */
/**
 * Per-section data fetcher seam. Each fetcher returns the same shape the
 * matching `getXxxTool` returns; `buildSectionAoa` then formats it into the
 * sheet rows. Exposing this seam lets unit tests inject deterministic fakes
 * without touching the real Athena/CUR/DB layers, while production code keeps
 * using `DEFAULT_SECTION_FETCHERS` automatically (see `BuildReportDeps`).
 */
type ReportRange = { startDate: string; endDate: string; accountIds?: string[] };
type ReportSectionFetcher = (range: ReportRange) => Promise<any>;
export type ReportSectionFetchers = Record<ReportSection, ReportSectionFetcher>;

const DEFAULT_SECTION_FETCHERS: ReportSectionFetchers = {
  summary: (range) => getTotalCostTool(range),
  by_account: (range) => getCostByAccountTool({ ...range, limit: 50 }),
  by_service: (range) => getCostByServiceTool({ ...range, limit: 50 }),
  by_domain: (range) => getCostByDomainTool({ ...range, limit: 50 }),
  top_resources: (range) => getTopResourcesTool({ ...range, limit: 100 }),
  net_breakdown: (range) => getNetCostBreakdownTool(range),
  hidden_costs: (range) => getHiddenCostsTool(range),
  marketplace: (range) => getMarketplaceChargesTool(range),
};

async function buildSectionAoa(
  section: ReportSection,
  range: ReportRange,
  fetchers: ReportSectionFetchers,
): Promise<unknown[][]> {
  switch (section) {
    case "summary": {
      const total = await fetchers.summary(range);
      return [
        ["Concepto", "Valor"],
        ["Periodo", `${total.period.startDate} → ${total.period.endDate}`],
        ["Cuentas incluidas", total.accountsIncluded],
        ["Coste total (USD)", total.totalCostUSD],
        ["Moneda", total.currency],
      ];
    }
    case "by_account": {
      const data = await fetchers.by_account(range);
      const rows: unknown[][] = [["Cuenta", "ID cuenta", "Coste (USD)"]];
      for (const a of data.accounts) {
        rows.push([a.accountName, a.accountId, a.costUSD]);
      }
      rows.push([]);
      rows.push(["Total (USD)", "", data.totalCostUSD]);
      return rows;
    }
    case "by_service": {
      const data = await fetchers.by_service(range);
      const rows: unknown[][] = [["Servicio", "Coste (USD)"]];
      for (const s of data.services) {
        // `getCostByServiceTool` already prettifies, but apply prettyServiceName
        // again defensively so no opaque id can sneak through.
        rows.push([prettyServiceName(s.service), s.costUSD]);
      }
      rows.push([]);
      rows.push(["Total (USD)", data.totalCostUSD]);
      return rows;
    }
    case "by_domain": {
      const data = await fetchers.by_domain(range);
      const rows: unknown[][] = [["Dominio", "Coste (USD)", "Recursos"]];
      for (const d of data.domains) {
        rows.push([d.domain, d.costUSD, d.resources]);
      }
      rows.push([]);
      rows.push(["Cobertura del tag user_domain"]);
      rows.push(["Etiquetado (USD)", data.tagCoverage.taggedUSD ?? "-"]);
      rows.push(["Sin etiqueta (USD)", data.tagCoverage.untaggedUSD ?? "-"]);
      rows.push(["Cobertura (%)", data.tagCoverage.coveragePct ?? "-"]);
      rows.push([data.note]);
      return rows;
    }
    case "top_resources": {
      const data = await fetchers.top_resources(range);
      const rows: unknown[][] = [
        ["Servicio", "Cuenta", "ID cuenta", "Recurso", "Coste (USD)"],
      ];
      for (const r of data.resources) {
        rows.push([
          prettyServiceName(r.service),
          r.accountName,
          r.accountId,
          r.resourceId,
          r.costUSD,
        ]);
      }
      return rows;
    }
    case "net_breakdown": {
      const data = await fetchers.net_breakdown(range);
      return [
        ["Concepto", "USD"],
        ["Bruto AWS", data.grossAwsUSD],
        ["Marketplace (separado)", data.marketplaceUSD],
        ["Coste neto infra", data.netInfraUSD],
        [],
        ["Descuentos", "USD"],
        ["SPP Discount", data.discounts.sppDiscountUSD],
        ["Bundled Discount", data.discounts.bundledDiscountUSD],
        ["Credits", data.discounts.creditsUSD],
        ["Refunds", data.discounts.refundsUSD],
        ["Savings Plan Negation", data.discounts.savingsPlanNegationUSD],
        [],
        ["Savings Plans", "USD"],
        ["Cubierto", data.savingsPlans.coveredUSD],
        ["On-demand equivalente", data.savingsPlans.onDemandEquivalentUSD],
        ["Ahorro absoluto", data.savingsPlans.savingsAmountUSD],
        ["Ahorro (%)", data.savingsPlans.savingsPct],
      ];
    }
    case "hidden_costs": {
      const data = await fetchers.hidden_costs(range);
      const f = data.findings;
      const extTotal = (f.extendedSupport || []).reduce(
        (s: number, x: any) => s + Number(x.monthlyCost || 0),
        0,
      );
      const rows: unknown[][] = [
        ["Hallazgo", "Coste / Ahorro estimado (USD)", "Detalle"],
        [
          "EBS gp2 → gp3 (ahorro estimado)",
          f.gp2.estimatedSavings,
          `${f.gp2.resourceCount} volúmenes, coste actual ${f.gp2.monthlyCost} USD`,
        ],
        [
          "RDS Extended Support",
          Math.round(extTotal),
          `${(f.extendedSupport || []).length} engines`,
        ],
        [
          "CloudWatch Logs",
          f.cloudwatchLogs.totalUSD,
          `${(f.cloudwatchLogs.topGroups || []).length} log groups top`,
        ],
        [
          "NAT Gateway",
          f.natGateways?.totalCost ?? 0,
          `data ${f.natGateways?.dataProcessedCost ?? 0} USD / hours ${f.natGateways?.hoursCost ?? 0} USD`,
        ],
        [
          "Bedrock GenAI",
          f.bedrock?.totalCost ?? 0,
          `${(f.bedrock?.byModel || []).length} modelos`,
        ],
        ["Snapshots EBS", f.snapshotsUSD, "Coste de snapshots EBS"],
        ["Tráfico inter-AZ", f.interZoneTransferUSD, "Inter-AZ data transfer"],
        [],
        ["Ahorro estimado total (USD)", data.totalEstimatedSavingsUSD],
      ];

      // Detail tables (capped) so the model never has to summarize numbers itself.
      if ((f.cloudwatchLogs.topGroups || []).length > 0) {
        rows.push([]);
        rows.push(["CloudWatch Logs — top groups"]);
        rows.push(["Log group", "Cuenta", "Coste (USD)"]);
        for (const g of f.cloudwatchLogs.topGroups.slice(0, 20)) {
          rows.push([g.logGroup, g.account, g.cost]);
        }
      }
      if ((f.natGateways?.topConsumers || []).length > 0) {
        rows.push([]);
        rows.push(["NAT Gateway — top consumers"]);
        rows.push(["Recurso", "Cuenta", "Coste (USD)"]);
        for (const n of f.natGateways.topConsumers.slice(0, 20)) {
          rows.push([n.resourceId, n.account, n.cost]);
        }
      }
      if ((f.bedrock?.byModel || []).length > 0) {
        rows.push([]);
        rows.push(["Bedrock — coste por modelo"]);
        rows.push(["Modelo", "Cuenta", "Coste (USD)"]);
        for (const b of f.bedrock.byModel.slice(0, 30)) {
          rows.push([
            prettyServiceName(b.model),
            b.accountName || b.account,
            b.cost,
          ]);
        }
      }
      if ((f.extendedSupport || []).length > 0) {
        rows.push([]);
        rows.push(["RDS Extended Support — engines"]);
        rows.push(["Engine", "Coste mensual (USD)", "Usage type"]);
        for (const e of f.extendedSupport) {
          rows.push([e.engine, e.monthlyCost, e.usageType]);
        }
      }
      return rows;
    }
    case "marketplace": {
      const data = await fetchers.marketplace(range);
      const rows: unknown[][] = [
        ["Producto / contrato", "Descripción", "Coste (USD)", "Fecha"],
      ];
      for (const it of data.items || []) {
        rows.push([
          prettyServiceName(it.productCode || ""),
          it.description || "",
          it.cost,
          it.date || "",
        ]);
      }
      rows.push([]);
      rows.push(["Total Marketplace (USD)", "", data.totalUSD, ""]);
      return rows;
    }
  }
}

/**
 * Optional injection seam for unit tests of `buildReportTool`. Defaults to the
 * real per-section executors and `saveReport` from `finops-report-store`, so
 * production callers (the dispatcher) do not need to provide deps.
 *  - `fetchers`: per-section data fetcher overrides (the test suite supplies
 *    deterministic data here so no Athena / CUR / DB call is made).
 *  - `saveReport`: persistence override; the test harness captures the buffer
 *    in-memory and returns a fixed `reportId` instead of writing to Postgres.
 */
export interface BuildReportDeps {
  fetchers?: Partial<ReportSectionFetchers>;
  saveReport?: typeof saveReport;
}

/**
 * Implementation of the `build_report` tool. It re-queries data per section
 * (NEVER trusts numbers from the model), builds the multi-sheet workbook,
 * persists the buffer in `finops_reports`, and returns enough metadata for
 * the chat layer to surface the download link.
 *
 * Per-section failures are captured into a per-sheet error note and the
 * remaining sections continue. Only when EVERY requested section fails does
 * the whole tool error out (R4.1 / R4.2).
 *
 * @param rawArgs   The Report_Spec coming from the model's tool call.
 * @param userEmail The session email of the user owning the report. Required
 *                  for `saveReport` and the download endpoint's ownership
 *                  check; the dispatcher passes it via the optional context.
 * @param deps      Optional dependency overrides used by the unit tests; in
 *                  production the call site omits it and the real fetchers /
 *                  `saveReport` are used.
 */
export async function buildReportTool(
  rawArgs: unknown,
  userEmail: string,
  deps?: BuildReportDeps,
): Promise<BuildReportResult> {
  if (!userEmail || typeof userEmail !== "string") {
    throw new Error(
      "build_report requires an authenticated userEmail context (session-bound)",
    );
  }

  const args = (typeof rawArgs === "object" && rawArgs !== null
    ? rawArgs
    : {}) as Record<string, any>;
  const spec = validateBuildReportSpec(args);

  // Resolve fetchers: deps overrides win over the real defaults so unit tests
  // can inject deterministic data without touching Athena/CUR/DB.
  const fetchers: ReportSectionFetchers = {
    ...DEFAULT_SECTION_FETCHERS,
    ...(deps?.fetchers ?? {}),
  };
  const persist = deps?.saveReport ?? saveReport;

  const wb = XLSX.utils.book_new();

  // "Resumen" sheet (always first) with informe metadata. Numbers come from
  // tool outputs only — this sheet is purely descriptive.
  const generatedAtIso = new Date().toISOString();
  const resumenAoa: unknown[][] = [
    ["Iskay — Informe FinOps"],
    [],
    ["Título", spec.title],
    ["Generado por", userEmail],
    ["Generado en (UTC)", generatedAtIso],
    ["Periodo", `${spec.startDate} → ${spec.endDate}`],
    [
      "Cuentas",
      spec.accountIds && spec.accountIds.length
        ? spec.accountIds.join(", ")
        : "(todas las cuentas activas)",
    ],
    ["Secciones solicitadas", spec.sections.join(", ")],
  ];
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet(resumenAoa),
    "Resumen",
  );

  const rowCounts: Record<string, number> = {};
  let successCount = 0;

  for (const section of spec.sections) {
    const sheetName = SHEET_NAME_BY_SECTION[section];
    let aoa: unknown[][];
    try {
      aoa = await buildSectionAoa(
        section,
        {
          startDate: spec.startDate,
          endDate: spec.endDate,
          accountIds: spec.accountIds,
        },
        fetchers,
      );
      successCount++;
    } catch (err: any) {
      const msg = err?.message || String(err);
      // Per-section failure: write an error note and continue (R4.1).
      aoa = [
        ["Sección", section],
        ["Estado", "Error al obtener datos"],
        ["Detalle", msg],
        [
          "Sugerencia",
          "Reintenta el informe en unos minutos o reduce el rango / cuentas.",
        ],
      ];
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
    // rowCounts excludes the header row so the caller sees actual data rows.
    rowCounts[section] = Math.max(0, aoa.length - 1);
  }

  // R4.2: if EVERY requested section failed, surface a hard error so the model
  // can communicate it to the user instead of delivering an empty workbook.
  if (successCount === 0) {
    throw new Error(
      "build_report: all requested sections failed to obtain data; nothing to deliver",
    );
  }

  const rawBuffer = XLSX.write(wb, {
    type: "buffer",
    bookType: "xlsx",
  }) as Buffer | Uint8Array;
  const content = Buffer.isBuffer(rawBuffer) ? rawBuffer : Buffer.from(rawBuffer);

  const filename = `iskay-report-${reportSlug(spec.title)}-${reportTimestamp()}.xlsx`;
  const reportId = await persist({
    filename,
    content,
    userEmail,
    ttlMinutes: 60,
  });

  return {
    reportId,
    filename,
    // +1 for the always-present "Resumen" metadata sheet.
    sheetCount: spec.sections.length + 1,
    rowCounts,
    downloadUrl: `/api/finops/report/${reportId}`,
  };
}

// ─── Public dispatcher -----------------------------------------------------

/**
 * Optional execution context for tools that need session-scoped data (e.g.
 * `build_report` needs the requesting user's email to persist + scope the
 * download). Existing callers can keep invoking `executeFinopsTool(name, input)`
 * without a context; only tools that explicitly require it will fail loudly
 * when it's missing.
 */
export interface FinopsToolContext {
  userEmail?: string;
}

export async function executeFinopsTool(
  name: string,
  input: unknown,
  context?: FinopsToolContext,
): Promise<unknown> {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, any>;

  switch (name) {
    case "list_accounts":
      return listAccountsTool();
    case "get_total_cost":
      return getTotalCostTool(args as CostQueryInput);
    case "get_cost_by_account":
      return getCostByAccountTool(args as CostQueryInput & { limit?: number });
    case "get_cost_by_service":
      return getCostByServiceTool(args as CostQueryInput & { limit?: number });
    case "compare_periods":
      return comparePeriodsTool(args as any);
    case "get_forecast":
      return getForecastTool(args as { months?: number });
    case "get_top_resources":
      return getTopResourcesTool(args as CostQueryInput & { limit?: number });
    case "get_daily_context":
      return getDailyContextTool();
    case "get_inventory_summary":
      return getInventorySummaryTool(args as { accountIds?: string[] });
    case "search_inventory":
      return searchInventoryTool(args as any);
    case "get_hidden_costs":
      return getHiddenCostsTool(args as { startDate?: string; endDate?: string; accountIds?: string[] });
    case "get_marketplace_charges":
      return getMarketplaceChargesTool(args as { startDate?: string; endDate?: string; accountIds?: string[] });
    case "get_net_cost_breakdown":
      return getNetCostBreakdownTool(args as { startDate?: string; endDate?: string; accountIds?: string[] });
    case "get_cost_by_domain":
      return getCostByDomainTool(args as { startDate?: string; endDate?: string; accountIds?: string[]; limit?: number });
    case "build_report": {
      // build_report needs the session userEmail (ownership + persistence).
      // Surface a clear error if the dispatcher was called without context.
      const userEmail = context?.userEmail;
      if (!userEmail) {
        throw new Error(
          "build_report requires the dispatcher to be called with a context containing userEmail (session-bound)",
        );
      }
      return buildReportTool(args, userEmail);
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
