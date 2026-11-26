# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning.

## [Unreleased]

### Added

- **Forward SyncTeX from the editor** — `Ctrl` (or `Cmd`) + click on a line in the LaTeX editor asks the Host where that line sits in the PDF, reuses the PDF preview that is already open (in whichever pane it sits), switches to that page and draws a short-lived highlight ring on the exact spot. The editor's status line reports the page, or why the lookup could not run.

### Fixed

- A PDF Ctrl+click that resolves to a source line no longer claims success when the source tab could not be opened: the preview reports the failure, focuses the tab that holds the file, and logs the address for diagnosis. The inverse gesture is now `Ctrl`/`Cmd` + click (double-click still selects words for ask/annotate).
- A DVI-only `latexmk` run (for example a project `.latexmkrc` with `$pdf_mode = 0`) no longer reports success or publishes a stale PDF left in `build/`; failed builds also stop printing a stale `pdf:` line.

## [0.6.1] - 2026-11-26

### Fixed

- The scoped npm package's browser half now registers under
  `@yaohualiu/dsh-latex` instead of the unscoped old id. The Harness client
  module graph keys entries by package name; a mismatched id makes the entry
  never arrive, executes the bundle twice and drops the whole client half
  behind a duplicate-factory guard (Host tools kept working). `scripts/check.mjs`
  now enforces the invariant, with `scripts/client-id.mjs`,
  `test/client-registration.test.mjs` and `test/client-smoke.test.mjs`.
- The marketplace GitHub-release tarball is version-free (`dsh-latex.tgz`) so
  the `latest/download/` URL keeps working after each release.

## [0.6.0] - 2026-11-23

### Added

- **Build history + audit baselines** — the last five successful builds keep
  their PDF and `{version, reason, builtAt, engine, pages, durationMs}` metadata;
  `latex_audit` accepts `against: previous | last-manual | <version>`, defaults
  to the last manual/editor build (never a watcher auto-build), and reports
  which baseline it used. A preview **Audit** panel chooses a baseline, runs
  the audit without the model, streams progress from the snapshot, and shows
  changed pages with side-by-side thumbnails.
- **Paper checks** — `latex_cite_audit`, `latex_bib_lint`,
  `latex_layout_lint`, and a dry-run `latex_bib_fill` Crossref lookup (no API
  key, nothing written). Sources are read with bounded recursion; comments are
  stripped before key matching; layout rules are configurable.
- **Local OCR model (RapidOCR/PP-OCRv4)** — the screenshot popover offers a
  one-click install into an isolated Python venv (`~/.dsh-latex/ocr` by default),
  with progress and cancel; the wheel bundles the PP-OCR ONNX models, inference
  is local, and Tesseract remains the fallback. `ocrEngine`, `ocrPython`,
  `ocrInstallDir` and `ocrInstallTimeoutMs` configure it. No API key.
- **CodeMirror 6 editor** — vendored `assets/codemirror.mjs` (esbuild bundle,
  MIT notices), LaTeX highlighting, line numbers, search, outline jump,
  `Ctrl+S`, per-tab draft recovery, and a disk-change banner; textarea fallback
  if the asset cannot load. Existing CAS/atomic-write semantics are unchanged.
- **One-click TinyTeX (Windows)** — downloads the official self-extracting
  asset, streams SHA-256 verification, extracts into the user directory via
  argv-only `[exe, '-y']` / system `tar`, and points `texBinDir` at it. Progress
  and cancel are exposed through `GET /latex/toolchain`,
  `POST /latex/toolchain/install` and `POST /latex/toolchain/cancel`; PATH and
  the registry are never modified. Non-Windows platforms remain manual.
- **Preview UX** — PDF outline with page jumps, per-project page/zoom
  persistence in localStorage, `Ctrl+F` document search with hit snippets,
  download, and dark preview.
- **Audit batch rendering** — missing audit pages render through one
  `pdftoppm -f … -l …` call per PDF instead of one process per page, with the
  previous per-page fallback.
