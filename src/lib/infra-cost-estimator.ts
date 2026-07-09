/**
 * Infrastructure cost estimator.
 * Prices are on-demand estimates for eu-west-1 in USD/month.
 */

const RDS_PRICING: Record<string, { instance: string; monthly: number; storage: number; vcpu: number; ram: string }> = {
  small:  { instance: "db.t4g.micro",  monthly: 12,  storage: 2,  vcpu: 2, ram: "1 GB"  },
  medium: { instance: "db.t4g.medium", monthly: 47,  storage: 5,  vcpu: 2, ram: "4 GB"  },
  large:  { instance: "db.t4g.large",  monthly: 95,  storage: 10, vcpu: 2, ram: "8 GB"  },
};

export interface CostEstimate {
  monthlyUsd: number;
  breakdown: string;
  details: string;
  billingWarning: string | null;
  recommendation: string | null;
  specs: string | null;
}

export function estimateInfraCost(resourceType: string, params: Record<string, any>): CostEstimate {
  const envs: string[] = params.target_environments || [];
  const envCount = envs.length || 1;
  const hasProd = envs.includes("prod");

  switch (resourceType) {
    case "rds": {
      const size = params.size || "small";
      const pricing = RDS_PRICING[size] || RDS_PRICING.small;
      const perEnv = pricing.monthly + pricing.storage;
      const prodExtra = hasProd ? pricing.monthly : 0; // Multi-AZ doubles compute
      const total = perEnv * envCount + prodExtra;

      return {
        monthlyUsd: total,
        breakdown: `${pricing.instance} \u00d7 ${envCount} env${envCount > 1 ? "s" : ""} = ~$${perEnv}/env/mes${hasProd ? " (+Multi-AZ en prod)" : ""}`,
        details: `Instancia: ${pricing.instance} (${pricing.vcpu} vCPU, ${pricing.ram} RAM). Storage: ${pricing.storage === 2 ? "20" : pricing.storage === 5 ? "50" : "100"} GB (autoscaling habilitado). Backup: 30 d\u00edas. Cifrado: activado. Password: rotaci\u00f3n autom\u00e1tica v\u00eda Secrets Manager.`,
        specs: `${pricing.instance} | ${pricing.vcpu} vCPU | ${pricing.ram} RAM | PostgreSQL 16`,
        billingWarning: "RDS factura por hora de instancia encendida + storage consumido + I/O. En prod se activa Multi-AZ (x2 compute). Performance Insights incluido en prod.",
        recommendation: size === "large"
          ? "Considera empezar con medium y escalar si es necesario. El autoscaling de storage est\u00e1 habilitado."
          : size === "medium" && envCount > 1
          ? "En dev puedes usar small (db.t4g.micro, $12/mes) para ahorrar ~$35/mes por entorno."
          : hasProd && size === "small"
          ? "Small en prod puede quedarse corto bajo carga. Monitoriza CPU y conexiones las primeras semanas."
          : null,
      };
    }

    case "s3": {
      return {
        monthlyUsd: 0,
        breakdown: `S3 bucket \u00d7 ${envCount} env${envCount > 1 ? "s" : ""}. El almacenamiento base es pr\u00e1cticamente gratuito.`,
        details: `Incluye: bloqueo de acceso p\u00fablico, cifrado AES-256. Sin lifecycle policy por defecto.`,
        specs: "S3 Standard | Cifrado AES-256 | Acceso p\u00fablico bloqueado",
        billingWarning: "\u26a0\ufe0f S3 NO es gratis. Factura por: storage ($0.023/GB/mes), requests GET ($0.0004/1000), requests PUT ($0.005/1000) y data transfer. Un uso intensivo de requests (ej. lecturas cada segundo desde un pod) puede generar costes significativos. Usa caching, reduce frecuencia de lectura y configura lifecycle policies para mover datos antiguos a S3 Glacier.",
        recommendation: "Configura lifecycle policy para expirar objetos temporales. Si vas a hacer lecturas frecuentes desde pods, usa un sidecar con cach\u00e9 local o CloudFront. Nunca montes S3 como filesystem con acceso directo por segundo.",
      };
    }

    case "lambda": {
      return {
        monthlyUsd: 0,
        breakdown: `Lambda es pay-per-use. Free tier: 1M requests + 400.000 GB-s/mes.`,
        details: `Runtime: ${params.runtime || "python3.12"}. Memory: 128 MB por defecto (configurable). Timeout: 3s por defecto.`,
        specs: `Lambda | ${params.runtime || "python3.12"} | 128 MB | Pay-per-use`,
        billingWarning: "\u26a0\ufe0f Lambda factura por: n\u00famero de invocaciones ($0.20/1M), duraci\u00f3n \u00d7 memoria asignada ($0.0000166667/GB-s) y data transfer. Una Lambda con 512 MB ejecut\u00e1ndose 1s cada segundo = ~$22/mes. Con 1 GB y 5s por invocaci\u00f3n a alta frecuencia puede dispararse r\u00e1pidamente.",
        recommendation: "Configura memory y timeout al m\u00ednimo necesario. 128 MB es suficiente para la mayor\u00eda de casos. Usa reserved concurrency para limitar ejecuciones paralelas. Monitoriza invocaciones y duraci\u00f3n en CloudWatch las primeras semanas.",
      };
    }

    case "iam_role":
      return {
        monthlyUsd: 0,
        breakdown: "IAM roles no tienen coste directo.",
        details: `Role IRSA para namespace: ${params.namespace || "N/A"}. Permisos: ${[
          params.enable_s3 && "S3",
          params.enable_secrets && "SecretsManager",
          params.enable_sqs && "SQS",
          params.enable_sns && "SNS",
          params.enable_eventbridge && "EventBridge",
          params.enable_rds && "RDS",
        ].filter(Boolean).join(", ") || "ninguno seleccionado"}.`,
        specs: `IAM Role (IRSA) | Namespace: ${params.namespace || "N/A"}`,
        billingWarning: null,
        recommendation: "Aplica el principio de m\u00ednimo privilegio. Solo activa los permisos que realmente necesites. Puedes a\u00f1adir m\u00e1s despu\u00e9s.",
      };

    default:
      return { monthlyUsd: 0, breakdown: "Tipo desconocido", details: "", specs: null, billingWarning: null, recommendation: null };
  }
}


