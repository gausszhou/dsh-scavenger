# dsh-scavenger — 实测验证与测试

> 本文档承接 README 中"实测验证"与测试信息：坏插件夹具全链、真实 profile 结果、
> 单测说明。（由 README 迁移而来）

## 1. 坏插件夹具全链（隔离 `DSH_HOME=/tmp/gdn-home`，4 种错误形态）

```text
$ dsh-scavenger --profile gdn-demo --home /tmp/gdn-home
summary: 1 error / 2 warning / 0 info
— cleanup plan (1 culprit row) —
  ✗ disable gdn-nonexistent (gdn-package-does-not-exist-xyz)  [ROW_PACKAGE_MISSING]
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
summary: 1 error / 0 warning / 0 info   # 逐字节还原，坏行重新激活
```

与 DSH 真实启动错误逐一对上：`Cannot find package 'gdn-package-does-not-exist-xyz'
imported from <profileDir>/`、「Cannot find package '@deepseek-ai/schemastery'」、
「pending (waiting for service: gdnMissingService)」。激活抛错的 thrower 是**合法契约**
的插件（模块可加载、apply 才抛错），静态预检正确地不清理它——那属于运行期观察（后续规划）。

## 2. 真实 profile（`~/.dsh/profiles/web`，约 150 行，dsh base + web-app + dsh-market）

```text
$ dsh-scavenger --profile web
summary: 0 error / 0 warning / 36 info
✓ No culprit rows found — nothing to clean.
```

全量契约检视（worker 沙箱逐个加载 ~150 个插件模块）约 2.5 秒。服务目录由**运行时扫描**
提供者注册模式（`ctx.provide('x')` / `super(ctx, 'x')` / `const X = "x"; provide(X)`）
自动推导，零手工维护。

## 3. 单元测试

41 项单测覆盖：组合层（compose）、解析层（resolve）、semver-peer（peers）、检查编排
（checker）与清理全链（cleaner：plan → apply → 复检 → rollback，含 4 形态坏夹具的
归属断言）。

```bash
npm test            # node --test（41 项单测）
npm run typecheck   # tsc --noEmit
```