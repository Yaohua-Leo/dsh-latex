# dsh-latex 验收与兼容性评估报告

- 报告日期：2026-11-18（Asia/Shanghai）
- 仓库：`D:\github_inbox\dsh-latex`
- 仓库 HEAD：`2ecdf52c64f80d7acfe93ffd4c5ff461029a22ea`（`main`，工作区干净）
- 插件版本：`0.3.0`（`package.json` / `index.js` / `CHANGELOG.md` 一致）
- 目标 DSH：`0.2.1-rc.5`（Electron 44.7.0，内置 Node 24.21.0，Chrome 152.0.7977.130）
- 执行模型：DeepSeek Harness，`deepseek-official / deepseek-flash`，思考强度 Max
- 执行约束：只新增本文件；未修改源码、profile、插件或配置；未 commit/push/建分支；临时文件在 `D:\dsh-tmp`，用后清理；未读取任何凭据文件。

---

## 0. 结论摘要

### 0.1 验收结论

**仓库自带的三条基线检查全部通过**：

| 检查 | 结果 |
| --- | --- |
| `npm test` | **PASS**：7 tests / 7 pass / 0 fail |
| `npm run check` | **PASS**：12 个 Host/Client 源文件语法检查通过 |
| `npm pack --dry-run` | **PASS**：24 files，497.1 kB 包 / 1.8 MB 解包 |

**本机工具链与真实构建通过**：

- 本机有完整的 TeX Live 2025（`D:\texlive\2025\bin\windows`）：latexmk 4.87、xelatex/pdflatex/lualatex、bibtex、biber、synctex、pdftotext/pdfinfo 全部可用。
- `examples/hello`、`examples/chinese`、`examples/multi-file` 用插件相同的 `latexmk` argv 全部编译成功（exit 0），PDF 内容、中文文本层与字体嵌入均已验证。
- 用仓库自身的 `src/build.js`、`src/project.js`、`index.js`、`src/tools.js`、`src/routes.js` 搭了一个**替换掉 DSH 服务实现**的宿主冒烟环境，真实跑通：项目解析 → latexmk → 日志解析 → last-good 发布 → 7 个工具 → `/latex/*` HTTP 面 → 重启恢复。全部通过（详见 §3.6–§3.9）。

**发现 1 个 P0 正确性缺陷**（不是兼容性问题，而是构建成功判定的误报）：

> 当项目 `.latexmkrc` 选择 DVI 模式（`$pdf_mode = 0`）且 `build/main.pdf` 里残留旧 PDF 时，一次**非强制**构建会被判定为 `SUCCESS`，并把旧 PDF 发布成新的 preview 版本。详见 §3.10 与 §7 P0-1。

### 0.2 兼容性结论

**兼容（接口/清单级核对通过；整机运行态未复验）**。

- README 声明“在 DSH 0.2.1-rc.5 上测试”，当前安装的 DSH 正是 **0.2.1-rc.5**，版本精确一致。
- 插件 manifest 引用的三个客户端包全部存在且同为 0.2.1-rc.5：`@deepseek-ai/dsh-client-ui-sidebar-right`、`@deepseek-ai/dsh-client-locale`、`@deepseek-ai/dsh-client-ui-theme`。
- `dsh.bundle.patch`（字符串）与 `dsh.client`（`platform`/`inject`）都被当前 DSH 的 manifest 读取器接受。
- Host 侧依赖的 `tools`、`webServer`、`connection`、`subprocess`、`workingDirectory`、`systemPrompt` 服务，以及 `tools.register`、`webServer.register`、`connection.admit`、`subprocess.spawn`、`workingDirectory.ensure`、`systemPrompt.section` 的接口形状，与当前 DSH 源码一致。
- Client 侧依赖的 `slots`、`locale`、`sidebarRight`、`sidebarRightTabs` 服务、`sidebar.right.pane.tab` / `tool.call.toolview` slot 名、`window.__ModuleLoader__.load({id, factory})` 加载契约，与当前 DSH 源码一致。
- 但**当前 desktop profile 没有安装本插件**（`package.json` 依赖与 `dsh.profile.bundles` 均无 `dsh-latex`，`node_modules/dsh-latex` 不存在），当前 GUI 的 `GET /latex/health` 返回 **404**。因此“在一个真实 DSH 进程里安装、挂载、点通 GUI”这一层是 **NOT VERIFIED**，本次受硬性约束不能安装/修改 profile。

> 结论口径：没有发现任何“版本不匹配 / 包或服务不存在 / 接口形状不一致”的证据，所以判定 **兼容**；但“运行期安装验收”仍未闭环，不能把 GUI 行为写成 PASS。

---

## 1. 环境与版本

### 1.1 DSH 安装

| 项 | 值 | 证据 |
| --- | --- | --- |
| DSH CLI | `D:\deepseekharness\resources\runtime\cli\bin\dsh.cmd` | `dsh --version` → `0.2.1-rc.5` |
| DSH 包版本 | `@deepseek-ai/dsh` 0.2.1-rc.5 | `app.asar\dsh\node_modules\@deepseek-ai\dsh\package.json` |
| Electron | 44.7.0 | `DeepSeek Harness.exe` 以 `ELECTRON_RUN_AS_NODE=1` 运行 `process.versions.electron` |
| 内置 Node | 24.21.0 | 同上；`resources\runtime\versions.json` |
| Chrome | 152.0.7977.130 | 同上 |
| pnpm | 11.28.5 | `resources\runtime\versions.json` |
| 当前 GUI | `http://127.0.0.1:59280` | 运行时上下文；`GET /latex/health` → 404 |
| DSH home | `D:\github_inbox\deepseek-ai\dsh-home` | 环境变量 `DSH_HOME` |
| desktop profile | `D:\github_inbox\deepseek-ai\dsh-home\profiles\desktop` | 只读检查 |

`app.asar` 是单文件归档，本次通过 `ELECTRON_RUN_AS_NODE=1 "D:\deepseekharness\DeepSeek Harness.exe" <script>` + Electron 的 asar 感知 `fs` 只读访问包内源码，没有解包、没有写入安装目录。

### 1.2 系统 Node 与 TeX Live

| 项 | 值 |
| --- | --- |
| 系统 Node / npm | v24.14.0 / 11.9.0 |
| TeX Live | 2025（`D:\texlive\2025\bin\windows`，已在 PATH） |
| latexmk | 4.87 |
| XeTeX | 3.141592653-2.6-0.999997 |
| pdfTeX | 1.40.28 |
| LuaHBTeX | 1.22.0 |
| BibTeX / biber | 0.99d / 2.21 |
| synctex | 1.5 |
| pdftotext / pdfinfo | 可用（TeX Live 自带） |

说明：`docs/` 中历史记录写的是 TeX Live 2023（`D:\latex\texlive2023\...`），本机实际是 TeX Live 2025。插件默认 `texBinDir: ''` 从 PATH 发现，因此**不需要改配置**就能用。

---

## 2. 插件声明的能力、依赖与验收标准

### 2.1 能力（README + 源码核对）

| 能力 | 实现位置 | 备注 |
| --- | --- | --- |
| `.tex` 在右侧栏直接打开为可编辑 tab | `client.js:1884-2007`，`package.json` 的 `dsh.client` | extension 优先级，`canOpen` 只接受 `.tex`；非 `.tex` 回落内建文档预览 |
| 保存 = 编译 = 刷新预览 | `client.js` 保存流程 → `POST /latex/file` → `POST /latex/action {compile-file}` | 自动保存 900 ms 防抖（`editorAutoSaveDelayMs`） |
| 结构化诊断（file:line） | `src/logparse.js`、`src/tools.js`、`src/build.js` | 错误/警告/日志尾部；失败保留旧 PDF |
| 安全写入 | `src/file-io.js` | 仅已存在的 `.tex`、绝对路径、非 UNC、4 MiB、UTF-8、BOM/EOL 保留、原子写、revision CAS |
| PDF 预览 | `client.js`（PDF.js，vendored） | 页码/适合宽度/25–200% 缩放/懒渲染/stale 横幅/双击反查 |
| 7 个模型工具 | `src/tools.js` | compile/preview/diagnostics/status/clean/cancel/synctex |
| 项目识别 | `src/project.js` | 显式主文件 → `% !TEX root` → 自身 `\documentclass` → 反向 `\input/\include` 图 → 会话 cwd |
| 无 shell / 默认 no-shell-escape | `src/build.js` | `subprocess.spawn({argv})`；`-no-shell-escape` 默认；项目 `.latexmkrc` 默认尊重，可用 `allowProjectLatexmkrc: false` 传 `-norc` |
| 本地 HTTP/SSE 面 | `src/routes.js` | `/latex/health`、`/state`、`/events`、`/file`、`/pdf`、`/log`、`/assets/*`、`/action`、`/synctex*` |

### 2.2 依赖的 DSH 服务/接口

**Host 半边**：

