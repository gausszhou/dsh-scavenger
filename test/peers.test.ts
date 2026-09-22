import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compareSemver, satisfiesRange } from '../src/checker/peers.ts'

describe('compareSemver', () => {
  it('orders plain versions', () => {
    assert.ok(compareSemver('1.0.0', '2.0.0') < 0)
    assert.ok(compareSemver('1.10.0', '1.9.9') > 0)
    assert.ok(compareSemver('1.2.3', '1.2.3') === 0)
  })
  it('orders prereleases below the release', () => {
    assert.ok(compareSemver('1.2.3-beta.1', '1.2.3') < 0)
    assert.ok(compareSemver('1.2.3-rc.2', '1.2.3-beta.9') > 0)
  })
})

describe('satisfiesRange', () => {
  it('handles exact and wildcard ranges', () => {
    assert.equal(satisfiesRange('1.2.3', '1.2.3'), true)
    assert.equal(satisfiesRange('1.2.4', '1.2.3'), false)
    assert.equal(satisfiesRange('3.1.4', '*'), true)
  })
  it('handles caret bounds', () => {
    assert.equal(satisfiesRange('1.9.9', '^1.2.3'), true)
    assert.equal(satisfiesRange('2.0.0', '^1.2.3'), false)
    assert.equal(satisfiesRange('0.2.9', '^0.2.0'), true)
    assert.equal(satisfiesRange('0.3.0', '^0.2.0'), false)
    assert.equal(satisfiesRange('0.0.3', '^0.0.3'), true)
    assert.equal(satisfiesRange('0.0.4', '^0.0.3'), false)
  })
  it('handles tilde bounds', () => {
    assert.equal(satisfiesRange('1.2.9', '~1.2.3'), true)
    assert.equal(satisfiesRange('1.3.0', '~1.2.3'), false)
  })
  it('handles >= <= > < comparators', () => {
    assert.equal(satisfiesRange('2.0.0', '>=1.0.0'), true)
    assert.equal(satisfiesRange('0.9.0', '>=1.0.0'), false)
    assert.equal(satisfiesRange('1.5.0', '<=1.0.0'), false)
    assert.equal(satisfiesRange('2.1.0', '>2.0.0'), true)
    assert.equal(satisfiesRange('2.0.0', '>2.0.0'), false)
    assert.equal(satisfiesRange('2.0.0', '<2.0.1'), true)
  })
  it('handles || alternatives', () => {
    assert.equal(satisfiesRange('1.2.0', '^2.0.0 || ^1.0.0'), true)
    assert.equal(satisfiesRange('1.9.9', '^2.0.0 || ^1.0.0'), true)
    assert.equal(satisfiesRange('3.0.0', '^2.0.0 || ^1.0.0'), false)
  })
  it('handles comparator sets', () => {
    assert.equal(satisfiesRange('1.8.0', '>=1.0.0 <2.0.0'), true)
    assert.equal(satisfiesRange('2.0.0', '>=1.0.0 <2.0.0'), false)
  })
  it('gates prereleases per npm set-level rule', () => {
    // A prerelease version does not match a set without a matching prerelease comparator.
    assert.equal(satisfiesRange('1.3.0-beta.1', '^1.2.0'), false)
    // includePrerelease opts in.
    assert.equal(satisfiesRange('1.3.0-beta.1', '^1.2.0', { includePrerelease: true }), true)
    // A set carrying the same-tuple prerelease admits it.
    assert.equal(satisfiesRange('1.3.0-beta.1', '>=1.3.0-beta.1 <2.0.0'), true)
  })
  it('normalizes workspace: ranges', () => {
    // workspace:* normalizes to the exact version.
    assert.equal(satisfiesRange('1.2.3', 'workspace:*'), true)
  })
  it('accepts partial version targets (engines style >=18)', () => {
    assert.equal(satisfiesRange('24.19.0', '>=18'), true)
    assert.equal(satisfiesRange('16.0.0', '>=18'), false)
    assert.equal(satisfiesRange('18.2.9', '^18'), true)
    assert.equal(satisfiesRange('19.0.0', '^18'), false)
    assert.equal(satisfiesRange('18.2.9', '~18.2'), true)
    assert.equal(satisfiesRange('18.3.0', '~18.2'), false)
  })
  it('returns null (indeterminate) for unparseable ranges, never false-positive', () => {
    assert.equal(satisfiesRange('1.2.3', 'banana'), null)
    assert.equal(satisfiesRange('not-a-version', '^1.0.0'), null)
  })
})