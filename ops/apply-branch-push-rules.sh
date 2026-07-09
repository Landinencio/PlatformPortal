#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# apply-branch-push-rules.sh
#
# Aplica las push rules de nomenclatura de ramas a todos los
# proyectos de los subgrupos indicados, incluyendo subgrupos anidados.
#
# Regla aplicada:
#   - Branch: ^(feat|fix|hotfix|perf|refactor|chore|build|ci|docs|test)\/[A-Z]+-[0-9]+$
#
# Requisitos:
#   - GITLAB_TOKEN con scope api y permisos de Owner/Maintainer en los grupos
#   - curl, jq
#
# Uso:
#   GITLAB_TOKEN=glpat-xxx ./ops/apply-branch-push-rules.sh [--dry-run]
#
# Variables de entorno opcionales:
#   GITLAB_URL  (default: https://gitlab.com)
# ---------------------------------------------------------------------------

set -euo pipefail

GITLAB_URL="${GITLAB_URL:-https://gitlab.com}"
API="${GITLAB_URL}/api/v4"
TOKEN="${GITLAB_TOKEN:?Error: GITLAB_TOKEN no está definido}"
DRY_RUN=false

# Branch naming regex (ADR ramas)
BRANCH_REGEX='^(feat|fix|hotfix|perf|refactor|chore|build|ci|docs|test)\/[A-Z]+-[0-9]+$'

# Grupos raíz a procesar
ROOT_GROUPS=(127660860 66347530)

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "=== MODO DRY-RUN: no se aplicarán cambios ==="
fi

# Colores
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
    echo "  URL: ${GITLAB_URL}"
    echo "  Respuesta: ${user}"
    exit 1
  fi

  local username
  username=$(echo "$user" | jq -r '.username // "unknown"' 2>/dev/null)
  echo -e "  Autenticado como: ${GREEN}${username}${NC}"
  echo ""
}

get_group_info() {
  local group_id="$1"
  local info
  info=$(gitlab_api GET "/groups/${group_id}" 2>&1) || true
  if [[ "$info" == API_ERROR* ]]; then
    echo -e "${RED}Error accediendo al grupo ${group_id}: ${info}${NC}"
    return 1
  fi
  echo "$info" | jq -r '.full_path // "unknown"'
}

get_all_subgroups() {
  local group_id="$1"
  local page=1
  while true; do
    local response
    response=$(gitlab_api GET "/groups/${group_id}/descendant_groups?per_page=100&page=${page}" 2>&1) || true
    if [[ "$response" == API_ERROR* || -z "$response" ]]; then break; fi
    local ids
    ids=$(echo "$response" | jq -r '.[].id' 2>/dev/null)
    if [[ -z "$ids" ]]; then break; fi
    echo "$ids"
    local count
    count=$(echo "$response" | jq 'length' 2>/dev/null)
    if [[ "$count" -lt 100 ]]; then break; fi
    page=$((page + 1))
  done
}

get_group_projects() {
  local group_id="$1"
  local page=1
  while true; do
    local response
    response=$(gitlab_api GET "/groups/${group_id}/projects?per_page=100&page=${page}&include_subgroups=false&archived=false&simple=true" 2>&1) || true
    if [[ "$response" == API_ERROR* || -z "$response" ]]; then break; fi
    local count
    count=$(echo "$response" | jq 'length' 2>/dev/null)
    if [[ -z "$count" || "$count" == "0" ]]; then break; fi
    echo "$response" | jq -r '.[] | "\(.id)|\(.path_with_namespace)"' 2>/dev/null
    if [[ "$count" -lt 100 ]]; then break; fi
    page=$((page + 1))
  done
}

apply_push_rule() {
  local project_id="$1"
  local project_path="$2"

  TOTAL=$((TOTAL + 1))

  # Obtener push rules actuales
  local current
  current=$(gitlab_api GET "/projects/${project_id}/push_rule" 2>&1) || true

  local current_branch_regex=""
  local has_rule=""

  if [[ "$current" != API_ERROR* ]]; then
    current_branch_regex=$(echo "$current" | jq -r '.branch_name_regex // empty' 2>/dev/null)
    has_rule=$(echo "$current" | jq -r '.id // empty' 2>/dev/null)
  fi

  if [[ "$current_branch_regex" == "$BRANCH_REGEX" ]]; then
    echo -e "  ${CYAN}[SKIP]${NC} ${project_path} — ya tiene la regex correcta"
    SKIPPED=$((SKIPPED + 1))
    return
  fi

  if $DRY_RUN; then
    if [[ -n "$current_branch_regex" ]]; then
      echo -e "  ${YELLOW}[DRY-RUN]${NC} ${project_path} — actualizaría regex: '${current_branch_regex}' → ADR"
    else
      echo -e "  ${YELLOW}[DRY-RUN]${NC} ${project_path} — crearía push rule"
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
    echo -e "  ${RED}[ERROR]${NC} ${project_path} — HTTP ${err_code}"
    ERRORS=$((ERRORS + 1))
  else
    echo -e "  ${GREEN}[OK]${NC} ${project_path} — push rule aplicada"
    UPDATED=$((UPDATED + 1))
  fi

  sleep 0.1
}

# -------------------------------------------------------
# Main
# -------------------------------------------------------
echo ""
echo "=============================================="
echo "  Push Rules: Nomenclatura de ramas"
echo "  Branch: ${BRANCH_REGEX}"
echo "  GitLab: ${GITLAB_URL}"
echo "=============================================="
echo ""

validate_token

for root_group in "${ROOT_GROUPS[@]}"; do
  echo -e "${GREEN}▸ Procesando grupo raíz: ${root_group}${NC}"

  group_name=$(get_group_info "$root_group") || continue
  echo "  Grupo: ${group_name}"

  all_groups=("$root_group")
  while IFS= read -r subgroup_id; do
    [[ -n "$subgroup_id" ]] && all_groups+=("$subgroup_id")
  done < <(get_all_subgroups "$root_group")

  echo "  Total grupos (raíz + subgrupos): ${#all_groups[@]}"
  echo ""

  for group_id in "${all_groups[@]}"; do
    while IFS='|' read -r project_id project_path; do
      [[ -z "$project_id" ]] && continue
      apply_push_rule "$project_id" "$project_path"
    done < <(get_group_projects "$group_id")
  done

  echo ""
done

echo "=============================================="
echo "  Resumen"
echo "=============================================="
echo -e "  Total proyectos:  ${TOTAL}"
echo -e "  Actualizados:     ${GREEN}${UPDATED}${NC}"
echo -e "  Ya correctos:     ${CYAN}${SKIPPED}${NC}"
echo -e "  Errores:          ${RED}${ERRORS}${NC}"
echo ""

if $DRY_RUN; then
  echo -e "${YELLOW}Ejecuta sin --dry-run para aplicar los cambios.${NC}"
fi
