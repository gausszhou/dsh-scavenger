# deepseek-harness 插件体系调研 — dsh-scavenger 前置研究

> 调研对象：`@deepseek-ai/dsh` 0.1.5-rc.2 发布包（安装于
> `/home/gauss/.nvm/versions/node/v24.19.0/lib/node_modules/@deepseek-ai/dsh/`）及其内部
> `@deepseek-ai/*` 包；本机 `~/.dsh` 的 web profile（含 `@gausszhou/dsh-market`）。
> 所有"实证"小节均为真实运行结果。日期：本会话。

## 1. DSH 是什么

`dsh` 是 deepseek-harness 的唯一 Node 应用启动器（README：profiles are ordered stacks of
plugin-bundle patch layers under the user's own overrides）。SDK / ACP / web / headless 都是
profile，不是独立命令。

- 启动模式：`dsh --profile <name>`，另有 `dsh web`（= `--profile web`）等别名。
- **profile** = 一个目录（`$DSH_HOME/profiles/<name>`，默认 `~/.dsh/profiles/<name>`）：
  - `package.json`：`dsh.profile` 清单（`bundles` 有序列表、`patchReload: live|startup`）+ 依赖。
  - `cordis.patch.yml`：用户的 patch 层（可热重载）。
  - `pnpm-workspace.yaml`：pnpm 工作区，供第三方插件安装。
- **bundle** = 一个 npm 包，其 `package.json` 声明 `dsh.bundle.patch`（指向自己的 patch 文件，
  如 dsh-base/cordis.patch.yml）。bundle 的 patch 成为 profile 组合树的一层。
- **组合**：空根 → 每个 bundle 的 patch（按 `dsh.profile.bundles` 顺序）→ profile 的
  `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml` → `--patch` 覆盖层。
  （`dsh/lib/profile-boot-Dk-7KqJc.js` `composeProfile`，app-boot `boot`。）
- 工具：`dsh --profile <n> --dump-config` 不启动、不执行 `!!js`，把组合结果按来源层注释输出
  （`lib/dump-config-*.js` `runDumpConfig` → `renderConfigDump`）；`--dump-default-config` 只输出
  bundle 层（用于修复损坏的用户层）。

### 1.1 插件管理（`dsh plugin --profile <name> <pnpm args>`）

`lib/plugin-Ddi42qoW.js`：
- 首次自动初始化 profile（模板或默认 bundle 集）。
- 在 profile 目录里转发 `pnpm <args>`（`add` / `remove` / `update` …）。
- pnpm 成功后 `reconcilePlugins`：**依赖清单里声明了 `dsh.bundle.patch` 的包自动加入
  `dsh.profile.bundles` 层栈**（按依赖顺序追加）；没有 bundle 声明的依赖会打一行警告
  （"installed as a plain dependency, not a profile layer"）。
- 相对路径参数（`.`、`../x`、`file:`、`link:`）会锚定到用户调用目录再转发（防止 `add .`
  自链接 profile）。
- git/私有源安装失败时提示 pnpm 的 allowBuilds 设置（prepare 脚本默认被 pnpm≥10 拦截）。

**用户装第三方插件的端到端路径**：`dsh plugin --profile web add @xxx/pkg` → pnpm 装入
profile node_modules → 若声明 bundle 则自动成为层 → 用户在自己的 cordis.patch.yml 里
`- insert:` 所需行（或在 bundle patch 里已自带行）→ 重启（或 live 热重载）→ Loader 逐个激活。

## 2. 插件运行时模型（Cordis fork：`@deepseek-ai/cordis` 4.0.2）

来源：`cordis/src/fiber.ts`、`registry.ts`、`events.ts`、`context.ts`，以及
`cordis-plugin-loader`（vendor/loader）。

- **FiberState**（fiber.ts）：`PENDING`(等待服务) / `LOADING` / `ACTIVE` / `FAILED`(回调或配置
  抛错) / `UNLOADING` / `DISPOSED`。
