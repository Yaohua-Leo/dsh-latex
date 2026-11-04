# Host 半对抗性代码审查（dsh-latex）

- 审查对象：`latex-plugin/index.js` + `latex-plugin/src/*.js`（共 11 个文件、4,160 行，不含 client.js 的 2,004 行）
- 审查方式：逐行只读源码审查 + 现有工具的只读调用（`latex_get_status` / `latex_get_diagnostics` / `latex_synctex`）+ 本机 `latexmk.pl`、真实 `.log`/`.blg` 与 Node 行为佐证
- 审查约束：未修改任何源码、profile、`cordis.patch.yml` 或 `latex-plugin-tests` 下的 fixture；未执行任何构建、clean、cancel 或预览操作
- 结论：**无 blocker；1 个 high；13 个 medium；22 个 low/nit**
- 任务原文的 P0/P1 目标（路径边界、鉴权、进程管理、日志解析、原子发布）逐项核对结果见第 4 节

> 重要提示（详见第 5 节）：审查期间运行中的 Host 实例启动于 **16:20:10（+08:00）**，而 `src/service.js` 的 mtime 是 **16:23:09**；运行时观察到的“恢复 last-build”行为与当前源码不一致，说明**线上插件实例可能仍运行旧代码**。本文的 finding 以工作区当前源码为准；引用运行时时会注明。

---

## 1. 结论摘要

### 1.1 按严重度

| 级别 | 数量 | 说明 |
| --- | --- | --- |
| blocker | 0 | 插件可正常加载、工具可调用、构建/预览路径未被发现致命缺陷 |
| high | 1 | H1：构建队列合并逻辑会丢弃 manual 构建，使 `latex_compile` 的 promise 永不 settle（工具悬挂） |
| medium | 13 | 取消在 semaphore 等待期失效；`% !TEX root` 绕过 allowedRoots；`.latexmkrc` 抑制 engine 且可能无 PDF；旧 PDF 可被判成功；Biber 日志不解析；项目按 rootDir 串主文件；`timeoutMs` 溢出；`.latexmkrc` 任意 Perl；`path` 目录契约、发布失败误判、clean/build 竞态、恢复态诊断误导、previewSurface 失效 |
| low/nit | 22 | 见第 3.3 节表格；包括 watcher 不重试、SSE 无背压、死代码、恢复元数据不校验等 |

### 1.2 最重要的 3 个问题

1. **H1（service.js:425-433）**：一次构建进行中，只要队列里同时出现 manual 与 auto 任务，`#pump` 只保留最后一个 auto，把排在它前面的 manual 任务直接 `slice` 掉，且只对 `reason === 'auto'` 的任务 `resolve`。manual 任务的 promise 没有 resolve/reject，`tools.js:174` 的 `await service.enqueueBuild(...)` 永久挂起，UI 的 `POST /latex/action` 也永远不返回。
2. **M1（service.js:468-480、634-657）**：`abortController` 是在 `await semaphore.acquire()` **之后**才创建的，而 service 内联的 semaphore 不支持 abort。当全局 `maxConcurrentBuilds` 占满时，`latex_cancel` / 工具取消会把状态写成 `cancelling` 却无法中止任何东西，随后构建照常跑完。
3. **M3 + M4（build.js:199-201、469-491）**：项目根存在 `.latexmkrc`/`latexmkrc` 时插件不再传 engine flag；若该 rc 未设置 `$pdf_mode`，latexmk 会落到默认 DVI 模式（latexmk.pl:361-366、2492、2535），退出码 0 却没有 PDF。此时 `#findOutputPdf` 会把 buildDir 里的**旧 PDF** 当成本次输出，构建被判 success 并发布一个“新版本”的旧 preview；`% !TEX program` 也会被 rc 掩盖。

---

## 2. 审查基线与运行时证据

### 2.1 源码清单

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| index.js | 111 | Cordis 入口、服务延迟接线、systemPrompt 提示 |
| src/config.js | 130 | 配置归一化/边界 |
| src/util.js | 224 | 路径/原子写/semaphore/会话文件地址 |
| src/project.js | 613 | 主文件识别、反向依赖索引、allowedRoots |
| src/build.js | 553 | latexmk argv/env/spawn、日志读取、PDF 发布、clean |
| src/logparse.js | 425 | LaTeX/BibTeX/Biber 日志解析 |
| src/service.js | 924 | 项目注册表、构建队列、watcher、状态、SyncTeX |
| src/routes.js | 513 | `/latex/*` HTTP/SSE 路由 |
| src/tools.js | 466 | 7 个模型工具 |
| src/tool.js | 201 | 本地 `defineTool` 兼容层 |

`node --check index.js client.js src/*.js` 对 11 个文件全部通过（2026-11-03 16:31 执行）。

### 2.2 运行时实例信息

`curl -i http://127.0.0.1:50802/latex/health`（16:27:25，未带 cookie）：

```
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
...
{"ok":true,"name":"dsh-latex","version":"0.1.0","pid":34656,
 "startedAt":1793694010266,        // 2026-11-03T08:20:10.266Z = 16:20:10 +08:00
 "projects":19,
 "toolchain":{...,"ok":true,"checkedAt":"2026-11-03T08:27:08.429Z"}}
```

同一时刻，不带 cookie 访问带鉴权的路由均被拒绝 401：

```
GET /latex/state            -> HTTP/1.1 401 Unauthorized  {"error":"request refused"}
GET /latex/assets/pdf.min.mjs -> 401
```

这与 `routes.js:254-263` 的设计一致：`/latex/health` 是唯一的匿名路由，其余先过 `connection.admit`。实测也确认了健康探针会泄漏 `pid`、TeX 绝对路径与全局项目数（见 L11）。

---

## 3. Finding 明细

### 3.1 High

#### H1 队列合并丢弃 manual 构建，promise 永不 settle

- **位置**：`src/service.js:425-433`（`#pump` 循环顶部的合并逻辑）、`src/service.js:403-416`（`enqueueBuild`）、`src/tools.js:174`
- **触发条件**（可复现的时序）：
  1. 构建 A 正在运行，`project.queue` 为空。
  2. 用户/模型发起 `latex_compile` → `enqueueBuild` 把 manual job 压入队列：`queue=[manual]`。
  3. 同一构建期间保存了源文件 → watcher 置 `project.autoRequested = true`（`service.js:365-370`）。由于 `queued > 0`，`#scheduleAutoBuild` 直接返回（`service.js:376-379`），标志保留。
  4. 构建 A 结束，`#runOne` 返回；`#pump` 在 `service.js:439-450` 发现 `autoRequested`，把 auto job 压到队尾：`queue=[manual, auto]`。
  5. 下一轮 `while`：`lastAutoIndex = 1 > 0`；`dropped = queue.slice(0, 1)` 得到 manual job；`project.queue = queue.slice(1)`；随后 `for (const job of dropped) if (job.options.reason === 'auto') job.resolve(...)`——manual 任务的 `resolve`/`reject` 都没被调用。
