# FinOps Advisor - IAM Guidance

## Objetivo
Elevar la calidad del inventario, la búsqueda por tags y la cobertura del análisis FinOps AI que usa el role `n8n-cost-reader-role` en cada cuenta AWS.

## Síntomas que indican permisos insuficientes
- Muchos recursos con estado `terraformStatus = unknown`
- Búsqueda por tags poco fiable o inconsistente entre servicios
- Cobertura de métricas baja pese a tener recursos elegibles
- RDS con Performance Insights habilitado pero sin `db.load`
- Informe FinOps sin coste real CUR o con poca capacidad de correlación

## Permisos base ya aprovechados por el portal
- `sts:AssumeRole`
- Lecturas de inventario por servicio (`Describe*`, `List*`)
- `cloudwatch:GetMetricStatistics`
- `pi:GetResourceMetrics`
- `pi:DescribeDimensionKeys`

## Permisos recomendados para mejorar tags y búsqueda
Estos mejoran de forma directa el inventario, la detección de Terraform y la búsqueda operativa:

- `lambda:ListTags`
- `s3:GetBucketTagging`
- `ecs:DescribeClusters`
- `ecs:DescribeServices`
- `elasticloadbalancing:DescribeTags`
- `eks:DescribeCluster`
- `dynamodb:DescribeTable`
- `dynamodb:ListTagsOfResource`
- `elasticache:ListTagsForResource`
- `sns:ListTagsForResource`
- `sqs:ListQueueTags`
- `cloudfront:ListTagsForResource`

## Recomendación fuerte para búsqueda transversal por tags
Para llevar la búsqueda a nivel producto y no depender solo de llamadas servicio a servicio:

- `tag:GetResources`
- `tag:GetTagKeys`
- `tag:GetTagValues`

Con estas acciones, el portal puede evolucionar hacia una capa de búsqueda centralizada por tags y ownership mucho más fiable.

## Permisos recomendados para observabilidad FinOps
Ya son útiles hoy para el advisor y conviene mantenerlos explícitos:

- `cloudwatch:GetMetricStatistics`
- `pi:GetResourceMetrics`
- `pi:DescribeDimensionKeys`

## Siguiente salto futuro: coste real por recurso
Para unir CUR/Athena con recursos individuales hará falta revisar la capa de consulta de costes. Eso no depende solo del role lector por cuenta, sino también de:

- acceso correcto a la lambda / Athena que resuelve CUR
- disponibilidad de `line_item_resource_id` o identificadores equivalentes en el dataset CUR
- estrategia de normalización ARN/ID por servicio

## Recomendación de rollout
1. Aplicar primero el bloque de tags y búsqueda.
2. Volver a lanzar inventario + advisor sobre 2-3 cuentas.
3. Revisar si baja `terraformStatus = unknown` y mejora la búsqueda.
4. Solo después abrir la fase de `coste real por recurso`.
