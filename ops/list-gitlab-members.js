const token = process.env.GITLAB_TOKEN;

async function fetchAll(url) {
  const results = [];
  let page = 1;
  while (true) {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(url + sep + 'per_page=100&page=' + page, {
      headers: { 'PRIVATE-TOKEN': token }
    });
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

function isProblematicName(name, username) {
  if (!name) return true;
  if (name.includes('@')) return true;           // email as name
  if (name === username) return true;             // username as name
  if (/^[a-z0-9]+\.[a-z0-9]+$/.test(name)) return true;  // firstname.lastname format (no spaces)
  if (/^[a-z0-9_-]+$/.test(name)) return true;  // all lowercase no spaces
  return false;
}

async function main() {
  const members = await fetchAll('https://gitlab.com/api/v4/groups/66335040/members/all');
  console.log('Total members: ' + members.length);
  console.log('');

  const problematic = members.filter(m => isProblematicName(m.name, m.username));
  console.log('--- PROBLEMATIC NAMES (' + problematic.length + ') ---');
  for (const m of problematic.sort((a, b) => a.name.localeCompare(b.name))) {
    console.log(m.id + ' | username: ' + m.username + ' | display_name: ' + m.name);
  }

  console.log('');
  console.log('--- ALL MEMBERS ---');
  for (const m of members.sort((a, b) => a.name.localeCompare(b.name))) {
    const flag = isProblematicName(m.name, m.username) ? ' ⚠️' : '';
    console.log(m.id + ' | ' + m.username + ' | ' + m.name + flag);
  }
}

main().catch(e => console.error(e));
