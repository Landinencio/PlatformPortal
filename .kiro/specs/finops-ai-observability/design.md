# Design Document

> Feature: FinOps AI Observability

## Overview

Esta feature añade tres capacidades al Platform Portal, todas ancladas en patrones ya existentes:

1. **Histórico del coste de IA** — una tabla `ai_cost_daily` con upsert idempotente, alimentada por un cronjob diario que consulta el CUR (`athena-cur.ts`) y las licencias Kiro (`kiro-licenses.ts`), y una gráfica de tendencia en la pestaña Costes.
2. **Novedades AWS** — un módulo `aws-health.ts` que hace polling de una cola SQS (`portal-aws-health-events` en dp-tooling) alimentada vía EventBridge fan-in cross-account (`source: aws.health`), una tabla cache `aws_health_events`, y una sidebar admin-only en la home. **Sin coste de soporte** (verificado: root está en Basic Support; la Health API de pago no se usa).
3. **Daily FinOps Digest** — un cronjob a las 10:20 (Europe/Madrid) que reutiliza `finops-advisor-runner.ts` + las novedades AWS del día y publica en un webhook de Teams dedicado (`FINOPS_TEAMS_WEBHOOK_URL`).

Principios de diseño:
- **Reutilizar, no reinventar**: advisor async, role chain CUR/Identity Store, patrón snapshot (`finops_daily_context`), patrón cronjob→curl→endpoint interno (`x-internal-secret`), patrón notificación Teams (MessageCard).
- **Degradación elegante**: si el CUR/Health/Bedrock falla, cada pieza degrada sin romper la home ni el dashboard.
- **Seguridad por defecto**: endpoints internos con `requireInternalAuth`, endpoint admin con `requireUserAuth(request, "admin")` validado en servidor, secretos en `platformportal-secrets`, rol Health solo lectura.

### Mapa de componentes

```mermaid
flowchart TD
  subgraph Cronjobs[CronJobs n8n / dp-tooling]
    SC[ai-cost-snapshot\n02:00 diario]
    HC[aws-health-sync\ncada 15 min]
    DC[finops-daily-digest\n10:20 Europe/Madrid]
  end

  subgraph Portal[Platform Portal Next.js]
    EP1[POST /api/finops/ai-cost/snapshot\ninternal]
    EP2[GET /api/finops/ai-cost/history\nuser FinOps]
    EP3[POST /api/aws-health/sync\ninternal]
    EP4[GET /api/aws-health/news\nuser admin]
    EP5[POST /api/finops/daily-digest\ninternal]

    LIBA[lib/ai-cost-history.ts]
    LIBH[lib/aws-health.ts]
    LIBD[lib/finops-daily-digest.ts]
    ADV[lib/finops-advisor-runner.ts\n(existente)]
    CUR[lib/athena-cur.ts\n(existente)]
    KIRO[lib/kiro-licenses.ts\n(existente)]
    TEAMS[lib/teams-notify.ts\n(nuevo helper)]
  end

  subgraph DB[(PostgreSQL)]
    T1[ai_cost_daily]
    T2[aws_health_events]
  end

  subgraph AWS
    ATHENA[Athena CUR\nroot 600700800900]
    SQS[SQS portal-aws-health-events\ndp-tooling 444455556666]
    EB[EventBridge aws.health\nfan-in 22 cuentas]
    BEDROCK[Bedrock Sonnet 4]
  end

  SC --> EP1 --> LIBA --> CUR --> ATHENA
  LIBA --> KIRO --> ATHENA
  LIBA --> T1
  EP2 --> LIBA --> T1
  EB --> SQS
  HC --> EP3 --> LIBH --> SQS
  LIBH --> T2
  EP4 --> LIBH --> T2
  DC --> EP5 --> LIBD
  LIBD --> ADV --> BEDROCK
  LIBD --> LIBH --> T2
  LIBD --> TEAMS

  subgraph Home[Home page]
    NS[NewsSidebar admin-only] --> EP4
  end
  subgraph Costs[FinOps Costes tab]
    CH[AiCostHistoryCard] --> EP2
  end
```

