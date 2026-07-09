# Implementation Plan: finops-savings-assessment

## Overview

**Este plan ejecuta un ANÁLISIS, no software.** Cada tarea es una acción de analista FinOps que
produce un **artefacto auditable**: una cifra del CUR congelada en el `Catálogo_Evidencias`, una
`Verificacion_Recurso_Vivo` de solo lectura, una Palanca documentada y clasificada, una invariante
contable auditada, o una sección del Informe compuesta. No hay tareas de escribir/probar código:
las "pruebas" son auditorías re-ejecutables sobre el `Catálogo_Evidencias` y el `Dataset_Congelado`.

El plan sigue la metodología del diseño en cinco fases incrementales:

1. **Fundación** — congelar el `Dataset_Congelado` del Mes_Referencia (mayo 2026, periodo `2026-05`),
   comprobar completitud del mes y clasificar cada partida del CUR dentro/fuera de alcance (control
   de conservación contable, Property 1).
2. **Palancas (1–12)** — por cada Palanca: ejecutar la consulta CUR documentada y congelar la cifra
   en el `Catálogo_Evidencias`; ejecutar la `Verificacion_Recurso_Vivo` de solo lectura
   (`us-east-1` para WAF/CloudFront); aplicar la fórmula de ahorro con su supuesto y origen
   (público/negociado); clasificar Garantizado/Estimado (partiendo EBS en sub-palancas); y rellenar
   la documentación por Palanca (supuesto %, % direccionable + coste base, riesgo, esfuerzo, owner;
   "pendiente" donde no sea evaluable).
3. **Barrido_Utilizacion** — para las Palancas que lo requieren (compromiso steady-state, rightsizing
   p95, scheduling/Spot no-prod). Una Palanca Estimado **no se eleva a objetivo comprometido** hasta
   completar su Barrido_Utilizacion.
4. **Auditoría** — verificar las invariantes contables / Correctness Properties 1–12.
5. **Composición del Informe** — resumen ejecutivo + tabla por Palanca + anexo de evidencias;
   derivar los objetivos comprometidos = `Σ Garantizado + Σ Conservador(Estimado con Barrido)`;
   listar Palancas pendientes de barrido; señalar la Palanca_Comercial Marketplace aparte.

**Acceso a datos (recordatorio).** Coste: Athena `athenacurcfn_finnops.data` (CUR 2.0, `eu-west-1`),
rol `Cur-AWSS3CURLambdaExecutor`, cuenta `600700800900`, salida
`s3://finnops-iskaypet/athena-query-results/`. Existencia de recursos: AWS CLI **solo lectura**
(describe/list/get), SSO SRE por cuenta, `eu-west-1` salvo `us-east-1` para WAF/CloudFront. Versión
del congelado: p. ej. `frozen-2026-05@<fecha-extraccion>`. Filtro temporal canónico semiabierto:
`line_item_usage_start_date >= TIMESTAMP '2026-05-01 00:00:00' AND < TIMESTAMP '2026-06-01 00:00:00'`.

> Nota de compromiso: los ahorros **Estimado** no se comprometen como objetivos hasta que su
> `Barrido_Utilizacion` esté completo (Req 18). Hasta entonces se muestran solo como rango.

## Tasks

