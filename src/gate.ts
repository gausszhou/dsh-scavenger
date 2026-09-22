/**
 * gate — pre-install compatibility preflight for a candidate plugin.
 *
 * Runs BEFORE `dsh plugin add` / market install: reads the candidate's
 * package manifest and (when it declares a bundle patch or an inspectable
 * module) validates the contract against the HOST profile's visible
 * dependency versions. Never writes, never installs.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findInstalledPackage, findDshInstallDir, resolveFileSpecifier } from './checker/resolve.ts'
import { satisfiesRange } from './checker/peers.ts'
import { inspectModule } from './inspector/index.ts'
import type { Finding } from './types.ts'

export interface GateOptions {
  /** Host profile directory whose visible versions act as the environment. */
  hostProfileDir?: string
  dshInstallDir?: string
  /** Evaluate the candidate's plugin module (default true). */
  inspect?: boolean
}

export interface GateReport {
  tool: 'dsh-scavenger'
  candidate: string
  hostProfileDir: string | null
  ok: boolean
  summary: { errors: number; warnings: number; infos: number }
  findings: Finding[]
}

function pushFindings(findings: Finding[], code: string, severity: Finding['severity'], message: string, plugin?: string): void {
  findings.push({ code, severity, message, plugin })
}

/**
 * Gate a candidate plugin. `candidate` is a local directory (extracted
 * package or checkout) or a package name resolved from the host profile.
 */
