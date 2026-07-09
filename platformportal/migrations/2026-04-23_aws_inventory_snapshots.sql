-- AWS Inventory Snapshots
-- Stores periodic snapshots of AWS resource inventory to avoid real-time API calls
-- and enable historical tracking of resource changes.

CREATE TABLE IF NOT EXISTS aws_inventory_snapshots (
  id SERIAL PRIMARY KEY,
  snapshot_date DATE NOT NULL,
  account_ids TEXT[] NOT NULL,
  data JSONB NOT NULL,
  resource_count INTEGER NOT NULL DEFAULT 0,
  estimated_monthly_cost NUMERIC(12, 2),
  eol_resources_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Only keep the latest snapshot per account set per day
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_snapshots_date_accounts
  ON aws_inventory_snapshots (snapshot_date, account_ids);

CREATE INDEX IF NOT EXISTS idx_inventory_snapshots_date
  ON aws_inventory_snapshots (snapshot_date DESC);

-- Track EOL resources separately for quick querying
CREATE TABLE IF NOT EXISTS aws_inventory_eol_resources (
  id SERIAL PRIMARY KEY,
  snapshot_id INTEGER REFERENCES aws_inventory_snapshots(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL,
  account_name TEXT,
  region TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  resource_name TEXT,
  resource_type TEXT NOT NULL,  -- 'EC2 Instance', 'RDS DB Instance', etc.
  eol_type TEXT NOT NULL,       -- 'AL2', 'MySQL 5.7', 'PostgreSQL 11', etc.
  eol_date DATE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inventory_eol_snapshot
  ON aws_inventory_eol_resources (snapshot_id);

CREATE INDEX IF NOT EXISTS idx_inventory_eol_type
  ON aws_inventory_eol_resources (eol_type);
