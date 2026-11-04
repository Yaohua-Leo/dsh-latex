# dsh-latex Client 半与插件 API 契约审查

审查对象：`D:\deepseekharness\latex-plugin` 的浏览器半侧与包/补丁声明
- `client.js`（2004 行，mtime 2026-11-03 16:19:59，81,624 B）
- `package.json`（39 行）
- `cordis.patch.yml`（41 行）
- 依赖的 Host 契约：`src/routes.js`、`src/service.js`、`src/tools.js`、`src/config.js`（只读，用于核对客户端期待的数据形状）
- 对照文档：`docs/api-cheatsheet.md`（G.3–G.8、I.1–I.2、D.2–D.4、A.2–A.6）、`docs/web-research.md` §5（PDF.js）、`docs/architecture.md` §11

审查方式：逐行阅读 `client.js`；用本机 `resources/app.asar`（DSH 0.2.1-rc.5）解包出来的真实 client bundle 校验契约（`D:\dsh-tmp\asar-extract\...`，临时只读副本）；调用现成工具取真实返回串并用 node 复跑客户端的正则/地址拼装函数。
**本任务没有修改任何源码、profile 或 fixture**；唯一产出是本文件。

> 时间线提示：`client.js` 的最后修改时间（16:19:59）晚于 Lead 的 UI 截图（16:16–16:20）且与 `docs/api-cheatsheet.md`（16:04）里引用的行号已不一致（该文档仍按 ~1900 行的版本写）。因此**当前版本的浏览器行为没有被任何 agent 侧 UI 验证覆盖**；本报告中标 `[静态]` 的缺陷只有代码路径证据，需要 Lead 用一次真实 UI 操作复核。

---

## 0. 结论与最重要的三个问题

总体判断：**契约层面基本正确**，两阶段 tab 注册、locale、tool view、资源地址、SSE 帧、路由载荷都能与本机 DSH bundle 逐条对上（见 §2 的 PASS 表）。问题集中在**手写 viewer 的渲染生命周期**与**反查结果解析**上：

1. **缩放之后页面变空白，双击反查同时失效**（F1，high）。缩放 effect 清空 `innerHTML` 却保留 `record.canvas`，`renderPage` 复用了已脱离 DOM 的 canvas，既不重新挂载也不再补页号；双击时 `querySelector('canvas')` 因此拿到 `null`。
2. **双击反查的路径/行号解析对真实输出不成立**（F2，high）。含空格/中文路径在第一个空格处被截断；没有 `(column N)` 时行号完全取不到——而本机 xelatex + SyncTeX 1.5 的输出正是 `Column:-1`，Host 因此不追加 column 后缀。已用真实工具返回串复现。
3. **工作台与预览的项目身份在若干入口丢失**（F3/F5/F6/F7/F8，medium）。首次编译后面板不自动开预览；恢复的预览 tab 没有项目参数；SSE/postAction 快照丢掉 `activeProjectId`；工作台忽略 `openTab` 传进来的 `project`。

其余是页码/滚动状态、hooks 用法、SSE 连接态、内存与可访问性一类的中低级问题。

---

## 1. 审查方法与可复现证据

| 证据类型 | 具体做法 |
| --- | --- |
| 源码 | 通读 `client.js` 全部 2004 行；`package.json`、`cordis.patch.yml` 逐字段核对 `src/config.js` |
| 真实 DSH 契约 | 解包 `resources/app.asar`，读 `@deepseek-ai/dsh-client-ui-sidebar-right`、`dsh-client-locale`、`dsh-client-ui-sidebar-documentpreview`、`dsh-client-ui-tool`、`dsh-client-modules` 的 `lib/client.js` / `lib/index.js` |
| 真实 Host 输出 | `latex_synctex` 工具（forward/inverse）取返回串；`synctex.exe edit` 取原始 stdout；`synctex.exe` 的 `Column:-1` 事实 |
| 纯函数复跑 | 用 node 复跑 `client.js` 里的两条反查正则（`1470`、`1472`）与 `sessionFileAddress`（`364-379`），输入取真实/构造串 |
| 未做 | 浏览器 DOM 操作、截图对比、键盘操作、真实重启 DSH —— 见 §4 |

DSH bundle 行号是解包副本的行号，解包方法沿用本机已有脚本：`node D:\dsh-tmp\asar\list.js resources\app.asar <filter>`。版本以 `app.asar` 的 `package.json` 为准（0.2.1-rc.5）；解包副本被清理后用同一方法可重建。

---

## 2. 契约核对（PASS）

### 2.1 bundle 声明（package.json / cordis.patch.yml）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| client 模块 id = 包名 | PASS：`id: 'dsh-latex'` = `"name": "dsh-latex"` | `client.js:13-15`、`package.json:2` |
| `dsh.client` 字段合法 | PASS：只含 `platform`/`inject`，二者类型正确；`parseDshClient` 校验的正是 platform/inject/external/immediately（其余键忽略） | `package.json:30-37`；`dsh-client-modules/lib/index.js:63-75` |
| `exports` 必备项 | PASS：`.`、`./client`、`./locale/*.json`、`./icon`、`./package.json` 都在 | `package.json:8-14` |
| patch 行 | PASS：`insert` + `id: latex` + `name: dsh-latex` + config，config 键与 `normalizeConfig` 一一对应（无未知键；`buildDir/engine/...` 全部被消费） | `cordis.patch.yml:12-41`、`src/config.js:78-114` |
| client bundle 加载顺序 | PASS：`inject` 列出的 sidebar-right / locale / theme 都是真实 client 包；组合器按该数组排前 | `dsh-client-modules/lib/index.js:405-445` |
| require 基座 | PASS：只 `require('react')`，其余全是浏览器内建/动态 `import()` | `client.js:13-18`、`1117-1129` |
| 装配入口 | PASS：返回 `{ inject, apply }`；`inject` 里的服务在本 profile 都存在（sidebar-right 由 `ctx.reflect.provide` 提供） | `client.js:1999-2002`、`sidebar-right/lib/client.js:4965-4966` |

