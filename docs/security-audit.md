# dsh-latex 安全审查报告

- 审查对象：`D:\deepseekharness\latex-plugin`（Host 半 `index.js` / `src/*.js`，Client 半 `client.js`，配置 `cordis.patch.yml`、`package.json`，资产 `assets/*`）
- 审查时间：2026-11-03
- 审查方式：只读源码 + 只读 HTTP 探测 + TeX Live 配置查询；**未修改插件源码、profile、fixture 或 TeX Live**
- 运行事实：`C:\Users\86132\.dsh\profiles\desktop\node_modules\dsh-latex` 是指向 `D:\deepseekharness\latex-plugin` 的符号链接（`Get-ChildItem ... | Select LinkType,Target` 实测），即本次审查的源码就是正在运行的源码；profile 的 `cordis.patch.yml` 没有 `latex` 覆盖，生效配置为 bundle 默认值（`allowedRoots: []`、`respectLatexmkrc: true`、`extraLatexmkArgs: []`）。

## 0. 结论摘要

**没有 blocker（无需立即下线的远程未授权 RCE/任意文件读取）。** 在“只构建可信项目”的前提下，以下关键条款成立：

- latexmk 通过 `ctx.subprocess.spawn({ argv })` 启动，**没有 shell、没有字符串拼命令**（SEC-01）。
- 除 `/latex/health` 外所有 HTTP 路由都过 `connection.admit`；`/latex/pdf` 只服务注册项目的固定 preview 路径；`clean` 只动 build 目录（SEC-09/10/11/16）。
- 凭据方面：子进程环境被裁剪为 `PATH`/`max_print_line`，不继承 API key；配置与状态里没有 token/密码（SEC-15）。

**但“构建一个不可信的 LaTeX 项目”在本插件里等价于“执行不可信代码”，且文档没有说清：**

| 编号 | 严重度 | 结论 |
| --- | --- | --- |
| SEC-03 | **High** | 项目根存在 `.latexmkrc` 时，latexmk 会把其内容当 Perl `eval` 执行；插件默认 `respectLatexmkrc: true`，且即使设为 `false` 也不会传 `-norc`，只是不强制 engine flag |
| SEC-04 | **High** | 本机 kpathsea `openin_any=a`，`.tex` 可 `\input`/`\openin` 任意绝对路径文件，并通过 `\typeout` 把内容写进 `.log`，再经工具结果/日志进入模型上下文；预览 PDF 也能嵌入 |
| SEC-06 | **High（条件）** | `% !TEX root = ...` 分支返回前没有 `assertAllowed`，可让一个位于 `allowedRoots` 内的文件把构建根目录带到 allowlist 之外；当前配置 `allowedRoots: []`，所以该边界当前未启用 |
| SEC-02 | Medium | 插件从不主动加 `-shell-escape`，但本机 TeX Live 默认 `shell_escape=p`（restricted，白名单含 `kpsewhich`/`repstopdf` 等），且插件不传 `-no-shell-escape`；`.latexmkrc` 还能显式打开 |
| SEC-05 | Medium | `openout_any=p` 只禁止绝对路径和 `..`，`.tex` 仍可在**项目根**内覆盖相对路径文件（例如 `.latexmkrc`、已关闭的 `\input` 子文件；当前正在读取的 `main.tex` 可能被 TeX 的打开文件检查拒绝），并不像 README 说的“构建输出只在 buildDir” |
| SEC-07 | Medium | `allowedRoots` 只是“入口主文件”白名单，不是文件系统沙箱；`\input{..\..\secret}`、UNC 路径、符号链接都能越过其语义 |
| SEC-08 | Medium-Low | `latex_synctex` 的 `file` 参数经 `path.resolve(rootDir, file)` 后直接传给 synctex，没有任何 root/allowedRoots 约束（实测可传 `../../../../Windows/win.ini`） |
| SEC-12 | Low-Medium | `/latex/health` 无需鉴权，且不校验 Host；实测 `Host: evil.example` 仍返回 200，泄漏 pid、TeX 绝对路径、项目数。loopback 绑定是唯一外层控制 |
| SEC-13 | Low | `/latex/state`、SSE、`?session=` 取项目均不做“请求者会话 = 项目会话”校验，任何已准入客户端可见全部项目的绝对路径、sessionIds、诊断 |
| SEC-14 | Low | 日志/诊断文本原样进入模型工具结果（只截断，不加边界标记），恶意项目可用 `\typeout` 做提示注入 |
| SEC-18 | Low | `isInside` 是词法比较，无 `realpath`；`clean` 未显式跳过符号链接/junction；PDF 路由 `stat`/`createReadStream` 会跟随链接 |
| SEC-19 | Low | `timeoutMs` 工具参数无上限，`Infinity`/超大值经 `setTimeout` 会退化为 1ms 超时；取消在等待全局 semaphore 时无效 |
| SEC-20 | Low | 插件以 `link:`/符号链接方式从可写工作区安装；任何能写该目录的进程都能改 Host JS 和浏览器端 JS，属于开发态完整性风险 |

## 1. 审查范围与方法

审查文件（全部逐行阅读）：

