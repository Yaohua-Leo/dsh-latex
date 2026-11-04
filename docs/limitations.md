# dsh-latex 限制与已知缺陷

> **更新（2026-11-03 深夜）**：本文记录的缺陷中，队列合并丢 manual job、semaphore 取消失效、
> clean/构建竞态、magic-root 绕过 allowedRoots、`.latexmkrc` 回退 DVI、SyncTeX 行号/空格/CJK 解析、
> 客户端缩放空白等已在 review 后修复，逐项见 **`docs/review-fixes.md`**。本文其余“限制”仍成立；
> 涉及已修项的段落只作为历史问题记录，最新行为以源码和 `acceptance.md` 附录 L 为准。
>
> **更新（2026-11-04，v0.2.0）**：`.tex` 现在直接打开为可编辑 tab，保存即编译并刷新已开的 PDF 预览。
> 编辑器的限制：纯 textarea（无语法高亮/补全/多光标）、显式保存（无自动保存）、中文输入法组合期间
> Ctrl+S 可能被吞、关闭 tab 丢弃未保存内容、仅 UTF-8 `.tex` ≤4 MiB、不能新建文件、没有只读预览模式。
> 详见 `acceptance.md` 附录 M4。

本文件是 `docs/architecture.md` 的补充：架构文档说明**怎么工作**，这里说明**哪里不行、为什么不改、怎么绕**。
所有条目都标了证据来源（源码行号 / 本机文件 / 真实命令返回），没有验证过的一律写
`NOT VERIFIED (agent-side)`，不臆测。

- 代码基线：`latex-plugin` 源码，mtime 2026-11-03 15:52–16:23（各文件行数见 `architecture.md` §0.1）。
- 运行基线：`http://127.0.0.1:50802/latex/health` 返回
  `{"ok":true,"name":"dsh-latex","version":"0.1.0","pid":34656,"startedAt":1793694010266,"projects":3,...}`
  （`startedAt` = 本地 16:20:10，早于 `src/service.js` 的 16:23:09 修改）。
- 严重度：**高** = 会错/会挂/会误导用户；**中** = 功能或体验有明确缺口；**低** = 边角情况；
  **提示** = 设计取舍，不一定需要修。

---

## 1. 持久化与生命周期

### 1.1 构建历史与诊断只在 Host 进程内存里【中】

`LatexService` 的所有历史字段（`lastBuild`、`lastBuildResult`、`diagnostics`、`lastSuccess`、`runs`、
`buildsStarted/buildsFinished`）都挂在 `projects` Map 里的普通对象上（`service.js:164-196`），
`dispose()` 直接 `projects.clear()`（`service.js:917-923`）。Host 进程一换，这些全部消失。

重启后唯一能恢复的是成功发布物：`#restorePublishedState`（`service.js:215-253`）读
`<buildDir>/.dsh-latex/last-build.json`，恢复 `previewVersion / previewPages / previewUpdatedAt`，
并合成一条 `reason:'restored'` 的 `lastBuild`（`exitCode:0`、`errors:0`、`warnings:0`、`logPath:undefined`）。
**不会**恢复：错误/警告明细、历次状态迁移、构建原因序列、`previewRequest` 序号、`stale` 标志。

影响：重启后 `latex_get_diagnostics` 只会说「last build succeeded」，看不到上一次失败的原因（除非还留着
build 目录里的 `.log`，那需要用户自己看）；UI 也不会显示历史。

绕法：需要历史就把诊断/日志另存（`build/<stem>.log` 本身还在 build 目录里，不会被删）。

### 1.2 「重启后恢复」的证据在当前进程里对不上【提示】

本机实测（`latex_get_status all:true`）：

```
toolchain: ready | latexmk: D:\latex\texlive2023\texlive\2023\bin\windows\latexmk.exe
projects: 3
- ...\single-math\main.tex | xelatex | never built | preview v1793693460674
```

`previewVersion` 有值（来自 meta 恢复或本进程构建），但单项目查询显示 `status: idle`、没有 `last build` 行。
按源码 `service.js:220-249`，恢复成功时应置 `status='success'` 并写入 `lastBuild`。最可能的解释是
**运行中的 Host 早于 16:23 那次 `service.js` 修改**（`startedAt` 16:20:10），而不是源码逻辑本身有问题。
→ 这条差异本身是「Host 侧改动需要 recomposition 才生效」的实测证据（见 §12.2）；
在 recomposition 之后应重新核对一次 `latex_get_status` 的输出。

### 1.3 没有常驻服务、没有可查询的历史接口【提示】

插件不 `listen`、不开端口，HTTP 路由挂在 Harness 的 `webServer` 上（`routes.js:233-239`）。
Harness 退出后没有任何东西在跑，「构建中崩溃」只能靠 build 目录里的残留文件判断。
也没有「历史构建列表」接口：`/latex/state` 只回当前快照（`service.js:716-736`）。

### 1.4 项目注册表有上限，且会静默驱逐【低】

`MAX_PROJECTS = 32`（`service.js:51`），超过时按 `lastUsedAt` 从最旧开始 `disposeProject` + `delete`
（`service.js:255-265`），只挑「不在构建且队列为空」的项目。被驱逐的项目会丢掉 watcher 与 `sessionIds`
（`sessionIds` 是 `Set`，`service.js:207`），下次访问会重新注册、重新恢复 meta。
影响：极端多项目工作区里，面板/选项目的记忆会跳。