### 2.2 两阶段 tab 注册（id 同时是 slot key）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 阶段 1：类型 | PASS：`id`/`kind`/`priority`/`title`/`guide` 齐全；`title` 是函数（`claim()`/`placeTab()` 会调用 `definition.title(address)`，缺失会 TypeError） | `client.js:1916-1949`；`sidebar-right:4702-4726`、`2298-2306` |
| 同 id 冲突 | PASS：两个 id 唯一（`dsh-latex/panel`、`dsh-latex/preview`）；重复注册会 throw，代码用 `ctx.effect` 持有 disposer，卸载即释放 | `client.js:20-23`、`1958-1973`；`sidebar-right:4580-4602` |
| 阶段 2：正文 key = 类型 id | PASS：框架渲染时 `entryKey: definition?.id ?? tab.kind`，即 key 必须是 **id 而不是 kind** | `sidebar-right:1400` |
| kind 冲突 | PASS：`latex-panel`/`latex-preview` 无内置同名 kind；`extension` band 与 `fallback`（documentpreview）不冲突 | `sidebar-right:4509-4526`（RANKS/coexists）、`4580-4602`（register）；`documentpreview:1081-1089` |
| slot 种类 | PASS：`sidebar.right.pane.tab` 是 keyed（key 必填）；`conversation.session.header.actions` 是 list（id 必填，本插件用 `id:'latex'`）；`tool.call.toolview` 是 keyed（key=工具 wire name） | `sidebar-right:5046-5050`；`conv-client.js:20058-20061`；`tool-client.js:4614-4617` |
| `multiple`/`keepMounted` | PASS（语义清楚）：未设 → 单实例、切 tab 卸载。**但**这带来 F8 的项目身份问题 | `sidebar-right:2298-2306`、`1371` |

### 2.3 locale

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 注册在 slot 之前 | PASS：`apply` 里先 `locale.register(NS, DICT)`/`bind`，再注册 tab/卡片，不存在“把未注册 locale 传给 slot” | `client.js:1869-1895`、`1916` 起 |
| zh 与 en 都给 | PASS：`DICT = { zh, en }`，实测键集各 76 个且完全一致（无缺键） | `client.js:26-183`；node 比对 |
| 命名空间 | PASS：`NS='latex'` 与四处 `locale: NS`（两个 tab 正文、工具卡片、header action）一致；与 `locale/*.json`（元信息）互不冲突 | `client.js:24`、`1961`、`1969`、`1979`、`1989` |
| 失败行为 | PASS（可接受）：`register` 重复会 throw（同一 ns+locale），被外层 try/catch 吃下后 `runtime.t` 回落成 key；`bind()` 本身不抛（缺 ns 时走 common→key） | `client.js:1869-1894`；`dsh-client-locale/lib/client.js:1387-1430` |
| 语言切换 | PASS：`bind` 返回的函数在调用时按当前 locale 查表，模块级缓存不会锁死语言 | `dsh-client-locale/lib/client.js:1414-1429` |

### 2.4 tool view / header action

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 7 个 key = 工具名 | PASS：`latex_compile/latex_preview/latex_get_diagnostics/latex_get_status/latex_clean/latex_cancel/latex_synctex` 与 `src/tools.js` 注册名逐一对上 | `client.js:1710-1718`；`src/tools.js:143,193,255,306,372,409,432` |
| props 用法 | PASS：`block`/`phase`/`toolName`/`sessionId`/`cwd`/`useSessions`/`t` 都是框架注入；`settled = 'kind' in block` 与 `toolCallPhase()` 一致；结果态读 `block.call.argsRaw`、`block.content`、`block.isError` 与内置行相同 | `client.js:1739-1757`；`tool-client.js:1935-1980, 311-330` |
| 从 toolview 打开右栏 | PASS：`openTab` 作用于屏幕会话，toolview 就在会话里，不会串台；失败被 catch 成 `false` | `client.js:381-397`、`1823` |
| header action | PASS：list slot + 唯一 id + order；按钮在会话里，`sidebarRight.mounted` 有值 | `client.js:1848-1859`、`1985-1996` |

### 2.5 资源地址与 openResource

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 地址语法 | PASS：`dsh-resource://file/session/<enc(sessionId)>/<enc(path)>`，`encodeSegment` 与官方实现完全一致（`%3A` 还原成冒号保留盘符） | `client.js:364-379` vs `documentpreview:42-57` |
| session 作用域被接受 | PASS：documentpreview 的 `canOpen` 只认 `scope==='session'`，本插件只用 session 地址 | `documentpreview:1081-1089, 62-104` |
| PDF 交给内建预览 | PASS：`previewSurface:'document'` 时 `openResource(previewPath)`；`dsh-resource://file/*` 由 documentpreview 的 fallback 类型接走 | `client.js:417-424`、`1495-1498`；`documentpreview:1081-1089` |
| 诊断跳转 | PASS：`{ params: { line } }` 形状正确 | `client.js:685-689` |

> 注意：`client.js:364-379` 与官方 builder 是两份实现，且**多了一步「先相对 cwd 归一」**；cwd 与 Host 解析根不一致时会拼错（见 F19，附复跑输出）。`sessionId` 缺失时会拼出 `/session/undefined/...`。

### 2.6 路由载荷与客户端字段

| 项 | 结果 | 证据 |
| --- | --- | --- |
| `GET /latex/state` | PASS：`projects/config/toolchain/previewRequest/schema/...` 全部由 `service.snapshot()` 提供，另加 `activeProjectId` | `routes.js:266-277`、`service.js:716-736` |
| SSE | PASS：`event: state` + 完整快照 + `retry: 2000` + 15 s 心跳；客户端 `addEventListener('state')` 对得上 | `routes.js:470-513`；`client.js:252-259` |
| snapshot 项目字段 | PASS：`id/rootDir/mainFile/mainRelative/engine/buildDir/previewPath/previewVersion/previewPages/stale/lastError/lastBuild.{status,exitCode,durationMs,finishedAt,logPath,clock}/diagnostics/sessionIds/lastUsedAt/building/queued/autoBuild/watchActive` 客户端用到的都存在 | `service.js:738-782`；`client.js` 各处 |
| `previewVersion` 语义 | PASS：是 `Date.now()` 时间戳（`clockOf(Number(...))` 显示成 HH:MM:SS 成立） | `src/build.js:317-322,341-348`、`service.js:503` |
| `POST /action` | PASS：`compile/cancel/clean/watch/preview` 的响应都带 `snapshot`；`preview` 另带 `previewRequest`（本插件 UI 不消费它，见 F15） | `routes.js:422-467`；`client.js:288-298` |
| `GET /pdf?project=&v=&r=` | PASS：`v/r` 被忽略但 `cache-control:no-store`，客户端靠 version 变化触发重取即可；`x-latex-version` 只是冗余 | `routes.js:289-316`；`client.js:1210-1218` |
| `GET /log` | PASS：`text/plain`，客户端按文本读并截尾 120 000 字符；`x-latex-log-path` 未用（改用 snapshot 的 `lastBuild.logPath`） | `routes.js:318-330`；`client.js:748-806` |
| `GET /synctex` / `POST /synctex-inverse` | 部分 PASS：forward 串 `SyncTeX forward: page N at (x, y)` 能被 `/page\s+(\d+)/i` 解析；inverse 串见 F2 | `service.js:885-898`；`client.js:899-908`、`1470-1473` |
| action 的 project 参数 | PASS：客户端传 project **id**，路由 `service.getProject(id)` | `client.js:843-877`；`routes.js:424` |