- 状态迁移触发事件 **`internal/status`(fiber, oldState)**（fiber.ts:586，events.ts:333）——
  运行期观察插件的入口之一。
- `ctx.plugin(plugin, config)` 启动一个插件；插件函数可声明 `inject: ['service', …]`（必需）
  与 `optional`；依赖服务未就绪时 fiber 停在 PENDING；服务由 `ctx.provide(name, impl)` 注册
  （Service 类/普通 provide）。`ctx.get(name)` 取服务。
- 配置校验走 schemastery（`z.object(...)` / `Config` 导出）；校验失败 → 激活抛错。
- **Loader**（cordis-plugin-loader，DSH 行 `id: loader` 由 app-boot 挂载）：`EntryTree` /
  `EntryGroup` / `Entry`；entry 字段 `{id, name, config, disabled, group, inject}`；
  `loader.create/update/remove/await/locate/resolve`；入口树是 profile 组合的运行时镜像。
  - `loader.await()` 等待所有 pending entry 的 import/fiber 重载落定；
  - `loader.locate(fiber)` 把 fiber 映射回拥有它的 entry（归因起点）；
  - `cordis:` 前缀的行是结构行（`cordis:include`、`cordis:loader` 等），不是普通插件；
  - entry 可嵌套在 group 下（`config` 为子 entry 列表）。
- `!!js` 表达式（`{__jsExpr: "…"}`）由 Loader 在**激活时求值**（`isJsExpr`）；dump 工具保持原文。

### 2.1 实证：DSH 对插件错误的硬失败（实测 4 种形态）

构造隔离 `DSH_HOME=/tmp/gdn-home` + 4 个坏插件运行 `dsh --profile gdn-demo headless`：

| 形态 | 错误输出 | 后果 |
|---|---|---|
| 激活抛错 | `failed to apply loader entry gdn-thrower (file:///tmp/…/thrower.js): BOOM …(activation)` | 整树失败 |
| 插件内部依赖缺失 | `failed to import loader entry gdn-config-bad (…): Cannot find package '@deepseek-ai/schemastery' imported from /tmp/…` | 整树失败 |
| 行名包不存在 | `failed to import loader entry gdn-nonexistent (gdn-package-does-not-exist-xyz): Cannot find package … imported from /tmp/gdn-home/profiles/gdn-demo/` | 整树失败 |
| inject 服务缺失 | `1 entry did not activate` → `…/missing-inject.js: pending (waiting for service: gdnMissingService)` | 整树失败 |

根因链路：`boot()`（app-boot:1525）→ 树落定 → **`assertEntriesActivated`**（app-boot:1465）：
- 启用的 entry 无 fiber（import 失败）→ 报 `plugin(s) failed to load: <names>`；
- fiber FAILED → `fiber.await()` 取出原始 rejection 原样抛出；
- fiber PENDING → 点名缺失服务；
- 之后 `installFailLoud`（app-boot:1401）把运行期 `unhandledRejection` 打为
  `fatal load failure` 并 `exit(1)`——**插件异步抛错会杀死整个应用进程**。

结论：DSH 对"插件启动不了/激活失败"已经是 **fail-loud**（绝不静默跳过），错误信息里带
entry id 与模块说明。但：没有"谁引起了这棵树失败"的结构化归因、没有运行期长期观测、
没有启动前的预检（只能 `--dump-config` 看组合，不能验证 inject/schema/import）。

## 3. 已存在的相关机制（可复用，不重复造）

1. **`dsh-app-boot`**（app-boot/lib/index.js，1575 行）导出一整套可复用 API：
   `composeEntries(layers, warn)`、`applyEntryPatches`（include 的 patch 算法，
   同时是 dump/boot 的唯一事实来源）、`loadProfile`、`loadOptionalPatches`、
   `loadOverlayPatches`（patch 文件解析失败=硬错误）、`renderConfigDump(bin, path, layers, warn)`
   （带来源注释的渲染）、`boot`、`installFailLoud`、`assertEntriesActivated`、
   `watchUserPatches`（live patch 监听 → `hmr.registerConfig` → `entry.update`）、
   `healProfilesModuleFallback`（模块回退/软链机制，让 profile 能看到安装包）。
