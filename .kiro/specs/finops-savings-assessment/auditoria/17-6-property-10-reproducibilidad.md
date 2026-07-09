# Auditoría 17.6 — Property 10: Reproducibilidad de las cifras base

> **Naturaleza:** auditoría re-ejecutable de un spec **analítico** (NO software, sin PBT/tests de
> código). Se re-ejecuta **cada consulta CUR documentada** del Estudio sobre el mismo
> `Dataset_Congelado` y se verifica que la cifra producida coincide con la congelada
> (diferencia exigida `0,00 USD`); con datos de llegada tardía, se exige varianza relativa ≤ 1 %
> o se marca discrepante.
>
> **Property 10: Reproducibilidad de las cifras base** — **Validates: Requirements 7.3, 7.4**
>
> *Para toda* consulta documentada re-ejecutada sobre el mismo `Dataset_Congelado` y la misma fecha
> de extracción, la cifra producida es igual a la publicada (diferencia `0,00 USD`); si la
> re-ejecución usa un CUR con datos de llegada tardía o reexpresados, la diferencia relativa
> permanece ≤ 1 % o la cifra se marca como **discrepante**.
>
> Fuente de cifras congeladas auditadas: `catalogo-evidencias.md` (Registros 1.1/1.2/1.3) y los
> 12 ficheros `evidencias/palanca-*.md`. Este artefacto **NO modifica** `catalogo-evidencias.md`
> ni ningún otro fichero del Estudio.

## Veredicto

✅ **PASS.** Las **16 consultas CUR base** re-ejecutadas el `2026-06-25` sobre el `Dataset_Congelado`
`frozen-2026-05@2026-06-23` reproducen **exactamente** las cifras congeladas: la diferencia a 2
decimales es **`0,00 USD` en las 16 cifras** (el total de la organización, los 6 grupos de la
partición contable y las 14 cifras base de las 12 Palancas auditadas). No se observó **ningún** dato
de llegada tardía con impacto: la única diferencia detectada está en el **5.º decimal** del
`net_unblended` agregado de la organización (sub-céntimo, varianza relativa `< 0,000001 %`, muy por
debajo del umbral del 1 % del Req 7.4) y **no** altera ninguna cifra publicada a 2 decimales. Ninguna
cifra se marca discrepante.

El `Dataset_Congelado` sigue **cerrado y completo** (31/31 días, Registro 1.2): el `COUNT(DISTINCT
date(...))` re-ejecutado devuelve `31`, idéntico al congelado, confirmando que la ventana del
Mes_Referencia no cambió entre extracciones.

## Parámetros de la re-ejecución (anclaje)

| Campo | Valor |
|-------|-------|
| Mes_Referencia | `2026-05` (1–31 mayo 2026, zona horaria de facturación AWS UTC) |
| Versión del `Dataset_Congelado` | `frozen-2026-05@2026-06-23` |
| Fecha de extracción anclada | `2026-06-23T07:55:14Z` (UTC) |
| Filtro temporal canónico (semiabierto) | `line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND line_item_usage_start_date < TIMESTAMP '2026-06-01 00:00:00'` |
| Moneda | `USD` (2 decimales, redondeo half-up, sumando antes de redondear — Req 6.7) |
| Motor / DB / tabla | Amazon Athena (CUR 2.0) · `athenacurcfn_finnops` · `data` |
| Región | `eu-west-1` |
| Cuenta CUR | `600700800900` (root-iskaypet) |
| Salida de resultados | `s3://finnops-iskaypet/athena-query-results/` |
| Perfil de acceso | `root-iskaypet` (credenciales referenciadas por **nombre de perfil**, sin tokens incrustados — Req 7.5) |
| Fecha de re-ejecución de esta auditoría | `2026-06-25` (re-verificación Tarea 17.6) |
| `caller-identity` verificado | `arn:aws:sts::600700800900:assumed-role/AWSReservedSSO_MPA-AdministratorAccess_37d6c4e8775d3419/ruben.landin@emefinpetcare.com` |

> **Reproducibilidad de la cadena de acceso (Req 7.1, 7.2, 7.5):** todas las consultas se lanzaron con
> el helper re-ejecutable `auditoria/_athena_run.sh "<SQL>"` (perfil `root-iskaypet`, región
> `eu-west-1`, DB `athenacurcfn_finnops`, salida `s3://finnops-iskaypet/athena-query-results/`). Las
> credenciales se referencian por nombre de perfil SSO; no se incrusta ningún token.

## Tabla maestra — cifra congelada vs re-ejecutada (Property 10)