### 2.7 PDF.js

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 版本/许可 | PASS：pdf.js 5.4.296（`pdfjsVersion = 5.4.296`），Apache-2.0，NOTICE 在 `assets/licenses/PDFJS-NOTICE.txt` | `assets/pdf.min.mjs` 头部、`assets/licenses/PDFJS-NOTICE.txt` |
| 加载方式 | PASS：`import('/latex/assets/pdf.min.mjs')` 同源动态导入，`GlobalWorkerOptions.workerSrc` 指向同源 worker；`mod?.default ?? mod` 兼容 ESM 命名导出 | `client.js:1117-1129` |
| 安全选项 | PASS：`getDocument({data, isEvalSupported:false})`；`render({canvasContext, viewport})` 是 5.x 仍支持的参数 | `client.js:1220`、`1309` |
| 清理 | PASS（主路径）：版本变化/卸载时 `cancelled` 标志 + `doc.destroy()` + `loadingRef.destroy()`；观察者、滚动监听、rAF、EventSource 都有 dispose | `client.js:1241-1257`、`1370-1373`、`1410-1413`、`264-272`、`1898-1907` |
| CSP | NOT VERIFIED：本机解包出的 host 侧 bundle 未见 app 级 CSP 头，无法确认 `worker-src`/`script-src`；若以后收紧 CSP，需允许 `script-src 'self'` 与同源 worker | 见 §4 |

---

## 3. Findings

严重度：blocker / high / medium / low / nit。`[静态]` = 只有代码路径证据；`[实测]` = 有本轮真实命令/返回串。

### F1（high，`[静态]`）缩放后页面空白，双击反查同时失效

- 位置：`client.js:1334-1350`（缩放重置）、`1276`、`1290-1300`（canvas 复用）、`1453-1456`（双击取 canvas）。
- 触发：预览已渲染过至少一页后，把缩放从「适合宽度」改成 50%–200% 或反向。
- 证据（代码路径）：
  1. 缩放 effect 对每个 `record` 执行 `record.element.innerHTML = ''`、`record.renderedScale = undefined`，但**没有**清 `record.canvas`；
  2. `renderPage` 只在 `if (!canvas)` 时才 `document.createElement` + `appendChild`（`1290-1300`）。此时 `record.canvas` 仍指向已被 `innerHTML=''` 摘掉的旧 canvas，于是画布尺寸/样式被设置、`pdfPage.render(...)` 也画了，但**画在脱离文档的节点上**，页面上只剩白底空 div（占位 class 还会被移除，`1307`），页号 `<span>` 也丢失；
  3. 双击时 `event.currentTarget.querySelector('canvas')` 返回 `null`，直接 `setSyncNote('SyncTeX 定位失败')` 并返回（`1453-1456`），连请求都不发。
- 影响：缩放功能实质不可用（用户看到白页），且缩放后双击反查 100% 失效。`docs/architecture.md:673-675` 把该路径描述成「重置为占位再 renderVisible()」，没有注意到 canvas 未重新挂载。
- 建议修法：重置循环里 `record.canvas = undefined`（并让 renderPage 重建 canvas 与页号），或把 `appendChild` 改成「canvas 不在 element 内就重新挂载」；同时给渲染任务加代次（见 F13）。
- 复核方式：打开任意 PDF 预览 → 缩放下拉改成 100% → 任一已渲染页应为空白；再双击该页，右下 toast 应为「SyncTeX 定位失败」。

### F2（high，`[实测]`）双击反查的路径与行号解析对真实 synctex 输出不成立

- 位置：`client.js:1470-1478`。
- 触发：本机（xelatex + SyncTeX 1.5）的每一次反查都丢行号（`Column:-1` → Host 不追加 column）；路径含空格的项目额外被截断（纯中文、无空格的路径 source 正确，但行号仍丢）。
- 证据：
  1. 真实工具返回（本轮实测）：
     - `latex_synctex(direction=inverse, project=...\synctex, page=1, x=125.798264, y=699.048828)` → `SyncTeX inverse: main.tex:11`
     - `latex_synctex(direction=inverse, project=...\single-math, page=1, x=100, y=100)` → `SyncTeX inverse: main.tex:44`
  2. 原始 `synctex.exe edit` 输出里是 `Column:-1`（见附录 A），而 Host 只在 `/Column:(\d+)/` 命中时才追加 ` (column N)`（`src/service.js:885-892`），所以结果串**以 `:44` 结尾**。
  3. 用 node 复跑客户端两条正则（附录 A）：
     | 输入 | `source` | `line` |
     | --- | --- | --- |
     | `SyncTeX inverse: main.tex:44` | `main.tex` | **undefined**（行号正则 `/:(\d+)(?:\s|\()/` 要求数字后是空白或 `(`，不含字符串结尾） |
     | `SyncTeX inverse: 带 空格 项目/main.tex:13` | **`带`** | undefined（`(.+?)` 非贪婪，source 正则的 `(?: |$)` 在第一个空格处就收口） |
     | `SyncTeX inverse: 中文项目/main.tex:13` | `中文项目/main.tex`（无空格 → 路径完整） | undefined（仍然丢行号） |
     | `SyncTeX inverse: sections/ch 1.tex:42` | **`sections/ch`** | undefined |
     | `SyncTeX inverse: main.tex:13 (column 5)` | `main.tex` | 13（唯一正常形态） |
  4. 客户端拿截断后的 source 拼成 `<rootDir>/带` 再 `openResource`（`1475-1478`），地址指向不存在的文件；且无论 `openResource` 成功与否都显示「已定位到源码」（`1478-1481`）。
