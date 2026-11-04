# SyncTeX 专项验证笔记（forward / inverse / viewer 双击 / params.page 跳页）

- 实测时间：2026-11-03 16:23–16:35（Asia/Shanghai）。
- 环境：DSH 0.2.1-rc.5（desktop profile，插件以 `link:` 安装），插件 `dsh-latex` 0.1.0；TeX Live 2023（`D:\latex\texlive2023\texlive\2023\bin\windows`），引擎 `xelatex`；`synctex.exe` 自报 `This is SyncTeX command line utility, version 1.5` / usage 版本 `client, version 1.21`。
- 源码基线：`latex-plugin/index.js`、`src/*.js`、`client.js`、`cordis.patch.yml`。本次**只读源码，未改一行**；所有实验在 `latex-plugin-tests/e2e/synctex/` 的副本里做，原始 fixture 未修改。
- 结论一句话：**forward 数值链路、inverse 数值链路与双击的坐标换算都是对的；但 viewer 双击的“跳行”在客户端解析层实际拿不到行号，带空格/CJK 路径还会打开错误路径；`params.page` 首次跳页链路完整，同一页的重复跳转会被忽略。**

---

## 0. 结论速览

| # | 检查项 | 结果 | 依据 |
| --- | --- | --- | --- |
| 1 | ASCII 单页 forward（line/column/file） | **PASS** | §3.1，F01–F14 |
| 2 | 多页 forward（page 2/3） | **PASS** | §3.2，F15–F19 |
| 3 | 多文件 `\input` 子文件 forward | **PASS** | §3.3，F20–F23 |
| 4 | 空格路径 / 中文路径 forward | **PASS**（数值） | §3.4，F24–F30 |
| 5 | ASCII inverse + 正反向闭环 | **PASS** | §4.1，I01–I02、§5 |
| 6 | 多页 inverse（page 2/3） | **PASS** | §4.3，I09–I13 |
| 7 | 无 `.synctex.gz`（有 PDF） | **部分 FAIL（UX）**：forward 只回 banner；inverse 把 2.8 KB usage 全文塞进工具结果 | §4.4（`raw-inverse-nosynctex.txt`） |
| 8 | 无 PDF | **PASS**（明确报错） | §4.4，F32 |
| 9 | 页码越界（99 / 第 4 页） | **PASS（语义可接受）**：`SyncTeX result begin/end` 为空，exit 0，工具回 “found no source location” | §4.2，I06/I12 |
| 10 | 行号越界（999 / 12） | **FAIL（严格语义）**：静默吸附到最后一条记录，exit 0，工具当成功返回 | §3.1，F06；§4.2 |
| 11 | 坐标越界（负数 / 1e6） | **可接受但静默**：吸附到 line 11，不报错 | §4.2，I04/I05 |
| 12 | 双击 x/y 坐标换算（canvas px ÷ scale → bp） | **PASS**（代码 + 数值闭环） | §5 |
| 13 | 双击“打开源码并跳到行” | **FAIL（agent-side 代码级）**：行号永远解析不到（见 F-1） | §6.1，parse-sim |
| 14 | 双击带空格源路径 | **FAIL**：路径在第一个空格处被截断（见 F-2） | §6.2，parse-sim |
| 15 | 双击中文路径 | **FAIL**：synctex 输出 GBK 字节，插件按 UTF-8 解码成 U+FFFD（见 F-3） | §8，I17–I22 |
| 16 | `params.page` 跳页链路（首次/换页） | 代码链路完整；工具级请求 PASS；**UI 行为 NOT VERIFIED (agent-side)** | §7 |
| 17 | 同一页的重复跳页 | **FAIL（代码级边界）**：`params.page` 不变时 effect 不重跑（见 F-5） | §7.4 |
| 18 | 复制/改名项目后的旧 `.synctex.gz` | **FAIL（数据问题）**：inverse 指回旧项目绝对路径 | §4.5，I25 |
| 19 | `latex_synctex` HTTP 路由（带 admission） | **NOT VERIFIED (agent-side)**：无授权请求返回 401（实测），无法在 agent 侧构造已准入连接 | §9 |

> UI 像素级/浏览器行为无法在本 agent 侧执行；凡涉及真实点击、tab 聚焦语义的项都标 `NOT VERIFIED (agent-side)`，没有写成 PASS。

---

## 1. 方法、fixture 与构建记录

### 1.1 实验副本（原始 fixture 未动）

| 副本路径（相对 `latex-plugin-tests/e2e/synctex/`） | 来源 | 用途 |
| --- | --- | --- |
| `ascii-project/` | 复制 `latex-plugin-tests/synctex/` | ASCII 单页基线 |
| `multipage/` | 新写 | 3 页 forward/inverse 跨页 |
| `multi-file/` | 复制 `latex-plugin-tests/multi-file/` | `\input{sections/ch1}` 子文件 forward |
| `multi space/` | 复制 `multi-file/`，把 `sections/` 改名为 `my sections/`，改 `\input{my sections/ch1}` | **源路径含空格**（触发 F-2） |
| `中文项目/` | 复制 `latex-plugin-tests/chinese-ctex/` | 项目根目录含中文 |
| `带 空格 项目/` | 复制 `latex-plugin-tests/chinese-ctex/` | 中文 + 空格混合路径 |
| `space project/` | 复制 `ascii-project/` | 纯 ASCII 空格根目录（源文件在根，相对路径无空格） |
| `cjk-file/` | 复制 `multipage/`，新增 `章节-一.tex` 并 `\input{章节-一}` | ASCII 根 + **中文源文件名** |
| `no-synctex/` | 复制 `ascii-project/` 后删除 `build/main.synctex.gz` | 有 PDF、无 synctex |
| `no-pdf/` | 只复制 `ascii-project/main.tex` | 从未构建 |
| `stale-synctex/` | 再次复制已构建的 `ascii-project/`（未重新构建） | 模拟项目被复制/改名后 `.synctex.gz` 里的旧绝对路径 |

`cjk-file/main.tex` 因使用 article 字体排中文，构建时产生 13 条 `Missing character` 警告（不影响本项结论，见构建记录）。

### 1.2 构建记录（全部经 `latex_compile`，`force=true`）

| 项目 | status | engine | duration | exit | pages | preview version |
| --- | --- | --- | --- | --- | --- | --- |
| `ascii-project` | SUCCESS | xelatex | 3.81 s | 0 | 1 | 1793694291992 |
| `中文项目` | SUCCESS | xelatex | 4.67 s | 0 | 1 | 1793694296722 |
| `带 空格 项目` | SUCCESS | xelatex | 4.73 s | 0 | 1 | 1793694304345 |
| `multi-file` | SUCCESS | xelatex | 5.97 s | 0 | 1 | 1793694310371 |
| `space project` | SUCCESS | xelatex | 3.65 s | 0 | 1 | 1793694384351 |
| `multi space` | SUCCESS | xelatex | 5.67 s | 0 | 1 | 1793694390128 |
| `multipage` | SUCCESS | xelatex | 3.39 s | 0 | 3 | 1793694443141 |
| `cjk-file` | SUCCESS | xelatex | 3.36 s | 0 | 3 | 1793694527783（13 warnings） |

