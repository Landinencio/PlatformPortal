import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { EC2Client, DescribeInstancesCommand, DescribeVpcsCommand, DescribeSubnetsCommand, DescribeSecurityGroupsCommand, DescribeNatGatewaysCommand, DescribeInternetGatewaysCommand, DescribeVolumesCommand, DescribeAddressesCommand, DescribeNetworkInterfacesCommand } from '@aws-sdk/client-ec2';
import { RDSClient, DescribeDBInstancesCommand, DescribeDBClustersCommand } from '@aws-sdk/client-rds';
import { LambdaClient, ListFunctionsCommand } from '@aws-sdk/client-lambda';
import { S3Client, ListBucketsCommand } from '@aws-sdk/client-s3';
import { ECSClient, ListClustersCommand, ListServicesCommand } from '@aws-sdk/client-ecs';
import { ElasticLoadBalancingV2Client, DescribeLoadBalancersCommand, DescribeTargetGroupsCommand } from '@aws-sdk/client-elastic-load-balancing-v2';
import { EKSClient, ListClustersCommand as EKSListClustersCommand } from '@aws-sdk/client-eks';
import { DynamoDBClient, ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { ElastiCacheClient, DescribeCacheClustersCommand } from '@aws-sdk/client-elasticache';
import { SNSClient, ListTopicsCommand } from '@aws-sdk/client-sns';
import { SQSClient, ListQueuesCommand } from '@aws-sdk/client-sqs';
import { CloudFrontClient, ListDistributionsCommand } from '@aws-sdk/client-cloudfront';
import { AutoScalingClient, DescribeAutoScalingGroupsCommand } from '@aws-sdk/client-auto-scaling';

const REGION = 'eu-west-1';
const stsClient = new STSClient({ region: REGION });

const ACCOUNT_NAMES = {
  '111122223333': 'EKS Dev / Default', '222233334444': 'EKS UAT', '333344445555': 'EKS Prod',
  '444455556666': 'EKS Tooling', '555566667777': 'Helios Dev', '666677778888': 'Helios UAT',
  '777788889999': 'Helios Prod', '888899990000': 'Digital Ecommerce', '999900001111': 'Digital Dev',
  '000011112222': 'Digital UAT', '111222333444': 'Digital Prod', '222333444555': 'Ecommerce Tiendanimal',
  '333444555666': 'IskayPet Ecommerce', '444555666777': 'Retail Dev', '555666777888': 'Retail UAT',
  '666777888999': 'Retail Prod', '777888999000': 'Animalis Dev', '888999000111': 'Animalis Prod',
  '999000111222': 'Clinicanimal', '100200300400': 'Data Dev', '200300400500': 'IskayPet Data',
  '300400500600': 'Infra', '400500600700': 'SAP', '500600700800': 'Sistemas Tiendanimal'
};

const ALL_ACCOUNT_IDS = Object.keys(ACCOUNT_NAMES);

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    body: JSON.stringify(body)
  };
}

// ─── Assume role into target account ────────────────────────────────────────
async function getCredentials(accountId) {
  const roleArn = `arn:aws:iam::${accountId}:role/n8n-cost-reader-role`;
  const resp = await stsClient.send(new AssumeRoleCommand({
    RoleArn: roleArn,
    RoleSessionName: `inventory-${accountId}`,
    DurationSeconds: 900
  }));
  return {
    accessKeyId: resp.Credentials.AccessKeyId,
    secretAccessKey: resp.Credentials.SecretAccessKey,
    sessionToken: resp.Credentials.SessionToken,
  };
}

// ─── Service collectors ─────────────────────────────────────────────────────
async function collectEC2(creds, region) {
  const client = new EC2Client({ region, credentials: creds });
  const resources = [];

  // Instances
  const instances = await client.send(new DescribeInstancesCommand({}));
  let count = 0;
  for (const r of instances.Reservations || []) {
    count += (r.Instances || []).length;
  }
  if (count > 0) resources.push({ service: 'EC2', type: 'Instances', count, region });

  // Volumes
  const volumes = await client.send(new DescribeVolumesCommand({}));
  const volCount = (volumes.Volumes || []).length;
  if (volCount > 0) resources.push({ service: 'EC2', type: 'EBS Volumes', count: volCount, region });

  // Security Groups
  const sgs = await client.send(new DescribeSecurityGroupsCommand({}));
  const sgCount = (sgs.SecurityGroups || []).length;
  if (sgCount > 0) resources.push({ service: 'EC2', type: 'Security Groups', count: sgCount, region });

  // VPCs
  const vpcs = await client.send(new DescribeVpcsCommand({}));
  const vpcCount = (vpcs.Vpcs || []).length;
  if (vpcCount > 0) resources.push({ service: 'VPC', type: 'VPCs', count: vpcCount, region });

  // Subnets
  const subnets = await client.send(new DescribeSubnetsCommand({}));
  const subCount = (subnets.Subnets || []).length;
  if (subCount > 0) resources.push({ service: 'VPC', type: 'Subnets', count: subCount, region });

  // NAT Gateways
  const nats = await client.send(new DescribeNatGatewaysCommand({}));
  const natCount = (nats.NatGateways || []).filter(n => n.State === 'available').length;
  if (natCount > 0) resources.push({ service: 'VPC', type: 'NAT Gateways', count: natCount, region });

  // Internet Gateways
  const igws = await client.send(new DescribeInternetGatewaysCommand({}));
  const igwCount = (igws.InternetGateways || []).length;
  if (igwCount > 0) resources.push({ service: 'VPC', type: 'Internet Gateways', count: igwCount, region });

  // Elastic IPs
  const eips = await client.send(new DescribeAddressesCommand({}));
  const eipCount = (eips.Addresses || []).length;
  if (eipCount > 0) resources.push({ service: 'EC2', type: 'Elastic IPs', count: eipCount, region });

  // ENIs
  const enis = await client.send(new DescribeNetworkInterfacesCommand({}));
  const eniCount = (enis.NetworkInterfaces || []).length;
  if (eniCount > 0) resources.push({ service: 'VPC', type: 'Network Interfaces', count: eniCount, region });

  return resources;
}