2. **`cordis-plugin-include`** 的 `parsePatchList`/`entryListSchema`：patch YAML 方言
   （`!!js` scalar 往返）。
3. **`dsh-plugin-package-inventory-deepseek`**（lib/index.js，143 行）：活跃 entry 枚举 →
   `entry.fiber?.state === 2`(ACTIVE) 过滤 → createRequire 定位 package.json →
   输出 `{name, version}` 清单。**这是"在另一个插件里枚举并归因其他插件"的现成范式**。
4. **`dsh-tool-cordis` + `dsh-cordis-host-runner`**：模型可用的运行期 Cordis 检视
   （`cordis_inspect_list/query/self`），动态包在 `node:vm` 沙箱中安全执行。**`node:vm`
   沙箱是"安全导入插件模块做静态检视"的生态内先例**。
5. **客户端插件**（web UI）：包声明 `dsh.client`（platform: 'web'，`./client` bundle，
   `dsh.client.external` 外部模块），由 `dsh-client-modules` 扫描**启用的 Loader 行**组合成
   boot graph 并服务 `/plugins/<id>/client.js`；浏览器懒加载；组合层拒绝 malformed requests /
   missing suppliers / self-requests / 同步循环。`dsh-client-hmr` 提供开发期热替换。
6. **`--dump-config` / `--dump-default-config`**：不启动的组合转储（用户层的恢复诊断入口）。

### 2.2 运行期可观测事件清单（scavenger runtime observer 的挂钩点，已核实）

Cordis 核心（`cordis/src/events.ts`）：
- `internal/status(fiber, oldState)` — fiber 状态迁移（PENDING→LOADING→ACTIVE / →FAILED 等）
- `internal/plugin(fiber)` — 插件 fiber 创建
- `internal/service(ctx, name, value)` — 服务提供/变更（可构服务图）
- `internal/config(this: Fiber, config, next)` / `internal/update` — 配置应用/更新
- `internal/dispatch(mode, name, args, thisArg)` — 每次事件派发（含错误观测面）

Loader（`cordis-plugin-loader/lib/index.js`）：
- `loader/entry-init(entry)` — entry 开始装载
- `loader/partial-dispose(entry, options, isUpdating)` — entry 重载/更新时部分销毁
- `loader/patch-context(...)` — patch 上下文
- entry 错误统一封装为 `failed to <stage> loader entry <id> (<name>): <detail>`
  （stage ∈ import/apply/…；`updateError`，lib:309）

```js
// runtime observer 的最小贴合面（伪代码）
ctx.on('internal/status', (fiber, old) => {
  if (fiber.state === FAILED) record(ctx, fiber)   // 归因：loader.locate(fiber)
})
ctx.on('loader/entry-init', (entry) => track(entry))
ctx.on('internal/service', (ctx, name, value) => serviceGraph.set(name, {by: ctx.fiber}))
// 异步错误归属：process.on('unhandledRejection') 先于 installFailLoud 登记，
// 按堆栈首帧 → 模块 → loader.locate / package.json 归属到插件
```

## 4. 用户已有资产：`@gausszhou/dsh-market`（web profile 中）

`~/.dsh/profiles/web/node_modules/@gausszhou/dsh-market`（纯 TS 源码在 `src/*.ts`）。

**其 `check.ts` 已实现"静态组合分析器"**（`analyzeProfile(profileDir)`，纯文件系统、无进程、无网络）：
- bundle 栈（official/community、依赖说明、解析目录、错误、patch 解析）；
- 组合后的 loader 行、**跨层重复 id**（#98 启动失败）、**overrides**（后层覆盖前层）、
  **orphans**（命中不到目标的 patch 行）；
