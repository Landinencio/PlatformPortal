# Registro de evidencia — Palanca 12: Contrato Marketplace (Palanca_Comercial) (Tarea 14.1)

**Validates: Requirements 17.1, 17.2, 17.3, 17.4, 17.5, 1.5, 2.3**

> Artefacto auditable de **análisis FinOps** (no software). Cuantifica y congela el coste **mensual
> y anualizado** del contrato Marketplace y la **sobrecarga PAYG** del mismo producto, con su
> consulta CUR re-ejecutable, anclados al `Dataset_Congelado`. Clasifica el contrato como
> **Palanca_Comercial**: separada y **NO contabilizada** en el total de ahorro técnico (Req 17.3).
> La fecha de renovación es desconocida → "pendiente" (Req 17.4); su realización depende de
> **renegociación o ajuste en renovación** (Req 17.5).
>
> Esta Palanca **no** lleva fórmula de ahorro técnico ni Verificacion_Recurso_Vivo de
> infraestructura: es una oportunidad **contractual/de negociación**, no técnica. Por eso se cierra
> en una sola tarea (14.1) y se presenta aparte del resto de Palancas en el Informe (Tarea 19.4).

## Parámetros de anclaje (Req 2.5, 1.3)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-14.1-marketplace-contrato-payg-2026-05` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción | `2026-06-23T07:55:14Z` (UTC) — coincide con la línea base contable (Registro 1.1) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Cuenta CUR | `600700800900` (root-iskaypet), `eu-west-1` |
| Motor / DB / tabla | Amazon Athena (CUR 2.0) · `athenacurcfn_finnops` / `data` |
| Rol de acceso | `Cur-AWSS3CURLambdaExecutor` (perfil `root-iskaypet` / `arn:aws:iam::600700800900:role/Cur-AWSS3CURLambdaExecutor-Y5pT9wqNQaur`) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |

**Clasificación del registro:** `comercial` (contrato Marketplace) — **fuera del ahorro técnico**
(Req 1.5, 17.3). El componente PAYG se etiqueta como **señal de tier mal dimensionado** (Req 17.2),
también fuera del ahorro técnico.

**Clasificación de atribución:** `no atribuible a recurso` (Req 2.4) — el contrato Marketplace y su
PAYG **no** presentan `line_item_resource_id` (campo vacío en el CUR); son cargos a nivel de
producto/contrato. Se registran por su discriminador CUR y dimensión de agregación (Req 2.3).

**Dimensión de agregación (Req 2.3):** `line_item_line_item_type` × `line_item_product_code` ×
`line_item_usage_type`; valor de agregación = `SUM(line_item_unblended_cost)` y
`SUM(line_item_net_unblended_cost)`.

## Producto y cuenta de facturación

| Campo | Valor |
|-------|-------|
| `line_item_product_code` | `cgdwha66labso75ke7c05fbaz` (contrato SaaS de AWS Marketplace) |
| Cuenta de facturación | `444455556666` (EKS Tooling) — **ambas** líneas (contrato y PAYG) se facturan aquí |
| `line_item_resource_id` | vacío / `null` en las dos líneas → "no atribuible a recurso" (Req 2.4) |

> Coherencia con la línea base contable: estas dos cifras son exactamente los grupos
> `E1.1-MKT-CONTRACT` (`85 000,55`) y `E1.1-PAYG` (`6 663,33`) congelados en el **Registro 1.1**
> del `catalogo-evidencias.md`. Este registro las re-consulta de forma aislada (filtro de producto
> Marketplace) y las cuantifica como Palanca_Comercial; **no** las recalcula ni altera la partición
> contable (que es la fuente oficial). Diferencia esperada en re-ejecución: `0,00 USD` (Req 7.3).

## Consulta CUR exacta (re-ejecutable) — separación contrato vs PAYG (Req 17.1, 17.2)

Idéntica a la del `design.md` (Palanca 12), ampliada con `net_unblended` y conteo de líneas. Separa
el **contrato** (`Fee` / `Global-SoftwareUsage-Contracts`, o `product_code LIKE 'cg%'`) del **PAYG
del mismo producto** (`MP:%`):

```sql
SELECT line_item_line_item_type AS charge_type,
       line_item_product_code   AS product_code,
       line_item_usage_type     AS usage_type,
       SUM(line_item_unblended_cost)     AS unblended_cost,
       SUM(line_item_net_unblended_cost) AS net_unblended_cost,
       COUNT(*)                          AS line_items
FROM data
WHERE (line_item_product_code LIKE 'cg%'
       OR line_item_usage_type = 'Global-SoftwareUsage-Contracts'
       OR line_item_usage_type LIKE 'MP:%')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2, 3
ORDER BY 4 DESC;
```

