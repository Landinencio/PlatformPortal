"use client";

import { ReactNode, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

interface FinOpsSectionProps {
  title: string;
  description?: string;
  icon?: ReactNode;
  defaultOpen?: boolean;
  badge?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Show as elevated section (default) or inline subgroup */
  variant?: "default" | "subtle";
}

export function FinOpsSection({
  title,
  description,
  icon,
  defaultOpen = false,
  badge,
  children,
  className,
  variant = "default",
}: FinOpsSectionProps) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      className={cn(
        "rounded-2xl border transition-all",
        variant === "default"
          ? "border-border/60 bg-card shadow-sm"
          : "border-border/40 bg-card/40",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={cn(
          "flex w-full items-center justify-between gap-4 px-5 py-4 text-left transition-colors",
          open && "border-b border-border/50",
        )}
      >
        <div className="flex items-center gap-3 min-w-0">
          {icon && <div className="shrink-0 text-primary">{icon}</div>}
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="text-base font-semibold text-foreground">{title}</h3>
              {badge}
            </div>
            {description && (
              <p className="mt-0.5 text-xs text-muted-foreground line-clamp-1">{description}</p>
            )}
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-2 text-xs text-muted-foreground">
          <span>{open ? "Ocultar" : "Mostrar"}</span>
          {open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
        </div>
      </button>
      {open && <div className="p-5 space-y-4">{children}</div>}
    </section>
  );
}
