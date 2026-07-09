# Design — Quality gates en la pipeline del portal (tests + lint + SonarQube)

## Overview

La pipeline del Platform Portal hoy es `RC tag → build imagen → scan Harbor → deploy_dev → release → deploy_prod`. **No ejecuta tests, ni lint, ni análisis de calidad de código.** El job `scan` es solo escaneo de la imagen (Harbor/Trivy), no calidad.

El portal ya tiene una base sólida que no se aprovecha en CI:
- **16 ficheros de test** `node:test` + `fast-check` en `src/lib/__tests__/` (incluido el nuevo `deploy-notify.test.ts`).
- **ESLint** configurado (`next/core-web-vitals` + `next/typescript`), ejecutable con `npm run lint`.

Como SRE, toca predicar con el ejemplo: añadir **quality gates** a nuestra propia pipeline antes que a las de los squads. Esta feature añade tres jobs nuevos —**tests**, **lint** y **SonarQube**— reutilizando el SonarQube corporativo (`sonarqube.tooling.dp.iskaypet.com`) que ya está montado en el Toolkit, mediante una **plantilla específica del portal** en el Toolkit (`CI/portal-quality.yml`), incluida desde `main-portal.yml`.

### Por qué una plantilla específica y no la genérica `CI/react/*`
Las plantillas `CI/react/{sonar,testing}.yml` del Toolkit **no encajan** con el portal:
- Asumen **pnpm** (`pnpm install --frozen-lockfile`); el portal usa **npm** (`package-lock.json`).
- Invocan scripts que el portal no tiene: `lint:check`, `format:check`, `test`, `test:coverage`.
- El portal usa `node:test` vía `tsx`, no Jest/Vitest.

Se reutiliza el **patrón** de `CI/react/sonar.yml` (imagen, host, project key, quality gate) pero con comandos npm/tsx propios del portal.

### No-objetivos
- No migrar a pnpm ni cambiar el runner de tests (seguimos con `node:test` + `tsx`).
- No bloquear el merge desde el día 1: Sonar arranca en `allow_failure: true` (modo "empezar a medir"); el endurecimiento a quality gate bloqueante es un paso posterior explícito.
- No tocar el flujo de deploy (build/scan/deploy_dev/prod se mantienen intactos).
- No exigir un umbral de cobertura concreto todavía; primero generamos y publicamos la cobertura.

## Architecture

```
Pipeline del portal (main-portal.yml) — stages NUEVOS antes de build_image:

  versioning_release_candidate
  → test          ── portal_tests   (npm ci + node:test con cobertura → coverage/lcov.info)
  → lint          ── portal_lint    (npm run lint)
  → code_quality  ── sonar_scanning  (sonar-scanner → SonarQube toolkit, consume lcov.info)
  → build_image   (sin cambios)
  → security_scan (sin cambios)
  → deploy_dev / versioning_release / deploy_prod (sin cambios)
```

Dos repos involucrados:
- **Toolkit** (`gitlab-ci-toolkit`, id 61922532): nueva plantilla `CI/portal-quality.yml` + 3 stages nuevos y el `include` en `main-portal.yml`.
- **Portal** (`platformportal`, id 77693276): scripts npm de test/cobertura, `sonar-project.properties`, dependencia de cobertura, y CI var `SQ_TOKEN`.

## Components and Interfaces

### 1. Portal — `package.json` scripts

```jsonc
{
  "scripts": {
    "test": "tsx --test src/lib/__tests__/*.test.ts",
    "test:coverage": "c8 --reporter=lcov --reporter=text --src src tsx --test src/lib/__tests__/*.test.ts",
    "lint": "eslint"   // ya existe
  }
}
```

- `test`: ejecuta toda la suite `node:test`. Node 20 (ya se usa en build local) soporta `--test` glob.
- `test:coverage`: envuelve con **c8** para emitir `coverage/lcov.info` (formato que SonarQube consume). c8 se añade a `devDependencies`.
- Alternativa considerada: `node --experimental-test-coverage --test-reporter=lcov`. Descartada porque la versión de Node del runner puede no tenerlo estable; **c8** es más portable y es el estándar del ecosistema.

