# Platform Portal

Portal centralizado de autoservicio para Platform Engineering en IskayPet. Permite a los equipos crear repositorios, visualizar métricas de ingeniería, analizar costos cloud, gestionar automatizaciones y más.

## Documentación

Toda la documentación técnica y funcional está en [`docs/PORTAL_DOCUMENTATION.md`](docs/PORTAL_DOCUMENTATION.md).

## Stack

- Next.js 14 (App Router) · TypeScript · Tailwind CSS
- Auth: NextAuth.js + Azure AD
- UI: Radix UI + shadcn/ui
- DB: PostgreSQL
- i18n: es, en, fr, pt

## Desarrollo Local

```bash
npm install
npm run dev
```

## Variables de Entorno

Ver sección "Variables de Entorno" en [`docs/PORTAL_DOCUMENTATION.md`](docs/PORTAL_DOCUMENTATION.md).

## Build & Deploy

El despliegue es **CI/CD + GitOps** (sin `docker build` ni `kubectl set image` manuales):

1. Merge a `main` → pipeline GitLab (consume `gitlab-ci-toolkit/main-portal.yml`).
2. Build con Kaniko → Harbor (`tooling/platformportal` + imágenes auxiliares de cronjobs).
3. `deploy_dev` (automático) y `deploy_prod` (manual) escriben el tag de imagen en el
   repo GitOps `argocd/tooling` (`shared-apps/portal-{dev,prod}/values.yaml`).
4. ArgoCD sincroniza el cluster `dp-tooling`: dev en namespace `platformportal`,
   prod en namespace `n8n` (deployment `portal-prod`).

Secretos vía External Secrets Operator desde AWS Secrets Manager (`dp/tooling/portal_*`).
El chart Helm vive en [`.helm/`](.helm/) (umbrella sobre el `generic-chart` corporativo).

**Rollback**: revertir el commit del tag en `argocd/tooling`. NO usar `set image` (selfHeal lo revertiría).

Detalle completo del flujo, secretos, rollback y gotchas en
[`.kiro/steering/portal-architecture.md`](.kiro/steering/portal-architecture.md) (§1 y §20).

## Estructura del Proyecto

```
src/
├── app/           # Pages + API routes (App Router)
├── components/    # React components (ui/, metrics/, finops/, etc.)
├── lib/           # Business logic, clients, utilities
├── i18n/          # Translation files (es, en, fr, pt)
└── types/         # TypeScript types
.helm/             # Helm chart (umbrella over generic-chart): values.yaml (base)
                   #   + values-prod.yaml / values-dev.yaml (overrides por entorno)
ops/               # Operational scripts (backfill, snapshots) + k8s manifests + Dockerfiles auxiliares
docs/              # Documentación, data contracts, ficheros de referencia, presentaciones/
migrations/        # SQL migration files
.kiro/steering/    # Contexto canónico del portal (arquitectura, convenciones git) para Kiro
.kiro/specs/       # Specs de features (requirements / design / tasks)
```

> **Para nuevos colaboradores**: el contexto técnico canónico está en `.kiro/steering/portal-architecture.md`
> (truth source). Al clonar el repo, Kiro carga ese steering automáticamente.