编译产物 `build/main.synctex.gz` 的头部（`ascii-project`，重新构建后）：

```text
SyncTeX Version:1
Input:1:D:/deepseekharness/latex-plugin-tests/e2e/synctex/ascii-project/./main.tex
Input:2:d:/latex/texlive2023/texlive/2023/texmf-dist/tex/latex/base/article.cls
...
```

注意：**Input 记录的是构建当时的绝对路径**（带 `/./`），这是 §4.5 stale 问题的根因。

### 1.3 调用方式

- 工具调用：`latex_compile(path=..., force=true)`、`latex_synctex(path=..., direction=..., ...)`、`latex_preview(path=..., page=...)`。
- 原始 CLI 交叉验证（等价 argv，供逐字节取证）：

```bat
"%TEXBIN%\synctex.exe" view -i <line>:<column>:<abs .tex> -o <abs pdf>
"%TEXBIN%\synctex.exe" edit -o <page>:<x>:<y>:<abs pdf>
```

原始输出已落盘到 `latex-plugin-tests/e2e/synctex/logs/`（见 §10）；批量抓取脚本为同目录 `capture-raw.ps1`、`capture-batch.ps1`。

---

## 2. 工具实现速览（本报告引用的行为）

- `latex_synctex` 工具定义：`src/tools.js:429-460`；参数说明 `src/tools.js:435-447`（`x`/`y` 明确写 “TeX points (72 dpi)”）。
- 唯一实现：`src/service.js:828-899`。
  - 15 s 硬超时：`:843`；spawn 参数：`:861-872`；**忽略退出码**：`:873`（`await handle.done.catch(() => undefined)`）。
  - inverse argv：`synctex edit -o page:x:y:pdf`（`:846-850`），page 被 `Math.max(1, Math.round(...))` 钳制（`:847`），x/y 仅做有限性检查后原样传入（`:848-849`）。
  - forward argv：`synctex view -i line:column:file -o pdf`（`:851-858`）；`file` 以 `path.resolve(project.rootDir, args.file)` 解析（`:852-853`）；line/column 分别钳到 ≥1（`:855-856`）。
  - inverse 结果解析：`Input:`/`Line:`/`Column:` 正则（`:885-887`），输出 `SyncTeX inverse: <relative|input>[:line][ (column N)]`（`:889-892`）。
  - forward 结果解析：取**文本中第一组** `Page:`/`x:`/`y:`（`:894-898`）。
- HTTP：`src/routes.js:370-382`（`POST /latex/synctex-inverse`）、`:384-394`（`GET /latex/synctex`）；除 `/latex/health`（`:254-258`，实测 200）外均走 `connection.admit`（`:129-150`，实测未授权 `/latex/state` 返回 401）。

---

## 3. Forward 实测

### 3.1 ASCII 单页（`ascii-project/main.tex`，1 页）

`main.tex` 行号：4=section，5=正文行，8=公式行，10=`SYNC-TARGET`，11=`\end{document}`。

| ID | 调用 | 工具返回（原文） |
| --- | --- | --- |
| F01 | line=4 | `SyncTeX forward: page 1 at (125.798264, 140.742218)` |
| F02 | line=5 | `SyncTeX forward: page 1 at (150.190979, 165.105621)` |
| F03 | line=8 | `SyncTeX forward: page 1 at (301.581146, 194.799942)` |
| F04 | line=10 | `SyncTeX forward: page 1 at (160.674622, 224.458221)` |
| F05 | line=11 | `SyncTeX forward: page 1 at (125.798264, 699.048828)` |
| F06 | line=999 | `SyncTeX forward: page 1 at (125.798264, 699.048828)` |
| F07 | line=1 | `SyncTeX forward: page 1 at (125.798264, 140.742218)` |
| F08 | line=0 | `SyncTeX forward: page 1 at (125.798264, 140.742218)` |
| F09 | line=-5 | `SyncTeX forward: page 1 at (125.798264, 140.742218)` |
| F10 | line=10.7 | `SyncTeX forward: page 1 at (125.798264, 699.048828)`（先被 round 成 11） |
| F11 | line=5, column=20 | `SyncTeX forward: page 1 at (150.190979, 165.105621)` |
| F12 | line=5, column=60 | `SyncTeX forward: page 1 at (150.190979, 165.105621)` |
| F13 | line=5, file=`does-not-exist.tex` | `SyncTeX forward lookup found no PDF location.\nThis is SyncTeX command line utility, version 1.5\nSyncTeX Warning: No tag for ...\does-not-exist.tex` |
| F14 | line=12 | `SyncTeX forward: page 1 at (125.798264, 699.048828)` |

原始输出（`logs/raw-forward-ascii-line5.txt`，line 5 一次返回 **4 条** 记录，工具取第一条）：

```text
This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:D:\deepseekharness\latex-plugin-tests\e2e\synctex\ascii-project\build\main.pdf
Page:1
x:150.190979
y:165.105621
h:125.798264
v:166.014725
W:358.655029
H:10.004216
before:
offset:-1
middle:
after:
...（另 3 条 Page:1 记录，x=292.10/338.85/314.85，v 均为 166.014725）
SyncTeX result end
```

观察：

1. **一次 forward 可能返回多条记录**（line 5 → 4 条；line 12/999 → 3 条）；`service.js:894-898` 只取第一组 `Page/x/y`，所以工具结果是“第一个命中框”。这与 `docs/env-audit.md:505-507` 的 CLI 级观察一致。
2. **行号越界不报错**：line 11/12/999 都吸附到页面最后一条记录（y≈699.05，即 `\end{document}` 的框）；line 0/1/-5 吸附到首个框（y≈140.74，即 section 行）。synctex 退出码仍是 0，工具按成功返回。即“源行不存在”与“成功命中”在工具层不可区分。
3. **column 无实际效果**：column=1/20/60 输出逐字节一致（TeX 引擎未记录列级信息）；工具还把 column 钳到 ≥1（`service.js:856`），因此 LaTeX-Workshop 的 rectangle 模式常用的 `column=0` 无法通过本工具表达。
4. **未知文件**只产生 `SyncTeX Warning: No tag for ...`（stdout），无 result 块，exit 0；工具返回“no PDF location + 原文”。

原始输出（`logs/raw-forward-ascii-line999.txt` 摘要，3 条记录）：

