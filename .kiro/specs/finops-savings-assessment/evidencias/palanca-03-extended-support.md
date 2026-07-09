# Registro Palanca 3 — Extended Support de motores EOL (RDS)

> **Tarea 5.1** — Ejecutar la consulta CUR de Extended Support y **congelar la cifra**.
> Artefacto auditable del Estudio FinOps de Ahorro AWS. Sigue el esquema completo del
> `Catálogo_Evidencias`. Las cifras quedan ancladas al `Dataset_Congelado`
> `frozen-2026-05@2026-06-23` (mayo 2026, USD).
>
> **Alcance de esta tarea (5.1):** cuantificar el coste total de RDS Extended Support del
> Mes_Referencia agregado a todas las cuentas, desglosarlo por tramo de precio anual
> (Año 1–2 vs Año 3) y listar por recurso (`line_item_resource_id`, cuenta). La
> `Verificacion_Recurso_Vivo` por instancia (id/motor/versión/fin de soporte) es la Tarea 5.2;
> la clasificación **Garantizado condicionado** y la documentación de la Palanca es la Tarea 5.3.
>
> **Validates: Requirements 9.1, 9.2, 2.2, 2.3**

---

## Parámetros del Dataset_Congelado (anclaje — Req 2.1, 2.5)

| Campo | Valor |
|-------|-------|
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23T08:10:33Z` (UTC) — ejecución de esta tarea |
| Moneda | `USD` |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |

## Cadena de acceso a datos (reproducibilidad — Req 7.1, 7.2)

| Parámetro | Valor |
|-----------|-------|
| Motor | Amazon Athena (CUR 2.0) |
| Base de datos / tabla | `athenacurcfn_finnops` / `data` |
| Región | `eu-west-1` |
| Cuenta CUR | `600700800900` (root-iskaypet) |
| Rol de acceso | `Cur-AWSS3CURLambdaExecutor` (perfil `root-iskaypet`) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |

---

## Consulta CUR exacta (re-ejecutable)

**Consulta 1 — Total + desglose por recurso y tramo de precio anual** (la del `design.md`,
ampliada con `line_item_usage_type` para el tramo y `line_item_usage_amount` para vCPU-horas):

```sql
SELECT line_item_usage_account_id    AS account,
       line_item_resource_id         AS resource,
       line_item_usage_type          AS usage_type,
       SUM(line_item_unblended_cost) AS extended_support_cost,
       SUM(line_item_usage_amount)   AS usage_amount,
       COUNT(*)                      AS line_items
FROM data
WHERE line_item_product_code = 'AmazonRDS'
  AND line_item_usage_type LIKE '%ExtendedSupport%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

**Consulta 2 — Reconciliación bruto/neto por tipo de línea** (separa el `Usage` facturado del
`SppDiscount` aplicado, para fijar el bruto y el neto sin ambigüedad):

```sql
SELECT line_item_usage_type              AS usage_type,
       line_item_line_item_type          AS li_type,
       SUM(line_item_unblended_cost)     AS unblended,
       SUM(line_item_net_unblended_cost) AS net_unblended,
       COUNT(*)                          AS line_items
FROM data
WHERE line_item_product_code = 'AmazonRDS'
  AND line_item_usage_type LIKE '%ExtendedSupport%'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2
ORDER BY 1, 2;
```

**Consulta 3 — Atribución limpia por recurso** (`li_type = 'Usage'`, para que el reparto por
recurso no se mezcle con el `SppDiscount` que llega sin `resource_id`):

```sql
SELECT line_item_usage_account_id        AS account,
       line_item_resource_id             AS resource,
       line_item_usage_type              AS usage_type,
       SUM(line_item_unblended_cost)     AS unblended,
       SUM(line_item_net_unblended_cost) AS net_unblended,
       SUM(line_item_usage_amount)       AS usage_hours
FROM data
WHERE line_item_product_code = 'AmazonRDS'
  AND line_item_usage_type LIKE '%ExtendedSupport%'
  AND line_item_line_item_type = 'Usage'
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

## Comando de ejecución re-ejecutable (Athena vía AWS CLI — credenciales por nombre de perfil, Req 7.2, 7.5)

```bash
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "<Consulta 1 / 2 / 3 de arriba, en una sola línea>" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

`QueryExecutionId` de las ejecuciones congeladas (estado `SUCCEEDED`):

| Consulta | `QueryExecutionId` |
|----------|--------------------|
| Consulta 1 — recurso + tramo | `9eb416e1-209d-4be1-ae8e-b508b20dbe55` |
| Consulta 2 — bruto/neto por tipo de línea | `5d0b789f-360a-4022-9988-f6a394b585aa` |
| Consulta 3 — atribución limpia por recurso | `c31c555e-1d19-439c-a5d1-6f70dc1f97d7` |

---

## Cifra congelada — total agregado a todas las cuentas (Req 9.1)