---

## 2. 项目识别

### 2.1 一切都是启发式，多个 root 时必须显式指定【中】

规则见 `project.js:380-542`。当同一文件被多个文档 `\input`、或 cwd 下有多个 `\documentclass` 文件、
或目录里有多个 `main/paper/...` 同优先级候选时，会抛 `LATEX_AMBIGUOUS_ROOT` 并列出候选
（`project.js:520-528`、`project.js:455-466`），不会替你猜。这是有意行为，但表现为「工具报错、需要传 path」。

### 2.2 依赖索引是近似的【低】

- 只认 `\input/\include/\subfile/\InputIfFileExists/\import` 这几种写法（`project.js:28-30`），
  通过用户命令或宏展开的引入（`\newcommand` 里拼路径、`\graphicspath` 之外的动态路径）不建边；
- 跳过的目录：`node_modules/.git/.hg/.svn/.dsh-latex/.cache/__pycache__/dist/.venv/venv/site-packages`
  与所有点开头目录（`project.js:46-58`、`project.js:166`）；
- 索引上限 6000 个 `.tex`（`project.js:60`），深度 8（`project.js:164`）；
- 索引 TTL 10 s（`project.js:61`），watcher 收到 `.tex` 变化会 `invalidate`（`service.js:363`），
  但**工具直接改文件（非本进程写入）且没触发 watcher** 时可能短时间用到旧索引。

### 2.3 `% !TEX root` 指错就直接失败【提示】

`project.js:496-500`：指令存在但目标文件不存在 → `LATEX_MAGIC_ROOT_MISSING`，不会回退到其它规则。
设计上正确（用户已表态），但模板里的过期指令会让「以前能用」的项目突然报错。

### 2.4 `allowedRoots` 默认放行一切【中（安全侧见 security-audit）】

默认 `allowedRoots: []`（`config.js:32`），`assertAllowed` 直接 return（`project.js:600-603`）。
它也只校验**主文件路径**，不额外校验结果里派生的 build 目录（后者另有 `isInside` 保护，`build.js:149-151`）。
需要边界时必须在 profile 里显式配置。

### 2.5 只做「主文件」识别，不做多文档工作区编排【提示】

一个项目 = 一个 rootDir + 一个 mainFile（`service.js:164-170`）。同一目录下并存的多个文档会被当成多个项目；
没有「一次编译全部」的能力。

---

## 3. 构建：超时、取消、并发

### 3.1 `timeoutMs` 下限被 clamp 到 5000 ms【中】

- 工具参数：`latex_compile` 的 `timeoutMs` 原样传给 `enqueueBuild`（`tools.js:179`），到 `build.js:213`：
  `Math.max(5_000, Number(options.timeoutMs) || this.config.timeoutMs)`。
- 配置：`normalizeConfig` 同样强制 5000..3_600_000（`config.js:100`）。

所以传 `timeoutMs: 1000` 不会更快失败，实际是 5 s。写测试/CI 时别指望用更小值。
另外「传 0 / NaN」会回落成 `config.timeoutMs`（180 s 默认），不是 5 s——这是 `||` 的语义，容易误判。

### 3.2 `cancel` 无法中止「已出队、正在等并发许可」的构建【中】

`#runOne` 先 `building=true, status='queued'`（`service.js:464-467`），再 `await semaphore.acquire()`
（`service.js:468`），`project.abortController` 在 `acquire()` **之后**才赋值（`service.js:469-470`）。
这段窗口里：

- job 已经不在 `project.queue` 里 → `cancel()` 的「清空队列」覆盖不到（`service.js:635-650`）；
- `project.abortController` 还是 `undefined` → `abort()` 无效果（`service.js:653`）；
- `cancel()` 却会因为 `running = project.building === true` 返回 `{cancelled: true, running: true}`。

结果：用户看到「已取消」，构建随后仍然开始，并把 status 改成 `running`。低并发上限 + 多项目时最容易撞上。

工具侧的 `exec.signal`（`service.js:477-480`）同样在 `acquire` 之后才绑定，但它在 abort 时会被检查
`options.signal?.aborted`（`service.js:471-473`），所以**工具体取消**这条路径是有效的。

### 3.3 构建失败/超时的「进程树是否真的死干净」依赖 Host【低，NOT VERIFIED】

杀进程走 `subprocess.spawn({signal, graceMs: 5000})`（`build.js:235-246`），由 Host 的 subprocess Job
终止进程树。插件侧只能相信 Host 的实现；agent 侧无法在不重启的情况下证明「latexmk runscript → tlperl →
xelatex」整棵树都被回收。Lead 的手工验证记录里「取消后无残留 xelatex/perl 进程」是当前唯一证据。
→ 本条建议在 `docs/acceptance.md` 的 F 组里以进程快照复核。

### 3.4 成功判定比「latexmk 退出 0」严格【提示】

`status = success` 需要：未取消、未超时、`exitCode===0`、找到 PDF、`parsed.counts.errors===0`
（`build.js:312-315`）。因此：

