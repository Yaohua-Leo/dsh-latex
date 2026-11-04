# dsh-latex 架构说明

> **更新（2026-11-03 深夜）**：本文基于 review 前的源码快照（部分行号已因修复而偏移）。随后按
> `docs/review-host.md`、`review-client.md`、`security-audit.md`、`synctex-notes.md` 修复了队列合并、
> semaphore 取消、clean 互斥、`.latexmkrc` 回退 DVI、magic-root 越界、SyncTeX 结构化/CJK 编码、客户端
> 缩放/解析等一批高/中危问题。逐项处置与回归见 **`docs/review-fixes.md`**；本文中与修复冲突的描述以
> `review-fixes.md` 和当前源码为准。最新真实验收见 `docs/acceptance.md` 附录 L。
>
> **更新（2026-11-04，v0.2.0）**：移除「LaTeX 工作台」及其头部入口；新增 `.tex` **可编辑资源 tab**
> （extension 优先级、`canOpen` 仅 `.tex`，直接取代内建只读预览）、`GET/POST /latex/file` 安全读写
> （原子写 + revision CAS）与 `/latex/action {action:"compile-file"}`（解析真实主文档并构建，reason=`editor`）。
> 保存后已打开的 PDF 预览经 SSE 自动刷新。验收与截图见 `docs/acceptance.md` 附录 M。

本文档描述 `D:\deepseekharness\latex-plugin`（包名 `dsh-latex`，v0.2.0；下文 sample 输出来自 v0.1 的历史运行）的**真实实现**：
模块划分、三条入口如何共用同一个服务对象、项目识别、构建状态机、last-good 发布、自动构建、
SSE 协议、PDF.js viewer、SyncTeX，以及安装/配置/卸载路径。所有结论都能落到源码行号或本机可复核的
文件/命令行证据上；限制与坑见同目录的 `limitations.md`。

- 本文不重复 README 的安装/配置速查，只解释**为什么这样实现**与**数据怎么流**。
- 引用格式：`相对路径:行号`，路径相对 `latex-plugin/`。
- 「已验证」的证据类型在正文中注明：源码阅读、本机文件、真实 HTTP/工具返回。

---

## 0. 证据基线

### 0.1 代码基线

`node --check` 之外没有构建步骤——插件是纯 ES module + 一个浏览器端 UMD 风格工厂函数。
本文阅读的源码版本按下表（`stat` 实测 mtime，2026-11-03）：

| 文件 | 行数 | mtime（本地） |
| --- | --- | --- |
| `index.js` | 111 | 15:56 |
| `client.js` | 2004 | 16:19 |
| `src/config.js` | 130 | 15:52 |
| `src/project.js` | 613 | 16:00 |
| `src/build.js` | 553 | 16:12 |
| `src/logparse.js` | 425 | 16:11 |
| `src/service.js` | 924 | 16:23 |
| `src/routes.js` | 513 | 16:15 |
| `src/tools.js` | 466 | 16:20 |
| `src/tool.js` | 201 | 15:59 |
| `src/util.js` | 224 | 15:52 |

合计 6164 行（`wc -l` 实测）。

### 0.2 运行基线（真实返回）

`GET http://127.0.0.1:50802/latex/health` 返回（节选，实测）：

```json
{"ok":true,"name":"dsh-latex","version":"0.1.0","pid":34656,
 "startedAt":1793694010266,"projects":3,
 "toolchain":{"binDir":"D:\\latex\\texlive2023\\texlive\\2023\\bin\\windows",
   "latexmk":"D:\\latex\\texlive2023\\texlive\\2023\\bin\\windows\\latexmk.exe",
   "tools":{"latexmk":{"exists":true},"xelatex":{"exists":true},
            "pdflatex":{"exists":true},"lualatex":{"exists":true},
            "biber":{"exists":true},"bibtex":{"exists":true},
            "synctex":{"exists":true}},
   "missing":[],"ok":true,"checkedAt":"2026-11-03T08:24:23.379Z"}}
```

`startedAt=1793694010266` 换算为本地时间 `2026-11-03 16:20:10`，**早于** `src/service.js` 的最后修改时间
16:23:09。也就是说当前 Host 进程加载的是稍旧的 Host 侧代码；下文行为一律以**源码**为准，遇到需要
精确对应线上行为的地方会标注「源码 vs 本进程可能不一致」。Host 侧改动要经过 profile recomposition
（例如再执行一次 `install_bundle`）才生效——证据见 §14。

---

## 1. 插件在 DSH 中的挂载方式

### 1.1 两个半边

| 半边 | 入口 | 注册方式 |
| --- | --- | --- |
| Host | `index.js` | bundle patch 在 Cordis 树里插入 id 为 `latex` 的一行（`cordis.patch.yml:12-41`），`name: dsh-latex` 指向包入口 `index.js` |
| Client | `client.js` | `package.json` 的 `dsh.client` 声明（`package.json:30-37`），导出 `exports["./client"]`（`package.json:10`），由 Harness 的插件 bundle 机制把文件下发给浏览器 |

`dsh.client.inject` 声明了三个依赖包：`@deepseek-ai/dsh-client-ui-sidebar-right`、
`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-theme`（`package.json:32-36`）。
客户端实际只 `require('react')`（`client.js:16`），其余能力都通过 `ctx`/`ctx.get()` 拿（见 §11.1）。

### 1.2 Host 装配

`index.js:71-111` 的 `apply(ctx, rawConfig)` 依次构造：

```
normalizeConfig(rawConfig)                    // src/config.js:78
ProjectResolver(config, logger)               // src/project.js:335
LatexBuilder(ctx, config, logger)             // src/build.js:99
LatexService(ctx, config, builder, resolver)  // src/service.js:78
```

然后四个 `ctx.effect`：

| effect | 作用 | 位置 |
| --- | --- | --- |
| 生命周期 | `service.init()` 探测工具链；dispose 时 `service.dispose()` | `index.js:78-87` |
| 工具 | `registerLatexTools(ctx, service, config)` | `index.js:89` |
| HTTP | `registerLatexRoutes(ctx, service, config)` | `index.js:90` |
| 提示词 | 往 `systemPrompt` 注入一段 `latex-workspace`（order 90） | `index.js:94-108` |

`wireWhenAvailable`（`index.js:28-64`）用 250 ms 轮询 `ctx.get(serviceName)` 等待 `tools` / `webServer` /
`systemPrompt` 出现，最长 60 s 后放弃并 warn。原因写在 `index.js:23-27`：Cordis 不保证插件启动顺序，
headless profile 没有 Web 服务器时工具半边仍须加载。这是「依赖注入」的无依赖替代品。

### 1.3 没有第二个监听端口

路由注册在 Harness 自己的 `webServer` 上（`src/routes.js:233-239`，`kind: 'prefix', path: '/latex'`），
预览与 PDF 走同一 loopback 源。插件不 `listen`、不开 socket、不写系统服务，因此不存在「常驻进程」。

### 1.4 三条入口共用一个 service

```
                        ┌──────────────────────────────────────────┐
 模型工具 (tools.js) ──▶│                                          │
 HTTP 路由 (routes.js)─▶│   LatexService  (src/service.js)         │──▶ LatexBuilder (src/build.js) ──▶ latexmk 子进程
 浏览器 UI  (client.js)▶│   projects / queue / watcher / snapshot  │──▶ ProjectResolver (src/project.js)
                        └──────────────────────────────────────────┘
```

关键点：UI 面板按钮打的是 `POST /latex/action`（`client.js:288-298`），tool 调的是 `service.enqueueBuild`
（`src/tools.js:174`），route 的 `compile` 动作也调 `service.enqueueBuild`（`src/routes.js:431`）。
三者最终落到**同一个** `LatexService` 实例、同一个项目对象、同一个队列。`service.js:5-8` 的注释把这条
约束写死了：「service 感知不到 HTTP 与 tool，所以面板按钮和模型工具共享一套实现」。

---

## 2. 模块划分

