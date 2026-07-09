"use client";

import { Database, HardDrive, Shield, DollarSign, Globe } from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { ConversationMessage, TerraformPreview } from "@/lib/infra-agent";

interface ConversationReviewProps {
  conversation: ConversationMessage[];
  terraformPreview: TerraformPreview | null;
}

const RESOURCE_ICONS: Record<string, typeof Database> = {
  rds: Database,
  s3: HardDrive,
  iam_role: Shield,
};

const RESOURCE_LABELS: Record<string, string> = {
  rds: "Base de datos PostgreSQL (RDS)",
  s3: "Bucket S3",
  iam_role: "IAM Role (IRSA)",
};

export function ConversationReview({
  conversation,
  terraformPreview,
}: ConversationReviewProps) {
  if (!terraformPreview) return null;

  const { resourceType, resourceName, targetEnvironments, filePath, estimatedCostMonthly } = terraformPreview;
  const Icon = RESOURCE_ICONS[resourceType] || Database;
  const label = RESOURCE_LABELS[resourceType] || resourceType.toUpperCase();

  return (
    <Card className="border-border/70 mt-3">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <div className="rounded-lg bg-primary/10 p-2">
            <Icon className="h-5 w-5 text-primary" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{label}</p>
            <p className="text-xs text-muted-foreground">Resumen de la solicitud</p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Summary table */}
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <tbody>
              <SummaryRow label="Recurso" value={resourceName} />
              <SummaryRow label="Tipo" value={label} />
              <SummaryRow
                label="Entornos"
                value={
                  <div className="flex gap-1.5 flex-wrap">
                    {targetEnvironments.map((env) => (
                      <Badge key={env} variant="outline" className="text-[10px] capitalize">
                        <Globe className="h-2.5 w-2.5 mr-1" />
                        {env}
                      </Badge>
                    ))}
                  </div>
                }
              />
              <SummaryRow
                label="Archivo Terraform"
                value={
                  <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">
                    {filePath}
                  </span>
                }
              />
              {estimatedCostMonthly !== null && estimatedCostMonthly > 0 && (
                <SummaryRow
                  label="Coste estimado"
                  value={
                    <Badge variant="outline" className="text-emerald-600 border-emerald-300 gap-1">
                      <DollarSign className="h-3 w-3" />
                      ~${estimatedCostMonthly.toFixed(2)}/mes
                    </Badge>
                  }
                />
              )}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function SummaryRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-3 py-2.5 text-xs font-medium text-muted-foreground whitespace-nowrap w-[140px] bg-muted/30">
        {label}
      </td>
      <td className="px-3 py-2.5 text-sm text-foreground">
        {value}
      </td>
    </tr>
  );
}
