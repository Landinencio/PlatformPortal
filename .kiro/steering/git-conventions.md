# Git Conventions — Platform Portal

## Branch Naming

Format: `<type>/<TICKET>`

Regex: `^(main|master|develop|release\/.*|(feat|fix|hotfix|perf|refactor|chore|build|ci|docs|test)\/[A-Z]{2,10}-[0-9]+)$`

### Valid examples
- `feat/SRE-001`
- `fix/CRO-128`
- `refactor/MKP-55`
- `hotfix/CEX-77`

### Invalid examples
- `feat/OMS-342-add-login` (no description allowed)
- `feature/login` (missing ticket)
- `OMS-342` (missing type)

### Allowed types
| Type | Use |
|------|-----|
| feat | New functionality |
| fix | Bug fix |
| hotfix | Urgent production fix |
| perf | Performance improvement |
| refactor | Refactoring without functional changes |
| chore | Technical tasks or maintenance |
| build | Build or packaging changes |
| ci | CI/CD pipeline changes |
| docs | Documentation |
| test | Tests |

## Commit Messages

Format: `[TICKET] <type>: <description>`

Regex: `(\[[A-Z]{3,5}-[0-9]{1,9})\]\s(feat|fix|test|style|ci|refactor|docs|chore|perf|revert)!?:\s{1}([[:ascii:]]{2,70})`

### Valid examples
- `[SRE-001] feat: add lighthouse scanning to synthetics`
- `[CRO-128] fix: resolve null pointer in cart validation`
- `[MKP-2345] feat!: new http client (breaking change)`

### Rules
- Ticket ID in brackets at the start
- Type after the bracket
- `!` after type indicates breaking change (optional)
- Single space after colon
- Description: 2-70 ASCII characters
- No scope (simplified from conventional commits)

## Working Branch

Current working branch: `feat/SRE-001`

## Deployment

- Registry: `harbor.tooling.dp.iskaypet.com/tooling/platformportal`
- Build: `docker buildx build --platform linux/amd64 --load -t harbor.tooling.dp.iskaypet.com/tooling/platformportal:<tag> .`
- Push: `docker push harbor.tooling.dp.iskaypet.com/tooling/platformportal:<tag>`
- Deploy: `kubectl -n n8n set image deploy/n8n-webhooks n8n-webhooks=harbor.tooling.dp.iskaypet.com/tooling/platformportal:<tag>`
- Cluster: dp-tooling
- Context: `arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling`
- Namespace: `n8n`
- Deployment: `n8n-webhooks` (2 replicas)
- Container name: `n8n-webhooks`
- Harbor login: Docker is already authenticated (no extra login needed)

## Infrastructure

- Database: PostgreSQL (internal service `platformportal-postgres-dev:5432` or external `aws.c65wqb8mcjpl.eu-west-1.rds.amazonaws.com:5432`)
- AWS profiles: `eks-tooling` (account 444455556666), `eks-dev`, `eks-uat`, `eks-prd`, `root-iskaypet` (600700800900)
- Azure tenant: `19e73cc9-78d1-4540-862c-5a89572ef80e`
- Portal URL: `https://portal.today.dev.tooling.dp.iskaypet.com`
- Domain handling: `@iskaypet.com` ↔ `@emefinpetcare.com` (same users, both domains valid)