- 日志里出现任何被解析成 error 的行 → 即使 PDF 已生成也判 `failure`（preview 不会更新，`build.js:319`）；
- 项目输出多个 PDF 且最新两个 mtime 差 < 50 ms → `#findOutputPdf` 返回 `undefined`（`build.js:489`），
  判失败 —— 对同时产出附件 PDF 的工程是误杀。

### 3.5 `clean` 与构建没有互斥【中】

`service.clean`（`service.js:680-694`）直接调 `builder.clean`，不检查 `project.building`，也不进队列。
在构建进行中 `latex_clean` / UI 清理会删掉正在写的 `.aux/.log`，结果是本次构建失败或日志残缺；
若同时带 `includePreview:true`，还会把刚发布的 `preview.pdf` 删掉并把 `previewVersion` 归零
（`service.js:685-691`），而正在运行的构建完成后又会写回一个新版本 —— 期间 `/latex/pdf` 会 404。

### 3.6 全局并发上限 = 2（可配 1..8）【提示】

`maxConcurrentBuilds` 默认 2（`cordis.patch.yml:41`、`config.js:106`）。它限制的是**全局 latexmk 进程数**，
不是核心数；大项目并行会互相拖慢，CPU 抢占导致的超时风险由 `timeoutMs` 决定。

---

## 4. 队列合并的已知缺陷（高）

**位置**：`src/service.js:425-434`。

```js
if (project.queue.length > 1) {
  const lastAutoIndex = project.queue.map((job) => job.options.reason).lastIndexOf('auto');
  if (lastAutoIndex > 0) {
    const dropped = project.queue.slice(0, lastAutoIndex);
    project.queue = project.queue.slice(lastAutoIndex);
    for (const job of dropped) {
      if (job.options.reason === 'auto') job.resolve(project.lastBuild?.summary ?? { status: 'coalesced' });
    }
  }
}
```

**问题**：被丢掉的 job 里只要有一个 `reason !== 'auto'`（`manual` / `ui` / `preview`），它既不会
`resolve` 也不会 `reject`。而 `enqueueBuild` 返回的是一个挂在 job 上的 Promise（`service.js:410-415`），
调用方在等它：工具会一直挂到上层超时，`POST /latex/action` 的 HTTP 请求会一直不返回。

**触发条件**（需要队列里「非 auto 在前、auto 在后」）：

1. 队列里已有 `manual`（例如用户点了编译、或模型调 `latex_compile`）；
2. 该 manual 还在执行/等待时，`auto` job 被追加到队尾——来源有两个：
   - `#pump` 在上一轮构建后发现 `autoRequested`，主动 `push` 一个 `auto`（`service.js:439-451`）；
   - 或先前的保存已经把 auto 排在后面。
3. 下一次循环开始时 `lastAutoIndex > 0`，`slice(0, lastAutoIndex)` 把 manual 一起切掉。

最小序列：`[auto, manual] → 再来一个 auto` ⇒ `[auto, manual, auto]`，`lastAutoIndex=2`，
`dropped=[auto, manual]`，manual 被静默丢弃。

**影响**：用户「点了编译但什么都没发生，也没有报错」；模型工具卡死。属于「静默丢请求」，比报错更难排查。

**建议修法**（不在本任务改源码）：只丢弃 `reason === 'auto'` 的 job，且对每个被丢弃的 job 都
`resolve({status:'coalesced'})`；或者干脆保留「每个非 auto job 必须 settle」的不变量，用
`promise.finally` 兜底。已交给 `docs/review-host.md`（host-review 任务）独立复核，
`docs/acceptance.md` 的并发/重复构建用例也应覆盖这一序列。

**当前绕法**：不要在同一项目上「先手动编译、再依赖自动编译」交替操作；批量编译时串行调用、等上一次返回。

---

## 5. last-good、stale、clean

### 5.1 `stale` 只在「曾经成功过」时才有意义【提示】

`stale = true` 的条件是 `previewVersion > 0` 且本次失败/取消（`service.js:514-516`、`service.js:580`）。
从没成功过的项目失败后 `stale` 保持 false、`previewVersion` 仍是 0，UI 走「还没有 PDF」空态
（`client.js:1514`）而不是「预览较旧」。语义上没错，但用户可能觉得「失败没有明显标志」——
此时要看诊断/`lastError`。

### 5.2 `preserveLastGood=false` 会改变 `/latex/pdf` 的语义【低】

此时成功构建不复制文件，`previewPath = pdfFound`（`build.js:340-343`）。于是：

- 下一次失败构建会直接覆盖 `build/<stem>.pdf` 吗？不会——失败时不会发布；但 latexmk 本身可能已经覆盖了
  这个文件（它是 latexmk 的输出路径），所以「last-good」在这种配置下**没有保障**。
- `/latex/pdf` 仍会检查路径在 `buildDirAbs` 与 `rootDir` 内（`routes.js:297-300`），安全边界不受影响。

默认 `preserveLastGood: true`，不建议关闭。

### 5.3 `clean` 的能力边界【提示】