Diferencia exigida `0,00 USD` (mismo snapshot, Req 7.3). Cada fila lleva su **QueryExecutionId real
nuevo** de esta re-ejecución (estado `SUCCEEDED`).

| # | Registro / Palanca | Cifra (descripción) | **Congelada (USD)** | **Re-ejecutada (USD)** | Δ (USD) | QueryExecutionId (nuevo) |
|--:|--------------------|---------------------|--------------------:|-----------------------:|:-------:|--------------------------|
| 1 | Reg. 1.1 — Total org | Total organización (unblended) | 148 553,36 | 148 553,36 | **0,00** | `a91f4b7d-c016-44e2-9c75-be32023d44fc` |
| 2 | Reg. 1.1 — Total org | Total organización (net) | 148 553,36 | 148 553,36 | **0,00** | `a91f4b7d-c016-44e2-9c75-be32023d44fc` |
| 3 | Reg. 1.1 — grupo | `infra_aws` (Usage excl. marketplace) | 48 320,13 | 48 320,13 | **0,00** | `8d1888b3-c7f8-48fe-9adc-6e3e83b65ecd` |
| 4 | Reg. 1.1 — grupo | `marketplace_contract` (Fee) | 85 000,55 | 85 000,55 | **0,00** | `8d1888b3-c7f8-48fe-9adc-6e3e83b65ecd` |
| 5 | Reg. 1.1 — grupo | `marketplace_payg` (`MP:%`) | 6 663,33 | 6 663,33 | **0,00** | `8d1888b3-c7f8-48fe-9adc-6e3e83b65ecd` |
| 6 | Reg. 1.1 — grupo | `tax` | 9 448,99 | 9 448,99 | **0,00** | `8d1888b3-c7f8-48fe-9adc-6e3e83b65ecd` |
| 7 | Reg. 1.1 — grupo | `flat_rate_subscription` (Kiro) | 904,73 | 904,73 | **0,00** | `8d1888b3-c7f8-48fe-9adc-6e3e83b65ecd` |
| 8 | Reg. 1.1 — grupo | `sp_discounts_bridge` (puente SP/desc.) | −1 784,38 | −1 784,38 | **0,00** | `8d1888b3-c7f8-48fe-9adc-6e3e83b65ecd` |
| 9 | Palanca 1 — EC2 | `sp_covered` | 7 998,83 | 7 998,83 | **0,00** | `98b7c5c9-fa0d-4be6-862b-32a012b23618` |
| 10 | Palanca 1 — EC2 | `on_demand` | 7 185,92 | 7 185,92 | **0,00** | `98b7c5c9-fa0d-4be6-862b-32a012b23618` |
| 11 | Palanca 1 — EC2 | `spot` | 3,30 | 3,30 | **0,00** | `98b7c5c9-fa0d-4be6-862b-32a012b23618` |
| 12 | Palanca 2 — RDS | `instance_compute` (Single+Multi-AZ) | 6 616,31 | 6 616,31 | **0,00** | `c4d0e35e-ac56-4d19-9d68-5f8db85a7b8f` |
| 13 | Palanca 2 — RDS | `storage` | 5 201,25 | 5 201,25 | **0,00** | `c4d0e35e-ac56-4d19-9d68-5f8db85a7b8f` |
| 14 | Palanca 2 — RDS | `backup` | 500,06 | 500,06 | **0,00** | `c4d0e35e-ac56-4d19-9d68-5f8db85a7b8f` |
| 15 | Palanca 3 — Ext. Support | bruto (`Usage`) | 1 169,52 | 1 169,52 | **0,00** | `896a808e-1d3c-4ca7-a6ba-e8e4ed52ca15` |
| 16 | Palanca 3 — Ext. Support | neto (`net_unblended`) | 1 075,96 | 1 075,96 | **0,00** | `896a808e-1d3c-4ca7-a6ba-e8e4ed52ca15` |
| 17 | Palanca 3 — Ext. Support | `SppDiscount` | −93,56 | −93,56 | **0,00** | `896a808e-1d3c-4ca7-a6ba-e8e4ed52ca15` |
| 18 | Palanca 4 — VendedLog | total bruto (`Usage`) | 2 774,92 | 2 774,92 | **0,00** | `59d17469-508c-4fad-b27f-a719f7b5c5cd` |
| 19 | Palanca 4 — VendedLog | total neto (`net_unblended`) | 2 374,51 | 2 374,51 | **0,00** | `59d17469-508c-4fad-b27f-a719f7b5c5cd` |
| 20 | Palanca 5 — Aurora Helios | bruto Usage (4× `db.r6g.large`) | 851,14 | 851,14 | **0,00** | `fc7991d8-4750-4617-b84a-3427cc87b7b6` |
| 21 | Palanca 5 — Aurora Helios | neto (tras SPP) | 783,05 | 783,05 | **0,00** | `fc7991d8-4750-4617-b84a-3427cc87b7b6` |
| 22 | Palanca 6a — EBS gp2 | coste base gp2 | 1 011,76 | 1 011,76 | **0,00** | `3c6c3065-0547-4bf4-b619-8d0f4fec9e89` |
| 23 | Palanca 6b — Snapshots | coste base snapshots | 402,93 | 402,93 | **0,00** | `8b730597-b259-4db5-9f90-866ece68e56c` |
| 24 | Palanca 7 — S3 | S3 Standard (todas las regiones) | 2 170,80 | 2 170,80 | **0,00** | `3fb63e40-58bf-4a29-9a42-538b5614b9f2` |
| 25 | Palanca 7 — S3 | total TimedStorage | 2 265,80 | 2 265,80 | **0,00** | `3fb63e40-58bf-4a29-9a42-538b5614b9f2` |
| 26 | Palanca 7 — S3 | Intelligent-Tiering (ausente) | 0,00 | 0,00 | **0,00** | `3fb63e40-58bf-4a29-9a42-538b5614b9f2` |
| 27 | Palanca 8 — Red | NAT Gateway | 1 503,28 | 1 503,28 | **0,00** | `71418abc-28df-48cb-bc85-b0cdc48cf418` |
| 28 | Palanca 8 — Red | VPN IPsec | 650,26 | 650,26 | **0,00** | `71418abc-28df-48cb-bc85-b0cdc48cf418` |
| 29 | Palanca 8 — Red | VPC endpoint | 352,77 | 352,77 | **0,00** | `71418abc-28df-48cb-bc85-b0cdc48cf418` |
| 30 | Palanca 8 — Red | IPv4 en uso | 305,90 | 305,90 | **0,00** | `71418abc-28df-48cb-bc85-b0cdc48cf418` |
| 31 | Palanca 8 — Red | IPv4 ociosa (candidato Garantizado) | 30,82 | 30,82 | **0,00** | `71418abc-28df-48cb-bc85-b0cdc48cf418` |
| 32 | Palanca 9 — Rightsizing | flota EC2 BoxUsage (equiv. on-demand) | 15 184,74 | 15 184,74 | **0,00** | `202846cf-e464-4aeb-bfdb-b90d07b08962` |
| 33 | Palanca 10 — No-prod | no-prod `on_demand` | 865,77 | 865,77 | **0,00** | `fd746bad-d154-49b7-a152-5ca415dc374f` |
| 34 | Palanca 10 — No-prod | no-prod `sp_covered` | 2 551,52 | 2 551,52 | **0,00** | `fd746bad-d154-49b7-a152-5ca415dc374f` |
| 35 | Palanca 11 — Bedrock | total organización | 2 178,94 | 2 178,94 | **0,00** | `e759fac2-bcf7-40fc-adad-0e6ced74f5fa` |
| 36 | Palanca 11 — Bedrock | alcance Data (iskaypet-data + data-dev) | 2 175,00 | 2 175,00 | **0,00** | `e759fac2-bcf7-40fc-adad-0e6ced74f5fa` |
| 37 | Palanca 12 — Marketplace | contrato (`Fee`) | 85 000,55 | 85 000,55 | **0,00** | `8d1888b3-...` (= grupo `marketplace_contract`) |
| 38 | Palanca 12 — Marketplace | PAYG (`MP:payg-Units`) | 6 663,33 | 6 663,33 | **0,00** | `8d1888b3-...` (= grupo `marketplace_payg`) |

