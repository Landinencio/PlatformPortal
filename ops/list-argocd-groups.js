// One-off probe: list all Azure AD groups that start with "ArgoCD_"
// Run inside the n8n-webhooks pod:
//   kubectl -n n8n exec deploy/n8n-webhooks -- node -e "$(cat ops/list-argocd-groups.js)"
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

(async () => {
  const t = await tok();
  let url = `https://graph.microsoft.com/v1.0/groups?$filter=startswith(displayName,'ArgoCD_')&$top=200&$select=id,displayName,description`;
  const all = [];
  while (url) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t, ConsistencyLevel: 'eventual' } });
    const d = await r.json();
    if (d.error) { console.log('err', JSON.stringify(d.error)); return; }
    for (const g of d.value || []) all.push(g);
    url = d['@odata.nextLink'] || null;
  }
  all.sort((a, b) => a.displayName.localeCompare(b.displayName));
  console.log('Total ArgoCD_* groups:', all.length);
  all.forEach(g => console.log(' ', g.displayName, '|', g.id));
})();