| Medida | Importe mensual (USD) | Origen |
|--------|----------------------:|--------|
| **Coste bruto** (`Usage`, unblended) | **1 169,52** | Consulta 2 (`li_type='Usage'`) |
| Descuento SPP (`SppDiscount`, unblended) | **−93,56** | Consulta 2 (`li_type='SppDiscount'`) |
| **Coste neto** (`net_unblended`) | **1 075,96** | Consulta 2 (`net_unblended` del `Usage`; el `SppDiscount` ya está incorporado, su `net_unblended = 0,00`) |

> El `design.md` cita **$1.17k/mes** como ejemplo trabajado: corresponde al **bruto** (`1 169,52`),
> que esta extracción confirma exactamente. La cifra de ahorro de la Palanca es el coste íntegro
> de Extended Support eliminable al actualizar el motor; se reporta bruto y neto para trazabilidad
> contable (el descuento SPP es un acuerdo transversal, no propio de esta partida).

**Reconciliación contable:** `1 169,52 (bruto) − 93,56 (SPP) = 1 075,96 (neto)` ✅ (cuadra con el
`net_unblended` del `Usage` de la Consulta 2; sumas calculadas **antes** de redondear half-up, Req 6.7).

**Anualización (Req 6.3, con advertencia de Req 6.4):**

| Medida | Mensual (USD) | Anualizada ×12 (USD) |
|--------|--------------:|---------------------:|
| Bruto | 1 169,52 | **14 034,20** |
| Neto | 1 075,96 | **12 911,46** |

> ⚠️ **Advertencia de anualización (Req 6.4):** la cifra anual = mensual × 12 asume que el
> Mes_Referencia (mayo 2026) es representativo y **no captura estacionalidad** ni cambios de
> inventario (altas/bajas de instancias EOL, salto de tramo Año 2→Año 3). El cómputo definitivo del
> ahorro y su clasificación se cierran en la Tarea 5.3.

---

## Desglose por tramo de precio anual (Req 9.2)

Todas las partidas del Mes_Referencia están en el **mismo** tipo de uso:
`EU-ExtendedSupport:Yr1-Yr2:PostgreSQL13`.

| Tramo de precio anual | Tipo de uso CUR | Coste bruto (USD) | Coste neto (USD) | vCPU-horas | % del total |
|-----------------------|-----------------|------------------:|-----------------:|-----------:|------------:|
| **Año 1 – Año 2** | `EU-ExtendedSupport:Yr1-Yr2:PostgreSQL13` | **1 169,52** | **1 075,96** | 11 184,11 | **100,0 %** |
| **Año 3** | `*:Yr3:*` | **0,00** | **0,00** | 0,00 | **0,0 %** |

> **Hallazgo:** en mayo 2026 el **100 %** del Extended Support está en el tramo **Año 1–Año 2**
> (PostgreSQL 13 entró en Extended Support en su EOL estándar). **No hay** cargo de **Año 3** todavía,
> cuyo precio por vCPU-hora se duplica. Implicación de negocio: existe una **ventana** para migrar
> el motor antes de que el inventario salte al tramo Año 3 y el coste de esta Palanca se duplique.
>
> **Tarifa observada (derivada del CUR):** `1 169,52 / 11 184,11 ≈ 0,1046 USD/vCPU-hora` bruto
> (las partidas de cuenta completa dan exactamente `0,112 USD/vCPU-hora`, p. ej.
> `333,312 / 2 976 = 0,112` y `166,656 / 1 488 = 0,112`; la media baja por las cuentas dev/uat con
> horas fraccionadas). El tramo Año 3 facturaría aproximadamente al doble.

---

## Lista por recurso (Req 2.2, 2.3, 9.1 — `line_item_resource_id` reales)

**Dimensión de agregación (Req 2.3):** `line_item_resource_id` × `line_item_usage_account_id`;
valor = `SUM(line_item_unblended_cost)` y `SUM(line_item_net_unblended_cost)` (atribución limpia
`li_type='Usage'`, Consulta 3). Todos los recursos: motor **PostgreSQL 13**, tramo **Año 1–Año 2**.

| # | Cuenta (ID) | Nombre cuenta (perfil) | `line_item_resource_id` | Bruto (USD) | Neto (USD) | vCPU-horas |
|---|-------------|------------------------|--------------------------|------------:|-----------:|-----------:|
| 1 | 111222333444 | Digital Prod (digital-prod) | `arn:aws:rds:eu-west-1:111222333444:db:payments-api` | 333,31 | 306,65 | 2 976,00 |
| 2 | 111222333444 | Digital Prod (digital-prod) | `arn:aws:rds:eu-west-1:111222333444:db:oms` | 333,31 | 306,65 | 2 976,00 |
| 3 | 444455556666 | EKS Tooling (dp-tooling) | `arn:aws:rds:eu-west-1:444455556666:db:postgres-oms-general` | 166,66 | 153,32 | 1 488,00 |
| 4 | 999900001111 | Digital Dev (digital-dev) | `arn:aws:rds:eu-west-1:999900001111:db:payments-api` | 86,31 | 79,40 | 770,62 |
| 5 | 999900001111 | Digital Dev (digital-dev) | `arn:aws:rds:eu-west-1:999900001111:db:oms` | 86,29 | 79,39 | 770,44 |
| 6 | 000011112222 | Digital UAT (digital-uat) | `arn:aws:rds:eu-west-1:000011112222:db:oms` | 81,82 | 75,28 | 730,56 |
| 7 | 000011112222 | Digital UAT (digital-uat) | `arn:aws:rds:eu-west-1:000011112222:db:payments-api` | 81,82 | 75,27 | 730,50 |
| | | | **Σ recursos (bruto)** | **1 169,52** | **1 075,96** | **11 184,11** |

