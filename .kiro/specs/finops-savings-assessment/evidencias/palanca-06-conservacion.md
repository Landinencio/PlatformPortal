# Registro de auditoría — Palanca 6 · Conservación de costes base entre Sub_Palancas (Tarea 8.4)

**Validates: Requirements 3.4** · **Property 7 (parcial): suma de Sub_Palancas = coste base de la Palanca**

> Artefacto auditable de **análisis FinOps** (no software). **Auditoría re-ejecutable** de una
> *Correctness Property*, no un test de código. Verifica la **conservación de costes base** entre las
> tres Sub_Palancas de la Palanca 6 (EBS): que la suma de los costes base de **6a** (gp2→gp3), **6b**
> (snapshots) y **6c** (volúmenes huérfanos) es coherente con el coste base EBS de la Palanca **sin
> doble conteo**, asignando cada unidad de coste (GiB-mes / `vol-…`) a **una sola** Sub_Palanca
> (conjuntos disjuntos). Anclado al `Dataset_Congelado` `frozen-2026-05@2026-06-23`.
>
> Esta tarea **no modifica** los ficheros 06a/06b/06c; consolida sus cifras congeladas y reporta el
> resultado de conservación como anticipo de la auditoría completa de Property 7 (Tarea 17.4).

## Parámetros de anclaje (Req 2.5)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-8.4-ebs-conservacion-subpalancas-2026-05` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Naturaleza | **Auditoría de conservación** (consolidación de cifras congeladas de 6a/6b/6c); no ejecuta consultas CUR nuevas ni verificaciones en vivo |
| Fuentes | `palanca-06a-gp2-gp3.md` (EV-8.1), `palanca-06b-snapshots.md` (EV-8.2), `palanca-06c-volumenes-huerfanos.md` (EV-8.3) |
| Property auditada | **Property 7 (parcial)** — conservación de costes base entre Sub_Palancas de la Palanca 6 |

---

## 1. Costes base congelados de las Sub_Palancas (entrada de la auditoría)

| Sub_Palanca | Dimensión de coste | Naturaleza | Coste base congelado (USD/mes) | Fuente |
|-------------|--------------------|-----------|-------------------------------:|--------|
| **6a** gp2→gp3 | `VolumeUsage.gp2` (almacenamiento de volúmenes gp2 activos) — agregado CUR por cuenta | Estimado | **1 011,76** | EV-8.1 |
| **6b** Snapshots | `SnapshotUsage` (almacenamiento de snapshots EBS) — agregado CUR | Estimado | **402,93** | EV-8.2 |
| **6c** Huérfanos | Volúmenes en estado `available` — verificado en vivo (`GiB × tarifa pública[tipo]`) | Garantizado | **232,20** | EV-8.3 |

**Composición interna de 6c por tipo de volumen** (de EV-8.3 §5), necesaria para el análisis de solape:

| Componente de 6c | GiB-mes | Tarifa pública (`eu-west-1`) | Coste (USD/mes) | ¿Solapa con 6a (`VolumeUsage.gp2`)? |
|------------------|--------:|------------------------------|----------------:|:-----------------------------------:|
| gp2 huérfano (eks-dev 1 830 + ecommerce-tiendanimal 322 + eks-tooling 8) | 2 160 | `0,10 USD/GB-mes` | **216,00** | **Sí** (es gp2 activo facturando `VolumeUsage.gp2`) |
| gp3 huérfano (ecommerce-tiendanimal 40 + retail-prod 50 + eks-tooling 25) | 115 | `0,08 USD/GB-mes` | 9,20 | No (dimensión gp3, no gp2) |
| standard huérfano (ecommerce-tiendanimal 140) | 140 | `0,05 USD/GB-mes` | 7,00 | No (dimensión magnética, no gp2) |
| **Total 6c** | **2 415** | | **232,20** | |

---

## 2. El solape detectado y el ajuste de no-doble-conteo (Req 8.8, 3.4)

**Hecho clave (de EV-8.3 §6).** Un volumen **gp2 en estado `available`** (huérfano) **sigue
facturando** `VolumeUsage.gp2` mientras existe. Por tanto sus **2 160 GiB-mes = 216,00 USD/mes** están
**incluidos simultáneamente** en:

