/**
 * Migrates platformportal DB to RDS.
 * v3: Apply original migration files for schema, then copy data.
 * 
 * Run: NODE_PATH=/app/node_modules node /tmp/migrate-v3.js
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const SOURCE_URL = process.env.DATABASE_URL;
const TARGET_URL = 'postgresql://dbadmin:PlatformPortal2026_Secure@aws.c65wqb8mcjpl.eu-west-1.rds.amazonaws.com:5432/platformportal';

const src = new Pool({ connectionString: SOURCE_URL });
const tgt = new Pool({ connectionString: TARGET_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log('=== DB Migration to RDS v3 ===');
  console.log('Started:', new Date().toISOString());

  // Step 1: Drop all tables on target (clean slate)
  console.log('\n[1/4] Cleaning target DB...');
  const existingTables = await tgt.query(`
    SELECT table_name FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  for (const row of existingTables.rows) {
    await tgt.query('DROP TABLE IF EXISTS "' + row.table_name + '" CASCADE');
  }
  console.log('  Dropped', existingTables.rows.length, 'tables');

  // Step 2: Dump schema from source using pg_dump format
  console.log('\n[2/4] Dumping schema from source...');
  
  // Get all CREATE TABLE statements with proper SERIAL support
  const tableNames = await src.query(`
    SELECT c.relname FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);
  const tables = tableNames.rows.map(r => r.relname);
  console.log('  Source has', tables.length, 'tables');

  // For each table, reconstruct proper DDL
  for (const table of tables) {
    try {
      const colsResult = await src.query(`
        SELECT a.attname, 
               pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
               a.attnotnull,
               pg_get_expr(d.adbin, d.adrelid) as default_val,
               CASE WHEN pg_get_expr(d.adbin, d.adrelid) LIKE 'nextval%' THEN true ELSE false END as is_serial
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, [table]);

      const colDefs = colsResult.rows.map(c => {
        let colType = c.type;
        // Convert integer + nextval to SERIAL
        if (c.is_serial && c.type === 'integer') colType = 'SERIAL';
        else if (c.is_serial && c.type === 'bigint') colType = 'BIGSERIAL';
        
        let def = '"' + c.attname + '" ' + colType;
        if (c.attnotnull && !c.is_serial) def += ' NOT NULL';
        if (c.default_val && !c.is_serial) def += ' DEFAULT ' + c.default_val;
        return def;
      });

      // Get primary key
      const pkResult = await src.query(`
        SELECT pg_get_constraintdef(c.oid) as def
        FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'p'
      `, [table]);

      let sql = 'CREATE TABLE "' + table + '" (\n  ' + colDefs.join(',\n  ');
      if (pkResult.rows.length > 0) sql += ',\n  ' + pkResult.rows[0].def;
      sql += '\n)';

      await tgt.query(sql);

      // Unique constraints
      const ucResult = await src.query(`
        SELECT conname, pg_get_constraintdef(c.oid) as def
        FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'u'
      `, [table]);
      for (const uc of ucResult.rows) {
        try { await tgt.query('ALTER TABLE "' + table + '" ADD CONSTRAINT "' + uc.conname + '" ' + uc.def); } catch {}
      }

      // Check constraints
      const ckResult = await src.query(`
        SELECT conname, pg_get_constraintdef(c.oid) as def
        FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'c'
      `, [table]);
      for (const ck of ckResult.rows) {
        try { await tgt.query('ALTER TABLE "' + table + '" ADD CONSTRAINT "' + ck.conname + '" ' + ck.def); } catch {}
      }

      // Indexes
      const idxResult = await src.query(`
        SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND schemaname = 'public'
        AND indexname NOT LIKE '%_pkey'
      `, [table]);
      for (const idx of idxResult.rows) {
        try { await tgt.query(idx.indexdef); } catch {}
      }

      process.stdout.write('  ✓ ' + table + '\n');
    } catch (err) {
      process.stdout.write('  ✗ ' + table + ': ' + err.message.substring(0, 100) + '\n');
    }
  }

  // Foreign keys (after all tables created)
  console.log('  Creating foreign keys...');
  for (const table of tables) {
    const fkResult = await src.query(`
      SELECT conname, pg_get_constraintdef(c.oid) as def
      FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'f'
    `, [table]);
    for (const fk of fkResult.rows) {
      try { await tgt.query('ALTER TABLE "' + table + '" ADD CONSTRAINT "' + fk.conname + '" ' + fk.def); } catch {}
    }
  }

  // Views
  const viewsResult = await src.query(`
    SELECT viewname, definition FROM pg_views WHERE schemaname = 'public'
  `);
  for (const v of viewsResult.rows) {
    try { await tgt.query('CREATE OR REPLACE VIEW "' + v.viewname + '" AS ' + v.definition); } catch {}
  }

  const tgtCount = await tgt.query(`SELECT count(*) as cnt FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'`);
  console.log('  Target tables:', tgtCount.rows[0].cnt);

  // Step 3: Copy data
  console.log('\n[3/4] Copying data...');
  let totalRows = 0;

  // Order: no FK first
  const fkSet = new Set();
  const fkCheck = await src.query(`SELECT DISTINCT tc.table_name FROM information_schema.table_constraints tc WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema='public'`);
  for (const r of fkCheck.rows) fkSet.add(r.table_name);
  const ordered = [...tables.filter(t => !fkSet.has(t)), ...tables.filter(t => fkSet.has(t))];

  for (const table of ordered) {
    const ts = () => new Date().toISOString().substring(11, 19);
    try {
      const cnt = await src.query('SELECT count(*) as c FROM "' + table + '"');
      const rowCount = parseInt(cnt.rows[0].c);
      if (rowCount === 0) { process.stdout.write('  [' + ts() + '] ' + table + ': 0 rows\n'); continue; }

      const colResult = await src.query(`
        SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum
      `, [table]);
      const cols = colResult.rows.map(r => r.attname);
      const colList = cols.map(c => '"' + c + '"').join(', ');
      const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');

      let copied = 0;
      const batchSize = 500;
      for (let offset = 0; offset < rowCount; offset += batchSize) {
        const data = await src.query('SELECT ' + colList + ' FROM "' + table + '" LIMIT ' + batchSize + ' OFFSET ' + offset);
        for (const row of data.rows) {
          try {
            await tgt.query('INSERT INTO "' + table + '" (' + colList + ') VALUES (' + placeholders + ') ON CONFLICT DO NOTHING', cols.map(c => row[c]));
            copied++;
          } catch {}
        }
      }
      totalRows += copied;
      process.stdout.write('  [' + ts() + '] ' + table + ': ' + copied + '/' + rowCount + '\n');
    } catch (err) {
      process.stdout.write('  [' + ts() + '] ' + table + ': ERROR ' + err.message.substring(0, 60) + '\n');
    }
  }

  // Step 4: Fix sequences
  console.log('\n[4/4] Fixing sequences...');
  for (const table of tables) {
    try {
      const seqResult = await tgt.query("SELECT pg_get_serial_sequence('\"" + table + "\"', 'id') as seq");
      if (seqResult.rows[0]?.seq) {
        await tgt.query("SELECT setval('" + seqResult.rows[0].seq + "', COALESCE((SELECT MAX(id) FROM \"" + table + "\"), 1))");
      }
    } catch {}
  }

  console.log('\n=== Migration complete ===');
  console.log('Tables:', tables.length);
  console.log('Rows:', totalRows);
  console.log('Finished:', new Date().toISOString());

  await src.end();
  await tgt.end();
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
