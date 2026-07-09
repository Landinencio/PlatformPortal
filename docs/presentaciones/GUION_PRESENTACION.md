# Guion — Métricas de Ingeniería (3 minutos)

## [0:00 - 0:15] Apertura

"Os enseño cómo medimos la eficiencia de ingeniería. Usamos las métricas DORA, el estándar de la industria. El portal recoge datos de GitLab y SonarQube cada día de forma automática."

---

## [0:15 - 1:20] Pestaña DORA

"Arriba tenéis los filtros: ventana temporal, equipo y proyectos. Podéis guardar vuestras selecciones favoritas para no tener que buscar cada vez."

Señalar cada card:

- **Deployment Frequency** — "Con qué frecuencia desplegamos a producción por proyecto y día. Cuanto más alto, más ágiles somos. El badge verde/amarillo/rojo os dice en qué nivel estáis según los benchmarks mundiales."

- **Lead Time for Changes** — "Cuánto tarda un cambio desde el último commit hasta que llega a producción. Usa como referencia el commit más reciente del deploy. Menos de 1 hora es nivel Elite."

- **Change Failure Rate** — "Qué porcentaje de deploys fallan. Se calcula dividiendo fallos entre intentos totales. Menos del 5% es Elite. Los hotfixes y rollbacks se clasifican aparte."

- **MTTR** — "Tiempo medio de recuperación. Cuánto tardamos desde que un deploy falla hasta que el siguiente tiene éxito. Menos de 1 hora es Elite."

"Debajo de cada card hay una explicación de cómo se calcula el dato, para total transparencia."

---

## [1:20 - 2:10] Pestaña Gestión (hacer click)

Señalar cada card:

- **Ritmo de entrega** — "MRs fusionadas en el periodo. Es el throughput real del equipo."

- **MRs abiertas** — "Work in progress actual. Si sube mucho, hay cuellos de botella."

- **Densidad de revisión** — "Comentarios por MR. Mide si hay code review real o se aprueba sin mirar."

- **Lifetime mediana** — "Cuánto vive una MR desde que se crea hasta que se fusiona. 18 horas es buen dato."

- **Lead time a primer feedback** — "Cuánto tarda alguien en dejar el primer comentario. Mide la velocidad de respuesta del equipo."

- **Review time mediana** — "Tiempo de revisión activa, desde el primer comentario hasta el merge. Excluye la espera inicial."

- **Tamaño de cambio** — "Líneas modificadas por MR. Cambios pequeños se revisan mejor y fallan menos."

- **Abiertas envejecidas** — "MRs abiertas más de 3, 7 o 14 días. Sirve para detectar MRs atascadas."

Scroll abajo:

- **Autores con impacto en producción** — "Personas cuyos cambios han llegado a prod, con su lead time individual y señal de riesgo. Aquí veis quién contribuye y cómo."

---

## [2:10 - 2:50] Pestaña SonarQube (hacer click)

- **Cobertura media** — "Porcentaje de código cubierto por tests automáticos en los 119 proyectos."

- **Vulnerabilidades y bugs** — "Problemas de seguridad y defectos detectados por análisis estático."

- **Deuda técnica** — "Tiempo estimado para resolver todos los code smells. Indica la salud del código."

- **Tendencia histórica** — "Gráfico de cómo evoluciona la cobertura y la duplicación con el tiempo."

- **Portfolio** — "Tabla con todos los proyectos, su cobertura, bugs, vulnerabilidades y quality gate. Se puede exportar a Excel."

---

## [2:50 - 3:00] Cierre

"Todo se actualiza solo cada día. Cada equipo puede ver sus métricas y guardar sus vistas. Los datos son para mejorar, no para juzgar. Está disponible ya para todos."

---

## Tips para la demo

- Usa el equipo **websites** o **oms** como filtro — tienen más actividad
- Proyecto recomendado: **ikp-digi-wcp-front-ecommerce** (9 deploys, 86 MRs, 4 contribuidores)
- No leas el guion — úsalo como referencia y señala los números reales
- Haz click en cada pestaña mientras hablas
- Si alguien pregunta por un dato, la explicación está debajo de cada card