- `index.js`（111 行）
- `src/build.js`（553 行）、`src/logparse.js`（425 行）、`src/project.js`（613 行）、`src/service.js`（924 行）、`src/routes.js`（513 行）、`src/tools.js`（466 行）、`src/tool.js`（201 行）、`src/config.js`（130 行）、`src/util.js`（224 行）
- `client.js`（2004 行，重点看鉴权/取数/资源地址/XSS sink/PDF.js 加载）
- `package.json`、`cordis.patch.yml`、`README.md`（Security 段）、`assets/licenses/PDFJS-NOTICE.txt`

补充证据：

- DSH 安全模型：`docs/api-cheatsheet.md` 的 D.2/D.3/D.5（`connection.admit` 的 cookie 与 Host/Origin/`Sec-Fetch-Site` 语义）与 E 节（`subprocess.spawn` 只有 `argv`，env 从 scrubbed env 起步）。
- TeX Live 实测：`kpsewhich -var-value=shell_escape|openin_any|openout_any|shell_escape_commands`、`latexmk --version`、`latexmk.pl` 源码中的 rc 处理。
- 只读 HTTP 探测（见 §6）。

未做（受任务约束，也避免制造副作用）：

- 没有实际编写并执行恶意 `.latexmkrc`；
- 没有为了验证 SEC-06 而修改 profile 的 `allowedRoots`；
- 没有新建/修改 fixture，没有编译，没有 UI 像素级验证，没有重启 DSH；
- 没有审计 TeX Live 自身 CVE 与 PDF.js 历史漏洞，只确认了本机安全相关配置与版本。

> 说明：为确认 SEC-08，调用了 `latex_synctex` 两次（read-only）。该调用会在 Host 内存中注册 `latex-plugin-tests/synctex` 项目并启动文件监听，但不写文件、不触发构建。

## 2. 威胁模型

| 主体 | 信任级别 | 说明 |
| --- | --- | --- |
| profile 配置（`cordis.patch.yml`） | 可信 | 可配置 `texBinDir`/`latexmkPath`/`extraLatexmkArgs`，能直接决定执行哪个 exe；能改配置的人本来就能执行代码 |
| 模型（工具参数） | 半可信 | 参数任意字符串；`allowedRoots` 是唯一“入口”边界；模型本身还能用 shell，故真正的增量风险来自项目内容 |
| 项目内容（`.tex`/`.latexmkrc`/`.bib`/图片） | **不可信** | clone 的模板、下载的仓库都算；插件会自动构建（`autoBuild: true`） |
| 浏览器/本机网络 | 半可信 | DSH Web 只绑 `127.0.0.1`；但同一浏览器的任何页面都可达 loopback（DNS rebinding） |
| PDF.js 资产 | 第三方 | 固定 5.4.296，同源提供 |

核心结论：**DSH 的安全模型把“运行构建工具”视为执行本地代码；插件没有、也很难在纯 Node 层提供 TeX 沙箱。因此安全边界必须表述为“只构建可信项目”，而不是“没有 shell 所以安全”。**

## 3. 逐项审查

### SEC-01 进程调用：纯 argv、无 shell —— 通过

`src/build.js:190-210` 构造 argv 数组，`src/build.js:235-246`：

```js
handle = subprocess.spawn({
  argv: args,
  cwd: project.rootDir,
  stdio: {...},
  graceMs: 5_000,
  signal: controller.signal,
  env: buildEnv(this.config),
});
```

- 没有任何 `shell: true`、`exec`、`execSync`、命令字符串拼接（全仓 grep 只有 `spawn({ argv })`）。
- argv 元素是独立字符串：`-outdir=<buildDir>`、engine flag、`extraLatexmkArgs` 每项、`mainRelative`。
- DSH 的 subprocess 契约本身只有 `argv`、没有 `executable`/shell 字段（`docs/api-cheatsheet.md` E.1）。
- `extraLatexmkArgs` 来自 profile 配置（`src/config.js:105`），不来自 `.tex` 或 HTTP；属于“可信配置”而不是注入点。
- `mainRelative` 会做 `path.relative` + 逃逸检查（`src/build.js:206-210`）。

**残余小问题**：`mainRelative` 若以 `-` 开头（Windows 允许文件名以 `-` 开头），会被 latexmk 当选项解析；建议在文件名前加 `--`（SEC-19 附带）。不是注入，因为仍是单个 argv。

### SEC-02 无 shell-escape —— 部分成立（Medium）

插件确实**从不添加** `-shell-escape`（`src/build.js:190-205`；README:111），这一点没错。但“没有 shell-escape”不等于“TeX 不能执行命令”：

```
$ kpsewhich -var-value=shell_escape
p
$ kpsewhich -var-value=shell_escape_commands
bibtex,bibtex8,extractbb,gregorio,kpsewhich,makeindex,repstopdf,r-mpost,texosquery-jre8,
```

本机 TeX Live 2023 默认是 **restricted shell escape**（`p`），白名单命令仍可由 `.tex` 的 `\write18{...}` 触发。插件没有传 `-no-shell-escape` 去关闭它。latexmk 本身支持该开关（`latexmk.pl:653-654` 的选项表），因此修复成本很低。

另外，项目 `.latexmkrc` 可以自行设置 `$latex = '... -shell-escape'`（见 SEC-03），此时连 restricted 都不是。

**建议**：默认在 argv 中加 `-no-shell-escape`；确实需要 `minted` 等功能的项目用显式配置 opt-in，并在文档中写明“开启后等于允许项目执行命令”。