- el **coste base de 6a** (`VolumeUsage.gp2` = 1 011,76, que agrega *todos* los volúmenes gp2,
  activos y huérfanos), y
- el **coste base de 6c** (volúmenes `available`, valorados a tarifa pública).

Contar esos $216,00 en ambas Sub_Palancas sería **doble conteo** y violaría Property 7 / Req 8.8.

**Regla de asignación (determinista).** La acción correcta sobre un volumen huérfano es **eliminarlo**
(6c, Garantizado), **no** migrarlo a gp3 (6a, Estimado). Por tanto la unidad de coste del gp2 huérfano
se **asigna a 6c** y se **resta de la base direccionable de 6a**, dejando los conjuntos de `vol-…`
**disjuntos**:

```
Base direccionable de 6a (ajustada) = Coste base 6a − gp2 huérfano (solape con 6c)
                                     = 1 011,76 − 216,00
                                     = 795,76 USD/mes
```

> Los componentes **gp3** (9,20) y **standard** (7,00) de 6c **no** solapan con la base de 6a (que es
> exclusivamente `VolumeUsage.gp2`): pertenecen a otras dimensiones de `VolumeUsage` que 6a no
> direcciona. La Sub_Palanca **6b** (`SnapshotUsage`) es una **dimensión de coste disjunta** del coste
> de volumen (`VolumeUsage`) y **no solapa** con 6a ni con 6c.

---

## 3. Partición en conjuntos disjuntos (resultado de la asignación)

Tras el ajuste, las tres Sub_Palancas operan sobre **conjuntos de unidades de coste mutuamente
disjuntos** (Req 8.8):

| Sub_Palanca | Conjunto de unidades de coste (disjunto) | Coste base disjunto (USD/mes) |
|-------------|-------------------------------------------|------------------------------:|
| **6a** (ajustada) | `VolumeUsage.gp2` de volúmenes gp2 **activos (no huérfanos)** | **795,76** |
| **6b** | `SnapshotUsage` (snapshots EBS) — dimensión disjunta de volumen | **402,93** |
| **6c** | **Todos** los volúmenes `available` (216,00 gp2 + 9,20 gp3 + 7,00 standard) | **232,20** |
| | **Σ disjunta (suma de Sub_Palancas)** | **1 430,89** |

### Disyunción de conjuntos de `vol-…` (Req 8.8)

- **6c** enumera **27 `vol-…`** concretos (14 eks-dev gp2 + 7 ecommerce-tiendanimal + 1 retail-prod
  gp3 + 5 eks-tooling), de los cuales **22 son gp2** (los 2 160 GiB-mes del solape).
- **6a (ajustada)** cubre el resto de volúmenes **gp2 activos** — es decir, `VolumeUsage.gp2`
  **excluyendo** esos 22 `vol-…` huérfanos. Conjuntos de `vol-…` **disjuntos** ✅.
- **6b** opera sobre **`line_item_resource_id` de snapshots** (1 216 snapshots distintos), un espacio
  de identificadores **disjunto** del de volúmenes ✅.

---

## 4. Ecuación de conservación — coste base EBS de la Palanca (Property 7 parcial)

El **coste base EBS de la Palanca** (universo de coste direccionable que la Palanca 6 toca) es la
**unión de los conjuntos disjuntos** de las tres Sub_Palancas:

```
Coste_base_Palanca_6 (EBS) = VolumeUsage.gp2 (activo + huérfano)   [6a completa]
                           + SnapshotUsage                          [6b]
                           + volúmenes huérfanos no-gp2 (gp3+std)   [parte de 6c no contenida en 6a]

                           = 1 011,76 + 402,93 + (9,20 + 7,00)
                           = 1 011,76 + 402,93 + 16,20
                           = 1 430,89 USD/mes
```

**Verificación de conservación (suma de Sub_Palancas disjuntas = coste base de la Palanca):**