async function collectRDS(creds, region) {
  const client = new RDSClient({ region, credentials: creds });
  const resources = [];

  const instances = await client.send(new DescribeDBInstancesCommand({}));
  const dbCount = (instances.DBInstances || []).length;
  if (dbCount > 0) resources.push({ service: 'RDS', type: 'DB Instances', count: dbCount, region });

  const clusters = await client.send(new DescribeDBClustersCommand({}));
  const clusterCount = (clusters.DBClusters || []).length;
  if (clusterCount > 0) resources.push({ service: 'RDS', type: 'DB Clusters', count: clusterCount, region });

  return resources;
}

async function collectLambda(creds, region) {
  const client = new LambdaClient({ region, credentials: creds });
  let count = 0;
  let marker;
  do {
    const resp = await client.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }));
    count += (resp.Functions || []).length;
    marker = resp.NextMarker;
  } while (marker);
  return count > 0 ? [{ service: 'Lambda', type: 'Functions', count, region }] : [];
}

async function collectS3(creds) {
  const client = new S3Client({ region: REGION, credentials: creds });
  const resp = await client.send(new ListBucketsCommand({}));
  const count = (resp.Buckets || []).length;
  return count > 0 ? [{ service: 'S3', type: 'Buckets', count, region: 'global' }] : [];
}

async function collectECS(creds, region) {
  const client = new ECSClient({ region, credentials: creds });
  const resources = [];

  const clusters = await client.send(new ListClustersCommand({}));
  const clusterArns = clusters.clusterArns || [];
  if (clusterArns.length > 0) resources.push({ service: 'ECS', type: 'Clusters', count: clusterArns.length, region });

  let totalServices = 0;
  for (const arn of clusterArns) {
    const svcs = await client.send(new ListServicesCommand({ cluster: arn }));
    totalServices += (svcs.serviceArns || []).length;
  }
  if (totalServices > 0) resources.push({ service: 'ECS', type: 'Services', count: totalServices, region });

  return resources;
}

async function collectELB(creds, region) {
  const client = new ElasticLoadBalancingV2Client({ region, credentials: creds });
  const resources = [];

  const lbs = await client.send(new DescribeLoadBalancersCommand({}));
  const lbCount = (lbs.LoadBalancers || []).length;
  if (lbCount > 0) resources.push({ service: 'ELB', type: 'Load Balancers', count: lbCount, region });

  const tgs = await client.send(new DescribeTargetGroupsCommand({}));
  const tgCount = (tgs.TargetGroups || []).length;
  if (tgCount > 0) resources.push({ service: 'ELB', type: 'Target Groups', count: tgCount, region });

  return resources;
}

async function collectEKS(creds, region) {
  const client = new EKSClient({ region, credentials: creds });
  const resp = await client.send(new EKSListClustersCommand({}));
  const count = (resp.clusters || []).length;
  return count > 0 ? [{ service: 'EKS', type: 'Clusters', count, region }] : [];
}

async function collectDynamoDB(creds, region) {
  const client = new DynamoDBClient({ region, credentials: creds });
  const resp = await client.send(new ListTablesCommand({}));
  const count = (resp.TableNames || []).length;
  return count > 0 ? [{ service: 'DynamoDB', type: 'Tables', count, region }] : [];
}

async function collectElastiCache(creds, region) {
  const client = new ElastiCacheClient({ region, credentials: creds });
  const resp = await client.send(new DescribeCacheClustersCommand({}));
  const count = (resp.CacheClusters || []).length;
  return count > 0 ? [{ service: 'ElastiCache', type: 'Clusters', count, region }] : [];
}

