# Integración n8n → Portal: Ciberseguridad

> Opción recomendada: importar directamente los flujos completos ya generados en `AzureFlows/* - CON PORTAL.json`.
> La configuración manual descrita aquí se conserva como referencia.

## Resumen

Los flujos de Azure AD en n8n ahora deben enviar sus resultados al portal vía `POST /api/cybersecurity/intake` para que queden persistidos en PostgreSQL. El portal consume esos datos desde BD, no desde n8n en vivo.

## Cambios necesarios en n8n

Cada flujo debe añadir un nodo HTTP Request al final que envíe el payload estructurado al portal.

### 1. Usuarios inactivos +90 días

**Flujo actual**: `Azure AD - Usuarios inactivos 90 dias`

**Webhook portal**: Añadir nodo Code después de "Fetch Inactive Users"

```javascript
// Nodo: "Send to Portal"
// Tipo: Code (JavaScript)

const fetchOutput = $('Fetch Inactive Users').first().json.stdout || '';
const totalInactive = (fetchOutput.match(/TOTAL_INACTIVE: (\d+)/) || [])[1] || '0';
const neverLogin = (fetchOutput.match(/NEVER_LOGIN: (\d+)/) || [])[1] || '0';
const oldLogin = (fetchOutput.match(/OLD_LOGIN: (\d+)/) || [])[1] || '0';

const rawData = JSON.parse(require('fs').readFileSync('/tmp/azure_inactive_users_report.json', 'utf8'));

const payload = {
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
};

return [{ json: payload }];
```

**Luego añadir nodo HTTP Request**:
- Tipo: HTTP Request
- Method: POST
- URL: `http://n8n-webhooks.n8n.svc.cluster.local:3000/api/cybersecurity/intake`
- Body: JSON
- Body Content: `{{ $json }}`

### 2. Usuarios sin grupo MFA

**Flujo actual**: `Azure AD - Usuarios sin grupo MFA`

**Webhook portal**: Añadir nodo Code después de "Fetch & Filter Users"

```javascript
// Nodo: "Send to Portal"
// Tipo: Code (JavaScript)

const fetchOutput = $('Fetch & Filter Users').first().json.stdout || '';
const resultMatch = (fetchOutput.match(/Result: (\d+) users/) || [])[1] || '0';
const neverMatch = (fetchOutput.match(/(\d+) never logged/) || [])[1] || '0';
const over90Match = (fetchOutput.match(/(\d+) >90 days/) || [])[1] || '0';

const rawData = JSON.parse(require('fs').readFileSync('/tmp/azure_mfa_report.json', 'utf8'));

const payload = {
  source: "azure_ad",
  reportType: "users_without_mfa_group",
  status: "completed",
  schemaVersion: "1",
  sourceRunId: $execution.id,
  generatedAt: new Date().toISOString(),
  meta: {
    workflow: "Azure AD - Usuarios sin grupo MFA",
    groupConMfaId: $('Config').first().json['GROUP_CON_MFA_ID'],
    groupSinMfaId: $('Config').first().json['GROUP_SIN_MFA_ID']
  },
  summary: {
    totalUsers: parseInt(resultMatch),
    neverLogin: parseInt(neverMatch),
    over90d: parseInt(over90Match)
  },
  records: rawData.map(row => ({
    upn: row.upn || row.userPrincipalName,
    displayName: row.displayName,
    mail: row.mail,
    department: row.department,
    jobTitle: row.jobTitle,
    company: row.company,
    created: row.created || row.createdDate,
    lastLogin: row.lastLogin === 'Nunca' ? null : row.lastLogin,
    lastNonInteractive: row.lastNonInteractive || null,
    days: typeof row.days === 'number' ? row.days : null,
    neverLoggedIn: row.lastLogin === 'Nunca'
  }))
};

return [{ json: payload }];
```

**Luego añadir nodo HTTP Request**:
- Tipo: HTTP Request
- Method: POST
- URL: `http://n8n-webhooks.n8n.svc.cluster.local:3000/api/cybersecurity/intake`
- Body: JSON
- Body Content: `{{ $json }}`

### 3. Grupos VPN

**Flujo actual**: `Azure AD - Grupos VPN reporte`

