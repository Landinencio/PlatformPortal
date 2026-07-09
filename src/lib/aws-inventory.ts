import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { EC2Client, DescribeInstancesCommand, DescribeImagesCommand, DescribeVpcsCommand, DescribeSubnetsCommand, DescribeSecurityGroupsCommand, DescribeNatGatewaysCommand, DescribeInternetGatewaysCommand, DescribeVolumesCommand, DescribeAddressesCommand, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand } from '@aws-sdk/client-rds';
import { LambdaClient, ListFunctionsCommand, ListTagsCommand as LambdaListTagsCommand } from '@aws-sdk/client-lambda';
import { S3Client, ListBucketsCommand, GetBucketTaggingCommand } from '@aws-sdk/client-s3';
import { ECSClient, ListClustersCommand, ListServicesCommand, DescribeClustersCommand, DescribeServicesCommand } from '@aws-sdk/client-ecs';
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand, DescribeTagsCommand as ELBDescribeTagsCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { EKSClient, ListClustersCommand as EKSListClustersCommand, DescribeClusterCommand } from '@aws-sdk/client-eks';
import { DynamoDBClient, ListTablesCommand, DescribeTableCommand, ListTagsOfResourceCommand } from '@aws-sdk/client-dynamodb';
import { ElastiCacheClient, DescribeCacheClustersCommand, ListTagsForResourceCommand as ElastiCacheListTagsForResourceCommand } from '@aws-sdk/client-elasticache';
import { SNSClient, ListTopicsCommand, ListTagsForResourceCommand as SNSListTagsForResourceCommand } from '@aws-sdk/client-sns';
import { SQSClient, ListQueuesCommand, ListQueueTagsCommand } from '@aws-sdk/client-sqs';
import { CloudFrontClient, ListDistributionsCommand, ListTagsForResourceCommand as CloudFrontListTagsForResourceCommand } from '@aws-sdk/client-cloudfront';
import { AutoScalingClient, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';
import type { AwsCredentialIdentity } from '@aws-sdk/types';
import { AWS_ACCOUNT_NAMES } from '@/lib/aws-accounts';
import type { TerraformStatus } from '@/types/inventory';
import { estimateResourceMonthlyCost } from '@/lib/finops-cost-estimation';
import { splitInventoryServiceKey } from '@/lib/finops-format';

const REGION = 'eu-west-1';
const SCAN_REGIONS = ['eu-west-1', 'eu-west-2', 'eu-west-3', 'eu-central-1', 'eu-north-1', 'eu-south-1', 'us-east-1', 'us-west-2'];
const stsClient = new STSClient({ region: REGION });

export type ResourceMetadataValue = string | number | boolean | null | undefined;

type Tag = { Key?: string; Value?: string };

export interface ResourceDetail {
  id: string;
  name: string;
  type: string;
  state: string;
  terraform: boolean;
  terraformStatus?: TerraformStatus;
  estimatedMonthlyCost?: number | null;
  tags?: Record<string, string>;
  metadata?: Record<string, ResourceMetadataValue>;
}

interface ResourceEntry {
  service: string;
  type: string;
  count: number;
  region: string;
  details: ResourceDetail[];
}

type ResourceSeed = Omit<ResourceDetail, "terraform" | "terraformStatus" | "estimatedMonthlyCost" | "tags">;

function normalizeTags(tags?: Tag[]): Record<string, string> {
  if (!tags) return {};

  return tags.reduce<Record<string, string>>((acc, tag) => {
    const key = tag.Key?.trim();
    const value = tag.Value?.trim();
    if (key) {
      acc[key] = value || "";
    }
    return acc;
  }, {});
}

function hasTf(tags?: Tag[]): boolean {
  if (!tags || tags.length === 0) return false;

  return tags.some((tag) => {
    const key = (tag.Key || '').toLowerCase().trim();
    const value = (tag.Value || '').toLowerCase().trim();

    if (key === 'terraform' && ['true', '1', 'yes'].includes(value)) return true;
    if (['managed-by', 'managedby', 'managed_by', 'app.kubernetes.io/managed-by', 'provisioner', 'iac'].includes(key) && (value.includes('terraform') || value.includes('terragrunt'))) return true;
    if (key.includes('terraform') || key.includes('terragrunt')) return true;
    if (value === 'terraform' || value === 'terragrunt') return true;
    return false;
  });
}

function getTerraformStatus(tags?: Tag[], tagsKnown = true): TerraformStatus {
  if (!tagsKnown) return 'unknown';
  return hasTf(tags) ? 'managed' : 'not-managed';
}

function buildTagSummary(tags: Record<string, string>): string | null {
  const entries = Object.entries(tags);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key}=${value}`).join(' | ');
}

function toTagsFromRecord(tags?: Record<string, string>): Tag[] {
  return Object.entries(tags || {}).map(([Key, Value]) => ({ Key, Value }));
}

function toTagsFromLowercase(tags?: { key?: string; value?: string }[]): Tag[] {
  return (tags || []).map((tag) => ({ Key: tag.key, Value: tag.value }));
}

function withResourceContext(
  detail: ResourceSeed,
  service: string,
  resourceType: string,
  tags?: Tag[],
  tagsKnown = true
): ResourceDetail {
  const normalizedTags = normalizeTags(tags);
  const terraformStatus = getTerraformStatus(tags, tagsKnown);
  const estimatedMonthlyCost = estimateResourceMonthlyCost(service, resourceType, detail);

  return {
    ...detail,
    terraform: terraformStatus === 'managed',
    terraformStatus,
    estimatedMonthlyCost,
    tags: Object.keys(normalizedTags).length > 0 ? normalizedTags : undefined,
    metadata: {
      ...detail.metadata,
      tagCount: Object.keys(normalizedTags).length,
      tagSummary: buildTagSummary(normalizedTags),
    },
  };
}

async function safeResolveTags<T>(resolver: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await resolver();
  } catch {
    return fallback;
  }
}

function tagName(tags?: { Key?: string; Value?: string }[]): string {
  return tags?.find(t => t.Key === 'Name')?.Value || '';
}

async function getCredentials(accountId: string): Promise<AwsCredentialIdentity> {
  const resp = await stsClient.send(new AssumeRoleCommand({
    RoleArn: `arn:aws:iam::${accountId}:role/n8n-cost-reader-role`,
    RoleSessionName: `inventory-${accountId}`,
    DurationSeconds: 900
  }));
  return {
    accessKeyId: resp.Credentials!.AccessKeyId!,
    secretAccessKey: resp.Credentials!.SecretAccessKey!,
    sessionToken: resp.Credentials!.SessionToken!,
  };
}

async function collectEC2(creds: AwsCredentialIdentity, region: string): Promise<ResourceEntry[]> {
  const client = new EC2Client({ region, credentials: creds });
  const resources: ResourceEntry[] = [];
  const service = 'EC2';

  // Instances
  const instances = await client.send(new DescribeInstancesCommand({}));
  const rawInstances: Array<{ instance: NonNullable<NonNullable<typeof instances.Reservations>[0]['Instances']>[0]; tags: Tag[] | undefined }> = [];
  for (const r of instances.Reservations || []) {
    for (const i of r.Instances || []) {
      rawInstances.push({ instance: i, tags: i.Tags as Tag[] | undefined });
    }
  }

  // Resolve AMI names in batch (avoid N+1 calls)
  const amiIds = [...new Set(rawInstances.map(({ instance: i }) => i.ImageId).filter(Boolean))] as string[];
  const amiNameMap = new Map<string, string>();
  if (amiIds.length > 0) {
    try {
      // DescribeImages accepts up to 200 IDs per call
      for (let offset = 0; offset < amiIds.length; offset += 200) {
        const batch = amiIds.slice(offset, offset + 200);
        const imagesResult = await client.send(new DescribeImagesCommand({ ImageIds: batch }));
        for (const img of imagesResult.Images || []) {
          if (img.ImageId && img.Name) {
            amiNameMap.set(img.ImageId, img.Name);
          }
        }
      }
    } catch {
      // Non-fatal — AMI names will be null if this fails
    }
  }

  const instDetails: ResourceDetail[] = rawInstances.map(({ instance: i, tags }) => {
    const amiId = i.ImageId || null;
    const amiName = amiId ? (amiNameMap.get(amiId) || null) : null;
    // Detect Amazon Linux 2 (EOL June 2026) vs AL2023
    const isAmazonLinux2 = amiName
      ? /amzn2[-_]|amazon.linux.2[^0-9]/i.test(amiName)
      : false;
    const isAmazonLinux2023 = amiName
      ? /al2023|amazon.linux.2023/i.test(amiName)
      : false;

    return withResourceContext({
      id: i.InstanceId || '-',
      name: tagName(tags),
      type: i.InstanceType || '-',
      state: i.State?.Name || '-',
      metadata: {
        availabilityZone: i.Placement?.AvailabilityZone || null,
        platform: i.Platform || 'linux',
        vpcId: i.VpcId || null,
        subnetId: i.SubnetId || null,
        privateIpAddress: i.PrivateIpAddress || null,
        publicIpAddress: i.PublicIpAddress || null,
        ebsOptimized: i.EbsOptimized ?? null,
        launchTime: i.LaunchTime?.toISOString?.() || null,
        amiId,
        amiName,
        isAmazonLinux2,
        isAmazonLinux2023,
      },
    }, service, 'Instances', tags);
  });
  if (instDetails.length > 0) resources.push({ service, type: 'Instances', count: instDetails.length, region, details: instDetails });

  // EBS Volumes
  const volumes = await client.send(new DescribeVolumesCommand({}));
  const volDetails: ResourceDetail[] = (volumes.Volumes || []).map(v => withResourceContext({
    id: v.VolumeId || '-',
    name: tagName(v.Tags as Tag[] | undefined),
    type: `${v.VolumeType || '-'} / ${v.Size || 0} GiB`,
    state: v.State || '-',
    metadata: {
      availabilityZone: v.AvailabilityZone || null,
      encrypted: v.Encrypted ?? null,
      iops: v.Iops ?? null,
      throughput: v.Throughput ?? null,
      attachedInstanceId: v.Attachments?.[0]?.InstanceId || null,
      multiAttachEnabled: v.MultiAttachEnabled ?? null,
    },
  }, service, 'EBS Volumes', v.Tags as Tag[] | undefined));
  if (volDetails.length > 0) resources.push({ service, type: 'EBS Volumes', count: volDetails.length, region, details: volDetails });

  // Security Groups
  const sgs = await client.send(new DescribeSecurityGroupsCommand({}));
  const sgDetails: ResourceDetail[] = (sgs.SecurityGroups || []).map(sg => withResourceContext({
    id: sg.GroupId || '-',
    name: sg.GroupName || '-',
    type: sg.VpcId || '-',
    state: '-',
  }, service, 'Security Groups', sg.Tags as Tag[] | undefined));
  if (sgDetails.length > 0) resources.push({ service, type: 'Security Groups', count: sgDetails.length, region, details: sgDetails });

  // VPCs
  const vpcs = await client.send(new DescribeVpcsCommand({}));
  const vpcDetails: ResourceDetail[] = (vpcs.Vpcs || []).map(v => withResourceContext({
    id: v.VpcId || '-',
    name: tagName(v.Tags as Tag[] | undefined),
    type: v.CidrBlock || '-',
    state: v.State || '-',
  }, 'VPC', 'VPCs', v.Tags as Tag[] | undefined));
  if (vpcDetails.length > 0) resources.push({ service: 'VPC', type: 'VPCs', count: vpcDetails.length, region, details: vpcDetails });

  // Subnets
  const subnets = await client.send(new DescribeSubnetsCommand({}));
  const subDetails: ResourceDetail[] = (subnets.Subnets || []).map(s => withResourceContext({
    id: s.SubnetId || '-',
    name: tagName(s.Tags as Tag[] | undefined),
    type: `${s.CidrBlock || '-'} (${s.AvailabilityZone || '-'})`,
    state: s.State || '-',
  }, 'VPC', 'Subnets', s.Tags as Tag[] | undefined));
  if (subDetails.length > 0) resources.push({ service: 'VPC', type: 'Subnets', count: subDetails.length, region, details: subDetails });

  // NAT Gateways
  const nats = await client.send(new DescribeNatGatewaysCommand({}));
  const natItems = (nats.NatGateways || []).filter(n => n.State === 'available');
  const natDetails: ResourceDetail[] = natItems.map(n => withResourceContext({
    id: n.NatGatewayId || '-',
    name: tagName(n.Tags as Tag[] | undefined),
    type: n.ConnectivityType || '-',
    state: n.State || '-',
  }, 'VPC', 'NAT Gateways', n.Tags as Tag[] | undefined));
  if (natDetails.length > 0) resources.push({ service: 'VPC', type: 'NAT Gateways', count: natDetails.length, region, details: natDetails });

  // Internet Gateways
  const igws = await client.send(new DescribeInternetGatewaysCommand({}));
  const igwDetails: ResourceDetail[] = (igws.InternetGateways || []).map(ig => withResourceContext({
    id: ig.InternetGatewayId || '-',
    name: tagName(ig.Tags as Tag[] | undefined),
    type: '-',
    state: ig.Attachments?.[0]?.State || '-',
  }, 'VPC', 'Internet Gateways', ig.Tags as Tag[] | undefined));
  if (igwDetails.length > 0) resources.push({ service: 'VPC', type: 'Internet Gateways', count: igwDetails.length, region, details: igwDetails });

  // Elastic IPs
  const eips = await client.send(new DescribeAddressesCommand({}));
  const eipDetails: ResourceDetail[] = (eips.Addresses || []).map(e => withResourceContext({
    id: e.AllocationId || '-',
    name: tagName(e.Tags as Tag[] | undefined) !== '-' ? tagName(e.Tags as Tag[] | undefined) : (e.PublicIp || '-'),
    type: e.Domain || '-',
    state: e.AssociationId ? 'associated' : 'available',
  }, service, 'Elastic IPs', e.Tags as Tag[] | undefined));
  if (eipDetails.length > 0) resources.push({ service, type: 'Elastic IPs', count: eipDetails.length, region, details: eipDetails });

  // Network Interfaces
  const enis = await client.send(new DescribeNetworkInterfacesCommand({}));
  const eniDetails: ResourceDetail[] = (enis.NetworkInterfaces || []).map(ni => withResourceContext({
    id: ni.NetworkInterfaceId || '-',
    name: ni.Description || '-',
    type: ni.InterfaceType || '-',
    state: ni.Status || '-',
  }, 'VPC', 'Network Interfaces', ni.TagSet as Tag[] | undefined));
  if (eniDetails.length > 0) resources.push({ service: 'VPC', type: 'Network Interfaces', count: eniDetails.length, region, details: eniDetails });

  return resources;
}

// RDS engine versions that are EOL or approaching EOL
// Sources: AWS RDS deprecation schedule
const RDS_EOL_VERSIONS: Array<{ engine: string; versionPrefix: string; eolDate: string; label: string }> = [
  { engine: "mysql", versionPrefix: "5.7", eolDate: "2023-10-31", label: "MySQL 5.7 EOL" },
  { engine: "mysql", versionPrefix: "5.6", eolDate: "2022-08-03", label: "MySQL 5.6 EOL" },
  { engine: "postgres", versionPrefix: "11.", eolDate: "2023-11-09", label: "PostgreSQL 11 EOL" },
  { engine: "postgres", versionPrefix: "12.", eolDate: "2024-11-14", label: "PostgreSQL 12 EOL" },
  { engine: "mariadb", versionPrefix: "10.3", eolDate: "2023-05-25", label: "MariaDB 10.3 EOL" },
  { engine: "mariadb", versionPrefix: "10.4", eolDate: "2024-06-18", label: "MariaDB 10.4 EOL" },
  { engine: "oracle-ee", versionPrefix: "19.", eolDate: "2027-04-30", label: "Oracle 19c" },
  { engine: "sqlserver-se", versionPrefix: "14.", eolDate: "2024-07-09", label: "SQL Server 2017 EOL" },
  { engine: "sqlserver-ee", versionPrefix: "14.", eolDate: "2024-07-09", label: "SQL Server 2017 EOL" },
];

function getRdsEolInfo(engine: string | null, engineVersion: string | null): { isEol: boolean; label: string | null } {
  if (!engine || !engineVersion) return { isEol: false, label: null };
  const engineLower = engine.toLowerCase();
  const match = RDS_EOL_VERSIONS.find(
    (entry) => engineLower.startsWith(entry.engine) && engineVersion.startsWith(entry.versionPrefix)
  );
  if (!match) return { isEol: false, label: null };
  return { isEol: true, label: match.label };
}

async function collectRDS(creds: AwsCredentialIdentity, region: string): Promise<ResourceEntry[]> {
  const client = new RDSClient({ region, credentials: creds });
  const resources: ResourceEntry[] = [];

  const instances = await client.send(new DescribeDBInstancesCommand({}));
  const dbDetails: ResourceDetail[] = (instances.DBInstances || []).map(db => {
    const engine = db.Engine || null;
    const engineVersion = db.EngineVersion || null;
    const eolInfo = getRdsEolInfo(engine, engineVersion);
    return withResourceContext({
      id: db.DBInstanceArn || '-',
      name: db.DBInstanceIdentifier || '-',
      type: `${db.DBInstanceClass || '-'} / ${db.Engine || '-'}`,
      state: db.DBInstanceStatus || '-',
      metadata: {
        instanceClass: db.DBInstanceClass || null,
        engine,
        engineVersion,
        multiAz: db.MultiAZ ?? null,
        allocatedStorageGb: db.AllocatedStorage ?? null,
        maxAllocatedStorageGb: db.MaxAllocatedStorage ?? null,
        storageType: db.StorageType || null,
        storageEncrypted: db.StorageEncrypted ?? null,
        publiclyAccessible: db.PubliclyAccessible ?? null,
        deletionProtection: db.DeletionProtection ?? null,
        performanceInsightsEnabled: db.PerformanceInsightsEnabled ?? null,
        performanceInsightsRetentionDays: db.PerformanceInsightsRetentionPeriod ?? null,
        monitoringIntervalSeconds: db.MonitoringInterval ?? null,
        backupRetentionDays: db.BackupRetentionPeriod ?? null,
        dbClusterIdentifier: db.DBClusterIdentifier || null,
        dbiResourceId: db.DbiResourceId || null,
        isEngineEol: eolInfo.isEol,
        engineEolLabel: eolInfo.label,
      },
    }, 'RDS', 'DB Instances', (db.TagList || []) as Tag[]);
  });
  if (dbDetails.length > 0) resources.push({ service: 'RDS', type: 'DB Instances', count: dbDetails.length, region, details: dbDetails });

  const clusters = await client.send(new DescribeDBClustersCommand({}));
  const clusterDetails: ResourceDetail[] = (clusters.DBClusters || []).map(c => {
    const engine = c.Engine || null;
    const engineVersion = c.EngineVersion || null;
    const eolInfo = getRdsEolInfo(engine, engineVersion);
    return withResourceContext({
      id: c.DBClusterArn || '-',
      name: c.DBClusterIdentifier || '-',
      type: `${c.Engine || '-'} ${c.EngineVersion || ''}`.trim(),
      state: c.Status || '-',
      metadata: {
        engine,
        engineVersion,
        engineMode: c.EngineMode || null,
        storageEncrypted: c.StorageEncrypted ?? null,
        deletionProtection: c.DeletionProtection ?? null,
        iamDatabaseAuthenticationEnabled: c.IAMDatabaseAuthenticationEnabled ?? null,
        serverlessV2MinCapacity: c.ServerlessV2ScalingConfiguration?.MinCapacity ?? null,
        serverlessV2MaxCapacity: c.ServerlessV2ScalingConfiguration?.MaxCapacity ?? null,
        performanceInsightsEnabled: c.PerformanceInsightsEnabled ?? null,
        isEngineEol: eolInfo.isEol,
        engineEolLabel: eolInfo.label,
      },
    }, 'RDS', 'DB Clusters', (c.TagList || []) as Tag[]);
  });
  if (clusterDetails.length > 0) resources.push({ service: 'RDS', type: 'DB Clusters', count: clusterDetails.length, region, details: clusterDetails });

  return resources;
}

async function collectLambda(creds: AwsCredentialIdentity, region: string): Promise<ResourceEntry[]> {
  const client = new LambdaClient({ region, credentials: creds });
  const details: ResourceDetail[] = [];
  let marker: string | undefined;
  do {
    const resp = await client.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }));
    for (const fn of resp.Functions || []) {
      const tags = fn.FunctionArn
        ? await safeResolveTags(async () => {
            const result = await client.send(new LambdaListTagsCommand({ Resource: fn.FunctionArn! }));
            return toTagsFromRecord(result.Tags);
          }, undefined as Tag[] | undefined)
        : undefined;

      details.push(withResourceContext({
        id: fn.FunctionArn || '-',
        name: fn.FunctionName || '-',
        type: fn.Runtime || '-',
        state: '-',
      }, 'Lambda', 'Functions', tags, tags !== undefined));
    }
    marker = resp.NextMarker;
  } while (marker);
  return details.length > 0 ? [{ service: 'Lambda', type: 'Functions', count: details.length, region, details }] : [];
}

async function collectS3(creds: AwsCredentialIdentity): Promise<ResourceEntry[]> {
  const client = new S3Client({ region: REGION, credentials: creds });
  const resp = await client.send(new ListBucketsCommand({}));
  const details: ResourceDetail[] = await Promise.all((resp.Buckets || []).map(async (b) => {
    const bucketName = b.Name || '-';
    const tags = await (async () => {
      try {
        const result = await client.send(new GetBucketTaggingCommand({ Bucket: bucketName }));
        return (result.TagSet || []) as Tag[];
      } catch (error: any) {
        if (error?.name === 'NoSuchTagSet' || error?.$metadata?.httpStatusCode === 404) {
          return [];
        }
        return undefined;
      }
    })();

    return withResourceContext({
      id: bucketName,
      name: bucketName,
      type: '-',
      state: '-',
      metadata: {
        createdAt: b.CreationDate?.toISOString?.() || null,
      },
    }, 'S3', 'Buckets', tags, tags !== undefined);
  }));
  return details.length > 0 ? [{ service: 'S3', type: 'Buckets', count: details.length, region: 'global', details }] : [];
}

async function collectECS(creds: AwsCredentialIdentity, region: string): Promise<ResourceEntry[]> {
  const client = new ECSClient({ region, credentials: creds });
  const resources: ResourceEntry[] = [];
  const clusters = await client.send(new ListClustersCommand({}));
  const clusterArns = clusters.clusterArns || [];
  if (clusterArns.length > 0) {
    const describeClusters = await safeResolveTags(
      async () => client.send(new DescribeClustersCommand({ clusters: clusterArns, include: ['TAGS'] })),
      null as any
    );
    const clusterDetails: ResourceDetail[] = (describeClusters?.clusters || []).map((cluster: any) => withResourceContext({
      id: cluster.clusterArn || '-',
      name: cluster.clusterName || cluster.clusterArn?.split('/').pop() || '-',
      type: '-',
      state: cluster.status || '-',
    }, 'ECS', 'Clusters', toTagsFromLowercase(cluster.tags), describeClusters !== null));
    resources.push({ service: 'ECS', type: 'Clusters', count: clusterArns.length, region, details: clusterDetails });
  }
  const svcDetails: ResourceDetail[] = [];
  for (const arn of clusterArns) {
    const svcs = await client.send(new ListServicesCommand({ cluster: arn }));
    const serviceArns = svcs.serviceArns || [];
    if (serviceArns.length === 0) continue;
    const describeServices = await safeResolveTags(
      async () => client.send(new DescribeServicesCommand({ cluster: arn, services: serviceArns, include: ['TAGS'] })),
      null as any
    );
    for (const service of ((describeServices as any)?.services || [])) {
      svcDetails.push(withResourceContext({
        id: service.serviceArn || '-',
        name: service.serviceName || service.serviceArn?.split('/').pop() || '-',
        type: service.launchType || '-',
        state: service.status || '-',
      }, 'ECS', 'Services', toTagsFromLowercase(service.tags), describeServices !== null));
    }
  }
  if (svcDetails.length > 0) resources.push({ service: 'ECS', type: 'Services', count: svcDetails.length, region, details: svcDetails });
  return resources;
}

async function collectELB(creds: AwsCredentialIdentity, region: string): Promise<ResourceEntry[]> {
  const client = new ElasticLoadBalancingV2Client({ region, credentials: creds });
  const resources: ResourceEntry[] = [];
  const lbs = await client.send(new DescribeLoadBalancersCommand({}));
  const lbTagMap = new Map<string, Tag[]>();
  const lbArns = (lbs.LoadBalancers || []).map((lb) => lb.LoadBalancerArn).filter(Boolean) as string[];
  if (lbArns.length > 0) {
    const tagResponse = await safeResolveTags(
      async () => client.send(new ELBDescribeTagsCommand({ ResourceArns: lbArns })),
      null as any
    );
    for (const tagDescription of ((tagResponse as any)?.TagDescriptions || [])) {
      lbTagMap.set(tagDescription.ResourceArn, (tagDescription.Tags || []) as Tag[]);
    }
  }

  const lbDetails: ResourceDetail[] = (lbs.LoadBalancers || []).map(lb => withResourceContext({
    id: lb.LoadBalancerArn || '-',
    name: lb.LoadBalancerName || '-',
    type: `${lb.Type || '-'} / ${lb.Scheme || '-'}`,
    state: lb.State?.Code || '-',
    metadata: {
      scheme: lb.Scheme || null,
      vpcId: lb.VpcId || null,
      ipAddressType: lb.IpAddressType || null,
      dnsName: lb.DNSName || null,
    },
  }, 'ELB', 'Load Balancers', lb.LoadBalancerArn ? lbTagMap.get(lb.LoadBalancerArn) : undefined, lbArns.length > 0));
  if (lbDetails.length > 0) resources.push({ service: 'ELB', type: 'Load Balancers', count: lbDetails.length, region, details: lbDetails });

  const tgs = await client.send(new DescribeTargetGroupsCommand({}));
  const tgTagMap = new Map<string, Tag[]>();
  const targetGroupArns = (tgs.TargetGroups || []).map((tg) => tg.TargetGroupArn).filter(Boolean) as string[];
  if (targetGroupArns.length > 0) {
    const tagResponse = await safeResolveTags(
      async () => client.send(new ELBDescribeTagsCommand({ ResourceArns: targetGroupArns })),
      null as any
    );
    for (const tagDescription of ((tagResponse as any)?.TagDescriptions || [])) {
      tgTagMap.set(tagDescription.ResourceArn, (tagDescription.Tags || []) as Tag[]);
    }
  }
  const tgDetails: ResourceDetail[] = (tgs.TargetGroups || []).map(tg => withResourceContext({
    id: tg.TargetGroupArn || '-',
    name: tg.TargetGroupName || '-',
    type: `${tg.Protocol || '-'} : ${tg.Port || '-'}`,
    state: '-',
  }, 'ELB', 'Target Groups', tg.TargetGroupArn ? tgTagMap.get(tg.TargetGroupArn) : undefined, targetGroupArns.length > 0));
  if (tgDetails.length > 0) resources.push({ service: 'ELB', type: 'Target Groups', count: tgDetails.length, region, details: tgDetails });
  return resources;
}

async function collectEKS(creds: AwsCredentialIdentity, region: string): Promise<ResourceEntry[]> {
  const client = new EKSClient({ region, credentials: creds });
  const resp = await client.send(new EKSListClustersCommand({}));
  const names = resp.clusters || [];
  const details: ResourceDetail[] = await Promise.all(names.map(async (name) => {
    const cluster = await safeResolveTags(async () => client.send(new DescribeClusterCommand({ name })), null as any);
    const clusterData: any = cluster && (cluster as any).cluster ? (cluster as any).cluster : null;
    return withResourceContext({
      id: clusterData?.arn || name,
      name,
      type: clusterData?.version || '-',
      state: clusterData?.status || '-',
    }, 'EKS', 'Clusters', toTagsFromRecord(clusterData?.tags), cluster !== null);
  }));
  return details.length > 0 ? [{ service: 'EKS', type: 'Clusters', count: details.length, region, details }] : [];
}

async function collectDynamoDB(creds: AwsCredentialIdentity, region: string): Promise<ResourceEntry[]> {
  const client = new DynamoDBClient({ region, credentials: creds });
  const resp = await client.send(new ListTablesCommand({}));
  const names = resp.TableNames || [];
  const details: ResourceDetail[] = await Promise.all(names.map(async (name) => {
    const table = await safeResolveTags(async () => client.send(new DescribeTableCommand({ TableName: name })), null as any);
    const tableArn = (table as any)?.Table?.TableArn || null;
    const tags = tableArn
      ? await safeResolveTags(async () => {
          const result = await client.send(new ListTagsOfResourceCommand({ ResourceArn: tableArn }));
          return (result.Tags || []) as Tag[];
        }, undefined as Tag[] | undefined)
      : undefined;
    return withResourceContext({
      id: tableArn || name,
      name,
      type: (table as any)?.Table?.BillingModeSummary?.BillingMode || '-',
      state: (table as any)?.Table?.TableStatus || '-',
    }, 'DynamoDB', 'Tables', tags, tags !== undefined);
  }));
  return details.length > 0 ? [{ service: 'DynamoDB', type: 'Tables', count: details.length, region, details }] : [];
}

async function collectElastiCache(creds: AwsCredentialIdentity, region: string): Promise<ResourceEntry[]> {
  const client = new ElastiCacheClient({ region, credentials: creds });
  const resp = await client.send(new DescribeCacheClustersCommand({}));
  const details: ResourceDetail[] = await Promise.all((resp.CacheClusters || []).map(async (cluster) => {
    const arn = (cluster as any).ARN || null;
    const tags = arn
      ? await safeResolveTags(async () => {
          const result = await client.send(new ElastiCacheListTagsForResourceCommand({ ResourceName: arn }));
          return (result.TagList || []) as Tag[];
        }, undefined as Tag[] | undefined)
      : undefined;
    return withResourceContext({
      id: arn || cluster.CacheClusterId || '-',
      name: cluster.CacheClusterId || '-',
      type: `${cluster.CacheNodeType || '-'} / ${cluster.Engine || '-'}`,
      state: cluster.CacheClusterStatus || '-',
    }, 'ElastiCache', 'Clusters', tags, tags !== undefined);
  }));
  return details.length > 0 ? [{ service: 'ElastiCache', type: 'Clusters', count: details.length, region, details }] : [];
}

async function collectSNS(creds: AwsCredentialIdentity, region: string): Promise<ResourceEntry[]> {
  const client = new SNSClient({ region, credentials: creds });
  const resp = await client.send(new ListTopicsCommand({}));
  const details: ResourceDetail[] = await Promise.all((resp.Topics || []).map(async (topic) => {
    const arn = topic.TopicArn || '-';
    const tags = arn
      ? await safeResolveTags(async () => {
          const result = await client.send(new SNSListTagsForResourceCommand({ ResourceArn: arn }));
          return (result.Tags || []) as Tag[];
        }, undefined as Tag[] | undefined)
      : undefined;
    return withResourceContext({
      id: arn,
      name: arn.split(':').pop() || '-',
      type: '-',
      state: '-',
    }, 'SNS', 'Topics', tags, tags !== undefined);
  }));
  return details.length > 0 ? [{ service: 'SNS', type: 'Topics', count: details.length, region, details }] : [];
}

async function collectSQS(creds: AwsCredentialIdentity, region: string): Promise<ResourceEntry[]> {
  const client = new SQSClient({ region, credentials: creds });
  const resp = await client.send(new ListQueuesCommand({}));
  const urls = resp.QueueUrls || [];
  const details: ResourceDetail[] = await Promise.all(urls.map(async (url) => {
    const tags = await safeResolveTags(async () => {
      const result = await client.send(new ListQueueTagsCommand({ QueueUrl: url }));
      return toTagsFromRecord(result.Tags);
    }, undefined as Tag[] | undefined);

    return withResourceContext({
      id: url,
      name: url.split('/').pop() || '-',
      type: '-',
      state: '-',
    }, 'SQS', 'Queues', tags, tags !== undefined);
  }));
  return details.length > 0 ? [{ service: 'SQS', type: 'Queues', count: details.length, region, details }] : [];
}

async function collectCloudFront(creds: AwsCredentialIdentity): Promise<ResourceEntry[]> {
  const client = new CloudFrontClient({ region: 'us-east-1', credentials: creds });
  const resp = await client.send(new ListDistributionsCommand({}));
  const items = resp.DistributionList?.Items || [];
  const details: ResourceDetail[] = await Promise.all(items.map(async (distribution) => {
    const arn = distribution.ARN || '-';
    const tags = arn
      ? await safeResolveTags(async () => {
          const result = await client.send(new CloudFrontListTagsForResourceCommand({ Resource: arn }));
          return (result.Tags?.Items || []) as Tag[];
        }, undefined as Tag[] | undefined)
      : undefined;
    return withResourceContext({
      id: arn,
      name: distribution.DomainName || '-',
      type: '-',
      state: distribution.Status || '-',
    }, 'CloudFront', 'Distributions', tags, tags !== undefined);
  }));
  return details.length > 0 ? [{ service: 'CloudFront', type: 'Distributions', count: details.length, region: 'global', details }] : [];
}

async function collectASG(creds: AwsCredentialIdentity, region: string): Promise<ResourceEntry[]> {
  const client = new AutoScalingClient({ region, credentials: creds });
  const resp = await client.send(new DescribeAutoScalingGroupsCommand({}));
  const details: ResourceDetail[] = (resp.AutoScalingGroups || []).map(g => withResourceContext({
    id: g.AutoScalingGroupARN || '-',
    name: g.AutoScalingGroupName || '-',
    type: '-',
    state: '-',
  }, 'Auto Scaling', 'Groups', g.Tags?.map(t => ({ Key: t.Key, Value: t.Value })) || []));
  return details.length > 0 ? [{ service: 'Auto Scaling', type: 'Groups', count: details.length, region, details }] : [];
}

async function collectAccount(accountId: string): Promise<{ accountId: string; resources: ResourceEntry[] }> {
  const creds = await getCredentials(accountId);
  const allResources: ResourceEntry[] = [];

  // Global services (S3, CloudFront) — only once
  const globalResults = await Promise.allSettled([
    collectS3(creds),
    collectCloudFront(creds),
  ]);
  for (const result of globalResults) {
    if (result.status === 'fulfilled') allResources.push(...result.value);
  }

  // Regional services — scan all regions
  for (const region of SCAN_REGIONS) {
    const results = await Promise.allSettled([
      collectEC2(creds, region),
      collectRDS(creds, region),
      collectLambda(creds, region),
      collectECS(creds, region),
      collectELB(creds, region),
      collectEKS(creds, region),
      collectDynamoDB(creds, region),
      collectElastiCache(creds, region),
      collectSNS(creds, region),
      collectSQS(creds, region),
      collectASG(creds, region),
    ]);

    for (const result of results) {
      if (result.status === 'fulfilled') allResources.push(...result.value);
      else {
        const msg = (result.reason as Error)?.message || '';
        // Ignore "not available in region" errors silently
        if (!msg.includes('not available') && !msg.includes('not supported')) {
          console.warn(`Collector error in ${accountId}/${region}:`, msg);
        }
      }
    }
  }

  return { accountId, resources: allResources };
}

export async function fetchInventory(
  accountIds: string[],
  options?: { accountNameMap?: Record<string, string> },
) {
  const BATCH_SIZE = 5;
  const accountResults: { accountId: string; resources: ResourceEntry[] }[] = [];
  const accountNameMap = options?.accountNameMap || {};

  for (let i = 0; i < accountIds.length; i += BATCH_SIZE) {
    const batch = accountIds.slice(i, i + BATCH_SIZE);
    const batchResults = await Promise.allSettled(batch.map(id => collectAccount(id)));
    for (const r of batchResults) {
      if (r.status === 'fulfilled') accountResults.push(r.value);
      else console.error('Account failed:', (r.reason as Error)?.message);
    }
  }

  const accounts: {
    accountId: string;
    accountName: string;
    totalResources: number;
    services: {
      name: string;
      serviceFamily?: string;
      resourceType?: string;
      resourceCount: number;
      estimatedMonthlyCost?: number | null;
      details: ResourceDetail[];
    }[];
  }[] = [];
  const serviceMap: Record<string, {
    serviceFamily: string;
    resourceType: string;
    resourceCount: number;
    estimatedMonthlyCost: number;
    regions: Set<string>;
    details: ResourceDetail[];
  }> = {};
  let totalResources = 0;

  for (const { accountId, resources } of accountResults) {
    const accServices: Record<string, {
      serviceFamily: string;
      resourceType: string;
      resourceCount: number;
      estimatedMonthlyCost: number;
      details: ResourceDetail[];
    }> = {};
    let accTotal = 0;
    const accountName = accountNameMap[accountId] || AWS_ACCOUNT_NAMES[accountId] || accountId;

    for (const r of resources) {
      accTotal += r.count;
      totalResources += r.count;
      const detailsWithScope = r.details.map((detail) => ({
        ...detail,
        metadata: {
          ...detail.metadata,
          accountId,
          accountName,
          region: r.region,
        },
      }));

      const key = `${r.service} - ${r.type}`;
      const { serviceFamily, resourceType } = splitInventoryServiceKey(key);
      if (!accServices[key]) {
        accServices[key] = {
          serviceFamily,
          resourceType,
          resourceCount: 0,
          estimatedMonthlyCost: 0,
          details: [],
        };
      }
      accServices[key].resourceCount += r.count;
      accServices[key].estimatedMonthlyCost += detailsWithScope.reduce((sum, detail) => sum + (detail.estimatedMonthlyCost || 0), 0);
      accServices[key].details.push(...detailsWithScope);

      if (!serviceMap[key]) {
        serviceMap[key] = {
          serviceFamily,
          resourceType,
          resourceCount: 0,
          estimatedMonthlyCost: 0,
          regions: new Set(),
          details: [],
        };
      }
      serviceMap[key].resourceCount += r.count;
      serviceMap[key].estimatedMonthlyCost += detailsWithScope.reduce((sum, detail) => sum + (detail.estimatedMonthlyCost || 0), 0);
      serviceMap[key].regions.add(r.region);
      serviceMap[key].details.push(...detailsWithScope);
    }

    accounts.push({
      accountId,
      accountName,
      totalResources: accTotal,
      services: Object.entries(accServices)
        .map(([name, d]) => ({
          name,
          serviceFamily: d.serviceFamily,
          resourceType: d.resourceType,
          resourceCount: d.resourceCount,
          estimatedMonthlyCost: d.estimatedMonthlyCost > 0 ? Number(d.estimatedMonthlyCost.toFixed(2)) : null,
          details: d.details,
        }))
        .sort((a, b) => b.resourceCount - a.resourceCount)
    });
  }

  const byService = Object.entries(serviceMap)
    .map(([service, d]) => ({
      service,
      serviceFamily: d.serviceFamily,
      resourceType: d.resourceType,
      resourceCount: d.resourceCount,
      estimatedMonthlyCost: d.estimatedMonthlyCost > 0 ? Number(d.estimatedMonthlyCost.toFixed(2)) : null,
      regions: [...d.regions].sort(),
      details: d.details,
    }))
    .sort((a, b) => b.resourceCount - a.resourceCount);

  const regionMap: Record<string, number> = {};
  for (const { resources } of accountResults) {
    for (const r of resources) {
      if (!regionMap[r.region]) regionMap[r.region] = 0;
      regionMap[r.region] += r.count;
    }
  }
  const byRegion = Object.entries(regionMap)
    .map(([region, resourceCount]) => ({ region, resourceCount }))
    .sort((a, b) => b.resourceCount - a.resourceCount);

  return {
    dateRange: { start: new Date().toISOString().split('T')[0], end: new Date().toISOString().split('T')[0] },
    totalResources,
    accounts: accounts.sort((a, b) => b.totalResources - a.totalResources),
    byService,
    byRegion,
    resources: []
  };
}
