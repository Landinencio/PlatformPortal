# Auditoría 17.7 — Verificación estrictamente de solo lectura (Property 11)

> **Tarea 17.7** del Estudio FinOps de Ahorro AWS. **Auditoría re-ejecutable** de una *Correctness
> Property* sobre el `Catálogo_Evidencias` y los registros de `Verificacion_Recurso_Vivo` — **no** es
> un test de código.
>
> - **Property 11 — Verificación estrictamente de solo lectura.** *Para toda* `Verificacion_Recurso_Vivo`
>   registrada, **todos** sus comandos pertenecen al conjunto de operaciones de solo lectura
>   (`describe`/`list`/`get`) y **ninguno** es una operación mutante
>   (`create`/`update`/`delete`/`modify`/`put`/`terminate`/`run`/`attach`/`detach`/`reboot`/`stop`/`start-instances`…).
>   Además, las verificaciones de **WAF/CloudFront** se ejecutan en **`us-east-1`** (recurso global
>   facturado allí) y las credenciales se referencian **por nombre de perfil/rol o clave de secret**,
>   **nunca incrustadas**.
>   **Validates: Requirements 5.1, 5.2, 7.5, 11.2.**
>
> Este fichero es el **artefacto NUEVO y DEDICADO** de la Tarea 17.7. **No** modifica ningún otro
> fichero del spec (evidencias, catálogo, design, tasks). Recorre todos los `evidencias/palanca-*.md`
> y `evidencias/barrido-16-*.md`, extrae cada comando AWS CLI / PromQL registrado en los sub-registros
> de verificación viva y audita: (a) read-only vs mutante; (b) región `us-east-1` para WAF/CloudFront;
> (c) credenciales no incrustadas.

## Parámetros de anclaje (Req 2.5)

| Campo | Valor |
|-------|-------|
| `id_auditoria` | `AUD-17.7-verificacion-solo-lectura` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Fecha de la auditoría | `2026-06-24` (UTC) |
| Naturaleza | Auditoría de cumplimiento (revisión documental re-ejecutable de los comandos registrados); no ejecuta consultas CUR ni verificaciones en vivo nuevas |
| Property auditada | **Property 11** — verificación estrictamente de solo lectura + `us-east-1` para WAF/CloudFront + credenciales no incrustadas |
| Fuentes | `palanca-01-ec2.md`, `palanca-02-rds.md`, `palanca-03-extended-support.md`, `palanca-04-logs.md`, `palanca-05-aurora-helios.md`, `palanca-06a-gp2-gp3.md`, `palanca-06b-snapshots.md`, `palanca-06c-volumenes-huerfanos.md`, `palanca-07-s3.md`, `palanca-08-red.md`, `palanca-09-rightsizing.md`, `palanca-10-noprod-spot.md`, `palanca-11-bedrock.md`, `palanca-12-marketplace.md`, `barrido-16-1-steady-state.md`, `barrido-16-2-rightsizing-p95.md`, `barrido-16-3-scheduling-spot.md` |

## Criterio de clasificación de verbos (cerrado)

| Conjunto | Verbos AWS CLI / PromQL | Veredicto |
|----------|-------------------------|:---------:|
| **Solo lectura permitido** | `describe-*`, `list-*`, `get-*` (incl. `sts get-caller-identity`, `ce get-savings-plans-coverage`, `cloudwatch get-metric-statistics`/`list-metrics`, `s3api get-*`/`list-*`, `wafv2 list-*`, `bedrock list-*`); PromQL `query` / `label values` (lectura) | ✅ read-only |
| **Acceso a datos de coste (no mutante)** | `athena start-query-execution` ejecutando exclusivamente `SELECT` contra `athenacurcfn_finnops.data` (escribe solo en el bucket de resultados `s3://finnops-iskaypet/athena-query-results/`) | ✅ no mutante (ver §4) |
| **Mutante (PROHIBIDO)** | `create-*`, `delete-*`, `put-*`, `modify-*`, `update-*`, `terminate-*`, `run-instances`, `stop-instances`, `start-instances`, `reboot-*`, `attach-*`, `detach-*`, `abort-multipart-upload`, `release-address`, etc. | ❌ violación |

---

