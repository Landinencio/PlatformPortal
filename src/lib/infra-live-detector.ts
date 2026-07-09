/**
 * Infra "live in AWS" detector.
 *
 * Source of truth for "the requested infra is REALLY created" is AWS itself,
 * NOT the GitLab pipeline state (an apply can time out on the runner yet the
 * resource exists; multi-env applies run as separate stages; branch names
 * collide with real SRE tickets). This module polls AWS directly per
 * environment account using the read-only n8n-cost-reader-role, and notifies
 * the requestor once the resource exists in ALL requested environments.
 *
 * Run by the infra-live-check cronjob (every ~10 min) hitting
 * POST /api/infra-requests/live-check with the internal secret.
 */

import { STSClient, AssumeRoleCommand } from "@aws-sdk/client-sts";
import { SQSClient, GetQueueUrlCommand } from "@aws-sdk/client-sqs";
import { SNSClient, ListTopicsCommand } from "@aws-sdk/client-sns";
import { DynamoDBClient, DescribeTableCommand } from "@aws-sdk/client-dynamodb";
import { RDSClient, DescribeDBInstancesCommand } from "@aws-sdk/client-rds";
import { SecretsManagerClient, ListSecretsCommand } from "@aws-sdk/client-secrets-manager";
import { S3Client, HeadBucketCommand } from "@aws-sdk/client-s3";
import { EventBridgeClient, ListRulesCommand } from "@aws-sdk/client-eventbridge";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import pool from "@/lib/db";
import { createNotification } from "@/lib/notifications";

const REGION = "eu-west-1";
const sts = new STSClient({ region: REGION });

async function getCreds(accountId: string): Promise<AwsCredentialIdentity> {
  const resp = await sts.send(
    new AssumeRoleCommand({
      RoleArn: `arn:aws:iam::${accountId}:role/n8n-cost-reader-role`,
      RoleSessionName: `infra-live-${accountId}`,
      DurationSeconds: 900,
    })
  );
  return {
    accessKeyId: resp.Credentials!.AccessKeyId!,
    secretAccessKey: resp.Credentials!.SecretAccessKey!,
    sessionToken: resp.Credentials!.SessionToken!,
  };
}

// ── Per-resource existence checks ──────────────────────────────────────────

async function sqsExists(creds: AwsCredentialIdentity, name: string): Promise<boolean> {
  const c = new SQSClient({ region: REGION, credentials: creds });
  try {
    await c.send(new GetQueueUrlCommand({ QueueName: name }));
    return true;
  } catch {
    return false;
  }
}

async function snsExists(creds: AwsCredentialIdentity, name: string): Promise<boolean> {
  const c = new SNSClient({ region: REGION, credentials: creds });
  try {
    let token: string | undefined;
    do {
      const r = await c.send(new ListTopicsCommand({ NextToken: token }));
      if ((r.Topics || []).some((t) => (t.TopicArn || "").endsWith(`:${name}`))) return true;
      token = r.NextToken;
    } while (token);
    return false;
  } catch {
    return false;
  }
}

async function dynamoExists(creds: AwsCredentialIdentity, name: string): Promise<boolean> {
  const c = new DynamoDBClient({ region: REGION, credentials: creds });
  try {
    await c.send(new DescribeTableCommand({ TableName: name }));
    return true;
  } catch {
    return false;
  }
}

async function rdsExists(creds: AwsCredentialIdentity, identifier: string): Promise<boolean> {
  const c = new RDSClient({ region: REGION, credentials: creds });
  try {
    const r = await c.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }));
    const inst = (r.DBInstances || [])[0];
    // "available" or at least present; treat creating as not-yet-live.
    return !!inst && ["available", "backing-up", "modifying"].includes(inst.DBInstanceStatus || "");
  } catch {
    return false;
  }
}

/** Returns the master-credentials secret ARN AWS auto-creates for an RDS instance. */
async function rdsMasterSecretArn(creds: AwsCredentialIdentity, identifier: string): Promise<string | null> {
  const c = new RDSClient({ region: REGION, credentials: creds });
  try {
    const r = await c.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: identifier }));
    const inst = (r.DBInstances || [])[0];
    return inst?.MasterUserSecret?.SecretArn || null;
  } catch {
    return null;
  }
}

