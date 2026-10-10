#!/usr/bin/env node
/**
 * dsh-scavenger — scavenge a DeepSeek Harness profile.
 *
 *   dsh-scavenger check    --profile <name> [--json] [--home <dir>] [--no-inspect]
 *   dsh-scavenger plan     --profile <name> [--out <file>] [--json] [--home <dir>] [--no-inspect]
 *   dsh-scavenger apply    --profile <name> [--plan <file>] [--no-verify] [--json] [--home <dir>] [--no-inspect]
 *   dsh-scavenger purge    --profile <name> [--apply] [--json] [--home <dir>]
 *   dsh-scavenger gate     <candidate> [--profile <name>] [--json] [--no-inspect]
 *   dsh-scavenger rollback [backupId] --profile <name> [--json]
 *   dsh-scavenger backups  --profile <name> [--json]
 *   dsh-scavenger list     [--json] [--home <dir>]
 *
 * 命令面（四组）：
 * - 检查：`check` 只输出诊断报告；主命令（无子命令）等价 `plan` 的快捷方式，
 *   带 `--apply` 时等价 `apply`（写盘 + 自动备份，可 `rollback`）。
 * - 清理：`plan`（dry-run 计划，可 `--out` 导出）；`apply`（写盘；`--plan <file>`
 *   复用上次导出的计划，`--no-verify` 跳过写后复检）；`rollback`；`backups`。
 * - 批量：`purge` 禁用所有三方插件行（dry-run / `--apply`）。
 * - 安装前：`gate <candidate>`（--host-profile 为旧名，等价 --profile）。
 *
 * 退出码：0 = 干净（或已清理干净）；1 = 有阻断启动的插件/计划待执行/残余错误；
 * 2 = 用法或 IO 故障。`--json` 输出统一信封 {command, ok, summary, report, plan,
 * apply, result}，机器调用方只解析一个形状。
 *
 * NB: 主命令与子命令是独立的 Command 实例（commander 13 会把父级同名选项吞进
 * 子命令，独立实例保证 `--profile/--home/--json` 语义一致）。
 */
import { Command } from 'commander'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { analyzeProfile, corePackageNames, VERSION } from './checker/index.ts'
import { resolveDshHome, resolveProfileDir } from './checker/resolve.ts'
import { contractFindings } from './inspector/check.ts'
import { gateCandidate } from './gate.ts'
import { applyCleanup, listBackups, planCleanup, planPurgeCleanup, rollbackCleanup } from './cleaner.ts'
import type { ApplyResult, CleanupPlan } from './cleaner.ts'
import type { CheckReport, Finding } from './types.ts'

// ── JSON 信封 ─────────────────────────────────────────────────────────────
/**
 * 所有命令共用的机器可读信封。字段固定、可缺省：
 * {command, ok, summary, report, plan, apply, result}。
 */
function envelope(command: string, payload: {
  ok: boolean
  summary?: CheckReport['summary'] | GateReportSummary
  report?: unknown
  plan?: CleanupPlan | null
  apply?: ApplyResult | null
  result?: unknown
}): string {
  const { ok, summary, report, plan, apply, result } = payload
  return JSON.stringify({
    command,
    ok,
    ...(summary !== undefined ? { summary } : {}),
    ...(report !== undefined ? { report } : {}),
    ...(plan !== undefined ? { plan: plan ?? null } : {}),
    ...(apply !== undefined ? { apply: apply ?? null } : {}),
    ...(result !== undefined ? { result } : {}),
  }, null, 2)
}

interface GateReportSummary { errors: number; warnings: number; infos: number }

// ── 公共工具 ──────────────────────────────────────────────────────────────
function severitySymbol(severity: Finding['severity']): string {
  return severity === 'error' ? '✗' : severity === 'warning' ? '!' : '·'
}

function printFindings(findings: Finding[], prefix = '  '): void {
  const lines = findings.map((finding) => {
    const where = [finding.layer, finding.entryId !== undefined ? `entry ${finding.entryId}` : undefined, finding.plugin !== undefined ? `pkg ${finding.plugin}` : undefined]
      .filter((part): part is string => part !== undefined).join(' | ')
    return `${prefix}${severitySymbol(finding.severity)} [${finding.code}] ${finding.message}${where ? `  (${where})` : ''}`
  })
  process.stdout.write(lines.length > 0 ? lines.join('\n') + '\n' : '')
}