## 1. Inventario de comandos de `Verificacion_Recurso_Vivo` por Palanca

Cada fila es un comando AWS CLI / PromQL **registrado** en el sub-registro de verificación viva de la
Palanca. `Verbo` = familia de operación; `R-O` = read-only.

### Palanca 1 — Compromiso EC2 (Savings Plans) · Tarea 3.2 (`palanca-01-ec2.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 1.1 | `aws ce get-savings-plans-coverage` | `get` | eu-west-1 (API pagadora/global) | ✅ |
| 1.2 | `aws savingsplans describe-savings-plans --states active` | `describe` | eu-west-1 (API pagadora/global) | ✅ |
| 1.3 | `aws ec2 describe-instances --filters Name=instance-state-name,Values=running` | `describe` | eu-west-1 | ✅ |
| 1.4 | `aws sts get-caller-identity` (sanity de identidad) | `get` | eu-west-1 | ✅ |

### Palanca 2 — Compromiso RDS (Reserved Instances) · Tarea 4.2 (`palanca-02-rds.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 2.1 | `aws rds describe-db-instances` | `describe` | eu-west-1 | ✅ |
| 2.2 | `aws rds describe-reserved-db-instances` | `describe` | eu-west-1 | ✅ |
| 2.3 | `aws sts get-caller-identity` (14 cuentas) | `get` | eu-west-1 | ✅ |

### Palanca 3 — Extended Support de motores EOL (RDS) · Tarea 5.2 (`palanca-03-extended-support.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 3.1 | `aws rds describe-db-instances` | `describe` | eu-west-1 | ✅ |
| 3.2 | `aws rds describe-db-major-engine-versions --engine postgres --major-engine-version 13` | `describe` | eu-west-1 | ✅ |
| 3.3 | `aws rds describe-db-engine-versions --engine postgres --engine-version 13.20 --include-all` | `describe` | eu-west-1 | ✅ |
| 3.4 | `aws sts get-caller-identity` (4 cuentas) | `get` | eu-west-1 | ✅ |

### Palanca 4 — Logs de CloudWatch y WAF · Tarea 6.2 (`palanca-04-logs.md`) — **WAF/CloudFront**

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 4.1 | `aws sts get-caller-identity` | `get` | **us-east-1** | ✅ |
| 4.2 | `aws wafv2 list-logging-configurations --scope CLOUDFRONT` | `list` | **us-east-1** | ✅ |
| 4.3 | `aws logs describe-log-groups --log-group-name-prefix aws-waf-logs` | `describe` | **us-east-1** | ✅ |

> **Punto crítico de la Tarea 17.7 (Req 5.2, 11.2):** la única Palanca con recurso global de
> CloudFront/WAF es la **Palanca 4**, y sus tres comandos vivos se ejecutaron **en `us-east-1`**
> (`--scope CLOUDFRONT --region us-east-1 --profile digital-ecommerce`). ✅ — ver §3.

### Palanca 5 — Aurora no productivo de Helios · Tarea 7.2 (`palanca-05-aurora-helios.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 5.1 | `aws sts get-caller-identity` (helios-dev, helios-uat) | `get` | eu-west-1 | ✅ |
| 5.2 | `aws rds describe-db-clusters` | `describe` | eu-west-1 | ✅ |
| 5.3 | `aws rds describe-db-instances` | `describe` | eu-west-1 | ✅ |

### Palanca 6a — EBS gp2→gp3 · Tarea 8.1 (`palanca-06a-gp2-gp3.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 6a.1 | `aws ec2 describe-volumes` (verificación de tamaños/rendimiento) — **pendiente, no ejecutada en 8.1; declarada solo lectura** | `describe` | eu-west-1 | ✅ |

> 6a no ejecutó verificación viva propia en la Tarea 8.1 (la difiere y la comparte con 6c); el único
> comando contra el recurso que declara es `ec2 describe-volumes` (solo lectura). El resto de su
> trabajo es Athena `SELECT`.

### Palanca 6b — Snapshots EBS · Tarea 8.2 (`palanca-06b-snapshots.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 6b.1 | `aws ec2 describe-snapshots --owner-ids self` | `describe` | eu-west-1 | ✅ |
| 6b.2 | `aws ec2 describe-images --owners self` (snapshots que respaldan AMIs → no elegibles) | `describe` | eu-west-1 | ✅ |

