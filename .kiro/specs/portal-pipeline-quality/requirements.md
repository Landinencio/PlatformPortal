# Requirements Document

## Introduction

Esta feature añade **quality gates** a la pipeline de CI/CD del Platform Portal. Hoy la pipeline solo hace `RC tag → build imagen → scan Harbor → deploy`, sin ejecutar tests, lint ni análisis de calidad de código.

Se añaden tres jobs nuevos —**tests**, **lint** y **SonarQube**— que corren **antes** del build, mediante una plantilla específica del portal en el Toolkit (`CI/portal-quality.yml`) incluida desde `main-portal.yml`, reutilizando el SonarQube corporativo (`sonarqube.tooling.dp.iskaypet.com`).

La adopción es gradual: los tests son bloqueantes desde el día 1 (ya pasan en verde), mientras que lint y SonarQube arrancan informativos (`allow_failure: true`) para "empezar a medir" sin frenar al equipo, y se endurecen en un paso posterior explícito. El cambio no debe romper el flujo existente de build/scan/deploy, no migra a pnpm y no cambia el runner de tests (`node:test` + `tsx`).

Estos requisitos se derivan del documento de diseño aprobado (`design.md`) de esta misma spec.

## Glossary

- **Portal_Pipeline**: La pipeline de GitLab CI del repositorio Platform Portal (`platformportal`, id 77693276), definida vía `include` de la plantilla `main-portal.yml` del Toolkit.
- **Toolkit**: El repositorio `gitlab-ci-toolkit` (id 61922532) que contiene las plantillas de CI/CD corporativas.
- **Quality_Template**: La nueva plantilla del Toolkit `CI/portal-quality.yml` que define los tres jobs de quality gate.
- **Main_Portal_Template**: La plantilla `main-portal.yml` del Toolkit que orquesta la pipeline del portal mediante `include` y la lista de `stages`.
- **Portal_Tests_Job**: El job `portal_tests` (stage `test`) que ejecuta la suite de tests con cobertura.
- **Portal_Lint_Job**: El job `portal_lint` (stage `lint`) que ejecuta ESLint.
- **Sonar_Scanning_Job**: El job `sonar_scanning` (stage `code_quality`) que ejecuta `sonar-scanner` contra el SonarQube corporativo.
- **SonarQube_Server**: La instancia corporativa de SonarQube en `https://sonarqube.tooling.dp.iskaypet.com/`.
- **Coverage_Report**: El fichero `coverage/lcov.info` generado por c8 en formato LCOV.
- **Sonar_Config**: El fichero `sonar-project.properties` en la raíz del repositorio portal.
- **SQ_TOKEN**: La variable de CI/CD del proyecto portal (masked) que contiene el token de autenticación contra SonarQube_Server.
- **Node_Image**: La imagen de contenedor Node 20 del registro corporativo (`harbor.tooling.dp.iskaypet.com/platform-images/node:20`).

## Requirements

### Requirement 1: Plantilla de quality gates en el Toolkit

**User Story:** Como SRE, quiero una plantilla de CI específica del portal que defina los jobs de quality gate, para reutilizar comandos npm/tsx propios del portal sin depender de las plantillas genéricas que asumen pnpm.

#### Acceptance Criteria

1. THE Quality_Template SHALL define the Portal_Tests_Job assigned to the `test` stage.
2. THE Quality_Template SHALL define the Portal_Lint_Job assigned to the `lint` stage.
3. THE Quality_Template SHALL define the Sonar_Scanning_Job assigned to the `code_quality` stage.
4. THE Quality_Template SHALL set the variable `SONAR_TOKEN` to the value of SQ_TOKEN.
5. THE Quality_Template SHALL set the variable `SONAR_HOST_URL` to `https://sonarqube.tooling.dp.iskaypet.com/`.

### Requirement 2: Inclusión y ordenación de stages en main-portal.yml

**User Story:** Como SRE, quiero que la pipeline incluya la plantilla de quality gates y ejecute los gates antes del build, para detectar fallos antes de construir una imagen (fail-fast).

#### Acceptance Criteria

1. THE Main_Portal_Template SHALL include the Quality_Template via a `local` include directive.
2. THE Main_Portal_Template SHALL declare the `test`, `lint`, and `code_quality` stages ordered before the `build_image` stage.
3. THE Main_Portal_Template SHALL declare the `versioning_release_candidate` stage before the `test` stage.
4. THE Main_Portal_Template SHALL preserve the existing `build_image`, `security_scan`, `deploy_dev`, `versioning_release`, and `deploy_prod` stages unchanged.

### Requirement 3: Job de tests con cobertura (bloqueante)

**User Story:** Como SRE, quiero que la pipeline ejecute la suite de tests con cobertura y bloquee si fallan, para tener una red de seguridad real antes de construir la imagen.

#### Acceptance Criteria

1. WHEN the Portal_Tests_Job runs, THE Portal_Tests_Job SHALL execute `npm ci` followed by `npm run test:coverage`.
2. THE Portal_Tests_Job SHALL use the Node_Image as its container image.
3. WHEN the test suite completes successfully, THE Portal_Tests_Job SHALL publish the `coverage/` directory as a job artifact.
4. IF the test suite fails, THEN THE Portal_Tests_Job SHALL fail the Portal_Pipeline and prevent the `build_image` stage from running.
5. THE Portal_Tests_Job SHALL run only when the pipeline ref is a merge request or the `main` branch.

### Requirement 4: Job de lint (informativo al inicio)