| DSH 服务 | 插件用法 | 安装包 |
| --- | --- | --- |
| `ctx.effect` / `ctx.get` / `ctx.logger` | 生命周期、服务等待、日志 | Cordis（DSH 内置） |
| `tools` | `tools.register(defineTool({...}))`，7 次 | `@deepseek-ai/dsh-tools` |
| `webServer` | `webServer.register({kind:'prefix', path:'/latex', handler})` | `@deepseek-ai/dsh-host-webserver` |
| `connection` | `connection.admit({ headers: req.headers })`；401/403；health 例外 | `@deepseek-ai/dsh-client-connection` |
| `subprocess` | `spawn({argv, cwd, stdio:{stdin,stdout:{maxBytes,spill},stderr}, graceMs, signal, env})`；`handle.done`；`handle.collected.std*?.readFrom(0).text` | `@deepseek-ai/dsh-subprocess` |
| `workingDirectory` | `ensure(exec.agent, exec.signal)` 取会话 cwd | `@deepseek-ai/dsh-working-directory` |
| `systemPrompt` | `section({ name:'latex-workspace', order:90, text })` | `@deepseek-ai/dsh-system-prompt` |

**Client 半边**：

| DSH 接口 | 插件用法 | 安装包 |
| --- | --- | --- |
| 模块加载器 | `window.__ModuleLoader__.load({ id:'dsh-latex', factory })`；factory 返回 `{ inject, apply }` | `@deepseek-ai/dsh-client-modules` + `dsh-client-ui-cordis` |
| `slots` | `ctx.slots.inject(seat, cb)` / `ctx.slots.register({ name, key, locale })` | `@deepseek-ai/dsh-client-ui-renderer` / ui-slots |
| `locale` | `register('latex', {zh,en})`、`bind('latex')` | `@deepseek-ai/dsh-client-locale` |
| `sidebarRight` | `openTab(kind, {params})`、`openResource(address, options)` | `@deepseek-ai/dsh-client-ui-sidebar-right` |
| `sidebarRightTabs` | `register({ id, kind, patterns, priority, canOpen, title, guide, keepMounted })` | 同上 |
| slot 名 | `sidebar.right.pane.tab`、`tool.call.toolview` | ui-sidebar-right / ui-tool |
| 资源地址 | `dsh-resource://file/session/<sessionId>/<path>` | `dsh-api-workspace-files` 约定 |

### 2.3 验收标准（仓库声明）

1. **README/CI 基线**：`npm run check`、`npm test`、`npm pack --dry-run` 在 Node 22 的 Ubuntu + Windows 上通过。
2. **docs/acceptance.md 的 A–F 矩阵**：单文件数学、ctex 中文、多文件 `\input/\include` + BibTeX + 交叉引用、错误行号与修复、预览版本刷新/stale、健壮性（空格/CJK 路径、取消、超时、重复构建、失败保留旧 PDF、clean、三引擎、安装/重启）。功能项 FAIL 应为 0。
3. **附录 M/N 的 GUI 项**：`.tex` 直接进编辑器、保存即编译、PDF 自动刷新、失败横幅、冲突横幅、自动保存、缩放/双击反查、内建 document 预览。
4. **兼容性**：在 DSH 0.2.1-rc.5 上可安装、可挂载、工具与 tab 正常；README 的 Limitations 明确其他版本未测试。

> 注意：`docs/acceptance.md` 是一份 **2026-11-03 的历史验收记录**，不是可重复执行的测试套件。它依赖 `D:\deepseekharness\latex-plugin-tests\...` 下的 fixture 与 `_evidence/` 快照，这些在本机/本仓库中**不存在**（已实测 `ls` 失败）。本次用等价临时 fixture 复跑能 CLI 化的部分（§3），其余 GUI 项列入“需人工验收”（§5）。

---

## 3. 命令与验收结果

所有命令在 `D:\github_inbox\dsh-latex` 或 `D:\dsh-tmp` 下执行；临时构建产物在 `D:\dsh-tmp\latex-accept`，报告完成后清理。命令失败均如实记录，没有为了通过而修改任何源码。

### 3.1 `npm test`

```text
$ node --version
v24.14.0

$ npm test
✔ editor auto-save defaults are on and bounded (0.6506ms)
✔ reads and atomically writes .tex while preserving BOM and CRLF (12.1192ms)
✔ rejects a stale revision instead of overwriting an external edit (4.6112ms)
✔ only existing .tex files are editable (1.6454ms)
✔ file routes read, save, and report revision conflicts (11.8171ms)
✔ compile-file resolves by path and returns a compact result (2.0321ms)
✔ file routes reject non-.tex paths and missing files (3.7117ms)
ℹ tests 7 / pass 7 / fail 0
ℹ duration_ms 132.4525
```

- 退出码：**0**
- 另外用 DSH 内置 Node 24.21.0 重跑 `--test`：7 pass / 0 fail，`duration_ms 155.8487`，退出码 **0**。说明测试在插件实际运行的 Node 版本上也通过。

### 3.2 `npm run check`

```text
$ npm run check
check index.js
check client.js
check src\build.js
check src\config.js
check src\file-io.js
check src\logparse.js
check src\project.js
check src\routes.js
check src\service.js
check src\tool.js
check src\tools.js
check src\util.js
CHECK_EXIT=0
```

- 退出码：**0**；12 个文件全部通过 `node --check`。

### 3.3 `npm pack --dry-run`

```text
$ npm pack --dry-run
dsh-latex-0.3.0.tgz
...
npm notice total files: 24
npm notice package size: 497.1 kB
npm notice unpacked size: 1.8 MB
npm notice shasum: fa54cc71c34ce4aab71711818c5840e759f8563f
PACK_EXIT=0
```

- 退出码：**0**；未生成 tarball（`--dry-run`）。
- 打包内容核对：`index.js`、`client.js`、`src/`、PDF.js 两个 `.mjs` + license、`locale/*.json`、`icon.svg`、`cordis.patch.yml`、`screenshots.json`、README、LICENSE 都在。
- **打包缺口**：`package.json` 的 `files` 没有 `assets/screenshots/`，但 `screenshots.json` 与 README 图片都引用 `assets/screenshots/editor.png`、`assets/screenshots/pdf-preview.png`。真实 `npm pack` 出来的 tarball 里这两张图不会存在，marketplace 截图/README 预览图会 404（P2-1）。

### 3.4 TeX Live / latexmk 可用性

```text
$ where latexmk
D:\texlive\2025\bin\windows\latexmk.exe
$ latexmk --version
Latexmk, John Collins, 15 June 2025. Version 4.87
$ where xelatex / pdflatex / lualatex / synctex
均位于 D:\texlive\2025\bin\windows
$ bibtex --version    → BibTeX 0.99d (TeX Live 2025)
$ biber --version     → biber version: 2.21
```

结论：**PASS**。`probeToolchain` 在后续插件级测试中也返回 `ok=true, missing=[]`，说明从 PATH 发现工具的路径成立。

### 3.5 examples 编译（使用插件相同的 latexmk argv）

做法：把 `examples/{hello,chinese,multi-file}` 复制到 `D:\dsh-tmp\latex-accept`，用插件 `src/build.js` 构造的同一组参数构建：

```text
latexmk -interaction=nonstopmode -file-line-error -synctex=1 -recorder \
  -outdir=build -no-shell-escape -xelatex main.tex
```

| 项目 | 退出码 | 耗时 | 产物 | 内容验证 |
| --- | --- | --- | --- | --- |
| `hello` | 0 | 5609 ms | `build/main.pdf` 22068 B，1 页，`main.synctex.gz` 1323 B | `pdfinfo`：1 页 A4；日志 0 error |
| `chinese` | 0 | 3656 ms | `build/main.pdf` 25698 B，1 页，`main.synctex.gz` 2038 B | `pdftotext` 取回“中文排版示例/中文段落/公式”；`pdffonts` 显示 `SimSun`、`SimHei` 已嵌入 |
| `multi-file` | 0 | 2332 ms | `build/main.pdf` 19295 B，1 页，`main.synctex.gz` 1290 B | `pdftotext` 含 “Contents / 1 Introduction / See Lemma 1”；`\input` 与 `\ref` 生效 |

`pdffonts`（chinese）节选：

```text
JRYMRO+SimSun      CID TrueType  Identity-H  emb yes
JHLEDX+SimHei      CID TrueType  Identity-H  emb yes
...
```

结论：**PASS**。这部分等价于 acceptance 的 A/B/C 中“能否编译出正确 PDF”的 CLI 可验证部分；BibTeX/Biber、跨文件交叉引用在 multi-file 例子中未涉及 `.bib`，属于本次未复跑的 A–F 子项。

### 3.6 插件宿主链路 E2E（用仓库自身的 Host 代码 + 代用 subprocess 服务）

因为不允许把插件装进 profile，本次用 `ctx` 的**代用实现**（只替换 DSH 服务，不替换插件代码）直接加载 `index.js`，用 Node `child_process` 实现 `ctx.subprocess.spawn` 的同一接口（`argv`/`cwd`/`env`/`done`/`collected.readFrom`），其余项目解析、构建参数、日志解析、发布、清理全部走仓库真实代码。

脚本结果：

