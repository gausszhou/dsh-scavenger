/**
 * cleaner — the scavenger's teeth.
 *
 * Given a profile check report, decide WHICH rows cause boot errors and produce
 * a cleanup plan: disable those loader rows by appending
 * `- id: <row>\n  disabled: true` patches to the profile's own patch layer
 * (a profile-level patch overrides any earlier bundle layer, and rows the
 * profile itself inserted can be patched within the same layer — both match
 * DSH's applyEntryPatches semantics).
 *
 * Safety model (design doc E1/E3/E4):
 * - the default is plan-only (`planCleanup`); writing needs an explicit apply;
 * - every apply snapshots every file it touches under
 *   `<profileDir>/.dsh-scavenger/backups/<timestamp>/` and records a state
 *   manifest, so `rollbackCleanup` restores byte-for-byte;
 * - the augmented document is re-parsed with the boot's exact YAML dialect
 *   before writing, and our appended block is single-sourced from a
 *   serializer — never made worse;
 * - the scavenger never writes root `cordis.yml` (DSH rewrites it every boot).
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parsePatchText } from './checker/compose.ts'
import { isBareLoaderSpecifier, packageRoot } from './checker/resolve.ts'
import type { CheckReport, ResolvableRow } from './types.ts'

/** Error codes whose culprit row is safe to disable via a patch. */
export const CLEANABLE_CODES = new Set([
  'ROW_PACKAGE_MISSING',
  'ROW_FILE_MISSING',
  'ROW_INVALID_SPECIFIER',
  'CONTRACT_PLUGIN_SHAPE',
  'CONTRACT_IMPORT_FAILED',
  'CONTRACT_CONFIG_INVALID',
])

export interface CleanupStep {
  id: string
  layer: string
  name?: string
  codes: string[]
  reasons: string[]
}

export interface CleanupPlan {
  tool: 'dsh-scavenger'
  profile: string
  profileDir: string
  inspectedAt: string
  steps: CleanupStep[]
  needsCleanup: boolean
  /** The profile patch file that would receive the disable patches. */
  writeTarget: string
  /** True when the profile patch file does not exist yet (created on apply). */
  targetMissing: boolean
}

export interface ApplyResult {
  applied: boolean
  backupDir: string | null
  patchLines: string[]
  reason?: string
}

const STATE_DIR = '.dsh-scavenger'
const STATE_MANIFEST = 'state.json'

function stateRoot(profileDir: string): string {
  return join(profileDir, STATE_DIR, 'backups')
}

const patchFileFor = (report: CheckReport): string => join(report.profileDir, 'cordis.patch.yml')

/** 从待禁用步骤构造 CleanupPlan（排序 + 写目标元数据）。 */
function buildPlan(report: CheckReport, steps: CleanupStep[]): CleanupPlan {
  const target = patchFileFor(report)
  const sorted = [...steps].sort((a, b) => a.id.localeCompare(b.id))
  return {
    tool: 'dsh-scavenger',
    profile: report.profile,
    profileDir: report.profileDir,
    inspectedAt: new Date().toISOString(),
    steps: sorted,
    needsCleanup: sorted.length > 0,
    writeTarget: target,
    targetMissing: !existsSync(target),
  }
}

/**
 * Build the cleanup plan from a check report: every enabled row that carries
 * error-severity findings from a cleanable code becomes one disable step.
 */
export function planCleanup(report: CheckReport): CleanupPlan {
  const byId = new Map(report.rows.map((row) => [row.id, row]))
  const steps = new Map<string, CleanupStep>()

  for (const finding of report.findings) {
    if (finding.severity !== 'error') continue
    if (!CLEANABLE_CODES.has(finding.code)) continue
    if (finding.entryId === undefined || finding.entryId === '') continue
    const row = byId.get(finding.entryId)
    if (row === undefined) continue
    const existing = steps.get(finding.entryId)
    if (existing !== undefined) {
      existing.codes.push(finding.code)
      existing.reasons.push(finding.message)
    } else {
      steps.set(finding.entryId, {
        id: finding.entryId,
        layer: row.layer,
        name: row.name,
        codes: [finding.code],
        reasons: [finding.message],
      })
    }
  }

  return buildPlan(report, [...steps.values()])
}

/** 合成错误码：purge 计划为"清理所有三方插件"专用，不属于 CLEANABLE_CODES 的发现码。 */
export const PURGE_CODE = 'PURGE_THIRD_PARTY'

/**
 * 判定一行是否为"三方插件"行：裸包 specifier 且其包根不在 DSH core 集合。
 * 相对/绝对路径、`cordis:` 内建、`file:`/协议 specifier 与 group 行都不算。
 */
export function isThirdPartyRow(row: ResolvableRow, core: Set<string>): boolean {
  if (row.group === true) return false
  const name = row.name
  if (name === undefined || name === '') return false
  if (!isBareLoaderSpecifier(name)) return false
  const pkg = packageRoot(name)
  if (pkg === null) return false
  return !core.has(pkg)
}

/**
 * Build the purge plan: disable EVERY third-party plugin row the loader would
 * import (`resolvableRows`), regardless of whether the row is broken. Local
 * file rows, `cordis:` builtins, group rows and DSH core packages are kept.
 */
