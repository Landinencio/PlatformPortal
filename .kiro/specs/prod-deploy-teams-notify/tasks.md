# Implementation Plan — Notificación a Teams en cada deploy a producción

## Overview

Plan de implementación de la notificación a un canal de Teams dedicado en cada deploy a producción de GitLab. Se reutiliza el receptor de webhooks existente (`/api/webhooks/gitlab`) y el helper de Teams (`teams-notify.ts`); la lógica nueva vive en un módulo puro y testeable (`src/lib/deploy-notify.ts`). El envío es prod-only (gate `DEPLOY_NOTIFY_ENABLED`) con deduplicación atómica en BD como segunda capa. Despliegue por el flujo GitOps estándar del portal.

## Task Dependency Graph

```
1 (migración)
2 (detector) ─┐
3 (enrich)  ──┤
4 (card)    ──┤
              ├─► 5 (orquestador) ─► 6 (hook en route) ─┐
1 ────────────┘                                          │
2,3,4,5 ──────────────────────────► 7 (tests) ──────────┤
                                                         ├─► 11 (build + GitOps + verificación) ─► 12 (steering)
8 (ESO + TF secreto) ────────────────────────────────────┤
9 (gate values-prod) ────────────────────────────────────┤
10 (group webhook GitLab) ───────────────────────────────┘
```

