/**
 * Model-facing LaTeX tools.
 *
 * Every tool resolves exactly one project through the same resolver the UI
 * uses and calls the same service methods the panel's buttons call. Tool
 * results are written for a model first: status, the file that actually failed,
 * and a next action.
 */
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { defineTool } from './tool.js';
import { errorMessage } from './util.js';

const ENGINE_ENUM = ['xelatex', 'pdflatex', 'lualatex'];

function toolText(lines) {
  return lines.filter((line) => line !== undefined && line !== null).join('\n');
}

function diagnosticLine(item, rootDir) {
  const location = item.file
    ? (() => {
        const relative = path.relative(rootDir, item.file);
        const file = relative && !relative.startsWith('..') ? relative.replace(/\\/g, '/') : item.file;
        return item.line ? `${file}:${item.line}` : file;
      })()
    : item.line
      ? `line ${item.line}`
      : '<unknown location>';
  return `- ${location}: ${item.message}${item.hint ? ` (${item.hint})` : ''}`;
}

export function formatResult(result, { includeWarnings = true, maxErrors = 25 } = {}) {
  const diagnostics = result.diagnostics ?? { errors: [], warnings: [], counts: { errors: 0, warnings: 0 } };
  const lines = [];
  const statusWord = String(result.status ?? 'unknown').toUpperCase();
  lines.push(`LaTeX build: ${statusWord}`);
  lines.push(`project: ${result.rootDir}`);
  lines.push(`main: ${result.mainFile}`);
  lines.push(
    `engine: ${result.engine} | duration: ${result.durationText ?? `${result.durationMs ?? 0} ms`} | exit: ${
      result.exitCode ?? '-'
    }`,
  );
  // A failed/timeout/cancelled build may still have an older successful PDF in
  // the build directory; never present it as this build's output.
  if (result.status === 'success' && result.pdfPath) {
    lines.push(`pdf: ${result.pdfPath}${result.pages ? ` (${result.pages} pages)` : ''}`);
  }
  if (result.previewPath) lines.push(`preview: ${result.previewPath} | version: ${result.previewVersion ?? '-'}`);
  if (result.logPath) lines.push(`log: ${result.logPath}`);
  if (result.rcFile) lines.push(`latexmkrc: ${result.rcFile} (project configuration respected)`);
  if (result.error) lines.push(`error: ${result.error}`);
  lines.push(
    `diagnostics: ${diagnostics.counts?.errors ?? 0} error(s), ${
      diagnostics.counts?.warnings ?? 0
    } warning(s)`,
  );
  const errors = (diagnostics.errors ?? []).slice(0, maxErrors);
  if (errors.length > 0) {
    lines.push('errors:');
    for (const item of errors) lines.push(diagnosticLine(item, result.rootDir));
    if ((diagnostics.counts?.errors ?? 0) > errors.length) {
      lines.push(`... ${(diagnostics.counts?.errors ?? 0) - errors.length} more error(s) in the log`);
    }
  }
  if (includeWarnings && (diagnostics.warnings ?? []).length > 0) {
    if ((diagnostics.warnings ?? []).length <= 12) {
      lines.push('warnings:');
      for (const item of diagnostics.warnings) lines.push(diagnosticLine(item, result.rootDir));
    } else {
      lines.push(`warnings: ${diagnostics.warnings.length} (first 8 shown)`);
      for (const item of diagnostics.warnings.slice(0, 8)) lines.push(diagnosticLine(item, result.rootDir));
    }
  }
  if (result.status === 'success') {
    lines.push('Next: change the source and compile again, or open the preview tab (LaTeX → Preview).');
  } else if (result.status === 'failure') {
    lines.push('Next: fix the first error above, then call latex_compile again.');
  } else if (result.status === 'timeout') {
    lines.push(`Next: the build exceeded its ${result.timeoutMs ?? ''} ms timeout; raise timeoutMs or fix the loop.`);
  } else if (result.status === 'cancelled') {
    lines.push('Next: the build was cancelled; call latex_compile again when ready.');
  }
  return lines.join('\n');
}

function projectStatusLine(project) {
  const last = project.lastBuild;
  const state =
    project.building
      ? 'building'
      : project.queued > 0
        ? `queued (${project.queued})`
        : last
          ? `${last.status} at ${last.clock ?? ''} in ${Math.round((last.durationMs ?? 0) / 100) / 10}s`
          : 'never built';
  return `${project.mainFile} | ${project.engine} | ${state} | preview v${project.previewVersion || '-'}`;
}

function oneLine(value, max = 160) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function roundBox(box) {
  if (!box) return '';
  const round = (value) => Math.round(Number(value) * 10) / 10;
  return `x${round(box.x)} y${round(box.y)} ${round(box.w)}x${round(box.h)}`;
}

