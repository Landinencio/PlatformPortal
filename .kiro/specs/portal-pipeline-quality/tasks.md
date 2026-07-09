# Implementation Plan — Quality gates en la pipeline del portal

## Overview

Plan para añadir tests + lint + SonarQube a la pipeline del portal antes del build. Cambios en dos repos: el repo del portal (scripts npm, c8, `sonar-project.properties`, CI var `SQ_TOKEN`) y el Toolkit (plantilla `CI/portal-quality.yml` + stages en `main-portal.yml`). Adopción gradual: tests bloqueantes desde el inicio; lint y Sonar informativos hasta endurecer.

## Task Dependency Graph

```
1 (scripts+c8) ─► 2 (validar test+coverage local) ─┐
3 (sonar-project.properties) ───────────────────────┤
                                                     ├─► 6 (commit portal) ─┐
4 (SQ_TOKEN CI var) ─────────────────────────────────┘                      │
5 (plantilla toolkit + main-portal stages) ─► 7 (MR toolkit) ───────────────┤
                                                                             ├─► 8 (MR prueba portal + verificar jobs) ─► 9 (endurecer) 
                                                                             │                                                    │
                                                                             └────────────────────────────────────────────────► 10 (steering)
```

```json
{
  "waves": [
    { "wave": 1, "tasks": ["1", "3", "4", "5"], "dependsOn": [] },
    { "wave": 2, "tasks": ["2"], "dependsOn": ["1"] },
    { "wave": 3, "tasks": ["6", "7"], "dependsOn": ["2", "3", "4", "5"] },
    { "wave": 4, "tasks": ["8"], "dependsOn": ["6", "7"] },
    { "wave": 5, "tasks": ["9", "10"], "dependsOn": ["8"] }
  ]
}
```

## Tasks

- [x] 1. Añadir scripts de test/cobertura y dependencia c8 al portal
  - En `package.json`: añadir `"test": "tsx --test src/lib/__tests__/*.test.ts"` y `"test:coverage": "c8 --reporter=lcov --reporter=text --src src tsx --test src/lib/__tests__/*.test.ts"`. Conservar `"lint": "eslint"`.
  - Añadir `c8` (y `tsx` si no está) a `devDependencies` y actualizar `package-lock.json` con `npm install`.
  - _Requirements: 6.1, 6.2, 6.3, 6.4_

- [x] 2. Validar tests + cobertura en local
  - Ejecutar `npm ci` + `npm run test:coverage` con Node 20; confirmar que toda la suite (`src/lib/__tests__/*.test.ts`) pasa y que se genera `coverage/lcov.info`.
  - Ajustar el glob/scripts si algún test no resuelve (alias `@/` vía tsx) o si c8 no emite lcov.
  - _Requirements: 6.5, 9.2_

- [x] 3. Crear `sonar-project.properties` en el portal
  - En la raíz del repo: `sonar.projectKey=iskaypetcom-digital-sre-tools:platformportal`, `sonar.projectName=Platform Portal`, `sonar.sources=src`, `sonar.tests=src/lib/__tests__`, `sonar.javascript.lcov.reportPaths=coverage/lcov.info`.
  - Exclusiones de cobertura/cpd/análisis: tests, `*.config.*`, `ops/**`, `migrations/**`, `.helm/**`, `docs/**`, `.next/**`, `node_modules/**`, `public/**`.
  - _Requirements: 7.1, 7.2, 7.3, 7.4_

- [x] 4. Crear la CI var `SQ_TOKEN` en el proyecto portal
  - Obtener/generar un token de análisis de SonarQube (preferible project analysis token con scope mínimo; alternativa: `sonarqube-token` de `platformportal-secrets`).
  - Crear `SQ_TOKEN` como variable CI/CD del proyecto portal (id 77693276), masked (protected si aplica).
  - _Requirements: 8.1_

- [x] 5. Crear la plantilla `CI/portal-quality.yml` y editar `main-portal.yml` en el Toolkit
  - Nueva plantilla con `portal_tests` (stage `test`, `npm ci` + `npm run test:coverage`, artifact `coverage/`, bloqueante), `portal_lint` (stage `lint`, `npm ci` + `npm run lint`, `allow_failure: true`), `sonar_scanning` (stage `code_quality`, `sonar-scanner -Dsonar.qualitygate.wait=true`, `dependencies: [portal_tests]`, `allow_failure: true`). Vars `SONAR_TOKEN=${SQ_TOKEN}`, `SONAR_HOST_URL`, `PORTAL_NODE_IMAGE`. `only: refs [merge_requests, main]`.
  - En `main-portal.yml`: añadir `- local: 'CI/portal-quality.yml'` al `include` y los stages `test`, `lint`, `code_quality` antes de `build_image` (tras `versioning_release_candidate`).
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3, 5.4, 5.5, 9.1, 10.1, 10.2, 10.3_

- [ ] 6. Commit de los cambios del portal
  - Commitear `package.json`, `package-lock.json`, `sonar-project.properties` en `feat/SRE-001` (`[SRE-001] ci: add test/coverage scripts + sonar config`). No rompe nada por sí solo (el toolkit aún no llama esos scripts hasta el merge de la task 7).
  - _Requirements: 9.3_

- [x] 7. MR de la plantilla en el Toolkit
  - Crear branch + commit con la plantilla y los stages en el Toolkit (id 61922532) vía API. Abrir MR (`[SRE-90xx] ci: add portal quality gates template`). El usuario lo mergea (push-rule/manual).
  - El `.gitlab-ci.yml` del portal ya hace `include ... ref: main`, así que al mergear el toolkit la próxima pipeline del portal trae los gates.
  - _Requirements: 1.*, 2.*_

- [ ] 8. MR de prueba en el portal y verificación de los jobs
  - Abrir una MR en el portal y comprobar que aparecen y corren los 3 jobs: `portal_tests` (verde, bloqueante, publica coverage), `portal_lint` (informativo), `sonar_scanning` (informativo, `qualitygate.wait`). Verificar que el build/scan/deploy posteriores siguen funcionando.
  - Confirmar en `sonarqube.tooling.dp.iskaypet.com` que el proyecto aparece con cobertura y métricas.
  - _Requirements: 3.4, 8.2, 8.3, 9.3_

- [ ] 9. Endurecer lint y Sonar (paso posterior)
  - Cuando el repo esté saneado: quitar `allow_failure: true` de `portal_lint` y `sonar_scanning` en la plantilla del Toolkit para que bloqueen el merge ante errores/quality gate fallido.
  - _Requirements: 10.4_

- [x] 10. Actualizar el steering canónico
  - En `.kiro/steering/portal-architecture.md` (§20 pipeline / nueva nota): documentar los quality gates (jobs, stages, plantilla Toolkit, `sonar-project.properties`, `SQ_TOKEN`, estrategia de adopción gradual).
  - _Requirements: 10.1, 10.2, 10.3_

## Notes

- **Fail-fast**: los gates van antes de `build_image`; un test rojo no produce imagen.
- **Dos repos**: portal (config) + Toolkit (plantilla). El portal consume el Toolkit por `ref: main`, así que el orden de merge importa: primero portal (inocuo), luego Toolkit (activa los gates).
- **npm ci**: reproducible con `package-lock.json`; no migramos a pnpm ni cambiamos el runner (`node:test` + `tsx`).
- **Adopción gradual**: tests bloqueantes desde el día 1 (ya pasan en verde); lint y Sonar informativos hasta el endurecimiento (task 9).
- **No tocar deploy**: build/scan/deploy_dev/prod intactos.