- **Distribution** — the npm package is published as
  `@yaohualiu/dsh-latex` (the unscoped `dsh-latex` name is owned by another
  account); `engines.dsh`, screenshots/CodeMirror/skills in the npm package, a
  capability table, `skills/latex/SKILL.md`, and a demo GIF;
  macOS unit CI and a best-effort BasicTeX e2e job.
- **Docs** — `docs/platform-support.md`, architecture §20, limitations §18,
  README/tool/config updates.

### Fixed

- `npm test` no longer picks up the real-TeX e2e script (moved to
  `scripts/e2e.mjs`).
- The audit composite filename regex now escapes correctly and the range
  renderer tolerates Poppler's unpadded page suffixes.

## [0.5.0] - 2026-11-23

### Added

- **`latex_audit`** — compare the whole document against the retained previous
  build, page by page, and return changed-page summaries with cropped
  side-by-side composites (old | new + red diff box). Budgeted by
  `maxPages` (30), `dpi` (100) and `maxImages` (3); added/removed pages and a
  byte-identical rebuild are reported separately.
- **Previous-build retention** — a successful build keeps one generation of the
  published preview (`previous-<fingerprint>.pdf`) so the audit can render the
  old page; `latex_clean includePreview` removes it.
- **Marquee screenshot questions** — a toolbar crop mode captures a PDF page
  region to a PNG and sends it into the current session as a text + image
  message (`POST /latex/ask-image`); screenshot questions work on scanned PDFs
  with no text layer.
- **Screenshot annotations** — annotations may carry a PNG crop stored under
  `stateDir/annotation-images/`; the panel shows a thumbnail, and image-only
  annotations survive a rebuild as an explicitly best-effort position.
- **Optional local OCR** — `src/ocr.js` detects `tesseract` and adds OCR text to
  screenshot questions and annotations (`ocrEnabled`, `ocrLanguages`,
  `ocrTimeoutMs`); a missing engine degrades silently.
- **Annotation delete** — per-item delete in the preview panel, `DELETE
  /latex/annotations?id=`, and `latex_annotations action=remove`; screenshots are
  removed with the item.
- **Preview shortcuts** — `Esc` closes the selection/panel/marquee, `Ctrl/Cmd+
  Enter` sends or saves the pending selection, `Alt+←/→` changes page.
- **PNG encoder / compositor** — dependency-free PNG encoding, cropping and
  red-box side-by-side composition for the audit.
- **Cross-process hardening** — annotation read-modify-write uses an `O_EXCL`
  lock file with stale reclaim and a retryable 503 on timeout; renders are
  written to a unique temp file and atomically renamed. Tests spawn two
  processes to prove no lost annotation entries.
- **New config**: `annotationImageMaxBytes`, `annotationsLockWaitMs`,
  `annotationsLockStaleMs`, `auditMaxPages`, `auditDpi`, `auditMaxImages`,
  `askImageMaxBytes`, `ocrEnabled`, `ocrLanguages`, `ocrTimeoutMs`.

### Changed

- **Source-line precision** — `askFromSelection` and `latex_look` now locate the
  quote with `pdftotext -bbox` and invert SyncTeX at the first line of that box,
  instead of using the selection centre. The e2e suite asserts that
  `\section{An equation}` resolves to `main.tex:11`, not a nearby line.
- `latex_look`/`latex_audit` reports now carry a project root and an absolute
  source path in the session message, so the model can open the file directly.
- `/latex/health` report unchanged; version is 0.5.0.

### Security

- Screenshot payloads are validated (PNG/JPEG/WebP signature, canonical base64,
  size cap); stored screenshots live only under a project's state directory and
  are served by an admission-protected route.
- OCR runs only a local `tesseract` binary with an argv array; no shell, no
  network.

## [0.4.0] - 2026-11-23

### Added

- **`latex_look` tool** — renders one page of the built PDF to a PNG and returns
  it to the model as an image, with the SyncTeX source location and a pixel
  diff against the previous build. Text (`text`) and point (`point`) anchors,
  optional normalized `crop`, and a `compare` switch. Rendering uses Poppler's
  `pdftoppm`/`pdftotext` (shipped with TeX Live) with Ghostscript/muPDF
  fallbacks; no npm dependency is added.
