# Review 后修复与决策记录

本轮（2026-11-03 傍晚至深夜）先后完成 6 个 swarm 任务（acceptance / host-review / client-review / synctex / security / docs），随后 Lead 按审查结论修复并回归。本文是 **finding → 处置 → 验证** 的对照表，便于复核为什么现在的代码与 `docs/review-host.md`、`docs/review-client.md`、`docs/security-audit.md`、`docs/synctex-notes.md`、`docs/limitations.md` 的初始描述不同。

> 约定：**FIXED** = 源码已改并有回归证据；**DOCUMENTED** = 行为保留但文档写明风险/语义；**DEFERRED** = 明确未做（已写入 limitations/README）。

---

## 一、Host（review-host.md）

| ID | 级别 | finding | 处置 | 实现/证据 |
| --- | --- | --- | --- | --- |
| H1 | high | `#pump` 队列合并会丢弃 manual/UI job，promise 永不 settle | **FIXED** | `src/service.js` `#pump` 只丢弃 `reason === 'auto'` 且保留最后一个 auto；每个被丢弃 job 都 resolve。回归：在 41.5 s 强制构建期间入队 manual + auto，manual 返回 SUCCESS 1.09 s、auto 随后 1.14 s，无悬挂（acceptance 附录 L3） |
| M1 | medium | 取消在 semaphore 等待期无效（abortController 在 acquire 后创建） | **FIXED** | controller 在 `acquire` 前创建并赋给 project；内置 semaphore 支持 `signal` abort；`acquire` 返回后再次检查 `aborted` 并走 cancelled 分支 |
| M2 / SEC-06 | medium/high | `% !TEX root` 分支绕过 `allowedRoots` | **FIXED** | `src/project.js` magic 分支对目标主文件与 rootDir 调 `assertAllowed`；新增 `assertSafePath` 在 `stat` 前拒绝 UNC/网络路径 |
| M3/M4 | medium | 项目 `.latexmkrc` 回退 DVI（exit 0 无 PDF）时，buildDir 里的旧 PDF 被当成本次成功并发布 | **FIXED** | `src/build.js` 新增 fresh-evidence 判定：`Output written on *.pdf`、PDF mtime ≥ start−2 s、或 latexmk 明确 “All targets … up-to-date”；否则 FAILURE 并给出 rc/PDF-mode 提示。回归：`$pdf_mode=0` + 旧 PDF 的 `-gg` 构建返回 FAILURE 与明确提示（acceptance L3） |
| M5 | medium | 只读了 BibTeX `.blg`，Biber 的 `WARN/ERROR` 行未解析 | **FIXED** | `src/logparse.js` `parseBibLog` 支持 `Warning--`、`WARN`、`ERROR`、`error message` |
| M6 | medium | 同一目录多个主文件共用一个项目 id / 一个 preview 文件 | **FIXED** | `util.projectIdOf(root, mainFile)` 改为 root+main；`build.projectPaths` 发布到 `preview-<sha1(mainFile).slice(0,10)>.pdf` 与 `last-build-<hash>.json`；子目录 `\include` 的 build 子目录在构建前镜像创建 |
| M7 | medium | 工具 `timeoutMs` 可超过 `setTimeout` 上限 | **FIXED** | `src/build.js` 钳制到 `[5000, 86 400 000]` ms |
| M8 / SEC-03 | medium/high | 项目 `.latexmkrc` 是可执行 Perl；插件默认尊重它 | **DOCUMENTED + OPT-OUT** | 保留任务要求的「不强行覆盖项目构建配置」默认；新增 `allowProjectLatexmkrc`（默认 true），置 false 时传 `-norc`。README 安全章节明确「构建不可信项目 = 运行不可信代码」 |
| M9 | medium | `latex_compile` 的 `path` 文档说可为目录，实现只当文件 | **FIXED** | `ProjectResolver.resolve` 遇到目录时走项目目录解析（有回归：`latex_compile(path="…/engines")` SUCCESS） |
| M10 | medium | 发布（atomicCopy）失败被外层 catch 归类为普通失败，可能掩盖已生成 PDF | **DOCUMENTED** | 仍然报告 failure（不发布半成品/旧 preview 更安全）；日志与 lastError 保留原文。若将来需要区分，可增加 `publishError` 字段 |
| M11 | medium | clean 与构建无互斥，构建中清理会制造假失败/删 preview | **FIXED** | `service.clean` 在 `building/queued/pumping` 时抛明确错误；回归：慢构建期间 clean 返回该错误且未删除文件（acceptance L3） |
| M12 | medium | 恢复的 last-build 状态可能误导（有 preview 但显示从未构建） | **FIXED（基本）** | `#restorePublishedState` 现在同时恢复 `status=success`、`lastBuild`（reason=`restored`、时间、duration、pages）；历史诊断不持久（已在 limitations 写明） |
| M13 | medium | `previewSurface` 配置未生效 | **FIXED** | Host `requestPreview` 记录 `surface`；工具 `latex_preview` 支持 `surface: native|document`；客户端按 request/config 打开 PDF.js tab 或 DSH 内建文档预览 |
| 其他 low/nit | low | watcher 不重试、SSE 背压、健康探针泄漏 pid/路径、恢复元数据不校验等 | **DEFERRED / DOCUMENTED** | 已在 `docs/limitations.md` 与 README 记录；不影响 P0/P1 使用 |

