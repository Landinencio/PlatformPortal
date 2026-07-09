# Registro de evidencia — Palanca 5: Aurora no productivo de Helios (Tarea 7.1)

**Validates: Requirements 2.2, 2.3, 15.1**

> Artefacto auditable de **análisis FinOps** (no software). Congela la cifra de coste del cómputo
> de instancia Aurora PostgreSQL de las dos cuentas no productivas de Helios (`helios-dev` +
> `helios-uat`) por recurso, con su consulta CUR re-ejecutable, anclada al `Dataset_Congelado`.
> Alcance de esta tarea: **solo congelar la cifra** (la Verificacion_Recurso_Vivo se ejecuta en la
> Tarea 7.2; la fórmula de ahorro, clasificación y documentación de la Palanca en la Tarea 7.3).

## Parámetros de anclaje (Req 2.5)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-7.1-aurora-helios-noprod-2026-05` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23T08:13:39Z` (UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Cuenta CUR | `600700800900` (root-iskaypet), `eu-west-1` |
| Motor / DB / tabla | Amazon Athena (CUR 2.0) · `athenacurcfn_finnops` / `data` |
| Rol de acceso | `Cur-AWSS3CURLambdaExecutor` (perfil `root-iskaypet`) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |

**Clasificación del registro:** cifra **atribuible a recursos** (Req 2.2) — se registra la lista de
`line_item_resource_id` reales (ARN completos) que la originan (Req 2.3), más la línea de descuento
agregada `SppDiscount` (no atribuible a recurso) que cierra el puente bruto→neto.

**Dimensión de agregación (Req 2.3):** `line_item_usage_account_id` × `line_item_resource_id`;
valor de agregación = `SUM(line_item_unblended_cost)` y `SUM(line_item_net_unblended_cost)`.

## Consulta CUR exacta (re-ejecutable)

Consulta primaria (cifra congelada por cuenta + recurso), idéntica a la del `design.md` (Palanca 5)
ampliada con `net_unblended` y conteo de líneas:

```sql
SELECT line_item_usage_account_id        AS account,
       line_item_resource_id             AS resource,
       SUM(line_item_unblended_cost)     AS unblended_cost,
       SUM(line_item_net_unblended_cost) AS net_unblended_cost,
       COUNT(*)                          AS line_items
FROM data
WHERE line_item_product_code = 'AmazonRDS'
  AND line_item_usage_type LIKE '%InstanceUsage%'
  AND line_item_usage_account_id IN ('555566667777','666677778888')  -- helios-dev, helios-uat
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2
ORDER BY 3 DESC;
```

Consulta de refuerzo (descompone por `line_item_line_item_type` + `usage_type` para identificar la
naturaleza de cada línea, en particular la línea negativa sin `resource_id`):

```sql
SELECT line_item_usage_account_id        AS account,
       line_item_resource_id             AS resource,
       line_item_line_item_type          AS li_type,
       line_item_usage_type              AS usage_type,
       SUM(line_item_unblended_cost)     AS unblended,
       SUM(line_item_net_unblended_cost) AS net
FROM data
WHERE line_item_product_code = 'AmazonRDS'
  AND line_item_usage_type LIKE '%InstanceUsage%'
  AND line_item_usage_account_id IN ('555566667777','666677778888')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2, 3, 4
ORDER BY 1, 2, 3;
```

## Comandos de ejecución re-ejecutables (Athena vía AWS CLI, credenciales por nombre de perfil — Req 7.5)