- Núcleo de código: 2, 3, 4 → 5 → 6 (secuencial en el orquestador; 2/3/4 paralelizables).
- Infra/config: 1, 8, 9, 10 independientes entre sí y del núcleo de código.
- 7 (tests) depende de 2–5. 11 integra todo. 12 cierra documentación.

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "2", "3", "4", "8", "9", "10"], "dependsOn": [] },
    { "wave": 2, "tasks": ["5"], "dependsOn": ["1", "2", "3", "4"] },
    { "wave": 3, "tasks": ["6", "7"], "dependsOn": ["5"] },
    { "wave": 4, "tasks": ["11"], "dependsOn": ["6", "7", "8", "9", "10"] },
    { "wave": 5, "tasks": ["12"], "dependsOn": ["11"] }
  ]
}
```

## Tasks

- [x] 1. Crear la migración de la tabla de deduplicación
  - Crear `migrations/2026-06-10_deploy_notifications.sql` con la tabla `deploy_notifications` (`pipeline_id BIGINT`, `project_id BIGINT`, `project_path TEXT`, `notified_at TIMESTAMPTZ DEFAULT NOW()`, PK compuesta `(pipeline_id, project_id)`) e índice por `notified_at`.
  - Usar `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` (idempotente, coherente con el resto de migraciones).
  - _Requirements: 3.1, 3.5, 3.7_

- [x] 2. Implementar el detector puro de deploy a producción
  - En `src/lib/deploy-notify.ts`, definir los tipos `DeployJob` y `ProdDeployDetection` y la función pura `detectProdDeploy(payload)`.
  - Leer `DEPLOY_JOB_NAMES` de `process.env.DORA_DEPLOY_JOB_NAMES` (split por coma, trim, filtrado) con el default canónico compartido con `dora-snapshot.ts`.
  - Matching por subcadena case-insensitive contra `build.name` y `build.stage`; devolver el primer build coincidente con `status === "success"` solo si `object_attributes.status === "success"`.
  - Manejar casos límite sin lanzar: `object_attributes` ausente, `builds` ausente/no-array/vacío, `name`/`stage` nulos.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

- [x] 3. Implementar el enriquecedor `buildDeployInfo` (best-effort)
  - En `src/lib/deploy-notify.ts`, definir el tipo `DeployInfo` y la función `buildDeployInfo(payload, client?)`.
  - Reusar helpers de extracción (`extractProjectName`, `extractTeam`) — moverlos a un sitio compartido o replicar localmente para no acoplar al route.
  - Poblar commit desde `payload.commit`; MR desde `payload.merge_request` si viene, si no via `client.getMergeRequestsForCommit(projectId, sha)[0]`.
  - Capturar cualquier fallo de GitLab_Client y continuar con los datos del payload (nunca lanza). Derivar `pipelineUrl`, `projectWebUrl`, `deployedAt`.
  - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

- [x] 4. Implementar el constructor puro de la Adaptive Card
  - En `src/lib/deploy-notify.ts`, función pura `buildDeployCard(info)` que devuelve el objeto `{ type:"message", attachments:[{ contentType, content }] }` (mismo formato que `teams-notify.ts`).
  - FactSet con: microservicio, entorno, cuándo (formato Europe/Madrid), ref, commit (corto + mensaje truncado), autor, MR (iid+título) si existe, pipeline id.
  - Acciones `Action.OpenUrl`: "Ver MR" (solo si hay URL de MR), "Ver pipeline", "Ver proyecto".
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5_

- [x] 5. Implementar el orquestador `notifyProdDeploy` con gate, dedup y envío
  - En `src/lib/deploy-notify.ts`, definir `DeployNotifyDeps` (`enabled`, `detect`, `claim`, `sendCard`, `getMrForCommit`, `webhookUrl`) y la función `notifyProdDeploy(payload, deps?)` que retorna `{ sent, reason }` y nunca lanza.
  - Orden: (1) gate `enabled !== "true"` → `{sent:false, reason:"disabled"}`; (2) `detectProdDeploy` false → `"not-prod-deploy"`; (3) claim atómico → `"already-notified"` / `"claim-error"`; (4) `buildDeployInfo` + `buildDeployCard`; (5) `webhookUrl` ausente → `"no-webhook"`; (6) `sendCard` → `true` o `"send-failed"`.
  - Implementar `claimDeployNotification(pipelineId, projectId, projectPath)` con el `INSERT ... ON CONFLICT DO NOTHING RETURNING` sobre `pool` (default dep), distinguiendo error de BD (`claim-error`) de "ya notificado" (`already-notified`).
  - Resolver defaults de producción desde `process.env` + `gitlabClient` + `pool` cuando no se inyectan deps.
  - _Requirements: 2.1, 2.2, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3_

- [x] 6. Enganchar la notificación en `processPipeline()` del webhook receiver
  - En `src/app/api/webhooks/gitlab/route.ts`, al final de `processPipeline()` (manteniendo el log-only actual), invocar `notifyProdDeploy(payload).catch((err) => console.error(...))` fire-and-forget.
  - Importar desde `@/lib/deploy-notify`. No bloquear el procesamiento ni la respuesta a GitLab.
  - _Requirements: 7.4_

- [x] 7. Tests unitarios del módulo
  - Crear `src/lib/__tests__/deploy-notify.test.ts` (node:test, estilo del repo) con deps inyectadas.
  - Cubrir: `detectProdDeploy` (todos los casos de R1 incluyendo límites), `buildDeployInfo` (MR del payload vs fallback vs fallo de API), `buildDeployCard` (facts + acciones condicionales + estructura), `notifyProdDeploy` (`disabled`, `not-prod-deploy`, `already-notified`, `claim-error`, `no-webhook`, `send-failed`, happy path, concurrencia 1ª envía / 2ª no).
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 7.1, 7.2, 7.3_

- [x] 8. Cablear el secreto del webhook dedicado (ESO + Terraform + CI)
  - Añadir entrada en `secret_manager.resources` de `.helm/values.yaml`: `DEPLOY_TEAMS_WEBHOOK_URL` → `dp/tooling/portal_teams` propiedad `deploy_webhook`.
  - En `shared-general` (`iac/global/`): añadir la propiedad `deploy_webhook` al secreto `dp/tooling/portal_teams` (variable TF `portal_teams_deploy_webhook`) + CI var `TF_VAR_portal_teams_deploy_webhook` (vía API GitLab, repo project id 45950137). Verificar el `sig` exacto del webhook de Power Automate antes de guardarlo.
  - _Requirements: 6.2, 6.3, 6.4, 8.3_

- [x] 9. Activar el gate prod-only en values-prod
  - Añadir `DEPLOY_NOTIFY_ENABLED: "true"` al `configMap` de `.helm/values-prod.yaml`. No tocar `values-dev.yaml`.
  - Opcional: documentar el default en `values.yaml` (sin definir = desactivado).
  - _Requirements: 2.1, 2.2, 2.3_

- [x] 10. Verificar configuración operativa del group webhook de GitLab
  - Confirmar que el group webhook de `iskaypetcom` tiene marcado el trigger "Pipeline events" y el secret token (`GITLAB_WEBHOOK_SECRET`) configurado. Si falta "Pipeline events", añadirlo.
  - _Requirements: 8.1, 8.2_

- [x] 11. Build, propagación GitOps y verificación end-to-end
  - `npm run build` + tests verdes. Migración aplicada (al arrancar el portal o manual).
  - Merge a `main` (commit `[SRE-001] feat: ...`) → CI build Harbor → tag en `argocd/tooling` → ArgoCD sync de `portal-prod`.
  - Verificar con un deploy a prod real (o forzado): llega exactamente una card al canal, con micro/MR/commit/pipeline/autor correctos.
  - _Requirements: 2.3, 6.1, 7.4_

- [x] 12. Actualizar el steering canónico
  - En `.kiro/steering/portal-architecture.md`: documentar la feature (§4 Teams o nueva subsección), la tabla `deploy_notifications` (§6), y las env vars `DEPLOY_TEAMS_WEBHOOK_URL` + `DEPLOY_NOTIFY_ENABLED` (§8). Nota del gate prod-only en gotchas (§10).
  - _Requirements: 2.3, 6.4_

## Notes

- **Best-effort**: `notifyProdDeploy` nunca lanza; el `.catch` en el route es defensa en profundidad.
- **Dos capas anti-duplicado**: gate `DEPLOY_NOTIFY_ENABLED` (cross-entorno, porque dev/prod tienen BD separadas) + dedup en BD (intra-entorno, 2 réplicas + reentregas de GitLab).
- **Nunca hardcodear** la URL del webhook; siempre vía ESO/env. No imprimir el valor en logs ni en chat.
- **Secret token GitLab**: el receptor ya valida `x-gitlab-token`; el group webhook debe llevarlo.
- **No tocar DORA**: la detección por snapshot sigue siendo la fuente de verdad de métricas; esto es solo notificación.
