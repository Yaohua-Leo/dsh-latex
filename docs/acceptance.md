# dsh-latex 真实 E2E 验收矩阵（A–F）

> 任务：swarm run「dsh-latex delivery hardening」中的 `acceptance`。
> 执行者：acceptance builder（本文件作者）。
> 执行时间：2026-11-03 16:24–16:33（Asia/Shanghai），全部为真实工具调用与真实构建产物。
> 约束遵守：未修改插件源码、未改 `D:\deepseekharness\latex-plugin-tests` 下的原始 fixture、未改 profile、未重启 DSH、未下载依赖。所有破坏性实验都在 `latex-plugin-tests/e2e/acceptance/` 的副本里做。
> 证据目录：`latex-plugin-tests/e2e/acceptance/_evidence/`（每次构建后的文件快照、哈希、源码修订哈希）；每个项目自己的 `build/`、`build/main.log`、`build/.dsh-latex/last-build.json`、`build/.dsh-latex/preview.pdf` 都保留。

## 0. 结论摘要

| 编号 | 验收项 | 结论 | 一句话证据 |
| --- | --- | --- | --- |
| A | 单文件数学文档 | **PASS** | exit 0，3946 ms，1 页，`preview.pdf` 33 676 B，版本 1793694328930 |
| B | ctex 中文 + 数学 | **PASS**（像素级另见 NOT VERIFIED） | exit 0，4867 ms；`pdftotext` 取回中文，`pdffonts` 显示 SimSun/SimHei 已嵌入 |
| C1 | 多文件 `\input` + BibTeX + 交叉引用，**从章节文件触发** | **PASS** | 从 `sections/ch1.tex` 触发，反查到 `main.tex`；exit 0，8408 ms；生成 `main.bbl`/`main.toc` |
| C2 | `\include` 子目录章 | **PASS** | 从 `sections/part.tex` 触发，exit 0，3705 ms，3 页 |
| D1 | 故意语法错误 → 文件名+行号 → 修复成功 | **PASS** | 失败 `main.tex:4: Undefined control sequence.` exit 12；修复后 auto 2586 ms、manual 1030 ms 成功 |
| D2 | 非法字符错误定位 | **PASS** | `main.tex:42: Text line contains an invalid character.` exit 12 |
| E | 预览版本刷新 / stale 横幅状态机（工具级） | **PASS**（UI 像素级另见 NOT VERIFIED） | v1→v2→失败(STALE)→v3，版本、`preview.pdf` 的 sha256 与 mtime 全部按预期变化 |
| F1 | 带空格 + 中文路径 | **PASS** | `F-space-带 空格 项目` exit 0，4451 ms；`last-build.json` 记录真实空格路径 |
| F2 | 取消正在运行的构建 | **PASS** | auto 构建中 `latex_cancel` 返回 running:true；进程树 latexmk/perl/xelatex 全部消失 |
| F3 | 超时 + `timeoutMs` 下限 clamp | **PASS** | 请求 6000 ms → 6022 ms TIMEOUT；请求 1000 ms → 实际 5000 ms TIMEOUT |
| F4 | 重复构建（增量） | **PASS** | 3.40 s → 923 ms，两次都 exit 0，各发布新版本 |
| F5 | 失败保留旧 PDF（手动路径） | **PASS** | 失败前后 `preview.pdf` 与 `main.pdf` 的 sha256 均为 `8929f1cc…`，版本不变、STALE 置位 |
| F6 | `latex_clean` 只删 aux、保留 PDF | **PASS** | 删除 6 个 aux，`main.pdf`/`preview.pdf` 哈希不变；再编译成功 |
| F7 | pdflatex / lualatex | **PASS** | pdflatex 2330 ms、lualatex 3141 ms，均 exit 0 |
| F8 | 安装持久性 / 重启后检查方式 | **部分** | profile 依赖+`node_modules` link+健康检查可查；真实重启 **NOT VERIFIED**（禁止重启），restore 代理测试暴露运行修订差异（§1.4） |
| F9 | 无构建时调用 `latex_cancel` | **PASS** | 返回 “No LaTeX build is running…”，不报错 |

- **功能项 FAIL：0 个**。
- **NOT VERIFIED (agent-side)：** UI 像素级刷新、中文屏幕渲染、双击 PDF 反查、SyncTeX 的 UI 交互；真实重启 DSH 之后的工具注册。Lead 已做过的像素级检查在本报告中只作为背景，不当作我的验收证据。
- **最重要的一条系统性问题：** 运行中的 Host 加载的 `src/service.js` 与磁盘当前文件不是同一修订版（§1.4）。本次矩阵的所有 PASS 都只对「Host 启动时加载的修订」成立；Lead 在 16:23:09 之后对 `src/service.js` 的改动需要重启/HMR 重建后复验。

---

## 1. 环境、工作区与运行修订

### 1.1 Host 与工具链

`GET /latex/health`（本机 loopback，health 是唯一不过 `connection.admit` 的路由，见 `src/routes.js:254-262`）实测：

```json
{"ok":true,"name":"dsh-latex","version":"0.1.0","pid":34656,
 "startedAt":1793694010266,"projects":28,
 "toolchain":{"binDir":"D:\\latex\\texlive2023\\texlive\\2023\\bin\\windows",
 "latexmk":"D:\\latex\\texlive2023\\texlive\\2023\\bin\\windows\\latexmk.exe",
 "tools":{"latexmk":{"exists":true},"xelatex":{"exists":true},
 "pdflatex":{"exists":true},"lualatex":{"exists":true},
 "biber":{"exists":true},"bibtex":{"exists":true},"synctex":{"exists":true}},
 "missing":[],"ok":true,"checkedAt":"2026-11-03T08:24:23.379Z"}}
```

- `startedAt = 1793694010266` → **16:20:10**（本地时间），`pid = 34656`。
- 同一时刻 `GET /latex/state` 返回 **401 `{"error":"request refused"}`**，`GET /` 返回 401 “dsh web authentication required”：说明除 `/latex/health` 外的路由确实过了 Host 的 authentication 栅栏（与安全审查任务相关，这里只作为旁证）。

### 1.2 测试工作区（全部是副本）

原始 fixture 未动。副本清单：

```
latex-plugin-tests/e2e/acceptance/
├─ A-single-math/                  ← ../../single-math/main.tex
├─ B-chinese-ctex/                 ← ../../chinese-ctex/main.tex
├─ C-multi-file/                   ← ../../multi-file/{main.tex,refs.bib,sections/*}
├─ C2-include-subdir/              ← ../../include-subdir/{main.tex,sections/part.tex}
├─ D-error-case/                   ← ../../error-case/main.tex（测试中修好）
├─ D2-badchar/                     ← 本任务构造：第 42 行放 0x01 控制字节
├─ E-refresh/                      ← ../../single-math/main.tex（测试中插/删标记）
├─ F-space-带 空格 项目/            ← ../../带 空格 项目/main.tex
├─ F-cancel-timeout/               ← ../../timeout/slow.tex，循环 2000 万→8000 万（约 20 s）
├─ F-repeat-single-math/           ← ../../single-math/main.tex
├─ F-stale-keep/                   ← ../../single-math/main.tex
├─ F-restore-single-math/          ← 复制 main.tex **连同 build/.dsh-latex/**（用于恢复测试）
├─ F-engines-pdflatex/plain.tex    ← ../../engines/plain.tex
├─ F-engines-lualatex/plain.tex    ← ../../engines/plain.tex
└─ _evidence/                      ← 快照脚本与每次构建后的文件/哈希记录
```