```bash
# Consulta primaria (cifra congelada por cuenta + recurso)
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "SELECT line_item_usage_account_id AS account, line_item_resource_id AS resource, SUM(line_item_unblended_cost) AS unblended_cost, SUM(line_item_net_unblended_cost) AS net_unblended_cost, COUNT(*) AS line_items FROM data WHERE line_item_product_code = 'AmazonRDS' AND line_item_usage_type LIKE '%InstanceUsage%' AND line_item_usage_account_id IN ('555566667777','666677778888') AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00' GROUP BY 1, 2 ORDER BY 3 DESC;" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

## Ejecución congelada

| Métrica | Valor |
|---------|-------|
| `QueryExecutionId` (consulta primaria) | `ac82037a-2731-430c-b129-8dc310bdff45` |
| `QueryExecutionId` (consulta de refuerzo por tipo) | `683d2e5a-a897-4e04-bac3-007d737190d9` |
| Estado | `SUCCEEDED` |
| Datos escaneados (primaria) | `10 231 752` bytes |

## Resultado congelado — coste por recurso (`Dataset_Congelado` = `frozen-2026-05@2026-06-23`, USD)

Cada cuenta no-prod de Helios presenta **2 instancias Aurora PostgreSQL** `db.r6g.large` (writer
`aurora-0` + reader `aurora-1`) facturadas como `EU-InstanceUsage:db.r6g.large` durante los 31 días
del mes (31 line items cada una → uso 24/7), más una línea **`SppDiscount`** agregada por cuenta
(sin `resource_id`) que reduce el bruto al neto.

| Cuenta (ID) | `line_item_resource_id` (ARN) | Tipo línea | Usage type | Líneas | Unblended (USD) | Net unblended (USD) |
|-------------|-------------------------------|-----------|------------|-------:|----------------:|--------------------:|
| 555566667777 (helios-dev) | `arn:aws:rds:eu-west-1:555566667777:db:helios-dev-golden-record-db-aurora-0` | Usage | `EU-InstanceUsage:db.r6g.large` | 31 | 212,784000 | 195,761280 |
| 555566667777 (helios-dev) | `arn:aws:rds:eu-west-1:555566667777:db:helios-dev-golden-record-db-aurora-1` | Usage | `EU-InstanceUsage:db.r6g.large` | 31 | 212,784000 | 195,761280 |
| 555566667777 (helios-dev) | *(no atribuible a recurso)* | SppDiscount | `EU-InstanceUsage:db.r6g.large` | 31 | −34,045440 | 0,000000 |
| 666677778888 (helios-uat) | `arn:aws:rds:eu-west-1:666677778888:db:helios-uat-golden-record-db-aurora-0` | Usage | `EU-InstanceUsage:db.r6g.large` | 31 | 212,784000 | 195,761280 |
| 666677778888 (helios-uat) | `arn:aws:rds:eu-west-1:666677778888:db:helios-uat-golden-record-db-aurora-1` | Usage | `EU-InstanceUsage:db.r6g.large` | 31 | 212,784000 | 195,761280 |
| 666677778888 (helios-uat) | *(no atribuible a recurso)* | SppDiscount | `EU-InstanceUsage:db.r6g.large` | 31 | −34,045440 | 0,000000 |

`recurso_ids` (Req 2.2, 2.3):

```
arn:aws:rds:eu-west-1:555566667777:db:helios-dev-golden-record-db-aurora-0
arn:aws:rds:eu-west-1:555566667777:db:helios-dev-golden-record-db-aurora-1
arn:aws:rds:eu-west-1:666677778888:db:helios-uat-golden-record-db-aurora-0
arn:aws:rds:eu-west-1:666677778888:db:helios-uat-golden-record-db-aurora-1
```

## Cifra combinada congelada (helios-dev + helios-uat)

Sumado **antes** de redondear, half-up a 2 decimales en USD (Req 6.7):

| Concepto | Cálculo | Importe (USD) |
|----------|---------|--------------:|
| **Coste de instancia bruto (Usage)** — 4× `db.r6g.large` 24/7 | `4 × 212,784000 = 851,136000` | **851,14** |
| Descuento empresarial `SppDiscount` (2 cuentas) | `2 × (−34,045440) = −68,090880` | **−68,09** |
| **Coste de instancia neto (tras SPP)** | `851,136000 − 68,090880 = 783,045120` | **783,05** |

> El neto agregado del cómputo (`783,05`) coincide por las dos vías: (a) suma del `net_unblended` de
> las 4 líneas Usage (`4 × 195,761280 = 783,045120`), y (b) bruto Usage menos la línea `SppDiscount`
> (`851,136000 − 68,090880 = 783,045120`). La línea `SppDiscount` tiene `net_unblended = 0` por
> construcción del CUR (el descuento ya está incorporado en el `net_unblended` de las líneas Usage),
> de modo que **no hay doble conteo** del descuento en la medida neta.

**Cifra congelada de la Palanca 5 (coste base mensual de la oportunidad):** cómputo de instancia
Aurora no-prod de Helios = **851,14 USD/mes bruto** · **783,05 USD/mes neto** (combinado dev+uat),
distribuido en 4 instancias `db.r6g.large` (2 writer + 2 reader), todas 24/7 durante el mes.

> Concordancia con el `design.md`: el ejemplo trabajado declaraba **«$851/mes combinado»**, que
> corresponde exactamente al **bruto Usage** aquí congelado (`851,14`). El neto tras el descuento
> empresarial SPP es `783,05`. El % de reducción aplicable (solo reader → reader + downsize +
> scheduling) y la clasificación Estimado/Garantizado se determinan en la **Tarea 7.3**, sujetos al
> `Barrido_Utilizacion` (Tarea 16.3).

## Notas metodológicas

- El filtro `line_item_usage_type LIKE '%InstanceUsage%'` aísla **cómputo de instancia** (Req 15.1),
  excluyendo storage, I/O, backups y ACU/serverless. Las 4 líneas son `EU-InstanceUsage:db.r6g.large`
  → instancias aprovisionadas (no Aurora Serverless v2), coherente con el patrón writer+reader.
- Los 31 line items por instancia (1 por día del mes, completitud 31/31 confirmada en el Registro
  1.2 del Catálogo) confirman uso continuo (24/7) en el Mes_Referencia.
- No se ejecuta ninguna acción mutante: esta tarea solo lee el CUR vía Athena. La verificación
  contra el recurso vivo (`rds describe-db-clusters` / `describe-db-instances`, solo lectura) es la
  **Tarea 7.2**.

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23` el `2026-06-23T08:13:39Z`.
- Cifras congeladas y reproducibles: re-ejecutar la consulta documentada sobre el mismo
  Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría en
  Tarea 17.6).

