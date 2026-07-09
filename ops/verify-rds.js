const { Pool } = require('pg');
const src = new Pool({ connectionString: process.env.DATABASE_URL });
const rds = new Pool({ 
  connectionString: 'postgresql://dbadmin:PlatformPortal2026_Secure@aws.c65wqb8mcjpl.eu-west-1.rds.amazonaws.com:5432/platformportal',
  ssl: { rejectUnauthorized: false }
});

const TABLES = [
  'dora_metrics_daily', 'developer_activity_daily', 'gitlab_mr_analytics',
  'deployment_traces', 'production_deployments', 'deployment_changes',
  'developer_name_map', 'webhook_events_raw', 'webhook_processing_log',
  'services', 'sonarqube_metrics_daily', 'service_compliance_daily',
  'synthetic_checks', 'portal_user_activity', 'gitlab_deploy_jobs',
  'gitlab_deploy_attempts', 'argocd_health_daily', 'k8s_rollouts_daily',
  'finops_advisor_jobs', 'infra_requests', 'user_notifications'
];

async function main() {
  console.log('=== RDS Verification ===');
  console.log('');
  console.log('Table                          | Source   | RDS      | Status');
  console.log('-'.repeat(70));

  let allOk = true;
  for (const table of TABLES) {
    try {
      const [s, r] = await Promise.all([
        src.query('SELECT count(*) as c FROM "' + table + '"'),
        rds.query('SELECT count(*) as c FROM "' + table + '"')
      ]);
      const srcCount = parseInt(s.rows[0].c);
      const rdsCount = parseInt(r.rows[0].c);
      const status = srcCount === rdsCount ? 'OK' : rdsCount > 0 ? 'PARTIAL' : 'EMPTY';
      if (status !== 'OK') allOk = false;
      console.log(table.padEnd(32) + '| ' + String(srcCount).padStart(8) + ' | ' + String(rdsCount).padStart(8) + ' | ' + status);
    } catch (e) {
      allOk = false;
      console.log(table.padEnd(32) + '| ERROR: ' + e.message.substring(0, 40));
    }
  }

  console.log('');

  // Check name map
  const nameCount = await rds.query('SELECT count(*) as c FROM developer_name_map');
  console.log('Name map entries:', nameCount.rows[0].c);

  const martin = await rds.query("SELECT canonical_name FROM developer_name_map WHERE gitlab_username = 'martin.godoy'");
  console.log('martin.godoy →', martin.rows[0]?.canonical_name || 'NOT FOUND');

  const ezequiel = await rds.query("SELECT canonical_name FROM developer_name_map WHERE gitlab_username = 'ezequiel.ponze'");
  console.log('ezequiel.ponze →', ezequiel.rows[0]?.canonical_name || 'NOT FOUND');

  // Check webhook data
  const webhookCount = await rds.query("SELECT gitlab_event_type, count(*) as c FROM webhook_events_raw GROUP BY gitlab_event_type ORDER BY c DESC");
  console.log('');
  console.log('Webhook events in RDS:');
  for (const r of webhookCount.rows) {
    console.log('  ' + r.gitlab_event_type + ': ' + r.c);
  }

  // Check latest snapshot date
  const latestSnapshot = await rds.query("SELECT MAX(snapshot_date) as d FROM dora_metrics_daily");
  console.log('');
  console.log('Latest DORA snapshot:', latestSnapshot.rows[0]?.d || 'NONE');

  const latestMR = await rds.query("SELECT MAX(snapshot_date) as d FROM gitlab_mr_analytics");
  console.log('Latest MR analytics:', latestMR.rows[0]?.d || 'NONE');

  console.log('');
  console.log(allOk ? '✅ All tables match!' : '⚠️ Some tables have differences — review above');

  await src.end();
  await rds.end();
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