### 1.3 如何记录证据

- 每个项目构建后用 `_evidence/snapshot.sh <label> <dir>` 记录：文件尺寸、mtime、`*.pdf`/`last-build.json`/`*.log` 的 sha256。原始输出保存在 `_evidence/*.txt`。
- 每次构建都另用 `latex_get_status` / `latex_get_diagnostics` 交叉验证，而不是只看 `latex_compile` 的文本。
- 中文与 PDF 内容用 TeX Live 自带的 `pdftotext.exe` / `pdffonts.exe` 验证（读的是真实生成的 PDF）。
- 进程树用 `Get-CimInstance Win32_Process` 按进程名检查（latexmk/xelatex/perl/pdflatex/lualatex/synctex）。
- 预览版本号语义：**每次成功发布 = `Date.now()` 的 epoch 毫秒**（`src/build.js:317-360`），不是 1,2,3 递增。

### 1.4 ⚠ 运行修订 vs 磁盘修订（影响所有结论）

本报告编写时（16:30–16:31）采集的源码哈希：`_evidence/source-revisions.txt`。

| 文件 | mtime | sha256（前 16 位） |
| --- | --- | --- |
| `src/service.js` | **2026-11-03 16:23:09** | `35f4025550c80903…` |
| `src/tools.js` | 16:20:03（Host 启动前 7 s） | `943fee3102e4aa4f…` |
| `src/routes.js` | 16:15:28 | `7a7436c0525f7aa9…` |
| `src/build.js` | 16:12:17 | `9344257fc302836e…` |
| `src/logparse.js` | 16:11:34 | `60c79d14dfefbd07…` |
| `src/project.js` | 16:00:14 | `19ac573361937ba2…` |
| `index.js` | 15:56:03 | `ce518c362e67b274…` |
| `client.js` | 16:19:59 | `5793905ee5ffc90f…` |
| `cordis.patch.yml` | 15:50:58 | `8ae16db51acbcec2…` |

**证据链：**

1. Host 启动于 16:20:10；`src/service.js` 在 **16:23:09** 被改动（很可能是 Lead 的修复）。
2. `/latex/health` 的 `startedAt` 仍是 16:20:10，`projects` 计数从 3 持续增加到 28 —— 说明 **HMR 没有重建这个 Host 服务实例**（若重建，`startedAt` 会更新、项目注册表会清空）。
3. 行为差异：把一份**已构建**的项目（含 `build/.dsh-latex/last-build.json`）复制成新目录 `F-restore-single-math` 后第一次 `latex_get_status`：

```text
project: D:\deepseekharness\latex-plugin-tests\e2e\acceptance\F-restore-single-math
status: idle | auto-build: true | watching: true
preview: version 1793693460674 | pages 1 | current
pdf: ...\F-restore-single-math\build\main.pdf | preview file: ...\build\.dsh-latex\preview.pdf
```

`preview version` 被恢复了，但 **status 仍是 `idle`，也没有 `last build:` 行**；`latex_get_status all:true` 对该项目显示 `never built | preview v1793693460674`。

而磁盘上的 `src/service.js:214-253`（`#restorePublishedState`）明确会在恢复 version 的同时设置：

```js
project.status = 'success';                    // :233
project.lastBuild = { status: 'success', reason: 'restored', ... };  // :234-248
```

**结论：** 运行中的 Host 执行的是 16:20:10 加载的旧 `service.js`，磁盘上 16:23:09 的版本并未生效。因此：

- 本报告所有 PASS = 「运行修订（`service.js` 16:20:10 版）」的验收结论；
- 如果 Lead 的修复改了 `service.js`，**必须重启 DSH 或触发真正的 Host 模块重载后复验**；任务约束禁止我重启，故本报告不做重启验证；
- 反过来说，`F8` 的 restore 代理测试在当前 Host 上只能证明「预览版本号会从 `last-build.json` 恢复」，不能证明磁盘源码注释里写的 `status=success / last build (restored)` 行为。

> 注：并行 agent 也在本 Host 里构建（`all:true` 可见 `e2e/synctex/*` 项目），各项目 build 目录独立，未观察到互相干扰；`maxConcurrentBuilds=2` 是全局信号量。

---

## 2. A：单文件数学文档

**调用：**

```text
latex_compile(path="latex-plugin-tests/e2e/acceptance/A-single-math/main.tex", open=false)
```

**原始返回：**

```text
LaTeX build: SUCCESS
project: D:\deepseekharness\latex-plugin-tests\e2e\acceptance\A-single-math
main: D:\deepseekharness\latex-plugin-tests\e2e\acceptance\A-single-math\main.tex
engine: xelatex | duration: 3.95 s | exit: 0
pdf: ...\A-single-math\build\main.pdf (1 pages)
preview: ...\A-single-math\build\.dsh-latex\preview.pdf | version: 1793694328930
log: ...\A-single-math\build\main.log
diagnostics: 0 error(s), 0 warning(s)
```

**交叉验证：**

```text
latex_get_status: status: success | watching: true
last build: success (manual) at 16:25:28 in 3946 ms | exit 0 | errors 0, warnings 0
preview: version 1793694328930 | pages 1 | current
latex_get_diagnostics: errors 0 | warnings 0；"The last build succeeded"
latex_preview(page=1): "LaTeX preview: open … version: 1793694328930 | pages: 1 / page: 1"
```

**文件证据**（`_evidence/A-after.txt`）：

- `build/main.pdf` 33 676 B，mtime 16:25:28.856，sha256 `b3a1cbae1287e1d4…`
- `build/.dsh-latex/preview.pdf` 33 676 B，sha256 `b3a1cbae1287e1d4…`（与 `main.pdf` 逐字节相同 → 发布的是原子副本）
- `build/.dsh-latex/last-build.json` 349 B，sha256 `40e05402f8ea05ed…`
- `build/main.log` 5 527 B；`build/main.synctex.gz`、`main.xdv` 存在

**结论：PASS。** 单文件数学、页面数、预览发布均正常。

---

## 3. B：ctex 中文 + 数学

**调用：**

```text
latex_compile(path="latex-plugin-tests/e2e/acceptance/B-chinese-ctex/main.tex", open=false)
```

**原始返回：**

```text
LaTeX build: SUCCESS
engine: xelatex | duration: 4.87 s | exit: 0
pdf: ...\B-chinese-ctex\build\main.pdf (1 pages)
preview: ...\preview.pdf | version: 1793694338201
diagnostics: 0 error(s), 0 warning(s)
```

**交叉验证：**

```text
latex_get_status: success | last build: success (manual) at 16:25:38 in 4867 ms | exit 0
preview: version 1793694338201 | pages 1 | current
```

**内容证据（真实 PDF）：**