> Las cifras de la Palanca 12 (filas 37–38) son **idénticas por construcción** a los grupos
> `marketplace_contract` y `marketplace_payg` de la partición contable (Reg. 1.1, filas 4–5); la
> re-ejecución del desglose por grupos las reproduce a `0,00 USD`, confirmando la coherencia entre el
> Registro 1.1 y el registro de la Palanca 12 (`EV-14.1-*`).

## Salidas crudas de la re-ejecución (precisión completa, antes de redondeo)

Para auditar la reproducibilidad al céntimo se conservan los valores crudos devueltos por Athena:

| Concepto | Valor crudo re-ejecutado | Congelado (crudo, fuente) | Redondeado |
|----------|--------------------------|---------------------------|-----------:|
| Total org unblended | `148553.35546862945` | `148553.35546862945` (Reg. 1.1 / Aud. 17.1) | 148 553,36 |
| Total org net | `148553.355463035` | `148553.355…` (≡ unblended a 2 dec) | 148 553,36 |
| `infra_aws` | `48320.126592766544` | `48320.126592766544` (Aud. 17.1) | 48 320,13 |
| `marketplace_contract` | `85000.55` | `85000.55` | 85 000,55 |
| `marketplace_payg` | `6663.3335806` | `6663.3335806` | 6 663,33 |
| `tax` | `9448.989999999996` | `9448.989999999996` | 9 448,99 |
| `flat_rate_subscription` | `904.7318399999954` | `904.7318399999954` | 904,73 |
| `sp_discounts_bridge` | `-1784.3765448119314` | `-1784.3765448119314` | −1 784,38 |
| EC2 `sp_covered` | `7998.828122917939` | `7998.828122917939` (P1 Ev. A) | 7 998,83 |
| EC2 `on_demand` | `7185.915289761053` | `7185.915289761053` | 7 185,92 |
| EC2 `spot` | `3.2951832223` | `3.2951832223` | 3,30 |
| RDS `instance_compute` | `6616.314840538971` | `6616.31…` (P2 §1) | 6 616,31 |
| Ext. Support `Usage` | `1169.516312383998` | `1169.516312383998` (P3) | 1 169,52 |
| Ext. Support `net` | `1075.9550073924` | `1075.96` (P3) | 1 075,96 |
| VendedLog `Usage` | `2774.916109339911` | `2774.92` (P4) | 2 774,92 |
| VendedLog `net` | `2374.511820524398` | `2374.51` (P4) | 2 374,51 |
| Aurora Helios (4× Usage) | `4 × 212.78400000000008 = 851.136` | `851.136` (P5) | 851,14 |
| Aurora Helios neto | `4 × 195.7612799999999 = 783.045` | `783.045120` (P5) | 783,05 |
| gp2 | `1011.7567538491171` | `1011.756…` (P6a) | 1 011,76 |
| Snapshots | `402.92753983059976` | `402.9275398306` (P6b) | 402,93 |
| S3 Standard | `2142.8031071609958 + 27.9966405930… + 0.000857… + 0.0000062 = 2170.8006…` | `2170.800611` (P7) | 2 170,80 |
| Red total (5 cat.) | `1503.2798 + 650.256 + 352.7658 + 305.8956 + 30.8191 = 2843.0163` | `2843.02` (P8) | 2 843,02 |
| EC2 BoxUsage equiv. on-demand | `15184.74341267901` | `15184.74…` (P9) | 15 184,74 |
| No-prod `on_demand` | `5063.900207… h / 865.7654027019` | `865.77` (P10) | 865,77 |
| No-prod `sp_covered` | `2551.523033174906` | `2551.52` (P10) | 2 551,52 |
| Bedrock org | `1782.8025314 + 392.202206 + 2.8392834 + 1.086396 + 0.013529 = 2178.943946` | `2178.94` (P11) | 2 178,94 |
| Bedrock Data | `1782.8025314 + 392.202206 = 2175.0047374` | `2175.00` (P11) | 2 175,00 |