function formatLookFailure(look) {
  return toolText([
    `LaTeX look failed: ${look.code ?? 'ERROR'}`,
    look.message,
    look.pages ? `pages: ${look.pages}` : undefined,
    look.capability
      ? `renderer: ${look.capability.engine ?? 'none'} | text extraction: ${
          look.capability.canExtractText ? 'yes' : 'no'
        }`
      : undefined,
    'Next: build the project first, or install a PDF renderer (TeX Live ships pdftoppm).',
  ]);
}

function formatLookResult(look) {
  const lines = [];
  lines.push(
    `LaTeX look: page ${look.pages ? `${look.page}/${look.pages}` : look.page} @ ${look.dpi} dpi (${look.engine}${
      look.cached ? ', cached' : ''
    })`,
  );
  lines.push(`project: ${look.rootDir}`);
  if (look.text) {
    if (look.text.found) {
      lines.push(
        `text: found on page ${look.text.page}${look.text.box ? ` at ${roundBox(look.text.box)}` : ''}`,
      );
    } else {
      lines.push(`text: NOT found (${look.text.message ?? 'no match'}); rendered the requested page instead.`);
    }
  }
  if (look.source) {
    if (look.source.ok) {
      const file = look.source.relativeFile ?? look.source.file;
      lines.push(
        `source: ${file}${look.source.line ? `:${look.source.line}` : ''}${
          look.source.approximate ? ' (approximate: page centre)' : ''
        }`,
      );
    } else if (look.source.message) {
      lines.push(`source: ${look.source.message}`);
    }
  }
  if (look.diff) {
    if (look.diff.comparable) {
      if (look.diff.changed > 0) {
        lines.push(
          `diff vs previous build: ${look.diff.changed} px changed (${(look.diff.ratio * 100).toFixed(2)}%)${
            look.diff.box ? `, box ${roundBox(look.diff.box)}` : ''
          }`,
        );
      } else {
        lines.push('diff vs previous build: no visible change');
      }
    } else {
      lines.push(`diff vs previous build: not comparable (${look.diff.reason ?? 'unknown'})`);
    }
  } else {
    lines.push('diff vs previous build: no previous render of this page');
  }
  if (look.cropDropped) lines.push('crop: dropped (page size unavailable)');
  lines.push(`png: ${look.pngPath}`);
  lines.push('Next: compare the image with the source location; edit the .tex file and compile again if needed.');
  return lines.join('\n');
}

function formatAnnotations(listed) {
  const lines = [
    `LaTeX annotations for ${listed.mainFile} (build v${listed.buildVersion || '-'})`,
    `counts: open ${listed.counts.open} | stale ${listed.counts.stale} | resolved ${listed.counts.resolved} | total ${listed.counts.total}`,
    listed.reanchorAvailable
      ? 're-anchoring: available (pdftotext)'
      : 're-anchoring: unavailable (pdftotext missing); old items may be stale',
  ];
  const items = listed.items.slice(0, 50);
  for (const item of items) {
    const comment = item.comment ? ` — ${oneLine(item.comment, 160)}` : '';
    const image = item.image ? ' [screenshot]' : '';
    const ocr = item.ocrText ? ` | OCR: ${oneLine(item.ocrText, 100)}` : '';
    lines.push(
      `- ${item.id} p${item.page} [${item.status}]${image} "${oneLine(item.quote, 160)}"${comment}${ocr}`,
    );
  }
  if (listed.items.length > items.length) lines.push(`... ${listed.items.length - items.length} more`);
  if (listed.items.length === 0) {
    lines.push('No annotations. They are created from the PDF preview selection toolbar.');
  } else {
    lines.push('Next: fix the source for open annotations, rebuild, then resolve them with action=resolve.');
  }
  return lines.join('\n');
}

function formatCitationAudit(result) {
  const lines = [
    `LaTeX citation audit: ${result.texFiles.length} .tex file(s) | ${result.bibFiles.length} .bib file(s)`,
    `cited: ${result.cited.length} | missing from bib: ${result.missing.length} | never cited: ${result.neverCited.length}`,
  ];
  if (result.missing.length > 0) {
    lines.push('cited but missing from the .bib:');
    for (const key of result.missing.slice(0, 80)) {
      const occurrence = (result.occurrences ?? []).find((item) => item.key === key);
      lines.push(`- ${key}${occurrence ? ` (${occurrence.path}:${occurrence.line})` : ''}`);
    }
  }
  if (result.neverCited.length > 0) {
    lines.push('present in the .bib but never cited:');
    for (const key of result.neverCited.slice(0, 80)) lines.push(`- ${key}`);
  }
  if (result.bibErrors?.length > 0) {
    lines.push(`bib parse errors: ${result.bibErrors.length}`);
    for (const error of result.bibErrors.slice(0, 10)) lines.push(`- ${error.message ?? error}`);
  }
  if (result.missing.length === 0 && result.neverCited.length === 0) {
    lines.push('No citation-key problems found.');
  }
  return lines.join('\n');
}

