#!/usr/bin/env node
/**
 * dsh-scavenger — scavenge a DeepSeek Harness profile.
 *
 *   dsh-scavenger --profile <name> [--apply] [--json] [--home <dir>] [--no-inspect]
 *   dsh-scavenger check    --profile <name> [--json] [--home <dir>] [--no-inspect]
 *   dsh-scavenger gate     <candidate> [--host-profile <name>] [--json] [--no-inspect]
 *   dsh-scavenger rollback [backupId] --profile <name> [--json]
 *   dsh-scavenger backups  --profile <name> [--json]
 *
 * The main command (no subcommand) analyzes the profile, lists the plugins
 * that would make `dsh <profile>` fail to boot, and — with `--apply` —
 * disables those rows in the profile's cordis.patch.yml (auto-backup, see
 * `rollback`). Without `--apply` nothing is ever written: dry-run plan only.
 *
 * Exit codes: 0 = clean (or cleaned); 1 = culprit rows found (plan shown) or
 * residual errors after cleaning; 2 = usage/IO failure.
 *
 * NB: the main command and the subcommands are built as SEPARATE Command
 * instances and routed by argv — commander 13 merges same-named options of a
 * parent program into its children, silently swallowing values (e.g.
 * `check --profile x` would read the parent's default). Two isolated programs
 * keep `--profile`/`--home`/`--json` unambiguous everywhere.
 */
import { Command } from 'commander'
import { join } from 'node:path'
import { analyzeProfile, VERSION } from './checker/index.ts'
import { contractFindings } from './inspector/check.ts'
import { gateCandidate } from './gate.ts'
import { applyCleanup, listBackups, planCleanup, rollbackCleanup } from './cleaner.ts'
import { resolveDshHome, resolveProfileDir } from './checker/resolve.ts'
import type { CheckReport, Finding } from './types.ts'

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

// ── main command: verify + clean ─────────────────────────────────────────
function buildMain(program: Command): void {
  program
    .name('dsh-scavenger')
    .description('Find the plugins that break a DeepSeek Harness profile, and clean them up (plan → apply, backup → rollback).')
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
      const apply = opts.apply === true && plan.needsCleanup ? applyCleanup(dir, plan.steps, plan.writeTarget) : null
      if (apply?.applied === true) {
        // Re-check after cleaning: any residual error is not cleanable by disabling a row.
        const recheck = await loadReport(profile, home, opts.dshInstall, opts.inspect !== false)
        report.summary = recheck.report.summary
        report.ok = recheck.report.ok
        report.findings = recheck.report.findings
        report.rows = recheck.report.rows
        plan.needsCleanup = planCleanup(recheck.report).needsCleanup
      }

      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify({ report, plan, apply }, null, 2)}\n`)
      } else {
        printMain(report, plan, apply, home, profile)
      }
      if (apply?.applied === true) {
        process.exitCode = report.ok ? 0 : 1
      } else {
        process.exitCode = plan.needsCleanup ? 1 : 0
      }
    })
}

function printMain(report: CheckReport, plan: ReturnType<typeof planCleanup>, apply: ReturnType<typeof applyCleanup> | null, home: string, profile: string): void {
  process.stdout.write(`\n=== dsh-scavenger: ${profile} ===\n`)
  process.stdout.write(`profile dir : ${report.profileDir}\n`)
  process.stdout.write(`dsh install : ${report.dshInstallDir ?? '(not located)'}\n`)
  process.stdout.write(`home        : ${home}\n`)
  process.stdout.write(`scanned at  : ${report.scannedAt}\n\n`)
  process.stdout.write(`summary: ${report.summary.errors} error / ${report.summary.warnings} warning / ${report.summary.infos} info\n\n`)

  if (report.summary.errors > 0) printFindings(report.findings.filter((f) => f.severity === 'error'))

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

  if (apply === null) {
    process.stdout.write(`\n→ ${plan.steps.length} culprit row(s) found. Re-run with --apply to disable them (auto-backup; \`dsh-scavenger rollback\` restores).\n`)
  } else if (apply.applied === true) {
    process.stdout.write(`\n✓ Applied: disabled ${plan.steps.length} row(s) in ${plan.writeTarget}\n`)
    if (apply.backupDir !== null) process.stdout.write(`  backup: ${apply.backupDir}  (\`dsh-scavenger rollback\` restores)\n`)
    if (report.summary.errors > 0) {
      process.stdout.write(`  remaining ${report.summary.errors} error(s) are not cleanable by disabling rows.\n`)
    } else {
      process.stdout.write('  re-check after cleaning: no residual errors. Restart `dsh <profile>` to boot without these plugins.\n')
    }
  } else {
    process.stdout.write(`\n→ apply refused: ${apply.reason ?? 'unknown'} — nothing written.\n`)
  }
}

