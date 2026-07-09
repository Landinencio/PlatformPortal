-- Daily FinOps context snapshot for the AI chatbot
CREATE TABLE IF NOT EXISTS finops_daily_context (
  id              SERIAL PRIMARY KEY,
  snapshot_date   DATE NOT NULL UNIQUE,
  total_accounts  INT NOT NULL DEFAULT 0,
  total_resources INT NOT NULL DEFAULT 0,
  total_services  INT NOT NULL DEFAULT 0,
  cost_summary    JSONB DEFAULT '{}',    -- { totalCost, byAccount: [...], byService: [...], topResources: [...] }
  inventory_summary JSONB DEFAULT '{}',  -- { byService: [{service, count}], ec2Running, ec2Stopped, rdsCount, ... }
  opportunities   JSONB DEFAULT '[]',    -- top savings opportunities
  metrics_summary JSONB DEFAULT '{}',    -- { ec2IdleCount, ec2LowCount, rdsUnderutilized, ebsUnattached, ... }
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