```text
Page:1  x:125.798264  y:699.048828   (h=v=125.798264/699.048828, H=7.265449)
Page:1  x:125.798264  y:104.876724   (H=0.000000)
Page:1  x:125.798264  y:699.048828   (H=7.265449)
```

### 3.2 多页（`multipage/main.tex`，3 页）

| ID | 调用 | 工具返回 |
| --- | --- | --- |
| F15 | line=5 | `SyncTeX forward: page 1 at (195.354614, 165.105621)` |
| F16 | line=10 | `SyncTeX forward: page 2 at (193.674591, 165.105621)` |
| F17 | line=12 | `SyncTeX forward: page 2 at (301.581146, 196.138107)` |
| F18 | line=18 | `SyncTeX forward: page 3 at (216.343689, 165.105621)` |
| F19 | line=999 | `SyncTeX forward: page 3 at (125.798264, 699.048828)` |

结论：页号正确（1/2/3），跨页可用；越界行同样吸附到最后一页的末尾框。

### 3.3 多文件（`multi-file`、`multi space`）

| ID | 调用 | 工具返回 |
| --- | --- | --- |
| F20 | `multi-file` line=3（主文件） | `SyncTeX forward: page 1 at (231.398254, 214.789520)` |
| F21 | `multi-file` file=`sections/ch1.tex` line=3 | `SyncTeX forward: page 1 at (162.267334, 393.261169)` |
| F22 | `multi-file` file=`sections/ch1.tex` line=8 | `SyncTeX forward: page 1 at (159.851105, 406.810364)` |
| F23 | `multi space` file=`my sections/ch1.tex` line=3 | `SyncTeX forward: page 1 at (162.267334, 393.261169)` |

结论：`file` 相对项目根解析正确（`service.js:852-857`），子目录带空格也能传给 synctex（argv 数组、无 shell）。

### 3.4 中文 / 空格 / 中文文件名

| ID | 项目 | 调用 | 工具返回 |
| --- | --- | --- | --- |
| F24 | `space project` | line=3 | `SyncTeX forward: page 1 at (125.798264, 140.742218)` |
| F25 | `中文项目` | line=12 | `SyncTeX forward: page 1 at (165.268341, 321.185242)` |
| F26 | `中文项目` | line=19 | `SyncTeX forward: page 1 at (319.454346, 384.297760)` |
| F27 | `带 空格 项目` | line=12 | `SyncTeX forward: page 1 at (165.268341, 321.185242)` |
| F28 | `带 空格 项目` | line=19 | `SyncTeX forward: page 1 at (319.454346, 384.297760)` |
| F29 | `cjk-file` | file=`章节-一.tex` line=3 | `SyncTeX forward: page 2 at (178.881882, 284.428894)` |
| F30 | `cjk-file` | file=`章节-一.tex` line=2 | `SyncTeX forward: page 2 at (153.867340, 284.428894)` |
| F31 | `no-synctex` | line=10 | `SyncTeX forward lookup found no PDF location.\nThis is SyncTeX command line utility, version 1.5` |
| F32 | `no-pdf` | line=10 | `SyncTeX needs a built PDF first: ...\no-pdf\build\main.pdf does not exist. Run latex_compile.` |
| F33 | `stale-synctex` | line=5 | `SyncTeX forward: page 1 at (150.190979, 165.105621)` |

结论：**forward 对中文/空格路径全部可用**（包括中文文件名），因为结果只解析数字；路径只作为 argv 传给 synctex。

---

## 4. Inverse 实测

### 4.1 ASCII 正反向闭环

| ID | 调用（`ascii-project`） | 工具返回 |
| --- | --- | --- |
| I01 | page=1 x=150.19 y=165.11 | `SyncTeX inverse: main.tex:5` |
| I02 | page=1 x=160.67 y=224.46 | `SyncTeX inverse: main.tex:10` |
| I03 | page=1 x=125.8 y=699.05 | `SyncTeX inverse: main.tex:11` |

闭环表（forward 的 `(x,y)` 原样喂回 inverse）：

| 源行 | forward 坐标 | inverse（原样回喂） | 是否闭环 |
| --- | --- | --- | --- |
| 5 | (150.190979, 165.105621) | `main.tex:5` | ✅ |
| 8 | (301.581146, 194.799942) | —（未单独跑） | — |
| 10 | (160.674622, 224.458221) | `main.tex:10` | ✅ |
| 11 | (125.798264, 699.048828) | `main.tex:11` | ✅ |
| 中文项目 12 | (165.268341, 321.185242) | `...:12`（路径乱码，行号正确） | 行号 ✅ / 路径 ❌ |
| 中文项目 19 | (319.454346, 384.297760) | `...:18`（**边界差一行**；y=390 时回 19） | 边界情况见 §5.3 |

原始输出（`logs/raw-inverse-ascii-line5.txt`）：

```text
This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:D:\deepseekharness\latex-plugin-tests\e2e\synctex\ascii-project\build\main.pdf
Input:D:/deepseekharness/latex-plugin-tests/e2e/synctex/ascii-project/./main.tex
Line:5
Column:-1
Offset:0
Context:
SyncTeX result end
```

**关键事实：`Column` 恒为 `-1`。** 在页面文本区做了 10×5 网格采样（y=100..699，x=130..500），50 个采样点全部 `Column:-1`（原始输出 `logs/inverse-column-grid.txt`，采样命令见 §10.3）。这不是异常，而是 TeX 引擎不提供列信息；`service.js:887` 用的是 `/Column:(\d+)/`，**负数不匹配**，所以工具结果里永远不会出现 `(column …)` 后缀。这正是 §6.1 行号丢失的直接原因。

### 4.2 页码越界 / 坐标越界 / 参数钳制

| ID | 调用 | 工具返回 |
| --- | --- | --- |
| I04 | page=1 x=-50 y=-50 | `SyncTeX inverse: main.tex:11` |
| I05 | page=1 x=1000000 y=1000000 | `SyncTeX inverse: main.tex:11` |
| I06 | page=99 x=100 y=100 | `SyncTeX inverse lookup found no source location.\nThis is SyncTeX command line utility, version 1.5` |
| I07 | page=-3 x=150.19 y=165.11 | `SyncTeX inverse: main.tex:5`（page 钳到 1） |
| I08 | page=1.6 x=150.19 y=165.11 | `SyncTeX inverse lookup found no source location.\nThis is SyncTeX command line utility, version 1.5`（round 成 2，PDF 只有 1 页） |

原始 CLI 细节（`logs/raw-inverse-edge-cases.txt`）：

- page 99：只有 banner，**exit 0**，无 result 块。
- page 0：exit 0，返回 `Line:11`（synctex 自己接受 0；工具会先钳成 1）。
- page 1.6：直接跑 CLI 会 `SyncTeX ERROR: Bad -o argument` 并打印 usage，**exit -1**；工具因为先 `Math.round`（`service.js:847`）不会触发这个形态。
- x/y = -50/-50 与 1e6/1e6：均 exit 0，返回 `Line:11`（吸附到最近/最后框），**没有越界错误**。