### SEC-03 项目 `.latexmkrc` = 任意 Perl 代码执行（High）

证据链：

1. 插件会检测项目根是否有 `.latexmkrc`/`latexmkrc`：`src/build.js:189`、`src/build.js:392-398`。
2. 该检测只用于“是否强推 engine flag”：`src/build.js:199-201`，并没有加 `-norc`。
3. latexmk 默认自动读取 rc：`latexmk.pl:1238`（`$auto_rc_use = 1`）、`latexmk.pl:1942-1944`（cwd 下 `.latexmkrc`/`latexmkrc`）。
4. 读取后不是“解析配置”，而是**把整个文件当 Perl eval**：`latexmk.pl:4303-4323`，核心是 `open(...) ... eval $code;`（第 4323 行）。
5. 插件从未传 `-norc`（全仓无该字符串）；`respectLatexmkrc` 只控制 engine flag（`src/config.js:36`、`src/config.js:108`；`src/build.js:199`），README:68 的表述“With a project `.latexmkrc`, the configured engine flag is not forced”本身没错，但 README:111 把它说成“keep their recipe”，弱化了“这是可执行代码”。

触发条件：项目根存在 `.latexmkrc`（内容任意 Perl，例如 `system("calc.exe")` 或读文件外发），用户/模型对该项目调用 `latex_compile` 或自动构建触发。默认 `autoBuild: true`（`cordis.patch.yml:25`），所以打开项目后保存一个 `.tex` 也可能触发。

**影响**：以 DSH Host 进程权限执行任意代码，绕过 `argv`/`no shell` 的全部保证；可读写任意文件、起网络连接、改 profile/插件源码。

**建议（Lead 修）**：

- 默认传 `-norc`；只有显式配置 `trustProjectLatexmkrc: true`（默认 false）时才允许项目 rc。
- 若要保留“项目自定义构建配方”，也必须把这个开关描述成“允许执行项目代码”，而不是“尊重项目配置”。
- 在没有 `-norc` 的旧行为下，至少对 `allowedRoots` 之外/首次见到的项目拒绝自动构建。

### SEC-04 `.tex` 任意文件读取并外带到日志/PDF（High）

本机 kpathsea 配置：

```
$ kpsewhich -var-value=openin_any
a
$ kpsewhich -var-value=openout_any
p
```

`openin_any=a` 表示 TeX 可以打开任意路径（绝对路径、`..` 都允许）。`openout_any=p` 只限制写，不限制读。

恶意 `.tex` 的最小链路：

```tex
\openin\f=C:/Users/86132/.ssh/id_rsa
\read\f to \x
\typeout{SECRET:\x}
```

- `\typeout` 写入 `.log`；
- 构建结束插件读取 `.log`（`src/build.js:289-295`），`src/logparse.js` 解析为诊断（消息截断 2000 字符，`src/logparse.js:158`），`src/tools.js:31-79` 原样拼进给模型的工具结果；
- 失败时 `service.readLog` 还会返回最多 512 KiB 日志（`src/service.js:696-710`），`/latex/log` 同理（`src/routes.js:318-330`）；
- 成功时 `\input{secret}` 的内容也会被排版进 PDF，预览页可直接看到。

对“模型被诱导构建恶意仓库”的场景，这是从**数据文件**获得任意读能力的实际路径；虽然模型本来也有文件工具，但恶意项目不应凭空获得该能力，而且日志会进入模型上下文，构成间接提示注入通道（SEC-14）。

**建议**：在文档中把“构建不可信项目”明确等同于“运行不可信代码”；高风险场景用独立低权限用户/容器/VM 构建，或设置 `openin_any=p` 与 `TEXMFCNF` 受限配置；至少不要宣称“no shell 所以安全”。

### SEC-05 `.tex` 可在项目根内覆盖文件（Medium）

`openout_any=p` 阻止绝对路径和 `..`，但允许相对 cwd 的写。latexmk 的 cwd 是项目根（`src/build.js:237`），因此恶意 `.tex` 可用 `\openout` 覆盖项目根内相对路径的文件，例如：

- `.latexmkrc`（写入后下一次构建即 SEC-03 的代码执行）；
- 已经读取结束、被 TeX 关闭的 `\input` 子文件；
- 项目根内其他可写文件。

注意：TeX 会拒绝写入当前仍处于打开状态的输入文件，所以“覆盖正在读取的 `main.tex`”并不总是成功；但 `.latexmkrc` 这类未被 TeX 打开的文件不受此限制。

这直接反驳 README:113-114 的“Build output is confined to `<project>/<buildDir>`”。`-outdir=build` 只控制 latexmk/TeX 默认输出，不控制显式 `\openout`。

**建议**：文档改为“默认输出在 buildDir；TeX 本身仍可在项目根相对路径写文件”；对不可信项目使用只读挂载/副本目录构建（构建后比对/丢弃副本）。

### SEC-06 `% !TEX root` 绕过 `allowedRoots`（High，条件）

`allowedRoots` 的检查函数是 `ProjectResolver.assertAllowed()`（`src/project.js:599-612`），但 `% !TEX root` 分支直接构造并返回，**没有调用它**：