function formatBibliographyLint(result) {
  const lines = [
    `LaTeX bib lint: ${result.entries.length} entr${result.entries.length === 1 ? 'y' : 'ies'} | ${result.issues.length} issue(s)`,
  ];
  if (result.errors?.length > 0) {
    lines.push(`parse errors: ${result.errors.length}`);
    for (const error of result.errors.slice(0, 10)) lines.push(`- ${error.message ?? error}`);
  }
  for (const issue of result.issues.slice(0, 80)) {
    lines.push(`- [${issue.severity ?? 'warning'}] ${issue.key ?? issue.type ?? ''}: ${issue.message}`);
  }
  if (result.issues.length === 0 && (result.errors?.length ?? 0) === 0) lines.push('No bib problems found.');
  return lines.join('\n');
}

function formatLayoutAudit(result) {
  const lines = [
    `LaTeX layout lint: ${result.issues.length} issue(s) | pages: ${result.pageCount ?? 'unknown'} | figures: ${
      result.figures?.length ?? 0
    } | tables: ${result.tables?.length ?? 0}`,
  ];
  for (const issue of result.issues.slice(0, 80)) {
    lines.push(
      `- [${issue.severity ?? 'warning'}] ${issue.code ?? 'issue'}${issue.line ? `:${issue.line}` : ''}: ${
        issue.message
      }`,
    );
  }
  if (result.issues.length === 0) lines.push('No layout warnings found.');
  return lines.join('\n');
}

function formatCrossrefFill(result) {
  const lines = [`Crossref ${result.doi}: ${result.message}`];
  if (result.key) lines.push(`bib key: ${result.key}`);
  if (result.missing && Object.keys(result.missing).length > 0) {
    lines.push('missing fields with proposed values (not written):');
    for (const [name, value] of Object.entries(result.missing)) lines.push(`- ${name} = ${String(value)}`);
  }
  return lines.join('\n');
}

function formatAuditFailure(result) {
  return toolText([
    `LaTeX audit failed: ${result.code ?? 'ERROR'}`,
    result.message,
    result.capability
      ? `renderer: ${result.capability.engine ?? 'none'}`
      : undefined,
    'Next: run latex_compile first, or install a PDF renderer (TeX Live ships pdftoppm).',
  ]);
}

function formatAuditResult(result) {
  const lines = [];
  lines.push(
    `LaTeX audit: pages ${result.from}-${result.to} of ${result.pages} | dpi ${result.dpi} | previous build ${
      result.previous ? (result.identical ? 'byte-identical' : `has ${result.previousPages} page(s)`) : 'missing'
    }`,
  );
  if (result.message) lines.push(result.message);
  lines.push(
    `changed: ${result.changed.length} | added: ${result.added.length} | removed: ${result.removed.length} | failed: ${
      result.failed.length
    } | images: ${result.images.length}`,
  );
  if (result.truncated) {
    lines.push(`truncated: only pages ${result.from}-${result.to} were checked (auditMaxPages budget).`);
  }
  for (const entry of [...result.changed, ...result.added, ...result.removed, ...result.failed]) {
    if (entry.status === 'removed') {
      lines.push(`- page ${entry.page}: removed`);
      continue;
    }
    if (entry.status === 'added') {
      const source = entry.source
        ? ` | source: ${entry.source.file}${entry.source.line ? `:${entry.source.line}` : ''}`
        : '';
      const image = entry.imagePath ? ` | image attached` : '';
      lines.push(`- page ${entry.page}: added${source}${image}`);
      continue;
    }
    if (entry.code) {
      lines.push(`- page ${entry.page}: render failed (${entry.code}: ${entry.message ?? ''})`);
      continue;
    }
    const changed = Number.isFinite(entry.changed)
      ? `${entry.changed} px changed (${(entry.ratio * 100).toFixed(2)}%)`
      : `changed (${entry.reason ?? 'unknown'})`;
    const box = entry.box ? ` | box ${roundBox(entry.box)}` : '';
    const source = entry.source
      ? ` | source: ${entry.source.file}${entry.source.line ? `:${entry.source.line}` : ''}${
          entry.source.approximate ? ' (approximate)' : ''
        }`
      : '';
    const image = entry.imagePath ? ` | image attached` : '';
    lines.push(`- page ${entry.page}: ${changed}${box}${source}${image}`);
  }
  if (result.images.length > 0) {
    lines.push('Composites: old | new, cropped around the change; the red box marks the diff region.');
  } else if (result.previous && !result.identical) {
    lines.push('No composite was produced (no diff box, maxImages=0, or a page-size change).');
  }
  return lines.join('\n');
}