> Nota: algunos tests importan con alias `@/` — se ejecutan con `tsx`, que resuelve `tsconfig.paths`. Verificado localmente (22 tests de deploy-notify + suite property en verde).

### 2. Portal — `sonar-project.properties`

```properties
sonar.projectKey=iskaypetcom-digital-sre-tools:platformportal
sonar.projectName=Platform Portal
sonar.sources=src
sonar.tests=src/lib/__tests__
sonar.test.inclusions=**/*.test.ts,**/*.property.test.ts
sonar.javascript.lcov.reportPaths=coverage/lcov.info
sonar.coverage.exclusions=**/*.test.ts,**/*.property.test.ts,**/*.config.*,ops/**,migrations/**,.helm/**,docs/**
sonar.cpd.exclusions=**/*.test.ts,**/*.property.test.ts
sonar.exclusions=.next/**,node_modules/**,public/**,ops/**,docs/**
```

- `projectKey` coherente con el patrón `${CI_PROJECT_NAMESPACE}:${CI_PROJECT_NAME}` de la plantilla react (con `/`→`-`). Se fija explícito para estabilidad.
- Excluye de cobertura: tests, configs, ops, migrations, helm, docs.

### 3. Toolkit — `CI/portal-quality.yml` (plantilla nueva)

```yaml
default:
  tags: [kubernetes-executor]

variables:
  SONAR_TOKEN: ${SQ_TOKEN}
  SONAR_HOST_URL: "https://sonarqube.tooling.dp.iskaypet.com/"
  PORTAL_NODE_IMAGE: "harbor.tooling.dp.iskaypet.com/platform-images/node:20"

portal_tests:
  stage: test
  image: { name: "${PORTAL_NODE_IMAGE}", entrypoint: [""] }
  script:
    - npm ci
    - npm run test:coverage
  artifacts:
    paths: [coverage/]
    expire_in: 1 day
  only:
    refs: [merge_requests, main]

portal_lint:
  stage: lint
  image: { name: "${PORTAL_NODE_IMAGE}", entrypoint: [""] }
  script:
    - npm ci
    - npm run lint
  allow_failure: true        # arranca informativo; endurecer después
  only:
    refs: [merge_requests, main]

sonar_scanning:
  stage: code_quality
  image:
    name: harbor.tooling.dp.iskaypet.com/platform-images/sonarsource/sonar-scanner-cli:11.5
    entrypoint: [""]
  dependencies: [portal_tests]   # necesita coverage/lcov.info
  script:
    - sonar-scanner -Dsonar.qualitygate.wait=true
  allow_failure: true            # modo "empezar a medir"; luego bloqueante
  only:
    refs: [merge_requests, main]
```

- `npm ci` (no `npm install`) para reproducibilidad con `package-lock.json`.
- Imagen Node del registro corporativo (`platform-images/node:20`); se confirma el tag disponible en Harbor (si no, usar el tag exacto que exista).
- `sonar-scanner` lee `sonar-project.properties` del repo + `SONAR_TOKEN`/`SONAR_HOST_URL` del entorno.
- **caché npm**: opcional `cache` de `node_modules` por `package-lock.json` para acelerar (los 3 jobs hacen `npm ci`); se puede añadir tras validar.

### 4. Toolkit — `main-portal.yml` (modificación)

Añadir el include y los stages:

```yaml
include:
  - local: 'CI/portal-quality.yml'   # NUEVO
  - local: 'CI/build-portal.yml'
  - local: 'CI/build-portal-aux.yml'
  - local: 'CI/image_scan.yml'
  - local: 'CD/deploy-portal.yml'

stages:
  - versioning_release_candidate
  - test            # NUEVO
  - lint            # NUEVO
  - code_quality    # NUEVO
  - build_image
  - security_scan
  - deploy_dev
  - versioning_release
  - deploy_prod
```

