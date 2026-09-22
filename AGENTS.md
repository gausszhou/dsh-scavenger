# AGENTS.md — 给 AI 代理的工作指引

> 面向在此仓库工作的 AI 代理（与人类协作者）。先读本文件再动手。

## 项目是什么

`@gausszhou/dsh-scavenger`：清扫 DeepSeek Harness (DSH) profile 的静态分析 CLI——
找出**导致 DSH 启动报错的插件**（组合/解析/契约三层检查），并安全地清理它们
（plan → `--apply` 禁行 → 自动备份 → rollback 回滚）。不启动 DSH、不导入插件代码
（契约检查在隔离 worker 线程沙箱进行）。

## 常用命令

```bash
pnpm install        # 依赖 schemastery / commander / js-yaml，Node >= 20
npm run build       # tsdown → lib/（esm + d.ts）
npm test            # node --import tsx --test test/*.test.ts（41 项单测）
npm run typecheck   # tsc --noEmit
```

改代码后**必须**跑 `npm test` 与 `npm run typecheck`，两者全绿才算完成。

## 仓库布局

- `src/checker/` — 组合层（compose：镜像 DSH boot 的 `applyEntryPatches` 语义）、
  解析层（resolve）、semver/peer 匹配（peers）、分析编排（index）
- `src/inspector/` — worker 线程沙箱检视插件模块（index）、契约检查编排（check）、
  服务目录推导（services）
- `src/cleaner.ts` — 清理计划 / apply（备份 + 双门禁 + 写盘）/ rollback
- `src/gate.ts` — 安装前门禁；`src/cli.ts` — 双 Command CLI；`src/types.ts` — 报告类型
- `test/*.test.ts` — node:test 单测
- `docs/` — design（方案与实现要点）、research（DSH 调研）、verification（实测验证与测试）、
  structure（目录结构）。**新文档放这里，不要进 README**

## 铁律（违反即改动不合格）

1. **`.research/` 永不提交**：已被 `.gitignore` 忽略、不在 git 跟踪中。不要 `git add -f`
   或引入其中内容。
2. **README 只讲"做了什么 + 如何使用"**：设计细节、实测验证、目录结构一律放 `docs/`。
3. **契约检视绝不调用 `apply()`**：inspector 只在一次性 worker 里读模块声明
   （默认导出 / `.inject` / `.Config`），有界超时、结束 terminate。
4. **清理安全模型不可破坏**：dry-run 默认；只往 profile 的 `cordis.patch.yml` 追加
   `disabled: true` 行；写前双门禁（DSH 方言重 parse 成功 + 计划行能在最终文档找到）；
   每次 `--apply` 先快照备份；**绝不写 root `cordis.yml`、绝不改插件包文件**。
5. **组合层语义必须与 DSH boot 一致**：`composeLayers` 对齐 `applyEntryPatches`
   （id 索引、后写覆盖、config 整行替换、insert 进组/顶层、`!!js` 表达式节点、warn+skip）。
6. **CLI 双 Command 实例**：主命令与子命令是独立 Command——commander 会把父级同名选项
   吞进子命令，独立实例保证 `--profile/--home/--json` 语义一致。新增子命令时遵循此模式。
7. **可清理错误码白名单**：只有 `CLEANABLE_CODES`（如 `ROW_PACKAGE_MISSING`、
   `CONTRACT_CONFIG_INVALID`）的 error 发现会被计划禁用；warning/info 与运行期错误
   不自动清理。新增 error 码时想清楚是否应纳入清理。
8. **禁止直接推送 `main`**：包括普通 push 与 force push。代码变更应先在分支上完成，
   或经用户明确授权后再合并/推送。

## 约定

- 代码注释与文档用**中文**（与现有仓库一致）；git 提交信息用**英文**（与现有历史一致）。
- 前端无框架：TypeScript + ESM，`import` 带 `.ts` 后缀（如 `./checker/compose.ts`）。
- 新增检查项时：`src/types.ts` 定 Finding 类型 → checker/inspector 产发现 →
  测试补断言 → `docs/design.md` 检查项清单同步。
- 报告与 CLI 输出保持机器可读能力（`--json`），退出码语义：`0` 干净 / `1` 有阻断插件 /
  `2` 用法或 IO 故障，不得随意更改。