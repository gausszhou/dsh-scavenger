/**
 * analyzeProfile — offline static analysis of one DSH profile directory.
 *
 * Pure filesystem analysis: no processes, no network, no writes, and NO
 * plugin modules are imported (contract-level inspection lives in the
 * inspector, M2). The goal is to reproduce, before a boot, every
 * composition/resolution failure DSH's fail-loud startup would hit, plus the
 * conflicts that are only warns at boot.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { composeLayers, parsePatchFile } from './compose.ts'
import type { LayerInput } from './compose.ts'
import {
  INBOX_BUNDLES, buildBundleLayers, findDshInstallDir, findInstalledPackage,
  isBareLoaderSpecifier, packageRoot, readProfileManifest, resolveDshHome,
  resolveProfileDir, resolveRowName,
} from './resolve.ts'
import { compareSemver, satisfiesRange } from './peers.ts'
import type { BundleInfo, CheckReport, Finding, LoaderRow } from '../types.ts'

export interface CheckOptions {
  /** DSH host install dir; auto-detected when omitted. */
  dshInstallDir?: string
  /** Harness home; defaults to $DSH_HOME or ~/.dsh. */
  homeDir?: string
  /** Carry the final composed tree (rows + configs) on the report. */
  includeTree?: boolean
}

export const VERSION = '0.1.0'

