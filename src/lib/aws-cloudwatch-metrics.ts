import { CloudWatchClient, GetMetricStatisticsCommand } from '@aws-sdk/client-cloudwatch';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import { Hash } from '@smithy/hash-node';
import { HttpRequest } from '@smithy/protocol-http';
import { SignatureV4 } from '@smithy/signature-v4';

const DEFAULT_REGION = 'eu-west-1';
const stsClient = new STSClient({ region: DEFAULT_REGION });

export interface ResourceMetrics {
  resourceId: string;
  resourceName: string;
  service: string;
  accountId: string;
  metrics: Record<string, number | null>; // metric name -> avg value
  insights?: {
    topWaitEvents?: string[];
  };
}

async function getCredentials(accountId: string): Promise<AwsCredentialIdentity> {
  const resp = await stsClient.send(new AssumeRoleCommand({
    RoleArn: `arn:aws:iam::${accountId}:role/n8n-cost-reader-role`,
    RoleSessionName: `metrics-${accountId}`,
    DurationSeconds: 900,
  }));
  return {
    accessKeyId: resp.Credentials!.AccessKeyId!,
    secretAccessKey: resp.Credentials!.SecretAccessKey!,
    sessionToken: resp.Credentials!.SessionToken!,
  };
}

interface InventoryDetail {
  id: string;
  name: string;
  type: string;
  state: string;
  terraform: boolean;
  metadata?: Record<string, string | number | boolean | null | undefined>;
}

interface InventoryServiceEntry {
  service?: string;
  name?: string;
  resourceCount: number;
  regions?: string[];
  details: InventoryDetail[];
}

interface MetricSummary {
  avg: number | null;
  p95: number | null;
  max: number | null;
  samples: number;
}

interface PerformanceInsightsMetricDataPoint {
  Timestamp?: number | string | Date;
  Value?: number;
}

interface PerformanceInsightsMetricResponse {
  MetricList?: Array<{
    DataPoints?: PerformanceInsightsMetricDataPoint[];
  }>;
}

interface PerformanceInsightsDimensionKeysResponse {
  Keys?: Array<{
    Dimensions?: Record<string, string>;
    Total?: number;
  }>;
}