---

# Sub-registro — Verificacion_Recurso_Vivo (Tarea 7.2)

**Validates: Requirements 5.1, 15.1**

> Comprobación de **solo lectura** (`describe-db-clusters` / `describe-db-instances`, ninguna
> operación mutante — Req 5.1, Property 11) que confirma que los 4 recursos Aurora congelados en la
> Tarea 7.1 existen y tienen las características asumidas: writer + reader por cuenta, clase
> `db.r6g.large`, `MultiAZ=false` por instancia y patrón 24/7. Las cifras base quedan ancladas al
> `Dataset_Congelado` `frozen-2026-05@2026-06-23`; el drift del recurso vivo entre la congelación y
> esta verificación es esperado y no invalida dichas cifras (Req 7.6).

## Parámetros de la verificación (Req 5.5)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-7.2-aurora-helios-noprod-liveverify` |
| Fecha-hora de ejecución (UTC) | `2026-06-23T08:51:44Z` |
| Tipo de verificación | Solo lectura (`describe/list/get`) — Req 5.1, 7.5 |
| Región consultada | `eu-west-1` |
| Cuentas consultadas | `555566667777` (helios-dev), `666677778888` (helios-uat) |
| Acceso / credenciales | SSO SRE por nombre de perfil (`helios-dev`, `helios-uat`), rol `AWSReservedSSO_SRE`; **sin credenciales incrustadas** (Req 7.5) |
| Identidad confirmada | `arn:aws:sts::555566667777:assumed-role/AWSReservedSSO_SRE_ed700c8eb3a4bc85/ruben.landin@emefinpetcare.com` · `arn:aws:sts::666677778888:assumed-role/AWSReservedSSO_SRE_9d6a93c213377049/ruben.landin@emefinpetcare.com` |
| **Estado global** | **confirmado** (4/4 recursos existentes con la clase y patrón asumidos) |

## Comandos de solo lectura re-ejecutables (Req 7.5 — credenciales por nombre de perfil)