```
Σ Sub_Palancas (disjunta) = 6a_ajustada + 6b + 6c
                          = 795,76 + 402,93 + 232,20
                          = 1 430,89 USD/mes   ✅  == Coste_base_Palanca_6
```

**Conservación confirmada:** `1 430,89 == 1 430,89` · diferencia **0,00 USD**. ✅

### Comprobación cruzada del solape (el doble conteo eliminado es exactamente el esperado)

```
Σ naïve (sin ajuste)  = 6a + 6b + 6c        = 1 011,76 + 402,93 + 232,20 = 1 646,89 USD/mes
Σ disjunta (ajustada) = Σ naïve − solape gp2 = 1 646,89 − 216,00          = 1 430,89 USD/mes
```

La diferencia entre la suma naïve y la suma disjunta es **exactamente 216,00 USD/mes**, es decir, el
**único** GiB-mes contado dos veces (gp2 huérfano). No hay otros solapes. ✅

> **Redondeo (Req 6.7).** Todas las cifras intermedias provienen de los totales ya sumados-antes-de-
> redondear de EV-8.1/8.2/8.3; las operaciones de esta auditoría (restas y sumas de totales) preservan
> los 2 decimales half-up sin reintroducir error de redondeo.

---

## 5. Resultado de la auditoría (conservación)

| Comprobación | Resultado |
|--------------|:---------:|
| Solape único identificado (gp2 huérfano en 6a ∩ 6c) | **216,00 USD/mes** |
| Ajuste de no-doble-conteo aplicado (216,00 asignado a 6c, restado de 6a) | ✅ |
| 6b (`SnapshotUsage`) es dimensión de coste disjunta de volumen | ✅ |
| Conjuntos de `vol-…` / `resource_id` disjuntos entre 6a, 6b y 6c | ✅ |
| Σ Sub_Palancas disjuntas (795,76 + 402,93 + 232,20) = coste base Palanca (1 430,89) | ✅ **0,00 USD** |
| **Property 7 (parcial) para la Palanca 6** | **CONFIRMADA (PASA)** |

**Conclusión.** La Palanca 6 (EBS) **conserva** su coste base entre Sub_Palancas: una vez asignado el
gp2 huérfano a 6c (eliminación/Garantizado) y restado de la base direccionable de 6a, la suma de los
costes base de 6a (795,76), 6b (402,93) y 6c (232,20) **iguala** el coste base EBS de la Palanca
(1 430,89 USD/mes) con **diferencia 0,00 USD** y **sin ninguna unidad de coste contada dos veces**.
La auditoría completa de Property 7 a nivel de Informe (incluyendo las Palancas que compiten por el
mismo gasto, p. ej. compromiso EC2 vs Spot/scheduling) se realiza en la **Tarea 17.4**.

---

## 6. Tabla resumen para la consolidación de la Palanca 6

| Sub_Palanca | Clasificación | Coste base **declarado** (USD/mes) | Ajuste no-doble-conteo | Coste base **disjunto** (USD/mes) |
|-------------|---------------|-----------------------------------:|------------------------|----------------------------------:|
| 6a gp2→gp3 | Estimado | 1 011,76 | − 216,00 (gp2 huérfano → 6c) | **795,76** |
| 6b Snapshots | Estimado | 402,93 | 0,00 (dimensión disjunta) | **402,93** |
| 6c Huérfanos | Garantizado | 232,20 | + 216,00 ya incluido (asignado aquí) | **232,20** |
| **Total Palanca 6 (EBS)** | Mixta | (1 646,89 naïve) | − 216,00 solape | **1 430,89** |

> **Nota para la consolidación.** El **ahorro** de cada Sub_Palanca se calcula en su propio registro
> (6a: 151,76–212,38 USD/mes Estimado sobre su base; 6b: 20,15–60,44 USD/mes Estimado; 6c: 232,20
> USD/mes Garantizado). Esta auditoría sólo verifica la conservación del **coste base** (no suma
> ahorros). El ajuste de la base direccionable de 6a a **795,76 USD/mes** debe reflejarse al estrechar
> el % neto de 6a tras la verificación en vivo de rendimiento (EV-8.1, dependencia pendiente), pero
> **no** altera el rango de ahorro ya publicado de 6a (expresado como % sobre su base gp2).

