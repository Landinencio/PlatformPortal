# Cybersecurity Intake Contract

El portal expone una ingesta para que n8n publique resultados estructurados de ciberseguridad sin depender del email como canal primario.

## Endpoint

`POST /api/cybersecurity/intake`

No requiere autenticación adicional por ahora. Se asume acceso solo desde red privada interna del equipo de plataforma.

## Campos comunes

```json
{
  "source": "azure_ad",
  "reportType": "inactive_users_90d",
  "status": "completed",
  "schemaVersion": "1",
  "sourceRunId": "n8n-execution-12345",
  "generatedAt": "2026-03-24T09:15:00Z",
  "meta": {
    "workflow": "Azure AD - Usuarios inactivos 90 dias",
    "thresholdDays": 90
  },
  "summary": {
    "totalInactive": 42,
    "neverLogin": 8,
    "oldLogin": 34
  },
  "records": []
}
```

## `reportType = "inactive_users_90d"`

Campos esperados por registro:

```json
{
  "id": "aad-user-id",
  "displayName": "Nombre Apellido",
  "mail": "name@company.com",
  "userPrincipalName": "name@company.com",
  "department": "Marketing",
  "company": "IskayPet",
  "createdDate": "2025-11-01T10:00:00Z",
  "lastLogin": "2025-12-15T09:00:00Z",
  "lastNonInteractiveLogin": "2025-12-15T09:05:00Z",
  "daysInactive": 99,
  "neverLoggedIn": false
}
```

## `reportType = "users_without_mfa_group"`

Campos esperados por registro:

```json
{
  "id": "aad-user-id",
  "displayName": "Nombre Apellido",
  "mail": "name@company.com",
  "upn": "name@company.com",
  "department": "Digital",
  "jobTitle": "Developer",
  "company": "IskayPet",
  "created": "2025-10-03T12:00:00Z",
  "lastLogin": "2026-03-01T08:12:00Z",
  "lastNonInteractive": "2026-03-01T08:13:00Z",
  "days": 23,
  "neverLoggedIn": false
}
```

## `reportType = "vpn_groups"`

Cada registro representa un grupo.

```json
{
  "groupId": "aad-group-id",
  "groupName": "AZ_VPN_DIGITAL",
  "description": "Acceso VPN Digital",
  "memberCount": 14,
  "members": [
    {
      "id": "aad-user-id",
      "displayName": "Nombre Apellido",
      "mail": "name@company.com",
      "userPrincipalName": "name@company.com",
      "department": "Digital",
      "createdDate": "2025-11-01T10:00:00Z",
      "lastLogin": "2026-03-20T07:00:00Z",
      "lastNonInteractiveLogin": "2026-03-20T07:02:00Z",
      "neverLoggedIn": false
    }
  ]
}
```

## Comportamiento

- El portal guarda una nueva ejecución por cada ingesta.
- El histórico queda disponible por tipo de reporte.
- Las tablas del portal consumen siempre la ejecución elegida por el administrador.
- La exportación Excel se genera desde el portal con el filtro activo.