```bash
# Verificación de sesión (no mutante)
aws sts get-caller-identity --profile helios-dev --region eu-west-1
aws sts get-caller-identity --profile helios-uat --region eu-west-1

# Clúster: writer/reader, motor, MultiAZ a nivel de clúster, estado
aws rds describe-db-clusters --profile helios-dev --region eu-west-1 \
  --query "DBClusters[?contains(DBClusterIdentifier, 'golden-record')].{Cluster:DBClusterIdentifier,Engine:Engine,EngineVersion:EngineVersion,Members:DBClusterMembers[].{Id:DBInstanceIdentifier,Writer:IsClusterWriter},MultiAZ:MultiAZ,Status:Status}"
aws rds describe-db-clusters --profile helios-uat --region eu-west-1 \
  --query "DBClusters[?contains(DBClusterIdentifier, 'golden-record')].{Cluster:DBClusterIdentifier,Engine:Engine,EngineVersion:EngineVersion,Members:DBClusterMembers[].{Id:DBInstanceIdentifier,Writer:IsClusterWriter},MultiAZ:MultiAZ,Status:Status}"

# Instancia: clase, MultiAZ por instancia, AZ, estado, fecha de creación
aws rds describe-db-instances --profile helios-dev --region eu-west-1 \
  --query "DBInstances[?contains(DBInstanceIdentifier, 'golden-record')].{Id:DBInstanceIdentifier,Class:DBInstanceClass,Engine:Engine,MultiAZ:MultiAZ,AZ:AvailabilityZone,Status:DBInstanceStatus,Created:InstanceCreateTime}"
aws rds describe-db-instances --profile helios-uat --region eu-west-1 \
  --query "DBInstances[?contains(DBInstanceIdentifier, 'golden-record')].{Id:DBInstanceIdentifier,Class:DBInstanceClass,Engine:Engine,MultiAZ:MultiAZ,AZ:AvailabilityZone,Status:DBInstanceStatus,Created:InstanceCreateTime}"
```

## Resultado de la verificación — por recurso

| Cuenta (ID) | Recurso (instancia) | Rol en clúster | Clase | Motor (versión) | `MultiAZ` (instancia) | AZ | Estado | Creado (UTC) |
|-------------|---------------------|----------------|-------|-----------------|:---------------------:|----|--------|--------------|
| 555566667777 (helios-dev) | `helios-dev-golden-record-db-aurora-0` | **writer** | `db.r6g.large` | aurora-postgresql 18.3 | `false` | eu-west-1a | available | 2025-08-12T11:15:11Z |
| 555566667777 (helios-dev) | `helios-dev-golden-record-db-aurora-1` | reader | `db.r6g.large` | aurora-postgresql 18.3 | `false` | eu-west-1b | available | 2025-08-12T11:17:19Z |
| 666677778888 (helios-uat) | `helios-uat-golden-record-db-aurora-0` | reader | `db.r6g.large` | aurora-postgresql 18.3 | `false` | eu-west-1a | available | 2025-10-30T11:23:17Z |
| 666677778888 (helios-uat) | `helios-uat-golden-record-db-aurora-1` | **writer** | `db.r6g.large` | aurora-postgresql 18.3 | `false` | eu-west-1b | available | 2025-10-30T11:18:46Z |

Clúster por cuenta: `helios-dev-golden-record-db-aurora` y `helios-uat-golden-record-db-aurora`,
ambos `available`, cada uno con **exactamente 1 writer + 1 reader** (2 miembros).

## Conclusiones de la verificación (contra los supuestos de la Tarea 7.1 y del `design.md`)

| Supuesto a verificar | Resultado | Detalle |
|----------------------|-----------|---------|
| writer + reader por cuenta | ✅ confirmado | 2 miembros por clúster, 1 writer + 1 reader en cada cuenta |
| clase `db.r6g.large` | ✅ confirmado | las 4 instancias son `db.r6g.large` |
| `MultiAZ=false` | ✅ confirmado **a nivel de instancia** | las 4 instancias reportan `MultiAZ: false` (matiz abajo) |
| patrón 24/7 | ✅ confirmado | creadas 2025-08 (dev) y 2025-10 (uat), `available` hoy; concuerda con los 31/31 line items diarios congelados en la 7.1 (uso continuo en el Mes_Referencia) |
| motor Aurora PostgreSQL | ✅ confirmado | `aurora-postgresql` 18.3 (aprovisionado, no Serverless v2 — coherente con `EU-InstanceUsage:db.r6g.large`) |

## Matices y drift detectado (registrados por honestidad — Req 7.6)

1. **`MultiAZ` a nivel de clúster = `true`, a nivel de instancia = `false`.** El flag de clúster es
   `true` porque writer y reader residen en AZ distintas (eu-west-1a / eu-west-1b), que es el
   comportamiento normal de replicación Aurora. El atributo relevante para el supuesto de coste
   (recargo de despliegue "Multi-AZ" de RDS) es el **de instancia**, que es `false` en las 4 — no
   hay instancia en espera (standby) Multi-AZ facturada como tal. Esto es **coherente** con que las
   líneas del CUR congeladas en la 7.1 sean `EU-InstanceUsage:db.r6g.large` (uso de instancia
   estándar), no un usage type de Multi-AZ. El supuesto `MultiAZ=false` del `design.md` queda
   confirmado en su sentido de facturación.