- 影响：双击反查是插件的主打交互：无 column 时「打开文件但不跳行」；有空格/中文路径时「打开失败但 UI 说成功」。`docs/limitations.md` §10.4 已从文档角度记录此缺陷（结论一致），本报告补充了真实返回串与原始 `Column:-1` 证据。
- 建议修法（Host 侧，Lead 修）：`service.syncTeX` 的 inverse 分支返回结构化结果 `{ ok, file, line, column, raw }`，`/latex/synctex-inverse` 直接 JSON 化；客户端不再解析人类可读串。退一步的客户端兜底（仍不改源码）：用「最后一个 `:<数字>`」切分路径，行号正则改为 `/:([0-9]+)(?=\s|\(|$)/`。

### F3（medium，`[静态]`）工作台「编译」在项目首次构建后不会自动打开预览

- 位置：`client.js:843-859`（`compile`）、`879-887`（`preview`）、`417-424`（`openPreview` 的 `!project.previewVersion` 早退）。
- 触发：某项目第一次成功构建（`previewVersion: 0 → N`），从工作台点「编译」。
- 证据：`compile` 是 `useCallback`，依赖只有 `[project?.id, busy]`，因此闭包里捕获的是**点击时**的 `project`/`snapshot`；`postAction` 里的 `store.set` 只影响下一次渲染。`data.result.status === 'success'` 后调用 `openPreview(project, snapshot, ...)`，而旧 `project.previewVersion` 仍是 0 → `openPreview` 直接 `return false`。第二次编译起 `previewVersion` 已存在，才会打开。
- 影响：首次构建没有预览（与工具描述和 UI 预期不符）；工具卡片路径不受影响（走 `previewRequest`）。
- 建议修法：用 `data.snapshot`/`data.result.previewVersion` 判断，或在回调里 `store.get()` 取最新快照（`openPreview(store.get().projects.find(...))`）。

### F4（medium，`[静态]`）滚动时页码只增不减

- 位置：`client.js:1377-1395`。
- 触发：向下滚过数页后向上回滚（或先 `goToPage` 跳到后面再往回滚）。
- 证据：`let current = page;` 之后只在 `top <= scrollTop + 80` 时执行 `current = Math.max(current, pageNumber)`；因为初值就是当前 `page`，`current` 永远 ≥ `page`。向上滚动时循环仍从 1 开始、`Math.max` 保持旧值 → `current === page`，`setPage` 不触发；`viewStates` 也不会回写更小的页。
- 影响：页码输入框、`/ N` 附近的状态与「当前页」长期不一致；关闭再打开 tab 会回到到达过的最大页。
- 建议修法：`current` 从 1 开始，循环结束后直接 `setPage(current)`（或取最后一个满足条件的页码作为结果，而不是 max）。

### F5（medium，`[静态]`）tab 重建时保存页码覆盖 `params.page`

- 位置：`client.js:1146-1162`（`initialView`/`pendingRestoreRef` 初值）、`1233`（加载后的恢复）、`1440-1446`（params effect）。
- 触发：预览 tab 被关闭后由前向 SyncTeX（`openTab(PREVIEW_KIND, { project, page })`）重新打开，且该项目在模块级 `viewStates` 里有旧页码。
- 证据：`pendingRestoreRef = initialView.page ?? params?.page ?? 1`，即 saved view 优先于本次导航参数；加载完成后 `restore = pendingRestoreRef.current || savedView(projectId).page || 1`。已打开的 tab 走 `params.page` effect（`1440-1446`）是正常的，所以问题只在「新建/重建 tab」这一条路径。
- 影响：请求跳到的页被旧页码顶掉；工作台前向定位的准确性依赖它。
- 建议修法：初值改为 `params?.page ?? initialView.page ?? 1`，并在 `params.page` 变化时同步 `pendingRestoreRef`。

### F6（medium，`[静态]`）工作台不读 tab 参数，`project` 参数被忽略

- 位置：`client.js:812-822`（`LatexPanel` 没有 `useTabInfo`）、`1599`、`1823`、`1855` 三处 `openTab(PANEL_KIND, { project })`。
- 触发：同一会话里有多个 LaTeX 项目时，从项目 B 的预览点「工作台」或从 B 的工具卡片点「工作台」。
- 证据：面板的项目选择只来自 `selectedId`/`activeProjectId`/`sessionIds`/`cwd`（`329-362`）；`params.project` 从未被读取。`latex-panel` 未设 `multiple`，所以一个会话只有一个面板 tab，重复 `openTab` 只会刷新导航参数。
- 影响：用户从 B 点「工作台」，看到的可能是 A（取决于活跃项目/最近使用），没有任何提示。
- 建议修法：注册面板时读 `useTabParams` 并把 `params.project` 作为 `pickProject` 的 `projectId`；或删掉这条无效参数并让入口明确「打开当前活跃项目」。

### F7（medium，`[静态]`）两个快照生产者字段不一致，`activeProjectId` 被 SSE/action 覆盖丢失

- 位置：`client.js:252-259`（SSE 用 payload 整体替换 store）、`284`（fetchState 同理）、`296`；`src/routes.js:270-275`（只有 `/latex/state` 附加 `activeProjectId`）、`477-487`（SSE 发 `service.snapshot()`）、`src/service.js:716-736`（snapshot 无该字段）。
- 触发：任意一次构建/预览请求触发 SSE 广播或 `postAction` 之后。
- 证据：`store.set({ ...parsed, connection: 'live' })` 会丢掉 `/latex/state` 计算出的 `activeProjectId`；此后 `pickProject` 的「活跃项目」分支失效（`336-344`），回落到 session/cwd/最近使用。连接状态也被两条路径各自硬编码成 `live`（`284`、`255`）。
- 影响：恢复的预览 tab、无 `params` 的面板初始选择、以及首次 `selectedId` 的锁定（`825-828`）都可能选到与 `/latex/state` 不同的项目；`connection` 指示器无法反映 SSE 是否真的通。
- 建议修法：让 `service.snapshot()` 接受 `activeProjectId`（或在客户端合并时保留旧值）；把 connection 与数据快照分两个字段，SSE 断线时不要被 fetch 改成 `live`。

