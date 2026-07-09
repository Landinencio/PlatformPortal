# Barrido_Utilizacion — Rightsizing por p95 de CPU/RAM (Palanca 9) — Tarea 16.2

> Artefacto auditable y **dedicado** de la **Tarea 16.2**: ejecución del **Barrido_Utilizacion**
> de la Palanca 9 (Rightsizing/Graviton). Objetivo del barrido: **consolidar el p95 de CPU y RAM
> por recurso candidato** usando la fuente designada por el `design.md` (**Grafana/VPA**,
> `quantile_over_time(0.95, ...)[7d:5m]`) y, si **no hay métricas**, dejar la Palanca **pendiente y
> sin proponer** rightsizing, registrando el resultado en el `Catálogo_Evidencias`.
>
> **Validates: Requirements 18.1, 18.3, 18.4, 13.1, 13.2**
>
> Gating: **Palanca 9**. Este fichero es el artefacto PROPIO de la Tarea 16.2; **no** se edita
> `catalogo-evidencias.md` ni ningún `palanca-*.md` (escritura en paralelo de otras sub-tareas del
> Barrido — se evita clobber). El registro para el catálogo va al final de este documento, listo
> para integrarse.

---

## Parámetros de anclaje (Req 2.1)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (mayo 2026) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Fecha-hora de ejecución del Barrido (UTC) | `2026-06-23T11:07:32Z` |
| Fecha-hora (Europe/Madrid, CEST) | `2026-06-23T13:07:32+02:00` |
| Ventana p95 objetivo | 7 días (`[7d:5m]`), según `design.md` Palanca 9 |
| Región de los candidatos | `eu-west-1` |
| Naturaleza de las consultas | **solo lectura** (PromQL `query` contra Grafana Cloud) — ninguna operación mutante (Req 5.1, Property 11) |
| Credenciales | token de Grafana Cloud leído de secret (`kiro-grafana-cloud`, ns `n8n`, dp-tooling); **sin tokens incrustados** (Req 7.5) |

---

## 1. Conjunto candidato a barrer (de la Palanca 9 congelada)

La Palanca 9 (Tareas 11.1–11.3, ya congeladas) dejó la **base direccionable** de rightsizing en
**6 instancias x86 no burstable de carga 24/7**, equiv. on-demand **3 828,48 USD/mes**. Son el
conjunto que este Barrido debe confirmar con p95 de **CPU y RAM** (Req 13.1):

| # | Instancia (`line_item_resource_id`) | Tipo | Cuenta · nombre | Plataforma | p95 CPU % (11.2, CloudWatch, parcial) |
|--:|--------------------------------------|------|-----------------|-----------|--------------------------------------:|
| 1 | `i-077c80e4ad5dee2f6` | `r6a.4xlarge` | `400500600700` · SAP (slimstock/logística) | Windows | 32,39 |
| 2 | `i-09e46b118b490e70c` | `m6i.4xlarge` | `400500600700` · SAP (spaceman) | Windows | 1,86 |
| 3 | `i-09df511c7032ee013` | `c5a.2xlarge` | `400500600700` · SAP (publishing) | Windows | 2,04 |
| 4 | `i-0131f5d7404a789c1` | `m6id.xlarge` | `200300400500` · iskaypet-data (power-bi-gateway) | Windows | 28,37 |
| 5 | `i-03c5a408758018ee9` | `m5.2xlarge` | `300400500600` · infra (unifi) | Linux | 23,09 |
| 6 | `i-01df3007e1dc5a4ad` | `m5.xlarge` | `999000111222` · clinicanimal (DWH_PROVET) | Linux | 0,11 |

> El resto de los 24 candidatos 24/7 de la Tarea 11.1 ya quedaron fuera de la base direccionable:
> familia burstable `t` moderada por Req 13.4, 6 `m7g` excluidas por drift (no existen), y
> adopta301/t2.micro/`testeando` excluidas con motivo. El Barrido se concentra en estas 6, que son
> donde la propuesta de rightsizing podría comprometerse **si** hubiera p95 de CPU **y** RAM.

