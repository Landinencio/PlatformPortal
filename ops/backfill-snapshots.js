#!/usr/bin/env node
/**
 * Backfill DORA snapshots for the last N days.
 * Run inside the portal pod:
 *   node /tmp/backfill.js
 */
const http = require('http');

const SECRET = process.env.INTERNAL_API_SECRET || '';
const PORT = process.env.PORT || 3000;

function snapshot(date) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: PORT,
      path: '/api/metrics/snapshot?date=' + date,
      method: 'POST',
      headers: {
        'x-internal-secret': SECRET,
        'content-type': 'application/json',
      },
      timeout: 1800000, // 30 min
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d.substring(0, 300) }));
    });
    req.on('error', e => reject(e));
    req.setTimeout(1800000);
    req.end();
  });
}

async function run() {
  // Backfill only dates BEFORE the webhook was activated (April 17, 2026)
  // After that date, webhooks handle real-time data
  const dates = [];
  const webhookStartDate = new Date('2026-04-17');
  const startFrom = new Date('2026-03-16');
  let cursor = new Date(startFrom);
  while (cursor < webhookStartDate) {
    dates.push(cursor.toISOString().split('T')[0]);
    cursor.setDate(cursor.getDate() + 1);
  }

  console.log(`Backfilling ${dates.length} days: ${dates[0]} → ${dates[dates.length - 1]}`);
  console.log(`(Stops before ${webhookStartDate.toISOString().split('T')[0]} — webhook handles data from that date)`);
  console.log('---');

  let ok = 0, fail = 0;
  for (const d of dates) {
    const ts = () => new Date().toISOString().substring(11, 19);
    process.stdout.write(`[${ts()}] ${d} ... `);
    try {
      const r = await snapshot(d);
      if (r.status === 200) {
        ok++;
        console.log(`OK (${ok}/${dates.length})`);
      } else {
        fail++;
        console.log(`FAIL ${r.status}: ${r.body}`);
      }
    } catch (e) {
      fail++;
      console.log(`ERROR: ${e.message}`);
    }
  }

  console.log('---');
  console.log(`Done. OK: ${ok}, Failed: ${fail}`);
}

run();