结论：页码越界是“空结果 + exit 0”，坐标越界是“吸附到最近框 + exit 0”。工具层靠“是否解析到 `Page:`/`Input:`”区分，无法区分“越界”与“真实失败”。

### 4.3 多页 / 多文件 / 空格根目录 inverse

| ID | 项目 | 调用 | 工具返回 |
| --- | --- | --- | --- |
| I09 | `multipage` | page=2 x=193.67 y=165.11 | `SyncTeX inverse: main.tex:10` |
| I10 | `multipage` | page=2 x=301.58 y=196.14 | `SyncTeX inverse: main.tex:12` |
| I11 | `multipage` | page=3 x=216.34 y=165.11 | `SyncTeX inverse: main.tex:18` |
| I12 | `multipage` | page=4 x=100 y=100 | `SyncTeX inverse lookup found no source location.\nThis is SyncTeX command line utility, version 1.5` |
| I13 | `multipage` | page=2 x=0 y=0 | `SyncTeX inverse: main.tex:16`（`\newpage` 行） |
| I14 | `multi-file` | (162.27, 393.26) | `SyncTeX inverse: sections\ch1.tex:4` |
| I15 | `multi space` | (162.27, 393.26) | `SyncTeX inverse: my sections\ch1.tex:4` |
| I16 | `space project` | (125.8, 140.74) | `SyncTeX inverse: main.tex:4` |

观察：**inverse 返回的路径是 `path.relative(project.rootDir, input)`，Windows 下带反斜杠**（`sections\ch1.tex`），并且**子目录名里的空格会保留**（`my sections\ch1.tex`）。这两点直接喂给 `client.js` 的两个正则，见 §6。

### 4.4 无 synctex / 无 PDF

- 无 PDF（`no-pdf`）：`SyncTeX needs a built PDF first: ...\build\main.pdf does not exist. Run latex_compile.`——在 `service.js:834-838` 前置检查，**PASS**。
- 有 PDF、无 `.synctex.gz`（`no-synctex`）：
  - forward：raw 只有 banner（`logs/raw-forward-nosynctex.txt`，51 B），exit 0；工具回 `SyncTeX forward lookup found no PDF location.` + banner。
  - inverse：raw 为 banner + `SyncTeX ERROR: No SyncTeX available for ...` + **完整 usage**（`logs/raw-inverse-nosynctex.txt`，2 843 B），**exit 127**；工具把这些全文拼进结果（`service.js:874-876` 不看退出码，`883` 只做 12 KB 截断）。对模型/用户是可读性很差的失败提示。
- synctex.exe 缺失时：`service.js:830-833` 返回 `SyncTeX is unavailable: ...`（本机未复现，未删 TeX）。

### 4.5 stale `.synctex.gz`（复制/改名项目）

`stale-synctex/` 是已构建的 `ascii-project/` 的副本，未重新构建。其 `build/main.synctex.gz` 里的 `Input:` 仍是 `.../ascii-project/./main.tex`：

| ID | 调用 | 工具返回 |
| --- | --- | --- |
| I25 | page=1 x=150.19 y=165.11 | `SyncTeX inverse: D:/deepseekharness/latex-plugin-tests/e2e/synctex/ascii-project/./main.tex:5` |

即：**项目被复制/改名后，double-click 会把用户带到旧项目里的同名源文件**（本机旧文件确实存在，错误是“静默打开另一个项目”）。`service.js:889-890` 只在 `relative` 不以 `..` 开头时才相对化，否则原样返回绝对路径；这正是本场景。

---

## 5. 坐标系、单位与双击换算

### 5.1 synctex 约定（来自本机 `synctex help edit` 原文）

```text
-o page:x:y:file
       specify the page and coordinates of the point under the mouse.
       page is 1 based.
       Coordinates x and y are counted from the top left corner of the page.
       Their unit is the big point (72 dpi).
```

- 原点：**页面左上角**；y 向下增大。
- 单位：**bp（big point，72 dpi）**，不是 CSS 96 dpi 像素，也不是 PDF 的 bottom-left pt。
- forward 的 `x/y` 与 inverse 的 `x/y` 使用同一约定——§4.1 的闭环（同一点喂回得到同一行）即证据。

### 5.2 viewer 侧换算（`client.js`）

1. 渲染：`renderPage` 用 `pdfPage.getViewport({ scale })` 得到 CSS 尺寸，`canvas.style.width = viewport.width`、`height = viewport.height`（`client.js:1288`、`:1301-1306`）；页面占位符同样 `baseSize.width * scale`（`:1685-1688`）。设备像素比 `dpr` 只放大 canvas 的 backing store（`:1287-1289`），**不改 CSS 尺寸**。
2. 点击：`rect = canvas.getBoundingClientRect()`，然后

   ```js
   const x = (event.clientX - rect.left) / scale;   // client.js:1459
   const y = (event.clientY - rect.top) / scale;    // client.js:1460
   ```

   因为 CSS 宽高 = `viewport.width/height = baseSize*scale`，除以 `scale` 后恰好得到 **PDF 页面坐标（bp，从左上角算）**，与 synctex 的约定一致。
3. 数值例：scale=1.5 时，点在 canvas 内 (225.30, 247.67) →
   x=225.30/1.5=150.20，y=247.67/1.5=165.11 → `latex_synctex inverse` 回 `main.tex:5`（与 I01 同一坐标）。
4. CSS 上没有对 canvas 做 `transform: scale(...)`（`.dl-page`/`.dl-page canvas` 仅尺寸、阴影、圆角，`client.js:633-636`），不存在二次缩放。

**结论：双击坐标换算 PASS**（代码与实测数值互证）。真正的问题不在坐标，而在解析（§6）。

### 5.3 边界行的一行偏差（记录，不是插件 bug）

forward 返回的 y 是**行框顶部**；在行距紧、两行框相接时，把该 y 原样喂回 inverse 可能命中上一行：

```
forward(中文项目, line=19) → (319.454346, 384.297760)
inverse(319.45, 384.30)   → :18
inverse(319.45, 390)      → :19
```

人双击落在字形内部（y 略大于行顶）会得到正确行；只有“拿 forward 的 y 原样反查”时才会看到差一行。ASCII 的 line 5/10 在这些坐标上闭环正常。记录该现象以免把闭环测试的偶发差异误判为解析 bug。

---

## 6. Viewer 双击反查链路（代码级）

调用链：`dl-page` 的 `onDoubleClick`（`client.js:1690`）→ `onDoubleClick(event, pageNumber)`（`:1448-1493`）→ `POST /latex/synctex-inverse`（`routes.js:370-382`）→ `service.syncTeX`（`service.js:828-899`）→ 返回字符串 → 客户端两个正则解析（`:1470`、`:1472`）→ `openResource(sessionFileAddress(...), line ? { params: { line } } : undefined)`（`:1478`）。