| 模块 | 职责 | 对外关键符号 |
| --- | --- | --- |
| `src/config.js` | 配置归一化与边界裁剪；`defaultConfig`、`publicConfig` | `normalizeConfig`、`publicConfig`、`defaultConfig`、`ENGINES` |
| `src/util.js` | 纯 Node builtin 小工具：哈希 id、路径包含判断、原子写/复制、`tailText`、`delay`、`formatDuration`、`projectIdOf` | 见文件头 `util.js:1-7` |
| `src/project.js` | 主文件识别（5 级规则）+ `\input/\include` 反向依赖索引 + `allowedRoots` | `ProjectResolver`、`extractReferences`、`ProjectResolutionError` |
| `src/build.js` | latexmk argv 构造、子进程、`.log`/`.blg` 解析调用、last-good 原子发布、clean | `LatexBuilder`、`probeToolchain`、`buildEnv`、`AUX_EXTENSIONS` |
| `src/logparse.js` | 纯函数日志解析（不碰 fs/进程），输入 `.log` 或 stdout | `parseLatexLog`、`parseBibLog`、`summarize` |
| `src/service.js` | 项目注册表、构建队列与并发闸门、fs watcher、状态快照、SSE 广播、SyncTeX 调用 | `LatexService` |
| `src/routes.js` | Host HTTP：`/latex/*` 10 个处理器、SSE、动作分发 | `registerLatexRoutes` |
| `src/tool.js` | 不依赖 Harness 包的 `defineTool` 精简版（把作者侧参数子集编译成 JSON Schema，并做运行时校验） | `defineTool` |
| `src/tools.js` | 7 个模型工具的 schema/描述/结果排版 | `registerLatexTools` |
| `client.js` | 浏览器半边：store、SSE、两个右栏 tab、tool 卡片、header 按钮、PDF.js viewer | `window.__ModuleLoader__.load({...})` |
| `index.js` | Cordis 装配 | `apply`、`name`、`version` |

两处**实际未被引用**的导出，读代码时容易误判（记录在案，不在本任务修正范围内）：

- `util.js:144-190` 的 `Semaphore`：`service.js` 自己内联了一个更简单的信号量（`service.js:102-127`），
  `util.Semaphore` 全仓无引用（`grep -rn Semaphore --include=*.js` 只命中定义处）。
- `util.js:209-224` 的 `sessionFileAddress`：`client.js:364-379` 有一份等价实现，Host 侧没有任何调用者。
  也就是说这个地址编码逻辑目前只在浏览器里用。

---

## 3. 三条入口的请求路径（逐步）

### 3.1 模型工具

`latex_compile`（`src/tools.js:140-188`）：

1. `resolveProject(args, exec)`（`tools.js:111-122`）：
   - `cwdOf(exec)` 通过 Host 的 `workingDirectory.ensure(agent, signal)` 取会话工作目录（失败则 `undefined`）；
   - 调 `service.ensureProject({file, project, mainFile, cwd}, {sessionId: agent.id})`。
2. `ensureProject`（`service.js:149-212`）→ `resolver.resolve(...)` → 得到 `{rootDir, mainFile, source, engineHint}`；
   用 `projectIdOf(rootDir)`（`util.js:13-16`，sha1 前 16 位）当项目 id；不存在则建项目对象（`service.js:164-197`），
   存在则刷新 `mainFile/paths/rootDir/engine`（`service.js:200-206`）。
3. 之后再 `enqueueBuild(project, {reason:'manual', signal: exec.signal, open, ...})`（`tools.js:174-183`）。
4. 结果用 `formatResult` 排成面向模型的文本（`tools.js:31-80`）：`LaTeX build: SUCCESS`、`pdf:`、`preview: ... version:`、
   `diagnostics: N error(s)`、逐条 `- 文件:行: 消息`、以及一句 Next。

`latex_preview` 在「项目还没有 success 过」时会先编译（`tools.js:218-226`），然后 `requestPreview`
（`tools.js:227-232`）。其余 `latex_get_diagnostics` / `latex_get_status` / `latex_clean` / `latex_cancel` /
`latex_synctex` 读或改同一份项目状态（`tools.js:252-461`）。

### 3.2 HTTP

`registerLatexRoutes`（`src/routes.js:233`）注册一个 prefix handler。每个请求先在 `routes.js:242-262`
做 URL 长度检查（>8192 → 414）与 `/latex/health` 例外，然后 `admit(ctx, req, res)`（`routes.js:129-150`）：
拿 `connection.admit({headers})`，拒绝就 401/403 并 `connection: close`，没有 `peer` 也 403。
`connection` 服务缺失 → 503。健康检查刻意不鉴权（`routes.js:252-253` 的理由：只 loopback、不带项目数据）。

### 3.3 浏览器

`client.js` 在模块工厂里创建一个极简 store（`client.js:191-216`）与一个 EventSource（`client.js:237-273`）。
UI 的每个动作都是 `postAction(...)`（`client.js:288-298`），成功后用响应里的 `snapshot` 覆盖 store（保留
`connection` 字段），所以面板不依赖下一次 SSE 才更新。

---

## 4. 项目识别算法

入口：`ProjectResolver.resolve(input)`（`src/project.js:380-542`）。优先级与实现：

### 4.1 规则 1：显式主文件

`input.project ?? input.mainFile`（`project.js:386`）先经 `resolveInputPath`（`project.js:317-333`）解析：
绝对路径直接用；相对路径依次试 `cwd`、`file` 所在目录；没有扩展名时补 `.tex`。若命中目录，则
`findMainInDirectory(dir, {deep:false})`（`project.js:394`），0 个 → `LATEX_NO_ROOT_DOCUMENT`，
多于 1 个 → `LATEX_AMBIGUOUS_ROOT`。命中文件时补 `.tex`、`stat` 校验，然后 `assertAllowed`
（`project.js:426`）并返回 `source:'explicit'`。

### 4.2 规则 2：`% !TEX root = ...`

`mergeMagic`（`project.js:73-89`）只读文件前 64 KB，正则 `project.js:23`。命中则相对**当前文件目录**解析
目标（`project.js:483`），目标缺失直接抛 `LATEX_MAGIC_ROOT_MISSING`（`project.js:496-500`）——不静默回退，
因为用户已经显式写了指令，猜错比报错更糟。

同一函数还识别 `% !TEX program`（`project.js:24`，只接受 xelatex/pdflatex/lualatex）与
`% !TEX encoding`（`project.js:25`）。`program` 会成为 `engineHint`，在 `service.ensureProject`
里覆盖默认引擎（`service.js:157-160`、`service.js:203`）。

### 4.3 规则 3：文件自己就是文档

`looksLikeDocument`（`project.js:130-137`）：去注释后含 `\documentclass` → `'documentclass'`；
只有 `\begin{document}` → `'document'`。规则 3 只认 `documentclass`（`project.js:503`）。

### 4.4 规则 4：反向 `\input`/`\include` 图

`DependencyIndex`（`project.js:228-314`）对一个 scan root 建索引：

- `listTexFiles`（`project.js:149-175`）广度优先，深度 ≤ 8，跳过 symlink、隐藏目录和
  `SKIP_DIRS`（`project.js:46-58`），文件上限 `MAX_INDEX_FILES = 6000`（`project.js:60`）。
- 每个 `.tex` 记录 `{magic, document, references, inputs}`；`extractReferences`（`project.js:111-128`）
  支持 `\input|\include|\subfile|\InputIfFileExists{...}`、`\input file` 无花括号形式、`\import{dir}{file}`；
  `cleanReference`（`project.js:100-105`）会拒绝含 `\ # { } 空白` 的引用，防止把宏参数当路径。
- 正向边解析 `resolveReference`（`project.js:177-190`）：先源文件目录、再 scan root，先原样、再补 `.tex`。
- 反向遍历 `rootsReferencing`（`project.js:271-299`）：BFS 上溯，步数上限 2000，收集「自己是文档」的祖先。
- 索引 TTL 10 s（`project.js:61`、`project.js:267-269`）；watcher 每次 `.tex` 变化会
  `resolver.invalidate(absolute)`（`service.js:363`），清掉覆盖该路径的索引。