## Architecture

### Role chain y permisos AWS

- **CUR / Kiro**: ya existente — portal IRSA `portal-inventory-irsa` → `AssumeRole Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur` (600700800900) → Athena. El histórico de IA reutiliza esto íntegro (sin nuevos permisos).
- **AWS Health vía EventBridge → SQS** (gratis, sin Health API): los eventos `aws.health` se emiten en EventBridge en cada cuenta aunque estén en Basic Support. Se hace fan-in cross-account hacia un bus central en dp-tooling y de ahí a una cola SQS que el portal consume con su IRSA.

**Verificación de plan de soporte (hecha):** en root (`600700800900`, admin) `aws support describe-severity-levels`, `aws health describe-health-service-status-for-organization` y `aws health describe-events` devuelven todas `SubscriptionRequiredException` → la org está en **Basic Support**, la Health API NO está disponible. Por eso se descarta la Health API y se usa EventBridge.

**Topología de ingesta (EventBridge fan-in):**

```
Cuenta N (×22)                         dp-tooling (444455556666)
┌──────────────────────────┐          ┌─────────────────────────────────┐
│ default event bus        │          │ custom bus: portal-aws-health   │
│  rule: source=aws.health │──put────▶│  rule: source=aws.health         │
│  target: dp-tooling bus  │  events  │  target: SQS portal-aws-health-  │
│  (cross-account, IAM)    │          │          events                  │
└──────────────────────────┘          └─────────────────────────────────┘
                                              │ poll (ReceiveMessage)
                                              ▼
                                       Portal (IRSA, eu-west-1)
```

Componentes a crear (en dp-tooling, cuenta del portal, eu-west-1):
- Custom EventBridge bus `portal-aws-health` con **resource policy** que permite `events:PutEvents` desde las 22 cuentas de la org (o `PrincipalOrgID` condicional para no enumerar).
- Regla en el bus `portal-aws-health` con pattern `{ "source": ["aws.health"] }` y target la cola SQS `portal-aws-health-events`.
- Cola SQS `portal-aws-health-events` (+ policy que permite a EventBridge `sqs:SendMessage`).
- En **cada cuenta de la org** (rollout idempotente): una regla en el `default` bus con pattern `{ "source": ["aws.health"] }` y target el ARN del bus `portal-aws-health` de dp-tooling, más el rol que EventBridge usa para el `PutEvents` cross-account.

Permisos que necesita el portal (añadir al rol IRSA `portal-inventory-irsa`, policy inline `AwsHealthQueueReader`):
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
    "Resource": "arn:aws:sqs:eu-west-1:444455556666:portal-aws-health-events"
  }]
}
```

> El rollout de las reglas EventBridge en las 22 cuentas se automatiza con `ops/apply-aws-health-eventbridge.sh` (mismo patrón que `ops/apply-infra-live-policy.sh`: itera perfiles AWS, idempotente con `put-rule`/`put-targets`).

### Patrón cronjob → endpoint interno

Idéntico a `infra-live-check-cronjob.yaml`: contenedor `curlimages/curl`, `INTERNAL_API_SECRET` desde `platformportal-secrets`, POST a `http://n8n-webhooks.n8n.svc.cluster.local:3000/...`. Tres CronJobs nuevos en `ops/k8s/`.

## Data Models

### Tabla `ai_cost_daily` (migración `2026-06-03_ai_cost_daily.sql`)

