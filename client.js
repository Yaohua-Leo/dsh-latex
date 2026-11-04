/**
 * dsh-latex — browser half.
 *
 * Registers one `.tex`-claiming resource tab type (an in-app editor), one PDF
 * preview tab type, and compact tool-result cards for the LaTeX tools. Opening
 * any `.tex` file address therefore lands in the editor instead of the
 * read-only document preview; saving the editor writes the source through the
 * Host and rebuilds, and an open PDF preview follows the build stream over
 * Server-Sent Events.
 *
 * Everything here is plain browser JavaScript; React comes from the module
 * table and no other Harness Client package is imported as a module.
 */
window.__ModuleLoader__.load({
  id: 'dsh-latex',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef, useCallback, useMemo } = React;

    const PREVIEW_KIND = 'latex-preview';
    const EDITOR_KIND = 'latex-tex-editor';
    const PREVIEW_ID = 'dsh-latex/preview';
    const EDITOR_ID = 'dsh-latex/editor';
    const NS = 'latex';

    const DICT = {
      zh: {
        'panel.title': 'LaTeX 工作台',
        'panel.description': '编译本机 TeX Live 项目、查看诊断、预览 PDF。',
        'preview.title': 'PDF 预览',
        'preview.description': '在应用内查看 LaTeX 编译出的 PDF，重新编译后自动刷新。',
        'editor.title': 'TeX 编辑',
        'editor.save': '保存并编译',
        'editor.saving': '保存中…',
        'editor.compiling': '编译中…',
        'editor.saved': '已保存',
        'editor.dirty': '未保存',
        'editor.loading': '加载源码…',
        'editor.reload': '重新加载',
        'editor.openPreview': '打开 PDF 预览',
        'editor.buildOk': '编译成功，预览已更新',
        'editor.buildFailed': '编译失败',
        'editor.saveFailed': '保存失败',
        'editor.loadFailed': '无法读取该 TeX 文件',
        'editor.noPath': '无法从文件地址解析出路径',
        'editor.hint': 'Ctrl+S 保存并编译',
        'editor.conflict': '磁盘文件已被外部修改',
        'editor.forceSave': '强制保存',
        'editor.reloadConfirm': '放弃未保存的修改并重新加载？',
        'editor.forceConfirm': '强制保存会覆盖磁盘上的外部修改，继续？',
        'editor.lines': '行',
        'header.title': 'LaTeX 工作台',
        'action.compile': '编译',
        'action.compiling': '编译中…',
        'action.cancel': '取消',
        'action.clean': '清理',
        'action.preview': '预览',
        'action.log': '日志',
        'action.reload': '重新检测',
        'action.openPanel': '工作台',
        'action.openPreview': '打开 PDF 预览',
        'action.documentPreview': '文档预览',
        'action.retry': '重试',
        'state.idle': '尚未编译',
        'state.queued': '排队中',
        'state.running': '编译中',
        'state.success': '成功',
        'state.failure': '失败',
        'state.cancelled': '已取消',
        'state.timeout': '超时',
        'state.building': '编译中',
        'state.watching': '监听源码中',
        'state.stale': '当前预览为上一次成功编译的 PDF',
        'state.staleShort': '预览较旧',
        'state.noProject': '尚未检测到 LaTeX 项目',
        'state.noProjectHint': '在会话中打开或创建一个 .tex 文件后点击重新检测；也可以让 AI 直接调用 latex_compile。',
        'state.noPdf': '还没有成功编译的 PDF',
        'state.noPdfHint': '点击编译生成预览；首次编译会解析主文件、参考文献和交叉引用。',
        'state.loadingPdf': '正在加载 PDF…',
        'state.loading': '加载中…',
        'state.autoBuild': '自动编译',
        'state.toolchainMissing': 'TeX Live 工具缺失',
        'errors.title': '错误',
        'warnings.title': '警告',
        'errors.none': '没有错误',
        'warnings.none': '没有警告',
        'build.last': '上次编译',
        'build.pages': '页',
        'build.duration': '耗时',
        'build.exit': '退出码',
        'build.forward': '源码行',
        'build.forwardGo': '定位到 PDF',
        'build.log': '日志',
        'build.main': '主文件',
        'build.engine': '引擎',
        'build.buildDir': '构建目录',
        'build.previewVersion': '预览版本',
        'build.staleNote': '最新一次编译失败，预览保留上一次成功的结果。',
        'preview.page': '页',
        'preview.zoom': '缩放',
        'preview.fit': '适合宽度',
        'preview.prev': '上一页',
        'preview.next': '下一页',
        'preview.goPage': '跳转到指定页',
        'preview.syncHint': '双击页面可跳转到对应源码行',
        'preview.syncing': 'SyncTeX 定位中…',
        'preview.synced': '已定位到源码',
        'preview.syncFailed': 'SyncTeX 定位失败',
        'tool.compile': 'LaTeX 编译',
        'tool.preview': 'LaTeX 预览',
        'tool.diagnostics': 'LaTeX 诊断',
        'tool.status': 'LaTeX 状态',
        'tool.clean': 'LaTeX 清理',
        'tool.cancel': 'LaTeX 取消',
        'tool.synctex': 'SyncTeX',
        'tool.running': '执行中',
        'tool.ok': '完成',
        'tool.failed': '失败',
        'conn.live': '实时更新',
        'conn.connecting': '连接中',
        'conn.error': '连接中断，正在重试',
        'empty.project': '没有可用的 LaTeX 项目',
        'settings.hint': '自动编译会监听 .tex/.bib/.sty/图片等源码，保存后防抖合并一次构建。',
      },
      en: {
        'panel.title': 'LaTeX Workbench',
        'panel.description': 'Compile a local TeX Live project, inspect diagnostics, and preview its PDF.',
        'preview.title': 'PDF Preview',
        'preview.description': 'View the compiled PDF inside the app; rebuilds refresh it in place.',
        'editor.title': 'TeX Editor',
        'editor.save': 'Save & compile',
        'editor.saving': 'Saving…',
        'editor.compiling': 'Compiling…',
        'editor.saved': 'Saved',
        'editor.dirty': 'Unsaved',
        'editor.loading': 'Loading source…',
        'editor.reload': 'Reload',
        'editor.openPreview': 'Open PDF preview',
        'editor.buildOk': 'Compiled; preview updated',
        'editor.buildFailed': 'Compilation failed',
        'editor.saveFailed': 'Save failed',
        'editor.loadFailed': 'Could not read this TeX file',
        'editor.noPath': 'Could not resolve a path from the file address',
        'editor.hint': 'Ctrl+S saves and compiles',
        'editor.conflict': 'The file changed on disk',
        'editor.forceSave': 'Force save',
        'editor.reloadConfirm': 'Discard unsaved changes and reload?',
        'editor.forceConfirm': 'Force save will overwrite the external change. Continue?',
        'editor.lines': 'lines',
        'header.title': 'LaTeX Workbench',
        'action.compile': 'Compile',
        'action.compiling': 'Compiling…',
        'action.cancel': 'Cancel',
        'action.clean': 'Clean',
        'action.preview': 'Preview',
        'action.log': 'Log',
        'action.reload': 'Refresh',
        'action.openPanel': 'Workbench',
        'action.openPreview': 'Open PDF preview',
        'action.documentPreview': 'Document preview',
        'action.retry': 'Retry',
        'state.idle': 'Not built',
        'state.queued': 'Queued',
        'state.running': 'Compiling',
        'state.success': 'Success',
        'state.failure': 'Failed',
        'state.cancelled': 'Cancelled',
        'state.timeout': 'Timed out',
        'state.building': 'Compiling',
        'state.watching': 'Watching sources',
        'state.stale': 'Showing the previous successful PDF',
        'state.staleShort': 'Preview is stale',
        'state.noProject': 'No LaTeX project detected yet',
        'state.noProjectHint': 'Open or create a .tex file, then refresh; or ask the AI to call latex_compile.',
        'state.noPdf': 'No successful PDF yet',
        'state.noPdfHint': 'Compile to create a preview. The first build resolves the main file, bibliography and references.',
        'state.loadingPdf': 'Loading PDF…',
        'state.loading': 'Loading…',
        'state.autoBuild': 'Auto build',
        'state.toolchainMissing': 'Missing TeX Live tools',
        'errors.title': 'Errors',
        'warnings.title': 'Warnings',
        'errors.none': 'No errors',
        'warnings.none': 'No warnings',
        'build.last': 'Last build',
        'build.pages': 'page(s)',
        'build.duration': 'Duration',
        'build.exit': 'Exit',
        'build.forward': 'Source line',
        'build.forwardGo': 'Locate in PDF',
        'build.log': 'Log',
        'build.main': 'Main file',
        'build.engine': 'Engine',
        'build.buildDir': 'Build dir',
        'build.previewVersion': 'Preview version',
        'build.staleNote': 'The latest build failed; the preview keeps the previous successful PDF.',
        'preview.page': 'Page',
        'preview.zoom': 'Zoom',
        'preview.fit': 'Fit width',
        'preview.prev': 'Previous page',
        'preview.next': 'Next page',
        'preview.goPage': 'Go to page',
        'preview.syncHint': 'Double-click a page to reveal the corresponding source line',
        'preview.syncing': 'SyncTeX lookup…',
        'preview.synced': 'Revealed source line',
        'preview.syncFailed': 'SyncTeX lookup failed',
        'tool.compile': 'LaTeX build',
        'tool.preview': 'LaTeX preview',
        'tool.diagnostics': 'LaTeX diagnostics',
        'tool.status': 'LaTeX status',
        'tool.clean': 'LaTeX clean',
        'tool.cancel': 'LaTeX cancel',
        'tool.synctex': 'SyncTeX',
        'tool.running': 'Running',
        'tool.ok': 'Done',
        'tool.failed': 'Failed',
        'conn.live': 'Live',
        'conn.connecting': 'Connecting',
        'conn.error': 'Connection lost, retrying',
        'empty.project': 'No LaTeX project available',
        'settings.hint': 'Auto build watches .tex/.bib/.sty/image sources and coalesces saves into one debounced build.',
      },
    };

    /* ------------------------------------------------------------------ */
    /* Runtime handle and shared state                                     */
    /* ------------------------------------------------------------------ */

    const runtime = { ctx: undefined, previewProjects: new Set() };

    function createStore() {
      let snapshot = { projects: [], connection: 'connecting' };
      const listeners = new Set();
      return {
        get() {
          return snapshot;
        },
        set(next) {
          snapshot = {
            ...next,
            // `/latex/state` is the only producer that computes this field;
            // keep it across SSE/action snapshots.
            activeProjectId: next?.activeProjectId ?? snapshot?.activeProjectId,
          };
          for (const listener of listeners) {
            try {
              listener(snapshot);
            } catch {
              // A broken subscriber must not take the plugin down.
            }
          }
        },
        merge(patch) {
          this.set({ ...snapshot, ...patch });
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    }

    const store = createStore();
    let eventsStarted = false;
    let lastPreviewHandled = 0;
    const viewStates = new Map();

    function ctxService(name) {
      try {
        return runtime.ctx?.get?.(name);
      } catch {
        return undefined;
      }
    }

    function tr(key) {
      const factory = runtime.t;
      const value = typeof factory === 'function' ? factory(key) : undefined;
      return typeof value === 'string' && value !== '' && value !== key ? value : key;
    }

    function startEvents() {
      if (eventsStarted || typeof window === 'undefined' || typeof window.EventSource !== 'function') {
        return () => {};
      }
      eventsStarted = true;
      let source;
      let closed = false;
      const connect = () => {
        if (closed) return;
        try {
          source = new window.EventSource('/latex/events');
        } catch {
          store.merge({ connection: 'error' });
          return;
        }
        source.addEventListener('state', (event) => {
          try {
            const parsed = JSON.parse(event.data);
            store.set({ ...parsed, connection: 'live' });
          } catch {
            // Malformed frame: wait for the next one.
          }
        });
        source.onopen = () => store.merge({ connection: 'live' });
        source.onerror = () => store.merge({ connection: 'connecting' });
      };
      connect();
      return () => {
        closed = true;
        eventsStarted = false;
        try {
          source?.close();
        } catch {
          // Already closed.
        }
      };
    }

    async function fetchState({ sessionId, cwd } = {}) {
      const query = new URLSearchParams();
      if (sessionId) query.set('session', String(sessionId));
      if (cwd) query.set('cwd', String(cwd));
      const response = await fetch(`/latex/state${query.toString() ? `?${query}` : ''}`, {
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      store.set({ ...payload, connection: 'live' });
      return payload;
    }

    async function postAction(payload) {
      const response = await fetch('/latex/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
      if (data.snapshot) store.set({ ...data.snapshot, connection: store.get().connection });
      return data;
    }

    function useSnapshot() {
      const [snapshot, setSnapshot] = useState(store.get());
      useEffect(() => store.subscribe(setSnapshot), []);
      return snapshot;
    }

    function useTabNavigation(useTabInfo) {
      const info = useTabInfo();
      return {
        info,
        params: info?.tab?.navigation?.params ?? {},
        revision: info?.tab?.navigation?.revision ?? 0,
      };
    }

    function pickProject(snapshot, { sessionId, cwd, projectId }) {
      const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
      if (projects.length === 0) return undefined;
      if (projectId) {
        const exact = projects.find((project) => project.id === projectId);
        if (exact) return exact;
      }
      if (snapshot.activeProjectId) {
        const active = projects.find((project) => project.id === snapshot.activeProjectId);
        if (active) {
          const bySession = projects.filter((project) =>
            (project.sessionIds ?? []).includes(String(sessionId)),
          );
          if (!sessionId || bySession.length === 0 || bySession.includes(active)) return active;
        }
      }
      if (sessionId) {
        const bySession = projects
          .filter((project) => (project.sessionIds ?? []).includes(String(sessionId)))
          .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
        if (bySession.length > 0) return bySession[0];
      }
      if (cwd) {
        const normalized = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
        const inside = projects
          .filter((project) => {
            const root = String(project.rootDir ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
            return root !== '' && (normalized === root || normalized.startsWith(`${root}/`));
          })
          .sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0));
        if (inside.length > 0) return inside[0];
      }
      if (runtime.lastPreviewProjectId) {
        const last = projects.find((project) => project.id === runtime.lastPreviewProjectId);
        if (last) return last;
      }
      return projects.slice().sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0))[0];
    }

    function sessionFileAddress(sessionId, cwd, absolutePath) {
      const normalize = (value) => String(value ?? '').replace(/\\/g, '/');
      const normalized = normalize(absolutePath);
      const root = normalize(cwd).replace(/\/+$/, '');
      let relative = normalized;
      if (root !== '' && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
        relative = normalized.slice(root.length + 1);
      }
      const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':');
      const encoded = relative
        .replace(/^(?:\.\/)+/, '')
        .split('/')
        .map(encodeSegment)
        .join('/');
      return `dsh-resource://file/session/${encodeSegment(String(sessionId))}/${encoded}`;
    }

    function openTab(kind, params, options = {}) {
      let sidebar;
      try {
        sidebar = runtime.ctx?.sidebarRight;
      } catch {
        sidebar = undefined;
      }
      if (!sidebar) sidebar = ctxService('sidebarRight');
      if (!sidebar || typeof sidebar.openTab !== 'function') return false;
      try {
        sidebar.openTab(kind, { ...options, params });
        return true;
      } catch (error) {
        console.warn('[dsh-latex] openTab failed:', error);
        return false;
      }
    }

    function openResource(address, options) {
      let sidebar;
      try {
        sidebar = runtime.ctx?.sidebarRight;
      } catch {
        sidebar = undefined;
      }
      if (!sidebar) sidebar = ctxService('sidebarRight');
      if (!sidebar || typeof sidebar.openResource !== 'function') return false;
      try {
        sidebar.openResource(address, options);
        return true;
      } catch (error) {
        console.warn('[dsh-latex] openResource failed:', error);
        return false;
      }
    }

    function openPreview(project, snapshot, { sessionId, cwd, page, surface, preferNewPane, revealIfOpened } = {}) {
      if (!project || !project.previewVersion) return false;
      runtime.lastPreviewProjectId = project.id;
      runtime.previewProjects.add(project.id);
      const chosen = surface ?? snapshot?.config?.previewSurface ?? 'native';
      if (chosen === 'document') {
        return openResource(sessionFileAddress(sessionId, cwd, project.previewPath));
      }
      return openTab(
        PREVIEW_KIND,
        { project: project.id, ...(page ? { page } : {}) },
        {
          ...(preferNewPane ? { preferNewPane: true } : {}),
          ...(revealIfOpened === false ? { revealIfOpened: false } : {}),
        },
      );
    }

    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/';

    /** Parse the same file-address grammar the built-in document preview uses. */
    function parseFileAddress(address) {
      try {
        if (typeof address !== 'string' || !address.startsWith(FILE_ADDRESS_PREFIX)) return undefined;
        const end = address.search(/[?#]/);
        const rest = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end);
        const segments = rest.split('/');
        const scope = segments.shift();
        if (scope === 'session') {
          const sessionId = segments.shift();
          if (!sessionId || segments.length === 0) return undefined;
          return {
            scope,
            sessionId: decodeURIComponent(sessionId),
            path: segments.map(decodeURIComponent).join('/'),
          };
        }
        if (scope === 'absolute') {
          const unc = segments[0] === '' && segments.length > 1;
          const parts = (unc ? segments.slice(1) : segments).map(decodeURIComponent);
          if (parts.length === 0 || parts[0] === '') return undefined;
          if (unc) return { scope, path: `//${parts.join('/')}` };
          return { scope, path: /^[A-Za-z]:$/.test(parts[0]) ? parts.join('/') : `/${parts.join('/')}` };
        }
        return undefined;
      } catch {
        return undefined;
      }
    }

    function basenameOfAddress(address) {
      const text = String(address ?? '');
      const name = text.slice(text.lastIndexOf('/') + 1);
      if (name === '') return text;
      try {
        return decodeURIComponent(name);
      } catch {
        return name;
      }
    }

    function isTexAddress(address) {
      const parsed = parseFileAddress(address);
      return Boolean(parsed && /\.tex$/i.test(parsed.path));
    }

    function resolveAddressPath(parsed, cwd) {
      if (!parsed) return '';
      if (parsed.scope === 'absolute') return parsed.path;
      const value = String(parsed.path ?? '').replace(/\\/g, '/');
      if (/^[A-Za-z]:\//.test(value) || value.startsWith('//')) return value;
      if (!cwd) return '';
      const root = String(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
      return `${root}/${value.replace(/^(?:\.\/)+/, '')}`;
    }

    function humanDuration(ms) {
      if (!Number.isFinite(ms) || ms < 0) return '--';
      if (ms < 1000) return `${Math.round(ms)} ms`;
      if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
      const minutes = Math.floor(ms / 60_000);
      return `${minutes} min ${Math.round((ms % 60_000) / 1000)} s`;
    }

    function clockOf(timestamp) {
      if (!Number.isFinite(timestamp)) return '';
      const date = new Date(timestamp);
      const pad = (value) => String(value).padStart(2, '0');
      return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    }

    function statusWord(project) {
      if (!project) return 'idle';
      if (project.building) return 'running';
      if (project.queued > 0) return 'queued';
      return project.lastBuild?.status ?? (project.previewVersion ? 'success' : 'idle');
    }

    function statusLabel(project) {
      const word = statusWord(project);
      return tr(`state.${word}`);
    }

    function statusTone(project) {
      const word = statusWord(project);
      if (word === 'success') return 'ok';
      if (word === 'failure' || word === 'timeout') return 'bad';
      if (word === 'running' || word === 'queued') return 'busy';
      return 'idle';
    }

    function projectRootKey(project) {
      return project?.id ?? 'none';
    }

    /* ------------------------------------------------------------------ */
    /* Icons                                                               */
    /* ------------------------------------------------------------------ */

    function svg(children, props) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: 16,
          height: 16,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.7,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          ...props,
        },
        children,
      );
    }

    function IconLatex(props) {
      return svg(
        [
          h('path', { key: 'doc', d: 'M6 3h8l4 4v14H6z' }),
          h('path', { key: 'fold', d: 'M14 3v4h4' }),
          h('path', { key: 'sigma', d: 'M9 11h6M9 11l3 3-3 3h6' }),
        ],
        props,
      );
    }

    function IconPlay(props) {
      return svg([h('path', { key: 'p', d: 'M7 4l12 8-12 8z' })], props);
    }

    function IconStop(props) {
      return svg([h('rect', { key: 'r', x: 6, y: 6, width: 12, height: 12, rx: 2 })], props);
    }

    function IconBroom(props) {
      return svg(
        [
          h('path', { key: 'handle', d: 'M14 3l7 7-3 3-7-7z' }),
          h('path', { key: 'brush', d: 'M10 9l-6 6v5h5l6-6' }),
        ],
        props,
      );
    }

    function IconEye(props) {
      return svg(
        [
          h('path', { key: 'eye', d: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z' }),
          h('circle', { key: 'pupil', cx: 12, cy: 12, r: 2.6 }),
        ],
        props,
      );
    }

    function IconRefresh(props) {
      return svg(
        [
          h('path', { key: 'a', d: 'M20 11a8 8 0 1 0-2.3 5.7' }),
          h('path', { key: 'b', d: 'M20 4v7h-7' }),
        ],
        props,
      );
    }

    function IconChevron(props) {
      return svg([h('path', { key: 'c', d: 'M9 6l6 6-6 6' })], props);
    }

    function IconAlert(props) {
      return svg(
        [
          h('path', { key: 'tri', d: 'M12 3l9 17H3z' }),
          h('path', { key: 'bar', d: 'M12 9v5' }),
          h('circle', { key: 'dot', cx: 12, cy: 17, r: 0.9, fill: 'currentColor', stroke: 'none' }),
        ],
        props,
      );
    }

    function IconCheck(props) {
      return svg([h('path', { key: 'c', d: 'M4 12.5l5 5L20 6.5' })], props);
    }

    function IconSpinner(props) {
      return h(
        'span',
        { className: 'dl-spinner', 'aria-hidden': true, ...props },
        h('span', { className: 'dl-spinner-dot' }),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Styling                                                             */
    /* ------------------------------------------------------------------ */

    const CSS = `
.dl-panel { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); font-size:12.5px; }
.dl-head { display:flex; align-items:center; gap:8px; padding:10px 12px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:0 0 auto; }
.dl-title { display:flex; align-items:center; gap:6px; font-weight:600; font-size:13px; min-width:0; }
.dl-title svg { color:var(--dsw-alias-brand-primary); flex:0 0 auto; }
.dl-head-spacer { flex:1 1 auto; }
.dl-conn { width:7px; height:7px; border-radius:50%; background:var(--dsw-alias-state-idle-primary); flex:0 0 auto; }
.dl-conn.live { background:var(--dsw-alias-state-success-primary); }
.dl-conn.connect { background:var(--dsw-alias-state-warn-primary); }
.dl-body { flex:1 1 auto; min-height:0; overflow:auto; padding:10px 12px 16px; display:flex; flex-direction:column; gap:10px; }
.dl-select { max-width:170px; min-width:0; font:inherit; color:inherit; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:3px 6px; }
.dl-project-main { font-weight:600; word-break:break-all; }
.dl-meta { color:var(--dsw-alias-label-secondary); font-size:11.5px; line-height:1.5; word-break:break-all; }
.dl-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dl-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dl-btn { display:inline-flex; align-items:center; gap:5px; font:inherit; font-size:12px; line-height:1; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:6px; padding:6px 9px; cursor:pointer; }
.dl-btn:hover { border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-2); }
.dl-btn:disabled { opacity:.5; cursor:default; }
.dl-btn.primary { background:var(--dsw-alias-brand-primary); border-color:transparent; color:#fff; }
.dl-btn.primary:hover { filter:brightness(1.05); }
.dl-btn.danger { color:var(--dsw-alias-state-error-primary); }
.dl-btn.ghost { background:transparent; border-color:transparent; padding:4px 6px; }
.dl-btn.ghost:hover { background:var(--dsw-alias-bg-layer-1); }
.dl-toggle { display:inline-flex; align-items:center; gap:5px; color:var(--dsw-alias-label-secondary); font-size:11.5px; cursor:pointer; user-select:none; }
.dl-card { border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); padding:9px 10px; display:flex; flex-direction:column; gap:6px; }
.dl-card-head { display:flex; align-items:center; gap:6px; }
.dl-pill { display:inline-flex; align-items:center; gap:4px; border-radius:999px; padding:2px 8px; font-size:11px; line-height:1.5; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.dl-pill.ok { color:var(--dsw-alias-state-success-primary); background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 12%, transparent); }
.dl-pill.bad { color:var(--dsw-alias-state-error-primary); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.dl-pill.busy { color:var(--dsw-alias-state-warn-primary); background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.dl-grid { display:grid; grid-template-columns:auto 1fr; gap:2px 10px; font-size:11.5px; }
.dl-grid > span:nth-child(odd) { color:var(--dsw-alias-label-secondary); }
.dl-grid > span:nth-child(even) { word-break:break-all; }
.dl-warn { display:flex; gap:6px; align-items:flex-start; color:var(--dsw-alias-state-warn-primary); font-size:11.5px; line-height:1.5; }
.dl-error { color:var(--dsw-alias-state-error-primary); font-size:11.5px; line-height:1.5; word-break:break-word; }
.dl-section { display:flex; flex-direction:column; gap:4px; }
.dl-section-title { display:flex; align-items:center; gap:6px; font-size:11.5px; font-weight:600; color:var(--dsw-alias-label-secondary); text-transform:none; }
.dl-diag-list { display:flex; flex-direction:column; gap:1px; margin:0; padding:0; list-style:none; }
.dl-diag { display:flex; gap:6px; align-items:flex-start; padding:4px 6px; border-radius:5px; cursor:pointer; font-size:11.5px; line-height:1.45; }
.dl-diag:hover { background:var(--dsw-alias-bg-layer-2); }
.dl-diag.static { cursor:default; }
.dl-diag-loc { color:var(--dsw-alias-label-secondary); flex:0 0 auto; font-family:var(--dsw-font-mono, ui-monospace, monospace); font-size:11px; }
.dl-diag-msg { min-width:0; word-break:break-word; }
.dl-diag.err .dl-diag-loc { color:var(--dsw-alias-state-error-primary); }
.dl-diag.warn .dl-diag-loc { color:var(--dsw-alias-state-warn-primary); }
.dl-log { max-height:260px; overflow:auto; margin:0; padding:8px; border-radius:6px; background:var(--dsw-alias-bg-base); border:1px solid var(--dsw-alias-border-l1); font-family:var(--dsw-font-mono, ui-monospace, monospace); font-size:10.5px; line-height:1.45; white-space:pre-wrap; word-break:break-all; }
.dl-empty { display:flex; flex-direction:column; align-items:center; text-align:center; gap:8px; padding:28px 12px; color:var(--dsw-alias-label-secondary); }
.dl-empty-title { color:var(--dsw-alias-label-primary); font-weight:600; font-size:13px; }
.dl-empty-hint { font-size:11.5px; line-height:1.6; max-width:280px; }
.dl-spinner { display:inline-block; width:12px; height:12px; border-radius:50%; border:2px solid color-mix(in srgb, currentColor 25%, transparent); border-top-color:currentColor; animation:dl-spin .8s linear infinite; vertical-align:-2px; }
@keyframes dl-spin { to { transform:rotate(360deg); } }
.dl-hint { color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.5; }
.dl-flex1 { flex:1 1 auto; min-width:0; }
.dl-kbd { font-family:var(--dsw-font-mono, ui-monospace, monospace); font-size:10.5px; border:1px solid var(--dsw-alias-border-l1); border-radius:4px; padding:0 3px; color:var(--dsw-alias-label-secondary); }
.dl-hbtn { display:inline-flex; align-items:center; gap:5px; height:26px; padding:0 8px; border-radius:6px; border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary); font:inherit; font-size:12px; cursor:pointer; }
.dl-hbtn:hover { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }
.dl-hbtn svg { color:var(--dsw-alias-brand-primary); }
.dl-tool { display:flex; flex-direction:column; gap:7px; padding:9px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }
.dl-tool-head { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
.dl-tool-title { font-weight:600; font-size:12px; }
.dl-tool-pre { margin:0; max-height:210px; overflow:auto; font-family:var(--dsw-font-mono, ui-monospace, monospace); font-size:10.5px; line-height:1.5; white-space:pre-wrap; word-break:break-word; color:var(--dsw-alias-label-secondary); }
.dl-tool-actions { display:flex; gap:6px; flex-wrap:wrap; }
.dl-preview { display:flex; flex-direction:column; height:100%; min-height:0; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.dl-preview-bar { display:flex; align-items:center; gap:5px; flex-wrap:wrap; padding:6px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:0 0 auto; background:var(--dsw-alias-bg-base); }
.dl-preview-scroll { position:relative; flex:1 1 auto; min-height:0; overflow:auto; padding:12px 8px 24px; background:var(--dsw-alias-bg-layer-2); }
.dl-page { position:relative; margin:0 auto 12px; background:#fff; box-shadow:0 1px 5px rgba(0,0,0,.28); overflow:hidden; border-radius:1px; }
.dl-page canvas { display:block; width:100%; height:100%; }
.dl-page-ph { display:flex; align-items:center; justify-content:center; color:#9aa0a6; font-size:11px; background:#fbfbfb; }
.dl-page-no { position:absolute; right:4px; bottom:4px; font-size:9px; color:#b9bcc2; pointer-events:none; }
.dl-page-input { width:46px; font:inherit; font-size:11.5px; text-align:center; color:inherit; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:5px; padding:3px 2px; }
.dl-zoom-select { font:inherit; font-size:11.5px; color:inherit; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); border-radius:5px; padding:3px 4px; }
.dl-banner { display:flex; align-items:center; gap:6px; padding:5px 9px; font-size:11.5px; line-height:1.4; border-bottom:1px solid var(--dsw-alias-border-l1); }
.dl-banner.warn { color:var(--dsw-alias-state-warn-primary); background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 9%, transparent); }
.dl-banner.info { color:var(--dsw-alias-label-secondary); background:var(--dsw-alias-bg-layer-1); }
.dl-iconbtn { display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border-radius:6px; border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary); cursor:pointer; padding:0; }
.dl-iconbtn:hover { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }
.dl-iconbtn:disabled { opacity:.4; cursor:default; }
.dl-center { flex:1 1 auto; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:10px; padding:24px; text-align:center; color:var(--dsw-alias-label-secondary); }
.dl-toast { position:absolute; left:50%; bottom:14px; transform:translateX(-50%); padding:5px 10px; border-radius:6px; font-size:11px; background:var(--dsw-alias-bg-overlay); color:var(--dsw-alias-label-primary); box-shadow:0 2px 10px rgba(0,0,0,.25); z-index:5; }
.dl-editor { display:flex; flex-direction:column; height:100%; min-height:0; color:var(--dsw-alias-label-primary); background:var(--dsw-alias-bg-base); font-size:12.5px; }
.dl-editor-bar { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:6px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:0 0 auto; }
.dl-editor-path { min-width:0; max-width:100%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:600; font-size:12px; }
.dl-editor-dirty { color:var(--dsw-alias-state-warn-primary); font-size:11px; }
.dl-editor-status { color:var(--dsw-alias-label-secondary); font-size:11px; white-space:nowrap; }
.dl-editor-status.ok { color:var(--dsw-alias-state-success-primary); }
.dl-editor-status.bad { color:var(--dsw-alias-state-error-primary); }
.dl-editor-body { flex:1 1 auto; min-height:0; display:flex; overflow:hidden; background:var(--dsw-alias-bg-base); }
.dl-editor-gutter { flex:0 0 auto; overflow:hidden; margin:0; padding:8px 6px 8px 8px; text-align:right; color:var(--dsw-alias-label-secondary); opacity:.65; font-family:var(--dsw-font-mono, ui-monospace, monospace); font-size:11px; line-height:1.55; white-space:pre; user-select:none; background:var(--dsw-alias-bg-base); }
.dl-editor-text { flex:1 1 auto; min-width:0; margin:0; padding:8px 10px 24px; border:0; outline:none; resize:none; overflow:auto; tab-size:2; white-space:pre; color:var(--dsw-alias-label-primary); background:transparent; font-family:var(--dsw-font-mono, ui-monospace, monospace); font-size:12px; line-height:1.55; caret-color:var(--dsw-alias-brand-primary); }
.dl-editor-error { flex:0 0 auto; padding:5px 9px; border-top:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-state-error-primary); background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 8%, transparent); font-size:11px; line-height:1.45; word-break:break-word; }
.dl-editor-conflict { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:6px 9px; border-top:1px solid var(--dsw-alias-border-l1); background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 10%, transparent); color:var(--dsw-alias-state-warn-primary); font-size:11px; }
.dl-editor-empty { flex:1 1 auto; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; padding:24px; text-align:center; color:var(--dsw-alias-label-secondary); }
.dl-editor-save { display:inline-flex; align-items:center; justify-content:center; width:28px; height:26px; border-radius:6px; border:1px solid transparent; background:var(--dsw-alias-brand-primary); color:#fff; cursor:pointer; padding:0; }
.dl-editor-save:hover { filter:brightness(1.06); }
.dl-editor-save:disabled { opacity:.5; cursor:default; filter:none; }
`;

    /* ------------------------------------------------------------------ */
    /* Shared UI fragments                                                 */
    /* ------------------------------------------------------------------ */

    /* ------------------------------------------------------------------ */
    /* PDF preview tab                                                     */
    /* ------------------------------------------------------------------ */

    let pdfjsPromise;
    function loadPdfjs() {
      if (!pdfjsPromise) {
        pdfjsPromise = import('/latex/assets/pdf.min.mjs')
          .then((mod) => {
            const pdfjs = mod?.default ?? mod;
            if (pdfjs?.GlobalWorkerOptions) {
              pdfjs.GlobalWorkerOptions.workerSrc = '/latex/assets/pdf.worker.min.mjs';
            }
            return pdfjs;
          })
          .catch((error) => {
            // Do not cache a failed chunk load for the life of the page: a
            // transient 401/404 or a Host restart must be retryable.
            pdfjsPromise = undefined;
            throw error;
          });
      }
      return pdfjsPromise;
    }

    function savedView(projectId) {
      if (!projectId) return {};
      return viewStates.get(projectId) ?? {};
    }

    function LatexPreview(props) {
      const { sessionId, useSessions, useTabInfo, t: seatT } = props;
      const t = seatT ?? tr;
      const cwd = useSessions((sessions) => sessions?.byId?.[sessionId]?.cwd);
      const { params, revision } = useTabNavigation(useTabInfo);
      const snapshot = useSnapshot();
      const project = pickProject(snapshot, { sessionId, cwd, projectId: params?.project });
      const projectId = project?.id;
      const version = project?.previewVersion ?? 0;

      const initialView = savedView(projectId);
      const [zoomMode, setZoomMode] = useState(initialView.zoomMode ?? 'fit');
      const [zoomPercent, setZoomPercent] = useState(initialView.zoomPercent ?? 100);
      const [docInfo, setDocInfo] = useState({ status: 'idle', numPages: 0, error: '' });
      const [page, setPage] = useState(initialView.page ?? 1);
      const [containerWidth, setContainerWidth] = useState(0);
      const [baseSize, setBaseSize] = useState({ width: 595, height: 842 });
      const [reloadToken, setReloadToken] = useState(0);
      const [toast, setToast] = useState('');
      const [syncNote, setSyncNote] = useState('');
      const docRef = useRef(null);
      const loadingRef = useRef(null);
      const containerRef = useRef(null);
      const pagesRef = useRef({});
      const pageElsRef = useRef({});
      const observerRef = useRef(null);
      const pendingRestoreRef = useRef(params?.page ?? initialView.page ?? 1);
      const toastTimerRef = useRef(undefined);
      const lastRenderedScaleRef = useRef(0);

      const scale = useMemo(() => {
        if (zoomMode === 'fit') {
          const available = containerWidth > 0 ? containerWidth - 26 : 0;
          if (available <= 0) return 1;
          return Math.max(0.1, available / baseSize.width);
        }
        return Math.max(0.1, Number(zoomPercent) / 100);
      }, [zoomMode, zoomPercent, containerWidth, baseSize.width]);

      useEffect(() => {
        if (projectId) {
          const previous = savedView(projectId);
          if (previous.page && !params?.page) setPage((current) => (current === 1 ? previous.page : current));
        }
      }, [projectId]);

      // Container width drives "fit width".
      useEffect(() => {
        const element = containerRef.current;
        if (!element) return () => {};
        const measure = () => setContainerWidth(element.clientWidth - 16);
        measure();
        let observer;
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure);
          observer.observe(element);
        }
        return () => {
          observer?.disconnect();
        };
      }, [docInfo.status]);

      // Load the PDF whenever the published version changes.
      useEffect(() => {
        let cancelled = false;
        if (!projectId || !version) {
          setDocInfo({ status: version ? 'loading' : 'empty', numPages: 0, error: '' });
          return () => {};
        }
        const requestedPage = Number(params?.page);
        pendingRestoreRef.current =
          Number.isFinite(requestedPage) && requestedPage >= 1
            ? requestedPage
            : (savedView(projectId).page ?? pendingRestoreRef.current ?? 1);
        setDocInfo({ status: 'loading', numPages: 0, error: '' });
        (async () => {
          try {
            const pdfjs = await loadPdfjs();
            if (!pdfjs?.getDocument) throw new Error('PDF.js failed to load');
            const response = await fetch(
              `/latex/pdf?project=${encodeURIComponent(projectId)}&v=${version}&r=${reloadToken}`,
              { cache: 'no-store' },
            );
            if (!response.ok) {
              const payload = await response.json().catch(() => ({}));
              throw new Error(payload?.error || `HTTP ${response.status}`);
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (cancelled) return;
            const task = pdfjs.getDocument({ data: bytes, isEvalSupported: false });
            loadingRef.current = task;
            const doc = await task.promise;
            if (cancelled) {
              doc.destroy().catch(() => {});
              return;
            }
            const first = await doc.getPage(1);
            const viewport = first.getViewport({ scale: 1 });
            if (cancelled) return;
            docRef.current = doc;
            setBaseSize({ width: viewport.width, height: viewport.height });
            setDocInfo({ status: 'ready', numPages: doc.numPages, error: '' });
            const restore = pendingRestoreRef.current ?? savedView(projectId).page ?? 1;
            setPage(Math.min(Math.max(1, restore), doc.numPages || 1));
            pendingRestoreRef.current = undefined;
          } catch (failure) {
            if (cancelled) return;
            setDocInfo({ status: 'error', numPages: 0, error: String(failure?.message ?? failure) });
          }
        })();
        return () => {
          cancelled = true;
          const doc = docRef.current;
          docRef.current = null;
          pagesRef.current = {};
          pageElsRef.current = {};
          try {
            doc?.destroy?.();
          } catch {
            // Already destroyed.
          }
          try {
            loadingRef.current?.destroy?.();
          } catch {
            // Already destroyed.
          }
          loadingRef.current = null;
        };
      }, [projectId, version, reloadToken]);

      // Scroll the restored page into view once placeholders exist.
      useEffect(() => {
        if (docInfo.status !== 'ready') return;
        const target = Math.min(Math.max(1, page), Math.max(1, docInfo.numPages));
        const element = pageElsRef.current[target];
        if (element && containerRef.current) {
          const container = containerRef.current;
          container.scrollTop = Math.max(0, element.offsetTop - 8);
        }
      }, [docInfo.status, docInfo.numPages, scale]);

      const renderPage = useCallback(
        (pageNumber) => {
          const doc = docRef.current;
          const record = pagesRef.current[pageNumber];
          if (!doc || !record || !record.element) return;
          if (record.renderedScale === scale && record.canvas) return;
          if (record.task) {
            try {
              record.task.cancel();
            } catch {
              // Already finished.
            }
            record.task = undefined;
          }
          const generation = (record.generation ?? 0) + 1;
          record.generation = generation;
          doc.getPage(pageNumber).then((pdfPage) => {
            if (!record.element || docRef.current !== doc || record.generation !== generation) return;
            const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
            const viewport = pdfPage.getViewport({ scale });
            const renderViewport = pdfPage.getViewport({ scale: scale * dpr });
            let canvas = record.canvas;
            if (!canvas || !record.element.contains(canvas)) {
              canvas = document.createElement('canvas');
              record.canvas = canvas;
              record.element.innerHTML = '';
              record.element.appendChild(canvas);
              const label = document.createElement('span');
              label.className = 'dl-page-no';
              label.textContent = String(pageNumber);
              record.element.appendChild(label);
            }
            canvas.width = Math.max(1, Math.floor(renderViewport.width));
            canvas.height = Math.max(1, Math.floor(renderViewport.height));
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;
            record.element.style.width = `${viewport.width}px`;
            record.element.style.height = `${viewport.height}px`;
            record.element.classList.remove('dl-page-ph');
            const context = canvas.getContext('2d', { alpha: false });
            const task = pdfPage.render({ canvasContext: context, viewport: renderViewport });
            record.task = task;
            record.renderedScale = scale;
            task.promise.catch(() => {});
          });
        },
        [scale],
      );

      const renderVisible = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        const threshold = Math.max(container.clientHeight, 600);
        for (const [pageNumber, record] of Object.entries(pagesRef.current)) {
          const element = record?.element;
          if (!element) continue;
          const top = element.offsetTop;
          const bottom = top + element.offsetHeight;
          if (bottom >= container.scrollTop - 200 && top <= container.scrollTop + threshold + 200) {
            renderPage(Number(pageNumber));
          }
        }
      }, [renderPage]);

      // Re-render visible pages when zoom changes.
      useEffect(() => {
        if (docInfo.status !== 'ready') return;
        if (lastRenderedScaleRef.current !== scale) {
          lastRenderedScaleRef.current = scale;
          for (const record of Object.values(pagesRef.current)) {
            if (!record?.element) continue;
            record.task?.cancel?.();
            record.task = undefined;
            record.renderedScale = undefined;
            record.generation = (record.generation ?? 0) + 1;
            record.canvas = undefined;
            record.element.innerHTML = '';
            record.element.classList.add('dl-page-ph');
            record.element.style.width = `${baseSize.width * scale}px`;
            record.element.style.height = `${baseSize.height * scale}px`;
          }
          renderVisible();
        }
      }, [scale, docInfo.status, baseSize.width, baseSize.height, renderVisible]);

      // IntersectionObserver renders pages lazily as they approach the viewport.
      useEffect(() => {
        if (docInfo.status !== 'ready' || typeof IntersectionObserver !== 'function') return () => {};
        const root = containerRef.current;
        const observer = new IntersectionObserver(
          (entries) => {
            for (const entry of entries) {
              const pageNumber = Number(entry.target.dataset.page);
              if (!pageNumber) continue;
              if (entry.isIntersecting) renderPage(pageNumber);
            }
          },
          { root, rootMargin: '600px 0px' },
        );
        observerRef.current = observer;
        for (const record of Object.values(pagesRef.current)) {
          if (record?.element) observer.observe(record.element);
        }
        return () => {
          observer.disconnect();
          observerRef.current = undefined;
        };
      }, [docInfo.status, docInfo.numPages, renderPage]);

      // Track the current page and persist view state per project.
      const onScroll = useCallback(() => {
        const container = containerRef.current;
        if (!container) return;
        const scrollTop = container.scrollTop;
        let current = 1;
        const entries = Object.entries(pageElsRef.current)
          .map(([pageNumber, element]) => [Number(pageNumber), element])
          .filter(([, element]) => Boolean(element))
          .sort((a, b) => a[0] - b[0]);
        for (const [pageNumber, element] of entries) {
          if (element.offsetTop <= scrollTop + 80) current = pageNumber;
          else break;
        }
        if (current !== page) {
          setPage(current);
          if (projectId) {
            const previous = savedView(projectId);
            viewStates.set(projectId, { ...previous, page: current, zoomMode, zoomPercent });
          }
        }
      }, [page, projectId, zoomMode, zoomPercent]);

      useEffect(() => {
        const element = containerRef.current;
        if (!element) return () => {};
        let frame;
        const handler = () => {
          if (frame) return;
          frame = window.requestAnimationFrame(() => {
            frame = undefined;
            onScroll();
            renderVisible();
          });
        };
        element.addEventListener('scroll', handler, { passive: true });
        return () => {
          element.removeEventListener('scroll', handler);
          if (frame) window.cancelAnimationFrame(frame);
        };
      }, [onScroll, renderVisible]);

      const goToPage = useCallback(
        (target) => {
          const pageNumber = Math.max(1, Math.min(Number(target) || 1, Math.max(1, docInfo.numPages)));
          setPage(pageNumber);
          if (projectId) {
            const previous = savedView(projectId);
            viewStates.set(projectId, { ...previous, page: pageNumber, zoomMode, zoomPercent });
          }
          const element = pageElsRef.current[pageNumber];
          if (element && containerRef.current) {
            containerRef.current.scrollTop = Math.max(0, element.offsetTop - 8);
          }
        },
        [docInfo.numPages, projectId, zoomMode, zoomPercent],
      );

      const showToast = useCallback((message) => {
        setToast(message);
        if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => setToast(''), 2200);
      }, []);

      // A new navigation (for example a forward SyncTeX request from the
      // workbench) carries a page in `params`; reveal it in this same tab. The
      // revision changes even when the target page is unchanged.
      useEffect(() => {
        if (docInfo.status !== 'ready') return;
        const requested = Number(params?.page);
        if (Number.isFinite(requested) && requested >= 1) {
          pendingRestoreRef.current = requested;
          goToPage(requested);
        }
      }, [params?.page, revision, docInfo.status, docInfo.numPages]);

      const onDoubleClick = useCallback(
        async (event, pageNumber) => {
          if (!projectId) return;
          event.preventDefault();
          event.stopPropagation();
          const canvas = event.currentTarget.querySelector('canvas');
          if (!canvas) {
            setSyncNote(t('preview.syncFailed'));
            return;
          }
          const rect = canvas.getBoundingClientRect();
          const x = (event.clientX - rect.left) / scale;
          const y = (event.clientY - rect.top) / scale;
          setSyncNote(`${t('preview.syncing')} ${pageNumber} (${x.toFixed(0)}, ${y.toFixed(0)})`);
          try {
            const response = await fetch('/latex/synctex-inverse', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ project: projectId, page: pageNumber, x, y }),
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data?.error || `HTTP ${response.status}`);
            const result = data?.synctex;
            if (!result?.ok || !result.file) {
              throw new Error(result?.message ?? t('preview.syncFailed'));
            }
            openResource(
              sessionFileAddress(sessionId, cwd, result.file),
              result.line ? { params: { line: result.line } } : undefined,
            );
            const target = result.relativeFile ?? result.file;
            const label = `${t('preview.synced')}: ${target}${result.line ? `:${result.line}` : ''}${
              result.stale ? ` (${t('state.staleShort')})` : ''
            }`;
            setSyncNote(label);
            showToast(label);
          } catch (failure) {
            const label = `${t('preview.syncFailed')}: ${String(failure?.message ?? failure)}`;
            setSyncNote(label);
            showToast(label);
          }
        },
        [projectId, project?.rootDir, scale, sessionId, cwd, showToast],
      );

      const openDocumentPreview = useCallback(() => {
        if (!project?.previewVersion) return;
        const address = sessionFileAddress(sessionId, cwd, project.previewPath);
        openResource(address);
      }, [project?.previewPath, project?.previewVersion, sessionId, cwd]);

      if (!project) {
        return h(
          'div',
          { className: 'dl-preview' },
          h(
            'div',
            { className: 'dl-center' },
            h(IconLatex, { width: 28, height: 28 }),
            h('div', { className: 'dl-empty-title' }, t('empty.project')),
            h('div', { className: 'dl-empty-hint' }, t('state.noProjectHint')),
          ),
        );
      }

      const showEmpty = docInfo.status === 'empty' || (!version && docInfo.status !== 'loading');
      const stale = project.stale && project.previewVersion > 0;

      return h(
        'div',
        { className: 'dl-preview' },
        h(
          'div',
          { className: 'dl-preview-bar' },
          h(
            'button',
            {
              type: 'button',
              className: 'dl-iconbtn',
              title: t('preview.prev'),
              disabled: page <= 1,
              onClick: () => goToPage(page - 1),
            },
            h(IconChevron, { style: { transform: 'rotate(180deg)' } }),
          ),
          h('input', {
            className: 'dl-page-input',
            type: 'number',
            min: 1,
            max: Math.max(1, docInfo.numPages),
            value: page,
            title: t('preview.goPage'),
            'aria-label': t('preview.goPage'),
            onChange: (event) => goToPage(Number(event.target.value)),
          }),
          h('span', { className: 'dl-hint' }, `/ ${docInfo.numPages || project.previewPages || '—'}`),
          h(
            'button',
            {
              type: 'button',
              className: 'dl-iconbtn',
              title: t('preview.next'),
              disabled: page >= (docInfo.numPages || 1),
              onClick: () => goToPage(page + 1),
            },
            h(IconChevron),
          ),
          h('div', { className: 'dl-head-spacer' }),
          h(
            'select',
            {
              className: 'dl-zoom-select',
              value: zoomMode === 'fit' ? 'fit' : String(zoomPercent),
              title: t('preview.zoom'),
              'aria-label': t('preview.zoom'),
              onChange: (event) => {
                const value = event.target.value;
                const nextMode = value === 'fit' ? 'fit' : 'percent';
                const nextPercent = value === 'fit' ? zoomPercent : Number(value);
                setZoomMode(nextMode);
                if (nextMode === 'percent') setZoomPercent(nextPercent);
                if (projectId) {
                  viewStates.set(projectId, {
                    ...savedView(projectId),
                    page,
                    zoomMode: nextMode,
                    zoomPercent: nextPercent,
                  });
                }
              },
            },
            h('option', { value: 'fit' }, t('preview.fit')),
            [50, 75, 100, 125, 150, 200].map((value) =>
              h('option', { key: value, value: String(value) }, `${value}%`),
            ),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dl-iconbtn',
              title: t('action.reload'),
              onClick: () => setReloadToken((value) => value + 1),
            },
            h(IconRefresh),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dl-btn ghost',
              title: t('action.documentPreview'),
              disabled: !project.previewVersion,
              onClick: openDocumentPreview,
            },
            h(IconEye),
          ),
        ),
        project.building
          ? h(
              'div',
              { className: 'dl-banner info' },
              h(IconSpinner),
              h('span', null, t('state.building')),
            )
          : null,
        stale
          ? h('div', { className: 'dl-banner warn' }, h(IconAlert), h('span', null, t('build.staleNote')))
          : null,
        !stale && syncNote
          ? h('div', { className: 'dl-banner info' }, h('span', null, syncNote))
          : null,
        showEmpty
          ? h(
              'div',
              { className: 'dl-center' },
              h(IconLatex, { width: 28, height: 28 }),
              h('div', { className: 'dl-empty-title' }, t('state.noPdf')),
              h('div', { className: 'dl-empty-hint' }, t('state.noPdfHint')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn primary',
                  onClick: () => postAction({ action: 'compile', project: project.id, open: true }),
                },
                h(IconPlay),
                h('span', null, t('action.compile')),
              ),
            )
          : null,
        docInfo.status === 'loading' || (version > 0 && docInfo.status === 'idle')
          ? h('div', { className: 'dl-center' }, h(IconSpinner), h('div', { className: 'dl-hint' }, t('state.loadingPdf')))
          : null,
        docInfo.status === 'error'
          ? h(
              'div',
              { className: 'dl-center' },
              h(IconAlert),
              h('div', { className: 'dl-empty-title' }, t('state.noPdf')),
              h('div', { className: 'dl-empty-hint' }, docInfo.error),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn',
                  onClick: () => setReloadToken((value) => value + 1),
                },
                h(IconRefresh),
                h('span', null, t('action.retry')),
              ),
            )
          : null,
        docInfo.status === 'ready'
          ? h(
              'div',
              {
                className: 'dl-preview-scroll',
                ref: containerRef,
                role: 'region',
                'aria-label': t('preview.title'),
              },
              Array.from({ length: docInfo.numPages }, (_, index) => {
                const pageNumber = index + 1;
                return h('div', {
                  key: pageNumber,
                  className: 'dl-page dl-page-ph',
                  'data-page': pageNumber,
                  style: {
                    width: `${baseSize.width * scale}px`,
                    height: `${baseSize.height * scale}px`,
                  },
                  title: t('preview.syncHint'),
                  onDoubleClick: (event) => onDoubleClick(event, pageNumber),
                  ref: (element) => {
                    if (!element) {
                      delete pageElsRef.current[pageNumber];
                      delete pagesRef.current[pageNumber];
                      return;
                    }
                    pageElsRef.current[pageNumber] = element;
                    const record = pagesRef.current[pageNumber] ?? {};
                    record.element = element;
                    pagesRef.current[pageNumber] = record;
                  },
                });
              }),
              toast ? h('div', { className: 'dl-toast' }, toast) : null,
            )
          : null,
      );
    }

    /* ------------------------------------------------------------------ */
    /* Editable .tex tab                                                   */
    /* ------------------------------------------------------------------ */

    function LatexEditor(props) {
      const { sessionId, useSessions, useTabInfo, t: seatT } = props;
      const t = seatT ?? tr;
      const info = useTabInfo();
      const tab = info?.tab;
      const address = tab?.contentId ?? '';
      const navigation = tab?.navigation ?? {};
      const params = navigation.params ?? {};
      const navigationRevision = navigation.revision ?? 0;
      const cwd = useSessions((sessions) => sessions?.byId?.[sessionId]?.cwd);
      const parsed = useMemo(() => parseFileAddress(address), [address]);
      const filePath = useMemo(() => resolveAddressPath(parsed, cwd), [parsed, cwd]);
      const displayName = basenameOfAddress(address) || filePath || '';

      const [content, setContent] = useState('');
      const [draft, setDraft] = useState('');
      const [revision, setRevision] = useState('');
      const [phase, setPhase] = useState('loading');
      const [error, setError] = useState('');
      const [conflict, setConflict] = useState(undefined);
      const [build, setBuild] = useState(undefined);
      const [previewProjectId, setPreviewProjectId] = useState('');
      const textRef = useRef(null);
      const gutterRef = useRef(null);
      const busyRef = useRef(false);
      const openedPreviewRef = useRef(false);
      const tRef = useRef(t);
      tRef.current = t;
      const dirty = content !== draft;
      const busy = phase === 'saving' || phase === 'compiling';

      const load = useCallback(async () => {
        if (!filePath) {
          if (parsed?.scope === 'session' && !cwd) return;
          setPhase('error');
          setError(tRef.current('editor.noPath'));
          return;
        }
        setPhase('loading');
        setError('');
        setConflict(undefined);
        try {
          const query = new URLSearchParams({ path: filePath });
          const response = await fetch(`/latex/file?${query}`, { cache: 'no-store' });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
          const file = payload?.file ?? payload;
          if (typeof file?.content !== 'string') throw new Error('invalid file response');
          setContent(file.content);
          setDraft(file.content);
          setRevision(file.revision ?? '');
          setBuild(undefined);
          setPhase('ready');
        } catch (loadError) {
          setPhase('error');
          setError(loadError?.message ?? String(loadError));
        }
      }, [filePath, parsed, cwd]);

      useEffect(() => {
        load();
      }, [load]);

      const openPdf = useCallback(() => {
        const snapshot = store.get();
        const project =
          (previewProjectId &&
            (snapshot.projects ?? []).find((entry) => entry.id === previewProjectId)) ||
          pickProject(snapshot, { sessionId, cwd });
        if (!project?.previewVersion) return;
        openPreview(project, snapshot, { sessionId, cwd });
      }, [previewProjectId, sessionId, cwd]);

      const save = useCallback(
        async ({ force = false } = {}) => {
          if (busyRef.current || !filePath) return;
          busyRef.current = true;
          const text = draft;
          setPhase('saving');
          setError('');
          setConflict(undefined);
          try {
            const body = { path: filePath, content: text };
            if (!force && revision) body.expectedRevision = revision;
            const response = await fetch('/latex/file', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(body),
            });
            const saved = await response.json().catch(() => ({}));
            if (response.status === 409) {
              setConflict({ revision: saved?.revision });
              setPhase('conflict');
              return;
            }
            if (!response.ok) throw new Error(saved?.error || `HTTP ${response.status}`);
            const next = saved?.file ?? saved;
            setRevision(next?.revision ?? '');
            setContent(text);
            setPhase('compiling');
            const compiled = await postAction({
              action: 'compile-file',
              path: filePath,
              cwd,
              sessionId,
              force,
            });
            const result = compiled?.result;
            setBuild(result);
            setPreviewProjectId(compiled?.projectId ?? '');
            if (result?.status === 'success') {
              setPhase('success');
              if (!openedPreviewRef.current) {
                openedPreviewRef.current = true;
                const snapshot = store.get();
                const project =
                  (compiled?.projectId &&
                    (snapshot.projects ?? []).find((entry) => entry.id === compiled.projectId)) || {
                    id: compiled?.projectId,
                    previewVersion: compiled?.previewVersion ?? result.previewVersion,
                    previewPath: compiled?.previewPath ?? result.previewPath,
                  };
                openPreview(project, snapshot, {
                  sessionId,
                  cwd,
                  revealIfOpened: false,
                });
              }
            } else {
              setPhase('failed');
            }
          } catch (saveError) {
            setPhase('error');
            setError(saveError?.message ?? String(saveError));
          } finally {
            busyRef.current = false;
          }
        },
        [draft, revision, filePath, cwd, sessionId],
      );

      const reload = useCallback(() => {
        if (dirty && typeof window !== 'undefined' && !window.confirm(tRef.current('editor.reloadConfirm'))) return;
        load();
      }, [dirty, load]);

      const forceSave = useCallback(() => {
        if (typeof window !== 'undefined' && !window.confirm(tRef.current('editor.forceConfirm'))) return;
        save({ force: true });
      }, [save]);

      // Scroll to the line a SyncTeX inverse jump asked for (once per load).
      useEffect(() => {
        const line = Number(params.line) || 0;
        if (!line || phase !== 'ready' || !content || !textRef.current) return;
        const lines = content.split('\n');
        const target = Math.min(Math.max(1, line), lines.length);
        let offset = 0;
        for (let index = 0; index < target - 1; index += 1) offset += lines[index].length + 1;
        const element = textRef.current;
        try {
          element.focus();
          element.setSelectionRange(offset, offset + (lines[target - 1]?.length ?? 0));
          element.scrollTop = Math.max(0, (target - 1) * 18 - element.clientHeight / 2);
        } catch {
          // A detached textarea during teardown is harmless.
        }
      }, [phase, content, navigationRevision, params.line]);

      const onKeyDown = useCallback(
        (event) => {
          if ((event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 's') {
            event.preventDefault();
            save();
            return;
          }
          if (event.key === 'Tab') {
            event.preventDefault();
            const element = event.currentTarget;
            const start = element.selectionStart ?? draft.length;
            const end = element.selectionEnd ?? start;
            const next = `${draft.slice(0, start)}  ${draft.slice(end)}`;
            setDraft(next);
            window.setTimeout(() => {
              try {
                element.selectionStart = start + 2;
                element.selectionEnd = start + 2;
              } catch {
                // Ignore a detached textarea.
              }
            }, 0);
          }
        },
        [draft, save],
      );

      const lineCount = useMemo(() => draft.split('\n').length, [draft]);
      const gutter = useMemo(
        () => Array.from({ length: lineCount }, (_, index) => String(index + 1)).join('\n'),
        [lineCount],
      );
      const buildErrors = build?.diagnostics?.errors ?? [];
      const errorCount = build?.diagnostics?.counts?.errors ?? buildErrors.length;
      const firstError = buildErrors[0];
      const firstLocation = firstError
        ? `${firstError.file ?? ''}${firstError.line ? `:${firstError.line}` : ''} ${firstError.message ?? ''}`.trim()
        : '';
      const statusText =
        phase === 'loading'
          ? t('editor.loading')
          : phase === 'saving'
            ? t('editor.saving')
            : phase === 'compiling'
              ? t('editor.compiling')
              : phase === 'success' && !dirty
                ? t('editor.buildOk')
                : phase === 'failed'
                  ? t('editor.buildFailed')
                  : dirty
                    ? t('editor.dirty')
                    : t('editor.saved');
      const statusTone =
        phase === 'success' && !dirty ? 'ok' : phase === 'failed' || phase === 'error' ? 'bad' : '';
      const canSave = Boolean(filePath) && !busy && phase !== 'loading';
      const canOpenPdf = Boolean(previewProjectId);

      return h(
        'div',
        { className: 'dl-editor' },
        h(
          'div',
          { className: 'dl-editor-bar' },
          h(IconLatex),
          h('span', { className: 'dl-editor-path', title: filePath || address }, displayName),
          dirty ? h('span', { className: 'dl-editor-dirty' }, t('editor.dirty')) : null,
          h('span', { className: 'dl-head-spacer' }),
          h('span', { className: `dl-editor-status ${statusTone}` }, statusText),
          h(
            'button',
            {
              type: 'button',
              className: 'dl-editor-save',
              title: t('editor.save'),
              'aria-label': t('editor.save'),
              disabled: !canSave,
              onClick: () => save(),
            },
            busy ? h(IconSpinner) : h(IconPlay),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dl-iconbtn',
              title: t('editor.reload'),
              'aria-label': t('editor.reload'),
              disabled: busy || !filePath,
              onClick: reload,
            },
            h(IconRefresh),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dl-iconbtn',
              title: t('editor.openPreview'),
              'aria-label': t('editor.openPreview'),
              disabled: !canOpenPdf,
              onClick: openPdf,
            },
            h(IconEye),
          ),
        ),
        conflict
          ? h(
              'div',
              { className: 'dl-editor-conflict' },
              h(IconAlert),
              h('span', null, t('editor.conflict')),
              h(
                'button',
                { type: 'button', className: 'dl-btn ghost', onClick: reload },
                t('editor.reload'),
              ),
              h(
                'button',
                { type: 'button', className: 'dl-btn danger', onClick: forceSave },
                t('editor.forceSave'),
              ),
            )
          : null,
        phase === 'failed'
          ? h(
              'div',
              { className: 'dl-editor-error' },
              `${t('editor.buildFailed')}${errorCount > 0 ? ` · ${errorCount} error(s)` : ''}${
                firstLocation ? ` — ${firstLocation}` : build?.error ? ` — ${build.error}` : ''
              }`,
            )
          : null,
        phase === 'error' && error ? h('div', { className: 'dl-editor-error' }, error) : null,
        phase === 'loading'
          ? h(
              'div',
              { className: 'dl-editor-empty' },
              h(IconSpinner),
              h('div', { className: 'dl-hint' }, t('editor.loading')),
            )
          : phase === 'error' && !content
            ? h(
                'div',
                { className: 'dl-editor-empty' },
                h(IconAlert, { width: 24, height: 24 }),
                h('div', { className: 'dl-empty-title' }, t('editor.loadFailed')),
                h('div', { className: 'dl-hint' }, filePath || address),
                h(
                  'button',
                  { type: 'button', className: 'dl-btn', onClick: reload },
                  h(IconRefresh),
                  h('span', null, t('editor.reload')),
                ),
              )
            : h(
                'div',
                { className: 'dl-editor-body' },
                h('pre', { ref: gutterRef, className: 'dl-editor-gutter', 'aria-hidden': true }, gutter),
                h('textarea', {
                  ref: textRef,
                  className: 'dl-editor-text',
                  value: draft,
                  spellCheck: false,
                  wrap: 'off',
                  'aria-label': displayName || t('editor.title'),
                  onChange: (event) => setDraft(event.currentTarget.value),
                  onKeyDown,
                  onScroll: (event) => {
                    if (gutterRef.current) gutterRef.current.scrollTop = event.currentTarget.scrollTop;
                  },
                }),
              ),
        h('div', { className: 'dl-hint', style: { padding: '2px 9px 6px' } }, t('editor.hint')),
      );
    }

    /* ------------------------------------------------------------------ */
    /* Tool result cards                                                   */
    /* ------------------------------------------------------------------ */

    const TOOL_LABELS = {
      latex_compile: 'tool.compile',
      latex_preview: 'tool.preview',
      latex_get_diagnostics: 'tool.diagnostics',
      latex_get_status: 'tool.status',
      latex_clean: 'tool.clean',
      latex_cancel: 'tool.cancel',
      latex_synctex: 'tool.synctex',
    };

    function parseArgs(raw) {
      if (typeof raw !== 'string' || raw === '') return {};
      try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
      } catch {
        return {};
      }
    }

    function resultText(block) {
      const parts = [];
      for (const item of block?.content ?? []) {
        if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text);
        else parts.push(JSON.stringify(item));
      }
      return parts.join('\n');
    }

    function LatexToolCard(props) {
      const { block, phase, sessionId, cwd, toolName, useSessions, t: seatT } = props;
      const t = seatT ?? tr;
      const sessionCwd = useSessions((sessions) => sessions?.byId?.[sessionId]?.cwd);
      const resolvedCwd = cwd || sessionCwd;
      const settled = block !== undefined && block !== null && 'kind' in block;
      const args = parseArgs(settled ? block?.call?.argsRaw : block?.argsRaw);
      const output = settled ? resultText(block) : '';
      const failed = settled && block?.isError === true;
      const projectHint = args.previewProject ?? args.project;
      const handledRef = useRef(false);
      const [project, setProject] = useState(undefined);

      useEffect(() => {
        if (!settled || handledRef.current) return;
        handledRef.current = true;
        if (toolName !== 'latex_compile' && toolName !== 'latex_preview') return;
        if (toolName === 'latex_compile' && args.open === false) return;
        fetchState({ sessionId, cwd: resolvedCwd })
          .then((snapshot) => {
            const request = snapshot?.previewRequest;
            const chosen = pickProject(snapshot, { sessionId, cwd: resolvedCwd, projectId: projectHint });
            if (chosen) setProject(chosen);
            if (!request || (request.sessionId && String(request.sessionId) !== String(sessionId))) return;
            if (request.seq <= lastPreviewHandled) return;
            const target = snapshot.projects?.find((entry) => entry.id === request.projectId);
            if (!target || !target.previewVersion) return;
            lastPreviewHandled = request.seq;
            const surface = request.surface ?? snapshot.config?.previewSurface ?? 'native';
            if (surface === 'document') {
              const addressCwd = resolvedCwd || target.rootDir;
              openResource(sessionFileAddress(sessionId, addressCwd, target.previewPath));
            } else {
              openTab(PREVIEW_KIND, { project: target.id, page: request.page });
            }
          })
          .catch(() => {});
      }, [settled, toolName, sessionId, resolvedCwd, projectHint]);

      useEffect(() => {
        if (toolName !== 'latex_get_status' || !settled) return;
        fetchState({ sessionId, cwd: resolvedCwd })
          .then((snapshot) => {
            const chosen = pickProject(snapshot, { sessionId, cwd: resolvedCwd, projectId: projectHint });
            if (chosen) setProject(chosen);
          })
          .catch(() => {});
      }, [settled, toolName, sessionId, resolvedCwd, projectHint]);

      const staleProject = project;
      return h(
        'div',
        { className: 'dl-tool' },
        h(
          'div',
          { className: 'dl-tool-head' },
          h(IconLatex),
          h('span', { className: 'dl-tool-title' }, t(TOOL_LABELS[toolName] ?? 'tool.compile')),
          h(
            'span',
            { className: `dl-pill ${!settled ? 'busy' : failed ? 'bad' : 'ok'}` },
            !settled ? t('tool.running') : failed ? t('tool.failed') : t('tool.ok'),
          ),
          args.engine ? h('span', { className: 'dl-pill' }, String(args.engine)) : null,
        ),
        output
          ? h('pre', { className: 'dl-tool-pre' }, output.length > 6000 ? `${output.slice(0, 6000)}\n…` : output)
          : null,
        staleProject?.previewVersion
          ? h(
              'div',
              { className: 'dl-tool-actions' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn',
                  onClick: () => openTab(PREVIEW_KIND, { project: staleProject.id }),
                },
                h(IconEye),
                h('span', null, t('action.openPreview')),
              ),
            )
          : null,
      );
    }

    /* ------------------------------------------------------------------ */
    /* Registration                                                        */
    /* ------------------------------------------------------------------ */

    function apply(ctx) {
      runtime.ctx = ctx;

      // Locale dictionaries (registered before any UI mounts).
      try {
        let locale;
        try {
          locale = ctx.locale;
        } catch {
          locale = undefined;
        }
        if (!locale) locale = ctxService('locale');
        if (locale && typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, DICT));
          const bound = locale.bind(NS);
          if (typeof bound === 'function') {
            runtime.t = (key) => {
              try {
                const value = bound(key);
                return typeof value === 'string' && value !== '' ? value : key;
              } catch {
                return key;
              }
            };
          }
        }
      } catch (error) {
        console.warn('[dsh-latex] locale registration failed:', error);
      }
      if (!runtime.t) runtime.t = (key) => key;
      const t = (key) => runtime.t(key);

      // One package-owned stylesheet, removed with the plugin.
      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-dsh-latex', '');
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      });

      // Live state stream; EventSource reconnects on its own.
      ctx.effect(() => startEvents());

      let tabs;
      try {
        tabs = ctx.sidebarRightTabs;
      } catch {
        tabs = undefined;
      }
      if (!tabs) tabs = ctxService('sidebarRightTabs');
      if (tabs && typeof tabs.register === 'function') {
        try {
          // A .tex address is claimed at the extension band, above the built-in
          // text preview (priority "fallback"), so opening any .tex file lands
          // in the editor. Non-.tex addresses fall through to the built-in
          // document preview untouched.
          ctx.effect(() =>
            tabs.register({
              id: EDITOR_ID,
              kind: EDITOR_KIND,
              patterns: ['dsh-resource://file/[\\s\\S]+'],
              priority: 'extension',
              canOpen: (address) => isTexAddress(address),
              title: (address) => basenameOfAddress(address) || 'TeX',
              keepMounted: true,
            }),
          );
          ctx.effect(() =>
            tabs.register({
              id: PREVIEW_ID,
              kind: PREVIEW_KIND,
              priority: 'extension',
              title: () => (runtime.t ? runtime.t('preview.title') : 'PDF'),
              guide: [
                {
                  id: 'preview',
                  order: 41,
                  title: () => (runtime.t ? runtime.t('preview.title') : 'PDF'),
                  description: () => (runtime.t ? runtime.t('preview.description') : ''),
                },
              ],
            }),
          );
        } catch (error) {
          console.error('[dsh-latex] sidebar tab registration failed:', error);
        }
      } else {
        console.warn('[dsh-latex] sidebarRightTabs is unavailable; the UI tabs stay unregistered.');
      }

      // Tab bodies.
      ctx.effect(() =>
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: EDITOR_ID, locale: NS },
            LatexEditor,
          ),
        ),
      );
      ctx.effect(() =>
        ctx.slots.inject('sidebar.right.pane.tab', () =>
          ctx.slots.register(
            { name: 'sidebar.right.pane.tab', key: PREVIEW_ID, locale: NS },
            LatexPreview,
          ),
        ),
      );

      // Tool result cards; registering an unclaimed key is the documented path.
      for (const toolName of Object.keys(TOOL_LABELS)) {
        ctx.effect(() =>
          ctx.slots.inject('tool.call.toolview', () =>
            ctx.slots.register({ name: 'tool.call.toolview', key: toolName, locale: NS }, LatexToolCard),
          ),
        );
      }
    }

    return {
      inject: ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'],
      apply,
    };
  },
});