```text
TOOLCHAIN ok=true latexmk=D:\texlive\2025\bin\windows\latexmk.exe missing=[]
RESOLVE chapter -> root=...\multi-file main=...\multi-file\main.tex source=reference
BUILD hello status=success exit=0 pages=1 errors=0 warnings=0 duration=2421ms
PUBLISH preview=22068 bytes meta=295 bytes sha=1b4fe554428289b4
BUILD hello status=success exit=0 pages=1 errors=0 warnings=0 duration=529ms
INCREMENTAL sameHash=true
BUILD broken status=failure exit=12 pages=1 errors=1 warnings=0 duration=1138ms
  first error: ...\broken\main.tex:17 Undefined control sequence.
BUILD broken status=success exit=0 pages=1 errors=0 warnings=0 duration=1720ms
RECOVERY success=success newPreview=27d51bcc6a71e64c
CLEAN removed=6 kept=1 pdfKept=true previewKept=true
```

结论：**PASS**（在代用 subprocess 的前提下）。覆盖：

- 从章节文件 `sections/intro.tex` 反查到 `main.tex`（source=`reference`）；
- 真实 latexmk 构建 → 日志解析 → `preview.pdf` + `last-build-*.json` 原子发布；
- 增量构建（第二次 529 ms，PDF 哈希不变）；
- 故意未定义命令 → exit 12、`main.tex:17` 行号、失败不发布新 preview；
- 修复后成功 → 新 preview 哈希；
- `clean` 只删 6 个 aux，保留 PDF 与 preview。

### 3.7 7 个工具 + HTTP 面 + 重启恢复

用同样的代用 `ctx` 调 `apply(ctx, {})`，检查注册面并调用工具：

```text
TOOLS n=7 names=["latex_compile","latex_preview","latex_get_diagnostics",
                 "latex_get_status","latex_clean","latex_cancel","latex_synctex"]
ROUTES ["prefix /latex"]
PROMPT [{"name":"latex-workspace","order":90}]
```

`latex_get_status`（构建前）：

```text
toolchain: ready | latexmk: D:\texlive\2025\bin\windows\latexmk.exe
status: idle | auto-build: true | watching: true
preview: version - | pages - | none
```

`latex_compile`（真实 latexmk）：

```text
LaTeX build: SUCCESS
engine: xelatex | duration: 2.35 s | exit: 0
pdf: ...\build\main.pdf (1 pages)
preview: ...\build\.dsh-latex\preview-992e1e7c23.pdf | version: 1794996455287
diagnostics: 0 error(s), 0 warning(s)
```

`latex_get_status`（构建后）：

```text
status: success | auto-build: true | watching: true
last build: success (manual) at 18:07:35 in 2348 ms | exit 0 | errors 0
preview: version 1794996455287 | pages 1 | current
```

`latex_clean`：`6 auxiliary file(s) removed`，1 个未识别文件保留（PDF）。

HTTP 面（用真实 `node:http` 把插件的 prefix handler 挂起来，`connection.admit` 用 mock peer）：

| 请求 | 状态码 | 结果 |
| --- | --- | --- |
| `GET /latex/health` | 200 | `{"ok":true,"name":"dsh-latex","version":"0.3.0",...}` |
| `GET /latex/state?session=smoke` | 200 | 1 个项目，`activeProjectId=p_45fff517eaeb4c55` |
| `GET /latex/pdf?project=...` | 200 | `application/pdf`，22068 B，magic `%PDF` |
| `GET /latex/file?path=...main.tex` | 200 | 返回 content + sha256 revision |
| `POST /latex/file`（正确 revision） | 200 | revision 改变 |
| `POST /latex/file`（旧 revision） | 409 | `the file changed on disk since it was loaded` |
| `GET /latex/file`（非 `.tex`） | 400 | `only .tex files can be edited` |

重启恢复（新进程 + 新 service，同一项目目录，不重新构建）：

```text
status: success | auto-build: true | watching: true
last build: success (restored) at 18:07:35 in 2348 ms | exit 0 | errors 0
preview: version 1794996455287 | pages 1 | current
```

结论：**PASS**。`#restorePublishedState` 在当前源码上确实恢复 `status`/`lastBuild`/`previewVersion`，修复了历史 acceptance §1.4 观察到的“只恢复版本、不恢复状态”的问题。

### 3.8 失败输出中的旧 PDF 行（观察项）

失败构建的真实工具输出：

```text
LaTeX build: FAILURE
engine: xelatex | duration: 1.15 s | exit: 12
pdf: ...\build\main.pdf (1 pages)        ← 这是上一次成功的旧 PDF
diagnostics: 1 error(s), 0 warning(s)
errors:
- main.tex:17: Undefined control sequence.
```

`pdf:` 行没有 stale 标记，容易被模型误读为“本次也生成了 PDF”。源码依据：`src/tools.js:43-44` 只要 `result.pdfPath` 存在就打印，而失败结果里的 `pdfPath` 是 `#findOutputPdf` 找到的旧文件。这一点与 `docs/acceptance.md` §9.1 的观察一致，**当前仍未修**（P1-2）。

### 3.9 已知缺陷复现：项目 `.latexmkrc` DVI 模式 + 旧 PDF → 误报 SUCCESS

**复现条件**（全部在 `D:\dsh-tmp` 的副本上）：

1. 复制 `examples/hello`；
2. 写项目 `.latexmkrc`：`$pdf_mode = 0;`（latexmk 只产 DVI）；
3. 在 `build/main.pdf` 预先放一份旧 PDF，mtime 设为 1 小时前；
4. 用插件真实 `LatexBuilder.build()`（默认配置：`allowProjectLatexmkrc=true`、`respectLatexmkrc=true`、`preserveLastGood=true`），`force=false`。

实测：

```text
rc-noforce force=false -> status=success exit=0 upToDate=true
                          pdfExists=true pdfIsStale=true previewIsStale=true
   tail=Output written on build/main.dvi (1 page, 996 bytes).
        Latexmk: All targets (build/main.dvi) are up-to-date

rc-force   force=true  -> status=failure exit=0 upToDate=true pdfExists=false
   error=latexmk exited 0 but no PDF was produced.
         The project .latexmkrc may select DVI mode; ...

norc                  -> status=success exit=0 pdfIsStale=false
```

根因在 `src/build.js:368-373`：

```js
const upToDate =
  /all targets .*are up-to-date/i.test(combinedOutput) ||
  /nothing to do/i.test(combinedOutput);
const pdfFresh = Boolean(pdfStat && pdfStat.mtimeMs >= startedAt - 2_000);
const pdfOutput = Boolean(parsed.outputFile && /\.pdf"?\s*$/i.test(parsed.outputFile.trim()));
const freshEvidence = upToDate || pdfFresh || pdfOutput;
```

latexmk 在**任何完整成功结束时**都会打印 `Latexmk: All targets (...) are up-to-date`（本次三个 examples 的 stdout 末尾都能看到），所以 `upToDate` 几乎恒为 true，并且它不检查目标列表里有没有 `.pdf`。当旧 `main.pdf` 还在、latexmk 只重建 DVI 时，`pdfFound` + `upToDate` 同时成立 → `success` → `atomicCopy` 把旧 PDF 发布成新版本。`force=true` 时 latexmk 的 `-gg` 清理会删掉旧 PDF，于是又变成 failure，行为不一致。

这与 `docs/review-fixes.md` 的 M3/M4“已修复”记录冲突，是本轮验收发现的**最重要缺陷**（P0-1）。

### 3.10 客户端注册面冒烟（不接 DSH UI）

用 Node 评估真实 `client.js`：提供最小 `window.__ModuleLoader__`、React stub、`document` stub、mock `ctx`，执行 factory 返回的 `apply(ctx)`。结果：

```text
MODULE id=dsh-latex hasApply=true inject=["slots","locale","sidebarRight","sidebarRightTabs"]
TABS editor=true preview=true
EDITOR patternTest tex=true md=false title=main.tex keepMounted=true priority=extension
PREVIEW guide=[{"id":"preview","order":41,"title":"zh:preview.title"}]
LOCALE [{"ns":"latex","languages":["zh","en"]}]
SLOTS ["sidebar.right.pane.tab:dsh-latex/editor",
       "sidebar.right.pane.tab:dsh-latex/preview",
       "tool.call.toolview:latex_compile", ... 共 7 个工具卡]
```

另外用当前 DSH 自带的 `picomatch 4.0.7` 验证了插件注册的 `.tex` 模式：源码字面量与当前 DSH 内置文档预览（`dsh-client-ui-sidebar-documentpreview`）完全一致，运行时字符串为 `dsh-resource://file/[\s\S]+`；对真实地址 `dsh-resource://file/session/.../main.tex`、`.../absolute/D:/...` 返回 `true`，对 `.md` 被 `canOpen` 拒绝。属于正确写法。

结论：**PASS**（注册面）；真实 UI 渲染仍需人工验收。

### 3.11 当前 desktop profile 安装状态

```text
$ curl http://127.0.0.1:59280/latex/health
HTTP=404

$ grep -Rni "dsh-latex" profiles/*/package.json profiles/*/cordis.patch.yml
（无输出）

$ ls profiles/*/node_modules/dsh-latex
（不存在）
```