`recurso_ids` (lista explícita, Req 2.2):

```json
[
  "arn:aws:rds:eu-west-1:111222333444:db:payments-api",
  "arn:aws:rds:eu-west-1:111222333444:db:oms",
  "arn:aws:rds:eu-west-1:444455556666:db:postgres-oms-general",
  "arn:aws:rds:eu-west-1:999900001111:db:payments-api",
  "arn:aws:rds:eu-west-1:999900001111:db:oms",
  "arn:aws:rds:eu-west-1:000011112222:db:oms",
  "arn:aws:rds:eu-west-1:000011112222:db:payments-api"
]
```

> **Cobertura de cuentas (Req 9.1):** el Extended Support está concentrado en **4 cuentas** del
> alcance (`digital-prod`, `dp-tooling`, `digital-dev`, `digital-uat`) y **7 instancias RDS**, todas
> **PostgreSQL 13**. Coincide con el ejemplo trabajado del `design.md`. Las demás ~26 cuentas del
> alcance no presentan partidas `%ExtendedSupport%` en el Mes_Referencia (coste 0,00 USD para esta
> Palanca). El patrón es claro: el par **oms + payments-api** repetido en prod/dev/uat de Digital,
> más el `postgres-oms-general` de tooling.

---

## Registro de evidencia (esquema completo del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-5.1-extended-support-2026-05` |
| `descripcion` | Coste de RDS Extended Support (motores EOL) del Mes_Referencia, agregado a todas las cuentas, desglosado por tramo de precio anual y atribuido por recurso |
| `cifra_publicada` | Bruto `1 169,52 USD/mes` · Neto `1 075,96 USD/mes` (SPP `−93,56`) · Anualizado bruto `14 034,20 USD` / neto `12 911,46 USD` · Tramo: 100 % Año 1–2, Año 3 = `0,00 USD` |
| `consulta_cur` | Consultas 1, 2 y 3 de este registro |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T08:10:33Z` (UTC) |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | Lista de 7 ARNs RDS (ver bloque JSON arriba) — cifra **atribuible a recurso** (Req 2.2) |
| `dimension_agregacion` | `line_item_resource_id` × `line_item_usage_account_id` × `line_item_usage_type`; valor = `SUM(line_item_unblended_cost)` / `SUM(line_item_net_unblended_cost)` |
| `verificacion_vivo` | `pendiente` — `rds describe-db-instances` por instancia (id, motor, versión, fin de soporte estándar) se ejecuta en la **Tarea 5.2** (Req 5.1, 9.3) |
| `clasificacion` | Cifra base de coste de la Palanca 3. La clasificación de ahorro (**Garantizado condicionado** a upgrade de motor) se fija en la **Tarea 5.3** (Req 3.1, 9.4–9.6) |

---

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23` el `2026-06-23T08:10:33Z`.
- Cifras congeladas y reproducibles: re-ejecutar las Consultas 1/2/3 documentadas sobre el mismo
  Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría en
  Tarea 17.6).
- **Pendiente (fuera del alcance de la Tarea 5.1):** `Verificacion_Recurso_Vivo` por instancia
  (Tarea 5.2) y clasificación + documentación de la Palanca (Tarea 5.3).
```

---

# Sub-registro — Verificacion_Recurso_Vivo por instancia (Tarea 5.2)

> **Tarea 5.2** — `Verificacion_Recurso_Vivo` de **solo lectura** por instancia EOL identificada en la
> Tarea 5.1. Registra por instancia: id, cuenta, motor, versión y **fecha de fin de soporte estándar**,
> más estado y marca temporal UTC. Operaciones exclusivamente `describe` (read-only); ninguna mutante.
>
> **Validates: Requirements 5.1, 9.3**

## Parámetros de la verificación (Req 5.5, 7.2, 7.5)

| Campo | Valor |
|-------|-------|
| Tipo de operación | **Solo lectura** (`rds describe-db-instances`, `rds describe-db-major-engine-versions`, `rds describe-db-engine-versions`) — ninguna mutante (Property 11) |
| Región consultada | `eu-west-1` (todas las instancias del alcance de la Palanca 3) |
| Fecha-hora de la verificación (UTC) | `2026-06-23T08:54:09Z` |
| Credenciales | SSO SRE por cuenta (rol `AWSReservedSSO_SRE`), referenciadas por **nombre de perfil**; sin credenciales incrustadas (Req 7.5) |
| Perfiles usados | `digital-prod` (111222333444), `eks-tooling` (444455556666), `digital-dev` (999900001111), `digital-uat` (000011112222) |
| Sesiones SSO | Activas y verificadas con `sts get-caller-identity` en las 4 cuentas (rol `AWSReservedSSO_SRE`, usuario `ruben.landin@emefinpetcare.com`) |

## Comandos re-ejecutables (solo lectura, Req 7.2, 7.5)

```bash
# 1) Estado vivo de cada instancia EOL (id, motor, versión, estado, MultiAZ) — por cuenta
aws rds describe-db-instances --profile <perfil> --region eu-west-1 \
  --query "DBInstances[].{id:DBInstanceIdentifier,engine:Engine,ver:EngineVersion,status:DBInstanceStatus,multiAz:MultiAZ}" \
  --output table