## Análisis de datos de llegada tardía (Req 7.4)

El Req 7.4 exige que, ante datos de llegada tardía o reexpresados, la varianza relativa por cifra
permanezca ≤ 1 % o la cifra se marque **discrepante**.

- **Cifras a 2 decimales:** las 38 cifras auditadas reproducen su valor congelado **al céntimo**
  (Δ = `0,00 USD`). No hay drift observable a la precisión publicada.
- **Única diferencia sub-céntimo (informativa):** el `net_unblended` agregado de la organización pasó
  de `148553.35546862945` (≡ unblended, congelado) a `148553.355463035` en la re-ejecución — una
  diferencia de `≈ 0,0000056 USD` (5.º–6.º decimal). Varianza relativa
  `≈ 3,8 × 10⁻¹¹` (`< 0,000001 %`), **muy por debajo** del umbral del 1 % del Req 7.4 y **sin impacto**
  a 2 decimales (ambos → `148 553,36`). Es el comportamiento esperado de reexpresiones menores del
  CUR en columnas netas; **no se marca discrepante**.
- **Completitud invariante:** el control de completitud del Registro 1.2 re-verificado devuelve
  `dias_cubiertos = 31` (rango `2026-05-01 … 2026-05-31`), idéntico al congelado → la ventana del
  Mes_Referencia no cambió; ningún día se añadió ni desapareció entre extracciones.

**Conclusión del análisis de llegada tardía:** no se requiere re-anclar ninguna cifra en una nueva
versión del `Dataset_Congelado`. Todas las cifras base permanecen reproducibles dentro de la
tolerancia (de hecho, al céntimo exacto).

