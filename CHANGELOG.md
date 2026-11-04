# Changelog

All notable changes are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
semantic versioning.

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