---

## 二、Client（review-client.md）

| ID | 级别 | finding | 处置 | 实现/证据 |
| --- | --- | --- | --- | --- |
| F1 | high | 缩放后 `innerHTML=''` 但保留旧 canvas，页面空白且双击取不到 canvas | **FIXED** | 缩放循环 `record.canvas = undefined`；`renderPage` 若 canvas 不在 element 内则重建 canvas+页号。UI 回归：缩放 100% 页面仍渲染（`本地截图（未随公开仓库发布）zoom-100-percent.png`） |
| F2 | high | 双击反查用正则拆人类可读串：行号结尾无空格 → 永远取不到；含空格路径被截断；CJK 乱码 | **FIXED** | Host 新增结构化 `service.syncTeXResult`（`/latex/synctex*` 返回 `synctex` JSON）；客户端直接用 `file/line/relativeFile/stale`，不再正则；synctex stdout 改为原始字节 UTF-8→GBK 解码。工具级 CJK inverse 返回 `main.tex:8`；重启后 ASCII 双击定位源码行 PASS |
| F3 | medium | 工作台首次成功编译后不开预览（闭包里的旧 `previewVersion=0`） | **FIXED** | compile 完成后从 `data.snapshot` 找最新项目再 `openPreview` |
| F4 | medium | 滚动页码只增不减 | **FIXED** | `onScroll` 从 1 开始按页序取最后一个 `offsetTop <= scrollTop+80` 的页 |
| F5 | medium | tab 重建时 saved page 覆盖 `params.page` | **FIXED** | `pendingRestoreRef` 初值改为 `params.page ?? savedView.page`；load effect 也优先 params |
| F6 | medium | 工作台不读 tab 参数 `project` | **FIXED** | 面板读取 `useTabInfo().navigation.params.project`，并以 revision 更新 selectedId |
| F7 | medium | SSE/action 快照丢掉 `/latex/state` 的 `activeProjectId` | **FIXED** | store.set 合并时保留旧 `activeProjectId` |
| F8 | medium | 预览 tab 无项目身份，恢复后可能选错项目；「一项目一 tab」表述不符 | **DOCUMENTED + 缓解** | 仍为「一会话一个 PDF 预览 tab」（DSH page type 身份限制）；新增 `lastPreviewProjectId` 作为恢复回退；工具/README 文案改为「one preview tab per session」。完整的每项目多 tab 需要 `multiple` + 自定义地址，留作后续 |
| F9 | medium | `pdfjsPromise` 缓存失败，重试永远失败 | **FIXED** | import catch 中清空缓存，重新加载可恢复 |
| F10 | medium | `useSessions`/`useTabInfo` 被 try/catch 包在函数里，违反 hooks 规则 | **FIXED** | 组件顶层无条件调用；删除了条件 hook 的 helper |
| F11 | medium-low | 预览 tab 改项目时请求页丢失 | **FIXED** | params.page → pendingRestore 同步 |
| F12 | low-medium | ref 传 null 不清理旧元素，重载后页码可能异常 | **FIXED** | ref null 时删除 `pageElsRef/pagesRef` 条目；加载/切换时清空 |
| F13 | low-medium | renderPage 异步结果无代次校验 | **FIXED** | 每页 `generation` 令牌 + doc 身份检查 |
| F14–F16 | low | SSE 重连态、lastPreviewHandled 盲区、生命周期小项 | **部分/文档化** | 连接指示仍以 SSE 事件为准，error→connecting 由 EventSource 自带重连；去重逻辑保留 |
| F17 | low | 页码/缩放输入缺 ARIA label | **FIXED** | 增加 `aria-label` |
| F18–F20 | nit | 尺寸/代码卫生/打包可移植性 | **部分** | `files` 未列 `assets`（linked 安装不受影响，发布需补）；已在 README 注明 pdf.js 资产来源与许可证 |

---

## 三、安全（security-audit.md）