只删 `AUX_EXTENSIONS` 白名单后缀（`build.js:21-56`）与名为 `.latexmkrc` 的文件；`.pdf` 需
`includePdf:true`；`preview.pdf` / `last-build.json` 需 `includePreview:true`（`build.js:525-550`）。
**不会**动项目根的源码，**不会**删 build 目录下白名单之外的产物（例如自己 `\write18` 出来的文件，
如果真开了 shell-escape —— 插件本身不加该 flag）。`kept` 列表会如实返回（`tools.js:394-400`）。

### 5.4 构建目录里的 `.dsh-latex` 不参与清理，但会跟着 build 目录一起被用户删掉【提示】

`stateDir=.dsh-latex` 存放 `preview.pdf` 与 `last-build.json`。用户手动 `rm -rf build` 后，
last-good 与版本元数据一起消失，但 Host 内存里的 `previewVersion` 还在，直到下次失败才置 `stale`
——期间 `/latex/pdf` 会 404（`routes.js:292-295`）而 UI 仍认为有版本。刷新/重新编译即可恢复一致。

---

## 6. 日志与诊断

### 6.1 解析是保守的，宁可没有位置【提示】

`logparse.js:1-14` 明确写了「never invent a file or line」。后果：

- 括号栈只是近似（`logparse.js:175-190`），嵌套/异常收尾时 `file` 可能落到主文件或 `undefined`；
- 经典 `!` 错误最多向后看 30 行找 `l.<n>`（`logparse.js:224`），超出或格式不同就没有行号；
- 一行里多个 `)` 会一次 pop 多个文件（`logparse.js:183-188`），可能把后续诊断归到外一层文件。

对模型的效果：`- 文件:行: 消息` 拿不到行号时会退成 `- 文件: 消息` 或 `- line N` 或 `<unknown location>`
（`tools.js:18-29`），不会给出错误行号——这是正确性优先的取舍。

### 6.2 折行与 `max_print_line`【中】

TeX 默认按 79 列折断日志，`-file-line-error` 的长消息会被切开。插件用
`max_print_line=2000`（`build.js:78-81`，默认值 `config.js:35`）来避免。

但：`maxPrintLine` 可配置，下限被允许到 **79**（`config.js:91`）。若有人把它设回 79（或某些 `.latexmkrc` /
环境已经固定了 `max_print_line`），折行会回来，解析器对折行的容忍仅在「续行以空白开头」的少数路径
（`logparse.js:95-103`、`logparse.js:296-307`），`file:line` 形态被折断时会退化成经典形态甚至丢行号。
→ 不要下调 `maxPrintLine`。

### 6.3 条数与体积上限【低】

| 限制 | 值 | 位置 |
| --- | --- | --- |
| errors | 200 | `logparse.js:121` |
| warnings | 300 | `logparse.js:122` |
| 单条 message | 2000 字符 | `logparse.js:158` |
| `raw` 单条 | 4000 字符 | `logparse.js:165` |
| 快照里的 errors/warnings | 各 80 条 | `service.js:52-53`、`service.js:60-61` |
| 构建结果 `logTail` | 64 KB（硬编码） | `build.js:383` |
| `/latex/log` 读取 | 512 KB 尾部 | `service.js:696`、`routes.js:320` |
| `.log` 文件参与解析的上限 | 32 MB | `build.js:461` |
| stdout / stderr 收集 | 1 MB + 32 MB 溢出 / 512 KB + 8 MB 溢出 | `build.js:240-241` |

所以「日志里明明有第 300 个警告」时，UI/工具看不到——`counts` 仍会显示总数（`service.js:65-69`），
并带 `truncated` 标记（`service.js:72-74`）。

### 6.4 `keepBuildLogTail` 是死配置【低】

`config.js:37` 定义、`config.js:109` 归一化，但全仓没有读取点；实际尾部长度是 `build.js:383` 的硬编码
`64 * 1024`。改这个键不会有任何效果。

### 6.5 Bib 诊断没有 file:line【提示】

`.blg` 条目并入构建结果时显式清空 `file/line`（`build.js:302-307`），因为 BibTeX/Biber 的日志不提供
稳定的源位置。模型只能拿到「缺哪个 .bib / .bst」这类信息。

---

## 7. 自动构建

### 7.1 `fs.watch` 的可靠性依赖平台与文件系统【低】

`watch(rootDir, {recursive:true})`（`service.js:301`）。Windows 本地 NTFS 实测可用；网络盘/UNC/某些容器挂载上
`recursive` 可能失效或漏事件，插件只能通过 `handle.on('error')` 记录 `watchError` 并置
`watchActive=false`（`service.js:308-313`），不会自动重试。UI 会显示未监听，但**不会**提示「自动编译已失效」的
显式警告（只靠 `watching` 字段，`client.js:994`）。

### 7.2 只监听项目根，不监听被 `\input` 的根外文件【低】

watcher 的 root 是 `project.rootDir`（`service.js:301`）。若章节文件在项目根之外（例如共享模板目录），
`\input` 进来的改动不会触发自动构建（手动编译仍正确，因为 latexmk 会读它）。

### 7.3 自动构建没有独立的取消入口【提示】

自动构建的 job 用 `signal: undefined`（`service.js:385`），只能靠 `cancel()` 打断（abort `project.abortController`）。
一旦进入 §3.2 的等待窗口，cancel 也打不断。