// ── V2 Cost Estimator (granular fields for Form V2) ─────────────────────────

export interface RdsCostParams {
  instanceClass: string
  storageGb: number
  multiAz: boolean
  targetEnvironments: string[]
}

export interface CostEstimateV2 {
  monthlyCost: number
  breakdown: string
  warning?: string
  recommendation?: string
}

const RDS_INSTANCE_PRICING: Record<string, number> = {
  "db.t4g.micro": 12,
  "db.t4g.small": 25,
  "db.t4g.medium": 47,
  "db.t4g.large": 95,
}

const GP3_STORAGE_PRICE_PER_GB = 0.115

export function estimateRdsCostV2(params: RdsCostParams): CostEstimateV2 {
  const { instanceClass, storageGb, multiAz, targetEnvironments } = params
  const envCount = targetEnvironments.length || 1

  const baseComputePerEnv = RDS_INSTANCE_PRICING[instanceClass] ?? RDS_INSTANCE_PRICING["db.t4g.micro"]
  const computePerEnv = multiAz ? baseComputePerEnv * 2 : baseComputePerEnv
  const storagePerEnv = +(storageGb * GP3_STORAGE_PRICE_PER_GB).toFixed(2)
  const backupStorageCost = +(baseComputePerEnv * 0.3).toFixed(2)
  const perEnv = computePerEnv + storagePerEnv + backupStorageCost
  const total = +(perEnv * envCount).toFixed(2)

  const azLabel = multiAz ? " (Multi-AZ)" : ""
  const breakdown = `${instanceClass}${azLabel}: $${computePerEnv}/env + storage ${storageGb} GB: $${storagePerEnv}/env + backup storage: $${backupStorageCost}/env \u00d7 ${envCount} env${envCount > 1 ? "s" : ""} = ~$${total}/mes`

  const result: CostEstimateV2 = { monthlyCost: total, breakdown }

  if (multiAz) {
    result.warning = "Multi-AZ duplica el coste de c\u00f3mputo por entorno. Data transfer: $0.09/GB egress entre AZs y hacia internet."
  } else {
    result.warning = "Data transfer: $0.09/GB egress hacia internet."
  }

  if (instanceClass === "db.t4g.large" && envCount > 1) {
    result.recommendation = "Considera usar db.t4g.medium en entornos no productivos para reducir costes."
  }

  return result
}

export function estimateS3Cost(): CostEstimateV2 {
  return {
    monthlyCost: 3,
    breakdown: "S3 se factura por uso (almacenamiento + requests). Coste t\u00edpico: $1-5/mes.",
    warning: "Data transfer: $0.09/GB egress hacia internet.",
  }
}

export function estimateIamRoleCost(): CostEstimateV2 {
  return {
    monthlyCost: 0,
    breakdown: "IAM no tiene coste directo",
  }
}