- **后果**：manual job 的 promise 永久 pending。`latex_compile` 的 `execute` 在 `tools.js:174` `await` 它，DSH 对该工具没有超时设置 → **工具调用悬挂**；UI 侧 `postAction`（`client.js:288-298`）也没有超时，编译按钮的 `fetch` 永不返回、busy 状态卡死。资源上项目会继续按 auto 构建并成功，但调用方永远收不到结果。
- **证据**：源码逐行可核对；`job.reject` 在 `#pump`/`enqueueBuild` 路径中从未被使用（只有 `cancel()` 走 resolve）。本次审查未在运行实例上制造该时序（不允许写入 fixture），但逻辑是确定性的。
- **建议修法**：
  - 只合并“队尾连续的 auto”或“最后一个 auto + 第一个 manual”之外的重复项，并且对每一个被丢弃的 job 都 settle：manual 用 `reject(new Error('superseded'))` 或仍执行；auto 用 `resolve({status:'coalesced'})`。
  - 更简单：删除 `queue.length > 1` 的这段 `slice`，仅保留 `#scheduleAutoBuild` 的 `building/queued` 保护；auto 任务本身已经是幂等的，重复跑一次代价远小于悬挂。
  - 建议为 `enqueueBuild` 的等待加超时/`AbortSignal`（见 M1 的修法），作为兜底。

### 3.2 Medium

#### M1 取消在等待全局 semaphore 时不生效

- **位置**：`src/service.js:468-470`（先 `acquire`、后创建 `abortController`）、`src/service.js:102-127`（内联 semaphore，无 abort 支持）、`src/service.js:634-657`（cancel）、`src/service.js:477-480`（external signal 同理会晚注册）
- **触发条件**：`maxConcurrentBuilds=2` 且两个项目正在构建，第三个项目的 `#runOne` 停在 `await this.semaphore.acquire()`。此时 `project.building=true`（:464），但 `project.abortController` 仍是 `undefined`（:469 尚未执行）：
  - 用户点“取消”：`cancel()` 看到 `running = project.building === true`，把状态设为 `cancelling`，调用 `project.abortController?.abort()`（无对象，空操作），返回 `{cancelled:true, running:true}`；semaphore 释放后 `#runOne` 继续 `builder.build(...)`，正常跑完并置为 `success`/`failure`。
  - 工具 `exec.signal` abort：signal 在 :480 才注册；`#runOne` 在 acquire 之后才发现已 abort（:471/:479），builder 虽会尽快终止进程，但 spawn 失败路径返回的是 `failure` 而不是 `cancelled`（build.js:229-231、271-287）。
- **后果**：取消**报告成功但实际无效**；UI 状态从 `cancelling` 跳回 `success`；工具的取消/会话中断也无效。`util.js:144-190` 本来实现了一个支持 `signal` 的 `Semaphore`，但 service 没用它，且它自己有监听器移除 bug（见 L13）。
- **证据**：源码；未在运行实例上制造（需要人为占满 2 个 permit，且构建 fixture 会写文件，超出本任务只读范围）。
- **建议修法**：先建 `AbortController`，`release = await semaphore.acquire(controller.signal)`；acquire 成功后立即检查 `controller.signal.aborted`，若已中止则 release 并返回 `cancelled`。或在 `cancel()` 前处理“已排队但尚未开始”的 job 标记。可复用 `util.Semaphore` 并修掉 :185。

#### M2 `% !TEX root` 绕过 allowedRoots

- **位置**：`src/project.js:482-500`（magic-root 分支 `return` 前没有 `assertAllowed`）；对照 `:426`、`:477`、`:545` 其他分支都有。
- **触发条件**：配置了 `allowedRoots`（README 称“可选路径允许清单”）时，传入一个位于允许根内、内容含 `% !TEX root = D:\outside\project\main.tex` 的 `.tex`。`resolve()` 返回 `rootDir = D:\outside\project`，`build.js:147-151` 的 `projectPaths` 只校验 buildDir 在**这个新 root 内**，不会回头检查 `allowedRoots`；随后 build 以该目录为 cwd 执行。
- **后果**：路径 allowlist 可被 `.tex` 文件内容绕过；可编译本机任意 LaTeX 项目。`cordis.patch.yml` 的 `allowedRoots=[]`（不启用），因此这是“配置了安全边界时”的漏洞，而不是默认行为。此外，`assertAllowed(file)` 在 `describeMagic/readTex` 之后（`:426`、`:477`），allowedRoots 外的 `.tex` 会被读取用于识别（内容不回传，属低危信息面）。
- **证据**：源码；当前配置无法修改，未做运行时验证。
- **建议修法**：magic-root 解析出 `withExt` 后、返回前调用 `this.assertAllowed(withExt)`；把 `assertAllowed(file)` 提前到 `readTex(file)` 之前；对 `input.project` 目录扫描同理。

#### M3 `.latexmkrc` 抑制 engine flag，可能无 PDF 或静默用错引擎

- **位置**：`src/build.js:189-201`（发现 rc 且 `respectLatexmkrc=true` 时跳过 `engineFlag`）、`src/build.js:392-398`（rc 探测）、`src/service.js:157-160/202-203`（`% !TEX program` 只改 `project.engine`，不产生 `engineExplicit`）、`src/tools.js:174-183`（`engineExplicit` 只来自工具显式参数）
- **触发条件**：项目根存在 `.latexmkrc` 或 `latexmkrc`（latexmk 会自动读取，见 `latexmk.pl:1944`），但内容只设置了 `$clean_ext`、`$max_repeat` 等，**没有**设置 `$pdf_mode`/`$pdf_method`。插件不再传 `-xelatex`，latexmk 落到默认：
  - `%compilation_defaults = ('latexmk' => [1,0,0,0], ...)`（latexmk.pl:361-366）：默认 `dvi_mode=1`；
  - `unless ($dvi_mode || $pdf_mode || ...) { ... = @{$compilation_defaults{$invoked_name}} }`（latexmk.pl:2492）；
  - 于是 latexmk 成功生成 DVI、退出码 0、**没有 PDF**。`build.js:310-315` 判 `success` 需要 `pdfFound`，第一次构建因此是 failure 且 0 诊断（工具只显示 `latexmk exited with 0`）；如果 buildDir 里已有旧 PDF，则被 `#findOutputPdf` 当成本次输出 → 判 success 并发布旧 PDF（见 M4）。
  - 若 rc 设置了 `$pdf_mode=1`，则即使 `config.engine=xelatex` 或 `% !TEX program=xelatex`（CJK 项目），也会用 pdflatex，编译失败。
