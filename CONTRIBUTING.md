# Contributing

Thanks for taking a look at `dsh-latex`.

## Development

There is no build step: the Host half is plain ES modules and the browser half
is a single module consumed by DSH's client module loader.

```sh
git clone https://github.com/Yaohua-Leo/dsh-latex.git
cd dsh-latex
npm test          # node:test; no dependencies to install
npm run check     # node --check over every source file
```

To try a checkout in a DSH profile, install it as a local bundle from the
Plugin Manager (`plugin_manager action=install_bundle target=<absolute path>`),
or from a shell:

```sh
dsh plugin --profile desktop add /absolute/path/to/dsh-latex
```

Reload the page / restart the Host when the plugin manager asks for it.

## Expectations for a change

- Keep the public behavior documented in `README.md`; update it when you add a
  config key or tool.
- Preserve the security invariants: no shell interpolation, no default shell
  escape, `.tex`-only editor writes, `allowedRoots`/UNC/realpath checks, and
  atomic writes with a revision compare-and-swap.
- Add a `node:test` case for new filesystem or HTTP behavior. Tests must not
  require a TeX installation; they may use temporary directories.
- Keep the browser half dependency-free. It imports only `react` from DSH's
  module table, and PDF.js is vendored under `assets/` (Apache-2.0).
- Run `npm test` and `npm run check` before opening a pull request.

## Reporting bugs

Please include the DSH version, operating system, TeX Live/`latexmk` version,
and the output of `GET /latex/health` when it is relevant. Logs and paths are
often enough to reproduce the problem; remove anything private first.

Security issues should follow [SECURITY.md](SECURITY.md), not a public issue.
