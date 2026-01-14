# Platform Portal

Frontend de autoservicio para el equipo de Platform Engineering de IskayPet. Permite a los desarrolladores crear repositorios, solicitar infraestructura, gestionar permisos y visualizar costos de cloud.

## Features

- **Create Repository** - Scaffold proyectos GitLab con integración Jira
- **Request Infrastructure** - Provisionar recursos AWS (S3, RDS, Lambda) via Terraform
- **Create IAM Role** - Solicitar roles IAM con permisos específicos
- **User Onboarding** - Solicitar acceso a aplicaciones (ArgoCD, SonarQube, AWS)
- **FinOps Cost Explorer** - Analizar gastos de cloud por cuenta o globalmente

## Stack Técnico

- **Framework**: Next.js 13 (App Router)
- **Lenguaje**: TypeScript
- **Estilos**: Tailwind CSS
- **Auth**: NextAuth.js con Azure AD
- **UI Components**: Radix UI + shadcn/ui

## Desarrollo Local

```bash
# Instalar dependencias
npm install

# Iniciar servidor de desarrollo
npm run dev
```

Abrir [http://localhost:3000](http://localhost:3000) en el navegador.

## Variables de Entorno

```bash
AZURE_AD_TENANT_ID=          # Azure AD Tenant ID
AZURE_AD_CLIENT_ID=          # Azure AD App Client ID
AZURE_AD_CLIENT_SECRET=      # Azure AD App Client Secret
NEXTAUTH_URL=                # URL de la aplicación
NEXTAUTH_SECRET=             # Secret para NextAuth
N8N_WEBHOOK_URL=             # URL webhook de n8n para crear repos
N8N_ONBOARDING_WEBHOOK=      # URL webhook de n8n para onboarding
N8N_FINOPS_WEBHOOK=          # URL webhook de n8n para FinOps
GRAFANA_STACK_URL=           # URL de Grafana Cloud
GRAFANA_TOKEN=               # Token de servicio de Grafana
```

## Build y Deploy

```bash
# Build de producción
npm run build

# Build Docker
docker build -t n8n-portal .
```

El pipeline de CI/CD (`.gitlab-ci.yml`) construye y sube automáticamente la imagen a ECR cuando se hace merge a main.

## Arquitectura

```
src/
├── app/              # App Router pages
│   ├── api/          # API routes (NextAuth)
│   ├── create-repo/  # Crear repositorio
│   ├── create-infra/ # Solicitar infraestructura
│   ├── finops/       # Dashboard FinOps
│   ├── user-onboarding/ # Onboarding usuarios
│   └── page.tsx      # Home / Dashboard
├── components/       # Componentes React
│   ├── ui/           # Componentes base (shadcn)
│   └── *.tsx         # Componentes de negocio
└── lib/              # Utilidades
```

## Deployment

La aplicación se despliega en Kubernetes via Helmfile. La configuración Helm está en:
- [`kube-stack/environments/tooling/applications/n8n-webhooks/`](https://gitlab.com/iskaypetcom/digital/platform-engineering/eks/kube-stack)