- `D:\github_inbox\deepseek-ai\dsh-home\profiles\desktop\package.json` 的 `dependencies` 与 `dsh.profile.bundles` 都没有 `dsh-latex`。
- 也没有安装到 `web` / `headless` profile（同上 grep/ls 无结果）。
- 因此当前运行的 GUI 里没有本插件；`/latex/health` 404 是决定性证据。

---

## 4. 与 `docs/acceptance.md` 的对应关系

| acceptance 项 | 能否 CLI 执行 | 本次结果 |
| --- | --- | --- |
| A 单文件数学 | 部分（可直接编译 PDF，无法调插件工具） | 用 examples/hello + 插件宿主 E2E 复现 → PASS |
| B ctex 中文 | 部分 | examples/chinese 编译 + pdftotext/pdffonts → PASS |
| C 多文件 `\input`/`\include` + BibTeX | 部分 | examples/multi-file 的 `\input`/`\ref` → PASS；BibTeX/Biber 未用 `.bib` fixture → 未复跑 |
| D 错误定位与修复 | 部分 | 插件宿主 E2E：`main.tex:17 Undefined control sequence.`，修复后成功 → PASS |
| E 预览版本刷新/stale | 工具级可 | 发布/版本/失败保留旧 PDF 已由宿主 E2E 覆盖；浏览器像素级刷新 → 需人工 |
| F1 空格/中文路径 | 可（自建 fixture） | 本次未单独跑（examples 路径无空格/CJK）；历史 acceptance PASS，标记未复验 |
| F2 取消构建 | 仅插件运行时可 | 未复跑（需长构建 + 工具并发）；代码路径存在 → 需人工/后续自动化 |
| F3 超时/下限 clamp | 仅插件运行时可 | 未复跑；代码 `Math.max(5_000, ...)` 仍在 → 需后续验证 |
| F4 重复构建 | 可 | 宿主 E2E 第二次 529 ms，PASS |
| F5 失败保留旧 PDF | 可 | 宿主 E2E 失败未发布新 preview；但 `pdf:` 行误导（§3.8） |
| F6 clean 只删 aux | 可 | 宿主 E2E：6 removed / 1 kept，PASS |
| F7 三引擎 | 可 | xelatex 复跑 PASS；pdflatex/lualatex 未复跑（二进制可用） |
| F8 安装/重启 | 可检查 profile；重启不可 | profile 未安装；restore 代理 PASS |
| F9 无构建取消 | 仅插件运行时可 | 未复跑 |
| 附录 L/M/N GUI | 否 | 全部需人工验收（见 §5） |
| 附录 L 的 CJK 双击/正向按钮 | 否 | 仍为“部分/未逐像素验证” |

结论：`docs/acceptance.md` 的完整矩阵**不能在本次环境直接重放**：fixtures 路径、旧插件目录、运行中的插件 Host 都不存在；只能用等价临时 fixture 覆盖 CLI 可验证部分。历史文档中的 PASS 只能作为参考，不能当作本次证据。

---

## 5. 需人工验收的 GUI 步骤

以下步骤因“当前 profile 未安装本插件 + 本次禁止安装/修改 profile”而**全部未执行**。表中所有项均标记为 **需人工验收**；“当前状态”一列说明本次是否执行以及原因。人工验收时建议按顺序做（安装属于验收前置，需要用户另行授权；不要在本次会话里做）。

| # | 步骤 | 预期 | 当前状态 |
| --- | --- | --- | --- |
| G1 | 在目标 profile 安装插件（`dsh plugin --profile desktop add <abs path>` 或 Plugin Manager `install_bundle`），刷新页面 | profile 出现依赖与 bundle；`/latex/health` 200；日志 `latex plugin loaded` | 未执行（禁止安装） |
| G2 | 右侧栏文件树打开 `examples/hello/main.tex` | 出现 `TeX 编辑` tab（行号 + textarea），不是内建只读预览 | 未执行 |
| G3 | 编辑并停手约 900 ms | 自动保存 + 自动编译；状态 pill 显示自动/手动；生成/刷新 PDF 预览 | 未执行 |
| G4 | Ctrl+S / 三角按钮 | 立即保存并构建，`latex_compile` 等价路径返回 SUCCESS | 未执行 |
| G5 | 插入 `\undefinedcommand` 后保存 | 顶部红色“编译失败 · 1 error(s) — main.tex:LINE …”；旧 PDF 保留；诊断 file:line 正确 | 未执行 |
| G6 | 修复错误后保存 | 自动/手动构建成功，红色横幅消失，PDF 内容更新 | 未执行 |
| G7 | 在编辑器外修改同一 `.tex`，再保存 | 黄色“磁盘文件已被外部修改”，提供“重新加载 / 强制保存” | 未执行 |
| G8 | PDF 预览：页码跳转、适合宽度、25/50/100/200% 缩放、滚动 | 页面按需渲染、不空白、页码/缩放状态保持 | 未执行 |
| G9 | 双击 PDF 页面（ASCII 路径） | 反向 SyncTeX，打开对应源文件并定位到行 | 未执行；历史记录 PASS |
| G10 | 同上，CJK/带空格路径 | 反查文件/行正确（不是乱码/截断） | 未执行；历史记录为“部分” |
| G11 | 切换 `previewSurface: document` | 内建文档预览打开 `preview.pdf`；页码/刷新由 DSH 控制 | 未执行；插件侧无法控制 |
| G12 | 聊天里调用 7 个 `latex_*` 工具 | 出现紧凑工具卡；成功/失败/运行中状态正确 | 未执行（client 注册面已冒烟） |
| G13 | 设置 → 语言切到 English / 中文 | 插件 tab、按钮、工具卡文案切换；无未翻译 key | 未执行 |
| G14 | 重启 DSH | `/latex/health` 新 `startedAt`；`latex_get_status` 显示 `success (restored)` 与 preview 版本 | 未执行（restore 已在代用环境验证） |
| G15 | 卸载/禁用 bundle | 工具与 tab 消失；无残留路由/请求报错 | 未执行 |
| G16 | 单会话多项目、两个主文件同目录 | PDF 预览在项目间正确切换；`preview-<fingerprint>.pdf` 不互相覆盖 | 未执行 |

建议人工验收时同时记录：GUI URL、DSH 版本、`/latex/health` JSON、截图、`build/.dsh-latex/last-build-*.json`、以及 `latex_get_status`/`latex_get_diagnostics` 的原始输出。

---

## 6. 兼容性核对

### 6.1 版本

| 项 | 插件声明 | 当前 DSH | 结论 |
| --- | --- | --- | --- |
| 测试基线 | README：DSH 0.2.1-rc.5 / Windows 11 | 0.2.1-rc.5 | **一致** |
| Node | `engines.node >= 20` | 内置 24.21.0 | **满足** |
| Electron | 未声明 | 44.7.0 | 未声明，无冲突 |

### 6.2 manifest

| 字段 | 插件值 | 当前 DSH 读取器 | 结论 |
| --- | --- | --- | --- |
| `dsh.bundle.patch` | `"./cordis.patch.yml"`（字符串） | `bundlePatchFiles()` 接受 string 或 string[] | **兼容** |
| `dsh.client.platform` | `"web"` | `parseDshClient()` 要求 string | **兼容** |
| `dsh.client.inject` | 3 个包名 | 接受 string[]，用于加载排序 | **兼容**（包名均存在） |
| `dsh.client.external` | 未声明 | 可选 | 不需要（只 `require('react')`） |
| `dsh.client.immediately` | 未声明 | 可选 | 非必需 |
| `exports["./client"]` | `./client.js` | 模块加载器按 `<pkg>/client` 解析 | **存在** |
| `exports["./locale/*.json"]` | `./locale/*.json` | 插件元信息读取 | **存在**；`meta.title/description` 形状匹配 |
| `exports["./icon"]` | `./icon.svg` | `readPluginMeta`/icon 逻辑 | **存在** |
| `engines.dsh` | **未声明** | 安装期兼容性检查不会拦截 | 缺声明（P2-2），不是不兼容 |
| `dsh.manifestVersion` | **未声明** | 可选 | 同上 |

### 6.3 客户端包与注入点

