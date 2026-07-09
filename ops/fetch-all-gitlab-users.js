/**
 * Fetches all members from all iskaypet subgroups and generates
 * the SQL for the developer_name_map table.
 * 
 * Run inside the portal pod:
 *   node /tmp/fetch-users.js
 */

const token = process.env.GITLAB_TOKEN;

// All subgroups under iskaypet (66335040)
const GROUP_IDS = [
  66347331,  // Digital
  66419117,  // Retail
  110564874, // Helios
  66418532,  // Backoffice
  66418793,  // DataBI
  66418992,  // SRE-Infra
  66419397,  // EducaPet-IT
  66417434,  // Friendly Companies
];

async function fetchAll(url) {
  const results = [];
  let page = 1;
  while (true) {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(url + sep + 'per_page=100&page=' + page, {
      headers: { 'PRIVATE-TOKEN': token }
    });
    if (!res.ok) break;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
    if (page > 20) break;
  }
  return results;
}

function isBot(username, name) {
  return username.includes('bot') || username.includes('token') || 
         name === 'cicd_token' || username.startsWith('group_');
}

function isOldAccount(username) {
  return username.endsWith('-old') || username.endsWith('_old');
}

function deriveCanonicalName(username, displayName) {
  // If display name looks like a real name (has space, proper casing), use it
  if (displayName && /\s/.test(displayName) && !/[@]/.test(displayName)) {
    return displayName;
  }
  
  // If display name is an email, derive from the local part
  if (displayName && displayName.includes('@')) {
    const local = displayName.split('@')[0];
    return local.split('.').map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }
  
  // If display name is a username format (no spaces, all lowercase)
  if (displayName && !/\s/.test(displayName) && !/[@]/.test(displayName)) {
    // Try to derive from username (more reliable)
    const clean = username.replace(/\d+$/, '').replace(/-old$/, '');
    return clean.split(/[._-]/).filter(p => p.length > 1)
      .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
  }
  
  // Fallback: derive from username
  const clean = username.replace(/\d+$/, '').replace(/-old$/, '');
  return clean.split(/[._-]/).filter(p => p.length > 1)
    .map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' ');
}

async function main() {
  const allMembers = new Map(); // gitlab_id → member

  // Use the root iskaypet group with all_members endpoint to get everyone
  // This covers all subgroups recursively
  const rootGroupId = 66335040; // iskaypet root
  const members = await fetchAll('https://gitlab.com/api/v4/groups/' + rootGroupId + '/members/all');
  for (const m of members) {
    if (!allMembers.has(m.id)) {
      allMembers.set(m.id, m);
    }
  }

  // Also fetch from each subgroup to catch members not in root
  for (const groupId of GROUP_IDS) {
    const groupMembers = await fetchAll('https://gitlab.com/api/v4/groups/' + groupId + '/members/all');
    for (const m of groupMembers) {
      if (!allMembers.has(m.id)) {
        allMembers.set(m.id, m);
      }
    }
  }

  const allMembersList = [...allMembers.values()];
  
  // Filter out bots and old accounts
  const active = allMembersList.filter(m => !isBot(m.username, m.name) && !isOldAccount(m.username));
  
  process.stderr.write('Total unique members across all groups: ' + allMembersList.length + '\n');
  process.stderr.write('Active (non-bot, non-old): ' + active.length + '\n\n');

  // Generate SQL
  const lines = [];
  lines.push('-- Developer name mapping — all GitLab members');
  lines.push('-- Generated from API: ' + new Date().toISOString());
  lines.push('-- Review canonical_name column before applying');
  lines.push('');
  lines.push('CREATE TABLE IF NOT EXISTS developer_name_map (');
  lines.push('  id SERIAL PRIMARY KEY,');
  lines.push('  gitlab_username TEXT NOT NULL UNIQUE,');
  lines.push('  gitlab_id INTEGER UNIQUE,');
  lines.push('  canonical_name TEXT NOT NULL,');
  lines.push('  gitlab_display_name TEXT,');
  lines.push('  notes TEXT,');
  lines.push('  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),');
  lines.push('  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()');
  lines.push(');');
  lines.push('');
  lines.push('INSERT INTO developer_name_map (gitlab_username, gitlab_id, canonical_name, gitlab_display_name) VALUES');

  const rows = active
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(m => {
      const canonical = deriveCanonicalName(m.username, m.name);
      const displayEscaped = (m.name || '').replace(/'/g, "''");
      const canonicalEscaped = canonical.replace(/'/g, "''");
      return "  ('" + m.username + "', " + m.id + ", '" + canonicalEscaped + "', '" + displayEscaped + "')";
    });

  lines.push(rows.join(',\n'));
  lines.push('ON CONFLICT (gitlab_username) DO UPDATE SET');
  lines.push('  canonical_name = EXCLUDED.canonical_name,');
  lines.push('  gitlab_display_name = EXCLUDED.gitlab_display_name,');
  lines.push('  updated_at = NOW();');
  lines.push('');
  lines.push('-- Total: ' + rows.length + ' members');

  console.log(lines.join('\n'));
}

main().catch(e => { process.stderr.write(e.message + '\n'); process.exit(1); });