#   perfiles: digital-prod (oms, payments-api), eks-tooling (postgres-oms-general),
#             digital-dev (oms, payments-api), digital-uat (oms, payments-api)

# 2) Fecha de fin de soporte ESTÁNDAR (autoritativa, del propio API de RDS) para PostgreSQL 13
aws rds describe-db-major-engine-versions --profile digital-prod --region eu-west-1 \
  --engine postgres --major-engine-version 13 \
  --query "DBMajorEngineVersions[0].SupportedEngineLifecycles" --output json

# 3) Confirmación del estado del minor 13.20 (deprecated)
aws rds describe-db-engine-versions --profile digital-prod --region eu-west-1 \
  --engine postgres --engine-version 13.20 --include-all \
  --query "DBEngineVersions[0].{ver:EngineVersion,status:Status}" --output json
```

## Fechas de soporte del motor PostgreSQL 13 (origen autoritativo: API de RDS, Req 9.3)

El propio API de RDS (`describe-db-major-engine-versions`, solo lectura) devuelve el ciclo de vida del
motor —no es un dato del `describe-db-instances`, sino del catálogo de versiones de RDS—:

| Fase de soporte | `LifecycleSupportName` | Inicio (UTC) | **Fin (UTC)** |
|-----------------|------------------------|--------------|---------------|
| **Soporte estándar** | `open-source-rds-standard-support` | `2021-02-24T00:00:00Z` | **`2026-02-28T23:59:59.999Z`** |
| Extended Support | `open-source-rds-extended-support` | `2026-03-01T00:00:00Z` | `2029-02-28T23:59:59.999Z` |

- **Fecha de fin de soporte estándar de PostgreSQL 13 = 2026-02-28** (28 feb 2026). Coincide con el
  anuncio público de AWS ("Amazon RDS PostgreSQL 13.x end of standard support is February 28, 2026").
  *Contenido reformulado por cumplimiento de licencias.*
  Fuente: [AWS re:Post — fin de soporte estándar RDS PostgreSQL 13](https://repost.aws/articles/ARRvHxJ_9sTDCGloBavca3kg/announcement-amazon-rds-postgresql-13-x-end-of-standard-support-is-february-28-2026).
- El minor `13.20` figura con `Status = deprecated` en el catálogo vivo de RDS (confirmado por API).
- Extended Support Año 1–2 corre **2026-03-01 → 2028-02-28**; Año 3 **2028-03-01 → 2029-02-28**. Coherente
  con el hallazgo de la Tarea 5.1: en el Mes_Referencia (mayo 2026) el 100 % del cargo está en el tramo
  **Año 1–Año 2** (`EU-ExtendedSupport:Yr1-Yr2:PostgreSQL13`).

## Resultado por instancia (Req 9.3, 5.5)

Verificación en vivo `2026-06-23T08:54:09Z` (UTC). Las 7 instancias de la Tarea 5.1, en `eu-west-1`:

| # | Cuenta (ID) | Perfil | Instancia (`DBInstanceIdentifier`) | Motor | Versión **viva** | Versión en `frozen-2026-05` | Estado vivo RDS | Fin soporte estándar | **Estado verificación** |
|---|-------------|--------|-------------------------------------|-------|------------------|------------------------------|-----------------|----------------------|--------------------------|
| 1 | 111222333444 | digital-prod | `oms` | postgres | **13.20** | 13 (EOL) | `available` (MultiAZ) | 2026-02-28 | **confirmado** (sigue PG13, Extended Support vigente) |
| 2 | 111222333444 | digital-prod | `payments-api` | postgres | **13.20** | 13 (EOL) | `available` (MultiAZ) | 2026-02-28 | **confirmado** (sigue PG13, Extended Support vigente) |
| 3 | 444455556666 | eks-tooling (dp-tooling) | `postgres-oms-general` | postgres | **13.20** | 13 (EOL) | `available` | 2026-02-28 | **confirmado** (sigue PG13, Extended Support vigente) |
| 4 | 999900001111 | digital-dev | `oms` | postgres | **18.4** | 13 (EOL) | `available` | (soporte estándar) | **drift** — ya actualizada a PG18.4 (ver nota) |
| 5 | 999900001111 | digital-dev | `payments-api` | postgres | **18.4** | 13 (EOL) | `available` | (soporte estándar) | **drift** — ya actualizada a PG18.4 (ver nota) |
| 6 | 000011112222 | digital-uat | `oms` | postgres | **18.4** | 13 (EOL) | `available` | (soporte estándar) | **drift** — ya actualizada a PG18.4 (ver nota) |
| 7 | 000011112222 | digital-uat | `payments-api` | postgres | **18.4** | 13 (EOL) | `available` | (soporte estándar) | **drift** — ya actualizada a PG18.4 (ver nota) |

> Las 7 instancias **existen** y están `available` en `eu-west-1` (existencia confirmada para las 7,
> Req 5.1). La característica asumida en el `Dataset_Congelado` (motor **PostgreSQL 13 EOL**) se mantiene
> en **3 de 7** (las de prod/tooling); en las **4** de dev/uat el motor ya está en **PostgreSQL 18.4**.

## Nota de drift del recurso vivo (Req 7.6) — hallazgo clave

Entre la fecha de extracción del `Dataset_Congelado` (`frozen-2026-05@2026-06-23`, Mes_Referencia mayo
2026) y esta verificación en vivo (`2026-06-23T08:54:09Z`), **4 de las 7** instancias EOL han sido
**actualizadas de PostgreSQL 13 a PostgreSQL 18.4**: las parejas `oms` + `payments-api` de **digital-dev**
y **digital-uat**. Este **drift es esperado y NO invalida** las cifras de coste ancladas al
`Dataset_Congelado` (Req 7.6): esas 4 instancias **sí** incurrieron en Extended Support durante mayo 2026
(coste congelado válido), pero a fecha de verificación su cargo de Extended Support **ya está
eliminándose** porque el motor dejó de ser EOL.

Implicaciones (a desarrollar en la Tarea 5.3, no aquí):

- **Sigue siendo EOL / sigue pagando Extended Support (3 instancias):** `digital-prod:oms`,
  `digital-prod:payments-api`, `dp-tooling:postgres-oms-general`. Son el objetivo real de la Palanca a
  fecha de verificación. Coste vivo asociado (atribución limpia Tarea 5.1): `333,31 + 333,31 + 166,66 =
  833,28 USD/mes` bruto (resto de cifras en la Tarea 5.1).
- **Ya remediado (4 instancias dev/uat):** `digital-dev:{oms,payments-api}`,
  `digital-uat:{oms,payments-api}` → motor PG18.4, fuera de Extended Support. Coste mayo 2026 asociado:
  `86,31 + 86,29 + 81,82 + 81,82 = 336,24 USD/mes` bruto, que se extingue tras la migración.
- Para la **clasificación de ahorro** (Tarea 5.3): el ahorro *futuro* de la Palanca se concentra en las 3
  instancias prod/tooling aún en PG13; la porción dev/uat ya está capturada por las migraciones recientes.
  La cifra base de la Palanca permanece anclada a mayo 2026 (Req 7.6); el ajuste por drift se documenta en
  la 5.3.

## Registro de evidencia (esquema del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-5.2-extended-support-verificacion-viva-2026-06-23` |
| `descripcion` | `Verificacion_Recurso_Vivo` de solo lectura de las 7 instancias RDS EOL de la Palanca 3: id, cuenta, motor, versión viva y fin de soporte estándar |
| `tipo` | `Verificacion_Recurso_Vivo` (solo lectura; no atribuible a coste — la cifra de coste vive en `EV-5.1-...`) |
| `comandos` | `rds describe-db-instances`, `rds describe-db-major-engine-versions`, `rds describe-db-engine-versions` (bloque "Comandos re-ejecutables") |
| `region_consultada` | `eu-west-1` |
| `fecha_hora_utc` | `2026-06-23T08:54:09Z` |
| `cuentas_consultadas` | `111222333444` (digital-prod), `444455556666` (dp-tooling), `999900001111` (digital-dev), `000011112222` (digital-uat) |
| `estado` | **confirmado** para 3/7 (prod/tooling, siguen PG13 EOL); **drift confirmado** para 4/7 (dev/uat ya en PG18.4, existencia confirmada, característica EOL ya no aplica) |
| `recurso_ids` | Los 7 ARNs de la Tarea 5.1 (`EV-5.1-...`) |
| `fin_soporte_estandar_pg13` | `2026-02-28T23:59:59.999Z` (autoritativo, API RDS `describe-db-major-engine-versions`) |
| `drift` | 4 instancias dev/uat actualizadas PG13→PG18.4 entre el congelado (mayo 2026) y la verificación; esperado, no invalida el coste congelado (Req 7.6) |
| `vinculo` | Cifra de coste y lista de recursos: `EV-5.1-extended-support-2026-05`. Clasificación (**Garantizado condicionado**) y ajuste por drift: **Tarea 5.3** |

