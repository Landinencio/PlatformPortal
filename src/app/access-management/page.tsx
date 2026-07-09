"use client";

import { useState } from "react";
import { AccessRequestForm } from "@/components/access-management/access-request-form";
import { KiroLicenseForm } from "@/components/access-management/kiro-license-form";
import { cn } from "@/lib/utils";

export default function AccessManagementPage() {
  const [view, setView] = useState<"access" | "kiro">("access");

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold">Gestión de Accesos</h1>
          <p className="text-muted-foreground mt-1">
            {view === "access"
              ? "Solicita acceso a plataformas corporativas. Requiere aprobación."
              : "Solicita licencias de Kiro para tu equipo."}
          </p>
        </div>
      </div>

      {/* Toggle buttons */}
      <div className="flex gap-2 mb-8">
        <button
          onClick={() => setView("access")}
          className={cn(
            "flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-all",
            view === "access"
              ? "border-primary bg-primary/10 text-primary shadow-sm"
              : "border-border bg-background text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          )}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          Accesos a plataformas
        </button>
        <button
          onClick={() => setView("kiro")}
          className={cn(
            "flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm font-medium transition-all",
            view === "kiro"
              ? "border-primary bg-primary/10 text-primary shadow-sm"
              : "border-border bg-background text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
          )}
        >
          <img src="/kiro-logo.png" alt="Kiro" className="h-4 w-4 rounded-sm" />
          Licencias Kiro
        </button>
      </div>

      {view === "access" ? <AccessRequestForm /> : <KiroLicenseForm />}
    </div>
  );
}