```sql
CREATE TABLE IF NOT EXISTS ai_cost_daily (
  id              SERIAL PRIMARY KEY,
  snapshot_date   DATE NOT NULL UNIQUE,
  kiro_cost       NUMERIC(12,2) NOT NULL DEFAULT 0,   -- coste licencias Kiro del día (neto)
  bedrock_cost    NUMERIC(12,2) NOT NULL DEFAULT 0,   -- coste inferencia Bedrock del día
  total_ai_cost   NUMERIC(12,2) NOT NULL DEFAULT 0,   -- kiro + bedrock
  kiro_by_plan    JSONB NOT NULL DEFAULT '[]',         -- [{ plan, users, cost }]
  bedrock_by_model JSONB NOT NULL DEFAULT '[]',        -- [{ model, account, accountName, cost }]
  by_account      JSONB NOT NULL DEFAULT '[]',         -- [{ accountId, accountName, kiroCost, bedrockCost, totalCost }]
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_cost_daily_date ON ai_cost_daily (snapshot_date DESC);
```

`snapshot_date UNIQUE` habilita el upsert idempotente (`ON CONFLICT (snapshot_date) DO UPDATE`). El filtro por cuentas en la UI se hace sobre `by_account` (JSONB), recomputando los totales en el endpoint de history para el subconjunto pedido.

### Tabla `aws_health_events` (migración `2026-06-03_aws_health_events.sql`)

```sql
CREATE TABLE IF NOT EXISTS aws_health_events (
  arn             TEXT PRIMARY KEY,           -- event ARN (estable de AWS Health)
  service         TEXT NOT NULL,
  region          TEXT,
  event_type_code TEXT,
  category        TEXT NOT NULL,              -- issue | scheduledChange | accountNotification
  status_code     TEXT NOT NULL,             -- open | upcoming | closed
  severity        TEXT NOT NULL DEFAULT 'low', -- alta | media | baja (inferida)
  start_time      TIMESTAMPTZ,
  end_time        TIMESTAMPTZ,
  last_updated    TIMESTAMPTZ,
  affected_accounts JSONB NOT NULL DEFAULT '[]', -- [{ accountId, accountName }]
  description     TEXT,
  raw             JSONB,                       -- payload normalizado completo
  first_seen      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_aws_health_status ON aws_health_events (status_code, last_updated DESC);
CREATE INDEX IF NOT EXISTS idx_aws_health_updated ON aws_health_events (last_updated DESC);
```

`arn` como PK permite upsert por evento (idempotente ante reentregas SQS at-least-once). `first_seen` distingue eventos nuevos (para "novedades de las últimas 24h" del digest). `synced_at` registra la última vez que se vio el evento en la cola.

## Components and Interfaces

### 1. `src/lib/ai-cost-history.ts` (nuevo)

```ts
export interface AiCostDay {
  date: string;            // YYYY-MM-DD
  kiroCost: number;
  bedrockCost: number;
  totalAiCost: number;
  byAccount: Array<{ accountId: string; accountName: string; kiroCost: number; bedrockCost: number; totalCost: number }>;
}

export interface AiCostHistory {
  days: AiCostDay[];
  anomalyDays: string[];   // fechas cuyo totalAiCost supera media + k*stddev
  totals: { kiro: number; bedrock: number; total: number };
}

/** Computa el coste de IA de un día (para el snapshot cronjob). */
export async function computeAiCostForDate(date: string): Promise<AiCostDay>;

/** Persiste (upsert) el AiCostDay en ai_cost_daily. */
export async function persistAiCostSnapshot(day: AiCostDay): Promise<void>;

/** Backfill de un rango usando el histórico del CUR. */
export async function backfillAiCost(startDate: string, endDate: string): Promise<{ persisted: number }>;

/** Lee ai_cost_daily para [startDate,endDate], filtrando por cuentas si se indica. */
export async function getAiCostHistory(startDate: string, endDate: string, accountIds?: string[]): Promise<AiCostHistory>;
```