- **Rendered-page cache** under `<buildDir>/.dsh-latex/look/<content-hash>/`,
  keyed by the PDF bytes; the previous build's renders are retained for diffs
  and pruned to `lookCacheKeep` build hashes.
- **Preview text layer and selection toolbar** — PDF pages are selectable; a
  selection can be sent to the current session (`POST /latex/ask`, delivered
  through the Host session controller) or saved as an annotation. If sending is
  unavailable the selection is copied to the clipboard instead.
- **Annotations** — persisted per project in
  `<buildDir>/.dsh-latex/annotations-<fingerprint>.json` with atomic writes and
  size/item caps; after a rebuild they are re-anchored by their quote (or marked
  `stale`), and the new **`latex_annotations`** tool lists/resolves/clears them.
- **New routes**: `POST /latex/ask`, `GET/POST/PATCH/DELETE /latex/annotations`;
  all reuse the existing same-origin connection admission.
- **Config**: `renderDpi`, `renderEngine`, `renderTimeoutMs`, `lookMaxPixels`,
  `lookCacheKeep`, `annotationsMaxItems`, `annotationsMaxBytes`.
- **CJK-aware text anchoring** via UTF-8 `pdftotext` and `pdftotext -bbox`
  (quote → page + PDF-point box), with a float/overfull page correction path.
- **CI e2e job** — Ubuntu + TeX Live + Poppler compiles the bundled examples and
  runs render/text-anchor/diff/look/annotation/ask checks.

### Changed

- `latex_clean includePreview=true` also removes the project's annotations,
  because they were anchored to the deleted preview.
- `/latex/health` now reports `render` capability (`canRender`,
  `canExtractText`, engine) for diagnostics.
- The system prompt mentions the two new tools.

### Security

- Rendering uses argv arrays only; no shell interpolation. The renderer executes
  only local Poppler/Ghostscript binaries, and images/annotations stay inside a
  registered project's build directory. New routes reject unauthenticated
  requests through the same admission boundary as the rest of the plugin.

## [0.3.0] - 2026-11-04

### Added

- Debounced **auto-save and auto-compile** in the TeX editor: after typing stops
  (default 900 ms), the source is written and built without Ctrl+S. The status
  pill shows whether auto or manual compile is active.
- `editorAutoSave` and `editorAutoSaveDelayMs` config keys; auto-save stops on
  a conflict or I/O error and never creates duplicate builds for one write.

### Changed

- The editor's toolbar status now distinguishes automatic and manual compile
  modes.

## [0.2.0] - 2026-11-04

### Added

- A `.tex`-claiming sidebar tab that opens a line-numbered editor directly;
  DSH's read-only document preview is no longer shown for `.tex` files.
- `GET /latex/file` and `POST /latex/file` for safe `.tex` reads and atomic
  writes (UTF-8, 4 MiB cap, BOM/EOL preservation, revision compare-and-swap).
- `/latex/action {action: "compile-file"}` to resolve a `.tex` file's real main
  document and rebuild it.
- Editor toolbar: save-and-compile (triangle / Ctrl+S), reload, open PDF
  preview, failure banner with `file:line`, and conflict handling.
- Unit tests and CI for file I/O and the HTTP file routes.

### Changed

- `texBinDir` now defaults to empty and discovers `latexmk` from
  `DSH_LATEX_TEX_BIN` or `PATH`; tools are resolved for Windows and POSIX.
- The plugin metadata is publishable: repository/homepage/bugs, keywords,
  `engines.node`, raster icon and marketplace screenshots.

### Removed

- The LaTeX Workbench tab, its guide card, the chat-header LaTeX button and the
  tool-card workbench buttons.

## [0.1.0] - 2026-11-03

### Added

- Initial Host/Client bundle: project and root-document detection, `latexmk`
  builds for XeLaTeX/pdfLaTeX/LuaLaTeX, build queue, source watcher with
  debounce/coalescing, last-good PDF publication, LaTeX/BibTeX/Biber log
  parsing, SyncTeX forward/inverse, seven model tools, SSE state updates and a
  PDF.js preview tab.