Consulta de refuerzo (confirma la cuenta de facturación y la ausencia de `resource_id`):

```sql
SELECT line_item_usage_account_id AS account,
       line_item_line_item_type   AS charge_type,
       line_item_usage_type       AS usage_type,
       line_item_resource_id      AS resource,
       SUM(line_item_unblended_cost) AS unblended_cost
FROM data
WHERE (line_item_product_code LIKE 'cg%'
       OR line_item_usage_type = 'Global-SoftwareUsage-Contracts'
       OR line_item_usage_type LIKE 'MP:%')
  AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00'
  AND line_item_usage_start_date <  TIMESTAMP '2026-06-01 00:00:00'
GROUP BY 1, 2, 3, 4
ORDER BY 5 DESC;
```

## Comandos de ejecución re-ejecutables (Athena vía AWS CLI, credenciales por nombre de perfil — Req 7.5)

```bash
# Consulta primaria — separación contrato vs PAYG del mismo producto
aws athena start-query-execution \
  --profile root-iskaypet --region eu-west-1 \
  --query-string "SELECT line_item_line_item_type AS charge_type, line_item_product_code AS product_code, line_item_usage_type AS usage_type, SUM(line_item_unblended_cost) AS unblended_cost, SUM(line_item_net_unblended_cost) AS net_unblended_cost, COUNT(*) AS line_items FROM data WHERE (line_item_product_code LIKE 'cg%' OR line_item_usage_type = 'Global-SoftwareUsage-Contracts' OR line_item_usage_type LIKE 'MP:%') AND line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00' GROUP BY 1, 2, 3 ORDER BY 4 DESC;" \
  --query-execution-context Database=athenacurcfn_finnops \
  --result-configuration OutputLocation=s3://finnops-iskaypet/athena-query-results/
```

## Ejecución congelada

| Métrica | Valor |
|---------|-------|
| `QueryExecutionId` (consulta primaria) | `8a502da1-21d2-43fc-b32a-7675cc1b1238` |
| `QueryExecutionId` (consulta de refuerzo — cuenta + resource_id) | `7f2caedb-18a9-42a4-9ca8-7ffa59a18430` |
| Estado | `SUCCEEDED` |
| Datos escaneados (primaria) | `5 612 328` bytes |

## Resultado congelado (`Dataset_Congelado` = `frozen-2026-05@2026-06-23`, USD)

| Componente | `charge_type` | `product_code` | `usage_type` | Líneas | Unblended (USD) | Net unblended (USD) |
|------------|---------------|----------------|--------------|-------:|----------------:|--------------------:|
| **Contrato Marketplace** | `Fee` | `cgdwha66labso75ke7c05fbaz` | `Global-SoftwareUsage-Contracts` | 1 | 85 000,55 | 85 000,55 |
| **PAYG mismo producto** | `Usage` | `cgdwha66labso75ke7c05fbaz` | `MP:payg-Units` | 1 | 6 663,3335806 | 6 663,3335806 |
| Tax sobre el contrato | `Tax` | `cgdwha66labso75ke7c05fbaz` | `Global-SoftwareUsage-Contracts` | 1 | 0,00 | 0,00 |
| Tax sobre el PAYG | `Tax` | `cgdwha66labso75ke7c05fbaz` | `MP:payg-Units` | 1 | 0,00 | 0,00 |

> Las líneas `Tax` del producto Marketplace son `0,00 USD` en el Mes_Referencia (el Tax agregado de
> la organización, `9 448,99`, se congela aparte en `E1.1-TAX`). Se listan para que la consulta del
> filtro de producto sea **exhaustiva** sobre lo que devuelve el CUR y no quede ninguna fila sin
> explicar.

### Cuantificación (Req 17.1) — el contrato es un CARGO PUNTUAL, no recurrente

