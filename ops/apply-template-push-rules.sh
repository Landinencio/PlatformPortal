#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# apply-template-push-rules.sh
#
# Aplica las push rules de nomenclatura de ramas a los proyectos
# template usados por el flujo de creación de repositorios del portal.
#
# Esto garantiza que cualquier repo nuevo creado desde estos templates
# herede la push rule y obligue al estándar de ramas desde el día 1.
#
# Regla aplicada:
#   - Branch: ^(feat|fix|hotfix|perf|refactor|chore|build|ci|docs|test)\/[A-Z]+-[0-9]+$
#
# Requisitos:
#   - GITLAB_TOKEN con scope api y permisos Maintainer en el grupo de templates
#   - curl, jq
#
# Uso:
#   GITLAB_TOKEN=glpat-xxx ./ops/apply-template-push-rules.sh [--dry-run]
# ---------------------------------------------------------------------------

set -euo pipefail

GITLAB_URL="${GITLAB_URL:-https://gitlab.com}"
API="${GITLAB_URL}/api/v4"
TOKEN="${GITLAB_TOKEN:?Error: GITLAB_TOKEN no está definido}"
DRY_RUN=false

# Branch naming regex
BRANCH_REGEX='^(feat|fix|hotfix|perf|refactor|chore|build|ci|docs|test)\/[A-Z]+-[0-9]+$'

# Template projects del grupo 93744712
TEMPLATES=(
  "61922564|go-microservices"
  "62552641|frontend-headless"
  "66003760|springboot-microservices"
  "74105964|fastapi-microservices"
  "66006940|springboot-library"
  "77818808|headless-template-multi-brand"
)
TEMPLATE_COUNT=${#TEMPLATES[@]}

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "=== MODO DRY-RUN: no se aplicarán cambios ==="
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

TOTAL=0
UPDATED=0
SKIPPED=0
ERRORS=0

gitlab_api() {
  local method="${1}"
  local endpoint="${2}"
  shift 2
  local response http_code body
  response=$(curl -s -w "\n%{http_code}" \
    --header "PRIVATE-TOKEN: ${TOKEN}" \
    --request "${method}" \
    "$@" \
    "${API}${endpoint}")
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')
  if [[ ! "$http_code" =~ ^2 ]]; then
    echo "API_ERROR:${http_code}:${body}" >&2
    return 1
  fi
  echo "$body"
}

validate_token() {
  echo "Validando token contra ${GITLAB_URL}..."
  local user
  user=$(gitlab_api GET "/user" 2>&1) || true
  if [[ "$user" == API_ERROR* ]]; then
    echo -e "${RED}Error: No se pudo autenticar con GitLab.${NC}"
    exit 1
  fi
  local username
  username=$(echo "$user" | jq -r '.username // "unknown"' 2>/dev/null)
  echo -e "  Autenticado como: ${GREEN}${username}${NC}"
  echo ""
}

apply_push_rule() {
  local project_id="$1"
  local template_name="$2"

  TOTAL=$((TOTAL + 1))

  local project_info
  project_info=$(gitlab_api GET "/projects/${project_id}" 2>&1) || true
  if [[ "$project_info" == API_ERROR* ]]; then
    echo -e "  ${RED}[ERROR]${NC} ${template_name} (${project_id}) — no se pudo acceder"
    ERRORS=$((ERRORS + 1))
    return
  fi

  local project_path
  project_path=$(echo "$project_info" | jq -r '.path_with_namespace // "unknown"' 2>/dev/null)

  local current
  current=$(gitlab_api GET "/projects/${project_id}/push_rule" 2>&1) || true

  local current_branch_regex=""
  local has_rule=""

  if [[ "$current" != API_ERROR* ]]; then
    current_branch_regex=$(echo "$current" | jq -r '.branch_name_regex // empty' 2>/dev/null)
    has_rule=$(echo "$current" | jq -r '.id // empty' 2>/dev/null)
  fi

  if [[ "$current_branch_regex" == "$BRANCH_REGEX" ]]; then
    echo -e "  ${CYAN}[SKIP]${NC} ${template_name} — ${project_path} — ya tiene la regex correcta"
    SKIPPED=$((SKIPPED + 1))
    return
  fi

  if $DRY_RUN; then
    if [[ -n "$current_branch_regex" ]]; then
      echo -e "  ${YELLOW}[DRY-RUN]${NC} ${template_name} — ${project_path} — actualizaría regex"
    else
      echo -e "  ${YELLOW}[DRY-RUN]${NC} ${template_name} — ${project_path} — crearía push rule"
    fi
    UPDATED=$((UPDATED + 1))
    return
  fi

  local result
  if [[ -n "$has_rule" ]]; then
    result=$(gitlab_api PUT "/projects/${project_id}/push_rule" \
      --header "Content-Type: application/json" \
      --data "{\"branch_name_regex\": \"${BRANCH_REGEX}\"}" 2>&1) || true
  else
    result=$(gitlab_api POST "/projects/${project_id}/push_rule" \
      --header "Content-Type: application/json" \
      --data "{\"branch_name_regex\": \"${BRANCH_REGEX}\"}" 2>&1) || true
  fi

  if [[ "$result" == API_ERROR* ]]; then
    local err_code
    err_code=$(echo "$result" | cut -d: -f2)
    echo -e "  ${RED}[ERROR]${NC} ${template_name} — ${project_path} — HTTP ${err_code}"
    ERRORS=$((ERRORS + 1))
  else
    echo -e "  ${GREEN}[OK]${NC} ${template_name} — ${project_path} — push rule aplicada"
    UPDATED=$((UPDATED + 1))
  fi

  sleep 0.1
}

echo ""
echo "=============================================="
echo "  Push Rules: Nomenclatura de ramas (Templates)"
echo "  Branch: ${BRANCH_REGEX}"
echo "  GitLab: ${GITLAB_URL}"
echo "  Templates: ${TEMPLATE_COUNT} proyectos"
echo "=============================================="
echo ""

validate_token

for entry in "${TEMPLATES[@]}"; do
  project_id="${entry%%|*}"
  template_name="${entry##*|}"
  apply_push_rule "$project_id" "$template_name"
done

echo ""
echo "=============================================="
echo "  Resumen"
echo "=============================================="
echo -e "  Total templates:  ${TOTAL}"
echo -e "  Actualizados:     ${GREEN}${UPDATED}${NC}"
echo -e "  Ya correctos:     ${CYAN}${SKIPPED}${NC}"
echo -e "  Errores:          ${RED}${ERRORS}${NC}"
echo ""

if $DRY_RUN; then
  echo -e "${YELLOW}Ejecuta sin --dry-run para aplicar los cambios.${NC}"
fi
