// Initial population of ArgoCD_<AppSet> Azure AD groups from the existing
// AWS_DH_*/AWS_Data_*/AWS_Retail_*/AWS_MarTech_*/AWS_Backoffice_* squad
// groups. The mapping is documented in steering section 16.
//
// Adds are idempotent: if a user is already in the target group, Graph
// returns "already exist" which we treat as success.
//
// Run inside the n8n-webhooks pod:
//   POD=$(kubectl -n n8n get pod -l app=n8n-webhooks -o jsonpath='{.items[0].metadata.name}')
//   kubectl -n n8n cp ops/populate-argocd-groups-from-aws-squads.js $POD:/tmp/populate.js -c n8n-webhooks
//   kubectl -n n8n exec $POD -c n8n-webhooks -- node /tmp/populate.js

const cid = process.env.AZURE_AD_GRAPH_CLIENT_ID;
const tid = process.env.AZURE_AD_TENANT_ID;
const sec = process.env.AZURE_AD_GRAPH_CLIENT_SECRET;

// Source AWS squad groups (Identity Center).
const AWS_GROUPS = {
  'AWS_DH_OMS_Developers':    'c6f4fdaa-44a4-4af1-b97b-9760d98fd136',
  'AWS_DH_MKP_Developers':    '527057fc-d725-45c1-aaa6-5565880e5fab',
  'AWS_DH_CEX_Developers':    '03698638-fcd5-4961-a27e-a4b91499f7c3',
  'AWS_DH_GROWTH_Developers': '7afbe0f7-f4d1-4d45-a53a-f99d6078dd0b',
  'AWS_DH_FLS_Developers':    '5493ef41-102c-4a5f-b939-80d46a163dc9',
  'AWS_DH_Mobile_Developers': '3994d1ca-996b-4cf5-b1e9-b6fa739abbb5',
  'AWS_Data_Developers':      '439a6a1d-36cf-4379-bdf8-f686e3507a06',
  'AWS_Backoffice_Developers':'61d8687e-e750-4005-b352-62231c006fc9',
  // We don't have IDs of AWS_Data_AIEngineer, AWS_Retail_*, AWS_MarTech_* in
  // this script; add them here when you confirm them or extend the mapping.
};

// Target ArgoCD groups (canonical, from steering section 16).
const ARGOCD_GROUPS = {
  ArgoCD_OMS:                 'fb68d1c6-e167-41f6-ac78-c50835b4ffde',
  ArgoCD_Marketplace:         '2ceb1157-ba04-46d4-93cf-c02aefc58db4',
  ArgoCD_Customers:           '1000511b-25cc-4701-9752-f28773fb0820',
  ArgoCD_Auth:                '2ac5cde3-824e-4d89-a9fd-3565c1211c64',
  ArgoCD_Loyalty:             'd60f52ce-a362-4e1b-b39b-ca52586823fd',
  ArgoCD_Mobile:              '2fb94cdf-7878-4489-8244-c16db25710e7',
  ArgoCD_Payments:            '6a081f04-4c80-492a-b4d5-9022c11d4f60',
  ArgoCD_Products:            '4332c161-12d5-407f-adf4-0f6ac2033ec2',
  ArgoCD_Stores:              '65abe35f-c175-431c-9ac0-c33913a772f8',
  ArgoCD_Shipping:            'bb0a7a16-a08f-41a9-a909-d30272c44071',
  ArgoCD_Identifiers:         '97ba24cb-a965-4361-b2c9-cac0400b1359',
  ArgoCD_Animalis:            '4891f0a2-eb4e-4ae6-9ab8-d7bb11802947',
  ArgoCD_Business_Monitoring: 'c8278fa8-fac3-41be-ab44-958df1cb0588',
  ArgoCD_Basket:              '27422c3f-cfcb-487f-9635-2e73dac5138a',
  ArgoCD_Checkout:            'c5c61720-7770-4c3e-89fa-b851e72f6704',
  ArgoCD_Core:                'a7bff54e-a6a1-4b1b-a408-004fd0b713f4',
  ArgoCD_Pricing:             '7d363d98-7fdc-46df-9fbe-d1059e09c6be',
  ArgoCD_CZZ:                 '663b2f6c-9fef-4f67-a747-5a22f19f890d',
  ArgoCD_CZZ_ProxySQL:        '547f5e6c-a186-48e9-8933-cab9877c3691',
  ArgoCD_Helios:              'a5eb2fcc-6c01-4631-95be-740bed0a668d',
  ArgoCD_Data_Science:        '9e47f6ca-2db7-4948-9abc-13688b1dc118',
  ArgoCD_Websites:            '246413c0-8d9f-4cba-8c0d-a0fd6c9572f6',
  ArgoCD_Websites_Animalis:   'cdd3cd4d-4899-4a45-9100-f2386560c44d',
  ArgoCD_Websites_Kiwoko:     'af3ca44e-e12f-4159-91e1-915651539b26',
  ArgoCD_Websites_Tiendanimal:'6ad4e0ca-d76c-40f4-a79a-7561328382fd',
};