```js
// src/project.js:482-495
if (magic.root) {
  const rootCandidate = path.resolve(path.dirname(file), magic.root);
  ...
  if (rootInfo?.isFile()) {
    return { rootDir: path.dirname(withExt), mainFile: withExt, source: 'magic', ... };
  }
```

对照其他入口：

- 显式 `mainFile`：`src/project.js:425-426` 调用了 `this.assertAllowed(mainFile)`；
- 反向引用/搜索：`#success()` 内 `src/project.js:544-554` 调用；
- 只有 magic 分支漏了。

触发：`allowedRoots=D:\allowed`，`D:\allowed\chapter.tex` 里写 `% !TEX root = D:\outside\main.tex`（或 `..\..\outside\main.tex`），且目标存在。之后 `rootDir` 变成 `D:\outside`，build 的 cwd、buildDir、`.latexmkrc` 全在 allowlist 之外。若 `D:\outside\main.tex` 所在目录有恶意 `.latexmkrc`，即 SEC-03 的跨边界版本。

当前 profile 的 `allowedRoots` 为空（`cordis.patch.yml:37`；profile 无覆盖），所以**今天没有可绕过的边界**；但一旦管理员按文档启用 allowlist，这个控制是 fail-open 的。

**建议**：magic 分支 resolve 后立即 `this.assertAllowed(withExt)`；同时把 `rootDir` 也纳入检查；`assertAllowed` 用 `fs.realpath` 处理符号链接（SEC-18）。

### SEC-07 `allowedRoots` 不是文件系统沙箱（Medium）

即使修复 SEC-06，`allowedRoots` 也只约束“主文件路径”，不约束构建过程读取/写入的内容：

- `.tex` 可以 `\input{..\..\secret}`、`\includegraphics{C:/...}` —— `openin_any=a`（SEC-04）；
- `chooseScanRoot()` 会从文件目录向上走最多 4 层（`src/project.js:198-225`），并可能索引 `MAX_INDEX_FILES=6000` 个 `.tex`（`src/project.js:60`、`src/project.js:149-175`），这些文件可能在 allowlist 之外；虽然候选主文件最终会被 `#success` 拒绝，但**读取已经发生**，且歧义错误会列出外部路径（`src/project.js:523-527`）；
- `input.cwd` 本身不受 `assertAllowed` 约束（`src/project.js:381`），会先扫描再拒绝；
- `% !TEX root` 支持 UNC（`\\server\share\main.tex`）：`path.resolve` 保留 UNC，`stat()` 会触发 SMB 连接，可能向攻击者服务器发起 NTLM 认证（凭据中继/泄漏），即使文件不存在也会先发起连接；
- `path.resolve` 不做 `realpath`：allowlist 内的符号链接/junction 可指向外部。

**建议**：在文档中把 `allowedRoots` 定义成“项目入口白名单（防误操作）”，不是安全边界；若要做边界，需要 realpath + 拒绝 UNC/设备路径 + 构建沙箱。

### SEC-08 SyncTeX 的 `file` 参数未做 root 约束（Medium-Low）

`service.syncTeX` 的 forward 分支：

```js
// src/service.js:852-857
const file = args.file
  ? path.resolve(project.rootDir, String(args.file))
  : project.mainFile;
...
argv = [synctex, 'view', '-i', `${line}:${column}:${file}`, '-o', pdf];
```

没有 `isInside(project.rootDir, file)`，也没有 `assertAllowed`。工具参数 `file` 直接来自模型（`src/tools.js:442`、`src/tools.js:454-457`），HTTP `/latex/synctex?file=` 同样（`src/routes.js:384-391`）。

实测证据（工作区根执行）：

```
latex_synctex(path: latex-plugin-tests/synctex/main.tex, direction: forward, line: 1)
→ SyncTeX forward: page 1 at (125.798264, 140.742218)

latex_synctex(path: latex-plugin-tests/synctex/main.tex, direction: forward,
              file: ../../../../Windows/win.ini, line: 1)
→ SyncTeX forward lookup found no PDF location.
  This is SyncTeX command line utility, version 1.5
  SyncTeX Warning: No tag for D:\Windows\win.ini
```

说明 `..` 被 resolve 到 `D:\Windows\win.ini` 并传给了 synctex。synctex `view` 主要是按 `.synctex` 记录匹配路径，通常不读源文件内容，所以影响有限；但这是可观测的路径边界缺口，且错误文本会把绝对路径回显给模型/客户端。

**建议**：`file` 先 `path.resolve`，再 `isInside(project.rootDir, file)`（或至少拒绝 `..`/绝对路径）；不满足则返回明确错误。

### SEC-09 `/latex/pdf` 只服务注册项目的 preview —— 通过（附链接说明）

- 路由不接受任意路径参数，只接受 `project`/`session`/`cwd`，最终由 `pickProject()` 在 `service.projects` 中查表（`src/routes.js:152-173`、`src/routes.js:289-291`）。
- `target = project.paths.previewPath`，由 `projectPaths()` 固定推导：`<root>/<buildDir>/.dsh-latex/preview.pdf`（`src/build.js:147-163`）。
- 双重 `isInside` 检查：`src/routes.js:297-300`。
- `content-type: application/pdf`、`nosniff`、`cache-control: no-store`、固定 filename（`src/routes.js:301-307`），没有用户可控 header。
- 未鉴权探测 `GET /latex/pdf?project=../../../../Windows/win.ini` 在 admit 阶段即 401（§6），不会走到文件系统。