| 插件引用 | 当前 DSH 是否存在 | 版本 | 证据 |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-client-ui-sidebar-right` | 是 | 0.2.1-rc.5 | app.asar `node_modules`；`dsh-web-app` 的 `cordis.patch.yml` 有 `ui-sidebar-right` 行 |
| `@deepseek-ai/dsh-client-locale` | 是 | 0.2.1-rc.5 | 同上，`locale` 行 |
| `@deepseek-ai/dsh-client-ui-theme` | 是 | 0.2.1-rc.5 | 同上，`ui-theme` 行（插件未实际使用，见 P2-8） |
| `@deepseek-ai/dsh-client-modules` | 是 | 0.2.1-rc.5 | `window.__ModuleLoader__` 生产方 |
| `@deepseek-ai/dsh-client-ui-renderer` / ui-slots | 是 | 0.2.1-rc.5 | `ctx.slots` 来源 |
| `@deepseek-ai/dsh-client-connection` | 是 | 0.2.1-rc.5 | Host connection 服务 |
| `@deepseek-ai/dsh-host-webserver` | 是 | 0.2.1-rc.5 | `webServer` 服务 |
| `@deepseek-ai/dsh-tools` | 是 | 0.2.1-rc.5 | `tools` 服务 |
| `@deepseek-ai/dsh-subprocess` / `-local` | 是 | 0.2.1-rc.5 | `subprocess` 服务 |
| `@deepseek-ai/dsh-working-directory` | 是 | 0.2.1-rc.5 | `workingDirectory` 服务 |
| `@deepseek-ai/dsh-system-prompt` | 是 | 0.2.1-rc.5 | `systemPrompt` 服务 |

### 6.4 Client API 形状

| 插件用法 | 当前 DSH 实现 | 结论 |
| --- | --- | --- |
| `window.__ModuleLoader__.load({id, factory})` | `dsh-client-modules` 的 boot 协议；factory 返回 plugin | **兼容**（本次 client 冒烟通过） |
| factory 返回 `{inject, apply}` | Cordis client runner 接受 `apply` + `inject` | **兼容** |
| `ctx.slots.inject(seat, cb)` / `register({name,key,locale}, Component)` | `dsh-client-ui-renderer` 的 SlotRegistry | **兼容**（多个内置插件同写法） |
| `sidebarRightTabs.register({id,kind,patterns,priority,canOpen,title,guide,keepMounted})` | `SidebarRightTabRegistry.register` 支持全部字段；band 为 extension/builtin/fallback | **兼容** |
| `sidebarRight.openTab(kind, {params})` / `openResource(address, opts)` | `SidebarRightController` 同名方法 | **兼容** |
| `locale.register(ns, {zh,en})` / `locale.bind(ns)` | `LocaleRuntime` 同名方法 | **兼容** |
| `.tex` 模式（与内置 documentpreview 同字面量；运行时 `dsh-resource://file/[\s\S]+`） | picomatch 4.0.7 | **兼容**（实测匹配真实地址） |
| slot 名 `sidebar.right.pane.tab` | ui-sidebar-right 对外 seat | **兼容** |
| slot 名 `tool.call.toolview` | ui-tool / ui-cordis 对外 seat | **兼容** |

### 6.5 Host API 形状

| 插件用法 | 当前 DSH 实现（0.2.1-rc.5） | 结论 |
| --- | --- | --- |
| `ctx.get('tools')` + `tools.register(def)` | `dsh-tools` 的 `ToolRuntime.register(definition)` | **兼容** |
| 本地 `defineTool` 输出 `{name,description,parameters,output:{schema,render},execute,timeoutMs,isConcurrencySafe}` | `dsh-tools/lib/types/schema.js` 的 `defineTool` 同形；额外可选字段不影响 | **兼容**（vendored 实现有漂移风险，P2-5） |
| `webServer.register({kind:'prefix', path:'/latex', handler})` | `dsh-host-webserver` 的 `register(route)` 接受 `exact|prefix` + handler | **兼容** |
| `connection.admit({headers: req.headers})` → `{peer}` / `{rejection}` | `admit(request)` 在当前实现只读 `request.headers`；`isTrustedApiRequest`/`authenticate` 也是 header-only | **当前可用**；传参不是正式 request 形状，属潜在风险（P2-4） |
| `subprocess.spawn({argv,cwd,stdio,graceMs,signal,env})` | `dsh-subprocess` 的明确请求形状；collect 支持 `maxBytes` + `spill.maxBytes` | **兼容** |
| `handle.done` → `{exitCode, signal}` | 同 README/实现 | **兼容** |
| `handle.collected.stdout?.readFrom(0).text` | `OutputCollector.readFrom` 返回 `{text,nextOffset,lossy,...}` | **兼容** |
| `workingDirectory.ensure(exec.agent, exec.signal)` | `dsh-working-directory` 同名方法 | **兼容** |
| `systemPrompt.section({name,order,text})` | `dsh-system-prompt` 同名方法；要求有限 order | **兼容**（90） |
| `ctx.effect` / `ctx.logger` | Cordis | **兼容** |

### 6.6 desktop profile 安装状态

见 §3.11：**未安装**，GUI 中 `/latex/health` 404。没有发现“安装失败”记录，也不能据此反推插件有问题——它从未被装进这个 profile。

### 6.7 兼容性结论

**兼容**，依据：

1. 目标 DSH 版本与 README 声明精确一致（0.2.1-rc.5）；
2. 所有 manifest 引用的包都存在且同版本；manifest 字段被当前读取器接受；
3. 所有 Host/Client 服务、slot、资源地址、模块加载契约都能在 0.2.1-rc.5 的 `app.asar` 源码中找到对应实现，形状一致；
4. 用真实仓库代码 + 真实 latexmk 的宿主冒烟通过；客户端注册面冒烟通过。

保留意见：

- **整机运行态未复验**：没有把插件装进 desktop profile，因此“DSH 进程启动时真正 import 插件并挂载 UI”没有现场证据；这是验收状态问题，不是接口不兼容的证据。
- 3 个潜在兼容风险（当前版本都不触发）：`admit({headers})` 的非正式入参形状、vendored `defineTool` 与 DSH schema 的漂移、未声明 `engines.dsh`。见 §7。

---

## 7. 缺口与未完成工作（P0 / P1 / P2）

### P0

#### P0-1 项目 `.latexmkrc` DVI 模式 + 旧 PDF → 误报 SUCCESS 并发布旧 PDF

- **现状**：`src/build.js:368-373` 的 `upToDate` 正则匹配 latexmk 正常结束行 `Latexmk: All targets (...) are up-to-date`，且不要求目标列表含 `.pdf`；`#findOutputPdf` 又能找到遗留的 `build/main.pdf`。实测 `rc-noforce` 返回 `success`、`previewIsStale=true`。`force=true` 时因 latexmk `-gg` 清理掉旧 PDF 反而返回 failure，行为不一致。
- **为什么值得做**：这是“成功 = 新 PDF”这一核心契约的破口。用户/模型会拿到一个 `SUCCESS`、新 preview 版本和旧 PDF 内容；如果这份 PDF 被提交/上传，是实质错误。它也说明 `docs/review-fixes.md` 的 M3/M4 修复没有真正覆盖所有 rc 场景，现有测试没有回归。
- **建议做法**：
  1. 把 `upToDate` 改成“目标列表里含 `.pdf` 且该 PDF 是本轮的新产物/明确 up-to-date”，例如 `All targets \(([^)]*\.pdf[^)]*)\) are up-to-date`；
  2. 保留 `pdfFresh` 作为更强证据：`pdf.mtime >= startedAt - 2s`，或解析 log 的 `Output written on ...pdf` 并校验路径；
  3. 失败/无新 PDF 时不要把旧 `pdfPath` 当作本次结果（与 P1-2 一起改）；
  4. 增加回归测试：`.latexmkrc` 设 `$pdf_mode=0` + 预置旧 PDF，断言 `failure` 且 preview 不变；再断言 `allowProjectLatexmkrc:false` 时成功。

### P1

#### P1-1 运行期安装/GUI 验收未闭环

- **现状**：desktop profile 未安装；`/latex/health` 404；全部 GUI 项（§5）未执行。
- **为什么值得做**：接口兼容不等于产品可用；tab 打开、自动保存、PDF 刷新、冲突、SyncTeX 双击、语言切换都只能在装好后的真实 GUI 里验证。README/acceptance 的历史截图来自另一台机器的旧 profile（`C:\Users\...\.dsh`），不能替代本机。
- **建议做法**：在获得授权后，用一次性测试 profile 或临时 profile 安装（不要污染日常 desktop），按 §5 的 G1–G16 走一遍；记录 `/latex/health`、`latex_get_status`、截图、`last-build-*.json`。验收完卸载。

#### P1-2 失败输出仍打印旧 `pdf:` 行

- **现状**：§3.8；`formatResult` 在 `failure`/`timeout`/`cancelled` 时仍打印上一次成功 PDF 的路径与页数，无 stale 标记。
- **为什么值得做**：模型会把 `pdf: ... (1 pages)` 理解为“本次构建生成了 PDF”，与 `diagnostics: 1 error(s)` 自相矛盾，容易导致错误决策（例如继续用旧 PDF 提交）。
- **建议做法**：失败时改为 `pdf: ... (stale: previous successful build)` 或完全不打印；仅在 `status === 'success'` 时打印 `pdf:`；同时给 `latex_get_status` 的 `pdf:` 行加“exists/stale”语义。

#### P1-3 核心路径缺少自动化测试，CI 不跑真实 TeX

