/**
 * Minimal semver subset matcher for peer-dependency range checks.
 *
 * Supported syntax (mirrors what dsh-market/check.ts supports, same semantics):
 * `*`, exact, `^`, `~`, `>=`, `>`, `<=`, `<`, whitespace-separated comparator
 * sets, `||` alternatives, and `workspace:` protocol normalization. Anything
 * else returns `null` (unknown — reported, never asserted).
 *
 * Prerelease handling follows npm's set-level rule: a version carrying a
 * prerelease tag only satisfies a set when at least one comparator in that set
 * shares the version's [major, minor, patch] tuple AND carries a prerelease of
 * its own.
 */

interface Semver {
  major: number
  minor: number
  patch: number
  pre: string[]
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
/** Partial range targets: "18", "18.2", "18.2.0" — missing fields pad to 0. */
const PARTIAL_RE = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/

function parseSemver(value: string): Semver | null {
  const m = SEMVER_RE.exec(value.trim())
  if (m === null) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    pre: m[4] === undefined ? [] : m[4].split('.'),
  }
}

/** Parse an npm-style range target, allowing partial version numbers. */
function parseRangeTarget(value: string): Semver | null {
  const full = parseSemver(value)
  if (full !== null) return full
  const m = PARTIAL_RE.exec(value.trim())
  if (m === null) return null
  return { major: Number(m[1]), minor: Number(m[2] ?? 0), patch: Number(m[3] ?? 0), pre: [] }
}

function comparePre(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i += 1) {
    const x = a[i]
    const y = b[i]
    if (x === undefined) return y === undefined ? 0 : -1
    if (y === undefined) return 1
    if (x === y) continue
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) return Number(x) - Number(y) || 0
    if (xn) return -1
    if (yn) return 1
    return x < y ? -1 : 1
  }
  return 0
}

export function compareSemver(a: string, b: string): number {
  const av = parseSemver(a)
  const bv = parseSemver(b)
  if (av === null || bv === null) return a < b ? -1 : a > b ? 1 : 0
  if (av.major !== bv.major) return av.major - bv.major || 0
  if (av.minor !== bv.minor) return av.minor - bv.minor || 0
  if (av.patch !== bv.patch) return av.patch - bv.patch || 0
  if (av.pre.length === 0 && bv.pre.length === 0) return 0
  if (av.pre.length === 0) return 1
  if (bv.pre.length === 0) return -1
  return comparePre(av.pre, bv.pre)
}

function toStr(v: Semver): string {
  return `${v.major}.${v.minor}.${v.patch}${v.pre.length > 0 ? `-${v.pre.join('.')}` : ''}`
}

function gte(a: Semver, b: Semver): boolean {
  return compareSemver(toStr(a), toStr(b)) >= 0
}

function single(part: string, v: Semver): boolean | null {
  const p = part.trim()
  if (p === '' || p === '*' || p === 'x' || p === 'X') return true
  const m = /^(\^|~|>=|<=|>|<)?(.*)$/.exec(p)
  const op = m?.[1] ?? ''
  const target = (m?.[2] ?? '').trim()
  const tv = parseRangeTarget(target)
  if (tv === null) return null
  const { major, minor, patch } = tv
  switch (op) {
    case '':
      return compareSemver(toStr(v), target) === 0
    case '>=':
      return gte(v, tv)
    case '<=':
      return gte(tv, v)
    case '>':
      return compareSemver(toStr(v), target) > 0
    case '<':
      return compareSemver(toStr(v), target) < 0
    case '^': {
      const upper: Semver = major > 0
        ? { major: major + 1, minor: 0, patch: 0, pre: [] }
        : minor > 0
          ? { major: 0, minor: minor + 1, patch: 0, pre: [] }
          : { major: 0, minor: 0, patch: patch + 1, pre: [] }
      return gte(v, tv) && compareSemver(toStr(upper), toStr(v)) > 0
    }
    case '~': {
      const upper: Semver = { major, minor: minor + 1, patch: 0, pre: [] }
      return gte(v, tv) && compareSemver(toStr(upper), toStr(v)) > 0
    }
    default:
      return null
  }
}

function comparator(part: string): { op: string; target: string } | null {
  const p = part.trim()
  if (p === '' || p === '*' || p === 'x' || p === 'X') return { op: '', target: '' }
  const m = /^(\^|~|>=|<=|>|<)?(.*)$/.exec(p)
  if (m === null) return null
  const target = (m[2] ?? '').trim()
  if (parseRangeTarget(target) === null) return null
  return { op: m[1] ?? '', target }
}

function evaluateSet(set: string, v: Semver, includePrerelease: boolean): boolean | null {
  const parts = set.trim().split(/\s+/).filter((part) => part !== '')
  if (parts.length === 0) return true
  const parsed = parts.map((part) => comparator(part))
  if (parsed.some((part) => part === null)) return null
  const versionHasPre = v.pre.length > 0
  if (versionHasPre && !includePrerelease) {
    const admitted = parsed.some((part) => {
      if (part?.target === '') return false
      const tv = parseSemver(part?.target ?? '')
      return tv !== null && tv.pre.length > 0
        && v.major === tv.major && v.minor === tv.minor && v.patch === tv.patch
    })
    if (!admitted) return false
  }
  const results = parsed.map((part) => single(`${part?.op ?? ''}${part?.target ?? ''}`, v))
  if (results.some((r) => r === null)) return null
  return results.every((r) => r === true)
}

/**
 * Whether `version` satisfies `range`. Returns:
 * - `true` / `false` when determinable;
 * - `null` when the range or version cannot be evaluated.
 */
export function satisfiesRange(version: string, range: string, options: { includePrerelease?: boolean } = {}): boolean | null {
  const v = parseSemver(version)
  if (v === null) return null
  let normalized = range
  // Mirror pnpm's peer-dependency workspace: transform.
  if (range.includes('workspace:')) {
    normalized = range.replace(/workspace:([\^~*]|>=|>|<=|<)?((\d+|[xX*])(\.(\d+|[xX*])){0,2})?/, (match, op: string | undefined, ver: string | undefined) => {
      if (ver === undefined) return `${op === '*' ? '' : (op ?? '')}${toStr(v)}`
      return range.replace('workspace:', '')
    })
  }
  if (normalized.includes('||')) {
    const outcomes = normalized.split('||').map((part) => evaluateSet(part, v, options.includePrerelease ?? false))
    if (outcomes.some((o) => o === true)) return true
    if (outcomes.some((o) => o === null)) return null
    return false
  }
  return evaluateSet(normalized, v, options.includePrerelease ?? false)
}