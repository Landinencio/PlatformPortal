# Registro de evidencia — Palanca 6 · Sub_Palanca 6c: Volúmenes EBS huérfanos (Tarea 8.3)

**Validates: Requirements 10.3, 10.6, 10.7, 5.1, 3.1, 3.2**

> Artefacto auditable de **análisis FinOps** (no software). Identifica los volúmenes EBS en estado
> `available` (huérfanos) mediante **Verificacion_Recurso_Vivo de solo lectura**
> (`ec2 describe-volumes --filters Name=status,Values=available`, Req 10.3/5.1), registrando por
> cuenta el identificador, el tamaño en GiB y la antigüedad (Req 10.3). Un huérfano confirmado **sin**
> etiquetas warm-spare / forense / retención se clasifica como **Ahorro_Garantizado** (cifra única,
> Req 10.6, 3.1); con esas etiquetas → pendiente de confirmación manual, **excluido** de Garantizado
> (Req 10.7). Frescura de la verificación ≤ 30 días (Req 3.2). Anclado al `Dataset_Congelado`
> `frozen-2026-05@2026-06-23`.
>
> Palanca 6 es **mixta** → se parte en Sub_Palancas: **6a** gp2→gp3 (Estimado, Tarea 8.1), **6b**
> snapshots (Estimado, Tarea 8.2), **6c** volúmenes huérfanos (**Garantizado**, este registro). La
> conservación de costes base entre Sub_Palancas se audita en la Tarea 8.4 (Property 7 parcial); ver
> §6 "Disyunción y no doble conteo con 6a".

