# Auditoría 17.1 — Property 1: Conservación contable y separación en 5 grupos

> **Naturaleza:** auditoría re-ejecutable de un spec analítico (NO software, sin PBT/tests de
> código). Se re-ejecuta la consulta de control de conservación sobre el `Dataset_Congelado` y se
> verifica que la partición del CUR del Mes_Referencia conserva el 100 % del coste.
>
> **Property 1: Conservación contable del coste total** — **Validates: Requirements 1.4, 1.6, 17.3**
>
> Fuente de cifras congeladas auditadas: `catalogo-evidencias.md`, Registros 1.1 y 1.4.
> Este artefacto NO modifica `catalogo-evidencias.md` ni ningún otro fichero del estudio.

## Veredicto

✅ **PASS.** La partición del CUR del Mes_Referencia es **exhaustiva** (`Σ dentro + Σ fuera = total
CUR`, sin huecos) y **disjunta** (cada partida activa exactamente una rama del `CASE`, sin solapes).
La diferencia exigida es `$0.00` y se obtiene `$0.00`; el conteo de filas se conserva exactamente
(`568.147 = 568.147`). Los **5 grupos del alcance + el puente SP/descuentos** reconstruyen el total
bruto de la organización. Las cifras re-ejecutadas coinciden con las congeladas en los Registros
1.1/1.4.

## Parámetros de la re-ejecución (anclaje)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |
| Moneda | `USD` |
| Motor / DB / tabla | Amazon Athena (CUR 2.0) · `athenacurcfn_finnops` · `data` |
| Región | `eu-west-1` |
| Cuenta CUR | `600700800900` (root-iskaypet) |
| Perfil de acceso | `root-iskaypet` (credenciales referenciadas por nombre de perfil, sin tokens incrustados — Req 7.5) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |
| Fecha de re-ejecución de la auditoría | `2026-06-23` (re-verificación Tarea 17.1) |
| `caller-identity` verificado | `arn:aws:sts::600700800900:assumed-role/AWSReservedSSO_MPA-AdministratorAccess_.../ruben.landin@emefinpetcare.com` |

## QueryExecutionIds reales de esta re-ejecución

| Consulta | Qué verifica | `QueryExecutionId` | Estado | Bytes escaneados |
|----------|--------------|--------------------|--------|-----------------:|
| **A** — Partición en 2 conjuntos (dentro/fuera) | subtotales dentro/fuera + conteo de filas | `e0c39bf5-aa11-4e1e-aeb3-bf1b671e2b30` | SUCCEEDED | 5.108.874 |
| **B** — Auto-control de conservación | `Σ(dentro+fuera) − total_CUR = 0,00` y filas conservadas | `89c1e3ca-0993-4313-ba10-17b6e2cef0df` | SUCCEEDED | 9.082.948 |
| **C** — 5 grupos del alcance + puente SP | unión de grupos = total bruto, sin solapes ni huecos | `bdbccdcf-d379-4810-8f00-526c122afaf5` | SUCCEEDED | 5.558.318 |

## Resultado — Consulta B (auto-control de conservación)

```
suma_particion   = 148553.35546862945
total_cur        = 148553.35546862945
diferencia_usd   = 0.0                  -- esperado 0.00  → ✅
filas_particion  = 568147
filas_total      = 568147
diferencia_filas = 0                    -- esperado 0     → ✅
```

`Σ dentro + Σ fuera = total CUR = 148.553,36 USD` (half-up, 2 decimales). Diferencia exacta `0,00
USD` y conteo de filas conservado al 100 %. **Sin huecos.**

## Resultado — Consulta A (partición en 2 conjuntos)

| `scope` | `subtotal_usd` (crudo) | Redondeado (USD) | `line_items` |
|---------|-----------------------:|-----------------:|-------------:|
| `dentro_alcance_tecnico` | 48 320,126592766544 | **48 320,13** | 468 210 |
| `fuera_alcance` | 100 233,22887572904 | **100 233,23** | 99 937 |
| **Σ (antes de redondear)** | **148 553,35546849558** | **148 553,36** | **568 147** |

- `Σ dentro + Σ fuera` (crudo) = `148.553,36 USD` = total CUR → conserva.
- Filas: `468.210 + 99.937 = 568.147` = filas totales → conserva.

## Resultado — Consulta C (5 grupos del alcance + puente SP/descuentos)

