# Design — Notificación a Teams en cada deploy a producción (GitLab)

## Overview

Un compañero quiere un canal de Teams donde reciba un mensaje con toda la info posible **cada vez que hay un deploy a producción en GitLab** (org-wide). El intento previo con ArgoCD notifications generaba demasiado ruido (cada sync emite eventos). La solución: aprovechar el receptor de webhooks de GitLab que **ya existe** en el portal, detectar el deploy a prod desde el evento `pipeline`, y publicar una Adaptive Card a un webhook de Teams **dedicado**.

Objetivo del mensaje (lo que pidió el usuario):
- **Qué micro** se ha desplegado (nombre del proyecto/repo).
- **Cuándo** (timestamp del deploy).
- **Qué MR / pipeline** lo disparó (para saber qué se cambió en esa subida concreta): MR iid + título + autor, commit sha + mensaje, enlaces a GitLab.

Principio rector: **reutilizar lo que ya hay**. El portal ya recibe los eventos, ya detecta jobs de deploy a prod, y ya tiene un helper de Teams. Solo hay que (a) enganchar la notificación, (b) enriquecer con MR/commit, (c) deduplicar, (d) cablear un webhook dedicado vía ESO.

### No-objetivos
- No tocar el pipeline de DORA ni la detección basada en snapshot (sigue siendo la fuente de verdad de métricas).
- No notificar deploys de no-prod (dev/uat/staging).
- No reusar el webhook de SRE (`TEAMS_WEBHOOK_URL`) ni el de FinOps (`FINOPS_TEAMS_WEBHOOK_URL`): canal separado para no mezclar señales.
- No construir UI: es una integración server-side dentro del webhook receiver.
- **No enviar desde el entorno dev del portal**: la notificación se emite EXCLUSIVAMENTE desde `portal-prod`. Ver §"Gate prod-only".

## Architecture

```
GitLab (org iskaypetcom)
  │  Group/System webhook → evento "pipeline" (status=success, builds[] con job deploy_prod ok)
  ▼
POST /api/webhooks/gitlab  (ya existe; valida x-gitlab-token, rate-limit, guarda en webhook_events_raw)
  │  processEventAsync → processPipeline()
  ▼
notifyProdDeploy(payload)
  │
  ├─► DEPLOY_NOTIFY_ENABLED !== "true" (entorno dev) ──► return (gate prod-only)
  │
  ├─► detectProdDeploy(payload) == false ──► return (log-only, como hoy)
  │
  ├─► claimDeployNotification(pipelineId, projectId) == ya notificado ──► return (dedup)
  │
  ▼
buildDeployInfo(payload, gitlabClient)   (enriquece: MR, commit, autor, URLs)
  ▼
buildDeployCard(info)  →  sendTeamsCard(card, DEPLOY_TEAMS_WEBHOOK_URL)
  ▼
Teams (canal del compañero, vía Power Automate webhook)
```

Toda la lógica nueva vive en un módulo nuevo `src/lib/deploy-notify.ts` (puro + testeable), invocado desde `processPipeline()` en el route existente. El route NO crece en complejidad: una llamada `await notifyProdDeploy(payload).catch(...)`.

> **Por qué el gate prod-only es imprescindible (no basta el dedup)**: el portal corre en dos entornos (`portal-dev` en ns `platformportal`, `portal-prod` en ns `n8n`) y **cada uno tiene su propia base de datos**. La tabla `deploy_notifications` deduplica dentro de un mismo entorno (2 réplicas + reentregas de GitLab), pero NO entre dev y prod: si ambos recibieran el mismo evento `pipeline`, cada uno haría su propio claim en su BD y **ambos enviarían** → card duplicada. El gate `DEPLOY_NOTIFY_ENABLED` (solo `"true"` en prod) corta esto de raíz. Defensa en dos capas: gate de entorno + dedup intra-entorno.

## Components and Interfaces

### 1. `src/lib/deploy-notify.ts` (módulo nuevo)

Contiene la lógica pura de detección/shaping y la orquestación.