export function registerLatexTools(ctx, service, config) {
  const tools = ctx.get('tools');
  if (!tools) return () => {};
  const logger = ctx.logger('latex');
  const disposers = [];

  async function cwdOf(exec) {
    const workingDirectory = ctx.get('workingDirectory');
    if (!workingDirectory || !exec.agent) return undefined;
    try {
      return await workingDirectory.ensure(exec.agent, exec.signal);
    } catch {
      return undefined;
    }
  }

  async function resolveProject(args, exec) {
    const cwd = await cwdOf(exec);
    return service.ensureProject(
      {
        file: typeof args.path === 'string' ? args.path : undefined,
        project: typeof args.project === 'string' ? args.project : undefined,
        mainFile: typeof args.mainFile === 'string' ? args.mainFile : undefined,
        cwd,
      },
      { sessionId: exec.agent ? String(exec.agent.id) : undefined },
    );
  }

  const commonProjectParams = {
    path: {
      type: 'string',
      description:
        'A .tex file (chapter or main), a project directory, or a main .tex path. Omit to detect the LaTeX project from the session working directory.',
    },
    mainFile: {
      type: 'string',
      description: 'Explicit main .tex file; wins over path detection. Relative paths resolve from the session cwd.',
    },
    project: {
      type: 'string',
      description: 'Alias of mainFile, or a directory containing exactly one root document.',
    },
  };

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_compile',
        description:
          'Compile a local LaTeX project with the configured TeX Live latexmk (xelatex by default). Returns structured diagnostics with file:line locations and the PDF preview version. The project root is auto-detected from the .tex file (including `% !TEX root` and \\input/\\include graphs), so compiling a chapter file compiles its real main document. A successful build publishes a new preview version; a failed build keeps the previous successful PDF.',
        parameters: {
          ...commonProjectParams,
          engine: {
            type: 'string',
            enum: ENGINE_ENUM,
            description: 'Build engine override for this and later builds of the project (default: xelatex).',
          },
          force: {
            type: 'boolean',
            description: 'Force a full rebuild (latexmk -gg) instead of an incremental build.',
          },
          open: {
            type: 'boolean',
            description: 'Open/focus the in-app PDF preview after a successful build (default: true).',
          },
          timeoutMs: {
            type: 'number',
            description: 'Hard timeout for this build in milliseconds (default from plugin config).',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          const open = args.open === undefined ? config.autoOpenPreview : args.open === true;
          const result = await service.enqueueBuild(project, {
            reason: 'manual',
            force: args.force === true,
            engine: args.engine,
            engineExplicit: typeof args.engine === 'string',
            timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
            signal: exec.signal,
            open,
            sessionId: exec.agent ? String(exec.agent.id) : undefined,
          });
          return formatResult(result);
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_preview',
        description:
          'Open the compiled PDF in the DeepSeek Harness LaTeX preview (a PDF.js tab inside the app), keeping one preview tab per session so a rebuild refreshes it instead of opening new windows. If no successful build exists yet, compile first. Use `page` to jump to a page number.',
        parameters: {
          ...commonProjectParams,
          page: { type: 'number', description: '1-based page to reveal in the preview.' },
          compile: {
            type: 'boolean',
            description: 'Compile first when the project has no successful PDF yet (default: true).',
          },
          surface: {
            type: 'string',
            enum: ['native', 'document'],
            description:
              'native = the plugin PDF.js tab (page jump, SyncTeX); document = the built-in DSH document preview. Default: native.',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          let compiled;
          if (project.previewVersion === 0 && args.compile !== false) {
            compiled = await service.enqueueBuild(project, {
              reason: 'preview',
              signal: exec.signal,
              timeoutMs: config.timeoutMs,
              sessionId: exec.agent ? String(exec.agent.id) : undefined,
            });
            if (compiled.status !== 'success') return formatResult(compiled);
          }
          const request = service.requestPreview(project, {
            page: typeof args.page === 'number' ? Math.max(1, Math.round(args.page)) : undefined,
            sessionId: exec.agent ? String(exec.agent.id) : undefined,
            reason: 'tool',
            surface: args.surface,
          });
          return toolText([
            `LaTeX preview: ${project.previewVersion > 0 ? 'open' : 'no successful PDF yet'}`,
            `main: ${project.mainFile}`,
            `preview: ${project.paths.previewPath}`,
            `version: ${project.previewVersion || '-'}${
              project.previewPages ? ` | pages: ${project.previewPages}` : ''
            }${project.stale ? ' | STALE: the last build failed, showing the previous successful PDF' : ''}`,
            project.previewVersion === 0
              ? 'Run latex_compile first, then call latex_preview again.'
              : args.surface === 'document'
                ? 'The built-in DSH document preview opens in the right sidebar; a rebuild refreshes the same file tab.'
                : 'The PDF.js preview tab opens in the right sidebar (LaTeX → Preview); rebuilds refresh it in place.',
            request.page ? `page: ${request.page}` : undefined,
          ]);
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_get_diagnostics',
        description:
          'Read the latest structured LaTeX compile diagnostics (errors and warnings with file, line and message) without rebuilding. Use this after a failed build to drive targeted source fixes.',
        parameters: {
          ...commonProjectParams,
          warnings: {
            type: 'boolean',
            description: 'Include warnings as well as errors (default: true).',
          },
          limit: { type: 'number', description: 'Maximum number of diagnostics to print (default: 40).' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          const limit = Math.max(1, Math.min(200, Number(args.limit) || 40));
          const includeWarnings = args.warnings !== false;
          if (project.lastBuild?.status === undefined && project.previewVersion === 0) {
            return `No LaTeX build has run yet for ${project.mainFile}. Call latex_compile first.`;
          }
          const diagnostics = project.diagnostics ?? { errors: [], warnings: [], counts: {} };
          const lines = [
            `LaTeX diagnostics for ${project.mainFile}`,
            `status: ${project.status}${project.lastBuild ? ` (${project.lastBuild.reason})` : ''}`,
            `errors: ${diagnostics.counts?.errors ?? 0} | warnings: ${diagnostics.counts?.warnings ?? 0}`,
            project.lastError ? `last error: ${project.lastError}` : undefined,
            ...(project.diagnostics.errors.length > 0 ? ['errors:'] : []),
            ...project.diagnostics.errors.slice(0, limit).map((item) => diagnosticLine(item, project.rootDir)),
            ...(includeWarnings && project.diagnostics.warnings.length > 0 ? ['warnings:'] : []),
            ...(includeWarnings
              ? project.diagnostics.warnings
                  .slice(0, Math.max(0, limit - project.diagnostics.errors.length))
                  .map((item) => diagnosticLine(item, project.rootDir))
              : []),
            project.lastBuild?.logPath ? `log: ${project.lastBuild.logPath}` : undefined,
            project.lastBuild?.status === 'success'
              ? 'The last build succeeded; any stale error above is historical.'
              : undefined,
          ];
          return toolText(lines);
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_get_status',
        description:
          'Report LaTeX project status: detected main file, engine, build state, preview version, last build time, errors/warnings, and whether the PDF is stale (last build failed).',
        parameters: {
          ...commonProjectParams,
          all: { type: 'boolean', description: 'Report every known LaTeX project instead of one.' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          const toolchain = await service.builder.checkToolchain().catch(() => undefined);
          const lines = [];
          if (toolchain) {
            lines.push(
              `toolchain: ${toolchain.ok ? 'ready' : 'INCOMPLETE'} | latexmk: ${toolchain.latexmk}${
                toolchain.missing?.length ? ` | missing: ${toolchain.missing.join(', ')}` : ''
              }`,
            );
          }
          if (args.all === true) {
            const projects = [...service.projects.values()];
            if (projects.length === 0) return toolText([...lines, 'No LaTeX project has been used in this Host yet.']);
            lines.push(`projects: ${projects.length}`);
            for (const project of projects) lines.push(`- ${projectStatusLine(project)}`);
            return toolText(lines);
          }
          const project = await resolveProject(args, exec);
          lines.push(`project: ${project.rootDir}`);
          lines.push(`main: ${project.mainFile}`);
          lines.push(`engine: ${project.engine} | build dir: ${project.paths.buildDirAbs}`);
          lines.push(
            `status: ${project.building ? 'building' : project.queued ? 'queued' : project.status} | auto-build: ${
              project.autoBuild
            } | watching: ${project.watchActive}${project.watchError ? ` (${project.watchError})` : ''}`,
          );
          if (project.lastBuild) {
            lines.push(
              `last build: ${project.lastBuild.status} (${project.lastBuild.reason}) at ${project.lastBuild.clock} in ${
                project.lastBuild.durationMs
              } ms | exit ${project.lastBuild.exitCode ?? '-'} | errors ${project.lastBuild.errors}, warnings ${
                project.lastBuild.warnings
              }`,
            );
          }
          lines.push(
            `preview: version ${project.previewVersion || '-'} | pages ${project.previewPages ?? '-'} | ${
              project.stale ? 'STALE (last build failed)' : project.previewVersion ? 'current' : 'none'
            }`,
          );
          if (project.lastBuild?.logPath) lines.push(`log: ${project.lastBuild.logPath}`);
          if (project.lastError) lines.push(`last error: ${project.lastError}`);
          lines.push(
            `pdf: ${project.paths.pdfPath} | preview file: ${project.paths.previewPath}`,
          );
          return toolText(lines);
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_clean',
        description:
          'Remove LaTeX auxiliary files (aux/log/toc/out/bbl/synctex/...) from the project build directory. Only recognised auxiliary files are deleted; the source tree and unrelated build artifacts are left alone. Optionally delete the PDF and the published preview.',
        parameters: {
          ...commonProjectParams,
          includePdf: { type: 'boolean', description: 'Also delete the built PDF in the build directory (default: false).' },
          includePreview: {
            type: 'boolean',
            description: 'Also delete the last-successful preview PDF and its metadata (default: false).',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          const result = await service.clean(project, {
            includePdf: args.includePdf === true,
            includePreview: args.includePreview === true,
          });
          return toolText([
            `LaTeX clean: ${result.removed.length} auxiliary file(s) removed`,
            `build dir: ${result.buildDir}`,
            ...result.removed.slice(0, 40).map((file) => `- removed ${file}`),
            result.removed.length > 40 ? `... ${result.removed.length - 40} more` : undefined,
            result.kept.length > 0 ? `${result.kept.length} unrecognised file(s) kept (not deleted)` : undefined,
          ]);
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_cancel',
        description:
          'Cancel running or queued LaTeX builds for a project. latexmk and its TeX child processes are terminated through the Host process tree.',
        parameters: { ...commonProjectParams },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          const result = service.cancel(project);
          return result.cancelled
            ? `LaTeX build cancelled for ${project.mainFile} (running: ${result.running}, queued: ${result.queued}).`
            : `No LaTeX build is running for ${project.mainFile}.`;
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_synctex',
        description:
          'SyncTeX between source and PDF: forward sync maps a TeX source file:line to a PDF page and coordinates; inverse sync maps a PDF page and point to the TeX source line. Requires a successful build with -synctex.',
        parameters: {
          ...commonProjectParams,
          direction: {
            type: 'string',
            enum: ['forward', 'inverse'],
            description: 'forward = source → PDF; inverse = PDF → source.',
          },
          file: { type: 'string', description: 'Source .tex file for forward sync (relative to the project root).' },
          line: { type: 'number', description: '1-based source line for forward sync.' },
          column: { type: 'number', description: '1-based source column for forward sync (default: 1).' },
          page: { type: 'number', description: '1-based PDF page for inverse sync.' },
          x: { type: 'number', description: 'PDF x coordinate in TeX points (72 dpi) for inverse sync.' },
          y: { type: 'number', description: 'PDF y coordinate in TeX points (72 dpi) for inverse sync.' },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => true,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          const cwd = await cwdOf(exec);
          return service.syncTeX(project, args, exec.signal, cwd);
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_audit',
        description:
          'Audit the whole built document against the previous build and return changed-page summaries plus cropped side-by-side images (old | new, red diff box). Use it after a large edit to find "compiles fine but this page moved/wrapped differently" regressions. Budgeted: checks at most `maxPages` pages (default 30) at `dpi` (default 100) and attaches at most `maxImages` composites (default 3); remaining changed pages are listed as text. Added/removed pages are reported separately, and a byte-identical rebuild returns "nothing changed".',
        parameters: {
          ...commonProjectParams,
          from: { type: 'number', description: 'First 1-based page to audit (default: 1).' },
          to: { type: 'number', description: 'Last 1-based page to audit (default: the last page).' },
          maxPages: {
            type: 'number',
            description: 'Page budget for this audit, 1-60 (default from auditMaxPages, usually 30).',
          },
          dpi: {
            type: 'number',
            description: 'Render resolution for the comparison, 36-300 (default from auditDpi, usually 100).',
          },
          maxImages: {
            type: 'number',
            description: 'Maximum side-by-side composites to attach, 0-5 (default from auditMaxImages, usually 3).',
          },
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              images: { type: 'json' },
            },
          },
          render: (_args, value) => {
            const blocks = [];
            for (const ref of value?.images ?? []) blocks.push({ type: 'image', attachment: ref });
            blocks.push({ type: 'text', text: value?.text ?? '' });
            return blocks;
          },
        },
        isConcurrencySafe: () => false,
        timeoutMs: 180_000,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          const audit = await service.audit(
            project,
            {
              from: args.from,
              to: args.to,
              maxPages: args.maxPages,
              dpi: args.dpi,
              maxImages: args.maxImages,
            },
            exec.signal,
          );
          if (!audit.ok) return { text: formatAuditFailure(audit), images: [] };
          let text = formatAuditResult(audit);
          const images = [];
          const attachments = ctx.get('attachments');
          if (audit.images.length > 0) {
            if (!attachments || typeof attachments.saveImages !== 'function') {
              text += `\nimage: the attachment service is unavailable; open these files instead:\n${audit.images
                .map((image) => `  ${image.path}`)
                .join('\n')}`;
            } else {
              for (const image of audit.images) {
                try {
                  const bytes = await readFile(image.path);
                  const refs = await attachments.saveImages([
                    {
                      data: new Uint8Array(bytes),
                      mediaType: 'image/png',
                      name: `latex-audit-page-${image.page}.png`,
                    },
                  ]);
                  if (refs?.[0]) images.push(refs[0]);
                  else text += `\nimage: no attachment reference for page ${image.page} (${image.path})`;
                } catch (error) {
                  text += `\nimage: could not attach page ${image.page} (${errorMessage(error)}); path: ${image.path}`;
                }
              }
            }
          }
          return { text, images };
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_look',
        description:
          'Look at the compiled PDF the way a reader does: render one page to a PNG, locate it with SyncTeX, and (by default) diff it against the previous build. Use this when the document compiles but may still look wrong — floating figures, overfull lines, a table that is not booktabs, a rule around the title. Pass `text` to find the page containing a phrase, `point` (PDF points, top-left origin) to map an exact spot, or `page` to look at a specific page. Returns the page image plus the source file:line and the changed region.',
        parameters: {
          ...commonProjectParams,
          page: {
            type: 'number',
            description: '1-based PDF page to render. Ignored when `text` resolves to a different page.',
          },
          text: {
            type: 'string',
            description: 'A phrase to locate in the PDF (at least 4 characters). The tool finds its page and exact box.',
          },
          point: {
            type: 'object',
            properties: {
              x: { type: 'number', description: 'PDF x in points (72 dpi), top-left origin.' },
              y: { type: 'number', description: 'PDF y in points (72 dpi), top-left origin.' },
            },
            description: 'An exact PDF point to map back to the source through SyncTeX.',
          },
          dpi: {
            type: 'number',
            description: 'Render resolution, 36-600 dpi (default from the renderDpi config, usually 120).',
          },
          crop: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              w: { type: 'number' },
              h: { type: 'number' },
            },
            description:
              'Optional region to crop, in normalized page coordinates (0-1). Useful to inspect one figure without sending the whole page.',
          },
          compare: {
            type: 'boolean',
            description: 'Diff this page against the previous build (default: true).',
          },
        },
        output: {
          schema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              pngPath: { type: 'string' },
              image: { type: 'json' },
            },
          },
          render: (_args, value) => {
            const blocks = [];
            if (value?.image) blocks.push({ type: 'image', attachment: value.image });
            blocks.push({ type: 'text', text: value?.text ?? '' });
            return blocks;
          },
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          const look = await service.look(
            project,
            {
              page: args.page,
              text: args.text,
              point: args.point,
              dpi: args.dpi,
              crop: args.crop,
              compare: args.compare,
            },
            exec.signal,
          );
          if (!look.ok) {
            return { text: formatLookFailure(look) };
          }
          let text = formatLookResult(look);
          let image;
          const attachments = ctx.get('attachments');
          if (attachments && typeof attachments.saveImages === 'function') {
            try {
              const bytes = await readFile(look.pngPath);
              const refs = await attachments.saveImages([
                {
                  data: new Uint8Array(bytes),
                  mediaType: 'image/png',
                  name: `latex-page-${look.page}.png`,
                },
              ]);
              image = refs?.[0];
              if (!image) text += '\nimage: the attachment service returned no reference; use pngPath instead.';
            } catch (error) {
              text += `\nimage: could not attach the page PNG (${errorMessage(error)}); open pngPath instead.`;
            }
          } else {
            text += '\nimage: the attachment service is unavailable in this profile; open pngPath instead.';
          }
          return { text, pngPath: look.pngPath, image };
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_annotations',
        description:
          'Work with annotations the user created by selecting text in the PDF preview. `list` shows open/resolved/stale items with page, quote, comment, screenshot/OCR fields; `resolve` marks items done after you fixed the source and rebuilt; `remove` deletes one item (and its screenshot); `clear` removes resolved items (or all with all=true). Annotations are re-anchored by their quote after a rebuild, and marked stale when the quote no longer exists.',
        parameters: {
          ...commonProjectParams,
          action: {
            type: 'string',
            enum: ['list', 'resolve', 'remove', 'clear'],
            description:
              'list reads annotations; resolve completes them; remove deletes one by id; clear removes resolved ones.',
          },
          id: { type: 'string', description: 'One annotation id (from list) to resolve or remove.' },
          ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Several annotation ids to resolve in one call.',
          },
          all: {
            type: 'boolean',
            description: 'With action=clear, remove every annotation including open ones (default: false).',
          },
        },
        output: {
          schema: { type: 'string' },
          render: (_args, value) => [{ type: 'text', text: value }],
        },
        isConcurrencySafe: () => false,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          const action =
            args.action === 'resolve' || args.action === 'remove' || args.action === 'clear'
              ? args.action
              : 'list';
          if (action === 'list') {
            const listed = await service.listAnnotations(project);
            return formatAnnotations(listed);
          }
          if (action === 'resolve') {
            const ids = new Set();
            if (typeof args.id === 'string' && args.id.trim() !== '') ids.add(args.id.trim());
            if (Array.isArray(args.ids)) {
              for (const id of args.ids) if (typeof id === 'string' && id.trim() !== '') ids.add(id.trim());
            }
            if (ids.size === 0) return 'latex_annotations resolve needs `id` or `ids`.';
            const resolved = [];
            const failed = [];
            for (const id of ids) {
              try {
                const item = await service.updateAnnotation(project, { id, status: 'resolved' });
                resolved.push(item);
              } catch (error) {
                failed.push(`${id}: ${errorMessage(error)}`);
              }
            }
            return toolText([
              `LaTeX annotations: resolved ${resolved.length} of ${ids.size}`,
              ...resolved.map((item) => `- ${item.id} (page ${item.page}) ${oneLine(item.quote, 120)}`),
              ...(failed.length > 0 ? ['failed:', ...failed.map((line) => `- ${line}`)] : []),
            ]);
          }
          if (action === 'remove') {
            if (typeof args.id !== 'string' || args.id.trim() === '') {
              return 'latex_annotations remove needs `id`.';
            }
            const result = await service.removeAnnotation(project, args.id.trim());
            return `LaTeX annotations: removed 1, ${result.remaining} remaining.`;
          }
          const result = await service.clearAnnotations(project, { all: args.all === true });
          return `LaTeX annotations: removed ${result.removed}, ${result.remaining} remaining.`;
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_cite_audit',
        description:
          'Audit citation keys across the project .tex files against the .bib entries: list cited-but-missing keys and bib entries that are never cited. Comments and \nocite{*} are handled; use before submission or after adding references.',
        parameters: { ...commonProjectParams },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        isConcurrencySafe: () => true,
        timeoutMs: 60_000,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          return formatCitationAudit(await service.citationAudit(project));
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_bib_lint',
        description:
          'Lint the project .bib files: duplicate citation keys, missing required fields per entry type, and parse errors. Does not rewrite files.',
        parameters: { ...commonProjectParams },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        isConcurrencySafe: () => true,
        timeoutMs: 60_000,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          return formatBibliographyLint(await service.bibliographyLint(project));
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_layout_lint',
        description:
          'Check the last build log/aux for layout problems: overfull/underfull boxes, undefined references/citations, page count, figure/table labels, and configured custom regex rules. Read-only.',
        parameters: { ...commonProjectParams },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        isConcurrencySafe: () => true,
        timeoutMs: 60_000,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          return formatLayoutAudit(await service.layoutCheck(project));
        },
      }),
    ),
  );

  disposers.push(
    tools.register(
      defineTool({
        name: 'latex_bib_fill',
        description:
          'Look up a DOI on Crossref (no API key) and show values that are missing from the matching .bib entry. Dry-run: nothing is written automatically; copy the proposed fields or ask the user first.',
        parameters: {
          ...commonProjectParams,
          doi: { type: 'string', description: 'DOI to look up, e.g. 10.1000/xyz123.' },
          key: { type: 'string', description: 'Optional bib citation key to compare against.' },
        },
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        isConcurrencySafe: () => true,
        timeoutMs: 60_000,
        execute: async (args, exec) => {
          const project = await resolveProject(args, exec);
          return formatCrossrefFill(
            await service.crossrefFill(project, { doi: args.doi, key: args.key }),
          );
        },
      }),
    ),
  );

  return () => {
    for (const dispose of disposers) dispose();
  };
}
