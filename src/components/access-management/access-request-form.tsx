"use client";

import { useState, useEffect, useMemo } from "react";
import { useSession } from "next-auth/react";
import { cn } from "@/lib/utils";
import { BUSINESS_TEAMS, BUSINESS_TEAM_LABELS, getApproversForTeam, isSoleApprover, type BusinessTeam } from "@/lib/team-approvers";
import { SELECTABLE_APPROVERS } from "@/lib/infra-approvers";

const PLATFORMS = [
  { value: "portal", label: "Portal" },
  { value: "aws", label: "AWS" },
  { value: "argocd", label: "ArgoCD" },
  { value: "sonarqube", label: "SonarQube" },
  { value: "gitlab", label: "GitLab" },
] as const;

/** GitLab roles — limited to Developer max */
const GITLAB_ROLES = [
  { value: "guest", label: "Guest" },
  { value: "reporter", label: "Reporter" },
  { value: "developer", label: "Developer" },
] as const;

type Platform = (typeof PLATFORMS)[number]["value"];

interface GroupOption {
  id: string;
  displayName: string;
}

export function AccessRequestForm() {
  const { data: session } = useSession();
  const userRole = (session?.user as any)?.appRole || "";

  // Only show Portal option to admin/directores
  const visiblePlatforms = useMemo(() => {
    const isAdminOrDirector = userRole === "admin" || userRole === "Admin" || userRole === "directores" || userRole === "Directores";
    if (isAdminOrDirector) return PLATFORMS;
    return PLATFORMS.filter((p) => p.value !== "portal");
  }, [userRole]);

  // Teams the user can pick from in the selector. All business teams are visible
  // to everyone (a dev from any team needs to be able to request access for their
  // own team). Only "audit" and "other" remain admin-only (handled in team-mapping).
  const visibleTeams = useMemo(() => {
    return BUSINESS_TEAMS;
  }, []);

  // Form state
  const [businessTeam, setBusinessTeam] = useState<BusinessTeam | "">("");
  /** Admin-only toggle to override the per-team group filter and see ALL groups. */
  const [showAllGroups, setShowAllGroups] = useState(false);
  const [approver, setApprover] = useState("");
  const [platform, setPlatform] = useState<Platform | "">("");
  const [targetEmail, setTargetEmail] = useState("");
  const [groups, setGroups] = useState<GroupOption[]>([]);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [selectedGroupName, setSelectedGroupName] = useState("");
  const [role, setRole] = useState("developer");

  // GitLab mode state
  const [gitlabMode, setGitlabMode] = useState<"" | "onboard" | "permissions">("");
  const [onboardAction, setOnboardAction] = useState<"alta" | "baja">("alta");

  // GitLab two-level state
  const [gitlabParentGroup, setGitlabParentGroup] = useState("");
  const [gitlabSubItems, setGitlabSubItems] = useState<GroupOption[]>([]);
  const [loadingSubItems, setLoadingSubItems] = useState(false);
  const [selectedGitlabItems, setSelectedGitlabItems] = useState<GroupOption[]>([]);

  // UI state
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Compute approver options based on selected team
  const approverOptions = useMemo(() => {
    if (!businessTeam) return [];
    if (businessTeam === "digital") {
      return SELECTABLE_APPROVERS.map((a) => ({ email: a.email, name: a.name }));
    }
    const options = getApproversForTeam(businessTeam, session?.user?.email || "");
    // One-person team exception: the sole approver of their team can self-approve
    // (otherwise self-approval prevention leaves the list empty).
    if (options.length === 0 && session?.user?.email && isSoleApprover(businessTeam, session.user.email)) {
      const local = session.user.email.split("@")[0];
      return [{
        email: session.user.email,
        name: session.user.name || local.split(".").map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join(" "),
      }];
    }
    return options;
  }, [businessTeam, session?.user?.email, session?.user?.name]);

  // Reset approver and "show all groups" toggle when team changes
  useEffect(() => {
    setApprover("");
    setShowAllGroups(false);
  }, [businessTeam]);

  // Fetch groups when platform OR team changes
  useEffect(() => {
    if (!platform) {
      setGroups([]);
      resetSelections();
      return;
    }

    // Reset gitlab mode when platform changes
    setGitlabMode("");
    setOnboardAction("alta");

    setLoadingGroups(true);
    setGroups([]);
    resetSelections();

    // Portal uses a different endpoint
    let url: string;
    if (platform === "portal") {
      url = "/api/access-management/portal-role";
    } else {
      const params = new URLSearchParams({ platform });
      // Only AWS has team-based groups today. ArgoCD and SonarQube use
      // transversal groups so the team filter does not apply on the backend
      // and we omit it on the request to make that explicit.
      const platformHasTeamGroups = platform === "aws";
      if (platformHasTeamGroups && businessTeam && !showAllGroups) {
        params.set("team", businessTeam);
      }
      url = `/api/access-management/groups?${params.toString()}`;
    }

    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch groups");
        return res.json();
      })
      .then((data) => {
        setGroups(data.groups || []);
      })
      .catch((err) => {
        console.error("Error fetching groups:", err);
        setGroups([]);
      })
      .finally(() => setLoadingGroups(false));
  }, [platform, businessTeam, showAllGroups]);

  // GitLab: fetch sub-items when parent group is selected
  useEffect(() => {
    if (platform !== "gitlab" || !gitlabParentGroup) {
      setGitlabSubItems([]);
      setSelectedGitlabItems([]);
      return;
    }

    setLoadingSubItems(true);
    setGitlabSubItems([]);
    setSelectedGitlabItems([]);

    fetch(`/api/access-management/groups?platform=gitlab&parentGroup=${gitlabParentGroup}`)
      .then((res) => {
        if (!res.ok) throw new Error("Failed to fetch sub-items");
        return res.json();
      })
      .then((data) => setGitlabSubItems(data.groups || []))
      .catch(() => setGitlabSubItems([]))
      .finally(() => setLoadingSubItems(false));
  }, [platform, gitlabParentGroup]);

  function resetSelections() {
    setSelectedGroupId("");
    setSelectedGroupName("");
    setRole("developer");
    setGitlabParentGroup("");
    setGitlabSubItems([]);
    setSelectedGitlabItems([]);
  }

  const handleGroupChange = (groupId: string) => {
    setSelectedGroupId(groupId);
    const group = groups.find((g) => g.id === groupId);
    setSelectedGroupName(group?.displayName || "");
  };

  const toggleGitlabItem = (item: GroupOption) => {
    setSelectedGitlabItems((prev) => {
      const exists = prev.find((i) => i.id === item.id);
      if (exists) return prev.filter((i) => i.id !== item.id);
      return [...prev, item];
    });
  };

  // Form validation
  const isFormValid = (): boolean => {
    // Portal mode: no team/approver needed
    if (platform === "portal") {
      return targetEmail !== "" && selectedGroupId !== "";
    }

    if (!businessTeam || !approver) return false;
    if (!platform) return false;

    if (platform === "gitlab") {
      if (!gitlabMode) return false;

      if (gitlabMode === "onboard") {
        // Onboard/offboard mode: only need target email
        return targetEmail !== "";
      }

      // Permissions mode: need email + area + projects + role
      return targetEmail !== "" && gitlabParentGroup !== "" && selectedGitlabItems.length > 0 && role !== "";
    }

    // Non-gitlab platforms
    if (!targetEmail) return false;
    return selectedGroupId !== "";
  };

  // Handle form submission
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isFormValid()) return;

    setSubmitting(true);
    setError(null);
    setSuccess(false);

    try {
      if (platform === "portal") {
        // Portal: direct execution, no approval needed
        const payload = {
          targetUserEmail: targetEmail,
          role: selectedGroupId, // groupId is the role name for portal
        };

        const res = await fetch("/api/access-management/portal-role", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!res.ok) {
          const data = await res.json();
          throw new Error(data.error || "Error al asignar el rol");
        }
      } else if (platform === "gitlab" && gitlabMode === "onboard") {
        // GitLab onboard/offboard mode
        const payload = {
          platform,
          targetUserEmail: targetEmail,
          requestType: onboardAction === "alta" ? "onboard" : "offboard",
          businessTeam,
          approverEmail: approver,
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
      } else if (platform === "gitlab" && selectedGitlabItems.length > 0) {
        // GitLab multi-select: submit one request per selected item
        for (const item of selectedGitlabItems) {
          const payload = {
            platform,
            targetUserEmail: targetEmail,
            requestType: "grant",
            groupId: item.id,
            groupName: item.displayName,
            role,
            businessTeam,
            approverEmail: approver,
          };

          const res = await fetch("/api/access-management/request", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });

          if (!res.ok) {
            const data = await res.json();
            throw new Error(data.error || `Error para ${item.displayName}`);
          }
        }
      } else {
        // Single request (Azure AD platforms)
        const payload = {
          platform,
          targetUserEmail: targetEmail,
          requestType: "grant",
          groupId: selectedGroupId,
          groupName: selectedGroupName,
          businessTeam,
          approverEmail: approver,
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
      }

      setSuccess(true);
      setBusinessTeam("");
      setApprover("");
      setPlatform("");
      setTargetEmail("");
      setGitlabMode("");
      setOnboardAction("alta");
      resetSelections();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error desconocido");
    } finally {
      setSubmitting(false);
    }
  };

  const isGitlab = platform === "gitlab";

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Team selector — hidden for Portal (no approval needed) */}
      {platform !== "portal" && (
      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">Equipo</label>
        <select
          value={businessTeam}
          onChange={(e) => setBusinessTeam(e.target.value as BusinessTeam | "")}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          <option value="">Selecciona un equipo</option>
          {visibleTeams.map((t) => (
            <option key={t} value={t}>{BUSINESS_TEAM_LABELS[t]}</option>
          ))}
        </select>
        {/* Admin-only: override the per-team filter and show all groups (only aws filters by team) */}
        {(userRole === "admin" || userRole === "Admin" || userRole === "directores" || userRole === "Directores") && businessTeam && platform === "aws" && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={showAllGroups}
              onChange={(e) => setShowAllGroups(e.target.checked)}
              className="h-3.5 w-3.5 rounded border-border"
            />
            Mostrar todos los grupos sin filtrar por equipo (admin)
          </label>
        )}
      </div>
      )}

      {/* Platform selector */}
      <div className="space-y-2">
        <label className="block text-sm font-medium text-foreground">Plataforma</label>
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value as Platform | "")}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          <option value="">Selecciona una plataforma</option>
          {visiblePlatforms.map((p) => (
            <option key={p.value} value={p.value}>{p.label}</option>
          ))}
        </select>
      </div>

      {/* GitLab mode selector */}
      {isGitlab && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">Modo</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => { setGitlabMode("onboard"); setTargetEmail(""); resetSelections(); }}
              className={cn(
                "rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                gitlabMode === "onboard"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-foreground hover:bg-secondary/60"
              )}
            >
              Altas / Bajas
            </button>
            <button
              type="button"
              onClick={() => { setGitlabMode("permissions"); setTargetEmail(""); resetSelections(); }}
              className={cn(
                "rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                gitlabMode === "permissions"
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-foreground hover:bg-secondary/60"
              )}
            >
              Permisos
            </button>
          </div>
        </div>
      )}

      {/* GitLab onboard mode: Alta/Baja selector */}
      {isGitlab && gitlabMode === "onboard" && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">Acción</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setOnboardAction("alta")}
              className={cn(
                "rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                onboardAction === "alta"
                  ? "border-green-500 bg-green-50 text-green-700 dark:border-green-400 dark:bg-green-950/30 dark:text-green-300"
                  : "border-border bg-background text-foreground hover:bg-secondary/60"
              )}
            >
              Alta
            </button>
            <button
              type="button"
              onClick={() => setOnboardAction("baja")}
              className={cn(
                "rounded-md border px-3 py-2 text-sm font-medium transition-colors",
                onboardAction === "baja"
                  ? "border-red-500 bg-red-50 text-red-700 dark:border-red-400 dark:bg-red-950/30 dark:text-red-300"
                  : "border-border bg-background text-foreground hover:bg-secondary/60"
              )}
            >
              Baja
            </button>
          </div>
        </div>
      )}

      {/* Target user email — shown for onboard mode or permissions mode */}
      {isGitlab && gitlabMode === "onboard" && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">Email del usuario</label>
          <input
            type="email"
            value={targetEmail}
            onChange={(e) => setTargetEmail(e.target.value)}
            placeholder="usuario@iskaypet.com"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <p className="text-xs text-muted-foreground">
            {onboardAction === "alta"
              ? "El usuario será dado de alta en GitLab (grupo Azure AD + webhook de onboarding)."
              : "El usuario será dado de baja de GitLab (se eliminará del grupo Azure AD)."}
          </p>
        </div>
      )}

      {/* Target user email — for non-gitlab platforms or gitlab permissions mode */}
      {platform && !isGitlab && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">Email del usuario</label>
          <input
            type="email"
            value={targetEmail}
            onChange={(e) => setTargetEmail(e.target.value)}
            placeholder="usuario@iskaypet.com"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          {platform === "portal" && (
            <p className="text-xs text-muted-foreground">
              El rol se asignará directamente sin necesidad de aprobación.
            </p>
          )}
        </div>
      )}

      {isGitlab && gitlabMode === "permissions" && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">Email del usuario</label>
          <input
            type="email"
            value={targetEmail}
            onChange={(e) => setTargetEmail(e.target.value)}
            placeholder="usuario@iskaypet.com"
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          <p className="text-xs text-muted-foreground">
            Si el usuario no existe en GitLab, se creará automáticamente y se le asignará una licencia.
          </p>
        </div>
      )}

      {/* Group selector — Azure AD platforms (single level) */}
      {platform && !isGitlab && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            {platform === "portal"
              ? "Rol"
              : platform === "argocd"
              ? "ApplicationSet"
              : "Grupo"}
          </label>
          {platform === "argocd" && (
            <p className="text-xs text-muted-foreground -mt-1">
              Cada ApplicationSet agrupa los servicios de un mismo dominio (oms, marketplace, websites, …). Tendrás permisos de admin solo dentro del AppSet seleccionado.
            </p>
          )}
          {loadingGroups ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <span className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
              {platform === "portal"
                ? "Cargando roles..."
                : platform === "argocd"
                ? "Cargando ApplicationSets..."
                : "Cargando grupos..."}
            </div>
          ) : (
            <select
              value={selectedGroupId}
              onChange={(e) => handleGroupChange(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">
                {platform === "portal"
                  ? "Selecciona un rol"
                  : platform === "argocd"
                  ? "Selecciona un ApplicationSet"
                  : "Selecciona un grupo"}
              </option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {platform === "argocd"
                    ? g.displayName.replace(/^ArgoCD[_ ]/, "")
                    : g.displayName}
                </option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* GitLab: Level 1 — Area selector (permissions mode only) */}
      {platform && isGitlab && gitlabMode === "permissions" && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">Área</label>
          {loadingGroups ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <span className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
              Cargando áreas...
            </div>
          ) : (
            <select
              value={gitlabParentGroup}
              onChange={(e) => setGitlabParentGroup(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            >
              <option value="">Selecciona un área</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>{g.displayName}</option>
              ))}
            </select>
          )}
        </div>
      )}

      {/* GitLab: Level 2 — Multi-select projects/subgroups (permissions mode only) */}
      {isGitlab && gitlabMode === "permissions" && gitlabParentGroup && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">
            Proyectos / Subgrupos
            {selectedGitlabItems.length > 0 && (
              <span className="ml-2 text-xs text-primary font-normal">
                ({selectedGitlabItems.length} seleccionados)
              </span>
            )}
          </label>
          {loadingSubItems ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
              <span className="animate-spin h-4 w-4 border-2 border-primary border-t-transparent rounded-full" />
              Cargando proyectos...
            </div>
          ) : gitlabSubItems.length === 0 ? (
            <p className="text-sm text-muted-foreground py-2">No hay proyectos disponibles</p>
          ) : (
            <div className="max-h-60 overflow-y-auto rounded-md border border-border bg-background p-2 space-y-1">
              {gitlabSubItems.map((item) => {
                const isSelected = selectedGitlabItems.some((i) => i.id === item.id);
                return (
                  <label
                    key={item.id}
                    className={cn(
                      "flex items-center gap-2 rounded-md px-3 py-2 text-sm cursor-pointer transition-colors",
                      isSelected ? "bg-primary/10 text-primary" : "hover:bg-secondary/60 text-foreground"
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => toggleGitlabItem(item)}
                      className="rounded border-border"
                    />
                    <span>{item.displayName}</span>
                  </label>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Role selector (GitLab permissions mode only) */}
      {isGitlab && gitlabMode === "permissions" && (
        <div className="space-y-2">
          <label className="block text-sm font-medium text-foreground">Rol</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value)}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            {GITLAB_ROLES.map((r) => (
              <option key={r.value} value={r.value}>{r.label}</option>
            ))}
          </select>
        </div>
      )}

      {/* Approver selector — hidden for Portal (no approval needed) */}
      {businessTeam && platform !== "portal" && (
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
          : platform === "portal"
          ? "Asignar rol"
          : isGitlab && gitlabMode === "onboard"
          ? onboardAction === "alta"
            ? "Solicitar alta"
            : "Solicitar baja"
          : isGitlab && selectedGitlabItems.length > 1
          ? `Solicitar acceso a ${selectedGitlabItems.length} proyectos`
          : "Solicitar acceso"}
      </button>

      {/* Success message */}
      {success && (
        <div className="rounded-md border border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30 p-4 text-sm text-green-800 dark:text-green-200">
          ✅ Solicitud enviada correctamente. Está pendiente de aprobación.
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