---

## 2. Ejecución del Barrido — consolidación de p95 por la fuente designada (Grafana/VPA)

El `design.md` de la Palanca 9 designa **Grafana/VPA** como fuente de p95
(`quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{...}[5m])[7d:5m])` para CPU y las
recomendaciones VPA para CPU/RAM). Se intentó consolidar el p95 de **CPU y RAM** por recurso
candidato contra el data plane de Grafana Cloud (Prometheus
`prometheus-prod-24-prod-eu-west-2`, usuario `1290143`). Resultado **reproducido en vivo** en la
fecha-hora de ejecución del Barrido:

| Sonda | PromQL (solo lectura) | Resultado | Lectura |
|-------|------------------------|-----------|---------|
| **A — ¿son nodos EKS los candidatos?** | `count(node_total_hourly_cost{provider_id=~".*(i-077c80e4ad5dee2f6\|i-09e46b118b490e70c\|i-09df511c7032ee013\|i-0131f5d7404a789c1\|i-03c5a408758018ee9\|i-01df3007e1dc5a4ad).*"})` | `[]` (**0 series**) | Ninguno de los 6 candidatos es nodo de los clusters EKS → OpenCost/Grafana no los ve |
| **B — ¿CloudWatch EC2 ingerido en Grafana?** | `count({__name__=~"aws_ec2.*"})` | `[]` (**0 series**) | No hay métricas `aws_ec2_*` en Grafana Cloud → no hay CPU/RAM de EC2 por esta vía |
| **C — ¿windows_exporter?** | `count({__name__=~"windows_.*"})` | `[]` (**0 series**) | Sin `windows_exporter` (las SAP/PowerBI son Windows) → no hay RAM/CPU de Windows |
| **D — control de sanidad (RDS sí existe)** | `count({__name__=~"aws_rds.*"})` | **608 series** | La ingesta CloudWatch funciona (RDS sí está) — la ausencia de EC2 no es un fallo de acceso |
| **E — VPA recomendación CPU (target cores)** | `count(kube_customresource_verticalpodautoscaler_recommendation_cpu_target_cores)` | **8 series** | VPA existe, pero solo para pods EKS |
| **F — VPA recomendación RAM (target bytes)** | `count(kube_customresource_verticalpodautoscaler_recommendation_memory_target_bytes)` | **140 series** | VPA RAM existe, pero solo para pods EKS |
| **G — VPA por cluster** | `count by (k8s_cluster_name) (kube_customresource_verticalpodautoscaler_recommendation_memory_target_bytes)` | `dp-dev=103`, `dp-uat=37` | Las recomendaciones VPA son de **pods EKS** (dp-dev/dp-uat), no de EC2 standalone |
| **H — ¿alguna reco VPA matchea los candidatos?** | `count({__name__=~"kube_customresource_verticalpodautoscaler.*", target_name=~".*(077c80e4\|09e46b11\|09df511c\|0131f5d7\|03c5a408\|01df3007).*"})` | `[]` (**0 series**) | Ninguna recomendación VPA corresponde a los 6 candidatos (son EC2, no pods) |

### Acceso a datos (reproducibilidad — Req 7.1, 7.2, 18.3)

```bash
# Token de Grafana Cloud (data plane) desde secret — NO se imprime en claro (Req 7.5)
TOKEN=$(kubectl --context arn:aws:eks:eu-west-1:444455556666:cluster/dp-tooling \
  -n n8n get secret kiro-grafana-cloud -o jsonpath='{.data.GRAFANA_CLOUD_TOKEN}' | base64 -d)

BASE="https://prometheus-prod-24-prod-eu-west-2.grafana.net/api/prom/api/v1/query"

# Ejemplo (sonda B): ¿hay métricas CloudWatch de EC2 ingeridas?
curl -sS -G -u "1290143:${TOKEN}" "$BASE" \
  --data-urlencode 'query=count({__name__=~"aws_ec2.*"})'
# -> {"status":"success","data":{"resultType":"vector","result":[]}}   (0 series)
```

