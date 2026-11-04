# Examples

Small projects used to exercise the plugin. Each directory is a normal LaTeX
project; open its `main.tex` from the right-sidebar file tree and press the
triangle save button (or Ctrl+S) to build.

- `hello/` — minimal single-file article with `amsmath` and a theorem.
- `chinese/` — `ctex` document for XeLaTeX.
- `multi-file/` — `main.tex` plus a chapter included through `\input`, with a
  cross-reference.

Build output goes to each project's `build/` directory and is ignored by Git.
TeX Live with `latexmk` and `xelatex` is required.
