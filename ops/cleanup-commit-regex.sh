#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# cleanup-commit-regex.sh
#
# Elimina la regex de commits (commit_message_regex) de todos los proyectos
# de los subgrupos + templates, dejando intacta la regex de ramas.
#
# Uso:
#   GITLAB_TOKEN=glpat-xxx ./ops/cleanup-commit-regex.sh [--dry-run]
# ---------------------------------------------------------------------------

set -euo pipefail

GITLAB_URL="${GITLAB_URL:-https://gitlab.com}"
API="${GITLAB_URL}/api/v4"
TOKEN="${GITLAB_TOKEN:?Error: GITLAB_TOKEN no está definido}"
DRY_RUN=false

# Grupos raíz
ROOT_GROUPS=(127660860 66347530)

# Templates
TEMPLATES=(
  "61922564|go-microservices"
  "62552641|frontend-headless"
  "66003760|springboot-microservices"
  "74105964|fastapi-microservices"
  "66006940|springboot-library"
  "77818808|headless-template-multi-brand"
)

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=true
  echo "=== MODO DRY-RUN ==="
fi

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
NC='\033[0m'

TOTAL=0; CLEANED=0; SKIPPED=0; ERRORS=0

gitlab_api() {
  local method="${1}" endpoint="${2}"; shift 2
  local response http_code body
  response=$(curl -s -w "\n%{http_code}" --header "PRIVATE-TOKEN: ${TOKEN}" --request "${method}" "$@" "${API}${endpoint}")
  http_code=$(echo "$response" | tail -1)
  body=$(echo "$response" | sed '$d')
  if [[ ! "$http_code" =~ ^2 ]]; then echo "API_ERROR:${http_code}:${body}" >&2; return 1; fi
  echo "$body"
}

get_all_subgroups() {
  local group_id="$1" page=1
  while true; do
    local response
    response=$(gitlab_api GET "/groups/${group_id}/descendant_groups?per_page=100&page=${page}" 2>&1) || true
    if [[ "$response" == API_ERROR* || -z "$response" ]]; then break; fi
    local ids; ids=$(echo "$response" | jq -r '.[].id' 2>/dev/null)
    if [[ -z "$ids" ]]; then break; fi
    echo "$ids"
    local count; count=$(echo "$response" | jq 'length' 2>/dev/null)
    if [[ "$count" -lt 100 ]]; then break; fi
    page=$((page + 1))
  done
}

get_group_projects() {
  local group_id="$1" page=1
  while true; do
    local response
    response=$(gitlab_api GET "/groups/${group_id}/projects?per_page=100&page=${page}&include_subgroups=false&archived=false&simple=true" 2>&1) || true
    if [[ "$response" == API_ERROR* || -z "$response" ]]; then break; fi
    local count; count=$(echo "$response" | jq 'length' 2>/dev/null)
    if [[ -z "$count" || "$count" == "0" ]]; then break; fi
    echo "$response" | jq -r '.[] | "\(.id)|\(.path_with_namespace)"' 2>/dev/null
    if [[ "$count" -lt 100 ]]; then break; fi
    page=$((page + 1))
  done
}

clean_commit_regex() {
  local project_id="$1" project_path="$2"
  TOTAL=$((TOTAL + 1))

  local current
  current=$(gitlab_api GET "/projects/${project_id}/push_rule" 2>&1) || true

  if [[ "$current" == API_ERROR* ]]; then
    SKIPPED=$((SKIPPED + 1))
    return
  fi

  local commit_regex has_rule
  commit_regex=$(echo "$current" | jq -r '.commit_message_regex // empty' 2>/dev/null)
  has_rule=$(echo "$current" | jq -r '.id // empty' 2>/dev/null)

  if [[ -z "$commit_regex" ]]; then
    echo -e "  ${CYAN}[SKIP]${NC} ${project_path} — no tiene commit regex"
    SKIPPED=$((SKIPPED + 1))
    return
  fi

  if $DRY_RUN; then
    echo -e "  ${YELLOW}[DRY-RUN]${NC} ${project_path} — borraría commit_message_regex"
    CLEANED=$((CLEANED + 1))
    return
  fi

  local result
  result=$(gitlab_api PUT "/projects/${project_id}/push_rule" \
    --header "Content-Type: application/json" \
    --data '{"commit_message_regex": ""}' 2>&1) || true

  if [[ "$result" == API_ERROR* ]]; then
    echo -e "  ${RED}[ERROR]${NC} ${project_path}"
    ERRORS=$((ERRORS + 1))
  else
    echo -e "  ${GREEN}[OK]${NC} ${project_path} — commit regex eliminada"
    CLEANED=$((CLEANED + 1))
  fi
  sleep 0.1
}

# Validar token
echo "Validando token..."
user=$(gitlab_api GET "/user" 2>&1) || true
if [[ "$user" == API_ERROR* ]]; then echo -e "${RED}Error de autenticación${NC}"; exit 1; fi
username=$(echo "$user" | jq -r '.username // "unknown"' 2>/dev/null)
echo -e "Autenticado como: ${GREEN}${username}${NC}"
echo ""

# Templates
echo -e "${GREEN}▸ Limpiando templates...${NC}"
for entry in "${TEMPLATES[@]}"; do
  pid="${entry%%|*}"; pname="${entry##*|}"
  clean_commit_regex "$pid" "template:${pname}"
done
echo ""

# Grupos
for root_group in "${ROOT_GROUPS[@]}"; do
  echo -e "${GREEN}▸ Limpiando grupo ${root_group}...${NC}"
  all_groups=("$root_group")
  while IFS= read -r sg; do [[ -n "$sg" ]] && all_groups+=("$sg"); done < <(get_all_subgroups "$root_group")
  echo "  Grupos: ${#all_groups[@]}"
  for gid in "${all_groups[@]}"; do
    while IFS='|' read -r pid ppath; do
      [[ -z "$pid" ]] && continue
      clean_commit_regex "$pid" "$ppath"
    done < <(get_group_projects "$gid")
  done
  echo ""
done

echo "=============================================="
echo -e "  Total: ${TOTAL} | Limpiados: ${GREEN}${CLEANED}${NC} | Skip: ${CYAN}${SKIPPED}${NC} | Errores: ${RED}${ERRORS}${NC}"
echo "=============================================="
if $DRY_RUN; then echo -e "${YELLOW}Ejecuta sin --dry-run para aplicar.${NC}"; fi