- **后果**：带最小 `.latexmkrc` 的项目表现为“无诊断失败”或“引擎被静默替换”；README 第 68 行“respectLatexmkrc”和“`% !TEX program` 优先级更高”的表述与实际不一致。
- **证据**：`latexmk.pl` 行号见上；本机 fixtures 都没有 `.latexmkrc`，E2E 未覆盖；本任务只读，未写 rc 复现。
- **建议修法**：只有在 rc 明确设置了 `$pdf_mode`/`$pdf_method`（或通过 `-norc` 关闭 rc）时才让出 engine flag；否则仍追加 `engineFlag`。`resolution.engineHint` 与显式 engine 参数应把 `engineExplicit` 置 true（build.js:199 的 `options.engineExplicit` 已支持，只是 service 没传）。
- **注意**：`respectLatexmkrc=false` 只影响是否追加 engine flag，**并不会阻止 latexmk 读取 rc**；若想真正忽略 rc 需要 `-norc`（见 M8）。

#### M4 旧 PDF 可被判定为本次成功并升版 preview

- **位置**：`src/build.js:310-315`（success 条件 `outcome.exitCode===0 && pdfFound && errors===0`）、`src/build.js:469-491`（`#findOutputPdf` 先 `stat(paths.pdfPath)`，不比较 mtime；找不到时扫 buildDir 取“唯一最新”的 PDF）、`src/service.js:502-513`（success 即 `previewVersion = buildResult.version`）
- **触发条件**：本次 latexmk exit 0、log 无 error，但**没有真正写出本次 PDF**，而 buildDir 里存在同名旧 PDF（M3 的 DVI 模式；或项目换了 `-jobname`/`\includeonly` 等提前成功退出的场景）。`#findOutputPdf` 直接返回旧 PDF → status success → `atomicCopy` 旧 PDF 覆盖 `preview.pdf`，`version=Date.now()`，客户端按新版本刷新到同一份旧内容。
- **后果**：报告成功、preview 版本号变化，掩盖“本次没有产出”；若旧 PDF 来自别的 jobname/文档，还可能展示错误文档（回退扫描 `buildDir` 下任意 `.pdf`，:478-490）。
- **证据**：源码；未构造（需要写 build 目录）。
- **建议修法**：记录 `startedAt`，要求 `stat(pdf).mtimeMs >= startedAt`（留 50-100ms 容差）或解析 log 的 `Output written on (...) (N pages, ...)` 并校验路径；失败时不要发布，也不要把旧 PDF 放在 `result.pdfPath` 里当本次输出。

#### M5 Biber 日志完全未解析

- **位置**：`src/logparse.js:392-412`（`parseBibLog`）、`src/build.js:296-308`（只在 build 里调用）
- **触发条件**：Biber 2.x 的 `.blg` 行格式是 `[0] Biber.pm:419> ERROR - ...` / `WARN - ...` / `INFO - ...`。当前匹配的是 BibTeX 的 `^Warning--`、`^I couldn't open database file`、`^I couldn't open style file`、`^error message`，**Biber 行一条都不匹配**。
- **证据**（本机真实文件 + 直接调用）：
  - `latex-plugin-tests/biblatex-biber/build/main.blg` 前 3 行：
    `[0] Config.pm:307> INFO - This is Biber 2.19`、`[0] Config.pm:310> INFO - Logfile is 'build/main.blg'`、`[234] biber-MSWIN64:340> INFO - ===`
  - `parseBibLog(真实 blg)` → `{"errors":[],"warnings":[]}`
  - 合成 `[0] Biber.pm:419> ERROR - Cannot find 'refs.bib'!` → 仍返回空（只有 `Warning--...` 被识别）。
- **后果**：biber 失败/缺失条目时没有结构化诊断；工具只能显示 `failure + 0 errors` 或依赖 LaTeX 端的 undefined citation；`biblatex-biber` 场景的诊断质量明显低于 `.log`。
- **建议修法**：增加 `^\s*(?:\[\d+\]\s+)?\S+>\s+(ERROR|WARN)\s+-\s+(.*)$`（code：`biber-error`/`biber-warning`），并考虑 `INFO -` 不算诊断；对“I didn't find a database entry”保留 warning。

#### M6 项目按 rootDir 注册，`mainFile`/`paths` 被后续调用改写

- **位置**：`src/service.js:156`（`id = projectIdOf(resolution.rootDir)`）、`src/service.js:200-206`（已存在时覆盖 `mainFile`/`paths`/`rootDir`，`engineHint` 覆盖 `engine`）
- **触发条件**：同一目录里有多个根文档（例如 `main.tex` 与 `paper.tex`，各自 `\documentclass`）。会话 A 打开 `main.tex` 注册项目；会话 B 打开 `paper.tex` 时 `ensureProject` 把同一个 project 的 `mainFile` 改成 `paper.tex`；随后 A 的 `latex_compile`（不再带 path，走同一 project）会编译 `paper.tex`。`% !TEX program` 的 engineHint 同样会互相覆盖。
- **后果**：跨会话/跨文件串项目；构建结果、preview 版本、`stale` 归属与调用者预期不一致；工具输出的 `main` 字段可能突然变化。
- **证据**：源码；本机 fixtures 没有“同目录双根”项目，未复现。
- **建议修法**：project key 改为 `rootDir + mainFile`（或每个 rootDir 下维护 main 文件的子表）；已有项目只在与本次解析出的 `mainFile` 相同时复用；至少不要用其他 session 的解析结果覆盖正在使用的 main。

#### M7 `timeoutMs` 未做上限，2^31-1 溢出会导致立即超时

- **位置**：`src/tools.js:161-165`（schema 只有 `type:'number'`，无 maximum）、`src/routes.js:431-439`（把 `body.timeoutMs` 原样透传）、`src/build.js:213`（只 `Math.max(5_000, ...)`，无上限）、`src/config.js:100`（config 本身 clamp 到 3_600_000）
- **触发条件**：模型或 UI 传入 `timeoutMs > 2147483647`（例如 `1000000000000`）。Node 的 `setTimeout` 溢出后会把延迟改成 1ms（`TimeoutOverflowWarning`），timer 立即 abort，build 瞬间返回 `TIMEOUT`。
- **证据**（本机 Node v24.12.0，见附录 A.4）：`setTimeout(...,1e12)` 先打印 `TimeoutOverflowWarning: ... Timeout duration was set to 1.`，回调在 1ms 触发。
- **后果**：schema 允许的合法 number 导致“秒超时”，模型会误以为项目死循环；与 README“timeoutMs 下限 5000”的已知限制不一致（缺少上限说明）。
- **建议修法**：在 build/tools/routes 三处 clamp 到 `[5_000, 3_600_000]`（与 config 一致），并在参数 schema 标 `maximum`。

#### M8 `.latexmkrc` 是任意 Perl 代码执行（安全）