- **现状**：`test/` 只有 3 个文件、7 个用例，覆盖 `config`、`file-io`、`file routes`；`src/build.js`、`logparse.js`、`project.js`、`service.js`、`tools.js`、`client.js` 都没有测试。CI 只跑 `check/test/pack`，不装 TeX、不构建 examples。
- **为什么值得做**：P0-1 就是一个“测试能直接拦住”的回归；queue merge、cancel、clean、restore 等已修问题同样没有回归。CI 不跑 TeX 也无法发现 latexmk 版本/参数行为变化。
- **建议做法**：
  1. 为 `build.js` 增加 fake subprocess + fixture `.log` 的单元测试（成功/失败/DVI/超时/取消/发布失败）；
  2. 为 `logparse.js` 增加固定日志 fixture（file:line、折行、BibTeX/Biber、非法字符）；
  3. 为 `project.js` 增加 magic root / 多根 / 反向依赖 / allowedRoots 的临时目录测试；
  4. 为 `service.js` 增加 queue 合并、cancel 等待窗口、clean 互斥、restore 的单测；
  5. CI 的 Windows job 安装 TeX Live 或使用容器，跑一个 `examples/hello` 的 `latexmk` smoke（可以只在 main 分支/手动触发，避免每个 PR 太重）。

#### P1-4 `docs/limitations.md` 与当前源码明显漂移

- **现状**：该文档仍把以下**已修复**项写成当前缺陷：队列合并丢 manual job（§4）、semaphore 等待期取消（§3.2）、clean/构建竞态（§3.5）、消费端用正则拆 SyncTeX 字符串（§10.4）、Windows-only 硬编码（§11.1，实际 `build.js` 已用 `path.delimiter`/`process.platform`）、`keepBuildLogTail` 死配置（§6.4，仍是死的，但描述的行号已旧）。`review-fixes.md` 说已修，`limitations.md` 正文没同步。
- **为什么值得做**：维护者/验收者会按 limitations 判定“还有高危问题”，造成误判；本轮 P0-1 的判定也受益于“不能只看 docs，要看源码”。
- **建议做法**：以 `review-fixes.md` 的 FIXED/DOCUMENTED/DEFERRED 为准重写 limitations 正文；已修项移到“历史问题”附录；给每条保留项标注当前源码位置；加一个 CI/脚本检查文档中的 `文件:行号` 是否还指向存在的内容（至少人工每版校对）。

#### P1-5 无 Config schema、无 Settings 表单，配置只能改 YAML

- **现状**：`index.js` 只导出 `name/version/apply`，没有 `export const Config`；`normalizeConfig` 对未知键/拼写错误静默忽略；改配置需要修改 bundle/profile 的 `cordis.patch.yml` 并 recompose。
- **为什么值得做**：`editorAutoSave`、`engine`、`texBinDir`、`timeoutMs` 等是用户常用项；没有 schema 时拼错键不会报错，只能靠行为猜；Panel 里也没有设置入口。
- **建议做法**：用 `@deepseek-ai/schemastery` 导出 `Config`（注意 link 安装无法解析 Harness 包，可改用 vendored/兼容的 schema 或声明 optional peer）；至少在 `normalizeConfig` 中对未知键发 warning；或在文档中提供一份“配置校验 checklist”。这项也可以明确标为“不做”，但要在 README 里写清当前边界。

### P2

#### P2-1 打包缺 `assets/screenshots/`，`screenshots.json` 与 README 图片在 tarball 中失效

- **现状**：`package.json.files` 没有 `assets/screenshots`，`npm pack --dry-run` 的 24 个文件里没有两张截图；`screenshots.json` 和 README 的 `![...](assets/screenshots/*.png)` 仍引用它们。
- **为什么值得做**：marketplace/GitHub release tarball 的预览图会 404，影响安装转化。
- **建议做法**：把 `assets/screenshots` 加进 `files`；或在发布脚本里生成截图并校验 `screenshots.json` 的每个路径存在。

#### P2-2 未声明 `engines.dsh` / `dsh.manifestVersion`

- **现状**：`package.json.engines` 只有 `node: ">=20"`；安装期 compatibility preflight 不会检查 DSH 版本。
- **为什么值得做**：README 只说“tested against 0.2.1-rc.5”，装到不兼容版本时用户不会收到安装期提示，只能在运行时踩坑。
- **建议做法**：声明 `"dsh": ">=0.2.1-rc.5 <0.3.0"`（注意 SemVer 预发布比较，需实测 `includePrerelease` 下的匹配）或至少声明 `>=0.2.1-rc.5`；同时评估 `manifestVersion: 1`。

#### P2-3 SSE 不按会话过滤，所有已鉴权页面看到全部项目路径

- **现状**：`openEventStream(res, service, streams, sessionId)` 接收 `sessionId` 但未使用；`service.#emit` 向所有 listener 推完整 `snapshot()`（`src/routes.js:532-575`、`src/service.js:923-932`）。
- **为什么值得做**：desktop 单人 loopback 风险低；但插件也支持 `web` profile，多用户/多会话时会把其他项目的绝对路径、主文件名、日志路径暴露给同机其他已鉴权页面。
- **建议做法**：按 `sessionId` 过滤 `snapshot.projects`（只推 active 项目 + 计数），或至少提供 `?session=` 的过滤语义；把 `project.rootDir` 等敏感字段从 SSE 中裁剪。

#### P2-4 `connection.admit({ headers })` 传参不是正式 request 形状

- **现状**：`src/routes.js:133-154` 把 `{ headers: req.headers }` 传给 `admit`。当前 0.2.1-rc.5 的 `admit`/`isTrustedApiRequest`/`authenticate` 只读 headers，所以可用；但文档契约是 `admit(request)`，未来若加入 `url/method` 检查会破坏。
- **为什么值得做**：这是“现在能跑、升级可能坏”的隐性兼容风险。
- **建议做法**：直接传 `req`（Node IncomingMessage）而不是裁剪对象；`admit` 不修改请求，安全。

#### P2-5 vendored `defineTool` 与 DSH schema DSL 的漂移风险

- **现状**：`src/tool.js` 是 201 行的本地 `defineTool` 等价物（为了 link 安装不解析 Harness 包）。它支持 `string/number/integer/boolean/null/array/object/json/oneOf` 和 `required` 标记，但 DSH 的 `dsh-tools` 版本升级可能加入新语义/校验。
- **为什么值得做**：工具参数 schema 是模型可见契约；漂移会导致参数被拒或描述不一致。
- **建议做法**：加一个小型契约测试：把本地 `defineTool` 对 7 个工具的输出与 DSH `parameterSchemaSpecToJsonSchema` 的结果对比（可作为 CI 的可选 job）；或在安装形态支持 `peerDependencies` 后改用官方 `defineTool`。

#### P2-6 死配置 / 死字段 / 资产白名单笔误

- **现状**：
  - `keepBuildLogTail` 在 `config.js` 定义并归一化，但 `build.js:467` 硬编码 `64 * 1024`，全仓无读取；
  - `engineFlag` 在 `config.js` 计算，`build.js` 用自己的 `ENGINE_ARGS`，无读取；
  - `ASSET_NAMES` 含 `LICENSE-pdfjs.txt`，磁盘实际是 `assets/licenses/PDFJS-NOTICE.txt`，请求该资产会 404。
- **为什么值得做**：文档/配置与实现不一致，用户改键无效；资产 404 是小的可见缺陷。
- **建议做法**：要么接线（`logTail` 用 config、`engineFlag` 复用），要么删除；把 `LICENSE-pdfjs.txt` 改成 `licenses/PDFJS-NOTICE.txt` 或从白名单移除。

#### P2-7 平台残留：SyncTeX 的 PATH 仍用 `;` 拼接

- **现状**：`src/build.js` 已用 `path.delimiter`/`process.platform` 做跨平台；但 `src/service.js:1003` 的 SyncTeX env 仍是 `[texBinDir, PATH].join(';')`。README 说 POSIX 代码路径“implemented but not end-to-end tested”。
- **为什么值得做**：macOS/Linux 上 SyncTeX 的 PATH 会被拼成一条无效变量；不影响 Windows 当前部署。
- **建议做法**：改用 `path.delimiter`；补一个 POSIX CI smoke（如果要做跨平台）。

#### P2-8 未使用的 `@deepseek-ai/dsh-client-ui-theme` 注入

- **现状**：`package.json.dsh.client.inject` 声明了 theme，但 `client.js` 不 import 也不使用它（只用 CSS 变量/自身样式）。
- **为什么值得做**：多余依赖会拉长首次加载图；若某个 profile 禁用 theme，可能导致组合排序额外约束。
- **建议做法**：删除该注入；若确实想用主题 CSS 变量，再显式依赖。

#### P2-9 若干“已文档化但未复验”的 UI 细节

- **现状**：自动保存的像素级计时（900 ms）、CJK/空格路径双击反查、`previewSurface: 'document'` 的刷新/stale 提示、“一会话一个 PDF 预览 tab”的项目切换、键盘可达性——历史文档标为“部分/未验证”，本次无法在未安装状态下复验。
- **为什么值得做**：这些是用户最能感知的交互；尤其 CJK 路径双击反查在历史记录里只是“代码已修、像素级未复验”。
- **建议做法**：按 §5 G9/G10/G11 做一次人工验收并截图；若发现问题，优先把 SyncTeX 反查改成完全结构化（Host 已返回 `synctex` JSON，client 已使用），再补 UI 自动化（Playwright/Electron）。

#### P2-10 默认执行项目 `.latexmkrc` 的信任模型需产品确认