`pdftotext -enc UTF-8 build/main.pdf`：

```text
中文排版测试
TeX 环境审计
2026 年 11 月 3 日
1
中文段落
这是一个包含中文与数学公式的测试文档。行内公式 E = mc2 ，行间
公式如下：
∞
∑ 1 = xn , |x| < 1.
1 − x n=0
```

`pdffonts build/main.pdf`：

```text
name                                 type            encoding    emb sub uni
RGVHHF+SimSun                        CID TrueType    Identity-H  yes yes yes
APNWTC+LMRoman12-Bold-Identity-H     CID Type 0C     Identity-H  yes yes yes
FWPSDI+SimHei                        CID TrueType    Identity-H  yes yes yes
FXRBQM+CMMI10                        Type 1C         Builtin     yes yes yes
```

**文件证据**（`_evidence/B-after.txt`）：`main.pdf` 30 600 B，sha256 `74af0aac65771474…`；`preview.pdf` 与 `main.pdf` 同哈希；`last-build.json` 351 B。

**结论：PASS（内容/字体/文本层）。** 中文在 PDF 中真实存在且字体嵌入。
**NOT VERIFIED (agent-side)：** 屏幕像素级中文渲染（Lead 已用截图确认，但这不是我的证据）。

---

## 4. C：多文件项目

### C1 从章节文件触发：`\input` + BibTeX + 交叉引用

**调用（注意传的是章节文件，不是 main）：**

```text
latex_compile(path="latex-plugin-tests/e2e/acceptance/C-multi-file/sections/ch1.tex", open=false)
```

**原始返回：**

```text
LaTeX build: SUCCESS
project: ...\C-multi-file
main: ...\C-multi-file\main.tex
engine: xelatex | duration: 8.41 s | exit: 0
pdf: ...\C-multi-file\build\main.pdf (1 pages)
preview: ...\preview.pdf | version: 1793694351002
diagnostics: 0 error(s), 0 warning(s)
```

- 项目根被正确解析为 `C-multi-file`，`main` 被解析为 `main.tex`（反向 `\input` 依赖图，`src/project.js:513-528`）。
- 8.41 s 与「xelatex + bibtex 多轮」一致。

**交叉验证：**

```text
latex_get_status(path=...\sections\ch1.tex):
  status: success | last build: success (manual) at 16:25:51 in 8408 ms | exit 0
  preview: version 1793694351002 | pages 1 | current
latex_get_diagnostics(path=...\sections\ch1.tex):
  "LaTeX diagnostics for ...\C-multi-file\main.tex"  ← 诊断归属 main.tex
  errors: 0 | warnings: 0
```

**产物证据**（`_evidence/C-after.txt`）：

- `build/main.bbl` 317 B（2 条 `\bibitem`：knuth1984、lamport1994）
- `build/main.toc` 121 B，`build/main.aux` 464 B，`build/main.blg` 859 B
- `build/main.pdf` 30 492 B，sha256 `131210285738c885…`；`preview.pdf` 同哈希
- `pdftotext` 取到 `Classic references: [1] for typesetting and [2] for document preparation.` 与 `By Equation (1)` → `\cite`/`\eqref` 都解析成功

**结论：PASS。**

### C2 从 `\include` 子目录章触发

```text
latex_compile(path="latex-plugin-tests/e2e/acceptance/C2-include-subdir/sections/part.tex", open=false)
→ SUCCESS, project=C2-include-subdir, main=main.tex, 3.71 s, exit 0, 3 pages
→ version 1793694360197
```

```text
latex_get_status(path=...\sections\part.tex):
  last build: success (manual) at 16:26:00 in 3705 ms | exit 0
  preview: version 1793694360197 | pages 3 | current
```

`pdftotext` 取到 `Contents / 1 Included section` 与 `This file is pulled in with \include; TeX Live's -outdir must have the mirrored …`。`\include` 在 `-outdir=build` 下需要镜像的 `build/sections/` 目录，实际构建成功，说明构建端处理正确。

**结论：PASS。**

---

## 5. D：错误定位与修复

### D1 未定义命令（第 4 行）

**失败调用：**

```text
latex_compile(path="latex-plugin-tests/e2e/acceptance/D-error-case/main.tex", open=false)
```

```text
LaTeX build: FAILURE
engine: xelatex | duration: 1.73 s | exit: 12
log: ...\D-error-case\build\main.log
diagnostics: 1 error(s), 0 warning(s)
errors:
- main.tex:4: Undefined control sequence.
```

- `build/main.log` 实测包含：`./main.tex:4: Undefined control sequence.`（日志第 56 行）
- 交叉验证 `latex_get_diagnostics`：`last error: Undefined control sequence. (line 4)`；`latex_get_status`：`last build: failure (manual) … exit 12 | errors 1`，`preview: version - | none`
- 快照（`_evidence/D-fail.txt`）：**没有 `preview.pdf`、没有 `last-build.json`**，`.dsh-latex/` 为空目录 → 失败不发布预览。

**修复：** 把第 4 行 `\undefinedcommand` 改为 `Fixed line: $a^2+b^2=c^2$.`（保持行号），保存后：

1. 800 ms 去抖 + 自动构建（watcher）在 16:26:18 成功：`last build: success (auto) at 16:26:18 in 2586 ms`，`version 1793694378214`；
2. 随后手动 `latex_compile` 再次成功：`SUCCESS … duration: 1.03 s … version: 1793694384310`。

**结论：PASS。** 错误定位到文件+行号，修复后自动/手动构建都成功，且诊断文本与 `main.log` 一致。

### D2 非法字符（第 42 行）

用 bash 生成 43 行文档，第 42 行含一个 `0x01` 控制字节（`D2-badchar/main.tex`）：

```text
latex_compile(path="latex-plugin-tests/e2e/acceptance/D2-badchar/main.tex", open=false)
→ LaTeX build: FAILURE
  engine: xelatex | duration: 1.80 s | exit: 12
  diagnostics: 1 error(s), 0 warning(s)
  errors:
  - main.tex:42: Text line contains an invalid character.

latex_get_diagnostics → last error: Text line contains an invalid character. (line 42)
```

**结论：PASS。** 与 Lead 记录的 “invalid character → line 42” 一致（本报告为独立复现）。

---

## 6. E：预览版本刷新与 stale 状态机（自动构建）

流程：`latex_compile(open=true)` → `latex_preview(page=1)` → 改源码 → 等自动构建 → 破坏 → 修复。全部版本/哈希来自真实文件（`_evidence/E-v1.txt`、`E-v2.txt`、`E-v2-failed.txt`、`E-v3.txt`）。

| 步骤 | 构建原因 | 结果 | duration | preview version | preview.pdf sha256 | preview.pdf mtime | stale |
| --- | --- | --- | --- | --- | --- | --- | --- |
| v1 初始 | manual | SUCCESS | 3770 ms | 1793694392335 | `61b1afcc570f6d1b…` | 16:26:32 | false |
| v2 插入标记段 | **auto**（保存触发） | SUCCESS | 3245 ms | 1793694406425 | `7e1c0b583770a574…` | 16:26:46 | false |
| v2+ 插入 `\undefinedEtest` | **auto** | FAILURE（exit 12，`main.tex:46`） | 2180 ms | **1793694406425（未变）** | **`7e1c0b583770a574…`（未变）** | 16:26:46（未变） | **true** |
| v3 删除错误行 | **auto** | SUCCESS | 2612 ms | 1793694431044 | `3983651f66a96372…` | 16:27:10 | **false** |

