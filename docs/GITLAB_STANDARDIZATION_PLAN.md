# Plan de Estandarización GitLab — Iskaypet

> Documento generado a partir de la auditoría de métricas del portal de ingeniería (Abril 2026).
> Objetivo: mejorar la calidad de los datos DORA y de gestión de personas estandarizando las prácticas en GitLab.

---

## Contexto

El portal de ingeniería recopila métricas DORA (Deployment Frequency, Lead Time, Change Failure Rate, Pipeline Recovery Time) y métricas de gestión de personas (MRs, reviews, commits, líneas de código) a partir de la API de GitLab y webhooks.

Actualmente, la falta de estandarización en los ~960 repositorios distribuidos en 8 grupos (Digital, Retail, Helios, Backoffice, DataBI, SRE-Infra, EducaPet-IT, Friendly Companies) obliga al portal a usar heurísticas complejas para detectar deployments a producción, clasificar hotfixes, resolver identidades de desarrolladores y calcular lead times.

Este documento propone un conjunto de mejoras ordenadas por prioridad e impacto.

---

## 1. CI/CD Templates Compartidos (Prioridad: ALTA)

### Problema

Cada equipo define su pipeline de forma independiente. Los nombres de stages, jobs y environments varían entre repositorios. Esto dificulta la detección automática de deployments a producción.

Ejemplos de variaciones actuales:
- **Deploy jobs**: `deploy_prod`, `deploy-production`, `deploy_artifact`, `deploy-artifact`, `deploy_prd`, `deploy-prd`
- **Environments**: `production`, `prod`, `customers-pro`, `data-pro`, `eks-pro`, `product-pro`, `mkp-prod`

### Estado actual

Ya existe el repositorio `gitlab-ci-toolkit` con templates CI/CD compartidos:
- `CD/deploy.yml` — Deploy estándar (digital)
- `CD/deploy-dep.yml` — Deploy por departamento
- `CD/deploy-proj.yml` — Deploy por proyecto
- `CD/deploy-ret.yml` — Deploy retail
- `CD/deploy-multibrand.yml` — Deploy multimarca (kiwoko/tiendanimal/animalis)
- `CI/` — Templates de build, sonar, testing por tecnología

**Problema detectado**: Ninguno de los templates de deploy tenía `environment:` declarado en los jobs. Sin esto, GitLab no registra deployments en su sistema de environments.

### Corrección aplicada

Se ha añadido `environment:` a los 5 templates de deploy:
- `deploy_dev` → `environment: { name: development }`
- `deploy_uat` → `environment: { name: staging }`
- `deploy_prod` → `environment: { name: production }`

### Impacto

- GitLab registrará deployments con environment estandarizado
- Los webhooks de deployment incluirán `environment: "production"` 
- El portal puede simplificar la detección a `environment = 'production'`
- Se activa el dashboard de environments en cada proyecto de GitLab
- Se pueden configurar protecciones por environment (approvals, variables protegidas)

### Trabajo pendiente

| Tarea | Esfuerzo |
|-------|----------|
| Push de los cambios al repo gitlab-ci-toolkit | Inmediato |
| Verificar que los repos que usan `include:` recogen el cambio | 1 día |
| Repos que NO usan el toolkit: añadir `environment:` manualmente o migrar al toolkit | 2-3 días |

---

## 2. Environments Estandarizados (Prioridad: ALTA)

### Problema

Los environments en GitLab no están estandarizados. Se han detectado al menos 11 nombres distintos en los webhooks recientes:

| Environment | Tipo real |
|-------------|-----------|
| `production` | Producción ✅ |
| `prod` | Producción ✅ |
| `customers-pro` | Producción ✅ (no detectado por el portal hasta la corrección) |
| `data-pro` | Producción ✅ (no detectado) |
| `eks-pro` | Producción ✅ (no detectado) |
| `product-pro` | Producción ✅ |
| `product-dev` | Desarrollo ❌ (detectado como producción por contener "prod") |
| `mkp-prod` | Producción ✅ |
| `customers-dev` | Desarrollo |
| `customers-uat` | UAT |
| `staging` | Staging |