## Estado de ejecución

- ✅ **Ejecutado** el `2026-06-23T08:54:09Z` (UTC). Existencia confirmada de las 7 instancias en
  `eu-west-1`; motor/versión/estado capturados por `describe-db-instances`; fin de soporte estándar
  capturado del API autoritativo `describe-db-major-engine-versions` (PG13 → `2026-02-28`).
- ✅ **Solo lectura** verificada: los 3 comandos usados son `describe-*` (read-only); ninguna operación
  mutante (cumple Property 11 / Req 5.1, 7.5).
- ⚠️ **Drift detectado** (Req 7.6): 4/7 instancias ya migradas a PG18.4 (dev/uat); 3/7 siguen en PG13
  (prod/tooling). No invalida las cifras de coste de la Tarea 5.1 ancladas a `frozen-2026-05@2026-06-23`.
- **Pendiente (fuera del alcance de la 5.2):** clasificación **Garantizado condicionado**, esfuerzo de
  migración, riesgo y owner, además del ajuste por drift → **Tarea 5.3** (Req 3.1, 9.4–9.6).

---

# Sub-registro — Clasificación y documentación de la Palanca (Tarea 5.3)

> **Tarea 5.3** — Clasificar la eliminación del Extended Support como **Garantizado condicionado** a
> la actualización de motor y a la validación previa de compatibilidad de la aplicación con la versión
> destino. Incorporar el **drift** de la Tarea 5.2: el ahorro *futuro* de la Palanca se concentra en las
> **3 instancias prod/tooling** aún en PG13 (`833,28 USD/mes` bruto); la porción dev/uat ya está
> capturada por las migraciones recientes a PG18.4. Si un upgrade está **bloqueado** por dependencia,
> excluirlo de Garantizado, reclasificarlo como no realizable a corto plazo e identificar la dependencia.
> Documentar esfuerzo de migración, riesgo (alto, compatibilidad de aplicación) y owner ("pendiente",
> Digital).
>
> **Validates: Requirements 3.1, 9.4, 9.5, 9.6, 4.4, 4.5, 4.6, 4.7**

