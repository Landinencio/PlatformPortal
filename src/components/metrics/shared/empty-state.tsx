"use client";

import { Inbox } from "lucide-react";
import { cn } from "@/lib/utils";

export function EmptyState({
  message,
  icon: Icon = Inbox,
  action,
}: {
  message: string;
  icon?: React.ComponentType<{ className?: string }>;
  action?: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-border/70 bg-background/70 px-6 py-10 text-center">
      <Icon className="mx-auto h-10 w-10 text-muted-foreground/40 mb-3" />
      <p className="text-sm text-muted-foreground">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
