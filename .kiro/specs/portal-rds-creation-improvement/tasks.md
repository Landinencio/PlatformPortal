# Implementation Plan: portal-rds-creation-improvement

## Overview

Se construye un **Generador_RDS determinista** (módulos puros bajo `src/lib/rds/`) que sustituye
la generación basada en IA para la creación de RDS, introspecciona `iac/databases/` del
Repositorio_Destino vía `gitlabClient`, renderiza el `.tf` parametrizado (cero literales para los
cinco atributos de motor/versión/flags) más `variables.tf` y los tres `tfvars`, y aplica guardas
deterministas (anti-literal, completitud de tfvars, coherencia) antes de emitir un
`TerraformPreview` extendido. Después se refuerza el validador de rotación, se cablea el endpoint
`generate` (validación + delegación) y `execute` (escritura multi-fichero + validación reforzada),
y por último el formulario (selector de motor/versión, defaults, reset al cambiar de motor,
etiqueta "PostgreSQL" —MySQL no permitido—, bloqueo de envío).

El plan secuencia primero los módulos puros con sus property tests, luego el generador y guardas,
después el validador, el cableado de servidor con tests de integración (gitlabClient mockeado), y
finalmente el formulario con tests unitarios, con checkpoints intermedios.

Stack de test: `node:test` (vía `tsx --test`) + `fast-check ^4.7.0`. Tests en
`src/lib/__tests__/*.property.test.ts` (propiedades) y `*.test.ts` (unidad/integración), recogidos
por `npm test`. Cada property test usa `{ numRuns: 100 }` (200 para guardas críticas) y lleva el
tag `// Feature: portal-rds-creation-improvement, Property N: ...`.

## Tasks

- [x] 1. Catalogo_Versiones (fuente de verdad pura)
  - [x] 1.1 Implementar `src/lib/rds/version-catalog.ts`
    - Definir `RdsEngine`, `EngineVersion`, `EngineCatalogEntry`, `VERSION_CATALOG` (postgres default `18`/`postgres18`; MySQL NO soportado) y `SUPPORTED_ENGINES`
    - Implementar helpers puros: `isSupportedEngine`, `versionsForEngine`, `defaultVersionForEngine`, `familyForVersion`, `isValidEngineVersion`
    - Implementar `reconcileVersionOnEngineChange(engine, prevVersion)`: conserva la versión si pertenece al catálogo del nuevo motor; si no, devuelve `defaultVersionForEngine` (o estado "sin selección")
    - _Requirements: 1.1, 1.3, 2.1, 2.2, 2.3, 2.4_

  - [x] 1.2 Property test del catálogo (coherencia motor↔familia)
    - **Property 1: Coherencia entre catálogo, motor y familia**
    - Archivo `src/lib/__tests__/rds-version-catalog.property.test.ts`; `familyForVersion(e,v)` empieza por el nombre del motor y `versionsForEngine(e)` solo contiene pares de `e`
    - **Validates: Requirements 1.3, 2.1, 2.4, 7.3**