```ts
export interface DeployJob {
  name: string;
  stage: string;
  status: string;
  finished_at: string | null;
}

export interface ProdDeployDetection {
  isProdDeploy: boolean;
  job: DeployJob | null;   // el job de deploy a prod que tuvo éxito
}

/**
 * Pura. Devuelve si el payload de pipeline representa un deploy a prod EXITOSO.
 * Reglas:
 *  - object_attributes.status === "success"  (pipeline terminado ok)
 *  - existe al menos un build cuyo name/stage casa un patrón de deploy a prod
 *    Y ese build tiene status === "success".
 * Patrón canónico: DEPLOY_JOB_NAMES (env DORA_DEPLOY_JOB_NAMES o el default
 * compartido con dora-snapshot.ts: deploy_prod, deploy-production, deploy_artifact,
 * deploy-artifact, deploy_prd, deploy-prd, *_playstore_prod, *_appstore_prod,
 * playstore_prod, appstore_prod, distribute_prod).
 */
export function detectProdDeploy(payload: any): ProdDeployDetection;

export interface DeployInfo {
  projectName: string;        // extractProjectName(path) → "marketplace-products-api"
  projectPath: string;        // iskaypetcom/digital/marketplace/marketplace-products-api
  team: string;               // extractTeam(path)
  environment: string;        // del job o "production"
  deployedAt: string;         // ISO; del job.finished_at o now
  jobName: string;
  ref: string;                // rama/tag
  commitSha: string;
  commitShort: string;
  commitMessage: string;
  commitAuthor: string;
  pipelineId: number;
  pipelineUrl: string;        // payload.object_attributes.url o compuesto
  mr: { iid: number; title: string; author: string; url: string } | null;
  projectWebUrl: string;
}

/**
 * Enriquece el payload con MR/commit. Best-effort: si una llamada al API de
 * GitLab falla, rellena lo que pueda con lo que viene en el payload. Nunca lanza.
 * - MR: payload.merge_request si viene; si no, gitlabClient.getMergeRequestsForCommit(projectId, sha)[0].
 * - Commit: payload.commit (title/message/author) ya viene en el evento pipeline.
 */
export async function buildDeployInfo(payload: any, client?: GitLabLike): Promise<DeployInfo>;

/** Pura. Construye la Adaptive Card (reusa el formato de teams-notify). */
export function buildDeployCard(info: DeployInfo): Record<string, unknown>;

/**
 * Orquestador. Llamado desde processPipeline. (1) comprueba el gate prod-only,
 * (2) detecta, (3) deduplica (claim atómico en BD), (4) enriquece, (5) construye
 * y envía. Nunca lanza (best-effort). Devuelve un pequeño resultado para
 * logging/tests: { sent, reason }.
 */
export async function notifyProdDeploy(
  payload: any,
  deps?: Partial<DeployNotifyDeps>,
): Promise<{ sent: boolean; reason: string }>;
```

`DeployNotifyDeps` (inyección para tests): `{ enabled, detect, claim, sendCard, getMrForCommit, webhookUrl }`. En producción se invoca `notifyProdDeploy(payload)` sin deps y resuelve todo desde `process.env` + `gitlabClient` + `pool`.

### Gate prod-only

Primer chequeo de `notifyProdDeploy`, antes de cualquier otra cosa:

```ts
const enabled = (deps?.enabled ?? process.env.DEPLOY_NOTIFY_ENABLED) === "true";
if (!enabled) return { sent: false, reason: "disabled" };
```

- `DEPLOY_NOTIFY_ENABLED` se define **solo en `values-prod.yaml`** (`configMap.DEPLOY_NOTIFY_ENABLED: "true"`). El entorno dev no la pone (o la pone a `"false"`), así que `portal-dev` nunca envía aunque reciba el evento.
- Es la primera línea de defensa contra el duplicado cross-entorno (ver nota en Architecture). El dedup en BD es la segunda capa (intra-entorno).
- Coherente con el patrón ya usado para `cronjobs.enabled: true` (solo prod).

### 2. Dedup — claim atómico en BD

Los eventos `pipeline` de GitLab se disparan **varias veces** (por cada cambio de estado: pending→running→success, y a veces reentregas). Necesitamos notificar **exactamente una vez por (pipeline, proyecto)**.

Migración nueva `migrations/2026-06-10_deploy_notifications.sql`:

```sql
CREATE TABLE IF NOT EXISTS deploy_notifications (
  pipeline_id   BIGINT NOT NULL,
  project_id    BIGINT NOT NULL,
  project_path  TEXT,
  notified_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (pipeline_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_deploy_notifications_notified_at
  ON deploy_notifications(notified_at);
```

Claim atómico (gana el primero, el resto no notifica):

```sql
INSERT INTO deploy_notifications (pipeline_id, project_id, project_path)
VALUES ($1, $2, $3)
ON CONFLICT (pipeline_id, project_id) DO NOTHING
RETURNING pipeline_id;
```

Si `rowCount === 0` → ya estaba notificado → `notifyProdDeploy` retorna `{ sent:false, reason:"already-notified" }`. El claim se hace **antes** de enviar para evitar carreras entre las 2 réplicas del portal; si el envío falla después, se acepta no reintentar (un deploy perdido es preferible a spam; el log lo registra). Alternativa considerada y descartada: claim después de enviar (riesgo de doble envío en carrera).

Retención: opcional cron de limpieza (>90 días). No crítico; la tabla crece ~nº deploys/día.