- [x] 1. Fundación — Dataset_Congelado y línea base contable
  - [x] 1.1 Congelar el total de la organización y el desglose por tipo de cargo (5 grupos)
    - Ejecutar la consulta del total org bruto/neto y la consulta por `line_item_line_item_type` sobre el filtro temporal canónico; separar y registrar como importes independientes en USD los **cinco grupos**: infra AWS (Usage), contrato Marketplace (`product_code LIKE 'cg%'` / `Global-SoftwareUsage-Contracts`), PAYG del mismo producto (`MP:%`), Tax, y suscripciones de tarifa plana (`FlatRateSubscription`)
    - Fijar la **versión** del `Dataset_Congelado` (`frozen-2026-05@<fecha-extraccion>`) y la fecha de extracción con marca temporal y zona horaria; moneda USD
    - Artefacto: registros de evidencia de cada uno de los 5 grupos en el `Catálogo_Evidencias`, etiquetados "no atribuible a recurso" con su consulta CUR
    - _Requirements: 1.2, 1.3, 1.6, 2.1, 2.4, 2.5, 7.1, 7.2_

  - [x] 1.2 Ejecutar el control de completitud del mes y registrar su grado
    - Ejecutar la consulta `COUNT(DISTINCT date(line_item_usage_start_date))`; comprobar `dias_cubiertos = 31`
    - Si el mes está incompleto, registrar el grado de completitud (días cubiertos / 31) y marcar como **no definitiva** toda cifra base afectada hasta el mes cerrado
    - Artefacto: registro de completitud anclado a la versión del `Dataset_Congelado`
    - _Requirements: 1.9_

  - [x] 1.3 Congelar el desglose por cuenta (alcance completo de ~30 cuentas)
    - Ejecutar la consulta por `line_item_usage_account_id` contra el mapa de cuentas de `portal-architecture.md` (§3, §7); incluir **toda** cuenta del alcance aunque tenga cero filas
    - Marcar cada cuenta con 0 filas como coste base `0,00 USD` + "sin datos de coste en el Mes_Referencia"; marcar las cuentas sin rol de lectura (`log`, `pruebas`, 4 sandbox, root) como "verificación en vivo no disponible", manteniéndolas en alcance
    - Artefacto: tabla por cuenta congelada con sus marcadores, en el `Catálogo_Evidencias`
    - _Requirements: 1.1, 1.7, 1.8, 2.3_

  - [x] 1.4 Clasificar cada partida CUR dentro/fuera de alcance y producir el control de conservación
    - Asignar **cada** partida del CUR del Mes_Referencia a exactamente uno de dos conjuntos (dentro de alcance técnico / fuera: Tax, Palanca_Comercial, tarifa plana); clasificar el contrato Marketplace como Palanca_Comercial excluida del ahorro técnico
    - Producir la consulta de control de conservación que reparta el 100% del coste y confirme `Σ dentro + Σ fuera = total CUR` y que los 5 grupos suman el total bruto sin solapes ni huecos
    - **Property 1: Conservación contable del coste total** — **Validates: Requirements 1.4, 1.6, 17.3**
    - Artefacto: lista explícita de partidas dentro/fuera + registro del control de conservación
    - _Requirements: 1.4, 1.5, 1.6, 17.3_

- [x] 2. Checkpoint — Fundación
  - Confirmar que el `Dataset_Congelado` está anclado (versión + fecha de extracción), la completitud registrada y la conservación contable cuadra. Ante dudas, preguntar al usuario.

- [x] 3. Palanca 1 — Compromiso EC2 (Savings Plans)
  - [x] 3.1 Ejecutar la consulta CUR de partición por opción de compra y congelar las cifras
    - Particionar EC2 en `sp_covered` / `spot` / `on_demand` (unblended, on-demand equiv, horas); calcular la cobertura como importe USD (2 dec) y % entre 0 y 100; separar la porción **estable** (≥90% de horas en ventana ≥30 días) de la intermitente/ráfaga
    - Artefacto: cifras congeladas con su consulta CUR en el `Catálogo_Evidencias`
    - _Requirements: 8.1, 8.4, 2.1, 2.3_
  - [x] 3.2 Ejecutar la Verificacion_Recurso_Vivo de cobertura (solo lectura)
    - `aws ce get-savings-plans-coverage` / `describe-savings-plans` (cobertura vigente + fechas de expiración dentro del horizonte de anualización) y `ec2 describe-instances` (familias estables); región `eu-west-1`; registrar estado (confirmado/excluido/no_verificable), cuenta, región y fecha-hora UTC
    - Artefacto: sub-registro de verificación en el `Catálogo_Evidencias`
    - _Requirements: 5.1, 5.5, 8.7_
  - [x] 3.3 Aplicar fórmula, clasificar y documentar la Palanca
    - Aplicar SP sobre la porción on-demand estable (Conservador ≈ Compute SP 28%, Agresivo ≈ EC2 Instance SP 37%, origen precio público AWS + fecha); declarar plazo (1 y 3 años) y opción de pago; enrutar lo ráfaga/intermitente a la Palanca 10 (sin doble conteo); clasificar **Estimado** (rango); documentar supuesto %, % direccionable + coste base, riesgo, esfuerzo, owner ("pendiente"); marcar **requiere Barrido_Utilizacion**
    - _Requirements: 3.3, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1, 8.5, 8.6, 8.8, 18.1_