2. **El miembro writer difiere entre cuentas.** En helios-dev el writer es `aurora-0` (y `aurora-1`
   el reader); en helios-uat el writer es `aurora-1` (y `aurora-0` el reader). La Tarea 7.1 asumía
   "writer aurora-0 + reader aurora-1" para ambas. El recuento (1 writer + 1 reader) y el coste **no
   cambian** (ambas instancias son `db.r6g.large` 24/7 facturadas idénticamente), así que la cifra
   congelada (`851,14 USD/mes bruto · 783,05 USD/mes neto` combinado) **no se ve afectada**; solo se
   corrige el etiquetado de qué miembro es writer en helios-uat.
3. **Drift de recurso vivo esperado (Req 7.6).** Esta verificación (`2026-06-23T08:51:44Z`) es
   posterior a la congelación del `Dataset_Congelado` (`frozen-2026-05@2026-06-23`). La versión de
   motor observada (18.3) y demás atributos vivos reflejan el estado actual; las cifras base
   permanecen ancladas al CUR de mayo 2026 y no se recalculan por este drift.

## Estado de ejecución

- ✅ **Ejecutado** el `2026-06-23T08:51:44Z` (UTC) contra los recursos vivos de helios-dev
  (555566667777) y helios-uat (666677778888), región `eu-west-1`, con operaciones **exclusivamente
  de solo lectura** (`sts get-caller-identity`, `rds describe-db-clusters`, `rds describe-db-instances`).
- **Estado: confirmado** — los 4 recursos `db.r6g.large` (2 writer + 2 reader) existen, están
  `available`, son `MultiAZ=false` por instancia y mantienen el patrón 24/7 asumido. La Palanca 5
  queda **resource-verified** (Req 15.1); el % de reducción aplicable sigue sujeto al
  `Barrido_Utilizacion` de la Tarea 16.3, y la fórmula/clasificación/documentación a la Tarea 7.3.
- Ninguna operación mutante ejecutada (Req 5.1, Property 11 — auditable en Tarea 17.7).

---

# Sub-registro — Fórmula, clasificación y documentación de la Palanca (Tarea 7.3)

**Validates: Requirements 3.3, 15.2, 15.5, 15.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1, 18.1**

> Cierre **analítico** (no software) de la Palanca 5: parte de la **cifra base congelada** en la
> Tarea 7.1 (`851,14 USD/mes bruto` · `783,05 USD/mes neto`, combinado helios-dev + helios-uat,
> 4× `db.r6g.large` writer+reader 24/7) y del recurso ya **resource-verified** en la Tarea 7.2
> (4/4 confirmados, `MultiAZ=false` por instancia). Aplica la fórmula de reducción por agresividad
> de la acción (solo reader → reader + downsize + scheduling), excluye con motivo lo que debe
> permanecer 24/7, clasifica la Palanca como **Ahorro_Estimado (rango)**, documenta los campos
> obligatorios del Req 4 y la marca **requiere Barrido_Utilizacion** (Tarea 16.3) antes de elevarse
> a objetivo comprometido (Req 18.1). **No** se ejecuta ninguna consulta CUR nueva ni operación
> mutante: las cifras de ahorro son **derivadas** de la cifra base congelada `frozen-2026-05@2026-06-23`.

## Anclaje (Req 2.5, heredado de 7.1/7.2)

| Campo | Valor |
|-------|-------|
| `id_evidencia` (raíz) | `EV-7.3-aurora-helios-noprod-ahorro` |
| Mes_Referencia | `2026-05` |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Fecha de extracción (cifra base) | `2026-06-23T08:13:39Z` (UTC) |
| Fecha de elaboración (Tarea 7.3) | `2026-06-23T09:05:00Z` (UTC) |
| Moneda | `USD` (2 decimales, half-up, sumando antes de redondear — Req 6.7) |
| Cifra base mensual afectada | **851,14 USD/mes bruto** · 783,05 USD/mes neto (combinado) |
| `recurso_ids` (Req 2.2, 2.3) | las 4 instancias Aurora congeladas en 7.1 (ARN abajo) |
| `verificacion_vivo` | sub-registro `EV-7.2-aurora-helios-noprod-liveverify` — **estado: confirmado** |
| `clasificacion` | **`estimado`** (rango; recurso confirmado, % de reducción sujeto a Barrido) |