**注意事项**：`stat(target)` 与 `createReadStream(target)` 都会跟随符号链接，而 `isInside` 是词法比较（`src/util.js:19-24`）。如果 `build/.dsh-latex/preview.pdf` 被预先放置为指向外部文件的符号链接，且尚未发生新构建，路由会把目标文件当 PDF 返回。Git 在 Windows 上创建符号链接需要额外条件，利用门槛高，但建议 `realpath` 后再 `isInside`，或 `lstat` 拒绝链接（SEC-18）。

另外路由只 `stat` 文件存在，不检查 `previewVersion > 0`；文件存在即服务。这与“last-good”语义一致，但“存在”不等于“本插件发布过”。

### SEC-10 `clean` 边界 —— 通过

- 起点固定 `project.paths.buildDirAbs`（`src/build.js:503`），每个绝对路径再过 `isInside`（`src/build.js:514`）。
- 只删除 `AUX_EXTENSIONS` 白名单后缀或 build 目录内的 `.latexmkrc`（`src/build.js:522-532`）；`.pdf` 只有 `includePdf === true` 才删（`src/build.js:524-531`）。
- `includePdf` 只作用于 build 目录内的 PDF，不会删项目根源码 PDF；`includePreview` 只删 `preview.pdf` 与 `last-build.json`（`src/build.js:541-550`、`src/service.js:685-691`）。
- 不会向上删除源码；`clean` 不传 `buildDir` 之外的东西。
- 小瑕疵：`includePdf` 会删 build 目录里**所有** `.pdf`（包括用户手工放进去的无关 PDF），与描述“delete the built PDF”略有出入；可接受但应写清。
- 链接风险同 SEC-18：`clean` 没有显式 `entry.isSymbolicLink()` 跳过；`Dirent.isDirectory()` 对 junction 的行为需要平台确认。词法 `isInside` 对“junction 指向外部 + 词法路径仍在 build 下”的情况可能放行，理论上可删到 build 目录之外。

### SEC-11 HTTP 鉴权 —— 通过（`/latex/health` 例外）

- `admit()` 在解析 URL 之后、所有业务路由之前执行（`src/routes.js:263`）；除 `GET /latex/health` 外无例外。
- 未准入返回 401/403 + `connection: close`（`src/routes.js:137-144`），不泄漏内部错误。
- 实测：无 cookie 的 `/latex/state` → 401；`Origin: https://evil.example` + `Sec-Fetch-Site: cross-site` 的 `/latex/state` → 403；`/latex/pdf?project=...` → 401（§6）。
- DSH 的 `connection.admit` 校验 host-only/HttpOnly/SameSite=Strict 的签名 cookie，Host 必须是 loopback/绑定 IP/`trustedHosts`，带 Origin 时必须同 authority，`Sec-Fetch-Site: cross-site` 拒绝（`docs/api-cheatsheet.md:589,596,667`）。

**CSRF**：`/latex/action` 只接受 `content-type: application/json`（`src/routes.js:67-74`），表单/`text/plain` 无法直接触发；跨站 `fetch` 会 preflight，而路由不应答 CORS。SameSite=Strict cookie 也不会随跨站请求发送。结论：没有可用的 CSRF 路径。

### SEC-12 `/latex/health` 未鉴权且不校验 Host（Low-Medium）

```js
// src/routes.js:252-261
// Health is deliberately unauthenticated: it is loopback-only...
if (pathname === '/latex/health' && method === 'GET') {
  sendJson(res, 200, await service.health());
}
```

`service.health()`（`src/service.js:901-915`）返回：

- `pid`、`startedAt`、`projects` 数量；
- `toolchain`：`binDir`、`latexmk`、7 个工具的**绝对路径**、`missing`、`checkedAt`。

实测（§6）无 cookie 直接 200，且带 `Host: evil.example` 仍 200。因为 health 在 `admit()` 之前返回，`connection.admit` 的 Host/Origin 校验对它完全无效。

**影响**：DNS rebinding 页面（同端口）可读取本机 DSH 进程 pid、TeX 安装路径、项目数量；为后续攻击提供指纹。不能读项目内容/PDF，因为那些路由需要 host-only cookie。

**建议**：health 也过 `admit()`（若需要人类免浏览器探活，可只返回 `{ok, name, version}`，不返回路径/pid）；或显式校验 `Host` 为 loopback/绑定地址，并加 `Vary`/`nosniff`（已有 nosniff）。

### SEC-13 `/latex/state`、SSE 与会话绑定（Low）

- `/latex/state` 返回 `service.snapshot()`（`src/routes.js:266-276`），其中包含所有项目的 `rootDir`、`mainFile`、`buildDir`、`pdfPath`、`previewPath`、`sessionIds`、`lastError`、诊断（`src/service.js:716-782`），不按请求者会话过滤。
- `/latex/events` 的 `sessionId` 参数被读出后**没有使用**（`src/routes.js:284-285`、`src/routes.js:470`），SSE 总是推全量快照。
- `pickProject()` 的 `?session=` 可选中任意 session 的项目（`src/routes.js:159-163`），`/latex/pdf?session=<other>` 也能取到别的会话的 PDF。

