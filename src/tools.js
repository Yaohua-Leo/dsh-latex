/**
 * Model-facing LaTeX tools.
 *
 * Every tool resolves exactly one project through the same resolver the UI
 * uses and calls the same service methods the panel's buttons call. Tool
 * results are written for a model first: status, the file that actually failed,
 * and a next action.
 */
import path from 'node:path';
import { defineTool } from './tool.js';

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

function formatResult(result, { includeWarnings = true, maxErrors = 25 } = {}) {
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
  if (result.pdfPath) lines.push(`pdf: ${result.pdfPath}${result.pages ? ` (${result.pages} pages)` : ''}`);
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

  return () => {
    for (const dispose of disposers) dispose();
  };
}