async function augmentWithContract(report: CheckReport, dir: string): Promise<void> {
  const contract = await contractFindings(dir, report, { concurrency: 4, timeoutMs: 8000 })
  report.findings.push(...contract)
  report.summary.errors = report.findings.filter((f) => f.severity === 'error').length
  report.summary.warnings = report.findings.filter((f) => f.severity === 'warning').length
  report.summary.infos = report.findings.filter((f) => f.severity === 'info').length
  report.ok = report.summary.errors === 0
}

async function loadReport(profile: string, home: string, dshInstall: string | undefined, inspect: boolean): Promise<{ report: CheckReport; dir: string }> {
  const dir = resolveProfileDir(profile, home)
  const report = analyzeProfile(dir, { homeDir: home, dshInstallDir: dshInstall, includeTree: inspect })
  if (inspect) await augmentWithContract(report, dir)
  return { report, dir }
}

function printHeader(kind: string, report: CheckReport, home: string, extra?: string): void {
  process.stdout.write(`\n=== dsh-scavenger ${kind}: ${report.profile} ===\n`)
  process.stdout.write(`profile dir : ${report.profileDir}\n`)
  process.stdout.write(`dsh install : ${report.dshInstallDir ?? '(not located)'}\n`)
  process.stdout.write(`home        : ${home}\n`)
  process.stdout.write(`scanned at  : ${report.scannedAt}\n`)
  if (extra !== undefined) process.stdout.write(`${extra}\n`)
  process.stdout.write(`summary: ${report.summary.errors} error / ${report.summary.warnings} warning / ${report.summary.infos} info\n\n`)
}

function printPlan(plan: CleanupPlan, dryRun: boolean): void {
  if (plan.steps.length === 0) {
    process.stdout.write('✓ No culprit rows found — nothing to clean.\n')
    return
  }
  process.stdout.write(`— cleanup plan (${plan.steps.length} culprit row${plan.steps.length === 1 ? '' : 's'}) —\n`)
  for (const step of plan.steps) {
    process.stdout.write(`  ✗ disable ${step.id}${step.name !== undefined ? ` (${step.name})` : ''}  [${step.codes.join(', ')}]\n`)
    for (const reason of step.reasons.slice(0, 2)) process.stdout.write(`      ↳ ${reason.split('\n')[0] ?? reason}\n`)
  }
  process.stdout.write(`  target: ${plan.writeTarget}${plan.targetMissing ? ' (will be created)' : ''}\n`)
  if (dryRun) {
    process.stdout.write(`\n→ ${plan.steps.length} culprit row(s) found. Run \`dsh-scavenger apply\` to disable them (auto-backup; \`dsh-scavenger rollback\` restores).\n`)
  }
}

function printApplyResult(plan: CleanupPlan, apply: ApplyResult, report: CheckReport | null): void {
  if (apply.applied !== true) {
    process.stdout.write(`\n→ apply refused: ${apply.reason ?? 'unknown'} — nothing written.\n`)
    return
  }
  process.stdout.write(`\n✓ Applied: disabled ${plan.steps.length} row(s) in ${plan.writeTarget}\n`)
  if (apply.backupDir !== null) process.stdout.write(`  backup: ${apply.backupDir}  (\`dsh-scavenger rollback\` restores)\n`)
  if (report === null) {
    process.stdout.write('  restart `dsh <profile>` to boot without these plugins.\n')
  } else if (report.summary.errors > 0) {
    process.stdout.write(`  re-check: remaining ${report.summary.errors} error(s) are not cleanable by disabling rows.\n`)
  } else {
    process.stdout.write('  re-check after cleaning: no residual errors. Restart `dsh <profile>` to boot without these plugins.\n')
  }
}