## Clasificación de la Palanca (Req 3.1, 9.4, 9.5)

**Clasificación: Ahorro_Garantizado condicionado.** El Extended Support es **desperdicio puro**
(IskayPet paga por *no* migrar; la eliminación del cargo no implica pérdida de capacidad), por lo que
cumple la definición de Ahorro_Garantizado del `design.md`. No obstante, su realización **no es
incondicional**: está **condicionada** a dos pasos previos, ambos exigidos por el Req 9.4/9.5:

1. **Actualización del motor** PostgreSQL 13 → versión con soporte estándar (PG15/16/… o el PG18.4 ya
   adoptado en dev/uat). Al dejar de ser EOL, el cargo `%ExtendedSupport%` desaparece por completo (Req 9.4).
2. **Validación previa de compatibilidad de la aplicación** con la versión destino (Req 9.5). El salto es
   de varias versiones mayores (13 → 18.x), por lo que requiere prueba funcional de `oms` y `payments-api`
   contra el motor nuevo antes del corte en producción.

Por ese condicionamiento la Palanca se etiqueta **Garantizado\*** (asterisco = condicionado) en la tabla
del Informe, distinguiéndola de los Garantizado incondicionales (p. ej. volúmenes EBS huérfanos confirmados).

### Evaluación de bloqueo por dependencia (Req 9.6)

**No se identifica ninguna dependencia bloqueante a fecha de verificación.** La evidencia que lo
respalda es el propio **drift** de la Tarea 5.2: las **4 instancias dev/uat** (`digital-dev:{oms,
payments-api}`, `digital-uat:{oms,payments-api}`) **ya fueron actualizadas con éxito de PG13 a PG18.4**
entre el `Dataset_Congelado` (mayo 2026) y la verificación viva (`2026-06-23`). Eso demuestra que:

- la **ruta de migración existe y es viable** (mismo par de servicios `oms`+`payments-api`, misma familia
  de motor) y **no está bloqueada** por ninguna dependencia técnica de la aplicación;
- las **3 instancias prod/tooling** restantes son el **mismo software** que las dev/uat ya migradas, luego
  su upgrade es replicable.

En consecuencia, las 3 instancias prod/tooling **permanecen en Ahorro_Garantizado condicionado** (no se
excluyen ni se reclasifican como no realizable a corto plazo). Se deja registrada la **regla del Req 9.6**
para futuras re-ejecuciones: *si* en el momento de planificar el upgrade de cualquiera de las 3 instancias
apareciera una dependencia bloqueante (p. ej. una librería/driver de la aplicación incompatible con la
versión destino, una extensión PostgreSQL no soportada, o una ventana de mantenimiento prod no
autorizable), esa instancia **se excluiría de Ahorro_Garantizado**, se **reclasificaría como ahorro no
realizable a corto plazo** y se **identificaría la dependencia** en este registro.

| Dependencia evaluada | ¿Bloquea hoy? | Evidencia |
|----------------------|---------------|-----------|
| Compatibilidad de la aplicación con la versión destino | **No** | dev/uat (mismo `oms`+`payments-api`) ya corren PG18.4 `available` (Tarea 5.2) |
| Disponibilidad de ruta de upgrade del motor | **No** | upgrade PG13→PG18.4 ya ejecutado en 4 instancias |
| Ventana de mantenimiento en prod (MultiAZ) | Pendiente de planificación (no bloqueante, afecta a esfuerzo/riesgo, no a realizabilidad) | `oms` y `payments-api` de prod son `MultiAZ` (Tarea 5.2) |