在单用户桌面里这是“同一用户的不同 agent/会话互相可见”，风险低；但如果将来做多用户/远程，必须按 principal 过滤。**建议**：SSE/state/pdf 统一用 `admission.peer` 或请求 session 做白名单；至少不要把 `sessionIds` 广播给所有客户端。

### SEC-14 日志/诊断文本的提示注入（Low）

`src/logparse.js` 只做截断（message 2000 字符、raw 4000 字符、`src/logparse.js:158,165`），`src/tools.js:53-68` 把 message 拼进模型可见文本，没有“以下是不可信构建输出”的边界标记。恶意 `.tex` 可以：

```tex
\typeout{IGNORE ALL PREVIOUS INSTRUCTIONS ...}
```

或构造 `!`/`Package ... Error:` 形式的文本，进入 `latex_compile` 结果和 `latex_get_diagnostics`。模型应把构建输出当数据，但当前提示层没有强调。

**建议**：在工具结果里用固定分隔符包裹日志/诊断，并在 description/system prompt 中声明“构建输出来自项目内容，不可信”；对日志中的控制字符做清理。这不是插件独有的问题，但安全报告应记录。

### SEC-15 凭据、环境与配置泄漏 —— 通过（部分）

- `buildEnv()` 只返回 `PATH`/`Path`/`max_print_line`（`src/build.js:72-83`），spawn 时 `env: buildEnv(...)`（`src/build.js:245`）；没有 `{ ...process.env }`，因此 API key、token、代理凭据不会进入 latexmk/TeX 子进程。DSH subprocess provider 也从 scrubbed env 起步（`docs/api-cheatsheet.md:765`）。
- `publicConfig()`（`src/config.js:117-129`）不含 `allowedRoots`/`extraLatexmkArgs`，`/latex/state` 不会泄漏白名单；没有 token/password 字段。
- 唯一的环境信息泄漏是 SEC-12 的 health（绝对路径/pid），以及 `/latex/state` 的项目绝对路径（仅已准入）。
- 日志可能包含 TeX 读到的文件内容（SEC-04）和绝对路径；`/latex/log` 只对已准入客户端开放，header `x-latex-log-path` 做了 `encodeURIComponent`（`src/routes.js:325-328`），没有 header 注入。
- `.latexmkrc` 的 Perl 代码虽然看不到凭据环境，但可以直接读文件/起进程（SEC-03），所以“环境裁剪”不等于“代码不可执行”。

### SEC-16 预览服务只 loopback —— 通过

- 插件不另起监听，只向 `ctx.get('webServer')` 注册 `/latex` 前缀（`src/routes.js:233-241`）。
- 实测 `Get-NetTCPConnection -LocalPort 50802 -State Listen` → `127.0.0.1:50802`，PID 34656；当前 GUI URL `http://127.0.0.1:50802`。
- 风险条件：如果 profile/DSH 改成 `0.0.0.0` 绑定，SEC-12 的 health 会暴露到局域网；其余路由仍受 cookie 保护，但 DSH 页面本身一旦可访问，攻击者也能获得 cookie（这是 DSH 的模型，不是插件能修的）。文档应写“安全前提是 webServer 绑定 loopback”。

### SEC-17 资产与 PDF.js —— 通过（附供应链说明）

- `ASSET_NAMES` 是硬编码白名单（`src/routes.js:28`），`path.join(ASSET_DIR, name)` 不接受用户拼接（`src/routes.js:332-361`）；`..`/编码穿越在精确匹配处即 404。
- 资产路由在 `admit()` 之后（`src/routes.js:332`），与主页面同源；没有 CORS/CDN。
- 实测版本：`pdfjsVersion = 5.4.296`，文件 419,107 bytes / 1,046,529 bytes，`assets/licenses/PDFJS-NOTICE.txt` 标注 Apache-2.0。
- `client.js:1120-1125` 用静态字面量 `import('/latex/assets/pdf.min.mjs')`，worker 设为同源 `/latex/assets/pdf.worker.min.mjs`；`client.js:1220` 传 `isEvalSupported: false`，关闭 PDF.js 的 eval 路径（对 CVE-2024-4367 类字体 eval 有缓解意义）。
- 残余：PDF.js 是解析不可信 PDF 的复杂第三方代码，必须跟随上游安全更新；当前是手工从本机 Cursor 目录复制的 5.4.296，没有版本清单/校验和。建议在 README/升级流程中记录来源、版本、更新方式。

### SEC-18 符号链接与词法 `isInside`（Low）

`isInside()`（`src/util.js:19-24`）只做 `path.relative`，不 `realpath`：

- `allowedRoots`：allowlist 内的符号链接/junction 可指向外部（SEC-06/07）。
- `clean`：`readdir` 的 `Dirent` 对符号链接通常 `isFile()/isDirectory()` 为 false，会跳过；但 junction 在 Windows 上的 `Dirent` 行为需要实测，且词法 `isInside` 对“路径仍显示在 build 下、实际指向外部”的情况会放行。建议显式 `lstat`/`realpath`。
- `/latex/pdf` 与 `#findOutputPdf`：`stat()` 跟随链接（`src/routes.js:292`、`src/build.js:470`），`createReadStream` 也会跟随。需要 `lstat` 或 `realpath` 后再做边界检查。

### SEC-19 超时/取消/健壮性（Low）

