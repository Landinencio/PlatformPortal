const token = process.env.GITLAB_TOKEN;
const DEPLOY_JOB_NAMES = ['deploy_prod','deploy-production','deploy_artifact','deploy-artifact','deploy_prd','deploy-prd'];

async function fetchAll(url) {
  const results = [];
  let page = 1;
  while (true) {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(url + sep + 'per_page=100&page=' + page, { headers: { 'PRIVATE-TOKEN': token } });
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) break;
    results.push(...data);
    if (data.length < 100) break;
    page++;
    if (page > 10) break;
  }
  return results;
}

async function main() {
  const since = '2026-04-13T00:00:00Z';
  console.log('Fetching pipelines since', since);
  const pipelines = await fetchAll('https://gitlab.com/api/v4/projects/45387718/pipelines?updated_after=' + since + '&order_by=updated_at&sort=desc');
  console.log('Pipelines found:', pipelines.length);
  
  let matchedJobs = 0;
  for (const p of pipelines) {
    const jobs = await fetchAll('https://gitlab.com/api/v4/projects/45387718/pipelines/' + p.id + '/jobs?include_retried=false');
    const matched = jobs.filter(j => 
      ['success','failed'].includes(j.status) &&
      DEPLOY_JOB_NAMES.some(name => (j.stage || '').includes(name) || (j.name || '').includes(name))
    );
    for (const j of matched) {
      matchedJobs++;
      const fin = j.finished_at ? j.finished_at.substring(0, 16) : 'N/A';
      console.log('  MATCH: ' + j.name + ' | stage: ' + j.stage + ' | status: ' + j.status + ' | finished: ' + fin);
    }
  }
  console.log('Total matched deploy jobs:', matchedJobs);
}
main().catch(e => console.error(e));
