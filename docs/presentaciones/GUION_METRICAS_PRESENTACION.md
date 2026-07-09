# Guion de Presentación — Métricas DORA y Monitorización Sintética

## Parte 1: Métricas DORA y Gestión de Ingeniería

### Introducción (2 min)

"Lo que vamos a ver hoy es cómo medimos el rendimiento de ingeniería de forma objetiva y automatizada. Usamos el framework DORA, que es el estándar de la industria creado por Google para medir equipos de software. Lo usan empresas como Spotify, Netflix, y está respaldado por el informe State of DevOps que lleva 10 años de investigación."

"El portal recopila datos automáticamente de GitLab cada noche y en tiempo real via webhooks. No hay intervención manual — los datos son los que son."

---

### Filtros (1 min)

"Arriba tenemos los filtros. Podemos ver métricas a nivel de toda la organización, por grupo de GitLab (digital, retail...), por equipo/squad, o incluso por proyecto individual. La ventana temporal va de 7 a 180 días."

"El conteo que veis entre paréntesis en los equipos es el número de proyectos activos en ese equipo."

---

### Las 4 Métricas DORA (5 min)

#### Deployment Frequency
"Mide cuántas veces desplegamos a producción por proyecto y día. Un equipo Elite despliega al menos una vez al día. Esto nos dice lo ágiles que somos para entregar valor."

"Solo contamos deploys exitosos a producción — no a dev ni staging. Se detectan por los jobs de CI/CD que tienen nombre de deploy a prod."

#### Lead Time (Tiempo de Entrega)
"Mide el tiempo desde que un desarrollador hace su primer commit hasta que ese cambio llega a producción. Incluye desarrollo, revisión de código y despliegue."

"Un equipo Elite tiene un lead time de menos de 1 hora. Nosotros estamos viendo el dato real — si es alto, nos dice que hay cuellos de botella en el proceso de revisión o en el pipeline."

#### Change Failure Rate
"Porcentaje de despliegues que fallan. Si desplegamos 100 veces y 5 fallan, tenemos un 5% — que es nivel Elite."

"Importante: solo contamos fallos de jobs de deploy en producción. Si un test falla antes del deploy, eso no cuenta aquí. Un CFR de 0% es el mejor resultado posible."

#### Pipeline Recovery Time
"Cuando un deploy falla, ¿cuánto tardamos en volver a desplegar con éxito? Esto mide la capacidad de recuperación del equipo."

"No es el MTTR clásico de incidentes en producción — es específico de pipeline. Mide agilidad de respuesta ante fallos técnicos."

---

### Contexto y Gráficos (2 min)

"Debajo de las 4 métricas principales tenemos el contexto: deploys exitosos totales, commits únicos, hotfixes detectados, rollbacks y fallos."

"Los hotfixes se detectan automáticamente por el nombre de la rama (hotfix/..., fix/...) o por el tipo de commit (fix:, hotfix:). Cuando implementéis el estándar de ramas, esto será aún más preciso."

"Los dos gráficos muestran la evolución diaria: a la izquierda volumen de entrega vs lead time, a la derecha fiabilidad (CFR vs tiempo de recuperación). Permiten ver tendencias y correlaciones."

---

### Tabla de Benchmarks (1 min)

"La tabla de abajo muestra dónde estamos respecto a los estándares DORA. La celda resaltada es nuestro nivel actual. El objetivo es ir moviendo todas las métricas hacia la izquierda (Elite)."

---

### Pestaña de Gestión (3 min)

"La pestaña de Gestión da una vista por persona. Muestra MRs mergeadas, tiempo medio de merge, reviews dados y actividad reciente."

"El tiempo medio de merge excluye MRs que estuvieron en Draft — para no inflar artificialmente el dato."

"Cada persona tiene una scorecard con sus últimas MRs. Esto permite a los managers ver de un vistazo quién está activo, quién revisa código de otros, y detectar cuellos de botella."

---

### Pestaña SonarQube (2 min)

"La tercera pestaña conecta con SonarQube para calidad de código. Muestra cobertura de tests, vulnerabilidades y deuda técnica."

"El mapeo entre proyectos de GitLab y SonarQube es automático por nombre, pero también permite selección manual."

---

### Documentación y Feedback (1 min)

"Hemos añadido un botón de 'Metodología' que descarga un documento con la explicación detallada de cada métrica: cómo se calcula, de dónde sale, qué significa cada nivel."

"También hay un botón de 'Feedback' donde cualquiera puede reportar datos incorrectos o proponer mejoras. Eso nos llega como ticket de Jira y mensaje de Teams directamente."

---

## Parte 2: Monitorización Sintética

### Introducción (1 min)

"La monitorización sintética comprueba la disponibilidad, latencia y estado SSL de los portales más relevantes de la organización. Se ejecuta periódicamente y nos da una foto en tiempo real del estado de los servicios."

---

### Vista de Monitores (2 min)

"Cada servicio tiene tres indicadores:
- **Disponibilidad**: ¿Responde el servicio? (HTTP 200)
- **Alcanzabilidad**: ¿Se puede llegar al servicio? (DNS + TCP)
- **Latencia P95**: Tiempo de respuesta en el percentil 95

Los estados son: Operativo (verde), Degradado (amarillo), Caído (rojo)."

---

### KPIs Globales (1 min)

"Arriba tenemos los KPIs agregados:
- Disponibilidad media de todos los servicios
- Alcanzabilidad media
- Latencia P95 media
- Incidentes activos
- SLA 30 días (el peor de todos los servicios)"

---

### Tendencias (1 min)

"Cada servicio muestra una tendencia visual que indica si está mejorando o empeorando respecto al periodo anterior."

---

### Ejecución Manual (30 seg)

"El botón 'Ejecutar comprobaciones' permite lanzar un check inmediato de todos los servicios sin esperar al siguiente ciclo automático."

---

## Cierre (1 min)

"En resumen: tenemos visibilidad completa y automatizada del rendimiento de ingeniería (DORA + gestión) y del estado operativo de los servicios (sintéticos). Todo sin intervención manual, con datos reales de GitLab y SonarQube."

"Los próximos pasos son:
1. Implementar el estándar de ramas y commits para mejorar la clasificación de hotfixes
2. Añadir labels en MRs para diferenciar contextos (DEV vs PROD)
3. Integrar Grafana Assistant para correlación con métricas de runtime"

---

*Tiempo total estimado: 20-22 minutos*
