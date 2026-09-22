/**
 * Package / module resolution helpers and the bundle layer stack.
 *
 * Resolution mirrors how the DSH boot sees packages: Node's own node_modules
 * ancestry from the profile directory (which covers pnpm workspace-root
 * hoisting under `$DSH_HOME/profiles/node_modules` and the dsh-managed
 * module fallback), with the dsh installation given first refusal for in-box
 * bundles. All functions are pure filesystem reads — no processes, no network.
 */

import { createRequire, isBuiltin } from 'node:module'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { parsePatchFile } from './compose.ts'
import type { LayerInput } from './compose.ts'
import type { BundleInfo } from '../types.ts'

const nodeRequire = createRequire(import.meta.url)

/** Shipped in-box bundles: supplied by the dsh installation, not the profile. */
export const INBOX_BUNDLES = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-sdk-minimal',
  '@deepseek-ai/dsh-acp-app',
])

export function isBareLoaderSpecifier(name: string): boolean {
  return !name.startsWith('.')
    && !name.startsWith('#')
    && !isAbsolute(name)
    && !/^[a-z][a-z\d+.-]*:/i.test(name)
}

/** npm package root owning one bare Loader specifier (handles @scope/pkg). */
export function packageRoot(specifier: string): string | null {
  const parts = specifier.split('/')
  const segments = specifier.startsWith('@') ? parts.slice(0, 2) : parts.slice(0, 1)
  if (segments.length !== (specifier.startsWith('@') ? 2 : 1)) return null
  for (const segment of segments) {
    if (segment === undefined || segment === '' || segment === '.' || segment === '..'
      || segment.includes('%') || segment.includes('\\') || segment.includes(':')) return null
  }
  if (specifier.startsWith('@') && (segments[0]?.length ?? 0) <= 1) return null
  return segments.join('/')
}

/** Walk `node_modules` ancestors from `base` (inclusive) looking for `name`. */
export function findInstalledPackage(base: string, name: string): string | null {
  let dir = resolve(base)
  while (true) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/** Resolve a package directory against multiple anchors (dsh install first). */
export function resolvePackageDir(anchorPackageJson: string, name: string): string | null {
  try {
    const paths = createRequire(anchorPackageJson).resolve.paths(name) ?? []
    for (const searchPath of paths) {
      const candidate = join(searchPath, name)
      if (existsSync(join(candidate, 'package.json'))) return candidate
    }
  } catch {
    return null
  }
  return null
}

/**
 * Locate the dsh installation directory (best effort):
 *   1. `DSH_INSTALL` environment override
 *   2. the `dsh` executable on PATH (resolved through symlinks)
 *   3. this module's own ancestry (guardian installed inside a profile whose
 *      module-fallback exposes the dsh install)
 * Returns null when not located (in-box bundles then read as `unresolvedInbox`).
 */
export function findDshInstallDir(): string | null {
  const env = process.env.DSH_INSTALL
  if (env !== undefined && env !== '') return existsSync(env) ? env : null
  const candidates: string[] = []
  try {
    const { execFileSync } = requireNodeChildProcess()
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['dsh'], { encoding: 'utf8', timeout: 5000 })
    const line = out.split('\n')[0]?.trim()
    if (line !== undefined && line !== '') candidates.push(line)
  } catch { /* dsh not on PATH */ }
  try {
    // This module usually lives under <host>/node_modules/@gausszhou/dsh-plugin-guardian
    // or <profile>/node_modules/@gausszhou/dsh-plugin-guardian; the dsh install
    // is either a sibling under @deepseek-ai or an ancestor's node_modules.
    const myUrl = import.meta.url
    candidates.push(fileURLToDir(myUrl))
  } catch { /* ignore */ }
  for (const candidate of candidates) {
    try {
      const resolved = realpathSync(candidate)
      let dir = existsSync(resolved) && !existsSync(join(resolved, 'package.json')) ? dirname(resolved) : resolved
      // Walk up a few levels hunting for package.json named @deepseek-ai/dsh.
      for (let i = 0; i < 6; i++) {
        const manifest = join(dir, 'package.json')
        if (existsSync(manifest)) {
          try {
            const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
            if (pkg.name === '@deepseek-ai/dsh') return dir
          } catch { /* keep walking */ }
        }
        const parent = dirname(dir)
        if (parent === dir) break
        dir = parent
      }
    } catch { /* unreadable candidate */ }
  }
  return null
}

function fileURLToDir(url: string): string {
  return dirname(fileURLToPathInternal(url))
}