### 3. Integración en `processPipeline()` (route existente)

Cambio mínimo, al final de la función (mantiene el log-only actual para auditoría):

```ts
// Notificación a Teams de deploy a prod (best-effort, dedup en BD).
// NO afecta a DORA (que sigue calculándose por snapshot).
notifyProdDeploy(payload).catch((err) =>
  console.error(`[webhook:pipeline] #${eventId} notifyProdDeploy failed:`, err)
);
```

Se lanza fire-and-forget (no bloquea el procesamiento del evento ni la respuesta a GitLab). `notifyProdDeploy` ya es "never throws", el `.catch` es defensa en profundidad.

### 4. Adaptive Card

Reutiliza el contentType/estructura de `teams-notify.ts` (no se añade dependencia). Contenido:

- **Título**: `🚀 Deploy a producción — {projectName}`
- **Summary markdown**: `**{team}** desplegó **{projectName}** a producción`
- **FactSet**:
  - Microservicio: `{projectName}`
  - Entorno: `{environment}`
  - Cuándo: `{deployedAt}` (formato local Europe/Madrid)
  - Rama/Tag: `{ref}`
  - Commit: `{commitShort} — {commitMessage}` (truncado)
  - Autor: `{commitAuthor}`
  - MR: `!{mr.iid} — {mr.title}` (si hay MR)
  - Pipeline: `#{pipelineId}`
- **Acciones (Action.OpenUrl)**:
  - "Ver MR" → `mr.url` (si hay)
  - "Ver pipeline" → `pipelineUrl`
  - "Ver proyecto" → `projectWebUrl`

Se puede construir con `buildDigestCard` (ya existe) o con un builder propio si necesitamos varios botones (el digest solo soporta uno). **Decisión**: builder propio `buildDeployCard` para soportar múltiples `Action.OpenUrl` (MR + pipeline + proyecto), reusando exactamente el wrapper `{ type:"message", attachments:[{contentType, content}] }`.

### 5. Secreto del webhook de Teams (dedicado)

Nuevo env `DEPLOY_TEAMS_WEBHOOK_URL`. Canal separado del de SRE/FinOps.

Tres capas (mismo patrón que `FINOPS_TEAMS_WEBHOOK_URL`):

1. **AWS Secrets Manager** (cuenta tooling): añadir propiedad `deploy_webhook` al secreto existente `dp/tooling/portal_teams` (ya tiene `sre_webhook` y `finops_webhook`). Vía Terraform en `shared-general` (`iac/global/secretsmanager.tf` + `variables.tf` + CI var `TF_VAR_portal_teams_deploy_webhook`).
2. **ESO** — añadir entrada en `secret_manager.resources` de `.helm/values.yaml`:
   ```yaml
   - variable_name: DEPLOY_TEAMS_WEBHOOK_URL
     sm_name: dp/tooling/portal_teams
     property: deploy_webhook
   ```
3. **Env var** materializada en el secret `portal-env` (envFrom) → disponible en `process.env.DEPLOY_TEAMS_WEBHOOK_URL`.

> El valor del webhook (Power Automate URL) lo suministra el operador en Secrets Manager. El `sig` que pasó el usuario hay que **verificarlo exacto** antes de guardarlo (puede venir truncado en el chat). No se hardcodea en código en ningún caso.

Degradación: si `DEPLOY_TEAMS_WEBHOOK_URL` no está, `notifyProdDeploy` retorna `{ sent:false, reason:"no-webhook" }` con un `console.warn` (igual que el resto de senders). El portal sigue funcionando.

### 5b. Activación prod-only (`values-prod.yaml`)

Además del secreto, el gate `DEPLOY_NOTIFY_ENABLED` se activa SOLO en prod, en el `configMap` override:

```yaml
# values-prod.yaml
generic-chart:
  configMap:
    DEPLOY_NOTIFY_ENABLED: "true"
```

El base `values.yaml` puede dejarla sin definir o explícita a `"false"` para dejar claro el default. `values-dev.yaml` NO la activa. Así `portal-dev` nunca emite la notificación.

### 6. Configuración del webhook en GitLab (operativa, no código)

Para que lleguen los eventos `pipeline` org-wide hay dos opciones:
- **Group webhook** en el grupo raíz `iskaypetcom` con trigger "Pipeline events" + el secret token (`GITLAB_WEBHOOK_SECRET`). Cubre todos los subgrupos/proyectos.
- **System hook** (requiere admin de instancia; en gitlab.com SaaS no aplica) → se usa Group webhook.

Tarea de verificación: confirmar que el group webhook de `iskaypetcom` ya está configurado (el portal ya recibe `push`/`merge_request`/`note` para DORA, así que el hook existe; hay que asegurar que **"Pipeline events"** está marcado). Si no, añadirlo en la config del group webhook.

