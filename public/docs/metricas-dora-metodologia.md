# Metodología de Métricas de Ingeniería — Portal de Plataforma

## 1. Visión general

El portal mide el rendimiento de ingeniería usando tres pilares:
- **DORA Metrics**: Las 4 métricas estándar de la industria para medir la entrega de software
- **Indicadores de Gestión**: Flujo de Merge Requests, colaboración y ritmo de entrega por persona
- **Calidad de Código (SonarQube)**: Cobertura, vulnerabilidades y deuda técnica

Todos los datos se recopilan automáticamente desde **GitLab** (despliegues, commits, MRs) y **SonarQube** (análisis estático).

---

## 2. Métricas DORA

Las métricas DORA (DevOps Research and Assessment) son el estándar de la industria para medir el rendimiento de equipos de ingeniería. Se basan en el informe "Accelerate: State of DevOps" de Google/DORA.

### 2.1 Deployment Frequency (Frecuencia de Despliegue)

**Qué mide**: Número medio de despliegues exitosos a producción por proyecto activo y día.

**Cómo se calcula**:
```
DF = Total deploys exitosos en el periodo / (Proyectos activos × Días del periodo)
```

**Fuente de datos**: Jobs de GitLab CI/CD con nombres que indican deploy a producción (`deploy_prod`, `deploy-production`, `deploy_artifact`, `deploy_prd`).

**Filtro de producción**: Solo se cuentan despliegues a entornos clasificados como producción (`production`, `prod`, `prd`, `live`, o que terminen en `-pro`). Se excluyen explícitamente: `dev`, `uat`, `staging`, `stg`, `test`, `qa`, `sandbox`.

**Niveles DORA**:
| Nivel | Umbral |
|-------|--------|
| Elite | ≥1 deploy/día |
| High | 1/semana – 1/día |
| Medium | 1/mes – 1/semana |
| Low | <1/mes |

---

### 2.2 Lead Time for Changes (Tiempo de Entrega)

**Qué mide**: Tiempo desde que un desarrollador empieza a trabajar en un cambio hasta que llega a producción.

**Cómo se calcula**: Se toma la fecha del **primer commit** de la Merge Request asociada al despliegue y se mide hasta la fecha de finalización del deploy job.

```
Lead Time = Fecha deploy completado − Fecha primer commit de la MR
```

**Variantes disponibles**:
- **Desde primer commit** (canónico, preferido): Primer commit de la MR → deploy
- **Desde MR creada**: Fecha de creación de la MR → deploy
- **Desde último commit**: Último commit → deploy (más corto, menos representativo)

**Filtros de calidad**:
- Se descartan lead times superiores a 90 días (outliers por datos incorrectos)
- Se usa la mediana para el valor mostrado (más resistente a outliers que la media)

**Niveles DORA**:
| Nivel | Umbral |
|-------|--------|
| Elite | ≤1 hora |
| High | 1 hora – 1 día |
| Medium | 1 día – 1 semana |
| Low | >1 semana |

---

### 2.3 Change Failure Rate (Tasa de Fallos)

**Qué mide**: Porcentaje de despliegues a producción que resultan en un fallo.

**Cómo se calcula**:
```
CFR% = (Jobs de deploy fallidos en producción / Total deploys en el periodo) × 100
```

**Qué cuenta como fallo**: Un job de deploy a producción con status "failed" en GitLab CI/CD. Solo se cuentan fallos en entornos de producción (se valida el environment del job).

**Importante**: Un pipeline que falla en tests antes de llegar al job de deploy NO cuenta como fallo de deploy. Solo se cuentan los jobs de deploy que efectivamente se ejecutaron y fallaron.

**Niveles DORA**:
| Nivel | Umbral |
|-------|--------|
| Elite | ≤5% |
| High | 5–15% |
| Medium | 15–30% |
| Low | >30% |

**Nota**: Un CFR de 0% es el mejor resultado posible y se clasifica como Elite.

---

### 2.4 Pipeline Recovery Time (Tiempo de Recuperación)

**Qué mide**: Tiempo medio entre un fallo de despliegue y la siguiente entrega exitosa en el mismo proyecto.

**Cómo se calcula**:
```
PRT = Media de (Fecha primer deploy exitoso post-fallo − Fecha del fallo)
```

**Ventana de análisis**: Se buscan eventos de recuperación en los últimos 14 días para cada proyecto.

**Diferencia con MTTR clásico**: Esta métrica mide recuperación de pipeline (tiempo hasta que el equipo vuelve a desplegar con éxito), no tiempo de recuperación de servicio en producción.

**Niveles DORA**:
| Nivel | Umbral |
|-------|--------|
| Elite | ≤1 hora |
| High | 1 hora – 1 día |
| Medium | 1 día – 1 semana |
| Low | >1 semana |

---

## 3. Contexto DORA (Indicadores secundarios)