`chooseScanRoot`（`project.js:198-225`）先向上找「项目容器」：遇到 `.git` 目录，或当前层已有
`main.tex/paper.tex/...` 之类的约定主文件名就停下；否则退到 `cwd`（若文件在 cwd 内），最后退回文件目录。
这样 `sections/ch1.tex` 不会被误索引成整个 workspace。

### 4.5 规则 5：工作目录搜索

无 `file` 且无 `mainFile` 时按 cwd 找（`project.js:436-468`）：先浅扫（深度 ≤2），0 个再深扫；深扫恰好 1 个
直接用它（`source:'search'`），多个就报歧义。`#rank`（`project.js:556-568`）按 `PREFERRED_ROOTS`
（`project.js:32-44`：main、paper、thesis、dissertation、article、document、root、book、report、manuscript、latex）
打分，只有「第一名严格优于第二名」时才收敛为单一候选，否则仍然报歧义。

### 4.6 返回结构与错误码

成功统一返回 `{rootDir, mainFile, source, engineHint, encoding}`，`source ∈ explicit | magic | self | reference | search`。
错误一律是 `ProjectResolutionError`（`project.js:64-71`），`code` 取值：
`LATEX_NO_INPUT`、`LATEX_FILE_NOT_FOUND`、`LATEX_MAIN_NOT_FOUND`、`LATEX_NO_ROOT_DOCUMENT`、
`LATEX_AMBIGUOUS_ROOT`、`LATEX_MAGIC_ROOT_MISSING`、`LATEX_ORPHAN_TEX`、`LATEX_PATH_NOT_ALLOWED`。
这些 message 是**可以原样给模型看**的（`project.js:63`）。

### 4.7 allowedRoots

`assertAllowed`（`project.js:600-612`）：`allowedRoots` 为空数组 → 放行任何本地路径；非空则要求目标在
某个 root 之下（`path.relative` 判定）。注意它只在「已经解析出主文件」之后调用（`project.js:426/477/545`），
默认配置下 `allowedRoots: []`（`src/config.js:32`）。

---

## 5. 构建生命周期与状态机

### 5.1 状态集合

项目对象上的状态字段（`service.js:164-196` 初始化）：

| 字段 | 含义 |
| --- | --- |
| `status` | `idle` / `queued` / `running` / `success` / `failure` / `timeout` / `cancelled` / `cancelling` |
| `building` | 是否有一个 `#runOne` 正在占用该项目 |
| `queued` | 队列长度 |
| `queue` / `pumping` | 待执行 job 与泵是否在跑 |
| `abortController` | 当前运行的取消手柄 |
| `previewVersion` / `previewPages` / `previewUpdatedAt` | last-good 发布信息 |
| `stale` | 已发布过 preview，但最近一次构建失败/取消 |
| `lastSuccess` / `lastBuild` / `lastBuildResult` / `diagnostics` / `lastError` | 展示与工具用的历史（仅内存） |
| `autoBuild` / `watchHandle` / `watchActive` / `watchError` / `autoRequested` | 自动构建相关 |

迁移：

```
            enqueueBuild
 idle ─────────────────▶ queued ──(#runOne 入口再置 queued)──▶ running
   ▲                        │                                     │
   │                        │                                     ├─ exit0 ∧ 有 PDF ∧ 0 error ─▶ success
   └──── restore(重启) ─────┘                                     ├─ 超时 ─────────────────────▶ timeout
                                                                  ├─ abort ─────────────────────▶ cancelled
                                                                  └─ 其它 ─────────────────────▶ failure
 cancel(): running → cancelling（随后由 build 结果落到 cancelled）
```

`#runOne`（`service.js:460-631`）的实现顺序值得注意：先置 `building=true, status='queued'` 并广播，
**然后**才 `await semaphore.acquire()`（`service.js:468-470`）。所以「等全局并发许可」的阶段对外显示
`queued`，语义是对的。

### 5.2 并发闸门

`service.js:102-127` 内联信号量，容量 `config.maxConcurrentBuilds`（默认 2，边界 1..8，`config.js:106`）。
`release` 幂等，`finally` 里一定调用（`service.js:618`），失败路径不会泄漏许可。

### 5.3 队列与合并

`enqueueBuild`（`service.js:404-416`）把 `{options, resolve, reject}` 压入 `project.queue`，更新 `queued`，
广播并 `#pump`。`#pump`（`service.js:418-458`）单实例循环：

- 取队首 → `#runOne` → `resolve(result)`；
- 若构建期间又来了文件变化（`project.autoRequested`），等 `min(debounceMs, 1500)` 后往队尾补一个 `auto`
  job（`service.js:439-451`）——「保存风暴合并成一次后续构建」；
- 队列里出现多个 `auto` 时只保留最后一个（`service.js:425-434`），丢弃的 auto job 用 `lastBuild.summary`
  或 `{status:'coalesced'}` resolve。

⚠ 这段合并逻辑有一个**已知风险**（源码 `service.js:428-433`）：`project.queue.slice(0, lastAutoIndex)`
会把该区间内**非 auto** 的 job 一并移出队列，而后续循环只 resolve `reason === 'auto'` 的 job，
非 auto job 既没有 resolve 也没有 reject。若队列出现 `[manual..., auto]` 的顺序，manual 调用方的 Promise
会永久挂起（HTTP 请求侧表现为浏览器一直等）。触发条件、证据与建议见 `limitations.md` §4 与
`docs/review-host.md`（由 host-review 任务独立复核）。

### 5.4 取消

三条路径，最终都落到 `AbortController`：

1. **工具取消**：`exec.signal` 从 `latex_compile` 一路传到 `#runOne`，并 `addEventListener('abort')`
   （`service.js:477-480`）。
2. **显式取消**：`service.cancel(project)`（`service.js:634-657`）先把队列里每个 job 用
   `status:'cancelled'` resolve，清空队列，再把 `project.abortController.abort()`；若正在运行则 status 置
   `cancelling`。`latex_cancel` 与 `POST /latex/action {action:'cancel'}` 都走这里。
   - 注意：正在**等待信号量**的 job 已经不在 `queue` 里、而 `abortController` 又还没赋值（`service.js:469-470`），
     因此这一小段时间内 `cancel()` 无法中止它（见 `limitations.md` §3）。
3. **超时**：`build.js:213-222`，`timeoutMs = max(5000, options.timeoutMs || config.timeoutMs)`，
   到点置 `timedOut=true` 并 abort。

子进程被杀的方式在 `build.js:235-246`：`subprocess.spawn({argv, cwd, stdio, graceMs:5000, signal, env})`，
由 Host 的 subprocess Job 负责进程树终止（latexmk 是 runscript 壳，会拉起 tlperl 与引擎子进程，
因此必须是树杀）。

### 5.5 argv 与运行环境

`build.js:190-210`：

```
[latexmk,
 '-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-recorder',
 `-outdir=${config.buildDir}`,
 (engineFlag 见下), (-gg 若 force),
 ...config.extraLatexmkArgs,
 mainRelative.replace(/\\/g,'/')]
```

- `engineFlag` 只在「项目里没有 `.latexmkrc`」或 `respectLatexmkrc=false` 或调用方显式指定引擎时加入
  （`build.js:198-201`）。`.latexmkrc` 查找在 `build.js:392-398`（`<root>/.latexmkrc` 或 `latexmkrc`）。
- `mainRelative` 必须留在项目根内，否则抛错（`build.js:206-209`）。
- `cwd` 固定为 `project.rootDir`（`build.js:237`），`-outdir` 是**相对**配置值（`config.buildDir` 被
  `config.js:83-86` 强制为相对且不含 `..`）。
- 环境（`build.js:73-83`）：`PATH`/`Path` 前置 `texBinDir`，并设 `max_print_line`（默认 2000），
  后者让 TeX 不按 79 列折行，日志解析更确定。
