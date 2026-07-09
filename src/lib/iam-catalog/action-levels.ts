/**
 * IAM action access-level classification.
 *
 * Pure module (no React, no `node:*`) that maps every IAM action used by the
 * IAM Catalog presets to its AWS access level, and offers total helpers to
 * decide whether an action is read-only or belongs to the RDS data plane.
 *
 * The map is a curated subset derived from the AWS IAM reference, covering
 * exactly the actions referenced by the 45 presets across 23 services in the
 * design document. Levels follow the AWS convention:
 *   - "List"        — enumerate resources
 *   - "Read"        — read a resource / its metadata
 *   - "Write"       — create/update/delete/invoke a resource
 *   - "Permissions" — manage permissions (never used by presets)
 *   - "Tagging"     — manage tags (never used by presets)
 *
 * Requirements: 1.5 (read-only ⇔ List/Read), 1.7 (RDS data-plane exclusion).
 */

export type ActionLevel = "List" | "Read" | "Write" | "Permissions" | "Tagging";

/**
 * Curated map of IAM action → AWS access level for every action used by the
 * catalog presets. Kept immutable so no consumer can reclassify at runtime.
 */
export const ACTION_LEVELS: Readonly<Record<string, ActionLevel>> = Object.freeze({
  // --- S3 (also datalake presets) ---
  "s3:GetObject": "Read",
  "s3:ListBucket": "List",
  "s3:GetBucketLocation": "Read",
  "s3:PutObject": "Write",
  "s3:DeleteObject": "Write",
  "s3:AbortMultipartUpload": "Write",

  // --- SQS ---
  "sqs:ReceiveMessage": "Read",
  "sqs:DeleteMessage": "Write",
  "sqs:GetQueueAttributes": "Read",
  "sqs:GetQueueUrl": "Read",
  "sqs:ChangeMessageVisibility": "Write",
  "sqs:SendMessage": "Write",
  "sqs:ListQueues": "List",

  // --- SNS ---
  "sns:Publish": "Write",
  "sns:GetTopicAttributes": "Read",
  "sns:ListSubscriptionsByTopic": "List",

  // --- EventBridge (events) ---
  "events:PutEvents": "Write",
  "events:DescribeRule": "Read",
  "events:ListRules": "List",
  "events:ListTargetsByRule": "List",

  // --- DynamoDB ---
  "dynamodb:GetItem": "Read",
  "dynamodb:BatchGetItem": "Read",
  "dynamodb:Query": "Read",
  "dynamodb:Scan": "Read",
  "dynamodb:DescribeTable": "Read",
  "dynamodb:PutItem": "Write",
  "dynamodb:UpdateItem": "Write",
  "dynamodb:DeleteItem": "Write",
  "dynamodb:BatchWriteItem": "Write",

  // --- Secrets Manager ---
  "secretsmanager:GetSecretValue": "Read",
  "secretsmanager:DescribeSecret": "Read",
  "secretsmanager:PutSecretValue": "Write",
  "secretsmanager:UpdateSecret": "Write",

  // --- SSM Parameter Store ---
  "ssm:GetParameter": "Read",
  "ssm:GetParameters": "Read",
  "ssm:GetParametersByPath": "Read",
  "ssm:PutParameter": "Write",

  // --- CloudWatch Logs ---
  "logs:CreateLogStream": "Write",
  "logs:PutLogEvents": "Write",
  "logs:DescribeLogStreams": "List",
  "logs:GetLogEvents": "Read",
  "logs:FilterLogEvents": "Read",
  "logs:DescribeLogGroups": "List",

  // --- CloudWatch Metrics ---
  "cloudwatch:PutMetricData": "Write",
  "cloudwatch:GetMetricData": "Read",
  "cloudwatch:ListMetrics": "List",
  "cloudwatch:GetMetricStatistics": "Read",

  // --- Kinesis ---
  "kinesis:GetRecords": "Read",
  "kinesis:GetShardIterator": "Read",
  "kinesis:DescribeStream": "Read",
  "kinesis:ListShards": "List",
  "kinesis:PutRecord": "Write",
  "kinesis:PutRecords": "Write",

  // --- Lambda ---
  "lambda:InvokeFunction": "Write",
  "lambda:GetFunction": "Read",
  "lambda:ListFunctions": "List",
  "lambda:GetFunctionConfiguration": "Read",

  // --- Step Functions (states) ---
  "states:StartExecution": "Write",
  "states:DescribeExecution": "Read",
  "states:StopExecution": "Write",
  "states:ListExecutions": "List",
  "states:GetExecutionHistory": "Read",

  // --- SES ---
  "ses:SendEmail": "Write",
  "ses:SendRawEmail": "Write",
  "ses:GetSendQuota": "Read",
  "ses:ListIdentities": "List",
  "ses:GetIdentityVerificationAttributes": "Read",

  // --- Bedrock ---
  "bedrock:InvokeModel": "Write",
  "bedrock:InvokeModelWithResponseStream": "Write",
  "bedrock:ListFoundationModels": "List",
  "bedrock:GetFoundationModel": "Read",

  // --- Athena ---
  "athena:GetQueryExecution": "Read",
  "athena:GetQueryResults": "Read",
  "athena:ListQueryExecutions": "List",
  "athena:GetWorkGroup": "Read",
  "athena:StartQueryExecution": "Write",
  "athena:StopQueryExecution": "Write",

  // --- Glue (Data Catalog + jobs) ---
  "glue:GetDatabase": "Read",
  "glue:GetTable": "Read",
  "glue:GetTables": "Read",
  "glue:GetPartitions": "Read",
  "glue:StartJobRun": "Write",
  "glue:GetJobRun": "Read",
  "glue:GetJobRuns": "Read",
  "glue:BatchStopJobRun": "Write",

  // --- Lake Formation ---
  "lakeformation:GetDataAccess": "Read",
  "lakeformation:GetResourceLFTags": "Read",
  "lakeformation:SearchTablesByLFTags": "Read",

  // --- Kinesis Firehose ---
  "firehose:PutRecord": "Write",
  "firehose:PutRecordBatch": "Write",
  "firehose:DescribeDeliveryStream": "Read",

  // --- Redshift Data API ---
  "redshift-data:GetStatementResult": "Read",
  "redshift-data:DescribeStatement": "Read",
  "redshift-data:ListStatements": "List",
  "redshift-data:ExecuteStatement": "Write",
  "redshift-data:BatchExecuteStatement": "Write",

  // --- EMR (elasticmapreduce) ---
  "elasticmapreduce:DescribeCluster": "Read",
  "elasticmapreduce:ListClusters": "List",
  "elasticmapreduce:ListSteps": "List",
  "elasticmapreduce:AddJobFlowSteps": "Write",
  "elasticmapreduce:TerminateJobFlows": "Write",

  // --- MSK / Kafka (IAM auth) ---
  "kafka-cluster:Connect": "Write",
  "kafka-cluster:DescribeGroup": "Read",
  "kafka-cluster:ReadData": "Read",
  "kafka-cluster:DescribeTopic": "Read",
  "kafka-cluster:WriteData": "Write",
  "kafka-cluster:WriteDataIdempotently": "Write",

  // --- SageMaker ---
  "sagemaker:DescribeEndpoint": "Read",
  "sagemaker:ListEndpoints": "List",
  "sagemaker:DescribeModel": "Read",
  "sagemaker:InvokeEndpoint": "Write",
});

/**
 * Returns true iff the action is classified as a read-only access level
 * (List or Read). Total: never throws. Unknown actions (not in the curated
 * map) are treated conservatively as NOT read-only.
 *
 * Requirement 1.5.
 */
export function isReadOnlyAction(action: string): boolean {
  if (typeof action !== "string") return false;
  const level = ACTION_LEVELS[action];
  return level === "List" || level === "Read";
}

/**
 * Returns true iff the action belongs to the RDS data plane — i.e. it grants
 * IAM authentication or data access to the database itself:
 *   - `rds-db:*`      (IAM DB authentication)
 *   - `rds-data:*`    (RDS Data API)
 *   - `rds:Connect*`  (IAM connect to a DB proxy / cluster)
 *
 * Total: never throws for any input (guards against non-string values) and
 * matches case-insensitively. Used to enforce the RDS data-plane exclusion.
 *
 * Requirement 1.7 (and 6.8 downstream).
 */
export function isRdsDataPlaneAction(action: string): boolean {
  if (typeof action !== "string") return false;
  const a = action.trim().toLowerCase();
  if (a.startsWith("rds-db:")) return true;
  if (a.startsWith("rds-data:")) return true;
  if (a.startsWith("rds:connect")) return true;
  return false;
}