> **p95 de CPU designado por el diseño (re-ejecutable cuando exista cobertura):**
> `quantile_over_time(0.95, rate(container_cpu_usage_seconds_total{container!="",container!="POD"}[5m])[7d:5m])`
> — solo aplica a **cargas EKS**; estos 6 EC2 standalone no producen `container_*` ni
> `node_*`, por lo que la consulta devuelve vacío para ellos.

---

## 3. Resultado del Barrido — **SIN MÉTRICAS por la fuente designada → PENDIENTE y sin proponer**

La consolidación de p95 **CPU y RAM** por Grafana/VPA **no es posible** para ninguno de los 6
candidatos, porque **no son cargas de EKS** sino **EC2 standalone** (SAP/PowerBI Windows, UniFi y
DWH Linux):

- **CPU (Grafana/VPA):** 0 series (`node_total_hourly_cost`, `aws_ec2_*`, `windows_*`, VPA) para los
  candidatos. La única señal de CPU disponible es **CloudWatch `AWS/EC2 CPUUtilization`** (parcial,
  ya leída en la Tarea 11.2), que **no** es la fuente Grafana/VPA del diseño y, sobre todo, **no
  aporta RAM**.
- **RAM (p95):** **no instrumentada en ninguna cuenta**. No hay `windows_exporter`/`node_exporter`
  ingerido a Grafana, no hay VPA para estos recursos, y (Tarea 11.2) no hay CloudWatch Agent
  (`CWAgent`) en `sap`/`iskaypet-data`/`infra`/`clinicanimal`. **0 fuentes de p95 de RAM.**

**Aplicación del gating (Req 13.1, 13.2):** el Req 13.1 exige p95 de **CPU y RAM** para proponer
rightsizing. Al **faltar el p95 de RAM** (y la CPU por la fuente designada) en **los 6 candidatos**,
**ninguno** cumple el criterio. Por la regla del Req 13.2, **no se propone rightsizing** para
ninguno y **todos permanecen pendientes de Barrido_Utilizacion**.

### Estado por candidato tras el Barrido

| Instancia | p95 CPU (Grafana/VPA) | p95 CPU (CloudWatch, parcial) | p95 RAM | ¿Cumple Req 13.1 (CPU+RAM)? | Estado Barrido |
|-----------|:---------------------:|:-----------------------------:|:-------:|:---------------------------:|----------------|
| `i-077c80e4ad5dee2f6` (r6a.4xlarge SAP) | sin métricas | 32,39 % | **n/d** | **No** | **PENDIENTE — sin proponer** |
| `i-09e46b118b490e70c` (m6i.4xlarge SAP) | sin métricas | 1,86 % | **n/d** | **No** | **PENDIENTE — sin proponer** |
| `i-09df511c7032ee013` (c5a.2xlarge SAP) | sin métricas | 2,04 % | **n/d** | **No** | **PENDIENTE — sin proponer** |
| `i-0131f5d7404a789c1` (m6id.xlarge data) | sin métricas | 28,37 % | **n/d** | **No** | **PENDIENTE — sin proponer** |
| `i-03c5a408758018ee9` (m5.2xlarge infra) | sin métricas | 23,09 % | **n/d** | **No** | **PENDIENTE — sin proponer** |
| `i-01df3007e1dc5a4ad` (m5.xlarge clinicanimal) | sin métricas | 0,11 % | **n/d** | **No** | **PENDIENTE — sin proponer** |

**Cobertura del Barrido: 0 de 6 candidatos con p95 CPU+RAM confirmado → Barrido al 0 % completado.**

