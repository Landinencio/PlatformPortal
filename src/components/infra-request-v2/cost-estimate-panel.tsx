"use client"

import { useMemo } from "react"
import { AlertTriangle, Lightbulb, DollarSign } from "lucide-react"
import { Card, CardContent, CardHeader } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  estimateRdsCostV2,
  estimateS3Cost,
  estimateIamRoleCost,
  type CostEstimateV2,
} from "@/lib/infra-cost-estimator"

// ── Props ────────────────────────────────────────────────────────────────────

export interface CostEstimatePanelProps {
  resourceType: "rds" | "s3" | "iam_role" | null
  rdsInstanceClass?: string
  rdsStorageGb?: number
  rdsMultiAz?: boolean
  targetEnvironments: string[]
}

// ── Component ────────────────────────────────────────────────────────────────

export function CostEstimatePanel({
  resourceType,
  rdsInstanceClass = "db.t4g.micro",
  rdsStorageGb = 20,
  rdsMultiAz = false,
  targetEnvironments,
}: CostEstimatePanelProps) {
  const estimate = useMemo<CostEstimateV2 | null>(() => {
    if (!resourceType || targetEnvironments.length === 0) return null

    switch (resourceType) {
      case "rds":
        return estimateRdsCostV2({
          instanceClass: rdsInstanceClass,
          storageGb: rdsStorageGb,
          multiAz: rdsMultiAz,
          targetEnvironments,
        })
      case "s3":
        return estimateS3Cost()
      case "iam_role":
        return estimateIamRoleCost()
      default:
        return null
    }
  }, [resourceType, rdsInstanceClass, rdsStorageGb, rdsMultiAz, targetEnvironments])

  if (!estimate) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-emerald-600" />
          <span className="text-sm font-medium">Estimación de coste</span>
          <Badge variant="outline" className="text-emerald-600 border-emerald-300">
            ~${estimate.monthlyCost.toFixed(2)}/mes
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-xs text-muted-foreground">{estimate.breakdown}</p>

        {estimate.warning && (
          <div className="flex items-start gap-2 rounded-md bg-amber-50 dark:bg-amber-950/30 p-2 text-xs text-amber-700 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{estimate.warning}</span>
          </div>
        )}

        {estimate.recommendation && (
          <div className="flex items-start gap-2 rounded-md bg-blue-50 dark:bg-blue-950/30 p-2 text-xs text-blue-700 dark:text-blue-400">
            <Lightbulb className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>{estimate.recommendation}</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