关键交叉验证：

- v2 后 `pdftotext build/main.pdf` 出现 `E2E auto-refresh marker line: δ = 2 and the version should change.` → 不只是时间戳变了，PDF 内容真的更新。
- 失败时 `latex_get_status`：`preview: version 1793694406425 | pages 1 | STALE (last build failed)`；`last error: Undefined control sequence. (line 46)`。
- 修复后 `latex_get_status`：`status: success … preview: version 1793694431044 | pages 1 | current`（STALE 消失）。
- `latex_compile` 的 `preview:` 行给出与 `last-build.json` 一致的 version；`build/main.pdf` 与 `preview.pdf` 每次成功构建后同哈希（原子发布）。

**结论：PASS（工具级：版本刷新、内容刷新、失败保留旧 PDF、stale 置位/清除）。**
**NOT VERIFIED (agent-side)：** 浏览器里 PDF.js 画面是否自动重绘、stale 横幅是否像素级消失。我在 `latex_preview` 里请求了 page 1，但无法看到 UI 像素；Lead 的截图验证不作为我的证据。

---

## 7. F：健壮性矩阵

### F1 空格 + 中文路径

```text
latex_compile(path="latex-plugin-tests/e2e/acceptance/F-space-带 空格 项目/main.tex", open=false)
→ SUCCESS | xelatex | duration: 4.45 s | exit: 0 | 1 page
→ preview version 1793694441806
```

- `build/.dsh-latex/last-build.json` 的 `mainFile` 是真实带空格路径：
  `D:\deepseekharness\latex-plugin-tests\e2e\acceptance\F-space-带 空格 项目\main.tex`
- `build/main.fls` 的 `PWD` 行：`PWD D:/deepseekharness/latex-plugin-tests/e2e/acceptance/F-space-带 空格 项目`
- `pdftotext` 能取回中文（与 B 相同的正文）
- `_evidence/F-space.txt`：`main.pdf` 30 602 B，sha256 `abdd358e80f9cdc2…`

**结论：PASS。** argv 数组 + 绝对 cwd 的调用方式对空格/中文路径成立。

### F2 取消正在运行的构建

由于 `latex_compile` 是阻塞式工具调用，同一 agent 无法在它返回前再发 `latex_cancel`；这里用**自动构建**制造长构建（同一 `service.cancel` 路径，同一进程树），再用 `latex_cancel` 工具取消——即任务里允许的“先后调用”。

1. 先 `latex_get_status` 注册项目（`watching: true`，`status: idle`）。
2. 向 `slow.tex` 追加注释触发 watcher；3 s 后进程表实测：

```text
ProcessId ParentProcessId Name
    13744           10524 latexmk.exe
    26556           13744 perl.exe
    33276           26556 xelatex.exe
```

3. `latex_cancel(path="...F-cancel-timeout/slow.tex")` →

```text
LaTeX build cancelled for ...\F-cancel-timeout\slow.tex (running: true, queued: 0).
```

4. 3 s 后同一进程检查：**latexmk/perl/xelatex 一个都不剩**。
5. `latex_get_status`：`status: cancelled | last build: cancelled (auto) at 16:27:57 in 5156 ms | exit 1`。
6. `_evidence/F-cancel.txt`：`build/slow.synctex(busy)` 0 B、`build/slow.aux` 0 B、`build/slow.log` 0 B（杀进程中间态残留，与 fixtures README 描述一致；没有发布 `preview.pdf`）。

**结论：PASS。** 取消返回 cancelled，进程树（Job object）确实被终止，无孤儿进程。
**NOT VERIFIED (agent-side)：** queued（排队中）任务的取消——需要两个并发调用者才能构造；`service.cancel` 代码里确实会 resolve 队列（`src/service.js:633-649`），但本 agent 无法在不并发的情况下制造该状态。

### F3 超时与 `timeoutMs` 下限

```text
latex_compile(path="...F-cancel-timeout/slow.tex", timeoutMs=6000, open=false)
→ LaTeX build: TIMEOUT | duration: 6.02 s | exit: 1
  diagnostics: 0 error(s), 0 warning(s)
  "Next: the build exceeded its 6000 ms timeout; raise timeoutMs or fix the loop."
→ 随后进程检查：无 latexmk/xelatex/perl
```

下限 clamp（已知限制，实测确认）：

```text
latex_compile(path="...F-cancel-timeout/slow.tex", timeoutMs=1000, open=false)
→ LaTeX build: TIMEOUT | duration: 5.03 s | exit: 1
  "Next: the build exceeded its 5000 ms timeout; …"
```

→ 请求 1000 ms 实际按 **5000 ms** 执行（`src/build.js:213` 的 `Math.max(5_000, …)`）。

**结论：PASS。** 超时会终止整棵进程树；`timeoutMs` 有 5 s 下限。

### F4 重复构建（增量）

```text
#1 latex_compile(F-repeat-single-math) → SUCCESS, 3.40 s, exit 0, version 1793694509707
#2 同一项目再次编译         → SUCCESS, 923 ms, exit 0, version 1793694512018
```

第二次明显是 latexmk 的增量/up-to-date 路径，但仍然发布新的 preview 版本（`Date.now()` 语义）。两次 `main.pdf` 内容哈希相同（PDF 输入未变）。

**结论：PASS。** 重复构建不会失败、不会堆积；版本号会变，不能用版本号判断内容是否变化。

### F5 失败保留旧 PDF（手动路径）

```text
# 先构建成功（v1）：SUCCESS 3.53 s，version 1793694527936
#   main.pdf = preview.pdf = 33 675 B，sha256 8929f1cc8f7e4976…
# 插入 \undefinedManual（第 44 行）后手动编译：
→ FAilURE: exit 12, 778 ms, errors: main.tex:44: Undefined control sequence.
```

- 快照（`_evidence/F-stale-failed.txt`）：`main.pdf` 与 `preview.pdf` 仍是 33 675 B / `8929f1cc…`，`last-build.json` 未变；`latex_get_status`：`preview: version 1793694527936 | pages 1 | STALE (last build failed)`。
- 修复后自动构建成功：`version 1793694558863`，`preview.pdf` 33 845 B / `0dde670d859ee656…`；随后手动构建 1.00 s 成功，`version 1793694564969`；`pdftotext` 出现 `Manual recovery line.`。

**结论：PASS。** 失败绝不覆盖旧 PDF，恢复构建发布新版本并清除 STALE。

> 观察：失败时 `latex_compile` 的文本仍打印 `pdf: …\build\main.pdf (1 pages)`（旧 PDF 被 `#findOutputPdf` 找到），没有 STALE 提示（见 §9.1）。

### F6 `latex_clean` 只删 aux、保留 PDF

