# TeX Live 2023 环境审计报告（env-audit）

- 审计对象：`D:\latex\texlive2023\texlive\2023`（TeX Live 2023，Windows）
- 审计时间：2026-11-03 15:47–16:05（+08:00）
- 执行环境：Windows 11 build 26200；MSYS/Git Bash（MINGW64_NT-10.0-26200）；工作区 `D:\deepseekharness`
- 方法：全部结论来自本机真实命令执行（绝对路径调用、记录退出码与原始输出）；未安装、未修改任何 TeX Live 文件
- 原始日志：`D:\deepseekharness\latex-plugin\docs\env-audit-logs\`（37 个文件，251 KB，逐条对应下文）
- 可复用 fixtures：`D:\deepseekharness\latex-plugin-tests\`

> 本报告只写"实测到的事实"。未测试的内容集中列在第 13 节，不做推断性断言。

---

## 0. 结论摘要

1. TeX Live 2023 完整可用：XeLaTeX / pdfLaTeX / LuaLaTeX / BibTeX / Biber / SyncTeX / kpsewhich 全部真实跑通。
2. **`latexmk.exe` 可以独立工作，不需要外部 Perl，也不需要把 TeX Live 加进 PATH。**
   它是 runscript 包装器（6144 B，与 `runscript.exe` 的 MD5 完全相同），内部固定使用
   `D:\latex\texlive2023\texlive\2023\tlpkg\tlperl\bin\perl.exe`（Perl 5.34.0），
   并把 `bin\windows`、`tlpkg\tlgs\bin`、`tlpkg\tlperl\bin` 预置进子进程 PATH。
   实测调用方 `PATH=""` 与 `PATH` 完全未设置时，`latexmk -xelatex` 仍 exit 0 并产出 PDF。
3. 唯一需要 PATH 的场景是**绕过包装器直接执行** `perl.exe latexmk.pl`：此时必须把
   `...\bin\windows` 加进 PATH，否则 exit 12。
4. 推荐调用（XeLaTeX）：
   `latexmk.exe -xelatex -synctex=1 -interaction=nonstopmode -file-line-error -outdir=build main.tex`
   pdfLaTeX 用 `-pdf`，LuaLaTeX 用 `-lualatex`。
5. 关键退出码：成功 `0`；LaTeX 编译失败 `12`；输出/aux 目录创建失败 `22`。
6. 中文（ctex + XeLaTeX）、含空格+中文的目录、绝对/含空格的 `-outdir`、`-cd` 均实测通过。
7. 最大坑：`latexmk.exe` 只是壳，进程树是 `latexmk.exe → perl.exe → xelatex.exe`；
   **只杀 latexmk.exe 会留下 perl/xelatex 孤儿进程**，必须 `taskkill /PID <pid> /T /F` 或 Job Object。
8. `-auxdir=aux` 在本机直接失败（`aux` 是 Windows 保留设备名，exit 22）；`-auxdir` 在 TeX Live 上还会
   改变引擎的 `-output-directory`，不建议使用。只用 `-outdir`。
9. `latexmk -C` 安全边界：只删它跟踪的产物（含最终 PDF、`.synctex.gz`），不删未跟踪文件；
   **默认保留 `.bbl`**（`$bibtex_use=1`），也不删除 `build` 目录本身。
10. `synctex view/edit` 全部 exit 0，包括"找不到 tag"和"页码越界"的失败场景 —— 必须解析 stdout，不能只看退出码。

---

## 1. 安装布局

| 项 | 路径 / 值 |
| --- | --- |
| TeX Live 根 | `D:\latex\texlive2023\texlive\2023` |
| bin 目录 | `D:\latex\texlive2023\texlive\2023\bin\windows` |
| 内置 Perl | `D:\latex\texlive2023\texlive\2023\tlpkg\tlperl\bin\perl.exe`（5.34.0） |
| latexmk 脚本 | `D:\latex\texlive2023\texlive\2023\texmf-dist\scripts\latexmk\latexmk.pl`（471 288 B） |
| tlmgr | `...\bin\windows\tlmgr.bat`（无 tlmgr.exe）；`tlmgr.bat --version` exit 0 |
| 安装版本 | tlmgr revision 66457 (2023-03-08)，TeX Live 2023 |
| kpsewhich 变量 | `TEXLIVE_WINDOWS_TRY_EXTERNAL_PERL=0` |
| TEXMFCACHE | `D:/latex/texlive2023/texlive/2023/texmf-var; C:/Users/86132/.texlive2023/texmf-var` |

`tlmgr.bat --version` 原始输出：

```
tlmgr revision 66457 (2023-03-08 00:07:12 +0100)
tlmgr using installation: D:/latex/texlive2023/texlive/2023
TeX Live (https://tug.org/texlive) version 2023
```

## 2. 工具清单与版本（全部 exit 0）

| 工具 | 绝对路径（bin 目录下） | 版本输出首行 | 实测 |
| --- | --- | --- | --- |
| latexmk | `latexmk.exe` | `Latexmk, John Collins, 7 Jan. 2023. Version 4.79` | ✔ `-v` exit 0 |
| XeLaTeX | `xelatex.exe` | `XeTeX 3.141592653-2.6-0.999995 (TeX Live 2023)` | ✔ 编译通过 |
| pdfLaTeX | `pdflatex.exe` | `pdfTeX 3.141592653-2.6-1.40.25 (TeX Live 2023)` | ✔ 编译通过 |
| LuaLaTeX | `lualatex.exe` | `This is LuaHBTeX, Version 1.16.0 (TeX Live 2023)` | ✔ 编译通过 |
| BibTeX | `bibtex.exe` | `BibTeX 0.99d (TeX Live 2023)` | ✔ 文献编译通过 |
| Biber | `biber.exe`（31 736 755 B） | `biber version: 2.19` | ✔ biblatex 编译通过 |
| kpsewhich | `kpsewhich.exe` | `kpathsea version 6.3.5` | ✔ |
| SyncTeX | `synctex.exe`（445 952 B） | `Synchronize TeX... client, version 1.21`；banner 又称 utility 1.5 | ✔ view/edit 通过 |
| Perl | `...\tlpkg\tlperl\bin\perl.exe` | `perl 5, version 34, subversion 0 (v5.34.0) built for MSWin32-x64-multi-thread` | ✔ |

注意：`latexmk.exe`、`xelatex.exe` 等只有 6144 B —— 它们是 TeX Live 的启动器壳，真正的逻辑在 DLL/Perl 脚本里；这不影响使用。

`latexmk.exe -v` 原始输出（exit 0）：

```
Initial Win CP for (console input, console output, system): (CP936, CP936, CP936)
I changed them all to CP936
Latexmk, John Collins, 7 Jan. 2023. Version 4.79
```

**注意前两行 CP936 噪音**：每次经 runscript 包装器启动（latexmk、tlmgr 等）都会打印这两行，
它们不是 latexmk 的输出，解析时应跳过或容忍。

## 3. Perl、runscript 包装器与 PATH 要求（核心结论）

### 3.1 latexmk.exe 是 runscript 壳

- `latexmk.exe` 与 `runscript.exe` 大小同为 6144 B，MD5 均为 `efcb1972fcc102c6948415128eefcf2b`。
- 失败时它会在 stderr 追加自己的报错行，例如：
  `D:\latex\texlive2023\texlive\2023\bin\windows\runscript.tlu:921: command failed with exit code 12:`
  下一行是被执行的真实命令：`perl.exe d:\...\latexmk.pl -xelatex ...`。

### 3.2 使用哪个 Perl

`runscript.tlu` 的逻辑（本机源码，行号为实测）：

- `TEXLIVE_WINDOWS_TRY_EXTERNAL_PERL` 只有显式设为 `1` 时才尝试外部 Perl（第 649 行）。
- 本机该变量为 `0`，因此**永远使用内置 Perl**：`TEXDIR/tlpkg/tlperl/bin/perl.exe`（第 661 行），
  同时设置 `PERL5LIB`，并把 `TEXDIR/tlpkg/tlperl/bin` 前置到 PATH（第 662–663 行）。
- 第 727 行还会把 `tlpkg/tlgs/bin` 和 **TeX Live bin 目录** 前置到 PATH。

用 `latexmk -e 'print STDERR "ENVPATH=[$ENV{PATH}]\n";' -v` 实测，调用方 PATH 中不含 TeX Live 时，
latexmk 进程内 PATH 为：

```
ENVPATH=[d:\latex\texlive2023\texlive\2023\bin\windows;d:\latex\texlive2023\texlive\2023\tlpkg\tlgs\bin;d:\latex\texlive2023\texlive\2023\tlpkg\tlperl\bin;E:\AppData\DeepSeekHarness\Home\profiles\desktop\node_modules\@dsh-ops\bash-win32-x64\usr\bin;C:\Windows\system32]
```

这解释了为什么"TeX Live 不在 PATH"也能编译：包装器给 latexmk 补了 PATH，latexmk 再用
`xelatex`/`bibtex`/`biber` 的裸名字启动它们。

### 3.3 三种调用方式实测

| 调用方式 | 调用方 PATH | 结果 |
| --- | --- | --- |
| `latexmk.exe -v` | 正常 PATH | exit 0 |
| `latexmk.exe -v` | `PATH=""` | exit 0 |
| `latexmk.exe -xelatex ... main.tex` | `PATH=""`（全新 build 目录） | **exit 0，生成 PDF** |
| `latexmk.exe -xelatex ... main.tex` | `env -u PATH` | **exit 0，生成 PDF** |
| `perl.exe latexmk.pl -pdf ...` | PATH 去掉 TL bin | **exit 12**（cmd 报 `pdflatex 不是内部或外部命令`，见 5.4） |
| `perl.exe latexmk.pl -pdf ...` | PATH 前置 TL bin | exit 0，生成 PDF |

结论：

- **首选**：绝对路径直接调 `latexmk.exe`，无需任何 PATH 配置。
- 若必须直接调 `perl.exe + latexmk.pl`（例如自建日志包装），必须把
  `D:\latex\texlive2023\texlive\2023\bin\windows` 放进 PATH；否则引擎、bibtex、biber 全部找不到。
- 为稳妥起见，插件也可以在 spawn 时显式把 TeX Live bin 前置到 PATH；这与包装器行为一致，无副作用（已实测）。

## 4. 推荐的 latexmk 调用方式（均在本次审计中真实成功）

统一参数：`-synctex=1 -interaction=nonstopmode -file-line-error -outdir=build`。

### XeLaTeX

```bat
"D:\latex\texlive2023\texlive\2023\bin\windows\latexmk.exe" ^
  -xelatex -synctex=1 -interaction=nonstopmode -file-line-error -outdir=build main.tex
```

### pdfLaTeX

```bat
"D:\latex\texlive2023\texlive\2023\bin\windows\latexmk.exe" ^
  -pdf -synctex=1 -interaction=nonstopmode -file-line-error -outdir=build main.tex
```

> `-pdflatex` 裸开关（不带 `=程序`）与 `-pdf` 等价，engines 首测即用该形式，exit 0 / 2.234 s。

### LuaLaTeX

```bat
"D:\latex\texlive2023\texlive\2023\bin\windows\latexmk.exe" ^
  -lualatex -synctex=1 -interaction=nonstopmode -file-line-error -outdir=build main.tex
```

### PowerShell

```powershell
& "D:\latex\texlive2023\texlive\2023\bin\windows\latexmk.exe" `
  -xelatex -synctex=1 -interaction=nonstopmode -file-line-error -outdir=build main.tex
```

### Node.js（插件推荐形态）

```js
spawn("D:\\latex\\texlive2023\\texlive\\2023\\bin\\windows\\latexmk.exe", [
  "-xelatex", "-synctex=1", "-interaction=nonstopmode",
  "-file-line-error", "-outdir=build", "main.tex",
], { cwd: projectDir, windowsHide: true });
```

要点：

- `-outdir=build` 是**单个 argv**（Node 里不要拆成 `-outdir` 和 `build`）。
- 路径含空格由 latexmk 自己加引号（实测 `-outdir="D:/dsh-tmp/tex-audit/out dir"` 成功）。
- 引擎选择必须用**裸开关** `-xelatex` / `-pdf` / `-lualatex`。
  **不要**用 `-pdflatex=<程序路径>` 代替 `-pdf`：实测该写法只设置程序名、不选择 PDF 模式，
  latexmk 会打印 `No specific requests made, so using default for latexmk.`，改用 `latex` 产出 DVI（exit 0）。
  （日志 `option-pdflatex-equals-program.log`）
- 不需要 `-cd` 当且仅当 cwd 就是主文档所在目录（见第 7 节）。

## 5. 退出码与输出形态

### 5.1 退出码（本机实测）

| 退出码 | 场景 | 证据 |
| --- | --- | --- |
| `0` | 编译成功；或已是最新（`All targets ... are up-to-date`） | 全部成功 fixture |
| `12` | 任意 LaTeX 编译错误 | `error-case`、`missing-pkg`、无 PATH 直调 perl |
| `22` | 输出/aux 目录创建失败 | `-auxdir=aux` |
| 无 | 被外部杀死（Stop-Process / taskkill） | 超时测试（未记录退出码） |

### 5.2 成功时的 stdout 结构

```
Initial Win CP for (console input, console output, system): (CP936, CP936, CP936)
I changed them all to CP936
Rc files read:
  NONE
Latexmk: This is Latexmk, John Collins, 7 Jan. 2023. Version 4.79.
Latexmk: making output directory 'build'
No existing .aux file, so I'll make a simple one, and require run of *latex.
Latexmk: applying rule 'xelatex'...
...
Running 'xelatex -no-pdf -synctex=1 -interaction=nonstopmode -file-line-error -recorder -output-directory="build"  "main.tex"'
...
Output written on build/main.xdv (1 page, 5252 bytes).
SyncTeX written on build/main.synctex.gz.
...
Latexmk: All targets (build/main.pdf) are up-to-date
```

注意：

- XeLaTeX 模式下 latexmk 实际执行 `xelatex -no-pdf` 两次 + `xdvipdfmx` 一次；
  引擎命令里的 `-output-directory="build"` 由 latexmk 注入，`-synctex=1` 等参数原样传递。
- XeLaTeX 的 PDF 由 `xdvipdfmx -E -o "build/main.pdf" "build/main.xdv"` 生成。
- pdfLaTeX / LuaLaTeX 直接产出 PDF，无 xdv 阶段。

### 5.3 编译错误时的 stdout（error-case，exit 12，1.519 s）

`error-case/main.tex` 第 4 行是 `\undefinedcommand`，stdout 与 `build/main.log` 都出现：

```
./main.tex:4: Undefined control sequence.
l.4 \undefinedcommand
```

stdout 收尾：

```
Latexmk: Errors, so I did not complete making targets
Collected error summary (may duplicate other messages):
  xelatex: Command for 'xelatex' gave return code 1
      Refer to 'build/main.log' and/or above output for details

D:\latex\texlive2023\texlive\2023\bin\windows\runscript.tlu:921: command failed with exit code 12:
perl.exe d:\...\latexmk.pl -xelatex -synctex=1 -interaction=nonstopmode -file-line-error -outdir=build main.tex
```

产物：`build/main.xdv`、`.aux`、`.log`、`.fls`、`.fdb_latexmk`、`.synctex.gz` 存在，**没有 PDF**。

可直接用于诊断的格式：`<相对路径>:<行号>: <LaTeX 错误文本>`，文件名带 `./` 前缀（按传入参数原样）。
`.log` 中行被 nonstopmode 折行的现象也存在（`[1` 换行 `]`），解析时需注意。

### 5.4 缺宏包时的输出（exit 12）

`\usepackage{nosuchpackage2023}`：

```
! LaTeX Error: File `nosuchpackage2023.sty' not found.

Type X to quit or <RETURN> to proceed,
or enter new name. (Default extension: sty)

Enter file name: 
./main.tex:3: Emergency stop.
...
./main.tex:3:  ==> Fatal error occurred, no output PDF file produced!
```

latexmk 追加：

```
Latexmk: Missing input file 'nosuchpackage2023.sty' (or dependence on it) from following:
  ! LaTeX Error: File `nosuchpackage2023.sty' not found.
...
Collected error summary (may duplicate other messages):
  pdflatex: Command for 'pdflatex' gave return code 1
```

注意：`! LaTeX Error: File ... not found.` 这一行**没有** `file:line` 前缀（LaTeX 层面没有行号信息），
后面才有 `./main.tex:3: Emergency stop.`。插件不能假设每个错误都有 `文件:行号`。

### 5.5 找不到引擎时的输出（直调 perl、PATH 缺 TL bin，exit 12）

```
'pdflatex' 不是内部或外部命令，也不是可运行的程序或批处理文件。   ← 控制台为 CP936，UTF-8 捕获会乱码
Latexmk: fls file doesn't appear to have been made.
Latexmk: Couldn't read log file 'build/plain.log':
...
  pdflatex: Run of rule 'pdflatex' gave a non-zero error code
```

### 5.6 控制台编码

runscript 自报 `(CP936, CP936, CP936)`。Windows 本地化错误文本以 CP936 字节输出，
用 UTF-8 解码会得到 `Ŀ¼������Ч��` 之类乱码（本次实测出现两次）。
插件若同时捕获系统/子进程消息，需按 GBK/CP936 解码或以 Buffer 保存后再判断。

## 6. Fixture 与编译证据

fixtures 根目录：`D:\deepseekharness\latex-plugin-tests\`。当前保留审计时生成的 `build/` 产物。

| Fixture | 引擎 | exit | 耗时 | 关键产物 |
| --- | --- | --- | --- | --- |
| `single-math` | XeLaTeX | 0 | 3.676 s | `build/main.pdf` 31 753 B / 1 页 / A4；aux,fdb,fls,log,pdf,synctex.gz,xdv |
| `chinese-ctex` | XeLaTeX | 0 | 4.658 s | PDF 30 595 B；嵌入 SimSun、SimHei、LMRoman、CMMI；`pdftotext` 取回中文正文 |
| `multi-file` | XeLaTeX + BibTeX | 0 | 7.623 s | PDF 30 495 B；`build/main.bbl` 317 B、`main.toc`；bibtex 运行 2 次 |
| `biblatex-biber` | XeLaTeX + Biber 2.19 | 0 | 12.615 s | PDF 19 480 B；`main.bcf`、`main.bbl`、`main.run.xml`；xelatex 4 遍 |
| `带 空格 项目`（with-space-path） | XeLaTeX | 0 | 5.227 s | PDF 30 591 B（`pdfinfo` 相对路径读数） |
| `error-case` | XeLaTeX | **12** | 1.519 s | 无 PDF；xdv/aux/log/fls/synctex.gz |
| `synctex` | XeLaTeX | 0 | 3.131 s | PDF 13 602 B；synctex.gz 1 124 B |
| `engines`（pdflatex） | pdfLaTeX | 0 | 2.234 s / `-pdf` 2.365 s | `build-pdflatex/`、`build-pdf/` 各 30 184 B |
| `engines`（lualatex） | LuaLaTeX | 0 | 冷 62.239 s / 热 2.034 s | `build-lualatex/plain.pdf` 25 861 B |
| `timeout` | XeLaTeX | 故意不完成 | 单次约 5.1 s | 用于杀进程测试（见第 10 节） |

统一命令（以 single-math 为例，bash 形式；Windows cmd 形式见第 4 节）：

```bash
cd "/d/deepseekharness/latex-plugin-tests/single-math"
"/d/latex/texlive2023/texlive/2023/bin/windows/latexmk.exe" \
  -xelatex -synctex=1 -interaction=nonstopmode -file-line-error -outdir=build main.tex
# EXIT=0 DURATION_MS=3676
```

### 6.1 multi-file：`-outdir` 下的 bibtex 细节

latexmk 自动处理了 outdir 与源目录分离时的 bibtex 查找（无需手写 BIBINPUTS）：

```
====== ENV{BIBINPUTS} changed to 'D:/deepseekharness/latex-plugin-tests/multi-file;build;D:\deepseekharness\latex-plugin-tests\multi-file\build;'
Latexmk: Change directory to 'build/'.
To assist finding of files in document directory, I set
  BIBINPUTS='D:/deepseekharness/latex-plugin-tests/multi-file;build;...'
  BSTINPUTS='D:/deepseekharness/latex-plugin-tests/multi-file;'.
------------
Running 'bibtex  "main.aux"'
------------
This is BibTeX, Version 0.99d (TeX Live 2023)
The top-level auxiliary file: main.aux
The style file: plain.bst
Database file #1: refs.bib
```

即：latexmk `cd build` 执行 bibtex，并显式设 BIBINPUTS/BSTINPUTS；`.bbl` 写在 `build/`。
`\bibliographystyle{plain}` + `\bibliography{refs}` 工作正常，正文 `\cite` 两轮后解析。

### 6.2 biblatex-biber

```
Running 'biber  "build/main.bcf"'
INFO - This is Biber 2.19
INFO - Logfile is 'build/main.blg'
INFO - Reading 'build/main.bcf'
INFO - Found 2 citekeys in bib section 0
INFO - Writing 'build/main.bbl' with encoding 'UTF-8'
```

latexmk 自动识别 `.bcf` 依赖并调用 biber（`biber` 从 TL bin 找到），随后重跑 xelatex 直到稳定，共 4 遍。

### 6.3 中文与字体（chinese-ctex）

`pdffonts` 实测输出（节选）：

```
UUSNJW+SimSun        CID TrueType  Identity-H  yes yes yes
AUSQSE+SimHei        CID TrueType  Identity-H  yes yes yes
CYOYQE+LMRoman12-Regular-Identity-H  CID Type 0C ...
WSKYWL+CMMI10        Type 1C       Builtin     yes yes yes
```

`pdftotext build/main.pdf -` 前几行：

```
中文排版测试
TeX 环境审计
2026 年 11 月 3 日
...
```

说明 ctex（windows 字体集）+ XeLaTeX 在本机开箱可用，无需额外配置字体。

### 6.4 LuaLaTeX 冷/热启动

- 首次：62.239 s（期间在 TEXMFCACHE 生成 LuaTeX 字体缓存 `.luc`；fdb 中缓存文件时间戳与运行时间吻合）。
- 修改源文件内容后再编译：2.034 s。
- `touch` 只改 mtime 不改内容时，latexmk 4.79 记录内容哈希，判定 `Nothing to do`（不重编）—— 这是正常行为。

## 7. 输出目录 / aux 目录 / -cd 行为

### 7.1 `-outdir`（推荐唯一使用）

实测：

| 场景 | 结果 |
| --- | --- |
| `-outdir=build`（相对 cwd，目录不存在） | exit 0，自动创建 `build` |
| `-outdir=D:/dsh-tmp/tex-audit/absout`（绝对路径，不存在） | exit 0，自动创建 |
| `-outdir="D:/dsh-tmp/tex-audit/out dir"`（含空格） | exit 0，内部命令正确加引号 |
| `-outdir=build` + `\input{sections/ch1}`（cwd=项目根） | exit 0，所有 aux/bbl 平铺在 `build/` |
| `-outdir=build` + 中文/空格 cwd | exit 0 |

`-outdir` **不改变 `\input` 的相对路径基准**：TeX 进程 cwd 仍是 latexmk 的 cwd，
所以 `\input{sections/ch1}` 相对的是 cwd（项目根），不是 outdir。这既是优点（源码路径无需改），
也是坑（见 7.3）。

### 7.2 `-auxdir`：不要用

- `-outdir=build -auxdir=aux` → **exit 22**：
  ```
  Latexmk: making auxiliary directory 'aux'
  problem making path aux: Invalid argument; Ŀ¼������Ч��   ← CP936 字节，实际为“目录名称无效”
  ```
  用 cmd 验证 `mkdir aux` 同样失败（exit 1），`mkdir auxfiles` 正常 —— `aux` 是 Windows 保留设备名。
- `-outdir=build -auxdir=auxfiles` → exit 0，但行为不是"aux 与 out 分离"那么简单：
  引擎实际被以 `-output-directory="auxfiles"` 启动，aux/log/xdv/fdb 落在 `auxfiles/`，
  最终 PDF 才由 xdvipdfmx 写到 `build/main.pdf`。
  日志：
  ```
  Running 'xelatex -no-pdf ... -output-directory="auxfiles"  "main.tex"'
  ```
  产物分布：`auxfiles/{main.aux,main.log,main.fls,main.fdb_latexmk,main.xdv}` + `build/main.pdf`。
  该模式下 SyncTeX/`\input` 的相对路径与工具链预期均未进一步验证；插件应避免。

### 7.3 `-cd` 与 cwd

用 `multi-file` 的干净副本，从父目录调用 `multi-file/main.tex`：

| 方式 | 结果 |
| --- | --- |
| 无 `-cd` | **exit 12**：`! LaTeX Error: File 'sections/ch1.tex' not found.`；aux 写到 `./build/`；无 PDF |
| 有 `-cd` | exit 0；latexmk 切到 `multi-file/`，产物落在 `multi-file/build/` |

结论：主文档不在 cwd 时，要么 `-cd`，要么把 cwd 设为项目根。
`-cd` 时 `-outdir` 的相对路径基准也随之为源文件目录（实测产物在 `multi-file/build/`）。

## 8. SyncTeX

### 8.1 生成

`-synctex=1` 对 XeLaTeX / pdfLaTeX / LuaLaTeX 都生效：
`build/main.synctex.gz` 均生成（本报告所有 XeLaTeX fixture 与 engines 两个引擎均验证）。
XeLaTeX 日志行：`SyncTeX written on build/main.synctex.gz.`

gzip 内容头部（`synctex` fixture）：

```
SyncTeX Version:1
Input:1:D:/deepseekharness/latex-plugin-tests/synctex/./main.tex
Input:2:d:/latex/texlive2023/texlive/2023/texmf-dist/tex/latex/base/article.cls
```

注意输入路径被记录为**绝对路径**（含 `/./`），因此 `-i` 里的文件名只要能被识别为同一路径即可。

### 8.2 forward（source → PDF）

命令：

```bat
"D:\...\bin\windows\synctex.exe" view -i 10:13:main.tex -o build/main.pdf
```

（cwd = `...\latex-plugin-tests\synctex`）输出（exit 0）：

```
This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:build/main.pdf
Page:1
x:160.674622
y:224.458221
h:125.798264
v:226.705490
W:358.655029
H:10.058167
before:
offset:-1
middle:
after:
SyncTeX result end
```

### 8.3 inverse（PDF → source）

```bat
"D:\...\bin\windows\synctex.exe" edit -o 1:160.674622:224.458221:build/main.pdf
```

输出（exit 0）：

```
This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:build/main.pdf
Input:D:/deepseekharness/latex-plugin-tests/synctex/./main.tex
Line:10
Column:-1
Offset:0
Context:
SyncTeX result end
```

坐标使用 TeX point（72 dpi）。`view` 给出页面坐标后可直接喂给 `edit`，实测能回到 `Line:10`。

### 8.4 失败形态（重要）

- 未知文件：`synctex view -i 13:3:nosuch.tex -o build/main.pdf` →
  `SyncTeX Warning: No tag for nosuch.tex`，**exit 0**，无 result 块。
- 页码越界：`synctex edit -o 9:10:10:build/main.pdf` → 只有 banner，**exit 0**，无 result 块。
- 行号越界：`synctex view -i 999:1:main.tex` → 仍输出 3 条 `Page:1` 记录（坐标被钳制），**exit 0**。
- 同一请求可能返回**多条**记录（line 13 的例子输出了两条完全相同的记录；行 999 输出三条）。
  插件应解析 `SyncTeX result begin/end`，取第一条或按需求选择，绝不能只看退出码。

版本注意：`synctex --version` 同时打印 `... client, version 1.21` 和
`This is SyncTeX command line utility, version 1.5` 两条版本信息（实测原文）。

## 9. 清理目标（`-c` / `-C`）与安全边界

在 single-math 副本上放诱饵文件：`keep-me.pdf`（根）、`notes.txt`（根）、`build/stray.pdf`。

### 9.1 `latexmk -c -outdir=build main.tex`（exit 0）

删除：`build/main.aux`、`build/main.fdb_latexmk`、`build/main.fls`、`build/main.log`、`build/main.xdv`。
保留：`build/main.pdf`、**`build/main.synctex.gz`**、`build/stray.pdf`、`keep-me.pdf`、`notes.txt`、`main.tex`。

即 `-c` 保留最终 PDF 与 synctex.gz（本次实测行为），只清中间文件。

### 9.2 `latexmk -C -outdir=build main.tex`（exit 0）

删除：`-c` 的全部 + `build/main.pdf` + `build/main.synctex.gz`。
保留：`build/` 目录本身、`build/stray.pdf`、`build/stray2.pdf`、`keep-me*.pdf`、`notes.txt`、`main.tex`。

### 9.3 `-C` 与 `.bbl`

在 multi-file 副本（`-cd -outdir=build`）上执行 `-C` 后，**只剩 `mf/build/main.bbl`**。
原因在 latexmk.pl 4.79：默认 `$bibtex_use = 1`（第 770 行），清理逻辑因此
`$keep_bbl = 1` 并 `delete $generated_exts{'bbl'}`（第 3711–3720 行）——默认不删 `.bbl`。

### 9.4 安全建议

- 插件"清理中间文件"用 `-c`；"清理全部产物"用 `-C`，但必须限定项目自己的 build 目录。
- `-C` 会删除最终 PDF —— 对"用户唯一交付物就是 PDF"的场景这是破坏性的，必须显式确认。
- `-C` 不会删 `build` 目录，也不会删 `.bbl`；需要彻底重置时删整个 `build` 目录。
- `-C` 只删它跟踪的产物；未跟踪的诱饵文件（stray.pdf 等）实测保留。但**不要**把 `-C` 当作沙箱：
  删除集合由 `.fdb_latexmk`/目标规则决定，"未跟踪文件被保留"只是当前实测结果，不是永久保证。

## 10. 超时与杀进程

fixture：`timeout/slow.tex`（2000 万次 `\loop` 空转）。直接 `xelatex -no-pdf slow.tex` 实测 5.117 s 完成
（说明该文档"足够慢"，可稳定制造 2 s 时仍在编译的窗口）。

用 PowerShell `Start-Process` 启动 latexmk，2 s 后抓进程树：

```
latexmk.exe  pid=19736  ppid=22348
  cmd="D:\...\bin\windows\latexmk.exe" -xelatex ... -outdir=build slow.tex
perl.exe     pid=11304  ppid=19736
  cmd=perl.exe d:\...\latexmk.pl -xelatex ... -outdir=build slow.tex
xelatex.exe  pid=12712  ppid=11304
  cmd=xelatex -no-pdf -synctex=1 ... "slow.tex"
```

### 实验 A：只杀 latexmk.exe（模拟 `child.kill()`）

`Stop-Process -Id 19736 -Force`，等 3 s 复查：

```
SURVIVOR perl.exe    pid=11304
SURVIVOR xelatex.exe pid=12712
```

**结论：只杀包装器会留下孤儿 perl + xelatex，它们继续占用 CPU、继续写 build 目录。**

### 实验 B：`taskkill /PID <latexmk-pid> /T /F`

```
SUCCESS: The process with PID 17868 (child process of PID 34672) has been terminated.
SUCCESS: The process with PID 5732  (child process of PID 28940) has been terminated.
SUCCESS: The process with PID 34672 (child process of PID 28940) has been terminated.
SUCCESS: The process with PID 28940 (child process of PID 22348) has been terminated.
```

复查孤儿数 = 0；taskkill 还额外终止了一个 latexmk 的直接子进程（PID 5732）。

### 遗留文件

被杀后 `build/` 内观察到：

```
slow.aux            0 B
slow.log            0 B
slow.fls            2834 B
slow.fdb_latexmk    185 B
slow.synctex(busy)  0 B     ← xelatex 正在写的 SyncTeX 临时文件
```

建议插件取消/超时后：`taskkill /T /F`（或 Windows Job Object），并把该 build 目录标记为不完整
（清理 `*.synctex(busy)`、0 字节 aux/log）后再允许重编。

### 超时预算建议（基于实测）

- 常规 XeLaTeX 单文档：1.5–8 s。
- biblatex + biber：约 12.6 s。
- LuaLaTeX **首次**运行：62 s（字体缓存）；之后 2 s。
- 因此默认超时建议 ≥ 120 s，LuaLaTeX/beamer 首次可用 180 s；不要用 30 s 以下的默认值。

## 11. 宏包可用性

`kpsewhich <name>` 实测（exit 0 = 找到；exit 1 = 未找到）：

| 名称 | kpsewhich 结果 | 路径 / 说明 |
| --- | --- | --- |
| `ctex.sty` | 找到 | `...\texmf-dist\tex\latex\ctex\ctex.sty` |
| `ctexart.cls` | 找到 | `...\ctex\ctexart.cls` |
| `ctex-fontset-windows.def` | 找到 | `...\ctex\fontset\ctex-fontset-windows.def`（本机默认字体集） |
| `biblatex.sty` | 找到 | `...\biblatex\biblatex.sty` |
| `tikz.sty` / `pgf.sty` / `pgfcore.sty` | 找到 | `...\pgf\...`；已真实编译通过 |
| `beamer.cls` | 找到 | `...\beamer\beamer.cls`；已真实编译通过 |
| `amsmath.sty` / `amsthm.sty` | 找到 | 已真实编译通过 |
| `fontspec.sty` / `xcolor.sty` / `geometry.sty` / `hyperref.sty` | 找到 | — |
| `biber.exe` | **kpsewhich 找不到（exit 1）** | 二进制在 `bin\windows\biber.exe`，用文件存在性判断；版本 2.19，已由 biblatex fixture 真实调用 |
| `latexmk.pl` | 默认找不到（exit 1） | 加 `--format=texmfscripts` 才返回 `...\scripts\latexmk\latexmk.pl` |

补充：`kpsewhich` 对不存在的文件返回 exit 1（不是 0），可用于缺失判断；但它只查 texmf 树，
**不能**用来探测 biber.exe 这类二进制。探测二进制请用 `fs.existsSync(path.join(tlBin,'biber.exe'))`。

tikz / beamer 冒烟测试（临时目录，真实编译）：

| 文档 | exit | 耗时 | 产物 |
| --- | --- | --- | --- |
| tikz 单图 | 0 | 4.095 s | `build/tikz.pdf` 2 825 B |
| beamer 单帧 | 0 | 6.533 s | `build/beamer.pdf` 6 690 B |

## 12. 已知坑与插件实现建议

1. **进程树**：`latexmk.exe` → `perl.exe` → `xelatex.exe`（+ conhost）。取消必须整树杀
   （`taskkill /PID <pid> /T /F` / Job Object）；`child.kill()` 会留孤儿（实测）。
2. **PATH**：绝对路径调 `latexmk.exe` 即可，无需配置 PATH；若改为直调 perl 脚本，必须把 TL bin 前置。
3. **`-outdir` vs `-auxdir`**：只推荐 `-outdir`；`-auxdir=aux` 会因 Windows 保留设备名 exit 22；
   `-auxdir=<其他>` 会把引擎 output-directory 改到 aux 目录，产物分裂，不建议。
4. **cwd / `-cd`**：主文档不在 cwd 时，`\input` 相对路径会断；用 `-cd` 或设 cwd=项目根。
   两种方式下 `-outdir` 的相对基准不同（实测）。
5. **不解析 CP936 前导行**：每次 latexmk 运行开头固定两行 `Initial Win CP ...` / `I changed them all to CP936`；
   本地化失败文本是 CP936 字节，UTF-8 解码会乱码。
6. **错误格式不统一**：TeX 错误有 `./file.tex:LINE: msg`（`-file-line-error`）；
   部分 LaTeX 错误（如缺宏包）没有行号前缀，只有 `! LaTeX Error: ...` 和后续 `Emergency stop`。
7. **退出码语义**：`0` 成功/已最新，`12` 编译失败，`22` 目录创建失败；不要用 `!=0` 一概当"代码错误"，
   也不要把 `12` 当超时/取消（取消应无退出码）。
8. **`synctex` 永远 exit 0**：必须解析 `SyncTeX result begin/end`；可能返回 0 条、1 条或多条记录，
   行号越界会被钳制而不是报错。
9. **`latexmk -C` 会删最终 PDF** 且默认保留 `.bbl`；清理接口必须显式区分 `-c` / `-C` 并在 UI 上警示。
10. **LuaLaTeX 首跑很慢**（62 s，字体缓存）；默认超时要留足，且首次失败可能只是超时不是文档错误。
11. **`-pdflatex=<program>` 不选 PDF 模式**：实测 `-pdflatex=definitely_not_a_real_engine` 时 latexmk 打印
    `No specific requests made, so using default for latexmk.` 并执行 `latex` 产出 DVI（exit 0，容易误判成功）。
    引擎选择请用裸 `-pdf` / `-xelatex` / `-lualatex`。
12. **路径含中文时个别外部工具异常**：`pdfinfo` 从 MSYS bash 接收"含中文的绝对路径"（POSIX 或
    Windows 形式均试过）会打印 `File size: 0 bytes`，但仍能读出 Pages/元信息；在目录内用相对路径则正常。
    这不是 TeX Live 问题，但插件若 shell 调用 poppler 校验 PDF 需注意（建议用 Win32 API/Node 传参）。
13. **空格与中文路径本身没问题**：cwd 为 `带 空格 项目`、`-outdir` 含空格、绝对 `-outdir` 均 exit 0。

## 13. 未验证 / 边界

以下内容**没有**测试，报告不作断言：

- pdfLaTeX / LuaLaTeX 编译中文文档（未测试）。
- `-shell-escape`、minted、tikz externalize、biber 的复杂特性（crossref、sorting 定制）。
- `-auxdir` 模式下 SyncTeX 的 forward/inverse 是否正确。
- 被 kill 后残留 `*.synctex(busy)` 时直接重编的行为（本次清理后未复测）。
- 多主文档、`% !TEX root`、`\include`（只测了 `\input`）、beamer 多帧/overlay。
- LaTeX 插件本身的 `latex_compile` 工具链（本次只审计 TeX Live 原生命令；fixtures 已可供插件 e2e 使用）。
- Windows 文件锁/杀毒软件干扰、并发编译、网络路径。

## 14. Verified by（实际执行的命令与结果）

> 原始 stdout/stderr 已按命令保存到 `D:\deepseekharness\latex-plugin\docs\env-audit-logs\`。
> 所有命令使用绝对路径 `D:\latex\texlive2023\texlive\2023\bin\windows\...`，未修改 TeX Live。

| # | 命令（要点） | 退出码 | 结果 |
| --- | --- | --- | --- |
| 1 | `latexmk.exe -v` | 0 | 4.79 |
| 2 | `xelatex.exe --version` | 0 | XeTeX 0.999995 |
| 3 | `pdflatex.exe --version` | 0 | pdfTeX 1.40.25 |
| 4 | `lualatex.exe --version` | 0 | LuaHBTeX 1.16.0 |
| 5 | `bibtex.exe --version` | 0 | BibTeX 0.99d |
| 6 | `biber.exe --version` | 0 | 2.19 |
| 7 | `kpsewhich.exe --version` | 0 | kpathsea 6.3.5 |
| 8 | `synctex.exe --version` | 0 | client 1.21 / utility 1.5 |
| 9 | `tlperl\bin\perl.exe -v` | 0 | Perl 5.34.0 |
| 10 | `kpsewhich -var-value=TEXLIVE_WINDOWS_TRY_EXTERNAL_PERL` | 0 | `0` |
| 11 | `latexmk -e 'print ... $ENV{PATH}' -v`（调用方 PATH 去 TL） | 0 | 进程内 PATH 含 TL bin/tlgs/tlperl |
| 12 | `latexmk -v`（`PATH=""`） | 0 | 正常 |
| 13 | `latexmk -xelatex ...`（`PATH=""`，全新 build） | 0 | 生成 PDF |
| 14 | `latexmk -xelatex ...`（`env -u PATH`） | 0 | 生成 PDF |
| 15 | `tlperl\perl.exe latexmk.pl -pdf ...`（PATH 去 TL） | **12** | 找不到 pdflatex |
| 16 | 同上但 PATH 前置 TL bin | 0 | 生成 PDF |
| 17 | single-math 编译 | 0 | 3.676 s，PDF 31 753 B |
| 18 | chinese-ctex 编译 | 0 | 4.658 s，PDF 30 595 B |
| 19 | multi-file 编译（bibtex） | 0 | 7.623 s，bbl 317 B |
| 20 | biblatex-biber 编译 | 0 | 12.615 s，biber 2.19 |
| 21 | `带 空格 项目` 编译 | 0 | 5.227 s，PDF 30 591 B |
| 22 | error-case 编译 | **12** | `./main.tex:4: Undefined control sequence.` |
| 23 | `latexmk -pdf` engines | 0 | 2.365 s，PDF 30 184 B（`-pdflatex` 裸开关同样实测 2.234 s） |
| 24 | `latexmk -lualatex` engines（冷） | 0 | 62.239 s，PDF 25 861 B |
| 25 | lualatex 修改内容后重编（热） | 0 | 2.034 s |
| 26 | tikz 冒烟编译 | 0 | 4.095 s |
| 27 | beamer 冒烟编译 | 0 | 6.533 s |
| 28 | synctex fixture 编译 | 0 | 3.131 s，synctex.gz 1 124 B |
| 29 | `synctex view -i 10:13:main.tex -o build/main.pdf` | 0 | Page 1, x 160.67, y 224.46 |
| 30 | `synctex edit -o 1:160.674622:224.458221:build/main.pdf` | 0 | Line 10 |
| 31 | `synctex view -i 13:3:nosuch.tex ...` | 0 | 仅 Warning，无 result |
| 32 | `synctex edit -o 9:10:10:...` | 0 | 仅 banner，无 result |
| 33 | 无 `-cd` 编译子目录 main.tex | **12** | `File 'sections/ch1.tex' not found.` |
| 34 | 有 `-cd` 同上 | 0 | 产物在 `multi-file/build/` |
| 35 | `-outdir=build -auxdir=aux` | **22** | 目录名无效 |
| 36 | `-outdir=build -auxdir=auxfiles` | 0 | 引擎 output-directory 改到 auxfiles |
| 37 | `-outdir` 绝对路径 | 0 | 产物正确 |
| 38 | `-outdir` 含空格 | 0 | 产物正确 |
| 39 | `latexmk -c -outdir=build` | 0 | 删 aux/log/fls/xdv/fdb，留 pdf/synctex.gz/诱饵 |
| 40 | `latexmk -C -outdir=build` | 0 | 再删 pdf/synctex.gz；留 build 目录/诱饵 |
| 41 | `latexmk -C` multi-file 副本 | 0 | 只剩 `build/main.bbl` |
| 42 | `Stop-Process` 只杀 latexmk.exe | — | perl、xelatex 存活 |
| 43 | `taskkill /PID <pid> /T /F` | 0 | 无孤儿进程 |
| 44 | `kpsewhich` 逐包检查 | 0/1 | 见第 11 节 |
| 45 | `cmd /c mkdir aux` / `mkdir auxfiles` | 1 / 0 | 证实 `aux` 保留名 |
| 46 | `pdfinfo` / `pdffonts` / `pdftotext` 中文 PDF | 0 | 中文可提取，SimSun/SimHei 已嵌入 |
| 47 | `tlmgr.bat --version` | 0 | TeX Live 2023，revision 66457 |

关键原始日志文件（`env-audit-logs\`）：

```
single-math.log            chinese-ctex.log        multi-file.log
biblatex-biber.log         space-path-xelatex.log  error-case.log
missing-pkg.log            engine-pdflatex.log     engine-lualatex.log
engine-pdf-flag.log        lua-cold.log            lua-warm-content.log
synctex-fixture.log        cdtest-nocd2.log        cdtest-cd2.log
auxdir.log                 auxdir2.log             abs-outdir.log
clean-c.log                space-outdir.log        clean-C-multifile.log
nopath-compile.log         nopath-empty.log        nopath-unset.log
perl-direct-nopath.log     perl-direct-path.log    pkg-tikz.log
pkg-beamer.log             option-pdflatex-equals-program.log
timeout-stdout.log
```
