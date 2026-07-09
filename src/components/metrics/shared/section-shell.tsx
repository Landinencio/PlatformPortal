"use client";

import { Card, CardContent } from "@/components/ui/card";
import { DoraSectionSkeleton } from "./skeleton-card";

export function SectionShell({
  title,
  description,
  loading,
  error,
  children,
  skeleton,
  actions,
}: {
  title: string;
  description: string;
  loading: boolean;
  error: string | null;
  children: React.ReactNode;
  skeleton?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h2 className="font-display text-2xl font-semibold tracking-tight">{title}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>

      {loading ? (
        skeleton || <DoraSectionSkeleton />
      ) : error ? (
        <Card className="border-danger/30 bg-danger/5">
          <CardContent className="py-8 text-sm text-danger">{error}</CardContent>
        </Card>
      ) : (
        <div className="animate-in fade-in duration-300 space-y-6">
          {children}
        </div>
      )}
    </div>
  );
}