```
arn:aws:rds:eu-west-1:555566667777:db:helios-dev-golden-record-db-aurora-0  (writer, dev)
arn:aws:rds:eu-west-1:555566667777:db:helios-dev-golden-record-db-aurora-1  (reader, dev)
arn:aws:rds:eu-west-1:666677778888:db:helios-uat-golden-record-db-aurora-0  (reader, uat)
arn:aws:rds:eu-west-1:666677778888:db:helios-uat-golden-record-db-aurora-1  (writer, uat)
```

## Fórmula de ahorro — rango por agresividad de la acción (Req 3.3, 15.5, 15.6)

La acción admite un espectro creciente de agresividad sobre la misma base de 4 instancias 24/7.
El ahorro se expresa **siempre como rango** (Estimado, Req 3.3 / 15.6), con la invariante
`0 < Conservador ≤ Agresivo`. La descomposición de cada componente (fracción de coste que
*permanece* tras la acción) es:

| Acción acumulada | Recursos resultantes | Fracción de coste que permanece | Reducción |
|------------------|----------------------|:-------------------------------:|:---------:|
| **(Conservador)** Eliminar solo las 2 réplicas **reader** (1 por cuenta) | 2 writers 24/7 `db.r6g.large` | `2/4 = 0,500` | **50,0 %** |
| + Downsize del writer un escalón (`db.r6g.large` → `db.r6g.medium`, ½ de vCPU/RAM → ½ de precio en tarifa pública) | 2 writers 24/7 `db.r6g.medium` | `0,500 × 0,50 = 0,250` | 75,0 % |
| **(Agresivo)** + Scheduling off-hours del writer en no-prod (encendido ~horario laboral extendido, ≈ 0,60 de uptime) | 2 writers `db.r6g.medium` programados | `0,250 × 0,60 = 0,150` | **85,0 %** |

- **Rango_Conservador = 50,0 %** de reducción (solo reader). Defendible sin supuestos de uso: en
  no-prod no hay escalado de lectura que justifique una réplica de lectura dedicada; el reader es
  desperdicio funcional. Aun así se clasifica **Estimado** (no Garantizado) porque la confirmación
  de que ninguna carga de dev/uat depende del endpoint reader exige el `Barrido_Utilizacion`.
- **Rango_Agresivo = 85,0 %** de reducción (reader + downsize + scheduling). Compone el
  downsize de clase (factor 0,50, precio lineal por vCPU en tarifa pública r6g) con un scheduling
  off-hours moderado (uptime ≈ 0,60, p. ej. encendido en horario laboral ampliado y apagado de
  madrugada/fines de semana). El uptime exacto y la compatibilidad de la clase reducida con la
  carga **son los supuestos sujetos a Barrido**.

> El `db.r6g.medium` mantiene la misma familia Graviton (r6g) que el `db.r6g.large` verificado en la
> 7.2; el supuesto de "½ de precio al bajar un escalón" usa la **relación de precio público AWS**
> entre clases r6g (lineal por vCPU/RAM), fecha de extracción `2026-06-23` (Req 4.3), a re-confirmar
> contra la calculadora vigente.

## Cifras de ahorro derivadas (mensual + anualizado ×12, Req 6.1, 6.2, 6.3, 6.4)

Calculado sobre la cifra base **sin redondear** (`851,136000` bruto · `783,045120` neto) y
redondeado half-up a 2 decimales al final (Req 6.7). Se presentan las dos medidas (bruto Usage y
neto tras descuento SPP) por trazabilidad con la 7.1; la cifra **publicable** de cabecera usa el
**bruto** (concuerda con el «$851/mes combinado» del `design.md`).

| Escenario | % reducción | Ahorro mensual **bruto** | Ahorro anualizado **bruto** (×12) | Ahorro mensual **neto** | Ahorro anualizado **neto** (×12) |
|-----------|:-----------:|-------------------------:|----------------------------------:|------------------------:|---------------------------------:|
| **Rango_Conservador** (solo reader) | 50,0 % | **425,57** | 5 106,82 | 391,52 | 4 698,27 |
| **Rango_Agresivo** (reader + downsize + schedule) | 85,0 % | **723,47** | 8 681,59 | 665,59 | 7 987,06 |