/** 校验 `--plan <file>` 读入的计划：字段齐备且写目标不出 profile 目录。 */
function readPlanFile(file: string, expectedProfileDir?: string): CleanupPlan {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`cannot read plan file ${file}: ${String(error)}`)
  }
  let plan: Partial<CleanupPlan>
  try {
    plan = JSON.parse(raw) as Partial<CleanupPlan>
  } catch (error) {
    throw new Error(`plan file ${file} is not valid JSON: ${String(error)}`)
  }
  const profileDir = typeof plan.profileDir === 'string' ? plan.profileDir : null
  const writeTarget = typeof plan.writeTarget === 'string' ? plan.writeTarget : null
  const steps = Array.isArray(plan.steps) ? plan.steps.filter((s): s is CleanupPlan['steps'][number] => s !== null && typeof s === 'object' && typeof s.id === 'string') : []
  if (profileDir === null || writeTarget === null) {
    throw new Error(`plan file ${file} is missing profileDir/writeTarget — regenerate it with \`dsh-scavenger plan --out <file>\``)
  }
  if (expectedProfileDir !== undefined && resolve(profileDir) !== resolve(expectedProfileDir)) {
    throw new Error(`plan file ${file} targets ${profileDir}, not the requested profile ${expectedProfileDir} — refuse to apply`)
  }
  // 写目标必须在 profile 目录内（防止被篡改的计划文件逃逸写盘）。
  if (!(resolve(writeTarget) === resolve(profileDir) || resolve(writeTarget).startsWith(resolve(profileDir) + sep))) {
    throw new Error(`plan file ${file} writeTarget ${writeTarget} escapes the profile directory — refuse to apply`)
  }
  return { ...plan, profileDir, writeTarget, steps } as CleanupPlan
}