## Cobertura de la auditoría

Se re-ejecutaron las consultas base **de las 12 Palancas** y de la **línea base contable**, cubriendo
las "cifras clave" exigidas y el resto del catálogo:

| Bloque | Consultas re-ejecutadas | Resultado |
|--------|-------------------------|-----------|
| Línea base contable (Reg. 1.1) | total org + partición en 6 grupos | ✅ 0,00 |
| Completitud (Reg. 1.2) | `COUNT(DISTINCT date(...))` = 31 | ✅ invariante |
| Palanca 1 — EC2 SP | partición por opción de compra | ✅ 0,00 |
| Palanca 2 — RDS | componentes (compute/storage/backup) | ✅ 0,00 |
| Palanca 3 — Extended Support | bruto/neto por tipo de línea | ✅ 0,00 |
| Palanca 4 — VendedLog | total bruto/neto por tipo de línea | ✅ 0,00 |
| Palanca 5 — Aurora Helios | por recurso (4 ARN) + SppDiscount | ✅ 0,00 |
| Palanca 6a — EBS gp2 | coste base gp2 | ✅ 0,00 |
| Palanca 6b — Snapshots | coste base snapshots | ✅ 0,00 |
| Palanca 7 — S3 | por clase de almacenamiento | ✅ 0,00 |
| Palanca 8 — Red | totales por categoría (NAT/VPN/VPCe/IPv4) | ✅ 0,00 |
| Palanca 9 — Rightsizing | flota BoxUsage (equiv. on-demand) | ✅ 0,00 |
| Palanca 10 — No-prod | partición no-prod por opción | ✅ 0,00 |
| Palanca 11 — Bedrock | por cuenta (org + alcance Data) | ✅ 0,00 |
| Palanca 12 — Marketplace | contrato + PAYG (= grupos de Reg. 1.1) | ✅ 0,00 |

> **Nota sobre cifras verificadas-en-vivo (no CUR).** La Sub_Palanca 6c (volúmenes EBS huérfanos,
> `232,20 USD/mes`) y las cifras derivadas de `ec2 describe-*` **no** son cifras de coste del CUR:
> su `consulta_cur` es "no aplica" (se calculan como `GiB × tarifa pública` sobre el inventario vivo).
> Quedan **fuera** del alcance de Property 10 (reproducibilidad de **consultas CUR**); su
> reproducibilidad es la del estado vivo, sujeta al **drift esperado** del Req 7.6 (auditado por la
> propia naturaleza de la verificación en vivo, no aquí). Property 10 cubre la reproducibilidad de
> las **consultas documentadas sobre el `Dataset_Congelado`**, que es lo verificado arriba.

## Tabla de controles (Property 10)

| Control | Esperado | Obtenido | Veredicto |
|---------|----------|----------|-----------|
| Diferencia por cifra a 2 decimales (mismo snapshot, Req 7.3) | `0,00 USD` | `0,00 USD` en las 38 cifras | ✅ |
| Varianza relativa con datos de llegada tardía (Req 7.4) | ≤ 1 % o marcar discrepante | máx. observado `< 0,000001 %` (sub-céntimo, neto org) | ✅ (sin discrepantes) |
| Completitud del Mes_Referencia invariante (Reg. 1.2) | `31 / 31` | `31 / 31` | ✅ |
| Cadena de acceso reproducible (Req 7.1, 7.2, 7.5) | perfil/rol referenciados, sin tokens | helper `_athena_run.sh`, perfil `root-iskaypet` | ✅ |
| Coherencia Palanca 12 ↔ Reg. 1.1 (contrato + PAYG) | iguales | `85 000,55` y `6 663,33` idénticos | ✅ |

## Conclusión

Property 10 **CUMPLE (PASS)** en la re-ejecución de la Tarea 17.6 contra `frozen-2026-05@2026-06-23`.
Las **38 cifras base** auditadas (total org, los 6 grupos de la partición contable y las cifras base
de las 12 Palancas) se reproducen con diferencia **`0,00 USD`** a 2 decimales re-ejecutando las
consultas CUR documentadas sobre el mismo `Dataset_Congelado` y fecha de extracción (Req 7.3). El
único drift detectado es **sub-céntimo** en el neto agregado de la organización (varianza relativa
`< 0,000001 %`), **muy por debajo** del umbral del 1 % del Req 7.4, sin impacto en ninguna cifra
publicada y sin necesidad de re-anclar el `Dataset_Congelado`. El control de completitud permanece en
`31/31`. **Ninguna cifra se marca discrepante.** El Estudio es **reproducible** en sus cifras base.