```text
latex_clean(path="...F-repeat-single-math/main.tex")
→ LaTeX clean: 6 auxiliary file(s) removed
  - main.aux, main.fdb_latexmk, main.fls, main.log, main.synctex.gz, main.xdv
  1 unrecognised file(s) kept (not deleted)        ← main.pdf
```

- clean 前：`main.pdf` sha256 `ef229b006336f614…`；clean 后：**同一哈希**，`build/.dsh-latex/preview.pdf`（同一哈希）与 `last-build.json` 均未被删除。
- clean 后再编译：`SUCCESS 3.86 s，version 1793694524327`（从零重编，无 aux 残留问题）。

**结论：PASS。** 源码树与 PDF/preview 未被误删（`src/build.js:500-552`）。

### F7 pdflatex / lualatex

```text
latex_compile(path="...F-engines-pdflatex/plain.tex", engine="pdflatex", open=false)
→ SUCCESS | pdflatex | 2.33 s | exit 0 | 1 page | version 1793694625320
→ 后续 latex_get_status: engine: pdflatex（覆盖在本项目上持久）

latex_compile(path="...F-engines-lualatex/plain.tex", engine="lualatex", open=false)
→ SUCCESS | lualatex | 3.14 s | exit 0 | 1 page | version 1793694629990
```

**结论：PASS。** 三个引擎都可用；引擎覆盖会写回该项目的 `project.engine`，后续构建沿用。

### F8 安装 / 重启持久性证据

**安装证据（只读检查）：**

```text
C:\Users\86132\.dsh\profiles\desktop\package.json:14  "dsh-latex": "link:D:/deepseekharness/latex-plugin"
C:\Users\86132\.dsh\profiles\desktop\package.json:43        "dsh-latex"      ← dsh.profile.bundles 列表
C:\Users\86132\.dsh\profiles\desktop\node_modules\dsh-latex -> /d/deepseekharness/latex-plugin
```

**运行证据：** `/latex/health` 返回 `{ok:true, name:dsh-latex, version:0.1.0, pid:34656, startedAt:…}`；7 个 `latex_*` 工具在本会话全部可调用（A–F 的实际调用即证据）。

**「重启后仍然可用」的检查方式（未执行重启，NOT VERIFIED）：**

1. profile 的 `package.json` 依赖 + `dsh.profile.bundles` 含 `dsh-latex`（上面两行）→ 启动时 app-boot 会加载该 bundle；
2. `node_modules/dsh-latex` 指向 `D:\deepseekharness\latex-plugin`（link 安装，重启后仍解析到同一目录）；
3. 重启后调用 `/latex/health`：`startedAt` 应更新为新进程时间、`ok:true`；
4. 重启后 `latex_get_status(project)`：最后一个成功项目的 `preview version` 应从 `build/.dsh-latex/last-build.json` 恢复（`src/service.js:214-253`）。

**restore 代理实验（不重启 Host 的条件下能拿到的最强证据）：** 复制「已构建 + `.dsh-latex/last-build.json`」的项目到新目录，第一次 `latex_get_status` 得到 `preview: version 1793693460674 | pages 1`，证明**预览版本/页数会从磁盘 meta 恢复**；但 `status`/`last build` 未恢复，且与当前磁盘源码不符 —— 见 §1.4，这同时暴露了运行修订落后于磁盘源码的问题。

**结论：** 安装证据 PASS；真实重启后的工具注册 **NOT VERIFIED（任务约束禁止重启）**；restore 只证明 version/pages 恢复，磁盘源码声称的 status/last-build 恢复在当前 Host 未生效。

### F9 无构建时取消（幂等）

```text
latex_cancel(path="...A-single-math/main.tex")
→ No LaTeX build is running for ...\A-single-math\main.tex.
```

**结论：PASS。** 不抛错、不误伤其他项目。

---

## 8. 版本与文件证据总表

| 项目 | 构建 | 版本（epoch ms） | duration | exit | preview.pdf sha256（前 16 位） |
| --- | --- | --- | --- | --- | --- |
| A-single-math | manual | 1793694328930 | 3946 ms | 0 | `b3a1cbae1287e1d4` |
| B-chinese-ctex | manual | 1793694338201 | 4867 ms | 0 | `74af0aac65771474` |
| C-multi-file（从 ch1.tex） | manual | 1793694351002 | 8408 ms | 0 | `131210285738c885` |
| C2-include-subdir（从 part.tex） | manual | 1793694360197 | 3705 ms | 0 | —（未单独快照） |
| D-error-case | manual（失败） | — | 1732 ms | 12 | 无（未发布） |
| D-error-case | auto（修复后） | 1793694378214 | 2586 ms | 0 | — |
| D-error-case | manual（复验） | 1793694384310 | 1030 ms | 0 | — |
| D2-badchar | manual（失败） | — | 1800 ms | 12 | 无 |
| E-refresh | manual v1 | 1793694392335 | 3770 ms | 0 | `61b1afcc570f6d1b` |
| E-refresh | auto v2 | 1793694406425 | 3245 ms | 0 | `7e1c0b583770a574` |
| E-refresh | auto（失败） | 1793694406425（不变） | 2180 ms | 12 | `7e1c0b583770a574`（不变） |
| E-refresh | auto v3 | 1793694431044 | 2612 ms | 0 | `3983651f66a96372` |
| F-space-带 空格 项目 | manual | 1793694441806 | 4451 ms | 0 | `abdd358e80f9cdc2` |
| F-cancel-timeout | auto（取消） | — | 5156 ms | 1 | 无 |
| F-cancel-timeout | manual（6000 ms 超时） | — | 6022 ms | 1 | 无 |
| F-cancel-timeout | manual（1000→5000 ms 超时） | — | 5030 ms | 1 | 无 |
| F-repeat-single-math | manual #1 | 1793694509707 | 3400 ms | 0 | — |
| F-repeat-single-math | manual #2 | 1793694512018 | 923 ms | 0 | — |
| F-repeat-single-math | manual（clean 后） | 1793694524327 | 3860 ms | 0 | — |
| F-stale-keep | manual v1 | 1793694527936 | 3530 ms | 0 | `8929f1cc8f7e4976` |
| F-stale-keep | manual（失败） | 1793694527936（不变） | 778 ms | 12 | `8929f1cc8f7e4976`（不变） |
| F-stale-keep | auto 恢复 | 1793694558863 | 2554 ms | 0 | `0dde670d859ee656` |
| F-stale-keep | manual 复验 | 1793694564969 | 1000 ms | 0 | — |
| F-engines-pdflatex | manual | 1793694625320 | 2330 ms | 0 | — |
| F-engines-lualatex | manual | 1793694629990 | 3141 ms | 0 | — |
| F-restore-single-math | 无构建（restore） | 1793693460674（来自 meta） | — | — | `de5294fb1994ec21` |

---

## 9. FAIL / NOT VERIFIED / 观察项

### 9.1 FAIL

**无。** A–F 的功能性断言全部由真实构建满足。

### 9.2 NOT VERIFIED (agent-side)