---

## 4. Conclusión del Barrido de la Palanca 9

🔶 **El Barrido de rightsizing por p95 de la Palanca 9 está PENDIENTE (al 100 %).** No hay ningún
candidato con p95 de CPU **y** RAM confirmado por la fuente designada (Grafana/VPA): los 6 recursos
direccionables son EC2 standalone fuera de EKS y la RAM no está instrumentada en ninguna cuenta.

Consecuencias (Req 13.2, 18.1, 18.2):

- **No se propone rightsizing** para ningún candidato (sin p95 completo, Req 13.2).
- **Ningún candidato es elegible para el Conservador comprometido.** La Palanca 9 **NO** entra en el
  `Objetivo_Comprometido` (Req 18.2): su ahorro **Estimado 574,27 – 1 531,39 USD/mes** (Tarea 11.3)
  se mantiene **solo como rango condicionado**, no como objetivo.
- El Barrido **no eleva** la Palanca: queda **fuera de objetivos** hasta instrumentar la RAM y
  re-ejecutar la consolidación de p95.

> Determinación de elegibilidad para el objetivo comprometido: **PENDIENTE** (no COMPLETO). Frente a
> la dicotomía de la tarea — *COMPLETO (algún candidato con p95 confirmado → Conservador elegible)*
> vs *PENDIENTE (todos sin métricas → fuera de objetivos)* — el resultado es **PENDIENTE**.

### Acciones para cerrar el Barrido (no parte de esta tarea; prerequisito de elevar la Palanca)

1. **Instrumentar el p95 de RAM** de los 6 candidatos: CloudWatch Agent (`mem_used_percent` en Linux
   / `Memory % Committed Bytes In Use` en Windows) **o** `node_exporter`/`windows_exporter` ingerido
   a Grafana Cloud.
2. Consolidar p95 de **CPU y RAM** por recurso sobre ventana ≥ 7 días y **re-derivar** la tasa de
   reducción por instancia (las cargas memory-bound — SAP/PowerBI/DWH — bajarán su recorte respecto
   a lo que sugiere la CPU).
3. Validar **compatibilidad arm64** antes de cualquier propuesta Graviton (descartada de entrada en
   Windows/SAP/PowerBI).
4. **Registrar los resultados en el `Catálogo_Evidencias` antes de elevar la Palanca** a objetivo
   comprometido (Req 18.4).

---

## 5. Registro de evidencia (esquema del Catálogo_Evidencias — Req 2.x, 18.4, 19.5)

