// Audit member counts in the 18 legacy `argocd_app_*` groups before
// migrating them to the standardised `ArgoCD_*` groups.
const cid = process.env.AZURE_AD_GRAPH_CLIENT_ID;
const tid = process.env.AZURE_AD_TENANT_ID;
const sec = process.env.AZURE_AD_GRAPH_CLIENT_SECRET;

const LEGACY_GROUPS = [
  ['argocd_app_animalis',         '45697d87-58b1-4a99-a5af-47ca57fe47c4', 'ArgoCD_Animalis'],
  ['argocd_app_auth',             '1d468559-575e-4a1a-8efb-ea1181c3ec99', 'ArgoCD_Auth'],
  ['argocd_app_businessmonitoring', 'e4e82edd-9db2-47f1-ac51-7598b9a3f611', 'ArgoCD_Business_Monitoring'],
  ['argocd_app_comerzzia',        '9c4894fe-0fcc-4110-a345-0caa32262152', 'ArgoCD_CZZ'],
  ['argocd_app_customers',        '13a8afec-5dcf-43bd-aee3-ae9462836777', 'ArgoCD_Customers'],
  ['argocd_app_frontvue',         '8fab00ad-6c5a-4d8d-9825-c5e22af41c15', 'ArgoCD_Websites'],
  ['argocd_app_identifiers',      '26f3c877-d787-4c95-a71f-94cc31a96c41', 'ArgoCD_Identifiers'],
  ['argocd_app_loyalty',          '6979244d-efc7-4cd5-aa00-01bf6770a8b3', 'ArgoCD_Loyalty'],
  ['argocd_app_marketplace',      'e09bf9ef-c70c-4554-893f-afdc4cee92b5', 'ArgoCD_Marketplace'],
  ['argocd_app_mobile',           '7d0a3b7a-3731-49fc-be9e-9113cb8252d1', 'ArgoCD_Mobile'],
  ['argocd_app_oms',              'c9ddb2a0-4804-4fbd-8924-8537eda35d06', 'ArgoCD_OMS'],
  ['argocd_app_payments',         '1df6c623-73c7-4610-b0ba-e82bca080df4', 'ArgoCD_Payments'],
  ['argocd_app_products',         'ce579082-8be2-4c64-ace9-b157941c2519', 'ArgoCD_Products'],
  ['argocd_app_returns',          '079755e1-6a8e-4921-b075-318deea8a1bc', null],          // no AppSet 'returns' active
  ['argocd_app_shipping',         'd25bb4d0-6e6d-4221-a760-dff7b6016f71', 'ArgoCD_Shipping'],
  ['argocd_app_stores',           '9edf5a89-ebe4-4441-b228-16d58a130dfb', 'ArgoCD_Stores'],
  ['argocd_app_websites',         '3e15851f-128e-4b79-b108-d8a5f450f447', 'ArgoCD_Websites'],
];

async function tok() {
  const r = await fetch(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${cid}&client_secret=${encodeURIComponent(sec)}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default`,
  });
  return (await r.json()).access_token;
}

async function getMembers(t, groupId) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/groups/${groupId}/members?$select=id,displayName,userPrincipalName&$top=200`, {
    headers: { Authorization: 'Bearer ' + t },
  });
  const d = await r.json();
  return d.value || [];
}

(async () => {
  const t = await tok();
  console.log('legacy_group | members | suggested_target');
  console.log('---');
  for (const [name, id, suggested] of LEGACY_GROUPS) {
    const members = await getMembers(t, id);
    console.log(`${name} | ${members.length} | ${suggested ?? '(NO TARGET — review manually)'}`);
    if (members.length > 0) {
      members.forEach(m => console.log(`    ${m.userPrincipalName || m.displayName}`));
    }
  }
})();