- `stdio`：stdin ignore，stdout 1 MB（可溢出到 32 MB），stderr 512 KB（溢出 8 MB）（`build.js:238-242`）。
- 无 shell：argv 数组直传；`-shell-escape` 从未出现（`grep shell-escape src/` 为空）。额外的
  `extraLatexmkArgs` 逐项过滤空串与 `\0` 后原样入 argv（`build.js:203-205`）。

---

## 6. 构建产物与 last-good 发布

### 6.1 路径约定

`LatexBuilder.projectPaths(resolution)`（`build.js:147-163`）：

| 路径 | 值 |
| --- | --- |
| `buildDirAbs` | `resolve(rootDir, config.buildDir)`，且**必须**在 `rootDir` 内（`build.js:149-151`，否则抛「Refusing to build outside the project root」） |
| `stateDir` | `<buildDirAbs>/.dsh-latex` |
| `pdfPath` | `<buildDirAbs>/<stem>.pdf` |
| `logPath` | `<buildDirAbs>/<stem>.log` |
| `previewPath` | `<buildDirAbs>/.dsh-latex/preview.pdf`（last-good） |
| `metaPath` | `<buildDirAbs>/.dsh-latex/last-build.json` |

`stem` 是主文件去扩展名（`build.js:152`）。中文与含空格路径的项目同样走这套布局（实测
`latex-plugin-tests/chinese-ctex/build/.dsh-latex/last-build.json` 存在，`version: 1793693772967`、
`pages: 1`、`durationMs: 770`）。真实例子（`latex-plugin-tests/single-math`）：

```
single-math/build/main.aux  main.fdb_latexmk  main.fls  main.log
single-math/build/main.pdf  main.synctex.gz  main.xdv
single-math/build/.dsh-latex/preview.pdf
single-math/build/.dsh-latex/last-build.json
```

### 6.2 成功判定与发布

`status` 由三个条件共同决定（`build.js:312-315`）：未被取消、未超时、`exitCode === 0` **且** 找到了输出 PDF
**且** `parsed.counts.errors === 0`。也就是说「latexmk 退出码 0 但日志里有 error」会被判 failure。

成功时：

- `preserveLastGood=true`（默认）：`atomicCopy(pdfFound, previewPath)`，`version = Date.now()`，
  并原子写 `last-build.json`（`build.js:319-339`）。
- `preserveLastGood=false`：`previewPath = pdfFound`（不复制），仍写 meta（`build.js:340-360`）。

`atomicCopy`（`util.js:62-72`）先写同目录临时文件再 `rename`，所以并发读取的 `/latex/pdf` 永远看不到半个文件。

`last-build.json` 真实内容（`single-math`）：

```json
{
  "schema": 1,
  "version": 1793693460674,
  "builtAt": "2026-11-03T08:11:00.674Z",
  "mainFile": "D:\\deepseekharness\\latex-plugin-tests\\single-math\\main.tex",
  "engine": "xelatex",
  "pdfPath": "D:\\deepseekharness\\latex-plugin-tests\\single-math\\build\\main.pdf",
  "pages": 1,
  "durationMs": 2230
}
```

`version` 就是 `previewVersion`，同时用于 `/latex/pdf?...&v=` 的缓存破坏（`client.js:1210-1213`）与
`x-latex-version` 响应头（`routes.js:307`）。

### 6.3 失败保留

失败/超时/取消**不写** preview、不改 meta；`#runOne` 只在 `previewVersion > 0` 时置 `stale = true`
（`service.js:514-516`、`service.js:580`）。UI 的 stale 横幅读这个字段（`client.js:1515`、`client.js:1623-1625`），
工具文本也会打印 `STALE`（`tools.js:239`）。

### 6.4 输出 PDF 的容错

`#findOutputPdf`（`build.js:469-491`）：先看 `<stem>.pdf`；找不到就扫 build 目录里所有 `.pdf`，取最新一个；
若最新两个 mtime 差 < 50 ms（无法判断谁才是本次产物）就返回 `undefined`（宁可判失败，也不发布错的 PDF）。

### 6.5 `\include` 子目录

`-outdir` 不会自动创建 `\include{sections/a}` 需要的 `build/sections` 目录，TeX 会报
「I can't write on file `sections/a.aux`」。`#prepareIncludeDirectories`（`build.js:406-455`）在构建前
**只创建目录**：BFS 扫项目里的 `.tex`（跳过 build 目录、隐藏目录、node_modules，上限 2000 个文件 / 200 个目录），
用 `\\include{sections/a}` 的 dirname 在 build 树里 `mkdir -p`，且每个目标都过 `isInside`。

### 6.6 clean

`LatexBuilder.clean`（`build.js:500-552`）从 `buildDirAbs` 递归（深度 ≤6，跳过 `.dsh-latex`）删除
**后缀白名单**内的文件（`AUX_EXTENSIONS`，`build.js:21-56`，含 `.aux/.log/.toc/.bbl/.synctex.gz/...`）与
名为 `.latexmkrc` 的文件；`.pdf` 只在 `includePdf===true` 时删；`includePreview===true` 再删
`preview.pdf` 与 `last-build.json`，并把项目 `previewVersion` 归零（`service.js:680-694`）。
源码树（项目根）永远不在删除范围内，因为递归起点是 build 目录且每条路径都过 `isInside`（`build.js:514`）。

---

## 7. 日志解析

`parseLatexLog`（`src/logparse.js:116-389`）是纯函数：输入 `.log` 文本（优先）或 latexmk stdout（回退），
输出 `{errors, warnings, counts, pages, outputFile, fatal, source}`，`source ∈ 'log'|'stdout'`。

识别顺序（每行依次尝试，命中即 `continue`）：

1. `file:line: message`（`logparse.js:19-21` 的正则，支持 Windows 盘符；`logparse.js:193-215`）——
   `-file-line-error` 的主要形态。会剥掉 TeX 包在打开文件时的括号 `(/abs/x.tex:22: ...)`。
2. 经典 `! ...`（`logparse.js:22`、`logparse.js:218-274`）：向后最多 30 行找 `l.<n>`，收集最多 6 行续行；
   按消息分类 `code`：`missing-file` / `emergency-stop` / `undefined-control-sequence` /
   `runaway-argument` / `package-error` / `latex-error`；`emergency-stop` 同时置 `fatal`。
   缺文件（`File 'x' not found`）会附加 hint「Install the package providing 'x'」。
3. `Package/Class/Module ... Error:`（`logparse.js:25`、`logparse.js:277-291`）。
4. `LaTeX|Package|Class|Module Warning:`（`logparse.js:24`、`logparse.js:293-331`）：收集最多 3 行缩进续行；
   细分为 `undefined-citation`、`undefined-reference`、`font-warning`、`latex-warning`。
5. `Overfull/Underfull \hbox`（`logparse.js:26`、`logparse.js:333-347`）。
6. `Missing character: There is no ... in font`（`logparse.js:27`、`logparse.js:349-361`）。
7. `Output written on ... (N pages, M bytes)` 取页数；`No pages of output` → 0；`Fatal error occurred` → fatal
   （`logparse.js:363-373`）。

「当前文件」用括号栈近似（`logparse.js:175-190`）：`(...x.tex` 入栈、`)` 出栈，栈顶作为诊断的 `file`。
注释里明确写了这是近似（`logparse.js:172-174`）：猜错只会让 file 退回 `undefined`/主文件。

去重键 = `severity|file|line|message 前 240 字符小写`（`logparse.js:137-149`）；errors 上限 200，warnings 上限 300。
命中不在项目根内的文件时 `relFile` 留空（`logparse.js:42-47`），不在 `file` 上瞎猜。

Bib 日志：`parseBibLog`（`logparse.js:392-412`）识别 `Warning--`、`I couldn't open database file`、
`I couldn't open style file`、`error message`；`build.js:296-308` 把 `.blg` 的条目并入同一次构建结果
（此时 file/line 为空）。

---

## 8. 自动构建