- [x] 4. Palanca 2 — Compromiso RDS (+ ElastiCache / OpenSearch / Fargate / Lambda)
  - [x] 4.1 Ejecutar la consulta CUR de cómputo RDS y la cobertura, y congelar las cifras
    - Aislar cómputo de instancia RDS (`%InstanceUsage%`) separándolo de storage y backups; identificar cómputo sin cobertura RI/SP; añadir el sub-análisis de cobertura por Compute SP de ElastiCache, OpenSearch y cómputo de Fargate/Lambda (consulta por `product_code` + `usage_type` de cómputo, separando cubierto de on-demand)
    - Artefacto: cifras congeladas con sus consultas en el `Catálogo_Evidencias`
    - _Requirements: 8.2, 8.3, 2.1, 2.3_
  - [x] 4.2 Ejecutar la Verificacion_Recurso_Vivo (solo lectura)
    - `rds describe-db-instances` (instancias prod 24/7), `rds describe-reserved-db-instances` (confirmar cobertura RI); región `eu-west-1`; registrar estado/cuenta/región/fecha-hora UTC
    - _Requirements: 5.1, 5.5_
  - [x] 4.3 Aplicar fórmula, clasificar y documentar la Palanca
    - RDS RI 1 año no-upfront ≈ 34% sobre prod estable (origen público + fecha); declarar plazos (1 y 3 años) y opción de pago; clasificar **Estimado** (rango, invariante `0 < Cons ≤ Agr`); documentar campos Req 4; marcar **requiere Barrido_Utilizacion**
    - _Requirements: 3.3, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1, 8.5, 18.1_

- [x] 5. Palanca 3 — Extended Support de motores EOL (RDS)
  - [x] 5.1 Ejecutar la consulta CUR de Extended Support y congelar la cifra
    - Total en USD agregado a todas las cuentas (`%ExtendedSupport%`); desglosar por tramo de precio anual (Año 1–2 vs Año 3); listar por recurso (id, cuenta)
    - Artefacto: cifra + desglose congelados con la lista de `line_item_resource_id`
    - _Requirements: 9.1, 9.2, 2.2, 2.3_
  - [x] 5.2 Ejecutar la Verificacion_Recurso_Vivo por instancia (solo lectura)
    - `rds describe-db-instances` para registrar por instancia EOL: id, cuenta, motor, versión y fecha de fin de soporte estándar; región `eu-west-1`; registrar estado/fecha-hora UTC
    - _Requirements: 5.1, 9.3_
  - [x] 5.3 Clasificar y documentar la Palanca (Garantizado condicionado)
    - Clasificar la eliminación como **Garantizado condicionado** a la actualización de motor y a la validación previa de compatibilidad de la aplicación; si el upgrade está bloqueado por dependencia, excluir de Garantizado, reclasificar como no realizable a corto plazo e identificar la dependencia; documentar esfuerzo de migración y riesgo (alto); owner "pendiente"
    - _Requirements: 3.1, 9.4, 9.5, 9.6, 4.4, 4.5, 4.6, 4.7_

- [x] 6. Palanca 4 — Logs de CloudWatch y WAF
  - [x] 6.1 Ejecutar la consulta CUR de logs vendidos y congelar las cifras
    - Aislar `%VendedLog%` por cuenta, región y tipo; identificar las mayores fuentes y, en particular, los logs de WAF de CloudFront en `us-east-1` con su cuenta de origen
    - Artefacto: cifras congeladas (EU + us-east-1) en el `Catálogo_Evidencias`
    - _Requirements: 11.1, 11.2, 2.3_
  - [x] 6.2 Ejecutar la Verificacion_Recurso_Vivo en us-east-1 (solo lectura)
    - `wafv2 list-logging-configurations`, `logs describe-log-groups` en **`us-east-1`** para confirmar destino y volumen del WAF de CloudFront; registrar estado/cuenta/región (`us-east-1`)/fecha-hora UTC
    - _Requirements: 5.1, 5.2, 11.2_
  - [x] 6.3 Aplicar fórmula, clasificar y documentar la Palanca
    - Distinguir la reducción atribuible a **redirección a S3**, a **muestreo** y a **metric filters**, con supuesto y % direccionable de cada una; marcar como no eliminable (solo redirección/muestreo) cualquier log group de compliance/seguridad con retención obligatoria; clasificar **Estimado** (rango); documentar campos Req 4
    - _Requirements: 3.3, 11.3, 11.4, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1_

