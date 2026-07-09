"use client";

import { useEffect, useRef, useState } from "react";

const BASE = "/api/kiro-analytics";

function buildUrl(path: string, params: Record<string, string | undefined>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) qs.set(k, v);
  }
  const q = qs.toString();
  return `${BASE}${path}${q ? `?${q}` : ""}`;
}

export interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: boolean;
}

/**
 * Minimal fetch hook for the Kiro Analytics endpoints. Re-fetches whenever the
 * serialised params change. Avoids adding react-query as a new dependency.
 */
export function useKiroData<T>(
  path: string,
  params: Record<string, string | undefined> = {},
): FetchState<T> {
  const [state, setState] = useState<FetchState<T>>({ data: null, loading: true, error: false });
  const serialized = JSON.stringify(params);
  const reqId = useRef(0);

  useEffect(() => {
    const id = ++reqId.current;
    setState((s) => ({ ...s, loading: true, error: false }));
    fetch(buildUrl(path, params))
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((data: T) => {
        if (id === reqId.current) setState({ data, loading: false, error: false });
      })
      .catch(() => {
        if (id === reqId.current) setState({ data: null, loading: false, error: true });
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, serialized]);

  return state;
}

export function usersParam(users: string[]): string | undefined {
  return users.length ? users.join(",") : undefined;
}