### Palanca 6c — Volúmenes huérfanos · Tarea 8.3 (`palanca-06c-volumenes-huerfanos.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 6c.1 | `aws ec2 describe-volumes --filters Name=status,Values=available` | `describe` | eu-west-1 | ✅ |
| 6c.2 | `aws sts get-caller-identity` | `get` | eu-west-1 | ✅ |

### Palanca 7 — S3 lifecycle / Intelligent-Tiering · Tarea 9.2 (`palanca-07-s3.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 7.1 | `aws cloudwatch get-metric-statistics --metric-name BucketSizeBytes` (ranking) | `get` | eu-west-1 | ✅ |
| 7.2 | `aws s3api get-bucket-location` | `get` | región del bucket | ✅ |
| 7.3 | `aws s3api get-bucket-versioning` | `get` | región del bucket | ✅ |
| 7.4 | `aws s3api get-bucket-lifecycle-configuration` | `get` | región del bucket | ✅ |
| 7.5 | `aws s3api list-multipart-uploads` | `list` | eu-west-1 | ✅ |

### Palanca 8 — Red (NAT, VPN, EIP, VPC endpoints) · Tarea 10.2 (`palanca-08-red.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 8.1 | `aws ec2 describe-nat-gateways --filter Name=state,Values=available,pending,deleting` | `describe` | eu-west-1 | ✅ |
| 8.2 | `aws ec2 describe-addresses` (EIP sin asociar) | `describe` | eu-west-1 | ✅ |
| 8.3 | `aws ec2 describe-vpn-connections` | `describe` | eu-west-1 | ✅ |
| 8.4 | `aws ec2 describe-vpc-endpoints` | `describe` | eu-west-1 | ✅ |
| 8.5 | `aws ec2 describe-route-tables --filters Name=route.nat-gateway-id,...` (confirma NAT en uso) | `describe` | eu-west-1 | ✅ |
| 8.6 | `aws sts get-caller-identity` (13 cuentas) | `get` | eu-west-1 | ✅ |

### Palanca 9 — Rightsizing y Graviton · Tarea 11.2 (`palanca-09-rightsizing.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 9.1 | `aws ec2 describe-instances` | `describe` | eu-west-1 | ✅ |
| 9.2 | `aws cloudwatch get-metric-statistics --metric-name CPUUtilization` (p95 CPU parcial) | `get` | eu-west-1 | ✅ |
| 9.3 | `aws cloudwatch list-metrics --namespace CWAgent` (comprobar RAM) | `list` | eu-west-1 | ✅ |
| 9.4 | `aws sts get-caller-identity` | `get` | eu-west-1 | ✅ |
| 9.5 | PromQL `query` / `label values` contra Grafana Cloud (OpenCost/VPA/CloudWatch ingest) | `query` (lectura) | data plane Grafana Cloud | ✅ |

### Palanca 10 — Scheduling y Spot no-prod · Tarea 12.2 (`palanca-10-noprod-spot.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 10.1 | `aws sts get-caller-identity` (4 cuentas no-prod) | `get` | eu-west-1 | ✅ |
| 10.2 | `aws ec2 describe-instances` (tags entorno, lifecycle, 24/7) | `describe` | eu-west-1 | ✅ |

### Palanca 11 — Bedrock · Tarea 13.2 (`palanca-11-bedrock.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 11.1 | `aws sts get-caller-identity` (iskaypet-data, data-dev) | `get` | eu-west-1 | ✅ |
| 11.2 | `aws bedrock list-inference-profiles` | `list` | eu-west-1 (profile cross-region `eu.`) | ✅ |

### Palanca 12 — Contrato Marketplace · Tarea 14.1 (`palanca-12-marketplace.md`)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| — | **Sin `Verificacion_Recurso_Vivo`** (Palanca_Comercial; cargo contractual SaaS sin `resource_id`; Req 5 no aplica). Solo Athena `SELECT`. | — | — | n/a |

### Barridos (Tareas 16.1 / 16.2 / 16.3)

