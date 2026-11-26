---
name: latex-workspace
description: Use the dsh-latex workspace tools for a local .tex project: compile with latexmk, read structured diagnostics, locate and visually inspect pages, audit changes, and resolve PDF annotations.
---

# LaTeX workspace

Use this skill whenever the task touches a local `.tex` project and the
dsh-latex plugin is available. Prefer these tools over running `latexmk` or
`pdftoppm` in a shell: they share one project registry with the editor and PDF
preview, and they return structured results.

## Tool order

1. `latex_get_status` — confirm the detected main file, engine, toolchain,
   preview version and auto-build state. Do this first when a path is ambiguous.
2. `latex_compile` — build. Read the first error before touching a second one.
   `force: true` only when an incremental build hides a stale auxiliary file.
3. `latex_get_diagnostics` — re-read the last build without compiling.
4. `latex_synctex` — map a source line to a page/point, or a point back to a
   source line. Use `inverse` before editing a location shown in the PDF.
5. `latex_look` — see a page as an image. Pass `text` to find the page and box,
   `point` for an exact spot, `compare: true` to diff the previous build.
6. `latex_audit` — after a larger edit, find changed/added/removed pages with
   cropped side-by-side images. Budgeted; do not use it as a page-by-page reader.
7. `latex_annotations` — read the user's PDF annotations, fix the source,
   resolve them. A screenshot annotation may have `ocrText` and no quote.

## Error playbook

| Symptom | First check | Typical fix |
| --- | --- | --- |
| `! LaTeX Error: File 'x.sty' not found` | TeX distribution completeness / `texBinDir` | install the package or use an existing one |
| `Undefined control sequence` | the first `file:line` from `latex_get_diagnostics` | fix the command or add its package |
| `Citation 'x' undefined` | `.bib` key spelling and BibTeX/Biber run | fix the key; check `latex_audit`/bib tools when available |
| `Reference 'x' undefined` | whether the label exists after two passes | add `\label`; compile twice |
| `Overfull \hbox` | the line from diagnostics | rephrase, resize, or add a break |
| Chinese text builds with pdflatex | engine detection | use `xelatex` (`engine: "xelatex"`) or set `% !TEX program = xelatex` |
| `latexmk exited 0 but did not produce a fresh PDF` | project `.latexmkrc` `$pdf_mode` | pass an explicit engine or fix the rc |
| Build timeout | log tail | raise `timeoutMs` or fix a TeX loop |

## Visual checks

- "Compiles but looks wrong" is a real class of bug: use `latex_look` on the
  page, not only diagnostics.
- For a figure/table that moved to the next page, pass `text` (the caption or
  first line); the tool searches the PDF text layer for the correct page.
- A red box in an audit composite marks the changed region; the caption/source
  line is in the text result.

## Annotations

- `list` first; fix all `open` items before resolving.
- `resolve` after a successful build. `remove` deletes one item and its screenshot.
- `stale` means the quote no longer exists after a rebuild — do not silently
  resolve it; ask the user or re-check the page.

## Safety

- Do not hand-edit files under `build/` or `.dsh-latex/`; they are plugin state.
- `.latexmkrc` and project TeX can execute code; do not treat a build as a sandbox.
- Only edit files inside the project root; the plugin's write API is fenced.
