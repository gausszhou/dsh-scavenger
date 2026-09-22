/**
 * Composition mirror of DSH's include patch algorithm.
 *
 * DSH composes a profile tree by applying patch layers over an empty root with
 * `applyEntryPatches` (dsh-app-boot, vendored include). This module mirrors
 * that algorithm *exactly* (same js-yaml dialect incl. `!!js` scalars, same
 * row-id indexing, same warn-and-skip semantics) so an offline report can
 * never drift from what actually mounts at boot — but additionally tracks
 * layer provenance, duplicates, overrides and orphan rows for diagnosis.
 *
 * Reference semantics (verified against dsh-app-boot lib/index.js `applyEntryPatches`, 0.1.5-rc.2):
 * - the input tree is detached (structuredClone); the map is rebuilt per layer;
 * - `insert` with a truthy `id` targets an existing group (else warn+skip);
 *   `insert` without `id` appends to the top level; inserted rows are indexed
 *   so later patches in the same run can target them;
 * - a non-insert patch requires `id`; missing target warns+skips; a truthy
 *   `name` that differs from the target's name warns+skips; remaining fields
 *   overwrite the target (config is REPLACED, not deep-merged);
 * - `disabled` is just a field overwritten by patches; `!!js` scalars are
 *   expression nodes evaluated by the Loader at activation, never here.
 */

import { JSON_SCHEMA, Type, load } from 'js-yaml'
import { existsSync, readFileSync } from 'node:fs'

/** js-yaml dialect tag for `!!js` scalars — identical to dsh-app-boot's entryListSchema. */
const JsExpr = new Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: (data: unknown): boolean => typeof data === 'string',
  construct: (data: unknown): unknown => ({ __jsExpr: String(data) }),
})
const entrySchema = JSON_SCHEMA.extend(JsExpr)

export function isJsExpr(value: unknown): value is { __jsExpr: string } {
  return value !== null && typeof value === 'object' && '__jsExpr' in value
}

export interface EntryNode {
  id: string
  name?: string
  /** Synthetic provenance attached by the guardian for attribution. */
  layer?: string
  group?: boolean
  config?: unknown
  disabled?: unknown
  /** Row-level injected services (patch `inject: [...]`), when declared. */
  inject?: string[]
}

export interface LoaderRowRecord {
  id: string
  layer: string
  name?: string
}

export interface OrphanRow {
  id: string
  layer: string
  reason: string
}

export interface OverrideRow {
  id: string
  layer: string
  overriddenLayers: string[]
}

export interface DuplicateId {
  id: string
  layers: string[]
  count: number
}

export interface DuplicateName {
  name: string
  layers: string[]
  count: number
}

export interface LayerInput {
  label: string
  kind: 'bundle' | 'user' | 'home' | 'overlay'
  patches: unknown[]
  parseError: string | null
  /** Absolute path of the layer's source file (for relative-name anchoring). */
  path?: string
}