Implementación de `computeAiCostForDate(date)`:
- **Kiro**: `fetchKiroSummary(date, date)` → `netCost`, `byPlan`, y desglose por cuenta a partir de `users[].account` agregando `cost`.
- **Bedrock**: query Athena acotada a un día sobre `line_item_resource_id LIKE 'arn:aws:bedrock:%'` agrupando por modelo (derivado del ARN) y cuenta. Se factoriza una función `fetchBedrockCostByDay(date, accountIds)` en `athena-cur.ts` reutilizando la conexión Athena existente (no recalcula todo el `CurFullSnapshot`).
- Combina ambos en `byAccount` y totales.

Detección de anomalías (cliente y digest): `mean + 2*stddev` sobre `totalAiCost` de la ventana; un día es anómalo si supera ese umbral y `totalAiCost > 1.5 * mean`. (Coherente con el pico de Data: ~700€ en un día sobre una media diaria de decenas).

### 2. `src/lib/aws-health.ts` (nuevo)

```ts
export interface AwsNewsItem {
  arn: string;             // event ARN del payload aws.health (estable). Fallback: hash(source+account+startTime+typeCode)
  service: string;
  region: string | null;
  category: "issue" | "scheduledChange" | "accountNotification";
  statusCode: "open" | "upcoming" | "closed";
  severity: "alta" | "media" | "baja";
  startTime: string | null;
  endTime: string | null;
  lastUpdated: string | null;
  affectedAccounts: Array<{ accountId: string; accountName: string }>;
  description: string;
}

/** Hace polling de la Health_Queue (SQS) y normaliza los eventos aws.health. */
export async function pollAwsHealthQueue(opts?: { maxMessages?: number }): Promise<AwsNewsItem[]>;

/** Upsert de eventos en aws_health_events (por arn) + borra de SQS los procesados. */
export async function syncAwsHealthEvents(): Promise<{ upserted: number; new: number }>;

/** Lee aws_health_events para la sidebar / digest. */
export async function getAwsNews(opts?: { includeClosed?: boolean; sinceHours?: number }): Promise<AwsNewsItem[]>;

export function normalizeHealthEvent(detail: any, accountNameMap: Record<string,string>): AwsNewsItem;
export function inferSeverity(category: string, statusCode: string): "alta" | "media" | "baja";
```

`pollAwsHealthQueue`:
1. `SQSClient({ region: "eu-west-1" })` con las credenciales del IRSA del portal (la cola está en la propia cuenta dp-tooling, sin AssumeRole).
2. `ReceiveMessageCommand` (long-poll, `MaxNumberOfMessages: 10`, `WaitTimeSeconds: 5`) en bucle hasta vaciar o alcanzar tope.
3. Cada mensaje SQS envuelve un evento EventBridge `aws.health`; se parsea `body.detail` (estructura `eventArn`, `service`, `eventTypeCode`, `eventTypeCategory`, `statusCode`, `affectedEntities`, `eventDescription[].latestDescription`, `startTime`, `endTime`).
4. `affectedAccounts`: el evento EventBridge incluye `account` (la cuenta donde se originó); se mapea a nombre vía `buildAwsAccountNameMap(fetchAwsAccountCatalog())`. Si llegan varias instancias del mismo `eventArn` desde distintas cuentas, se agregan en `affectedAccounts` al hacer upsert.
5. `inferSeverity`: `issue`+`open`→`alta`; `scheduledChange`→`media`; `accountNotification`→`baja`; `closed`→`baja`; categoría desconocida→`baja`.

`syncAwsHealthEvents`: tras `pollAwsHealthQueue`, hace upsert por `arn` (mergeando `affectedAccounts` y preservando `first_seen`), y solo entonces `DeleteMessageCommand` de los mensajes procesados con éxito (at-least-once; el upsert idempotente absorbe reentregas).

Degradación: cualquier error de SQS (cola inexistente, sin permisos) → log + `return []`. El sync no toca filas previas (req 3.5). La sidebar sirve lo último persistido.

### 3. `src/lib/finops-daily-digest.ts` (nuevo)

