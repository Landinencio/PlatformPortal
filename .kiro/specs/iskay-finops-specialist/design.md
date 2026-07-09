# Design — Iskay, chatbot FinOps especialista (Excel export + precisión/evals)

## Overview

Iskay es el chat FinOps del portal (Bedrock Sonnet 4, tool-calling, streaming SSE, read-only, acceso admin/directores). Tras la mejora de velocidad reciente, la latencia ya no es el problema. El objetivo ahora es **subir su nivel como chatbot FinOps especialista** (NO agente ejecutivo: sigue siendo solo lectura) para poder **abrirlo a toda la compañía cuando su comportamiento sea fiable al 100%**.

Esta spec cubre **dos frentes** (el tercero —RBAC/visibilidad por equipo al abrir a la compañía— irá en una spec propia por su complejidad):

- **A. Export a Excel**: que Iskay genere un informe `.xlsx` descargable con lo que se le pida, construido con las **cifras exactas** de las tools (cero alucinación en el fichero).
- **B. Precisión y fiabilidad**: un **harness de evaluación** (golden-set) que demuestre con datos —no con sensaciones— que Iskay responde bien, más endurecimiento de grounding (citas de cifras, fechas, out-of-scope, IDs opacos).

### No-objetivos
- NADA ejecutivo: sin tools de escritura/acción (ni MRs, ni tickets, ni apagar recursos).
- NO RBAC/visibilidad por equipo (spec 3, aparte). De momento sigue admin/directores.
- NO tocar la arquitectura de datos (Athena/Lambda) ni añadir pre-agregación: la velocidad ya es aceptable.
- NO migrar el runner de tests ni el modelo.

## Architecture

```
Usuario → FinOpsChat (SSE) → /api/ai/finops-chat (loop Bedrock)
                                   │
                                   ├── tools de lectura existentes (14)
                                   │
                                   └── NUEVA tool `build_report`
                                          │ (re-consulta datos exactos por sección)
                                          ▼
                                   genera .xlsx (XLSX, multi-hoja) en memoria
                                          │
                                          ├── guarda buffer keyed by reportId (cache corto)
                                          └── devuelve { reportId, filename, summary }
                                   │
        SSE `done` incluye downloadUrl  ◄┘
                                   ▼
        UI muestra botón "Descargar Excel" → GET /api/finops/report/<id> (attachment)

Evals (offline, CI-friendly):
  ops/iskay-evals/cases.ts  → runner → ejecuta contra el loop (o tool-selection + judge)
                            → assertions deterministas + (opcional) LLM-as-judge
                            → reporte pass/fail por caso
```

## Componentes — Frente A: Export a Excel

### A1. Tool `build_report` (en `src/lib/finops-tools.ts`)

Nueva entrada en `FINOPS_TOOLS` + handler en `executeFinopsTool`. El modelo la invoca cuando el usuario pide un informe/Excel ("dame un informe en Excel del coste de mayo por cuenta y servicio").

**Decisión clave de precisión**: la tool **NO recibe las cifras del modelo**. Recibe una *especificación de informe* (rango, cuentas, qué secciones) y **vuelve a obtener los datos** llamando a los mismos helpers internos (`fetchCostQuery`, `getCostByAccountTool`, etc.). Así el Excel sale de las cifras exactas de Athena/CUR, nunca de texto que el modelo podría re-teclear mal.

```ts
{
  name: "build_report",
  description: "Genera un informe Excel (.xlsx) descargable con los datos de coste/inventario pedidos. Úsalo cuando el usuario pida 'un informe', 'en Excel', 'descargable', 'un fichero'. NO pongas tú las cifras: indica el rango, cuentas y secciones, y la herramienta obtiene los datos exactos y construye el fichero.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Título del informe (ej. 'Coste AWS — Mayo 2026')" },
      startDate: { type: "string" },
      endDate: { type: "string" },
      accountIds: { type: "array", items: { type: "string" } },
      sections: {
        type: "array",
        description: "Secciones a incluir (cada una = una hoja del Excel).",
        items: { enum: ["summary","by_account","by_service","by_domain","top_resources","net_breakdown","hidden_costs","marketplace"] }
      }
    },
    required: ["title","startDate","endDate","sections"],
    additionalProperties: false
  }
}
```