function round(value: number | null, decimals = 2): number | null {
  if (value === null || Number.isNaN(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const position = Math.min(sorted.length - 1, Math.floor((percentileValue / 100) * sorted.length));
  return sorted[position];
}

function bytesToMegabytes(value: number | null): number | null {
  return value !== null ? round(value / 1024 / 1024, 0) : null;
}

function bytesToGigabytes(value: number | null): number | null {
  return value !== null ? round(value / 1024 / 1024 / 1024, 1) : null;
}

function secondsToMilliseconds(value: number | null): number | null {
  return value !== null ? round(value * 1000, 2) : null;
}

function getRegionForDetail(detail: InventoryDetail): string {
  const region = detail.metadata?.region;
  return typeof region === 'string' && region.trim() ? region.trim() : DEFAULT_REGION;
}

function getBooleanMetadata(detail: InventoryDetail, key: string): boolean {
  return detail.metadata?.[key] === true;
}

function getStringMetadata(detail: InventoryDetail, key: string): string | null {
  const value = detail.metadata?.[key];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

async function callPerformanceInsightsApi<T>(
  credentials: AwsCredentialIdentity,
  region: string,
  operation: 'GetResourceMetrics' | 'DescribeDimensionKeys',
  body: Record<string, unknown>,
): Promise<T> {
  const hostname = `pi.${region}.amazonaws.com`;
  const payload = JSON.stringify(body);
  const request = new HttpRequest({
    protocol: 'https:',
    hostname,
    method: 'POST',
    path: '/',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'host': hostname,
      'x-amz-target': `PerformanceInsightsv20180227.${operation}`,
    },
    body: payload,
  });

  const signer = new SignatureV4({
    credentials,
    region,
    service: 'pi',
    sha256: Hash.bind(null, 'sha256'),
  });

  const signedRequest = await signer.sign(request);
  const response = await fetch(`https://${hostname}/`, {
    method: 'POST',
    headers: signedRequest.headers as Record<string, string>,
    body: payload,
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`Performance Insights ${operation} returned ${response.status}`);
  }

  return response.json() as Promise<T>;
}

async function getPerformanceInsightsMetricSummary(
  credentials: AwsCredentialIdentity,
  region: string,
  identifier: string,
  days: number,
): Promise<MetricSummary> {
  const end = new Date();
  const start = new Date();
  const effectiveDays = Math.min(days, 7);
  start.setDate(start.getDate() - effectiveDays);

  try {
    const response = await callPerformanceInsightsApi<PerformanceInsightsMetricResponse>(
      credentials,
      region,
      'GetResourceMetrics',
      {
        ServiceType: 'RDS',
        Identifier: identifier,
        StartTime: Math.floor(start.getTime() / 1000),
        EndTime: Math.floor(end.getTime() / 1000),
        PeriodInSeconds: effectiveDays >= 7 ? 3600 : 300,
        MetricQueries: [{ Metric: 'db.load.avg' }],
      },
    );

    const dataPoints = response.MetricList?.[0]?.DataPoints || [];
    const values = dataPoints
      .map((point) => point.Value)
      .filter((value): value is number => typeof value === 'number');

    if (values.length === 0) {
      return { avg: null, p95: null, max: null, samples: 0 };
    }

    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    const max = Math.max(...values);
    const p95 = percentile(values, 95);

    return {
      avg: round(avg),
      p95: round(p95),
      max: round(max),
      samples: values.length,
    };
  } catch {
    return { avg: null, p95: null, max: null, samples: 0 };
  }
}

async function describePerformanceInsightsTopWaits(
  credentials: AwsCredentialIdentity,
  region: string,
  identifier: string,
  days: number,
): Promise<string[]> {
  const end = new Date();
  const start = new Date();
  const effectiveDays = Math.min(days, 7);
  start.setDate(start.getDate() - effectiveDays);

  try {
    const response = await callPerformanceInsightsApi<PerformanceInsightsDimensionKeysResponse>(
      credentials,
      region,
      'DescribeDimensionKeys',
      {
        ServiceType: 'RDS',
        Identifier: identifier,
        StartTime: Math.floor(start.getTime() / 1000),
        EndTime: Math.floor(end.getTime() / 1000),
        PeriodInSeconds: effectiveDays >= 7 ? 3600 : 300,
        Metric: 'db.load.avg',
        GroupBy: {
          Group: 'db.wait_event',
          Dimensions: ['db.wait_event.name'],
          Limit: 3,
        },
      },
    );

    return (response.Keys || [])
      .map((key) => {
        const name = key.Dimensions?.['db.wait_event.name'];
        if (!name) return null;
        const total = typeof key.Total === 'number' ? ` (${round(key.Total)})` : '';
        return `${name}${total}`;
      })
      .filter((value): value is string => Boolean(value));
  } catch {
    return [];
  }
}

async function getMetricSummary(
  cw: CloudWatchClient,
  namespace: string,
  metricName: string,
  dimensions: { Name: string; Value: string }[],
  days: number,
): Promise<MetricSummary> {
  const end = new Date();
  const start = new Date();
  start.setDate(start.getDate() - days);
  const periodSeconds = days >= 14 ? 21600 : 3600; // 6h granularity for long windows to reduce API pressure

  try {
    const resp = await cw.send(new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: metricName,
      Dimensions: dimensions,
      StartTime: start,
      EndTime: end,
      Period: periodSeconds,
      Statistics: ['Average', 'Maximum'],
    }));

    const points = resp.Datapoints || [];
    const avgValues = points.map((dp) => dp.Average).filter((v): v is number => typeof v === 'number');
    const maxValues = points.map((dp) => dp.Maximum).filter((v): v is number => typeof v === 'number');
    if (avgValues.length === 0 && maxValues.length === 0) {
      return { avg: null, p95: null, max: null, samples: 0 };
    }

    const avg = avgValues.length > 0
      ? avgValues.reduce((sum, value) => sum + value, 0) / avgValues.length
      : null;
    const max = maxValues.length > 0 ? Math.max(...maxValues) : null;
    const p95 = percentile(avgValues, 95);

    return {
      avg: round(avg),
      p95: round(p95),
      max: round(max),
      samples: Math.max(avgValues.length, maxValues.length),
    };
  } catch {
    return { avg: null, p95: null, max: null, samples: 0 };
  }
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R | null>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const result: R[] = [];
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      try {
        const value = await worker(item);
        if (value !== null) result.push(value);
      } catch {
        // Best effort collector: continue on individual resource failures.
      }
    }
  });

  await Promise.all(runners);
  return result;
}

