const stackUrl = process.env.GRAFANA_STACK_URL;
const token = process.env.GRAFANA_TOKEN;
const auth = `Bearer ${token}`;

async function getJson(path) {
  const r = await fetch(stackUrl + path, { headers: { Authorization: auth } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${r.status} ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function tryProxyQuery(uid, path, qs = '') {
  const url = `${stackUrl}/api/datasources/proxy/uid/${uid}${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, { headers: { Authorization: auth } });
  console.log(`  proxy uid=${uid} ${path}: HTTP ${r.status}`);
  if (r.ok) {
    const t = await r.text();
    console.log('    sample:', t.slice(0, 400).replace(/\s+/g, ' '));
  }
}

(async () => {
  const ds = await getJson('/api/datasources');
  console.log(`Found ${ds.length} datasources:`);
  for (const d of ds) {
    console.log(`  type=${d.type.padEnd(20)} uid=${d.uid.padEnd(18)} name=${d.name}`);
  }

  console.log('\n--- Loki / Tempo / Pyroscope datasources ---');
  const interesting = ds.filter((d) => /loki|tempo|pyroscope/i.test(d.type));
  for (const d of interesting) {
    console.log(`\n[${d.type}] ${d.name} uid=${d.uid}`);
    if (d.type === 'loki') {
      await tryProxyQuery(d.uid, '/loki/api/v1/labels');
      await tryProxyQuery(d.uid, '/loki/api/v1/label/__name__/values');
      const now = Math.floor(Date.now() / 1000);
      await tryProxyQuery(d.uid, '/loki/api/v1/label/cluster/values', `start=${now - 3600}&end=${now}`);
    } else if (d.type === 'tempo') {
      await tryProxyQuery(d.uid, '/api/echo');
      await tryProxyQuery(d.uid, '/api/search/tags');
    }
  }
})();