- Derivación bruta: `851,136 × 0,50 = 425,568 → 425,57`; `425,568 × 12 = 5 106,816 → 5 106,82`.
  `851,136 × 0,85 = 723,4656 → 723,47`; `723,4656 × 12 = 8 681,5872 → 8 681,59`.
- Derivación neta: `783,045120 × 0,50 = 391,52256 → 391,52` (×12 → `4 698,27`);
  `783,045120 × 0,85 = 665,588352 → 665,59` (×12 → `7 987,06`).
- **Invariante de rango (Req 3.3, 6.1):** `0 < 425,57 ≤ 723,47` (bruto) y `0 < 391,52 ≤ 665,59`
  (neto). ✅
- **Advertencia de anualización (Req 6.4):** las cifras anualizadas asumen que el Mes_Referencia
  (mayo 2026) es **representativo** y **no capturan estacionalidad**; son `mensual × 12` directo.
  No es un compromiso de captura progresiva (Req 6.5 no aplica: la acción es de efecto inmediato,
  no de cobertura prorrateada).

## Exclusiones con motivo — lo que debe permanecer 24/7 (Req 15.2, 15.5)

| Elemento | Decisión | Motivo |
|----------|----------|--------|
| **Writer** de cada cuenta (`aurora-0` en dev, `aurora-1` en uat) | **NO eliminable**; solo downsizable / programable | Es la base de datos golden-record del entorno; dev/uat dejan de funcionar sin él. Solo entra en el ahorro vía downsize y/o scheduling, no vía eliminación. |
| Ventana de scheduling | Excluir del apagado las franjas con **jobs nocturnos / sync de golden-record** si existen | Req 15.2: un recurso no-prod que deba estar disponible para jobs programados se excluye de esa franja. **La existencia y horario de dichos jobs se confirma en el Barrido_Utilizacion (16.3)**; hasta entonces el uptime 0,60 del escenario agresivo es un supuesto, no un compromiso. |
| **Reader** de cada cuenta | Candidato a eliminación (incluido en Conservador y Agresivo) | En no-prod no hay escalado de lectura que lo justifique; sujeto a confirmar en Barrido que ninguna carga apunta al endpoint reader. |

> **Spot (Req 15.3, 15.4):** no aplica a esta Palanca. Aurora PostgreSQL es un servicio gestionado
> **stateful** sin modalidad Spot; la oportunidad de Spot en no-prod se cuantifica en la Palanca 10
> (cómputo EC2/EKS no-prod). Aquí la tolerancia a interrupción se traduce en **scheduling** (parada
> programada), no en Spot. Las horas de esta Palanca son **disjuntas** de las de la Palanca 10 (RDS
> vs EC2), sin doble conteo.

## Documentación obligatoria por Palanca (Req 4.1–4.7)

| Campo (Req 4) | Valor |
|---------------|-------|
| **Supuesto de reducción** (Req 4.1, % 0–100, 1 decimal) | **50,0 %** (Conservador) – **85,0 %** (Agresivo) de reducción sobre la base 24/7 |
| **% direccionable + coste base mensual** (Req 4.2) | **100,0 %** del coste base direccionable; coste base mensual afectado = **851,14 USD bruto** (783,05 USD neto). Las 4 instancias son no-prod y candidatas a alguna acción. |
| **Origen del supuesto + fecha** (Req 4.3) | **Precio público AWS** (`2026-06-23`) para el componente de downsize (relación lineal de precio r6g large↔medium). Los componentes de eliminación de reader y de scheduling son **reducciones operativas** (de recursos/horas, no de tarifa) sujetas al Barrido_Utilizacion. |
| **Riesgo** (Req 4.4) | **medio** — eliminar el reader en no-prod es bajo riesgo; el downsize de clase y el scheduling off-hours pueden afectar la disponibilidad de dev/uat y a jobs nocturnos/CI que consuman la BD (mitigable validando dependencias en el Barrido). |
| **Esfuerzo** (Req 4.5) | **medio** — cambios Terraform (eliminar réplica reader, ajustar `instance_class`) + automatización de arranque/parada programada (p. ej. EventBridge + Lambda / RDS scheduler) + validación de que no hay procesos nocturnos dependientes. |
| **Owner** (Req 4.6, 4.7) | **pendiente** (equipo **Helios**; correo del responsable por confirmar) |
| **Barrido_Utilizacion** (Req 18.1) | **requerido** — gating en la Tarea 16.3 (perfil 24/7 vs intermitente y horas reducibles defendibles, incl. Aurora Helios). |