## Parámetros de anclaje (Req 1.2, 1.3, 2.5)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-8.3-ebs-volumenes-huerfanos-2026-05` |
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Fecha de extracción (verificación en vivo) | `2026-06-23T09:01:54Z` (UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Moneda | `USD` |
| Naturaleza de la cifra | **Verificada en vivo** (no derivada del CUR): coste = GiB × tarifa pública por tipo de volumen |
| Región de verificación | `eu-west-1` (todas las cuentas) |
| Acceso | SSO SRE por cuenta (`sso_start_url=https://iskaypet.awsapps.com/start`, `sso_role_name=SRE`); credenciales referenciadas por **nombre de perfil**, sin incrustar tokens (Req 7.5) |

**Naturaleza del registro.** A diferencia de 6a/6b (cifras de coste agregadas del CUR), la cifra de
6c es una **palanca verificada en vivo**: el coste mensual de los volúmenes huérfanos se calcula como
`GiB × tarifa pública por tipo de volumen` (`eu-west-1`), donde los GiB y el tipo proceden de la
verificación `ec2 describe-volumes`. Esta es la base correcta para un Ahorro_**Garantizado**: la
eliminación del volumen `available` retira la **totalidad** de su coste de almacenamiento sin pérdida
de capacidad (el volumen no está asociado a ninguna instancia). Cada cifra es atribuible al recurso
real (`vol-…`, Req 2.2).

---

## 1. Verificacion_Recurso_Vivo de solo lectura (Req 5.1, 5.5, 10.3)

**Comando canónico (describe/list/get — ninguna operación mutante), región `eu-west-1`:**

```bash
# Volúmenes huérfanos (estado available) por cuenta — solo lectura
aws ec2 describe-volumes \
  --profile <perfil-sso-sre> --region eu-west-1 \
  --filters Name=status,Values=available \
  --query 'Volumes[].{id:VolumeId,size:Size,type:VolumeType,az:AvailabilityZone,created:CreateTime,iops:Iops,tp:Throughput,tags:Tags}' \
  --output json
```

**Barrido re-ejecutable sobre todas las cuentas con rol SRE** (perfiles del `portal-architecture.md`
§7; `<perfil>` ∈ la lista de cuentas en alcance), idéntico al ejecutado:

```bash
for P in eks-dev eks-uat eks-prd eks-tooling digital-dev digital-uat digital-prod \
         digital-ecommerce retail-dev retail-uat retail-prod helios-dev helios-uat \
         helios-prod animalis-dev animalis-prod infra iskaypet-data data-dev \
         iskaypet-ecommerce ecommerce-tiendanimal clinicanimal sap sistemas-tiendanimal; do
  aws ec2 describe-volumes --profile "$P" --region eu-west-1 \
    --filters Name=status,Values=available \
    --query 'Volumes[].{id:VolumeId,size:Size,type:VolumeType,created:CreateTime,iops:Iops,tp:Throughput,tags:Tags}' \
    --output json
done
```

> **Solo lectura (Req 5.1; auditoría en Tarea 17.7):** todos los comandos son `describe-volumes`
> (lectura). **No** se ejecutó ninguna operación mutante (`delete-volume`, `detach-volume`,
> `modify-volume`, etc.). El drift del recurso vivo entre esta verificación y futuras re-ejecuciones
> es esperado (Req 7.6).
>
> **Antigüedad desde la desasociación (Req 10.3).** `describe-volumes` expone `CreateTime` pero **no**
> el instante de la última desasociación. Se usa `CreateTime` como **cota inferior** de antigüedad
> (un volumen `available` lleva sin asociar como mínimo desde antes de "ahora"); la fecha exacta de
> desasociación requeriría el evento `DetachVolume` de CloudTrail (fuera del alcance del describe de
> solo lectura). Los volúmenes con `CreateTime` de 2015–2023 son huérfanos manifiestamente estancados.

---

## 2. Resultado congelado — volúmenes `available` por cuenta (verificado `2026-06-23T09:01:54Z`)

**Cuentas CON volúmenes huérfanos confirmados:**

| Cuenta (ID) | Nombre (perfil) | Vols | GiB | Tipos | Etiquetas warm-spare/forense/retención | Estado |
|-------------|------------------|-----:|----:|-------|:--------------------------------------:|--------|
| 111122223333 | EKS Dev (eks-dev) | 14 | 1 830 | gp2 ×14 | **0** | confirmado |
| 222333444555 | Ecommerce Tiendanimal (ecommerce-tiendanimal) | 7 | 502 | gp2 ×4, gp3 ×2, standard ×1 | **0** | confirmado |
| 666777888999 | Retail Prod (retail-prod) | 1 | 50 | gp3 ×1 | **0** | confirmado |
| 444455556666 | EKS Tooling (eks-tooling) | 5 | 33 | gp2 ×4, gp3 ×1 | **0** | confirmado |
| | **Total confirmado** | **27** | **2 415** | | **0** | |

> Concordancia con el `design.md` (Sub_Palanca 6c): el ejemplo declaraba **«`eks-dev` 14 vols /
> 1830 GiB available; `eks-tooling` 33 GiB»** — ambos **coinciden exactamente** con la verificación.
> `retail-prod` (50 GiB) y `ecommerce-tiendanimal` (502 GiB) son hallazgos adicionales de este barrido.

**Detalle por volumen (cifra atribuida a recurso real — Req 2.2):**

### EKS Dev (111122223333) — 14 vols / 1 830 GiB · todos gp2 · etiquetas especiales: 0

| `vol-…` | GiB | Tipo | Creado (UTC) | IOPS | Throughput | nTags | Observación |
|---------|----:|------|--------------|-----:|-----------:|------:|-------------|
| vol-073c6ae86794159f0 | 80 | gp2 | 2026-05-27 | 240 | — | 9 | PVC k8s `nominatim-portugal` (PV huérfano) |
| vol-05c24ce0c9dc9ab7e | 20 | gp2 | 2025-04-29 | 100 | — | 0 | sin etiquetas (huérfano estancado >1 año) |
| vol-0f35cf67adc61c485 | 100 | gp2 | 2026-03-20 | 300 | — | 8 | PVC k8s `nominatim-spain` |
| vol-08a1ac41477deb4c0 | 200 | gp2 | 2026-05-27 | 600 | — | 9 | PVC k8s `nominatim-france` |
| vol-07fc0dc5dd1ac1a38 | 150 | gp2 | 2026-03-23 | 450 | — | 8 | PVC k8s `nominatim-spain` |
| vol-00221161472bc49a2 | 200 | gp2 | 2026-03-26 | 600 | — | 8 | PVC k8s `nominatim` |
| vol-0bfeee7fc536a241e | 80 | gp2 | 2026-03-20 | 240 | — | 8 | PVC k8s `nominatim` |
| vol-0db1bba2ac8245210 | 150 | gp2 | 2026-03-23 | 450 | — | 8 | PVC k8s `nominatim` |
| vol-02876d2fe7da6049d | 150 | gp2 | 2026-03-24 | 450 | — | 8 | PVC k8s `nominatim` |
| vol-0d06c44c4650f90f4 | 100 | gp2 | 2026-03-20 | 300 | — | 8 | PVC k8s `nominatim` |
| vol-02edeae946b6b4bf4 | 150 | gp2 | 2026-03-23 | 450 | — | 8 | PVC k8s `nominatim` |
| vol-042125571f0a04c5b | 150 | gp2 | 2026-05-27 | 450 | — | 9 | PVC k8s `nominatim` |
| vol-04ebde73a0202e002 | 150 | gp2 | 2026-03-21 | 450 | — | 8 | PVC k8s `nominatim` |
| vol-0177e3f44a6d1b300 | 150 | gp2 | 2026-03-21 | 450 | — | 8 | PVC k8s `nominatim` |

> Todos son PVs huérfanos del clúster `dp-dev` (CSI EBS, namespace `nominatim`) o volúmenes sin
> etiqueta; ninguno lleva `warm-spare`, `forense` ni `retención`. Todos `gp2`, IOPS base (≤ 600,
> < 3 000) → tarifa pública pura sin IOPS extra.

### Ecommerce Tiendanimal (222333444555) — 7 vols / 502 GiB · etiquetas especiales: 0

| `vol-…` | GiB | Tipo | Creado (UTC) | Tag keys | Observación |
|---------|----:|------|--------------|----------|-------------|
| vol-0d3f0ba61f24a0f3b | 20 | gp3 | 2023-06-26 | (ninguna) | huérfano sin etiquetas |
| vol-0a7d8c1b0d7cd77bb | 100 | gp2 | 2019-07-23 | Name, customer, app, phase, stack | huérfano estancado (>6 años) |
| vol-0c87250bd381de3a7 | 20 | gp3 | 2021-02-10 | Name, app, customer, phase, stack | huérfano estancado |
| vol-0f8ba750f32749a75 | 150 | gp2 | 2017-03-28 | Name, customer, stack, app, phase | huérfano estancado (>9 años) |
| vol-ef1bfc2a | 140 | standard | 2016-04-29 | Name, customer | magnético legacy huérfano (>10 años) |
| vol-45bbc75a | 64 | gp2 | 2015-07-22 | app, customer, stack, Name, phase | huérfano estancado (>10 años) |
| vol-0cff57cd1d0d3e264 | 8 | gp2 | 2017-11-29 | customer, Name | huérfano estancado |

> Etiquetas presentes (`Name`, `customer`, `app`, `phase`, `stack`) son metadatos genéricos de
> aplicación; **ninguna** es warm-spare / forense / retención. Volúmenes muy antiguos (2015–2023) →
> huérfanos manifiestos.

### Retail Prod (666777888999) — 1 vol / 50 GiB · etiquetas especiales: 0

| `vol-…` | GiB | Tipo | Creado (UTC) | IOPS | Throughput | nTags |
|---------|----:|------|--------------|-----:|-----------:|------:|
| vol-042aaa2b744084be5 | 50 | gp3 | 2023-09-12 | 3 000 | 125 | 0 | (base gp3, sin IOPS/throughput extra) |

### EKS Tooling (444455556666) — 5 vols / 33 GiB · etiquetas especiales: 0

| `vol-…` | GiB | Tipo | Creado (UTC) | IOPS | Throughput | nTags |
|---------|----:|------|--------------|-----:|-----------:|------:|
| vol-0ac6d8b58f05f38b2 | 1 | gp2 | 2025-08-19 | 100 | — | 8 |
| vol-019b14c04f29e6d7d | 5 | gp2 | 2026-01-30 | 100 | — | 8 |
| vol-03b3889de35722105 | 1 | gp2 | 2026-06-05 | 100 | — | 9 |
| vol-00c174a64ff2c962f | 1 | gp2 | 2025-09-22 | 100 | — | 8 |
| vol-0753a4af08124c2fa | 25 | gp3 | 2022-02-11 | 3 000 | 125 | 5 | (base gp3, sin extra) |

---

## 3. Cuentas con cero volúmenes huérfanos y cuentas no verificables (Req 1.1, 1.7, 1.8, 5.4)

**Cuentas verificadas con 0 volúmenes `available`** (en alcance, sin desperdicio en esta palanca):
`eks-uat` (222233334444), `eks-prd` (333344445555), `digital-dev` (999900001111),
`digital-uat` (000011112222), `digital-prod` (111222333444), `digital-ecommerce` (888899990000),
`retail-dev` (444555666777), `retail-uat` (555666777888), `helios-dev` (555566667777),
`helios-uat` (666677778888), `helios-prod` (777788889999), `infra` (300400500600),
`iskaypet-data` (200300400500), `data-dev` (100200300400), `iskaypet-ecommerce` (333444555666),
`clinicanimal` (999000111222), `sap` (400500600700), `sistemas-tiendanimal` (500600700800).

**Cuentas `no_verificable`** (permisos de solo lectura denegados o sin rol — excluidas de Garantizado,
mantenidas en alcance, Req 1.8, 5.4):

| Cuenta (ID) | Perfil | Motivo | Estado |
|-------------|--------|--------|--------|
| 777888999000 | animalis-dev | `GetRoleCredentials … ForbiddenException: No access` (rol SRE sin acceso) | no_verificable |
| 888999000111 | animalis-prod | `GetRoleCredentials … ForbiddenException: No access` (rol SRE sin acceso) | no_verificable |
| 400600800100 | log | sin rol de lectura SRE (per `portal-architecture.md` §7) | no_verificable |
| 100300500700 | pruebas | sin rol de lectura SRE | no_verificable |
| 700800900100 / 800900100200 / 900100200300 / 200400600800 | 4× sandbox | sin rol de lectura SRE | no_verificable |
| 600700800900 | root-iskaypet | rol admin propio (no SRE); no barrido en esta tarea | no_verificable |

> Las cuentas `no_verificable` se **excluyen del ahorro contabilizado** de 6c y se documentan con su
> motivo (Req 5.4). Re-ejecutar el barrido en esas cuentas cuando se disponga del rol de lectura
> permitiría ampliar el Garantizado (pendiente).

---

## 4. Origen del supuesto de precio (Req 4.3) — precio público AWS, fecha 2026-06-23

| Tipo de volumen | Precio público AWS (`eu-west-1`) | Nota |
|-----------------|----------------------------------|------|
| gp2 — almacenamiento | `0,10 USD / GB-mes` | Rendimiento derivado del tamaño (sin IOPS/throughput facturados aparte) |
| gp3 — almacenamiento | `0,08 USD / GB-mes` | Base 3 000 IOPS + 125 MiB/s **gratis**; todos los gp3 huérfanos están en base → **sin coste extra** |
| standard (magnético) | `0,05 USD / GB-mes` | + `0,05 USD / millón de I/O`; un volumen `available` está ocioso → I/O ≈ 0 |

Origen: **precio público AWS** (lista pública EBS, región Europe-Ireland `eu-west-1`), consultado el
`2026-06-23`. No se usa tarifa negociada.

---

## 5. Cálculo del Ahorro_Garantizado (cifra única — Req 3.1, 10.6)

La eliminación de un volumen `available` (huérfano) retira **el 100 %** de su coste de almacenamiento
sin pérdida de capacidad → **Ahorro_Garantizado**, expresado como **cifra única** (no rango).

```
Ahorro_Garantizado_mensual = Σ_volúmenes_huérfanos ( GiB × tarifa_pública[tipo] )
```

| Cuenta | gp2 (GiB × 0,10) | gp3 (GiB × 0,08) | standard (GiB × 0,05) | Subtotal mensual (USD) |
|--------|-----------------:|-----------------:|----------------------:|-----------------------:|
| EKS Dev (111122223333) | 1 830 × 0,10 = 183,00 | — | — | **183,00** |
| Ecommerce Tiendanimal (222333444555) | 322 × 0,10 = 32,20 | 40 × 0,08 = 3,20 | 140 × 0,05 = 7,00 | **42,40** |
| Retail Prod (666777888999) | — | 50 × 0,08 = 4,00 | — | **4,00** |
| EKS Tooling (444455556666) | 8 × 0,10 = 0,80 | 25 × 0,08 = 2,00 | — | **2,80** |
| **Total (sumado antes de redondear, half-up — Req 6.7)** | | | | **232,20** |

**Ahorro_Garantizado = `232,20 USD/mes`** · **anualizado ×12 = `2 786,40 USD/año`**.

**Advertencia de anualización (Req 6.4):** la cifra anual = mensual × 12 asume que el parque de
volúmenes huérfanos del Mes_Referencia es representativo y **no captura estacionalidad**. A diferencia
de un ahorro recurrente garantizado, este es un **saneamiento puntual**: una vez eliminados los 27
volúmenes, el ahorro se materializa y deja de "acumularse" (no reaparece salvo nuevos huérfanos). La
cifra anual debe leerse como *coste evitado a 12 meses si los volúmenes siguieran existiendo*, no como
un flujo perpetuo.

**Frescura (Req 3.2):** verificación `2026-06-23T09:01:54Z`, mismo día que el `Dataset_Congelado`
`frozen-2026-05@2026-06-23` → frescura **0 días** ≤ 30 días ✅. Reverificar si la publicación del
Informe supera los 30 días desde esta fecha.

**Clasificación: `garantizado`.** Los 27 volúmenes están confirmados `available` en vivo y **ninguno**
lleva etiquetas warm-spare / forense / retención (Req 10.6). No hay candidatos con esas etiquetas en
este barrido, por lo que **ninguno** queda pendiente de confirmación manual por la regla 10.7 (ver §7).

---

## 6. Disyunción y no doble conteo con 6a (Property 7 — entrada para Tareas 8.4 / 17.4)

**Solape detectado con la Sub_Palanca 6a (gp2→gp3).** Un volumen gp2 en estado `available` **sigue
facturando** `VolumeUsage.gp2` mientras existe, por lo que su GiB-mes está **incluido** en el coste
base gp2 de 6a (`1 011,76 USD/mes`). Para respetar la **ausencia de doble conteo** (Property 7, Req
3.4/8.8), la unidad de coste de un volumen huérfano se asigna a **una sola** palanca: como la acción
correcta sobre un huérfano es **eliminarlo** (6c, Garantizado), no migrarlo (6a, Estimado), su coste
debe **atribuirse a 6c** y **restarse de la base direccionable de 6a**.

| Concepto | GiB-mes | Coste gp2 (USD/mes) |
|----------|--------:|--------------------:|
| gp2 huérfano en eks-dev | 1 830 | 183,00 |
| gp2 huérfano en ecommerce-tiendanimal | 322 | 32,20 |
| gp2 huérfano en eks-tooling | 8 | 0,80 |
| **gp2 huérfano total (solapa con base gp2 de 6a)** | **2 160** | **216,00** |

> **Nota para la auditoría de conservación (Tarea 8.4 / Property 7, y Tarea 17.4):** la base
> direccionable de 6a debería reducirse en **216,00 USD/mes** (2 160 GiB-mes de gp2 huérfano) para
> mantener los conjuntos de `vol-…` **disjuntos** entre 6a y 6c. Los volúmenes huérfanos `gp3`
> (40 + 25 + 50 = 115 GiB) y `standard` (140 GiB) **no** solapan con la base gp2 de 6a. Este registro
> **no modifica** el fichero de 6a; deja constancia del ajuste para que la consolidación de la Palanca
> 6 (8.4) lo aplique. La Sub_Palanca 6b (snapshots, `SnapshotUsage`) es una dimensión de coste
> disjunta y no solapa con 6c.

---

## 7. Documentación de la Palanca (Req 4)

| Campo (Req 4) | Valor |
|---------------|-------|
| **Supuesto de reducción** (4.1, % 0–100, 1 decimal) | **100,0 %** — eliminar un volumen `available` retira la totalidad de su coste de almacenamiento (supresión directa, no descuento) |
| **% direccionable + coste base mensual afectado** (4.2) | **100,0 %** direccionable (27/27 volúmenes confirmados huérfanos sin etiquetas de exclusión); **coste base mensual afectado = 232,20 USD/mes** (2 415 GiB en 4 cuentas) |
| **Origen del supuesto + fecha** (4.3) | **Precio público AWS** (lista EBS `eu-west-1`), fecha **2026-06-23**. No es tarifa negociada |
| **Riesgo** (4.4) | **bajo** — los volúmenes no están asociados a ninguna instancia; su eliminación no afecta capacidad. Mitigación recomendada: snapshot de respaldo previo al borrado y confirmación de no-dependencia |
| **Esfuerzo** (4.5) | **bajo** — `delete-volume` por volumen (automatizable); sin migración de datos. Los PV huérfanos de k8s (eks-dev/`nominatim`) pueden requerir limpieza de `PersistentVolume`/`PVC` asociados |
| **Owner** (4.6, 4.7) | **pendiente** — SRE por cuenta (eks-dev y eks-tooling: SRE/Platform; ecommerce-tiendanimal: squad Commerce/SRE; retail-prod: squad Retail/SRE) |
| **Campos no evaluables** (4.7) | `owner` registrado como **"pendiente"** en lugar de omitirse |
| **Barrido_Utilizacion** | **No requerido** — 6c es Garantizado verificado en vivo; no depende de perfil de uso p95 ni de tasa de descuento. (No aplica la regla de gating del Req 18) |
| **Clasificación** | **Ahorro_Garantizado** (cifra única `232,20 USD/mes`) |

**Manejo del caso de borde Req 10.7 (etiquetas warm-spare/forense/retención).** En este barrido
**ningún** volumen huérfano lleva esas etiquetas (`special=0` en las 4 cuentas), por lo que no hay
volúmenes a excluir de Garantizado por esta regla. Si una re-ejecución encontrara un huérfano con
etiqueta `warm-spare`, `forense` o `retención` (o equivalente de retención/backup gestionado), se
marcaría **pendiente de confirmación manual** y se excluiría de Garantizado (Req 10.7).

---

## 8. Registro de evidencia (esquema del Catálogo_Evidencias)

| Campo | Valor |
|-------|-------|
| `id_evidencia` | `EV-8.3-ebs-volumenes-huerfanos-2026-05` |
| `cifra_publicada` | Ahorro_Garantizado = `232,20 USD/mes`; anualizado `2 786,40 USD/año` (coste evitado) |
| `descripcion` | Coste de los volúmenes EBS huérfanos (estado `available`) eliminables sin pérdida de capacidad (Sub_Palanca 6c, Garantizado), verificado en vivo y valorado a precio público por tipo de volumen |
| `consulta_cur` | **No aplica** — palanca verificada en vivo (`ec2 describe-volumes`, §1), no derivada del CUR. Cifra = GiB × tarifa pública por tipo |
| `mes_referencia` | `2026-05` |
| `fecha_extraccion` | `2026-06-23T09:01:54Z` (UTC) — verificación en vivo |
| `version_dataset` | `frozen-2026-05@2026-06-23` |
| `moneda` | `USD` |
| `recurso_ids` | 27 volúmenes: eks-dev (`vol-073c6ae86794159f0`, `vol-05c24ce0c9dc9ab7e`, `vol-0f35cf67adc61c485`, `vol-08a1ac41477deb4c0`, `vol-07fc0dc5dd1ac1a38`, `vol-00221161472bc49a2`, `vol-0bfeee7fc536a241e`, `vol-0db1bba2ac8245210`, `vol-02876d2fe7da6049d`, `vol-0d06c44c4650f90f4`, `vol-02edeae946b6b4bf4`, `vol-042125571f0a04c5b`, `vol-04ebde73a0202e002`, `vol-0177e3f44a6d1b300`); ecommerce-tiendanimal (`vol-0d3f0ba61f24a0f3b`, `vol-0a7d8c1b0d7cd77bb`, `vol-0c87250bd381de3a7`, `vol-0f8ba750f32749a75`, `vol-ef1bfc2a`, `vol-45bbc75a`, `vol-0cff57cd1d0d3e264`); retail-prod (`vol-042aaa2b744084be5`); eks-tooling (`vol-0ac6d8b58f05f38b2`, `vol-019b14c04f29e6d7d`, `vol-03b3889de35722105`, `vol-00c174a64ff2c962f`, `vol-0753a4af08124c2fa`) |
| `dimension_agregacion` | Por `line_item_usage_account_id` lógico (4 cuentas); valor = `Σ (GiB × tarifa_pública[tipo de volumen])` sobre volúmenes `available` |
| `verificacion_vivo` | Ver sub-registro abajo |
| `clasificacion` | `garantizado` |

### Sub-registro de Verificacion_Recurso_Vivo

| Campo | Valor |
|-------|-------|
| `comando` | `aws ec2 describe-volumes --profile <perfil-sso-sre> --region eu-west-1 --filters Name=status,Values=available` (solo lectura) |
| `cuenta` | 111122223333 (EKS Dev), 222333444555 (Ecommerce Tiendanimal), 666777888999 (Retail Prod), 444455556666 (EKS Tooling) — **confirmado**; 777888999000 (animalis-dev), 888999000111 (animalis-prod) y log/pruebas/4×sandbox/root — **no_verificable** |
| `region` | `eu-west-1` (todas) |
| `fecha_hora_utc` | `2026-06-23T09:01:54Z` |
| `estado` | `confirmado` (27 volúmenes en 4 cuentas) · `no_verificable` (animalis-dev/prod por `ForbiddenException`; log/pruebas/sandbox/root sin rol SRE) |
| `motivo` | confirmados: huérfanos `available` sin etiquetas warm-spare/forense/retención → Garantizado (Req 10.6). no_verificable: permisos de solo lectura denegados / sin rol de lectura SRE (Req 5.4), excluidos del ahorro contabilizado y mantenidos en alcance |

---

## 9. Notas metodológicas

- El filtro `--filters Name=status,Values=available` aísla exactamente los volúmenes **no asociados**
  a ninguna instancia (huérfanos), que es la definición de la Sub_Palanca 6c (Req 10.3).
- La cifra de 6c es **verificada en vivo** (GiB × precio público), no una agregación del CUR; por eso
  el campo `consulta_cur` es "no aplica". Es cross-comprobable contra el CUR: los GiB-mes de gp2
  huérfano forman parte de las líneas `VolumeUsage.gp2` de 6a (ver §6, ajuste de no doble conteo).
- **Solo lectura (Req 5.1):** únicamente se ejecutó `aws ec2 describe-volumes` (+ `sts
  get-caller-identity` para confirmar identidad). Ninguna operación mutante. Auditoría en Tarea 17.7.
- **Sin doble conteo (Property 7):** 6c (volúmenes `available`) vs 6a (`VolumeUsage` de volúmenes
  activos gp2) **solapan en el gp2 huérfano** → se asigna a 6c (delete) y se resta de 6a (§6); 6b
  (`SnapshotUsage`) es disjunta. Auditoría de conservación en Tareas 8.4 y 17.4.
- **Drift esperado (Req 7.6):** una re-ejecución posterior puede mostrar un parque distinto (nuevos
  huérfanos o volúmenes ya borrados); esto no invalida la cifra anclada a esta verificación, sino que
  exige reverificar la frescura (≤ 30 días) antes de publicar.

## 10. Estado de ejecución

- ✅ **Ejecutado** — Verificacion_Recurso_Vivo `ec2 describe-volumes` (solo lectura, `eu-west-1`) sobre
  las 24 cuentas con rol SRE el `2026-06-23T09:01:54Z`.
- ✅ **27 volúmenes huérfanos confirmados** / **2 415 GiB** en 4 cuentas (eks-dev 1 830, ecommerce-
  tiendanimal 502, retail-prod 50, eks-tooling 33); coincide con el ejemplo del `design.md` en eks-dev
  (14 vols/1 830 GiB) y eks-tooling (33 GiB).
- ✅ **Ninguno** con etiquetas warm-spare/forense/retención → todos **Ahorro_Garantizado** (cifra
  única **232,20 USD/mes** = **2 786,40 USD/año**).
- ✅ Frescura 0 días ≤ 30 (Req 3.2); clasificación `garantizado` (Req 3.1, 10.6).
- ✅ Caso de borde Req 10.7 documentado (sin volúmenes etiquetados que excluir en este barrido).
- ✅ Ajuste de no doble conteo con 6a registrado (restar 216,00 USD/mes de la base 6a — §6) para las
  Tareas 8.4 / 17.4.
- ⏳ **Pendiente** (no bloquea el Garantizado): barrido en cuentas `no_verificable` (animalis-dev/prod,
  log, pruebas, 4×sandbox, root) cuando se disponga del rol de lectura; asignación de owner por cuenta;
  reverificar frescura si la publicación del Informe supera 30 días desde `2026-06-23`.
