import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeProfile } from '../src/checker/index.ts'
import { contractFindings } from '../src/inspector/check.ts'
import { applyCleanup, disablePatchText, listBackups, planCleanup, rollbackCleanup } from '../src/cleaner.ts'

let home: string
let profileDir: string
let patchPath: string
const originalPatch = `- insert:
    - id: gdn-thrower
      name: './plugins/thrower.js'
    - id: gdn-config-bad
      name: './plugins/config-bad.js'
    - id: gdn-nonexistent
      name: 'gdn-package-does-not-exist-xyz'
`

before(() => {
  home = mkdtempSync(join(tmpdir(), 'gdn-clean-'))
  profileDir = join(home, 'profiles', 'gdn-demo')
  patchPath = join(profileDir, 'cordis.patch.yml')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  mkdirSync(join(profileDir, 'plugins'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-gdn-demo', private: true, dependencies: {}, dsh: { profile: { bundles: [], patchReload: 'startup' } } }, null, 2))
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDir, 'plugins', 'thrower.js'), `export default function thrower(ctx) { throw new Error('BOOM') }\n`)
  writeFileSync(join(profileDir, 'plugins', 'config-bad.js'), `import z from '@deepseek-ai/schemastery'\nexport default function cfg() {}\n`)
  writeFileSync(patchPath, originalPatch)
})

after(() => rmSync(home, { recursive: true, force: true }))

describe('planCleanup', () => {
  it('plans to disable exactly the error rows that will boot-fail', async () => {
    const report = analyzeProfile(profileDir, { homeDir: home, includeTree: true })
    await contractFindings(profileDir, report, { concurrency: 2, timeoutMs: 8000 })
    const plan = planCleanup(report)
    assert.equal(plan.needsCleanup, true)
    // ROW_PACKAGE_MISSING (error) is cleanable; CONTRACT_IMPORT_FAILED
    // (warning) and CONTRACT_INJECT_UNVERIFIED (warning) are not errors, so
    // only the missing-package row is planned.
    assert.deepEqual(plan.steps.map((s) => s.id), ['gdn-nonexistent'])
    assert.ok(plan.steps[0]?.codes.includes('ROW_PACKAGE_MISSING'))
    assert.equal(plan.writeTarget, patchPath)
  })

  it('produces valid DSH-dialect disable patch text', () => {
    const text = disablePatchText([{ id: 'row-a', layer: 'x', codes: ['ROW_PACKAGE_MISSING'], reasons: ['r'] }])
    assert.match(text, /^- id: "row-a"\n  disabled: true$/)
  })
})

describe('applyCleanup + review + rollback', () => {
  it('disables the row, clears the error on re-check, and rollback restores the file byte-for-byte', async () => {
    // 1. plan
    const before = analyzeProfile(profileDir, { homeDir: home, includeTree: true })
    const plan = planCleanup(before)
    assert.equal(plan.steps.length, 1)

    // 2. apply
    const applied = applyCleanup(profileDir, plan.steps, plan.writeTarget)
    assert.equal(applied.applied, true)
    assert.ok(applied.backupDir !== null)

    // 3. the appended patch is valid + row disabled
    const afterApply = readFileSync(patchPath, 'utf8')
    assert.match(afterApply, /- id: "gdn-nonexistent"\n  disabled: true/)
    const { parsePatchText } = await import('../src/checker/compose.ts')
    assert.notEqual(parsePatchText(afterApply), null)

    // 4. re-check: no more ROW_PACKAGE_MISSING error
    const recheck = analyzeProfile(profileDir, { homeDir: home, includeTree: true })
    assert.equal(recheck.findings.filter((f) => f.code === 'ROW_PACKAGE_MISSING' && f.severity === 'error').length, 0)
    assert.ok(recheck.ok, 'profile should be clean after disabling the culprit row')

    // 5. backup bookkeeping
    const backups = listBackups(profileDir)
    assert.equal(backups.length, 1)
    assert.deepEqual(backups[0]?.disabled.map((d) => d.id), ['gdn-nonexistent'])

    // 6. rollback restores the exact original file
    const rolledBack = rollbackCleanup(profileDir)
    assert.equal(rolledBack.ok, true)
    assert.equal(readFileSync(patchPath, 'utf8'), originalPatch)
    assert.equal(listBackups(profileDir).length, 0)

    // 7. the error is back (faithful restore)
    const afterRollback = analyzeProfile(profileDir, { homeDir: home })
    assert.equal(afterRollback.findings.filter((f) => f.code === 'ROW_PACKAGE_MISSING' && f.severity === 'error').length, 1)
  })

  it('refuses to apply when the augmented patch would not parse', () => {
    // A guarded write path: corrupt target that cannot be re-parsed even
    // after appending is refused (we simulate by making the target contain
    // invalid YAML that no append can fix).
    writeFileSync(patchPath, 'not: [valid yaml: [\n  broken: [')
    const result = applyCleanup(profileDir, [{ id: 'x', layer: 'l', codes: ['ROW_PACKAGE_MISSING'], reasons: ['r'] }], patchPath)
    assert.equal(result.applied, false)
    assert.match(result.reason ?? '', /re-parse/)
    writeFileSync(patchPath, originalPatch)
  })
})