async function collectSNS(creds, region) {
  const client = new SNSClient({ region, credentials: creds });
  const resp = await client.send(new ListTopicsCommand({}));
  const count = (resp.Topics || []).length;
  return count > 0 ? [{ service: 'SNS', type: 'Topics', count, region }] : [];
}

async function collectSQS(creds, region) {
  const client = new SQSClient({ region, credentials: creds });
  const resp = await client.send(new ListQueuesCommand({}));
  const count = (resp.QueueUrls || []).length;
  return count > 0 ? [{ service: 'SQS', type: 'Queues', count, region }] : [];
}

async function collectCloudFront(creds) {
  const client = new CloudFrontClient({ region: 'us-east-1', credentials: creds });
  const resp = await client.send(new ListDistributionsCommand({}));
  const count = resp.DistributionList?.Items?.length || 0;
  return count > 0 ? [{ service: 'CloudFront', type: 'Distributions', count, region: 'global' }] : [];
}

async function collectASG(creds, region) {
  const client = new AutoScalingClient({ region, credentials: creds });
  const resp = await client.send(new DescribeAutoScalingGroupsCommand({}));
  const count = (resp.AutoScalingGroups || []).length;
  return count > 0 ? [{ service: 'Auto Scaling', type: 'Groups', count, region }] : [];
}

// ─── Collect all resources for one account ──────────────────────────────────
async function collectAccount(accountId) {
  const creds = await getCredentials(accountId);
  const region = REGION;
  const allResources = [];

  // Run all collectors in parallel
  const results = await Promise.allSettled([
    collectEC2(creds, region),
    collectRDS(creds, region),
    collectLambda(creds, region),
    collectS3(creds),
    collectECS(creds, region),
    collectELB(creds, region),
    collectEKS(creds, region),
    collectDynamoDB(creds, region),
    collectElastiCache(creds, region),
    collectSNS(creds, region),
    collectSQS(creds, region),
    collectCloudFront(creds),
    collectASG(creds, region),
  ]);

  for (const result of results) {
    if (result.status === 'fulfilled') {
      allResources.push(...result.value);
    } else {
      console.warn(`Collector error in ${accountId}:`, result.reason?.message);
    }
  }

  return { accountId, resources: allResources };
}

// ─── Main handler ───────────────────────────────────────────────────────────
export const handler = async (event) => {
  try {
    let parsedBody;
    if (event.body) {
      parsedBody = typeof event.body === 'string' ? JSON.parse(event.body) : event.body;
    } else {
      parsedBody = event;
    }

    const query = parsedBody.query || {};
    const requestedAccounts = query.accountIds
      ? query.accountIds.split(',').map(id => id.trim())
      : ALL_ACCOUNT_IDS;

    // Process accounts in batches of 5 to avoid STS throttling
    const BATCH_SIZE = 5;
    const accountResults = [];
    for (let i = 0; i < requestedAccounts.length; i += BATCH_SIZE) {
      const batch = requestedAccounts.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(accId => collectAccount(accId))
      );
      for (const r of batchResults) {
        if (r.status === 'fulfilled') accountResults.push(r.value);
        else console.error('Account failed:', r.reason?.message);
      }
    }

    // Aggregate
    const accounts = [];
    const serviceMap = {};
    const regionSet = new Set();
    let totalResources = 0;

    for (const { accountId, resources } of accountResults) {
      const accServices = {};
      let accTotal = 0;

      for (const r of resources) {
        accTotal += r.count;
        totalResources += r.count;
        regionSet.add(r.region);

        // Per-account service aggregation
        const key = `${r.service} - ${r.type}`;
        if (!accServices[key]) accServices[key] = { resourceCount: 0 };
        accServices[key].resourceCount += r.count;

        // Global service aggregation
        if (!serviceMap[key]) serviceMap[key] = { resourceCount: 0, regions: new Set() };
        serviceMap[key].resourceCount += r.count;
        serviceMap[key].regions.add(r.region);
      }

      accounts.push({
        accountId,
        accountName: ACCOUNT_NAMES[accountId] || accountId,
        totalResources: accTotal,
        services: Object.entries(accServices)
          .map(([name, d]) => ({ name, resourceCount: d.resourceCount }))
          .sort((a, b) => b.resourceCount - a.resourceCount)
      });
    }

    const byService = Object.entries(serviceMap)
      .map(([service, d]) => ({
        service,
        resourceCount: d.resourceCount,
        regions: [...d.regions].sort()
      }))
      .sort((a, b) => b.resourceCount - a.resourceCount);

    const byRegion = [...regionSet].map(region => ({ region, resourceCount: 0 }))
      .sort((a, b) => a.region.localeCompare(b.region));

    return jsonResponse(200, {
      dateRange: { start: new Date().toISOString().split('T')[0], end: new Date().toISOString().split('T')[0] },
      totalResources,
      accounts: accounts.sort((a, b) => b.totalResources - a.totalResources),
      byService,
      byRegion,
      resources: []
    });

  } catch (error) {
    console.error('Error:', error);
    return jsonResponse(500, { error: error.message });
  }
};
