import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isBareLoaderSpecifier, packageRoot, findInstalledPackage, resolveRowName, resolveFileSpecifier,
  buildBundleLayers,
} from '../src/checker/resolve.ts'
import { composeLayers } from '../src/checker/compose.ts'

describe('packageRoot', () => {
  it('keeps plain names and scoped-name prefixes', () => {
    assert.equal(packageRoot('pkg-a'), 'pkg-a')
    assert.equal(packageRoot('@scope/pkg-b'), '@scope/pkg-b')
    assert.equal(packageRoot('@scope/pkg-b/sub/path'), '@scope/pkg-b')
    assert.equal(packageRoot('pkg-c/sub'), 'pkg-c')
  })
  it('rejects node protocol and relative forms', () => {
    assert.equal(packageRoot('node:fs'), null)
    assert.equal(packageRoot('file:./x.js'), null)
    assert.equal(packageRoot(''), null)
  })
})

describe('isBareLoaderSpecifier', () => {
  it('accepts npm-style specifiers', () => {
    assert.equal(isBareLoaderSpecifier('pkg-a'), true)
    assert.equal(isBareLoaderSpecifier('@scope/pkg-b'), true)
    assert.equal(isBareLoaderSpecifier('@scope/pkg-b/sub'), true)
  })
  it('rejects relative, absolute, file: and cordis: forms', () => {
    assert.equal(isBareLoaderSpecifier('./x.js'), false)
    assert.equal(isBareLoaderSpecifier('../x.js'), false)
    assert.equal(isBareLoaderSpecifier('/abs/x.js'), false)
    assert.equal(isBareLoaderSpecifier('file:///x.js'), false)
    assert.equal(isBareLoaderSpecifier('cordis:include'), false)
    assert.equal(isBareLoaderSpecifier('node:fs'), false)
  })
})

describe('resolveRowName', () => {
  let dir: string
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'gdn-resolve-'))
    mkdirSync(join(dir, 'node_modules', '@scope', 'pkg-real', 'lib'), { recursive: true })
    mkdirSync(join(dir, 'node_modules', 'pkg-plain', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', '@scope', 'pkg-real', 'package.json'), JSON.stringify({ name: '@scope/pkg-real', version: '1.0.0' }))
    writeFileSync(join(dir, 'node_modules', 'pkg-plain', 'package.json'), JSON.stringify({ name: 'pkg-plain', version: '1.0.0' }))
    writeFileSync(join(dir, 'node_modules', 'pkg-plain', 'lib', 'index.js'), 'export default 1')
    mkdirSync(join(dir, 'a'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b.js'), 'export default 1')
  })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('classifies cordis: builtins', () => {
    assert.equal(resolveRowName('cordis:include', dir).kind, 'cordis')
    assert.equal(resolveRowName('cordis:group', dir).kind, 'cordis')
  })
  it('resolves installed packages', () => {
    const scoped = resolveRowName('@scope/pkg-real', dir)
    assert.equal(scoped.kind, 'package')
    assert.equal(scoped.packageName, '@scope/pkg-real')
    assert.ok(scoped.resolved?.endsWith(join('node_modules', '@scope', 'pkg-real')))
  })
  it('reports missing packages without resolving', () => {
    const missing = resolveRowName('pkg-ghost', dir)
    assert.equal(missing.kind, 'package')
    assert.equal(missing.resolved, undefined)
  })
  it('resolves relative file specifiers', () => {
    const file = resolveRowName('./a/b.js', dir)
    assert.equal(file.kind, 'file')
    assert.ok(file.resolved?.endsWith('b.js'))
    const absent = resolveRowName('./a/c.js', dir)
    assert.equal(absent.kind, 'file')
    assert.equal(absent.resolved, undefined)
  })
  it('falls back to the dsh installation for package resolution (0.1.6+ runtime resolution)', () => {
    const dshDir = mkdtempSync(join(tmpdir(), 'gdn-dsh-resolve-'))
    try {
      mkdirSync(join(dshDir, 'node_modules', 'host-pkg'), { recursive: true })
      writeFileSync(join(dshDir, 'node_modules', 'host-pkg', 'package.json'), JSON.stringify({ name: 'host-pkg', version: '1.0.0' }))
      // profile 侧不含该包：只有传入 dsh 安装目录才能解析到。
      const resolved = resolveRowName('host-pkg', dir, dshDir)
      assert.equal(resolved.kind, 'package')
      assert.equal(resolved.packageName, 'host-pkg')
      assert.ok(resolved.resolved?.endsWith(join('node_modules', 'host-pkg')))
      const missing = resolveRowName('host-pkg', dir)
      assert.equal(missing.kind, 'package')
      assert.equal(missing.resolved, undefined)
    } finally {
      rmSync(dshDir, { recursive: true, force: true })
    }
  })
})

describe('findInstalledPackage', () => {
  let dir: string
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'gdn-findpkg-'))
    mkdirSync(join(dir, 'node_modules', 'a'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'a', 'package.json'), JSON.stringify({ name: 'a', version: '1.0.0' }))
    mkdirSync(join(dir, 'node_modules', 'b', 'node_modules', 'c'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'b', 'node_modules', 'c', 'package.json'), JSON.stringify({ name: 'c', version: '1.0.0' }))
  })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('walks ancestors to the nearest node_modules', () => {
    const deep = join(dir, 'node_modules', 'b')
    assert.equal(findInstalledPackage(deep, 'a'), join(dir, 'node_modules', 'a'))
    assert.equal(findInstalledPackage(deep, 'c'), join(dir, 'node_modules', 'b', 'node_modules', 'c'))
    assert.equal(findInstalledPackage(deep, 'ghost'), null)
  })
})

