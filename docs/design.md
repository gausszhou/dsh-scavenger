# dsh-scavenger — 设计方案

> 目标：一个独立的 DSH 插件/工具，用于**检查其他插件的兼容性与错误**：启动前预检
> （pre-flight gate）、运行期错误观测与归因（watchdog & attribution）、以及安全的修复建议。
> 本方案基于对 DSH 0.1.5-rc.2（本机安装版）的实证调研（见 `docs/research.md`），并
> 明确与现有方案（dsh-market / dsh-doctor / upstream-radar / 官方诊断）差异化。

## 1. 生态定位（为什么还有空白）

| 方案 | 静态组合分析 | 环境健康 | 契约级检查(inject/schema/!!js) | 运行期错误归因 | 修复/回滚 | 独立 CLI |
|---|---|---|---|---|---|---|
| 官方 dsh | fail-loud 启动审计 | — | — | 报错文本(无结构化归因) | — | `--dump-config*` |
| dsh-market | ✅ 强(组合层) | ❌ | ❌ | ❌(拉取式 liveNames 而已) | ✅ 快照/回滚/热开关 | ❌(绑定 UI) |
| dsh-doctor | ❌(仅 bundle 存在性) | ✅ | ❌ | ⚠️ 只记 `fiber.name`(常为 unknown) | ✅ journal 可逆修复 | ✅ |
| upstream-radar | — | — | 真实验证(外部 VM 跨版本) | — | — | ✅(CI) |
| **scavenger** | 🔁 复用/泛化 market | — | ✅ **主打** | ✅ **主打：归因到 entry.id/包名/来源层/错误原因** | ✅ dry-run+原子 | ✅ |

Guardian 的差异化定位 = **插件契约级预检（静态、不启动） + 进程内运行期错误归因
（被动监听）**，并以独立 CLI/API/工具面输出机器可读结果。与 dsh-doctor 的关系：
doctor 管"环境/文件/进程层"，scavenger 管"插件契约与运行时行为层"——可以互相引用
（如 doctor 的 repair 建议由 scavenger 的动态诊断结果驱动），但互不依赖。

## 2. 总体架构（一个 npm 包，多面）

```
@dsh-scavenger
├── lib/checker    静态分析器（纯函数/纯文件系统，无进程无网络，不导入插件模块）
│     ├── analyzeProfile(dir) → GuardianReport        # 组合+解析层（泛化自 market/check.ts）
│     └── analyzeCandidate(pkgDir, hostProfile)       # 安装前对候选插件的兼容性预检
├── lib/inspector  契约级检视（node:vm 沙箱安全导入插件模块）
│     └── 导出形态 / inject 声明 / Config schema / engines / peer 族
├── lib/runtime    Cordis 插件（运行期被动观测 + 归因 + 服务/工具面）
├── bin/dsh-scavenger  CLI：--profile 清理（plan/--apply/rollback）
│                       check <profile> [--json|--text]
│                       gate  <pkg-or-uri>            # 安装前门禁（供脚本/market/doctor 调用）
└── client/        （可选）web 面板：插件健康度/错误时间线
```

### 2.1 三个运行形态

| 形态 | 何时 | 做什么 |
|---|---|---|
| CLI 预检（check/gate） | 启动前 / 安装前 / 恢复时 | 静态全部检查（含 vm 沙箱契约检视），JSON+退出码 |
| 运行时 observer（bundle 行 `- id: scavenger`） | profile 运行中 | 被动监听 fiber 状态/异步错误，归因到插件；暴露 `ctx.scavenger` 服务 + `plugin_scavenger_*` 工具 |
| 客户端面板（可选） | web GUI | 健康度/时间线/修复建议入口 |

约束：**另一插件导致启动硬失败时进程直接退出，observer 跑不起来**——所以
"本轮启动失败"场景全靠 CLI 预检兜底；observer 负责"运行中发生的错误"（异步炸、
live-patch 失败、动态加载失败）。两者配合：先 gate，后 watch。

## 3. 检查项清单

级别：**error**＝启动必挂／行为必然错误；**warning**＝大概率问题；**info**＝结构性事实。
每条尽量带"该用 DSH 哪个机制实现"。