- `timeoutMs` 工具参数无上限：`src/build.js:213` 只做 `Math.max(5_000, Number(...) || config.timeoutMs)`，没有上限。`Infinity`/`1e309`（JSON 可解析为 Infinity）会进入 `setTimeout(Infinity)`，Node 会按 1ms 处理并告警，导致“刚启动就超时”。建议 `Math.min(config.timeoutMs 上限或 24h, ...)`。
- `cancel()` 在 `#runOne` 已经 `building=true` 但还在 `await semaphore.acquire()` 时，`project.abortController` 尚未赋值（`src/service.js:468-470`），取消只能把状态改成 `cancelling`，不能中止等待；全局并发满时表现为“取消无效”。不是安全问题，但影响“取消必成功”的验收。
- `service.readLog()` 先整文件 `readFile` 再 `tailText`（`src/service.js:702-704`），没有像 `#readOptional` 那样的 32MB 上限；超大 `.log` 可造成内存压力。建议按大小截断或流式读尾部。

### SEC-20 安装形态与代码完整性（Low）

- profile 用 `link:`/符号链接指向工作区（实测 `...\node_modules\dsh-latex -> D:\deepseekharness\latex-plugin`）。
- 任何能写 `D:\deepseekharness\latex-plugin` 的进程/agent 都能改 `index.js`/`client.js`，从而在 Host 进程和 DSH 页面 origin 执行代码。DSH 桌面版本身就是高权限 agent 环境，这是开发态可接受但生产前应收紧的完整性风险。
- `package.json` 没有依赖、没有 install/postinstall 脚本（`package.json:1-39`），供应链面很小；PDF.js 是唯一第三方二进制资产。

## 4. 任务 6.3 对照表

| 6.3 条款 | 结论 | 证据/说明 |
| --- | --- | --- |
| 进程调用纯 argv | **PASS** | `src/build.js:190-246`；DSH `subprocess.spawn` 只有 argv（`docs/api-cheatsheet.md` E.1） |
| 无 shell-escape | **RISK（Medium）** | 插件不加 `-shell-escape`，但本机 `shell_escape=p` 且不传 `-no-shell-escape`（SEC-02） |
| `.tex` 内容能否逃逸路径 | **FAIL（High）** | `openin_any=a`（SEC-04）、`% !TEX root` 绕过 allowedRoots（SEC-06）、UNC（SEC-07） |
| 工具参数能否逃逸路径 | **PARTIAL** | resolver 对主文件有 `assertAllowed`（`src/project.js:426,545`），但 syncTeX `file` 无约束（SEC-08）；`allowedRoots` 当前为空 |
| `/latex/pdf` 只服务注册项目 preview | **PASS**（链接 caveat） | `src/routes.js:152-173,289-316`；实测未鉴权 401 |
| `clean` 是否可能删源码/PDF | **PASS** | 只遍历 buildDir、后缀白名单、`includePdf` 只删 build 内 PDF（SEC-10）；junction/符号链接 caveat |
| SSE/资产路由边界 | **PASS**（Low caveat） | 全部 admit；资产白名单（`src/routes.js:28,332-361`）；SSE 忽略 session（SEC-13） |
| 日志/配置泄漏凭据 | **PARTIAL** | 无凭据；env 裁剪；health 泄漏绝对路径/pid（SEC-12）；日志可含 TeX 读到的秘密（SEC-04） |
| 预览服务只 loopback | **PASS** | 实测 `127.0.0.1:50802`；插件无第二监听（SEC-16） |
| `allowedRoots` 实际效果 | **FAIL（条件）** | 只约束主文件；magic 分支漏检；非沙箱（SEC-06/07） |

## 5. 修复建议（按优先级，供 Lead 实施；本报告未改源码）

**P0（安全语义，建议下个版本前）**

1. 默认 `-norc`；新增 `trustProjectLatexmkrc`（默认 false），只有显式开启才允许项目 `.latexmkrc`；文档把 `.latexmkrc` 描述为“可执行 Perl 代码”。（SEC-03）
2. `% !TEX root` 返回值前 `assertAllowed()`；`assertAllowed` 用 `realpath`，拒绝 UNC/设备路径。（SEC-06/07）
3. 默认 `-no-shell-escape`（`latexmk.pl:653-654` 支持），需要时显式 opt-in。（SEC-02）
4. README/文档改写安全声明：删除“build output confined to buildDir”“no shell 即安全”的暗示；明确“不可信项目 = 不可信代码”。（SEC-03/04/05）

**P1（边界与鉴权）**

5. `service.syncTeX` 对 `file` 做 `isInside(project.rootDir, ...)`；HTTP `/latex/synctex?file=` 同样。（SEC-08）
6. `/latex/health` 也过 `admit`，或只返回 `{ok,name,version}`；校验 Host 为 loopback/绑定地址。（SEC-12）
7. `/latex/state`、SSE、`pickProject(?session=)` 按 `admission.peer`/session 过滤；不要在快照里广播 `sessionIds`。（SEC-13）
8. 清理/PDF 路由对 `preview.pdf`、build 内文件使用 `lstat`/`realpath`，拒绝链接越界。（SEC-09/10/18）

**P2（健壮性与文档）**