- [x] 7. Palanca 5 — Aurora no productivo de Helios
  - [x] 7.1 Ejecutar la consulta CUR de Aurora no-prod y congelar la cifra
    - Coste Aurora PostgreSQL de `helios-dev` (555566667777) + `helios-uat` (666677778888) por recurso; congelar la cifra combinada
    - _Requirements: 2.2, 2.3, 15.1_
  - [x] 7.2 Ejecutar la Verificacion_Recurso_Vivo (solo lectura)
    - `rds describe-db-clusters` + `rds describe-db-instances` con perfiles helios-dev/uat (confirmar writer+reader, clase `db.r6g.large`, `MultiAZ=false`, 24/7); región `eu-west-1`; registrar estado/cuenta/fecha-hora UTC
    - _Requirements: 5.1, 15.1_
  - [x] 7.3 Aplicar fórmula, clasificar y documentar la Palanca
    - Rango según agresividad (solo reader → reader+downsize+schedule); excluir con motivo lo que deba permanecer 24/7; clasificar **Estimado** (rango, recurso ya verificado, % de reducción sujeto a Barrido); documentar campos Req 4; marcar **requiere Barrido_Utilizacion**
    - _Requirements: 3.3, 15.2, 15.5, 15.6, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1, 18.1_

- [x] 8. Palanca 6 — EBS (Palanca mixta → Sub_Palancas)
  - [x] 8.1 Sub_Palanca 6a — gp2→gp3: consulta CUR, congelar cifra y fórmula (Estimado)
    - Consulta `%VolumeUsage.gp2%` por cuenta; ahorro **neto** (USD y %) restando el coste del rendimiento extra a aprovisionar en gp3 cuando el gp2 supere la base gp3 (>3000 IOPS o >125 MiB/s); origen público; clasificar **Estimado** (rango); documentar campos Req 4
    - _Requirements: 10.1, 10.2, 3.3, 4.1, 4.2, 4.3, 6.1_
  - [x] 8.2 Sub_Palanca 6b — Snapshots EBS: consulta CUR, congelar cifra y fórmula (Estimado)
    - Consulta `%SnapshotUsage%`; separar snapshots **elegibles** de **no elegibles**; marcar no elegible y excluir todo snapshot que respalde una AMI o esté cubierto por retención (`ec2 describe-snapshots` / `describe-images` para elegibilidad, solo lectura); clasificar **Estimado**; documentar campos Req 4
    - _Requirements: 10.4, 10.5, 3.3, 5.1, 4.1, 4.2, 6.1_
  - [x] 8.3 Sub_Palanca 6c — Volúmenes huérfanos: Verificacion_Recurso_Vivo y clasificación (Garantizado)
    - `ec2 describe-volumes --filters Name=status,Values=available` (cuenta, id, tamaño GiB, antigüedad desde desasociación); huérfano confirmado **sin** etiquetas warm-spare/forense/retención → **Garantizado** (cifra única); con esas etiquetas → pendiente de confirmación manual, excluido de Garantizado; región `eu-west-1`; registrar estado/fecha-hora UTC
    - _Requirements: 10.3, 10.6, 10.7, 5.1, 3.1, 3.2_
  - [x] 8.4 Verificar la conservación de costes base entre Sub_Palancas
    - Confirmar que la suma de los costes base de 6a/6b/6c es coherente con el coste base EBS de la Palanca (anticipo de la auditoría Property 7)
    - **Property 7 (parcial): suma de Sub_Palancas = coste base de la Palanca** — **Validates: Requirements 3.4**
    - _Requirements: 3.4_