### A. 组合层（静态，镜像 applyEntryPatches；复用 market/check.ts 的 composeLayers）
- A1 patch 解析失败 → error（loadOptionalPatches 已抛，直接捕获）
- A2 跨层重复 entry id → error（boot 硬失败，实测）
- A3 orphan / name 不匹配 → warning（boot 只 warn）
- A4 overrides（后层覆盖前层）→ info（附来源链）
- A5 跨层重复插件 name（运行时遮蔽）→ warning
- A6 bundle 缺失 / 无 dsh.bundle.patch / patch 缺失或不可解析 → error
- A7 排序规则冲突/循环 → warning（复用 market order.ts 语义）

### B. 解析层（静态，不导入模块；PoC 已验证）
- B1 行 name 的裸包在 profile 可见 node_modules 祖先中不可解析 → error（实测形态3）
- B2 相对/绝对路径行：文件存在性 + 最近 package.json name/version 可读 → error/warning
- B3 插件把核心包（@deepseek-ai/{dsh,cordis}*）当普通依赖（hoist 遮蔽）→ error
- B4 lockfile 核心包多版本 → error/warning（复用 market）
- B5 用户/home patch 行无 name 或 name 非法（含空名）→ error/warning

### C. 契约层（vm 沙箱导入插件模块后检视；market/doctor 均无）
- C1 导出形态：default/具名导出必须是 Cordis 插件形状（function/object/class，
  有 `apply`/`inject`/`Config` 静态声明）→ 否则激活必挂
- C2 **inject 服务图**：行声明的必需服务能否被提供——内置服务（loader/timer/…）+
  其他行 provide + base 基座；不可达 → error（"waiting for service" 实测形态4）；
  optional（本 fork 无标记，惯例 `ctx.get` 探测）→ 不报
- C3 **Config schema**：导出 `Config` 时用 schemastery `~standard.validate` 校验该行
  config（`!!js` 在受限作用域求值：process.env / process.platform / process.cwd /
  dshHomePath）；失败 → error（**ValidationError 可用 `Symbol.for('ValidationError')`
  稳定识别**）；表达式无法求值 → warning（标注"静态作用域受限"）
- C4 peerDependencies / peerDependenciesMeta(optional) vs 实际解析版本 → warning
  （复用 market satisfiesRange；含 engines.node / engines.dsh / lockstep 声明）
- C5 **同名服务重复 provide**：静态收集各插件 `ctx.provide`/`Service` 的 service 名，
  同名两次 → error（**reflect.ts 第二次 provide 同步抛错**，实测语义）
- C6 行 name 为 bundle 子路径时导出存在性（require.resolve 该子路径）→ error

### D. 运行期观测（进程内，被动；doctor 只做到"记 name"，scavenger 做到"归因+原因"）
- D1 fiber → FAILED：**在 `internal/status` 同一微任务窗口内 `fiber.await()` 取原始
  rejection**，用 `loader.locate(fiber)` 归因到 entry.id，再经 package.json 解析到
  包名/版本，记录 {entryId, name, layer来源, error, stack, ts}（注意 Loader 随后会
  dispose 失败 fiber；错过窗口则改从启动/审计角度补）——信息面远超 doctor 的
  `fiber.name`（entry fiber 常匿名）
- D2 `unhandledRejection`/`uncaughtException`：先于 installFailLoud 注册，按堆栈首帧
  归属插件（loader 归因 / 模块→entry 映射），记录"哪个插件异步抛错"（installFailLoud
  只会 `fatal load failure` + exit 1）
- D3 live patch（cordis.patch.yml / home patch）热重载失败：监听 `hmr/config-update-failed`
  或刷新失败，记录并提示下一轮启动后果（live reload 失败非致命，旧树保持）
- D4 `internal/service` 事件：构建运行时服务图（谁 provide 了什么），补充 C2 动态面
- D5 `ctx.scavenger.status()`/`report()`：全量 entry 状态投影（复用 inventory 的
  activeEntries 范式：`!group && !disabled && fiber?.state===2`）+ PENDING/FAILED 归因

### E. 修复建议（全部 dry-run 优先，显式授权才 apply）
- E1 建议禁用行：生成 `- id: X\n  disabled: true` patch（**写前必须完整 parsePatchFile
  校验 + 串行化 + 白名单校验**，复用 market patch.ts 的"never made worse"约束）