| 项 | 原因 | 现有替代证据 |
| --- | --- | --- |
| PDF.js 预览画面是否像素级重绘 / stale 横幅是否消失 | agent 看不到屏幕像素 | 版本号 + `preview.pdf` sha256 + mtime + `stale` 字段（§6） |
| 中文在屏幕上的实际渲染 | 同上 | PDF 文本层与字体嵌入（§3） |
| 双击 PDF 反查源码、SyncTeX 双击坐标 → 源码行 | 需要真实鼠标/浏览器 | 由 synctex 任务与 Lead 的 UI 验证覆盖；本报告不冒充 |
| 真实重启 DSH 后工具仍在、`last-build` 恢复后的 status 行为 | 任务禁止重启 | profile 记录 + 检查方法（§F8），restore 代理（§1.4） |
| 排队中（queued）构建的取消 | 单 agent 无法并发制造 | `src/service.js:633-649` 代码路径；运行中取消已实测（§F2） |
| 自动编译开关经 UI 切换 | UI 操作，且当前运行修订无对应工具 | Lead 已验；本报告不重复 |

### 9.3 观察（交给 Lead/审查 agent，不是 FAIL）

1. **失败构建的 `latex_compile` 文本会把旧 PDF 当作本次 pdf 打印。** F5 失败输出含 `pdf: …\build\main.pdf (1 pages)`，但那是上一次成功的 PDF；文本没有 stale 标记（`latex_get_status` 有 `STALE`）。证据：§F5 原始输出、`src/tools.js:43-44`。可能误导模型以为新 PDF 已生成。建议在失败/超时/取消时给 `pdf:` 行加 `(stale: previous build)` 或干脆不打印。
2. **没有 PDF 时 `latex_get_status` 也打印 `pdf:` 路径。** D1 失败后 `build/main.pdf` 不存在，status 仍输出 `pdf: …\build\main.pdf`（只是配置路径，不是存在性）。证据：`_evidence/D-fail.txt` 与 D1 的 status 输出。
3. **运行修订落后于磁盘源码。** §1.4：`src/service.js` 在 Host 启动后被改（16:23:09），HMR 未重建服务实例（`startedAt`/`projects` 计数可证），restore 行为与磁盘 `src/service.js:214-253` 不一致。若 Lead 的修复在该文件里，交付前必须重启复验；否则 16:20:10 之前的代码仍在跑。
4. **取消/超时会留下中间态文件。** `build/slow.synctex(busy)`、0 字节 `slow.aux`/`slow.log`。不影响下次构建，但 `latex_clean` 的 `AUX_EXTENSIONS` 是否覆盖 `synctex(busy)` 值得确认（本次未 clean 该目录）。
5. **每次成功都发布新 preview 版本（即使 latexmk 判定 up-to-date）。** 版本号是 `Date.now()`，不是内容哈希；自动化里不能用版本变化判断内容变化。证据：F4 第二次 923 ms 仍换版本。
6. **超时/取消的 `exitCode` 记录为 1**（进程被终止），而不是专用状态码；状态本身是 `timeout`/`cancelled`，解析时不要依赖 exit code。

---

## 10. 已知限制（如实记录）

- **构建历史/诊断只在 Host 进程内存中**：重启后最多从 `build/.dsh-latex/last-build.json` 恢复 `preview version/pages`，不恢复历史记录；且当前运行修订连 `status/last build` 都没恢复（§1.4）。
- **没有常驻服务**：`latexmk` 每次构建都重新拉起；无守护进程/增量编译服务。
- **PDF.js viewer 按需渲染**：只渲染可见页；极小概率短暂空白（来自运行说明，本报告未复现）。
- **`timeoutMs` 下限 5000 ms**：请求 1000 实测按 5000 执行（§F3）。
- **无 Settings 表单**：`link:` 安装形态无法 `import @deepseek-ai/schemastery`，插件不导出 `Config` schema；配置只能改 `cordis.patch.yml`/profile patch。
- **`.latexmkrc` 存在时默认不强推 engine flag**：本次 fixtures 均无 `.latexmkrc`，未触发。
- **CJK inverse SyncTeX 依赖 `synctex` CLI 行为**：由 synctex 专项任务覆盖，本报告不结论。
- **内建文档预览（surface=document）的页码位置由 DSH 控制**：本报告没有测试该 surface 的 UI 行为。
- **预览刷新走 SSE**：工具侧只能验证发布与状态；画面重绘无法在 agent 侧验证。

---

## 11. 复现步骤（可直接照抄）

```bash
# 0) 准备副本（不要改原始 fixture）
cd D:/deepseekharness/latex-plugin-tests/e2e/acceptance
cp ../../single-math/main.tex A-single-math/main.tex
cp ../../chinese-ctex/main.tex B-chinese-ctex/main.tex
cp -r ../../multi-file/. C-multi-file/            # 或按 §1.2 逐文件复制
cp -r ../../include-subdir/. C2-include-subdir/
# D2：构造第 42 行为 0x01 的文档（见 §5）
# F-cancel-timeout：把 slow.tex 的 20000000 改成 80000000
# F-restore：连 build/ 一起复制已构建项目

# 1) 工具调用（模型侧）
latex_compile(path="latex-plugin-tests/e2e/acceptance/A-single-math/main.tex", open=false)
latex_get_status(...)       # 交叉验证
latex_get_diagnostics(...)  # 交叉验证
latex_preview(..., page=1)  # 仅 A/E
# 其余见 §2–§7 的逐项参数

# 2) 文件证据
cd D:/deepseekharness/latex-plugin-tests/e2e/acceptance
bash _evidence/snapshot.sh <label> <项目目录>
sha256sum <项目>/build/.dsh-latex/preview.pdf
# 3) 进程检查（Windows）
powershell -NoProfile -Command "Get-CimInstance Win32_Process | Where-Object { \$_.Name -in @('latexmk.exe','xelatex.exe','perl.exe','pdflatex.exe','lualatex.exe','synctex.exe') } | Select-Object ProcessId,ParentProcessId,Name"
```

---

## 12. 证据文件索引

| 文件 | 内容 |
| --- | --- |
| `_evidence/snapshot.sh` | 快照脚本（文件列表 + 尺寸 + mtime + 关键文件 sha256） |
| `_evidence/source-revisions.txt` | 16:30 时 `index.js/client.js/src/*.js/cordis.patch.yml` 的 sha256 |
| `_evidence/A-after.txt` | A 构建产物与哈希 |
| `_evidence/B-after.txt` | B 构建产物与哈希 |
| `_evidence/C-after.txt` | C 产物（bbl/toc）与哈希 |
| `_evidence/D-fail.txt` | D1 失败态（无 preview/meta） |
| `_evidence/D2-badchar.txt` | D2 失败态（line 42） |
| `_evidence/E-v1.txt` / `E-v2.txt` / `E-v2-failed.txt` / `E-v3.txt` | E 四个阶段的版本/哈希/mtime |
| `_evidence/F-space.txt` | 空格路径构建证据 |
| `_evidence/F-cancel.txt` | 取消后的残留中间态（并配合进程检查） |
| `_evidence/F-repeat-before-clean.txt` / `F-repeat-after-clean.txt` | clean 前后对照（PDF 哈希不变） |
| `_evidence/F-stale-v1.txt` / `F-stale-failed.txt` / `F-stale-recovered.txt` | 旧 PDF 保留与恢复 |
| `_evidence/F-restore.txt` | restore 代理的 meta/preview 哈希 |

