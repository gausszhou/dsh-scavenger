# dsh-scavenger — 目录结构与模块职责

> 本文档承接 README 中"目录"一节（由 README 迁移而来）。

## 源码头（`src/`，约 3000 行 TypeScript）

| 路径 | 职责 |
|---|---|
| `src/checker/compose.ts` | 组合层：bundle/patch 分层合并，精确镜像 DSH boot 的 `applyEntryPatches` 语义（行 id 索引、后写覆盖、config 整行替换、insert、`!!js` 表达式节点、warn+skip） |
| `src/checker/resolve.ts` | 解析层：包存在性 / specifier / 路径行 / 核心包依赖 / DSH 安装目录与 profile 定位（`resolveDshHome`、`resolveProfileDir` 等） |
| `src/checker/peers.ts` | semver / peer 区间匹配（npm 集合级规则 + `includePrerelease`） |
| `src/checker/index.ts` | 分析编排：`analyzeProfile` / `checkProfile` / `corePackageNames` / `VERSION` |
| `src/inspector/index.ts` | worker 线程沙箱检视单个插件模块（只读声明：默认导出 / `.inject` / `.Config`，从不调用 `apply()`） |
| `src/inspector/check.ts` | 契约检查编排：`contractFindings` / `classifyInject` / `KNOWN_SERVICES` |
| `src/inspector/services.ts` | 服务目录推导：运行时扫描 `ctx.provide('x')` / `super(ctx, 'x')` 等提供者注册模式 |
| `src/cleaner.ts` | 清理计划 `planCleanup` / 应用 `applyCleanup`（备份 + 双门禁 + 写盘）/ `rollbackCleanup` / `listBackups` |
| `src/gate.ts` | 安装前门禁 `gateCandidate`（engines / bundle patch 缺失等硬不兼容） |
| `src/cli.ts` | 双 Command CLI（主命令与子命令独立实例，避免 commander 父子选项串味） |
| `src/types.ts` | 报告类型（`CheckReport` / `Finding` / `Severity` / `LoaderRow` 等） |
| `src/index.ts` | 公共 API 出口（checker / inspector / cleaner / gate / peers / types） |

## 测试（`test/`）

| 文件 | 覆盖 |
|---|---|
| `test/compose.test.ts` | 组合层语义 |
| `test/resolve.test.ts` | 解析层 |
| `test/peers.test.ts` | semver-peer 匹配 |
| `test/checker.test.ts` | 检查编排（含 4 形态坏夹具的归属断言） |
| `test/cleaner.test.ts` | 清理全链：plan → apply → 复检 → rollback |

共 41 项单测，见 `docs/verification.md`。

## 文档（`docs/`）

| 文件 | 内容 |
|---|---|
| `docs/design.md` | 设计方案（生态定位、总体架构、检查项分级 A–E、里程碑） |
| `docs/research.md` | DSH 插件体系调研（架构、错误形态实测、生态对照、版本差异） |
| `docs/verification.md` | 实测验证与测试 |
| `docs/structure.md` | 本文档 |

## 其他

| 路径 | 说明 |
|---|---|
| `scripts/poc-check.mjs` | 早期 M1 PoC（已被 `src/checker/resolve.ts` 取代） |
| `.research/` | 子代理完整调研报告（官方文档存档 / 安装包深挖 / market 能力矩阵） |
| `lib/` / `dist/` | 构建产物（tsdown → esm + d.ts） |