### Propuesta

Definir 3 environments estándar a nivel de grupo:

| Environment | Uso |
|-------------|-----|
| `production` | Entorno de producción real |
| `staging` | Pre-producción / UAT |
| `development` | Desarrollo / integración |

Los environments en GitLab se declaran en el `.gitlab-ci.yml` dentro del job:

```yaml
deploy_prod:
  stage: deploy_production
  environment:
    name: production
    url: https://app.iskaypet.com
  script:
    - ./deploy.sh
```

Sí, los environments se asocian directamente a jobs/stages del pipeline. Cuando un job con `environment: production` se ejecuta con éxito, GitLab registra un deployment en ese environment. Esto es lo que el portal lee via API y webhooks.

### Beneficios

- El portal puede filtrar por `environment = 'production'` sin heurísticas
- GitLab muestra un dashboard de environments por proyecto con historial de deploys
- Se pueden configurar protecciones por environment (approvals, variables protegidas)
- Los webhooks de deployment incluyen el environment, permitiendo detección en tiempo real

### Trabajo estimado

Se resuelve con el punto 1 (CI/CD templates). Los templates ya han sido actualizados con `environment:` estandarizado. Los repos que usan `include:` del toolkit recogerán el cambio automáticamente en su próximo pipeline.

---

## 3. Branch Naming Convention (Prioridad: MEDIA-ALTA)

### Problema

No hay convención uniforme de nombres de rama. Se han detectado:
- `fix/`, `hotfix/`, `bugfix/` — usados indistintamente
- `feat/`, `feature/` — variantes
- `revert/`, `rollback/` — variantes

El portal clasifica deploys como hotfix/rollback basándose en el prefijo de la rama de la MR. Si un equipo usa `fix/` para bugs normales, se inflan los hotfixes.

### Propuesta

| Prefijo | Uso | Clasificación DORA |
|---------|-----|-------------------|
| `feature/` o `feat/` | Nueva funcionalidad | Feature |
| `fix/` o `bugfix/` | Corrección de bug (no urgente) | Feature |
| `hotfix/` | Corrección urgente en producción | Hotfix |
| `revert/` o `rollback/` | Reversión de cambio | Rollback |
| `release/` | Rama de release | Feature |
| `chore/` | Mantenimiento, refactor | Feature |

### Implementación

Aplicar push rules a nivel de grupo con regex:

```
^(feature|feat|fix|bugfix|hotfix|revert|rollback|release|chore)\/[a-z0-9._-]+$|^main$|^master$|^develop$
```

Ya existen scripts para esto:
- `ops/apply-branch-push-rules.sh` — Aplica regex de branch a todos los proyectos
- `ops/apply-template-push-rules.sh` — Aplica push rules de template

### Trabajo estimado

| Tarea | Esfuerzo |
|-------|----------|
| Definir regex final y validar con equipos | 0.5 días |
| Aplicar push rules via script existente | 0.5 días |
| Comunicar a equipos y documentar | 0.5 días |

---

## 4. Merge Request Approvals (Prioridad: MEDIA)

### Problema

Muchos MRs se mergean sin review formal. En los últimos 30 días solo se han registrado 29 reviews (todas via webhook, los últimos 3 días). Esto afecta:
- La métrica de "Review Time" (no hay datos suficientes)
- La calidad del código (sin peer review)
- El ranking de contribuidores (reviewsGiven siempre 0 para la mayoría)

### Propuesta

Configurar a nivel de grupo de GitLab:

| Setting | Valor |
|---------|-------|
| Approvals required | 1 mínimo |
| Author cannot approve | Sí |
| Prevent push to protected branches | Sí |
| Merge method | Merge commit (o squash) |
| Delete source branch on merge | Sí |

### Implementación

Se puede configurar via API de GitLab a nivel de grupo:

```bash
curl -X PUT "https://gitlab.com/api/v4/groups/66335040" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "default_branch_protection": 2,
    "merge_requests_template": "## Descripción\n\n## Checklist\n- [ ] Tests\n- [ ] Review"
  }'
```

