# Bugfix Requirements Document

## Introduction

En la pestaña **Gestión** del dashboard de métricas del Platform Portal (`/metrics`), cuando el
usuario selecciona una ventana temporal personalizada que abarca fechas **anteriores a ~90 días**
(o que arranca antes del histórico realmente almacenado), la tabla **"Detalle por MR"** no muestra
datos o solo retrocede hasta un punto fijo (~22 de abril) sin poder paginar más atrás, mientras que
las tarjetas de **"Indicadores de gestión"** (MRS MERGEADAS, MRS ABIERTAS, REVIEWS DADOS, PERSONAS
ACTIVAS) sí muestran algún total.

El reporte original (Jorge Marcial) incluye dos escenarios reproducibles sobre el proyecto
`basket-api`:

1. Rango histórico `01/01/2026–28/03/2026`: las tarjetas muestran totales, pero "Detalle por MR"
   muestra el empty-state *"No hay datos de MRs para el periodo seleccionado. Los datos se
   actualizan cada noche."* La respuesta HTTP es **200 OK** (no es un error técnico, es ausencia de
   datos).
2. Rango `01/01/2026–26/06/2026` (hasta hoy): "Detalle por MR" sí trae filas y pagina (Página 1/5,
   AVG REVIEW TIME, TOTAL MRS 31…), **pero el detalle más antiguo solo llega a ~22 de abril** y la
   paginación no retrocede más allá de esa fecha.

Causa raíz sospechada (a confirmar en el diseño, no forma parte de estos requisitos): la tabla del
detalle por MR y la de los agregados se alimentan de **fuentes/ventanas distintas**, y el histórico
per-MR no se conserva más allá de una ventana corta. Concretamente, las tarjetas y la tabla de
detalle muestran cobertura temporal diferente, lo que produce que un mismo rango devuelva totales
agregados pero detalle vacío o truncado.

El objetivo del bugfix es que **un rango personalizado anterior a ~90 días (o que abarque
histórico) muestre el detalle por MR y pagine correctamente**, conservando el histórico de métricas
de MR más allá de la ventana actual.

## Bug Analysis

### Current Behavior (Defect)

Lo que ocurre hoy al consultar la pestaña Gestión con un rango personalizado que incluye fechas
fuera de la ventana de datos conservada:

1.1 WHEN el usuario selecciona un rango personalizado `[desde, hasta]` íntegramente anterior al
límite de cobertura del detalle por MR (p. ej. `01/01/2026–28/03/2026`) THEN la tabla "Detalle por
MR" devuelve **0 filas** y muestra el empty-state *"No hay datos de MRs para el periodo
seleccionado"* con respuesta **200 OK**.

1.2 WHEN el usuario selecciona un rango personalizado que cruza el límite de cobertura (parte
histórica + parte reciente, p. ej. `01/01/2026–26/06/2026`) THEN la tabla "Detalle por MR" solo
incluye MRs cuya fecha de merge es posterior al límite (~22 de abril) y **omite por completo los MRs
anteriores** que sí existieron en ese rango.

1.3 WHEN el usuario pagina hacia las páginas finales del "Detalle por MR" en un rango que abarca
histórico THEN la paginación **se detiene en el MR más antiguo conservado** (~22 de abril) y no
expone páginas adicionales para los MRs anteriores del rango, aunque el rango solicitado los
incluya.

1.4 WHEN el usuario consulta el mismo rango histórico THEN las tarjetas de "Indicadores de gestión"
muestran **algunos totales** mientras la tabla "Detalle por MR" sale vacía, exponiendo una
**incoherencia visible** entre agregados y detalle para el mismo periodo.

### Expected Behavior (Correct)

Lo que debería ocurrir tras el fix, para esas mismas condiciones:

2.1 WHEN el usuario selecciona un rango personalizado `[desde, hasta]` íntegramente histórico para
el que existieron MRs en GitLab THEN la tabla "Detalle por MR" SHALL mostrar las filas de los MRs
mergeados en ese rango (en lugar del empty-state), respetando los filtros activos (equipo,
proyecto, autor).

2.2 WHEN el usuario selecciona un rango que cruza el límite histórico/reciente THEN el "Detalle por
MR" SHALL incluir **tanto los MRs anteriores como los posteriores** al antiguo límite, sin omitir
los previos a ~22 de abril.

