# Platform support

Updated 2026-11-23, v0.6.0.

| Area | Windows 11 | Ubuntu 24.04 | macOS |
| --- | --- | --- | --- |
| Host half (project/build/API/SSE) | Verified locally + CI | Verified CI | Unit tests in CI |
| Real-TeX e2e (`scripts/e2e.mjs`) | Verified locally | Verified CI | Best-effort BasicTeX job (`continue-on-error`) |
| Native PDF.js preview UI | Verified locally | Not automated | Not automated |
| CodeMirror editor UI | Verified locally | Not automated | Not automated |
| One-click TinyTeX install | Verified locally (official `.exe`) | Manual (`texBinDir`) | Manual (`texBinDir`) |
| OCR | RapidOCR managed venv / Tesseract fallback | RapidOCR needs Python 3; Tesseract installed in CI | RapidOCR needs Python 3; Tesseract optional |
| Clipboard / attachment integration | Via DSH Host | Via DSH Host | Via DSH Host |

## Notes

- macOS CI has two jobs: `macos-latest` runs `npm run check` and `npm test`
  (no TeX required); `macos-e2e` installs BasicTeX and tries the real e2e. The
  latter is explicitly best-effort because Homebrew casks and TinyTeX package
  coverage on a fresh runner are outside this plugin's control.
- The desktop UI (preview canvas, selection toolbar, marquee, CodeMirror) is
  only automated indirectly; the e2e covers the Host behavior and the browser
  half is exercised manually on Windows.
- POSIX paths, SyncTeX, Poppler, Tesseract and the TinyTeX `.tar.xz` extraction
  path are implemented; see `docs/limitations.md` §18 for what remains
  unverified.
