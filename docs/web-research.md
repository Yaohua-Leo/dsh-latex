# Prior art for a native LaTeX plugin — research notes

Status: research complete (2026-11-03).
Audience: implementers of `dsh-latex` (host build pipeline, log parser, SyncTeX, PDF.js viewer).

Method:

- Primary source read at a pinned commit: **LaTeX-Workshop** `bf7d26577b2fe744cd6b1766dcfb32c394f18a4c`
  (commit dated 2026-11-03). All `#L…` anchors below are pinned to that SHA.
- **latexmk** manual (`latexmk.txt`, "9 March 2026", man-page for latexmk **4.88**) and
  `latexmk.pl` source, both from CTAN.
- **Verified locally** against the toolchain this plugin targets
  (`D:\latex\texlive2023\…\bin\windows`, latexmk **4.79**, XeTeX 3.141592653-2.6-0.999995,
  `synctex` CLI 1.5, pdf.js **5.4.296** in `assets/`). Probe transcripts are reproduced
  verbatim; they are marked **[verified locally]**.
- Overleaf's log parser (the other mature open-source implementation), pdf.js API docs,
  Node/Windows process docs, chokidar docs.

Reference implementation index (all in LaTeX-Workshop):

| Concern | File |
| --- | --- |
| Root detection | `src/core/root.ts` |
| Recipe / tool model | `src/compile/recipe.ts`, `src/compile/plan.ts`, `src/compile/step.ts` |
| Placeholders (`%DOC%`, `%OUTDIR%` …) | `src/utils/utils.ts` (`replaceArgumentPlaceholders`) |
| Log parsers | `src/parse/parser/{latexlog,bibtexlog,biberlog}.ts` |
| Diagnostics → `file:line` | `src/parse/parser/parserutils.ts` |
| SyncTeX | `src/locate/synctex.ts`, `src/locate/synctex/synctexjs.ts` |
| Viewer refresh/state | `viewer/components/{state,refresh}.ts`, `src/preview/viewer.ts` |
| Loopback asset server | `src/preview/server.ts` |

---

## 0. Executive summary (the 12 facts that change our design)

1. Root detection is a **4-stage cascade**, not one heuristic: magic comment → active file
   (indicator regex, or `subfiles` package) → "is the active file still inside the current
   root's `\input` graph" → workspace scan with include/exclude globs. The magic-comment
   chain is followed **transitively with loop detection**.
2. The default commands are short and boring: `latexmk -synctex=1 -interaction=nonstopmode
   -file-line-error -pdf -outdir=%OUTDIR% -auxdir=%AUXDIR% %DOC%`. XeLaTeX is **not** a
   different program, it is the same `latexmk` with `-xelatex` instead of `-pdf`.
3. `-xelatex` on modern latexmk is documented as **equivalent to `-pdfxe`**: xelatex writes
   `.xdv`, and the `.pdf` is produced **once** by `xdvipdfmx` after the last rerun. Consequence:
   the PDF does not flicker through intermediate states on multi-pass builds, and **a build
   that fails produces no new PDF at all** (verified: failure leaves only `main2.xdv`).
4. TeX Live/non-MiKTeX **does not support `-aux-directory`**; latexmk emulates it by passing
   `-output-directory=<auxdir>` to `*latex` and then moving the final files. Only MiKTeX has a
   native aux dir. So: prefer a single `-outdir`, or accept emulation.
5. With `-outdir`, `\include{sections/part}` **fails on TeX Live** unless `<outdir>/sections/`
   already exists — `./main.tex:3: I can't write on file `sections/part.aux'. [verified locally]`.
   Pre-creating the directory makes the same build exit 0.
