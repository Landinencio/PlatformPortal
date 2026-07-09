import { NextResponse } from 'next/server';
import pool from '@/lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const schemaSql = `
-- Synthetic Monitoring Schema

-- Monitors table: Stores the websites to check
CREATE TABLE IF NOT EXISTS synthetic_monitors (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  url VARCHAR(255) NOT NULL,
  active BOOLEAN DEFAULT true,
  interval_seconds INTEGER DEFAULT 60,
  method VARCHAR(10) DEFAULT 'GET',
  timeout_ms INTEGER DEFAULT 10000,
  expected_status_min INTEGER DEFAULT 200,
  expected_status_max INTEGER DEFAULT 399,
  expected_keyword TEXT,
  allow_insecure BOOLEAN DEFAULT false,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Checks table: Stores individual check results
CREATE TABLE IF NOT EXISTS synthetic_checks (
  id SERIAL PRIMARY KEY,
  monitor_id INTEGER REFERENCES synthetic_monitors(id) ON DELETE CASCADE,
  checked_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  is_up BOOLEAN NOT NULL,
  status_code INTEGER,
  response_time_ms INTEGER,
  ssl_valid BOOLEAN,
  ssl_days_remaining INTEGER,
  error_message TEXT,
  error_kind VARCHAR(32),
  dns_ok BOOLEAN,
  tcp_ok BOOLEAN,
  tls_ok BOOLEAN,
  http_ok BOOLEAN,
  content_ok BOOLEAN,
  dns_ms INTEGER,
  tcp_ms INTEGER,
  tls_ms INTEGER,
  ttfb_ms INTEGER,
  download_ms INTEGER,
  total_ms INTEGER,
  ip_address VARCHAR(64),
  region VARCHAR(64),
  
  -- Index for faster time-series queries
  CONSTRAINT fk_monitor FOREIGN KEY (monitor_id) REFERENCES synthetic_monitors(id)
);

-- Ensure existing tables get new columns (Must run before index creation if table exists)
ALTER TABLE IF EXISTS synthetic_monitors ADD COLUMN IF NOT EXISTS method VARCHAR(10) DEFAULT 'GET';
ALTER TABLE IF EXISTS synthetic_monitors ADD COLUMN IF NOT EXISTS timeout_ms INTEGER DEFAULT 10000;
ALTER TABLE IF EXISTS synthetic_monitors ADD COLUMN IF NOT EXISTS expected_status_min INTEGER DEFAULT 200;
ALTER TABLE IF EXISTS synthetic_monitors ADD COLUMN IF NOT EXISTS expected_status_max INTEGER DEFAULT 399;
ALTER TABLE IF EXISTS synthetic_monitors ADD COLUMN IF NOT EXISTS expected_keyword TEXT;
ALTER TABLE IF EXISTS synthetic_monitors ADD COLUMN IF NOT EXISTS allow_insecure BOOLEAN DEFAULT false;

ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS error_kind VARCHAR(32);
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS dns_ok BOOLEAN;
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS tcp_ok BOOLEAN;
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS tls_ok BOOLEAN;
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS http_ok BOOLEAN;
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS content_ok BOOLEAN;
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS dns_ms INTEGER;
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS tcp_ms INTEGER;
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS tls_ms INTEGER;
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS ttfb_ms INTEGER;
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS download_ms INTEGER;
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS total_ms INTEGER;
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS ip_address VARCHAR(64);
ALTER TABLE IF EXISTS synthetic_checks ADD COLUMN IF NOT EXISTS region VARCHAR(64);

-- Indexes (Safe to run after columns exist)
CREATE INDEX IF NOT EXISTS idx_synthetic_checks_monitor_time ON synthetic_checks(monitor_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_synthetic_checks_time ON synthetic_checks(checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_synthetic_checks_error_kind ON synthetic_checks(error_kind);

-- Daily rollups for long-term retention
CREATE TABLE IF NOT EXISTS synthetic_checks_rollup_daily (
  id SERIAL PRIMARY KEY,
  monitor_id INTEGER REFERENCES synthetic_monitors(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  total_checks INTEGER NOT NULL,
  up_checks INTEGER NOT NULL,
  reachable_checks INTEGER NOT NULL,
  avg_total_ms INTEGER,
  p95_ms INTEGER,
  p99_ms INTEGER,
  last_status_code INTEGER,
  last_error_kind VARCHAR(32),
  last_check_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_synthetic_rollup_daily_unique ON synthetic_checks_rollup_daily(monitor_id, day);
CREATE INDEX IF NOT EXISTS idx_synthetic_rollup_daily_day ON synthetic_checks_rollup_daily(day DESC);

-- Seed initial monitors if table is empty
INSERT INTO synthetic_monitors (name, url, interval_seconds, method)
SELECT 'Animalis', 'https://www.animalis.com', 60, 'GET'
WHERE NOT EXISTS (SELECT 1 FROM synthetic_monitors WHERE name = 'Animalis');

INSERT INTO synthetic_monitors (name, url, interval_seconds, method)
SELECT 'Kiwoko ES', 'https://www.kiwoko.com', 60, 'GET'
WHERE NOT EXISTS (SELECT 1 FROM synthetic_monitors WHERE name = 'Kiwoko ES');

INSERT INTO synthetic_monitors (name, url, interval_seconds, method)
SELECT 'Kiwoko PT', 'https://www.kiwoko.pt', 60, 'GET'
WHERE NOT EXISTS (SELECT 1 FROM synthetic_monitors WHERE name = 'Kiwoko PT');

INSERT INTO synthetic_monitors (name, url, interval_seconds, method)
SELECT 'Tiendanimal ES', 'https://www.tiendanimal.es', 60, 'GET'
WHERE NOT EXISTS (SELECT 1 FROM synthetic_monitors WHERE name = 'Tiendanimal ES');

INSERT INTO synthetic_monitors (name, url, interval_seconds, method)
SELECT 'Tiendanimal PT', 'https://www.tiendanimal.pt', 60, 'GET'
WHERE NOT EXISTS (SELECT 1 FROM synthetic_monitors WHERE name = 'Tiendanimal PT');
        `;

    console.log('Running Synthetics schema migration...');

    // Execute the SQL script
    await pool.query(schemaSql);

    return NextResponse.json({
      success: true,
      message: 'Synthetic monitoring tables created and seeded successfully.'
    });
  } catch (error) {
    console.error('Failed to init synthetics DB:', error);
    return NextResponse.json(
      { error: 'Failed to initialize database', details: String(error) },
      { status: 500 }
    );
  }
}