**Webhook portal**: Añadir nodo Code después de "Fetch VPN Groups"

```javascript
// Nodo: "Send to Portal"
// Tipo: Code (JavaScript)

const fetchOutput = $('Fetch VPN Groups').first().json.stdout || '';
const totalGroups = (fetchOutput.match(/TOTAL_GROUPS: (\d+)/) || [])[1] || '0';
const totalMembers = (fetchOutput.match(/TOTAL_MEMBERS: (\d+)/) || [])[1] || '0';

const rawData = JSON.parse(require('fs').readFileSync('/tmp/azure_vpn_groups_report.json', 'utf8'));

const payload = {
  source: "azure_ad",
  reportType: "vpn_groups",
  status: "completed",
  schemaVersion: "1",
  sourceRunId: $execution.id,
  generatedAt: new Date().toISOString(),
  meta: {
    workflow: "Azure AD - Grupos VPN reporte",
    groupPrefix: $('Config').first().json['VPN_GROUP_PREFIX']
  },
  summary: {
    totalGroups: parseInt(totalGroups),
    totalMembers: parseInt(totalMembers),
    groupsWithMembers: rawData.filter(g => g.memberCount > 0).length
  },
  records: rawData.map(group => ({
    groupId: group.groupId,
    groupName: group.groupName,
    description: group.description || null,
    memberCount: group.memberCount,
    members: group.members.map(member => ({
      userPrincipalName: member.userPrincipalName,
      displayName: member.displayName,
      mail: member.mail,
      department: member.department,
      createdDate: member.createdDate,
      lastLogin: member.lastLogin === 'Nunca' ? null : member.lastLogin,
      lastNonInteractiveLogin: member.lastNonInteractive || null,
      neverLoggedIn: member.lastLogin === 'Nunca'
    }))
  }))
};

return [{ json: payload }];
```

**Luego añadir nodo HTTP Request**:
- Tipo: HTTP Request
- Method: POST
- URL: `http://n8n-webhooks.n8n.svc.cluster.local:3000/api/cybersecurity/intake`
- Body: JSON
- Body Content: `{{ $json }}`

## Variables de entorno

No se requieren variables adicionales ni cabeceras de autenticación por ahora. El endpoint se consume solo desde la red privada interna.

## Flujo de datos

```
Azure AD Graph API
       ↓
   n8n workflow
       ↓
  Genera JSON + Excel
       ↓
  POST /api/cybersecurity/intake (nuevo)
       ↓
  PostgreSQL (cybersecurity_runs + tablas detalle)
       ↓
  Portal UI consume desde BD
```

## Ventajas

1. **Histórico**: El portal retiene todas las ejecuciones en BD
2. **Filtros**: La UI puede filtrar por departamento, grupo, fecha sin volver a llamar a n8n
3. **Exportación**: El Excel se genera desde BD con los filtros aplicados
4. **Independencia**: El portal no depende de que n8n esté disponible para mostrar datos históricos
5. **Email opcional**: Los flujos de email siguen funcionando como respaldo, pero ya no son la fuente primaria

## Verificación

Después de actualizar los flujos:

1. Ejecutar manualmente cada flujo en n8n
2. Verificar que el nodo "Send to Portal" devuelve 200 OK
3. Ir al portal → `/ciberseguridad`
4. Verificar que aparecen los datos en las tarjetas de resumen
5. Entrar en cada tab (Inactivos, MFA, VPN) y verificar que se ven los registros
6. Probar la exportación Excel desde el portal

## Troubleshooting

**Error 503 Schema not ready**
- Ejecutar la migración: `psql $DATABASE_URL -f migrations/2026-03-24_cybersecurity_reports.sql`

**Error 400 Bad Request**
- Revisar el payload en el nodo "Send to Portal"
- Verificar que los campos obligatorios están presentes: `reportType`, `records`

**No aparecen datos en el portal**
- Verificar que el POST devolvió 200 OK
- Revisar logs del portal: `kubectl logs -n n8n deployment/n8n-webhooks -f`
- Consultar BD directamente: `SELECT * FROM cybersecurity_runs ORDER BY generated_at DESC LIMIT 5;`
