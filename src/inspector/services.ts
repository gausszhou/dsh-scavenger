/**
 * Runtime-derived service catalog: which service names can this deployment
 * provide?
 *
 * The KnownProviders include every Cordis service a plugin might inject. Most
 * are registered inside plugin `apply()` bodies, which we never execute — so
 * we derive the candidate set cheaply by scanning the installed packages'
 * compiled output for the two canonical registration patterns:
 *   - `ctx.provide("name", ...)` / `ctx.provide('name', ...)`
 *   - `super(ctx, "name")` (the Service subclass constructor that registers
 *     the service named in its second argument)
 *
 * This is heuristic: dynamic names are missed (→ those rows stay
 * "unverified", never asserted broken), and false positives only widen the
 * catalog (a name we think exists but that is gated behind a runtime branch
 * — safe direction for a checker that must not cry wolf).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const PROVIDE_RE = /(?:provide|register)\(\s*["'`]([^"'`]+)["'`]/g
const SERVICE_CTOR_RE = /super\(\s*ctx\s*,\s*["'`]([^"'`]+)["'`]/g
const CONST_ASSIGN_RE = /const\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*["'`]([A-Za-z][A-Za-z0-9]*)["'`]/g
const PROVIDE_VAR_RE = /(?:provide|register)\(\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[,)]/g
const SERVICE_CTOR_VAR_RE = /super\(\s*ctx\s*,\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*[,)]/g

function collectFromFile(path: string, out: Set<string>): void {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return
  }
  // Direct string literals.
  for (const m of text.matchAll(PROVIDE_RE)) {
    const name = m[1]
    if (name !== undefined && /^[A-Za-z][A-Za-z0-9]*$/.test(name)) out.add(name)
  }
  for (const m of text.matchAll(SERVICE_CTOR_RE)) {
    const name = m[1]
    if (name !== undefined && /^[A-Za-z][A-Za-z0-9]*$/.test(name)) out.add(name)
  }
  // `const X = "svcName"` constants used by `provide(X)` / `super(ctx, X)`.
  const constNames = new Map<string, string>()
  for (const m of text.matchAll(CONST_ASSIGN_RE)) {
    const variable = m[1]
    const value = m[2]
    if (variable !== undefined && value !== undefined) constNames.set(variable, value)
  }
  if (constNames.size === 0) return
  const resolveProvided = (variable: string | undefined): void => {
    const value = variable !== undefined ? constNames.get(variable) : undefined
    if (value !== undefined) out.add(value)
  }
  for (const m of text.matchAll(PROVIDE_VAR_RE)) resolveProvided(m[1])
  for (const m of text.matchAll(SERVICE_CTOR_VAR_RE)) resolveProvided(m[1])
}

function collectFromDir(dir: string, out: Set<string>, depth = 0): void {
  if (depth > 3) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      collectFromDir(full, out, depth + 1)
    } else if (entry.isFile() && /\.(?:js|cjs|mjs)$/.test(entry.name)) {
      collectFromFile(full, out)
    }
  }
}

/**
 * Service names discovered from the dsh install and the profile's installed
 * packages. Both scans ignore node_modules subtrees (top-level only).
 */
export function discoverServiceNames(dshInstallDir: string | null, profileDir: string): string[] {
  const out = new Set<string>()
  if (dshInstallDir !== null) {
    const scope = join(dshInstallDir, 'node_modules', '@deepseek-ai')
    try {
      for (const entry of readdirSync(scope, { withFileTypes: true })) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
        const libDir = join(scope, entry.name, 'lib')
        if (statSync(libDir, { throwIfNoEntry: false })?.isDirectory()) {
          collectFromDir(libDir, out, 0)
        }
      }
    } catch { /* dsh install scope unreadable */ }
  }
  // Profile top-level packages (community bundles and their row packages).
  const profileModules = join(profileDir, 'node_modules')
  collectFromDir(profileModules, out, 0)
  return [...out].sort()
}