### F8（medium，`[静态]`）预览 tab 没有项目身份，恢复后可能显示别的项目；「一项目一 tab」的说法与实现不符

- 位置：`client.js:423`、`1142`；DSH 侧 `sidebar-right:719-721`（page 地址 `sidebar://<kind>`）、`2298-2306`（非 `multiple` 时地址固定）、`1920-1924`（从已提交布局恢复时 `params: void 0`）。
- 触发：刷新/重启后 DSH 从 localStorage 恢复布局；或同一会话里先看 A 的 PDF、再打开 B 的 PDF。
- 证据：`params` 只存在于内存（`tabDomain.hold`），恢复路径 `sync()` 显式写 `params: void 0, revision: 0`；`multiple` 未设 → 一个会话只有一个 `sidebar://latex-preview` tab，所有项目共用它，`claim.title(address)` 也拿不到项目名（`client.js` 注册的 title 是常量 `'preview.title'`）。
- 影响：恢复后 `pickProject` 只能猜（active/session/cwd），多项目时会展示错项目的 PDF，而标题仍写「PDF 预览」。另外 `latex_preview` 工具描述「keeping one tab per project」与实际「一会话一 tab、内容可被改指向」不符（`src/tools.js:195-197`）。
- 建议修法：把 project id 持久化进 tab 的身份（例如自定义 title/close handler 之外，用 `multiple: true` + 项目专属地址；或在恢复时用 `previewUpdatedAt` 最近的项目兜底）；修正工具/README 文案。

### F9（medium，`[静态]`）`pdfjsPromise` 把失败缓存成永久失败

- 位置：`client.js:1117-1129`（模块级 `pdfjsPromise`）、`1208-1209`、`1663`（重试只加 `reloadToken`）。
- 触发：首次预览时代码加载失败（服务刚重启、cookie 过期一次、瞬时网络错误、assets 路由 404/401）。
- 证据：`pdfjsPromise = import(...).then(...)`，rejected promise 不会重置；`loadPdfjs()` 后续永远返回同一个 rejection；重试按钮只递增 `reloadToken`，`loadPdfjs()` 仍命中缓存。
- 影响：整个页面生命周期内预览不可恢复，用户只能刷新整页。
- 建议修法：`pdfjsPromise.catch(() => { pdfjsPromise = undefined; })`，或把成功结果单独缓存。

### F10（medium，`[静态]`）条件调用 hook + 用 try/catch 吞 hook 异常

- 位置：`client.js:306-315`（`pickCwd` 内调 `useSessions`）、`317-327`（`useTabParams` 内调 `useTabInfo`）、`1743-1750`（`LatexToolCard` 内联 `useSessions`）。
- 触发：任何一次 `useTabInfo`/`useSessions` 抛错；最现实的是 tab 记录在 layout 更新间隙尚未提交时。
- 证据：DSH 的 `tabInfoFactory` 自身会主动抛错——`if (layout === void 0 || tab === void 0 || navigation === void 0) throw new Error(...)`（`sidebar-right:4864`），而它内部先调了 `useStore`/`useTabNavigation`（`4856-4892`）。本插件把 `useTabInfo()` 包在 try/catch 里，异常那个 render 会**跳过 `LatexPreview` 后续所有 hook**（`1146` 之后的 `useState/useRef/useMemo/useEffect`），下一次渲染 hook 数量不同 → React 抛 “Rendered fewer hooks than expected”。同理 `pickCwd` 里的 `useSessions` 也把 hook 调用藏在普通函数 + try 里（React 规则要求顶层无条件调用）。
- 影响：低概率但一旦发生就是整块 UI 崩掉（错误边界兜底后预览 tab 白屏），且难以复现。
- 建议修法：不要 try/catch hook。`useTabInfo` 的可用性由框架保证（正文只在已提交 tab 里渲染），改为直接调用；若确实要兜底，把兜底放在组件外层错误边界或 `inject` 里。

### F11（medium-low，`[静态]`）预览 tab 改指向另一个项目时，请求页丢失

- 位置：`client.js:1199-1258`（load effect 用 `savedView(projectId).page` 恢复）、`1440-1446`（params effect）。
- 触发：预览 tab 已打开显示项目 A，工作台对项目 B 前向定位到第 N 页（或工具 `latex_preview` 指定 B+page）。
- 证据：`openTab` 会先把 `params.page` 写进导航；`LatexPreview` 的 params effect 可能在旧 doc 上先 `goToPage(N)`，随后 `projectId` 变化触发 loader，`setDocInfo('loading')` → 重新加载 B 的 PDF → `restore = savedView(B).page || 1`，把 N 覆盖掉。
- 影响：跨项目前向定位落错页（同项目且 tab 已打开时正常）。
- 建议修法：`params.page` 变化时同步 `pendingRestoreRef.current = requested`；loader 恢复时优先读它。

### F12（low-medium，`[静态]`）`pageElsRef` 的 null ref 不清理，旧文档元素残留

- 位置：`client.js:1691-1697`。
- 触发：重新编译/刷新预览（容器 `status!=='ready'` 卸载重建）、或新 PDF 页数变少。
- 证据：ref 回调 `if (!element) return;`，卸载时传 `null` 不做删除；`pageElsRef` 只在组件卸载时随实例消失，期间一直是累积的。`onScroll` 会遍历这些残留元素（`1382-1387`），残留元素的 `offsetTop` 通常为 0，能把 `page` 推到超过 `numPages` 的值；`docInfo` clamp 只在 status/numPages/scale 变化时执行。
- 影响：重载后页码可能显示成「12 / 5」之类；`goToPage` 的 clamp 能兜住，但滚动状态会跳。
- 建议修法：ref 为 null 时 `delete pageElsRef.current[pageNumber]` 并同步删 `pagesRef`。

### F13（low-medium，`[静态]`）`renderPage` 的异步结果没有代次校验

- 位置：`client.js:1285-1312`、`1338-1346`。
- 触发：快速连续改缩放（或容器宽度剧变导致 `scale` 连变两次）。
- 证据：`doc.getPage(n).then(...)` 的回调只校验 `record.element` 存在和 `docRef.current === doc`，不校验「这次调用是否仍是最新一次」「scale 是否已变」；`record.task` 被后一次覆盖，先发起的 promise 晚到仍会改写 canvas 尺寸/样式并 `render`。`record.renderedScale = scale` 也是在回调里用旧 scale 写的。
- 影响：连续缩放后可能出现尺寸/清晰度错乱，或旧页面内容闪回；与 F1 叠加时表现为「有时白、有时有内容」。
- 建议修法：每次 renderPage 自增 `record.generation`，回调里比对；只保留最新 task。