```ts
export interface DigestResult {
  finopsSent: boolean;
  newsSent: boolean;
  mode: "single" | "split";
  errors: string[];
}

export async function runDailyFinOpsDigest(): Promise<DigestResult>;
```

Flujo:
1. Calcula ventana de coste mes-a-fecha (default del advisor) y todas las cuentas vivas (`filterLiveAwsAccounts`).
2. `runFinOpsAdvisorAnalysis({ accountIds, includeMetrics, includeCosts, ... locale: 'es' })` → `analysis` + `insights`.
3. `getAwsNews({ sinceHours: 24, includeClosed: false })` → novedades del día.
4. Construye 1 o 2 MessageCards según `FINOPS_DIGEST_MODE` (`single` | `split`, default `split`).
5. Envía vía `sendTeamsCard(card, FINOPS_TEAMS_WEBHOOK_URL)`.
6. Si el análisis FinOps falla pero hay novedades → envía solo novedades (req 5.8).
7. Trunca el análisis a un tamaño seguro para Teams (~20KB por card; resumen + enlace al dashboard) (req 5.6).

### 4. `src/lib/teams-notify.ts` (nuevo helper, refactor ligero)

Centraliza el envío de MessageCard a un webhook arbitrario (hoy duplicado en 5+ ficheros). No se refactorizan los call-sites existentes en esta feature (out of scope); solo se usa para el digest.

```ts
export async function sendTeamsCard(card: Record<string, unknown>, webhookUrl: string): Promise<boolean>;
export function buildDigestCard(opts: { title: string; markdownSummary: string; facts: Array<{name:string; value:string}>; linkUrl: string }): Record<string, unknown>;
```

### 5. Endpoints API

| Endpoint | Método | Auth | Descripción |
|----------|--------|------|-------------|
| `/api/finops/ai-cost/snapshot` | POST | `requireInternalAuth` | Body `{ date? }`. Default = ayer. Backfill con `{ startDate, endDate }`. Llama `computeAiCostForDate`+`persistAiCostSnapshot`. `maxDuration=300`. |
| `/api/finops/ai-cost/history` | GET | `requireUserAuth(req,'desarrolladores')` | Query `?startDate&endDate&accountIds=csv`. Devuelve `AiCostHistory`. |
| `/api/aws-health/sync` | POST | `requireInternalAuth` | Llama `syncAwsHealthEvents` (poll SQS + upsert). `maxDuration=120`. |
| `/api/aws-health/news` | GET | `requireUserAuth(req,'admin')` | Query `?includeClosed`. Devuelve `AwsNewsItem[]` desde cache. |
| `/api/finops/daily-digest` | POST | `requireInternalAuth` | Llama `runDailyFinOpsDigest`. `maxDuration=300`. |

> Nota acceso `ai-cost/history`: el control de acceso FinOps mínimo es `desarrolladores` (req 2.6; `externos` no acceden a FinOps). `requireUserAuth(req,'desarrolladores')` lo cumple vía `hasMinimumRole`.

### 6. UI

**`src/components/finops/ai-cost-history-card.tsx`** (nuevo): card en la pestaña Costes (junto a `KiroLicensesCard`/`BedrockCard` en `costs-dashboard.tsx`). Recharts `AreaChart` apilada (Kiro + Bedrock) con los días anómalos marcados (`ReferenceDot`/color). Recibe `accountIds` del dashboard. Estado vacío informativo si no hay snapshots (req 2.4). Fetch a `/api/finops/ai-cost/history`.

**`src/components/home/news-sidebar.tsx`** (nuevo): panel lateral en la home, render condicionado a `session.user.appRole === 'admin'` (y el endpoint valida admin en servidor). Lista `AwsNewsItem` con badges de severidad/categoría/estado, cuentas afectadas y toggle "ocultar cerrados". Integrado en `src/app/page.tsx` ajustando el layout (`max-w-5xl` → grid con columna lateral cuando admin).