- **现状**：`allowProjectLatexmkrc` 默认 true（为了尊重项目构建配置）。构建不可信仓库时，项目 `.latexmkrc` 是可执行 Perl，等价于运行不可信代码；README/SECURITY 已明确写出。
- **为什么值得做**：如果插件进 marketplace，用户会从 GitHub clone 任意仓库并点编译；“已文档化”不等于“用户会读”。
- **建议做法**：保持默认尊重 rc 的同时，在 UI 首次构建不可信项目时给一次性警告；或提供“安全模式”一键 `allowProjectLatexmkrc:false` + `allowedRoots`；在 marketplace 页面显著提示“TeX 构建不是沙箱”。

---

## 8. 未验证项与风险（NOT VERIFIED）

| 项 | 原因 | 后续验证方式 |
| --- | --- | --- |
| 在真实 DSH 进程内安装/挂载插件 | 禁止修改 profile；当前 profile 未安装 | 获得授权后按 §5 G1–G16 |
| GUI：tab 打开、自动保存、PDF 刷新、失败/冲突横幅、SyncTeX 双击、语言切换 | 同上 | 人工验收 + 截图/录屏 |
| 取消构建（含 semaphore 等待窗口） | 需要运行中的插件 + 长构建/并发调用 | 用 slow fixture + `latex_cancel` 自动化 |
| 超时/5 s 下限 | 同上 | slow fixture + `timeoutMs` 参数 |
| pdflatex / lualatex 端到端 | 本次只复跑 xelatex | 用 `examples/hello` 复制后改 engine |
| BibTeX/Biber 诊断 | examples 不含 `.bib` | 新建带 `refs.bib` 的 fixture |
| 空格/CJK 路径完整链路 | 本次未单独构造（只有普通路径 + 中文文档内容） | 复制 hello 到 `带 空格 测试` 目录，跑 compile/clean/SyncTeX |
| `previewSurface: 'document'` 的刷新/stale | 由 DSH 内建预览控制 | 安装后人工验收 |
| PDF.js 像素级渲染/缩放 | 需要浏览器 | 人工或 Playwright |
| 多用户/远程 Web 下 SSE 暴露面 | 未构造多会话 | 代码审查 + 多浏览器测试 |
| `.latexmkrc` 安全边界 | 文档化，非沙箱 | 产品/安全评审 |

---

## 9. 证据与复现

### 9.1 本次执行的关键命令

```powershell
# 仓库基线
cd D:\github_inbox\dsh-latex
npm test
npm run check
npm pack --dry-run

# DSH 自带 Node 重跑测试
$env:ELECTRON_RUN_AS_NODE=1
& "D:\deepseekharness\DeepSeek Harness.exe" --test

# DSH 版本 / Electron / Node
& "D:\deepseekharness\resources\runtime\cli\bin\dsh.cmd" --version
& "D:\deepseekharness\DeepSeek Harness.exe" ...  # ELECTRON_RUN_AS_NODE=1, process.versions

# 当前 GUI 是否加载插件
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:59280/latex/health
# → 404
```

### 9.2 临时构建（已清理）

```text
D:\dsh-tmp\latex-accept\
  hello\  chinese\  multi-file\        ← examples 副本
  plugin-e2e.mjs                        ← 插件 Build/Resolver/Clean E2E
  host-e2e.mjs                          ← 7 工具 + 构建 + 状态 + 诊断 + clean
  http-smoke.mjs                        ← /latex/health|state|pdf|file
  restore-smoke.mjs                     ← 新进程恢复 last-build
  dvi-rc-test2.mjs                      ← P0-1 复现
  client-smoke.mjs                      ← client.js 注册面
```

这些脚本只用于本次验收，执行后已删除；它们不修改仓库，全部使用 `D:\dsh-tmp` 下的副本。报告中的命令与输出已足够定位复现路径；如果要把它们变成长期回归，应放入 `test/` 并在 CI 中运行（这正是 P1-3 的建议）。

### 9.3 未纳入的证据

- `app.asar` 内部源码没有逐行引用行号（它是归档，行号对读者不稳定）；报告用“包名 + 符号名”定位（如 `dsh-tools/lib/types/schema.js` 的 `defineTool`）。
- 历史 acceptance 的截图/evidence 目录不在本仓库（`docs/evidence/` 也不存在），本报告没有把它们当作本次 PASS 证据。

---

## 10. 建议的下一步（按顺序）

1. **修 P0-1**：收紧 `freshEvidence`/`upToDate`，加 rc-DVI 回归测试；这是发布前必须做的。
2. **授权安装到临时 profile**，按 §5 完成 GUI 验收（G1–G16），把结果补进本报告或新开一份验收记录。
3. **补核心测试**（P1-3），至少覆盖 build/logparse/project/service + rc-DVI 回归；CI 加 Windows latexmk smoke。
4. **修 P1-2**（失败时的 `pdf:` 行），更新 `docs/limitations.md`（P1-4）。
5. **打包与元数据**：补 screenshots、声明 `engines.dsh`、删除无用 theme 注入（P2-1/2/8）。
6. **兼容性加固**：`connection.admit(req)`、`path.delimiter`、vendored `defineTool` 契约测试（P2-4/5/7）。
7. **产品决策**：Config schema/Settings 表单（P1-5）、`.latexmkrc` 默认安全模式（P2-10）、SSE 按会话过滤（P2-3）。

---

## 附录 A：关键输出摘要

### A.1 `npm pack --dry-run` 文件清单（24 个）

```text
LICENSE  README.md  assets/icon-180.png  assets/licenses/PDFJS-NOTICE.txt
assets/pdf.min.mjs  assets/pdf.worker.min.mjs  client.js  cordis.patch.yml
icon.svg  index.js  locale/en.json  locale/zh.json  package.json
screenshots.json  src/build.js  src/config.js  src/file-io.js  src/logparse.js
src/project.js  src/routes.js  src/service.js  src/tool.js  src/tools.js  src/util.js
```

（没有 `assets/screenshots/`、`scripts/check.mjs`、`test/`、`docs/`、`examples/`。）

### A.2 接口对照的“存在性”证据

- 客户端三包：`app.asar/dsh/node_modules/@deepseek-ai/{dsh-client-ui-sidebar-right,dsh-client-locale,dsh-client-ui-theme}/package.json`，版本均为 `0.2.1-rc.5`。
- 三包的 Loader 行：`@deepseek-ai/dsh-web-app/cordis.patch.yml` 中 `ui-sidebar-right`、`locale`、`ui-theme` 行均存在且未 disabled。
- `dsh.client` 解析器：`@deepseek-ai/dsh-client-modules/lib/index.js` 的 `parseDshClient` 接受 `platform`/`inject`/`external`/`immediately`；`inject` 必须是 string[]。
- `dsh.bundle.patch` 解析：`@deepseek-ai/dsh-app-boot/lib/index.js` 的 `bundlePatchFiles` 接受 string 或 string[]。
- `sidebarRightTabs.register`：`@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js` 的 `SidebarRightTabRegistry.register` 支持 `patterns/priority/canOpen/title/guide/keepMounted`，band 为 `extension|builtin|fallback`。
- `connection.admit`：`@deepseek-ai/dsh-client-connection/lib/index.js` 的 `admit(request)` 先 `isTrusted(request)`（只读 headers）再 `browserAuth.isAuthenticated(request)`（只读 headers）。
- `subprocess.spawn`：`@deepseek-ai/dsh-subprocess` 的请求形状与 `handle.done` / `collected.*.readFrom(0).text`（`dsh-subprocess-local/lib/output.js`）。
- `systemPrompt.section`：`@deepseek-ai/dsh-system-prompt/lib/index.js` 要求有限 `order` 并返回 effect disposer。

### A.3 测试结果汇总

| 测试 | 退出码 | 结论 |
| --- | --- | --- |
| `npm test`（Node 24.14.0） | 0 | 7/7 pass |
| `npm test`（DSH Node 24.21.0） | 0 | 7/7 pass |
| `npm run check` | 0 | 12 files OK |
| `npm pack --dry-run` | 0 | 24 files |
| examples `hello` | 0 | 1 page，22068 B |
| examples `chinese` | 0 | 1 page，中文字体嵌入 |
| examples `multi-file` | 0 | 1 page，`\input`/`\ref` 正确 |
| plugin-e2e | 0 | success/failure/recovery/clean all as expected |
| host-e2e | 0 | 7 tools + prefix route + prompt + build/status/diagnostics/clean |
| http-smoke | 0 | 200/200/200/200/200/409/400 |
| restore-smoke | 0 | `success (restored)` + preview version |
| dvi-rc-test2 | 0 | 复现 P0-1（脚本本身成功执行） |
| client-smoke | 0 | 2 tabs / 7 tool cards / locale / inject |

---

## 附录 B：本报告没有改动仓库其他文件

- 首轮验收时本报告是唯一新增文件；2026-11-18 修复轮按用户批准另修改了 `src/build.js`、`src/tools.js`、`test/build.test.mjs`、`test/tools.test.mjs`、`CHANGELOG.md`，并追加了 §11。
- 执行前后 `git status --porcelain` 均为干净（写入报告前实测；写入后只应出现该新文件）。
- 没有 commit、没有 push、没有建分支、没有安装/卸载/修改 DSH profile 或插件。
- `D:\dsh-tmp\latex-accept` 下的临时脚本与构建产物在报告完成后清理。