### F14（low，`[静态]`）SSE 重连与连接态

- 位置：`client.js:237-273`、`275-286`；`src/routes.js:281`（同时最多 24 条流）。
- 触发：cookie 失效（401）、流数超限（429）、DSH 重启。
- 证据：`EventSource` 构造失败只 `merge({connection:'error'})` 并保持 `eventsStarted=true`，之后不会重连（没有重试定时器）；`onerror` 一律标 `connecting`，没有区分 readyState/HTTP 状态；服务端 429 时 EventSource 会按 `retry: 2000` 无限重连。`fetchState` 只要成功就把 `connection` 写成 `live`（`284`），即使 SSE 实际已断。
- 影响：连接指示器不可信；断流期间只有手动操作/卡片挂载才会刷新状态。
- 建议修法：`onerror` 里按 `source.readyState` 与失败次数设状态与退避；对 429 指数退避；把「数据新鲜度」与「SSE 连接」拆成两个指示。

### F15（low，`[静态]`）`lastPreviewHandled` 去重的三个盲区

- 位置：`client.js:220`、`1760-1784`；`src/service.js:95, 664-678`（`previewSeq` 是 Host 进程内自增）；`src/routes.js:430-439`（UI 构建不带 `sessionId`）。
- 证据/影响：
  1. `lastPreviewHandled` 是模块变量，页面刷新归零；刷新后挂载历史里最新的 `latex_compile` 卡片时会重新打开预览 tab（用户已关闭的 tab 会被再次打开）。
  2. Host 重启后 `previewSeq` 从 0 开始，若页面没刷新，新请求的 `seq` 会 `<= lastPreviewHandled` 被静默吞掉，自动打开永久失效直到刷新。
  3. UI（`/latex/action`）触发的 `requestPreview` 没有 `sessionId`（`routes.js:437`），卡片的前置过滤 `request.sessionId && ...` 直接放行 → 任何会话的 compile/preview 卡片都可能替别的会话打开预览；这是跨会话副作用。
- 建议修法：handled 状态放进 store 并带上 `request.at`/`sessionId`；UI 构建在 action body 里带 `sessionId`（由客户端补齐）；卡片只处理「本卡片触发」的请求（用 `at >= 卡片开始时间` 过滤）。

### F16（low，`[静态]`）内存与生命周期小项

- 位置：`client.js:1432-1436`（`toastTimerRef` 无卸载清理）、`1294`/`1338-1345`（canvas 像素尺寸不清零）、`221`/`1131-1134`（`viewStates` 无上限）。
- 影响：关闭 tab 后 2.2 s 内的 `setTimeout` 仍会触发（React 18 不再报错，但闭包与组件实例被多留一会儿）；长文档看过的页 canvas 会保留（`limitations.md` §9.4 已记，本报告确认属于「有意取舍但未归零像素」）；`viewStates` 随项目数缓慢增长。
- 建议修法：`useEffect(() => () => clearTimeout(toastTimerRef.current), [])`；页面卸载或缩放重置时 `canvas.width = 0`；`viewStates` 做 LRU（如 64 项）。

### F17（low，`[静态]`）可访问性缺口

- 位置：`client.js:606-613`（`.dl-diag` 可点击样式）、`723-742`（`li` + `onClick`，无 `role`/`tabIndex`/键盘）、`1690`（双击反查无键盘等价物）、`1523-1613`（图标按钮只有 `title`，无 `aria-label`）、`932-935`/`975-978`（连接状态只有颜色）、`1626-1628`（syncNote 无 `aria-live`）、`1534-1542`/`1556-1581`（页码/缩放控件只有 `title`）。
- 影响：键盘/读屏用户无法打开诊断源码、无法触发反查、听不到构建/定位结果。`limitations.md` §9.7 已列一部分，这里补齐控件级证据。
- 建议修法：诊断项改成 `<button>` 或加 `role="button" tabIndex={0} onKeyDown`；图标按钮加 `aria-label`；状态区加 `role="status" aria-live="polite"`；页码/缩放补 `aria-label`。

### F18（low，`[静态]`）尺寸与输入细节

- 位置：`client.js:1166-1173`、`1685-1688`（占位统一用第 1 页 `baseSize`）；`1534-1542`（页码输入 `onChange` 直接 `goToPage(Number(value))`）。
- 证据/影响：混合纸张尺寸 PDF 的占位/滚动条偏差（`renderPage` 会修正已渲染页，见 `1288-1306`）；页码输入被清空时 `Number('')=0` → clamp 到 1 并立刻滚动，输入多位数过程中会「抢滚动」，只能靠连续输入纠正。
- 建议修法：页码输入用本地字符串 state，`onBlur`/Enter 再提交；占位尺寸按每页 viewport（或至少按最常见的页面尺寸）。

### F19（nit）代码卫生与文档偏差

- `client.js:1495` 行首缩进异常（`useCallback(() => {        if (...)`），可执行但像合并残留。
- `client.js:1756` `args.previewProject` 在 7 个工具的参数里都不存在（`src/tools.js:128-141` 只有 `path/mainFile/project`），是死代码；`args.project` 是**路径/目录**，却被当成 project id 传给 `pickProject`，多项目时可能给卡片选中错误项目（仅影响卡片上的「打开预览」按钮，自动打开走 `previewRequest` 是对的）。
- `client.js:1796` `const staleProject = project;` 冗余；`client.js:1366/1372` 只写不读 `observerRef`；`client.js:1857` 硬编码 `'LaTeX'`（未走 i18n，虽然两种语言都叫 LaTeX）。
- `client.js:586` `.dl-btn.primary` 用 `color:#fff`，应使用 `var(--dsw-alias-label-primary-foreground)`（token 表见 `docs/api-cheatsheet.md` G.8）；`.dl-page*` 的 `#fff/#9aa0a6/#fbfbfb/#b9bcc2` 是 PDF 纸张/页号色，属于有意固定，但 `docs/architecture.md` §11.8「颜色一律用主题 token、无硬编码色板」的说法不准确。
- `client.js:364-379` 的 `sessionFileAddress` 是 `documentpreview:54-57` 的第二份实现，且**多了一步相对 cwd 归一**；本轮 node 复跑（附录 A）显示 `cwd=D:/deepseekharness/latex-plugin-tests` 时会把 `.../latex-plugin-tests/synctex/build/preview.pdf` 拼成 `session/<id>/synctex/build/preview.pdf`——若 cwd 与 Host 的文件解析根不一致，地址就指向错文件。`sessionId` 缺失时会得到 `/session/undefined/...`，`openResource` 内部的 try/catch 会把它变成 `false` 并只留一条 `console.warn`（`399-415`），用户没有提示。
- `client.js:20-23` 两个 tab id 带斜杠没问题（框架只要求唯一），但和内置包 `@deepseek-ai/.../guide` 风格一致，建议保持。

