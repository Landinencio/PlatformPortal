"use client";

import { Component, type ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";

type Props = {
  children: ReactNode;
  fallbackMessage?: string;
};

type State = {
  hasError: boolean;
  error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[ErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-2xl border border-danger/30 bg-danger/5 p-6 text-center">
          <AlertTriangle className="mx-auto h-8 w-8 text-danger/60 mb-3" />
          <p className="text-sm font-medium text-danger">
            {this.props.fallbackMessage || "Algo salió mal al renderizar esta sección"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {this.state.error?.message}
          </p>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            className="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-danger/10 px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/20 transition-colors"
          >
            <RefreshCcw className="h-3 w-3" />
            Reintentar
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