async function s3Exists(creds: AwsCredentialIdentity, bucket: string): Promise<boolean> {
  const c = new S3Client({ region: REGION, credentials: creds });
  try {
    await c.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch {
    return false;
  }
}

async function secretExists(creds: AwsCredentialIdentity, name: string): Promise<boolean> {
  const c = new SecretsManagerClient({ region: REGION, credentials: creds });
  try {
    const r = await c.send(new ListSecretsCommand({
      Filters: [{ Key: "name", Values: [name] }],
      MaxResults: 10,
    }));
    return (r.SecretList || []).some((s) => s.Name === name);
  } catch {
    return false;
  }
}

async function eventBridgeRuleExists(creds: AwsCredentialIdentity, busName: string, ruleName: string): Promise<boolean> {
  const c = new EventBridgeClient({ region: REGION, credentials: creds });
  try {
    const r = await c.send(new ListRulesCommand({ EventBusName: busName, NamePrefix: ruleName }));
    return (r.Rules || []).some((rule) => rule.Name === ruleName);
  } catch {
    return false;
  }
}

// ── Resource dispatch ──────────────────────────────────────────────────────

interface InfraReqRow {
  id: number;
  requestor_email: string;
  resource_type: string;
  payload: any;
}

/** Map env keyword (dev/uat/pro) to the AWS account id for this request. */
function accountsForRequest(payload: any): Record<string, string | null> {
  // Squad infra requests carry their own account ids; SRE infra (digital) uses
  // the digital accounts. Default to digital accounts when not specified.
  const fromPayload = payload.awsAccounts || {};
  return {
    dev: fromPayload.dev || payload.awsAccountDev || "999900001111",
    uat: fromPayload.uat || payload.awsAccountUat || "000011112222",
    pro: fromPayload.pro || payload.awsAccountPro || "111222333444",
  };
}

async function resourceExistsInAccount(
  resourceType: string,
  payload: any,
  creds: AwsCredentialIdentity
): Promise<boolean> {
  const baseType = resourceType.replace(/^squad-/, "");
  const cfg = payload.config || {};
  const name = payload.resourceName || payload.identifier || cfg.name;

  switch (baseType) {
    case "sqs": return sqsExists(creds, cfg.name || name);
    case "sns": return snsExists(creds, cfg.name || name);
    case "dynamodb": return dynamoExists(creds, cfg.name || name);
    case "secret": return secretExists(creds, cfg.name || name);
    case "eventbridge": return eventBridgeRuleExists(creds, cfg.busName || "default", cfg.ruleName || name);
    case "rds": return rdsExists(creds, name);
    case "s3": return s3Exists(creds, name);
    default: return false;
  }
}

// ── Main loop ──────────────────────────────────────────────────────────────

export interface LiveCheckResult {
  checked: number;
  notified: number;
  details: Array<{ id: number; resourceType: string; liveEnvs: string[]; pendingEnvs: string[]; notified: boolean }>;
}

export async function runInfraLiveCheck(): Promise<LiveCheckResult> {
  // Only requests that executed (branch+MR created) and not yet notified.
  // secret-update has nothing to detect in AWS (it's a value rotation) → skip.
  const { rows } = await pool.query<InfraReqRow>(
    `SELECT id, requestor_email, resource_type, payload
     FROM infra_requests
     WHERE status = 'executed'
       AND infra_live_notified = false
       AND resource_type NOT IN ('squad-secret-update')
     ORDER BY executed_at ASC NULLS LAST
     LIMIT 50`
  );

  const result: LiveCheckResult = { checked: rows.length, notified: 0, details: [] };

  for (const req of rows) {
    const payload = typeof req.payload === "string" ? JSON.parse(req.payload) : (req.payload || {});
    const envs: string[] = payload.environments || payload.target_environments || ["pro"];
    const accounts = accountsForRequest(payload);

    const liveEnvs: string[] = [];
    const pendingEnvs: string[] = [];

    for (const env of envs) {
      const accountId = accounts[env];
      if (!accountId) { pendingEnvs.push(env); continue; }
      try {
        const creds = await getCreds(accountId);
        const exists = await resourceExistsInAccount(req.resource_type, payload, creds);
        if (exists) liveEnvs.push(env); else pendingEnvs.push(env);
      } catch (err) {
        console.error(`[infra-live] req #${req.id} env ${env} (acct ${accountId}) check failed:`, err);
        pendingEnvs.push(env);
      }
    }

    let notified = false;
    // Notify only when the resource exists in ALL requested environments.
    if (pendingEnvs.length === 0 && liveEnvs.length > 0) {
      const baseType = req.resource_type.replace(/^squad-/, "");
      const resourceName = payload.resourceName || payload.identifier || (payload.config?.name) || "tu recurso";

      let extra = "";
      if (baseType === "rds") {
        // Resolve the master-credentials secret in the prod (or first) account.
        const acct = accounts.pro || accounts.dev || accounts.uat;
        if (acct) {
          try {
            const creds = await getCreds(acct);
            const arn = await rdsMasterSecretArn(creds, resourceName);
            if (arn) {
              extra = `\n\n🔐 La contraseña del usuario administrador está en AWS Secrets Manager (gestionada y rotada cada 15 días):\n${arn}\nÚsala para conectar; no la copies a ningún sitio.`;
            }
          } catch { /* best effort */ }
        }
        if (!extra) {
          extra = `\n\n🔐 La contraseña del usuario administrador está en AWS Secrets Manager (rotada cada 15 días), asociada a la instancia "${resourceName}".`;
        }
      }

      await createNotification({
        userEmail: req.requestor_email,
        type: "info",
        title: `✅ Infraestructura creada en AWS: ${resourceName}`,
        message: `Tu solicitud #${req.id} (${baseType.toUpperCase()}) ya está disponible en AWS en ${liveEnvs.join(", ")}.${extra}`,
        link: "/infra-requests",
        metadata: { requestId: req.id, liveEnvs },
      }).catch(() => {});

      await pool.query(`UPDATE infra_requests SET infra_live_notified = true WHERE id = $1`, [req.id]);
      notified = true;
      result.notified++;
      console.log(`[infra-live] ✓ Notified ${req.requestor_email}: req #${req.id} (${baseType}) live in ${liveEnvs.join(", ")}`);
    }

    result.details.push({ id: req.id, resourceType: req.resource_type, liveEnvs, pendingEnvs, notified });
  }

  return result;
}