6. latexmk exit codes are specific and worth branching on:
   **0** ok · **11** main source not found · **12** errors while processing (normal "compile
   failed") · **10** bad usage · **20** internal/previewer bug · propagated code of an external
   command otherwise. **[verified locally: 12]**
7. The canonical robust error line under `-file-line-error` is
   `./main2.tex:5: Undefined control sequence.` — note the leading `./`, relative to **the TeX
   process cwd (project root)**, not to the log directory. The classic form is `! LaTeX Error:
   …` followed by `l.5 \UndefinedMacro` and a hint block. A parser must handle **both
   simultaneously in the same log** (verified: the missing-package error stays in `!` form even
   with `-file-line-error`).
8. LaTeX wraps log lines at **`max_print_line`**, default 79 columns — verified:
   `./main2.tex:9: LaTeX Error: \begin{itemize} on input line 7 ended by \end{docum` (len 79)
   + `ent}.`. Two standard mitigations: set `max_print_line=10000` in the child env
   (LaTeX-Workshop) or `--max-print-line=10000` for MiKTeX pdfLaTeX, and/or join wrapped lines
   in the parser (Overleaf's rule).
9. SyncTeX forward is one CLI call: `synctex view -i "<line>:<col>:<abs .tex>" -o "<abs .pdf>"`
   → block between `SyncTeX result begin/end` with `Page:`, `x:`, `y:` (+ `h,v,W,H,before,
   offset,middle,after`). Inverse is `synctex edit -o "<page>:<x>:<y>:<abs .pdf>"` → `Input:`,
   `Line:`, `Column:`, `Offset:`, `Context:`. **[verified locally]**
10. LaTeX-Workshop deliberately uses the **pure-JS** syncTeX reader for *inverse* sync because
    "the binary cannot handle CJK encodings (#4239)" — directly relevant for Chinese users.
11. Viewer refresh is a **handshake, not a reload**: extension sends `{type:'refresh'}`, client
    snapshots `{page, scale, scrollMode, sidebarView, spreadMode, scrollTop, scrollLeft}`,
    re-`getDocument`s the PDF, restores the snapshot on `pagerendered`, and acknowledges with
    `{type:'done'}`; a second refresh during a refresh is coalesced into `shouldRefreshAgain`.
12. Never parse or re-render the PDF ourselves. pdf.js v5 (`5.4.296`) already ships in
    `assets/`: `getDocument({data})`, `GlobalWorkerOptions.workerSrc`, `page.render({canvas,
    viewport})`, `TextLayer`. Apache-2.0.

---

## 1. LaTeX-Workshop (the most relevant prior art)

### 1.1 Root document detection

Entry point: `find()` iterates a fixed list of strategies and stops at the first hit
([`src/core/root.ts#L43-L86`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/core/root.ts#L43-L86)):

```ts
const findMethods = [ findFromMagic, findFromActive, findFromRoot, findInWorkspace ]
```

Note the ordering: **magic comment beats the file's own `\documentclass`**, and the
"previous root still valid?" check runs *after* the active-file check, so renaming/switching
tabs cannot pin a stale root.

**(a) Magic comment `% !TEX root`** ([#L157-L198](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/core/root.ts#L157-L198))

```js
/^(?:%\s*!\s*T[Ee]X\sroot\s*=\s*(.*\.(?:tex|[jrsRS]nw|[rR]tex|jtexw))$)/m
```

Algorithm, verbatim from the code:

```text
fileStack = []
content   = activeEditor.text; filePath = activeEditor.fileName
while (m = content.match(regex)):
    filePath = path.resolve(path.dirname(filePath), m[1])   // relative to the *current* file
    if filePath in fileStack: return filePath               // loop -> give up, return it
    fileStack.push(filePath)
    content = read(filePath); if (!content) return          // target does not exist -> none
return fileStack.last() ?? undefined
```

Details worth copying: resolution is **relative to the file that holds the comment** (so a
chapter in `chapters/` may say `% !TEX root = ../main.tex`), the chain is transitive, a cycle
returns the repeated path instead of hanging, and a missing target silently yields *no* root
(not a broken root). The whole feature is behind `latex.build.enableMagicComments`.

**(b) Indicator regex for the active file** ([#L97-L113](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/core/root.ts#L97-L113))

| Setting `latex.rootFile.indicator` | Regex |
| --- | --- |
| `\documentclass[]{}` (default) | `/\\documentclass(?:\s*\[.*\])?\s*\{.*\}/ms` |
| `\begin{document}` | `/\\begin\s*{document}/m` |
| `\starttext` | `/\\starttext/m` |
| `\startTEXpage` | `/\\startTEXpage/m` |

`findFromActive` ([#L235-L263](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/core/root.ts#L235-L263)) runs the indicator against
`stripCommentsAndVerbatim(content)`, i.e. comments, `\verb…` and verbatim-like environments are
blanked first ([`src/utils/utils.ts#L106-L112`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/utils/utils.ts#L106-L112)) — otherwise a commented-out
`\documentclass` in a chapter would win.

Two shortcuts live here:

- `.dtx` / `.ltx` are "always a root" extensions
  ([`src/lw.ts#L64`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/lw.ts#L64): `ACTIVE_ROOTFILE_EXT: ['.dtx', '.ltx']`);
- `subfiles` package: a file whose preamble contains `\documentclass[<root>]{subfiles}` is not
  a root; the root is `<root>` ([#L275-L286](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/core/root.ts#L275-L286)):

```js
/(?:\\documentclass\[(.*)\]{subfiles})/s
```

**(c) "Is the old root still valid?"** ([#L208-L224](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/core/root.ts#L208-L224)) — keeps the previous root iff the active file is
a LaTeX file **and** is a member of `cache.getIncludedTeX()` (the `\input`/`\include` graph built
from parsing, later cross-checked against the `.fls` file). This is what makes chapter editing
stable.

**(d) Workspace scan fallback** ([#L299-L351](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/core/root.ts#L299-L351))

Defaults (`package.json`):

```json
"latex-workshop.latex.search.rootFiles.include": ["**/*.tex", "**/*.rnw", "**/*.Rnw"],
"latex-workshop.latex.search.rootFiles.exclude": []
```

Ordering inside the scan:

1. if the candidate's `.fls` children contain the active file → **immediate** winner
   (`.fls` is the ground truth of a real previous build);
2. else if the candidate contains the active file in its `\input` graph → `candidates.unshift()`;
3. else `candidates.push()`;
4. if the current root is among the candidates, keep it; otherwise take `candidates[0]`.

**What we should steal:** the stage order, the transitive magic chain with cycle detection,
"relative to the file holding the directive", and `.fls` as the tie-breaker. **What we should
not:** LaTeX-Workshop's scan is interactive (it prompts when ambiguous); a headless agent
plugin should instead pick deterministically (fewest-includes / `main.tex|paper.tex|thesis.tex`
preference, as `dsh-latex` already documents).

### 1.2 Build recipes: tools and steps

Model (`package.json` → `contributes.configuration`):

```jsonc
// latex-workshop.latex.recipes — an ordered list of named recipes
[{ "name": "latexmk", "tools": ["latexmk"] },
 { "name": "latexmk (xelatex)", "tools": ["xelatexmk"] },
 { "name": "pdflatex -> bibtex -> pdflatex * 2",
   "tools": ["pdflatex", "bibtex", "pdflatex", "pdflatex"] }]

// latex-workshop.latex.tools — named commands
{ "name": "xelatexmk", "command": "latexmk",
  "args": ["-synctex=1", "-interaction=nonstopmode", "-file-line-error",
           "-xelatex", "-outdir=%OUTDIR%", "-auxdir=%AUXDIR%", "%DOC%"] }
```

A tool object is `{name, command, args?, cwd?, env?}`; a recipe is `{name, tools}` where each
entry is either a tool **name** or an inline tool object. So "steps" are just an array:
`Recipe.tools` is a `(string | Tool)[]` expanded by `Plan` into ordered `Step`s
([`src/compile/recipe.ts#L13-L35`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/recipe.ts#L13-L35),
[`src/compile/plan.ts#L123-L141`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/plan.ts#L123-L141)).

Recipe selection ([`#L187-L228`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/recipe.ts#L187-L228)):

```text
explicit name → "lastUsed" (remembered per languageId) → first language-compatible recipe
languageId changes (rsweave/jlweave/pweave) invalidate the remembered recipe
```

Magic comments that alter the build
([`#L102-L149`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/recipe.ts#L102-L149)), scanned **only in the leading `%` comment
block** of the root file (the loop breaks at the first non-comment, non-blank line):

```js
/^(?:%\s*!\s*T[Ee]X\s(?:TS-)?program\s*=\s*([^\s]*)$)/m     // % !TEX program = xelatex
/^(?:%\s*!\s*T[Ee]X\s(?:TS-)?options\s*=\s*(.*)$)/m        // % !TEX options = -shell-escape
/^(?:%\s*!\s*BIB\s(?:TS-)?program\s*=\s*([^\s]*)$)/m       // % !BIB program = biber
/^(?:%\s*!\s*BIB\s(?:TS-)?options\s*=\s*(.*)$)/m
/^(?:%\s*!\s*LW\srecipe\s*=\s*(.*)$)/m                     // % !LW recipe = latexmk (xelatex)
```

When a magic *program* is present and no recipe name is given, the recipe is synthesized as a
**fixed 4-step cycle** (`#L157-L180`):

```ts
return [texTool, bibTool, texTool, texTool]   // tex, bib, tex, tex
```

— for a bare `% !TEX program`, `latex.magic.args` is used
(`["-synctex=1","-interaction=nonstopmode","-file-line-error","%DOC%"]`), and `% !BIB program`
defaults to `latex.magic.bib.args` = `["%DOCFILE%"]`.

Portability note: because `% !TEX options = -shell-escape -synctex=1` is a **string**, its tool
must run through a shell (`spawn(cmd, [], {shell:true})`) — LaTeX-Workshop does exactly that and
flags it as a special case ([`src/compile/step.ts#L164-L190`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/step.ts#L164-L190)). A plugin whose security stance is
"no shell, argv only" should either parse the options string with a small argv tokenizer or
ignore `% !TEX options` and log a diagnostic. (`-shell-escape` should stay refused.)

### 1.3 Placeholder expansion (copy this table verbatim)

[`src/utils/utils.ts#L296-L341`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/utils/utils.ts#L296-L341). All paths are produced with `/` separators
(`dir.split(path.sep).join('/')`) because TeX accepts `/` on Windows but a `\` inside an argument
can be eaten as an escape.

| Placeholder | Value |
| --- | --- |
| `%DOC%` | `<dir>/<basename>` (no extension) |
| `%DOC_W32%` | same, backslashes |
| `%DOC_EXT%` / `%DOC_EXT_W32%` | `<dir>/<basename>.tex` |
| `%DOCFILE%` / `%DOCFILE_EXT%` | basename / basename + extension |
| `%DIR%` / `%DIR_W32%` | root file directory |
| `%OUTDIR%` / `%OUTDIR_W32%` | expanded `latex.outDir` (default `%DIR%`) |
| `%AUXDIR%` | expanded `latex.auxDir` (default `%OUTDIR%`) |
| `%TMPDIR%` | extension temp dir |
| `%WORKSPACE_FOLDER%` | first workspace folder |
| `%RELATIVE_DIR%` / `%RELATIVE_DOC%` | relative to workspace folder |
| `%RELATIVE_CWD_DIR%` / `%RELATIVE_CWD_DOC%` | relative to the recipe cwd |

Two ordering traps that the code comments call out:

```ts
// Replace %AUXDIR% first as its default value is %OUTDIR%
expand(arg).replace(/%AUXDIR%/g, auxDir).replace(/%OUTDIR%/g, outDir)
```

and outdir itself is expanded **through the same function**, so `latex.outDir` may itself contain
`%DIR%`/`%DOCFILE%` (that is how the default `%DIR%` works).

### 1.4 Running latexmk on Windows

Exact default argv (`latex-workshop.latex.tools`):

```text
latexmk
  -synctex=1
  -interaction=nonstopmode
  -file-line-error
  -pdf | -xelatex | -lualatex
  -outdir=%OUTDIR%
  -auxdir=%AUXDIR%
  %DOC%                  ← "<abs dir>/<basename>", no .tex
```

Process handling, all in `src/compile/step.ts`:

- **env**: `{...process.env, ...tool.env, max_print_line: '10000'}`
  ([#L152-L157](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/step.ts#L152-L157)). `max_print_line` is not cosmetic — it is how the parser
  avoids 79-column wrapping. For MiKTeX `pdflatex`, the equivalent is a command-line option
  `--max-print-line=10000`, added only when `pdflatex --version` contains `MiKTeX`
  ([`src/compile/plan.ts#L179-L222`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/plan.ts#L179-L222)).
- **cwd**: `tool.cwd ?? recipe cwd` (`getWorkingFolder(rootFile)` = the root file's directory);
  a relative `tool.cwd` is resolved against the recipe cwd
  ([`src/compile/plan.ts#L131-L134`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/plan.ts#L131-L134)).
- **outdir/auxdir discovery**: arguments are *matched back out* of the tool's argv so later
  stages know where the log/PDF are
  ([`src/compile/plan.ts#L166-L172`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/plan.ts#L166-L172)):

```js
/^--?out(?:-directory|dir)=/     /^--?aux(?:-directory|dir)=/
```

- **kill tree** ([#L96-L138](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/step.ts#L96-L138)): `taskkill /F /T /PID <pid>` on Windows (`pkill -P <pid>` on
  Unix), then `child.kill()`; first error wins, and the tree kill is validated (`status !== 0` →
  throw).
- **outcome** ([#L236-L241](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/step.ts#L236-L241)): `signal === 'SIGTERM' ? 'terminated' : code === 0 ? 'succeeded' : 'failed'`.
  Note `SIGTERM` is how Node reports **our own** kill; it must not be reported as a compile error.
- **engine fingerprint**: `stdout.match(/l3backend-(.*?)\.def/)?.[1] ?? 'unknown'`
  ([#L231](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/step.ts#L231)) — a cheap way to learn the real backend when a recipe is overridden.

### 1.5 Log parsing pipeline

Files: `src/parse/parser/{latexlog,bibtexlog,biberlog,dvipdfmxlog}.ts`, each exporting the same
shape ([`parserutils.ts#L5-L11`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/parserutils.ts#L5-L11)):

```ts
interface IParser { clearLog(): void; showLog(): void; parse(log: string, rootFile?: string): LogEntry[] }
type LogEntry = { type: string, file: string, text: string, line: number, errorPosText?: string }
```

`type` ∈ `error | warning | information | typesetting`; mapped to severity
`Information | Warning | Error | Information` ([`parserutils.ts#L39-L44`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/parserutils.ts#L39-L44)).

**Regex inventory** (verbatim, [`latexlog.ts#L9-L34`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/latexlog.ts#L9-L34)):

```js
const latexError       = /^(?!.*ignored error)(?:(.*):(\d+):|!)(?:\s?(.+) [Ee]rror:)? (.+?)$/
const latexOverfullBox = /^(Overfull \\[vh]box \([^)]*\)) in paragraph at lines (\d+)--(\d+)$/
const latexOverfullBoxAlt   = /^(Overfull \\[vh]box \([^)]*\)) detected at line (\d+)$/
const latexOverfullBoxOutput= /^(Overfull \\[vh]box \([^)]*\)) has occurred while \\output is active(?: \[(\d+)\])?/
const latexUnderfullBox     = /^(Underfull \\[vh]box \([^)]*\)) in paragraph at lines (\d+)--(\d+)$/
const latexUnderfullBoxAlt  = /^(Underfull \\[vh]box \([^)]*\)) detected at line (\d+)$/
const latexUnderfullBoxOutput = /^(Underfull \\[vh]box \([^)]*\)) has occurred while \\output is active(?: \[(\d+)\])?/
const latexInfo  = /^((?:(?:Class|Package|Module) \S*)|LaTeX(?: \S*)?|LaTeX3) (Info):\s+(.*?)(?: on(?: input)? line (\d+))?(\.|\?|)$/
const latexWarn  = /^((?:(?:Class|Package|Module) \S*)|LaTeX(?: \S*)?|LaTeX3) (Warning):\s+(.*?)(?: on(?: input)? line (\d+))?(\.|\?|)$/
const latexPackageWarningExtraLines = /^\((.*)\)\s+(.*?)(?: +on input line (\d+))?(\.)?$/
const latexMissChar    = /^\s*(Missing character:.*?!)/
const latexNoPageOutput= /^No pages of output\.$/
const bibEmpty         = /^Empty `thebibliography' environment/
const biberWarn        = /^Biber warning:.*WARN - I didn't find a database entry for '([^']+)'/
const UNDEFINED_REFERENCE = /^LaTeX Warning: (Reference|Citation) `(.*?)' on page (?:\d+) undefined on input line (\d+).$/
const messageLine      = /^l\.\d+\s(\.\.\.)?(.*)$/
```

Group mapping for `latexError` (this is the heart of the parser):

| group | meaning |
| --- | --- |
| 1 | file, only for `file:line:` form |
| 2 | line, only for `file:line:` form |
| 3 | "package-ish" prefix before ` Error:` — `LaTeX`, `Package foo`, `Class bar`, … |
| 4 | message |

File resolution for the `file:line:` form:
`path.resolve(path.dirname(state.rootFile), result[1])` — i.e. **relative to the project root**,
not to the build directory where the `.log` lives ([`#L230-L244`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/latexlog.ts#L230-L244)).

Note the negative lookahead `(?!.*ignored error)`: TeX prints
`! LaTeX Error: \begin{…} on input line 7 ended by \end{…}. … (your command was ignored)` — the
parser refuses to treat the "ignored" echo as a second error.

**Parser state machine** ([`#L54-L74`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/latexlog.ts#L54-L74)):

```ts
{ searchEmptyLine, insideBoxWarn, insideError, currentResult, nested, rootFile, fileStack }
```

Per-line order of decisions (`parseLine`, [`#L101-L249`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/latexlog.ts#L101-L249)):

```text
1  if insideBoxWarn: skip exactly one line (the over/underfull box body line), clear flag
2  if searchEmptyLine (a multi-line message is open):
      blank line                      -> close message
      insideError && line starts \\s  -> close message
      else if /^\\((.*)\\)\\s+(.*)/     -> same package warning continues; append, update line
      else if insideError && /^l\\.\\d+\\s/ -> record errorPosText, close (hint block dropped)
      else                            -> append to message text
3  apply the user's exclusion regex list (message.latexlog.exclude)
4  undefined reference/citation special-case
5  over/underfull box special-case
6  "No pages of output."  -> error
7  "Missing character: …!" -> warning
8  Class|Package|LaTeX (Info)   -> information
9  Class|Package|LaTeX (Warning)-> warning
10 "Biber warning: …" -> warning, then recurse on the remainder of the line
11 latexError -> error, file/line as above, open multi-line collection
12 otherwise: feed the parentheses scanner to maintain fileStack
```

The **file stack** is the only mechanism that attributes warnings to the right file
([`#L317-L340`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/latexlog.ts#L317-L340)). For every `(`/`)` in the line it strips
up to the paren, and on `(` matches a path:

```js
// POSIX, Windows drive letters, ./ and \\\\server prefixes
/^"?((?:(?:[a-zA-Z]:|\.|\/)?(?:\/|\\\\?))[^"()[\]]*)/
// MiKTeX prints bare names; treat as ./<name>
/^"?([^"()[\]]*\.[a-z]{3,})/
```

and pushes/pops `fileStack`; `nested` absorbs parens that are not files (a `(` without a
recognisable path increments `nested` instead of pushing). The current file for a diagnostic is
the **top of the stack**, resolved against the root file's directory (`#L110-L111`).

If the stack empties (unbalanced `)`), it is reset to `[rootFile]` (`#L245-L248`).

**Precise column** (`errorPosText`) → `parserutils.getErrorPosition`
([`#L13-L37`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/parserutils.ts#L13-L37)): it reads the *source line* from the document cache,
`indexOf(errorPosText)`, then highlights only the **last word** of the echoed text
(`len = text.length - text.lastIndexOf(' ') - 1`). This is how `l.5 \UndefinedMacro` becomes a
range over `\UndefinedMacro` rather than the whole line — worth copying for agent UX (the tool
can quote the exact token).

**File-stack caveat** worth documenting in our parser: attribution is only as good as TeX's
paren bookkeeping. Packages that do `\openout` bookkeeping, `.fls`-generated files, and
`\input` inside `\begin{document}` can shift the stack; LaTeX-Workshop mitigates by
1) never reporting a warning whose file does not exist (see `convertFilenameEncoding`,
`parserutils.ts#L68-L79`) and 2) preferring `l.N` when it can.

**BibTeX / Biber** parsers are tiny and reusable
([`bibtexlog.ts#L8-L13`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/bibtexlog.ts#L8-L13),
[`biberlog.ts#L8-L11`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/biberlog.ts#L8-L11)):

```js
// bibtex
/^Warning--(.+)\n--line (\d+) of file (.+)$/gm
/^Warning--(.+) in ([^\s]+)\s*$/gm
/^(.*)---line (\d+) of file (.*)\n([^]+?)\nI'm skipping whatever remains of this entry$/gm
/^(A bad cross reference---entry ".+?"\nrefers to entry.+?, which doesn't exist)$/gm
/^(.*)---while reading file (.*)$/gm
// biber (stderr, "-" separated levels)
/^INFO - Found BibTeX data source '(.*)'$/
/^ERROR - BibTeX subsystem.*, line (\d+), (.*)$/
/^WARN - (I didn't find a database entry for '.*'.*)$/
/^WARN - (.* entry '(.*)' .*)$/
```

Practical note for a first version: bibtex/biber problems usually surface in the main log as
`LaTeX Warning: Citation 'x' undefined` on the *next* pass, which the main parser already
handles; a separate biblatex pass is a nice-to-have.

### 1.6 SyncTeX (forward / inverse)

**Forward** ([`src/locate/synctex.ts#L318-L374`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/locate/synctex.ts#L318-L374)):

```ts
const args = ['view', '-i',
  `${line}:${indicator === 'rectangle' ? 0 : col + 1}:${filePath}`,   // filePath absolute
  '-o', pdfUri.fsPath]
spawn('synctex', args, { cwd: path.dirname(pdfUri.fsPath) })
```

Two modes, chosen by config `synctex.indicator`:

- `rectangle` → `col = 0` and the **list** parser: several records, each opened by an `Output:`
  line, exposing `Page,h,v,W,H,x,y`
  ([#L84-L134](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/locate/synctex.ts#L84-L134));
- `circle`/`none` → `col+1` and a single record with `page,x,y`
  ([#L38-L68](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/locate/synctex.ts#L38-L68)).

Parsing rule that matters: iterate lines, start at `SyncTeX result begin`, stop at
`SyncTeX result end`, split on the **first** `:`, lowercase the key, `Number(value)`; keys other
than `page|x|y` (or `Page|h|v|W|H|x|y`) are ignored. Numbers are already in **bp**.

**Inverse** ([`#L474-L530`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/locate/synctex.ts#L474-L530)) — and this is the important design lesson:

```ts
// We only use synctex.js for backward sync as the binary cannot handle CJK encodings #4239.
const temp = await syncTeXToTeX(data.page, data.pos[0], data.pos[1], pdfUri)   // pure JS
```

So: forward = CLI, inverse = parse the `.synctex.gz` in JS
([`src/locate/synctex/synctexjs.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/locate/synctex/synctexjs.ts), which is
[MIT, © 2018 Thomas Durieux, `tdurieux/synctex-js`](https://github.com/tdurieux/synctex-js)).

After parsing, the returned `Input:` path is normalised: strip CR/LF, then resolve symlinks by
comparing against the project's known file paths (kpathsea/SyncTeX follow symlinks,
`#L512-L529`), then `path.resolve()`.

Both directions reject a non-zero exit and fall back (`#L355-L373`), so a failed `synctex`
never breaks the feature — it just returns nothing.

### 1.7 PDF viewer: refresh strategy and state retention

**What state is kept** (`viewer/components/state.ts#L38-L51`):

```ts
{ pdfFileUri, scale: pdfViewer.currentScaleValue, scrollMode, sidebarView,
  spreadMode, scrollTop, scrollLeft, synctexEnabled, autoReloadEnabled }
```

`scrollTop/scrollLeft` are read from `#viewerContainer` (the scrollable div), **not** from the
page; `scale` is `currentScaleValue` — the *string* form (`'auto'`, `'page-width'`,
`'page-fit'`, or a number) — which is exactly what you want to restore across a reload.

**Refresh handshake** (`viewer/components/refresh.ts`):

```text
refresh():
  if (refreshing) { shouldRefreshAgain = true; return }        // coalesce
  refreshing = true; timer = setTimeout(doneRefresh, 1000)     // fail-safe
  prevState = snapshot()                                       // L58-L67
  PDFViewerApplicationOptions.set('showPreviousViewOnLoad', false)   // L71  ← critical
  PDFViewerApplicationOptions.set('spreadModeOnLoad', prevState.spreadMode) // L76
  masks = addMasks()                                           // L79-L87 + L161-L201
  doc = await pdfjsLib.getDocument({url: pdfUrl, cMapUrl: '../cmaps/'}).promise   // L91-L95
  PDFViewerApplication.load(doc)                               // L95
  ... on every 'pagerendered': when all visible pages are FINISHED -> remove masks  // L80-L88
restoreState():                                                // L101-L130
  currentPageNumber = prevState.page
  currentScaleValue = prevState.scale
  switchView(sidebarView); scrollMode; spreadMode
  viewerContainer.scrollTop / scrollLeft = prevState...
```

Why `showPreviousViewOnLoad = false`: pdf.js would otherwise restore *its* remembered position
(or the last clicked internal link) and fight the explicit restore — comment at `#L69-L71`.

Why the masks: `addMasks()` snapshots the currently visible canvases with
`canvas.toDataURL()` into absolutely-positioned `<div>`s, then fades them out when the new
pages have rendered. User-visible effect: no white flash between builds. Cheap, ~40 lines,
worth adopting.

**Extension-side gating** — the recompile-vs-refresh loop is broken by a counter, not by mtime
([`src/preview/viewer.ts#L31-L36`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/preview/viewer.ts#L31-L36)):

```ts
lw.watcher.pdf.onChange(pdfUri => {
    if (lw.compile.compiledPDFWriting === 0 || path.relative(lw.compile.compiledPDFPath, pdfUri.fsPath) !== '') {
        refresh(pdfUri)
    }
})
```

i.e. "ignore PDF writes while a build is writing the PDF; refresh only when quiescent".
`compiledPDFWriting` is incremented before the plan and decremented via `setTimeout` after it
([`src/compile/executor.ts#L225`, `#L254`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/executor.ts#L225)) — a timer, because the last write can land after
the process exits.

**One viewer per file**: `manager.getClients(pdfUri)` returns a set; panels are revealed
(`panel.webviewPanel.reveal(undefined, true)`) rather than duplicated
([`src/preview/viewer.ts#L41-L76`, `#L164`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/preview/viewer.ts#L164)).

**Reload rate limit**: a webview reload (needed when the served URL changes) is capped at
`RELOAD_LIMIT` per `RELOAD_WINDOW` so an unreachable server cannot cause an endless reload loop
([`src/preview/viewer/pdfviewerpanel.ts#L9-L10`, `#L69-L89`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/preview/viewer/pdfviewerpanel.ts#L69-L89)).

**Loopback asset server** ([`src/preview/server.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/preview/server.ts)):
`httpServer.listen(port, hostname ?? '127.0.0.1')` (#L165-L166); the PDF is served from
`/pdf/<base64url(encodeURIComponent(path))>` and is **rejected unless a client is currently
viewing that exact file** (#L264-L287) — a simple, effective allowlist; pdf.js assets are served
from `node_modules/pdfjs-dist` with a path-traversal guard
(`path.posix.resolve('/', url)` then `path.resolve(root, '.' + name)`, #L312-L317) and
site-isolation headers (`Cross-Origin-Resource-Policy: same-origin`,
`Cross-Origin-Embedder-Policy: require-corp`, `X-Content-Type-Options: nosniff`, #L238-L248).

---

## 2. latexmk

Source of truth: [CTAN latexmk](https://ctan.org/pkg/latexmk) — `latexmk.txt` man page for
**4.88** (dated 9 March 2026). Local install used for probes is **4.79**.

### 2.1 Options we care about

| Option | Behaviour (manual) | Notes for us |
| --- | --- | --- |
| `-pdf` | generate PDF **using pdflatex**; turns off incompatible requests | default recipe |
| `-pdflua` / `-lualatex` | lualatex | |
| `-pdfxe` / `-xelatex` | xelatex → `.xdv`, then **one** `xdvipdfmx` at the end. The manual states `-xelatex` is *equivalent to* `-pdfxe` | fewer PDF rewrites, faster on large images, and **no PDF at all** if the run errors |
| `-synctex=1` | **not a latexmk option**; it is one of the `*latex` options latexmk accepts and passes through (inserted where `%O` appears in the `$pdflatex`/`$xelatex` command strings) | same for `-interaction=…`, `-file-line-error`, `-jobname=…`, `-recorder`, `-shell-escape` |
| `-interaction=nonstopmode` | passthrough; keeps TeX from prompting | without it a missing package **hangs** |
| `-file-line-error` | passthrough; TeX emits `file:line: message` | the whole log parser hinges on this |
| `-outdir=DIR` / `-output-directory=DIR` | all `*latex` output goes to DIR (PDF+DVI+PS+synctex); with a *different* `-auxdir`, only final outputs go here | use one directory; see 2.2 |
| `-auxdir=DIR` / `-aux-directory=DIR` | aux files (.aux,.log,…). **MiKTeX only.** TeX Live does not support it — latexmk then *emulates*: it passes `-output-directory=<aux>` and moves final outputs itself (manual: "AUXILIARY AND OUTPUT DIRECTORIES"; source `$emulate_aux`) | emulation means the PDF appears in the aux dir first; our watcher must not fire on it |
| `-out2dir=DIR` | *experimental* final-output directory, mainly to stop viewers reloading intermediate PDFs during multi-pass builds | a cleaner alternative to "ignore writes" if we ever need it |
| `-cd` | chdir to the main source file's directory first (`$do_cd=1`) | only needed when invoking with an absolute path from another cwd |
| `-cd-` | default |
| `-c` | remove *regeneratable* files (aux, log, toc, …) but keep PDF/DVI/PS | our `latex_clean` |
| `-C` | like `-c` **plus** the final output files (PDF/DVI/PS) | |
| `-gg` | "super go mode": clean as `-C`, then a full make | our `force` |
| `-g` | force each rule to run at least once (keep aux) | "rerun everything but keep caches" |
| `-f` | keep going after errors | **do not** set by default: it hides the error exit code |
| `-use-make` | let `make` try to build missing graphics/inputs | not needed; can execute arbitrary project Makefiles |
| `-r <file>` | read an extra RC file (later ones override earlier ones) | |
| `-norc` | do not read any RC file | **do not** use by default — it silently drops the user's `.latexmkrc` recipe |
| `-silent` / `-quiet` | suppress chatter | harmless; we parse the `.log` anyway |

Passing an option that latexmk does not know is a hard error, so always keep the argv to the
documented set; `-showextraoptions` prints exactly which `*latex` options are accepted.

### 2.2 `-outdir` semantics and the `\input` question

- Paths inside the source are **not** rewritten. TeX continues to look for `\input`,
  `\includegraphics`, `.bib`, classes, etc. relative to its **cwd**; only *output* files are
  redirected. That is why `%DOC%` is passed as `<dir>/<basename>` and the cwd is the project
  root: the engine writes `build/main.aux` while still reading `main.tex`, `sections/x.tex`,
  `figs/a.pdf` from the tree.
- **TeX Live does not create subdirectories in the output directory.** `\include{sections/part}`
  writes `<outdir>/sections/part.aux`; if `<outdir>/sections` is missing the run dies:

```text
./main4.tex:3: I can't write on file `sections/part.aux'.
...
*** (job aborted, file error in nonstopmode)
```

**[verified locally]** — `latexmk … -outdir=build4 main4.tex` → exit **12**, no PDF.
Creating `build4/sections/` first → the identical command exits **0** and produces the PDF.
MiKTeX creates safe subdirs automatically; TeX Live does not (latexmk analyses this exact
message: `read_log_file` matches `I can't write on file `([^']+)'` and, if allowed, creates the
subdir on the next run).

⇒ Implementation rule: before the **first** build, mirror the directory tree of every
`\include`d file (and of any `\includegraphics` that writes, e.g. `\tikzexternalize` output)
inside the build dir, or create missing dirs on that specific error and retry once.

- Relative `-outdir` is resolved against the **cwd**, and `-cd` changes that: the manual notes
  that with `-cd` a relative aux/out dir is interpreted relative to the document directory.
- Absolute `-outdir` works and keeps the log/PDF discoverable from one place (this is what we
  do).

### 2.3 RC file precedence (and how not to clobber it)

The manual's `CONFIGURATION/INITIALIZATION (RC) FILES` section gives the exact order:

1. **system** RC: on Windows only `C:\latexmk` (file `LatexMk` or `latexmkrc`); on Unix
   `/etc`, `/opt/local/share/latexmk`, `/usr/local/share/latexmk`, `/usr/local/lib/latexmk`;
   overridable with `LATEXMKRCSYS`.
2. **user** RC: first of `$XDG_CONFIG_HOME/latexmk/latexmkrc`, `$HOME/.latexmkrc`
   (on Windows `HOME` is usually absent → `USERPROFILE`).
3. **project** RC: `latexmkrc` or `.latexmkrc` in the **cwd** — the first one found.
4. any `-r <file>` given on the command line.

Each RC file is a sequence of **Perl** assignments/expressions and an RC found later can
override earlier ones; command-line options override RC variables.

How to avoid clobbering:

- **Never write `.latexmkrc`** into a user's project (this is exactly what
  `respectLatexmkrc: true` protects).
- Do not pass `-norc`. If a project-local RC exists, let it own the recipe: drop our
  `-xelatex`/`-pdf` flag and pass `-r` only if we need an extra file.
- Express our own build directory and flags as **command-line arguments** (highest precedence,
  zero file writes); put anything not expressible as a flag into `-e '<perl expr>'` (e.g.
  `-e '$max_repeat=3'`) rather than in a temp RC file. `-e` runs Perl code with the same
  precedence as a command-line option and multiple `-e` are allowed.
- Note that an RC file located in the **cwd** is picked up automatically — one more reason to
  run latexmk with the project root as cwd (as LaTeX-Workshop does).

### 2.4 Exit codes

From `latexmk.pl` (`exit_msg1` and friends):

| code | meaning | source |
| --- | --- | --- |
| 0 | success (also "nothing to do") | normal |
| 11 | main source file not found | `exit_msg1("Could not find file '$texfile_name'", 11)` |
| 12 | **errors during processing** — the normal "compile failed" | `exit 12` after printing "You need to correct the file(s)…" |
| 10 | bad usage | `exit_help` |
| 20 | internal error / invalid preview method | `exit 20` |
| other | the failed external command's code, i.e. `system()`'s `256*code` divided by 256 | `exit_msg1(…, $retcode)` |

**[verified locally]** a document with an undefined control sequence and an unclosed
`itemize` gives exactly `12`; the missing-`.sty` document also gives `12`.

Design: treat `0` as success; `12` as *compile failed, parse the log*; `11` as *configuration
error (wrong root)*; `10`/`20` as *plugin/toolchain bug* with the raw output attached.
Never infer success from the presence of a PDF — `-gg` deletes it first, and on `-xelatex`
failure no PDF is written at all.

### 2.5 Perl / Win32 requirements

- latexmk is a **Perl** program. TeX Live ships a `runscript.tlu` shim so `latexmk` on `PATH` is
  really `perl.exe …\scripts\latexmk\latexmk.pl` — visible in the failing probe:
  `D:\latex\texlive2023\…\runscript.tlu:921: command failed with exit code 12: perl.exe
  d:\latex\…\latexmk.pl …`. Consequences: the process tree is `latexmk.exe → perl.exe →
  xelatex.exe`, so killing only the direct child orphans the engine (hence `taskkill /T`);
  and stdout is written by Perl, which re-encodes console text.
- Console code page: on this machine latexmk prints
  `Initial Win CP for (console input, console output, system): (CP936, CP936, CP936)` /
  `I changed them all to CP936` at startup (**[verified locally]**). Perl transparently
  switches the console CP for the duration of the run, and TeX's own messages may be emitted
  in the OEM/ANSI code page. Practical rule: **read the `.log` file as bytes and decode it as
  UTF-8 with a lossy replacement**, never rely on stdout encoding for messages; treat only
  ASCII-structured fields (`file:line:`, `!`, `l.N`, key names) as parseable.
- A MiKTeX install can put `latexmk` elsewhere; `latexmkPath`/`texBinDir` must be explicit
  (already our design).

---

## 3. Parsing real `.log` files

### 3.1 Canonical shape

A log is a flat text stream with three kinds of content interleaved:

1. **banner/pass markers** — `This is XeTeX, Version … (preloaded format=xelatex …)`,
   `entering extended mode`, `restricted \write18 enabled.`, `file:line:error style messages
   enabled.`, `**main.tex`, `(./main.tex` … one per engine run, so a multi-pass build appends
   several.
2. **file-open bookkeeping** — `(<path>` / `)` nesting, plus package sign-on lines
   `Package: foo 2024/01/01 v1.2 …` and `File: bar.sty …` (latexmk explicitly skips these:
   `/^File: /`, `/^Package: /`, `/^! LaTeX Error: /` are all `next LINE`).
3. **messages** — errors `! …` or `<file>:<line>: …`, warnings `LaTeX Warning: …`,
   `Package … Warning: …`, over/underfull boxes, `Missing character: …!`, `No pages of output.`

### 3.2 Verified specimens (TeX Live 2023, xelatex)

`[verified locally]` with
`latexmk -xelatex -synctex=1 -interaction=nonstopmode -file-line-error -outdir=build main2.tex`:

```text
LaTeX Warning: Reference `sec:missing' on page 1 undefined on input line 4.
LaTeX Warning: Citation `nokey' on page 1 undefined on input line 4.
./main2.tex:5: Undefined control sequence.
l.5 \UndefinedMacro
                    here.
Overfull \hbox (316.735pt too wide) in paragraph at lines 4--7
\TU/lmr/m/n/10 box that will certainly overflow: [].
 []
./main2.tex:9: LaTeX Error: \begin{itemize} on input line 7 ended by \end{docum
ent}.
See the LaTeX manual or LaTeX Companion for explanation.
Type  H <return>  for immediate help.
...
l.9 \end{document}
Your command was ignored.
LaTeX Warning: There were undefined references.
LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.
```

and for a missing package (classic form survives even with `-file-line-error`):

```text
! LaTeX Error: File `nonexistentpkgxyz.sty' not found.
...
./main.tex:3: Emergency stop.
`<read *>`
l.3 \begin
        {document}
No pages of output.
```

Note what the two examples prove:

- the `-file-line-error` line is `./<relpath>:<line>: <message>`, and the **wrap at column 79**
  can split it mid-message (`…\end{docum` + `ent}.`, line length verified **79**);
- `l.<n> <echo>` follows, where the echo may include the *rest of the line* on the next line
  (`here.`), with leading spaces preserved;
- the hint block (`See the LaTeX manual…`, `Type H…`) is noise;
- `Your command was ignored.` triggers the `(?!.*ignored error)` guard in LaTeX-Workshop's
  regex — otherwise the tail would be parsed as an error;
- an unclosed environment error is *reported at* the `\end{document}` line (`l.9`), not at the
  `\begin{itemize}` line (`l.7`) — the message text carries the real origin;
- "Emergency stop." means nonstopmode gave up (missing package asks for a filename, and even
  nonstopmode cannot continue) — build is unusable, report it as fatal.

Other formats worth matching, with their real-world shapes:

```text
Runaway argument?
{...}\end{document}
! File ended while scanning use of \@xdblarg.
```
```text
Missing character: There is no 中 (U+4E2D) in font [lmroman10-regular]!
```
```text
Package hyperref Warning: Token not allowed in a PDF string (Unicode):
(hyperref)                removing `\ldots' on input line 42.
```
(multi-line package warnings echo `(<package>)` at the start of continuation lines — that is
`latexPackageWarningExtraLines` above)

```text
LaTeX Font Warning: Font shape `T1/cmr/m/n' undefined
(Font)              using `T1/cmr/m/n' instead on input line 7.
```

### 3.3 Edge cases we must design for

| Edge case | Why it breaks the naive parser | Rule |
| --- | --- | --- |
| **79-column wrapping** | splits paths, messages, even `file:line:` | set `max_print_line` high (we use 2000; LaTeX-Workshop 10000) **and** join lines defensively: if `len(prev) == 79` and `prev` does not end with `...`, append (Overleaf's `LOG_WRAP_LIMIT=79` rule). Never join when the previous line is exactly our `file:line:` header, since the wrap continues the *message*, not the header |
| Windows drive letters | `C:\a\b.tex:12: msg` contains three colons | anchor on `^(.*):(\d+):` with a **greedy** `.*` (last possible `:number:` wins) and validate that `:\d+:` is followed by a space; LaTeX-Workshop's `/^(?:(.*):(\d+):|!)/` relies on the greedy prefix doing exactly this |
| Paths with spaces | `./My Docs/main.tex:12:` | legal in the `file:line:` form; must **not** tokenise on whitespace. In the paren stack it *is* ambiguous (TeX prints the path unquoted) — LaTeX-Workshop allows an optional leading `"` and otherwise stops at whitespace/()[]; the file stack is then best-effort, the `file:line:` header is authoritative |
| Backslashes | `\\server\share` and `C:\x` in the paren stack | LaTeX-Workshop's path regex is explicitly built for `\\`-prefixed UNC and `C:` drives: `/^"?((?:(?:[a-zA-Z]:|\.|\/)?(?:\/|\\\\?))[^"()[\]]*)/` |
| `./` and `../` in paths | seen in `./main.tex:3:` and `Input:…/./main3.tex` | always `path.resolve(dirname(root), p)` |
| Trailing `^^M`, `^^I` | TeX echoes control chars in `l.N` echoes | strip `\x00-\x08`, `^^M` before display |
| CRLF | Windows logs | split on `/\r?\n/` |
| Non-UTF-8 bytes | CP936/CJK messages | decode UTF-8 with `fatal:false`, or latin1 for the ASCII structure |
| `(your command was ignored)` | duplicated errors | LaTeX-Workshop's `(?!.*ignored error)` |
| `! Emergency stop.` | fatal | map to a single fatal diagnostic and stop collecting |
| `No pages of output.` | success-shaped failure (exit 12) | explicit error diagnostic |
| duplicate messages over passes | one build = several engine runs | parse only the **last** run (see 3.4) |
| `Missing character` spam | CJK fonts | aggregate per font, cap at N |

### 3.4 Recommended parser algorithm

Feed it the **log file** (`<buildDir>/<job>.log`), not stdout: it is complete, uncolored, and
contains the `-file-line-error` lines even when latexmk suppresses engine chatter. Split off
the final run first — the log of a multi-pass build contains several banners:

```ts
const RUN_START = /^This is (?:Xe|pdf|Lua)?TeX, Version/;
const lines = text.split(/\r?\n/);
const start = lines.findLastIndex(l => RUN_START.test(l));   // last run wins
const final = start > 0 ? lines.slice(start) : lines;
```

Then a single forward pass with an explicit state machine:

```ts
type Pending = { level: 'error'|'warning'|'info'|'typesetting'; file: string; line: number;
                 message: string; context: string[]; posText?: string };
const state = { fileStack: [rootFile], nested: 0, pending: null as Pending|null,
                skipNext: false, inErrorBlock: false };

for (const line of final) {
  if (state.skipNext) { state.skipNext = false; continue; }        // over/underfull body line
  if (state.pending) {                                             // multi-line collection
    if (line.trim() === '') { flush(); continue; }
    const extra = line.match(/^\((.+?)\)\s+(.*)$/);                // "(hyperref) removing ..."
    if (extra) { state.pending.message += ' ' + extra[2]; continue; }
    if (state.inErrorBlock) {
      const m = line.match(/^l\.(\d+)\s(\.\.\.)?(.*)$/);           // l.5 \UndefinedMacro
      if (m) { state.pending.line = +m[1]; state.pending.posText = m[3].trim(); flush(); continue; }
      state.pending.context.push(line); continue;
    }
    state.pending.message += '\n' + line; continue;
  }
  // 1. errors, cheapest and most specific first
  const e = line.match(/^(?:(.*):(\d+):|!)(?:\s?(.+) [Ee]rror:)? (.+)$/);
  // 2. warnings family, 3. info, 4. boxes, 5. undefined refs/cites, 6. fatal markers
  // 7. always: feed the paren scanner (file stack) at the END of the line
}
```

Ordering rules that came out of the prior art:

1. a pending message **always** wins over starting a new one (that is how hint blocks and
   `(pkg)` continuations are absorbed);
2. the `l.N` line **overwrites** the line number of a `!`-form error (the `!` form has no line);
3. over/underfull boxes consume exactly **one** following line (`insideBoxWarn`);
4. exclusion regexes are applied before classification, so users can silence a noisy package;
5. the paren scanner runs last on every unclassified line, so file attribution keeps working.

Post-processing that we should add (LaTeX-Workshop does this in the VS Code layer, we should
do it in the tool result):

```ts
dedupe by (file, line, level, normalize(message))      // multi-pass duplicates
cap at N per level, aggregate the rest                 // "1 more error, 12 more warnings"
sort by (file, line)                                   // clickable, stable order
severity: error | warning | info                       // typesetting -> info
relativePath: path.relative(projectRoot, file)          // model-facing file:line
```

### 3.5 Mapping errors to `file:line` — the honest limits

- The `-file-line-error` header gives a file **and** line, but the file is the one TeX was
  reading *at that moment*, which is why the paren stack exists. When the two disagree
  (LaTeX-Workshop: header wins) the header is right far more often than the stack.
- `!`-form errors have **no file**; LaTeX-Workshop attaches the top of the file stack, and if
  that is empty, the root file.
- Unclosed-environment errors are reported at the `\end{document}` line; the message contains
  the real `\begin{…} on input line N`. A UX nicety: when the message matches
  `/\\begin\{([^}]+)\} on input line (\d+)/`, emit a **second** diagnostic at the true line
  (severity info: "environment opened here").
- Missing package: `File `x.sty' not found` gives no line, but the `Emergency stop` header
  does (`./main.tex:3`). Emit both, dedupe by message.
- Package warnings with `on input line N` are reliable; warnings without a line fall back to
  the file stack + line 1.

---

## 4. SyncTeX

### 4.1 What TeX writes — `.synctex.gz` format

`[verified locally]`, `xelatex -synctex=1`, decompressed `build/main3.synctex.gz`:

```text
SyncTeX Version:1
Input:1:D:/dsh-tmp/texprobe/./main3.tex
Input:2:d:/latex/.../tex/latex/base/article.cls
...
Input:7:D:/dsh-tmp/texprobe/build/main3.aux
Output:xdv
Magnification:1000
Unit:1
X Offset:4736287
Y Offset:4736287
Content:
!512
{1
[1,7:0,41484288:26673152,41484288,0
[1,7:4063232,41484288:22609920,40435712,0
(1,7:4063232,1835008:22609920,786432,0
h1,7:4063232,1835008:22609920,0,0
)
]
(1,3:4063232,4128768:22609920,654940,5661
g1,3:4063232,4128768
g1,3:5538263,4128768
k1,3:26673152,4128768:18698209
)
```

Structure:

- **header** `Key:Value` lines: `SyncTeX Version`, one `Input:<n>:<path>` per input file
  (n is the **tag** used in records), `Output:<type>` (note: with `-xelatex` this says
  **`xdv`**, not `pdf` — do not branch on it), `Magnification` (1000 = ×1),
  `Unit` (1 = sp), `X Offset` / `Y Offset` (TeX point origin in sp).
- **records**, one per line; `Content:` starts the block. Each record is
  `<char><page>,<tag>:<values>` with `<char>` ∈ `{ ( [ h v g k … } ) ]`: `{`/`}` delimit a
  *sheet*, `[`/`]` a box, `(`/`)` an hbox, `h`/`v` a void hbox/vbox, `g` a glue, `k` a kern.
  For box records `<values>` is `<h>,<v>:<width>,<height>,<depth>` in **sp**, measured from the
  page's top-left origin; void-box/glue/kern records carry only `h,v` (and sometimes a length).
  `synctex(5)` and `synctex_parser.h` define the full set; a reader only needs the box and
  void-box forms to answer "page + position + tag". `tag` indexes the `Input:<n>` table.
- converting to PDF points: `bp = sp / 65536 / 72.27 * 72` (i.e. `sp * 72 / (65536 * 72.27)`),
  then apply `Magnification/1000` and the X/Y offsets. **In practice you do not implement
  this**: the `synctex` CLI already prints `bp`.

Header caveat: paths are exactly what the engine saw, e.g. `D:/dsh-tmp/texprobe/./main3.tex`
(mixed separators, `./` segment, drive letter case varies: `D:` for the main file,
`d:` for TeX Live files). Always normalise with `path.resolve`/`path.normalize` and compare
case-insensitively on Windows.

### 4.2 `synctex` CLI

`synctex view -i <line>:<col>:<file> -o <output-pdf>` — **[verified locally]**:

```text
This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:build/main3.pdf
Page:1
x:157.011215
y:156.595764
h:133.768372
v:158.648056
W:343.711060
H:8.796997
before:
offset:-1
middle:
after:
SyncTeX result end
```

`synctex edit -o <page>:<x>:<y>:<pdf>` — **[verified locally]**:

```text
This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:build/main3.pdf
Input:D:/dsh-tmp/texprobe/./main3.tex
Line:6
Column:-1
Offset:0
Context:
SyncTeX result end
```

Notes:

- `Output:` is echoed back in the same form it was passed (`build/main3.pdf` vs
  `D:/dsh-tmp/texprobe/build/main3.pdf`, depending on the `-o` argument) — parse it but do not
  compare it textually with your own path.
- `Page` is 1-based. `x`/`y` are bp from the **top-left** of the page. `y` grows downward.
- `Column:-1` is normal (`synctex edit` usually cannot give a column); `Offset` and `Context`
  are often empty. LaTeX-Workshop compensates by searching the source line for the
  `before/after` text of the click (`getRowAndColumn`) — an approach worth copying only if we
  need word-level precision.
- Exit code is `0` even when the block is empty (`before:` empty, no `Page:`) — **the presence
  of `Page:` is the success signal**, not the exit code.
- The CLI must be able to find `<job>.synctex.gz`; it looks next to the file given by `-o`, so
  pass the real PDF path (in our build dir).
- `synctex view` works from any cwd **as long as the `-i` file and `-o` pdf are absolute**
  (verified: ran from the project root with absolute paths, and from the same cwd with relative
  paths — both fine). LaTeX-Workshop additionally sets `cwd` to the PDF's directory.
- CJK: LaTeX-Workshop reports (`src/locate/synctex.ts#L490`) that the **binary** "cannot handle
  CJK encodings" for inverse sync and uses a JS reader instead. Forward sync with CJK *paths*
  worked in our environment, but treat inverse-via-CLI as unreliable for non-ASCII project
  paths and keep a JS fallback.

### 4.3 Implementing forward/inverse in JS

Cheapest correct implementation (what we do today, and it is fine):

```ts
// forward: spawn, parse the block
const out = await run('synctex', ['view', '-i', `${line}:${col ?? 1}:${absTex}`, '-o', absPdf]);
const rec = parseBlock(out);           // { page, x, y, h, v, W, H }
// render: const vp = page.getViewport({ scale }); const [vx, vy] = vp.convertToViewportPoint(rec.x, rec.y);

// inverse: spawn
const out = await run('synctex', ['edit', '-o', `${page}:${x}:${y}:${absPdf}`]);
const rec = parseBlock(out);           // { Input, Line, Column }
```

A pure-JS reader (no process spawn, works with CJK, sub-millisecond) is a known amount of work
— LaTeX-Workshop vendors `tdurieux/synctex-js` (MIT) for exactly the inverse half. For the
plugin, the pragmatic split is:

- **spawn for forward** (fast, robust, already proven);
- **spawn for inverse**, with the `.synctex.gz` JS reader as a fallback for non-ASCII paths or
  when `synctex` is missing from `PATH`.

Parsing helpers both directions need:

```ts
function parseBlock(out: string): Record<string, string> {
  const lines = out.split(/\r?\n/); const r: Record<string,string> = {}; let on = false;
  for (const l of lines) {
    if (l.includes('SyncTeX result begin')) { on = true; continue; }
    if (l.includes('SyncTeX result end')) break;
    if (!on) continue;
    const i = l.indexOf(':'); if (i < 0) continue;
    r[l.slice(0, i).toLowerCase()] = l.slice(i + 1);
  }
  return r;                              // page/x/y or input/line/column
}
```

Performance: one `synctex` call is a ~15–40 ms process spawn on Windows. Debounce cursor
moves (LaTeX-Workshop uses ~250 ms on the editor side), and cache the last
`(file,line) → rect` per build generation.

Correctness traps:

- SyncTeX data reflects the **last engine run**; with `-xelatex`/`-pdfxe` the `.synctex.gz` is
  written by the xelatex pass, and `xdvipdfmx` does not invalidate it — good, forward coords
  are in the same bp space.
- Page numbers shift when content is added; never cache coordinates across builds, key them by
  the published build version.
- Multi-file projects: the `-i` file must match an `Input:` entry. If a call returns an empty
  block, retry once with `path.basename(file)` after scanning the `Input:` table.
- `\include`d files are fine; `\input` inside a float may map to the float's page.

---

## 5. PDF.js

Version in this repo: `assets/pdf.min.mjs` + `pdf.worker.min.mjs`, **5.4.296** (Mozilla,
Apache-2.0 — [LICENSE](https://github.com/mozilla/pdf.js/blob/master/LICENSE)). API docs:
[module-pdfjsLib](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html).

### 5.1 Loading bytes (no URL, no second server)

```ts
import * as pdfjsLib from './assets/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '/latex/assets/pdf.worker.min.mjs';

const task = pdfjsLib.getDocument({ data: new Uint8Array(bytes) });   // bytes from our route
const pdf  = await task.promise;                                      // PDFDocumentProxy
```

- `data` may be `Uint8Array | ArrayBuffer | TypedArray`; **do not** pass the same buffer to two
  live documents unless you copy (`data` is transferred/consumed in some paths). Re-fetch bytes
  from our `/latex/pdf?project=…&v=<version>` route on every refresh — that is also the cache
  buster.
- `workerSrc` must be same-origin and served with `Content-Type: text/javascript` (our static
  route already does this); a wrong MIME type is the #1 cause of "fake worker / falling back to
  main thread".
- `getDocument({url})` exists but brings fetch/CORS/range semantics we do not want; bytes give
  us full control over the "last good PDF" and the version counter.

### 5.2 Rendering a page

```ts
const page = await pdf.getPage(n);                    // 1-based
const vp   = page.getViewport({ scale });             // scale 1 = 1 CSS px per bp
const dpr  = Math.min(window.devicePixelRatio || 1, 2);
const canvas = document.createElement('canvas');
canvas.width  = Math.floor(vp.width  * dpr);
canvas.height = Math.floor(vp.height * dpr);
canvas.style.width  = `${vp.width}px`;
canvas.style.height = `${vp.height}px`;
const renderTask = page.render({
  canvas,                                             // v5: pass the canvas
  viewport: vp.clone({ transform: dpr !== 1 ? [dpr,0,0,dpr,0,0] : undefined }),
});
await renderTask.promise;                             // throws RenderingCancelledException on cancel
```

- Always render through `viewport.transform` for DPR instead of multiplying CSS size (crisp
  text, same layout).
- `page.cleanup()` after rendering off-screen pages; `pdf.destroy()` when the tab closes —
  otherwise the worker keeps the whole document (~10–100 MB for a thesis).
- One in-flight `RenderTask` per page; call `.cancel()` before starting a new one on the same
  canvas (zoom changes), and swallow `RenderingCancelledException`.
- Use `page.getViewport({scale: 1}).width/height` to compute "fit width":
  `scale = container.clientWidth / vp1.width`.

### 5.3 Text layer

pdf.js 4.4+ exposes a `TextLayer` class (still true in 5.4):

```ts
const tl = new pdfjsLib.TextLayer({
  textContentSource: page.streamTextContent(),   // or await page.getTextContent()
  container: absoluteDivOverCanvas,              // position:absolute; inset:0
  viewport: vp,
});
await tl.render();
```

It needs the CSS from `pdf_viewer.css` (`.textLayer span { position:absolute; … }`) and the
`--scale-factor` custom property on the container. We only need the text layer for *selection
and find*; SyncTeX inverse works on coordinates alone. Decision for v1: **skip the text
layer** unless selection is requested — it roughly doubles per-page work and is the most
common source of "text is offset/oversized" bugs.

### 5.4 Navigation, zoom, state

PDF.js's full viewer exposes `PDFViewer`/`currentScaleValue` (`'auto' | 'page-width' |
'page-fit' | 'page-actual' | number`), `scrollMode` (`0 = vertical`, `1 = horizontal`,
`2 = wrapped`, `3 = page`), `spreadMode`, `currentPageNumber`, and `#viewerContainer`
scroll offsets. A minimal custom viewer (what we have) can model the same state explicitly:

```ts
type ViewState = {
  page: number;                        // 1-based current page
  scale: number | 'page-width' | 'page-fit';
  scrollTop: number; scrollLeft: number;   // container offsets, for pixel fidelity
  scrollMode: 0|1|2|3; spreadMode: 0|1|2;  // only if implemented
};
```

Restore order matters (same as LaTeX-Workshop's `restoreState`): **page → scale → scroll**.
Setting `scrollTop` before the new canvas has its final size is silently clamped to 0; that is
why they restore on `pagerendered`/after a paint, not immediately after `load()`.

### 5.5 What NOT to reimplement

- **No PDF parser, no object-stream/xref decoding, no CMaps, no font programs, no wasm image
  decoders.** We ship Mozilla's build; `cMapUrl`/`wasmUrl` can point at `assets/` when a
  document needs them (CJK PDFs do — worth a follow-up).
- **No PDF writer / merger.** "Keep last good PDF" = copy the file, not manipulate it.
- **No page layout engine.** Canvas per page, plain flex column; virtualise only if a document
  with >200 pages becomes a problem (render window ±2 pages).
- **No worker fork of our own** — pdf.js's worker is the only heavy thread.

### 5.6 Viewer pitfalls (all seen in the wild / in LaTeX-Workshop)

| Symptom | Cause | Fix |
| --- | --- | --- |
| blank page after rebuild | rendered before `document.fonts.ready` / canvas detached | keep the canvas mounted, re-render after `load()` resolves, await `renderTask.promise` |
| "fake worker" warning, slow | `workerSrc` 404 or wrong MIME | serve `.mjs` as `text/javascript`, cache-bust with `?v=` |
| text offset at high zoom | CSS size vs. backing store mismatch | `dpr` transform, integer canvas size, `Math.floor` |
| memory growth | old `PDFDocumentProxy` not destroyed | `await pdf.destroy()` on refresh/replace |
| scroll jumps on refresh | pdf.js restored its own position | `showPreviousViewOnLoad = false`-equivalent: set page/scale/scroll explicitly **after** the new pages render |
| flicker between builds | tearing down the old canvas too early | snapshot-mask trick (see 1.7) |

---

## 6. Windows specifics

### 6.1 Spawning TeX without a shell

- Pass an **argv array**, never a command string. `spawn(latexmk, args, {shell:false})` is the
  whole security model: spaces in paths become non-issues, `&`/`^`/quotes in file names cannot
  inject. Our host uses `ctx.subprocess`, which is the same contract.
- `windowsHide: true` (default is false) — otherwise every build flashes a console window; with
  auto-build on save this is unbearable.
- `windowsVerbatimArguments: false` (default) lets libuv do the quoting; only set it when you
  are *sure* you need raw `CreateProcess` semantics (a TeX `-jobname=a b` case).
- Do **not** go through `cmd.exe /c` to get `PATH` resolution: prepend `texBinDir` to the
  child `PATH` and pass the fully resolved `latexmk.exe` path. `PATH` inheritance is enough for
  the engine to find `xdvipdfmx`, `biber`, etc. (they live in the same `bin\windows`).
- Note TeX Live's `latexmk.exe` is a `.tlu` shim → `perl.exe latexmk.pl`; process accounting
  therefore has one more level than you think.

### 6.2 Unicode and spaces

- Node passes UTF-16 → `CreateProcessW`, so Unicode paths work; TeX Live's kpathsea handles
  them; **but** TeX's log messages are emitted in the console code page. A project in
  `D:\论文\main.tex` can produce mojibake in `file:line:` headers. Mitigations: keep the
  *structural* parse ASCII-only; verify every parsed path with `fs.existsSync()` before
  reporting it; on mismatch, fall back to matching `path.basename` against the project's file
  list (LaTeX-Workshop has a whole `convertFilenameEncoding` config for this).
- Always convert to `/` separators when handing paths to TeX/`latexmk` options; keep `\` only
  for Node APIs. `-outdir=C:\a\b` works in practice but `-outdir=C:/a/b` is safer (backslash
  handling differs between latexmk (Perl), the engine, and `cmd`).
- Quote nothing manually — argv elements with spaces are fine; **only** the `% !TEX options`
  style string needs tokenising, and that is a shell contract we should avoid.

### 6.3 Killing the process tree (`latexmk → perl → xelatex`)

```text
taskkill /F /T /PID <pid>      # /T = tree, /F = force; exit 128 if not found
```

- Node's `child.kill()` sends `TerminateProcess` to **one** process on Windows — it does not
  cascade into Perl's children. Use `taskkill /T /F` first (LaTeX-Workshop: `step.ts#L96-L138`),
  then `kill()`; treat "exit 128 / not found" as success (already gone).
- After a kill, `close` may fire with `code === null, signal === 'SIGTERM'`; map it to
  *cancelled*, never to *compile failed* — otherwise the auto-build queue reports a fake error
  on every save-then-cancel.
- Kill on: user cancel, timeout (our `timeoutMs`), and plugin unload. Leave no `perl.exe`
  orphan: a leaked xelatex keeps the PDF locked and the next build fails with `EBUSY`.
- Node ≥ 16 can also use `spawn(..., {signal})`/`AbortController`; on Windows it still only
  kills the direct child, so keep `taskkill` for the tree.

### 6.4 Antivirus, file locks, partial writes

- Windows AV (and OneDrive) can hold the freshly written PDF open for 50–500 ms. Any read must
  be retried: `EBUSY/EPERM/EACCES` with 30–50 ms backoff, ~10 attempts.
- Publishing pattern (matches `preserveLastGood`): never serve `build/main.pdf` directly.
  Copy it to a plugin-owned `<state>/preview/<project>-<version>.pdf` (or read it once into
  memory) and serve *that*; a partially written PDF then never reaches pdf.js.
- Check the PDF is complete before publishing: `%PDF-` header (first 5 bytes) and `%%EOF`
  within the last ~1 KiB. Truncated PDFs make pdf.js throw `InvalidPDFException`.
- `-gg` / `latex_clean` delete files that a viewer may still have open → close/replace the
  pdf.js document *before* cleaning, or clean and then let the next build republish.
- Unicode file names + AV: sometimes the lock is on the **directory**; a retry loop on the
  final rename/copy is more robust than on `writeFile`.

### 6.5 Watching build directories without loops

Two independent loops to break:

1. **our own writes**: we write `build/…`, the watcher sees `build/**`, triggers a build,
   writes more files. Fix: watch **sources only** (`.tex`, `.bib`, `.sty`, `.cls`, images) with
   an explicit ignore of `buildDir`; the PDF is refreshed by the build-completion event, not by
   the watcher.
2. **the compiler's writes racing the viewer**: latexmk/xelatex emits `.log`, `.aux`, `.xdv`
   and (on `-pdfxe`) the PDF only at the end. Chokidar's `awaitWriteFinish`
   (`{ stabilityThreshold: 300–500, pollInterval: 50–100 }`) is the standard answer for
   "file exists but is still being written"; LaTeX-Workshop instead uses the
   `compiledPDFWriting` counter + a `setTimeout` drain, which is more precise for our case
   because we know exactly when the build ends.

Recommended combination:

```text
chokidar.watch([projectRoot], {
  ignored: [buildDir, /\.(aux|log|fls|fdb_latexmk|xdv|synctex\.gz|toc|out|bbl|blg)$/],
  ignoreInitial: true,
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 50 },
})
+ 800 ms debounce + coalescing (a save storm of 20 files = one build)
+ one build at a time per project (queue), N projects in parallel (maxConcurrentBuilds)
+ a monotonically increasing build generation; the viewer ignores events from stale generations
```

`awaitWriteFinish` costs latency (it is the `stabilityThreshold`); with an 800 ms debounce we
are already above it, so both together are cheap.

Also: `fs.watch` recursion on Windows is native and fine for a project root; chokidar v6 adds
`awaitWriteFinish`, `atomic` and a polling backend for network drives. Watch **one root per
project**, not the whole workspace.

---

## 7. Artifact-preview mechanics worth copying

- **Same-origin loopback, no second listener.** LaTeX-Workshop serves the PDF from its own
  loopback HTTP server and rejects any path that is not currently being viewed
  (`src/preview/server.ts#L264-L287`). We do the same through the Harness web server
  (`GET /latex/pdf?project=…`), which avoids CSP/CORS work entirely and keeps the same
  admission control as the rest of the app.
- **Per-build cache busting**: the URL embeds a version (`?v=<generation>`), and pdf.js is
  re-`getDocument`ed from bytes. The version is the only thing the client needs to know; no
  ETag/If-Modified-Since logic, no mtime comparisons.
- **One viewer instance per project**, keyed by project id: `latex_preview` focuses the
  existing tab and posts a "reload to version N" message instead of opening a second tab.
  VS Code's webview panel serialization (`deserializeWebviewPanel` +
  `webviewPanel.revokeAll`/`reveal`) is the same idea — see
  [VS Code webview guide](https://code.visualstudio.com/api/extension-guides/webview).
- **Keep viewer state in the client, not the host.** The host only tracks "which project is
  where"; page/zoom/scroll live with the DOM element that owns them. Persist them in
  `sessionStorage` so a tab re-mount survives (page, scale, scrollTop).
- **Handshake, not fire-and-forget**: `refresh(version)` → client acks `rendered(version)`;
  coalesce requests while rendering and re-run once at the end
  (`shouldRefreshAgain`, `refresh.ts#L42-L56`).
- **Rate-limit reloads** (webview reload, tab re-create) to avoid an infinite reload loop when
  the server or the PDF is broken (`pdfviewerpanel.ts#L9-L10`).
- **Snapshot mask** during refresh (`refresh.ts#L161-L201`) — the single cheapest perceived
  performance win.
- **Stale banner**: when the last build failed, the preview shows the *previous* successful PDF
  with an explicit "stale" badge rather than an error page (`preserveLastGood`).

---

## 8. Recommended design decisions for `dsh-latex`

These map onto the config keys and tools the plugin already documents; the "why" is the point.

1. **Engine**: default `xelatex` through **one** `latexmk` invocation, `-pdfxe` semantics.
   Rationale: CJK/Unicode correctness (our users write Chinese), one PDF write per build,
   `-synctex=1` handled by latexmk. Never invoke the engine directly in v1.

2. **Exact argv** (per build; argv only, no shell):

   ```text
   latexmk
     -synctex=1 -interaction=nonstopmode -file-line-error
     -xelatex                      # or -pdf / -lualatex
     -outdir=<abs buildDir>
     <mainFile>                    # basename, cwd = main file's directory
   ```

   plus `-gg` when `force` is requested, and `extraLatexmkArgs` appended verbatim.
   Do **not** add: `-f` (masks exit 12), `-norc` (drops the user's recipe), `-use-make`
   (arbitrary Makefile execution), `-shell-escape`.

3. **`.latexmkrc` respect** (`respectLatexmkrc: true`): if `latexmkrc`/`.latexmkrc` exists in
   the project directory, drop our engine flag (let the RC choose) but keep
   `-synctex -interaction -file-line-error -outdir` (they are additive and safe). Never write
   into the RC.

4. **Build directory**: `<project>/build` as `-outdir` (`-auxdir` omitted — TeX Live cannot do a
   separate aux dir without emulation). Mirror `\include`d subdirectories once before the first
   build; on `I can't write on file `…'`, create the missing dir and retry exactly once.
   Keep `max_print_line=2000` in the child env (wrapping mitigation), and `texBinDir` prepended
   to `PATH`.

5. **Root detection order** (deterministic, headless, no prompts):
   explicit `mainFile` → `% !TEX root` chain (transitive, cycle-safe, relative to the file
   holding it) → active file's own `\documentclass`/`\begin{document}` (comments/verbatim
   stripped) → reverse `\input`/`\include` graph (candidates that include the active file,
   preferring `main.tex`, `paper.tex`, `thesis.tex`) → single root under cwd → error with the
   candidate list. Root file's directory is the project root; everything else is relative to it.

6. **Error parser**: read `<buildDir>/<job>.log` (not stdout), keep the **last engine run**
   (split on `^This is …TeX, Version`), then the state machine from §3.4 with this precedence:
   pending-message continuation → `file:line:` error → `!` error → `LaTeX Warning:` /
   `Package … Warning:` → over/underfull (info) → undefined ref/citation → `l.N` line rewrite →
   paren file-stack maintenance. Resolve `file:line:` against the **project root**. Emit
   `{level, file, line, message, context[]}`; drop hint blocks; clamp hint-count;
   de-duplicate across passes; sort by file/line. Map latexmk exit codes
   (0/11/12/10/20) into `status` so the tool can say "compile failed (12)" vs "wrong root (11)".

7. **"Environment opened here" courtesy diagnostic**: when the message is
   `\begin{X} on input line N ended by …`, add an info diagnostic at line N. Free, and it turns
   the most common student error into a two-click fix.

8. **Debounce + coalesce**: watcher (`awaitWriteFinish` 300 ms) → **800 ms quiet window** →
   queue; one build per project; global `maxConcurrentBuilds`; each build has a generation id;
   the viewer only accepts the event whose generation equals the active one. Cancel = tree
   kill + generation bump, reported as *cancelled*, never as *failed*.

9. **PDF publication**: on success, validate `%PDF-`/`%%EOF`, copy to the plugin-owned preview
   path, bump the version, then notify the viewer. On failure, keep the old version and mark
   the project stale. Never serve the raw build-dir PDF (AV/lock/partial-write safety).

10. **SyncTeX integration points**:
    - forward: click a diagnostic / "jump to PDF" → `synctex view` with absolute paths →
      `{page, x, y} → viewport.convertToViewportPoint` → scroll + highlight ring;
    - inverse: double-click the canvas → `convertToPdfPoint` → `synctex edit` → open
      `<file>:<line>` (fall back to a `.synctex.gz` JS reader for non-ASCII paths);
    - debounce cursor-driven forward sync (~250 ms); cache per build generation; disable when
      the build is stale (coordinates would be wrong).

11. **PDF.js**: bundle only `pdf.min.mjs` + `pdf.worker.min.mjs` (+ `cmaps/` if CJK PDFs must be
    searchable), load via `getDocument({data})` from our route, render page-by-page on canvas
    with a DPR transform, keep `{page, scale, scrollTop}` in component state +
    `sessionStorage`, destroy the proxy on replace. No text layer in v1, no PDF parsing of our
    own, no second HTTP server.

12. **Windows runtime**: `windowsHide: true`, explicit `latexmk.exe` path, `taskkill /F /T /PID`
    on cancel/timeout, `EBUSY` retry with backoff on all reads of build outputs, and log
    decoding that never assumes UTF-8 for TeX-emitted text.

Open questions / follow-ups (not blockers):

- CMaps for CJK-content PDFs: `cMapUrl`/`wasmUrl` point at `assets/` — decide whether to ship
  them (~1–2 MB) or accept "no text search in CJK PDFs".
- Whether to add `-out2dir` to suppress intermediate PDF states for very long builds (only
  matters if we drop the version handshake).
- Whether to expose `latexmk -c` vs `-C` in `latex_clean` (currently: recognised aux files only,
  which is the safer superset).

---

## 9. Sources

Primary (read in full):

- LaTeX-Workshop — [repository](https://github.com/James-Yu/LaTeX-Workshop), pinned commit
  [`bf7d265`](https://github.com/James-Yu/LaTeX-Workshop/tree/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c).
  Key files with anchors:
  [`src/core/root.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/core/root.ts),
  [`src/compile/recipe.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/recipe.ts),
  [`src/compile/plan.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/plan.ts),
  [`src/compile/step.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/step.ts),
  [`src/compile/README.md`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/compile/README.md),
  [`src/utils/utils.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/utils/utils.ts),
  [`src/parse/parser/latexlog.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/latexlog.ts),
  [`src/parse/parser/parserutils.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/parserutils.ts),
  [`src/parse/parser/bibtexlog.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/bibtexlog.ts),
  [`src/parse/parser/biberlog.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/parse/parser/biberlog.ts),
  [`src/locate/synctex.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/locate/synctex.ts),
  [`src/preview/viewer.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/preview/viewer.ts),
  [`src/preview/server.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/src/preview/server.ts),
  [`viewer/components/state.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/viewer/components/state.ts),
  [`viewer/components/refresh.ts`](https://github.com/James-Yu/LaTeX-Workshop/blob/bf7d26577b2fe744cd6b1766dcfb32c394f18a4c/viewer/components/refresh.ts).
- latexmk — [CTAN package](https://ctan.org/pkg/latexmk), manual
  [`latexmk.txt`](https://mirrors.ctan.org/support/latexmk/latexmk.txt) (4.88, 2026-03-09),
  source [`latexmk.pl`](https://mirrors.ctan.org/support/latexmk/latexmk.pl).
- Overleaf log parser — [overleaf/latex-log-parser](https://github.com/overleaf/latex-log-parser),
  [`src/coffee/latex-log-parser.coffee`](https://github.com/overleaf/latex-log-parser/blob/master/src/coffee/latex-log-parser.coffee)
  (79-column wrap join, paren file stack, multi-line package warnings).
- SyncTeX — [`synctex(1)`](https://man.archlinux.org/man/synctex.1.en),
  [`synctex(5)`](https://man.archlinux.org/man/synctex.5.en) (file format),
  [tdurieux/synctex-js](https://github.com/tdurieux/synctex-js) (MIT JS reader used by
  LaTeX-Workshop).
- PDF.js — [project](https://mozilla.github.io/pdf.js/),
  [API: module-pdfjsLib](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html),
  [`src/display/text_layer.js`](https://github.com/mozilla/pdf.js/blob/master/src/display/text_layer.js),
  [LICENSE (Apache-2.0)](https://github.com/mozilla/pdf.js/blob/master/LICENSE).
- Node.js — [`child_process`](https://nodejs.org/api/child_process.html) (`windowsHide`,
  `windowsVerbatimArguments`, `killSignal`, `AbortSignal`).
- chokidar — [paulmillr/chokidar](https://github.com/paulmillr/chokidar)
  (`awaitWriteFinish`, `atomic`, polling backend).
- Windows — [`taskkill`](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill).
- VS Code — [Webview API guide](https://code.visualstudio.com/api/extension-guides/webview)
  (panel serialization / reveal, the pattern our one-tab-per-project mirrors).
- TextMate — [latex.tmbundle](https://github.com/textmate/latex.tmbundle): its "Typeset & View"
  command is the other long-lived SyncTeX integration; it shells out to `latexmk` and `synctex`
  exactly like the scheme in §4 (no separate research needed for us).

Local verification (reproducible): see the probe transcripts quoted in §1.4, §2.2, §3.2, §4.1,
§4.2. Commands used:

```bash
latexmk -xelatex -synctex=1 -interaction=nonstopmode -file-line-error -outdir=build main.tex
synctex view -i "4:1:$PWD/main3.tex" -o "$PWD/build/main3.pdf"
synctex edit -o "1:157:170:$PWD/build/main3.pdf"
```
