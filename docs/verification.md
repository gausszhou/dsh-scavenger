# dsh-scavenger — 实测验证与测试

> 本文档承接 README 中"实测验证"与测试信息：坏插件夹具全链、真实 profile 结果、
> 单测说明。（由 README 迁移而来）

## 1. 坏插件夹具全链（隔离 `DSH_HOME=/tmp/gdn-home`，4 种错误形态）

```text
$ dsh-scavenger --profile gdn-demo --home /tmp/gdn-home
summary: 1 error / 1 warning / 0 info
— cleanup plan (1 culprit row) —
  ✗ disable webserver (gdn-required-does-not-exist)  [ROW_PACKAGE_MISSING]   # 必需条目行
  target: /tmp/gdn-home/profiles/gdn-demo/cordis.patch.yml
→ 1 culprit row(s) found. Re-run with --apply to disable them ...
$ echo $?                    # 1

$ dsh-scavenger --profile gdn-demo --home /tmp/gdn-home --apply
✓ Applied: disabled 1 row(s) in .../cordis.patch.yml
  backup: .../.dsh-scavenger/backups/2026-09-22T08-37-10-007Z
  re-check after cleaning: no residual errors.
$ echo $?                    # 0

$ dsh-scavenger rollback --profile gdn-demo --home /tmp/gdn-home
✓ restored .../cordis.patch.yml from .../cordis.patch.yml
$ dsh-scavenger check --profile gdn-demo --home /tmp/gdn-home --no-inspect | grep summary
summary: 1 error / 1 warning / 0 info   # 逐字节还原，坏行重新激活
```

与 DSH 真实启动错误逐一对上：`Cannot find package 'gdn-package-does-not-exist-xyz'
imported from <profileDir>/`、「Cannot find package '@deepseek-ai/schemastery'」、
「pending (waiting for service: gdnMissingService)」。**0.1.6+ required-entry 语义**：
只有行 id 属于 DSH 全局必需集合（此处 `webserver`）的缺包报告为 error 并进入清理计划；
普通三方行（`gdn-nonexistent`）降为 warning——启动继续，仅产生启动诊断日志。
激活抛错的 thrower 是**合法契约**的插件（模块可加载、apply 才抛错），静态预检正确地
不清理它——那属于运行期观察（后续规划）。

## 2. 真实 profile（`~/.dsh/profiles/web`，DSH 0.2.0-rc.2，dsh-base + dsh-web-app 多文件 patch）

```text
$ dsh-scavenger --profile web
summary: 0 error / 0 warning / 52 info
✓ No culprit rows found — nothing to clean.
```

0.2.0-rc.2 下 web-app 的 `dsh.bundle.patch` 是有序 5 文件列表（cordis.patch.yml +
presets/*.patch.yml），组合层按序拼接成一层（与 DSH `composeEntries` flat 语义一致）；
行级官方包全部解析到 dsh 安装目录（0.1.6+ 运行时解析，profile 不再投影 node_modules）。
52 条 info = 31 LAYER_OVERRIDE（多层 preset 正常覆盖）+ 5 CONTRACT_INJECT_UNVERIFIED
（官方层，info）+ 16 CONTRACT_CONFIG_DYNAMIC（`!!js` 表达式 config）。全量契约检视
（worker 沙箱逐个加载插件模块）对 0.2.0 官方插件正常生效。服务目录由**运行时扫描**
提供者注册模式（`ctx.provide('x')` / `super(ctx, 'x')` / `const X = "x"; provide(X)`）
自动推导，零手工维护。

### 2.1 purge 实测（混合 profile：三方裸包 ×2 + core + cordis: + 本地文件）

```text
$ dsh-scavenger purge --profile web --home /tmp/gdn-home
summary: 3 error / 0 warning / 0 info
— purge plan (2 third-party plugin rows) —
  ✗ disable chatluna (chatluna)  [PURGE_THIRD_PARTY]
  ✗ disable gdn-kit (@gausszhou/dsh-kit)  [PURGE_THIRD_PARTY]
→ 2 third-party row(s) found. Re-run with --apply to disable them all ...

$ dsh-scavenger purge --profile web --home /tmp/gdn-home --apply
✓ Applied: disabled 2 row(s) in .../cordis.patch.yml
  backup: .../.dsh-scavenger/backups/...   # rollback 可逐字节还原

$ dsh-scavenger rollback --profile web --home /tmp/gdn-home
✓ restored .../cordis.patch.yml from ...
```

`@deepseek-ai/cordis-plugin-group`（core）、`cordis:timer`（内建）、`./plugins/local.js`
（本地文件）均被保留；只有 bare 三方裸包行被禁用。

## 3. 单元测试

49 项单测覆盖：组合层（compose）、解析层（resolve）、semver-peer（peers）、检查编排
（checker，含 required-entry 严重度分级断言）、清理全链（cleaner：plan → apply →
复检 → rollback，含必需条目缺包行的归属断言）、purge 三方判定/计划/回滚（purge），
以及 0.2 兼容专项：`dsh.bundle.patch` 有序多文件按序拼接（共享 entryMap）、
resolveRowName 的 dsh 安装兜底（0.1.6+ 运行时解析）、缺失声明文件报错。

```bash
npm test            # node --test（49 项单测）
npm run typecheck   # tsc --noEmit
```