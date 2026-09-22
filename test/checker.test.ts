import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeProfile } from '../src/checker/index.ts'
import { contractFindings } from '../src/inspector/check.ts'

/**
 * End-to-end fixture mirroring the four boot-failure shapes DSH exhibits:
 *   1. activation throw        → module loads, apply() throws (runtime-shaped:
 *                                 passes import contract, so NOT flagged statically)
 *   2. missing import dep      → "Cannot find package '@deepseek-ai/schemastery'
 *                                 imported from ..." (CONTRACT_IMPORT_FAILED)
 *   3. missing inject service  → "pending (waiting for service: gdnMissingService)"
 *                                 (CONTRACT_INJECT_UNVERIFIED)
 *   4. missing row package     → "Cannot find package 'gdn-package-does-not-exist-xyz'
 *                                 imported from <profileDir>/" (ROW_PACKAGE_MISSING)
 */
let home: string
let profileDir: string

before(() => {
  home = mkdtempSync(join(tmpdir(), 'gdn-home-'))
  profileDir = join(home, 'profiles', 'gdn-demo')
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  mkdirSync(join(profileDir, 'plugins'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-gdn-demo',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [], patchReload: 'startup' } },
  }, null, 2))
  writeFileSync(join(profileDir, 'cordis.yml'), '[]\n')
  writeFileSync(join(profileDir, 'plugins', 'thrower.js'), `export default function thrower(ctx) {\n  throw new Error('BOOM from thrower plugin (activation)')\n}\n`)
  writeFileSync(join(profileDir, 'plugins', 'config-bad.js'), `import z from '@deepseek-ai/schemastery'\nexport const Config = z.object({ env: z.string().required() })\nexport default function cfg(ctx, config) { ctx.logger.info('cfg %o', config) }\n`)
  writeFileSync(join(profileDir, 'plugins', 'missing-inject.js'), `const injector = Object.assign(function injector(ctx) { ctx.logger.info('see %o', ctx.gdnMissingService) }, { inject: ['gdnMissingService'] })\nexport default injector\n`)
  writeFileSync(join(profileDir, 'cordis.patch.yml'), `
- insert:
    - id: gdn-thrower
      name: './plugins/thrower.js'
    - id: gdn-config-bad
      name: './plugins/config-bad.js'
    - id: gdn-missing-inject
      name: './plugins/missing-inject.js'
    - id: gdn-nonexistent
      name: 'gdn-package-does-not-exist-xyz'
`)
})

after(() => rmSync(home, { recursive: true, force: true }))

describe('analyzeProfile on the broken fixture', () => {
  it('flags the missing row package as the blocking error', () => {
    const report = analyzeProfile(profileDir, { homeDir: home, includeTree: true })
    assert.equal(report.ok, false)
    const missing = report.findings.filter((f) => f.code === 'ROW_PACKAGE_MISSING')
    assert.equal(missing.length, 1)
    assert.equal(missing[0]?.severity, 'error')
    assert.equal(missing[0]?.plugin, 'gdn-package-does-not-exist-xyz')
    // The three real ./plugins rows resolve fine — no ROW_FILE_MISSING.
    assert.equal(report.findings.filter((f) => f.code === 'ROW_FILE_MISSING').length, 0)
    assert.equal(report.rows.length, 4)
    assert.deepEqual(report.bundles, [])
  })

  it('attaches row provenance for attribution', () => {
    const report = analyzeProfile(profileDir, { homeDir: home, includeTree: true })
    const thrower = report.rows.find((r) => r.id === 'gdn-thrower')
    assert.equal(thrower?.layer, join(profileDir, 'cordis.patch.yml'))
    assert.equal(thrower?.name, './plugins/thrower.js')
  })
})

describe('contractFindings on the broken fixture', () => {
  it('reproduces the DSH import and inject failure attributions', async () => {
    const report = analyzeProfile(profileDir, { homeDir: home, includeTree: true })
    const findings = await contractFindings(profileDir, report, { concurrency: 2, timeoutMs: 8000 })

    const importFailed = findings.find((f) => f.code === 'CONTRACT_IMPORT_FAILED' && f.entryId === 'gdn-config-bad')
    assert.ok(importFailed, 'expected CONTRACT_IMPORT_FAILED for gdn-config-bad')
    assert.match(importFailed?.message ?? '', /@deepseek-ai\/schemastery/)

    const inject = findings.find((f) => f.code === 'CONTRACT_INJECT_UNVERIFIED' && f.entryId === 'gdn-missing-inject')
    assert.ok(inject, 'expected CONTRACT_INJECT_UNVERIFIED for gdn-missing-inject')
    assert.equal(inject?.severity, 'warning')
    assert.match(inject?.message ?? '', /gdnMissingService/)

    // The activation thrower is a *valid* plugin contract-wise; nothing static
    // should flag it (the failure needs a running fiber).
    assert.equal(findings.filter((f) => f.entryId === 'gdn-thrower').length, 0)

    // No false CONTRACT_PLUGIN_SHAPE anywhere.
    assert.equal(findings.filter((f) => f.code === 'CONTRACT_PLUGIN_SHAPE').length, 0)
  })
})

describe('disabled rows', () => {
  it('downgrades missing-package severity to warning when the row is conditionally disabled', () => {
    writeFileSync(join(profileDir, 'cordis.patch.yml'), `
- insert:
    - id: gdn-cond
      name: 'gdn-package-does-not-exist-xyz'
      disabled: { __jsExpr: 'ctx.flags.enableIt' }
`)
    const report = analyzeProfile(profileDir, { homeDir: home })
    const missing = report.findings.find((f) => f.code === 'ROW_PACKAGE_MISSING')
    assert.equal(missing?.severity, 'warning')
  })
})