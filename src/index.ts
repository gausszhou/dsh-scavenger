/**
 * @gausszhou/dsh-scavenger — public API
 *
 * Scavenge a DeepSeek Harness profile: offline static analysis
 * (`analyzeProfile`) plus worker-isolated contract inspection
 * (`contractFindings`) that identify which plugins break boot, a cleanup
 * planner/applier with backup & rollback (`planCleanup`, `applyCleanup`,
 * `rollbackCleanup`), a pre-install gate (`gateCandidate`), and the
 * semver/peer matching primitives they share.
 */

export { analyzeProfile, checkProfile, corePackageNames, VERSION } from './checker/index.ts'
export type { CheckOptions } from './checker/index.ts'
export { satisfiesRange, compareSemver } from './checker/peers.ts'
export { composeLayers, parsePatchFile, parsePatchText, isJsExpr } from './checker/compose.ts'
export type { Composed, LayerInput, EntryNode, LoaderRowRecord } from './checker/compose.ts'
export {
  findDshInstallDir, resolveDshHome, resolveProfileDir, resolveRowName,
  resolveFileSpecifier, packageRoot, findInstalledPackage, INBOX_BUNDLES,
} from './checker/resolve.ts'
export { contractFindings, classifyInject, KNOWN_SERVICES } from './inspector/check.ts'
export { discoverServiceNames } from './inspector/services.ts'
export { inspectModule } from './inspector/index.ts'
export type { InspectedPlugin, ConfigValidation } from './inspector/index.ts'
export { gateCandidate } from './gate.ts'
export type { GateReport, GateOptions } from './gate.ts'
export {
  planCleanup, applyCleanup, rollbackCleanup, listBackups, disablePatchText, CLEANABLE_CODES,
} from './cleaner.ts'
export type { CleanupPlan, CleanupStep, ApplyResult, BackupEntry } from './cleaner.ts'
export type { CheckReport, Finding, Severity, LoaderRow, LoaderEntryNode, BundleInfo, ReportSummary } from './types.ts'