- [x] 9. Palanca 7 — S3 lifecycle e Intelligent-Tiering
  - [x] 9.1 Ejecutar la consulta CUR por clase de almacenamiento y congelar las cifras
    - Consulta `%TimedStorage%`; comparar Standard frente a Intelligent-Tiering y Glacier
    - _Requirements: 12.1, 2.3_
  - [x] 9.2 Ejecutar la Verificacion_Recurso_Vivo (solo lectura)
    - `s3api get-bucket-lifecycle-configuration`, `get-bucket-versioning`, `list-multipart-uploads` por bucket; región del bucket; registrar estado/fecha-hora UTC
    - _Requirements: 5.1, 12.3_
  - [x] 9.3 Aplicar fórmula, clasificar y documentar la Palanca
    - Declarar supuesto de transición de clase, respetar la duración mínima de IA/Glacier y declarar % direccionable; excluir objetos de acceso frecuente donde la cuota de monitorización de IT supere el ahorro (registrar motivo); considerar versionado y MPU incompletas en el almacenamiento facturable; clasificar **Estimado** (rango); documentar campos Req 4
    - _Requirements: 12.2, 12.3, 12.4, 3.3, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1_

- [x] 10. Palanca 8 — Red: NAT, VPN, EIP y VPC endpoints
  - [x] 10.1 Ejecutar la consulta CUR de red ociosa y congelar las cifras
    - Consulta por `%NatGateway%`/`%VPN%`/`%VpcEndpoint%`/`%PublicIPv4%`; cuantificar IPv4 ociosas, NAT Gateways, VPN IPsec y VPC endpoints
    - _Requirements: 14.1, 2.3_
  - [x] 10.2 Ejecutar la Verificacion_Recurso_Vivo (solo lectura)
    - `ec2 describe-nat-gateways`, `describe-addresses` (EIP sin asociar), `ec2 describe-vpn-connections`, `ec2 describe-vpc-endpoints`; identificar recursos ociosos/duplicados/sin uso; región `eu-west-1`; registrar estado/fecha-hora UTC
    - _Requirements: 5.1, 14.2_
  - [x] 10.3 Aplicar fórmula, clasificar y documentar la Palanca (mixta)
    - Tratar como necesario el NAT que da egress a subredes privadas en uso; excluir con motivo VPN de backup/DR y redundancia intencionada de endpoints por AZ; IPv4 idle y recursos confirmados ociosos → **Garantizado**; reducción de NAT/endpoints sujeta a rediseño → **Estimado**; documentar campos Req 4
    - _Requirements: 14.3, 14.4, 14.5, 3.1, 3.4, 4.1, 4.4, 4.5, 4.6, 4.7_

- [x] 11. Palanca 9 — Rightsizing y Graviton por utilización real
  - [x] 11.1 Ejecutar la consulta CUR de candidatos y congelar las cifras
    - Consulta por `line_item_resource_id` + `product_instance_type` + horas (744 = 24/7) + coste; identificar candidatos a rightsizing y a Graviton con familia y perfil de uso
    - _Requirements: 13.3, 2.2, 2.3_
  - [x] 11.2 Ejecutar la Verificacion_Recurso_Vivo y leer utilización real (solo lectura)
    - `ec2 describe-instances` + p95 CPU/RAM desde Grafana/VPA (`quantile_over_time(0.95, ...)[7d:5m]`); sin métricas para un candidato → no proponer rightsizing y marcar pendiente de Barrido_Utilizacion; región `eu-west-1`; registrar estado/fecha-hora UTC
    - _Requirements: 5.1, 13.1, 13.2_
  - [x] 11.3 Aplicar fórmula, clasificar y documentar la Palanca
    - Basar la propuesta en p95 (no solo coste CUR); moderar la oportunidad en familias burstable (`t`); declarar como riesgo la compatibilidad arm64 (Graviton) y el impacto en capacidad; clasificar **Estimado** siempre (rango); documentar campos Req 4; marcar **requiere Barrido_Utilizacion**
    - _Requirements: 13.1, 13.4, 13.5, 13.6, 3.3, 4.1, 4.4, 4.5, 4.6, 4.7, 6.1, 18.1_

