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
# 检查（只读）/ 发现 profile
dsh-scavenger check --profile web [--json]
dsh-scavenger list

# 清理：plan（dry-run 只出计划，绝不写盘）→ apply（写盘，自动备份）
dsh-scavenger plan --profile web                    # 出计划
dsh-scavenger plan --profile web --out plan.json    # 导出计划，供 apply --plan 复用
dsh-scavenger apply --profile web                   # 重新检查 → 写盘 → 复检
dsh-scavenger apply --profile web --plan plan.json  # 直接执行上次导出的计划

# 主命令是 plan/apply 的快捷方式（无子命令时的默认入口）
dsh-scavenger --profile web             # 等价 plan（dry-run）
dsh-scavenger --profile web --apply     # 等价 apply

# 回滚/查看备份 / 安装前门禁（--host-profile 为 --profile 的旧名）
dsh-scavenger rollback [backupId] --profile web
dsh-scavenger backups --profile web
dsh-scavenger gate ./my-plugin-bundle [--profile web] [--json]

# 清理所有三方插件（区别于主命令：不看是否报错，凡非官方裸包插件行一律禁用）
dsh-scavenger purge --profile web              # dry-run 计划
dsh-scavenger purge --profile web --apply      # 写盘（自动备份，可 rollback）
```

**退出码**（check / plan / apply / 主命令 / purge / gate）：`0` = 干净（或已清理干净）；
`1` = 存在会阻断启动的插件，或计划待执行（plan 只展示，apply 才写盘）；apply 后仍有
`1` = 残余错误不可通过禁用行清除；`2` = 用法/IO 故障。

**常见组合**：

```bash
dsh-scavenger --profile web --apply && dsh web        # 先清后启
```

## 文档

- `docs/design.md` — 设计方案（生态定位、总体架构、检查项分级 A–E、里程碑）与实现要点
- `docs/research.md` — DSH 插件体系调研（架构、错误形态实测、生态对照、版本差异）
- `docs/verification.md` — 实测验证与测试（坏插件夹具全链、真实 profile 结果、单测说明）
- `docs/structure.md` — 目录结构与模块职责