/** 列出 home 下的 profile 名称。 */
function listProfiles(home: string): string[] {
  try {
    return readdirSync(join(home, 'profiles'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && existsSync(join(home, 'profiles', e.name, 'package.json')))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** 幂等写文件（plan --out）。 */
function writePlanFile(plan: CleanupPlan, file: string): void {
  try {
    writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, 'utf8')
  } catch (error) {
    throw new Error(`cannot write plan file ${file}: ${String(error)}`)
  }
}

// ── 主命令：plan 的快捷方式 ───────────────────────────────────────────────
function buildMain(program: Command): void {
  program
    .name('dsh-scavenger')
    .description('Plan (or with --apply, apply) the disable of the plugins that break a DeepSeek Harness profile. Equivalent to the `plan` / `apply` subcommands.')
    .version(VERSION)
    .option('--profile <name>', 'profile name under $DSH_HOME/profiles (default: web)', 'web')
    .option('--apply', 'write the cleanup plan: disable the culprit rows in the profile patch (default: dry-run plan only)')
    .option('--json', 'emit a machine-readable report (check report + plan + apply result)')
    .option('--home <dir>', 'override the Harness home (default: $DSH_HOME or ~/.dsh)')
    .option('--dsh-install <dir>', 'override the dsh installation directory')
    .option('--no-inspect', 'skip worker-isolated contract inspection (C layer)')
    .action(async (opts: { profile?: string; apply?: boolean; json?: boolean; home?: string; dshInstall?: string; inspect?: boolean }) => {
      const home = resolveDshHome(opts.home)
      const profile = opts.profile ?? 'web'
      const { report, dir } = await loadReport(profile, home, opts.dshInstall, opts.inspect !== false)
      const plan = planCleanup(report)

      let apply: ApplyResult | null = null
      if (opts.apply === true && plan.needsCleanup) {
        apply = applyCleanup(dir, plan.steps, plan.writeTarget)
        if (apply.applied === true) {
          // 写后复检：任何残余 error 都不是通过禁用一行能清除的。
          const recheck = await loadReport(profile, home, opts.dshInstall, opts.inspect !== false)
          report.summary = recheck.report.summary
          report.ok = recheck.report.ok
          report.findings = recheck.report.findings
          report.rows = recheck.report.rows
          plan.needsCleanup = planCleanup(recheck.report).needsCleanup
        }
      }

      if (opts.json === true) {
        process.stdout.write(envelope('scavenge', {
          ok: report.ok,
          summary: report.summary,
          report,
          plan,
          apply,
        }))
      } else {
        printHeader('scavenge', report, home)
        if (report.summary.errors > 0) printFindings(report.findings.filter((f) => f.severity === 'error'))
        if (apply === null) {
          printPlan(plan, true)
        } else {
          printPlan(plan, false)
          printApplyResult(plan, apply, report)
        }
      }
      if (apply?.applied === true) {
        process.exitCode = report.ok ? 0 : 1
      } else {
        process.exitCode = plan.needsCleanup ? 1 : 0
      }
    })
}

// ── purge 专属输出 ────────────────────────────────────────────────────────
function printPurge(report: CheckReport, plan: ReturnType<typeof planPurgeCleanup>, apply: ApplyResult | null, home: string, profile: string): void {
  process.stdout.write(`\n=== dsh-scavenger purge: ${profile} ===\n`)
  process.stdout.write(`profile dir : ${report.profileDir}\n`)
  process.stdout.write(`dsh install : ${report.dshInstallDir ?? '(not located)'}\n`)
  process.stdout.write(`home        : ${home}\n`)
  process.stdout.write(`scanned at  : ${report.scannedAt}\n\n`)
  process.stdout.write(`summary: ${report.summary.errors} error / ${report.summary.warnings} warning / ${report.summary.infos} info\n\n`)

  if (plan.steps.length === 0) {
    process.stdout.write('✓ No third-party plugin rows found — nothing to purge.\n')
    return
  }

  process.stdout.write(`— purge plan (${plan.steps.length} third-party plugin row${plan.steps.length === 1 ? '' : 's'}) —\n`)
  for (const step of plan.steps) {
    process.stdout.write(`  ✗ disable ${step.id}${step.name !== undefined ? ` (${step.name})` : ''}  [${step.codes.join(', ')}]\n`)
    for (const reason of step.reasons.slice(0, 2)) process.stdout.write(`      ↳ ${reason.split('\n')[0] ?? reason}\n`)
  }
  process.stdout.write(`  target: ${plan.writeTarget}${plan.targetMissing ? ' (will be created)' : ''}\n`)

  if (apply === null) {
    process.stdout.write(`\n→ ${plan.steps.length} third-party row(s) found. Re-run with --apply to disable them all (auto-backup; \`dsh-scavenger rollback\` restores).\n`)
  } else {
    printApplyResult(plan, apply, report)
  }
}

// ── 子命令 ────────────────────────────────────────────────────────────────
function buildSub(program: Command): void {
  program
    .name('dsh-scavenger')
    .description('Scavenge a DeepSeek Harness profile (subcommands: check | plan | apply | purge | gate | rollback | backups | list).')
    .version(VERSION)

  // check：只诊断，不改任何东西。
  program
    .command('check')
    .description('Offline static + contract preflight of one profile (read-only).')
    .option('--profile <name>', 'profile name under $DSH_HOME/profiles (default: web)', 'web')
    .option('--json', 'emit the report as JSON')
    .option('--home <dir>', 'override the Harness home (default: $DSH_HOME or ~/.dsh)')
    .option('--dsh-install <dir>', 'override the dsh installation directory')
    .option('--no-inspect', 'skip worker-isolated contract inspection (C layer)')
    .action(async (opts: { profile?: string; json?: boolean; home?: string; dshInstall?: string; inspect?: boolean }) => {
      const home = resolveDshHome(opts.home)
      const profile = opts.profile ?? 'web'
      const { report } = await loadReport(profile, home, opts.dshInstall, opts.inspect !== false)
      if (opts.json === true) {
        process.stdout.write(envelope('check', { ok: report.ok, summary: report.summary, report }))
      } else {
        printHeader('check', report, home)
        printFindings(report.findings)
        if (report.summary.errors > 0) {
          process.stdout.write(`\n→ ${report.summary.errors} blocking issue(s). Run \`dsh-scavenger plan\` to see the cleanup plan.\n`)
        } else {
          process.stdout.write('\n✓ No blocking issue found by static checks; booting should get past plugin composition/resolution.\n')
        }
      }
      process.exitCode = report.ok ? 0 : 1
    })

  // plan：检查 + 出计划；--out 导出计划文件供 apply --plan 复用。
  program
    .command('plan')
    .description('Check a profile and show the cleanup plan (dry-run; write nothing).')
    .option('--profile <name>', 'profile name under $DSH_HOME/profiles (default: web)', 'web')
    .option('--out <file>', 'write the plan as JSON to <file> for later `apply --plan <file>`')
    .option('--json', 'emit the report as JSON')
    .option('--home <dir>', 'override the Harness home (default: $DSH_HOME or ~/.dsh)')
    .option('--dsh-install <dir>', 'override the dsh installation directory')
    .option('--no-inspect', 'skip worker-isolated contract inspection (C layer)')
    .action(async (opts: { profile?: string; out?: string; json?: boolean; home?: string; dshInstall?: string; inspect?: boolean }) => {
      const home = resolveDshHome(opts.home)
      const profile = opts.profile ?? 'web'
      const { report } = await loadReport(profile, home, opts.dshInstall, opts.inspect !== false)
      const plan = planCleanup(report)
      if (opts.out !== undefined) writePlanFile(plan, opts.out)

      if (opts.json === true) {
        process.stdout.write(envelope('plan', { ok: report.ok, summary: report.summary, report, plan }))
      } else {
        printHeader('plan', report, home, opts.out !== undefined ? `plan out   : ${opts.out}` : undefined)
        if (report.summary.errors > 0) printFindings(report.findings.filter((f) => f.severity === 'error'))
        printPlan(plan, true)
        if (opts.out !== undefined) process.stdout.write(`  (plan written to ${opts.out})\n`)
      }
      process.exitCode = plan.needsCleanup ? 1 : 0
    })

  // apply：写盘（默认重新检查 → 计划 → 写盘 → 复检）；--plan 复用导出的计划。
  program
    .command('apply')
    .description('Apply a cleanup plan: disable culprit rows in the profile patch (auto-backup). By default re-checks first and re-verifies after writing.')
    .option('--profile <name>', 'profile name under $DSH_HOME/profiles (default: web)', 'web')
    .option('--plan <file>', 'use a plan JSON previously exported by `plan --out <file>` (skip re-analysis)')
    .option('--no-verify', 'skip the post-write re-check')
    .option('--json', 'emit a machine-readable report (check report + plan + apply result)')
    .option('--home <dir>', 'override the Harness home (default: $DSH_HOME or ~/.dsh)')
    .option('--dsh-install <dir>', 'override the dsh installation directory')
    .option('--no-inspect', 'skip worker-isolated contract inspection (C layer)')
    .action(async (opts: { profile?: string; plan?: string; verify?: boolean; json?: boolean; home?: string; dshInstall?: string; inspect?: boolean }) => {
      const home = resolveDshHome(opts.home)
      const profile = opts.profile ?? 'web'

      let plan: CleanupPlan
      let report: CheckReport | null = null
      let dir: string
      if (opts.plan !== undefined) {
        // 复用导出的计划：不做重新分析，直接校验并写盘。
        dir = resolveProfileDir(profile, home)
        plan = readPlanFile(opts.plan, dir)
      } else {
        const loaded = await loadReport(profile, home, opts.dshInstall, opts.inspect !== false)
        report = loaded.report
        dir = loaded.dir
        plan = planCleanup(report)
      }
      if (!plan.needsCleanup) {
        if (opts.json === true) {
          process.stdout.write(envelope('apply', {
            ok: report?.ok ?? true,
            summary: report?.summary,
            report,
            plan,
            apply: { applied: false, backupDir: null, patchLines: [], reason: 'nothing to clean' },
          }))
        } else {
          process.stdout.write(`\n=== dsh-scavenger apply: ${profile} ===\n`)
          printPlan(plan, false)
        }
        process.exitCode = 0
        return
      }

      const apply = applyCleanup(dir, plan.steps, plan.writeTarget)
      if (apply.applied === true && opts.verify !== false) {
        // 写后复检（默认）：任何残余 error 都不是通过禁用一行能清除的。
        const recheck = await loadReport(profile, home, opts.dshInstall, opts.inspect !== false)
        report = recheck.report
        plan.needsCleanup = planCleanup(recheck.report).needsCleanup
      }

      if (opts.json === true) {
        process.stdout.write(envelope('apply', {
          ok: report?.ok ?? apply.applied,
          summary: report?.summary,
          report,
          plan,
          apply,
        }))
      } else {
        if (report !== null) printHeader('apply', report, home)
        else process.stdout.write(`\n=== dsh-scavenger apply: ${profile} ===\n`)
        printApplyResult(plan, apply, report)
      }
      process.exitCode = apply.applied === true ? (report?.ok ?? true ? 0 : 1) : 2
    })

  // purge：批量禁用所有三方插件（dry-run / --apply），与主命令共用安全模型。
  program
    .command('purge')
    .description('Wholesale cleanup: plan (or with --apply write) the disable of EVERY third-party plugin row — broken or not.')
    .option('--profile <name>', 'profile name under $DSH_HOME/profiles (default: web)', 'web')
    .option('--apply', 'write the purge plan: disable all third-party rows in the profile patch (default: dry-run plan only)')
    .option('--json', 'emit a machine-readable report (check report + plan + apply result)')
    .option('--home <dir>', 'override the Harness home (default: $DSH_HOME or ~/.dsh)')
    .option('--dsh-install <dir>', 'override the dsh installation directory')
    .action(async (opts: { profile?: string; apply?: boolean; json?: boolean; home?: string; dshInstall?: string }) => {
      const home = resolveDshHome(opts.home)
      const profile = opts.profile ?? 'web'
      const { report, dir } = await loadReport(profile, home, opts.dshInstall, false)
      // 三方判定需要 core 包集合：dsh install 提供官方包清单。
      const core = corePackageNames(report.dshInstallDir)
      const plan = planPurgeCleanup(report, core)
      const apply = opts.apply === true && plan.needsCleanup ? applyCleanup(dir, plan.steps, plan.writeTarget) : null
      if (apply?.applied === true) {
        // Re-check after cleaning: any residual error is not cleanable by disabling a row.
        const recheck = await loadReport(profile, home, opts.dshInstall, false)
        report.summary = recheck.report.summary
        report.ok = recheck.report.ok
        report.findings = recheck.report.findings
        report.rows = recheck.report.rows
        report.resolvableRows = recheck.report.resolvableRows
        plan.needsCleanup = planPurgeCleanup(recheck.report, core).needsCleanup
      }

      if (opts.json === true) {
        process.stdout.write(envelope('purge', {
          ok: report.ok,
          summary: report.summary,
          report,
          plan,
          apply,
        }))
      } else {
        printPurge(report, plan, apply, home, profile)
      }
      if (apply?.applied === true) {
        process.exitCode = report.ok ? 0 : 1
      } else {
        process.exitCode = plan.needsCleanup ? 1 : 0
      }
    })

  // gate：安装前门禁；--host-profile 为旧名，等价 --profile。
  program
    .command('gate')
    .description('Pre-install compatibility preflight of a candidate plugin (local dir or installed package name).')
    .argument('<candidate>', 'path to the candidate package directory, or a package name resolved from the host profile')
    .option('--profile <name>', 'host profile name used as the environment (default: web)', 'web')
    .option('--host-profile <name>', 'alias of --profile (legacy name)')
    .option('--home <dir>', 'override the Harness home (default: $DSH_HOME or ~/.dsh)')
    .option('--json', 'emit the report as JSON')
    .option('--no-inspect', 'do not load the candidate module for contract checks')
    .action(async (candidate: string, opts: { profile?: string; hostProfile?: string; home?: string; json?: boolean; inspect?: boolean }) => {
      const home = resolveDshHome(opts.home)
      const hostProfile = opts.profile ?? opts.hostProfile ?? 'web'
      const hostProfileDir = resolveProfileDir(hostProfile, home)
      const report = await gateCandidate(candidate, { hostProfileDir, inspect: opts.inspect !== false })
      if (opts.json === true) {
        process.stdout.write(envelope('gate', { ok: report.ok, summary: report.summary, report }))
      } else {
        process.stdout.write(`\n=== dsh-scavenger gate: ${candidate} ===\n`)
        process.stdout.write(`host profile: ${report.hostProfileDir ?? '(none)'}\n`)
        process.stdout.write(`summary: ${report.summary.errors} error / ${report.summary.warnings} warning / ${report.summary.infos} info\n\n`)
        printFindings(report.findings)
        process.stdout.write(report.ok
          ? '\n✓ No blocking issue found; the candidate may be installed.\n'
          : '\n→ Blocking issue(s) found; fix or reject the candidate before installing.\n')
      }
      process.exitCode = report.ok ? 0 : 1
    })

  // rollback / backups：备份管理与回滚。
  program
    .command('rollback')
    .description('Restore the profile patch file from a scavenger backup (default: the newest).')
    .argument('[backupId]', 'backup directory name; omit for the newest backup')
    .option('--profile <name>', 'profile name under $DSH_HOME/profiles (default: web)', 'web')
    .option('--home <dir>', 'override the Harness home (default: $DSH_HOME or ~/.dsh)')
    .option('--json', 'emit a machine-readable result')
    .action((backupId: string | undefined, opts: { profile?: string; home?: string; json?: boolean }) => {
      const home = resolveDshHome(opts.home)
      const dir = resolveProfileDir(opts.profile ?? 'web', home)
      const result = rollbackCleanup(dir, backupId)
      if (opts.json === true) {
        process.stdout.write(envelope('rollback', { ok: result.ok, result }))
      } else {
        process.stdout.write(result.ok ? `✓ ${result.message}\n` : `✗ ${result.message}\n`)
      }
      process.exitCode = result.ok ? 0 : 1
    })

  program
    .command('backups')
    .description('List scavenger backups for a profile.')
    .option('--profile <name>', 'profile name under $DSH_HOME/profiles (default: web)', 'web')
    .option('--home <dir>', 'override the Harness home (default: $DSH_HOME or ~/.dsh)')
    .option('--json', 'emit a machine-readable list')
    .action((opts: { profile?: string; home?: string; json?: boolean }) => {
      const home = resolveDshHome(opts.home)
      const dir = resolveProfileDir(opts.profile ?? 'web', home)
      const backups = listBackups(dir)
      if (opts.json === true) {
        process.stdout.write(envelope('backups', { ok: true, result: backups }))
      } else if (backups.length === 0) {
        process.stdout.write('No backups found.\n')
      } else {
        for (const backup of backups) {
          const ids = backup.disabled.map((d) => d.id).join(', ')
          process.stdout.write(`${backup.dir.split(/[\\/]/).pop()}  ${backup.createdAt}  disabled: ${ids || '(no manifest)'}\n`)
        }
      }
      process.exitCode = 0
    })

  // list：发现 profile。
  program
    .command('list')
    .description('List profiles under the Harness home.')
    .option('--home <dir>', 'override the Harness home (default: $DSH_HOME or ~/.dsh)')
    .option('--json', 'emit a machine-readable list')
    .action((opts: { home?: string; json?: boolean }) => {
      const home = resolveDshHome(opts.home)
      const profiles = listProfiles(home)
      if (opts.json === true) {
        process.stdout.write(envelope('list', {
          ok: true,
          result: profiles.map((name) => ({ name, dir: resolveProfileDir(name, home) })),
        }))
      } else if (profiles.length === 0) {
        process.stdout.write('No profiles found under the Harness home.\n')
      } else {
        process.stdout.write(`profiles under ${home}:\n`)
        for (const name of profiles) process.stdout.write(`  ${name}\n`)
      }
      process.exitCode = 0
    })
}

// ── route ────────────────────────────────────────────────────────────────
const SUBCOMMANDS = new Set(['check', 'plan', 'apply', 'purge', 'gate', 'rollback', 'backups', 'list'])
const argv = process.argv.slice(2)
const firstToken = argv.find((arg) => !arg.startsWith('-'))
const isSubcommand = firstToken !== undefined && SUBCOMMANDS.has(firstToken)

const program = new Command()
if (isSubcommand) {
  buildSub(program)
} else {
  buildMain(program)
}

program.parseAsync(process.argv).catch((error) => {
  process.stderr.write(`dsh-scavenger: ${String(error)}\n`)
  process.exitCode = 2
})

void join