| ID | 级别 | 结论/处置 |
| --- | --- | --- |
| SEC-01 | 通过 | `ctx.subprocess.spawn({ argv })`，无 shell、无字符串拼命令 |
| SEC-02 | **FIXED** | 默认加 `-no-shell-escape`（可用 `allowShellEscape: true` 显式放开）；仍从不默认加 `-shell-escape` |
| SEC-03 | **DOCUMENTED + OPT-OUT** | `.latexmkrc` 是 Perl eval；保留「尊重项目 recipe」的默认（任务要求），提供 `allowProjectLatexmkrc: false`（传 `-norc`）；README 明示「不可信项目 = 不可信代码」 |
| SEC-04 | **DOCUMENTED（无法在插件层修复）** | 本机 kpathsea `openin_any=a`，TeX 可读任意文件并由 log/PDF 外带；插件不修改全局 texmf.cnf。README 明确：构建不可信项目必须用低权限用户/容器/VM |
| SEC-05 | **DOCUMENTED** | `-outdir` 只约束默认输出；TeX 可在项目根内 `\openout` 覆盖相对路径文件。README 已改正“构建输出只在 buildDir”的表述 |
| SEC-06 | **FIXED** | magic root 分支补 `assertAllowed` + UNC 拒绝 |
| SEC-07 | **DOCUMENTED** | `allowedRoots` 是“项目入口白名单（防误操作）”，不是文件系统沙箱；符号链接/`\input ..\..` 仍可能出界（TeX 读路径） |
| SEC-08 | **FIXED** | SyncTeX forward 的 `file` 必须位于项目根内；inverse 外部路径标 STALE 并提示重建 |
| SEC-09/10/11/16 | 通过/低风险 | 路由除 `/latex/health` 外均 `connection.admit`；PDF 只服务注册项目的 preview；clean 只删 allowlist；health 会暴露 pid/TeX 路径（本机 loopback，低风险，已记录） |
| SEC-12+ | 低/通过 | 未发现命令注入或任意写 preview 之外路径的路径 |

**总体安全立场（写入 README）**：本插件把 TeX 项目当作**可执行内容**。安全边界是“用户主动选择在哪个目录上构建”，不是沙箱；需要对抗不可信仓库时，必须在独立低权限环境运行。

---

## 四、SyncTeX（synctex-notes.md）

| ID | 处置 |
| --- | --- |
| F-1 行号永远取不到（`Column:-1` 无后缀） | **FIXED**：结构化返回，客户端不再解析字符串 |
| F-2 含空格路径被截断 | **FIXED**：结构化 `file` 字段 |
| F-3 CJK 路径 GBK→UTF-8 乱码 | **FIXED**：原始字节 → 严格 UTF-8 失败则 GBK 解码（`decodeSyncTeXOutput`）。工具级中文反查返回 `main.tex:8`；像素级双击复验未完成（过程被前台窗口遮挡），未记 PASS |
| F-5 同一页重复跳转被忽略 | **FIXED**：`params.page` effect 依赖 `navigation.revision`；pendingRestore 同步 |
| 无 `.synctex.gz` 时把 usage 全文当结果 | **FIXED**：检查 `SyncTeX result begin`，返回明确提示 |
| 项目复制/改名后旧 `.synctex.gz` 指回旧路径 | **FIXED（提示）**：`stale` 标记 + 提示重建 |
| `Column:-1` 列信息 | **ACCEPTED**：视为 unknown，不显示 column |
| 页码/行号越界静默吸附 | **DOCUMENTED**：synctex.exe 行为，工具只能检测空结果，无法区分“越界”与“真实失败”；README/limitations 记录 |

---

## 五、Acceptance（acceptance.md）的已知差异

1. 矩阵执行时 Host 加载的是 16:20 版 `service.js`；acceptance 已在 §1.4 说明。随后 **真实重启**（23:42）加载了修复版，Lead 在 acceptance 附录 L 重新验证了关键链路。
2. Agent 侧无法验证的 UI 项（像素级刷新、中文屏幕渲染、双击反查、重启后工具注册）已由 Lead 用截图/真实重启补验；仍保留的“未逐像素验证”项（CJK 双击、正向按钮点击）明确写在附录 L2，不冒充 PASS。
3. `single-math` fixture 在验收中临时加入的 “Auto-refresh check” 小节已移除，源码恢复；其历史 `preview.pdf` 仍是含该小节的构建产物，属正常测试痕迹。

---

## 六、后续建议（未实现，非本轮目标）

1. 用 `multiple: true` + 项目专属资源地址实现「一项目一预览 tab」，替代目前的「一会话一 tab + 参数切换」。
2. 纯 JS 解析 `.synctex.gz` 的 Input 表，彻底摆脱 `synctex.exe` 的 ANSI 编码与 CJK 路径限制。
3. 构建历史/诊断持久化（存入 `build/.dsh-latex/history.jsonl` 并在面板展示）。
4. 可选的 `openin_any`/`openout_any` 受限 TeX 配置模板或容器构建模式。
5. 为 `files` 补 `assets/`（发布/打包时需要），并接入 CI 的 `node --check` + 真实 fixtures 冒烟。
6. 把 `.latexmkrc` 默认改为 `-norc` 的一键“安全模式”（需产品层权衡是否违背“尊重项目构建配置”的契约）。
