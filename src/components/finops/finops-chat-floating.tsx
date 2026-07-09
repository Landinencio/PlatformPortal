"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import { MessageCircle, X } from "lucide-react";
import { useSession } from "next-auth/react";
import { FinOpsChat } from "@/components/finops/finops-chat";
import { hasMinimumRole, type AppRole } from "@/lib/rbac";
import { cn } from "@/lib/utils";

const BECARIO_AVATAR = "/avatars/becario-sre.png";

interface FinOpsChatFloatingProps {
  /** Optional context to show in the chat header (e.g. "2 cuentas seleccionadas"). */
  contextHint?: string;
  /** Suggestions tailored to the current page. */
  suggestions?: string[];
}

export function FinOpsChatFloating({ contextHint, suggestions }: FinOpsChatFloatingProps) {
  const [open, setOpen] = useState(false);
  const { data: session } = useSession();
  const role: AppRole = ((session?.user as any)?.appRole || "externos").toLowerCase() as AppRole;
  const canSeeChat = hasMinimumRole(role, "directores");

  // Close on Esc
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!canSeeChat) return null;

  return (
    <>
      {/* Floating launcher */}
      {!open && (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn(
            "group fixed bottom-6 right-6 z-40 flex items-center gap-3 rounded-full",
            "bg-gradient-to-br from-primary via-primary to-violet-600 text-primary-foreground",
            "px-5 py-3 shadow-2xl shadow-primary/30 ring-1 ring-white/10 backdrop-blur",
            "transition-all duration-300 hover:scale-105 hover:shadow-primary/50",
          )}
          aria-label="Abrir Iskay (FinOps)"
        >
          <span className="relative flex h-10 w-10 shrink-0 overflow-hidden rounded-full ring-2 ring-white/40">
            <Image src={BECARIO_AVATAR} alt="Iskay" fill className="object-cover" sizes="40px" />
          </span>
          <span className="hidden text-left sm:flex sm:flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80">Pregunta a</span>
            <span className="text-sm font-bold leading-tight">Iskay · FinOps</span>
          </span>
          <span className="absolute -top-1 -right-1 flex h-3 w-3">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-75" />
            <span className="relative inline-flex h-3 w-3 rounded-full bg-success" />
          </span>
        </button>
      )}

      {/* Drawer */}
      {open && (
        <>
          {/* Backdrop (click to close) */}
          <div
            className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm transition-opacity animate-in fade-in duration-200"
            onClick={() => setOpen(false)}
          />

          {/* Side drawer */}
          <div
            className={cn(
              "fixed bottom-6 right-6 top-20 z-50 flex flex-col",
              "w-full max-w-[480px] sm:right-6",
              "rounded-2xl border border-border/60 bg-card shadow-2xl",
              "animate-in slide-in-from-right duration-300",
            )}
            style={{ maxHeight: "calc(100vh - 6rem)" }}
          >
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="absolute -top-3 -right-3 z-10 flex h-8 w-8 items-center justify-center rounded-full bg-foreground text-background shadow-lg ring-2 ring-card transition hover:scale-110"
              aria-label="Cerrar"
            >
              <X className="h-4 w-4" />
            </button>
            <div className="flex-1 overflow-hidden rounded-2xl">
              <FinOpsChat embedded contextHint={contextHint} suggestions={suggestions} />
            </div>
          </div>
        </>
      )}
    </>
  );
}