- **位置**：`src/build.js:189-201`（识别 rc 并允许 latexmk 读取 cwd 的 rc）；latexmk 侧：`latexmk.pl:1944`（默认读取 `.latexmkrc`/`latexmkrc`）、`:1238`（`$auto_rc_use=1`）、`:4304-4323`（把整个文件读入后 `eval $code`）
- **触发条件**：编译一个不可信项目（clone 的仓库、下载的示例），项目根带 `.latexmkrc`。latexmk 以 Harness 用户身份 `eval` 项目控制的 Perl 代码。插件不传 `-shell-escape` **不能**阻止这条路径。
- **后果**：本地代码执行；README“Security”节只承诺了无 shell / 无 shell-escape，未提 rc 执行；`respectLatexmkrc` 的命名也容易让人以为是“只读配置”。
- **证据**：latexmk 源码行号；本机 fixtures 无 rc，未实际触发。
- **建议修法**：在文档中明确威胁模型；对不可信项目或 `respectLatexmkrc=false` 时加 `-norc`（latexmk 在读取 rc 之前预扫描 argv，:1875-1889，`-norc` 有效）；或提供 `trustProjectRc` 类开关，默认 false 并 `-norc`。注意 `-norc` 会同时禁用用户/系统级 rc，需要在 UI/工具输出里说明。

#### M9 `path` 参数文档说可传目录，但 resolver 只按文件处理

- **位置**：`src/tools.js:124-128`（`path` 描述：“A .tex file (chapter or main), a project directory, or a main .tex path”）、`src/project.js:381-382` + `:470-476`（`input.file` 只做 `stat`/`isFile`，目录 → `LATEX_FILE_NOT_FOUND`）
- **触发条件**：`latex_compile`/`latex_get_status` 使用 `path` 传目录。
- **证据**（本会话实测，附录 A.3）：
  - `latex_get_status { path: "D:\deepseekharness\latex-plugin-tests\single-math" }` → `Error: File not found: D:\...\single-math`
  - 同样路径改用 `project` → 正常解析出 `main.tex` 并返回状态。
- **后果**：模型按工具描述调用会失败，可能误以为插件坏了/放弃；目录解析实际只能走 `project`（`mainFile` 在 resolver 里也接受目录，但描述写的是“显式 main .tex”），`path` 不行。
- **建议修法**：`resolve()` 中若 `input.file` 是目录则复用 `project` 分支逻辑；或者把 `path` 的描述改成“必须是 .tex 文件（目录请用 project）”。

#### M10 发布/元数据写入失败把成功构建变 failure

- **位置**：`src/build.js:319-339`（`atomicCopy`/`atomicWriteText` 在 `build()` 内没有 try/catch，抛错会冒泡）、`src/service.js:574-580`（catch 统一 `status='failure'`）
- **触发条件**：latexmk 成功、PDF 正常，但 `preview.pdf` 被外部 PDF 阅读器/杀毒软件独占，或磁盘满，`copyFile`/`rename` 抛 `EBUSY`/`ENOSPC`。此时 #runOne 的 catch 把已完成的成功构建记为 failure，`project.diagnostics` 不更新，preview 不发布。
- **后果**：成功编译被误判失败；工具只显示异常串（不含 latexmk 结果）；用户重试可能再次失败。
- **证据**：源码；未制造文件锁。Windows 上外部程序以非共享方式打开 preview.pdf 时可能发生（本机无复现条件）。
- **建议修法**：把发布步骤单独 try/catch；发布失败仍返回 success 并附 `publishError` 警告，或重试 2-3 次后再降级；不要把发布失败与编译失败混用同一个 status。

#### M11 `clean` 与 build 并发无保护，且可能删除 `.latexmkrc`

- **位置**：`src/service.js:680-694`（`clean` 不检查 `project.building`、不取消构建）、`src/build.js:500-552`（递归删除；`:523` 把 `entry.name === '.latexmkrc'` 当作可删文件）
- **触发条件**：
  - 构建运行中点击 clean / 调用 `latex_clean`，删除正在写的 `.aux/.log/.synctex.gz`，latexmk 可能报 “I can't write on file ...”，甚至产出不完整 PDF。
  - `buildDir='.'`（`normalizeConfig` 允许 `.`：非绝对路径且不含 `..`）时，`clean` 递归项目根：会删掉根下 `.aux/.bbl/.log/.synctex.gz` 以及 **`.latexmkrc`**（:523），与 README“never sources/不删源码”的承诺只差一个后缀判断。
- **后果**：构建损坏、项目配置被删；`buildDir='.'` 还会让 watcher 忽略整个项目（L17）。
- **证据**：源码；`buildDir` 默认 `build`，所以默认配置不受影响；未在 fixture 上执行 clean。
- **建议修法**：`clean` 前若 `building` 或 `queued>0` 返回 409/拒绝（或先 cancel 并等待）；绝不删除 `.latexmkrc`；拒绝 `buildDir='.'`（至少警告）。

#### M12 恢复态下 `latex_get_diagnostics` 宣称 0 错误/上次成功

- **位置**：`src/service.js:215-253`（当前源码恢复 `previewVersion`，并把 `lastBuild.status` 设为 `success`/reason `restored`）、`src/tools.js:271-298`（`lastBuild.status === 'success'` 时打印 “The last build succeeded; any stale error above is historical.”；`project.diagnostics` 是进程内空集）
- **触发条件**：Host 重启/插件重载后，第一次对“只有 `last-build.json`、没有本次构建内存状态”的项目调用 `latex_get_diagnostics`。
- **后果**：输出类似 `status: success (restored) / errors: 0 / warnings: 0 / The last build succeeded`，但**诊断数据并没有恢复**；如果源码在重启后被改坏，模型可能被误导为“当前源码已通过”。（brief 已把“历史/诊断不持久”列为已知限制，但工具文案没有把“诊断为不可用”说清楚。）
- **证据**：附录 A.3 的运行时输出（旧代码实例）为 `status: idle / errors: 0 / warnings: 0`；当前源码会进一步显示 success restored，但诊断同样为空。
- **建议修法**：恢复状态标记 `diagnosticsRestored=false`；工具输出“diagnostics are unavailable after a Host restart; run latex_compile”；不要把 recovered 的 `lastBuild` 与真实诊断混为一谈。

#### M13 `previewSurface` 配置对工具触发的 preview 无效

- **位置**：`src/service.js:664-678`（`surface: surface === 'document' ? 'document' : 'native'`：未传时**总是** native）、`src/tools.js:227-232`（`latex_preview` 只在显式 `surface` 时传）、`src/routes.js:455-461`（action preview 同）、`client.js:417-424`（`surface ?? snapshot.config.previewSurface ?? 'native'`——本应回退 config，但 `request.surface` 永远有值）
- **触发条件**：`config.previewSurface: 'document'`，模型调用 `latex_compile`（`open` 默认 config.autoOpenPreview=true）或 `latex_preview` 未传 `surface`。service 把请求 surface 固定为 `native`，客户端的 config 回退永远不会生效。
- **后果**：配置项在“工具触发”路径被忽略，只有 UI 自身调用 `openPreview` 时才遵守；行为与 README 表格描述不一致。
- **证据**：源码链路。
- **建议修法**：`requestPreview` 的默认值改为 `this.config.previewSurface`（`document`/`native`），或未指定时把 `surface` 留空，让 client 走 config 回退。