### 6.1 F-1（high）：行号永远解析不到，双击只打开文件、不跳行

服务端输出模板（`service.js:889-892`）：

```js
return `SyncTeX inverse: ${relative ...}${
  line ? `:${line}` : ''
}${column ? ` (column ${column})` : ''}`;
```

由于实测 `Column:-1`（§4.1），`const column = /Column:(\d+)/.exec(trimmed)?.[1]`（`:887`）**匹配不到负数**，`column` 为 `undefined`，所以结果字符串以行号结尾，**末尾没有空格/括号**，例如 `SyncTeX inverse: main.tex:5`。

客户端（`client.js:1470`）：

```js
const match = /:(\d+)(?:\s|\()/.exec(String(data.result ?? ''));
```

该正则要求行号后必须是空白或 `(`；字符串在 `5` 处结束 → **无匹配** → `line = undefined` → `openResource(..., undefined)`（`:1478`）→ 文件打开但不带行号参数。

复现（`logs/parse-sim.txt`，脚本 `parse-sim.mjs` 复制了 `client.js:899/1470/1472` 的原正则）：

```text
{"result":"SyncTeX inverse: main.tex:5","line":undefined,"source":"main.tex"}
{"result":"SyncTeX inverse: main.tex:5 (column 1)","line":5,"source":"main.tex"}
```

只有服务端**恰好**带上 `(column N)`（要求 `Column:0/正数`）时行号才会被解析——本机 XeTeX 实测从不发生。也就是说 Lead 记录过的“双击打开源码行”，**代码路径上只保证打开文件，行号参数实际丢失**；建议在 UI 上以“文件打开后光标是否在该行”复测。修复：把正则改成 `/:(\d+)(?=\s|\(|$)/`，或让 `service.syncTeX` 返回结构化 `{file,line,column}` 而不是拼接文本。

### 6.2 F-2（high）：源路径含空格时被截断，打开错误路径

客户端（`client.js:1472`）：

```js
const sourceMatch = /SyncTeX inverse: (.+?)(?::\d+)?(?: |$)/.exec(String(data.result ?? ''));
```

`(.+?)` 非贪婪，遇到第一个空格就可能满足 `(?: |$)`。实测 `multi space` 的结果是 `SyncTeX inverse: my sections\ch1.tex:4`，解析为：

```text
{"result":"SyncTeX inverse: my sections\\ch1.tex:4","source":"my","openResourcePath":"D:\\...\\multi space/my"}
```

即打开 `<项目根>/my`（不存在的文件），并丢掉行号。任何“子目录名/文件名含空格”的项目都会中招（项目根含空格但源文件在根时不会，因为 relative 是 `main.tex`——`space project` 正常，见 I16）。绝对路径含空格（stale 场景）同理：`D:/x/space project/./main.tex:12` → source=`D:/x/space`。

修复：从右向左解析（例如 `/^SyncTeX inverse: (.*?)(?::(\d+))?(?: \(column (\d+)\))?$/`，并注意 `.*?` 仍需允许空格；或用 `lastIndexOf` 逻辑/结构化返回）。

### 6.3 F-3（high）：CJK 路径乱码（详见 §8）

`中文项目` 的 inverse 返回 `SyncTeX inverse: D:/.../������Ŀ/./main.tex:12`；`cjk-file` 返回 `�½�-һ.tex:2`。客户端会把 U+FFFD 拼进 `dsh-resource://` 地址，打开必然失败；`openResource` 只接受存在的地址（`docs/api-cheatsheet.md` G.5）。

### 6.4 F-4（medium）：stale synctex 指向另一个项目（§4.5）

### 6.5 其他核对（无问题）

- `source` 为绝对路径（`^[A-Za-z]:[\\/]`）时直接用，否则拼 `${project.rootDir}/${source}`（`:1475-1477`）；对 `sections\ch1.tex` 这类反斜杠相对路径，Windows 下混合分隔符可接受。
- `sessionFileAddress` 会归一化反斜杠并逐段 `encodeURIComponent`（`:364-379`），空格会编码为 `%20`，路径段本身不丢；问题只在更早的 `source` 截断。
- 双击事件挂在页面元素而不是 canvas（`:1690`），`currentTarget.querySelector('canvas')`（`:1453`）在有渲染时存在；未渲染的占位页没有 canvas，会走 `preview.syncFailed` 分支（合理）。
- `event.currentTarget` 是页面 `div`，`rect` 取 canvas 自身（`:1458`），canvas 在页面内无 padding/transform，偏移为 0。

---

## 7. `params.page` 跳页链路

### 7.1 两条入口

1. **工作台 forward sync**：`LatexWorkbench.forwardSync`（`client.js:889-912`）→ `GET /latex/synctex`（`:896`）→ 正则 `/page\s+(\d+)/i` 从 `SyncTeX forward: page 2 at (...)` 取页号（`:899`）→ `openPreview(project, snapshot, { page })`（`:904-908`）。

   注意 `forwardSync` 始终把 `file` 设为 `project.mainRelative`（`client.js:895`），因此**工作台 forward 只能按主文件行号同步**；在章节文件里按章节行号 forward 只能用工具 `latex_synctex(file=...)`，UI 没有章节入口（见 §9 第 14 条）。
2. **`latex_preview` 工具**：`page` 参数（`tools.js:198`、`:228`）→ `service.requestPreview`（`tools.js:227-232`，`service.js:664-678`）→ snapshot 里 `previewRequest`（`service.js:732`）→ 工具卡片读到后 `openTab(PREVIEW_KIND, { project, page: request.page })`（`client.js:1767-1780`）。

`openPreview` 最终 `openTab(PREVIEW_KIND, { project: project.id, ...(page ? { page } : {}) })`（`client.js:417-424`），`openTab` 调 `sidebar.openTab(kind, { params })`（`:381-397`）。tab 正文经 `useTabParams` 读 `info.tab.navigation.params`（`:317-327`、`:1140`），这是 `docs/api-cheatsheet.md` §G.4 明确记载的 `navigation.params`。

### 7.2 LatexPreview 内的两段处理

- 首次加载：`pendingRestoreRef = initialView.page ?? params?.page ?? 1`（`:1162`），PDF `getDocument` 后用 `restore` 设 `page`（`:1233-1235`）。
- 已打开 tab 的导航：

  ```js
  useEffect(() => {
    if (docInfo.status !== 'ready') return;
    const requested = Number(params?.page);
    if (Number.isFinite(requested) && requested >= 1 && requested !== page) {
      goToPage(requested);
    }
  }, [params?.page, docInfo.status, docInfo.numPages]);   // client.js:1440-1446
  ```

  `goToPage` 会 clamp 到 `[1, numPages]` 并设置 `container.scrollTop = element.offsetTop - 8`（`:1416-1430`）。