- **跨层重复 name**（运行期影子遮蔽）；
- **peerDependencies 范围不匹配**（自带 semver 子集匹配器 `satisfiesRange`，含 workspace:、
  prerelease 门控）；
- **lockfile 里核心包多版本**（`@deepseek-ai/{dsh,cordis}*`）；
- 用户/home patch 行引用的包在 profile 可见 node_modules 祖先中是否安装；
- bundle 排序规则（`dsh.bundle.order` before/after）校验 + LOOT 式建议顺序；
- `!!js` 条件 disabled 行按"conditional"处理，不武断判定。
- 严重级：errors（必挂）→ warnings（确认问题）→ informational（不报警）。

**还有**：`compatibility.ts`（peer 风险分级 belowMin/aboveMax/optional）、
`discovery-compatibility.ts`（目录条目的 `engines.dsh` / lockstep `@deepseek-ai/dsh-*`
peers 判定）、`trial.ts`（"Nothing is written until a trial composition passes"——写入前的
试组合校验）、`patch.ts`（hot disable/enable 把 `- id: … disabled: true|false` 写进
cordis.patch.yml，且"绝不把已损坏的 patch 弄得更坏"）、`hot.ts`、`verify.ts`、
`order.ts`、`routes.ts`（大量 HTTP 端点）、诊断面板 UI、"AI fix"提示词复制。

> 能力矩阵的完整核对由子代理产出，最终合入本文件。

## 5. 综合判断（现状 → 缺口）

DSH 生态对"插件不兼容/报错"已有：**启动时 fail-loud 硬失败 + 归因错误文本**、
**market 的静态预检**（组合/重复/peer/多版本/排序/安装存在性）、**运行期检视工具**
（dsh-tool-cordis）。真正的缺口（scavenger 的价值定位）：

1. **启动前预检没有"契约级"检查**：inject 服务图、插件模块导出形态、Config schema 校验、
   `!!js` 表达式求值错误——这些都要"安全导入插件模块"（vm 沙箱）才能查。
2. **运行期没有持续观测/归因层**：fiber FAILED 事件、`unhandledRejection` 归属到具体插件、
   live patch 重载失败记录——DSH 只会杀进程，不会告诉你"是哪个插件、从哪行来的"。
3. **没有机器可读的 CLI/API 预检门禁**：market 的 check 绑死在自己服务的 profile 和 UI；
   scavenger 应提供独立 bin + 结构化报告 + 退出码，可被安装流程/恢复脚本/CI 调用。
4. **没有"修复建议后的安全落地"闭环**：market 有 AI-fix 提示词与热开关，但仍需人工；
   scavenger 可把"禁用肇事行/回滚到上次好组合"做成 dry-run + 显式授权的原子动作。
## 6. 生态全景：已有方案对照（截至本调研）

调研子代理交付：`.research/RESEARCH_REPORT.md`（官方文档/社区，全部带 URL）、
`.research/INSTALLED_PACKAGE_DEEP_DIVE.md`（安装包内部机制，带 file:line）、
`.research/upstream-radar-README.md`、`.research/apps_cli_reference_README.md` 等。

### 6.1 官方现状（deepseek-ai/deepseek-harness，**master 分支**，非 main）