export async function gateCandidate(candidate: string, options: GateOptions = {}): Promise<GateReport> {
  const findings: Finding[] = []
  const hostDir = options.hostProfileDir
  const dshInstall = options.dshInstallDir ?? findDshInstallDir()
  const depSeverity = (error: string): { severity: Finding['severity']; suffix: string } => {
    const missing = missingPackageFromError(error)
    if (missing !== null && hostCanProvide(hostDir, dshInstall, missing)) {
      return { severity: 'info', suffix: ` (dependency ${missing} resolves inside the host profile tree after install — verify pnpm hoisting)` }
    }
    return { severity: 'warning', suffix: '' }
  }

  // --- locate the candidate ---
  let candidateDir: string | null = null
  let resolvedFrom = 'path'
  if (existsSync(candidate) && existsSync(join(candidate, 'package.json'))) {
    candidateDir = resolve(candidate)
  } else if (hostDir !== undefined) {
    const hit = findInstalledPackage(hostDir, candidate) ?? findInstalledPackage(dirname(hostDir), candidate)
    if (hit !== null) {
      candidateDir = hit
      resolvedFrom = `profile:${candidate}`
    }
  }
  if (candidateDir === null) {
    findings.push({ code: 'GATE_LOCATE_FAILED', severity: 'error', message: `candidate ${candidate} not found as a local package dir and not installed in the host profile` })
    return summarize(candidate, hostDir, findings)
  }

  const manifestPath = join(candidateDir, 'package.json')
  let manifest: {
    name?: unknown; version?: unknown; main?: unknown; exports?: unknown
    engines?: Record<string, string>
    dependencies?: Record<string, string>
    peerDependencies?: Record<string, string>
    peerDependenciesMeta?: Record<string, { optional?: unknown }>
    dsh?: { bundle?: { patch?: unknown } }
  }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch (error) {
    pushFindings(findings, 'GATE_MANIFEST_INVALID', 'error', `candidate package.json is unreadable: ${String(error)}`)
    return summarize(candidate, hostDir, findings)
  }
  const pkgName = typeof manifest.name === 'string' ? manifest.name : undefined
  const pkgVersion = typeof manifest.version === 'string' ? manifest.version : undefined
  if (pkgName === undefined || pkgVersion === undefined) {
    pushFindings(findings, 'GATE_MANIFEST_INVALID', 'error', 'candidate package.json must declare non-empty name and version')
    return summarize(candidate, hostDir, findings)
  }

  // --- engines vs host ---
  const dshVersion = dshInstall !== null ? readHostVersion(dshInstall) : null
  const nodeVersion = process.versions.node
  const engines = manifest.engines ?? {}
  if (engines.node !== undefined && satisfiesRange(nodeVersion, engines.node, { includePrerelease: true }) === false) {
    pushFindings(findings, 'GATE_ENGINES_NODE', 'warning', `${pkgName} engines.node ${engines.node} does not match running Node ${nodeVersion}`)
  }
  if (engines.dsh !== undefined) {
    if (dshVersion === null) {
      pushFindings(findings, 'GATE_ENGINES_DSH', 'info', `${pkgName} declares engines.dsh ${engines.dsh} but the host dsh install could not be located`)
    } else if (satisfiesRange(dshVersion, engines.dsh, { includePrerelease: true }) === false) {
      pushFindings(findings, 'GATE_ENGINES_DSH', 'error', `${pkgName} engines.dsh ${engines.dsh} does not match running DSH ${dshVersion}`)
    }
  }

  // --- bundle patch ---
  const bundlePatch = manifest.dsh?.bundle?.patch
  if (typeof bundlePatch === 'string') {
    const patchPath = join(candidateDir, bundlePatch)
    if (!existsSync(patchPath)) {
      pushFindings(findings, 'GATE_BUNDLE_PATCH_MISSING', 'error', `${pkgName} declares dsh.bundle.patch ${bundlePatch} but the file is missing`)
    } else {
      const { parsePatchFile } = await import('./checker/compose.ts')
      const patches = parsePatchFile(patchPath)
      if (patches === null) {
        pushFindings(findings, 'GATE_BUNDLE_PATCH_UNPARSABLE', 'error', `${pkgName} bundle patch ${bundlePatch} is not a valid entry list`)
      } else if (options.inspect !== false) {
        await inspectBundleRows(pkgName, patches, candidateDir, findings, hostDir, depSeverity)
      }
    }
  } else {
    pushFindings(findings, 'GATE_NOT_A_BUNDLE', 'info', `${pkgName} declares no dsh.bundle.patch — it will be a plain dependency unless your profile patch inserts one of its rows`)
  }

  // --- peers vs host profile visible versions ---
  if (hostDir !== undefined) {
    for (const [name, spec] of Object.entries(manifest.peerDependencies ?? {})) {
      if (typeof spec !== 'string') continue
      const nested = readVersionAt(join(candidateDir, 'node_modules'), name)
      const hoisted = readVersionAt(hostDir, name)
      const host = dshInstall !== null ? readVersionAt(dshInstall, name) : null
      const resolved = nested ?? hoisted ?? host
      const optional = manifest.peerDependenciesMeta?.[name]?.optional === true
      // Hosts on prerelease lines (0.1.5-rc.2) must be admitted by peer sets.
      const satisfied = resolved !== null ? satisfiesRange(resolved, spec, { includePrerelease: true }) : null
      if (satisfied === false && optional !== true) {
        pushFindings(findings, 'GATE_PEER_MISMATCH', 'warning', `${pkgName} peer ${name}@${spec} does not match ${resolved} in the host profile`)
      } else if (resolved === null && !optional) {
        pushFindings(findings, 'GATE_PEER_ABSENT', 'info', `${pkgName} peer ${name}@${spec} is not present in the host profile${dshInstall !== null ? ' or the dsh install' : ''}`)
      }
    }
  }

  // --- inspect a single-entry plugin (non-bundle) ---
  if (typeof bundlePatch !== 'string' && options.inspect !== false) {
    const entry = manifest.main ?? (typeof manifest.exports === 'string' ? manifest.exports : undefined)
    if (typeof entry === 'string') {
      const resolvedPath = resolveFileSpecifier(entry, candidateDir)
      if (resolvedPath !== null) {
        const inspected = await inspectModule(pathToFileURL(resolvedPath).href, undefined, 5000)
        if (inspected.error !== undefined) {
          const { severity, suffix } = depSeverity(inspected.error)
          pushFindings(findings, 'GATE_MODULE_IMPORT_FAILED', severity, `${pkgName} entry ${entry} failed to load: ${trimError(inspected.error)}${suffix}`)
        } else if (!inspected.validPlugin) {
          pushFindings(findings, 'GATE_PLUGIN_SHAPE', 'error', `${pkgName} default export is not a Cordis plugin (shape: ${inspected.shape})`)
        } else {
          pushFindings(findings, 'GATE_PLUGIN_OK', 'info', `${pkgName} entry exports a loadable plugin${inspected.inject.length > 0 ? ` (inject: ${inspected.inject.join(', ')})` : ''}`)
        }
      } else {
        pushFindings(findings, 'GATE_ENTRY_MISSING', 'warning', `${pkgName} declares entry ${entry} but the file does not exist`)
      }
    }
  }

  return summarize(candidate, hostDir, findings)
}