### 7.3 工具级证据

| 调用 | 工具返回 |
| --- | --- |
| `latex_preview(multipage, page=2)` | `... The PDF.js preview tab opens ...` + `page: 2`（preview v1793694443141, 3 pages） |
| `latex_preview(multipage, page=999)` | 同上，但 `page: 999`（**服务端不 clamp**） |

即：page 请求确实进入 snapshot 的 `previewRequest.page`，工具卡片会把它带进 `openTab`。viewer 侧 `goToPage` 再把 999 clamp 到 3（`:1418`）。

### 7.4 F-5（medium/low）：同一页的重复跳转会被忽略

effect 依赖只有 `params?.page / docInfo.status / docInfo.numPages`，没有 `page`/`goToPage`；同时有 `requested !== page` 守卫。触发序列：

1. forward sync 到第 2 页 → `params.page=2`，`goToPage(2)`，`page=2`；
2. 用户手动滚到第 1 页 → `onScroll` 把 `page` 改成 1（`:1377-1395`）；
3. 再次 forward sync 到第 2 页 → `openTab` 传的 `params.page` 仍是 `2`，**值没变** → effect 不重跑 → 视图停在第一页。

若第二次请求的是第 3 页（值变化）则正常跳转。修复：在 `params` 里带上单调递增的 `requestId`/`seq`，或把 `params.page` 与 `request.seq` 一起作为依赖；不能简单把 `page` 加入依赖（会在手动滚动时被 goToPage 拉回）。

### 7.5 其他 `params.page` 细节

- 服务端 `requestPreview` 存 page 原值（`service.js:664-678`）；`latex_compile(open=true)` 触发预览时用的是 `project.previewPage`（`service.js:623-629`），而 `previewPage` 只由 `requestPreview` 赋值，所以正常构建自动打开时 page 通常是 `undefined`（传给 openTab 时不带 page）——符合“构建后保持当前页”的预期。
- **NOT VERIFIED (agent-side)**：已有 tab 被再次 `openTab` 时，Host 是否更新 `navigation.params`/触发重渲染（`docs/api-cheatsheet.md` 只说明 `navigation.params` 是本次导航参数）；真实浏览器里的首次/换页跳转也未做像素级验证。

---

## 8. CJK / 空格路径专项（编码实测）

### 8.1 矩阵

| 项目形态 | forward | inverse 返回 | 双击可用性 |
| --- | --- | --- | --- |
| ASCII 根 + ASCII 源（`ascii-project`） | ✅ | `main.tex:5` | 文件 ✅ / 行号 ❌（F-1） |
| ASCII 根 + 中文源名（`cjk-file/章节-一.tex`） | ✅ | `�½�-һ.tex:2` | ❌（乱码相对路径） |
| 中文根 + ASCII 源（`中文项目`） | ✅ | `D:/.../������Ŀ/./main.tex:12` | ❌（乱码绝对路径） |
| 中文+空格根（`带 空格 项目`） | ✅ | `D:/.../�� �ո� ��Ŀ/./main.tex:12` | ❌ |
| ASCII 根 + 空格子目录（`multi space/my sections`） | ✅ | `my sections\ch1.tex:4` | ❌（截断成 `my`，F-2） |
| ASCII 空格根 + 根源文件（`space project`） | ✅ | `main.tex:4` | 文件 ✅ / 行号 ❌ |
| 中文内容 + ASCII 路径（`latex-plugin-tests/chinese-ctex`） | ✅ | `main.tex:12` | 文件 ✅ / 行号 ❌ |

**结论：中文“内容”没问题；坏的是中文“路径”。** forward 永远只解析数字，所以不受影响；反查需要把 Input 路径回传给编辑器，才会暴露。

### 8.2 编码证据

`logs/raw-inverse-cjk-path.txt` 里 `Input:` 行的原始字节（UTF-8 解码前）：

```text
49 6E 70 75 74 3A ... 2F D6 D0 CE C4 CF EE C4 BF 2F 2E 2F 6D 61 69 6E 2E 74 65 78
```

`D6 D0 CE C4 CF EE C4 BF` 按 **CP936/GBK** 解码正好是 `中文项目`：

```text
Input:D:/deepseekharness/latex-plugin-tests/e2e/synctex/中文项目/./main.tex
Line:12
```

也就是说：**synctex.exe 把路径按系统 ANSI 代码页（本机 CP936）写 stdout**；DSH 的 subprocess 文本按 UTF-8 解码，非法字节被替换成 U+FFFD，服务再拼进结果。这不是“synctex 找不到文件”（它确实找到了，Line:12 正确），而是**输出编码**问题。

补充实验：在 `cmd /c "chcp 65001 & synctex.exe ..."` 下输出仍是 GBK 字节（`logs/raw-inverse-cjk-utf8.txt` 与 `raw-inverse-cjk-path.txt` 同为 292 B）；`chcp` 不改变该二进制的路径输出编码。

### 8.3 影响与建议

