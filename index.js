/**
 * dsh-latex — a native DeepSeek Harness LaTeX workspace.
 *
 * Host half: project detection, latexmk builds, structured diagnostics, source
 * watching, last-good PDF publication and the HTTP surface consumed by the
 * in-app panel and PDF viewer. The browser half lives in ./client.js and is
 * discovered through package.json's `dsh.client` declaration.
 *
 * Design notes live in docs/architecture.md; user configuration keys are in
 * cordis.patch.yml and README.md.
 */
import { LatexBuilder } from './src/build.js';
import { normalizeConfig } from './src/config.js';
import { ProjectResolver } from './src/project.js';
import { registerLatexRoutes } from './src/routes.js';
import { LatexService } from './src/service.js';
import { registerLatexTools } from './src/tools.js';

export const name = 'dsh-latex';
export const version = '0.3.0';

/**
 * Wire one optional Host service once it exists. Cordis may start plugins in
 * any order, and a profile without the Web server (headless) must still load
 * the tool half. Polling `ctx.get` is the dependency-free equivalent of
 * `ctx.inject` used by the installed swarm plugin.
 */
function wireWhenAvailable(ctx, serviceName, wire, timeoutMs = 60_000) {
  const logger = ctx.logger('latex');
  const run = () => {
    try {
      return wire();
    } catch (error) {
      logger.error('latex: wiring %s failed: %s', serviceName, String(error));
      return undefined;
    }
  };
  if (ctx.get(serviceName) !== undefined) {
    const disposer = run();
    return () => {
      if (typeof disposer === 'function') disposer();
    };
  }
  let inner;
  let settled = false;
  const timer = setInterval(() => {
    if (ctx.get(serviceName) === undefined) return;
    clearInterval(timer);
    clearTimeout(timeout);
    inner = run();
    settled = true;
  }, 250);
  timer.unref?.();
  const timeout = setTimeout(() => {
    clearInterval(timer);
    if (!settled) logger.warn('latex: service %s never appeared; that capability is inactive.', serviceName);
  }, timeoutMs);
  timeout.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(timeout);
    if (settled && typeof inner === 'function') inner();
  };
}

/**
 * Cordis plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig the `latex` row's config
 */
export function apply(ctx, rawConfig) {
  const logger = ctx.logger('latex');
  const config = normalizeConfig(rawConfig);
  const resolver = new ProjectResolver(config, logger);
  const builder = new LatexBuilder(ctx, config, logger);
  const service = new LatexService(ctx, config, builder, resolver, logger);

  ctx.effect(() => {
    let disposed = false;
    service.init().catch((error) => {
      if (!disposed) logger.warn('latex: initial toolchain probe failed: %s', String(error));
    });
    return () => {
      disposed = true;
      service.dispose();
    };
  });

  ctx.effect(() => wireWhenAvailable(ctx, 'tools', () => registerLatexTools(ctx, service, config)));
  ctx.effect(() => wireWhenAvailable(ctx, 'webServer', () => registerLatexRoutes(ctx, service, config)));

  // A short, always-available prompt hint: the tools' own descriptions carry
  // the details, this only tells the model the capability exists.
  ctx.effect(() =>
    wireWhenAvailable(ctx, 'systemPrompt', () => {
      const systemPrompt = ctx.get('systemPrompt');
      if (!systemPrompt || typeof systemPrompt.section !== 'function') return () => {};
      return systemPrompt.section({
        name: 'latex-workspace',
        order: 90,
        text: [
          'A native LaTeX workspace is available: latex_compile builds a local TeX Live project with latexmk and returns structured diagnostics with file:line locations;',
          'latex_get_diagnostics re-reads the last build; latex_preview opens/refreshes the in-app PDF preview; latex_clean, latex_cancel, latex_get_status and latex_synctex cover the rest.',
          'Use these instead of running latexmk in a shell when the task involves a .tex project.',
        ].join(' '),
      });
    }),
  );

  logger.info('latex plugin loaded (engine=%s, buildDir=%s)', config.engine, config.buildDir);
}
