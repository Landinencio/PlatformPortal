#!/bin/bash

# Script para probar la ingesta de reportes de ciberseguridad

set -e

PORTAL_URL="${PORTAL_URL:-http://localhost:3000}"

echo "🧪 Probando ingesta de reportes de ciberseguridad"
echo "   Portal: $PORTAL_URL"
echo ""

# Leer payloads de prueba
PAYLOADS_FILE="docs/cybersecurity-test-payload.json"

if [ ! -f "$PAYLOADS_FILE" ]; then
  echo "❌ No se encuentra $PAYLOADS_FILE"
  exit 1
fi

# Función para enviar payload
send_payload() {
  local report_type=$1
  local payload=$(cat "$PAYLOADS_FILE" | jq ".$report_type")
  
  echo "📤 Enviando reporte: $report_type"
  
  response=$(curl -s -w "\n%{http_code}" \
    -X POST \
    -H "Content-Type: application/json" \
    -d "$payload" \
    "$PORTAL_URL/api/cybersecurity/intake")
  
  http_code=$(echo "$response" | tail -n1)
  body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "200" ]; then
    echo "✅ Ingesta exitosa"
    echo "$body" | jq -r '   "   Run ID: \(.runId) | Registros: \(.recordsCount) | Insertados: \(.insertedCount)"'
  else
    echo "❌ Error HTTP $http_code"
    echo "$body" | jq '.' 2>/dev/null || echo "$body"
    return 1
  fi
  
  echo ""
}

# Enviar cada tipo de reporte
send_payload "inactive_users_90d"
send_payload "users_without_mfa_group"
send_payload "vpn_groups"

echo "✅ Pruebas completadas"
echo ""
echo "🔍 Verifica los datos en el portal:"
echo "   $PORTAL_URL/ciberseguridad"
echo ""
echo "📊 O consulta directamente en BD:"
echo "   psql \$DATABASE_URL -c \"SELECT id, report_type, generated_at, records_count FROM cybersecurity_runs ORDER BY generated_at DESC LIMIT 10;\""