> Si alguna fila pasara a "Sí bloquea", aplicar el Req 9.6 sobre la instancia afectada y restar su coste
> del Ahorro_Garantizado de la Palanca.

## Incorporación del drift de la Tarea 5.2 — ahorro futuro vs ya capturado (Req 7.6)

La cifra **base** de la Palanca permanece anclada al `Dataset_Congelado` `frozen-2026-05@2026-06-23`
(`1 169,52 USD/mes` bruto sobre 7 instancias; el drift **no** la invalida, Req 7.6). Para la
**clasificación de ahorro**, el drift reparte ese coste base en dos porciones de naturaleza distinta:

| Porción | Instancias | Estado motor (vivo) | Bruto (USD/mes) | Neto (USD/mes) | Naturaleza del ahorro |
|---------|-----------|---------------------|----------------:|---------------:|------------------------|
| **Ahorro futuro de la Palanca** | `digital-prod:oms`, `digital-prod:payments-api`, `dp-tooling:postgres-oms-general` | PG13 (EOL, sigue pagando) | **833,28** | **766,62** | **Garantizado condicionado** — objetivo real a fecha de verificación |
| **Ya capturado (remediado)** | `digital-dev:{oms,payments-api}`, `digital-uat:{oms,payments-api}` | PG18.4 (soporte estándar) | 336,24 | 309,34 | Ya en curso de extinción por las migraciones recientes; **no** se cuenta como ahorro futuro |
| | | **Σ coste base (mayo 2026)** | **1 169,52** | **1 075,96** | (conserva la cifra de la Tarea 5.1 ✅) |

> Reconciliación del reparto (bruto): `833,28 (futuro) + 336,24 (capturado) = 1 169,52` ✅ — coincide con
> el coste base congelado de la Tarea 5.1 (suma calculada antes de redondear, Req 6.7).
> Neto: `766,62 + 309,34 = 1 075,96` ✅.

**Cifra de Ahorro_Garantizado condicionado de la Palanca (a fecha de verificación):**

| Medida | Bruto (USD) | Neto (USD) |
|--------|------------:|-----------:|
| Mensual (3 instancias prod/tooling PG13) | **833,28** | 766,62 |
| Anualizado ×12 (con advertencia Req 6.4) | **9 999,36** | 9 199,44 |

> ⚠️ **Advertencia de anualización (Req 6.4):** el ×12 asume que mayo 2026 es representativo y que las 3
> instancias siguen en PG13 todo el horizonte. Es **conservador a la baja** respecto al riesgo de coste:
> si el upgrade se retrasa más allá de **2028-02-28**, el inventario salta al **tramo Año 3** (precio por
> vCPU-hora ≈ ×2, ver Tarea 5.1), por lo que **no migrar** encarece esta partida. Existe una **ventana**
> (Año 1–2: 2026-03-01 → 2028-02-28) para capturar el ahorro antes de que el cargo se duplique.

## Documentación de la Palanca — campos obligatorios (Req 4.1–4.7)

| Campo (Req) | Valor |
|-------------|-------|
| **Supuesto de descuento / fórmula** | Eliminación íntegra del cargo `%ExtendedSupport%` al actualizar el motor (PG13 → versión con soporte estándar). El ahorro = coste completo de Extended Support de las instancias migradas (no es un % de descuento, es supresión del cargo). |
| **Origen del supuesto + fecha (Req 4.3)** | **Precio público AWS** — el cargo es un importe observado directamente en el CUR del Mes_Referencia (`2026-05`), no una tarifa estimada. Fecha del dato: `frozen-2026-05@2026-06-23`. Fin de soporte estándar PG13 = `2026-02-28` (API RDS, Tarea 5.2). |
| **% direccionable + coste base mensual afectado (Req 4.2)** | **100,0 %** del cargo de Extended Support es direccionable por upgrade. Coste base mensual afectado (ahorro futuro, 3 instancias PG13): **833,28 USD/mes** bruto (766,62 neto). Sobre el coste base congelado total (7 instancias): el 71,2 % corresponde al ahorro futuro y el 28,8 % ya está remediado. |
| **Riesgo (Req 4.4)** | **Alto.** Motivo: validación de **compatibilidad de la aplicación** con la versión destino tras un salto de varias versiones mayores (PG13→18.x); las instancias prod (`oms`, `payments-api`) son **MultiAZ** y críticas para el flujo de pedidos/pagos. Mitigante: dev/uat ya migradas a PG18.4 sin incidencia conocida, lo que reduce la incertidumbre pero no elimina el riesgo de corte en producción. |
| **Esfuerzo de migración (Req 4.5)** | **Alto.** Upgrade de versión mayor de RDS PostgreSQL (13→destino) en 3 instancias, 2 de ellas `MultiAZ` en producción: requiere prueba de compatibilidad de aplicación, ventana de mantenimiento prod coordinada, plan de rollback (snapshot previo) y validación post-upgrade. Reutilizable el procedimiento ya aplicado en dev/uat. |
| **Owner / responsable (Req 4.6, 4.7)** | **pendiente** (correo por confirmar). Equipo responsable: **Digital** (propietario de `oms` y `payments-api`); `postgres-oms-general` reside en `dp-tooling` pero da servicio a OMS (coordinación SRE↔Digital). Owner marcado "pendiente" por no estar asignado el correo nominal (Req 4.7). |
| **Estado de Barrido_Utilizacion** | **n/a** — el ahorro es supresión de un cargo verificado en vivo, no depende de perfil de utilización; no requiere Barrido (a diferencia de las Palancas de compromiso/rightsizing/scheduling). |