每个项目目录下的 `build/main.log`（或 `slow.log`/`plain.log`）、`build/.dsh-latex/last-build.json`、`build/.dsh-latex/preview.pdf` 是最终证据；原始 fixture（`../../single-math` 等）未被修改。

---

## 附录 L（Lead 补验，2026-11-03 23:42–23:52）：真实重启、UI 像素级与 review 后回归

> 本附录由 Lead 手工执行，独立于上文 agent 侧矩阵。它把上文标为 **NOT VERIFIED (agent-side)** 的项补上可复核证据，并把代码审查后的修复纳入验收。截图证据在 `本地截图（未随公开仓库发布）`。

### L1 真实 DSH 重启 → F8 由「部分/未验证」改为 **PASS**

- **重启事实**：桌面应用进程于 **2026-11-03 23:42:13** 重新启动；旧 Web 端口 50802 消失，新 GUI 为 `http://127.0.0.1:61692`。
- **插件自动加载**：`GET /latex/health` 返回 `pid=18268`、`startedAt=23:42:27`、`toolchain.ok=true`、7 个工具全部存在；本轮随后真实调用了 `latex_get_status`、`latex_compile`、`latex_synctex`、`latex_preview`。
- **profile 持久性**：desktop profile 的 `package.json` 仍有 `"dsh-latex": "link:D:/deepseekharness/latex-plugin"` 与 `bundles` 条目；`node_modules/dsh-latex` 链接仍在，无需重新安装。
- **发布态恢复**：重启后首次 `latex_get_status` 返回 `status: success`、`last build: success (restored) at 16:46:38`、`preview version 1793695598137`（来自 `build/.dsh-latex/last-build-d077868cd8.json`）。
- **重启后重新编译**：`single-math` exit 0、4.85 s、新版本 `1793720810675`；`chinese-ctex` 769 ms、新版本 `1793720900807`。
- **重启后自动构建**：仅修改 `single-math/main.tex`（未调用任何工具），watcher 自动构建 `success (auto)` 于 23:48:08、7.0 s、新版本 `1793720888525`。
- **重启后 UI**：窗口恢复后右侧栏仍显示 `PDF 预览 / LaTeX 工作台 / main.tex` 三个 tab，PDF.js 正常渲染，聊天头部 `LaTeX` 入口存在（`本地截图（未随公开仓库发布）`）。
- **重启后 SyncTeX**：双击 PDF 后右侧栏打开 `main.tex` 文档预览并定位到对应行（`本地截图（未随公开仓库发布）`）。

### L2 UI 像素级补验（对应验收 A/B/D/E）

| 项 | 结果 | 证据 |
| --- | --- | --- |
| A 单文件数学：成功编译 + 应用内 PDF 预览 | PASS | 右侧栏 «PDF 预览» 渲染定理/公式；`本地截图（未随公开仓库发布）` |
| B 中文数学：ctex + XeLaTeX 中文渲染 | PASS | 中文标题、段落、公式正常；`本地截图（未随公开仓库发布）` |
| D 失败诊断 → stale 横幅 → 修复后恢复 | PASS | 失败时页面顶部显示「最新一次编译失败，预览保留上一次成功编译的结果。」；修复后自动构建、横幅消失、内容更新为新增小节 |
| E 保持预览打开，修改源码 → 自动构建 → PDF 刷新 | PASS | 同一 tab 内内容从 v1 刷新为含 “Auto-refresh check” 的新版本，页码 1、缩放「适合宽度」保持 |
| 缩放 100% 后仍渲染（review-client F1） | PASS | 缩放切到 100%，页面未空白，双击仍可取到 canvas；`本地截图（未随公开仓库发布）` |
| 双击 PDF 反查源码行（ASCII） | PASS | 右侧栏打开 `main.tex` 并定位到实际行；`本地截图（未随公开仓库发布）` |
| 工作台 UI（状态/诊断/日志/自动编译开关） | PASS | 工作台显示成功状态、文件/引擎/构建目录/预览版本、错误与警告计数、日志折叠；自动编译开关可关闭/恢复（状态接口 auto-build false/true 复核） |
| 内建文档预览（surface=document） | PASS | 点击预览器「文档预览」按钮打开 `preview.pdf` 文件 tab，DSH 自带 PDF 预览渲染正常 |
| CJK 源路径 double-click 反查 | **部分（代码已修，像素级未复验）** | 结构化同步已返回 CJK 路径与行号（工具级 `latex_synctex inverse` 对 `chinese-ctex` 返回 `main.tex:8`）；双击的像素级复验被前台窗口遮挡，未作为 PASS 记录 |
| 工作台「源码行 → PDF」正向定位行 | **代码已实现，未做像素级点击** | 工具级 forward PASS；UI 行存在但未逐像素验证 |

### L3 review 后修复的回归验证（2026-11-03 深夜）

| 回归项 | 结果 | 证据 |
| --- | --- | --- |
| H1 队列合并丢 manual job（review-host） | PASS | 构造 `[运行中 force build, 期间触发 auto, 再 enqueue manual]`：manual 未悬挂，返回 SUCCESS（1.09 s，在其前一次 41.5 s 强制构建之后），随后 auto 也完成（1.14 s） |
| M1 semaphore 等待期取消 | 代码修复并在源码复核；未构造满并发时序 | `abortController` 在 `acquire` 前创建、semaphore 支持 abort、`acquire` 后再次检查 aborted |
| M11 clean 与构建竞态 | PASS | 慢构建进行中调用 `latex_clean` → 返回 `Error: A LaTeX build is running or queued for this project; cancel it or wait before cleaning.`，未删除任何文件 |
| M3/M4 `.latexmkrc` 回退 DVI + 旧 PDF 被当成功 | PASS | `.latexmkrc` 写 `$pdf_mode = 0` 并预置旧 PDF：`-gg` 强制构建后 exit 0 但无新 PDF → 工具返回 FAILURE，提示「latexmk exited 0 but no PDF was produced. The project .latexmkrc may select DVI mode…」，不再发布旧 PDF |
| M6 同目录多主文件冲突 | 修复 | project id 改为 rootDir+mainFile；发布文件改为 `build/.dsh-latex/preview-<fingerprint>.pdf`，不再互相覆盖 |
| SEC-06 `% !TEX root` 绕过 allowedRoots | 修复 | magic 分支 now `assertAllowed(mainFile)` 且检查 rootDir；UNC/网络路径在 `stat` 前拒绝 |
| SEC-02 shell-escape | 修复 | 默认 argv 增加 `-no-shell-escape`；需要时显式 `allowShellEscape: true` 或 `extraLatexmkArgs` |
| SEC-08 SyncTeX file 越界 | 修复 | forward 的 `file` 必须位于项目根内；inverse 结果若指向项目外会标记 STALE 并提示重建 |
| SyncTeX 行号/空格路径/CJK 编码（synctex F-1/F-2/F-3） | 修复 | Host 改为结构化 `syncTeXResult` + 原始字节 UTF-8/GBK 解码；客户端不再用正则拆字符串；ASCII 双击已在重启后复验 |
| 客户端 F1/F3/F4/F5/F6/F7/F9/F10/F11/F12/F13 | 修复/缓解 | 缩放重建 canvas、首次编译用 `data.snapshot` 开预览、页码可回退、`params.page` 优先、面板读 tab 参数、activeProjectId 保留、PDF.js 失败不缓存、hook 无条件调用、恢复页与 ref 清理、渲染代次校验 |
| 客户端 F8/F14–F20 / host 低危项 | 部分缓解或文档化 | 预览 tab 仍为「一会话一 tab」（用 lastPreviewProjectId 缓解恢复选错项目）；SSE 背压、watcher 重试、健康探针信息等按低风险保留，见 `docs/review-fixes.md` |

