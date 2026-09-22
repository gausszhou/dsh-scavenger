# dsh-scavenger 🧹🛡️

清扫 DeepSeek Harness (DSH) profile：静态分析找出**导致报错的插件**并**清理**它们
（plan → apply，自动备份可回滚）。不启动 DSH、不导入插件代码（契约检查在隔离的
worker 线程沙箱里进行）。

> 状态：**可用**（v0.1.0）。静态分析（组合/解析/契约层）+ 清理（plan/dry-run、`--apply`
> 写盘、rollback 回滚）+ 安装前 gate。TypeScript + ESM。
> 前身 `dsh-plugin-guardian`（原定位：纯检查守卫）已并入本仓库并重构。

## 定位（一句话）

DSH 对"插件装不上/激活失败"已经是 fail-loud（启动即点名报错并退出）；dsh-market 已覆盖
"组合层静态分析+热开关"；dsh-doctor 已覆盖"环境诊断+可逆修复"；upstream-radar 做"外部
跨版本验证"。**scavenger 补的是中间那块空白：插件契约级预检（inject / Config schema /
导出形态 / `!!js` / engines / peers）+ 把导致报错的插件行禁用掉（`--apply`），全程
不手改文件、可一键回滚。**

## 安装与使用

```bash
pnpm install        # 依赖 schemastery / commander / js-yaml，Node >= 20
npm run build       # tsdown → lib/（esm + d.ts）
```

```bash
# 主命令：找出导致报错的插件（dry-run，绝不会写盘）
dsh-scavenger --profile web

# 清理：把导致报错的插件行禁用到 profile 的 cordis.patch.yml（自动备份）
dsh-scavenger --profile web --apply

# 回滚/查看备份 / 纯检查 / 安装前门禁
dsh-scavenger rollback [backupId] --profile web
dsh-scavenger backups --profile web
dsh-scavenger check --profile web [--json]
dsh-scavenger gate ./my-plugin-bundle [--host-profile web] [--json]
```

**退出码**：主命令与 check 均为 `0` = 干净（或已清理干净）；`1` = 存在会阻断启动的
插件（plan 已展示，`--apply` 才会动手）。`--apply` 后仍有 `1` = 残余错误不可通过禁用行
清除。`2` = 用法/IO 故障。

**常见组合**：

```bash
dsh-scavenger --profile web --apply && dsh web        # 先清后启
```

## 清理语义（安全模型）

- **dry-run 默认**：不带 `--apply` 时只读不写，输出"将禁用哪些行 + 原因 + 写目标"。
- **只禁行，不动插件**：对每个"会阻断启动的启用行"追加 `- id: <row>\n  disabled: true`
  到 profile 的 `cordis.patch.yml`（profile 层 patch 可覆盖任何更早的 bundle 层行；
  该文件不存在则创建）。
- **写前双门禁**：合并后的文档用 DSH 同款 YAML 方言重新 parse 必须成功；每个计划行
  必须能在最终文档中找到对应的 `disabled: true` 行——**never made worse**。
- **自动备份**：每次 `--apply` 把原文件快照到
  `<profileDir>/.dsh-scavenger/backups/<时间戳>/` 并记录 `state.json`；
  `rollback` 逐字节恢复并移除该备份。
- **不碰 root `cordis.yml`**（DSH 每 boot 重写为 `[]`），也不改插件包文件。

## 检查项（代码 → 语义，与 DSH 启动错误一一对应）

| 层 | 代码 | 严重度 | 对应 DSH 启动行为 |
|---|---|---|---|
| A 组合 | `BUNDLE_LAYER_ERROR` / `PATCH_PARSE_ERROR` | error | patch 文件坏 → 层被跳过，行丢失 |
| A 组合 | `DUPLICATE_ENTRY_ID` | error | 同 id 多行：后写覆盖且 boot 审计点名 |
| A 组合 | `DUPLICATE_PLUGIN_NAME` | warning | 跨层同名 → 后者运行时遮蔽前者 |
| A 组合 | `ORPHAN_PATCH_ROW` | warning | 目标不存在 → warn+skip |
| A 组合 | `LAYER_OVERRIDE` | info | 合法但需知情的覆盖（同 id 行替换） |
| B 解析 | `ROW_PACKAGE_MISSING` | error | `Cannot find package '<pkg>' imported from <profileDir>/` |
| B 解析 | `ROW_FILE_MISSING` | warning | 相对/绝对路径行指向不存在的文件 |
| B 解析 | `ROW_INVALID_SPECIFIER` / `ROW_MISSING_NAME` | error | Loader 无法导入 → 启动失败 |
| B 解析 | `CORE_AS_DEPENDENCY` | error | 插件把 `@deepseek-ai/dsh*` 装成普通依赖 → 遮蔽宿主版本 |
| B 解析 | `MULTI_VERSION_CORE` | error | lockfile 里多个核心版本 → pnpm 提升歧义 |
| B 解析 | `PEER_RANGE_MISMATCH` | warning | peer 区间与解析到的实际版本不符 |
| C 契约 | `CONTRACT_IMPORT_FAILED` | warning | `Cannot find package 'X' imported from <module>` |
| C 契约 | `CONTRACT_PLUGIN_SHAPE` | error | 默认导出不是 Cordis 插件 → 激活即挂 |
| C 契约 | `CONTRACT_CONFIG_INVALID` | error | 行配置未过声明的 Standard Schema → ValidationError |
| C 契约 | `CONTRACT_INJECT_UNVERIFIED` | warning | inject 服务无已知提供者 → PENDING 永久挂起 |
| C 契约 | `CONTRACT_CONFIG_DYNAMIC` | info | 配置含 `!!js` 表达式（`ctx.service` 等）→ 校验留给运行期 |
| Gate | `GATE_ENGINES_DSH` / `GATE_BUNDLE_PATCH_MISSING` 等 | error | 安装前即可拒绝的硬不兼容 |

**可清理（会被 `--apply` 禁用的）error 码**：`ROW_PACKAGE_MISSING`、`ROW_FILE_MISSING`、
`ROW_INVALID_SPECIFIER`、`CONTRACT_PLUGIN_SHAPE`、`CONTRACT_IMPORT_FAILED`、
`CONTRACT_CONFIG_INVALID`。warning/info 与运行期错误（apply 抛错）**不自动清理**——
运行期归因属于后续规划（见 `docs/design.md`）。

## 文档

- `docs/design.md` — 设计方案（生态定位、总体架构、检查项分级 A–E、里程碑）与实现要点
- `docs/research.md` — DSH 插件体系调研（架构、错误形态实测、生态对照、版本差异）
- `docs/verification.md` — 实测验证与测试（坏插件夹具全链、真实 profile 结果、单测说明）
- `docs/structure.md` — 目录结构与模块职责