9. `timeoutMs` 加上限（如 24h），避免 `Infinity`/1e309 变 1ms；等待 semaphore 的阶段也允许取消。（SEC-19）
10. `readLog` 先 `stat` 限制大小或只读尾部；`clean` 显式跳过 `entry.isSymbolicLink()`。（SEC-10/19）
11. 工具结果用固定分隔符包裹日志/诊断，并在提示中声明其不可信。（SEC-14）
12. PDF.js 建立版本/来源/更新记录，定期跟随上游安全版本。（SEC-17）
13. 生产安装改为打包/只读目录，避免 `link:` 到可写工作区。（SEC-20）

## 6. 复现证据（本次实际执行）

以下命令/调用均只读，未写插件源码或 profile。

### 6.1 监听地址与 profile 链接

```text
PS> Get-NetTCPConnection -LocalPort 50802 -State Listen
LocalAddress LocalPort State  OwningProcess
127.0.0.1    50802     Listen 34656

PS> Get-ChildItem C:\Users\86132\.dsh -Recurse -Filter dsh-latex ...
C:\Users\86132\.dsh\profiles\desktop\node_modules\dsh-latex | LinkType=SymbolicLink | Target=D:\deepseekharness\latex-plugin
```

### 6.2 `/latex/health` 未鉴权 + Host 不校验

```text
$ curl -i http://127.0.0.1:50802/latex/health
HTTP/1.1 200 OK
{"ok":true,"name":"dsh-latex","version":"0.1.0","pid":34656,"startedAt":1793694010266,"projects":7,
 "toolchain":{"binDir":"D:\\latex\\texlive2023\\texlive\\2023\\bin\\windows",
 "latexmk":"D:\\latex\\texlive2023\\texlive\\2023\\bin\\windows\\latexmk.exe", ...}}

$ curl -i -H 'Host: evil.example' http://127.0.0.1:50802/latex/health
HTTP/1.1 200 OK
（同上，仍返回路径/pid）
```

### 6.3 鉴权边界

```text
$ curl -i http://127.0.0.1:50802/latex/state
HTTP/1.1 401 Unauthorized
{"error":"request refused"}

$ curl -i 'http://127.0.0.1:50802/latex/pdf?project=../../../../Windows/win.ini'
HTTP/1.1 401 Unauthorized
{"error":"request refused"}

$ curl -i -H 'Origin: https://evil.example' -H 'Sec-Fetch-Site: cross-site' \
       http://127.0.0.1:50802/latex/state
HTTP/1.1 403 Forbidden
{"error":"request refused"}
```

### 6.4 TeX Live 安全配置

```text
$ kpsewhich -var-value=shell_escape
p
$ kpsewhich -var-value=shell_escape_commands
bibtex,bibtex8,extractbb,gregorio,kpsewhich,makeindex,repstopdf,r-mpost,texosquery-jre8,
$ kpsewhich -var-value=openin_any
a
$ kpsewhich -var-value=openout_any
p

$ latexmk --version
Latexmk, John Collins, 7 Jan. 2023. Version 4.79
```

### 6.5 `.latexmkrc` 被当 Perl 执行

```text
$ grep -n 'auto_rc_use' latexmk.pl | head
1238:$auto_rc_use = 1;
1942:if ( $auto_rc_use ) {
2053:      $auto_rc_use = 0;     # -norc

$ sed -n '4303,4323p' latexmk.pl
...
        my $BOM = Encode::encode( 'UTF-8', "\N{U+FEFF}" );
        $code =~ s/^$BOM//;
        eval $code;
```

对应源码路径：`D:\latex\texlive2023\texlive\2023\texmf-dist\scripts\latexmk\latexmk.pl`。

### 6.6 SyncTeX 路径越界

```text
latex_synctex(path: latex-plugin-tests/synctex/main.tex, direction: forward, line: 1)
→ SyncTeX forward: page 1 at (125.798264, 140.742218)

latex_synctex(path: latex-plugin-tests/synctex/main.tex, direction: forward,
              file: ../../../../Windows/win.ini, line: 1)
→ SyncTeX forward lookup found no PDF location.
  This is SyncTeX command line utility, version 1.5
  SyncTeX Warning: No tag for D:\Windows\win.ini
```

### 6.7 PDF.js 资产

```text
assets/pdf.min.mjs          419107 bytes
assets/pdf.worker.min.mjs  1046529 bytes
grep: pdfjsVersion = 5.4.296
assets/licenses/PDFJS-NOTICE.txt: Apache-2.0 notice
```

## 7. 未覆盖与限制

- 本报告没有实际运行恶意 `.latexmkrc`、没有在 `allowedRoots` 非空的情况下复现 SEC-06（会需要改 profile/创建 fixture，超出本任务只读约束）。SEC-03/06/07 是**源码 + 运行环境**证据，不是攻击演示。
- 没有验证 junction 在 `readdir`/`Dirent` 下的具体行为（SEC-10/18），需要在允许创建链接的测试目录里实测。
- 没有审计 PDF.js 5.4.296 的已知 CVE 列表；只确认了版本、来源与 `isEvalSupported: false`。
- 没有覆盖 DSH Host 的 `connection`/`webServer`/`subprocess` 实现本身（只引用 `docs/api-cheatsheet.md` 的契约与实测行为）。
- 没有重启 DSH、没有改插件/profile、没有做 UI 像素验证。