/** DSH host core packages: `@deepseek-ai/{dsh,cordis}*` plus a curated seed. */
export function corePackageNames(dshInstallDir: string | null): Set<string> {
  const names = new Set<string>([
    ...INBOX_BUNDLES,
    '@deepseek-ai/dsh',
    '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-app-boot',
    '@deepseek-ai/dsh-home-paths',
    '@deepseek-ai/cordis',
    '@deepseek-ai/cordis-plugin-loader',
    '@deepseek-ai/cordis-plugin-include',
    '@deepseek-ai/cordis-plugin-hmr',
    '@deepseek-ai/cordis-plugin-timer',
    '@deepseek-ai/cordis-plugin-group',
  ])
  if (dshInstallDir !== null) {
    try {
      for (const entry of readdirSync(join(dshInstallDir, 'node_modules', '@deepseek-ai'), { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        if (/^(?:dsh|cordis)/.test(entry.name)) names.add(`@deepseek-ai/${entry.name}`)
      }
    } catch { /* install node_modules unreadable — curated seed stands */ }
  }
  return names
}

/** Version of `name` physically resolved at `base`/node_modules, or null. */
function readNodeModulesVersion(base: string, name: string): string | null {
  try {
    const manifest = JSON.parse(readFileSync(join(base, 'node_modules', name, 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' ? manifest.version : null
  } catch {
    return null
  }
}

/** Version visible to the profile tree: profile node_modules, then workspace root. */
function readProfileVisibleVersion(profileDir: string, name: string): string | null {
  const direct = readNodeModulesVersion(profileDir, name)
  if (direct !== null) return direct
  const workspaceRoot = dirname(profileDir)
  if (workspaceRoot === profileDir) return null
  return readNodeModulesVersion(workspaceRoot, name)
}

/** Top-level installed package names (incl. scoped), excluding pnpm internals. */
function installedPackageNames(profileDir: string): string[] {
  const names: string[] = []
  const isPkgDir = (entry: { isDirectory(): boolean; isSymbolicLink(): boolean }): boolean =>
    entry.isDirectory() || entry.isSymbolicLink()
  try {
    const root = readdirSync(join(profileDir, 'node_modules'), { withFileTypes: true })
      .filter((entry) => isPkgDir(entry) && entry.name !== '.bin' && entry.name !== '.pnpm' && entry.name !== '.dsh-plugin-backups')
      .map((entry) => entry.name)
    for (const name of root) {
      if (!name.startsWith('@')) {
        names.push(name)
        continue
      }
      try {
        for (const scoped of readdirSync(join(profileDir, 'node_modules', name), { withFileTypes: true })) {
          if (isPkgDir(scoped)) names.push(`${name}/${scoped.name}`)
        }
      } catch { /* empty scope dir */ }
    }
  } catch { /* profile node_modules unreadable */ }
  return names
}

/** Distinct core versions present in the pnpm lockfile. */
function lockfileCoreVersions(profileDir: string): Map<string, string[]> {
  const found = new Map<string, Set<string>>()
  let text: string
  try {
    text = readFileSync(join(profileDir, 'pnpm-lock.yaml'), 'utf8')
  } catch {
    return new Map()
  }
  for (const m of text.matchAll(/(@deepseek-ai\/(?:dsh|cordis)[^@\s'"():]*?)@([0-9][^\s:'"()]*)/g)) {
    const name = m[1]
    const version = m[2]
    if (name === undefined || version === undefined || !/^v?\d+\.\d+\.\d+/.test(version)) continue
    const versions = found.get(name) ?? new Set<string>()
    versions.add(version)
    found.set(name, versions)
  }
  const out = new Map<string, string[]>()
  for (const [name, versions] of found) out.set(name, [...versions].sort(compareSemver))
  return out
}

/** Read a patch layer from a file (missing file = no layer; parse error captured). */
function readUserLayer(path: string): LayerInput {
  const label = path
  if (!existsSync(path)) return { label, kind: 'user', patches: [], parseError: null, path }
  const patches = parsePatchFile(path)
  if (patches === null) {
    return { label, kind: 'user', patches: [], parseError: 'patch file is not a valid entry list', path }
  }
  return { label, kind: 'user', patches, parseError: null, path }
}

function severityRank(severity: 'error' | 'warning' | 'info'): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2
}

/**
 * Analyze one profile directory. Safe to call on every check; never writes.
 */
export function analyzeProfile(profileDir: string, options: CheckOptions = {}): CheckReport {
  const dshInstall = options.dshInstallDir ?? findDshInstallDir()
  const home = resolveDshHome(options.homeDir)
  const findings: Finding[] = []
  const push = (finding: Finding): void => { findings.push(finding) }
  const core = corePackageNames(dshInstall)

  const manifest = readProfileManifest(profileDir)
  if (manifest === null) {
    return {
      tool: 'dsh-scavenger', version: VERSION, profile: profileDir, profileDir,
      dshInstallDir: dshInstall, scannedAt: new Date().toISOString(), ok: false,
      summary: { errors: 1, warnings: 0, infos: 0 },
      findings: [{ code: 'PROFILE_MANIFEST_UNREADABLE', severity: 'error', message: 'profile package.json is missing or unreadable — the profile cannot boot' }],
      rows: [], bundles: [],
    }
  }
  const bundleNames = Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((name): name is string => typeof name === 'string')
    : []

  // --- 1. bundle stack ---
  const built = buildBundleLayers(profileDir, bundleNames, manifest.dependencies ?? {}, dshInstall)
  const bundles: BundleInfo[] = built.bundles
  const layers: LayerInput[] = [...built.layers]
  for (const bundle of bundles) {
    if (bundle.unresolvedInbox) continue
    if (bundle.error !== null) {
      push({ code: 'BUNDLE_LAYER_ERROR', severity: 'error', plugin: bundle.name, message: `bundle ${bundle.name}: ${bundle.error}` })
    }
  }

  // --- 2. user + home patch layers ---
  const userPatchPath = join(profileDir, 'cordis.patch.yml')
  if (existsSync(userPatchPath)) layers.push(readUserLayer(userPatchPath))
  const homePatchPath = join(home, 'cordis.patch.yml')
  if (existsSync(homePatchPath)) layers.push(readUserLayer(homePatchPath))
  for (const layer of layers) {
    if (layer.parseError === null) continue
    push({ code: 'PATCH_PARSE_ERROR', severity: 'error', layer: layer.label, message: `${layer.label}: ${layer.parseError}` })
  }

  // --- 3. composition ---
  const composed = composeLayers(layers)

  for (const dup of composed.duplicates) {
    push({
      code: 'DUPLICATE_ENTRY_ID', severity: 'error', entryId: dup.id,
      detail: { count: dup.count, layers: dup.layers },
      message: `duplicate loader entry id ${JSON.stringify(dup.id)} (${dup.count} rows: ${dup.layers.join(', ')})`,
    })
  }
  for (const orphan of composed.orphans) {
    push({
      code: 'ORPHAN_PATCH_ROW', severity: 'warning', layer: orphan.layer, entryId: orphan.id,
      message: `${orphan.layer}: ${orphan.id} — ${orphan.reason}`,
    })
  }
  for (const ov of composed.overrides) {
    push({
      code: 'LAYER_OVERRIDE', severity: 'info', layer: ov.layer, entryId: ov.id,
      detail: { overriddenLayers: ov.overriddenLayers },
      message: `${ov.layer} overrides ${ov.id} introduced by ${ov.overriddenLayers.join(', ')}`,
    })
  }
  for (const dn of composed.duplicateNames) {
    push({
      code: 'DUPLICATE_PLUGIN_NAME', severity: 'warning', plugin: dn.name,
      detail: { count: dn.count, layers: dn.layers },
      message: `loader name ${dn.name} mounts in multiple layers (${dn.layers.join(', ')}) — the later row shadows the earlier one at runtime`,
    })
  }

  // --- 4. row-level resolution checks (B layer) ---
  const userLayerLabels = new Set(layers.filter((l) => l.kind === 'user' || l.kind === 'home').map((l) => l.label))
  for (const row of composed.resolvableRows) {
    if (row.name === undefined || row.name === '') {
      const message = `${row.layer}: loader entry ${JSON.stringify(row.id)} has no module name`
      push({
        code: 'ROW_MISSING_NAME',
        severity: row.activation === 'required' ? 'error' : 'warning',
        layer: row.layer, entryId: row.id,
        message: row.activation === 'required' ? `${message} — the profile will fail to boot` : `${message} — boot will fail if its disabled expression enables the entry`,
      })
      continue
    }
    if (!isBareLoaderSpecifier(row.name)) {
      // Relative / absolute / file: / subpath rows — check file existence.
      if (!row.name.startsWith('cordis:')) {
        const resolution = resolveRowName(row.name, profileDir)
        if (resolution.kind === 'file' && resolution.resolved === undefined) {
          push({
            code: 'ROW_FILE_MISSING', severity: 'warning', layer: row.layer, entryId: row.id, plugin: row.name,
            message: `${row.layer}: loader entry ${row.id} module ${row.name} does not exist relative to the profile`,
          })
        }
      }
      continue
    }
    const pkg = packageRoot(row.name)
    if (pkg === null) {
      const message = `${row.layer}: loader specifier ${JSON.stringify(row.name)} is not a valid bare package name`
      push({
        code: 'ROW_INVALID_SPECIFIER', severity: row.activation === 'required' ? 'error' : 'warning',
        layer: row.layer, entryId: row.id, plugin: row.name,
        message: row.activation === 'required' ? `${message} — the profile will fail to boot` : `${message} — boot will fail if its disabled expression enables the entry`,
      })
      continue
    }
    const hit = findInstalledPackage(profileDir, pkg) ?? findInstalledPackage(dirname(profileDir), pkg)
    if (hit === null) {
      const message = `${row.layer}: loader package ${pkg} is not installed in the profile`
      push({
        code: 'ROW_PACKAGE_MISSING', severity: row.activation === 'required' ? 'error' : 'warning',
        layer: row.layer, entryId: row.id, plugin: row.name,
        message: row.activation === 'required' ? `${message} — the profile will fail to boot` : `${message} — boot will fail if its disabled expression enables the entry`,
      })
    } else if (userLayerLabels.has(row.layer)) {
      push({
        code: 'ROW_PACKAGE_RESOLVED', severity: 'info', layer: row.layer, entryId: row.id, plugin: row.name,
        message: `${row.layer}: loader package ${pkg} resolves at ${hit}`,
      })
    }
  }

  // --- 5. B3: core packages as ordinary dependencies (hoist shadowing) ---
  for (const plugin of installedPackageNames(profileDir)) {
    let pkg: { dependencies?: Record<string, string> }
    try {
      pkg = JSON.parse(readFileSync(join(profileDir, 'node_modules', plugin, 'package.json'), 'utf8')) as typeof pkg
    } catch {
      continue
    }
    for (const [depName] of Object.entries(pkg.dependencies ?? {})) {
      if (core.has(depName)) {
        push({
          code: 'CORE_AS_DEPENDENCY', severity: 'error', plugin,
          detail: { dependency: depName },
          message: `${plugin} installs core package ${depName} as an ordinary dependency — it can be hoisted to the profile root and shadow the host version`,
        })
      }
    }
  }

  // --- 6. B4: multi-version core packages from the lockfile ---
  for (const [name, versions] of lockfileCoreVersions(profileDir)) {
    if (versions.length < 2) continue
    const hoisted = readProfileVisibleVersion(profileDir, name)
    const line = `${name}: ${versions.join(' / ')}${hoisted !== null ? ` (hoisted ${hoisted})` : ''}`
    push({
      code: 'MULTI_VERSION_CORE', severity: core.has(name) ? 'error' : 'warning',
      plugin: name, detail: { versions, hoisted },
      message: core.has(name) ? `multiple versions of core package — ${line}` : `multiple versions of ${line}`,
    })
  }

  // --- 7. C4: peer dependency ranges vs resolved versions ---
  for (const plugin of installedPackageNames(profileDir)) {
    let pkg: { peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: unknown }> }
    try {
      pkg = JSON.parse(readFileSync(join(profileDir, 'node_modules', plugin, 'package.json'), 'utf8')) as typeof pkg
    } catch {
      continue
    }
    const map = pkg.peerDependencies
    if (map === null || typeof map !== 'object') continue
    for (const [name, spec] of Object.entries(map)) {
      if (typeof spec !== 'string') continue
      const nested = readNodeModulesVersion(join(profileDir, 'node_modules', plugin), name)
      const hoisted = readProfileVisibleVersion(profileDir, name)
      const host = dshInstall !== null ? readNodeModulesVersion(dshInstall, name) : null
      const resolved = nested ?? hoisted ?? host
      const satisfied = resolved !== null ? satisfiesRange(resolved, spec, { includePrerelease: true }) : null
      const optional = pkg.peerDependenciesMeta?.[name]?.optional === true
      if (satisfied === false && optional !== true) {
        push({
          code: 'PEER_RANGE_MISMATCH', severity: 'warning', plugin,
          detail: { peer: name, range: spec, resolved },
          message: `${plugin} peer range ${name}@${spec} does not match resolved ${String(resolved)}`,
        })
      }
    }
  }

  // --- summary ---
  const sorted = findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.code.localeCompare(b.code))
  const summary = {
    errors: sorted.filter((f) => f.severity === 'error').length,
    warnings: sorted.filter((f) => f.severity === 'warning').length,
    infos: sorted.filter((f) => f.severity === 'info').length,
  }
  const rows: LoaderRow[] = composed.rows.map((row) => ({ id: row.id, layer: row.layer, name: row.name }))
  return {
    tool: 'dsh-scavenger',
    version: VERSION,
    profile: profileDir,
    profileDir,
    dshInstallDir: dshInstall,
    scannedAt: new Date().toISOString(),
    ok: summary.errors === 0,
    summary,
    findings: sorted,
    rows,
    bundles,
    ...(options.includeTree === true ? { nodes: composed.nodes } : {}),
  }
}

/** Convenience wrapper for tests & CLI: check a profile by name under the home. */
export function checkProfile(name: string, options: CheckOptions = {}): CheckReport {
  const home = resolveDshHome(options.homeDir)
  const dir = resolveProfileDir(name, home)
  return analyzeProfile(dir, { ...options, homeDir: home })
}