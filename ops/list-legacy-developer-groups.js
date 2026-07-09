// List Azure AD groups that look like legacy "<Squad>Developers" or
// "<Squad>Leads" — pre-RBAC era groups still referenced in
// kube-stack values.yaml. We need to know who's in each before migrating.
const cid = process.env.AZURE_AD_GRAPH_CLIENT_ID;
const tid = process.env.AZURE_AD_TENANT_ID;
const sec = process.env.AZURE_AD_GRAPH_CLIENT_SECRET;

async function tok() {
  const r = await fetch(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${cid}&client_secret=${encodeURIComponent(sec)}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default`,
  });
  return (await r.json()).access_token;
}

const SUFFIXES = ['Developers', 'Leads'];

(async () => {
  const t = await tok();
  const matches = [];
  for (const suffix of SUFFIXES) {
    let url = `https://graph.microsoft.com/v1.0/groups?$filter=endsWith(displayName,'${suffix}')&$top=200&$select=id,displayName,description`;
    while (url) {
      const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t, ConsistencyLevel: 'eventual' } });
      const d = await r.json();
      if (d.error) {
        console.log('error fetching', suffix, ':', d.error.message);
        break;
      }
      for (const g of d.value || []) matches.push(g);
      url = d['@odata.nextLink'] || null;
    }
  }
  matches.sort((a, b) => a.displayName.localeCompare(b.displayName));
  console.log(`Found ${matches.length} groups with suffix Developers/Leads:`);
  for (const g of matches) {
    const r = await fetch(`https://graph.microsoft.com/v1.0/groups/${g.id}/members?$select=userPrincipalName,displayName&$top=50`, {
      headers: { Authorization: 'Bearer ' + t },
    });
    const d = await r.json();
    const members = d.value || [];
    console.log(`\n[${members.length}] ${g.displayName}  (${g.id})`);
    if (g.description) console.log(`     ${g.description.slice(0, 100)}`);
    members.forEach(m => console.log(`     - ${m.userPrincipalName ?? m.displayName}`));
  }
})();
