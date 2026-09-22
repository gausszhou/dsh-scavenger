/**
 * Shared report types for dsh-plugin-guardian.
 *
 * A `Finding` is one diagnosed issue with a stable machine-readable `code`,
 * a severity tier, and optional provenance (which layer / entry / plugin it
 * refers to). `CheckReport` is the full offline analysis of one profile.
 */

export type Severity = 'error' | 'warning' | 'info'

export interface Finding {
  /** Stable machine-readable code, e.g. `DUPLICATE_ENTRY_ID`. */
  code: string
  severity: Severity
  /** Human-readable message (bilingual-friendly single line). */
  message: string
  /** Patch-layer provenance (bundle package name, `user-patch`, `home-patch`, overlay label). */
  layer?: string
  /** Loader row id this finding refers to. */
  entryId?: string
  /** npm package / module specifier this finding refers to. */
  plugin?: string
  /** Optional structured machine detail. */
  detail?: unknown
}

/** One composed loader row with layer provenance. */
export interface LoaderRow {
  id: string
  layer: string
  name?: string
  group?: boolean
}

/** One bundle layer of the profile stack. */
export interface BundleInfo {
  name: string
  kind: 'official' | 'community'
  /** Dependency spec from profile package.json; undefined when not a direct dep. */
  source?: string
  /** Resolved package directory; null when not installed. */
  directory: string | null
  /** Absolute patch file path; null when undeclared or missing. */
  patchPath: string | null
  /** Why this layer cannot load at boot (null = ok). */
  error: string | null
  /** Loader entry ids this bundle's patch inserts (top level). */
  entries: string[]
  /** An in-box bundle whose install dir could not be located (unknown, not broken). */
  unresolvedInbox?: boolean
}

export interface ReportSummary {
  errors: number
  warnings: number
  infos: number
}

export interface CheckReport {
  tool: 'dsh-scavenger'
  version: string
  profile: string
  profileDir: string
  /** Detected dsh installation dir (null when not located). */
  dshInstallDir: string | null
  scannedAt: string
  /** True when no `error`-severity finding exists. */
  ok: boolean
  summary: ReportSummary
  findings: Finding[]
  /** Composed loader rows (top-level + group children), most consumers can ignore. */
  rows: LoaderRow[]
  bundles: BundleInfo[]
  /** Final composed tree with layer tags; only present when `includeTree` was set. */
  nodes?: LoaderEntryNode[]
}

/** Composed loader entry (id/name/config/disabled/group) with layer provenance. */
export interface LoaderEntryNode {
  id: string
  name?: string
  layer?: string
  group?: boolean
  config?: unknown
  disabled?: unknown
  inject?: string[]
}