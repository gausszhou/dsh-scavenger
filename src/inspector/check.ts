/**
 * Contract-level findings for a whole profile (C1/C2/C3/C6).
 *
 * A companion to `analyzeProfile`: pure static checks never execute plugin
 * modules; this pass loads every resolvable row's module in an isolated
 * worker realm and validates the declared contract (export shape, inject
 * declarations, config schema).
 */

import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { classifyInject, inspectModule } from './index.ts'
import { KNOWN_SERVICES } from './index.ts'
import { discoverServiceNames } from './services.ts'
import { resolveFileSpecifier } from '../checker/resolve.ts'
import type { CheckReport, Finding, LoaderEntryNode } from '../types.ts'

export { classifyInject, KNOWN_SERVICES }

export interface ContractOptions {
  /** Concurrency cap for worker spawns. */
  concurrency?: number
  /** Per-module worker timeout ms. */
  timeoutMs?: number
  /** Skip config-value validation against row configs. */
  skipConfig?: boolean
}

interface RowContractTarget {
  id: string
  layer: string
  name: string
  moduleUrl: string
  config?: unknown
}

/** Resolve one row's module URL using the profile's own resolution anchor. */
function resolveRowModule(name: string, profileDir: string): string | null {
  if (name.startsWith('cordis:')) return null
  try {
    if (name.startsWith('.') || name.startsWith('/') || name.startsWith('file:')) {
      const path = resolveFileSpecifier(name, profileDir)
      return path === null ? null : pathToFileURL(path).href
    }
    const require = createRequire(join(profileDir, 'package.json'))
    const resolved = require.resolve(name)
    return pathToFileURL(resolved).href
  } catch {
    return null
  }
}

/** Index the composed tree: row id -> { layer, config, inject }. */
function indexTree(nodes: LoaderEntryNode[] | undefined): Map<string, { layer: string; config?: unknown; inject?: string[] }> {
  const meta = new Map<string, { layer: string; config?: unknown; inject?: string[] }>()
  const walk = (list: LoaderEntryNode[], inheritedLayer?: string): void => {
    for (const node of list) {
      const layer = node.layer ?? inheritedLayer ?? 'unknown'
      meta.set(node.id, { layer, config: node.config, inject: node.inject })
      if (node.group === true && Array.isArray(node.config)) {
        walk(node.config as unknown as LoaderEntryNode[], layer)
      }
    }
  }
  if (nodes !== undefined) walk(nodes)
  return meta
}

/**
 * Run contract checks for a profile. Requires `analyzeProfile` to have been
 * called with `includeTree: true` so row configs are available.
 */
export async function contractFindings(profileDir: string, report: CheckReport, options: ContractOptions = {}): Promise<Finding[]> {
  const findings: Finding[] = []
  const timeoutMs = options.timeoutMs ?? 8000
  const skipConfig = options.skipConfig ?? false
  const meta = indexTree(report.nodes)

  // Catalog of services this deployment can provide: builtin names + a
  // runtime-derived scan of installed packages. Rows injected with a service
  // outside this set are "unverified", never asserted broken.
  const provided = new Set<string>([...KNOWN_SERVICES, ...discoverServiceNames(report.dshInstallDir, profileDir)])
  const isOfficialLayer = (layer: string): boolean => layer.startsWith('@deepseek-ai/dsh-') || layer.includes('/dsh-base') || layer.includes('/dsh-web')

  const targets: RowContractTarget[] = []
  for (const row of report.rows) {
    if (row.name === undefined || row.name === '') continue
    const moduleUrl = resolveRowModule(row.name, profileDir)
    if (moduleUrl === null) continue
    targets.push({
      id: row.id,
      layer: row.layer,
      name: row.name,
      moduleUrl,
      config: skipConfig ? undefined : meta.get(row.id)?.config,
    })
  }

  // Bounded-concurrency worker pool.
  const limit = Math.max(1, options.concurrency ?? 4)
  const results: Array<Promise<void>> = []
  let cursor = 0
  const pump = (): boolean => {
    if (cursor >= targets.length) return false
    while (cursor < targets.length && results.length < limit) {
      const target = targets[cursor]
      if (target === undefined) break
      cursor += 1
      const work = workerTask(target).finally(() => {
        const index = results.indexOf(work)
        if (index >= 0) results.splice(index, 1)
        pump()
      })
      results.push(work)
    }
    return true
  }

  const workerTask = async (target: RowContractTarget): Promise<void> => {
    const inspected = await inspectModule(target.moduleUrl, target.config, timeoutMs)
    if (inspected.error !== undefined) {
      findings.push({
        code: 'CONTRACT_IMPORT_FAILED', severity: 'warning',
        layer: target.layer, entryId: target.id, plugin: target.name,
        message: `${target.layer}: entry ${target.id} module failed to load during inspection: ${firstLine(inspected.error)}`,
      })
      return
    }
    if (!inspected.validPlugin) {
      findings.push({
        code: 'CONTRACT_PLUGIN_SHAPE', severity: 'error',
        layer: target.layer, entryId: target.id, plugin: target.name,
        detail: { shape: inspected.shape },
        message: `${target.layer}: entry ${target.id} default export is not a loadable Cordis plugin (shape: ${inspected.shape}) — the profile will fail to boot`,
      })
      return
    }
    // Module-declared inject + row-level patch inject are both operative.
    const injectNames = new Set<string>([...inspected.inject, ...(meta.get(target.id)?.inject ?? [])])
    for (const service of injectNames) {
      if (classifyInject(service, provided) === 'unknown') {
        const message = `${target.layer}: entry ${target.id} injects service ${service} which no known provider in this deployment declares — if nothing provides it at runtime, the entry stays pending and the profile fails to boot`
        findings.push({
          code: 'CONTRACT_INJECT_UNVERIFIED',
          severity: isOfficialLayer(target.layer) ? 'info' : 'warning',
          layer: target.layer, entryId: target.id, plugin: target.name,
          detail: { service },
          message,
        })
      }
    }
    if (inspected.validation !== null && inspected.validation.dynamic === true) {
      findings.push({
        code: 'CONTRACT_CONFIG_DYNAMIC', severity: 'info',
        layer: target.layer, entryId: target.id, plugin: target.name,
        message: `${target.layer}: entry ${target.id} config contains !!js expressions (e.g. ctx.service lookups) that only the host boot can resolve — schema validation deferred to the runtime`,
      })
    } else if (inspected.validation !== null && !inspected.validation.ok) {
      const issues = inspected.validation.issues.map((issue) => `${String(issue.path ?? 'config')}: ${issue.message ?? 'invalid'}`).join('; ')
      findings.push({
        code: 'CONTRACT_CONFIG_INVALID', severity: 'error',
        layer: target.layer, entryId: target.id, plugin: target.name,
        detail: { issues: inspected.validation.issues },
        message: `${target.layer}: entry ${target.id} config fails its declared schema — ${issues}`,
      })
    }
  }

  while (pump()) {
    await Promise.all(results)
  }
  await Promise.all(results)
  return findings
}

function firstLine(value: string): string {
  return value.split('\n')[0] ?? value
}