| `charge_group` | `unblended_usd` (crudo) | Redondeado (USD) | `line_items` | Congelado Reg. 1.1 | Conjunto |
|----------------|------------------------:|-----------------:|-------------:|-------------------:|----------|
| `marketplace_contract` | 85 000,55 | **85 000,55** | 1 | 85 000,55 | FUERA (Palanca_Comercial) |
| `infra_aws` | 48 320,126592766544 | **48 320,13** | 468 210 | 48 320,13 | **DENTRO** (alcance técnico) |
| `tax` | 9 448,989999999996 | **9 448,99** | 569 | 9 448,99 | FUERA |
| `marketplace_payg` | 6 663,3335806 | **6 663,33** | 1 | 6 663,33 | FUERA (tier mal dimensionado) |
| `flat_rate_subscription` | 904,7318399999954 | **904,73** | 916 | 904,73 | FUERA (tarifa plana) |
| `sp_discounts_bridge` | −1 784,3765448119314 | **−1 784,38** | 98 450 | −1 784,38 | FUERA (puente/cierre contable) |
| **Σ (antes de redondear)** | **148 553,3554685546** | **148 553,36** | **568 147** | 148 553,36 | total bruto |

- Los **5 grupos del alcance** (infra AWS, contrato Marketplace, PAYG mismo producto, Tax,
  FlatRateSubscription) **más** el puente SP/descuentos reconstruyen el total bruto
  `148.553,36 USD`, **sin solapes ni huecos**.
- Cada una de las 6 cifras coincide **exactamente** con la congelada en el Registro 1.1.
- Suma de `line_items` de los 6 grupos: `468.210 + 1 + 569 + 1 + 916 + 98.450 = 568.147` = filas
  totales → partición disjunta y exhaustiva confirmada a nivel de fila.

## Tabla de controles (Property 1)

| Control | Esperado | Obtenido | Veredicto |
|---------|----------|----------|-----------|
| `Σ dentro + Σ fuera = total CUR` (suma antes de redondear, Consulta A+B) | `148 553,36 USD` | `148 553,36 USD` | ✅ conserva |
| `diferencia_usd` (Consulta B) | `0,00 USD` | `0,0 USD` | ✅ sin huecos |
| `diferencia_filas` (Consulta B) | `0` | `0` | ✅ conteo de filas conservado |
| Unión de 5 grupos + puente = total bruto (Consulta C) | `148 553,36 USD` | `148 553,36 USD` | ✅ sin solapes ni huecos |
| Cada partida en exactamente un conjunto (`CASE … ELSE`) | exhaustivo + disjunto | exhaustivo + disjunto (568.147 filas a nivel de grupo y de scope) | ✅ |

## Orden crítico del `CASE` (verificado en re-ejecución)

La separación Marketplace se respeta con el orden canónico del Registro 1.1: `line_item_usage_type
LIKE 'MP:%'` (PAYG, `marketplace_payg`) se evalúa **antes** que `line_item_product_code LIKE 'cg%'`
(contrato, `marketplace_contract`), y ambos antes del bucket genérico `Usage` (`infra_aws`). El
resultado mantiene PAYG (`6.663,33`, 1 línea) separado del contrato (`85.000,55`, 1 línea) e
`infra_aws` limpio de marketplace (`48.320,13`), tal como exige el Req 17.3 / gotcha #3.

## Nota de redondeo (Req 6.7) — sin impacto en el veredicto

La conservación se verifica sobre los **valores crudos** (antes de redondear): `Σ dentro + Σ fuera
− total_CUR = 0,00` de forma exacta (Consulta B). La suma de los subtotales **ya redondeados** a 2
decimales (`48.320,13 + 100.233,23 = 148.553,36`, o por grupos `148.553,35`) puede arrojar artefactos
de `±0,01 USD`; son ruido de redondeo half-up, **no** fugas de partición. Detalle de matiz:

- El Registro 1.4 publica `Σ fuera = 100.233,22` como **suma de componentes ya redondeados**
  (`85.000,55 + 6.663,33 + 9.448,99 + 904,73 − 1.784,38`). El `SUM(cost)` crudo del conjunto `fuera`
  es `100.233,22887…`, que redondeado aislado daría `100.233,23`. Ambas representaciones difieren en
  `0,01 USD` por el orden de redondeo; la cifra oficial de conservación es la **suma antes de
  redondear**, que cuadra con el total CUR al céntimo (`diferencia_usd = 0,00`).

## Conclusión

Property 1 **CUMPLE (PASS)** en la re-ejecución de la Tarea 17.1 contra `frozen-2026-05@2026-06-23`.
La partición dentro/fuera y la descomposición en los 5 grupos del alcance + puente SP/descuentos son
exhaustivas y disjuntas, conservan el 100 % del coste (`148.553,36 USD`) y el 100 % de las filas
(`568.147`), con diferencia `0,00 USD`. Las cifras re-ejecutadas son idénticas a las congeladas en
los Registros 1.1 y 1.4. Re-ejecutar las Consultas A/B/C sobre el mismo Mes_Referencia y fecha de
extracción reproduce `diferencia_usd = 0,00` y `diferencia_filas = 0` (Req 7.3).
