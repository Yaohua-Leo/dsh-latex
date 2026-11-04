# Security

`dsh-latex` compiles local TeX projects, so it executes project code. It is not
a sandbox, and a review of the plugin is not a review of the documents you
build.

## What the plugin does to reduce risk

- `latexmk` is spawned with an argv array through DSH's subprocess service;
  no shell command is constructed from user paths.
- `-no-shell-escape` is passed unless the owner explicitly enables
  `allowShellEscape`.
- The editor write endpoint only accepts an existing absolute `.tex` path,
  rejects UNC/network paths, re-checks `allowedRoots` after resolving symlinks,
  caps the file at 4 MiB, and writes atomically only when the caller holds the
  revision it loaded.
- The PDF preview route serves only the published preview of a registered
  project; all routes except `/latex/health` use DSH's connection admission.

## What it cannot protect you from

- A project `.latexmkrc` is executable Perl. The default honours it because a
  project's recipe is part of its build contract; set
  `allowProjectLatexmkrc: false` to pass `-norc`.
- TeX itself can read files (for example through `\input` or `\openin`) and
  write files in the project (for example through `\openout`). `allowedRoots`
  is an entry fence for project resolution, not a filesystem sandbox. Build
  untrusted documents in a low-privilege container or VM.
- DSH plugin code runs with the Host's permissions. Install plugins from
  sources you trust.

## Reporting a vulnerability

Please open a private security advisory at
<https://github.com/Yaohua-Leo/dsh-latex/security/advisories/new>, or contact the
maintainer through the repository. Do not open a public issue for a
vulnerability. Please include a minimal `.tex`/configuration reproducer and the
affected version; supported versions are the current 0.2.x line.