- [x] 2. Render determinista (puro)
  - [x] 2.1 Implementar `src/lib/rds/render-rds.ts`
    - Implementar `renderRds(fields, family, moduleVersion, targetEnvironments, existingVariables)`: compone el `.tf` con `engine_version`/`family`/`major_engine_version`/`allow_major_version_upgrade`/`apply_immediately` como referencias `var.<db>_...` (prefijo `<db> = tfId(identifier)`), incluye el Bloque_Rotacion exacto, `count = contains([...envs], var.environment) ? 1 : 0` cuando no están los tres entornos, versión de módulo exacta, y sin `password` literal
    - Devolver `RenderedRds` (tf, `variableDeclarations` solo de las variables no existentes, `vars` con valores por entorno) y las 5 `ParameterizedVar`
    - Implementar `upsertTfvarsEntries(currentContent, entries)`: merge no destructivo de `key = value` (bool sin comillas, string entre comillas), preservando el resto del fichero
    - _Requirements: 3.1, 3.2, 3.3, 4.1, 5.1, 5.4, 6.1, 6.3, 6.4_

  - [x] 2.2 Property test de parametrización sin literales
    - **Property 6: Parametrización sin literales con prefijo `<db>_`**
    - Archivo `src/lib/__tests__/rds-render-rds.property.test.ts`
    - **Validates: Requirements 3.1**

  - [x] 2.3 Property test de declaraciones de variables
    - **Property 7: Declaraciones de variables = referenciadas menos existentes**
    - En `rds-render-rds.property.test.ts`; usar `existingVarsArb`
    - **Validates: Requirements 3.2**

  - [x] 2.4 Property test de cobertura de tfvars
    - **Property 8: Cobertura completa y bien tipada de los tres tfvars**
    - En `rds-render-rds.property.test.ts`; bool sin comillas, string con comillas, `prod`→`pro.tfvars`, independiente de entornos
    - **Validates: Requirements 3.3, 6.1, 6.2, 6.4**

  - [x] 2.5 Property test de versión de módulo exacta
    - **Property 10: Version_Modulo exacta sin operadores**
    - En `rds-render-rds.property.test.ts`; `version` ajustada a `MAJOR.MINOR.PATCH`, sin `~> >= <= > < =`
    - **Validates: Requirements 4.1**

  - [x] 2.6 Property test de rotación y ausencia de contraseña
    - **Property 13: Rotación obligatoria y ausencia de contraseña en claro**
    - En `rds-render-rds.property.test.ts`; los 4 atributos del Bloque_Rotacion exactos + cero `password` literal
    - **Validates: Requirements 5.1, 5.4**

  - [x] 2.7 Property test de scoping multi-entorno
    - **Property 15: Scoping multi-entorno mediante count**
    - En `rds-render-rds.property.test.ts`; `count` con lista exacta de entornos seleccionados si no son los tres; sin `count` si son los tres; variables presentes en los 3 tfvars en ambos casos
    - **Validates: Requirements 6.3**

- [x] 3. Introspección del repo (read-only vía gitlabClient)
  - [x] 3.1 Implementar `src/lib/rds/repo-introspection.ts`
    - Implementar `extractModuleVersions(tfContents)`: extrae `version` de bloques `module` con `source = terraform-aws-modules/rds/aws`
    - Implementar `selectModuleVersion(versions)`: más frecuente; empate → mayor semver; `[]` → `null`
    - Implementar `readRdsConvention(gitlab, projectId, branch)`: lee `iac/databases/` y devuelve `RepoRdsConvention` (`moduleVersion`, `existingVariables`, `countPatternFound`, `databasesDirReadable`); nunca lanza por fichero ausente, señala con flags
    - _Requirements: 3.4, 3.5, 4.2, 4.3, 4.4, 4.5, 6.3_

  - [x] 3.2 Property test de extracción de versiones del módulo
    - **Property 11: Extracción de versiones del módulo RDS**
    - Archivo `src/lib/__tests__/rds-repo-introspection.property.test.ts`; ignora bloques con otros `source`
    - **Validates: Requirements 4.2**

  - [x] 3.3 Property test de selección de Version_Modulo
    - **Property 12: Selección de Version_Modulo (moda; empate→mayor semver)**
    - En `rds-repo-introspection.property.test.ts`; usar `moduleVersionsArb`
    - **Validates: Requirements 4.3**

- [x] 4. Checkpoint - Módulos puros (catálogo, render, introspección)
  - Ensure all tests pass, ask the user if questions arise.

- [x] 5. Extender tipos compartidos
  - [x] 5.1 Extender `RdsFields` en `src/lib/infra-prompt-builder.ts`
    - Añadir `engine?: RdsEngine` (ausente ⇒ `postgres` por compatibilidad) y `family?: string` (derivada/recalculada por el generador)
    - Importar `RdsEngine` desde `version-catalog.ts`
    - _Requirements: 1.6, 7.1_

  - [x] 5.2 Extender `TerraformPreview` en `src/lib/infra-agent.ts`
    - Añadir `AuxiliaryFileOp` (`create | append | upsert-entries`, `content?`, `entries?`), campo opcional `auxiliaryFiles?: AuxiliaryFileOp[]` y `metadata?: { engine?; engineVersion?; family? }`
    - _Requirements: 1.6, 7.2_

