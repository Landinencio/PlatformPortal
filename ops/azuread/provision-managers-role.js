// Provision the `managers` RBAC role in Azure AD for the Platform Portal.
//
// Idempotent, Node + Microsoft Graph, client_credentials token flow.
// Follows the style of ops/list-argocd-groups.js and ops/migrate-legacy-argocd-groups.js.
//
// Runs the 4 provisioning steps in STRICT order, each idempotent
// (GET-check before POST/PATCH; `already exists` conflicts are ignored):
//   1. appRole `managers` on the App Registration "PlatformPortal"
//   2. security group `platformmanagers-analytics`
//   3. appRoleAssignment group -> appRole on the PlatformPortal Service Principal
//   4. membership: add the current approvers as members of the group
//
// Secrets are read from the ENVIRONMENT, never from the repo. No secret GUID
// lives in this file. Load them from the dp-tooling cluster (ns n8n, secret
// portal-env, keys AZURE_AD_GRAPH_CLIENT_ID / AZURE_AD_GRAPH_CLIENT_SECRET) and
// AZURE_AD_TENANT_ID. Nothing secret is ever printed in cleartext.
//
// Run (operator only — see task 11.2), e.g. inside the portal pod:
//   kubectl -n n8n exec deploy/portal-prod -- node -e "$(cat ops/azuread/provision-managers-role.js)"
// or locally with the env vars exported:
//   node ops/azuread/provision-managers-role.js

const { randomUUID } = require('crypto');

// --- Config (public identifiers only; NO secrets here) ---------------------

// Enterprise App / App Registration "PlatformPortal" (the one whose appRoles
// originate the JWT `roles` claim). appId is public; the secret is NOT here.
const PORTAL_APP_ID = 'ac7af294-f64a-4345-924b-5bfc652b639d';

const NEW_APP_ROLE = {
  value: 'managers',
  displayName: 'Managers',
  description: 'Managers: staff + Kiro Analytics + visibilidad del buzón de aprobaciones',
  allowedMemberTypes: ['User'],
  isEnabled: true,
};

const GROUP_DISPLAY_NAME = 'platformmanagers-analytics';
const GROUP_MAIL_NICKNAME = 'platformmanagers-analytics';
const GROUP_DESCRIPTION =
  'Portal: rol managers (staff + Kiro Analytics + visibilidad buzón aprobaciones)';

// Approver emails, derived from src/lib/team-approvers.ts (TEAM_APPROVERS) and
// src/lib/infra-approvers.ts (SELECTABLE_APPROVERS + ALWAYS_NOTIFIED).
// Kept as @iskaypet.com; the resolver falls back to @emefinpetcare.com per user.
const APPROVER_EMAILS = [
  // infra-approvers.ts — SELECTABLE_APPROVERS
  'jaime.palomo@iskaypet.com',
  'jorge.marcial@iskaypet.com',
  'santy.prada@iskaypet.com',
  'ruben.landin@iskaypet.com',
  'jesus.furio@iskaypet.com',
  'vanessa.lopez@iskaypet.com',
  // infra-approvers.ts — ALWAYS_NOTIFIED
  'agustin.medina@iskaypet.com',
  // team-approvers.ts — TEAM_APPROVERS (marktech / retail / data / backoffice)
  'alberto.salomon@iskaypet.com',
  'victoria.reyes@iskaypet.com',
  'jesus.avila@iskaypet.com',
  'jose.lopez@iskaypet.com',
  'francisca.suarez@iskaypet.com',
  'arturo.lorenzo@iskaypet.com',
  'mariajose.gonzalez@iskaypet.com',
  'pedro.hernandez@iskaypet.com',
];

// Alternate domain to try when the primary @iskaypet.com lookup fails.
const ALT_DOMAIN = '@emefinpetcare.com';

const GRAPH = 'https://graph.microsoft.com/v1.0';

// --- Auth ------------------------------------------------------------------

const cid = process.env.AZURE_AD_GRAPH_CLIENT_ID;
const tid = process.env.AZURE_AD_TENANT_ID;
const sec = process.env.AZURE_AD_GRAPH_CLIENT_SECRET;