Handler `buildReportTool(args)`:
1. Valida fechas/secciones.
2. Para cada sección pedida, llama al helper correspondiente (reusa los executors existentes) → obtiene filas estructuradas.
3. Construye el workbook con `XLSX` (mismo patrón que `src/app/api/synthetics/export/route.ts`): una hoja por sección + hoja "Resumen" con metadatos (rango, cuentas, generado por, timestamp). Aplica `prettyServiceName` para que no aparezcan IDs opacos.
4. `XLSX.write(wb, { type:"buffer", bookType:"xlsx" })` → buffer.
5. Guarda el buffer en un **store de informes** keyed por `reportId` (UUID), TTL corto.
6. Devuelve `{ reportId, filename, sheetCount, rowCounts, downloadUrl: "/api/finops/report/<id>" }`.

### A2. Store de informes + endpoint de descarga

- **Store**: `src/lib/finops-report-store.ts`. Opción simple y robusta entre réplicas: persistir el buffer en una **tabla `finops_reports`** (`id UUID PK`, `filename`, `content BYTEA`, `created_at`, `user_email`, `expires_at`). Limpieza por TTL (cron o lazy delete al servir). Alternativa in-memory descartada: 2 réplicas → la descarga podría ir al pod que no lo generó.
- **Endpoint**: `GET /api/finops/report/[id]/route.ts` — `requireUserAuth` (mismo gate admin/directores), busca por id (y valida ownership por email), devuelve el `BYTEA` con `Content-Disposition: attachment; filename="..."` y `Content-Type` xlsx. 404 si no existe/expiró.

### A3. UI — botón de descarga

- El SSE `done` ya transporta el `trace`. Añadir que, si la última tool fue `build_report`, el evento `done` incluya `report: { downloadUrl, filename }`.
- En `finops-chat.tsx`: si el mensaje del asistente trae `report`, renderizar un botón "⬇️ Descargar Excel" bajo la respuesta. (Pequeña extensión del tipo `Message`.)

### A4. Migración BD

`migrations/2026-06-1X_finops_reports.sql`: tabla `finops_reports` (con índice por `expires_at` para limpieza).

## Componentes — Frente B: Precisión y fiabilidad

### B1. Harness de evals (lo más importante para abrir a la compañía)

`ops/iskay-evals/` — set de casos golden + runner. Ejecutable en local/CI (Node + tsx), **no** toca producción (puede correr contra una cuenta de datos real en modo read-only, o con tools mockeadas para los asserts deterministas).

**Estructura de un caso** (`cases.ts`):
```ts
interface EvalCase {
  id: string;
  question: string;
  expectTools: string[];          // tools que DEBE/PUEDE llamar (p.ej. ["get_cost_by_domain"])
  forbidTools?: string[];         // tools que NO debe usar (p.ej. get_cost_by_service para "por departamento")
  assertions: {
    noOpaqueIds?: boolean;        // la respuesta no contiene cg…/ids de inference-profile crudos
    citesToolFigures?: boolean;   // toda cifra € citada existe en algún toolResult
    period?: { start: string; end: string }; // resolvió bien el rango
    outOfScopeRedirect?: boolean; // pregunta no-FinOps → redirige limpio
  };
}
```

**Runner** (`run.ts`): por cada caso ejecuta el loop del agente (reusando `executeFinopsTool` + el mismo system prompt) capturando el `trace`, y evalúa:
- **Deterministas** (sin LLM): qué tools se llamaron (`expectTools`/`forbidTools`), que las cifras citadas en el texto aparecen en los toolResults (regex de importes vs outputs), ausencia de IDs opacos, rango de fechas resuelto.
- **LLM-as-judge** (opcional, una llamada Bedrock por caso): puntúa claridad/correctud de la respuesta contra una rúbrica. Marcado como opcional para no encarecer cada corrida.

Salida: tabla pass/fail por caso + score agregado. Umbral configurable (ej. 100% de los deterministas para considerar "listo para abrir").

