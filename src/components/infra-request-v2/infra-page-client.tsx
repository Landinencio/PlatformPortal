"use client";

import { useState } from "react";
import { InfraRequestFormV2 } from "./infra-request-form-v2";
import { ModifyInfraForm } from "./modify-infra-form";
import { SquadInfraForm } from "./squad-infra-form";
import { SquadModifyForm } from "./squad-modify-form";
import { RecentRequests } from "./recent-requests";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import Link from "next/link";
import { ExternalLink, Plus, Pencil, Boxes } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { INFRA_BUSINESS_TEAMS, BUSINESS_TEAM_LABELS } from "@/lib/team-approvers";

interface InfraPageClientProps {
  teams: string[];
  recentRequests: { id: number; resource_type: string; team: string; status: string; created_at: string }[];
}

export function InfraPageClient({ teams, recentRequests }: InfraPageClientProps) {
  const [mode, setMode] = useState<"create" | "modify" | "squad">("create");
  const [squadMode, setSquadMode] = useState<"create" | "modify">("create");

  return (
    <main className="min-h-screen flex flex-col items-center p-8">
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex items-center justify-end">
          <Link href="/infra-requests">
            <Button variant="outline" size="sm" className="gap-1.5">
              <ExternalLink className="h-4 w-4" />
              Ver solicitudes
            </Button>
          </Link>
        </div>

        <div className="text-center space-y-2 mb-4">
          <h1 className="text-3xl font-bold tracking-tight text-foreground">Infraestructura</h1>
          <p className="text-muted-foreground">
            Provisiona nuevos recursos o modifica los existentes.
          </p>
        </div>

        {/* Toggle buttons */}
        <div className="flex gap-2 justify-center flex-wrap">
          <button
            onClick={() => setMode("create")}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-all",
              mode === "create"
                ? "border-primary bg-primary/10 text-primary shadow-sm"
                : "border-border bg-background text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            )}
          >
            <Plus className="h-4 w-4" />
            Crear recurso
          </button>
          <button
            onClick={() => setMode("modify")}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-all",
              mode === "modify"
                ? "border-primary bg-primary/10 text-primary shadow-sm"
                : "border-border bg-background text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            )}
          >
            <Pencil className="h-4 w-4" />
            Modificar existente
          </button>
          <button
            onClick={() => setMode("squad")}
            className={cn(
              "flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-all",
              mode === "squad"
                ? "border-primary bg-primary/10 text-primary shadow-sm"
                : "border-border bg-background text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
            )}
          >
            <Boxes className="h-4 w-4" />
            Infra de squad
          </button>
        </div>

        {mode === "create" ? (
          <>
            <Card>
              <CardHeader>
                <CardTitle>Detalles del recurso</CardTitle>
                <CardDescription>
                  Tu solicitud será procesada automáticamente.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <InfraRequestFormV2 teams={teams} />
              </CardContent>
            </Card>
            <RecentRequests requests={recentRequests} />
          </>
        ) : mode === "modify" ? (
          <Card>
            <CardHeader>
              <CardTitle>Selecciona el recurso</CardTitle>
              <CardDescription>
                Elige el equipo, tipo de recurso y el recurso que quieres modificar.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ModifyInfraForm teams={INFRA_BUSINESS_TEAMS.map(t => BUSINESS_TEAM_LABELS[t])} />
            </CardContent>
          </Card>
        ) : (
          <Card>
            <CardHeader>
              <CardTitle>Infraestructura de squad</CardTitle>
              <CardDescription>
                Recursos del día a día (SQS, Secret, DynamoDB, SNS, EventBridge) en el repo de tu squad. Generación automática, misma aprobación por equipo.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Sub-toggle create / modify within squad infra */}
              <div className="flex gap-2">
                <button
                  onClick={() => setSquadMode("create")}
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-all",
                    squadMode === "create"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:bg-secondary/60"
                  )}
                >
                  Crear recurso
                </button>
                <button
                  onClick={() => setSquadMode("modify")}
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-all",
                    squadMode === "modify"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border bg-background text-muted-foreground hover:bg-secondary/60"
                  )}
                >
                  Modificar existente
                </button>
              </div>
              {squadMode === "create" ? <SquadInfraForm /> : <SquadModifyForm />}
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