### 7.4 保存风暴只能合并「同一轮」【提示】

`debounceMs` 默认 800 ms，构建中到达的变更会在构建结束后补一次（`service.js:439-451`），且补跑前再等
`min(debounceMs,1500)`。如果构建本身比编辑慢得多，用户会看到「连续编译」，这是预期的「最后一次赢」，
但没有「攒批延迟上限」之外的节流。

---

## 8. HTTP / SSE / 鉴权边界

### 8.1 `/latex/health` 不鉴权【中（设计如此）】

`routes.js:252-261` 在 `admit()` 之前响应。它只回 `name/version/pid/startedAt/projects 数量/toolchain 路径`，
不含项目路径与内容；但仍泄漏「本机装了 TeX Live 在哪」。因为 Harness Web 默认 loopback，
这一层通常等价于本机访问。若将来暴露到非 loopback，这里应先加鉴权。

### 8.2 SSE 不按会话过滤，所有连接收到全部项目快照【中】

`openEventStream(res, service, streams, sessionId)`（`routes.js:284-285`）接收 `sessionId` 但没使用；
`service.subscribe` → `#emit` 对每个 listener 发完整 `snapshot()`（`service.js:808-817`）。
同一个 Harness 里的任何已鉴权页面都能看到所有项目的绝对路径、主文件名、日志路径。
客户端靠 `pickProject` 自己筛（`client.js:329-362`），属于「信任客户端」的做法。

建议（不在本任务改）：在 `openEventStream` 里按 `sessionId` 过滤 `snapshot.projects`，或提供
`GET /latex/state?session=` 已做的那种 rank 结果，SSE 只推 active 项目 + 计数。

### 8.3 SSE 连接数上限 24，超出 429【提示】

`STREAM_LIMIT = 24`（`routes.js:26`、`routes.js:280-283`）。多标签页/多窗口同时开预览时可能撞上，
客户端会进入 `connecting` 状态并靠 `retry: 2000` 重试，但不会告诉用户「连接被拒」。
`cleanup` 幂等（`routes.js:497-510`），依赖 `res.on('close'|'error')`，异常断开依赖 Node 正确发 close。

### 8.4 资产白名单有一个不存在的条目【低】

`ASSET_NAMES` 含 `LICENSE-pdfjs.txt`（`routes.js:28`），磁盘只有 `assets/licenses/PDFJS-NOTICE.txt`。
请求 `/latex/assets/LICENSE-pdfjs.txt` 会 404（`routes.js:340-343`）。不影响 viewer（它只取两个 `.mjs`）。

### 8.5 `/latex/pdf` 只服务「已发布预览」，但能力上仍是全项目可读【提示】

路径固定为 `project.paths.previewPath`（`routes.js:291`），并复查 `isInside(buildDirAbs)` 与
`isInside(rootDir)`（`routes.js:297-300`）。没有任意文件读取面；`project` 参数只能是注册表里的 id。
但「注册表里的任何项目」对所有已鉴权连接可见（见 §8.2）。

### 8.6 POST body 限制 64 KB【提示】

`BODY_LIMIT = 64 * 1024`（`routes.js:25`）。`/latex/action` 与 `/latex/synctex-inverse` 的 body 都很小，
正常使用不会撞上；传大对象会被 413。

---

## 9. 浏览器端与 PDF viewer

### 9.1 页面按需渲染：极小概率短暂空白【低（已知）】

占位 div 先出（`client.js:1679-1699`），canvas 由 `IntersectionObserver`（`rootMargin: 600px`，
`client.js:1353-1374`）或滚动回调（`client.js:1397-1414` → `renderVisible`）触发 `renderPage`。
快速拖动滚动条/瞬间跳页时，页面进入视口到 canvas 画完之间是灰底占位（`.dl-page-ph`，`client.js:635`）。
这是有意的内存取舍：全部页一次性渲染在 500 页文档上会直接卡死。

### 9.2 所有页共用第 1 页的尺寸【低】

`baseSize` 来自 `doc.getPage(1).getViewport({scale:1})`（`client.js:1227-1231`），占位与「fit」比例都用它。
混合页面尺寸的 PDF（例如 beamer 里插了不同纸张的页）会出现占位与真实页面长宽不等，滚动定位略偏。
`renderPage` 会按真实 page 的 viewport 重设单页尺寸（`client.js:1288-1306`），所以画出来是对的，只是
滚动条长度与预期不符。

### 9.3 没有文本层：不能选中、搜索、复制【中】

viewer 只画 canvas（`client.js:1290-1309`），不渲染 PDF.js 的 text layer。于是：不能搜索、不能选中文字、
不能复制。双击被用作 SyncTeX 反查（`client.js:1690`），也不承担选词。

### 9.4 每个已渲染页面常驻一张 canvas【低】

`pagesRef[pageNumber].canvas` 在滚动离开后**不回收**（`client.js:1290-1312`），只有缩放变化
（`client.js:1334-1350`）或文档重载（cleanup，`client.js:1241-1257`）才清空。对长文档 = 内存随「看过的页数」增长；
非 retina 设备由 `dpr = min(devicePixelRatio, 2.5)` 上限约束（`client.js:1287`）。