**Casos iniciales** (cubren los gotchas FinOps conocidos):
- "¿Cuánto cuesta AWS?" → usa `get_net_cost_breakdown` (Gross/Marketplace/Net), no `get_total_cost` a secas.
- "¿Qué departamento gasta más en IA?" → `get_cost_by_domain` (NO `get_cost_by_service`), expone cobertura del tag.
- "Coste de mayo" sin año → resuelve al año correcto / mes en curso si aplica.
- Pico día 1 → lo atribuye a marketplace, no a infra.
- Pregunta fuera de scope ("dame los logs de oms") → redirige al dashboard, no inventa.
- Cifra exacta: la respuesta cita el mismo número que devolvió la tool.

### B2. Endurecimiento de grounding (cambios pequeños y dirigidos)

- **Guard de citas de cifras** (servidor): tras el loop, verificar que los importes monetarios del texto final aparecen en algún `toolResult` de la conversación; si hay desajuste, loguear (telemetría) y —en modo estricto— pedir al modelo que corrija. Empezar en modo "loguea y mide" (alimenta los evals), endurecer después.
- **Refuerzo del system prompt** según hallazgos de los evals (fechas relativas, out-of-scope, prohibición de IDs opacos —ya está, pero se valida con tests).
- **Tests unitarios** de `prettyServiceName` y de la resolución de cuentas/fechas (puro, `node:test`).

### B3. Telemetría de calidad (ligero)

Reusar `iskay_conversations` (ya guarda turnos + tools usadas). Añadir, best-effort, un registro de “cifras citadas vs verificadas” por turno para poder auditar la precisión en producción una vez abierto. (Opcional; si añade complejidad, queda fuera.)

## Data Models

- **`finops_reports`** (nueva): `id UUID PK`, `filename TEXT`, `content BYTEA`, `user_email TEXT`, `created_at TIMESTAMPTZ`, `expires_at TIMESTAMPTZ`. Índice por `expires_at`.
- `iskay_conversations` (existente): sin cambios estructurales (telemetría B3 es opcional).
- Evals: sin BD; viven como ficheros en `ops/iskay-evals/`.

## Error Handling

- `build_report`: si una sección falla al obtener datos, incluye la hoja con una nota de error y sigue con el resto (informe parcial > fallo total). Si TODO falla, la tool devuelve error → el modelo lo comunica.
- Descarga: 404 limpio si el report expiró; nunca servir a otro usuario (ownership por email).
- Evals: un caso que peta no aborta la corrida; se marca fail con el error.
- Mantener el contrato del chat: nada de esto bloquea la respuesta conversacional.

## Testing Strategy

- **Unit** (`node:test` + tsx, patrón del repo): `buildReportTool` (genera workbook con las hojas pedidas, aplica prettyServiceName, maneja sección fallida), helpers de resolución de fechas/cuentas, `prettyServiceName`.
- **Integración ligera**: el endpoint de descarga sirve el buffer con los headers correctos.
- **Evals** (B1): el entregable estrella de precisión. Corren bajo demanda / en CI nocturno (no en cada MR por coste Bedrock; los deterministas sí pueden correr sin Bedrock si mockeamos tool outputs).
- El Excel se valida abriendo un fichero generado de muestra (hoja por sección, números = tool outputs).

## Despliegue / orden

1. **A (Excel)** primero — valor tangible y demostrable: tool `build_report` + store + endpoint + botón UI + migración. Flujo GitOps habitual.
2. **B (evals + grounding)** — harness con casos iniciales (deterministas), guard de citas en modo "mide", refuerzo de prompt con lo aprendido. Es el trabajo que habilita el "100% fiable" para la apertura.
3. Actualizar steering (§4 Iskay): nueva tool `build_report`, tabla `finops_reports`, harness de evals.

## Decisiones clave (resumen)

| Decisión | Elección | Por qué |
|----------|----------|---------|
| Cómo se generan las cifras del Excel | la tool re-consulta datos, no las recibe del modelo | exactitud garantizada, cero alucinación en el fichero |
| Almacenamiento del informe | tabla `finops_reports` (BYTEA, TTL) | 2 réplicas → la descarga debe funcionar desde cualquier pod |
| Patrón xlsx | `XLSX` (igual que synthetics/export) | ya en deps y probado en el repo |
| Medir precisión | harness de evals golden-set | "100% perfecto" se demuestra con datos, no con sensaciones |
| Guard de cifras | empezar en modo "loguea y mide" | endurecer sin frenar; alimenta los evals |
| Scope | read-only, sin RBAC nuevo | objetivo del usuario; RBAC es spec 3 aparte |
