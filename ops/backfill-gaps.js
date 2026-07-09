const http = require('http');
const DELAY_MS = 30_000;
const DATES = [
  '2025-09-24','2025-09-25','2025-09-26','2025-09-27','2025-09-28','2025-09-29','2025-09-30',
  '2025-10-01','2025-10-02','2025-10-03','2025-10-04','2025-10-05','2025-10-06','2025-10-07',
  '2025-10-08','2025-10-09','2025-10-10','2025-10-11','2025-10-12','2025-10-13','2025-10-14',
  '2025-10-15','2025-10-16','2025-10-17','2025-10-18','2025-10-19','2025-10-20','2025-10-21',
  '2025-10-22','2025-10-23','2025-10-24','2025-10-25','2025-10-26','2025-10-27','2025-10-28',
  '2025-10-29','2025-10-30','2025-10-31',
  '2025-11-01','2025-11-02','2025-11-03','2025-11-04','2025-11-05','2025-11-06','2025-11-07',
  '2025-11-08','2025-11-09','2025-11-10','2025-11-11','2025-11-12','2025-11-13','2025-11-14','2025-11-15',
  '2026-03-07','2026-03-08','2026-03-13','2026-03-14','2026-03-15',
];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function snap(date) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: 3000,
      path: `/api/metrics/snapshot?date=${date}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    }, res => {
      let b = '';
      res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve({success:false}); } });
    });
    req.setTimeout(1200000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
async function main() {
  const N = DATES.length;
  console.log(`Backfill ${N} dates | ${new Date().toISOString()}\n`);
  let ok=0, fail=0;
  for (let i=0; i<N; i++) {
    const t0 = Date.now();
    try {
      const d = await snap(DATES[i]);
      const s = ((Date.now()-t0)/1000)|0;
      console.log(`[${i+1}/${N}] ${DATES[i]} ${d.success?'✓':'✗'} ${d.projectsProcessed||0}p ${s}s`);
      d.success ? ok++ : fail++;
    } catch(e) {
      console.log(`[${i+1}/${N}] ${DATES[i]} ✗ ${e.message} ${((Date.now()-t0)/1000)|0}s`);
      fail++;
    }
    if (i<N-1) await sleep(DELAY_MS);
  }
  console.log(`\nDone ${new Date().toISOString()} | OK:${ok} FAIL:${fail}`);
}
main();
