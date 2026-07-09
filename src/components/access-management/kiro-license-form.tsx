"use client";

import { useState, useEffect, useMemo } from "react";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { BUSINESS_TEAMS, BUSINESS_TEAM_LABELS, getApproversForTeam, isSoleApprover, type BusinessTeam } from "@/lib/team-approvers";
import { SELECTABLE_APPROVERS } from "@/lib/infra-approvers";

export function KiroLicenseForm() {
  const { data: session } = useSession();

  const [businessTeam, setBusinessTeam] = useState<BusinessTeam | "">("");
  const [approver, setApprover] = useState("");
  const [licenses, setLicenses] = useState<string[]>([""]);
  const [requestMode, setRequestMode] = useState<"new" | "upgrade">("new");
  const [plan, setPlan] = useState<"pro" | "pro-plus" | "power">("pro");
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const KIRO_PLANS = [
    { id: "pro" as const, name: "Kiro Pro", price: "$20/mes", credits: "1.000 créditos" },
    { id: "pro-plus" as const, name: "Kiro Pro+", price: "$40/mes", credits: "2.000 créditos" },
    { id: "power" as const, name: "Kiro Power", price: "$200/mes", credits: "10.000 créditos" },
  ];

  // All plans available for both new and upgrade (can upgrade or downgrade)
  const availablePlans = KIRO_PLANS;

  // Reset plan when switching mode
  const handleModeChange = (mode: "new" | "upgrade") => {
    setRequestMode(mode);
    if (mode === "upgrade") {
      setPlan("pro-plus");
    } else {
      setPlan("pro");
    }
  };

  // Kiro license approvers for digital team (restricted list)
  const KIRO_DIGITAL_APPROVERS = [
    { email: "vanessa.lopez@iskaypet.com", name: "Vanessa López" },
    { email: "ruben.landin@emefinpetcare.com", name: "Rubén Landín" },
    { email: "jesus.furio@emefinpetcare.com", name: "Jesús Furió" },
  ];

  // Compute approver options based on selected team
  const approverOptions = useMemo(() => {
    if (!businessTeam) return [];
    if (businessTeam === "digital") {
      return KIRO_DIGITAL_APPROVERS;
    }
    const options = getApproversForTeam(businessTeam, session?.user?.email || "");
    // One-person team exception: if the requester is the SOLE approver of their team,
    // self-approval prevention would otherwise leave the list empty. Offer themselves.
    if (options.length === 0 && session?.user?.email && isSoleApprover(businessTeam, session.user.email)) {
      const local = session.user.email.split("@")[0];
      return [{
        email: session.user.email,
        name: session.user.name || local.split(".").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" "),
      }];
    }
    return options;
  }, [businessTeam, session?.user?.email, session?.user?.name]);

  // Reset approver when team changes
  useEffect(() => {
    setApprover("");
  }, [businessTeam]);

  const addLicenseRow = () => {
    setLicenses((prev) => [...prev, ""]);
  };

  const removeLicenseRow = (index: number) => {
    setLicenses((prev) => prev.filter((_, i) => i !== index));
  };

  const updateLicense = (index: number, value: string) => {
    setLicenses((prev) => prev.map((v, i) => (i === index ? value : v)));
  };

  const validEmails = licenses.filter((e) => e.trim() && e.includes("@"));

  const isFormValid = (): boolean => {
    return !!businessTeam && !!approver && validEmails.length > 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid()) return;

    setSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      const selectedPlan = KIRO_PLANS.find((p) => p.id === plan)!;
      const payload = {
        platform: "kiro",
        targetUserEmail: validEmails.join(", "),
        requestType: "kiro-license",
        businessTeam,
        approverEmail: approver,
        licenseCount: validEmails.length,
        licenseEmails: validEmails,
        kiroPlan: plan,
        kiroPlanName: selectedPlan.name,
        kiroPlanPrice: selectedPlan.price,
        kiroPlanCredits: selectedPlan.credits,
        kiroRequestMode: requestMode,
      };

      const res = await fetch("/api/access-management/request", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Error al enviar la solicitud");
      }

      setSuccess(true);
      setBusinessTeam("");
      setApprover("");
      setLicenses([""]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Header with Kiro branding */}
      <div className="flex items-center gap-3 p-4 rounded-xl border border-border bg-gradient-to-r from-violet-50/50 to-blue-50/50 dark:from-violet-950/20 dark:to-blue-950/20">
        <img src="/kiro-logo.png" alt="Kiro" className="h-10 w-10 rounded-lg" />
        <div>
          <h3 className="text-sm font-semibold text-foreground">Licencias Kiro IDE</h3>
          <p className="text-xs text-muted-foreground">
            Solicita nuevas licencias o upgrades de plan para tu equipo.
          </p>
        </div>
      </div>

      {/* Request mode selector */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">Tipo de solicitud</label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleModeChange("new")}
            className={cn(
              "flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition-all",
              requestMode === "new"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted/50"
            )}
          >
            Nueva licencia
          </button>
          <button
            type="button"
            onClick={() => handleModeChange("upgrade")}
            className={cn(
              "flex-1 rounded-lg border px-4 py-2.5 text-sm font-medium transition-all",
              requestMode === "upgrade"
                ? "border-primary bg-primary/10 text-primary"
                : "border-border text-muted-foreground hover:bg-muted/50"
            )}
          >
            Cambio de plan
          </button>
        </div>
      </div>

      {/* Plan selector */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">Plan</label>
        <div className={cn("grid gap-3", availablePlans.length === 3 ? "grid-cols-1 md:grid-cols-3" : "grid-cols-1 md:grid-cols-2")}>
          {availablePlans.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPlan(p.id)}
              className={cn(
                "rounded-lg border p-4 text-left transition-all",
                plan === p.id
                  ? "border-primary bg-primary/5 ring-2 ring-primary/20"
                  : "border-border hover:border-primary/40 hover:bg-muted/30"
              )}
            >
              <div className="text-xs font-semibold text-foreground">{p.name}</div>
              <div className="text-lg font-bold text-primary mt-1">{p.price}</div>
              <div className="text-[11px] text-muted-foreground mt-1">{p.credits}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Team selector */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">Equipo</label>
        <select
          value={businessTeam}
          onChange={(e) => setBusinessTeam(e.target.value as BusinessTeam | "")}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          <option value="">Selecciona un equipo</option>
          {BUSINESS_TEAMS.map((t) => (
            <option key={t} value={t}>{BUSINESS_TEAM_LABELS[t]}</option>
          ))}
        </select>
      </div>

      {/* License emails */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">
          Usuarios que necesitan licencia
          {validEmails.length > 0 && (
            <span className="ml-2 text-xs text-primary font-normal">
              ({validEmails.length} {validEmails.length === 1 ? "licencia" : "licencias"})
            </span>
          )}
        </label>
        <div className="space-y-2">
          {licenses.map((email, index) => (
            <div key={index} className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => updateLicense(index, e.target.value)}
                placeholder="usuario@iskaypet.com"
                className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
              {licenses.length > 1 && (
                <button
                  type="button"
                  onClick={() => removeLicenseRow(index)}
                  className="rounded-md border border-border px-2.5 py-2 text-sm text-muted-foreground hover:text-destructive hover:border-destructive/50 transition-colors"
                >
                  ✕
                </button>
              )}
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={addLicenseRow}
          className="text-xs text-primary hover:text-primary/80 font-medium transition-colors"
        >
          + Añadir otro usuario
        </button>
      </div>

      {/* Approver selector */}
      {businessTeam && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">Aprobador</label>
          {approverOptions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No hay aprobadores disponibles para este equipo</p>
          ) : (
            <select
              value={approver}
              onChange={(e) => setApprover(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">Selecciona un aprobador</option>
              {approverOptions.map((a) => (
                <option key={a.email} value={a.email}>{a.name}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* Submit button */}
      <button
        type="submit"
        disabled={!isFormValid() || submitting}
        className={cn(
          "w-full rounded-md px-4 py-2.5 text-sm font-medium text-white transition-colors",
          isFormValid() && !submitting
            ? "bg-primary hover:bg-primary/90 cursor-pointer"
            : "bg-primary/50 cursor-not-allowed"
        )}
      >
        {submitting
          ? "Enviando solicitud..."
          : requestMode === "upgrade"
          ? `Solicitar cambio a ${KIRO_PLANS.find(p => p.id === plan)?.name || "Kiro"} (${validEmails.length} usuario${validEmails.length !== 1 ? "s" : ""})`
          : `Solicitar ${validEmails.length || ""} licencia${validEmails.length !== 1 ? "s" : ""} ${KIRO_PLANS.find(p => p.id === plan)?.name || "Kiro"}`}
      </button>

      {/* Success message */}
      {success && (
        <div className="rounded-md border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30 p-4 text-sm text-green-800 dark:text-green-200">
          ✅ Solicitud de licencias enviada correctamente. Está pendiente de aprobación.
        </div>
      )}

      {/* Error message */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 dark:border-red-800 dark:bg-red-950/30 p-4 text-sm text-red-800 dark:text-red-200">
          ❌ {error}
        </div>
      )}
    </form>
  );
}
