const https = require('https');

const url = process.env.GRAFANA_METRICS_URL;
const username = process.env.GRAFANA_METRICS_USERNAME;
const token = process.env.GRAFANA_METRICS_TOKEN;
const auth = Buffer.from(username + ':' + token).toString('base64');

function query(promql) {
  var fullUrl = url + '/api/v1/query?' + new URLSearchParams({ query: promql });
  return new Promise(function(resolve, reject) {
    https.get(fullUrl, { headers: { Authorization: 'Basic ' + auth } }, function(res) {
      var data = '';
      res.on('data', function(c) { data += c; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function run() {
  var r, results;

  // 1. kube_deployment metrics
  r = await query('count(kube_deployment_status_observed_generation) by (namespace)');
  results = (r.data && r.data.result) || [];
  console.log('=== kube_deployment_status_observed_generation ===');
  console.log('Namespaces:', results.length);
  results.slice(0, 10).forEach(function(x) { console.log(' ', x.metric.namespace, ':', x.value[1]); });

  // 2. kube_deployment_spec_replicas - tells us about deployment changes
  r = await query('count(kube_deployment_spec_replicas) by (namespace)');
  results = (r.data && r.data.result) || [];
  console.log('\n=== kube_deployment_spec_replicas ===');
  console.log('Namespaces:', results.length);

  // 3. container restart counts (useful for failure detection)
  r = await query('count(kube_pod_container_status_restarts_total) by (namespace)');
  results = (r.data && r.data.result) || [];
  console.log('\n=== kube_pod_container_status_restarts_total ===');
  console.log('Namespaces:', results.length);

  // 4. Check for deployment metadata/labels
  r = await query('count(kube_deployment_labels) by (namespace)');
  results = (r.data && r.data.result) || [];
  console.log('\n=== kube_deployment_labels ===');
  console.log('Namespaces:', results.length);

  // 5. Check kube_deployment_created
  r = await query('count(kube_deployment_created) by (namespace)');
  results = (r.data && r.data.result) || [];
  console.log('\n=== kube_deployment_created ===');
  console.log('Namespaces:', results.length);

  // 6. Sample: deployments in a prod-like namespace
  r = await query('kube_deployment_status_observed_generation{namespace=~".*prod.*|.*digital.*|.*default.*"}');
  results = (r.data && r.data.result) || [];
  console.log('\n=== Prod deployments (sample) ===');
  results.slice(0, 10).forEach(function(x) {
    console.log(' ', x.metric.namespace + '/' + x.metric.deployment, 'gen:', x.value[1]);
  });
  console.log('Total prod deployments:', results.length);

  // 7. Check for rollout-related metrics
  r = await query('count by (__name__)({__name__=~"kube_deployment.*"})');
  results = (r.data && r.data.result) || [];
  console.log('\n=== All kube_deployment_* metric names ===');
  results.forEach(function(x) { console.log(' ', x.metric.__name__, ':', x.value[1], 'series'); });

  // 8. ArgoCD app_info with more detail
  r = await query('argocd_app_info{health_status="Degraded"}');
  results = (r.data && r.data.result) || [];
  console.log('\n=== Degraded ArgoCD Apps ===');
  results.forEach(function(x) {
    console.log(' ', x.metric.name, '- ns:', x.metric.dest_namespace, '- repo:', (x.metric.repo || 'none').substring(0, 60));
  });

  // 9. Check for argocd_app_info labels available
  r = await query('argocd_app_info{name="oms-carriers-helm"}');
  results = (r.data && r.data.result) || [];
  console.log('\n=== Sample ArgoCD app labels ===');
  if (results.length > 0) {
    var labels = Object.keys(results[0].metric);
    console.log('Labels:', labels.join(', '));
    console.log('Values:');
    labels.forEach(function(l) { console.log('  ', l, '=', results[0].metric[l]); });
  }
}

run().catch(function(e) { console.error('Error:', e.message); });