**User Story:** Como SRE, quiero que la pipeline ejecute ESLint en modo informativo, para medir la calidad sin bloquear el merge mientras se sanea la deuda.

#### Acceptance Criteria

1. WHEN the Portal_Lint_Job runs, THE Portal_Lint_Job SHALL execute `npm ci` followed by `npm run lint`.
2. THE Portal_Lint_Job SHALL use the Node_Image as its container image.
3. IF the lint command reports errors, THEN THE Portal_Lint_Job SHALL report a failed status WHILE allowing the Portal_Pipeline to continue.
4. THE Portal_Lint_Job SHALL run only when the pipeline ref is a merge request or the `main` branch.

### Requirement 5: Job de análisis SonarQube (informativo al inicio)

**User Story:** Como SRE, quiero que la pipeline ejecute un análisis SonarQube con la cobertura generada por los tests, para empezar a medir la calidad del código en el SonarQube corporativo.

#### Acceptance Criteria

1. WHEN the Sonar_Scanning_Job runs, THE Sonar_Scanning_Job SHALL execute `sonar-scanner` with the option `sonar.qualitygate.wait=true`.
2. THE Sonar_Scanning_Job SHALL declare a dependency on the Portal_Tests_Job to consume the Coverage_Report.
3. THE Sonar_Scanning_Job SHALL authenticate against SonarQube_Server using `SONAR_TOKEN` and `SONAR_HOST_URL`.
4. IF the SonarQube quality gate fails, THEN THE Sonar_Scanning_Job SHALL report a failed status WHILE allowing the Portal_Pipeline to continue.
5. THE Sonar_Scanning_Job SHALL run only when the pipeline ref is a merge request or the `main` branch.

### Requirement 6: Scripts de test y cobertura en el portal

**User Story:** Como desarrollador del portal, quiero scripts npm de test y cobertura, para ejecutar la suite localmente y en CI generando un informe LCOV consumible por SonarQube.

#### Acceptance Criteria

1. THE portal `package.json` SHALL define a `test` script that runs the `node:test` suite via `tsx` over `src/lib/__tests__/*.test.ts`.
2. THE portal `package.json` SHALL define a `test:coverage` script that runs the test suite under c8 and emits an LCOV report to `coverage/lcov.info`.
3. THE portal `package.json` SHALL declare `c8` as a development dependency.
4. THE portal `package.json` SHALL preserve the existing `lint` script unchanged.
5. WHEN the `test:coverage` script completes successfully, THE Coverage_Report SHALL exist at `coverage/lcov.info`.

### Requirement 7: Configuración de SonarQube en el portal

**User Story:** Como SRE, quiero un fichero de configuración SonarQube en el repositorio del portal, para definir clave de proyecto, fuentes, tests y rutas de cobertura de forma estable.

#### Acceptance Criteria

1. THE Sonar_Config SHALL set `sonar.projectKey` to `iskaypetcom-digital-sre-tools:platformportal`.
2. THE Sonar_Config SHALL set `sonar.sources` to `src`.
3. THE Sonar_Config SHALL set `sonar.javascript.lcov.reportPaths` to `coverage/lcov.info`.
4. THE Sonar_Config SHALL declare the test inclusions and coverage exclusions for test files, configuration files, `ops`, `migrations`, `.helm`, and `docs`.

### Requirement 8: Token y proyecto SonarQube

**User Story:** Como SRE, quiero el token de SonarQube disponible como variable de CI protegida y el proyecto registrado, para que el análisis pueda autenticarse y publicar resultados.

#### Acceptance Criteria

1. THE portal project SHALL define SQ_TOKEN as a masked CI/CD variable containing a SonarQube authentication token.
2. WHERE the SonarQube project `iskaypetcom-digital-sre-tools:platformportal` does not yet exist, THE SonarQube_Server SHALL auto-provision the project on the first analysis.
3. WHEN the Sonar_Scanning_Job completes successfully, THE SonarQube_Server SHALL display the portal project with coverage and code quality metrics.

### Requirement 9: Reproducibilidad y no regresión del flujo existente

**User Story:** Como SRE, quiero que los quality gates usen instalación reproducible y no alteren el flujo de despliegue actual, para añadir calidad sin riesgo de romper build, scan o deploy.

#### Acceptance Criteria

1. THE Portal_Tests_Job, THE Portal_Lint_Job, and THE Sonar_Scanning_Job SHALL install dependencies using `npm ci` against the committed `package-lock.json`.
2. THE Portal_Pipeline SHALL retain the `node:test` plus `tsx` test runner without migrating to pnpm or a different test runner.
3. WHEN the quality gate stages complete, THE Portal_Pipeline SHALL execute the existing `build_image`, `security_scan`, and deploy stages with their previous behavior.

### Requirement 10: Estrategia de adopción gradual y endurecimiento

**User Story:** Como SRE, quiero una estrategia de adopción gradual de los gates, para dar ejemplo midiendo la calidad sin frenar al equipo y endurecer los gates cuando la deuda esté saneada.

#### Acceptance Criteria

1. THE Portal_Tests_Job SHALL be blocking from the initial rollout.
2. THE Portal_Lint_Job SHALL start with `allow_failure: true` as an informative gate.
3. THE Sonar_Scanning_Job SHALL start with `allow_failure: true` as an informative gate.
4. WHERE the hardening step is applied, THE Portal_Lint_Job and THE Sonar_Scanning_Job SHALL become blocking by removing `allow_failure`.