---

## 7. Registro de evidencia (esquema del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-8.4-ebs-conservacion-subpalancas-2026-05` |
| `descripcion` | Auditoría de conservación de costes base entre las Sub_Palancas 6a/6b/6c de la Palanca 6 (EBS); aplica el ajuste de no-doble-conteo del gp2 huérfano y confirma Property 7 (parcial) |
| `cifra_publicada` | Coste base EBS de la Palanca (disjunto) = `1 430,89 USD/mes`; solape eliminado = `216,00 USD/mes`; conservación = diferencia `0,00 USD` |
| `consulta_cur` | **No aplica** — auditoría de consolidación; consolida las cifras congeladas de EV-8.1 (`VolumeUsage.gp2`), EV-8.2 (`SnapshotUsage`) y EV-8.3 (verificación en vivo `describe-volumes`). Las consultas/comandos re-ejecutables están en cada registro fuente |
| `mes_referencia` | `2026-05` |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | `["no atribuible a recurso"]` (cifra de conservación agregada; los 27 `vol-…` de 6c y los 1 216 snapshots de 6b están enumerados en sus registros fuente) |
| `dimension_agregacion` | Unión disjunta de dimensiones EBS: `VolumeUsage.gp2` (6a) ⊕ `SnapshotUsage` (6b) ⊕ volúmenes `available` (6c); valor = Σ de costes base disjuntos |
| `verificacion_vivo` | Heredada de EV-8.3 (6c) — `ec2 describe-volumes` solo lectura; esta tarea no ejecuta verificaciones nuevas |
| `clasificacion` | `auditoria` (Correctness Property — Property 7 parcial) |

---

## 8. Re-ejecución de la auditoría (procedimiento)

La auditoría es **re-ejecutable** y debe producir el mismo resultado de conservación (diferencia
`0,00 USD`) mientras los registros fuente sigan anclados al `Dataset_Congelado`
`frozen-2026-05@2026-06-23`:

1. Releer los costes base congelados: 6a = `1 011,76`, 6b = `402,93`, 6c = `232,20` (USD/mes).
2. Extraer de EV-8.3 §6 el solape gp2 huérfano (gp2 `available`): `2 160 GiB × 0,10 = 216,00 USD/mes`.
3. Calcular la base disjunta de 6a: `1 011,76 − 216,00 = 795,76`.
4. Calcular el coste base de la Palanca: `1 011,76 + 402,93 + (9,20 + 7,00) = 1 430,89`.
5. Verificar la conservación: `795,76 + 402,93 + 232,20 = 1 430,89` → diferencia con (4) = **0,00 USD**.
6. Comprobación cruzada del solape: `Σ naïve (1 646,89) − solape (216,00) = 1 430,89`.

Cualquier diferencia distinta de `0,00 USD` indicaría un cambio en alguna cifra base fuente (drift del
`Dataset_Congelado` o reexpresión del CUR) y debe investigarse antes de publicar el Informe (Req 7.3).

## 9. Estado de ejecución

- ✅ **Ejecutada** la auditoría de conservación contra las cifras congeladas de EV-8.1/8.2/8.3
  (`Dataset_Congelado` `frozen-2026-05@2026-06-23`).
- ✅ Solape único identificado y resuelto: **gp2 huérfano 216,00 USD/mes** asignado a 6c y restado de
  la base direccionable de 6a (795,76 USD/mes).
- ✅ 6b (`SnapshotUsage`) confirmada como dimensión de coste disjunta; conjuntos de `vol-…` /
  `resource_id` disjuntos entre las tres Sub_Palancas.
- ✅ **Property 7 (parcial) CONFIRMADA** para la Palanca 6: Σ Sub_Palancas disjuntas = coste base EBS
  de la Palanca = `1 430,89 USD/mes` (diferencia `0,00 USD`).
- ⏳ La auditoría completa de Property 7 a nivel de Informe (todas las Palancas, incluidas las que
  compiten por el mismo gasto) se realiza en la **Tarea 17.4**.
