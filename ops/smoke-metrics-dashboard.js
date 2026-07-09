const http = require("node:http");
const https = require("node:https");

const baseUrl = process.env.METRICS_BASE_URL || "http://localhost:3000";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function fetchJson(pathname) {
  return new Promise((resolve, reject) => {
    const url = new URL(pathname, baseUrl);
    const client = url.protocol === "https:" ? https : http;

    const request = client.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
        });
        response.on("end", () => {
          if ((response.statusCode || 500) >= 400) {
            return reject(new Error(`HTTP ${response.statusCode} on ${pathname}: ${body}`));
          }

          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(new Error(`Respuesta no JSON en ${pathname}: ${error.message}`));
          }
        });
      }
    );

    request.on("error", reject);
    request.end();
  });
}

async function run() {
  console.log(`Running metrics smoke checks against ${baseUrl}`);

  const projectsPayload = await fetchJson("/api/metrics/projects?includeInactive=false&inactiveDays=60&days=60");
  assert(Array.isArray(projectsPayload.groups), "El endpoint /api/metrics/projects no devolvio groups[]");

  const allProjects = projectsPayload.groups.flatMap((group) => group.projects || []);
  const sampleProject = allProjects[0] || null;

  const dora = await fetchJson("/api/metrics/dora-core?days=30");
  assert(dora.summary && Array.isArray(dora.trend), "DORA core no tiene summary/trend");
  assert(dora.summary.deploymentFrequency, "DORA core no trae deploymentFrequency");
  assert(dora.summary.methodology, "DORA core no trae methodology");

  const manager = await fetchJson("/api/metrics/manager-dashboard?days=30");
  assert(manager.summary && Array.isArray(manager.weekly), "Manager dashboard no tiene summary/weekly");
  assert(manager.productionDelivery && Array.isArray(manager.productionDelivery.weekly), "Manager dashboard no trae productionDelivery.weekly");

  const sonar = await fetchJson("/api/sonarqube/dashboard?days=30");
  assert(sonar.summary && Array.isArray(sonar.projects), "Sonar dashboard no tiene summary/projects");
  assert(Array.isArray(sonar.availableProjects), "Sonar dashboard no trae availableProjects");

  if (sampleProject && sampleProject.id) {
    const scopedDora = await fetchJson(`/api/metrics/dora-core?days=30&projectIds=${sampleProject.id}`);
    assert(scopedDora.summary && Array.isArray(scopedDora.trend), "DORA scopeado por proyecto no devolvio summary/trend");

    const scopedManager = await fetchJson(`/api/metrics/manager-dashboard?days=30&projectIds=${sampleProject.id}`);
    assert(scopedManager.summary, "Manager scopeado por proyecto no devolvio summary");
  }

  console.log("✓ /api/metrics/projects");
  console.log("✓ /api/metrics/dora-core");
  console.log("✓ /api/metrics/manager-dashboard");
  console.log("✓ /api/sonarqube/dashboard");
  if (sampleProject && sampleProject.id) {
    console.log(`✓ Scoped checks on project ${sampleProject.id}`);
  }
}

run().catch((error) => {
  console.error("Smoke metrics dashboard failed:", error.message);
  process.exitCode = 1;
});