- E2 bundle 顺序调整（按声明规则最小改动，先 trial 组合重放）
- E3 快照对比回滚（对比修改前后组合 diff，回滚到上次"已知好组合"）
- E4 关键边界：不自动写入——只输出 JSON 补丁/命令，由用户或调用方执行；
  scavenger 自身状态持久化在 profile manifest（package.json）或独立 state 文件，
  **不写 root cordis.yml**（每 boot 被重写为 []）

## 4. 关键机制选型与版本注意

1. **安全导入插件模块**：`node:vm` + 受限 createRequire（生态先例 dsh-cordis-host-runner
  的沙箱）；只读声明不动 apply；Config 校验只调 `.validate`。风险自评：插件顶层代码
  副作用无法完全隔离——检查面限定为"声明读取"，不执行 apply。
2. **目标 DSH 版本**：本机 0.1.5-rc.2（启动全有或全无）与 master（required-entry 策略、
  `--dump-config-schema`、位置参数 `dsh <name>`）语义不同。scavenger 用
  `engines.dsh` 声明目标线，按安装版行为实现，master 差异用特性探测适配。
3. **官方可复用点**：master 的 `--dump-config-schema`（schema/partial/absent/unsupported/
  error + complete）、`~/.dsh/logs/startup-*.log`（启动诊断）、`plugin-inventory`
  （PluginFiberPhase 投影）——scavenger 的 CLI `check` 在目标版本支持时可直接调用/
  解析这些输出，避免重复实现。
4. **与 dsh-market 的关系（待用户定）**：A/B 层逻辑与 market/check.ts 同源。方向一：
  scavenger 把 market 的纯函数分析收编为 `lib/checker`，market 后续改为消费 scavenger
  （引擎独立、UI 在 market）；方向二：各自独立，仅语义对齐（避免运行时相互依赖）。
5. **与 dsh-doctor 的关系**：scavenger 出"插件契约+运行时归因"诊断；doctor 出
  "环境+文件"诊断与可逆修复。可将 scavenger 的 `dsh_scavenger_*` 工具与 doctor 的
  `dsh_doctor_*` 并列使用；`gate` 子命令可被 doctor 的 repair 流程调用。**不合并、
  不依赖**（两者都是独立 npm 包）。
6. **验收路径（本会话已具备）**：隔离 `DSH_HOME` + 4 种坏插件（激活抛错/内部依赖缺失/
  包不存在/inject 缺失）已复现全部 4 种启动失败输出；PoC 已实现 B 层；M2+ 后可在
  同一坏 profile 上端到端验证「check 报错 → 建议 → dry-run → apply → 恢复启动」。
7. **prerelease 宿主**：Host 常驻 `0.1.5-rc.2` 这类 prerelease 行，peer/engines 匹配
   使用 npm 集合级规则 + `includePrerelease`，避免对官方依赖误报。
8. **CLI 路由**：主命令与子命令是两个独立 Command 实例——commander 会把父级同名选项
   吞进子命令（`check --profile x` 会读到父级默认值），独立实例保证
   `--profile/--home/--json` 在任何位置语义一致。

## 5. 里程碑

- M0 ✅ 调研（docs/research.md 本方案）— 本次完成
- M1 `lib/checker` A/B 层 + CLI `check`（泛化 market 逻辑，独立实现）
- M2 `lib/inspector` C 层（vm 沙箱：导出形态/inject 服务图/schema/engines/同名 provide）
- M3 `lib/runtime` D 层（FAILED 归因 + 异步错误归属 + status 服务/工具）
- M4 E 层修复建议（dry-run + 写保护）+ （可选）web 面板
- M5 端到端验收（坏 profile 全链） + 发布 npm + （可选）进 awesome-dsh-plugin 目录

## 6. 实现态语义（v0.1.0，与第 3 节设计项对应的落地形态）

### 6.1 清理安全模型

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

### 6.2 检查项错误码清单

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
运行期归因属 D 层（后续规划）。

## 7. 待用户确认

1. **范围**：只要 CLI 预检（A/B/C），还是也要运行时 observer（D）？建议至少 CLI+observer；
   面板做不做？
2. **与 dsh-market 关系**：收编其 checker 引擎（market 改消费）还是各自独立？
3. **包名/发布**：`@gausszhou/dsh-scavenger`？是否进市场目录？
4. **与 dsh-doctor**：看完源码后，是否要联动（如 doctor 调 `dsh-scavenger gate`）？
5. 是否现在开始实现 M1？