`startWatch(project)`（`service.js:298-324`）：`fs.watch(rootDir, {recursive:true}, cb)`，注册 `error` 监听，
失败只记录 `watchError` 并置 `watchActive=false`（不会让插件崩）。`stopWatch` / `disposeProject` 关闭句柄。

`#onFsEvent`（`service.js:352-372`）的过滤链：

1. 无 filename → 忽略；
2. 路径在 `buildDirAbs` 内 → 忽略（防「构建产物触发构建」死循环，`service.js:357-358`）；
3. 路径含 `node_modules/.git/.hg/.svn/.dsh-latex` → 忽略；
4. 扩展名不在 `WATCH_EXTENSIONS`（`service.js:24-49`：tex/bib/bst/sty/cls/cbx/bbx/lbx/def/cfg/clo/ltx/tikz/pgf/lua
   与 png/jpg/jpeg/pdf/eps/svg/gif/webp/bmp）且不在 `config.watchExtraExtensions` → 忽略；
5. `.tex` 变化 → `resolver.invalidate(absolute)`（清依赖索引）；
6. `autoBuild` 关闭 → 只做 4/5，不排队；
7. 否则置 `autoRequested=true` 并重置 `debounceMs` 定时器，到点 `#scheduleAutoBuild`。

`#scheduleAutoBuild`（`service.js:374-392`）在 `building || queued>0 || pumping` 时直接返回——把「构建中又有保存」
交给 `#pump` 完成后的 `autoRequested` 复查（`service.js:439-451`）。这样一串保存只会产生一次后续构建。

自动构建没有外部 AbortSignal（`signal: undefined`），只能被 `cancel()`（会 abort `project.abortController`）打断。

---

## 9. 状态快照与 SSE

### 9.1 快照结构

`service.snapshot()`（`service.js:716-736`）：

```jsonc
{
  "schema": 1,
  "now": 0, "startedAt": 0,
  "config": { /* publicConfig，见 src/config.js:117-130 */ },
  "toolchain": { "ok": true, "binDir": "...", "latexmk": "...", "missing": [], "checkedAt": "..." },
  "previewRequest": { "seq": 1, "projectId": "p_...", "sessionId": "...", "page": 3,
                      "at": 0, "reason": "tool", "surface": "native" },
  "builds": { "started": 0, "finished": 0 },
  "projects": [ /* #projectSummary，service.js:738-782 */ ]
}
```

`#projectSummary` 给每个项目：`id/rootDir/mainFile/mainRelative/engine/status/building/queued/autoBuild/
watchActive/watchError/buildDir/pdfPath/previewPath/previewVersion/previewPages/previewUpdatedAt/stale/
lastError/lastSuccess/lastBuild{status,reason,startedAt,finishedAt,durationMs,exitCode,errors,warnings,pages,
logPath,error,rcFile,clock}/diagnostics{sent to client 时截断到 errors≤80、warnings≤80}/sessionIds/lastUsedAt/runs`。

`diagnostics` 经 `summarizeDiagnostics`（`service.js:59-76`）截断并带 `truncated` 标记；`counts` 保留原始总数，
所以 UI 显示「80 条 + 省略号」而不是假装只有 80 个错误。

### 9.2 广播节流

`#broadcast(immediate=false)`（`service.js:790-806`）：非 immediate 时用一个 60 ms 定时器合并多次变更；
`immediate=true`（只用于 `requestPreview`，`service.js:676`）会清定时器并立即 emit。
`#emit`（`service.js:808-817`）逐个调用 listener，单个 listener 抛错只 warn，不影响其他订阅者。

### 9.3 SSE 帧格式

`openEventStream`（`routes.js:470-513`）：

```
retry: 2000\n\n                          ← 首帧，客户端 2 s 重连
event: state\ndata: <snapshot JSON>\n\n  ← 每次广播 + 连接时立即一帧
: heartbeat <epoch ms>\n\n               ← 每 15 s
```

- 连接上限 `STREAM_LIMIT = 24`（`routes.js:26`），超出 429 + `retry-after: 15`。
- `cleanup()` 幂等：清心跳、退订、从 `streams` 移除、`res.end()`；`res` 的 `close`/`error` 都绑它。
  插件 dispose 时 `registerLatexRoutes` 返回的 disposer 会遍历 `streams` 全部清理（`routes.js:405-419`）。
- `openEventStream` 接收 `sessionId` 参数但**没有用它过滤**（`routes.js:284-285`）——所有连接收到全部项目。
  这是有意的简单做法（客户端自己 `pickProject`），但属于隐私/效率上的边界，见 `limitations.md` §8。

---

## 10. HTTP 路由表（源码为准）

注册点：`src/routes.js:239-403`，前缀 `/latex`。除特别说明外都先过 `admit`。

| 方法 | 路径 | 入参 | 成功响应 | 备注 |
| --- | --- | --- | --- | --- |
| GET | `/latex/health` | — | `service.health()`（name/version/pid/startedAt/projects/toolchain） | **不鉴权**（`routes.js:254-261`） |
| GET | `/latex/state` | `session?`、`cwd?` | 快照 + `activeProjectId` | `rankForSession` 选活跃项目（`routes.js:181-204`） |
| GET | `/latex/events` | `session?` | `text/event-stream` | 见 §9.3 |
| GET | `/latex/pdf` | `project` 或 `session` 或 `cwd` | PDF 字节流 | 只服务 `previewPath`，并复查 `isInside(buildDirAbs)` 与 `isInside(rootDir)`（`routes.js:297-300`） |
| GET | `/latex/log` | 同上 | `text/plain` 日志尾部（≤512 KB） | 响应头带 `x-latex-log-path/size`（`routes.js:318-330`） |
| GET | `/latex/assets/<name>` | — | `text/javascript` 或 `text/plain` | 白名单 `pdf.min.mjs`、`pdf.worker.min.mjs`、`LICENSE-pdfjs.txt`（`routes.js:28`）；带 ETag/304 |
| POST | `/latex/action` | JSON：`action`、`project`、… | `{ok, result|snapshot}` | 动作见 §10.2；body ≤64 KB |
| POST | `/latex/synctex-inverse` | `{project, page, x, y}` | `{ok:true, result:"..."}` | `routes.js:370-382` |
| GET | `/latex/synctex` | `project/session/cwd`、`file`、`line`、`column` | `{ok:true, result:"..."}` | `routes.js:384-394` |
| * | 其它 | — | 404 `{error:'not found'}` | `routes.js:396` |

> 文件头注释（`routes.js:9-18`）是早期版本的路由表，缺少 `GET /latex/synctex` 与 `LICENSE-pdfjs.txt`；
> 以上表为准。

### 10.1 项目选择

- 路由里 `pickProject`（`routes.js:152-173`）：`project` id 精确命中 → 否则 `session` 找该项目集合里的第一个
  （`findProjectForSession` 取**第一个**，不排序）→ 否则 `cwd` 找「互相包含」且 `lastUsedAt` 最新的项目 → 否则 400。
- `/latex/state` 用 `rankForSession`（`routes.js:181-204`）：session 命中唯一项目就用它；多个取最近使用；
  否则按 cwd 距离；最后退化为全局最近使用。

### 10.2 `/latex/action` 动作

`performAction`（`routes.js:422-468`）：

| action | 行为 | 备注 |
| --- | --- | --- |
| `status` | 返回快照 | 不需要 project |
| `compile` | `service.enqueueBuild(reason:'ui', force, engine, timeoutMs, open)` | `open` 默认 true（`body.open !== false`）；结果经 `compactBuildResult` 裁剪（诊断各 ≤40 条） |
| `cancel` | `service.cancel(project)` | 返回 `{cancelled, running, queued}` |
| `clean` | `service.clean(project, {includePdf, includePreview})` | |
| `watch` | `service.setAutoBuild(project, enabled)` | `enabled` 默认 true |
| `preview` | `service.requestPreview(project, {page, surface})` | 递增 `previewSeq` 并立即广播 |
| `renameProject` | `{ok:false, error:'not supported'}` | 占位 |
| 其它 | 400 `unknown action` | |