// Squad → list of ArgoCD AppSet groups to copy members into.
const PLAN = [
  { aws: 'AWS_DH_OMS_Developers',    targets: ['ArgoCD_OMS', 'ArgoCD_Animalis', 'ArgoCD_Stores', 'ArgoCD_Business_Monitoring'] },
  { aws: 'AWS_DH_MKP_Developers',    targets: ['ArgoCD_Marketplace', 'ArgoCD_Identifiers'] },
  { aws: 'AWS_DH_CEX_Developers',    targets: ['ArgoCD_Customers', 'ArgoCD_Business_Monitoring'] },
  { aws: 'AWS_DH_GROWTH_Developers', targets: ['ArgoCD_Payments', 'ArgoCD_Websites', 'ArgoCD_Products'] },
  { aws: 'AWS_DH_FLS_Developers',    targets: ['ArgoCD_Stores'] },
  { aws: 'AWS_DH_Mobile_Developers', targets: ['ArgoCD_Mobile'] },
  { aws: 'AWS_Data_Developers',      targets: ['ArgoCD_Data_Science'] },
  // Backoffice has no ArgoCD AppSets today, skipping.
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

(async () => {
  const t = await tok();

  // Aggregate: target_group -> Set(userIds)  (dedupe across multiple squads)
  const aggregate = new Map();
  for (const step of PLAN) {
    const awsId = AWS_GROUPS[step.aws];
    if (!awsId) {
      console.log(`! Source ${step.aws} has no ID configured, skipping`);
      continue;
    }
    const members = await getMembers(t, awsId);
    console.log(`\n${step.aws} (${members.length} members)`);
    for (const target of step.targets) {
      const targetId = ARGOCD_GROUPS[target];
      if (!targetId) {
        console.log(`  ! Target ${target} unknown, skipping`);
        continue;
      }
      let bucket = aggregate.get(target);
      if (!bucket) {
        bucket = new Map();
        aggregate.set(target, bucket);
      }
      for (const m of members) {
        bucket.set(m.id, m.userPrincipalName ?? m.displayName);
      }
      console.log(`  → planned for ${target}: ${members.length}`);
    }
  }

  // Execute
  console.log('\n=== EXECUTION ===');
  for (const [target, bucket] of aggregate) {
    const targetId = ARGOCD_GROUPS[target];
    console.log(`\n→ ${target} (${bucket.size} unique users to ensure)`);
    let added = 0, already = 0, errors = 0;
    for (const [userId, upn] of bucket) {
      const res = await addMember(t, targetId, userId);
      if (res === 'added') added++;
      else if (res === 'already_member') already++;
      else { errors++; console.log(`  ! ${upn}: ${res}`); }
    }
    console.log(`  added=${added} already_member=${already} errors=${errors}`);
  }

  console.log('\nDone.');
})();