## Clasificación final (Req 3.1, 3.3, 18.1, 18.2)

- **Clasificación: Ahorro_Estimado (rango).** La Palanca es **resource-verified** (los 4 recursos
  están confirmados en la 7.2 con la clase y el patrón 24/7 asumidos), pero el **% de reducción**
  depende de supuestos de uso (necesidad del reader, clase mínima viable del writer, horas
  reducibles), de modo que **no** es Ahorro_Garantizado: se expresa siempre como rango, nunca como
  cifra única (Req 3.3).
- **No es objetivo comprometido (Req 18.1, 18.2):** al ser Estimado **sin** Barrido_Utilizacion
  completado, en el Informe se presenta **solo como rango** (Conservador–Agresivo) y queda **fuera**
  del `Objetivo_Comprometido` hasta que la Tarea 16.3 registre sus resultados en el
  `Catálogo_Evidencias`. Si el barrido se completa solo parcialmente, la Palanca permanece pendiente
  (Req 18.3).

## Registros para el Catálogo_Evidencias (Req 2.7 — biyección cifra↔registro)

Cifras **derivadas** (sin consulta CUR propia; ancladas a la cifra base congelada en 7.1). Cada una
es publicable en el Informe y referencia este sub-registro.

| `id_evidencia` | `cifra_publicada` (USD) | `descripcion` | `consulta_cur` | `recurso_ids` | `verificacion_vivo` | `clasificacion` |
|----------------|------------------------:|---------------|----------------|---------------|---------------------|-----------------|
| `EV-7.3-aurora-helios-cons-mensual` | 425,57 | Ahorro mensual bruto Conservador (solo reader, 50,0 %) | no aplica (derivada de `EV-7.1`: `851,136 × 0,50`) | las 4 ARN Aurora no-prod | `EV-7.2` (confirmado) | `estimado` |
| `EV-7.3-aurora-helios-cons-anual` | 5 106,82 | Ahorro anualizado bruto Conservador (×12, advertencia estacionalidad) | no aplica (`425,568 × 12`) | ídem | `EV-7.2` (confirmado) | `estimado` |
| `EV-7.3-aurora-helios-agr-mensual` | 723,47 | Ahorro mensual bruto Agresivo (reader+downsize+schedule, 85,0 %) | no aplica (derivada de `EV-7.1`: `851,136 × 0,85`) | ídem | `EV-7.2` (confirmado) | `estimado` |
| `EV-7.3-aurora-helios-agr-anual` | 8 681,59 | Ahorro anualizado bruto Agresivo (×12, advertencia estacionalidad) | no aplica (`723,4656 × 12`) | ídem | `EV-7.2` (confirmado) | `estimado` |

> Medidas **netas** equivalentes (tras descuento SPP), para trazabilidad con la 7.1: Conservador
> `391,52`/mes (`4 698,27`/año); Agresivo `665,59`/mes (`7 987,06`/año). `dimension_agregacion`:
> combinación de las 4 instancias `db.r6g.large` (helios-dev + helios-uat), valor = fracción de
> reducción aplicada sobre `SUM(line_item_unblended_cost)` congelado.

## Estado de ejecución

- ✅ **Completado.** Fórmula aplicada (rango 50,0 %–85,0 % de reducción), exclusiones registradas
  (writer no eliminable; ventana de jobs nocturnos a confirmar), clasificación **Ahorro_Estimado
  (rango), resource-verified**, documentación Req 4 completa (owner **pendiente**, Helios) y
  **requiere Barrido_Utilizacion** (Tarea 16.3) marcada.
- **Cifras publicables (combinado helios-dev + helios-uat, USD):** ahorro mensual bruto
  **425,57 – 723,47** (neto `391,52 – 665,59`); anualizado **5 106,82 – 8 681,59** (neto
  `4 698,27 – 7 987,06`), con la advertencia de estacionalidad del Req 6.4.
- **No elevable a objetivo comprometido** hasta completar el Barrido_Utilizacion (Req 18.1, 18.2).
- Ninguna operación mutante ni consulta CUR nueva: cifras derivadas del `Dataset_Congelado`
  `frozen-2026-05@2026-06-23` (Property 10 / Req 7.3 — re-derivables con diferencia `0,00 USD`).