**Corrección (gotcha #3 — contratos Marketplace prepagados Día 1):** el **contrato Marketplace
(`85 000,55`) es un cargo PUNTUAL** (prepago del contrato SaaS, facturado de una sola vez; aparece
íntegro en la factura de mayo 2026 porque ese fue el mes de cargo). **NO es un coste recurrente
mensual y NO debe anualizarse × 12.** Se repite únicamente en la **renovación** del contrato (su
cadencia es la del término contratado, p. ej. anual, no mensual). Solo el **PAYG**
(`MP:payg-Units`) es un cargo **recurrente** (pago por uso mes a mes) y, ese sí, se anualiza × 12.
Sumado antes de redondear, half-up a 2 decimales (Req 6.7); la advertencia de estacionalidad
(Req 6.4) aplica solo al PAYG.

| Concepto | Cadencia | Importe (USD) | Anualizado |
|----------|----------|--------------:|-----------:|
| **Contrato Marketplace** (`Fee`) | **PUNTUAL** (prepago, 1 vez — mayo 2026) | **85 000,55** | **no aplica × 12** (cargo único; recurre solo en la renovación) |
| **Sobrecarga PAYG** (`MP:payg-Units`) | **recurrente** (mensual) | **6 663,33** /mes | **79 960,00** /año (× 12) |

Detalle del redondeo half-up del PAYG: `6 663,3335806 → 6 663,33` mensual; anualizado
`6 663,3335806 × 12 = 79 960,0029672 → 79 960,00`. El contrato **no** se suma al PAYG como si fuera
mensual ni se compone un "total producto /mes": son cargos de naturaleza distinta (puntual vs
recurrente). El antiguo "Total producto 91 663,88/mes · 1 099 966,60/año" queda **retirado** por
incorrecto (mezclaba un cargo puntual con uno recurrente y anualizaba el puntual).

## Registros de evidencia (esquema completo del Catálogo_Evidencias)

### `EV-14.1-MKT-CONTRACT` — Contrato Marketplace (Palanca_Comercial)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-14.1-MKT-CONTRACT` |
| `cifra_publicada` | `85 000,55` USD — **cargo PUNTUAL** (prepago del contrato, una sola vez en mayo 2026). **NO recurrente mensual, NO se anualiza × 12** (recurre solo en la renovación) |
| `descripcion` | Coste del contrato Marketplace (`Fee` / `Global-SoftwareUsage-Contracts`) del producto `cgdwha66labso75ke7c05fbaz`, facturado en la cuenta `444455556666`. **Cargo puntual prepagado** (gotcha #3), no recurrente |
| `consulta_cur` | Consulta primaria de este registro (filtro de producto Marketplace, grupo `charge_type='Fee'` / `usage_type='Global-SoftwareUsage-Contracts'`) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T07:55:14Z` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` (sin `line_item_resource_id`; cargo a nivel de contrato) |
| `dimension_agregacion` | `line_item_line_item_type='Fee'` ∧ `usage_type='Global-SoftwareUsage-Contracts'` ∧ `product_code='cgdwha66labso75ke7c05fbaz'`; `SUM(line_item_unblended_cost)` |
| `verificacion_vivo` | `null` (oportunidad **contractual**, no de recurso físico — Req 5 no aplica) |
| `clasificacion` | `comercial` |

### `EV-14.1-MKT-PAYG` — Sobrecarga PAYG del mismo producto (señal de tier mal dimensionado)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-14.1-MKT-PAYG` |
| `cifra_publicada` | `6 663,33` USD/mes · `79 960,00` USD/año (× 12, con advertencia de estacionalidad) |
| `descripcion` | Sobrecarga PAYG (`Usage` / `MP:payg-Units`) del **mismo** producto Marketplace `cgdwha66labso75ke7c05fbaz`; indicador de un tier de infraestructura **mal dimensionado** (consumo por encima del contrato comprometido) — Req 17.2 |
| `consulta_cur` | Consulta primaria de este registro (grupo `usage_type LIKE 'MP:%'`) |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T07:55:14Z` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` (sin `line_item_resource_id`; cargo de uso a nivel de producto) |
| `dimension_agregacion` | `line_item_usage_type LIKE 'MP:%'` (`MP:payg-Units`) ∧ `product_code='cgdwha66labso75ke7c05fbaz'`; `SUM(line_item_unblended_cost)` |
| `verificacion_vivo` | `null` |
| `clasificacion` | `comercial` (señalado aparte; fuera del ahorro técnico) |

## Documentación de la Palanca (Req 4 — campos obligatorios)

| Campo | Valor |
|-------|-------|
| **Naturaleza** | **Palanca_Comercial** (contractual/negociación), **NO** técnica (Req 17.3) |
| **Supuesto de descuento/reducción** | `pendiente` — no se aplica supuesto de ahorro técnico; la reducción depende de renegociación/ajuste en renovación, cuyo % es desconocido sin la oferta comercial (Req 4.1, 17.5) |
| **% direccionable + coste base mensual afectado** | Coste base señalado: contrato `85 000,55` USD **(cargo puntual/prepago, no recurrente)** + PAYG `6 663,33` USD/mes **(recurrente)**. % direccionable técnico = `0,0` (no direccionable por palancas técnicas); el direccionamiento es **comercial** (Req 4.2) |
| **Origen del supuesto + fecha** | `tarifa negociada` (contrato Marketplace), términos **no disponibles** al analista a fecha `2026-06-23`; coste observado = CUR mayo 2026 (Req 4.3) |
| **Riesgo** | `pendiente` — depende de los términos de renegociación y de la dependencia del producto SaaS contratado (Req 4.4, 4.7) |
| **Esfuerzo** | `pendiente` — proceso comercial/de compras, no de ingeniería; no estimable por el analista FinOps (Req 4.5, 4.7) |
| **Owner** | `pendiente` (dirección + Compras) — Palanca transversal sin correo concreto asignado (Req 4.6, 4.7) |
| **Fecha de renovación del contrato** | **`pendiente`** (desconocida) — Req 17.4 |
| **Dependencia de realización** | **Renegociación o ajuste en renovación** del contrato Marketplace (Req 17.5). La sobrecarga PAYG (`6 663,33`/mes) sugiere que el tier contratado está **infradimensionado** frente al consumo real: una de las vías de optimización comercial es **redimensionar el tier** en la próxima renovación para absorber el PAYG dentro del contrato. |
| **Barrido_Utilizacion** | No aplica (no es Palanca técnica de Ahorro_Estimado) |

## Tratamiento en el Informe (Req 17.3, 17.5; anticipo de Tarea 19.4)

- El contrato Marketplace se presenta **por separado** del total de ahorro técnico y **nunca** entra
  en `Ahorro_Garantizado` ni en `Ahorro_Estimado` ni en el `Objetivo_Comprometido`
  (`Objetivo = Σ Garantizado + Σ Conservador(Estimado con Barrido)`; esta Palanca queda **excluida**
  por construcción — Property 12, Tarea 17.8).
- Se señala explícitamente que su realización **depende de renegociación o ajuste en renovación**
  (Req 17.5) y que la **fecha de renovación es "pendiente"** (Req 17.4).
- La sobrecarga PAYG se reporta como **indicador de tier mal dimensionado** (Req 17.2), no como
  ahorro técnico contabilizado.

## Notas metodológicas

- **Orden de discriminadores (gotcha heredado del Registro 1.1):** en la partición contable global,
  `MP:%` (PAYG) se evalúa **antes** que `cg%` (contrato) porque comparten `product_code`. En **este**
  registro la consulta agrupa por las tres columnas (`charge_type`, `product_code`, `usage_type`),
  de modo que contrato y PAYG salen como **filas separadas** sin riesgo de absorción; no hay
  ambigüedad de orden. La coherencia con la partición global (Registro 1.1) está garantizada porque
  las cifras coinciden exactamente (`85 000,55` y `6 663,33`).
- **Sin Verificacion_Recurso_Vivo:** al ser un cargo contractual SaaS sin recurso de infraestructura
  propio (`resource_id` vacío), no hay describe/list/get aplicable. El Req 5 (verificación en vivo)
  rige para candidatos técnicos derivados del CUR, no para Palancas comerciales.
- **Sin operaciones mutantes:** esta tarea solo lee el CUR vía Athena (consultas `SELECT`). No se
  ejecuta ninguna acción mutante (Req 5.1, 7.5).

## Estado de ejecución

- ✅ **Ejecutado** contra el `Dataset_Congelado` `frozen-2026-05@2026-06-23`; consultas lanzadas el
  `2026-06-23` (cifras ancladas a la fecha de extracción `2026-06-23T07:55:14Z` de la línea base
  contable, con la que coinciden exactamente — Registro 1.1).
- Cifras congeladas y reproducibles: re-ejecutar las consultas documentadas sobre el mismo
  Mes_Referencia y fecha de extracción debe producir diferencia `0,00 USD` (Req 7.3; auditoría en
  Tarea 17.6).
- `QueryExecutionId` retenidos: `8a502da1-21d2-43fc-b32a-7675cc1b1238` (primaria) y
  `7f2caedb-18a9-42a4-9ca8-7ffa59a18430` (refuerzo cuenta + `resource_id`).