function assertEnv() {
  const missing = [];
  if (!cid) missing.push('AZURE_AD_GRAPH_CLIENT_ID');
  if (!tid) missing.push('AZURE_AD_TENANT_ID');
  if (!sec) missing.push('AZURE_AD_GRAPH_CLIENT_SECRET');
  if (missing.length) {
    // Never print the values — only the missing key names.
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

async function tok() {
  const r = await fetch(`https://login.microsoftonline.com/${tid}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=client_credentials&client_id=${cid}&client_secret=${encodeURIComponent(sec)}&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default`,
  });
  const d = await r.json();
  if (!d.access_token) {
    throw new Error(`Failed to obtain Graph token (status ${r.status})`);
  }
  return d.access_token;
}

// --- Graph helpers ---------------------------------------------------------

async function graphGet(t, path) {
  const r = await fetch(`${GRAPH}${path}`, {
    headers: { Authorization: 'Bearer ' + t, ConsistencyLevel: 'eventual' },
  });
  const d = await r.json().catch(() => ({}));
  if (d && d.error) {
    throw new Error(`GET ${path} -> ${r.status}: ${JSON.stringify(d.error)}`);
  }
  return d;
}

async function graphPost(t, path, body) {
  const r = await fetch(`${GRAPH}${path}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  return { status: r.status, text: txt };
}

async function graphPatch(t, path, body) {
  const r = await fetch(`${GRAPH}${path}`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  if (r.status !== 204) {
    throw new Error(`PATCH ${path} -> ${r.status}: ${txt.slice(0, 200)}`);
  }
  return 'ok';
}

// --- Step 1: appRole `managers` on the App Registration --------------------

async function ensureAppRole(t) {
  console.log('\n=== Step 1: appRole `managers` on App Registration PlatformPortal ===');

  const apps = await graphGet(
    t,
    `/applications?$filter=appId eq '${PORTAL_APP_ID}'&$select=id,displayName,appRoles`
  );
  const app = (apps.value || [])[0];
  if (!app) {
    throw new Error(`App Registration with appId ${PORTAL_APP_ID} not found`);
  }
  const appObjectId = app.id;
  console.log(`  App Registration: ${app.displayName} (objectId ${appObjectId})`);

  const appRoles = Array.isArray(app.appRoles) ? app.appRoles : [];
  const existing = appRoles.find(
    (r) => (r.value || '').toLowerCase() === NEW_APP_ROLE.value
  );
  if (existing) {
    console.log(`  appRole 'managers' already exists (id ${existing.id}) — reusing`);
    return { appObjectId, appRoleId: existing.id };
  }

  const appRoleId = randomUUID();
  const merged = [...appRoles, { ...NEW_APP_ROLE, id: appRoleId }];
  await graphPatch(t, `/applications/${appObjectId}`, { appRoles: merged });
  console.log(`  appRole 'managers' created (id ${appRoleId})`);
  return { appObjectId, appRoleId };
}

// --- Step 2: security group `platformmanagers-analytics` -------------------

async function ensureGroup(t) {
  console.log(`\n=== Step 2: security group ${GROUP_DISPLAY_NAME} ===`);

  // Exact displayName match — never a prefix that could collide with
  // `platformmanagers` (which maps to `directores`).
  const found = await graphGet(
    t,
    `/groups?$filter=displayName eq '${GROUP_DISPLAY_NAME}'&$select=id,displayName`
  );
  const existing = (found.value || [])[0];
  if (existing) {
    console.log(`  group already exists (id ${existing.id}) — reusing`);
    return existing.id;
  }

  const res = await graphPost(t, '/groups', {
    displayName: GROUP_DISPLAY_NAME,
    mailNickname: GROUP_MAIL_NICKNAME,
    mailEnabled: false,
    securityEnabled: true,
    description: GROUP_DESCRIPTION,
  });
  if (res.status === 201) {
    const created = JSON.parse(res.text);
    console.log(`  group created (id ${created.id})`);
    return created.id;
  }
  if (res.text.includes('already exist')) {
    // Race: re-resolve by displayName.
    const again = await graphGet(
      t,
      `/groups?$filter=displayName eq '${GROUP_DISPLAY_NAME}'&$select=id`
    );
    const g = (again.value || [])[0];
    if (g) {
      console.log(`  group already existed (id ${g.id}) — reusing`);
      return g.id;
    }
  }
  throw new Error(`POST /groups -> ${res.status}: ${res.text.slice(0, 200)}`);
}

// --- Step 3: appRoleAssignment group -> appRole on the SP ------------------

async function ensureAppRoleAssignment(t, groupId, appRoleId) {
  console.log('\n=== Step 3: appRoleAssignment group -> managers on Service Principal ===');

  const sps = await graphGet(
    t,
    `/servicePrincipals?$filter=appId eq '${PORTAL_APP_ID}'&$select=id,displayName`
  );
  const sp = (sps.value || [])[0];
  if (!sp) {
    throw new Error(`Service Principal with appId ${PORTAL_APP_ID} not found`);
  }
  const spObjectId = sp.id;
  console.log(`  Service Principal: ${sp.displayName} (objectId ${spObjectId})`);

  const current = await graphGet(t, `/groups/${groupId}/appRoleAssignments`);
  const already = (current.value || []).find(
    (a) => a.appRoleId === appRoleId && a.resourceId === spObjectId
  );
  if (already) {
    console.log(`  assignment already exists (id ${already.id}) — skipping`);
    return;
  }

  const res = await graphPost(t, `/groups/${groupId}/appRoleAssignments`, {
    principalId: groupId,
    resourceId: spObjectId,
    appRoleId: appRoleId,
  });
  if (res.status === 201) {
    console.log('  assignment created');
    return;
  }
  if (res.text.includes('already exist') || res.text.includes('Permission being assigned already exists')) {
    console.log('  assignment already existed — skipping');
    return;
  }
  throw new Error(`POST appRoleAssignments -> ${res.status}: ${res.text.slice(0, 200)}`);
}

// --- Step 4: membership ----------------------------------------------------

async function resolveUserId(t, email) {
  // Try the primary email, then the alternate domain (@iskaypet.com <-> @emefinpetcare.com).
  const candidates = [email];
  if (email.endsWith('@iskaypet.com')) {
    candidates.push(email.replace('@iskaypet.com', ALT_DOMAIN));
  }
  for (const candidate of candidates) {
    const r = await fetch(`${GRAPH}/users/${encodeURIComponent(candidate)}?$select=id,userPrincipalName`, {
      headers: { Authorization: 'Bearer ' + t },
    });
    if (r.status === 200) {
      const d = await r.json();
      return { id: d.id, upn: d.userPrincipalName };
    }
  }
  return null;
}

async function addMember(t, groupId, userId) {
  const r = await fetch(`${GRAPH}/groups/${groupId}/members/$ref`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
    body: JSON.stringify({ '@odata.id': `${GRAPH}/directoryObjects/${userId}` }),
  });
  if (r.status === 204) return 'added';
  const txt = await r.text();
  if (txt.includes('already exist')) return 'already_member';
  return `error_${r.status}: ${txt.slice(0, 120)}`;
}

async function populateMembership(t, groupId) {
  console.log(`\n=== Step 4: membership (${APPROVER_EMAILS.length} approvers) ===`);
  for (const email of APPROVER_EMAILS) {
    const user = await resolveUserId(t, email);
    if (!user) {
      console.log(`  ! could not resolve user for ${email} — skipping`);
      continue;
    }
    const res = await addMember(t, groupId, user.id);
    console.log(`  add ${user.upn ?? email} -> ${GROUP_DISPLAY_NAME}: ${res}`);
  }
}

// --- Main ------------------------------------------------------------------

(async () => {
  assertEnv();
  const t = await tok();

  const { appRoleId } = await ensureAppRole(t);       // Step 1
  const groupId = await ensureGroup(t);               // Step 2
  await ensureAppRoleAssignment(t, groupId, appRoleId); // Step 3
  await populateMembership(t, groupId);               // Step 4

  console.log('\nDone. `managers` role provisioned (idempotent).');
})().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