---

## 11. 修复记录（2026-11-18）

> 本节追加于 P0-1 / P1-2 修复之后；第 0–10 节保留首轮验收的原貌，§7 中 P0-1 与 P1-2 的“现状”以本节为准（已修复）。首轮验收时本报告曾是唯一新增文件；本轮修复按用户批准又修改了源码、测试与 CHANGELOG（见 11.1）。

### 11.1 改动文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `src/build.js` | 源码 | 成功判定改为“PDF 必须是新产物，或 latexmk 明确声明为 up-to-date 的 PDF 目标”；`#findOutputPdf` 优先采用 latexmk 自己指名的 PDF；失败结果不再暴露 `pdfPath` |
| `src/tools.js` | 源码 | `formatResult` 仅在 `status === 'success'` 时打印 `pdf:`；导出该函数供单测 |
| `test/build.test.mjs` | 新增测试 | 6 个 fake-subprocess 回归用例（DVI 旧 PDF、真 up-to-date、fresh PDF、jobname PDF、stale log、force） |
| `test/tools.test.mjs` | 新增测试 | 4 个 `formatResult` 用例（success 打印 pdf；failure/timeout/cancelled 不打印） |
| `CHANGELOG.md` | 文档 | `[Unreleased] / Fixed` 一行说明 |
| 本报告 | 文档 | 追加本节 |

### 11.2 P0-1 修复要点

**根因**：旧逻辑把 latexmk 的正常结束行 `Latexmk: All targets (...) are up-to-date` 直接当作 PDF 证据（`/all targets .*are up-to-date/i`），不检查目标列表里有没有 `.pdf`；`#findOutputPdf` 又会优先返回 `build/main.pdf`。项目 `.latexmkrc` 选择 DVI（`$pdf_mode = 0`）且旧 PDF 残留时，`pdfFound + upToDate` 同时成立 → `success` → 把旧 PDF 原子复制成新 preview。

**修复**（`src/build.js`）：

1. 新增 `parseUpToDateTargets()`，只解析 `Latexmk: All targets (...) are up-to-date` 行的目标列表；DVI 构建的 `(build/main.dvi)` 不含 PDF。
2. 新增 `upToDatePdfPaths()` / `logOutputPdfPath()`，把摘要中声明的 `.pdf`、以及 `Output written on ...pdf` 解析为**构建目录内**的绝对路径候选；摘要若以相对路径点名预期 `<stem>.pdf`，也接受（兼容文件名含空格、目标列表按空格分隔的情况）。
3. `#findOutputPdf(paths, preferred)` 先采用 latexmk 指名的 PDF（`preferred`），再退回直接路径与“唯一最新 PDF”。这样 jobname 改变时不会误选残留的 `main.pdf`。
4. 成功证据收紧为：`pdfTargetUpToDate`（pdfFound 与摘要中被点名的 PDF 同一文件）**或** `pdfFresh`（PDF mtime ≥ 构建开始 − 2 s）。删除了宽泛的 `upToDate` 与 `nothing to do` 两个匹配。
5. 进度：失败/超时/取消时 `result.pdfPath` 为 `undefined`，不会再被任何消费者当成“本次输出”；`upToDate` 字段现在是“PDF 目标被 latexmk 明确声明 up-to-date”。
6. `force` 仍走 `-gg`；`allowProjectLatexmkrc: false` 仍走 `-norc` + 引擎 flag，两条路径都有测试/真实构建覆盖。

**明确不改变的行为**：

- 正常 PDF 构建（latexmk 摘要含 `build/main.pdf`）→ success；
- 真正 up-to-date 的 PDF 重建（`Nothing to do` + 摘要含 `.pdf`，PDF mtime 很旧）→ 仍 success，preview 内容保持不变；
- 因 jobname 产生非 `<stem>.pdf` 的构建 → 只要摘要/日志点名且文件在构建目录内，仍 success；
- `exit 0` 但无 PDF / 只有 DVI / 有错误 → failure，不发布 preview。

### 11.3 P1-2 修复要点

与 P0-1 同根（旧 PDF 被当成 PDF 证据），改动很小：

- `src/tools.js` 的 `formatResult`：`pdf:` 行改为仅 `result.status === 'success' && result.pdfPath` 时打印；failure/timeout/cancelled 即使带着 `pdfPath` 也不打印。
- 配合 11.2 的第 5 点，失败构建的 `pdfPath` 本身已是 `undefined`，形成双保险。
- 新增 `test/tools.test.mjs` 覆盖四种 status。

### 11.4 修复前后结果

命令均在仓库根目录执行；新增测试使用 `DSH_LATEX_TEST_TMP=D:/dsh-tmp/latex-fix-tests`，测试代码按用例清理自己的临时目录。

| 检查 | 修复前 | 修复后 |
| --- | --- | --- |
| `npm test` | 7 tests / 7 pass / 0 fail / 127.4 ms | **17 tests / 17 pass / 0 fail / 492.7 ms** |
| `npm run check` | 12 files OK | 12 files OK |
| `npm pack --dry-run` | 24 files / 497.1 kB / shasum `fa54cc71…` | 24 files / 498.7 kB / shasum `e4296251…` |
| DSH 内置 Node 24.21.0 `--test` | 7 pass | **17 pass** |

测试失败情况：新用例在第一次运行时暴露了两处测试自身问题（断言用了 `previewVersion` 而 build 结果字段是 `version`；`tools.test.mjs` 写入时被 heredoc 截断），修正测试代码后全绿；没有削弱任何断言。源码修复本身没有失败记录。

### 11.5 真实 TeX 复现（临时目录，未进仓库）

用本机 TeX Live 2025 + 真实 `latexmk`，在 `D:\dsh-tmp\latex-fix-tests\real` 下通过仓库 `LatexBuilder` 验证（`ctx.subprocess` 仍用本地 `child_process` 代用，构建完全真实）：

```text
pdf  -> status=success upToDate=true  pdfPath=main.pdf preview=true  bytes=22068 duration=2267ms
pdf  -> status=success upToDate=true  pdfPath=main.pdf preview=true  bytes=22068 duration=493ms
dvi  -> status=failure upToDate=false pdfPath=none     preview=false bytes=0     duration=1418ms
        error=latexmk exited 0 but did not produce or declare a fresh PDF.
              The project .latexmkrc may select DVI mode (for example $pdf_mode = 0); ...
dvi(allowProjectLatexmkrc=false, force) -> status=success upToDate=true pdfPath=main.pdf preview=true bytes=22068
norc(rc 保留、非强制) -> status=failure upToDate=false pdfPath=none preview=false
```

结论：

- 第一次 `pdf` 是真实全量构建，第二次是真实“latexmk 判定 up-to-date”的重建；两次都 success，未回归。
- `dvi` 场景复现了原缺陷条件（`.latexmkrc` `$pdf_mode = 0` + 预置旧 `main.pdf`）：修复后 **failure，preview 不发布**。
- 同一目录再用 `allowProjectLatexmkrc: false` + `force: true` 构建：`-norc` + `-xelatex` 生效，success，说明 opt-out 与 force 路径未被破坏。
- 最后一个 “rc 保留、非强制” 用例仍然 failure（DVI 模式没有 PDF），符合预期。

### 11.6 仍存在的风险

1. **silent rc 的 up-to-date 误判风险（低）**：如果项目 `.latexmkrc` 设置 `$silent = 1`，latexmk 不打印 `All targets ...` 摘要。此时真正的 up-to-date PDF 重建没有“PDF 目标被点名”的证据，且 PDF mtime 很旧，会被判 failure（**宁可误报失败，不误报成功**）。需要更精确地解析 `.fdb_latexmk`/rc 才能消除；本次未做。
2. **文件名含空格且 latexmk 目标列表不加引号**：摘要按空格分词会拆开路径；本次通过“摘要文本包含预期相对路径”兜底常规 `<stem>.pdf`，但若 jobname 也含空格，仍可能判 failure。当前插件默认名与常见用法不受影响。
3. **真实 DSH 运行态仍未复验**：本次只跑仓库代码 + 代用 subprocess；没有安装到 DSH profile，`/latex/health` 仍 404。GUI 项仍列在 §5 的“需人工验收”。
4. **其他 P1/P2 未动**：测试覆盖仍集中在 config/file-io/routes/build/tools；logparse/project/service/synctex 没有新增测试；SSE、打包截图、engines.dsh 等保持原状。
5. **`pdfFresh` 允许 2 s 时钟容差**：极端网络文件系统/时钟回拨可能误判 fresh；正常本地 NTFS 不受影响。

### 11.7 修复轮验证命令

```powershell
cd D:\github_inbox\dsh-latex
npm test
npm run check
npm pack --dry-run
$env:ELECTRON_RUN_AS_NODE=1
& "D:\deepseekharness\DeepSeek Harness.exe" --test
node D:\dsh-tmp\latex-fix-tests\real-tex-check.mjs
```

临时目录 `D:\dsh-tmp\latex-fix-tests` 在报告完成后清理；源码/测试改动未 commit、未 push、未建分支。