Y para approvals a nivel de proyecto (se puede scriptear para todos):

```bash
curl -X POST "https://gitlab.com/api/v4/projects/$PROJECT_ID/approval_rules" \
  -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name": "Default", "approvals_required": 1}'
```

### Trabajo estimado

| Tarea | Esfuerzo |
|-------|----------|
| Script para aplicar approval rules a todos los proyectos | 1 día |
| Configurar protección de ramas a nivel de grupo | 0.5 días |
| Crear MR template estándar | 0.5 días |
| Comunicar a equipos | 0.5 días |

---

## 5. Labels Estándar (Prioridad: MEDIA)

### Problema

El portal busca labels `hotfix`, `incident`, `rollback`, `revert` en las MRs para clasificar deploys. Pero casi ninguna MR tiene labels, así que la clasificación depende exclusivamente del nombre de la rama.

### Propuesta

Crear labels a nivel del grupo raíz `iskaypetcom` (se heredan a todos los subgrupos y proyectos):

| Label | Color | Uso |
|-------|-------|-----|
| `hotfix` | 🔴 `#dc3545` | MR que arregla incidencia urgente en producción |
| `incident` | 🔴 `#dc3545` | Relacionado con un incidente |
| `rollback` | 🟠 `#fd7e14` | MR que revierte un cambio |
| `breaking-change` | 🟡 `#ffc107` | Cambio que rompe compatibilidad |
| `feature` | 🟢 `#28a745` | Nueva funcionalidad |
| `bugfix` | 🔵 `#007bff` | Corrección de bug (no urgente) |
| `tech-debt` | ⚪ `#6c757d` | Refactor / deuda técnica |

### Implementación

```bash
# Crear labels a nivel de grupo
for label in "hotfix:#dc3545" "incident:#dc3545" "rollback:#fd7e14" "breaking-change:#ffc107" "feature:#28a745" "bugfix:#007bff" "tech-debt:#6c757d"; do
  name="${label%%:*}"
  color="${label##*:}"
  curl -X POST "https://gitlab.com/api/v4/groups/66335040/labels" \
    -H "PRIVATE-TOKEN: $GITLAB_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"name\": \"$name\", \"color\": \"$color\"}"
done
```

### Trabajo estimado

| Tarea | Esfuerzo |
|-------|----------|
| Crear labels via API | 0.5 días |
| Documentar cuándo usar cada label | 0.5 días |
| Añadir labels al MR template | Incluido en punto 4 |

---

## 6. Identidad de Desarrolladores (Prioridad: MEDIA)

### Problema

- 100% de emails NULL en `gitlab_mr_analytics` (GitLab privacy)
- 30 desarrolladores con emails `@unknown.local` en `developer_activity_daily`
- 14 autores de MR mostraban email como nombre (corregido con `developer_name_map`)
- Typos en emails (ej: `iskatpet` en vez de `iskaypet`)

### Propuesta

1. **Automatizar actualización del name map**: Script que consulta la API de miembros de grupo y actualiza `developer_name_map` periódicamente.

2. **Pedir a los desarrolladores que configuren su email de commit**:
   ```bash
   git config --global user.email "nombre.apellido@iskaypet.com"
   ```
   Esto no afecta la privacidad de GitLab pero sí aparece en los commits.

3. **Push rule de email**: Forzar que los commits usen email corporativo:
   ```
   author_email_regex: "@(iskaypet\.com|ext\.iskaypet\.com|seidor\.(es|com)|viseo\.com)$"
   ```

### Implementación

Script de actualización automática del name map (ejecutar como CronJob semanal):

```javascript
// ops/update-name-map.js
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GROUP_ID = 66335040; // iskaypet root group

async function fetchAllMembers() {
  let page = 1;
  const members = [];
  while (true) {
    const res = await fetch(
      `https://gitlab.com/api/v4/groups/${GROUP_ID}/members/all?per_page=100&page=${page}`,
      { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } }
    );
    const data = await res.json();
    if (data.length === 0) break;
    members.push(...data);
    page++;
  }
  return members;
}