2.3 WHEN el usuario pagina hacia atrás en un rango que abarca histórico THEN la paginación SHALL
exponer todas las páginas necesarias para recorrer el conjunto completo de MRs del rango, y el
`total`/`totalPages` SHALL reflejar el recuento real de MRs del periodo.

2.4 WHEN el usuario consulta un rango histórico THEN los "Indicadores de gestión" y el "Detalle por
MR" SHALL ser **coherentes entre sí** para el mismo periodo (si las tarjetas reportan MRs en el
rango, el detalle debe poder listarlos).

2.5 WHEN existen MRs anteriores a la ventana de ~90 días THEN el sistema SHALL **conservar el
histórico de métricas de MR** (detalle per-MR y/o agregados) más allá de esa ventana, de modo que
los rangos históricos sean consultables.

### Unchanged Behavior (Regression Prevention)

Comportamiento existente que debe preservarse sin cambios:

3.1 WHEN el usuario selecciona un rango reciente dentro de la ventana ya cubierta (p. ej. últimos
30/90 días) THEN el "Detalle por MR" SHALL CONTINUE TO mostrar las filas, los KPIs (AVG REVIEW
TIME, TOTAL MRS, etc.) y la paginación como lo hace hoy.

3.2 WHEN el usuario aplica filtros de equipo, proyecto o autor sobre cualquier rango THEN el sistema
SHALL CONTINUE TO aplicar esos filtros correctamente sobre los resultados.

3.3 WHEN un rango no contiene ningún MR (ni histórico ni reciente) THEN el sistema SHALL CONTINUE TO
devolver **200 OK** y mostrar el empty-state legítimo, sin tratarlo como error técnico.

3.4 WHEN el usuario consulta las tarjetas de "Indicadores de gestión" para rangos recientes THEN
SHALL CONTINUE TO mostrar los mismos totales que hoy.

3.5 WHEN el usuario ordena/recorre el "Detalle por MR" THEN SHALL CONTINUE TO ordenarse por fecha de
merge descendente (más recientes primero) con el mismo tamaño de página.

## Condición del bug (metodología C(X))

Formalización testeable de la condición observable del fallo. Sea `B` el límite de cobertura del
histórico de detalle por MR (la fecha de merge más antigua actualmente consultable; ~2026-04-22 en
producción), y sea `X` una consulta de la pestaña Gestión con rango `[from, to]` y filtros.

**Función de condición del bug** — identifica las consultas que disparan el bug:

```pascal
FUNCTION isBugCondition(X)
  INPUT:  X = { from: Date, to: Date, filters }   // rango personalizado de la pestaña Gestión
  OUTPUT: boolean

  // El rango abarca fechas anteriores al límite de cobertura del detalle por MR,
  // y existieron MRs reales en esa porción histórica del rango.
  RETURN X.from < B
     AND existedMergedMRsInGitLab(X.from, min(X.to, B), X.filters)
END FUNCTION
```

**Propiedad — Fix Checking** (comportamiento correcto para entradas buggy):

```pascal
// Para todo rango que abarque histórico con MRs reales, el detalle NO debe salir vacío ni truncado
FOR ALL X WHERE isBugCondition(X) DO
  result ← mrDetails'(X)
  ASSERT result.mrs CONTAINS los MRs históricos de [X.from, min(X.to, B)]
  ASSERT result.pagination.total = recuento_real_de_MRs(X.from, X.to, X.filters)
  ASSERT NOT isEmptyState(result) WHEN recuento_real > 0
END FOR
```

**Propiedad — Preservation Checking** (entradas no-buggy se comportan igual que antes):

```pascal
// Para todo rango dentro de la ventana ya cubierta, el resultado fijo es idéntico al original
FOR ALL X WHERE NOT isBugCondition(X) DO
  ASSERT mrDetails(X) = mrDetails'(X)
END FOR
```

**Definiciones:**
- **F = `mrDetails`**: el endpoint del "Detalle por MR" tal y como se comporta hoy (antes del fix).
- **F' = `mrDetails'`**: el mismo endpoint tras aplicar el fix.
- **B**: límite de cobertura del histórico per-MR (fecha de merge más antigua consultable hoy).
- **Counterexample**: rango `01/01/2026–28/03/2026` sobre `basket-api` → empty-state con 200 OK
  pese a existir MRs mergeados en ese periodo en GitLab.