i18n: claves nuevas `finops.aiCost.*`, `home.news.*` en los 4 idiomas, con `const { t } = useI18n()` propio en cada componente (gotcha #8).

## Cronjobs (`ops/k8s/`)

| Manifiesto | Nombre | Schedule | Endpoint |
|------------|--------|----------|----------|
| `ai-cost-snapshot-cronjob.yaml` | `ai-cost-snapshot` | `0 2 * * *` (02:00 UTC) | `/api/finops/ai-cost/snapshot` |
| `aws-health-sync-cronjob.yaml` | `aws-health-sync` | `*/15 * * * *` | `/api/aws-health/sync` |
| `finops-daily-digest-cronjob.yaml` | `finops-daily-digest` | `20 8 * * *` UTC con `timeZone: "Europe/Madrid"` puesto a `20 10 * * *` | `/api/finops/daily-digest` |

> El digest debe salir a las **10:20 Europe/Madrid**. Se usa el campo `spec.timeZone: "Europe/Madrid"` (CronJob v1, k8s ≥1.27) con `schedule: "20 10 * * *"`. Si el cluster no soporta `timeZone`, fallback a UTC `20 8 * * *` (verano CEST = UTC+2) documentado en el manifiesto.

## Error Handling

| Escenario | Manejo |
|-----------|--------|
| CUR no disponible en snapshot | Endpoint devuelve 500, cronjob reintenta (OnFailure). Snapshots previos intactos (upsert por fecha). |
| Health cola sin permisos / inexistente | `pollAwsHealthQueue` → `[]`; sidebar muestra estado vacío o último persistido; sync no borra cache previa. |
| Bedrock advisor falla en digest | Envía solo novedades AWS si las hay; registra error en `errors[]` (req 5.8). |
| Card excede tamaño Teams | Trunca markdown del análisis a límite seguro + enlace al dashboard (req 5.6). |
| `FINOPS_TEAMS_WEBHOOK_URL` no configurado | `sendTeamsCard` → warn + `false`; digest no falla el proceso. |
| Sin snapshots para la gráfica | `AiCostHistory.days=[]` → card muestra estado vacío (req 2.4). |
| Usuario no-admin pide `/api/aws-health/news` | 403 vía `requireUserAuth(req,'admin')`. |

## Correctness Properties

Propiedades ejecutables que el sistema debe cumplir (para PBT / validación):

### Property 1: Idempotencia del snapshot
Para cualquier `date`, ejecutar `persistAiCostSnapshot(computeAiCostForDate(date))` N veces produce exactamente una fila en `ai_cost_daily` con `snapshot_date = date` (no duplica; el último gana).
**Validates: Requirements 1.3**

### Property 2: Consistencia de totales
Para todo `AiCostDay`, `totalAiCost == round2(kiroCost + bedrockCost)`, y `sum(byAccount[].totalCost) == totalAiCost` (±0.01 por redondeo).
**Validates: Requirements 1.1**

### Property 3: Filtrado por cuenta es un subconjunto monótono
`getAiCostHistory(s,e,subset).totals.total <= getAiCostHistory(s,e).totals.total` para cualquier `subset ⊆ cuentas`, y filtrar por todas las cuentas reproduce el total sin filtro.
**Validates: Requirements 2.3**

### Property 4: Detección de anomalías estable
Un día se marca anómalo sii `totalAiCost > mean + 2*stddev && totalAiCost > 1.5*mean` sobre la ventana; con ≤1 día de datos, `anomalyDays == []` (no hay anomalía sin base estadística).
**Validates: Requirements 2.5**

### Property 5: Severidad determinista y total
`inferSeverity(category,status)` devuelve siempre uno de `{alta,media,baja}` para cualquier entrada (incluidas categorías desconocidas → `baja`).
**Validates: Requirements 3.3**

### Property 6: Upsert de Health por ARN
Tras `syncAwsHealthEvents`, no existen dos filas con el mismo `arn`; un evento que cambia de estado actualiza la fila existente preservando `first_seen`.
**Validates: Requirements 3.4**

### Property 7: Aislamiento de acceso admin
`GET /api/aws-health/news` devuelve 403 para cualquier rol distinto de `admin`, independientemente de los parámetros.
**Validates: Requirements 4.1, 4.7**

### Property 8: Degradación no destructiva
Si `pollAwsHealthQueue` falla, `syncAwsHealthEvents` no borra ni corrompe filas previas de `aws_health_events`.
**Validates: Requirements 3.5**

### Property 9: El digest nunca lanza por fallo parcial
Si el análisis FinOps falla pero hay novedades, `runDailyFinOpsDigest` retorna `{ finopsSent:false, newsSent:true }` sin excepción no capturada.
**Validates: Requirements 5.8**

### Property 10: Webhook correcto
El digest se envía exclusivamente a `FINOPS_TEAMS_WEBHOOK_URL` y nunca al `TEAMS_WEBHOOK_URL` de SRE.
**Validates: Requirements 5.4**

## Testing Strategy

Dado que el portal no tiene framework de tests automatizado consolidado, la estrategia prioriza pruebas de lógica pura + verificación manual de integraciones AWS:

- **Unit (lógica pura)**: `inferSeverity`, detección de anomalías (`mean+2σ`), agregación `byAccount`, truncado de cards, normalización de `AwsNewsItem`. Estas funciones se diseñan puras (sin I/O) para testearlas con vitest si se introduce el runner, o validarlas con un script `ops/` ad-hoc.
- **Integración (manual, verificable)**:
  - `POST /api/finops/ai-cost/snapshot` con `x-internal-secret` → fila en `ai_cost_daily`.
  - Backfill de un rango → N filas; reejecución idempotente (no duplica).
  - `POST /api/aws-health/sync` → poll SQS + filas en `aws_health_events`; reejecución upsert idempotente.
  - `GET /api/aws-health/news` como admin (200) y no-admin (403).
  - `POST /api/finops/daily-digest` → mensaje(s) en el canal Teams de pruebas.
- **Verificación de despliegue**: build Next standalone OK (AWS SDK top-level imports, gotcha #5), cronjobs `kubectl get cronjob -n n8n`, ejecución manual `kubectl create job --from=cronjob/...`.

## Decisiones y trade-offs

1. **Ingesta de Health vía EventBridge en vez de la Health API**: verificado que la org está en Basic Support (la Health API responde `SubscriptionRequiredException`). EventBridge emite los eventos `aws.health` sin coste de soporte y captura exactamente las notificaciones que hoy llegan por email. Trade-off: hay que desplegar reglas en las 22 cuentas (automatizado con script idempotente) y la agregación la hace el portal, en vez de venir dada por la API de organización. Evita varios miles de $/mes de Business Support.
2. **Tabla `ai_cost_daily` separada** de `finops_daily_context`: el contexto diario tiene otro propósito (inventario/oportunidades para Iskay) y otra cadencia. Mantener el coste de IA aparte simplifica el endpoint de history y el filtrado por cuenta.
3. **Bedrock por día factorizado** en `athena-cur.ts` en vez de recomputar `CurFullSnapshot`: el snapshot completo es caro (22 queries). Para el día solo necesitamos Kiro + Bedrock.
4. **Digest reutiliza el advisor síncrono** (`runFinOpsAdvisorAnalysis`) y no crea un job en `finops_advisor_jobs`: el cronjob no necesita polling de UI; ejecuta y publica. Si en el futuro se quiere histórico de digests, se añade tabla.
5. **`timeZone` en CronJob**: se fija explícitamente a Europe/Madrid para evitar deriva verano/invierno; fallback documentado.