- **插件契约**（docs/user/develop/basic/*）：插件 = 导出 `apply(ctx)` 的模块
  （function/object/class 三形态 + `inject` 服务声明）；发行单元 = bundle
  （`"dsh":{"bundle":{"patch":"./cordis.patch.yml"}}`）+ profile
  （`dsh.profile.bundles` 有序列表）；安装唯一通道 = `dsh plugin --profile <n> <pnpm args>`。
  官方插件 peerDependencies 钉同一 rc 版本族；npm `keywords:dsh-plugin` 约 5822 个包。
- **CLI 诊断**：startup diagnostics（失败插件清单 + 原始栈 + pending 缺失服务，写
  `~/.dsh/logs/startup-*.log`，exit 1）；`--dump-config` / `--dump-default-config`；
  master 新增 **`--dump-config-schema`**（逐 entry status:
  schema/partial/absent/unsupported/error + `complete` 布尔——"complete ≠ 能 boot"）。
- **Web UI 状态链**：`host/plugin-inventory`（PluginFiberPhase:
  pending/loading/active/failed/unloading/null，只读快照）→ `api-remotes` →
  `client/ui-settings-plugin-inventory`（Settings→Plugin 列表状态点）；`ui-plugin-manager`
  是侧栏 Plugins 管理页（显示 phase 但不显示 reason）。
- **运行时自检**：`packages/runtime-diagnostics`（`ctx.invariants`）。
- 官方**无** doctor/scavenger/audit 命令或提案（issues 关闭、discussions 枚举无相关话题）。
- ⚠️ **版本差异**：安装版 0.1.5-rc.2 ≠ master——master 已分化 `dsh <name>` 位置参数、
  `--dump-config-schema`、runtime-resolution（不再建软链）、required-entry 启动策略
  （可选插件失败仅警告）、dsh-hmr、plugin-manager。安装版启动是"全有或全无"。
  **scavenger 必须按目标 DSH 版本设计**（本项目环境为 0.1.5-rc.2；master 的
  required-entry 策略会让"插件失败"从致命变成告警，语义不同）。

### 6.2 dsh-doctor（@jorinyang/dsh-doctor，GitHub jorinyang/dsh-doctor）

用户要求核对的同类项目。"DSH 的私人医生"：崩溃诊断 + 可逆修复 + 一键回滚 + 运行时自愈。
- **形态**：自带 CLI（postinstall 注册 PATH，`dsh-doctor [diagnose|fix|rollback]`）+
  Cordis 运行时插件（`ctx.provide('dsh-doctor')` 服务 + `dsh_doctor`/`dsh_doctor_fix`/
  `dsh_doctor_rollback` 工具）。
- **诊断 9 类**（src/diagnose.ts）：env（node/pnpm/dsh 版本）、home 目录、profile 结构
  （5 文件+node_modules）、config 语法（package.json JSON、pnpm-workspace allowBuilds
  占位符）、**bundle 依赖存在性**（core bundle 豁免；link: 依赖有效性）、**config mount**
  （exec `dsh --dump-config` + 核心 bundle 是否挂载）、port、HTTP health、disk。
- **修复**（src/repair.ts + journal.ts）：scope safe/deps/full；每个改动记录 undo journal；
  LIFO 回滚；系统边界操作（pnpm install/杀进程）标记"需手动补偿"。
- **运行时**（src/runtime.ts）：`ctx.on('internal/status')` 记录 FIBER_FAILED →
  `failures()` + `dsh-doctor/fiber-failed` 事件；ACTIVE-from-FAILED 记 recovered。
- **局限（从源码看）**：bundle 存在性检查只查 `dsh.profile.bundles` 顶层，不分析组合树；
  不做重复 id/name、peer、多版本、inject、schema、`!!js` 检查；运行时 FAILED 记录只有
  `fiber.name ?? 'unknown'`（**Loader entry 的 fiber 常常匿名**，归因到不了 entry.id /
  包名 / 来源层 / 错误原因）；诊断是 external 子进程视图，看不到进程内错误。

### 6.3 upstream-radar（github.com/MicroMilo/upstream-radar，npm）

"Always-on compatibility testing for DeepSeek Harness plugins"——在一次性 GitHub VM 里
做精确的 插件×DSH×Node×profile 三平面（headless/Web/TUI）真实验证；100 插件 feed
（87 兼容 / 9 待查）；已向维护者提交 13 份报告；明确拒绝"永久兼容徽章"话术。
**定位：外部 CI 级、跨版本回归矩阵**——与"进程内低成本预检 + 运行期归因"正交。

### 6.4 dsh-market 能力矩阵（详表见子代理交付）

**已覆盖（≈80% 的"组合/静态/写保护"）**：bundle 栈完整性、重复 loader id/name、
orphan/override、peer 方向分级、多版本核心包、排序约束+自动修复、写前试运行
（trial.ts，纯读重放）+ 写后快照/备份/自动回滚、patch 文件永不写坏、激活五态验证、
客户端 bundle 语法、发现期 DSH 需求标签、宿主基础设施防误开关——**但都不看插件代码**。
**确认空白（scavenger 切入点，均有源码证据）**：
1. **inject 服务缺失**（静态层完全不检测，check.ts 无任何 inject 引用）；
2. **配置 schema 校验**（无 schema 声明/校验机制引用）；
3. **`!!js` 表达式只标记不执行**（check.ts:40-44, 667-669）；
4. **pre-install 组合门禁缺失**（install 无 trial/assess 前置，是"先装后补"后置 heal+回滚）；
5. **运行期被动守护缺失**（无 crash/error 事件订阅、无 `internal/status` 消费、无
   unhandledRejection 监听；只有请求时拉取式 liveNames + `internal/plugin` 单点自愈）；
6. 传递依赖冲突（peer 只查三级可见版本，不解析完整依赖图）。

### 6.5 Cordis 关键机制补遗（子代理 A，file:line 见 .research）

- FiberState const enum：PENDING=0/LOADING=1/ACTIVE=2/FAILED=3/DISPOSED=4/UNLOADING=5。
- **失败时序**：apply 抛错 → `_reload` catch（记日志、存 `_error`、epoch=INACTIVE）→
  状态 LOADING→UNLOADING→FAILED；错误**仅 `fiber.await()` 重抛**。boot 后 Loader 常
  立即 dispose 失败 fiber（entry.fiber 清空）——scavenger 想"接管"错误须在
  `internal/status` 的同一微任务窗口内 `fiber.await()`。
- inject：全部必选、缺失永久 PENDING、**无超时**；无显式 optional（可选依赖惯例 =
  `ctx.get(name)` 探测，绝不抛错）；`ctx[name]` 读未注入服务抛硬错误；
  **`ctx.using` 在本 fork 不存在**。同名服务重复 `provide` 第二次同步抛错（→ 应用失败）。
- config：插件静态 `Config` 为 Standard Schema（schemastery `z.object`）；校验失败抛
  **`ValidationError`（`Symbol.for('ValidationError')` 标记，可稳定识别）** → 插件启动失败。
- 只注册 `cordis:include`、`cordis:group` 两个 builtin；`cordis:loader`/`cordis:hmr`
  不存在（未知 cordis: 名 → entry 启动失败）。
- `loader.locate(fiber)` 返回 entry.id 字符串（fiber→entry 归因的权威 API）。
- 可监听事件全集：internal/plugin、internal/status、internal/config、internal/service、
  internal/update、internal/get/set/listener/dispatch；loader/entry-init、
  loader/partial-dispose、loader/patch-context；hmr/change、hmr/reload、
  hmr/config-update-failed。**无 "plugin/error" 事件**。
- 持久化注意：root `cordis.yml` 每次 boot 被重写为 `[]`——scavenger 状态不得存那里；
  profile manifest（package.json）才是持久化处。

### 6.6 可行性验证结果（本次会话实测）

- 用隔离 `DSH_HOME` 实测 4 种插件错误形态的启动输出（§2.1）。
- PoC（`scripts/poc-check.mjs`）：仅用 app-boot 导出的 `loadProfile`/`composeEntries`/
  `loadOptionalPatches` + `require.resolve` 方式，不启动 DSH 即检出"行引用的包不存在"
  （error + 退出码 1）——证明"组合+解析层静态预检"完全可行。
- dsh-market `analyzeProfile` 在真实 web profile 上运行：3 bundle、27 overrides、
  1 条 peer 不匹配（optional 正确降级），0 error——基线可用。
