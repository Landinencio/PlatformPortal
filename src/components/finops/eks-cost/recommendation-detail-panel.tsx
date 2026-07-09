"use client";

/**
 * RecommendationDetailPanel — slide-over detail for a single EKS Cost
 * `Recommendation`.
 *
 * Shows the ready-to-copy `resources:` block (`recommendation.unitYamlBlock`)
 * in a `<pre>` block, a Copy button that writes the YAML to the system
 * clipboard via `navigator.clipboard.writeText()`, and the one-line
 * human-readable reason (`recommendation.reason`).
 *
 * The panel is rendered as a shadcn/ui `Sheet` (slide-over from the right on
 * desktop, full-width sheet on mobile via the responsive `sm:max-w-lg`
 * width). Controlled component: the parent owns the `open` state and the
 * currently selected `recommendation` (null when nothing is selected).
 *
 * After a successful copy the button briefly shows "Copiado" (2s) via a
 * local state timer.
 *
 * Validates: Requirements 5.6, 10.3.
 */

import { useEffect, useState } from "react";
import { Check, ClipboardCopy } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import type { Recommendation } from "@/lib/eks-cost/types";
import { prettySquadName } from "./theme";

export interface RecommendationDetailPanelProps {
  recommendation: Recommendation | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Human-readable label for each `RecommendationKind`, shown in the sheet
 * title next to the workload name.
 */
const KIND_LABEL: Record<Recommendation["kind"], string> = {
  "over-cpu": "Sobre-provisionado (CPU)",
  "over-mem": "Sobre-provisionado (Memoria)",
  "under-cpu": "Infra-provisionado (CPU)",
  "under-mem": "Infra-provisionado (Memoria)",
};

export function RecommendationDetailPanel({
  recommendation,
  open,
  onOpenChange,
}: RecommendationDetailPanelProps) {
  const [copied, setCopied] = useState(false);

  // Reset the "Copiado" state whenever the panel closes or the selected
  // recommendation changes, so the next open starts from a clean button.
  useEffect(() => {
    if (!open) setCopied(false);
  }, [open, recommendation]);

  // Auto-reset the "Copiado" indicator after a short delay so the button
  // returns to its default state without user intervention.
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  async function handleCopy() {
    if (!recommendation) return;
    try {
      await navigator.clipboard.writeText(recommendation.unitYamlBlock);
      setCopied(true);
    } catch {
      // Swallow: clipboard write can fail on insecure contexts or when the
      // permission is denied. The UI simply won't show the "Copiado" state.
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        {recommendation && (
          <>
            <SheetHeader>
              <SheetTitle>
                {recommendation.namespace}/{recommendation.workload}
              </SheetTitle>
              <SheetDescription>
                {KIND_LABEL[recommendation.kind]} · {recommendation.cluster} ·{" "}
                {prettySquadName(recommendation.squad)}
              </SheetDescription>
            </SheetHeader>

            <div className="mt-4 space-y-4 overflow-y-auto">
              <p className="text-sm text-muted-foreground">
                {recommendation.reason}
              </p>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                    Bloque de configuración
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant={copied ? "secondary" : "outline"}
                    onClick={handleCopy}
                    aria-label="Copiar bloque YAML al portapapeles"
                  >
                    {copied ? (
                      <>
                        <Check className="mr-2 h-4 w-4" />
                        Copiado
                      </>
                    ) : (
                      <>
                        <ClipboardCopy className="mr-2 h-4 w-4" />
                        Copiar
                      </>
                    )}
                  </Button>
                </div>
                <pre className="rounded-md border bg-muted/40 p-3 text-xs font-mono leading-relaxed text-foreground overflow-x-auto whitespace-pre">
                  {recommendation.unitYamlBlock}
                </pre>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