### F20（nit）打包与配置的可移植性

- `package.json`：无 `engines.dsh` / `peerDependencies`（`docs/api-cheatsheet.md` A.2 标为可选加固；`link:` 安装下不影响，registry 安装时会少一道兼容性拦截）；`files` 未含 `docs/`、`tests/`，若将来发布 npm 会缺文档（`package.json:15-24`）。
- `dsh.client` 无 `immediately: true`：右栏 tab 首次打开要多一次按需下载（可选优化，不是缺陷，A.2 也这么写）。
- `cordis.patch.yml:17` 硬编码 `D:\latex\texlive2023\...`：与本机环境一致、README 也说明可 override；但换机器必须改，属于可移植性提示。
- 没有导出 Config schema / settings 表单（任务已知限制），客户端也没有设置面板，只能改 YAML —— 与 `limitations.md` §9.9 一致，不属于本半侧的实现缺陷。

---

## 4. FAIL / NOT VERIFIED（agent-side）清单

| 项 | 状态 | 说明 |
| --- | --- | --- |
| 缩放后的实际 UI 表现（F1） | **NOT VERIFIED (agent-side)** | 只有代码路径证据；本会话没有浏览器自动化，`client.js` 也晚于 Lead 的截图。需要一次「打开预览 → 改缩放」的人工复核 |
| 双击反查的 UI 端到端（F2） | **FAIL（解析层，`[实测]`）** | Host 返回串与客户端正则已用真实输出与 node 复现；文件能否打开取决于路径是否被截断，但**行号必然丢失**（本机 xelatex 输出 `Column:-1`） |
| 工作台首次编译自动开预览（F3） | **NOT VERIFIED (agent-side)** | 代码路径明确；未做「全新项目第一次编译」的 UI 复现 |
| 面板/预览的多项目选择（F6/F7/F8） | NOT VERIFIED (agent-side) | 依赖多项目会话与布局恢复的 UI 场景 |
| React hook 顺序异常（F10） | NOT VERIFIED | 需要构造 tab 未提交的时序，未能复现 |
| 键盘/读屏行为（F17） | NOT VERIFIED (agent-side) | 没有键盘驱动的浏览器 |
| CSP 下 PDF.js worker 是否放行 | NOT VERIFIED | 解包出的 host bundle 未见 app 级 CSP；当前环境预览可渲染（Lead 截图）说明现状可用，但无法确认未来策略 |
| `exec.agent.id` 是否等于前端 `sessionId` | NOT VERIFIED | 决定 `previewRequest.sessionId` 过滤是否真的生效；现有「工具调用后自动开预览」的 UI 证据间接支持二者一致 |
| `previewSurface:'document'` 的自动刷新 | NOT VERIFIED | 内建预览由 DSH 控制（`limitations.md` §9.8 已写明） |
| Host 重启后工具/UI 是否仍在 | 不在本任务范围 | 由 acceptance 任务覆盖（`docs/acceptance.md` 已声明不重启 DSH） |

---

## 5. 与队友文档的关系

- `docs/limitations.md` §10.4 已从「限制」角度记录反查正则的两个缺陷（含空格截断、无 column 丢行号）；本报告 F2 给出**真实返回串 + 原始 `synctex Column:-1` + node 复跑**三重证据，并补充「UI 仍显示已定位」的误导性提示。
- `docs/architecture.md` §11.6-§11.8 对 viewer 的描述与代码一致，但有两处需要按本报告更正：① 缩放变化「重置为占位再 renderVisible」并不会重新挂载 canvas（F1）；② 「颜色无硬编码」不成立（F19）。
- `docs/api-cheatsheet.md` 的附录 2 里 `client.js:1056-1060`、`1745-1755`、`1789-1830` 等行号对应的是 16:04 之前的版本；当前 `client.js` 为 2004 行，行号已漂移。建议由该文档的 owner 统一更新（不在本任务 scope）。
- `docs/acceptance.md` 明确把 UI 双击/像素级验证标为 NOT VERIFIED，与本报告一致，没有冲突。

---

## 附录 A：本轮实际运行的命令与原始结果

### A.1 转发/反查实测（工具调用，只读）

```
latex_synctex(project=D:\deepseekharness\latex-plugin-tests\synctex,
              direction="forward", file="main.tex", line=13)
→ SyncTeX forward: page 1 at (125.798264, 699.048828)

latex_synctex(project=D:\deepseekharness\latex-plugin-tests\synctex,
              direction="inverse", page=1, x=125.798264, y=699.048828)
→ SyncTeX inverse: main.tex:11

latex_synctex(project=D:\deepseekharness\latex-plugin-tests\single-math,
              direction="inverse", page=1, x=100, y=100)
→ SyncTeX inverse: main.tex:44
```

### A.2 原始 synctex 输出（证明 Column:-1，因而 Host 不追加 `(column N)`）

```
$ "D:/latex/texlive2023/texlive/2023/bin/windows/synctex.exe" \
    edit -o "1:100:100:D:/deepseekharness/latex-plugin-tests/single-math/build/main.pdf"
This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:D:/deepseekharness/latex-plugin-tests/single-math/build/main.pdf
Input:D:/deepseekharness/latex-plugin-tests/single-math/./main.tex
Line:44
Column:-1
Offset:0
Context:
SyncTeX result end
```

多组坐标（page1: 100,100 / 100,200 / 300,300 / 100,700 / 200,120）全部是 `Column:-1`。

### A.3 客户端正则复跑（node）

