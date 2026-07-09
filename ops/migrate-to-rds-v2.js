/**
 * Migrates platformportal DB from pod PostgreSQL to RDS.
 * v2: Simpler approach — dump schema via pg_catalog, copy data row by row.
 * 
 * Run: NODE_PATH=/app/node_modules node /tmp/migrate-v2.js
 */
const { Pool } = require('pg');

const SOURCE_URL = process.env.DATABASE_URL;
const TARGET_URL = 'postgresql://dbadmin:PlatformPortal2026_Secure@aws.c65wqb8mcjpl.eu-west-1.rds.amazonaws.com:5432/platformportal';

const src = new Pool({ connectionString: SOURCE_URL });
const tgt = new Pool({ connectionString: TARGET_URL, ssl: { rejectUnauthorized: false } });

async function run() {
  console.log('=== DB Migration to RDS v2 ===');
  console.log('Started:', new Date().toISOString());

  // Step 1: Get all table DDLs from source using pg_dump-like approach
  console.log('\n[1/3] Creating schema on target...');
  
  const tablesResult = await src.query(`
    SELECT c.relname as table_name
    FROM pg_class c
    JOIN pg_namespace n ON c.relnamespace = n.oid
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);
  const tables = tablesResult.rows.map(r => r.table_name);
  console.log('  Source tables:', tables.length);

  // For each table, get CREATE TABLE + constraints + indexes
  for (const table of tables) {
    try {
      // Get column definitions
      const colsResult = await src.query(`
        SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod) as type,
               a.attnotnull, pg_get_expr(d.adbin, d.adrelid) as default_val
        FROM pg_attribute a
        LEFT JOIN pg_attrdef d ON a.attrelid = d.adrelid AND a.attnum = d.adnum
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, [table]);

      const colDefs = colsResult.rows.map(c => {
        let def = '"' + c.attname + '" ' + c.type;
        if (c.attnotnull) def += ' NOT NULL';
        if (c.default_val) def += ' DEFAULT ' + c.default_val;
        return def;
      });

      // Get primary key
      const pkResult = await src.query(`
        SELECT pg_get_constraintdef(c.oid) as def
        FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'p'
      `, [table]);
      
      let createSQL = 'CREATE TABLE IF NOT EXISTS "' + table + '" (\n  ' + colDefs.join(',\n  ');
      if (pkResult.rows.length > 0) {
        createSQL += ',\n  ' + pkResult.rows[0].def;
      }
      createSQL += '\n)';

      await tgt.query(createSQL);

      // Create unique constraints
      const ucResult = await src.query(`
        SELECT conname, pg_get_constraintdef(c.oid) as def
        FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'u'
      `, [table]);
      for (const uc of ucResult.rows) {
        try { await tgt.query('ALTER TABLE "' + table + '" ADD CONSTRAINT "' + uc.conname + '" ' + uc.def); } catch {}
      }

      // Create indexes
      const idxResult = await src.query(`
        SELECT indexdef FROM pg_indexes WHERE tablename = $1 AND schemaname = 'public'
        AND indexname NOT LIKE '%_pkey'
      `, [table]);
      for (const idx of idxResult.rows) {
        try { await tgt.query(idx.indexdef.replace('CREATE INDEX', 'CREATE INDEX IF NOT EXISTS')); } catch {}
      }

      process.stdout.write('  ✓ ' + table + ' (' + colDefs.length + ' cols)\n');
    } catch (err) {
      process.stdout.write('  ✗ ' + table + ': ' + err.message.substring(0, 80) + '\n');
    }
  }

  // Create foreign keys after all tables exist
  console.log('\n  Creating foreign keys...');
  for (const table of tables) {
    const fkResult = await src.query(`
      SELECT conname, pg_get_constraintdef(c.oid) as def
      FROM pg_constraint c WHERE c.conrelid = $1::regclass AND c.contype = 'f'
    `, [table]);
    for (const fk of fkResult.rows) {
      try { await tgt.query('ALTER TABLE "' + table + '" ADD CONSTRAINT "' + fk.conname + '" ' + fk.def); } catch {}
    }
  }

  // Verify
  const tgtTables = await tgt.query(`
    SELECT count(*) as cnt FROM information_schema.tables 
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  console.log('  Target tables:', tgtTables.rows[0].cnt);

  // Step 2: Copy data
  console.log('\n[2/3] Copying data...');
  let totalRows = 0;

  // Order: tables without FK first
  const fkTables = new Set();
  const fkCheck = await src.query(`
    SELECT DISTINCT tc.table_name FROM information_schema.table_constraints tc
    WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
  `);
  for (const r of fkCheck.rows) fkTables.add(r.table_name);
  
  const ordered = [...tables.filter(t => !fkTables.has(t)), ...tables.filter(t => fkTables.has(t))];

  for (const table of ordered) {
    const ts = () => new Date().toISOString().substring(11, 19);
    try {
      const countResult = await src.query('SELECT count(*) as cnt FROM "' + table + '"');
      const rowCount = parseInt(countResult.rows[0].cnt);
      if (rowCount === 0) {
        process.stdout.write('  [' + ts() + '] ' + table + ': 0 rows\n');
        continue;
      }

      // Get columns
      const colResult = await src.query(`
        SELECT a.attname FROM pg_attribute a
        WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY a.attnum
      `, [table]);
      const cols = colResult.rows.map(r => r.attname);
      const colList = cols.map(c => '"' + c + '"').join(', ');

      // Batch copy
      const batchSize = 1000;
      let copied = 0;
      
      for (let offset = 0; offset < rowCount; offset += batchSize) {
        const data = await src.query('SELECT ' + colList + ' FROM "' + table + '" LIMIT ' + batchSize + ' OFFSET ' + offset);
        
        for (const row of data.rows) {
          const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
          const values = cols.map(c => row[c]);
          try {
            await tgt.query(
              'INSERT INTO "' + table + '" (' + colList + ') VALUES (' + placeholders + ') ON CONFLICT DO NOTHING',
              values
            );
            copied++;
          } catch {}
        }
      }

      totalRows += copied;
      process.stdout.write('  [' + ts() + '] ' + table + ': ' + copied + '/' + rowCount + ' rows\n');
    } catch (err) {
      process.stdout.write('  [' + ts() + '] ' + table + ': ERROR ' + err.message.substring(0, 60) + '\n');
    }
  }

  // Step 3: Fix sequences
  console.log('\n[3/3] Fixing sequences...');
  for (const table of tables) {
    try {
      const seqResult = await tgt.query(`
        SELECT pg_get_serial_sequence('"' || $1 || '"', 'id') as seq
      `, [table]);
      if (seqResult.rows[0]?.seq) {
        await tgt.query(`
          SELECT setval($1, COALESCE((SELECT MAX(id) FROM "` + table + `"), 1))
        `, [seqResult.rows[0].seq]);
      }
    } catch {}
  }

  console.log('\n=== Migration complete ===');
  console.log('Tables:', tables.length);
  console.log('Rows copied:', totalRows);
  console.log('Finished:', new Date().toISOString());

  await src.end();
  await tgt.end();
}

run().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