- 影响：中文路径/中文文件名的项目，**双击反查不可用**（打开不存在的 U+FFFD 路径）；工具级 `latex_synctex inverse` 的行号仍正确，只是路径不可用。
- 这与 `docs/web-research.md` §1.6 的调研一致：LaTeX-Workshop 明确“binary cannot handle CJK encodings (#4239)”，inverse 改用纯 JS 解析 `.synctex.gz`。
- 可行修法（未实施，需 Lead 决定）：
  1. 在 Windows 上检测解码失败（出现 U+FFFD）后，用 CP936 重新解码 stdout（Node 可用 `TextDecoder('gbk')`/iconv-lite），或让 subprocess 暴露原始 Buffer；
  2. 用纯 JS 读 `.synctex.gz` 的 `Input` 表，按 tag 把 `Line` 映射回已知源文件，完全不依赖 CLI 的路径回显；
  3. 至少把“inverse 路径不可用”显式转成错误提示，而不是打开一个乱码路径。

---

## 9. 真实限制清单（如实）

1. **双击跳行失效**（F-1）：服务端输出以行号结尾、`Column:-1` 不产生后缀，客户端正则要求行号后有空白/括号 → 行号恒为 `undefined`。文件能打开，跳行不能。
2. **空格路径截断**（F-2）：`syncTeX` 返回的相对路径可以含空格；客户端 `(.+?)(?: |$)` 在第一个空格截断，`source` 变成前缀目录（如 `my`）。
3. **CJK 路径反查乱码**（F-3）：synctex 以 CP936 输出路径，插件以 UTF-8 解码成 U+FFFD；中文根/中文文件名都不可用。forward 不受影响。
4. **stale `.synctex.gz`**（F-4）：synctex 记录的是构建时绝对路径；项目被复制/改名/从别处拷 build 后，inverse 会指向旧项目（本机会静默打开旧文件）。
5. **越界行静默吸附**：line 0/1/-5 → 首个框（y≈140.7）；line 11/12/999 → 末尾框（y≈699.0，多页时是最后一页）。工具按成功返回，调用方无法区分“真实命中”和“吸附”。
6. **坐标越界静默吸附**：x/y 负数或 1e6 都返回 line 11，exit 0，无错误。[`service.js:848-849`](src/service.js) 不校验范围。
7. **页码越界为空结果**：page 99/4 → 只有 banner，exit 0；页面 0 与负数被钳到 1；小数被 round（`service.js:847`）；直接跑 CLI 的小数页码会 `Bad -o argument`（exit -1）。
8. **无 `.synctex.gz` 的 inverse 把 usage 全文塞进结果**：`service.js:873` 不看 exit code（实测 127），stderr 直接进入工具输出（2.8 KB 噪声）。
9. **column 参数无效**：TeX 不记录列，column=1/20/60 输出完全一致；工具还把 column 钳到 ≥1，无法表达 rectangle 模式的 0。
10. **一次查询多条记录**：forward 取第一条 `Page/x/y`（`service.js:894-898`），inverse 取第一条 `Input/Line`（`:884-892`）；同一坐标可能有多条（`cjk-file` 的 (178.88,284.43) 同时命中 line 2/3，服务返回 2）。
11. **15 s 硬超时**：`service.js:843` 固定，无工具参数可调；超时后只回 “no PDF location + 已收集文本”，没有 TIMEOUT 专用状态（本次未触发）。
12. **HTTP 路由未在 agent 侧验证**：`/latex/health` 无需 admission（实测 200），`/latex/state`、`/latex/synctex` 未带授权返回 401；真实 UI 走 admitted 连接，本报告只能验证工具层（与 UI 共用 `service.syncTeX`）与代码路径。
13. **UI 行为 NOT VERIFIED (agent-side)**：双击后的实际 toast/打开位置、已打开 tab 的 `params.page` 跳转、tab 聚焦语义，均未在浏览器里复测（无浏览器自动化）。
14. **UI forward sync 只支持主文件行号**：`client.js:895` 固定 `file=project.mainRelative`；在 `\input` 的章节文件里按当前编辑行 forward 会得到错误位置。工具 `latex_synctex(file="sections/ch1.tex")` 支持章节（实测 F21/F22），但工作台没有对应入口。

---

## 10. 证据文件与复现

### 10.1 副本与脚本

- fixtures：`latex-plugin-tests/e2e/synctex/{ascii-project,multipage,multi-file,multi space,中文项目,带 空格 项目,space project,cjk-file,no-synctex,no-pdf,stale-synctex}/`
- `parse-sim.mjs`：逐字复制 `client.js` 的 forward page / inverse line / source 正则，输出 `logs/parse-sim.txt`。
- `capture-raw.ps1` / `capture-batch.ps1`：用 `Start-Process` / 批量方式抓原始 CLI 输出（保留字节）。

### 10.2 原始输出清单（`latex-plugin-tests/e2e/synctex/logs/`）

| 文件 | 内容 |
| --- | --- |
| `raw-forward-ascii-line5.txt` | line 5 的 4 条记录 |
| `raw-forward-ascii-line999.txt` | line 999 的 3 条记录（含 y=699.048828 / 104.876724） |
| `raw-forward-ascii-missingfile.txt` | `No tag` 警告 |
| `raw-forward-multipage-line10.txt` | page 2 记录 |
| `raw-forward-nosynctex.txt` | 仅 banner |
| `raw-forward-edge-cases.txt` | line 0/1/-5/12/999、column 20/60 的逐条 Page/x/y |
| `raw-inverse-ascii-line5.txt` | 标准 inverse result 块（`Input/Line/Column:-1`） |
| `raw-inverse-ascii-page99.txt` | 页码越界：仅 banner |
| `raw-inverse-edge-cases.txt` | page 99/0/1.6、负坐标、1e6 坐标、正常坐标 |
| `raw-inverse-cjk-path.txt` | 中文根目录 inverse（GBK 字节） |
| `raw-inverse-cjk-utf8.txt` | `chcp 65001` 对照（仍为 GBK） |
| `raw-inverse-cjk-file.txt` | 中文文件名 inverse |
| `raw-inverse-multispace.txt` | `my sections/ch1.tex` 的绝对 Input |
| `raw-inverse-nosynctex.txt` | 无 synctex：ERROR + usage（2 843 B） |
| `parse-sim.txt` | 客户端正则模拟结果（行号丢失、空格截断） |
| `inverse-column-grid.txt` | 10×5 inverse 采样：全部 `Column:-1` |

### 10.3 关键命令（等价复现）

```powershell
# 构建（工具），四类 fixture 各一次
latex_compile(path="...\ascii-project\main.tex", force=true)
latex_compile(path="...\multipage\main.tex", force=true)
latex_compile(path="...\multi space\main.tex", force=true)
latex_compile(path="...\中文项目\main.tex", force=true)

# 工具级查询
latex_synctex(path="...\ascii-project\main.tex", direction="forward", line=5)
latex_synctex(path="...\ascii-project\main.tex", direction="inverse", page=1, x=150.19, y=165.11)

# 原始 CLI（项目根为 cwd 亦可；这里用绝对路径）
& $B view -i "5:1:$root\ascii-project\main.tex" -o "$root\ascii-project\build\main.pdf"
& $B edit -o "1:150.19:165.11:$root\ascii-project\build\main.pdf"

# 列信息采样（10×5 网格，结果全部 Column:-1）
foreach ($y in 100,140,160,180,200,220,260,400,680,699) { foreach ($x in 130,200,300,400,500) { ... } }
```

---

## 11. 给 Lead 的修复建议（不改源码）

| 优先级 | 位置 | 问题 | 建议 |
| --- | --- | --- | --- |
| P0 | `client.js:1470` | 行号正则要求行尾有空白/`(` | 改为 `/:(\d+)(?=\s|\(|$)/`；或让 `service.syncTeX` 返回结构化字段，客户端不做字符串解析 |
| P0 | `client.js:1472` | 空格截断源路径 | 改为从右解析（`/^SyncTeX inverse: (.+?)(?::(\d+))?(?: \(column \d+\))?$/` 并验证），或结构化返回 |
| P0 | `service.js:885-892` + subprocess 解码 | CJK 路径 GBK 被当 UTF-8 | Windows 上用 CP936 重新解码或读原始 Buffer；更好的方案是纯 JS 解析 `.synctex.gz` 的 Input 表 |
| P1 | `client.js:1440-1446` | 同页重复请求不跳 | `params` 增加 `seq`/`requestId`，effect 依赖它，而不是只依赖 `params.page` 的值 |
| P1 | `service.js:873-878` | 忽略 exit code；usage 噪声进入结果 | 检查退出码；失败时返回短错误（例如 “no SyncTeX data for this PDF”），截断 stderr |
| P2 | `service.js:894-898` | forward 越界行被当成功 | 可选：返回 `line`/匹配记录数，或标注“out of range”，让调用方决定 |
| P2 | `service.js:848-849` | x/y 不校验范围 | 对 `x<0 || y<0 || 超出页面` 给出明确提示（需要页面尺寸，可从 `Page`/PDF 拿） |
| P3 | `service.js:887` | `Column:-1` 被丢弃 | 若未来要列信息，接受 `-?\d+` 并区分 `-1`=unknown |
| P3 | `service.js:852` | `file` 可解析到项目根外 | 与安全审查一起决定是否限制在 rootDir 内（当前仅用于在 synctex 输入表里查 tag） |

---

## 12. 未验证项（agent-side）

- 真实浏览器里双击 PDF 后：是否打开正确文件、是否定位到行、toast 文案（`preview.synced/synced`）、以及已打开 tab 的跳页/聚焦——**均未验证**。本文对双击的结论来自 `client.js` 源码 + 原始返回字符串 + 正则模拟（可复核）。
- `POST /latex/synctex-inverse` 与 `GET /latex/synctex` 在 **admitted** HTTP 连接下的行为：无授权请求实测 401（§2），agent 侧无法构造 Host 的 admission 头；工具层与 UI 共用 `service.syncTeX`，因此数值行为应一致。
- 15 s 超时分支、`synctex.exe` 缺失分支：未触发/未破坏 TeX 安装，仅做了源码核对。
- 内建 document preview（`surface=document`）下的 SyncTeX 行为：该表面不是 PDF.js viewer，双击能力属于 native viewer；未验证。

---

## 附录 A：本轮所有 `latex_synctex` / `latex_preview` 调用的原始返回

> 全部为工具实际返回文本（未改写）；路径参数统一指向 `latex-plugin-tests/e2e/synctex/...`。

```text
# forward
line=4                       -> SyncTeX forward: page 1 at (125.798264, 140.742218)
line=5                       -> SyncTeX forward: page 1 at (150.190979, 165.105621)
line=8                       -> SyncTeX forward: page 1 at (301.581146, 194.799942)
line=10                      -> SyncTeX forward: page 1 at (160.674622, 224.458221)
line=11                      -> SyncTeX forward: page 1 at (125.798264, 699.048828)
line=12                      -> SyncTeX forward: page 1 at (125.798264, 699.048828)
line=999                     -> SyncTeX forward: page 1 at (125.798264, 699.048828)
line=0 / 1 / -5              -> SyncTeX forward: page 1 at (125.798264, 140.742218)
line=10.7                    -> SyncTeX forward: page 1 at (125.798264, 699.048828)
line=5 col=20 / col=60       -> SyncTeX forward: page 1 at (150.190979, 165.105621)
line=5 file=does-not-exist   -> no PDF location + banner + "SyncTeX Warning: No tag"
multipage line=5             -> page 1 at (195.354614, 165.105621)
multipage line=10            -> page 2 at (193.674591, 165.105621)
multipage line=12            -> page 2 at (301.581146, 196.138107)
multipage line=18            -> page 3 at (216.343689, 165.105621)
multipage line=999           -> page 3 at (125.798264, 699.048828)
multi-file line=3            -> page 1 at (231.398254, 214.789520)
multi-file file=sections/ch1.tex line=3 -> page 1 at (162.267334, 393.261169)
multi-file file=sections/ch1.tex line=8 -> page 1 at (159.851105, 406.810364)
multi space file=my sections/ch1.tex line=3 -> page 1 at (162.267334, 393.261169)
space project line=3         -> page 1 at (125.798264, 140.742218)
中文项目 line=12             -> page 1 at (165.268341, 321.185242)
中文项目 line=19             -> page 1 at (319.454346, 384.297760)
带 空格 项目 line=12/19      -> 同上（165.268341,321.185242 / 319.454346,384.297760）
cjk-file file=章节-一.tex line=3 -> page 2 at (178.881882, 284.428894)
cjk-file file=章节-一.tex line=2 -> page 2 at (153.867340, 284.428894)
chinese-ctex line=12         -> page 1 at (165.268341, 321.185242)
no-synctex line=10           -> no PDF location + banner
no-pdf line=10               -> SyncTeX needs a built PDF first: ...\no-pdf\build\main.pdf does not exist. Run latex_compile.
stale-synctex line=5         -> page 1 at (150.190979, 165.105621)

# inverse
ascii (150.19,165.11)        -> SyncTeX inverse: main.tex:5
ascii (160.67,224.46)        -> SyncTeX inverse: main.tex:10
ascii (125.8,699.05)         -> SyncTeX inverse: main.tex:11
ascii (-50,-50)              -> SyncTeX inverse: main.tex:11
ascii (1e6,1e6)              -> SyncTeX inverse: main.tex:11
ascii page=99 (100,100)      -> no source location + banner
ascii page=-3 (150.19,165.11)-> SyncTeX inverse: main.tex:5
ascii page=1.6 (150.19,165.11) -> no source location + banner (round→2)
multipage page=2 (193.67,165.11) -> main.tex:10
multipage page=2 (301.58,196.14) -> main.tex:12
multipage page=3 (216.34,165.11) -> main.tex:18
multipage page=4 (100,100)   -> no source location + banner
multipage page=2 (0,0)       -> main.tex:16
multi-file (162.27,393.26)   -> sections\ch1.tex:4
multi space (162.27,393.26)  -> my sections\ch1.tex:4
space project (125.8,140.74) -> main.tex:4
中文项目 (165.27,321.19)     -> D:/.../������Ŀ/./main.tex:12
中文项目 (319.45,384.30)     -> .../������Ŀ/./main.tex:18
中文项目 (319.45,390)        -> .../������Ŀ/./main.tex:19
中文项目 (150,384.3)         -> .../������Ŀ/./main.tex:18
带 空格 项目 (165.27,321.19) -> D:/.../�� �ո� ��Ŀ/./main.tex:12
带 空格 项目 (319.45,384.3)  -> ...:18
chinese-ctex (165.27,321.19) -> main.tex:12
cjk-file (178.88,284.43)     -> �½�-һ.tex:2
cjk-file (153.87,284.43)     -> �½�-һ.tex:2
no-synctex                  -> no source location + banner + ERROR/usage (exit 127)
stale-synctex (150.19,165.11)-> D:/.../ascii-project/./main.tex:5

# preview page requests
latex_preview(multipage, page=2)   -> ... page: 2   (v1793694443141, 3 pages)
latex_preview(multipage, page=999) -> ... page: 999 (v1793694443141, 3 pages)
```