| # | Comando | Verbo | Región | R-O |
|--:|---------|-------|--------|:---:|
| 16.1 | `aws athena start-query-execution` (SELECT de barrido EC2/RDS) | SELECT (no mutante) | eu-west-1 | ✅ |
| 16.2 | PromQL `query` (`count(...)`, `quantile_over_time(...)`) contra Grafana Cloud Prometheus | `query` (lectura) | data plane Grafana Cloud | ✅ |
| 16.3 | `aws rds describe-db-clusters` | `describe` | eu-west-1 | ✅ |
| 16.3 | `aws cloudwatch get-metric-statistics` (DatabaseConnections, CPUUtilization Aurora) | `get` | eu-west-1 | ✅ |
| 16.1/16.3 | `aws athena start-query-execution` (SELECT) | SELECT (no mutante) | eu-west-1 | ✅ |

---

## 2. Auditoría (a) — todos los comandos son describe/list/get; ninguno es mutante

Recorridas las **17** fuentes y extraídos **todos** los comandos de los sub-registros de
`Verificacion_Recurso_Vivo`, el conjunto de verbos distintos observado es:

| Verbo / familia | Apariciones (palancas/barridos) | ¿Mutante? |
|-----------------|----------------------------------|:---------:|
| `ec2 describe-instances` | P1, P3*, P9, P10 | No |
| `ec2 describe-volumes` | P6a (pend.), P6c | No |
| `ec2 describe-snapshots` | P6b | No |
| `ec2 describe-images` | P6b | No |
| `ec2 describe-nat-gateways` | P8 | No |
| `ec2 describe-addresses` | P8 | No |
| `ec2 describe-vpn-connections` | P8 | No |
| `ec2 describe-vpc-endpoints` | P8 | No |
| `ec2 describe-route-tables` | P8 | No |
| `rds describe-db-instances` | P2, P3, P5 | No |
| `rds describe-reserved-db-instances` | P2 | No |
| `rds describe-db-clusters` | P5, B16.3 | No |
| `rds describe-db-major-engine-versions` | P3 | No |
| `rds describe-db-engine-versions` | P3 | No |
| `s3api get-bucket-location` / `get-bucket-versioning` / `get-bucket-lifecycle-configuration` | P7 | No |
| `s3api list-multipart-uploads` | P7 | No |
| `wafv2 list-logging-configurations` | P4 | No |
| `logs describe-log-groups` | P4 | No |
| `ce get-savings-plans-coverage` | P1 | No |
| `savingsplans describe-savings-plans` | P1 | No |
| `bedrock list-inference-profiles` | P11 | No |
| `cloudwatch get-metric-statistics` / `list-metrics` | P7, P9, B16.3 | No |
| `sts get-caller-identity` | P1, P2, P3, P4, P5, P6c, P8, P9, P10, P11 | No |
| PromQL `query` / `label values` (Grafana) | P9, B16.2 | No |
| `athena start-query-execution` (SELECT) | todas (acceso a coste) | No (ver §4) |

> `*` P3 usa `describe-db-instances` también; listado bajo RDS.

