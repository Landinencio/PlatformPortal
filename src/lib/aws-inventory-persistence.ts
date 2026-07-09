/**
 * AWS Inventory Persistence
 *
 * Saves and loads inventory snapshots from the database so the UI
 * loads instantly from cached data instead of calling AWS APIs every time.
 */

import pool from "@/lib/db";
import type { InventoryResponse } from "@/lib/aws-inventory";

const SNAPSHOT_STALE_HOURS = 24; // Snapshots older than this are considered stale

export type InventorySnapshotMeta = {
  id: number;
  snapshotDate: string;
  accountIds: string[];
  resourceCount: number;
  estimatedMonthlyCost: number | null;
  eolResourcesCount: number;
  createdAt: string;
  isStale: boolean;
};

export type EolResource = {
  accountId: string;
  accountName: string | null;
  region: string;
  resourceId: string;
  resourceName: string | null;
  resourceType: string;
  eolType: string;
  eolDate: string | null;
};

/** Save an inventory snapshot to the database */
export async function saveInventorySnapshot(
  accountIds: string[],
  data: InventoryResponse
): Promise<number> {
  const sortedIds = [...accountIds].sort();
  const snapshotDate = new Date().toISOString().split("T")[0];

  // Count EOL resources
  const eolResources = extractEolResources(data);
  const resourceCount = data.byService.reduce((sum, s) => sum + s.resourceCount, 0);
  const estimatedMonthlyCost = data.byService.reduce((sum, s) => sum + (s.estimatedMonthlyCost || 0), 0);

  const result = await pool.query<{ id: number }>(
    `INSERT INTO aws_inventory_snapshots (snapshot_date, account_ids, data, resource_count, estimated_monthly_cost, eol_resources_count)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (snapshot_date, account_ids) DO UPDATE SET
       data = EXCLUDED.data,
       resource_count = EXCLUDED.resource_count,
       estimated_monthly_cost = EXCLUDED.estimated_monthly_cost,
       eol_resources_count = EXCLUDED.eol_resources_count,
       created_at = NOW()
     RETURNING id`,
    [snapshotDate, sortedIds, JSON.stringify(data), resourceCount, estimatedMonthlyCost, eolResources.length]
  );

  const snapshotId = result.rows[0].id;

  // Save EOL resources for quick querying
  if (eolResources.length > 0) {
    await pool.query(`DELETE FROM aws_inventory_eol_resources WHERE snapshot_id = $1`, [snapshotId]);
    for (const eol of eolResources) {
      await pool.query(
        `INSERT INTO aws_inventory_eol_resources (snapshot_id, account_id, account_name, region, resource_id, resource_name, resource_type, eol_type, eol_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [snapshotId, eol.accountId, eol.accountName, eol.region, eol.resourceId, eol.resourceName, eol.resourceType, eol.eolType, eol.eolDate]
      );
    }
  }

  return snapshotId;
}

/** Load the latest inventory snapshot for a set of accounts */
export async function loadLatestInventorySnapshot(
  accountIds: string[]
): Promise<{ data: InventoryResponse; meta: InventorySnapshotMeta } | null> {
  const sortedIds = [...accountIds].sort();

  const result = await pool.query<{
    id: number;
    snapshot_date: string;
    account_ids: string[];
    data: InventoryResponse;
    resource_count: number;
    estimated_monthly_cost: string | null;
    eol_resources_count: number;
    created_at: string;
  }>(
    `SELECT id, snapshot_date, account_ids, data, resource_count, estimated_monthly_cost, eol_resources_count, created_at
     FROM aws_inventory_snapshots
     WHERE account_ids = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [sortedIds]
  );

  if (result.rows.length === 0) return null;

  const row = result.rows[0];
  const createdAt = new Date(row.created_at);
  const ageHours = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);

  return {
    data: row.data,
    meta: {
      id: row.id,
      snapshotDate: row.snapshot_date,
      accountIds: row.account_ids,
      resourceCount: row.resource_count,
      estimatedMonthlyCost: row.estimated_monthly_cost ? parseFloat(row.estimated_monthly_cost) : null,
      eolResourcesCount: row.eol_resources_count,
      createdAt: row.created_at,
      isStale: ageHours > SNAPSHOT_STALE_HOURS,
    },
  };
}

/** Get all EOL resources across all snapshots (latest per account set) */
export async function getLatestEolResources(): Promise<EolResource[]> {
  const result = await pool.query<{
    account_id: string;
    account_name: string | null;
    region: string;
    resource_id: string;
    resource_name: string | null;
    resource_type: string;
    eol_type: string;
    eol_date: string | null;
  }>(
    `SELECT DISTINCT ON (e.resource_id)
       e.account_id, e.account_name, e.region, e.resource_id, e.resource_name,
       e.resource_type, e.eol_type, e.eol_date::text
     FROM aws_inventory_eol_resources e
     JOIN aws_inventory_snapshots s ON s.id = e.snapshot_id
     ORDER BY e.resource_id, s.created_at DESC`
  );

  return result.rows.map((row) => ({
    accountId: row.account_id,
    accountName: row.account_name,
    region: row.region,
    resourceId: row.resource_id,
    resourceName: row.resource_name,
    resourceType: row.resource_type,
    eolType: row.eol_type,
    eolDate: row.eol_date,
  }));
}

/** Extract EOL resources from an inventory response */
function extractEolResources(data: InventoryResponse): EolResource[] {
  const eolResources: EolResource[] = [];

  for (const service of data.byService) {
    for (const detail of service.details) {
      const accountId = (detail.metadata?.accountId as string) || "";
      const accountName = (detail.metadata?.accountName as string) || null;
      const region = (detail.metadata?.region as string) || "";

      // EC2 AL2
      if (detail.metadata?.isAmazonLinux2 === true) {
        eolResources.push({
          accountId,
          accountName,
          region,
          resourceId: detail.id,
          resourceName: detail.name !== "-" ? detail.name : null,
          resourceType: "EC2 Instance",
          eolType: "Amazon Linux 2",
          eolDate: "2026-06-30",
        });
      }

      // RDS EOL engines
      if (detail.metadata?.isEngineEol === true && detail.metadata?.engineEolLabel) {
        eolResources.push({
          accountId,
          accountName,
          region,
          resourceId: detail.id,
          resourceName: detail.name !== "-" ? detail.name : null,
          resourceType: service.service.includes("Cluster") ? "RDS DB Cluster" : "RDS DB Instance",
          eolType: detail.metadata.engineEolLabel as string,
          eolDate: null,
        });
      }
    }
  }

  return eolResources;
}