### L4 复原与说明

- 验收期间临时插入 `single-math/main.tex` 的 “Auto-refresh check” 小节已移除，fixture 恢复到 TeX 环境审计时的内容；最后一次自动构建发生在复原之前，因此其 `preview.pdf` 仍是含该小节的历史产物（不影响源码 fixture 与任何 PASS 结论）。
- UI 截图是在真实桌面窗口上通过恢复/最小化窗口取得的；CJK 双击与正向按钮未做像素级复验的项在本附录中保持「未验证」，不写成 PASS。
- 本节所有数值来自真实工具返回与文件系统证据；对应源码版本已是 review 后修复版（见 `docs/review-fixes.md`）。

---

## 附录 M（v0.2.0，2026-11-04 03:1x–03:30）：`.tex` 直接进入编辑器 + 保存即编译 + PDF 实时刷新

> 依据用户新要求：.tex 默认直接打开为编辑器（不再先显示只读预览）。本轮用真实桌面 UI 与真实 TeX Live 验证，截图在 `本地截图（未随公开仓库发布）tex-editor-*.png`。

### M1 实现要点（与 0.1 的差异）

- 客户端把 `latex-tex-editor` 注册为 **extension 优先级、canOpen 只接受 `.tex`** 的资源 tab 类型；地址解析沿用 DSH 的 `session/<id>/<path>` / `absolute/<path>` 语法。`.bib`、`.md`、图片等仍由内建文档预览处理。
- 移除「LaTeX 工作台」tab / guide 卡 / 聊天头部 `LaTeX` 按钮 / 工具卡「工作台」按钮；保留「PDF 预览」与 7 个工具。
- Host 新增 `GET /latex/file`、`POST /latex/file`（仅 `.tex`、UTF-8、4 MiB、allowedRoots/UNC/realpath、原子写、保留 EOL/BOM、revision CAS）与 `/latex/action {action:"compile-file"}`（解析真实主文档并构建，reason=`editor`）。
- 客户端保存流程：写盘 → compile-file → 构建结果展示；成功后若 PDF 预览已打开则 SSE 刷新，未打开则首次保存自动打开预览 tab。编辑器保留在 tab（`keepMounted`），可切回。

### M2 真实 UI 验证

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 从右侧栏文件树点击 `latex-plugin-tests/include-subdir/main.tex` | **PASS**：直接出现 TeX 编辑器（行号 + 源码 + 顶部三角按钮），不是内建只读文本预览 | `本地截图（未随公开仓库发布）` |
| 打开 `single-math/main.tex` | **PASS**：编辑器显示 42 行源码，状态「已保存」，顶部三角/刷新/眼睛按钮，底部提示 Ctrl+S；tab 标题为文件名 | `本地截图（未随公开仓库发布）` |
| 在 `\maketitle` 后插入可见文本并点三角保存 | **PASS**：源文件落盘包含 `Editor live preview check.`；构建 reason=`editor`，exit 0；PDF 预览 tab 自动打开并渲染出该行 | `本地截图（未随公开仓库发布）` |
| 保存后 PDF 实时刷新 | **PASS**：PDF 页面顶部出现新增文本（同上截图） |
| 外部恢复源码后的自动刷新 | **PASS**：移除测试行后 watcher 自动构建 `success (auto)` 03:27:49、2.1 s，已打开的 PDF 页面同步消失该行（人工截图复核） |
| 工作台移除 | **PASS**：Slots 的 `sidebar.right.pane.tab` occupants 仅有 `dsh-latex/editor` 与 `dsh-latex/preview`；`conversation.session.header.actions` 无 `latex` occupant；UI 无工作台 tab/guide 卡 | Slots inspect + screenshots |
| 章节文件 | 代码路径一致（保存后由 Host 解析真实主文档），本轮像素级使用 `include-subdir/main.tex`，章节文件未单独点击 | 部分 |
| 非 `.tex` 回落内建预览 | 代码 `canOpen` 仅接受 `.tex`；未做像素级点击 | 部分 |
| 失败 UI | **PASS**：在 include-subdir 中插入 `\undefinedcommand` 保存 → 顶部红色「编译失败 · 1 error(s) — main.tex:6 Undefined control sequence」，编辑器保留、旧 PDF 不被覆盖 | `本地截图（未随公开仓库发布）` |
| 冲突 UI | **PASS**：编辑器载入后外部修改源文件再保存 → 顶部黄色「磁盘文件已被外部修改」+「重新加载 / 强制保存」 | 执行过程截图（未入库） |

### M3 路由级测试（mock Connection，真实文件系统）

独立脚本直接调用 `registerLatexRoutes` 的 handler（`connection.admit` 返回 mock peer，文件 IO 使用真实 `src/file-io.js`）：

| 请求 | 结果 |
| --- | --- |
| `GET /latex/file?path=...route.tex` | 200，返回 content + sha256 revision |
| `POST /latex/file`（正确 revision） | 200，磁盘内容更新，revision 改变 |
| `POST /latex/file`（旧 revision） | **409** `the file changed on disk since it was loaded` |
| `GET /latex/file` 非 `.tex` | 400 `only .tex files can be edited` |
| `POST /latex/action {compile-file}` | 200，`result.status=success`、projectId（mock compilePath） |
| 缺失文件 | 404 `file not found` |

### M4 已知限制（v0.2.0）

- 编辑器是纯 `<textarea>` + 行号，无语法高亮、自动补全、多光标；不引入外部编辑器依赖。
- **显式保存**（Ctrl+S / 三角按钮）才编译；没有自动保存。中文输入法组合期间 Ctrl+S 可能被吞（实测），按 Esc 结束组合或点按钮即可。
- 关闭编辑器 tab 会丢弃未保存内容（`keepMounted` 只保证切 tab 不丢）；重新打开会从磁盘读取。
- `.tex` 不再显示内建只读预览，也没有只读模式；查看原始文件可用编辑器本身。
- 只支持 UTF-8 `.tex`，最大 4 MiB，不能新建文件/目录；写文件 API 只服务编辑器。
- 失败 UI 与冲突 UI 已分别做像素级触发（见 M2）；CJK 文件名编辑、非 `.tex` 回落和重启后编辑器 tab 的恢复未做像素级复验。
