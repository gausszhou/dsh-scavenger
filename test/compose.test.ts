import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { composeLayers, isJsExpr, parsePatchText } from '../src/checker/compose.ts'
import type { LayerInput } from '../src/checker/compose.ts'

function layer(label: string, patches: unknown[], kind: LayerInput['kind'] = 'bundle'): LayerInput {
  return { label, kind, patches, parseError: null, path: label }
}

describe('parsePatchText', () => {
  it('parses the DSH dialect incl. !!js expression nodes', () => {
    const patches = parsePatchText(`
- insert:
    - id: a
      name: pkg-a
      config:
        host: !!js ctx.webStartup.host ?? '127.0.0.1'
        port: 3080
`)
    assert.notEqual(patches, null)
    const insert = (patches?.[0] as { insert?: unknown[] })?.insert
    const row = insert?.[0] as { config?: Record<string, unknown> }
    assert.equal(typeof row?.config?.host, 'object')
    assert.equal(isJsExpr(row?.config?.host), true)
    assert.equal((row?.config?.host as { __jsExpr: string }).__jsExpr, "ctx.webStartup.host ?? '127.0.0.1'")
    assert.equal(row?.config?.port, 3080)
  })
  it('returns null for non-list documents', () => {
    assert.equal(parsePatchText('foo: bar'), null)
    assert.equal(parsePatchText('not: [valid], yaml: ['), null)
  })
})

describe('composeLayers', () => {
  it('stacks layers in order and tracks provenance', () => {
    const composed = composeLayers([
      layer('base', [{ insert: [{ id: 'a', name: 'pkg-a' }, { id: 'b', name: 'pkg-b' }] }]),
      layer('web', [{ insert: [{ id: 'c', name: 'pkg-c' }] }]),
    ])
    assert.deepEqual(composed.rows.map((r) => r.id), ['a', 'b', 'c'])
    assert.equal(composed.rows[0]?.layer, 'base')
    assert.equal(composed.rows[2]?.layer, 'web')
    assert.equal(composed.duplicates.length, 0)
    assert.equal(composed.orphans.length, 0)
  })

  it('reports duplicate ids introduced by later layers', () => {
    const composed = composeLayers([
      layer('base', [{ insert: [{ id: 'a', name: 'pkg-a' }] }]),
      layer('web', [{ insert: [{ id: 'a', name: 'pkg-a2' }] }]),
    ])
    assert.equal(composed.duplicates.length, 1)
    assert.equal(composed.duplicates[0]?.id, 'a')
    assert.deepEqual(composed.duplicates[0]?.layers, ['base', 'web'])
    assert.equal(composed.duplicates[0]?.count, 2)
  })

  it('patches override the named target and record the override', () => {
    const composed = composeLayers([
      layer('base', [{ insert: [{ id: 'srv', name: 'pkg-srv', config: { a: 1 } }] }]),
      layer('web', [{ id: 'srv', config: { a: 2, b: 3 } }]),
    ])
    const srv = composed.nodes[0]
    assert.equal(srv?.id, 'srv')
    assert.deepEqual(srv?.config, { a: 2, b: 3 }) // config replaced, not merged
    assert.equal(composed.overrides.length, 1)
    assert.deepEqual(composed.overrides[0]?.overriddenLayers, ['base'])
  })

  it('warns-and-skips patches targeting unknown ids (orphans)', () => {
    const composed = composeLayers([
      layer('base', [{ insert: [{ id: 'a', name: 'pkg-a' }] }]),
      layer('user', [{ id: 'ghost', name: 'pkg-ghost' }]),
    ])
    assert.equal(composed.rows.length, 1)
    assert.equal(composed.orphans.length, 1)
    assert.equal(composed.orphans[0]?.id, 'ghost')
    assert.equal(composed.orphans[0]?.reason, 'patch target not found')
  })

  it('inserts into an existing group by top-level id (real dsh syntax)', () => {
    const composed = composeLayers([
      layer('base', [{ insert: [{ id: 'grp', group: true, config: [{ id: 'x', name: 'pkg-x' }] }] }]),
      layer('web', [{ id: 'grp', insert: [{ id: 'x2', name: 'pkg-x2' }] }]),
    ])
    const grp = composed.nodes.find((n) => n.id === 'grp')
    const children = (grp?.config as unknown[]) ?? []
    assert.deepEqual(children.map((c) => (c as { id: string }).id), ['x', 'x2'])
  })

  it('warns-and-skips a non-array insert', () => {
    const composed = composeLayers([
      layer('base', [{ insert: [{ id: 'grp', group: true, config: [] }] }]),
      layer('web', [{ insert: { id: 'grp' } }]),
    ])
    assert.equal(composed.orphans.some((o) => o.reason === 'insert is not an array'), true)
    assert.equal(composed.rows.length, 1) // base row only
  })

  it('keeps object configs on inserted rows (no array forcing)', () => {
    const composed = composeLayers([
      layer('app', [{ insert: [{ id: 'preset', name: 'pkg-preset', config: { default: 'standard' } }] }]),
    ])
    const node = composed.nodes.find((n) => n.id === 'preset')
    assert.deepEqual(node?.config, { default: 'standard' })
  })

  it('reports names mounted in multiple layers', () => {
    const composed = composeLayers([
      layer('base', [{ insert: [{ id: 'a', name: 'pkg-same' }] }]),
      layer('web', [{ insert: [{ id: 'b', name: 'pkg-same' }] }]),
    ])
    assert.equal(composed.duplicateNames.length, 1)
    assert.equal(composed.duplicateNames[0]?.name, 'pkg-same')
    assert.deepEqual(composed.duplicateNames[0]?.layers, ['base', 'web'])
  })

  it('computes activation: literal disabled drops, !!js disabled is conditional, group is required', () => {
    const composed = composeLayers([
      layer('base', [{ insert: [
        { id: 'on', name: 'pkg-on' },
        { id: 'off', name: 'pkg-off', disabled: true },
        { id: 'cond', name: 'pkg-cond', disabled: { __jsExpr: 'ctx.flags.enable' } },
        { id: 'grp', group: true, disabled: true, config: [{ id: 'child', name: 'pkg-child' }] },
      ] }]),
    ])
    const ids = composed.resolvableRows.map((r) => r.id)
    assert.ok(ids.includes('on'))
    assert.ok(!ids.includes('off'))
    const cond = composed.resolvableRows.find((r) => r.id === 'cond')
    assert.equal(cond?.activation, 'conditional')
    const grp = composed.resolvableRows.find((r) => r.id === 'grp')
    assert.equal(grp?.activation, 'required')
    // child of a disabled group is dropped
    assert.ok(!ids.includes('child'))
  })
})