### 3.3 Low / Nit

| ID | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| L1 | service.js:308-313 | watcher `error` 后只把 `watchActive=false`，`project.watchHandle` 仍是非空句柄，`startWatch` 的 `if (project.watchHandle) return` 导致**永远不会重试**；`setAutoBuild(true)` 也救不回来 | error 时 `close()` 并清空 handle，然后退避重连 |
| L2 | service.js:917-923、636-648 | `dispose()` 不清空/拒绝 `project.queue`，也不叫醒 semaphore waiter；插件 HMR/卸载时排队中的工具 promise 悬挂 | dispose 时 reject 所有 queued job 并清空 waiters |
| L3 | routes.js:478-495、service.js:716-735 | SSE 没有 `res.writableLength` 背压/踢出策略（cheatsheet D.4 建议 256KiB 上限）；快照含所有项目 × 最多 80+80 条诊断 × 4KB raw | 增加 `writableLength` 阈值；快照只带当前项目或裁剪 raw |
| L4 | service.js:696-710 | `readLog` 先整文件 `readFile`（build.js 允许 32MB）再 `tailText`，内存尖峰 | 用 `open`+`read` 尾部偏移读取，或限制 stat.size |
| L5 | service.js:697 | 日志候选固定为 `<stem>.log`；若 jobname/主文件变化，可能读到旧日志 | 用 `lastBuildResult.logPath` 优先，或校验 mtime |
| L6 | service.js:215-253 | 恢复 `last-build.json` 时不校验 `meta.mainFile === project.mainFile`、也不校验 `preview.pdf` 存在；当 `.dsh-latex/` 被随项目一起复制时会报告“别人的 version”（运行时 `e2e/synctex/no-synctex` 显示与 ascii-project 相同的 version，符合该情形，见附录 A.1） | 校验 mainFile/pdfPath/preview 存在性；不匹配则忽略 |
| L7 | service.js:852-857 | forward SyncTeX 的 `file` 用 `path.resolve(rootDir, ...)`，绝对路径可指向项目外；没有 allowedRoots/root containment（仅作 synctex 查询键，不读源码） | 限制在 `rootDir`/allowedRoots 内，或明确文档化为“按 synctex 记录匹配” |
| L8 | service.js:874-888 | inverse 越界 page 时 synctex 退出 0 并在 stdout 打 banner，service 返回 “found no source location + This is SyncTeX command line utility, version 1.5...”，工具仍当成功文本返回 | 解析 exitCode/添加明确 `error` 标记；过滤 banner |
| L9 | routes.js:431-439 | `/latex/action` compile 在 HTTP handler 里 `await` 整个构建；Node 默认 `server.requestTimeout=300s`，配置 timeout 最大 1h，长构建可能被 HTTP 层掐断（DSH 是否覆盖未知） | 改为异步受理 + SSE 进度，或确认/设置 webServer requestTimeout |
| L10 | routes.js:181-204、152-173 | `rankForSession` 最后回退到“全局最近项目”，`pickProject` 的 `cwd` 匹配允许“cwd 是 rootDir 的祖先”；无项目的 session 会拿到别的项目作为 `activeProjectId` | 无 session 项目时返回 undefined，让 client 显示空态 |
| L11 | routes.js:254-261 | `/latex/health` 匿名泄漏 pid、TeX 绝对路径、全局项目数（实测 200 JSON） | 仅返回 `{ok, version}`；或至少去掉 pid/路径/计数 |
| L12 | routes.js:28 | `ASSET_NAMES` 含 `LICENSE-pdfjs.txt`，实际文件是 `assets/licenses/PDFJS-NOTICE.txt`，该 URL 恒 404 | 修正白名单或把 notice 放到 `assets/LICENSE-pdfjs.txt` |
| L13 | util.js:144-190 | `Semaphore`/`abortError`/`displayPath`/`sessionFileAddress` 是 Host 侧死代码；`#releaser` 的 `next.signal?.removeEventListener(...)` 中 waiter 没有 `signal` 字段（:185），若启用会在正常 release 时泄漏 abort 监听器；同类死配置还有 `config.engineFlag`、`config.keepBuildLogTail`、`project.engineExplicit`（写入后无人读取） | 删除死代码/死配置，或修 `waiter.signal` 并复用 |
| L14 | util.js:13-16 | `projectIdOf` 对绝对路径 `toLowerCase()`；在大小写敏感文件系统上 `/a/X` 与 `/a/x` 会碰撞（当前 Windows 目标下可接受） | 按平台条件小写，或把大小写保留进 hash |
| L15 | project.js:236-265（:248） | `DependencyIndex` 把每个 `.tex` 的全文保存在 `text` 字段（refresh 之后不再使用），最多 6,000 个、单文件 4MB；`Promise.all` 对最多 6,000 个文件并发 `readFile`，可能 EMFILE/内存尖峰 | 不保存 text；用 `p-limit` 式并发上限（如 16/32） |
| L16 | logparse.js:172-190、:192-215 | `fileStack` 用 `(`/`)` 计数近似，消息里的括号会误 pop，经典 `!` 错误可能归到错误文件；`-file-line-error` 的 79 列折行续行不拼接（`max_print_line=2000` 已大幅缓解） | 解析时只统计行首/受限的括号；对折行做续行合并（至少 file:line 行） |
| L17 | service.js:357-358、build.js:148-151 | `buildDir='.'` 时 `isInside(buildDirAbs, any)` 恒真 → watcher 忽略整个项目，autoBuild 永不触发；build 的 `#prepareIncludeDirectories` 也会跳过所有子目录 | normalizeConfig 拒绝 `.`（或至少 warning） |
| L18 | routes.js:292-314 | `/latex/pdf` 先 `stat` 再 `createReadStream`，期间原子发布可能替换文件，`content-length` 与实际字节不符（客户端会重试下一版本） | 用同一 `FileHandle` 取 size 后读流，或忽略 content-length |
| L19 | routes.js:67-114 | `readJsonBody` 没有整体读取超时；慢速上传（chunked、持续 <64KB）可长期占用连接（Node requestTimeout 可缓解） | 加 AbortSignal/总超时 |
| L20 | build.js:469-491 | `#findOutputPdf` 在多个 PDF mtime 相差 <50ms 时直接返回 undefined → 成功构建被误判 failure（很快速的两次连续构建/并行产物） | 用本 build 的 `-jobname`/log 输出定位，或放宽/记录候选 |
| L21 | routes.js:279-286、470 | SSE 的 `sessionId` 传入 `openEventStream` 后**未被使用**，`snapshot()` 又把全部项目的绝对路径、诊断、preview 请求广播给任何已准入的浏览器会话；`latex_get_status all:true` 同理。单用户 loopback 下风险低，但跨 session 可见性/隐私边界不清晰 | 按 session 过滤项目，或至少让 snapshot 只带当前 session 的项目；SSE 使用 session 参数 |
| L22 | service.js:874-892、client.js:1470-1478 | `syncTeX` 只返回人类可读字符串。inverse 在 `Column:` 未匹配时输出 `main.tex:10`（实测），client 的 `/:(\d+)(?:\s|\()/` 要求数字后跟空白/`(` → **行号丢失**；路径含空格时 `source` 正则还会在空格处截断（`带 空格/main.tex:13` → `带`）。这是 Host 输出契约与 client 解析的组合缺陷（详见 `docs/synctex-notes.md`） | 服务端改为返回结构化 `{file,line,column}`，或固定格式 `file:line:column`；client 侧同步改正则 |