## Data Models

Nueva tabla `deploy_notifications` (ver §2). Reutiliza `webhook_events_raw` (sin cambios) para la auditoría del evento crudo.

`DeployInfo` y `DeployJob` son tipos en memoria (no persisten).

## Error Handling

- `notifyProdDeploy` **nunca lanza** (contrato best-effort, igual que `sendTeamsCard` y el digest). Acumula el motivo en el valor de retorno para logging/tests.
- Enriquecimiento (MR/commit) best-effort: fallo de API GitLab → se usa lo que viene en el payload; nunca aborta el envío.
- Claim de dedup: si la query falla (BD caída), se decide **no enviar** (evita spam si no podemos garantizar unicidad) y se loguea. Alternativa (enviar igualmente) descartada por riesgo de duplicados entre réplicas.
- Envío Teams: `sendTeamsCard` ya captura errores y devuelve `false`; se loguea.
- El fire-and-forget en el route lleva `.catch` defensivo.

## Testing Strategy

Tests unitarios (node:test, estilo del repo) en `src/lib/__tests__/deploy-notify.test.ts`, todos sobre las funciones puras + orquestador con deps inyectadas:

- **detectProdDeploy**:
  - pipeline success + build `deploy_prod` success → `isProdDeploy:true`.
  - pipeline success pero sin build de deploy → false.
  - build de deploy presente pero `status:"failed"` → false.
  - build `deploy-dev`/`deploy_uat` → false (no casa patrón prod).
  - stages móviles (`android_playstore_prod`) → true.
- **buildDeployInfo**:
  - usa `payload.merge_request` cuando viene.
  - cae a `getMrForCommit` cuando no viene MR.
  - rellena commit desde `payload.commit`.
  - no lanza si el enriquecimiento falla (mock que rechaza).
- **buildDeployCard**:
  - incluye todos los facts esperados; acciones presentes solo cuando hay URLs.
  - estructura `{type:"message",attachments:[...]}` correcta.
- **notifyProdDeploy** (deps inyectadas):
  - `enabled:false` (entorno dev / gate off) → `{sent:false, reason:"disabled"}`, no detecta ni envía.
  - no-prod → `{sent:false, reason:"not-prod-deploy"}`, no llama sendCard.
  - claim devuelve "ya notificado" → `{sent:false, reason:"already-notified"}`, no envía.
  - sin webhook → `{sent:false, reason:"no-webhook"}`.
  - happy path → `sent:true`, llama sendCard una vez con la card correcta.
  - dos invocaciones concurrentes con el mismo claim → solo una envía (mock de claim que devuelve true la 1ª y false la 2ª).

## Despliegue

Flujo GitOps estándar (igual que el resto del portal):
1. Migración BD aplicada (la corre el portal vía `runMigrations` al arrancar, o manual).
2. Secreto `deploy_webhook` en Secrets Manager (Terraform shared-general) + ESO entry en `.helm/values.yaml`.
3. Código en `feat/SRE-001` → merge a `main` → CI build Harbor → tag en `argocd/tooling` → ArgoCD sync.
4. Verificación: forzar un deploy a prod de prueba (o esperar uno real) y confirmar la card en el canal.
5. Actualizar steering `portal-architecture.md` (§4 Teams / nueva sección de notificación de deploys) y env vars (§8).

## Decisiones clave (resumen)

| Decisión | Elección | Por qué |
|----------|----------|---------|
| Trigger | evento `pipeline` (success + deploy job ok) | Es donde está el contexto completo (MR/commit/pipeline). Más fiable que `deployment` para "qué cambió". |
| Dedup | tabla `deploy_notifications` con claim atómico ON CONFLICT | Las 2 réplicas + reentregas de GitLab exigen unicidad fuerte (intra-entorno). |
| Envío solo desde prod | gate `DEPLOY_NOTIFY_ENABLED="true"` solo en `values-prod.yaml` | dev y prod tienen BD separadas → el dedup no cruza entornos. Sin el gate, ambos entornos enviarían la misma card. |
| Webhook Teams | nuevo `DEPLOY_TEAMS_WEBHOOK_URL` vía ESO | Canal separado; no mezclar con SRE/FinOps; nunca hardcodear. |
| Detección prod | reusar `DORA_DEPLOY_JOB_NAMES` | Una sola fuente de verdad de "qué es un deploy a prod". |
| Ubicación lógica | módulo nuevo `deploy-notify.ts` | Route receiver se mantiene fino; lógica pura testeable. |
| Best-effort | nunca lanza, dedup-before-send | Coherente con el contrato del digest; preferimos perder un aviso a duplicar/spamear. |
