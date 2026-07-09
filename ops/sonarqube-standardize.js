// Standardise SonarQube access: create a single SonarQube_Developers group,
// remove the existing 9 transversal groups from the Enterprise App, and add
// to the new group every user that belongs to any of the 25 ArgoCD_* groups.
//
// What it does:
//   1. Discover all users from the 25 ArgoCD_<AppSet> Azure AD groups (the
//      authoritative source of "platform developers" today). Dedupe.
//   2. Create or get the `SonarQube_Developers` security group.
//   3. Add the deduped users to the new group (idempotent).
//   4. Assign the new group to the SonarQube Enterprise App.
//   5. Remove every other group assignment from the SonarQube Enterprise App
//      (the 9 legacy ones).
//
// Run inside the n8n-webhooks pod (uses Graph credentials from env).

const cid = process.env.AZURE_AD_GRAPH_CLIENT_ID;
const tid = process.env.AZURE_AD_TENANT_ID;
const sec = process.env.AZURE_AD_GRAPH_CLIENT_SECRET;

const SONARQUBE_SP_ID = '45099247-f6a1-4205-a11e-0c4dfbe1c51e';
const NEW_GROUP_NAME = 'SonarQube_Developers';
const NEW_GROUP_DESCRIPTION = 'Acceso transversal a SonarQube — alimentado desde la unión de los grupos ArgoCD_*';

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

async function getToken() {
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

async function findGroupByName(t, displayName) {
  const r = await fetch(
    `https://graph.microsoft.com/v1.0/groups?$filter=displayName eq '${encodeURIComponent(displayName)}'&$select=id,displayName`,
    { headers: { Authorization: 'Bearer ' + t } }
  );
  const d = await r.json();
  return (d.value || [])[0] || null;
}

async function createGroup(t, displayName, description) {
  const r = await fetch('https://graph.microsoft.com/v1.0/groups', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName,
      mailEnabled: false,
      mailNickname: displayName.toLowerCase().replace(/[^a-z0-9]/g, ''),
      securityEnabled: true,
      description,
    }),
  });
  const d = await r.json();
  if (!r.ok) throw new Error(`createGroup ${r.status}: ${JSON.stringify(d)}`);
  return d;
}

async function addMember(t, groupId, userId) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/groups/${groupId}/members/$ref`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ '@odata.id': `https://graph.microsoft.com/v1.0/directoryObjects/${userId}` }),
  });
  if (r.status === 204) return 'added';
  const txt = await r.text();
  if (txt.includes('already exist') || txt.includes('One or more added object')) return 'already_member';
  return `error_${r.status}: ${txt.slice(0, 120)}`;
}

async function getSpAssignments(t, spId) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/servicePrincipals/${spId}/appRoleAssignedTo?$top=999`, {
    headers: { Authorization: 'Bearer ' + t },
  });
  const d = await r.json();
  return (d.value || []).filter((x) => x.principalType === 'Group');
}

async function deleteAssignment(t, assignmentId, spId) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/servicePrincipals/${spId}/appRoleAssignedTo/${assignmentId}`, {
    method: 'DELETE',
    headers: { Authorization: 'Bearer ' + t },
  });
  if (r.status === 204) return 'deleted';
  const txt = await r.text();
  return `error_${r.status}: ${txt.slice(0, 120)}`;
}

async function getSpAppRoles(t, spId) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/servicePrincipals/${spId}?$select=appRoles`, {
    headers: { Authorization: 'Bearer ' + t },
  });
  const d = await r.json();
  return d.appRoles || [];
}

async function createAssignment(t, spId, principalId, appRoleId) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/servicePrincipals/${spId}/appRoleAssignedTo`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      principalId,
      resourceId: spId,
      appRoleId,
    }),
  });
  if (r.status === 201) return 'created';
  const txt = await r.text();
  if (txt.includes('Permission being assigned already exists')) return 'already_exists';
  return `error_${r.status}: ${txt.slice(0, 200)}`;
}

(async () => {
  const t = await getToken();

  // Step 1: collect all unique members across the 25 ArgoCD_* groups
  console.log('=== Step 1: Collect members from 25 ArgoCD_* groups ===');
  const aggregate = new Map(); // userId -> upn
  for (const [name, id] of Object.entries(ARGOCD_GROUPS)) {
    const members = await getMembers(t, id);
    for (const m of members) {
      aggregate.set(m.id, m.userPrincipalName ?? m.displayName);
    }
    console.log(`  ${name.padEnd(30)} ${members.length} members (running total ${aggregate.size})`);
  }
  console.log(`Total unique users: ${aggregate.size}`);

  // Step 2: create or get the new group
  console.log(`\n=== Step 2: Ensure group "${NEW_GROUP_NAME}" exists ===`);
  let group = await findGroupByName(t, NEW_GROUP_NAME);
  if (!group) {
    group = await createGroup(t, NEW_GROUP_NAME, NEW_GROUP_DESCRIPTION);
    console.log(`  CREATED ${NEW_GROUP_NAME} = ${group.id}`);
  } else {
    console.log(`  EXISTS ${NEW_GROUP_NAME} = ${group.id}`);
  }
  const newGroupId = group.id;

  // Step 3: populate the new group
  console.log(`\n=== Step 3: Populate ${NEW_GROUP_NAME} with ${aggregate.size} users ===`);
  let added = 0, already = 0, errors = 0;
  for (const [userId, upn] of aggregate) {
    const res = await addMember(t, newGroupId, userId);
    if (res === 'added') added++;
    else if (res === 'already_member') already++;
    else { errors++; console.log(`  ! ${upn}: ${res}`); }
  }
  console.log(`  added=${added}  already_member=${already}  errors=${errors}`);

  // Step 4: assign the new group to SonarQube SP
  console.log(`\n=== Step 4: Assign ${NEW_GROUP_NAME} to SonarQube SP ===`);
  const appRoles = await getSpAppRoles(t, SONARQUBE_SP_ID);
  const assignableRoles = appRoles.filter((r) => r.isEnabled && (r.allowedMemberTypes || []).includes('User'));
  let appRoleId = '00000000-0000-0000-0000-000000000000';
  if (assignableRoles.length > 0) {
    appRoleId = assignableRoles[0].id;
    console.log(`  Using appRole "${assignableRoles[0].displayName}" id=${appRoleId}`);
  } else {
    console.log(`  Using default access appRoleId=${appRoleId}`);
  }
  const assigned = await createAssignment(t, SONARQUBE_SP_ID, newGroupId, appRoleId);
  console.log(`  assignment: ${assigned}`);

  // Step 5: remove every OTHER group assignment from SonarQube SP
  console.log(`\n=== Step 5: Remove other group assignments from SonarQube SP ===`);
  const existing = await getSpAssignments(t, SONARQUBE_SP_ID);
  for (const asg of existing) {
    if (asg.principalId === newGroupId) {
      console.log(`  KEEP    ${asg.principalDisplayName} (the new group)`);
      continue;
    }
    const res = await deleteAssignment(t, asg.id, SONARQUBE_SP_ID);
    console.log(`  REMOVE  ${asg.principalDisplayName.padEnd(40)} → ${res}`);
  }

  console.log('\nDone.');
})();