请求体校验在 `readJsonBody`/`readJsonObject`（`routes.js:67-127`）：强制 `application/json`（否则 415）、
`content-length` 必须是纯数字且 ≤64 KB（413/400）、流式累计再判 64 KB、解析失败 400。

---

## 11. 浏览器端

### 11.1 运行环境与 store

`client.js:13-15` 用 `window.__ModuleLoader__.load({id:'dsh-latex', factory(require){...}})` 注册模块，
`require('react')` 取 React，`h = React.createElement`（`client.js:16-18`）——整份 UI 是手写 `h(...)`，
不用 JSX，也没有其他 Harness 客户端包被当作模块 import。

`runtime.ctx`（`client.js:189`）保存 apply 时拿到的 ctx；`ctxService(name)`（`client.js:223-229`）做
`ctx.get` 的安全包装。能力获取方式是「先 `ctx.xxx`，失败再 `ctx.get('xxx')`」：
`openTab`/`openResource` 走 `ctx.sidebarRight` 或 `ctxService('sidebarRight')`（`client.js:381-415`），
tab 注册走 `ctx.sidebarRightTabs` 或 `ctxService('sidebarRightTabs')`（`client.js:1909-1916`）。

store（`client.js:191-216`）只有 `get/set/merge/subscribe`，`useSnapshot()`（`client.js:300-304`）把
store 订阅成 React state；单个 listener 抛错被吞掉，不会拖垮插件。

### 11.2 SSE 与首屏

`startEvents`（`client.js:237-273`）创建 `new EventSource('/latex/events')`，`state` 帧 JSON.parse 后
整体覆盖 store 并置 `connection:'live'`；`onopen` → live；`onerror` → `connecting`（浏览器自动重连，
服务端 `retry: 2000`）。返回的 disposer 会 `close()` 并复位 `eventsStarted`。
`fetchState`（`client.js:275-286`）用 `?session=&cwd=` 主动拉一次（`LatexPanel` 挂载时调，`client.js:839-841`），
用于拿到 `activeProjectId`。

### 11.3 项目选择（客户端）

`pickProject(snapshot, {sessionId, cwd, projectId})`（`client.js:329-362`）顺序：精确 id → `activeProjectId`
（若该会话没有别的项目或 active 属于本会话）→ 本会话项目里 `lastUsedAt` 最新 → cwd 前缀匹配最近使用 → 全局最近使用。
`pickCwd`（`client.js:306-315`）通过 seat 传入的 `useSessions` 钩子取会话 cwd，钩子在非会话座位可能不存在，故 try/catch。

### 11.4 tab 的两阶段注册

DSH 右栏要求「先注册 tab 类型（kind），再往 slot 里注册内容」。本插件的做法：

1. 类型：`tabs.register({id: PANEL_ID, kind: PANEL_KIND, priority:'extension', title, guide})`
   （`client.js:1917-1949`），其中 `PANEL_ID = 'dsh-latex/panel'`、`PANEL_KIND = 'latex-panel'`（`client.js:20-23`）。
2. 内容：`ctx.slots.register({name:'sidebar.right.pane.tab', key: PANEL_ID, locale: NS}, LatexPanel)`
   （`client.js:1958-1973`）——**key 就是 tab 的 id**，这是两者衔接的唯一约定；`kind` 只用于 `openTab(kind, ...)`。
3. `openTab(kind, {params})`（`client.js:381-397`）→ `sidebarRight.openTab(kind, {params})`；
   `LatexPreview` 通过 `useTabInfo()` 读回 `info.tab.navigation.params`（`client.js:317-327`、`client.js:1140`），
   所以 `{project, page}` 这类参数是「导航参数」，重复 open 同一 tab 会更新参数而不是新开窗口。

`locale: NS` 只在 locale 注册成功后才有意义（`client.js:1869-1894`）：先 `locale.register(NS, DICT)`，
再 `locale.bind(NS)` 得到 `runtime.t`；都失败时退化为 `key => key`（`client.js:1894`），不会把未注册的
namespace 传给 slot。

tool view 只注册已知 key（`client.js:1976-1982` 遍历 `TOOL_LABELS`），避免占用别人的 key。

### 11.5 LaTeX 工作台（`LatexPanel`，`client.js:812-1111`）

- 顶部：项目选择（多项目时，`client.js:960-973`）、连接指示灯。
- 状态卡：`StatusPill`、上次构建时钟/耗时、stale 警告、main/engine/buildDir/previewVersion/exit 网格
  （`client.js:1071-1106`）。
- 动作：编译/取消/预览/清理 + 自动编译开关（`client.js:997-1035`）。
  编译成功后若 `result.status === 'success'` 再调一次 `openPreview`（`client.js:848-851`）。
- 前向 SyncTeX：输入行号 → `GET /latex/synctex?project&line&file`，从返回文本里抠 `page N`，再
  `openPreview(..., {page})`（`client.js:889-912`）。
- 诊断列表：错误/警告分页签，点击有 `file` 的诊断 → `sessionFileAddress(...)` →
  `openResource(address, {params:{line}})`（`client.js:679-746`）。
- 日志面板：折叠时按需 `GET /latex/log?project=`，只在展开或 `lastBuild.finishedAt` 变化时拉（`client.js:748-806`）。

### 11.6 PDF viewer（`LatexPreview`，`client.js:1136-1704`）

**加载**：`loadPdfjs`（`client.js:1117-1129`）动态 `import('/latex/assets/pdf.min.mjs')`，只 import 一次
（模块级 Promise 缓存），并把 `GlobalWorkerOptions.workerSrc` 指向 `/latex/assets/pdf.worker.min.mjs`。

**取数与重载**：一个 effect 依赖 `[projectId, version, reloadToken]`（`client.js:1199-1258`）：

1. `fetch('/latex/pdf?project=..&v=..&r=..', {cache:'no-store'})` → `Uint8Array`；
2. `pdfjs.getDocument({data, isEvalSupported:false})`（`isEvalSupported` 关掉 PDF.js 的 eval 路径）；
3. 读第 1 页 viewport（scale 1）当 `baseSize`，`setDocInfo({status:'ready', numPages})`；
4. 恢复页码：`pendingRestoreRef.current || savedView(projectId).page || 1`，clamp 到 `numPages`；
5. cleanup：`cancelled=true`、`docRef.current=null`、清 `pagesRef`、`doc.destroy()`、`loadingRef.destroy()`。
   `version` 变化（新构建发布）自动走这条路径，因此「重新编译 → 预览原地刷新」。
   `reloadToken` 由刷新按钮递增（`client.js:1583-1592`）。

**占位与按需渲染**：ready 之后渲染 `numPages` 个 `div.dl-page` 占位（`client.js:1679-1699`），尺寸
`baseSize * scale`；每个占位带 `data-page` 与 `onDoubleClick`。`IntersectionObserver`（root 为滚动容器，
`rootMargin: 600px`）在占位接近视口时调 `renderPage`（`client.js:1353-1374`）。`renderPage`
（`client.js:1271-1316`）：

- 若 `record.renderedScale === scale && record.canvas` 直接返回（同一缩放下不重渲）；
- 取消上一笔 `record.task`，`doc.getPage(n)` → 按 `dpr = min(devicePixelRatio, 2.5)` 设 canvas 像素尺寸、
  按 CSS 尺寸设样式，`pdfPage.render({canvasContext, viewport: renderViewport})`；
- `task.promise.catch(()=>{})`，避免取消产生的 rejection 变成未处理拒绝。

**缩放**：`scale = useMemo`（`client.js:1166-1173`），`fit` 模式基于容器宽度；缩放变化时
`client.js:1334-1350` 把所有页重置为占位（`innerHTML=''`、清 `renderedScale`）再 `renderVisible()`。
容器宽度用 `ResizeObserver` 量（`client.js:1183-1196`）。

