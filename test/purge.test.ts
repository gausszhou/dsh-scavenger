/**
 * planPurgeCleanup — 清理"所有三方插件"行（区别于 planCleanup 只清报错行）。
 *
 * 三方判定（isThirdPartyRow）：裸包 specifier 且包根不在 DSH core 集合。
 * 相对/绝对路径、`cordis:` 内建、file:/协议 specifier、group 行与 core 包
 * 都不算三方；字面量 disabled 的行不在 resolvableRows 中，也不会被计划。
 * `!!js` disabled（conditional）的行运行期可能加载，purge 照常禁用。
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeProfile, corePackageNames } from '../src/checker/index.ts'
import { applyCleanup, isThirdPartyRow, planPurgeCleanup, rollbackCleanup } from '../src/cleaner.ts'
import type { ResolvableRow } from '../src/types.ts'

let home: string
let profileDir: string
let patchPath: string
const originalPatch = `- insert:
    - id: tp-missing
      name: 'some-third-party-plugin'
    - id: tp-conditional
      name: 'another-third-party-plugin'
      disabled: { __jsExpr: 'ctx.flags.enableIt' }
    - id: tp-disabled
      name: 'disabled-third-party-plugin'
      disabled: true
    - id: core-base
      name: '@deepseek-ai/dsh-base'
    - id: core-dsh
      name: '@deepseek-ai/dsh'
    - id: builtin-timer
      name: 'cordis:timer'
    - id: local-file
      name: './plugins/local.js'
    - id: my-group
      group: true
      config:
        - id: nested-tp
          name: 'nested-third-party-plugin'
`

before(() => {
  home = mkdtempSync(join(tmpdir(), 'gdn-purge-'))
  profileDir = join(home, 'profiles', 'gdn-demo')
  patchPath = join(profileDir, 'cordis.patch.yml')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  mkdirSync(join(profileDir, 'plugins'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: 'dsh-profile-gdn-demo', private: true, dependencies: {}, dsh: { profile: { bundles: [], patchReload: 'startup' } } }, null, 2))
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDir, 'plugins', 'local.js'), 'export default function local() {}\n')
  writeFileSync(patchPath, originalPatch)
})

after(() => rmSync(home, { recursive: true, force: true }))

function coreOf(report: ReturnType<typeof analyzeProfile>): Set<string> {
  return corePackageNames(report.dshInstallDir)
}

describe('isThirdPartyRow', () => {
  it('accepts only bare non-core packages', () => {
    const core = new Set(['@deepseek-ai/dsh', '@deepseek-ai/dsh-base', '@deepseek-ai/cordis'])
    const row = (name: string | undefined, group = false): ResolvableRow => ({ id: 'x', layer: 'x', name, group, activation: 'required' })
    assert.equal(isThirdPartyRow(row('some-third-party-plugin'), core), true)
    assert.equal(isThirdPartyRow(row('@gausszhou/another-plugin'), core), true)
    // core 包 / cordis: 内建 / 相对路径 / 本地文件 / group / 无名行 → 不是三方
    assert.equal(isThirdPartyRow(row('@deepseek-ai/dsh'), core), false)
    assert.equal(isThirdPartyRow(row('@deepseek-ai/dsh-base'), core), false)
    assert.equal(isThirdPartyRow(row('@deepseek-ai/cordis'), core), false)
    assert.equal(isThirdPartyRow(row('cordis:timer'), core), false)
    assert.equal(isThirdPartyRow(row('./plugins/local.js'), core), false)
    assert.equal(isThirdPartyRow(row('../relative.js'), core), false)
    assert.equal(isThirdPartyRow(row('file:/tmp/x.js'), core), false)
    assert.equal(isThirdPartyRow(row(undefined), core), false)
    assert.equal(isThirdPartyRow(row('pkg', true), core), false)
  })
})

describe('planPurgeCleanup', () => {
  it('plans exactly the third-party rows the loader would import', () => {
    const report = analyzeProfile(profileDir, { homeDir: home })
    const plan = planPurgeCleanup(report, coreOf(report))
    assert.equal(plan.needsCleanup, true)
    assert.deepEqual(plan.steps.map((s) => s.id), ['nested-tp', 'tp-conditional', 'tp-missing'])
    assert.ok(plan.steps.every((s) => s.codes.includes('PURGE_THIRD_PARTY')))
    assert.equal(plan.writeTarget, patchPath)
    // core / cordis: / 本地文件 / 已禁用行 / group 行都不在计划里
    for (const kept of ['core-base', 'core-dsh', 'builtin-timer', 'local-file', 'tp-disabled', 'my-group']) {
      assert.ok(!plan.steps.some((s) => s.id === kept), `expected ${kept} to be kept`)
    }
  })

  it('produces an empty plan when every third-party row is disabled', async () => {
    const report = analyzeProfile(profileDir, { homeDir: home })
    const plan = planPurgeCleanup(report, coreOf(report))
    assert.ok(plan.needsCleanup)

    // 应用 purge 后永久禁掉三方行 → 复检计划应为空。
    const applied = applyCleanup(profileDir, plan.steps, plan.writeTarget)
    assert.equal(applied.applied, true)
    const recheck = analyzeProfile(profileDir, { homeDir: home })
    assert.equal(planPurgeCleanup(recheck, coreOf(recheck)).needsCleanup, false)
    for (const id of ['tp-missing', 'tp-conditional', 'nested-tp']) {
      assert.ok(!recheck.resolvableRows.some((r) => r.id === id), `expected ${id} disabled after purge`)
    }
  })
})

describe('purge apply + rollback', () => {
  before(() => writeFileSync(patchPath, originalPatch))

  it('appends disabled patches for every third-party row and rollback restores byte-for-byte', () => {
    const before = analyzeProfile(profileDir, { homeDir: home })
    const plan = planPurgeCleanup(before, coreOf(before))
    assert.equal(plan.steps.length, 3)

    const applied = applyCleanup(profileDir, plan.steps, plan.writeTarget)
    assert.equal(applied.applied, true)
    assert.ok(applied.backupDir !== null)

    const afterApply = readFileSync(patchPath, 'utf8')
    assert.match(afterApply, /- id: "tp-missing"\n  disabled: true/)
    assert.match(afterApply, /- id: "tp-conditional"\n  disabled: true/)
    assert.match(afterApply, /- id: "nested-tp"\n  disabled: true/)
    // core 行没有被追加禁用
    assert.ok(!/- id: "core-base"\n  disabled: true/.test(afterApply))
    assert.ok(!/- id: "builtin-timer"\n  disabled: true/.test(afterApply))

    const rolledBack = rollbackCleanup(profileDir)
    assert.equal(rolledBack.ok, true)
    assert.equal(readFileSync(patchPath, 'utf8'), originalPatch)
  })
})