### 9.5 `viewStates` 是模块级 Map，没有上限【低】

`client.js:221`、`client.js:1131-1134`。它保存每个项目的页码/缩放，永不清理；项目多时增长很慢，
但严格说没有淘汰。

### 9.6 前向 SyncTeX 从工作台发起时只查主文件【中】

`client.js:889-912` 的请求只带 `file = project.mainRelative`（`client.js:895`）与行号。所以：
在章节文件里写第 200 行、然后从工作台点「定位到 PDF」，synctex 会在 `main.tex` 的第 200 行附近找，
而不是章节文件。模型用 `latex_synctex` 工具时**可以**传 `file`（`tools.js:442`、`service.js:852-857`），
不受此限。

### 9.7 可访问性缺口【低】

有 `aria-hidden` 图标、`role="region"`、`title` 提示（`client.js:481`、`client.js:1676-1677`），但：
没有键盘翻页（PageUp/Down）、没有焦点管理、没有 `aria-live` 播报构建状态与 SyncTeX 结果、
错误/警告列表项是 `li` + `onClick` 而不是可聚焦控件（`client.js:723-742`）。
键盘用户只能用 Tab 到工具条按钮，翻页要手动输入页码。

### 9.8 `document` 预览面（内建预览）完全不受控【中（已知）】

`previewSurface: 'document'` 时，`openPreview` 走 `openResource(sessionFileAddress(...previewPath))`
（`client.js:417-424`），把 `preview.pdf` 交给 DSH 内建文档预览。此时：

- 页码位置、缩放、工具栏、是否刷新，全部由 DSH 决定，插件无法定位到某一页（`page` 参数被忽略）；
- 没有 SyncTeX 双击反查；
- 自动刷新依赖内建预览对同一资源地址的重新读取 —— `NOT VERIFIED (agent-side)`，本任务没有独立验证；
- 构建失败时的 stale 提示只在插件的 native tab 里有，document 面看不到。

默认 `native` 就是为了避开这些；只有用户显式选择 `document` 才进入上述状态。

### 9.9 没有设置表单（无 Config schema 导出）【中】

插件 `index.js` 只导出 `name/version/apply`（`index.js:19-20`、`index.js:71`），没有向 Harness 暴露
config schema；客户端也没有注册 settings 面板。所以**所有配置只能改 YAML**
（bundle 的 `cordis.patch.yml` 或 profile 级 override），改完还要 recomposition / 刷新。
UI 里唯一能改的运行时开关是「自动编译」（`client.js:1025-1034` → `action:'watch'`），它只改内存状态，
不写回任何文件，Host 重启后回到 `config.autoBuild`。

### 9.10 前端刷新路径与 HMR【提示】

`client.js` 的改动需要浏览器拿到新 bundle；仅在 `pnpm run dev:web` 同时运行时客户端插件才会热重载，
否则要刷新页面（README 也写了「装完 F5」）。Host 侧改动见 §12.2。

### 9.11 小的代码卫生问题（不影响功能）【提示】

- `client.js:1495` 的 `useCallback(() => {` 之后同一行还有内容，缩进异常但可执行；
- `client.js:364-379` 与 `util.js:209-224` 是同一函数的两份实现，改一边容易忘另一边（目前 Host 侧那份没被调用）；
- `TOOL_LABELS`（`client.js:1710-1718`）硬编码 7 个工具名，新增工具要同时改这里与 `src/tools.js`。

---

## 10. SyncTeX

### 10.1 完全依赖 `synctex` CLI 与其产物【中】

`service.js:828-899` 先要求 `synctex.exe` 存在（`service.js:830-833`），再要求
`build/<stem>.pdf` 存在（`service.js:834-838`）。**没有**检查 `.synctex.gz` 是否存在：
没有它时 synctex 通常输出提示文本，插件把原始文本尾部附在返回里（`service.js:888`、`service.js:897`），
工具调用不会「失败」，只是结果里写着找不到位置。模型需要自己读懂这句话。

### 10.2 退出码被忽略，越界/无匹配无法与「成功但空」区分【低】

`await handle.done.catch(() => undefined)`（`service.js:873`）吞掉退出码与异常；
之后只靠正则找 `Page:` / `Input:`。synctex 在「坐标越界但仍能给出最近位置」时会正常返回，
插件会照样报告 `page N at (x, y)`——这可能是离点击点很远的页。
`docs/synctex-notes.md`（synctex 任务）负责给出实测的越界行为。

### 10.3 CJK / 非 ASCII 路径下的 inverse 行为【中，NOT VERIFIED (agent-side)】

`service.js:884-893` 从 synctex stdout 里用 `/Input:([^\r\n]+)/` 抓文件名，输出相对路径。
中文/空格路径下 synctex CLI 是否原样回显多字节路径、是否会转义，**未在本任务内独立验证**；
若它输出的是系统编码字节而非 UTF-8，`Input:` 解析会得到乱码 → 反查打开错误的文件。
→ 交由 `docs/synctex-notes.md` 用 `带 空格 项目` 与 `chinese-ctex` fixture 实测；
本文件不把「CJK 反查可用」当结论。

### 10.4 客户端反查解析对空格路径 / 无 column 输出不健壮【高】

