"use client";

import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

interface ErrorCardProps {
  message?: string;
  onRetry: () => void;
}

export function ErrorCard({ message, onRetry }: ErrorCardProps) {
  return (
    <Card className="p-6 text-center">
      <AlertTriangle className="h-8 w-8 mx-auto text-amber-500 mb-3" />
      <p className="text-sm text-muted-foreground mb-4">
        {message || "Error al cargar los datos. Inténtalo de nuevo."}
      </p>
      <Button variant="outline" size="sm" onClick={onRetry} className="gap-1.5">
        <RotateCcw className="h-3.5 w-3.5" />
        Reintentar
      </Button>
    </Card>
  );
}