Orden: los gates corren **antes** del build (fail-fast: no construimos imagen si los tests fallan). El RC tag se mantiene primero porque genera el `dotenv` que usan los stages de build.

### 5. SonarQube — proyecto y token

- **Token `SQ_TOKEN`**: CI var del proyecto portal (id 77693276), masked. Se obtiene del token SonarQube existente (`platformportal-secrets` key `sonarqube-token`) o se genera uno *project analysis token* dedicado en SonarQube para el proyecto `platformportal` (preferible: scope mínimo).
- **Proyecto en SonarQube**: si no existe `iskaypetcom-digital-sre-tools:platformportal`, se crea en el primer análisis (auto-provision) o manualmente. Quality gate por defecto (Sonar way) al principio.

## Data Models

No aplica (es CI/CD; sin cambios de BD).

## Error Handling y estrategia de adopción gradual

| Job | Estado inicial | Endurecimiento posterior |
|-----|----------------|--------------------------|
| `portal_tests` | **bloqueante** (los tests deben pasar) | se mantiene bloqueante |
| `portal_lint` | `allow_failure: true` (informativo) | quitar `allow_failure` cuando el repo esté limpio de warnings |
| `sonar_scanning` | `allow_failure: true` + `qualitygate.wait` | quitar `allow_failure` para que el quality gate bloquee el merge |

Razonamiento: los tests ya pasan en verde hoy, así que pueden ser bloqueantes desde el inicio (red de seguridad real). Lint y Sonar arrancan informativos para no bloquear el flujo mientras se sanea la deuda, y se endurecen en un segundo paso explícito. Esto es "empezar a medir" sin frenar al equipo.

## Testing Strategy

- **Validación local** antes de subir: `npm ci`, `npm run test:coverage` (genera `coverage/lcov.info`), `npm run lint`. Verificar que la suite completa pasa con tsx + coverage y que el lcov se genera.
- **Validación en CI**: abrir una MR de prueba en el portal y comprobar que los 3 jobs aparecen y corren (tests verde, lint/sonar informativos), y que el build sigue funcionando después.
- **Validación SonarQube**: confirmar que el proyecto aparece en `sonarqube.tooling.dp.iskaypet.com` con cobertura y métricas.

## Despliegue / orden de cambios

1. **Portal**: añadir scripts + `c8` devDep + `sonar-project.properties`. Validar local. Commit a `feat/SRE-001` (no rompe nada por sí solo — el toolkit aún no llama esos scripts).
2. **SonarQube**: crear/obtener `SQ_TOKEN` y ponerlo como CI var del portal (masked).
3. **Toolkit**: crear `CI/portal-quality.yml` + editar `main-portal.yml` (stages + include). MR en toolkit (consume el usuario; merge manual).
4. El `.gitlab-ci.yml` del portal ya hace `include ... ref: main` del toolkit → al mergear el toolkit, la próxima pipeline del portal ya trae los gates.
5. Probar con una MR en el portal. Endurecer lint/sonar cuando esté saneado.
6. Actualizar steering (`portal-architecture.md` §20 pipeline / nueva nota de quality gates).

## Decisiones clave (resumen)

| Decisión | Elección | Por qué |
|----------|----------|---------|
| Plantilla | nueva `CI/portal-quality.yml` específica | la genérica `CI/react/*` asume pnpm + scripts inexistentes |
| Runner de tests | `node:test` + `tsx` (sin cambios) | ya hay 16 ficheros de test; no reinventar |
| Cobertura | `c8` → `lcov.info` | portable, estándar, lo consume Sonar |
| Gestor de paquetes | npm (`npm ci`) | el repo usa `package-lock.json` |
| Orden de stages | gates antes de build | fail-fast: no construir imagen si fallan tests |
| Adopción | tests bloqueante; lint+sonar informativos al inicio | dar ejemplo sin frenar; endurecer después |
| SonarQube | el corporativo del toolkit | ya montado, un solo sitio de verdad |