- [x] 6. RdsGenerator + guardas deterministas
  - [x] 6.1 Implementar `src/lib/rds/rds-generator.ts`
    - Implementar `RdsGenerator` con `gitlabClient` inyectado y `generate(input): Promise<RdsGenerateResult>`
    - Validar motor (`isSupportedEngine`) y versión (`isValidEngineVersion`); derivar `family` del catálogo
    - Orquestar `readRdsConvention` (fallback `portalDefaultModuleVersion` si no hay módulo o falla la lectura; abortar `missing_databases_dir` si `iac/databases/` no es legible) + `renderRds` + plan de tfvars (3 ficheros)
    - Implementar las guardas previas a emitir el preview: anti-literal (`literal_guard`), completitud de tfvars (`tfvars_incomplete`, identifica variable + fichero), coherencia preview↔form (`coherence_mismatch`, identifica campo)
    - Construir `TerraformPreview` extendido: `.tf` primario + `auxiliaryFiles` (variables.tf append + 3 tfvars upsert) + `metadata.engine/engineVersion/family`
    - _Requirements: 1.5, 1.6, 2.5, 3.1, 3.2, 3.4, 3.5, 3.6, 4.4, 4.5, 6.6, 7.2, 7.5_

  - [x] 6.2 Property test de rechazo de motor inválido
    - **Property 3: Rechazo de motor inválido**
    - Archivo `src/lib/__tests__/rds-generator.property.test.ts`; usar `invalidEngineArb`; mensaje contiene el motor y enumera admitidos
    - **Validates: Requirements 1.5**

  - [x] 6.3 Property test de rechazo de versión inválida
    - **Property 4: Rechazo de versión inválida**
    - En `rds-generator.property.test.ts`; mensaje identifica versión + motor
    - **Validates: Requirements 2.5**

  - [x] 6.4 Property test de fidelidad de metadatos
    - **Property 5: Fidelidad de metadatos entre preview y formulario**
    - En `rds-generator.property.test.ts`; `metadata.engine/engineVersion` y `targetEnvironments` exactamente iguales a la entrada
    - **Validates: Requirements 1.6, 7.2**

  - [x] 6.5 Property test de la guarda anti-literal
    - **Property 9: Guarda anti-literal**
    - En `rds-generator.property.test.ts`; bloquea literales en los 5 atributos, pasa con referencias `var.<db>_...`; `{ numRuns: 200 }`
    - **Validates: Requirements 3.6**

  - [x] 6.6 Property test de la guarda de completitud de tfvars
    - **Property 16: Guarda de completitud de tfvars**
    - En `rds-generator.property.test.ts`; aborta si falta cobertura 5×3 identificando variable + fichero; pasa con cobertura completa; `{ numRuns: 200 }`
    - **Validates: Requirements 6.6**

  - [x] 6.7 Property test de la guarda de coherencia
    - **Property 17: Guarda de coherencia preview↔formulario**
    - En `rds-generator.property.test.ts`; rechaza si motor/versión/familia difieren identificando el campo; pasa si coinciden
    - **Validates: Requirements 7.5**

- [x] 7. Checkpoint - Generador y guardas
  - Ensure all tests pass, ask the user if questions arise.

- [x] 8. Reforzar el Validador_RDS
  - [x] 8.1 Reforzar `validateRdsPasswordRotation` en `src/lib/terraform-validator.ts`
    - Verificar presencia y valor exacto de los 4 atributos del Bloque_Rotacion, incluido `master_user_password_rotate_immediately = false`
    - Devolver inválido listando cada atributo ausente o con valor incorrecto
    - _Requirements: 5.2, 5.3_

  - [x] 8.2 Property test del validador de rotación
    - **Property 14: Validador de rotación exacto**
    - Añadir a `src/lib/__tests__/terraform-validator.property.test.ts`; partir de `.tf` válido y mutar/omitir cada atributo verificando rechazo
    - **Validates: Requirements 5.2**