// Upsert into developer_name_map
// ...
```

### Trabajo estimado

| Tarea | Esfuerzo |
|-------|----------|
| Script de actualización automática del name map | 1 día |
| CronJob semanal para ejecutarlo | 0.5 días |
| Push rule de email (opcional, puede ser restrictivo) | 0.5 días |
| Comunicar a equipos sobre configuración de email | 0.5 días |

---

## 7. Service Catalog (Prioridad: BAJA)

### Problema

El portal tiene un check de compliance que busca `service_catalog_linked`, `runtime_mapping_ok`, `sonar_linked`. La mayoría de proyectos no tienen estos metadatos, lo que baja el compliance score.

### Propuesta

Que cada repositorio con servicio desplegable tenga un fichero `.service.yml` en la raíz:

```yaml
# .service.yml
service:
  name: customers-api
  team: customers
  type: api                    # api | frontend | worker | library | infra
  production_environment: production
  sonar_project_key: iskaypet_customers-api
  runtime:
    cluster: eks-tooling
    namespace: customers
    deployment: customers-api
```

El portal puede leer este fichero via API de GitLab y usarlo para:
- Mapear proyecto → servicio → runtime
- Auto-detectar el sonar project key
- Saber qué environment es producción para ese repo específico

### Trabajo estimado

| Tarea | Esfuerzo |
|-------|----------|
| Definir schema de `.service.yml` | 0.5 días |
| Script para generar fichero base en todos los repos | 1 día |
| Actualizar portal para leer `.service.yml` | 1-2 días |
| Comunicar a equipos | 0.5 días |

---

## 8. Commit Message Convention (Prioridad: BAJA)

### Problema

No hay convención de mensajes de commit. Esto dificulta la generación automática de changelogs y la clasificación de cambios.

### Propuesta

Adoptar Conventional Commits:

```
feat: add customer search endpoint
fix: resolve null pointer in order processing
hotfix: emergency fix for payment gateway timeout
chore: update dependencies
docs: add API documentation
```

### Implementación

Push rule a nivel de grupo:

```
commit_message_regex: "^(feat|fix|hotfix|chore|docs|refactor|test|ci|perf|revert)(\(.+\))?: .{3,}"
```

### Trabajo estimado

| Tarea | Esfuerzo |
|-------|----------|
| Definir convención y documentar | 0.5 días |
| Aplicar push rule (opcional, puede ser disruptivo) | 0.5 días |
| Comunicar a equipos | 0.5 días |

---

## Resumen de prioridades

| # | Mejora | Prioridad | Impacto en métricas | Esfuerzo |
|---|--------|-----------|---------------------|----------|
| 1 | CI/CD Templates compartidos | 🔴 Alta | Deployment Frequency, Lead Time, CFR | 5-7 días |
| 2 | Environments estandarizados | 🔴 Alta | Deployment detection | Incluido en #1 |
| 3 | Branch naming + push rules | 🟠 Media-Alta | Hotfix/Rollback classification | 1.5 días |
| 4 | MR Approvals | 🟡 Media | Review metrics, code quality | 2.5 días |
| 5 | Labels estándar | 🟡 Media | Deploy classification | 1 día |
| 6 | Identidad de desarrolladores | 🟡 Media | Contributor ranking, identity | 2.5 días |
| 7 | Service Catalog | 🟢 Baja | Compliance score | 3-4 días |
| 8 | Commit messages | 🟢 Baja | Changelog, clasificación | 1.5 días |

**Esfuerzo total estimado**: ~15-20 días de trabajo (no necesariamente consecutivos).

**Recomendación**: Empezar por #1 (CI/CD templates) ya que resuelve #2 automáticamente y tiene el mayor impacto. Luego #3 y #5 que son rápidos de aplicar con los scripts existentes. #4 y #6 en paralelo.

---

## Próximos pasos

1. Validar este plan con los tech leads de cada equipo
2. Crear el repo `ci-templates` con los templates base
3. Piloto con 2-3 repos del equipo Digital
4. Rollout progresivo al resto de grupos
5. Actualizar el portal para simplificar la detección una vez estandarizado