describe('resolveFileSpecifier', () => {
  let dir: string
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'gdn-file-'))
    writeFileSync(join(dir, 'x.js'), 'export default 1')
  })
  after(() => rmSync(dir, { recursive: true, force: true }))

  it('resolves relative and file: specifiers that exist', () => {
    assert.ok(resolveFileSpecifier('./x.js', dir)?.endsWith('x.js'))
    assert.ok(resolveFileSpecifier(`file://${join(dir, 'x.js')}`, dir)?.endsWith('x.js'))
    assert.equal(resolveFileSpecifier('./nope.js', dir), null)
  })
})

describe('buildBundleLayers with an ordered patch list (dsh.bundle.patch: string[])', () => {
  let home: string
  let profileDir: string
  let bundleDir: string
  before(() => {
    home = mkdtempSync(join(tmpdir(), 'gdn-bundle-'))
    profileDir = join(home, 'profiles', 'demo')
    bundleDir = join(profileDir, 'node_modules', 'my-bundle')
    mkdirSync(bundleDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-demo', private: true,
      dependencies: { 'my-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['my-bundle'] } },
    }, null, 2))
    writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({
      name: 'my-bundle', version: '1.0.0',
      dsh: { bundle: { patch: ['./a.yml', './b.yml'] } },
    }, null, 2))
    // a.yml 插入 x 行；b.yml 按 id 打补丁——两文件必须按序拼接、共享 entryMap。
    writeFileSync(join(bundleDir, 'a.yml'), `- insert:
    - id: x
      name: 'pkg-x'
`)
    writeFileSync(join(bundleDir, 'b.yml'), `- id: x
  config:
    alpha: 1
`)
  })
  after(() => rmSync(home, { recursive: true, force: true }))

  it('concatenates the ordered patch files into one layer and applies them in order', () => {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    const built = buildBundleLayers(profileDir, manifest.dsh.profile.bundles, { 'my-bundle': '1.0.0' }, null)
    const bundle = built.bundles[0]
    assert.equal(bundle?.error, null)
    assert.equal(bundle?.patchPaths?.length, 2)
    assert.ok(bundle?.patchPath?.endsWith(join('my-bundle', 'a.yml')))
    assert.equal(built.layers.length, 1)
    // 两文件按序拼接成一层，b.yml 的补丁命中 a.yml 插入的行。
    assert.equal(built.layers[0]?.patches.length, 2)
    const composeLayer = built.layers[0]
    if (composeLayer === undefined) throw new Error('expected one bundle layer')
    const composed = composeLayers([composeLayer])
    const x = composed.nodes.find((n) => n.id === 'x')
    assert.ok(x, 'row x inserted by a.yml must exist')
    assert.deepEqual(x?.config, { alpha: 1 })
    assert.equal(bundle?.entries.includes('x'), true)
  })

  it('keeps single-file patch declarations working', () => {
    const singleDir = join(home, 'profiles', 'demo2')
    const singleBundle = join(singleDir, 'node_modules', 'my-bundle')
    mkdirSync(singleBundle, { recursive: true })
    writeFileSync(join(singleDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-demo2', private: true,
      dependencies: { 'my-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['my-bundle'] } },
    }, null, 2))
    writeFileSync(join(singleBundle, 'package.json'), JSON.stringify({
      name: 'my-bundle', version: '1.0.0',
      dsh: { bundle: { patch: './only.yml' } },
    }, null, 2))
    writeFileSync(join(singleBundle, 'only.yml'), `- insert:
    - id: y
      name: 'pkg-y'
`)
    const built = buildBundleLayers(singleDir, ['my-bundle'], { 'my-bundle': '1.0.0' }, null)
    assert.equal(built.bundles[0]?.error, null)
    assert.equal(built.bundles[0]?.patchPath, join(singleBundle, 'only.yml'))
    assert.equal(built.layers[0]?.patches.length, 1)
  })

  it('reports a missing declared patch file', () => {
    const brokenDir = join(home, 'profiles', 'demo3')
    const brokenBundle = join(brokenDir, 'node_modules', 'my-bundle')
    mkdirSync(brokenBundle, { recursive: true })
    writeFileSync(join(brokenDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-demo3', private: true,
      dependencies: { 'my-bundle': '1.0.0' },
      dsh: { profile: { bundles: ['my-bundle'] } },
    }, null, 2))
    writeFileSync(join(brokenBundle, 'package.json'), JSON.stringify({
      name: 'my-bundle', version: '1.0.0',
      dsh: { bundle: { patch: ['./a.yml', './missing.yml'] } },
    }, null, 2))
    writeFileSync(join(brokenBundle, 'a.yml'), '[]\n')
    const built = buildBundleLayers(brokenDir, ['my-bundle'], { 'my-bundle': '1.0.0' }, null)
    assert.match(built.bundles[0]?.error ?? '', /missing\.yml is missing/)
  })
})