- [x] 9. Cableado de servidor (generate / execute)
  - [x] 9.1 Modificar `src/app/api/infra-request-v2/generate/route.ts`
    - Validar `engine`/`engineVersion` contra el catálogo (400/422 `invalid_engine`/`invalid_version`, repo intacto)
    - Delegar la creación de RDS (`resourceType === 'rds'`) en `RdsGenerator.generate`, propagando errores de guarda; mantener S3/IAM por el flujo existente
    - _Requirements: 1.5, 2.5, 3.4, 7.1, 7.2_

  - [x] 9.2 Tests de integración del endpoint generate (gitlabClient mockeado)
    - Archivo `src/lib/__tests__/rds-generate-route.test.ts`: `generate` lee `iac/databases/` antes de renderizar (3.4); motor/versión inválidos devuelven error sin tocar el repo; el preview incluye `auxiliaryFiles` (variables.tf + 3 tfvars) y `metadata.engine`
    - _Requirements: 1.5, 2.5, 3.4_

  - [x] 9.3 Modificar `src/app/api/infra-assistant/execute/[id]/route.ts`
    - Iterar `auxiliaryFiles` aplicando `create`/`append`/`upsert-entries` (variables.tf + `vars/{dev,uat,pro}.tfvars`) con bloqueo optimista, además del `.tf` primario
    - Invocar `validateRdsPasswordRotation` reforzada → 422 sin rama/commit/MR si falla
    - _Requirements: 3.2, 3.3, 5.2, 5.3, 6.1_

  - [x] 9.4 Tests de integración del endpoint execute (gitlabClient mockeado)
    - Archivo `src/lib/__tests__/rds-execute-route.test.ts`: 422 sin crear rama/MR cuando falta la rotación (5.3); las operaciones `auxiliaryFiles` se aplican a los 3 tfvars + variables.tf
    - _Requirements: 5.3, 3.2, 3.3_

- [x] 10. Checkpoint - Cableado de servidor
  - Ensure all tests pass, ask the user if questions arise.

- [x] 11. Formulario_RDS
  - [x] 11.1 Modificar `src/components/infra-request-v2/rds-fields.tsx`
    - Añadir selector de Motor (solo `postgres`, default `postgres`; sin MySQL) y selector de Versión dirigido por `versionsForEngine` con preselección de `defaultVersionForEngine`
    - Reset de versión al cambiar de motor usando `reconcileVersionOnEngineChange`; mostrar motor+versión de forma continua
    - Etiqueta del tipo de recurso con "PostgreSQL" (MySQL no permitido); bloquear envío si entornos vacíos o catálogo vacío con mensaje
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.6, 2.7, 6.5, 7.4_

  - [x] 11.2 Cablear `src/components/infra-request-v2/infra-request-form-v2.tsx`
    - Transmitir `engine`, `engineVersion` y `targetEnvironments` al endpoint sin omitir ninguno
    - _Requirements: 7.1_

  - [x] 11.3 Property test de reset de versión al cambiar de motor
    - **Property 2: Reset de versión al cambiar de motor**
    - Archivo `src/lib/__tests__/rds-form-reconcile.property.test.ts` sobre `reconcileVersionOnEngineChange`
    - **Validates: Requirements 1.4**

  - [x] 11.4 Tests unitarios del Formulario_RDS
    - Archivo `src/lib/__tests__/rds-fields.test.ts`: defaults del catálogo (2.2, 2.3), etiqueta "PostgreSQL" sin MySQL (7.4), bloqueo de envío con entornos vacíos (6.5) / catálogo vacío (2.6), transmisión de campos (7.1)
    - _Requirements: 2.2, 2.3, 2.6, 6.5, 7.1, 7.4_

- [x] 12. Checkpoint final - Ejecutar la suite completa
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Las tareas marcadas con `*` son opcionales (tests) y pueden saltarse para un MVP más rápido; las tareas de implementación nunca son opcionales.
- Cada tarea referencia cláusulas concretas de requisitos para trazabilidad.
- Cada una de las 17 propiedades de corrección se implementa con un único property test (≥100 iteraciones; 200 para las guardas críticas 9 y 16), con el tag `Feature: portal-rds-creation-improvement, Property N: ...`.
- Los módulos puros (`version-catalog`, `render-rds`, `repo-introspection`) se construyen primero con sus property tests; el `RdsGenerator` recibe `gitlabClient` por inyección para testear sin red.
- Los checkpoints aseguran validación incremental antes de avanzar.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "3.1", "5.1", "5.2", "8.1"] },
    { "id": 1, "tasks": ["2.1", "1.2", "3.2", "8.2", "11.3"] },
    { "id": 2, "tasks": ["6.1", "2.2", "3.3"] },
    { "id": 3, "tasks": ["2.3", "6.2", "11.1"] },
    { "id": 4, "tasks": ["2.4", "6.3", "9.1"] },
    { "id": 5, "tasks": ["2.5", "6.4", "9.3", "11.2"] },
    { "id": 6, "tasks": ["2.6", "6.5", "9.2"] },
    { "id": 7, "tasks": ["2.7", "6.6", "9.4", "11.4"] },
    { "id": 8, "tasks": ["6.7"] }
  ]
}
```