**Resultado (a):** el **100 %** de los comandos registrados pertenece al conjunto de solo lectura
(`describe`/`list`/`get` + SELECT de Athena + PromQL `query`). **No se detecta ningún** verbo mutante
(`create`/`delete`/`put`/`modify`/`update`/`terminate`/`run-instances`/`stop`/`start`/`reboot`/
`attach`/`detach`/`abort-multipart-upload`/`release-address`/`put-bucket-*`/`put-logging-configuration`/
`put-retention-policy`…) en ninguna de las 12 Palancas ni en los 3 barridos. Varios registros lo dejan
escrito explícitamente como salvaguarda (p. ej. P4 "no se ejecutó `put-logging-configuration`,
`delete-log-group`, `put-retention-policy`"; P7 "no `put-bucket-lifecycle-configuration`,
`abort-multipart-upload`, `delete-object`"; P2 "ninguna `create/modify/delete/reboot`"). **(a): PASA.**

---

## 3. Auditoría (b) — WAF/CloudFront verificados en `us-east-1` (Req 5.2, 11.2)

| Recurso global | Palanca | Comandos | Región ejecutada | Veredicto |
|----------------|---------|----------|------------------|:---------:|
| WAF de CloudFront (web ACLs `CLOUDFRONT`) + log groups WAF | **Palanca 4** | `wafv2 list-logging-configurations --scope CLOUDFRONT`, `logs describe-log-groups --log-group-name-prefix aws-waf-logs`, `sts get-caller-identity` | **`us-east-1`** (`--region us-east-1 --profile digital-ecommerce`) | ✅ |

- La Palanca 4 es la **única** con recurso global de CloudFront/WAF en todo el Estudio. Su
  `Verificacion_Recurso_Vivo` (Tarea 6.2, `id_evidencia` `EV-6.2-waf-cloudfront-live-2026-06-23`,
  `2026-06-23T08:50:59Z`) se ejecutó **en `us-east-1`**, donde el WAF de CloudFront (global) factura y
  registra — exactamente lo que exigen el Req 5.2 y el Req 11.2.
- El sub-registro consigna `region = us-east-1` y el `--scope CLOUDFRONT` confirma que se interroga el
  ámbito global, no el regional. Las 5 web ACLs de CloudFront y sus 5 log groups quedaron confirmados
  en `us-east-1`.
- Ninguna otra Palanca referencia recursos de CloudFront/WAF, por lo que `us-east-1` no aplica al
  resto (que opera correctamente en `eu-west-1`, o en la región del bucket para S3 — P7). El
  `design.md` lista esta excepción de región como caso límite explícito ("Verificación de WAF/CloudFront
  ejecutada en `us-east-1`, no en `eu-west-1`").

**Resultado (b): PASA.**

---

## 4. Auditoría (c) — credenciales por nombre de perfil/secret, nunca incrustadas (Req 7.5)

| Mecanismo | Dónde | Forma de referencia | Veredicto |
|-----------|-------|---------------------|:---------:|
| SSO SRE por cuenta | P1–P11 (AWS CLI) | `--profile <nombre>` (`root-iskaypet`, `helios-dev`, `digital-ecommerce`, `eks-*`, etc.); rol `AWSReservedSSO_SRE_*` | ✅ sin incrustar |
| Athena / CUR | todas | perfil `root-iskaypet` (rol `Cur-AWSS3CURLambdaExecutor`) por nombre | ✅ sin incrustar |
| Token Grafana Cloud | P9 (11.2), B16.2 | leído de secret `kiro-grafana-cloud` (ns `n8n`, dp-tooling) vía `kubectl ... | base64 -d` a variable `TOKEN`; **no impreso en claro** | ✅ sin incrustar |

- Todos los comandos AWS referencian las credenciales **por nombre de perfil** (SSO SRE) o por rol; no
  hay claves de acceso, secretos ni tokens literales en ningún registro.
- Las sondas PromQL (P9/16.2) usan un token de Grafana Cloud **leído de un secret de Kubernetes** y
  pasado por variable de entorno, con la nota explícita de "sin incrustar tokens" (Req 7.5). El propio
  ejemplo re-ejecutable muestra `TOKEN=$(kubectl ... | base64 -d)`, no el valor.
- La identidad efectiva se prueba con `sts get-caller-identity` (solo lectura), no exponiendo secretos.

**Resultado (c): PASA.**

### Nota sobre `athena start-query-execution` (acceso a coste, no mutación de recursos)

El verbo `start-query-execution` no es `describe/list/get`, pero **no es una operación mutante** sobre
el patrimonio de recursos AWS: ejecuta exclusivamente sentencias `SELECT` contra
`athenacurcfn_finnops.data` (CUR 2.0) y su único efecto de escritura es depositar el resultado de la
consulta en el bucket de resultados designado (`s3://finnops-iskaypet/athena-query-results/`), que es
el comportamiento estándar e inevitable de Athena. No crea, modifica ni elimina ningún recurso del
alcance del Estudio. Por eso queda **fuera** del ámbito de Property 11 (que aplica a la
`Verificacion_Recurso_Vivo` del recurso) y se clasifica como **acceso de lectura al plano de coste**,
consistente con el principio "CUR para coste, AWS en vivo para existencia" del `design.md`. Se
documenta aquí para que el inventario sea exhaustivo y honesto.

---

## 5. Resultado de la auditoría

| Sub-comprobación | Alcance | Veredicto |
|------------------|---------|:---------:|
| (a) Todos los comandos de verificación son `describe`/`list`/`get`; ninguno mutante | 12 Palancas + 3 barridos; ~25 verbos distintos | **PASA** |
| (b) WAF/CloudFront verificados en `us-east-1` (Req 5.2, 11.2) | Palanca 4 (única con recurso global) | **PASA** |
| (c) Credenciales por perfil/secret, nunca incrustadas (Req 7.5) | Todas las verificaciones (AWS CLI + PromQL) | **PASA** |
| **Property 11 — Verificación estrictamente de solo lectura** | Conjunto completo de `Verificacion_Recurso_Vivo` del Estudio | **PASA** |

**Conclusión.**

- **Property 11 — PASA.** Todos los comandos registrados en las `Verificacion_Recurso_Vivo` del
  Estudio (Palancas 1–11; la Palanca 12 no tiene verificación por ser comercial; barridos 16.1–16.3)
  pertenecen al conjunto de solo lectura `describe`/`list`/`get` (más `sts get-caller-identity`,
  `ce get-savings-plans-coverage`, `cloudwatch get-metric-statistics`/`list-metrics`, `s3api get-*`/
  `list-*`, PromQL `query`). **No se detecta ni un solo verbo mutante.**
- **WAF/CloudFront (Req 5.2, 11.2): PASA.** La única verificación de recurso global (Palanca 4, WAF de
  CloudFront) se ejecutó en **`us-east-1`** con `--scope CLOUDFRONT`.
- **Credenciales (Req 7.5): PASA.** Todas se referencian por **nombre de perfil/rol** o se leen de un
  **secret** (token Grafana); ninguna está incrustada en los registros.
- El acceso al plano de coste (`athena start-query-execution` con `SELECT`) no es una operación mutante
  y queda fuera del ámbito de Property 11 (§4); se inventaría por exhaustividad.

---

## 6. Re-ejecución de la auditoría (procedimiento)

Auditoría **re-ejecutable**; debe reproducir el mismo veredicto mientras los registros sigan anclados
a `frozen-2026-05@2026-06-23`:

1. Para cada `evidencias/palanca-*.md` y `evidencias/barrido-16-*.md`, localizar los bloques de
   `Verificacion_Recurso_Vivo` y extraer cada comando AWS CLI / PromQL (campos `comando` / `metodo` /
   bloques ```bash```).
2. Clasificar el verbo de cada comando contra el criterio cerrado del encabezado (solo lectura vs
   mutante). Marcar cualquier `create`/`update`/`delete`/`modify`/`put`/`terminate`/`run`/`stop`/
   `start-instances`/`reboot`/`attach`/`detach`/`abort-*`/`release-*` como **violación**.
3. Confirmar que toda verificación de WAF/CloudFront declara `region = us-east-1` y `--scope CLOUDFRONT`
   (Palanca 4).
4. Confirmar que ningún comando incrusta credenciales/tokens: deben aparecer `--profile <nombre>` o
   lectura de secret (`kubectl ... | base64 -d`), nunca claves/tokens literales.
5. Tratar `athena start-query-execution` como acceso de lectura al plano de coste (SELECT) — no
   mutante, fuera del ámbito de Property 11.

Cualquier comando mutante, una verificación de WAF/CloudFront fuera de `us-east-1`, o una credencial
incrustada constituiría una violación de Property 11 y debe corregirse antes de publicar el Informe.

## 7. Estado de ejecución

- ✅ **Ejecutada** la auditoría 17.7 sobre los sub-registros de `Verificacion_Recurso_Vivo` de las 12
  Palancas y los 3 barridos, anclados a `frozen-2026-05@2026-06-23`.
- ✅ **(a) Solo lectura — PASA:** ~25 verbos distintos, todos `describe`/`list`/`get` (+ SELECT Athena
  + PromQL query); **0 verbos mutantes**.
- ✅ **(b) WAF/CloudFront en `us-east-1` — PASA:** Palanca 4 (única con recurso global) verificada en
  `us-east-1` con `--scope CLOUDFRONT`.
- ✅ **(c) Credenciales no incrustadas — PASA:** referenciadas por perfil SSO/rol o leídas de secret.
- ✅ **Property 11 — PASA** (sin observaciones).
