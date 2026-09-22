/**
 * Contract-level inspection of plugin modules (M2).
 *
 * To learn a plugin's export shape, `inject` declaration and config schema we
 * must actually LOAD its module. To avoid executing plugin top-level code in
 * the guardian's own process (side effects, crashes, hangs), each module runs
 * in a throwaway `worker_threads` realm with a bounded timeout and is
 * terminated afterwards. `apply()` is never called — only module evaluation
 * and static declarations are read, which is exactly what the Loader does
 * before activation.
 */

import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

export interface ConfigValidation {
  ok: boolean
  issues: Array<{ message?: string; path?: unknown }>
  /** True when the config contains `!!js` expression nodes — validation skipped. */
  dynamic?: boolean
}

export interface InspectedPlugin {
  /** Module specifier that was loaded. */
  module: string
  /** Default export shape: function / object / other. */
  shape: 'function' | 'object' | 'other' | 'missing'
  /** Whether the module exports a loadable Cordis plugin. */
  validPlugin: boolean
  /** Declared plugin name (default export .name or named export `name`). */
  name?: string
  /** Declared injected services (default .inject or named export `inject`). */
  inject: string[]
  /** Whether a config schema (Standard Schema) is declared. */
  hasConfig: boolean
  /** Result of validating `config` against the declared schema. */
  validation: ConfigValidation | null
  /** When worker import/eval failed. */
  error?: string
}

const WORKER_BOOTSTRAP = `
const { parentPort, workerData } = require('node:worker_threads')
;(async () => {
  try {
    const mod = await import(workerData.moduleUrl)
    const def = mod.default
    const shape = def === undefined || def === null ? 'missing'
      : typeof def === 'function' ? (def.prototype && typeof def.prototype.apply === 'function' ? 'class' : 'function')
      : typeof def === 'object' ? 'object' : 'other'
    const hasApply = (typeof def?.apply === 'function') || (typeof mod.apply === 'function')
    const validPlugin = typeof def === 'function' || hasApply
    const nameOf = (value) => (typeof value === 'string' && value !== '' ? value : undefined)
    const name = nameOf(def?.name) ?? nameOf(mod.name)
    const injectRaw = (typeof def === 'function' ? def.inject : def?.inject) ?? mod.inject
    const inject = Array.isArray(injectRaw)
      ? injectRaw.filter((item) => typeof item === 'string')
      : typeof injectRaw === 'object' && injectRaw !== null
        ? Object.keys(injectRaw)
        : []
    const configTarget = (typeof def === 'function' ? def.Config : def?.Config) ?? mod.Config
    const hasConfig = configTarget !== undefined && configTarget !== null
    let validation = null
    if (hasConfig) {
      const dynamic = workerData.config !== undefined && hasJsExpr(workerData.config)
      const std = configTarget?.['~standard']
      if (dynamic) {
        validation = { ok: true, issues: [], dynamic: true }
      } else if (std && typeof std.validate === 'function') {
        const raw = std.validate(workerData.config)
        const result = raw && typeof raw.then === 'function' ? await raw : raw
        const issues = result?.issues ?? []
        validation = { ok: issues.length === 0, issues: issues.map((issue) => ({ message: String(issue?.message ?? ''), path: issue?.path })) }
      } else {
        validation = { ok: false, issues: [{ message: 'declared Config is not a Standard Schema (no ~standard.validate)' }] }
      }
    }
    parentPort.postMessage({ ok: true, facts: { shape, validPlugin, name, inject, hasConfig, validation } })
  } catch (err) {
    parentPort.postMessage({ ok: false, error: String((err && err.stack) || err) })
  }
})()
function hasJsExpr(value, seen = new Set()) {
  if (value === null || typeof value !== 'object') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (Object.prototype.hasOwnProperty.call(value, '__jsExpr')) return true
  return Object.values(value).some((item) => hasJsExpr(item, seen))
}
`

/**
 * Load one plugin module in an isolated worker realm and read its declared
 * contract. Resolves `null` when the worker itself failed to boot.
 */
export function inspectModule(
  moduleUrl: string,
  config?: unknown,
  timeoutMs = 5000,
): Promise<InspectedPlugin> {
  return new Promise((resolvePromise) => {
    let worker: Worker
    try {
      worker = new Worker(WORKER_BOOTSTRAP, {
        eval: true,
        workerData: { moduleUrl, config },
      })
    } catch (error) {
      resolvePromise({ module: moduleUrl, shape: 'other', validPlugin: false, inject: [], hasConfig: false, validation: null, error: String(error) })
      return
    }
    const timer = setTimeout(() => {
      void worker.terminate()
      resolvePromise({ module: moduleUrl, shape: 'other', validPlugin: false, inject: [], hasConfig: false, validation: null, error: `module evaluation timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    worker.once('message', (message: { ok?: boolean; facts?: InspectedPlugin; error?: string }) => {
      clearTimeout(timer)
      void worker.terminate()
      if (message?.ok === true && message.facts !== undefined) {
        resolvePromise({ ...message.facts, module: moduleUrl })
      } else {
        resolvePromise({ module: moduleUrl, shape: 'other', validPlugin: false, inject: [], hasConfig: false, validation: null, error: message?.error ?? 'unknown worker failure' })
      }
    })
    worker.once('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ module: moduleUrl, shape: 'other', validPlugin: false, inject: [], hasConfig: false, validation: null, error: String(error) })
    })
    worker.once('exit', (code) => {
      clearTimeout(timer)
    })
  })
}

/** Services this DSH line is known to provide (curated for 0.1.5-rc.2 base). */
export const KNOWN_SERVICES = new Set<string>([
  // cordis / loader core
  'loader', 'timer', 'hmr',
  // dsh boot glue
  'dshHomePath', 'cmdlineArgs',
  // base composition (rows in @deepseek-ai/dsh-base cordis.patch.yml)
  'llm', 'llmRetry', 'deepseekLlmApiExtensions', 'session', 'sessionLog',
  'settings', 'credentials', 'agents', 'dynamicCordisRunner', 'cordisInspect',
  'sessionQuery', 'sessionProjection', 'storage', 'attachment',
  'approval', 'permission', 'sandbox', 'fsSandbox',
  'agentLoop', 'systemPrompt', 'tools', 'toolRegistry',
  'jobs', 'subprocess', 'subagent', 'workflow',
  'tokenMeter', 'spill', 'web', 'webSearch', 'webFetch',
  'skills', 'commands', 'goal', 'planMode', 'brand',
  'webserver', 'webRuntime', 'connection',
])

/** Static inject-missing verdict: error only when provably nothing provides it. */
export function classifyInject(name: string, known: Set<string> = KNOWN_SERVICES): 'error' | 'unknown' | 'ok' {
  if (known.has(name)) return 'ok'
  // A bare string service with no known provider: PENDING risk is real but
  // could be provided dynamically by another plugin's apply().
  return 'unknown'
}