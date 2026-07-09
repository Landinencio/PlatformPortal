#!/usr/bin/env node

/**
 * Verifica que el esquema de ciberseguridad está correctamente aplicado en PostgreSQL
 */

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL no está configurada');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function verifySchema() {
  const client = await pool.connect();
  try {
    console.log('🔍 Verificando esquema de ciberseguridad...\n');

    // Verificar tabla principal
    const runsTable = await client.query(`
      SELECT to_regclass('public.cybersecurity_runs')::text AS table_name
    `);
    
    if (!runsTable.rows[0]?.table_name) {
      console.error('❌ Tabla cybersecurity_runs NO existe');
      console.log('\n📝 Ejecuta la migración:');
      console.log('   psql $DATABASE_URL -f migrations/2026-03-24_cybersecurity_reports.sql\n');
      process.exit(1);
    }

    console.log('✅ Tabla cybersecurity_runs existe');

    // Verificar tablas de detalle
    const tables = [
      'cyber_azure_inactive_users',
      'cyber_azure_mfa_gaps',
      'cyber_azure_vpn_groups',
      'cyber_azure_vpn_group_members'
    ];

    for (const table of tables) {
      const result = await client.query(`
        SELECT to_regclass('public.${table}')::text AS table_name
      `);
      
      if (!result.rows[0]?.table_name) {
        console.error(`❌ Tabla ${table} NO existe`);
        process.exit(1);
      }
      console.log(`✅ Tabla ${table} existe`);
    }

    // Verificar índices
    const indexes = await client.query(`
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename IN ('cybersecurity_runs', 'cyber_azure_inactive_users', 'cyber_azure_mfa_gaps', 'cyber_azure_vpn_groups', 'cyber_azure_vpn_group_members')
      ORDER BY indexname
    `);

    console.log(`\n✅ ${indexes.rows.length} índices encontrados`);

    // Verificar datos existentes
    const counts = await client.query(`
      SELECT 
        report_type,
        COUNT(*) as total,
        MAX(generated_at) as latest
      FROM cybersecurity_runs
      GROUP BY report_type
      ORDER BY report_type
    `);

    if (counts.rows.length === 0) {
      console.log('\n⚠️  No hay datos todavía en cybersecurity_runs');
      console.log('   Los flujos de n8n deben enviar datos a /api/cybersecurity/intake\n');
    } else {
      console.log('\n📊 Datos existentes:');
      for (const row of counts.rows) {
        const latest = new Date(row.latest).toISOString().replace('T', ' ').substring(0, 19);
        console.log(`   ${row.report_type}: ${row.total} ejecuciones (última: ${latest})`);
      }
    }

    console.log('\n✅ Esquema de ciberseguridad verificado correctamente\n');
    process.exit(0);

  } catch (error) {
    console.error('\n❌ Error verificando esquema:', error.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

verifySchema();