- [x] 12. Palanca 10 — Entornos no productivos: scheduling y Spot
  - [x] 12.1 Ejecutar la consulta CUR de horas 24/7 no-prod y uso de Spot, y congelar las cifras
    - Consulta por cuenta + opción (spot/on_demand) + horas + coste en cuentas no-prod; cuantificar uso actual de Spot y oportunidad de ampliarlo; horas **disjuntas** de las de la Palanca 1
    - _Requirements: 15.1, 15.3, 8.8, 2.3_
  - [x] 12.2 Ejecutar la Verificacion_Recurso_Vivo (solo lectura)
    - `ec2 describe-instances` en cuentas no-prod (tags de entorno, perfil de uso, identificar 24/7); región `eu-west-1`; registrar estado/cuenta/fecha-hora UTC
    - _Requirements: 5.1, 15.1_
  - [x] 12.3 Aplicar fórmula, clasificar y documentar la Palanca
    - Declarar supuesto de horas reducidas y riesgo; excluir con motivo lo que deba estar 24/7 (QA compartido, jobs nocturnos) y los workloads stateful/sin tolerancia a interrupción (Spot); declarar tolerancia a interrupción requerida; clasificar **Estimado** siempre (rango); documentar campos Req 4; marcar **requiere Barrido_Utilizacion**
    - _Requirements: 15.2, 15.4, 15.5, 15.6, 3.3, 4.1, 4.4, 4.5, 4.6, 4.7, 6.1, 18.1_

- [x] 13. Palanca 11 — Bedrock (IA generativa)
  - [x] 13.1 Ejecutar la consulta CUR de Bedrock y congelar las cifras
    - Consulta por cuenta + inference profile (`arn:aws:bedrock:%`) + usage_type; considerar inference profiles cross-region; cuentas `iskaypet-data` (200300400500) + `data-dev` (100200300400); identificar el coste guiado por **output tokens** como principal direccionador
    - _Requirements: 16.1, 16.3, 2.2, 2.3_
  - [x] 13.2 Confirmar cuenta/modelo y, si procede, la verificación de solo lectura
    - Confirmar cuenta/modelo desde el `resource_id` del CUR; si procede, `bedrock list-inference-profiles` (lectura); registrar estado/región del profile/fecha-hora UTC
    - _Requirements: 5.1, 16.1_
  - [x] 13.3 Aplicar fórmula, clasificar y documentar la Palanca
    - Declarar supuesto de optimización (prompt caching / cambio de modelo) y % direccionable; señalar que, al ser producto del squad Data, optimizar puede afectar la calidad del modelo (registrar advertencia); clasificar **Estimado** siempre (rango); documentar campos Req 4; owner Data ("pendiente" de correo)
    - _Requirements: 16.2, 16.4, 16.5, 3.3, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 6.1_

- [x] 14. Palanca 12 — Contrato Marketplace (Palanca_Comercial, señalada no contabilizada)
  - [x] 14.1 Ejecutar la consulta CUR del contrato y PAYG, clasificar y documentar como comercial
    - Consulta separando contrato (`cg%` / `Global-SoftwareUsage-Contracts`) y PAYG del mismo producto (`MP:%`); cuantificar coste mensual y anualizado del contrato en USD; cuantificar la sobrecarga PAYG como indicador de tier mal dimensionado; clasificar **Palanca_Comercial** separada del total de ahorro técnico (no contabilizada); fecha de renovación desconocida → "pendiente"; señalar dependencia de renegociación/renovación
    - _Requirements: 17.1, 17.2, 17.3, 17.4, 17.5, 1.5, 2.3_

- [x] 15. Checkpoint — Palancas completas
  - Confirmar que las 12 Palancas tienen cifra congelada + verificación (donde aplica) + clasificación + documentación, y que cada cifra tiene su registro en el `Catálogo_Evidencias`. Ante dudas, preguntar al usuario.

