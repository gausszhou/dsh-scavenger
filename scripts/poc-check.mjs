#!/usr/bin/env node
/**
 * dsh-plugin-guardian 可行性验证 PoC（M1 原型的最小切片）
 *
 * 使用 @deepseek-ai/dsh-app-boot 导出的纯函数（loadProfile / composeEntries /
 * loadOptionalPatches）对一个 profile 做"不启动"的组合与解析层静态预检：
 *   - patch 解析错误（loadOptionalPatches 抛出）
 *   - 组合警告（orphan 行 / name 不匹配）
 *   - 行引用的裸包在 profile 可见 node_modules 祖先中不可解析
 *   - bundle 层清单一致性（dsh.profile.bundles 声明的包是否可解析）
 *
 * 不导入任何插件模块、不启动 DSH、不写文件。契约层（inject / Config schema）
 * 需要 vm 沙箱检视，属于 M2，不在本 PoC。
 */
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DSH_INSTALL = '/home/gauss/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh'
// 从 dsh 安装锚点解析内部包（与 DSH 启动解析一致）
const dshRequire = createRequire(join(DSH_INSTALL, 'package.json'))
const { loadProfile, composeEntries, loadOptionalPatches } = await import(
  pathToFileURL(dshRequire.resolve('@deepseek-ai/dsh-app-boot')).href
)

const NAME = 'dsh-plugin-guardian:poc'

function packageRoot(specifier) {
  if (specifier.startsWith('.') || specifier.startsWith('#') || specifier.startsWith('cordis:') ||
      /^[a-z][a-z\d+.-]*:/i.test(specifier) || isBuiltin(specifier)) return null
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** 包是否在 profile 可见的 node_modules 祖先中存在（与 market/check.ts 同思路）。 */
function installedInAncestry(profileDir, name) {
  let dir = resolve(profileDir)
  while (true) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function report(profileName, home) {
  const profile = loadProfile(NAME, profileName, join(DSH_INSTALL, 'package.json'), home, { userLayer: true })
  const out = { profile: profileName, dir: profile.dir, errors: [], warnings: [], info: [] }

  // 1. bundle 层清单
  const manifests = profile.layers.map((l) => l.packageName)
  for (const name of manifests) {
    const hit = installedInAncestry(profile.dir, name) ?? installedInAncestry(dirname(profile.dir), name)
    if (!hit) out.errors.push(`bundle ${name}: 声明在 dsh.profile.bundles 但在 profile 可见 node_modules 中找不到`)
    else out.info.push(`bundle ${name}: -> ${hit}`)
  }

  // 2. 用户层 patch 解析（解析失败=硬错误）
  let userPatches
  try {
    userPatches = loadOptionalPatches(NAME, profile.patchPath) ?? []
  } catch (err) {
    out.errors.push(`patch 解析失败 ${profile.patchPath}: ${err.message}`)
    userPatches = []
  }

  // 3. 组合（bundle 层 + 用户层），warn 收集 orphan/name 不匹配
  const warns = []
  const layers = [
    ...profile.layers.map((l) => l.patches),
    userPatches,
  ]
  const rows = composeEntries(layers, (msg) => warns.push(msg))
  for (const w of warns) out.warnings.push(`组合警告: ${w}`)

  // 4. 有效行的裸包可解析性
  const seen = new Set()
  const walk = (list) => {
    for (const row of list) {
      if (typeof row.id === 'string') {
        const key = `${row.id}::${row.name}`
        if (!seen.has(key)) {
          seen.add(key)
          if (typeof row.name === 'string') {
            const pkg = packageRoot(row.name)
            if (pkg) {
              const hit = installedInAncestry(profile.dir, pkg)
              if (!hit) {
                out.errors.push(`行 ${row.id} 引用的包 ${pkg} (${row.name}) 在 profile 可见 node_modules 中不存在 —— 启动时将 "Cannot find package"（实测形态3）`)
              } else {
                out.info.push(`行 ${row.id} -> ${hit}`)
              }
            } else if (row.name !== '' && !row.name.startsWith('cordis:')) {
              out.info.push(`行 ${row.id} name=${row.name} 非裸包（相对/绝对/子路径），跳过解析检查`)
            }
          } else if (row.name === undefined && row.group !== true) {
            out.warnings.push(`行 ${row.id} 没有 name 且非 group —— 激活时无模块可装载`)
          }
        }
      }
      if (row.group === true && Array.isArray(row.config)) walk(row.config)
    }
  }
  walk(rows)

  return out
}

const profileName = process.argv[2] ?? 'web'
const home = process.env.DSH_HOME ?? '/home/gauss/.dsh'
const r = report(profileName, home)
console.log(`\n=== dsh-plugin-guardian PoC check: ${r.profile} @ ${r.dir} ===`)
for (const e of r.errors) console.log('ERROR  ', e)
for (const w of r.warnings) console.log('WARN   ', w)
for (const i of r.info) console.log('info   ', i)
console.log(`\n结论: ${r.errors.length} errors, ${r.warnings.length} warnings`)
process.exit(r.errors.length > 0 ? 1 : 0)