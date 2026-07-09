// Migrate legacy `argocd_app_*` Azure AD groups to the standardised
// `ArgoCD_*` groups, then delete the legacy ones.
//
// What it does:
//   1. For each legacy group with members, add those members to the suggested
//      target group (idempotent — Graph 400's if the user is already there,
//      we treat that as success).
//   2. Delete the legacy group.
//
// Re-run safe: deleting an already-deleted group returns 404 which we ignore.
const cid = process.env.AZURE_AD_GRAPH_CLIENT_ID;
const tid = process.env.AZURE_AD_TENANT_ID;
const sec = process.env.AZURE_AD_GRAPH_CLIENT_SECRET;

const TARGET_GROUP_IDS = {
  ArgoCD_Animalis:           '4891f0a2-eb4e-4ae6-9ab8-d7bb11802947',
  ArgoCD_Auth:               '2ac5cde3-824e-4d89-a9fd-3565c1211c64',
  ArgoCD_Business_Monitoring:'c8278fa8-fac3-41be-ab44-958df1cb0588',
  ArgoCD_CZZ:                '663b2f6c-9fef-4f67-a747-5a22f19f890d',
  ArgoCD_Customers:          '1000511b-25cc-4701-9752-f28773fb0820',
  ArgoCD_Identifiers:        '97ba24cb-a965-4361-b2c9-cac0400b1359',
  ArgoCD_Loyalty:            'd60f52ce-a362-4e1b-b39b-ca52586823fd',
  ArgoCD_Marketplace:        '2ceb1157-ba04-46d4-93cf-c02aefc58db4',
  ArgoCD_Mobile:             '2fb94cdf-7878-4489-8244-c16db25710e7',
  ArgoCD_OMS:                'fb68d1c6-e167-41f6-ac78-c50835b4ffde',
  ArgoCD_Payments:           '6a081f04-4c80-492a-b4d5-9022c11d4f60',
  ArgoCD_Products:           '4332c161-12d5-407f-adf4-0f6ac2033ec2',
  ArgoCD_Shipping:           'bb0a7a16-a08f-41a9-a909-d30272c44071',
  ArgoCD_Stores:             '65abe35f-c175-431c-9ac0-c33913a772f8',
  ArgoCD_Websites:           '246413c0-8d9f-4cba-8c0d-a0fd6c9572f6',
};

const LEGACY_GROUPS = [
  ['argocd_app_animalis',           '45697d87-58b1-4a99-a5af-47ca57fe47c4', 'ArgoCD_Animalis'],
  ['argocd_app_auth',               '1d468559-575e-4a1a-8efb-ea1181c3ec99', 'ArgoCD_Auth'],
  ['argocd_app_businessmonitoring', 'e4e82edd-9db2-47f1-ac51-7598b9a3f611', 'ArgoCD_Business_Monitoring'],
  ['argocd_app_comerzzia',          '9c4894fe-0fcc-4110-a345-0caa32262152', 'ArgoCD_CZZ'],
  ['argocd_app_customers',          '13a8afec-5dcf-43bd-aee3-ae9462836777', 'ArgoCD_Customers'],
  ['argocd_app_frontvue',           '8fab00ad-6c5a-4d8d-9825-c5e22af41c15', 'ArgoCD_Websites'],
  ['argocd_app_identifiers',        '26f3c877-d787-4c95-a71f-94cc31a96c41', 'ArgoCD_Identifiers'],
  ['argocd_app_loyalty',            '6979244d-efc7-4cd5-aa00-01bf6770a8b3', 'ArgoCD_Loyalty'],
  ['argocd_app_marketplace',        'e09bf9ef-c70c-4554-893f-afdc4cee92b5', 'ArgoCD_Marketplace'],
  ['argocd_app_mobile',             '7d0a3b7a-3731-49fc-be9e-9113cb8252d1', 'ArgoCD_Mobile'],
  ['argocd_app_oms',                'c9ddb2a0-4804-4fbd-8924-8537eda35d06', 'ArgoCD_OMS'],
  ['argocd_app_payments',           '1df6c623-73c7-4610-b0ba-e82bca080df4', 'ArgoCD_Payments'],
  ['argocd_app_products',           'ce579082-8be2-4c64-ace9-b157941c2519', 'ArgoCD_Products'],
  ['argocd_app_returns',            '079755e1-6a8e-4921-b075-318deea8a1bc', null],
  ['argocd_app_shipping',           'd25bb4d0-6e6d-4221-a760-dff7b6016f71', 'ArgoCD_Shipping'],
  ['argocd_app_stores',             '9edf5a89-ebe4-4441-b228-16d58a130dfb', 'ArgoCD_Stores'],
  ['argocd_app_websites',           '3e15851f-128e-4b79-b108-d8a5f450f447', 'ArgoCD_Websites'],
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
  const r = await fetch(`https://graph.microsoft.com/v1.0/groups/${groupId}/members?$select=id,userPrincipalName,displayName&$top=200`, {
    headers: { Authorization: 'Bearer ' + t },
  });
  const d = await r.json();
  return d.value || [];
}

async function addMember(t, groupId, userId) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/groups/${groupId}/members/$ref`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` }),
  });
  if (r.status === 204) return 'added';
  const txt = await r.text();
  if (txt.includes('already exist')) return 'already_member';
  return `error_${r.status}: ${txt.slice(0, 120)}`;
}

async function deleteGroup(t, groupId) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/groups/${groupId}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + t },
  });
  if (r.status === 204) return 'deleted';
  if (r.status === 404) return 'not_found';
  const txt = await r.text();
  return `error_${r.status}: ${txt.slice(0, 120)}`;
}

(async () => {
  const t = await tok();
  for (const [legacyName, legacyId, target] of LEGACY_GROUPS) {
    console.log(`\n=== ${legacyName} -> ${target ?? '(no target)'} ===`);
    const members = await getMembers(t, legacyId);
    console.log(`  members: ${members.length}`);
    if (members.length > 0 && target) {
      const targetId = TARGET_GROUP_IDS[target];
      if (!targetId) {
        console.log(`  ! target id not found for ${target}, skipping membership migration`);
      } else {
        for (const m of members) {
          const res = await addMember(t, targetId, m.id);
          console.log(`  add ${m.userPrincipalName ?? m.displayName} → ${target}: ${res}`);
        }
      }
    } else if (members.length > 0 && !target) {
      console.log(`  ! has ${members.length} members but no target — keeping group, skipping delete`);
      continue;
    }
    const del = await deleteGroup(t, legacyId);
    console.log(`  delete ${legacyName}: ${del}`);
  }
})();