function fileURLToPathInternal(url: string): string {
  return process.platform === 'win32'
    ? url.replace(/^file:\/\/\//, '')
    : decodeURIComponent(url.replace(/^file:\/\//, ''))
}

function requireNodeChildProcess(): typeof import('node:child_process') {
  return nodeRequire('node:child_process')
}

/** Resolve the default Harness home (DSH_HOME or ~/.dsh). */
export function resolveDshHome(override?: string): string {
  const value = override ?? process.env.DSH_HOME
  if (value !== undefined && value !== '') return value
  return join(homedir(), '.dsh')
}

/** Resolve a profile directory under the home. */
export function resolveProfileDir(name: string, home = resolveDshHome()): string {
  return join(home, 'profiles', name)
}

export interface ProfileManifest {
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: unknown
      patchReload?: unknown
    }
  }
}

export function readProfileManifest(profileDir: string): ProfileManifest | null {
  try {
    return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as ProfileManifest
  } catch {
    return null
  }
}

/** Resolve one bundle layer the way the boot does: dsh install first, then profile ancestry. */
export function resolveBundleDir(
  name: string,
  profileDir: string,
  dshInstallDir: string | null,
): string | null {
  if (dshInstallDir !== null) {
    const fromInstall = resolvePackageDir(join(dshInstallDir, 'package.json'), name)
    if (fromInstall !== null) return fromInstall
  }
  return findInstalledPackage(profileDir, name) ?? findInstalledPackage(dirname(profileDir), name)
}

export interface ResolvedBundle extends BundleInfo {
  /** Absolute path of the layer's patch file. */
  patchPath: string | null
  /** Parsed patch list; empty when none/error. */
  patches: unknown[]
  /** When the patch file exists but cannot be parsed. */
  parseError?: string | null
}

/**
 * Build the bundle layer stack for a profile. Mirrors the boot's resolution:
 * in-box bundles come from the dsh installation; community bundles from the
 * profile-visible ancestry. A single code path keeps the check report and any
 * later trial-start validation from disagreeing about what a bundle is.
 */
export function buildBundleLayers(
  profileDir: string,
  bundleNames: string[],
  specs: Record<string, string>,
  dshInstallDir: string | null,
): { bundles: ResolvedBundle[]; layers: LayerInput[] } {
  const bundles: ResolvedBundle[] = bundleNames.map((name) => {
    const base: ResolvedBundle = {
      name,
      kind: INBOX_BUNDLES.has(name) ? 'official' : 'community',
      source: specs[name],
      directory: null,
      patchPath: null,
      error: null,
      entries: [],
      patches: [],
    }
    const directory = resolveBundleDir(name, profileDir, dshInstallDir)
    if (directory === null) {
      if (INBOX_BUNDLES.has(name)) {
        base.unresolvedInbox = true
        return base
      }
      base.error = 'bundle package is not installed — the profile will fail to boot'
      return base
    }
    base.directory = directory
    let manifest: { dsh?: { bundle?: { patch?: unknown } } }
    try {
      manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as typeof manifest
    } catch {
      base.error = 'bundle package.json is unreadable'
      return base
    }
    const declared = manifest.dsh?.bundle?.patch
    if (typeof declared !== 'string') {
      base.error = 'bundle declares no dsh.bundle.patch — the profile will fail to boot'
      return base
    }
    const patchPath = join(directory, declared)
    if (!existsSync(patchPath)) {
      base.error = `declared patch ${declared} is missing — the profile will fail to boot`
      return base
    }
    base.patchPath = patchPath
    return base
  })

  const layers: LayerInput[] = bundles.map((bundle) => {
    if (bundle.error !== null || bundle.patchPath === null) {
      return { label: bundle.name, kind: 'bundle', patches: [], parseError: bundle.error }
    }
    const patches = parsePatchFile(bundle.patchPath)
    if (patches === null) {
      bundle.error = 'patch file is not a valid entry list'
      bundle.parseError = bundle.error
      bundle.entries = []
      return { label: bundle.name, kind: 'bundle', patches: [], parseError: bundle.error, path: bundle.patchPath }
    }
    bundle.entries = collectInsertIds(patches)
    return { label: bundle.name, kind: 'bundle', patches, parseError: null, path: bundle.patchPath }
  })
  return { bundles, layers }
}

/** Every id in one patch list's insert lists, recursively (group configs included). */
function collectInsertIds(rows: unknown[]): string[] {
  const ids: string[] = []
  const walk = (value: unknown): void => {
    if (!Array.isArray(value)) return
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
      const record = entry as Record<string, unknown>
      if (typeof record.id !== 'string') continue
      ids.push(record.id)
      if (Array.isArray(record.config)) walk(record.config)
    }
  }
  for (const patch of rows) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) continue
    const record = patch as Record<string, unknown>
    if (!Array.isArray(record.insert)) continue
    walk(record.insert)
  }
  return ids
}

/** Resolve a loader row's module specifier against the profile tree. */
export interface RowResolution {
  kind: 'package' | 'file' | 'cordis' | 'builtin' | 'invalid'
  /** Resolved package directory (kind=package) or file path (kind=file). */
  resolved?: string
  /** npm package name (kind=package). */
  packageName?: string
  /** Reason when kind=invalid. */
  reason?: string
}

/**
 * Map a file-style specifier (relative / absolute / file:) to a concrete
 * filesystem path anchored at `baseDir`, or null when it cannot be resolved.
 */
export function resolveFileSpecifier(specifier: string, baseDir: string): string | null {
  let filePath: string
  try {
    if (specifier.startsWith('file:')) {
      filePath = fileURLToPathInternal(specifier)
    } else if (isAbsolute(specifier)) {
      filePath = specifier
    } else {
      filePath = resolve(baseDir, specifier)
    }
  } catch {
    return null
  }
  return existsSync(filePath) ? filePath : null
}

export function resolveRowName(name: string, profileDir: string): RowResolution {
  if (name.startsWith('cordis:')) return { kind: 'cordis' }
  if (isBuiltin(name)) return { kind: 'builtin' }
  const pkg = packageRoot(name)
  if (pkg !== null) {
    const dir = findInstalledPackage(profileDir, pkg) ?? findInstalledPackage(dirname(profileDir), pkg)
    if (dir !== null) return { kind: 'package', resolved: dir, packageName: pkg }
    return { kind: 'package', packageName: pkg }
  }
  if (isBareLoaderSpecifier(name)) {
    return { kind: 'invalid', reason: 'not a valid bare package name' }
  }
  // Relative / absolute / file: / subpath specifier → check file existence.
  const filePath = resolveFileSpecifier(name, profileDir)
  if (filePath !== null) return { kind: 'file', resolved: filePath }
  return { kind: 'file' }
}