`client.js:1470-1478` 用两条正则从**给人读的结果字符串**里抠路径与行号：

```js
const match = /:(\d+)(?:\s|\()/.exec(String(data.result ?? ''));
const sourceMatch = /SyncTeX inverse: (.+?)(?::\d+)?(?: |$)/.exec(String(data.result ?? ''));
const source = sourceMatch?.[1]?.trim();
```

实测这两个正则（node 直接跑同一表达式）：

| 输入（service 可能的输出） | 抠出的 source | 抠出的 line |
| --- | --- | --- |
| `SyncTeX inverse: main.tex:13 (column 3)` | `main.tex` | 13 |
| `SyncTeX inverse: main.tex:13` | `main.tex` | **undefined** |
| `SyncTeX inverse: 带 空格 项目/main.tex:13` | **`带`** | undefined |
| `SyncTeX inverse: sections/ch 1.tex:42` | **`sections/ch`** | undefined |

两个独立缺陷：

1. **路径含空格被截断**：`(.+?)` 非贪婪且允许以空格结尾，`source` 只截到第一个空格之前。
   随后拼成 `<rootDir>/带` 并 `openResource`，打开一个不存在的文件。含空格/中文路径的项目
   双击反查「跳不过去」。
2. **没有 `(column N)` 时行号丢失**：行号正则要求数字后紧跟空白或 `(`（`client.js:1470`）。
   而 Host 只在 synctex 报 `Column:` 时才追加 ` (column N)`（`service.js:886-892`）——
   一旦某次反查只有 `Line:` 没有 `Column:`，结果串以 `:13` 结尾，行号就取不到，
   于是「打开了文件但没有跳到行」。

这是当前最影响体验的明确缺陷之一，`docs/review-client.md`（client-review 任务）会给出同类 finding。

建议修法（不在本任务改源码）：让 Host 返回结构化结果（`{file, line, column}`）而不是给人读的字符串；
退一步，客户端也应改成「取最后一个 `:<数字>` 之前」的切分，且行号正则允许字符串结尾（`/:([0-9]+)(?:\s|$|\()/`）。

### 10.5 坐标换算的单位前提【提示】

双击用 `(clientX - rect.left) / scale`（`client.js:1458-1460`）。这在「canvas CSS 尺寸 = PDF pt × scale」
时成立（`renderPage` 里 `canvas.style.width = viewport.width`，`client.js:1301-1306`），并且
`rect` 是 canvas 自身的 bounding box，所以与容器的 padding/滚动无关。
但页面 div 有 `overflow:hidden` 与 `border-radius:1px`（`client.js:633`），Canvas 放大到非整数 CSS 尺寸时
可能有 < 1px 的取整偏差；对行级反查无实际影响，对极窄坐标（列级）会有 ±1pt 误差。

### 10.6 前向 sync 的 column 恒为 1（UI）【低】

工作台请求不带 `column`（`client.js:894`），`routes.js:390` 用 `Number(...) || 1`。
因此只能定位到行首位置；对同一行内有多个公式的场景，PDF 高亮位置就是该行起点。

---

## 11. 平台与路径假设

### 11.1 硬编码 Windows 假设【中（当前部署无影响）】

- 默认 `texBinDir = D:\latex\texlive2023\...`（`config.js:10`、`cordis.patch.yml:17`）；
- `probeToolchain` 拼 `latexmk.exe` 与 `${tool}.exe`（`build.js:88-92`）——macOS/Linux 上会全部判定缺失；
- `buildEnv` 用 `;` 拼 PATH（`build.js:74`）、SyncTeX 也用 `;`（`service.js:871`）；
- 路径分隔符处理到处有 `replace(/\\/g,'/')` 兜底，但上述三点是平台契约。

结论：**这是 Windows 桌面版专用实现**。当前部署（DSH desktop on Windows + TeX Live 2023）符合假设；
要移植需改这三处。

### 11.2 中文/空格路径【低（已实测可用）】

本机证据：`latex-plugin-tests/chinese-ctex/build/.dsh-latex/last-build.json` 与
`latex-plugin-tests/带 空格 项目/build/.dsh-latex/last-build.json` 都存在（中间产物 `main.pdf`、
`main.synctex.gz` 也在），说明插件在这两类路径上真的完成了编译与 last-good 发布，而不只是环境审计时手工跑过。
argv 传参不经 shell，所以空格安全；风险集中在：SyncTeX 的 `Input:` 解析（§10.3）、
客户端反查路径切分（§10.4）。

### 11.3 `sessionFileAddress` 在跨根路径下的退化【低】

`client.js:364-379`：只有文件在 cwd 之下才转成相对路径；否则保留绝对路径并把 `:` 转义为 `:`
（`replace(/%3A/gi, ':')`）。项目根不在会话 cwd 下时，生成的地址形如
`dsh-resource://file/session/<sid>/D:/x/main.tex`——内建打开是否接受带盘符的地址，
`NOT VERIFIED (agent-side)`。跨根场景建议用 native 预览，避免走 `document` 面。

---

## 12. 配置与安装

### 12.1 无 schema、无表单、改配置要重启/重组【中】