## Registro de evidencia (esquema completo del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-5.3-extended-support-clasificacion-2026-06-23` |
| `descripcion` | Clasificación de la Palanca 3 (Extended Support PG13) como **Ahorro_Garantizado condicionado** a upgrade de motor + validación de compatibilidad de aplicación, con reparto por drift (ahorro futuro vs ya capturado) y documentación de los campos Req 4 |
| `tipo` | Clasificación + documentación de Palanca (no atribuible a coste nuevo; reutiliza las cifras de `EV-5.1-...` y la verificación de `EV-5.2-...`) |
| `clasificacion` | **Ahorro_Garantizado condicionado** (a upgrade de motor + validación previa de compatibilidad de la aplicación, Req 9.4, 9.5) |
| `cifra_ahorro_garantizado` | **833,28 USD/mes** bruto (766,62 neto) — 3 instancias prod/tooling aún en PG13. Anualizado: **9 999,36 USD** bruto / 9 199,44 neto (advertencia Req 6.4) |
| `porcion_ya_capturada` | 336,24 USD/mes bruto (309,34 neto) — 4 instancias dev/uat ya migradas a PG18.4 (no contabilizado como ahorro futuro) |
| `coste_base_congelado` | 1 169,52 USD/mes bruto / 1 075,96 neto (7 instancias, `frozen-2026-05@2026-06-23`, Tarea 5.1) — invariante: `833,28 + 336,24 = 1 169,52` ✅ |
| `recurso_ids` | Ahorro futuro (Garantizado condicionado): `arn:aws:rds:eu-west-1:111222333444:db:oms`, `arn:aws:rds:eu-west-1:111222333444:db:payments-api`, `arn:aws:rds:eu-west-1:444455556666:db:postgres-oms-general` |
| `% direccionable` | `100,0` (el cargo completo de Extended Support se elimina al actualizar) |
| `coste_base_afectado` | 833,28 USD/mes (ahorro futuro) sobre 1 169,52 USD/mes congelado |
| `supuesto_origen` | Precio público AWS (cargo observado en CUR); fecha `2026-05` / `frozen-2026-05@2026-06-23` |
| `riesgo` | **alto** (compatibilidad de aplicación; prod MultiAZ; salto de versión mayor) |
| `esfuerzo` | **alto** (upgrade de versión mayor RDS en 3 instancias, 2 MultiAZ prod; requiere ventana + rollback) |
| `owner` | **pendiente** (Digital — `oms`/`payments-api`; coordinación SRE para `postgres-oms-general`) |
| `dependencia_bloqueante` | **ninguna identificada** a fecha de verificación (las dev/uat ya migraron PG13→PG18.4); regla Req 9.6 registrada para re-ejecución |
| `barrido_utilizacion` | `n/a` (supresión de cargo verificado en vivo; no depende de utilización) |
| `mes_referencia` | `2026-05` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `vinculo` | Cifra base y consultas CUR: `EV-5.1-extended-support-2026-05`. Verificación viva (motor/versión/fin soporte): `EV-5.2-extended-support-verificacion-viva-2026-06-23` |

## Estado de ejecución

- ✅ **Clasificada** como **Ahorro_Garantizado condicionado** (upgrade de motor + validación previa de
  compatibilidad de la aplicación, Req 9.4, 9.5).
- ✅ **Drift incorporado** (Req 7.6): ahorro futuro `833,28 USD/mes` (3 instancias prod/tooling PG13);
  porción dev/uat (`336,24 USD/mes`) ya capturada por las migraciones a PG18.4 y excluida del ahorro futuro.
  Reparto reconciliado con el coste base congelado de la Tarea 5.1 (`833,28 + 336,24 = 1 169,52` ✅).
- ✅ **Regla de bloqueo (Req 9.6) registrada**; sin dependencia bloqueante identificada hoy (evidencia: las
  4 dev/uat ya migradas). Si apareciera, la instancia afectada se excluye de Garantizado y se reclasifica
  como no realizable a corto plazo, identificando la dependencia.
- ✅ **Documentación de Palanca completa** (Req 4.1–4.7): supuesto/origen, % direccionable (100,0 %) + coste
  base afectado (833,28 USD/mes), riesgo **alto**, esfuerzo **alto**, owner **pendiente** (Digital);
  Barrido_Utilizacion `n/a`.
- **Vínculos:** cifra y consultas en `EV-5.1-...`; verificación viva en `EV-5.2-...`. Esta Palanca alimenta
  la tabla del Informe (Tarea 19.2) como fila "3 | Extended Support PG13 | Garantizado\* | $833,28/mes
  (futuro) | …" y la derivación de objetivos comprometidos (Tarea 19.4) como Σ Garantizado.