**滚动与页码**：滚动事件经 `requestAnimationFrame` 合并（`client.js:1397-1414`）→ `onScroll`
（`client.js:1377-1395`）算当前页、写 `viewStates`；`goToPage`（`client.js:1416-1430`）clamp 后滚动到
`element.offsetTop - 8`。文档就绪后把当前页滚进视口在 `client.js:1261-1269`（依赖 `docInfo.status/numPages/scale`，
所以缩放变化也会重新对位）。

**导航参数跳页**：`client.js:1440-1446`，当 `params.page` 是有限正数且不等于当前页时 `goToPage`，
依赖 `[params.page, docInfo.status, docInfo.numPages]`——同一 tab 被前向 SyncTeX 再次打开时会生效。

**双击反查**：`onDoubleClick`（`client.js:1448-1493`）：

```js
const rect = canvas.getBoundingClientRect();
const x = (event.clientX - rect.left) / scale;   // CSS px → TeX pt（scale = CSS px/pt）
const y = (event.clientY - rect.top) / scale;
POST /latex/synctex-inverse { project, page, x, y }
```

拿到 `result` 文本后：`/:(\d+)(?:\s|\()/` 取行号，`/SyncTeX inverse: (.+?)(?::\d+)?(?: |$)/` 取源文件
（相对项目根就拼回绝对路径），`openResource(sessionFileAddress(...), {params:{line}})` 打开源码并跳行，
同时显示 toast 与 banner。这条链路的已知缺陷（含空格路径截断）见 `limitations.md` §10。

**状态保持**：`viewStates` 是模块级 `Map`（`client.js:221`），key 为 projectId，值 `{page, zoomMode, zoomPercent}`
（`client.js:1131-1134`、`client.js:1392`、`client.js:1420-1423`、`client.js:1568-1575`）。tab 关闭再打开时
`LatexPreview` 用 `savedView(projectId)` 初始化 state（`client.js:1146-1152`），页码另经
`client.js:1175-1180` 应用。

**stale/空/错误态**：`showEmpty`（`client.js:1514`）、loading（`1648-1650`）、error + 重试（`1651-1669`）、
stale 横幅（`1623-1625`）、构建中横幅（`1615-1622`）。

### 11.7 tool 结果卡片与 header 入口

`LatexToolCard`（`client.js:1739-1842`）：从 block 里取 args 与文本，展示工具名/状态 pill/输出（>6000 字符截断）
和「工作台 / 打开预览」按钮。`latex_compile`/`latex_preview` 成功后会自动开预览，靠
`previewRequest.seq` 去重：`if (request.seq <= lastPreviewHandled) return;`（`client.js:1771`），
`handledRef` 保证同一卡片只处理一次（`client.js:1757-1763`）。`latex_compile` 带 `open:false` 时不自动开
（`client.js:1764`）。

`LatexHeaderButton`（`client.js:1848-1859`）注册到 `conversation.session.header.actions`
（`client.js:1985-1996`），点击 `openTab(PANEL_KIND, {})`。

### 11.8 样式与可访问性现状

- 全部 CSS 在一个模板字符串里（`client.js:568-647`），只追加一个 `<style data-dsh-latex>`，
  dispose 时移除（`client.js:1898-1904`）。颜色一律用主题 token（`--dsw-alias-*`），无硬编码色板。
- 语义/aria：`svg` 统一 `aria-hidden`（`client.js:481`），PDF 滚动区 `role="region" aria-label`（`client.js:1676-1677`）；
  按钮都有 `title`。**没有**实现键盘翻页、焦点环管理或 `aria-live` 通知，见 `limitations.md` §9。

---

## 12. SyncTeX 通路

`LatexService.syncTeX(project, args, signal)`（`service.js:828-899`）：

1. 取工具链（30 s 缓存，`build.js:119-141`），`synctex.exe` 不存在 → 返回一句提示文本（不抛错）；
2. 检查 `build/<stem>.pdf` 存在，否则提示先编译；
3. `argv`：
   - inverse：`[synctex, 'edit', '-o', `${page}:${x}:${y}:${pdf}`]`（`service.js:846-851`）；
   - forward：`[synctex, 'view', '-i', `${line}:${column}:${file}`, '-o', pdf]`（`service.js:852-858`），
     `file` 相对 `project.rootDir` 解析，缺省用主文件；
4. 用 Host `subprocess.spawn`（argv、cwd=rootDir、PATH 前置 texBinDir、`graceMs: 2000`），15 s 看门狗，
   合并 stdout+stderr；
5. 解析结果：
   - inverse 取 `Input:` / `Line:` / `Column:`，输出
     `SyncTeX inverse: <相对路径或绝对路径>[:line][ (column N)]`（`service.js:884-893`）；
   - forward 取 `Page:` / `x:` / `y:`，输出 `SyncTeX forward: page N at (x, y)`（`service.js:894-898`）；
   - 没解析到时把原始文本尾部附在提示里返回。

调用方：工具 `latex_synctex`（`tools.js:429-461`，`direction` 枚举 forward/inverse，参数 `file/line/column/page/x/y`）；
HTTP 有 `GET /latex/synctex`（仅 forward）与 `POST /latex/synctex-inverse`；UI 有工作台的前向定位与 viewer 的双击反查。
三者共用这一份实现。

工具参数 `isConcurrencySafe: () => true`（`tools.js:453`）——查询不写状态，可以并发。

---

## 13. 配置

### 13.1 层次

```
defaultConfig()            src/config.js:20-39     硬编码默认 + 文档形状
   ↑ 覆盖
cordis.patch.yml 的 config cordis.patch.yml:15-41  bundle 自带默认（部署值）
   ↑ 覆盖
profile 级 override        ~/.dsh/profiles/desktop/cordis.patch.yml（当前没有 latex 行）
   ↓
normalizeConfig(raw)       src/config.js:78-114    逐字段边界裁剪，坏值回落默认
   ↓
publicConfig(config)       src/config.js:117-130   暴露给浏览器/快照的只读视图
```

事实核对：`~/.dsh/profiles/desktop/cordis.patch.yml` 里没有 `id: latex` 的 override，因此实际生效的就是
bundle 里那份 config（engine=xelatex、buildDir=build、debounceMs=800、timeoutMs=180000、autoBuild=true、
autoOpenPreview=true、previewSurface=native、allowedRoots=[]、extraLatexmkArgs=[]、maxConcurrentBuilds=2），
其余键取 `defaultConfig`（maxPrintLine=2000、respectLatexmkrc=true、keepBuildLogTail、watchExtraExtensions=[]）。

### 13.2 字段与生效位置

| 键 | 默认 | 归一化约束 | 实际使用位置 |
| --- | --- | --- | --- |
| `texBinDir` | `D:\latex\texlive2023\texlive\2023\bin\windows` | 字符串 ≤1024，`path.normalize` | `build.js:74`、`build.js:92`、`service.js:871` |
| `latexmkPath` | `''` | ≤1024 | `build.js:88` |
| `engine` | `xelatex` | 枚举校验（非法回落） | `build.js:179`、`service.js:157-160` |
| `buildDir` | `build` | 绝对路径或含 `..` → 回落 `build`（`config.js:83-86`） | `build.js:148`、`build.js:196` |
| `autoBuild` | `true` | 布尔 | 项目初始值 `service.js:178` |
| `debounceMs` | `800` | 100..30000 | `service.js:370`、`service.js:442` |
| `timeoutMs` | `180000` | 5000..3600000 | `build.js:213` |
| `preserveLastGood` | `true` | 布尔 | `build.js:319` |
| `autoOpenPreview` | `true` | 布尔 | `tools.js:173` |
| `previewSurface` | `native` | `native`\|`document` | `openPreview`（`client.js:417-424`）、`service.js:674` |
| `allowedRoots` | `[]` | 每项 `path.resolve`，≤32 项 | `project.js:600-612` |
| `extraLatexmkArgs` | `[]` | ≤32 项，过滤空串/`\0` | `build.js:203-205` |
| `maxConcurrentBuilds` | `2` | 1..8 | `service.js:127` |
| `maxPrintLine` | `2000` | 79..100000 | `build.js:80`（写进子进程 env） |
| `respectLatexmkrc` | `true` | 布尔 | `build.js:199` |
| `keepBuildLogTail` | `1048576` | 65536..8388608 | **未被任何代码读取**（`grep` 只命中 `config.js`）；日志尾部实际硬编码 64 KB（`build.js:383`） |
| `watchExtraExtensions` | `[]` | 归一化成小写 `.ext` | `service.js:362` |

