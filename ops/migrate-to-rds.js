/**
 * Migrates the platformportal database from the K8s pod PostgreSQL to RDS.
 * 
 * Strategy: 
 * 1. Connect to source (pod postgres) and dump schema + data
 * 2. Connect to target (RDS) and restore
 * 
 * Run inside the portal pod:
 *   node /tmp/migrate-to-rds.js
 */

const { Pool } = require('pg');

const SOURCE_URL = process.env.DATABASE_URL;
const TARGET_URL = 'postgresql://dbadmin:PlatformPortal2026_Secure@aws.c65wqb8mcjpl.eu-west-1.rds.amazonaws.com:5432/platformportal';

const sourcePool = new Pool({ connectionString: SOURCE_URL });
const targetPool = new Pool({ connectionString: TARGET_URL, ssl: { rejectUnauthorized: false } });

async function getTables(pool) {
  const result = await pool.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return result.rows.map(r => r.table_name);
}

async function getCreateTableSQL(pool, tableName) {
  // Get columns
  const cols = await pool.query(`
    SELECT column_name, data_type, character_maximum_length, 
           column_default, is_nullable, udt_name
    FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);

  // Get constraints
  const constraints = await pool.query(`
    SELECT conname, pg_get_constraintdef(c.oid) as def
    FROM pg_constraint c
    JOIN pg_class t ON c.conrelid = t.oid
    WHERE t.relname = $1
  `, [tableName]);

  return { columns: cols.rows, constraints: constraints.rows };
}

async function getIndexes(pool, tableName) {
  const result = await pool.query(`
    SELECT indexdef FROM pg_indexes 
    WHERE tablename = $1 AND schemaname = 'public'
    AND indexname NOT LIKE '%_pkey'
  `, [tableName]);
  return result.rows.map(r => r.indexdef);
}

async function copyTable(tableName) {
  const startTime = Date.now();
  
  // Count rows
  const countResult = await sourcePool.query(`SELECT count(*) as cnt FROM "${tableName}"`);
  const rowCount = parseInt(countResult.rows[0].cnt);
  
  if (rowCount === 0) {
    process.stdout.write(`  ${tableName}: 0 rows (skip data)\n`);
    return 0;
  }

  // Get all data
  const batchSize = 5000;
  let offset = 0;
  let totalCopied = 0;

  // Get column names
  const colResult = await sourcePool.query(`
    SELECT column_name FROM information_schema.columns 
    WHERE table_schema = 'public' AND table_name = $1
    ORDER BY ordinal_position
  `, [tableName]);
  const columns = colResult.rows.map(r => r.column_name);
  const colList = columns.map(c => '"' + c + '"').join(', ');

  while (offset < rowCount) {
    const dataResult = await sourcePool.query(
      `SELECT ${colList} FROM "${tableName}" ORDER BY 1 LIMIT ${batchSize} OFFSET ${offset}`
    );
    
    if (dataResult.rows.length === 0) break;

    // Build INSERT
    for (const row of dataResult.rows) {
      const values = columns.map((col, i) => {
        const val = row[col];
        if (val === null || val === undefined) return 'NULL';
        if (typeof val === 'number') return String(val);
        if (typeof val === 'boolean') return val ? 'TRUE' : 'FALSE';
        if (val instanceof Date) return "'" + val.toISOString() + "'";
        if (typeof val === 'object') return "'" + JSON.stringify(val).replace(/'/g, "''") + "'";
        return "'" + String(val).replace(/'/g, "''") + "'";
      });
      
      try {
        await targetPool.query(
          `INSERT INTO "${tableName}" (${colList}) VALUES (${values.join(', ')}) ON CONFLICT DO NOTHING`
        );
        totalCopied++;
      } catch (err) {
        // Skip individual row errors
      }
    }

    offset += batchSize;
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(`  ${tableName}: ${totalCopied}/${rowCount} rows (${elapsed}s)\n`);
  return totalCopied;
}

async function main() {
  console.log('=== Platform Portal DB Migration to RDS ===');
  console.log('Source:', SOURCE_URL?.substring(0, 40) + '...');
  console.log('Target: RDS aws.c65wqb8mcjpl...');
  console.log('');

  // Step 1: Get full schema dump from source
  console.log('[1/3] Exporting schema from source...');
  const schemaDump = await sourcePool.query(`
    SELECT pg_catalog.pg_get_functiondef(p.oid) as funcdef
    FROM pg_proc p
    JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'public'
  `);

  // Get full DDL via pg_dump style
  const ddlResult = await sourcePool.query(`
    SELECT 
      'CREATE TABLE IF NOT EXISTS "' || tablename || '" (' ||
      string_agg(
        '"' || attname || '" ' || 
        CASE 
          WHEN typname = 'int4' THEN 'INTEGER'
          WHEN typname = 'int8' THEN 'BIGINT'
          WHEN typname = 'float8' THEN 'DOUBLE PRECISION'
          WHEN typname = 'bool' THEN 'BOOLEAN'
          WHEN typname = 'timestamptz' THEN 'TIMESTAMP WITH TIME ZONE'
          WHEN typname = 'timestamp' THEN 'TIMESTAMP WITHOUT TIME ZONE'
          WHEN typname = 'jsonb' THEN 'JSONB'
          WHEN typname = 'json' THEN 'JSON'
          WHEN typname = 'text' THEN 'TEXT'
          WHEN typname = 'varchar' THEN 'VARCHAR(' || COALESCE(atttypmod - 4, 255)::text || ')'
          WHEN typname = 'serial' OR typname = 'int4' AND atthasdef THEN 'SERIAL'
          ELSE upper(typname)
        END ||
        CASE WHEN NOT attnotnull THEN '' ELSE ' NOT NULL' END ||
        CASE WHEN atthasdef THEN ' DEFAULT ' || pg_get_expr(adbin, adrelid) ELSE '' END,
        ', ' ORDER BY attnum
      ) || ');' as ddl
    FROM pg_attribute a
    JOIN pg_class c ON a.attrelid = c.oid
    JOIN pg_namespace n ON c.relnamespace = n.oid
    JOIN pg_type t ON a.atttypid = t.oid
    LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum
    WHERE n.nspname = 'public' 
      AND c.relkind = 'r'
      AND a.attnum > 0 
      AND NOT a.attisdropped
    GROUP BY tablename
    ORDER BY tablename
  `);

  // Step 2: Apply migrations to target (simpler approach — just run all migration files)
  console.log('[2/3] Applying schema via migrations...');
  
  // Instead of complex DDL reconstruction, just apply all migrations in order
  // The migrations are idempotent (IF NOT EXISTS, ON CONFLICT)
  const tables = await getTables(sourcePool);
  console.log('  Source has ' + tables.length + ' tables');

  // Create tables on target by running a pg_dump-like approach
  // First, get the raw DDL for each table
  for (const table of tables) {
    try {
      // Get the CREATE TABLE statement
      const createResult = await sourcePool.query(`
        SELECT 
          'CREATE TABLE IF NOT EXISTS "' || $1 || '" (' ||
          string_agg(
            '"' || a.attname || '" ' || pg_catalog.format_type(a.atttypid, a.atttypmod) ||
            CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END ||
            CASE WHEN d.adbin IS NOT NULL THEN ' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid) ELSE '' END,
            ', ' ORDER BY a.attnum
          ) || ')' as ddl
        FROM pg_attribute a
        JOIN pg_class c ON a.attrelid = c.oid
        JOIN pg_namespace n ON c.relnamespace = n.oid
        LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE c.relname = $1
          AND n.nspname = 'public'
          AND a.attnum > 0
          AND NOT a.attisdropped
        GROUP BY 1
      `, [table]);

      if (createResult.rows[0]?.ddl) {
        await targetPool.query(createResult.rows[0].ddl);
      }

      // Create indexes
      const indexes = await getIndexes(sourcePool, table);
      for (const idx of indexes) {
        try {
          await targetPool.query(idx.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS'));
        } catch {}
      }

      // Create primary key and unique constraints
      const constraints = await sourcePool.query(`
        SELECT pg_get_constraintdef(c.oid) as def, conname, contype
        FROM pg_constraint c
        JOIN pg_class t ON c.conrelid = t.oid
        WHERE t.relname = $1
      `, [table]);
      
      for (const con of constraints.rows) {
        try {
          if (con.contype === 'p') {
            await targetPool.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${con.conname}" ${con.def}`);
          } else if (con.contype === 'u') {
            await targetPool.query(`ALTER TABLE "${table}" ADD CONSTRAINT "${con.conname}" ${con.def}`);
          }
        } catch {}
      }

      process.stdout.write('  Created: ' + table + '\n');
    } catch (err) {
      process.stdout.write('  SKIP: ' + table + ' (' + err.message.substring(0, 60) + ')\n');
    }
  }

  // Verify tables on target
  const targetTables = await getTables(targetPool);
  console.log('  Target has ' + targetTables.length + ' tables');

  // Step 3: Copy data
  console.log('[3/3] Copying data...');
  let totalRows = 0;
  
  // Copy tables without foreign keys first, then the rest
  const tablesWithFK = new Set();
  const fkResult = await sourcePool.query(`
    SELECT DISTINCT tc.table_name
    FROM information_schema.table_constraints tc
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `);
  for (const r of fkResult.rows) tablesWithFK.add(r.table_name);

  const tablesNoFK = targetTables.filter(t => !tablesWithFK.has(t));
  const tablesFK = targetTables.filter(t => tablesWithFK.has(t));

  for (const table of [...tablesNoFK, ...tablesFK]) {
    try {
      totalRows += await copyTable(table);
    } catch (err) {
      process.stdout.write('  ERROR: ' + table + ' - ' + err.message.substring(0, 80) + '\n');
    }
  }

  // Fix sequences
  console.log('Fixing sequences...');
  for (const table of targetTables) {
    try {
      await targetPool.query(`
        SELECT setval(pg_get_serial_sequence('"${table}"', 'id'), 
               COALESCE((SELECT MAX(id) FROM "${table}"), 1))
      `);
    } catch {}
  }

  console.log('');
  console.log('=== Migration complete ===');
  console.log('Tables: ' + targetTables.length);
  console.log('Rows copied: ' + totalRows);
  
  await sourcePool.end();
  await targetPool.end();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