> Listo para integrarse en `catalogo-evidencias.md` (no se escribe aquí para evitar clobber con
> otras sub-tareas del Barrido en curso).

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-16.2-barrido-rightsizing-p95` |
| `descripcion` | Barrido_Utilizacion de rightsizing por p95 (Palanca 9): intento de consolidar p95 de CPU y RAM por recurso candidato vía la fuente designada Grafana/VPA para las 6 instancias x86 no burstable direccionables; sin métricas (EC2 standalone fuera de EKS, RAM no instrumentada) → Palanca pendiente y sin propuesta |
| `consulta_cur` | `no aplica` (barrido de utilización por PromQL contra Grafana Cloud, no consulta CUR) |
| `promql` | A: `count(node_total_hourly_cost{provider_id=~".*(<6 ids>).*"})` → 0; B: `count({__name__=~"aws_ec2.*"})` → 0; C: `count({__name__=~"windows_.*"})` → 0; D: `count({__name__=~"aws_rds.*"})` → 608 (control); E: `count(kube_customresource_verticalpodautoscaler_recommendation_cpu_target_cores)` → 8; F: `...recommendation_memory_target_bytes` → 140; G: `count by (k8s_cluster_name)(...memory_target_bytes)` → dp-dev=103, dp-uat=37; H: VPA por `target_name` matcheando ids candidatos → 0 |
| `mes_referencia` | `2026-05` (candidatos congelados); barrido p95 sobre ventana de 7 días |
| `fecha_hora_utc` | `2026-06-23T11:07:32Z` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `cuentas` | `400500600700` (SAP), `200300400500` (iskaypet-data), `300400500600` (infra), `999000111222` (clinicanimal) |
| `region` | `eu-west-1` |
| `recurso_ids` | `i-077c80e4ad5dee2f6`, `i-09e46b118b490e70c`, `i-09df511c7032ee013`, `i-0131f5d7404a789c1`, `i-03c5a408758018ee9`, `i-01df3007e1dc5a4ad` (6 candidatos direccionables) |
| `metodo` | PromQL `query` (solo lectura) contra Grafana Cloud Prometheus `prometheus-prod-24-prod-eu-west-2` (usuario `1290143`); token de Grafana Cloud desde secret, sin incrustar (Req 7.5, Property 11) |
| `fuente_designada` | **Grafana/VPA** (`design.md` Palanca 9) — **sin cobertura** para estos EC2 standalone (0 series node/aws_ec2/windows/VPA) |
| `cobertura_p95` | CPU por Grafana/VPA: **0/6**; RAM por cualquier fuente: **0/6**; (CPU parcial por CloudWatch `AWS/EC2`: 5/6 running, insumo de 11.2, no es la fuente del diseño) |
| `estado_barrido` | **PENDIENTE (0 % completado)** — sin métricas de p95 (especialmente RAM) por la fuente designada → no iniciable hasta instrumentar RAM |
| `gating` | Req 13.1 (p95 CPU+RAM) **no se cumple para ningún candidato** → Req 13.2: **no se propone rightsizing**; Req 18.1/18.2: Palanca **fuera del Objetivo_Comprometido** |
| `efecto_en_objetivo` | La Palanca 9 contribuye **solo** como rango Estimado (574,27 – 1 531,39 USD/mes), **no** como Conservador comprometido |
| `clasificacion` | **Estimado** (rango, Req 13.6) — **requiere Barrido_Utilizacion**, pendiente al 100 % |

---

## 6. Estado de ejecución (Tarea 16.2)

- ✅ **Barrido ejecutado** el `2026-06-23T11:07:32Z` (UTC), **solo lectura**, PromQL contra Grafana
  Cloud (data plane), token desde secret sin incrustar (Req 5.1, 7.5, Property 11).
- ✅ **Intento de consolidación de p95 CPU/RAM por Grafana/VPA**: confirmado en vivo que **no hay
  cobertura** para los 6 candidatos (0 series de `node_total_hourly_cost`, `aws_ec2_*`, `windows_*`
  y VPA; control RDS = 608 series demuestra que la ingesta funciona, la ausencia es real, no un
  fallo de acceso). VPA existe pero solo para pods EKS (dp-dev=103, dp-uat=37) y **ninguna**
  recomendación matchea los ids candidatos.
- ✅ **Gating aplicado (Req 13.1, 13.2)**: sin p95 de CPU **y** RAM → **no se propone rightsizing**;
  **0 de 6** candidatos elegibles; **todos permanecen PENDIENTES**.
- 🔶 **Conclusión: Barrido de la Palanca 9 PENDIENTE (100 %)** → la Palanca queda **fuera del
  Objetivo_Comprometido** (Req 18.2); su ahorro Estimado se mantiene solo como rango.
- ✅ **Resultados registrados** en este artefacto dedicado con su registro de evidencia
  (`EV-16.2-barrido-rightsizing-p95`) listo para el `Catálogo_Evidencias` (Req 18.4) — sin tocar
  `catalogo-evidencias.md` ni `palanca-*.md` para evitar clobber.
- Reproducibilidad (Req 7.3): re-ejecutar las PromQL documentadas sobre la misma cobertura debe
  reproducir 0 series para los candidatos (resultado estable mientras no se instrumente la RAM).