### 3.1 Deploys Exitosos
Total de despliegues exitosos a producción en el periodo seleccionado.

### 3.2 Commits Únicos
Número de commits únicos asociados a los despliegues del periodo.

### 3.3 Hotfixes
Despliegues clasificados como correcciones urgentes. Se detectan por:
- Rama con prefijo `hotfix/` o `fix/`
- Label de MR: `hotfix` o `incident`
- Commit message con tipo `fix:` o `hotfix:` (conventional commits)

### 3.4 Rollbacks
Despliegues clasificados como reversiones. Se detectan por:
- Rama con prefijo `rollback/` o `revert/`
- Label de MR: `rollback` o `revert`
- Commit message con tipo `revert:`
- Re-despliegue de un commit anterior ya desplegado

### 3.5 Fallos
Total de jobs de deploy fallidos en producción durante el periodo.

---

## 4. Gráficos

### 4.1 Entrega y Lead Time
- **Eje izquierdo**: Deploys exitosos por día (barras)
- **Eje derecho**: Lead time efectivo diario (línea)
- Permite ver la correlación entre volumen de entrega y velocidad

### 4.2 Fiabilidad del Cambio
- **Eje izquierdo**: Change Failure Rate % diario (línea roja)
- **Eje derecho**: Pipeline Recovery Time en días (línea naranja)
- Permite ver la correlación entre fallos y tiempo de recuperación

---

## 5. Tabla de Benchmarks DORA

Muestra los 4 niveles de rendimiento (Elite, High, Medium, Low) para cada métrica según los estándares del informe Accelerate/DORA State of DevOps. La celda resaltada indica el nivel actual del equipo/proyecto seleccionado.

---

## 6. Indicadores de Gestión

### 6.1 MRs Mergeadas
Total de Merge Requests fusionadas en el periodo por los contribuidores del alcance.

### 6.2 MRs Abiertas
Merge Requests actualmente abiertas (último snapshot).

### 6.3 Reviews Dados
Número de MRs donde una persona ha dejado comentarios de revisión (excluyendo comentarios del propio autor).

### 6.4 Personas Activas
Contribuidores con al menos 1 MR mergeada o 1 review dado en el periodo.

### 6.5 Por persona (scorecards)
- **MRs Mergeadas**: Conteo de MRs fusionadas por esa persona
- **Tiempo Medio Merge**: Media de horas desde creación de la MR hasta merge (excluye MRs que estuvieron en Draft)
- **Reviews Dados**: MRs revisadas por esa persona
- **Último Merge**: Fecha relativa del último merge

### 6.6 MRs Recientes (drill-down)
Últimas 5 MRs mergeadas de cada persona con título, proyecto y tiempo de vida.

---

## 7. Calidad de Código (SonarQube)

### 7.1 Cobertura Media
Promedio de cobertura de tests entre todos los proyectos seleccionados.

### 7.2 Vulnerabilidades
Suma de vulnerabilidades de seguridad detectadas + security hotspots.

### 7.3 Deuda Técnica
Estimación del tiempo necesario para resolver toda la deuda técnica acumulada (code smells).

### 7.4 Quality Gate
Estado del quality gate de SonarQube: OK (verde), ERROR (rojo), WARN (amarillo).

### 7.5 Mapeo GitLab ↔ SonarQube
El sistema mapea automáticamente proyectos de GitLab con proyectos de SonarQube por nombre. También permite selección manual.

---

## 8. Filtros

### 8.1 Ventana Temporal
Periodo de análisis: 7, 15, 30, 90 o 180 días.

### 8.2 Grupo GitLab
Filtra por grupo de primer nivel en GitLab (digital, retail, etc.).

### 8.3 Equipos
Filtra por equipo/squad dentro del grupo. El conteo entre paréntesis indica proyectos activos.

### 8.4 Proyectos GitLab
Selección específica de proyectos. Solo aparecen proyectos con actividad en los últimos 6 meses.

---

## 9. Recopilación de Datos

- **Snapshot nocturno** (2:00 AM): Recorre todos los proyectos del grupo GitLab, recopila deploys, commits, MRs y calcula métricas diarias.
- **Webhook en tiempo real**: Recibe eventos de push, MR y comentarios para actualizar contadores incrementalmente.
- **SonarQube**: Se consulta diariamente para obtener métricas de calidad actualizadas.

---

## 10. Limitaciones conocidas

- Solo se miden despliegues a producción. Despliegues a dev/staging no se cuentan.
- Proyectos sin job de deploy con nombre estándar no generan métricas DORA.
- El lead time requiere que el deploy tenga un commit asociado con una MR. Deploys sin MR no generan lead time.
- La cobertura de datos depende de la actividad del proyecto. Proyectos con poca actividad tendrán menos días con datos.

---

*Documento generado automáticamente por el Portal de Plataforma. Última actualización: Mayo 2026.*