// ── subcommands ──────────────────────────────────────────────────────────
function buildSub(program: Command): void {
  program
    .name('dsh-scavenger')
    .description('Scavenge a DeepSeek Harness profile (subcommands: check | gate | rollback | backups).')
    .version(VERSION)

  program
    .command('check')
    .description('Offline static + contract preflight of one profile (same analysis as the main command, no cleanup).')
    .option('--profile <name>', 'profile name under $DSH_HOME/profiles (default: web)', 'web')
    .option('--json', 'emit the report as JSON')
    .option('--home <dir>', 'override the Harness home (default: $DSH_HOME or ~/.dsh)')
    .option('--dsh-install <dir>', 'override the dsh installation directory')
    .option('--no-inspect', 'skip worker-isolated contract inspection (C layer)')
    .action(async (opts: { profile?: string; json?: boolean; home?: string; dshInstall?: string; inspect?: boolean }) => {
      const home = resolveDshHome(opts.home)
      const profile = opts.profile ?? 'web'
      const { report, dir } = await loadReport(profile, home, opts.dshInstall, opts.inspect !== false)
      void dir
      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
      } else {
        process.stdout.write(`\n=== dsh-scavenger check: ${profile} ===\n`)
        process.stdout.write(`profile dir : ${report.profileDir}\n`)
        process.stdout.write(`dsh install : ${report.dshInstallDir ?? '(not located)'}\n`)
        process.stdout.write(`home        : ${home}\n`)
        process.stdout.write(`scanned at  : ${report.scannedAt}\n\n`)
        process.stdout.write(`summary: ${report.summary.errors} error / ${report.summary.warnings} warning / ${report.summary.infos} info\n\n`)
        printFindings(report.findings)
        if (report.summary.errors > 0) {
          process.stdout.write(`\n→ ${report.summary.errors} blocking issue(s). Run \`dsh-scavenger --profile ${profile}\` to plan cleaning them.\n`)
        } else {
          process.stdout.write('\n✓ No blocking issue found by static checks; booting should get past plugin composition/resolution.\n')
        }
      }
      process.exitCode = report.ok ? 0 : 1
    })

  program
    .command('gate')
    .description('Pre-install compatibility preflight of a candidate plugin (local dir or installed package name).')
    .argument('<candidate>', 'path to the candidate package directory, or a package name resolved from the host profile')
    .option('--host-profile <name>', 'host profile name used as the environment (default: web)', 'web')
    .option('--home <dir>', 'override the Harness home (default: $DSH_HOME or ~/.dsh)')
    .option('--json', 'emit the report as JSON')
    .option('--no-inspect', 'do not load the candidate module for contract checks')
    .action(async (candidate: string, opts: { hostProfile?: string; home?: string; json?: boolean; inspect?: boolean }) => {
      const home = resolveDshHome(opts.home)
      const hostProfileDir = resolveProfileDir(opts.hostProfile ?? 'web', home)
      const report = await gateCandidate(candidate, { hostProfileDir, inspect: opts.inspect !== false })
      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
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
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
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
        process.stdout.write(`${JSON.stringify(backups, null, 2)}\n`)
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
}

// ── route ────────────────────────────────────────────────────────────────
const SUBCOMMANDS = new Set(['check', 'gate', 'rollback', 'backups'])
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