---

## 4. 已核对（未发现问题）的项目

以下各项都对照了源码与（可行时）真实日志/工具输出；没有发现问题，或发现的是设计上可接受的限制。

1. **无 shell / argv 注入**：`build.js:190-210` 构造 argv 数组，`ctx.subprocess.spawn({ argv, cwd, ... })`（:235-246）；`syncTeX` 同样纯 argv（:850-871）。Host 源码（index.js + src/*.js）中 `grep` 没有 `child_process`、`exec`、`createServer`、`listen`；插件不新开监听端口（`routes.js` 只向 `ctx.get('webServer')` 注册）。
2. **`-shell-escape` 不由代码注入**：`ENGINE_ARGS`（build.js:58-62、198-201）只含 `-xelatex/-pdf/-pdflua`；`extraLatexmkArgs` 只能来自 profile 配置（:203-205），不是模型/工具可控。注意这是“配置信任边界”而非“调用者不可注入”（配置管理员仍可加入 `-shell-escape`，见 M8 的说明）。
3. **buildDir 逃逸防护**：`config.js:82-86` 拒绝绝对路径与含 `..` 的 buildDir；`build.js:147-151` 再次用 `isInside(rootDir, buildDirAbs)` 兜底；`mainRelative`（:206-210）拒绝主文件逃出 root。`clean` 每次删除前都 `isInside(buildDirAbs, absolute)`（:514）。
4. **PDF 路由只服务已注册项目的 preview**：`routes.js:289-300` 从 `service.getProject(id)`/注册表取 `project.paths.previewPath`，并双重校验 `isInside(buildDirAbs, target)` 与 `isInside(rootDir, target)`；`previewPath` 只由 `build.js:147-163` 计算。未发现路径拼接注入（query 只当 id/cwd 用）。
5. **资源路由白名单**：`ASSET_NAMES` 精确匹配（routes.js:28、332-338），`pathname` 用 `new URL()` 规范化，`..` 段不会落到 `path.join(ASSET_DIR, name)`；实测无 cookie 访问 `/latex/assets/pdf.min.mjs` 返回 401（鉴权先于资源读取）。
6. **鉴权边界**：`routes.js:254-261` 只有 GET `/latex/health` 跳过 `admit`；其余所有分支在 :263 之前统一 `admit(ctx, req, res)`。实测 `/latex/state`、`/latex/assets/*` 未带 cookie 均 401；`admit` 在 `connection` 服务缺失时 503、`rejection` 时 401/403、无 `peer` 时 403（代码路径完整）。
7. **进程管理（超时/取消/树杀）**：`build.js:214-230` 用 `AbortController`，`ctx.subprocess.spawn({ signal, graceMs: 5_000 })`；`subprocess` 的 Job object 语义见 `docs/api-cheatsheet.md` §E.2。`handle.done` 后清 timer/监听；未用 `taskkill` 等旁路。`cancel()` 会 abort 正在运行的构建（`service.js:653`）。（semaphore 等待期是例外，见 M1。）
8. **原子发布与失败保留**：`util.js:62-86` 先写同目录 temp 再 rename；`build.js:319-339` 只有 success 才 `atomicCopy` 到 `preview.pdf`，失败/超时/cancel 不改 preview（service.js:514-516 只置 `stale`）。失败保留旧 PDF 的设计与 README 一致。
9. **日志解析真实样本**（附录 A.2）：对 `single-math`/`chinese-ctex`/`multi-file`/`biblatex-biber` 四份真实干净日志解析均为 `0 errors / 0 warnings`；对 `error-case/build/main.log` 解析出 `Undefined control sequence.` @ `main.tex:4`（与验收 D 的已知结果一致）；合成的 `file:line`（含 Windows 盘符）、经典 `!`+`l.N`、`LaTeX/Package Warning`、overfull、包错误、`(`/`)` 文件栈均按预期归类。Biber 日志是明确缺口（M5），不是“解析错误”。
10. **配置归一化边界**：`config.js:42-113` 对 engine 枚举、buildDir、debounceMs(100-30000)、timeoutMs(5000-3600000)、maxConcurrentBuilds(1-8)、maxPrintLine(79-100000)、keepBuildLogTail(65536-8388608)、allowedRoots(≤32)、extraLatexmkArgs(≤32) 都做了类型/范围/长度限制；非法值回退默认而不是抛错（README 承诺一致）。`extraLatexmkArgs` 拒绝空串/NUL。
11. **项目识别主路径**：`resolve()` 的 显式 → `% !TEX root` → 自身 `\documentclass` → 反向 `\input/\include` → cwd 搜索（project.js:380-542）与 README 描述一致；`cleanReference` 拒绝反斜杠、`#`、`{}` 与空白（引号只剥首尾），`stripComments` 避开 `\%`；`resolveReference` 只在扫描索引内命中（:251-261），不会因 `\input{..\..\x}` 读索引外文件。C 项验收（章节文件反查 main.tex）由此路径支撑。
12. **SyncTeX 工具级输出**（附录 A.1）：`latex_synctex forward file=main.tex line=13 column=1` → `SyncTeX forward: page 1 at (125.798264, 699.048828)`；`inverse page=1 x=125.8 y=285.6` → `SyncTeX inverse: main.tex:10`（服务端能解析 `Input:/Line:`）。但 inverse 返回串在无 `Column:` 时以 `:N` 结尾，client 的 `/:(\d+)(?:\s|\()/`（client.js:1470）不会命中，行号会丢失；路径含空格时 source 解析还会截断。详见 L22 与 `docs/synctex-notes.md`。
13. **SSE 生命周期**：`openEventStream`（routes.js:470-513）先 `subscribe` 再发首帧（不会漏更新），15s heartbeat + `unref`，`res.on('close'/'error')` 幂等 cleanup，`streams` 上限 24，disposer 会统一关闭（:405-419）。未发现监听器/定时器泄漏。
14. **`tool.js` 兼容层与 live 契约**：`defineTool` 编译的 parameter DSL、`required:true` 收集、enum/类型校验、`isConcurrencySafe` 包装与 `docs/api-cheatsheet.md` §C 的官方 `defineTool` 形态一致；插件不 import Harness 包，符合 `link:` 安装约束。
15. **`package.json`/`dsh.client` 声明**：`exports` 暴露 `./client`、locale、icon；`dsh.bundle.patch` 指向 `cordis.patch.yml`；`dsh.client.inject` 三项与 client.js 实际使用的 `runtime.ctx.sidebarRight`/locale/theme 对应。未发现声明缺失。
16. **HTTP/客户端响应形状**（仅 Host 侧）：`/latex/state` 返回 `{...snapshot, activeProjectId}`；SSE 事件名 `state`；`/latex/action` 返回 `{ok,result|previewRequest,snapshot}`；`/latex/log` 为 text/plain；`/latex/synctex*` 为 `{ok,result}`；`/latex/pdf` 为 application/pdf。与 client.js 的读取点（`client.js:247、279、289、758、896、1210、1463`）一致。
17. **env 最小化**：`buildEnv` 只给 `PATH/Path/max_print_line`（build.js:73-83）。本环境已由 Lead/其他子任务实测 xelatex/pdflatex/lualatex、ctex、biber 均成功，说明该组合可用；但它不继承 `TEXMFVAR`/`TEXMFCACHE`/`TEMP` 等用户级变量，属于“已核对可用但有环境依赖”的风险项（未记为 finding）。

---

## 5. 运行时与源码的版本漂移（重要）

- `/latex/health`：`startedAt = 1793694010266` → **2026-11-03T08:20:10.266Z（16:20:10 +08:00）**。
- 源文件 mtime（UTC / +08:00）：
  - `src/tools.js` 08:20:03.840 / 16:20:03
  - `client.js` 08:19:59.427 / 16:19:59
  - `src/service.js` **08:23:09.466 / 16:23:09**
  - 其余更早（index.js 07:56:03Z、project.js 08:00:14Z、build.js 08:12:17Z、logparse.js 08:11:34Z、routes.js 08:15:28Z）
- 运行时观察与当前 `src/service.js:215-253` 不一致：
  - 对 `single-math` 调用 `latex_get_status`（本会话；该项目在 Host 启动后更早注册，`all:true` 的插入顺序显示它早于 16:24:51 注册的 e2e 项目）返回 `preview: version 1793693460674 | pages 1`，但 **`status: idle`、没有 last build 行**。按当前源码，`#restorePublishedState` 会把 `project.status='success'` 并写入 `lastBuild={status:'success',reason:'restored',...}`，应显示 `status: success` 且有 last build。
  - `latex_get_diagnostics` 同项目返回 `status: idle / errors: 0 / warnings: 0`，没有当前源码的 “restored” 语义。
  - `latex_get_status all:true` 里多个项目呈现 `never built | preview v<非零>`。当前源码在恢复时必然同时写 status/lastBuild，`projectStatusLine`（tools.js:82-93）不会显示 “never built”。
- 这说明：**线上 Host 仍在运行 16:20 加载的旧 `service.js`**（或 Node ESM 模块缓存使 recompose 未生效）。这一现象与 `docs/acceptance.md` §1.4 的独立观察一致（`startedAt` 不变、`projects` 计数从 3 持续增加，证明 HMR 没有重建服务实例）。本任务禁止重启 DSH，所以无法在 agent 侧重载验证。建议 Lead 在最终验收/修复后执行一次真实的 profile recompose + 进程内重载（确认 `startedAt` 变化），再重跑 acceptance 的关键项；否则 `docs/acceptance.md` 等运行证据可能对应旧代码。
- 本文所有源码行号以工作区当前文件为准；工具级运行证据（第 4 节第 9/12 项、附录 A）来自上述旧实例，特此标注。

---

## 6. 无法在 agent 侧验证 / 未验证清单

- **NOT VERIFIED（运行时）**：M1 的 semaphore 等待期取消（需要占满 2 个 permit 的并发构建）；H1 的队列时序（需要构建中再入队，且要写 fixture）；M2/M8 的 allowedRoots/rc 触发（需要改 profile 或写 `.latexmkrc`）；M3 的 rc/DVI 行为（同上）；M4 的旧 PDF 判成功（需要特殊 rc 或 jobname 场景）；M10 的文件锁发布失败；M11 的 clean/build 竞态（未运行 clean）；L9 的 HTTP requestTimeout；L18 的 TOCTOU。
- **NOT VERIFIED（UI）**：PDF.js viewer 像素级行为、双击反查坐标、tab 两阶段注册、locale/slot 契约属于 client-review 范围，本文只做 Host 接口形状的交叉检查。
- **无法执行**：重启 DSH、停/启插件、修改 profile 或 `cordis.patch.yml`、修改源文件、复制 fixture 到 `e2e/`（本任务写路径只有 `docs/review-host.md`）。
- 已知限制（brief 已列，本文确认源码对应位置）：构建历史/诊断只在内存（service.js:192-195、:215-253 只恢复 preview 与 last-build 概要，不恢复诊断/日志）；无 settings schema（未导出 `Config`）；`timeoutMs` 下限 5000（build.js:213）；viewer 按需渲染、内建文档预览页码属 DSH（client 范围内）。

---

## 7. 建议修复顺序（给 Lead）

1. **H1**：改 `#pump` 的合并逻辑，保证任何被丢弃的 job 都 settle；这是唯一会让工具/HTTP 永久悬挂的问题。
2. **M1**：`abortController` 提前到 `acquire` 之前，并给 semaphore 加 abort；否则取消在并发场景下不可信。
3. **M3/M4**：修正 rc 与 engine 的优先级，并用“本次构建是否真正写出 PDF（mtime/log Output written on）”判定 success；否则“成功”与 preview 版本都不可信。
4. **M5**：补 Biber `.blg`；biblatex 项目的诊断质量依赖它。
5. **M2/M6/M8**：allowedRoots 对 magic-root 生效；项目 key 加 mainFile；文档化/开关化 rc 执行（安全）。
6. 其余 medium：M7（clamp）、M9（目录契约）、M10（发布失败不降级）、M11（clean 与 build 互斥）、M12（恢复态文案）、M13（previewSurface）。
7. low/nit 按第 3.3 节批量清理；其中 L1/L2 与 HMR/长期运行稳定性相关，建议不要留到最后。

---

## 附录 A：本会话的原始调用与输出（可复核）

### A.1 只读工具调用

```
latex_get_status { path: D:\deepseekharness\latex-plugin-tests\synctex\main.tex }
→ toolchain: ready | latexmk: D:\latex\...\latexmk.exe
  project: D:\deepseekharness\latex-plugin-tests\synctex
  main: ...\main.tex
  engine: xelatex | build dir: ...\build
  status: idle | auto-build: true | watching: true
  preview: version - | pages - | none
  pdf: ...\build\main.pdf | preview file: ...\build\.dsh-latex\preview.pdf

latex_synctex { path: ...\synctex\main.tex, direction: forward, file: main.tex, line: 13, column: 1 }
→ SyncTeX forward: page 1 at (125.798264, 699.048828)

latex_synctex { ..., direction: inverse, page: 1, x: 125.8, y: 285.6 }
→ SyncTeX inverse: main.tex:10

latex_synctex { ..., direction: inverse, page: 99, x: 10, y: 10 }
→ SyncTeX inverse lookup found no source location.
  This is SyncTeX command line utility, version 1.5
  （其余为 usage/banner 文本；退出码被忽略）
```

`latex_get_status all:true`（节选，25 个项目）：

```
- ...\chinese-ctex\main.tex | xelatex | never built | preview v1793693772967
- ...\error-case\main.tex  | xelatex | never built | preview v-
- ...\synctex\main.tex     | xelatex | never built | preview v-
- ...\e2e\acceptance\A-single-math\main.tex | xelatex | success at 16:25:28 in 3.9s | preview v1793694328930
- ...\e2e\synctex\no-synctex\main.tex | xelatex | never built | preview v1793694291992
  （no-synctex 的 version 与 ascii-project 相同——见 L6 的复制 fixture 场景）
```

### A.2 日志解析直调

对真实 `.log`（`node --input-type=module`，直接 import `src/logparse.js`）：

```
== single-math     counts {"errors":0,"warnings":0,"overfull":0} pages 1 source log
== chinese-ctex    counts {"errors":0,"warnings":0,"overfull":0} pages 1 source log
== multi-file      counts {"errors":0,"warnings":0,"overfull":0} pages 1 source log
== biblatex-biber  counts {"errors":0,"warnings":0,"overfull":0} pages 1 source log
== error-case      counts {"errors":1,...} pages 1 source log
   E latex-error D:\...\error-case\main.tex 4 | Undefined control sequence.
```

合成样本（节选）：

```
fileLine   -> E latex-error main.tex:4  Undefined control sequence.
              E latex-error main.tex:42 LaTeX Error: Invalid character.
classic    -> E undefined-control-sequence main.tex:4
warning    -> W undefined-reference main.tex:5 ; W latex-warning (Package hyperref)
overfull   -> W overfull main.tex:12 endLine 14
bangPkg    -> E package-error main.tex:5 "Option clash for package biblatex"
stack      -> E latex-error D:\proj\sections\ch1.tex:5 ; E missing-file D:\proj\missing.tex:3
fileLineWarn -> W latex-warning main.tex:12 (带括号的 file:line)
```

### A.3 工具契约实测

```
latex_get_status { path: D:\...\single-math }     # 目录
→ Error: File not found: D:\deepseekharness\latex-plugin-tests\single-math

latex_get_status { project: D:\...\single-math }
→ project: ...\single-math
  main: ...\main.tex
  engine: xelatex | build dir: ...\build
  status: idle | auto-build: true | watching: true
  preview: version 1793693460674 | pages 1 | current

latex_get_diagnostics { path: D:\...\single-math\main.tex }
→ LaTeX diagnostics for ...\main.tex
  status: idle
  errors: 0 | warnings: 0
```

### A.4 Node `setTimeout` 溢出（本机 v24.12.0）

```
$ node -e "const t0=Date.now(); setTimeout(()=>{console.log('FIRED after',Date.now()-t0,'ms');},1e12)"
(node:13236) TimeoutOverflowWarning: 1000000000000 does not fit into a 32-bit signed integer.
Timeout duration was set to 1.
FIRED after 1 ms
```

### A.5 latexmk rc 行为（TeX Live 2023 自带 `latexmk.pl`）

```
:1238   $auto_rc_use = 1;              # Whether to read rc files automatically
:1875-1889  # -norc 在读取 rc 之前预扫描 argv
:1944   read_first_rc_file_in_list( ".latexmkrc", "latexmkrc" );
:4257   sub process_rc_file
:4304-4323  读取 rc 全文后  eval $code;
:361-366   %compilation_defaults = ('latexmk' => [1,0,0,0], ...)
:2492   unless (...) { ($dvi_mode,...) = @{$compilation_defaults{$invoked_name}} }
```

### A.6 Biber `.blg` 真实样本与解析

```
$ head -3 latex-plugin-tests/biblatex-biber/build/main.blg
[0] Config.pm:307> INFO - This is Biber 2.19
[0] Config.pm:310> INFO - Logfile is 'build/main.blg'
[234] biber-MSWIN64:340> INFO - ===

parseBibLog(真实 blg) -> {"errors":[],"warnings":[]}
parseBibLog("[0] Biber.pm:419> ERROR - Cannot find 'refs.bib'!") -> {"errors":[],"warnings":[]}
```

### A.7 源码静态检查

```
$ cd latex-plugin && for f in index.js client.js src/*.js; do node --check "$f" || echo "SYNTAX FAIL $f"; done
checked 11 files
```

### A.8 inverse 输出与 client 正则的组合验证（L22）

```
$ node -e "const re=/:(\d+)(?:\s|\()/; ..."
"SyncTeX inverse: main.tex:10"                    -> line=undefined  source="main.tex"
"SyncTeX inverse: main.tex:13 (column 0)"         -> line=13         source="main.tex"
"SyncTeX inverse: 带 空格/main.tex:13 (column 0)" -> line=13         source="带"
```

与运行时实测（A.1：`SyncTeX inverse: main.tex:10`，没有 column）一致：当前服务端输出会让 client 拿不到行号；带空格路径会在 source 解析处被截断。

---

## 附录 B：Finding 索引（按文件:行号）

| 位置 | ID | 级别 |
| --- | --- | --- |
| src/service.js:425-433 | H1 | high |
| src/service.js:468-480、634-657 | M1 | medium |
| src/project.js:482-500 | M2 | medium |
| src/build.js:189-201、392-398 | M3 | medium |
| src/build.js:310-315、469-491 | M4 | medium |
| src/logparse.js:392-412 | M5 | medium |
| src/service.js:156、200-206 | M6 | medium |
| src/tools.js:161-165、src/routes.js:431-439、src/build.js:213 | M7 | medium |
| src/build.js:189-201（+ latexmk.pl:1944/4304-4323） | M8 | medium |
| src/tools.js:124-128、src/project.js:381-382/470-476 | M9 | medium |
| src/build.js:319-339、src/service.js:574-580 | M10 | medium |
| src/service.js:680-694、src/build.js:500-552 | M11 | medium |
| src/service.js:215-253、src/tools.js:271-298 | M12 | medium |
| src/service.js:664-678、src/tools.js:227-232 | M13 | medium |
| 见第 3.3 节 | L1-L22 | low/nit |