- [x] 16. Barrido_Utilizacion (gating de objetivos comprometidos)
  - [x] 16.1 Barrido de compromiso steady-state (Palancas 1 y 2)
    - Confirmar el "uso estable" (≥90% de horas en ventana ≥30 días) que sostiene el % direccionable de EC2/RDS; registrar resultados en el `Catálogo_Evidencias` antes de elevar a objetivo; barrido parcial → tratar la Palanca como pendiente
    - **Gating: Palancas 1, 2** — _Requirements: 18.1, 18.3, 18.4, 8.4_
  - [x] 16.2 Barrido de rightsizing por p95 (Palanca 9)
    - Consolidar el p95 de CPU/RAM (Grafana/VPA) por recurso candidato; sin métricas → permanece pendiente y sin proponer; registrar resultados en el `Catálogo_Evidencias`
    - **Gating: Palanca 9** — _Requirements: 18.1, 18.3, 18.4, 13.1, 13.2_
  - [x] 16.3 Barrido de scheduling/Spot no-prod (Palancas 5 y 10)
    - Confirmar perfil 24/7 vs intermitente y horas reducibles defendibles en no-prod (incl. Aurora Helios); registrar resultados en el `Catálogo_Evidencias`
    - **Gating: Palancas 5, 10** — _Requirements: 18.1, 18.3, 18.4, 15.5_

- [x] 17. Auditoría de invariantes (Correctness Properties)
  - [x] 17.1 Auditar conservación contable y separación en 5 grupos
    - Re-ejecutar la consulta de control: `Σ dentro + Σ fuera = total CUR` y unión de los 5 grupos = total bruto sin solapes ni huecos
    - **Property 1** — **Validates: Requirements 1.4, 1.6, 17.3**
  - [x] 17.2 Auditar la biyección cifra↔evidencia y la completitud del esquema
    - Confirmar correspondencia uno-a-uno al 100% entre cada cifra publicada y su registro; confirmar que todo registro tiene los campos obligatorios (consulta o "no aplica", `AAAA-MM`, fecha de extracción con zona horaria, versión del congelado, USD, recurso(s) o "no atribuible")
    - **Property 2 + Property 3** — **Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.5, 2.7, 19.5**
  - [x] 17.3 Auditar la clasificación, el rango de Estimado y la frescura de Garantizado
    - Confirmar clasificación única {Garantizado, Estimado} por Palanca técnica; invariante `0 < Conservador ≤ Agresivo` en cada Estimado; cada Garantizado con Verificacion_Recurso_Vivo `confirmado` y frescura ≤ 30 días (reclasificar/retirar si falla)
    - **Property 4 + Property 5 + Property 6** — **Validates: Requirements 3.1, 3.2, 3.3, 3.5, 5.3, 6.1**
  - [x] 17.4 Auditar la ausencia de doble conteo
    - Cruzar los conjuntos de `line_item_resource_id` y de horas asignados a Palancas que comparten servicio (compromiso EC2 vs Spot/scheduling vs rightsizing) y confirmar disyunción; suma de Sub_Palancas = coste base de la Palanca
    - **Property 7** — **Validates: Requirements 3.4, 8.8**
  - [x] 17.5 Auditar anualización y redondeo
    - Recalcular cada cifra anual = mensual × 12 con su advertencia de mes representativo/estacionalidad; recalcular cada total sumando **antes** de redondear con half-up a 2 decimales en USD
    - **Property 8 + Property 9** — **Validates: Requirements 6.3, 6.4, 6.6, 6.7**
  - [x] 17.6 Auditar la reproducibilidad de las cifras base
    - Re-ejecutar cada consulta documentada sobre el mismo `Dataset_Congelado` y fecha de extracción; exigir diferencia `0,00 USD`; con datos de llegada tardía, exigir varianza relativa ≤ 1% o marcar discrepante
    - **Property 10** — **Validates: Requirements 7.3, 7.4**
  - [x] 17.7 Auditar que las verificaciones son estrictamente de solo lectura
    - Confirmar que todos los comandos registrados son describe/list/get y ninguno es mutante; confirmar que las verificaciones de WAF/CloudFront usan `us-east-1`
    - **Property 11** — **Validates: Requirements 5.1, 5.2, 7.5, 11.2**
  - [x] 17.8 Auditar la derivación cerrada de los objetivos
    - Recalcular `Objetivo_Comprometido = Σ Garantizado + Σ Conservador(Estimado con Barrido completado)`; confirmar que excluye Palancas Estimado sin barrido (o con barrido parcial) y toda Palanca_Comercial
    - **Property 12** — **Validates: Requirements 18.2, 19.4, 19.6**

- [x] 18. Checkpoint — Auditoría
  - Confirmar que las 12 invariantes se cumplen sobre el `Catálogo_Evidencias` y el `Dataset_Congelado`. Si alguna se viola, corregir antes de componer el Informe. Ante dudas, preguntar al usuario.