async function inspectBundleRows(
  pkgName: string,
  patches: unknown[],
  candidateDir: string,
  findings: Finding[],
  hostDir: string | undefined,
  depSeverity: (error: string) => { severity: Finding['severity']; suffix: string },
): Promise<void> {
  const names = new Set<string>()
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      if (typeof record.name === 'string' && !record.name.startsWith('cordis:')) names.add(record.name)
      if (record.group === true && Array.isArray(record.config)) walk(record.config)
    }
  }
  for (const patch of patches) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) continue
    if (Array.isArray((patch as Record<string, unknown>).insert)) walk((patch as Record<string, unknown>).insert)
  }
  for (const name of names) {
    // Resolve the row's module against the candidate dir (relative rows) or
    // the candidate's own visible node_modules (bare packages).
    let modulePath: string | null = null
    if (name.startsWith('.') || isAbsolute(name) || name.startsWith('file:')) {
      modulePath = resolveFileSpecifier(name, candidateDir)
    } else {
      const root = name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')
      modulePath = findInstalledPackage(candidateDir, root)
    }
    if (modulePath === null) continue
    const inspected = await inspectModule(pathToFileURL(modulePath).href, undefined, 5000)
    if (inspected.error !== undefined) {
      const { severity, suffix } = depSeverity(inspected.error)
      pushFindings(findings, 'GATE_ROW_IMPORT_FAILED', severity, `${pkgName} row ${name} failed to load: ${trimError(inspected.error)}${suffix}`, name)
    } else if (!inspected.validPlugin) {
      pushFindings(findings, 'GATE_ROW_PLUGIN_SHAPE', 'warning', `${pkgName} row ${name} default export is not a Cordis plugin (shape: ${inspected.shape})`, name)
    }
  }
}

/** Version of a package visible at `base`, or the `base` dir itself when its
 * package.json matches (the dsh install dir is itself the package). */
function readVersionAt(base: string, name: string): string | null {
  try {
    const selfPath = join(base, 'package.json')
    if (existsSync(selfPath)) {
      const self = JSON.parse(readFileSync(selfPath, 'utf8')) as { name?: unknown; version?: unknown }
      if (self.name === name && typeof self.version === 'string') return self.version
    }
    const manifest = JSON.parse(readFileSync(join(base, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

function readHostVersion(dshInstall: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(dshInstall, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/** Pull the bare package name out of an ERR_MODULE_NOT_FOUND message. */
function missingPackageFromError(error: string): string | null {
  const m = /Cannot find package '([^']+)'/.exec(error)
  return m?.[1] ?? null
}

/** Whether the missing import dep is already resolvable from the host tree or the dsh install. */
function hostCanProvide(hostDir: string | undefined, dshInstall: string | null, name: string): boolean {
  if (hostDir !== undefined && readVersionAt(hostDir, name) !== null) return true
  if (dshInstall !== null && readVersionAt(dshInstall, name) !== null) return true
  return false
}

function trimError(error: string): string {
  return error.split('\n')[0] ?? error
}

function summarize(candidate: string, hostProfileDir: string | undefined, findings: Finding[]): GateReport {
  const sorted = findings.sort((a, b) => (a.severity === 'error' ? 0 : a.severity === 'warning' ? 1 : 2) - (b.severity === 'error' ? 0 : b.severity === 'warning' ? 1 : 2))
  const summary = {
    errors: sorted.filter((f) => f.severity === 'error').length,
    warnings: sorted.filter((f) => f.severity === 'warning').length,
    infos: sorted.filter((f) => f.severity === 'info').length,
  }
  return { tool: 'dsh-scavenger', candidate, hostProfileDir: hostProfileDir ?? null, ok: summary.errors === 0, summary, findings: sorted }
}

