/**
 * Unit tests for the Modify Route prompt-building logic.
 * Validates that new modification parameters (addPermissions, removePermissions, lifecycleRules)
 * produce correct prompt descriptions, and that existing parameters (storageGb, multiAz) continue to work.
 *
 * Feature: infra-robustness
 * **Validates: Requirements 8.1, 8.2, 8.3, 8.4, 8.5**
 */

import test from 'node:test'
import assert from 'node:assert/strict'

/**
 * Extracted prompt-building logic from the modify route for testability.
 * This mirrors the logic in route.ts.
 */
function buildModDescriptions(modifications: {
  targetEnvironments?: string[]
  instanceClass?: string
  storageGb?: number
  multiAz?: boolean
  addPermissions?: string[]
  removePermissions?: string[]
  lifecycleRules?: {
    expirationDays?: number
    transitions?: Array<{ days: number; storageClass: string }>
  }
}): string[] {
  const modDescriptions: string[] = []

  if (modifications.targetEnvironments) {
    const allEnvs = ['dev', 'uat', 'prod']
    const hasAll = allEnvs.every(e => modifications.targetEnvironments!.includes(e))
    if (hasAll) {
      modDescriptions.push('Eliminar el count condicional — el recurso debe desplegarse en TODOS los entornos (dev, uat, prod)')
    } else {
      const envList = modifications.targetEnvironments.map(e => `"${e}"`).join(', ')
      modDescriptions.push(`Cambiar los entornos a SOLO: ${modifications.targetEnvironments.join(', ')}. Usar count = contains([${envList}], var.environment) ? 1 : 0`)
    }
  }
  if (modifications.instanceClass) {
    modDescriptions.push(`Cambiar la clase de instancia a: ${modifications.instanceClass}`)
  }
  if (modifications.storageGb !== undefined) {
    modDescriptions.push(`Cambiar el almacenamiento a: ${modifications.storageGb} GB`)
  }
  if (modifications.multiAz !== undefined) {
    modDescriptions.push(`Cambiar Multi-AZ a: ${modifications.multiAz ? 'habilitado' : 'deshabilitado'}`)
  }
  if (modifications.addPermissions && modifications.addPermissions.length > 0) {
    const policies = modifications.addPermissions.map(p => `"${p}"`).join(', ')
    modDescriptions.push(`Añadir las siguientes políticas/permisos IAM al rol: ${policies}. Crear aws_iam_role_policy_attachment resources para cada política añadida.`)
  }
  if (modifications.removePermissions && modifications.removePermissions.length > 0) {
    const policies = modifications.removePermissions.map(p => `"${p}"`).join(', ')
    modDescriptions.push(`Eliminar las siguientes políticas/permisos IAM del rol: ${policies}. Eliminar los aws_iam_role_policy_attachment resources correspondientes.`)
  }
  if (modifications.lifecycleRules) {
    const { expirationDays, transitions } = modifications.lifecycleRules
    const parts: string[] = []
    if (expirationDays !== undefined) {
      parts.push(`expiración de objetos a los ${expirationDays} días`)
    }
    if (transitions && transitions.length > 0) {
      const transDesc = transitions.map(t => `transición a ${t.storageClass} después de ${t.days} días`).join(', ')
      parts.push(transDesc)
    }
    modDescriptions.push(`Añadir/actualizar reglas de ciclo de vida (lifecycle_rule) en el bucket S3: ${parts.join('; ')}. Usar un bloque lifecycle_rule con las configuraciones especificadas.`)
  }

  return modDescriptions
}

test('storageGb modification produces correct prompt', () => {
  const result = buildModDescriptions({ storageGb: 100 })
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('100 GB'))
  assert.ok(result[0].includes('almacenamiento'))
})

test('multiAz enabled modification produces correct prompt', () => {
  const result = buildModDescriptions({ multiAz: true })
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('habilitado'))
  assert.ok(result[0].includes('Multi-AZ'))
})

test('multiAz disabled modification produces correct prompt', () => {
  const result = buildModDescriptions({ multiAz: false })
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('deshabilitado'))
  assert.ok(result[0].includes('Multi-AZ'))
})

test('addPermissions produces prompt with policy ARNs', () => {
  const result = buildModDescriptions({
    addPermissions: ['arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess', 'arn:aws:iam::aws:policy/CloudWatchLogsFullAccess']
  })
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('AmazonS3ReadOnlyAccess'))
  assert.ok(result[0].includes('CloudWatchLogsFullAccess'))
  assert.ok(result[0].includes('Añadir'))
  assert.ok(result[0].includes('aws_iam_role_policy_attachment'))
})

test('removePermissions produces prompt with policy ARNs', () => {
  const result = buildModDescriptions({
    removePermissions: ['arn:aws:iam::aws:policy/AmazonS3FullAccess']
  })
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('AmazonS3FullAccess'))
  assert.ok(result[0].includes('Eliminar'))
  assert.ok(result[0].includes('aws_iam_role_policy_attachment'))
})

test('empty addPermissions array does not produce prompt', () => {
  const result = buildModDescriptions({ addPermissions: [] })
  assert.equal(result.length, 0)
})

test('empty removePermissions array does not produce prompt', () => {
  const result = buildModDescriptions({ removePermissions: [] })
  assert.equal(result.length, 0)
})

test('lifecycleRules with expirationDays produces correct prompt', () => {
  const result = buildModDescriptions({
    lifecycleRules: { expirationDays: 90 }
  })
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('90 días'))
  assert.ok(result[0].includes('expiración'))
  assert.ok(result[0].includes('lifecycle_rule'))
})

test('lifecycleRules with transitions produces correct prompt', () => {
  const result = buildModDescriptions({
    lifecycleRules: {
      transitions: [
        { days: 30, storageClass: 'STANDARD_IA' },
        { days: 90, storageClass: 'GLACIER' }
      ]
    }
  })
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('STANDARD_IA'))
  assert.ok(result[0].includes('30 días'))
  assert.ok(result[0].includes('GLACIER'))
  assert.ok(result[0].includes('90 días'))
  assert.ok(result[0].includes('lifecycle_rule'))
})

test('lifecycleRules with both expirationDays and transitions', () => {
  const result = buildModDescriptions({
    lifecycleRules: {
      expirationDays: 365,
      transitions: [{ days: 60, storageClass: 'GLACIER' }]
    }
  })
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('365 días'))
  assert.ok(result[0].includes('expiración'))
  assert.ok(result[0].includes('GLACIER'))
  assert.ok(result[0].includes('60 días'))
})

test('combined modifications produce multiple descriptions', () => {
  const result = buildModDescriptions({
    storageGb: 200,
    multiAz: true,
    addPermissions: ['arn:aws:iam::aws:policy/AmazonS3ReadOnlyAccess'],
    lifecycleRules: { expirationDays: 30 }
  })
  assert.equal(result.length, 4)
  assert.ok(result[0].includes('200 GB'))
  assert.ok(result[1].includes('Multi-AZ'))
  assert.ok(result[2].includes('Añadir'))
  assert.ok(result[3].includes('lifecycle_rule'))
})

test('storageGb with value 0 still produces prompt', () => {
  const result = buildModDescriptions({ storageGb: 0 })
  assert.equal(result.length, 1)
  assert.ok(result[0].includes('0 GB'))
})