```js
const cases = [
  'SyncTeX inverse: main.tex:44',
  'SyncTeX inverse: main.tex:13 (column 5)',
  'SyncTeX inverse: 带 空格 项目/main.tex:13',
  'SyncTeX inverse: sections/ch 1.tex:42',
  'SyncTeX inverse: 中文项目/main.tex:13',
  'SyncTeX inverse: D:/deepseekharness/latex-plugin-tests/synctex/./main.tex:11',
];
for (const s of cases) {
  const line = /:(\d+)(?:\s|\()/.exec(s);
  const source = /SyncTeX inverse: (.+?)(?::\d+)?(?: |$)/.exec(s);
  console.log(s, '=> line:', line?.[1] ?? 'NONE', '| source:', source?.[1]?.trim() ?? 'NONE');
}
// 输出（本轮 node 实跑）：
// "SyncTeX inverse: main.tex:44"                 => line: NONE | source: "main.tex"
// "SyncTeX inverse: main.tex:13 (column 5)"      => line: 13   | source: "main.tex"
// "SyncTeX inverse: 带 空格 项目/main.tex:13"     => line: NONE | source: "带"
// "SyncTeX inverse: sections/ch 1.tex:42"        => line: NONE | source: "sections/ch"
// "SyncTeX inverse: 中文项目/main.tex:13"         => line: NONE | source: "中文项目/main.tex"
// "SyncTeX inverse: D:/..././main.tex:11"        => line: NONE | source: "D:/..././main.tex"
// 对照：forward 的 /page\s+(\d+)/i 在 "SyncTeX forward: page 1 at (...)" 上取到 1。
```

### A.4 `sessionFileAddress` 复跑（把 `client.js:364-379` 原样抄出来）

```
raw path           : "D:\\deepseekharness\\latex-plugin-tests\\synctex\\build\\preview.pdf"
cwd=workspace root : dsh-resource://file/session/s1/latex-plugin-tests/synctex/build/preview.pdf
cwd=subdir (风险)  : dsh-resource://file/session/s1/synctex/build/preview.pdf
cwd undefined      : dsh-resource://file/session/s1/D:/deepseekharness/latex-plugin-tests/synctex/build/preview.pdf
outside cwd        : dsh-resource://file/session/s1/D:/other/proj/build/preview.pdf
space in name      : dsh-resource://file/session/s1/latex-plugin-tests/%E5%B8%A6%20%E7%A9%BA%E6%A0%BC/build/preview.pdf
sessionId missing  : dsh-resource://file/session/undefined/latex-plugin-tests/synctex/build/preview.pdf
```

### A.5 DSH 契约证据（解包副本，只读）

```
sidebar-right:4580-4602   registry.register：id 唯一、kind band 冲突即 throw、返回 disposer
sidebar-right:4702-4726   claim：kind 缺省按 patterns 排名；title(address) 必填
sidebar-right:2298-2306   placeTab：multiple!==true 时地址固定 `sidebar://<kind>`
sidebar-right:719-721     pageAddress(kind) = `sidebar://${kind}`
sidebar-right:1920-1924   tabDomain.sync：恢复的 tab 用 params: void 0, revision: 0
sidebar-right:1400        TabSlot: entryKey = definition?.id ?? tab.kind
sidebar-right:1371        keepMounted 只在显式 true 时保留
sidebar-right:4864        tabInfoFactory：layout/tab/navigation 缺失直接 throw
sidebar-right:2594-2602   require()：无屏幕会话时 throw "no session surface is mounted"
documentpreview:54-57     官方 sessionFileAddress（不做 cwd 相对化）
documentpreview:1081-1089 fallback 文本类型：patterns 全匹配、canOpen 只认 session scope
dsh-client-locale:1387-1430  register 重复抛错、bind 永不抛、缺 ns 回落 common/key
dsh-client-modules:63-75  parseDshClient：校验 platform/inject/external/immediately（其余键忽略）
```

---

## 附录 B：审查覆盖清单（逐段）

| client.js 区段 | 内容 | 本轮检查点 |
| --- | --- | --- |
| 13-23 | bundle 注册、常量 | id=包名、PANEL/PREVIEW id 与 kind |
| 26-183 | zh/en 词典 | 键集 76/76 一致、状态词齐全 |
| 189-304 | runtime、store、EventSource、fetch | SSE 覆盖语义、连接态、store 订阅 |
| 306-362 | useSessions/useTabInfo 包装、project 选择 | hook 用法、active/session/cwd 回退 |
| 364-424 | sessionFileAddress、openTab/openResource/openPreview | 地址语法、options 形状、surface |
| 426-463 | 状态词/色调/时间 | 状态机显示 |
| 469-562 | 图标 | `aria-hidden` |
| 568-647 | CSS | token、硬编码色、布局关键点 |
| 653-746 | StatusPill/ToolButton/Diagnostics | 诊断点击、a11y |
| 748-806 | LogPanel | 取数、错误态、重载触发 |
| 812-1111 | LatexPanel | 项目选择、编译/取消/清理/预览、前向定位、自动编译开关 |
| 1117-1704 | PDF viewer | 加载/渲染/缩放/滚动/页码/IO/双击/参数 |
| 1710-1842 | 工具卡片 | block 形状、预览自动打开、去重 |
| 1848-1859 | header 按钮 | openTab |
| 1865-1997 | apply/注册 | locale、样式、SSE、tab 两阶段、tool view、header action |
| package.json | 打包声明 | exports/files/dsh.* |
| cordis.patch.yml | 配置 | 键与 normalizeConfig、硬编码路径 |

---

## 附录 C：给 Lead 的修复建议优先级

1. **F1**：一行级修复（重置 canvas 引用），影响最大、成本最低；修完请顺手人工确认缩放 + 双击。
2. **F2**：Host 侧结构化返回（`{file,line,column}`）+ 客户端停止解析字符串。只改客户端正则也能救急，但空格路径仍需 Host 侧可靠数据。
3. **F3/F5/F6/F7/F8**：五个「参数/身份」类问题一起修最省事：统一让 `openTab` 的 `params` 成为唯一真相（`project/page`），store 合并时保留 `activeProjectId`，首次编译用 action 返回的快照判断。
4. **F4/F9/F12/F13**：viewer 健壮性小修。
5. **F10/F14/F15/F16/F17**：工程质量与可访问性，可排到 P2。
