# 插件市场同类调研：哪些功能值得 dsh-latex 借鉴

- 调研日期：2026-11-23
- 数据源：[dshmarket](https://github.com/dsh-market/dsh-market) 使用的社区目录
  `https://awesome-dsh-plugin.com/plugins.json`（`updated: 2026-11-23`，12,763 条），
  以及各插件仓库的 README / package.json 二次核对。
- 口径：star 数、收录时间均为该目录快照；同类插件体量都很小，star 不代表质量。

---

## 0. 结论摘要

1. **同形态（本机 LaTeX 编辑 + 编译 + PDF 预览）的插件全市场只有 4 个**，且集中在
   2026-08 ~ 11 上线；"LaTeX" 这个词在目录里更多被公式渲染、引用核查、Overleaf 桥接
   分摊，而不是完整工作台。dsh-latex 的赛道很窄，但也没被占满。
2. **最值得抄的不是"再做一个编辑器"，而是三件把闭环补上的事**：
   - 让 agent **看见**编译后的页面（`latex-look` 的 render + SyncTeX + 像素 diff + audit）；
   - 把"编译成功"升级为"论文可交付"（`latex-guard` 的 cite/bib 审计、`dsh-cumcm` 的排版体检）；
   - 把 PDF 预览从"只读终点"变成"上下文入口"（`paperlab` 的批注→AI 改源→编译→git，
     `paper-reader` 的页码锚点，`office-kit` 的选区→修改请求）。
3. **两个基础短板必须补**：同类都在消除安装摩擦（便携 MiKTeX / 私有 TinyTeX / 一键安装），
   dsh-latex 是唯一要求用户预装 TeX Live 且没有安装入口的；同类编辑器普遍上了
   CodeMirror/折叠/大纲，dsh-latex 还是纯 `<textarea>`。
4. **市场卡片本身也值得学**：同类普遍有 npm 包、`engines.dsh`、能力说明、GIF 首图；
   dsh-latex 目录条目 `version: null`、无 npm、无 `engines.dsh`，且 `package.json#files`
   未包含 `assets/screenshots`（验收报告 P2-1 的缺口仍在），打包后的 README 图会 404。

---

## 1. 市场分层与代表性条目

目录里命中 LaTeX/TeX 关键词的条目共 **67 条**。按"与本插件的关系"分桶：

| 层级 | 代表条目（star 为快照） | 定位 | 与本插件的关系 |
| --- | --- | --- | --- |
| 同形态工作台 | [maple-pwn/paperlab](https://github.com/maple-pwn/paperlab) 11★ · [kasaki002/dsh-latex-studio](https://github.com/kasaki002/dsh-latex-studio) 4★ · [violector/dsh-latex-studio](https://github.com/violector/dsh-latex-studio) 1★ · 本仓库 [Yaohua-Leo/dsh-latex](https://github.com/Yaohua-Leo/dsh-latex) 0★ | 编辑 + 编译 + PDF 预览 | **直接同类**，功能对标的第一梯队 |
| 垂直工作流 | [Rosynb666/dsh-cumcm](https://github.com/Rosynb666/dsh-cumcm) 1★ | 数模论文 P0–P7 看板 + facts 台账 + 体检编译 | 同一技术栈，产品逻辑可借 |
| Agent 侧 LaTeX 工具 | [fangchenghao/latex-look](https://github.com/fangchenghao/latex-look) 0★ · [Flan246/dsh-latex-guard](https://github.com/Flan246/dsh-latex-guard) 0★ · [Accelerater-tech/dsh-latex](https://github.com/Accelerater-tech/dsh-latex) 1★ | 只做工具，不做完整工作台 | 与 dsh-latex 的 7 个工具直接互补 |
| Overleaf 桥接 | [fly233338/dsh-overleaf](https://github.com/fly233338/dsh-overleaf) 14★ · [gychen-NJU/dsh-overleaf](https://github.com/gychen-NJU/dsh-overleaf) 4★ · [measureer/dsh-overleaf-sync](https://github.com/measureer/dsh-overleaf-sync) 0★ | 把云端项目接进 DSH | 另一条路线，协议/凭据风险高 |
| 论文阅读 / 伴读 | [GGboya/dsh-paper-reader](https://github.com/GGboya/dsh-paper-reader) 62★ · [miaojinQWQ/dsh-docmate](https://github.com/miaojinQWQ/dsh-docmate) 1★ · [YuboCoco/dsh-english-lit-reader](https://github.com/YuboCoco/dsh-english-lit-reader) 0★ | PDF 阅读 + 选区提问 + 页码锚点 | 预览交互与锚点设计的直接参考 |
| PDF / 文档工具 | [zhtx2024/dsh-pdf](https://github.com/zhtx2024/dsh-pdf) 10★ · [hairyf/dsh-office-kit](https://github.com/hairyf/dsh-office-kit) 31★ · [AngelosZou/dsh-pdf-reader](https://github.com/AngelosZou/dsh-pdf-reader) 8★ | 页面渲染、选区标注、渲染校验 | 页面渲染与批注的技术参考 |
| 编辑器基建 | [ltmroberthk915/markpilot](https://github.com/ltmroberthk915/markpilot) 15★ · [Roland0511/dsh-marktext](https://github.com/Roland0511/dsh-marktext) 389★ · [Limbo-137/dsh-typst-preview](https://github.com/Limbo-137/dsh-typst-preview) 1★ · [tylina/dsh-tylina](https://github.com/tylina/dsh-tylina) 12★ | 所见即所得 / 并排编辑 / 侧栏预览 | 编辑器与预览形态的参考 |
| 引用 / 文献 | [ECNU/EduWork#dsh-literature](https://github.com/ECNU) 387★ · [Yu-tao-Li/dsh-reference-checker](https://github.com/Yu-tao-Li/dsh-reference-checker) 6★ · [STARDUSTLC666/dsh-cite](https://github.com/STARDUSTLC666/dsh-cite) 5★ · [ECHOUniverse/dsh-zoteroplugin](https://github.com/ECHOUniverse/dsh-zoteroplugin) 1★ | 文献检索、BibTeX 核验、Zotero | dsh-latex 完全没有的一层 |

### 1.1 三个结构性观察

1. **"LaTeX = 公式渲染"是市场主流，不是"LaTeX = 论文工程"。**
   67 条命中里，真正处理本机 LaTeX 工程的不到 10 条，其余是 KaTeX 渲染、公式编辑器、
   引用核查、PDF 翻译/阅读。这说明：普通用户对 LaTeX 的入口需求是"把公式显示好"，
   而 dsh-latex 服务的是"真的在写论文"的人——价值更高，但受众更窄，**必须把长板做深**。
2. **同类都在消灭安装摩擦。** kasaki 首次使用一键装 ~150 MB 便携 MiKTeX（清华 TUNA 镜像）；
   violector 下载官方 TinyTeX 并校验 SHA-256、缺宏包自动补装；Accelerater-tech 在输入框上方
   给 BasicTeX/TinyTeX 一键安装横幅。**dsh-latex 是唯一要求 TeX Live 已装好、且没有安装入口的**
   （README 只写了"Requires TeX Live"）。
3. **同类在把"预览"从终点变成上下文。** paperlab 在 PDF 上选字批注 → agent 改源 → 编译 → git；
   paper-reader 的回答必带页码、点页码跳回原文高亮；office-kit 在预览里吸附段落/框选 →
   批量发修改要求；docmate 把选区、页码、划线变成会话上下文。dsh-latex 的 PDF 预览目前
   只是"渲染 + 缩放 + 双击反查 SyncTeX"，**不产生任何可被 agent 使用的上下文**。

---

## 2. 值得借鉴的功能（按价值/成本排序）

### P0-1 让 agent 真正"看见"页面 —— 借鉴 `latex-look`

**出处**：[fangchenghao/latex-look](https://github.com/fangchenghao/latex-look)（npm
`@fffangchenghao/dsh-latex-look`，单工具 `latex_look`）。

它解决的是 dsh-latex 现有诊断覆盖不到的一类问题：**编译零错误，但排版是错的**
（标题带框线、表格是网格、链接出血、图太宽）。做法：

- 一个工具一次调用完成"编译 → 渲染指定页为 PNG → SyncTeX 定位附近源码 → 与上一次构建
  做像素 diff → 返回图 + 行号 + 变化框"；另有 `audit` 扫描整本"上次修改引入了哪些空洞"。
- **SyncTeX 页码纠偏**：浮动体被 TeX 移到下一页时 SyncTeX 记录的是构建页；它用 PDF 文本层
  （`gs -sDEVICE=txtwrite`）确认文字实际在第几页，并允许 ±2 页搜索。
- **构建缓存**：文档 + `\input` 图（三层）+ `\includegraphics` + aux 全部做内容哈希，
  未变化直接复用（208 页书 17 s → 0.2 s）；失败构建永不复用。
- **快照属于构建，不属于调用**：同一构建的多次 look 共享"修改前"快照，所以 agent 看第 2、3 页
  也能看到 diff。
- **并发正确性**：同文档并发编译会互相写坏 `.aux`；它用进程内 promise 队列 + 跨进程
  PID 锁文件串行化，锁覆盖"快照+编译+观察"整段。
- 工程上还有两个可抄的细节：运行版本与磁盘版本不一致时明确提示"重启才生效"；
  同一引擎另出 CLI 与 MCP server（`npx ... mcp`），不依赖 Harness 就能测试。

**落到 dsh-latex：**

1. 新增 `latex_look` 工具（`src/tools.js` + `src/service.js`）：参数
   `{ path, page=1, text?, point?, compare?, audit?, dpi? }`，返回图片 content block +
   `{ page, file, line, diff }`；复用现有 `latex_synctex` 的 inverse 实现。
2. 渲染引擎三选一，按可用性降级并如实报告：
   - Ghostscript（`gswin64c` / `gs`，Windows 查 `C:\Program Files\gs\gs*\bin` 与 TeX 安装目录）——
     与 latex-look 同路径，最快落地；
   - Poppler `pdftoppm`（若 PATH 有）；
   - 纯 Node：`pdfjs-dist` + `@napi-rs/canvas`（[zhtx2024/dsh-pdf](https://github.com/zhtx2024/dsh-pdf)
     已验证，含非内嵌 CJK 字体的系统字体回退），代价是新增两个依赖，与"零依赖"定位冲突，
     建议作为可选引擎而不是默认。
   - 都没有时返回 `skipped: true` + 原因，**不要**把"没装 Ghostscript"报成工具失败。
3. 渲染缓存放 `<buildDir>/.dsh-latex/look/<contentHash>/page-N.png`，与现有
   `last-build-<fingerprint>.json` 同目录；`look` 只读构建产物，不触发额外编译（除非 stale）。
4. 图片尺寸是第一成本：默认 120 dpi、单页、必要时按 `text` 裁剪返回；`audit` 只回变化页列表，
   不复述整本。

**成本**：MVP（gs/pdftoppm + 单页 + diff）1–2 天；缓存与 audit 再加 1–2 天。

---

### P0-2 论文体检工具组 —— 借鉴 `latex-guard` + `dsh-cumcm`

**出处**：
- [Flan246/dsh-latex-guard](https://github.com/Flan246/dsh-latex-guard)：`latex_check`、`bib_lint`、
  `bib_fill`、`cite_audit` 四个工具；`--json` + 退出码（0/1/2）；缺 latexmk 时
  `skipped: true` 降级而不是报错；`bib_fill` 从 Crossref 补字段**从不覆盖**已有值；
  bib 无法完整解析时**拒绝写回**；引擎 `auto` 按 `% !TeX program` / `\RequireXeTeX` /
  `xeCJK` / `{ctex` / `\RequireLuaTeX` 探测。
- [Rosynb666/dsh-cumcm](https://github.com/Rosynb666/dsh-cumcm)：`layout.py` 按竞赛规范检查
  页边距、摘要页数、图表编号与引用、三线表、身份信息泄露、正文页数；`compile.py` 报页数与
  首个错误；`facts.json` + `\res{key}` 让正文数字可溯源（"论文里的数字不能手写"）。

**落到 dsh-latex：**
1. `latex_cite_audit`：扫 `.tex`（识别 `\cite`/`\citep`/`\citet`/`\parencite`/`\textcite`/
   `\autocite`/`\footcite`/`\fullcite`/`\nocite`），对比 `.bib`，报告
   "被引但缺失" / "存在但从未被引"。**注意注释行误报**是 latex-guard 的已知限制，
   实现时先剥注释再匹配。
2. `latex_bib_lint`：重复 key、按条目类型检查必填字段、格式规范化；解析不完整时拒绝 `--write`。
3. `latex_bib_fill`（可选、默认离线）：Crossref by DOI/title，10 s 超时 + 1 次重试，
   只补空字段；没有网络时明确 skipped。
4. `latex_layout_lint`（轻量版）：从 `.aux`/`.lof`/`.lot`/`.log` 取页数、图表编号顺序、
   overfull hbox、未定义引用；"身份信息泄露/三线表"这类规范检查先只做可配置的 regex 规则
   （竞赛/投稿场景），不要硬编码某一比赛的规则。

**成本**：1–2 天；纯文本处理，无新依赖，测试用 `examples/multi-file` + 一个坏 bib fixture
即可覆盖主路径。

---

### P0-3 引擎自动识别与工具链引导 —— 借鉴 `latex-guard` / `kasaki` / `violector` / `Accelerater`

**借鉴点：**
- 引擎探测规则（见 P0-2）；探测结果写进 `status` 与诊断，并在"配置默认 vs 文档要求"冲突时
  明确说明用了哪个、为什么。
- 一键装工具链的三种做法：
  - kasaki：便携 MiKTeX，首次使用 ~150 MB，TUNA 镜像，`engines.json` 缓存探测结果，
    只检查文件还在不在，不再每次跑 `--version`；
  - violector：私有 TinyTeX，GitHub Release SHA-256 校验，缺宏包自动从 TeX Live 仓库补装，
    不碰系统 PATH/注册表；
  - Accelerater：检测不到 TeX 时在输入框上方出横幅 + 一键 BasicTeX/TinyTeX，带进度与取消，
    装完重新扫描；路由 `GET /dsh-latex/env`、`POST /install`、`GET /install/status`、
    `POST /install/cancel`，除健康信标外全部校验 Origin。
- 安全细节：kasaki 的 `/dsh-latex/*` 不走 `/api` 默认鉴权，所以在 handler 最前面调用
  `ctx.connection.requestRejection({ headers })`；系统浏览器打开时用 2 分钟一次性票据换
  `Path=/dsh-latex` 的 HttpOnly cookie。dsh-latex 的 PDF 路由已有 admission 检查，
  新增安装/打开路由要沿用同一套。

**落到 dsh-latex：**
1. 先做**识别**：`src/project.js` 增加 preamble 扫描（ctex/xeCJK/fontspec/`\RequireXeTeX`/
   `\RequireLuaTeX`），产出 `engineHint` 并在 `latex_compile` 未显式指定引擎时采用，
   `latex_get_status` 说明来源。成本约半天，立刻减少"中文文档默认 pdflatex 报错"。
2. 再做 **Windows 一键 TinyTeX**：下载到用户配置目录（不是 C 盘临时区）、SHA-256 校验、
   解压到 `<DSH_HOME>/latex/toolchain`，装完只更新插件内 `texBinDir`，不改 PATH/注册表；
   路由与 UI 状态卡复用现有 SSE。macOS/Linux 可后置（README 已注明 POSIX 未端到端验证）。

**成本**：识别 0.5 天；安装 2–3 天（含失败回滚与磁盘占用提示）。

---

### P1-1 编辑器升级：CodeMirror 6 + 大纲 + 草稿恢复 —— 借鉴 `violector` / `markpilot`

**出处：**
- [violector/dsh-latex-studio](https://github.com/violector/dsh-latex-studio)：CodeMirror 编辑器、
  章节/环境折叠、LaTeX 语义高亮（章节、环境、宏包、引用、数学命令、注释、括号）、
  选区 AI 修改（携带文件版本 + 精确范围，版本变化拒绝覆盖，可从 `.history/` 恢复）、
  24 个模板入口、公式/图表/伪代码插入、Ctrl +/- 缩放。
- [ltmroberthk915/markpilot](https://github.com/ltmroberthk915/markpilot)：文件树 + 编辑器 + 对话
  并排；选中文段把源码和文件路径插入对话；保存走**版本守卫 + 原子落盘**，冲突给横幅而不覆盖；
  外部改写 1–2 秒自动采纳，有草稿时给可操作提示；草稿可恢复；15 万字交 Worker 不卡主线程。
- dsh-latex 已经有的（**不要退步**）：revision CAS、原子替换、BOM/EOL 保留、4 MiB 上限、
  `keepMounted` 切 tab 不丢。缺的是高亮、折叠、大纲、草稿恢复、外部修改提示。

**落到 dsh-latex：**
1. 用 CodeMirror 6 替换 `client.js` 里的 `.dl-editor-text` textarea；保留现有
   `POST /latex/file` 的 CAS 协议不变（编辑器只换外壳，服务端不动）。
2. 大纲：host 侧从主文档 `\input` 图 + `\section|\subsection|\chapter` 生成（可复用
   `project.js` 的依赖图），client 侧折叠面板，点击滚动到行。
3. 草稿：`sessionStorage` 按 `project + file + revision` 存未保存文本（含 2 s 节流），
   重开 tab 恢复；外部修改检测沿用 watcher（已有），有草稿时提示"磁盘已变，加载/保留/对比"。
4. 注意 IME：现有实现里中文输入法组合期间 Ctrl+S 可能被吞（`docs/limitations.md`），
   CodeMirror 的 `compositionstart/end` 处理可以一并修掉。

**成本**：3–5 天；新增 CodeMirror 依赖（MIT，可按 pdf.js 的方式 vendor 进 `assets/`）。
这是投入最大、但对"写作体验"收益也最大的一项。

---

### P1-2 把 PDF 预览变成上下文：批注 → AI 改源 → 编译 → 修订 —— 借鉴 `paperlab` / `office-kit`

**出处：**
- [maple-pwn/paperlab](https://github.com/maple-pwn/paperlab)：在渲染后的 PDF 上选中任意文字写批注，
  黄高亮按页面坐标落位；"定位"红窗显示修改前原文；agent 逐条改写、编译验证、git 提交；
  每个项目即 git 仓库，AI 修订自动 checkpoint，历史/diff/revert/导出；宽屏"轨迹"直播
  思考/工具调用/输出；引擎降级链、尊重 latexmkrc。
- [hairyf/dsh-office-kit](https://github.com/hairyf/dsh-office-kit)：预览里悬停吸附段落或框选区域，
  输入修改要求批量提交；PDF 附选区截图，DOC 只发文字+定位；注释列表可逐条查看；
  Esc 两级取消；暂存注释刷新后不保留（明确的取舍）。
- [paperlab] 的架构值得注意但**不建议照搬**：它是独立 React + FastAPI + 插件三进程，
  工作台跑在 127.0.0.1:8210，AI 引擎在 DSH 里。dsh-latex 的"原生 tab + 同源路由"更轻。

**落到 dsh-latex：**
1. PDF 预览加 pdf.js **TextLayer**（已 vendor pdf.js，零新增依赖），让页面文字可选中。
2. 选区 → 小工具条（"提问 / 改成 / 批注"）→ 落盘
   `<buildDir>/.dsh-latex/annotations/<fingerprint>.json`：
   `{ id, page, rects, quote, comment, status, buildVersion }`。
3. 新增工具 `latex_annotations`（list / resolve / clear），agent 读完批注后用现有
   `POST /latex/file` 改源、`latex_compile` 验证，再把条目标记为 resolved；
   若构建版本变了而批注未 resolve，按 `quote` 文本重新定位，定位失败标 stale 而不是静默丢弃。
4. git checkpoint **默认关闭**：项目本身是 git 仓库且用户显式开启时才 `git add -A && git commit`
   （提交信息带批注 id 与构建结果）。默认自动提交是入侵性行为，不要学。
5. 选区提问可以先做最小版（把 quote + 页码 + 附近源码作为用户消息发进会话），
   再做批注持久化与 resolved 生命周期。

**成本**：选区+提问 1 天；批注存储 + 工具 + 修订状态 2–3 天。

---

### P1-3 预览体验补齐 —— 借鉴 `paper-reader` / `docmate` / `kasaki` / `Accelerater`

| 能力 | 出处 | 做法要点 |
| --- | --- | --- |
| 页码锚点回答 | paper-reader | 回答必带页码；点页码跳回 PDF 并高亮闪烁；选区即问不打断阅读 |
| 字符偏移锚点 | docmate | 划线锚点用字符偏移（doc 级/page 级）而非像素，缩放/换宽不漂；CSS Custom Highlight API 画，不碰 React DOM |
| 目录 / 文档内搜索 | docmate、kasaki | pdf.js outline 直接取目录；跨文本节点拼接后匹配；KaTeX 的 MathML 副本要跳过 |
| 阅读位置记忆 | docmate、kasaki | 每文档一个 localStorage/state 键，异步内容加载完再恢复；公式排版后高度变化再对齐一次 |
| 深色模式 | paper-reader | 整页反色 + 强度档位，图片会偏色 → 明确写进限制并可一键关 |
| 下载 / 系统浏览器打开 | kasaki | 成功后才有入口；`attachment` + RFC 5987 文件名解决中文乱码；Electron 下用 Host 打开浏览器 + 一次性票据 |
| 分栏记忆 | kasaki、violector | 拖动比例落 `prefs.json`，双击复位，方向键微调 |
| 懒渲染 + 单文档 | typst-preview | 同时只挂一个预览文档（每个 tab 一个 WebKit 文档会到 GB 级）；实例有上限 + 空闲回收 + 存活探测 |

dsh-latex 现有预览已有：分页跳转、fit-width、25–200% 缩放、懒渲染、stale 横幅、last-good、
双击反查 SyncTeX。**缺**：目录、位置记忆（目前只在会话内）、文档内搜索、深色、下载、
选区、大纲联动。

**成本**：目录/位置记忆/下载各 0.5 天；搜索 1 天；深色 0.5 天。

---

### P2-1 分发与市场表现 —— 借鉴 `violector` / `latex-look` / `typst-preview` / `kasaki`

目录里 dsh-latex 的条目现状：`version: null`、`npm: null`、无 `engines.dsh`、
`install` 只指向 GitHub release tarball、2 张截图（来自 GitHub raw HEAD）。
对照同类：

| 项 | 同类做法 | 对 dsh-latex 的建议 |
| --- | --- | --- |
| 安装方式 | paperlab `dsh-paperlab`、kasaki `@kasaki002/dsh-latex-studio`、latex-look 均发 npm；typst-preview 声明精确 `engines.dsh` 区间 | 发 npm（同名 `dsh-latex`），保留 release tarball；加 `engines.dsh: ">=0.2.1-rc.5"`，让市场卡显示兼容而不是 unknown |
| 首图 | paperlab 截图 + workflow.svg；kasaki GIF；paper-reader GIF | 做一段 15–20 s GIF：打开 .tex → 改 → 自动编译 → 预览原地刷新 → 双击回源码。这比 2 张静态图更能解释"原生闭环" |
| 能力说明 | typst-preview 用表格逐项写死文件/网络/命令/凭据/生命周期边界；Accelerater 的威胁模型写进 README | README 加一节能力表：shell（latexmk argv）、fs-write（仅 `.tex` + 构建目录）、network（无，除非 Crossref/bib-fill）、env；明确"TeX 不是沙箱"（SECURITY.md 已有，市场卡看不到） |
| 打包完整性 | — | `package.json#files` 补 `assets/screenshots`（或把截图放 README 不打包），否则 release tarball 里 README 图 404——验收报告 P2-1 仍未修 |
| 技能层 | latex-look 附 `SKILL.md`（症状→原因→修法手册）；cumcm 把 skill 与 plugin 分工 | 加 `skills/latex/SKILL.md`：编译错误手册 + 工具使用顺序（先 diagnostics，再 synctex，再 look），比只靠 systemPrompt 一段话更能约束模型 |
| 索引分发 | violector 提供 format-1 自定义插件索引，固定到完整 commit | 本仓库已在社区目录中，优先把条目质量做好；自定义索引可后置 |
| 版本提示 | latex-look 检测"磁盘新版本 / 进程旧代码"并明确提示重启 | 若发 npm + 支持热更新，这点值得抄 |

**成本**：0.5–1 天（npm + metadata + GIF + 能力表 + files 修复）。

---

### P2-2 工程与测试 —— 借鉴 `latex-look` / `paper-reader`

- latex-look 的测试是"真文档"驱动：52 个端到端场景 + 34 个深场景 + 一本 208 页真实书
  （164 个 `.tex`、自定义 `.sty`、181 张图）；`book-tasks` 用"用户会说的话"当用例，
  断言"构建成功 + diff 存在 + 变化框落在编辑作用的区域"。
- paper-reader：CI 跑 ubuntu/macOS/Windows 三平台；删除走 `.trash` + manifest 可恢复；
  中途失败自动回滚。
- dsh-latex 现有：`node --test`、`npm run check`、CI 语法+单测+`npm pack --dry-run`，
  但 **CI 没有 TeX**，`examples/{hello,chinese,multi-file}` 从未在 CI 真编译。
- 建议：
  1. 加一个 `ubuntu + texlive-xetex` 的 CI job，真编译 3 个 example，断言退出码/页数/诊断 JSON；
  2. 加 `bin/dsh-latex.mjs` CLI（compile/diagnostics/synctex/look），不经过 Host reload 就能手测——
     latex-look 的 CLI 就是它的主要调试路径；
  3. 加"坏文档"fixture（缺宏包、未定义引用、中文默认引擎、多 root 歧义），把已知错误码变成回归。

**成本**：1–2 天。

---

## 3. 不建议照搬

| 功能 | 出处 | 原因 |
| --- | --- | --- |
| 独立 Web 应用 + FastAPI + 插件三进程 | paperlab | 绕过 DSH 原生集成，多一个端口、多一套鉴权、多一份部署；dsh-latex 的同源路由 + 原生 tab 更轻 |
| Overleaf Socket.IO/OT 双向同步 | measureer/dsh-overleaf-sync | 协议私有且随官方前端变化，需浏览器 Cookie，账号共享有条款风险；除非用户明确要，不做 |
| 云端 PDF 翻译 / OCR（上传文件） | dsh-pdf-translator、kolmopdf | 隐私与成本；dsh-latex 的卖点是"本机、无网络"，不要稀释 |
| WYSIWYG Typst 编辑器 | tylina | 不同编译器（Typst），与 LaTeX 工程不共享；可作为独立插件存在 |
| 默认 git 自动提交 | paperlab | 写用户仓库历史是入侵性行为，必须 opt-in |
| 模板市场 / 24 个期刊模板 | violector | 上游样式许可与维护成本高（作者自己写了 THIRD_PARTY_NOTICES）；先做"从现有项目开始" |
| Office 套件 / PPT / 表格 | univer-office、office-kit、dsh-ppt | 范围蔓延，与 LaTeX 写作无关 |
| 多引擎混合渲染（sysfont 内容流解码） | dsh-pdf | 只对非内嵌 CJK 的特定 PDF 有用；dsh-latex 编译产物字体内嵌正常，用 gs/pdfjs 足够 |

---

## 4. 建议路线图

**第一批（约 1 周，性价比最高）**
1. `latex_cite_audit` + `latex_bib_lint`（P0-2，纯文本，零依赖）
2. 引擎自动识别 + `latex_get_status` 说明（P0-3 前半）
3. 市场元数据：`engines.dsh`、npm 发布、`files` 补截图、能力表、GIF（P2-1）
4. `latex_look` MVP：gs/pdftoppm 单页渲染 + SyncTeX 定位 + 与上一版 diff（P0-1）

**第二批（约 1–2 周，形成差异化）**
5. PDF TextLayer + 选区 → 会话提问 → 批注落盘 + `latex_annotations` 工具（P1-2）
6. 预览：目录、位置记忆、下载、文档内搜索（P1-3）
7. `latex_look` 缓存 + audit + 浮动页纠偏（P0-1 后半）

**第三批（体验升级，投入最大）**
8. CodeMirror 6 + 大纲 + 草稿恢复（P1-1）
9. Windows 一键 TinyTeX + 安装状态 UI（P0-3 后半）
10. TeX e2e CI + CLI + 坏文档 fixture（P2-2）

---

## 5. 风险与边界

- **TeX 构建不是沙箱**：`.latexmkrc` 是可执行 Perl，编辑器写接口带 Host 权限。新增的
  `look`/`annotations` 路由必须复用现有 admission 检查；安装 TeX 的路由要校验 Origin，
  下载要校验 SHA-256，安装目录不写 PATH/注册表。
- **图片成本**：把整页 PNG 返回给模型会消耗大量 token；默认低 dpi、单页、按需裁剪，
  `audit` 只回变化页。
- **新依赖**：pdfjs-dist/@napi-rs/canvas/CodeMirror 都会打破"零 npm 依赖"的定位；
  要么 vendor（像 pdf.js 一样带许可证），要么明确写成可选引擎并优雅降级。
- **磁盘**：用户机器 C/E 盘紧张，渲染缓存与 TeX 安装默认放可配置目录，并给清理入口
  （现有 `latex_clean` 只清 aux，可扩展 `look` 缓存）。
- **批注失效**：PDF 版本变化后坐标不再可靠，必须按 quote 重定位 + stale 标记，
  不能静默丢弃，也不能把错位锚点交给 agent。

---

## 附录 A：目录中 LaTeX/TeX 相关条目的分桶（67 条）

| 桶 | 数量（约） | 例子 |
| --- | --- | --- |
| 本机 LaTeX 工作台/编译闭环 | 8 | paperlab、kasaki studio、violector studio、cumcm、Accelerater、latex-look、latex-guard、本仓库 |
| Overleaf 桥/同步 | 3 | fly233338、gychen-NJU、measureer |
| 公式渲染/编辑/复制 | ~20 | sbVAN/dsh-latex、dsh-math-render、dsh-math-snippets、latex-formula-editor、formula-editor、katex-inline-copy、math-copy、colorlab… |
| 引用/文献/核查 | ~15 | literature、reference-checker、dsh-cite、cite-verify、refkeeper、lit-search、zotero、scholar-digest… |
| PDF 阅读/翻译/解析 | ~10 | paper-reader、english-lit-reader、pdf-translator、docmate、kolmopdf、docx2md… |
| 文档转换/排版其他 | ~8 | formula-docx、code-highlight、cumcm skill、mathtype、pptx-builder… |
| 其他（主题/性能/复制） | ~3 | chat-perf-css、copy-enhance、colorlab |

## 附录 B：精读清单

1. [maple-pwn/paperlab](https://github.com/maple-pwn/paperlab) — 批注→AI 修订→编译→git
2. [kasaki002/dsh-latex-studio](https://github.com/kasaki002/dsh-latex-studio) — 便携 MiKTeX、会话页签、票据换 cookie
3. [violector/dsh-latex-studio](https://github.com/violector/dsh-latex-studio) — 私有 TinyTeX、模板、CodeMirror 折叠、选区守卫
4. [fangchenghao/latex-look](https://github.com/fangchenghao/latex-look) — 页面渲染 + SyncTeX + 像素 diff + audit + 缓存/锁
5. [Flan246/dsh-latex-guard](https://github.com/Flan246/dsh-latex-guard) — cite/bib 四工具、引擎探测、JSON/退出码
6. [Accelerater-tech/dsh-latex](https://github.com/Accelerater-tech/dsh-latex) — 公式/文档编译工具、一键装 TeX、路线注册坑
7. [Rosynb666/dsh-cumcm](https://github.com/Rosynb666/dsh-cumcm) — P0–P7 看板、facts 台账、layout 体检
8. [GGboya/dsh-paper-reader](https://github.com/GGboya/dsh-paper-reader) — 页码锚点、选区即问、公式裁切、回收站
9. [miaojinQWQ/dsh-docmate](https://github.com/miaojinQWQ/dsh-docmate) — 字符偏移锚点、CSS Highlight、注入+记忆、三工具 `when` 条件
10. [hairyf/dsh-office-kit](https://github.com/hairyf/dsh-office-kit) — 预览选区→批量修改要求、渲染校验
11. [ltmroberthk915/markpilot](https://github.com/ltmroberthk915/markpilot) — 版本守卫、冲突横幅、草稿恢复、外部修改自动采纳
12. [Limbo-137/dsh-typst-preview](https://github.com/Limbo-137/dsh-typst-preview) — 侧栏 tab 注册、单文档内存上限、实例回收
13. [zhtx2024/dsh-pdf](https://github.com/zhtx2024/dsh-pdf) — pdfjs + @napi-rs/canvas 页面渲染、非内嵌 CJK 回退
14. [measureer/dsh-overleaf-sync](https://github.com/measureer/dsh-overleaf-sync) — dry-run 默认、三方 diff、冲突不覆盖

## 附录 C：数据复现

```sh
# dshmarket 的目录源（本机 dshmarket 1.73.1 的 lib 中确认）
curl -sSL -o plugins.json https://awesome-dsh-plugin.com/plugins.json
# 12,763 条；docs 分类 255 条，star 中位数 1，≥50★ 仅 8 条
# 命中 LaTeX/TeX 关键词 67 条；其中本机工作台/编译闭环 8 条
```

目录中本仓库条目：
`https://awesome-dsh-plugin.com/p/Yaohua-Leo/dsh-latex/`
（`added: 2026-11-12`，`npm: null`，`version: null`，`engines.dsh` 未声明，
截图 2 张来自 GitHub raw HEAD）。
