const http = require('http');

// Fechas faltantes basadas en el análisis:
// DORA: 2026-03-21, 2026-03-22, 2026-03-23
// MR Analytics: 2026-03-23
// SonarQube: 2026-03-17 a 2026-03-23
const DATES = [
  '2026-03-17',
  '2026-03-18',
  '2026-03-19',
  '2026-03-20',
  '2026-03-21',
  '2026-03-22',
  '2026-03-23',
];

const DELAY_MS = 30_000; // 30 segundos entre snapshots
const TIMEOUT_MS = 1800_000; // 30 minutos por snapshot

const sleep = ms => new Promise(r => setTimeout(r, ms));

function snap(date) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 3000,
      path: `/api/metrics/snapshot-all?date=${date}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve({ status: res.statusCode, data });
        } catch {
          resolve({ status: res.statusCode, data: { success: false } });
        }
      });
    });

    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy(new Error('timeout'));
    });

    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const total = DATES.length;
  console.log(`Backfill ${total} dates | ${new Date().toISOString()}\n`);

  let ok = 0;
  let fail = 0;

  for (let i = 0; i < total; i++) {
    const date = DATES[i];
    const startTime = Date.now();

    try {
      const result = await snap(date);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const success = result.status === 200 || result.status === 207;

      if (success) {
        console.log(`[${i + 1}/${total}] ${date} ✓ HTTP:${result.status} ${elapsed}s`);
        ok++;
      } else {
        console.log(`[${i + 1}/${total}] ${date} ✗ HTTP:${result.status} ${elapsed}s`);
        fail++;
      }

      if (result.data?.results) {
        const r = result.data.results;
        console.log(`  DORA:${r.dora?.success ? '✓' : '✗'} MR:${r.mrAnalytics?.success ? '✓' : '✗'} Sonar:${r.sonarqube?.success ? '✓' : '✗'} K8s:${r.k8sMetrics?.success ? '✓' : '✗'} Corr:${r.correlation?.success ? '✓' : '✗'}`);
      }
    } catch (error) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`[${i + 1}/${total}] ${date} ✗ ${error.message} ${elapsed}s`);
      fail++;
    }

    if (i < total - 1) {
      console.log(`  Waiting ${DELAY_MS / 1000}s...\n`);
      await sleep(DELAY_MS);
    }
  }

  console.log(`\nCompleted ${new Date().toISOString()}`);
  console.log(`Success: ${ok} | Failed: ${fail}`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
