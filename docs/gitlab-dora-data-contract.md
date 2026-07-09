# GitLab Data Contract for DORA Metrics

This document defines how teams must work in GitLab if they want the portal to classify deployments correctly and produce reliable DORA metrics.

Without a shared operating contract, the portal can only infer part of what happened.

## What the portal reads today

The current collector reads:

- GitLab Deployments API for production deployments
- GitLab pipeline jobs as fallback for deploy events
- Merge Requests linked to the deployed commit
- Commits inside the associated Merge Request

The collector classifies and calculates:

- deployment frequency
- unique commits deployed
- hotfixes
- rollbacks
- lead time from deployed commit
- lead time from first commit in the MR
- lead time from MR creation
- change failure rate based on failed deploy jobs
- MTTR based on failed job or pipeline followed by recovery

## Minimum rules teams must follow

### 1. Deploy to a production environment with a stable name

The portal only counts deployments whose environment matches one of these names:

- `production`
- `prod`

If your project uses a different production environment name, the portal will not count it unless the collector config is updated.

Recommended naming:

- `production`
- `prod-eu`
- `production-es`

Bad examples:

- `live`
- `main-env`
- `cluster-a`

Rule:

- the environment name must include `prod` or `production`

### 2. Use standard deploy job names

When the Deployments API is missing or incomplete, the collector falls back to deploy jobs.

Current accepted job names:

- `deploy_prod`
- `deploy-production`

Rule:

- keep deploy jobs under a predictable name containing `deploy` and `prod`

Recommended examples:

- `deploy_prod`
- `deploy_production`
- `deploy-prod-eu`

### 3. Ship changes through Merge Requests

If teams bypass Merge Requests and push directly to the deployed branch:

- review metrics degrade
- traceability weakens
- first commit lead time becomes unreliable

Rule:

- every production change should go through an MR whenever possible

Recommended:

- one logical change per MR
- avoid mixing unrelated fixes and features in one MR
- keep MR branch lifetime bounded

### 4. Use explicit hotfix branches or labels

The portal detects hotfixes from branch names or labels.

Current accepted branch prefixes:

- `hotfix/`
- `hotfix-`
- `fix/`
- `bugfix/`

Current accepted labels:

- `hotfix`
- `bug`
- `incident`

Rule:

- urgent production fixes must use at least one of:
  - hotfix branch prefix
  - hotfix label

Recommended examples:

- branch: `hotfix/cart-timeout`
- branch: `bugfix/payment-retry`
- labels: `hotfix`, `incident`

### 5. Use explicit rollback branches or labels

The portal now tries to detect rollbacks from deployment history, but teams should still mark them explicitly.

Current accepted branch prefixes:

- `rollback/`
- `revert/`

Current accepted labels:

- `rollback`
- `revert`

Rule:

- intentional rollback changes must use at least one of:
  - rollback branch prefix
  - rollback label

Recommended examples:

- branch: `rollback/cart-service-2026-03-03`
- branch: `revert/payment-patch`
- labels: `rollback`

### 6. Keep commit timestamps meaningful

Lead time calculations depend on commit dates inside the MR.

Avoid:

- rebasing large branches in a way that rewrites all commit timestamps right before merge
- force-pushing a single squash commit after days of hidden work if you want true development lead time

Preferred:

- keep the MR open while the change is being developed
- commit incrementally inside the MR branch

## How each practice impacts the metrics

### Deployment Frequency

Improves when:

- production deployments are registered under `prod` or `production`
- deploy jobs follow the expected naming

### Lead Time for Changes

Improves in accuracy when:

- the change has an MR
- the MR contains the real development commits
- the deployed commit is linked to that MR

The portal currently stores three variants:

- deployed commit -> deploy
- first MR commit -> deploy
- MR created -> deploy

### Change Failure Rate

Today it reflects:

- failed deploy jobs

It does not yet reflect:

- incidents in production without pipeline failure
- performance regressions without failing deployment automation

### MTTR

Today it reflects:

- time from failed job or pipeline to the next successful recovery in the same scope

It does not yet reflect:

- incident resolution based on incident management tools

## Team workflow examples

### Normal feature

1. Branch from main: `feat/OMS-342`
2. Open MR early
3. Push several commits to the MR
4. Merge MR
5. Deploy to `production`

Expected portal result:

- counted as deployment
- counted as feature
- lead time available from first commit, MR creation and deployed commit

### Hotfix

1. Branch from main: `hotfix/OMS-911`
2. Open MR
3. Add label `hotfix`
4. Merge and deploy to `prod`

Expected portal result:

- counted as deployment
- classified as hotfix
- lead time variants available

### Rollback

1. Branch from main: `fix/OPS-120`
2. Add label `rollback`
3. Revert the offending change
4. Merge and deploy to `production`

Expected portal result:

- counted as deployment
- classified as rollback

Nota:

- si el ADR de ramas obliga `^(feat|fix|hotfix|perf|refactor|chore|build|ci|docs|test)\/[A-Z]+-[0-9]+$`, no debemos depender de ramas `rollback/` para clasificar rollbacks
- para ese caso, la clasificación debe apoyarse en `label rollback`, `title` o en la detección por historial de commit ya desplegado

## Recommended admin configuration

If a team cannot follow the default nomenclature exactly, update the collector env vars instead of allowing free-form naming.

Relevant env vars:

- `DORA_PROD_ENVIRONMENTS`
- `DORA_DEPLOY_JOB_NAMES`
- `DORA_HOTFIX_BRANCH_PREFIXES`
- `DORA_HOTFIX_LABELS`
- `DORA_ROLLBACK_BRANCH_PREFIXES`
- `DORA_ROLLBACK_LABELS`

Example:

```env
DORA_PROD_ENVIRONMENTS=production,prod,live-prod
DORA_DEPLOY_JOB_NAMES=deploy_prod,deploy-production,release_prod
DORA_HOTFIX_BRANCH_PREFIXES=hotfix/,fix/,incident/
DORA_HOTFIX_LABELS=hotfix,incident,p1
DORA_ROLLBACK_BRANCH_PREFIXES=rollback/,revert/
DORA_ROLLBACK_LABELS=rollback,revert
```

## Current limitations teams should know

Even following this contract, the portal still does not infer all real-world outcomes.

Not covered yet:

- performance degradation without failed pipeline
- incidents without GitLab deployment failure
- automatic distinction between infra failure and app failure
- full many-commits-to-one-deploy lineage outside the MR boundary

Those will require integration with incidents, monitoring and richer deployment lineage.
