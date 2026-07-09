type PrometheusInstantValue = [number | string, string];
type PrometheusRangeValue = [number | string, string][];

export type PrometheusVectorResult<TLabels extends Record<string, string> = Record<string, string>> = {
  metric: TLabels;
  value: PrometheusInstantValue;
};

export type PrometheusMatrixResult<TLabels extends Record<string, string> = Record<string, string>> = {
  metric: TLabels;
  values: PrometheusRangeValue;
};

type PrometheusResponse<TResult> = {
  status: "success" | "error";
  data?: {
    resultType: "vector" | "matrix" | "scalar" | "string";
    result: TResult[];
  };
  errorType?: string;
  error?: string;
  warnings?: string[];
};

export type GrafanaMetricsStatus = {
  configured: boolean;
  ready: boolean;
  url: string | null;
  username: string | null;
  missing: string[];
  notes: string[];
};

function resolveGrafanaMetricsStatus(): GrafanaMetricsStatus {
  const url = process.env.GRAFANA_METRICS_URL?.trim() || null;
  const username = process.env.GRAFANA_METRICS_USERNAME?.trim() || null;
  const token = process.env.GRAFANA_METRICS_TOKEN?.trim() || null;

  const missing = [
    ...(!url ? ["GRAFANA_METRICS_URL"] : []),
    ...(!username ? ["GRAFANA_METRICS_USERNAME"] : []),
    ...(!token ? ["GRAFANA_METRICS_TOKEN"] : []),
  ];

  return {
    configured: missing.length < 3,
    ready: missing.length === 0,
    url,
    username,
    missing,
    notes: missing.length === 0
      ? ["Grafana Cloud Metrics configurado para consultas Prometheus/Mimir."]
      : ["Faltan variables de entorno para activar las consultas de runtime."],
  };
}

export class GrafanaMetricsClient {
  getStatus(): GrafanaMetricsStatus {
    return resolveGrafanaMetricsStatus();
  }

  async query<TLabels extends Record<string, string> = Record<string, string>>(
    query: string,
    options: { time?: Date; timeoutMs?: number } = {}
  ) {
    const params = new URLSearchParams({ query });
    if (options.time) params.set("time", String(Math.floor(options.time.getTime() / 1000)));
    return this.request<PrometheusVectorResult<TLabels>>("/api/v1/query", params, options.timeoutMs);
  }

  async queryRange<TLabels extends Record<string, string> = Record<string, string>>(
    query: string,
    options: { start: Date; end: Date; step: string; timeoutMs?: number }
  ) {
    const params = new URLSearchParams({
      query,
      start: String(Math.floor(options.start.getTime() / 1000)),
      end: String(Math.floor(options.end.getTime() / 1000)),
      step: options.step,
    });

    return this.request<PrometheusMatrixResult<TLabels>>("/api/v1/query_range", params, options.timeoutMs);
  }

  private async request<TResult>(
    path: string,
    params: URLSearchParams,
    timeoutMs?: number
  ): Promise<{ result: TResult[]; warnings: string[] }> {
    const status = this.getStatus();
    if (!status.ready || !status.url || !status.username || !process.env.GRAFANA_METRICS_TOKEN) {
      throw new Error(`Grafana Metrics is not ready: missing ${status.missing.join(", ")}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs || Number(process.env.GRAFANA_METRICS_TIMEOUT_MS || 15000));

    try {
      const response = await fetch(`${status.url}${path}?${params.toString()}`, {
        method: "GET",
        headers: {
          "Authorization": `Basic ${Buffer.from(`${status.username}:${process.env.GRAFANA_METRICS_TOKEN}`).toString("base64")}`,
          "Accept": "application/json",
        },
        cache: "no-store",
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Grafana Metrics query failed with ${response.status}: ${body}`);
      }

      const payload = await response.json() as PrometheusResponse<TResult>;
      if (payload.status !== "success" || !payload.data) {
        throw new Error(payload.error || payload.errorType || "Grafana Metrics returned an invalid payload");
      }

      return {
        result: payload.data.result || [],
        warnings: payload.warnings || [],
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const grafanaMetricsClient = new GrafanaMetricsClient();