`engineFlag` 由 `ENGINE_FLAGS`（`config.js:13-17`）派生，但 `build.js` 自己又用了一份 `ENGINE_ARGS`
（`build.js:58-62`），两者当前一致（xelatex→`-xelatex`、pdflatex→`-pdf`、lualatex→`-pdflua`）。

---

## 14. 安装、升级、卸载

### 14.1 现状（本机事实）

- 安装方式：`link:`，profile `package.json` 第 14 行
  `"dsh-latex": "link:D:/deepseekharness/latex-plugin"`，且 `dsh.profile.bundles` 数组末尾列出 `dsh-latex`。
- 文件系统证据：`~/.dsh/profiles/desktop/node_modules/dsh-latex -> /d/deepseekharness/latex-plugin`（符号链接实测）。
- 安装命令（README 记录）：`plugin_manager action=install_bundle target=D:\deepseekharness\latex-plugin`。
- 生效方式：bundle 安装后 Host 侧靠 profile recomposition 加载，浏览器侧靠 HMR/刷新加载。

### 14.2 Host 侧改动的生效时机（重要）

`GET /latex/health` 的 `startedAt` 是 service 构造时间。实测 `startedAt` 对应 16:20:10，而 `src/service.js`
的 mtime 是 16:23:09 —— 说明**运行中的 Host 用的是上一次 recomposition 时的代码**。因此：

- 改 Host 源码（`index.js`/`src/*.js`）后，需要触发一次 profile recomposition（例如再执行一次
  `install_bundle`，或重启 Harness）才会生效；
- 改 `client.js` 需要浏览器拿到新的 bundle 并刷新页面（依赖 `pnpm run dev:web` 之类的客户端重建，或重装 bundle）。

这条不是猜测：它是 `startedAt` 与文件 mtime 的直接对比结果，也是 `limitations.md` §1 的一条限制。

### 14.3 升级与卸载

- 升级：因为是 `link:` 安装，改动源码后重装/重组即可，无需 `npm publish`。
- 卸载：`plugin_manager action=remove_bundle target=dsh-latex`（按 bundle 包名），它会同时把
  `package.json` 的依赖与 `dsh.profile.bundles` 条目移除；插件没有后台进程需要单独停。
- 插件自身不写 profile 配置、不写全局状态；唯一落盘产物是<项目>/<buildDir>/{产物, .dsh-latex/*}。

---

## 15. 文件清单

| 路径 | 随包发布（`package.json:15-25`） | 说明 |
| --- | --- | --- |
| `index.js` | ✅ | Cordis 入口，装配 + 三个 effect |
| `client.js` | ✅ | 浏览器半边（2004 行，手写 React） |
| `src/config.js` | ✅ | 配置 |
| `src/project.js` | ✅ | 项目识别 |
| `src/build.js` | ✅ | latexmk 后端 |
| `src/logparse.js` | ✅ | 日志解析 |
| `src/service.js` | ✅ | 注册表/队列/监听/SSE/SyncTeX |
| `src/routes.js` | ✅ | HTTP 路由 |
| `src/tools.js` | ✅ | 7 个工具 |
| `src/tool.js` | ✅ | `defineTool` 精简版 |
| `src/util.js` | ✅ | 工具函数（`Semaphore`、`sessionFileAddress` 当前无引用） |
| `assets/pdf.min.mjs` | ✅ | PDF.js 5.x 主模块（419,107 B，实测） |
| `assets/pdf.worker.min.mjs` | ✅ | PDF.js worker（1,046,529 B，实测） |
| `assets/licenses/PDFJS-NOTICE.txt` | ✅（目录随 `assets`） | Apache-2.0 许可说明（1,358 B） |
| `locale/zh.json`、`locale/en.json` | ✅ | 只含 `meta.title/description`（供 tab 元信息），UI 文案在 `client.js` 的 `DICT` 内 |
| `icon.svg` | ✅ | 插件图标（`exports["./icon"]`） |
| `cordis.patch.yml` | ✅ | bundle patch（insert `latex` 行） |
| `README.md`、`LICENSE` | ✅ | 使用说明 / MIT |
| `package.json` | ✅ | `exports`、`dsh.bundle`、`dsh.client` |
| `docs/*.md` | ❌（不在 `files` 列表） | 文档：`env-audit.md`、`web-research.md`、`api-cheatsheet.md`、本文件、`limitations.md` 及队友的验收/审查文档 |
| `docs/env-audit-logs/*.log` | ❌ | 环境审计的原始日志（46 个文件） |

> 注意 `src/routes.js:28` 的资产白名单包含 `LICENSE-pdfjs.txt`，但磁盘上只有
> `assets/licenses/PDFJS-NOTICE.txt`；因此该名字的请求会走 404 分支（`routes.js:340-343`）。

---

## 16. 关键不变量与设计权衡

1. **无 shell、无 shell-escape**：`subprocess.spawn({argv})`（`build.js:235-246`、`service.js:861-872`），
   路径永不拼进命令行。
2. **产物不出项目根**：`projectPaths` 校验 `buildDirAbs ⊆ rootDir`（`build.js:149-151`），每次 `clean`
   再逐条 `isInside`（`build.js:514`），PDF 路由再查两次（`routes.js:297`）。
3. **失败的构建不覆盖成功产物**：只有 success 才 `atomicCopy` 到 `preview.pdf`（`build.js:319-339`）。
4. **同一项目串行、全局有上限**：单项目 `pumping` 循环 + 全局 `maxConcurrentBuilds`。
5. **状态只有一份**：工具/HTTP/UI 读同一 `projects` Map，避免三套缓存。
6. **事件有节流、SSE 有上限与心跳**：60 ms 合并（`service.js:800-805`）、24 连接（`routes.js:26`）、
   15 s 心跳（`routes.js:488-496`）。
7. **诊断宁可「没有位置」也不瞎猜**：`logparse.js:1-14` 的设计声明；`file`/`line` 拿不到就 `undefined`。
8. **客户端不缓存自己的构建真相**：UI 显示的版本/状态全部来自服务端 `snapshot`，只有页码/缩放这种
   纯视觉状态留在浏览器内存（`viewStates`）。

权衡代价（详见 `limitations.md`）：
- 全部历史在 Host 内存 → 重启只剩 `preview.pdf` + `last-build.json`；
- 快照每次都全量序列化 → 项目多、诊断多时 SSE 帧会变大（诊断各截断 80 条缓解）；
- 依赖启发式找主文件 → 多 root 必须显式指定；
- 日志解析保守 → 某些跨行/嵌套错误只能落到主文件或不带行号。

---

## 17. 相关文档

| 文档 | 内容 |
| --- | --- |
| `docs/limitations.md` | 限制与已知缺陷清单（本文的函数级补充） |
| `docs/env-audit.md` | TeX Live 2023 实测（PATH、runscript、引擎、ctex、biber、synctex） |
| `docs/web-research.md` | LaTeX Workshop / latexmk / SyncTeX / PDF.js 的调研 |
| `docs/api-cheatsheet.md` | DSH 插件 API 对照 |
| `docs/acceptance.md` | 端到端验收矩阵（由 acceptance 任务产出） |
| `docs/review-host.md`、`docs/review-client.md`、`docs/security-audit.md`、`docs/synctex-notes.md` | 对应专项任务产出 |
| `latex-plugin-tests/` | 真实 fixtures（single-math、chinese-ctex、multi-file、biblatex-biber、带 空格 项目、error-case、synctex、engines、timeout、include-subdir） |
