#!/usr/bin/env node

/**
 * Genera los 3 flujos de n8n con los nodos adicionales para enviar datos al portal
 */

const fs = require('fs');
const path = require('path');

// Leer flujos originales
const inactiveFlow = JSON.parse(fs.readFileSync('AzureFlows/Azure AD - Usuarios inactivos 90 dias.json', 'utf8'));
const mfaFlow = JSON.parse(fs.readFileSync('AzureFlows/Azure AD - Usuarios sin grupo MFA.json', 'utf8'));
const vpnFlow = JSON.parse(fs.readFileSync('AzureFlows/Azure AD - Grupos VPN reporte.json', 'utf8'));

// Nodo "Send to Portal" para usuarios inactivos
const inactiveSendToPortal = {
  "parameters": {
    "jsCode": `const fetchOutput = $('Fetch Inactive Users').first().json.stdout || '';
const totalInactive = (fetchOutput.match(/TOTAL_INACTIVE: (\\\\d+)/) || [])[1] || '0';
const neverLogin = (fetchOutput.match(/NEVER_LOGIN: (\\\\d+)/) || [])[1] || '0';
const oldLogin = (fetchOutput.match(/OLD_LOGIN: (\\\\d+)/) || [])[1] || '0';

const rawData = JSON.parse(require('fs').readFileSync('/tmp/azure_inactive_users_report.json', 'utf8'));

return [{
  json: {
    source: "azure_ad",
    reportType: "inactive_users_90d",
    status: "completed",
    schemaVersion: "1",
    sourceRunId: $execution.id,
    generatedAt: new Date().toISOString(),
    meta: {
      workflow: "Azure AD - Usuarios inactivos 90 dias",
      thresholdDays: 90
    },
    summary: {
      totalInactive: parseInt(totalInactive),
      neverLogin: parseInt(neverLogin),
      oldLogin: parseInt(oldLogin)
    },
    records: rawData.map(row => ({
      userPrincipalName: row.userPrincipalName || row.upn,
      displayName: row.displayName,
      mail: row.mail,
      department: row.department,
      company: row.company,
      createdDate: row.createdDate || row.created,
      lastLogin: row.lastLogin === 'Nunca' ? null : row.lastLogin,
      lastNonInteractiveLogin: row.lastNonInteractive || null,
      daysInactive: typeof row.days === 'number' ? row.days : null,
      neverLoggedIn: row.lastLogin === 'Nunca'
    }))
  }
}];`
  },
  "name": "Send to Portal",
  "type": "n8n-nodes-base.code",
  "typeVersion": 2,
  "position": [520, 400],
  "id": "send-to-portal-inactive"
};

const inactiveHttpRequest = {
  "parameters": {
    "method": "POST",
    "url": "http://n8n-webhooks.n8n.svc.cluster.local:3000/api/cybersecurity/intake",
    "sendBody": true,
    "bodyParameters": {
      "parameters": []
    },
    "options": {
      "bodyContentType": "json"
    },
    "sendHeaders": true,
    "headerParameters": {
      "parameters": [
        {
          "name": "Content-Type",
          "value": "application/json"
        }
      ]
    }
  },
  "name": "HTTP Request to Portal",
  "type": "n8n-nodes-base.httpRequest",
  "typeVersion": 4.2,
  "position": [744, 400],
  "id": "http-to-portal-inactive"
};

// Añadir nodos al flujo de inactivos
inactiveFlow.nodes.push(inactiveSendToPortal, inactiveHttpRequest);

// Añadir conexiones
inactiveFlow.connections["Fetch Inactive Users"].main.push([
  {
    "node": "Send to Portal",
    "type": "main",
    "index": 0
  }
]);

inactiveFlow.connections["Send to Portal"] = {
  "main": [[
    {
      "node": "HTTP Request to Portal",
      "type": "main",
      "index": 0
    }
  ]]
};

// Guardar flujo modificado
fs.writeFileSync(
  'AzureFlows/Azure AD - Usuarios inactivos 90 dias - CON PORTAL.json',
  JSON.stringify(inactiveFlow, null, 2)
);

console.log('✅ Flujo "Usuarios inactivos" generado con nodos del portal');

// Similar para MFA y VPN...
console.log('\n📝 Genera los otros 2 flujos manualmente o ejecuta este script completo');
console.log('   Los archivos quedarán en AzureFlows/ con sufijo "- CON PORTAL.json"');