export async function collectMetricsForAccount(
  accountId: string,
  services: InventoryServiceEntry[],
  days = 14,
): Promise<ResourceMetrics[]> {
  const creds = await getCredentials(accountId);
  const cloudWatchClients = new Map<string, CloudWatchClient>();
  const results: ResourceMetrics[] = [];

  const getCloudWatchClient = (region: string) => {
    const resolvedRegion = region || DEFAULT_REGION;
    if (!cloudWatchClients.has(resolvedRegion)) {
      cloudWatchClients.set(resolvedRegion, new CloudWatchClient({ region: resolvedRegion, credentials: creds }));
    }
    return cloudWatchClients.get(resolvedRegion)!;
  };

  for (const svc of services) {
    if (!svc.details) continue;
    const serviceKey = svc.service || svc.name || '';

    // EC2 Instances
    if (serviceKey === 'EC2 - Instances') {
      const ec2Items = svc.details.filter((d) => d.state === 'running').slice(0, 30);
      const rows = await mapWithConcurrency(ec2Items, 5, async (d) => {
        const cw = getCloudWatchClient(getRegionForDetail(d));
        const dims = [{ Name: 'InstanceId', Value: d.id }];
        const cpu = await getMetricSummary(cw, 'AWS/EC2', 'CPUUtilization', dims, days);
        return {
          resourceId: d.id,
          resourceName: d.name,
          service: 'EC2',
          accountId,
          metrics: {
            cpuAvg: cpu.avg,
            cpuP95: cpu.p95,
            cpuMax: cpu.max,
            cpuSamples: cpu.samples,
          },
        };
      });
      results.push(...rows);
    }

    // RDS DB Instances
    if (serviceKey === 'RDS - DB Instances') {
      const rdsItems = svc.details.slice(0, 25);
      const rows = await mapWithConcurrency(rdsItems, 4, async (d) => {
        const region = getRegionForDetail(d);
        const cw = getCloudWatchClient(region);
        const dims = [{ Name: 'DBInstanceIdentifier', Value: d.name }];
        const performanceInsightsEnabled = getBooleanMetadata(d, 'performanceInsightsEnabled');
        const dbiResourceId = getStringMetadata(d, 'dbiResourceId');

        const [cpu, connections, freeMemory, freeStorage, readIops, writeIops, readLatency, writeLatency, diskQueueDepth, piLoad, piTopWaits] = await Promise.all([
          getMetricSummary(cw, 'AWS/RDS', 'CPUUtilization', dims, days),
          getMetricSummary(cw, 'AWS/RDS', 'DatabaseConnections', dims, days),
          getMetricSummary(cw, 'AWS/RDS', 'FreeableMemory', dims, days),
          getMetricSummary(cw, 'AWS/RDS', 'FreeStorageSpace', dims, days),
          getMetricSummary(cw, 'AWS/RDS', 'ReadIOPS', dims, days),
          getMetricSummary(cw, 'AWS/RDS', 'WriteIOPS', dims, days),
          getMetricSummary(cw, 'AWS/RDS', 'ReadLatency', dims, days),
          getMetricSummary(cw, 'AWS/RDS', 'WriteLatency', dims, days),
          getMetricSummary(cw, 'AWS/RDS', 'DiskQueueDepth', dims, days),
          performanceInsightsEnabled && dbiResourceId
            ? getPerformanceInsightsMetricSummary(creds, region, dbiResourceId, days)
            : Promise.resolve({ avg: null, p95: null, max: null, samples: 0 }),
          performanceInsightsEnabled && dbiResourceId
            ? describePerformanceInsightsTopWaits(creds, region, dbiResourceId, days)
            : Promise.resolve([]),
        ]);

        return {
          resourceId: d.id,
          resourceName: d.name,
          service: 'RDS',
          accountId,
          metrics: {
            cpuAvg: cpu.avg,
            cpuP95: cpu.p95,
            cpuMax: cpu.max,
            cpuSamples: cpu.samples,
            connectionsAvg: round(connections.avg, 0),
            connectionsP95: round(connections.p95, 0),
            freeMemoryMB: bytesToMegabytes(freeMemory.avg),
            freeMemoryP95MB: bytesToMegabytes(freeMemory.p95),
            freeStorageGB: bytesToGigabytes(freeStorage.avg),
            freeStorageP95GB: bytesToGigabytes(freeStorage.p95),
            readIopsAvg: round(readIops.avg, 0),
            readIopsP95: round(readIops.p95, 0),
            writeIopsAvg: round(writeIops.avg, 0),
            writeIopsP95: round(writeIops.p95, 0),
            readLatencyMs: secondsToMilliseconds(readLatency.avg),
            readLatencyP95Ms: secondsToMilliseconds(readLatency.p95),
            writeLatencyMs: secondsToMilliseconds(writeLatency.avg),
            writeLatencyP95Ms: secondsToMilliseconds(writeLatency.p95),
            diskQueueDepthAvg: round(diskQueueDepth.avg, 2),
            diskQueueDepthP95: round(diskQueueDepth.p95, 2),
            piDbLoadAvg: piLoad.avg,
            piDbLoadP95: piLoad.p95,
            piDbLoadMax: piLoad.max,
          },
          insights: piTopWaits.length > 0 ? { topWaitEvents: piTopWaits } : undefined,
        };
      });
      results.push(...rows);
    }

    // ElastiCache
    if (serviceKey === 'ElastiCache - Clusters') {
      const cacheItems = svc.details.slice(0, 15);
      const rows = await mapWithConcurrency(cacheItems, 4, async (d) => {
        const cw = getCloudWatchClient(getRegionForDetail(d));
        const dims = [{ Name: 'CacheClusterId', Value: d.id }];
        const [cpu, memory] = await Promise.all([
          getMetricSummary(cw, 'AWS/ElastiCache', 'CPUUtilization', dims, days),
          getMetricSummary(cw, 'AWS/ElastiCache', 'DatabaseMemoryUsagePercentage', dims, days),
        ]);
        return {
          resourceId: d.id,
          resourceName: d.name,
          service: 'ElastiCache',
          accountId,
          metrics: {
            cpuAvg: cpu.avg,
            cpuP95: cpu.p95,
            memoryPct: memory.avg,
            memoryP95: memory.p95,
          },
        };
      });
      results.push(...rows);
    }

    // ELB
    if (serviceKey === 'ELB - Load Balancers') {
      const elbItems = svc.details.slice(0, 15);
      const rows = await mapWithConcurrency(elbItems, 4, async (d) => {
        const cw = getCloudWatchClient(getRegionForDetail(d));
        const arnParts = d.id.split(':loadbalancer/');
        if (arnParts.length < 2) return null;
        const lbDim = arnParts[1];
        const dims = [{ Name: 'LoadBalancer', Value: lbDim }];
        const namespace = lbDim.startsWith('net/') ? 'AWS/NetworkELB' : 'AWS/ApplicationELB';

        const requestMetric = namespace === 'AWS/ApplicationELB' ? 'RequestCount' : 'ActiveFlowCount';
        const [requests, activeConn] = await Promise.all([
          getMetricSummary(cw, namespace, requestMetric, dims, days),
          getMetricSummary(cw, 'AWS/ApplicationELB', 'ActiveConnectionCount', dims, days),
        ]);

        return {
          resourceId: d.id,
          resourceName: d.name,
          service: 'ELB',
          accountId,
          metrics: {
            requestCountAvg: round(requests.avg, 0),
            requestCountP95: round(requests.p95, 0),
            activeConnectionsAvg: round(activeConn.avg, 0),
          },
        };
      });
      results.push(...rows);
    }
  }

  return results;
}