export function planPurgeCleanup(report: CheckReport, core: Set<string>): CleanupPlan {
  const steps: CleanupStep[] = []
  for (const row of report.resolvableRows) {
    if (!isThirdPartyRow(row, core)) continue
    steps.push({
      id: row.id,
      layer: row.layer,
      name: row.name,
      codes: [PURGE_CODE],
      reasons: [`third-party plugin ${String(row.name)} (layer ${row.layer}) — purge disables every third-party plugin`],
    })
  }
  return buildPlan(report, steps)
}

/** Serialize the disable patches (DSH dialect, ids JSON-escaped). */
export function disablePatchText(steps: CleanupStep[]): string {
  return steps.map((step) => `- id: ${JSON.stringify(step.id)}\n  disabled: true`).join('\n')
}

/**
 * Apply the plan: snapshot the target, re-parse the augmented document under
 * the boot dialect, write. Returns the backup dir for rollback.
 */
export function applyCleanup(profileDir: string, steps: CleanupStep[], target: string): ApplyResult {
  const appended = disablePatchText(steps)
  const patchLines = appended === '' ? [] : appended.split('\n')

  const original = existsSync(target) ? readFileSync(target, 'utf8') : ''
  const next = original.trimEnd() === '' ? (appended === '' ? '' : `${appended}\n`) : `${original.trimEnd()}\n${appended}\n`

  // Parse gate: the augmented document must parse under the boot dialect.
  const parsed = parsePatchText(next)
  if (parsed === null) {
    return { applied: false, backupDir: null, patchLines: [], reason: 'augmented patch failed to re-parse under the DSH dialect — nothing written' }
  }
  // Never-made-worse gate: every step id must correspond to a `disabled: true`
  // patch row in the final document (so we can prove the append took effect).
  const patchIds = new Set<string>()
  for (const block of parsed) {
    if (block === null || typeof block !== 'object' || Array.isArray(block)) continue
    const record = block as Record<string, unknown>
    if (record.insert === undefined && typeof record.id === 'string' && record.disabled === true) {
      patchIds.add(record.id)
    }
  }
  for (const step of steps) {
    if (!patchIds.has(step.id)) {
      return { applied: false, backupDir: null, patchLines: [], reason: `disable patch for ${step.id} missing after parse — nothing written` }
    }
  }

  // Snapshot before the first write.
  const backupDir = snapshot(profileDir, target, original, steps, patchLines)
  writeFileSync(target, next, 'utf8')
  return { applied: true, backupDir, patchLines }
}

function snapshot(profileDir: string, target: string, original: string, steps: CleanupStep[], patchLines: string[]): string {
  const base = stateRoot(profileDir)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backupDir = join(base, stamp)
  mkdirSync(backupDir, { recursive: true })
  const targetName = target.split(/[\\/]/).pop() ?? 'cordis.patch.yml'
  const backupFile = join(backupDir, targetName)
  if (existsSync(target)) copyFileSync(target, backupFile)
  const state = {
    tool: 'dsh-scavenger',
    createdAt: new Date().toISOString(),
    profileDir,
    target,
    backupFile,
    disabled: steps.map((s) => ({ id: s.id, name: s.name })),
    patchLines,
    originalLength: original.length,
  }
  writeFileSync(join(backupDir, STATE_MANIFEST), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  return backupDir
}

export interface BackupEntry {
  dir: string
  backupFile: string | null
  target: string | null
  createdAt: string
  disabled: Array<{ id: string; name?: string }>
}

/** List available backups (newest first). */
export function listBackups(profileDir: string): BackupEntry[] {
  const base = stateRoot(profileDir)
  if (!existsSync(base)) return []
  const out: BackupEntry[] = []
  for (const entry of readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).sort((a, b) => b.name.localeCompare(a.name))) {
    const dir = join(base, entry.name)
    const manifestPath = join(dir, STATE_MANIFEST)
    if (!existsSync(manifestPath)) {
      out.push({ dir, backupFile: null, target: null, createdAt: entry.name, disabled: [] })
      continue
    }
    try {
      const state = JSON.parse(readFileSync(manifestPath, 'utf8')) as { backupFile?: string; target?: string; createdAt?: string; disabled?: Array<{ id: string; name?: string }> }
      out.push({
        dir,
        backupFile: state.backupFile ?? null,
        target: state.target ?? null,
        createdAt: state.createdAt ?? entry.name,
        disabled: state.disabled ?? [],
      })
    } catch {
      out.push({ dir, backupFile: null, target: null, createdAt: entry.name, disabled: [] })
    }
  }
  return out
}

/**
 * Roll back one backup (default: the newest). Restores the target file
 * byte-for-byte and removes the backup dir on success.
 */
export function rollbackCleanup(profileDir: string, backupDir?: string): { ok: boolean; message: string } {
  const backups = listBackups(profileDir)
  if (backups.length === 0) return { ok: false, message: 'no backups found under .dsh-scavenger/backups' }
  const match = backupDir !== undefined
    ? backups.find((b) => b.dir === backupDir || b.dir.endsWith(`/${backupDir}`))
    : backups[0]
  if (match === undefined) return { ok: false, message: `backup ${backupDir} not found` }
  if (match.backupFile === null || !existsSync(match.backupFile)) return { ok: false, message: `backup ${match.dir} has no restorable file snapshot` }
  if (match.target === null) return { ok: false, message: `backup ${match.dir} does not record its target file` }
  copyFileSync(match.backupFile, match.target)
  rmSync(match.dir, { recursive: true, force: true })
  return { ok: true, message: `restored ${match.target} from ${match.backupFile}` }
}