import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isBareLoaderSpecifier, packageRoot, findInstalledPackage, resolveRowName, resolveFileSpecifier,
} from '../src/checker/resolve.ts'

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