export interface Composed {
  rows: LoaderRowRecord[]
  duplicates: DuplicateId[]
  duplicateNames: DuplicateName[]
  overrides: OverrideRow[]
  orphans: OrphanRow[]
  /** Whether the composition produced any orphan (warn) rows. */
  hasOrphans: boolean
  /**
   * Rows the Loader can attempt to import, with activation state. Literal
   * `disabled: true` (own or inherited from a group parent) drops the row;
   * `!!js` disabled expressions stay `conditional` (indeterminate here).
   */
  resolvableRows: Array<{ id: string; layer: string; name?: string; activation: 'required' | 'conditional' }>
  /** Final composed tree with layer tags (config preserved for contract checks). */
  nodes: EntryNode[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Parse one entry-list/patch file with the DSH dialect; null when unparsable or not a list. */
export function parsePatchText(text: string): unknown[] | null {
  try {
    const value = load(text, { schema: entrySchema })
    return Array.isArray(value) ? value : null
  } catch {
    return null
  }
}

export function parsePatchFile(path: string): unknown[] | null {
  try {
    return parsePatchText(readFileSync(path, 'utf8'))
  } catch {
    return null
  }
}

/** Flatten a tree of entries (group configs included) into row records, inheriting layer. */
export function flattenEntries(nodes: EntryNode[]): LoaderRowRecord[] {
  const rows: LoaderRowRecord[] = []
  const walk = (list: EntryNode[], inheritedLayer?: string): void => {
    for (const node of list) {
      const layer = node.layer ?? inheritedLayer
      if (layer === undefined) continue
      rows.push({ id: node.id, layer, name: node.name })
      if (node.group === true && Array.isArray(node.config)) {
        walk(node.config as EntryNode[], layer)
      }
    }
  }
  walk(nodes)
  return rows
}

/**
 * Apply the layer stack over an empty root exactly like the dsh boot include,
 * tracking per-layer provenance and collecting diagnostics.
 */
export function composeLayers(layers: LayerInput[]): Composed {
  const tree: EntryNode[] = []
  const orphans: OrphanRow[] = []
  const overrides: OverrideRow[] = []
  /**
   * Mirror of the boot's entryMap: the LAST row registered for an id
   * (top-level or nested group member) is the patch target; later inserts
   * overwrite the map entry — exactly applyEntryPatches' buildMap.
   */
  const entryMap = new Map<string, EntryNode>()
  const buildMap = (nodes: EntryNode[]): void => {
    for (const node of nodes) {
      if (node.id !== '') entryMap.set(node.id, node)
      if (node.group === true && Array.isArray(node.config)) buildMap(node.config as EntryNode[])
    }
  }

  for (const layer of layers) {
    if (layer.parseError !== null) continue
    for (const patch of layer.patches) {
      if (!isRecord(patch)) {
        orphans.push({ id: '(anonymous)', layer: layer.label, reason: 'patch entry is not a mapping' })
        continue
      }
      const { id, insert, name, ...overridesOf } = patch
      // Boot boundary: `insert` and `id` are truthiness-checked.
      const hasId = typeof id === 'string' ? id !== '' : Boolean(id)
      const lookupKey = hasId ? String(id) : ''
      if (insert) {
        if (!Array.isArray(insert)) {
          orphans.push({ id: lookupKey === '' ? '(anonymous)' : lookupKey, layer: layer.label, reason: 'insert is not an array' })
          continue
        }
        const nodes = (insert as unknown[])
          .filter(isRecord)
          .map((entry): EntryNode | null => {
            if (typeof entry.id !== 'string') return null
            return {
              id: entry.id,
              name: typeof entry.name === 'string' ? entry.name : undefined,
              layer: layer.label,
              group: entry.group === true,
              // config may be a JSON object (normal config) or an array
              // (group children); keep it verbatim for contract checks.
              config: entry.config,
              disabled: entry.disabled,
              inject: Array.isArray(entry.inject) ? entry.inject.filter((s): s is string => typeof s === 'string') : undefined,
            }
          })
          .filter((n): n is EntryNode => n !== null)
        if (hasId) {
          const target = entryMap.get(lookupKey)
          if (target === undefined) {
            orphans.push({ id: lookupKey, layer: layer.label, reason: 'insert target not found' })
            continue
          }
          if (target.group !== true) {
            orphans.push({ id: lookupKey, layer: layer.label, reason: 'insert target is not a group' })
            continue
          }
          // Boot boundary: a group with a non-array config is fixed up to an
          // empty array before the append (applyEntryPatches does the same).
          if (!Array.isArray(target.config)) target.config = []
          target.config = [...(target.config as unknown[]), ...nodes]
        } else {
          tree.push(...nodes)
        }
        buildMap(nodes)
        continue
      }
      if (!hasId) {
        orphans.push({ id: '(anonymous)', layer: layer.label, reason: 'id required for non-insert patch' })
        continue
      }
      const target = entryMap.get(lookupKey)
      if (target === undefined) {
        orphans.push({ id: lookupKey, layer: layer.label, reason: 'patch target not found' })
        continue
      }
      // Boot boundary: the name guard is truthiness-based.
      if (name && name !== target.name) {
        orphans.push({ id: lookupKey, layer: layer.label, reason: `name mismatch (expected ${String(target.name)}, got ${String(name)})` })
        continue
      }
      const priorLayers: string[] = []
      for (const row of flattenEntries(tree)) {
        if (row.id === lookupKey && !priorLayers.includes(row.layer)) priorLayers.push(row.layer)
      }
      if (priorLayers.some((prior) => prior !== layer.label)) {
        overrides.push({ id: lookupKey, layer: layer.label, overriddenLayers: priorLayers.filter((prior) => prior !== layer.label) })
      }
      for (const [key, value] of Object.entries(overridesOf)) {
        if (key === 'id') continue
        ;(target as unknown as Record<string, unknown>)[key] = value
      }
    }
  }

  const rows = flattenEntries(tree)

  // Duplicate ids: rows sharing an id across layers. Same-layer duplicates are
  // still structural (a bundle inserting twice) but only cross-layer ones fail
  // the boot's audit message; count all, keep layers unique.
  const countById = new Map<string, number>()
  const layersById = new Map<string, string[]>()
  for (const row of rows) {
    countById.set(row.id, (countById.get(row.id) ?? 0) + 1)
    const layers = layersById.get(row.id) ?? []
    if (!layers.includes(row.layer)) layers.push(row.layer)
    layersById.set(row.id, layers)
  }
  const duplicates: DuplicateId[] = []
  for (const [id, count] of countById) {
    if (count < 2) continue
    duplicates.push({ id, layers: layersById.get(id) ?? [], count })
  }
  duplicates.sort((a, b) => a.id.localeCompare(b.id))

  // Duplicate names across DIFFERENT layers: the Loader registers plugins by
  // name, so a later layer's row with the same name shadows the earlier one.
  // Rows sharing a name within ONE layer are routine (multi-entry bundles).
  const layersByName = new Map<string, string[]>()
  const countByName = new Map<string, number>()
  for (const row of rows) {
    if (row.name === undefined) continue
    countByName.set(row.name, (countByName.get(row.name) ?? 0) + 1)
    const layers = layersByName.get(row.name) ?? []
    if (!layers.includes(row.layer)) layers.push(row.layer)
    layersByName.set(row.name, layers)
  }
  const duplicateNames: DuplicateName[] = []
  for (const [name, layers] of layersByName) {
    if (layers.length < 2) continue
    duplicateNames.push({ name, layers, count: countByName.get(name) ?? 0 })
  }
  duplicateNames.sort((a, b) => a.name.localeCompare(b.name))

  // Resolvable rows with activation state (mirrors market/check.ts's
  // resolvableEntries: group rows are always required; literal disabled state
  // combines with the parent chain; `!!js` disabled is conditional).
  type Disabled = 'active' | 'disabled' | 'conditional'
  const stateOf = (value: unknown): Disabled => {
    if (value !== null && typeof value === 'object' && '__jsExpr' in value) return 'conditional'
    return Boolean(value) ? 'disabled' : 'active'
  }
  const combine = (parent: Disabled, own: Disabled): Disabled => {
    if (parent === 'disabled' || own === 'disabled') return 'disabled'
    if (parent === 'conditional' || own === 'conditional') return 'conditional'
    return 'active'
  }
  const resolvableRows: Composed['resolvableRows'] = []
  const walkActivation = (list: EntryNode[], inheritedLayer?: string, parentDisabled: Disabled = 'active'): void => {
    for (const node of list) {
      const layer = node.layer ?? inheritedLayer
      if (layer === undefined) continue
      const descendantsDisabled = combine(parentDisabled, stateOf(node.disabled))
      const activation = node.group === true ? 'required' : descendantsDisabled
      if (activation !== 'disabled') {
        resolvableRows.push({
          id: node.id,
          layer,
          name: node.name,
          activation: activation === 'conditional' ? 'conditional' : 'required',
        })
      }
      if (node.group === true && Array.isArray(node.config)) {
        walkActivation(node.config as EntryNode[], layer, descendantsDisabled)
      }
    }
  }
  walkActivation(tree)

  return { rows, duplicates, duplicateNames, overrides, orphans, hasOrphans: orphans.length > 0, resolvableRows, nodes: tree }
}

/** Read a patch layer from a file, capturing a parse error instead of throwing. */
export function readPatchLayer(label: string, kind: LayerInput['kind'], path: string): LayerInput {
  let patches: unknown[] | null
  try {
    patches = parsePatchFile(path)
  } catch {
    patches = null
  }
  if (!existsSync(path)) {
    return { label, kind, patches: [], parseError: null, path }
  }
  if (patches === null) {
    return { label, kind, patches: [], parseError: 'patch file is not a valid entry list', path }
  }
  return { label, kind, patches, parseError: null, path }
}