见 §9.9。补充：`previewSurface` 在打开预览时从**当前快照**读取（`client.js:419`），改 YAML 后必须让 Host
重新加载配置（recomposition）才会变；单纯刷新页面不会。

### 12.2 Host 侧源码修改不会自动生效（实测证据）【中】

`/latex/health` 的 `startedAt` 是 service 构造时刻。本机实测：`startedAt` 对应 16:20:10，
而 `src/service.js` mtime 为 16:23:09 → 当前进程运行的是**旧代码**（见 §1.2 的行为差异）。
生效方式：再执行一次 `plugin_manager action=install_bundle`（触发 profile recomposition）或重启 Harness。
这不是 bug，是 bundle 的加载模型；但排查「为什么改了没效果」时要知道。

### 12.3 配置项有三类无效/半无效状态【低】

1. `keepBuildLogTail`：完全没被读取（§6.4）；
2. `engineFlag`（`config.js:96`）：归一化时算出来，但 `build.js` 用的是自己那张 `ENGINE_ARGS`
   （`build.js:58-62`）；两份表当前一致，改一份会漂移；
3. `project.engineExplicit`（`service.js:408`）：赋值后没有任何读取点。

### 12.4 卸载会带走 profile 记录，但 build 目录留在项目里【提示】

卸载只移除 bundle 与 profile 依赖（`dsh.profile.bundles`）；每个项目下的 `<buildDir>/`（含
`.dsh-latex/preview.pdf`、`last-build.json`、latexmk 产物）不会被清理。需要干净卸载时手动删 build 目录。

---

## 13. 代码卫生（不影响当前功能，但影响维护）【提示】

| 项 | 位置 | 说明 |
| --- | --- | --- |
| `util.Semaphore` 无引用 | `util.js:144-190` | `service.js:102-127` 内联了另一个实现；两份语义不同（内联版不支持 abort/waiters 信号） |
| `util.sessionFileAddress` 无引用 | `util.js:209-224` | 浏览器端有同名副本（`client.js:364-379`） |
| `keepBuildLogTail` 无读取 | `config.js:37`、`config.js:109` | 见 §6.4 |
| `project.engineExplicit` 无读取 | `service.js:408` | 死字段 |
| `ASSET_NAMES` 多一项 | `routes.js:28` | 见 §8.4 |
| `client.js:1495` 缩进异常 | `client.js:1495` | `useCallback(() => {        if (...)`，可执行但可读性差 |
| 队列合并缺陷 | `service.js:425-434` | 见 §4，**建议优先修** |

---

## 14. 未验证项（agent-side NOT VERIFIED）

以下项本任务没有独立验证，**不作为通过结论**，留给对应专项/Lead：

| 项 | 原因 | 建议验证方 |
| --- | --- | --- |
| 内建文档预览（`previewSurface: 'document'`）的页码位置、刷新时机、失败提示 | 由 DSH 控制，插件侧无 API | Lead / client-review |
| 取消/超时后「latexmk → tlperl → 引擎」进程树是否零残留 | 依赖 Host subprocess 实现，agent 侧无法在构建瞬间抓进程 | acceptance 的 F 组 |
| CJK / 空格路径下 synctex CLI 的 `Input:` 输出编码与内容 | 需真实调用并看原始 stdout | `docs/synctex-notes.md` |
| 双击反查在带空格项目上的实际失败表现 | 同上 + 前端行为 | synctex + client-review |
| 浏览器内存随长文档/多项目的真实占用 | 需要 DevTools 采样 | client-review / Lead |
| 重启 DSH 后工具仍在、preview 版本仍在 | 本任务不允许重启 | acceptance |
| 键盘可达性、焦点顺序 | 需要真人/自动化 UI 检查 | Lead |
| 网络盘/UNC 上 `fs.watch(recursive)` 的行为 | 无该环境 | 环境受限，记录为风险 |
| `allowedRoots` 配置后到实际拦截的端到端效果 | 需改 profile 配置（本任务禁止） | security-review / Lead |

---

## 15. 建议的修复优先级（仅建议，本任务不改源码）

1. **§4 队列合并丢弃非 auto job**（会静默挂起工具/HTTP 请求）——最高优先级；
2. **§10.4 反查路径含空格被截断**（双击反查在中文/空格项目直接失效）——返回结构化结果最稳；
3. **§3.2 取消在等信号量窗口无效**（用户看到「已取消」但构建继续）——把 `abortController` 提前到 `#runOne` 开头创建；
4. **§3.5 clean 与构建互斥**（构建中清理会制造假失败）——复用项目队列或加 `building` 检查；
5. **§8.2 SSE 按会话过滤**（所有连接看到全部项目路径）；
6. **§6.4 / §12.3 死配置与死字段**——要么接线、要么删除，避免文档与实现漂移；
7. **§9.7 可访问性**（键盘翻页、aria-live）；
8. **§11.1 平台抽象**（`.exe` 与 `;` 的 PATH 分隔符）——只有在需要跨平台时才做。

以上每一项都对应 `docs/review-host.md`、`docs/review-client.md`、`docs/security-audit.md` 或
`docs/synctex-notes.md` 中的独立复核；本文件只负责把它们如实登记，不修改任何源码或 profile。
