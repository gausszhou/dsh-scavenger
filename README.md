# dsh-scavenger 🧹🛡️

清扫 DeepSeek Harness (DSH) profile：静态分析找出**导致报错的插件**并**清理**它们
（plan → apply，自动备份可回滚）。不启动 DSH、不导入插件代码（契约检查在隔离的
worker 线程沙箱里进行）。

> 状态：**可用**（v0.1.0）。静态分析（组合/解析/契约层）+ 清理（plan/dry-run、`--apply`
> 写盘、rollback 回滚）+ 安装前 gate。TypeScript + ESM。
> 前身 `dsh-plugin-guardian`（原定位：纯检查守卫）已并入本仓库并重构。

## 定位

一个独立的 DSH 插件静态分析 CLI：扫描 profile 的**组合 / 解析 / 契约**三层，找出
**会导致 DSH 启动报错的插件行**（缺包、坏 specifier、非 Cordis 插件形态、Config
schema 不合法、inject 服务无提供者等），并安全地清理它们（`--apply` 追加
`disabled: true` 禁用行，自动备份、可回滚），另提供安装前门禁 `gate`。

实现上**不启动 DSH、不导入插件代码**：契约检视在隔离的 worker 线程沙箱中只读插件
声明（默认导出 / `.inject` / `.Config`，从不调用 `apply()`）；组合层语义精确镜像
DSH boot 的 `applyEntryPatches`。

## 安装与使用

```bash
npm install -g @gausszhou/dsh-scavenger   # 全局安装 CLI（Node >= 20）
```

本地开发构建：

```bash
pnpm install && npm run build             # tsdown → lib/（esm + d.ts）
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

## 文档

- `docs/design.md` — 设计方案（生态定位、总体架构、检查项分级 A–E、里程碑）与实现要点
- `docs/research.md` — DSH 插件体系调研（架构、错误形态实测、生态对照、版本差异）
- `docs/verification.md` — 实测验证与测试（坏插件夹具全链、真实 profile 结果、单测说明）
- `docs/structure.md` — 目录结构与模块职责