- [x] 19. Composición del Informe
  - [x] 19.1 Componer el resumen ejecutivo
    - Presentar coste total de la organización, coste de infraestructura direccionable, total de Ahorro_Garantizado y rango de Ahorro_Estimado (suma de Conservadores – suma de Agresivos); cada cifra referencia su evidencia en el `Catálogo_Evidencias`
    - _Requirements: 19.1, 19.2, 19.5, 3.6, 6.6_
  - [x] 19.2 Componer la tabla por Palanca
    - Una fila por Palanca con: clasificación, ahorro mensual y anualizado, supuesto (% 1 decimal) + origen + fecha, % direccionable + coste base mensual afectado, riesgo, esfuerzo, responsable y estado de Barrido_Utilizacion (completado/pendiente)
    - _Requirements: 19.1, 19.3, 18.5, 6.2_
  - [x] 19.3 Componer el anexo de evidencias
    - Volcar el `Catálogo_Evidencias` completo: por cada cifra, su consulta CUR, mes, fecha de extracción, versión del congelado, recurso(s) o "no atribuible", y el sub-registro de Verificacion_Recurso_Vivo cuando aplica
    - _Requirements: 19.1, 2.1, 2.2, 2.3, 2.4, 2.5, 5.5_
  - [x] 19.4 Derivar objetivos comprometidos y señalar pendientes/comercial
    - Derivar `Objetivo_Comprometido = Σ Garantizado + Σ Conservador(Estimado con Barrido)`; identificar explícitamente las Palancas pendientes de Barrido_Utilizacion (fuera de objetivos); presentar la Palanca_Comercial Marketplace por separado indicando dependencia de renegociación/renovación
    - _Requirements: 19.4, 19.6, 18.2, 18.5, 17.5_

- [x] 20. Checkpoint final
  - Confirmar que el Informe (resumen + tabla + anexo) está completo, que los objetivos derivados cuadran con la regla cerrada y que toda cifra es trazable. Ante dudas, preguntar al usuario.

## Notes

- **Este plan ejecuta un análisis, no software.** Cada tarea produce un artefacto auditable (cifra
  congelada, verificación de solo lectura, Palanca documentada, invariante auditada o sección del
  Informe), no código de aplicación.
- Las tareas marcadas con `*` son verificaciones complementarias y pueden posponerse sin bloquear el
  Informe; las auditorías de la fase 17 son **núcleo** y no opcionales (sostienen la defendibilidad).
- Los ahorros **Estimado no se comprometen como objetivos** hasta que su `Barrido_Utilizacion` esté
  completo (Req 18). Hasta entonces se presentan solo como rango.
- Las "Correctness Properties" se verifican como **auditorías re-ejecutables** sobre el
  `Catálogo_Evidencias` y el `Dataset_Congelado`, no como tests de código.
- Toda cifra va anclada al `Dataset_Congelado` (versión + fecha de extracción) en USD; los totales se
  suman antes de redondear (half-up, 2 decimales).
- La Palanca_Comercial Marketplace se señala aparte y **nunca** entra en el total de ahorro técnico.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3"] },
    { "id": 1, "tasks": ["1.4"] },
    { "id": 2, "tasks": ["3.1", "4.1", "5.1", "6.1", "7.1", "8.1", "8.2", "9.1", "10.1", "11.1", "12.1", "13.1", "14.1"] },
    { "id": 3, "tasks": ["3.2", "4.2", "5.2", "6.2", "7.2", "8.3", "9.2", "10.2", "11.2", "12.2", "13.2"] },
    { "id": 4, "tasks": ["3.3", "4.3", "5.3", "6.3", "7.3", "8.4", "9.3", "10.3", "11.3", "12.3", "13.3"] },
    { "id": 5, "tasks": ["16.1", "16.2", "16.3"] },
    { "id": 6, "tasks": ["17.1", "17.2", "17.3", "17.4", "17.5", "17.6", "17.7", "17.8"] },
    { "id": 7, "tasks": ["19.1", "19.2", "19.3"] },
    { "id": 8, "tasks": ["19.4"] }
  ]
}
```
