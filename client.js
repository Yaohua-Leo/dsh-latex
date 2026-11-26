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
  // The registration id MUST be the npm package name: the Harness client
  // module graph keys every entry by the package it resolves to. A bundle that
  // registers under any other id never counts as arrived, so the loader falls
  // back to the one-resource URL, executes the bundle a second time, and the
  // duplicate-factory guard kills the whole entry (no UI, silent Host tools).
  id: '@yaohualiu/dsh-latex',
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
        'editor.hint': 'Ctrl+S 保存并编译 · Ctrl+单击定位到 PDF',
        'editor.syncNoProject': '这个文件不在任何已检测到的 LaTeX 项目里，无法定位',
        'editor.syncing': '正在定位到 PDF…',
        'editor.synced': '已定位到 PDF',
        'editor.syncFailed': '定位到 PDF 失败',
        'editor.syncNoPanel': '右侧面板不可用，打不开 PDF 预览',
        'editor.conflict': '磁盘文件已被外部修改',
        'editor.forceSave': '强制保存',
        'editor.reloadConfirm': '放弃未保存的修改并重新加载？',
        'editor.forceConfirm': '强制保存会覆盖磁盘上的外部修改，继续？',
        'editor.autoOn': '自动编译',
        'editor.autoOff': '手动编译',
        'editor.autoHint': '停止输入后自动保存并编译',
        'editor.lines': '行',
        'editor.outline': '大纲',
        'editor.outlineEmpty': '还没有 section',
        'editor.draftRecovered': '已恢复上次未保存的草稿',
        'editor.discardDraft': '丢弃草稿',
        'editor.keepMine': '保留草稿',
        'editor.externalChange': '文件已在磁盘上更新',
        'editor.loadDisk': '加载磁盘版本',
        'toolchain.missing': '没有找到可用的 TeX 工具链',
        'toolchain.install': '一键安装 TinyTeX',
        'toolchain.cancel': '取消安装',
        'toolchain.installing': '正在安装 TinyTeX',
        'toolchain.percent': '{percent}%',
        'toolchain.failed': '安装失败',
        'toolchain.done': '安装完成，正在刷新…',
        'toolchain.dismiss': '稍后',
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
        'action.openSource': '打开源码',
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
        'preview.syncHint': 'Ctrl+单击页面跳到对应源码行；在源码里 Ctrl+单击跳到这里的对应位置',
        'preview.syncing': 'SyncTeX 定位中…',
        'preview.synced': '已定位到源码',
        'preview.syncFailed': 'SyncTeX 定位失败',
        'preview.syncOpenFailed': '右侧面板没能打开源码标签',
        'preview.textHint': '选中文字可提问或写批注',
        'preview.ask': '提问',
        'preview.annotate': '批注',
        'preview.askPlaceholder': '想让 AI 解释或修改什么…',
        'preview.annotatePlaceholder': '给这条批注写点说明（可留空）…',
        'preview.sendToChat': '发送到会话',
        'preview.saveAnnotation': '保存批注',
        'preview.sending': '发送中…',
        'preview.askSent': '已发送到当前会话',
        'preview.askCopied': '发送失败，选区已复制到剪贴板',
        'preview.askFailed': '发送失败',
        'preview.annotationSaved': '批注已保存',
        'preview.annotationFailed': '批注保存失败',
        'preview.annotations': '批注',
        'preview.annotationsEmpty': '还没有批注',
        'preview.clearResolved': '清除已解决',
        'preview.annoOpen': '待处理',
        'preview.annoResolved': '已解决',
        'preview.annoStale': '已失效',
        'preview.annoStaleBanner': '有批注在重建后找不到原文，已标记失效；可在批注列表中清除。',
        'preview.annoHint': '选中 PDF 文字后可提问或写批注；批注会随重建按原文重锚。',
        'preview.toc': '目录',
        'preview.search': '搜索',
        'preview.searchPlaceholder': '在当前 PDF 中搜索…',
        'preview.searchRun': '搜索',
        'preview.searching': '搜索中…',
        'preview.searchEmpty': '没有匹配',
        'preview.download': '下载 PDF',
        'preview.dark': '深色预览',
        'preview.audit': '审计',
        'preview.auditHint': '选择一次历史构建，逐页对比当前 PDF；变化页会给出并排图。',
        'preview.auditAuto': '自动（最近手动构建）',
        'preview.auditPrevious': '上一构建（含自动编译）',
        'preview.auditRun': '运行审计',
        'preview.auditRunning': '审计中',
        'preview.auditProgress': '第 {page} / {to} 页',
        'preview.auditEmpty': '还没有可对比的历史构建；连续编译两次后再试。',
        'preview.auditNoBaseline': '没有可用的对比基线',
        'preview.auditChanged': '变化',
        'preview.auditAdded': '新增',
        'preview.auditRemoved': '删除',
        'preview.auditFailed': '渲染失败',
        'preview.auditImages': '并排图（旧 | 新，红框为变化区）',
        'preview.auditTruncated': '本次只检查了预算内的页数',
        'preview.close': '关闭',
        'preview.selected': '已选',
        'preview.copySelection': '复制选区',
        'preview.crop': '框选',
        'preview.cropHint': '在页面上按住鼠标拖出一个区域，松开后可提问或写批注',
        'preview.cropCancel': '退出框选',
        'preview.imageQuestionPlaceholder': '想问关于这张截图什么？',
        'preview.sendImage': '发送截图到会话',
        'preview.saveImageAnnotation': '保存截图批注',
        'preview.imageAnnotation': '截图批注',
        'preview.delete': '删除',
        'preview.deleteConfirm': '删除这条批注？截图文件也会一起删除。',
        'preview.ocr': 'OCR',
        'preview.ocrMissing': '本地 OCR 未安装（含 PP-OCR 模型，约 150 MB）',
        'preview.ocrInstall': '安装本地 OCR',
        'preview.ocrInstalling': 'OCR 安装中 {percent}%',
        'preview.ocrCancel': '取消安装',
        'preview.ocrReady': '本地 OCR 已就绪',
        'preview.ocrFailed': 'OCR 安装失败',
        'preview.imageTooLarge': '截图过大，请框选更小的区域',
        'preview.screenshotSent': '截图已发送到当前会话',
        'tool.look': 'LaTeX 看图',
        'tool.audit': 'LaTeX 审计',
        'tool.annotations': 'LaTeX 批注',
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
        'editor.hint': 'Ctrl+S saves and compiles · Ctrl+click locates the line in the PDF',
        'editor.syncNoProject': 'This file is not inside any detected LaTeX project',
        'editor.syncing': 'Locating in the PDF…',
        'editor.synced': 'Located in the PDF',
        'editor.syncFailed': 'Could not locate the line in the PDF',
        'editor.syncNoPanel': 'The right sidebar is unavailable; the PDF preview cannot open',
        'editor.conflict': 'The file changed on disk',
        'editor.forceSave': 'Force save',
        'editor.reloadConfirm': 'Discard unsaved changes and reload?',
        'editor.forceConfirm': 'Force save will overwrite the external change. Continue?',
        'editor.autoOn': 'Auto compile',
        'editor.autoOff': 'Manual compile',
        'editor.autoHint': 'Save and compile after typing stops',
        'editor.lines': 'lines',
        'editor.outline': 'Outline',
        'editor.outlineEmpty': 'No sections yet',
        'editor.draftRecovered': 'Recovered an unsaved draft',
        'editor.discardDraft': 'Discard draft',
        'editor.keepMine': 'Keep draft',
        'editor.externalChange': 'The file changed on disk',
        'editor.loadDisk': 'Load disk version',
        'toolchain.missing': 'No usable TeX toolchain found',
        'toolchain.install': 'Install TinyTeX',
        'toolchain.cancel': 'Cancel install',
        'toolchain.installing': 'Installing TinyTeX',
        'toolchain.percent': '{percent}%',
        'toolchain.failed': 'Install failed',
        'toolchain.done': 'Installed; refreshing…',
        'toolchain.dismiss': 'Later',
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
        'action.openSource': 'Open source',
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
        'preview.syncHint': 'Ctrl+click a page to reveal its source line; Ctrl+click the source to locate it here',
        'preview.syncing': 'SyncTeX lookup…',
        'preview.synced': 'Revealed source line',
        'preview.syncFailed': 'SyncTeX lookup failed',
        'preview.syncOpenFailed': 'The right sidebar could not open the source tab',
        'preview.textHint': 'Select text to ask about it or leave an annotation',
        'preview.ask': 'Ask',
        'preview.annotate': 'Annotate',
        'preview.askPlaceholder': 'What should the AI explain or change?',
        'preview.annotatePlaceholder': 'Optional note for this annotation…',
        'preview.sendToChat': 'Send to chat',
        'preview.saveAnnotation': 'Save annotation',
        'preview.sending': 'Sending…',
        'preview.askSent': 'Sent to the current chat',
        'preview.askCopied': 'Send failed; the selection was copied instead',
        'preview.askFailed': 'Could not send the selection',
        'preview.annotationSaved': 'Annotation saved',
        'preview.annotationFailed': 'Could not save the annotation',
        'preview.annotations': 'Annotations',
        'preview.annotationsEmpty': 'No annotations yet',
        'preview.clearResolved': 'Clear resolved',
        'preview.annoOpen': 'Open',
        'preview.annoResolved': 'Resolved',
        'preview.annoStale': 'Stale',
        'preview.annoStaleBanner': 'Some annotations could not be re-anchored after the rebuild and are marked stale; clear them from the annotation list.',
        'preview.annoHint': 'Select text in the PDF to ask or annotate; annotations are re-anchored by their quote after a rebuild.',
        'preview.toc': 'Contents',
        'preview.search': 'Search',
        'preview.searchPlaceholder': 'Search this PDF…',
        'preview.searchRun': 'Search',
        'preview.searching': 'Searching…',
        'preview.searchEmpty': 'No matches',
        'preview.download': 'Download PDF',
        'preview.dark': 'Dark preview',
        'preview.audit': 'Audit',
        'preview.auditHint': 'Compare the current PDF with a historical build; changed pages get a side-by-side image.',
        'preview.auditAuto': 'Auto (latest manual build)',
        'preview.auditPrevious': 'Previous build (including auto)',
        'preview.auditRun': 'Run audit',
        'preview.auditRunning': 'Auditing',
        'preview.auditProgress': 'Page {page} of {to}',
        'preview.auditEmpty': 'No historical build yet; build twice before auditing.',
        'preview.auditNoBaseline': 'No usable baseline',
        'preview.auditChanged': 'changed',
        'preview.auditAdded': 'added',
        'preview.auditRemoved': 'removed',
        'preview.auditFailed': 'render failed',
        'preview.auditImages': 'Side-by-side (old | new, red box = diff)',
        'preview.auditTruncated': 'Only pages within this audit budget were checked',
        'preview.close': 'Close',
        'preview.selected': 'Selected',
        'preview.copySelection': 'Copy selection',
        'preview.crop': 'Marquee',
        'preview.cropHint': 'Drag a rectangle on the page, then ask or annotate the crop',
        'preview.cropCancel': 'Exit marquee',
        'preview.imageQuestionPlaceholder': 'What would you like to ask about this screenshot?',
        'preview.sendImage': 'Send screenshot to chat',
        'preview.saveImageAnnotation': 'Save screenshot annotation',
        'preview.imageAnnotation': 'Screenshot annotation',
        'preview.delete': 'Delete',
        'preview.deleteConfirm': 'Delete this annotation? Its screenshot is removed too.',
        'preview.ocr': 'OCR',
        'preview.ocrMissing': 'Local OCR is not installed (PP-OCR models, about 150 MB)',
        'preview.ocrInstall': 'Install local OCR',
        'preview.ocrInstalling': 'Installing OCR {percent}%',
        'preview.ocrCancel': 'Cancel install',
        'preview.ocrReady': 'Local OCR is ready',
        'preview.ocrFailed': 'OCR install failed',
        'preview.imageTooLarge': 'Screenshot is too large; select a smaller region',
        'preview.screenshotSent': 'Screenshot sent to the current chat',
        'tool.look': 'LaTeX look',
        'tool.audit': 'LaTeX audit',
        'tool.annotations': 'LaTeX annotations',
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

    /**
     * 找出真正拥有某个源文件的项目：取包含该文件的最深 rootDir，这样
     * \input 进来的子文件也能落到它的主文件项目上。
     */
    function projectForFile(snapshot, absolutePath, sessionId) {
      const projects = Array.isArray(snapshot?.projects) ? snapshot.projects : [];
      const file = String(absolutePath ?? '').replace(/\\/g, '/').toLowerCase();
      let best;
      if (file !== '') {
        for (const project of projects) {
          const root = String(project.rootDir ?? '')
            .replace(/\\/g, '/')
            .replace(/\/+$/, '')
            .toLowerCase();
          if (root === '' || !(file === root || file.startsWith(`${root}/`))) continue;
          if (!best || root.length > best.root.length) best = { project, root };
        }
      }
      if (best) return best.project;
      // 文件不在任何项目里时退回本会话的项目，至少给用户一个明确结果。
      return pickProject(snapshot, { sessionId });
    }

    /** rootDir 下的相对路径（正斜杠）；文件不在 rootDir 里时原样返回。 */
    function relativeInside(rootDir, absolutePath) {
      const normalized = String(absolutePath ?? '').replace(/\\/g, '/');
      const root = String(rootDir ?? '')
        .replace(/\\/g, '/')
        .replace(/\/+$/, '');
      if (root !== '' && normalized.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
        return normalized.slice(root.length + 1);
      }
      return normalized;
    }

    /** 右侧面板服务；undefined 表示当前宿主没有这个能力。 */
    function sidebarRightFace() {
      let sidebar;
      try {
        sidebar = runtime.ctx?.sidebarRight;
      } catch {
        sidebar = undefined;
      }
      if (!sidebar) sidebar = ctxService('sidebarRight');
      return sidebar;
    }

    /**
     * 找出当前会话里已经打开的 PDF 预览标签所在的 dock pane。
     * 页面型标签只在“目标 pane 内”去重，所以要从布局里捞到它所在的 pane，
     * 再把 openTab 指过去，否则每次都会在编辑器旁边新开一个预览页。
     */
    function previewPaneId(sessionId) {
      const sidebar = sidebarRightFace();
      try {
        const surface = sidebar?.adopted?.get?.(sessionId)?.store?.getSnapshot?.()?.bySession?.[sessionId];
        const layout = surface?.layout;
        if (!layout || !layout.nodes || !layout.tabs) return undefined;
        for (const [paneId, node] of Object.entries(layout.nodes)) {
          if (!node || node.kind !== 'pane') continue;
          const holdsPreview = (node.tabs ?? []).some((tabId) => layout.tabs[tabId]?.kind === PREVIEW_KIND);
          if (holdsPreview) return paneId;
        }
      } catch {
        // 布局属于面板内部结构，读不到就退回默认行为。
      }
      return undefined;
    }

    /** openResource 之后再把焦点压到那个标签上，避免“已定位但页没动”。 */
    function focusResourceTab(sessionId, address) {
      const sidebar = sidebarRightFace();
      if (!sidebar || typeof sidebar.focus !== 'function') return false;
      try {
        const tabs = typeof sidebar.tabsIn === 'function' ? sidebar.tabsIn(sessionId) : [];
        const match = (tabs ?? []).find((tab) => tab && tab.contentId === address);
        if (!match?.id) return false;
        sidebar.focus(match.id);
        return true;
      } catch {
        return false;
      }
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

    function IconNote(props) {
      return svg(
        [
          h('path', { key: 'bubble', d: 'M4 5h16v10H9l-5 4z' }),
          h('path', { key: 'line1', d: 'M8 9h8' }),
          h('path', { key: 'line2', d: 'M8 12h5' }),
        ],
        props,
      );
    }

    function IconSearch(props) {
      return svg(
        [
          h('circle', { key: 'c', cx: 11, cy: 11, r: 6 }),
          h('path', { key: 'l', d: 'M16 16l5 5' }),
        ],
        props,
      );
    }

    function IconDownload(props) {
      return svg(
        [
          h('path', { key: 'd', d: 'M12 3v12M7 10l5 5 5-5' }),
          h('path', { key: 'b', d: 'M4 19h16' }),
        ],
        props,
      );
    }

    function IconMoon(props) {
      return svg(
        [h('path', { key: 'm', d: 'M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z' })],
        props,
      );
    }

    function IconList(props) {
      return svg(
        [
          h('path', { key: 'l1', d: 'M4 6h16' }),
          h('path', { key: 'l2', d: 'M4 12h11' }),
          h('path', { key: 'l3', d: 'M4 18h14' }),
        ],
        props,
      );
    }

    function IconCrop(props) {
      return svg(
        [
          h('path', { key: 'tl', d: 'M7 3v4H3' }),
          h('path', { key: 'br', d: 'M17 21v-4h4' }),
          h('path', { key: 'tr', d: 'M3 7h4V3' }),
          h('path', { key: 'bl', d: 'M21 17h-4v4' }),
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
.dl-preview { position:relative; display:flex; flex-direction:column; height:100%; min-height:0; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); }
.dl-preview-bar { display:flex; align-items:center; gap:5px; flex-wrap:wrap; padding:6px 8px; border-bottom:1px solid var(--dsw-alias-border-l1); flex:0 0 auto; background:var(--dsw-alias-bg-base); }
.dl-preview-scroll { position:relative; flex:1 1 auto; min-height:0; overflow:auto; padding:12px 8px 24px; background:var(--dsw-alias-bg-layer-2); }
.dl-page { position:relative; margin:0 auto 12px; background:#fff; box-shadow:0 1px 5px rgba(0,0,0,.28); overflow:hidden; border-radius:1px; }
.dl-page canvas { display:block; width:100%; height:100%; }
.dl-page-ph { display:flex; align-items:center; justify-content:center; color:#9aa0a6; font-size:11px; background:#fbfbfb; }
.dl-page-no { position:absolute; right:4px; bottom:4px; font-size:9px; color:#b9bcc2; pointer-events:none; }
.dl-sync-mark { position:absolute; width:34px; height:34px; margin:-17px 0 0 -17px; border:2px solid #e39a2d; border-radius:50%; background:rgba(227,154,45,.16); box-shadow:0 0 0 5px rgba(227,154,45,.13); pointer-events:none; z-index:4; animation:dl-sync-pulse 1.3s ease-out 2; }
@keyframes dl-sync-pulse { 0% { transform:scale(.55); opacity:.3; } 55% { opacity:1; } 100% { transform:scale(1); opacity:.85; } }
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
.dl-editor-auto { color:var(--dsw-alias-label-secondary); font-size:10.5px; white-space:nowrap; border:1px solid var(--dsw-alias-border-l1); border-radius:999px; padding:1px 6px; }
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
.dl-outline { flex:0 0 190px; max-width:45%; overflow:auto; padding:6px; border-right:1px solid var(--dsw-alias-border-l1); display:flex; flex-direction:column; gap:1px; background:var(--dsw-alias-bg-base); }
.dl-outline button { text-align:left; font:inherit; font-size:11px; line-height:1.45; color:var(--dsw-alias-label-secondary); background:transparent; border:0; border-radius:4px; padding:2px 5px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dl-outline button:hover { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }
.dl-cm { flex:1 1 auto; min-width:0; min-height:0; display:flex; overflow:hidden; }
.dl-cm .cm-editor { flex:1 1 auto; height:100%; background:transparent; color:var(--dsw-alias-label-primary); }
.dl-cm .cm-scroller { overflow:auto; font-family:var(--dsw-font-mono, ui-monospace, monospace); font-size:12px; line-height:1.55; }
.dl-cm .cm-gutters { background:var(--dsw-alias-bg-base); border-right:1px solid var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }
.dl-cm .cm-activeLine, .dl-cm .cm-activeLineGutter { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent); }
.dl-cm .cm-selectionBackground, .dl-cm .cm-content ::selection { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 26%, transparent) !important; }
.dl-cm .cm-content { caret-color:var(--dsw-alias-brand-primary); }
.dl-cm .cm-cursor { border-left-color:var(--dsw-alias-brand-primary); }
.dl-page canvas { position:relative; z-index:0; }
.dl-textlayer { position:absolute; inset:0; overflow:hidden; line-height:1; z-index:2; }
.dl-textlayer span { position:absolute; white-space:pre; color:transparent; transform-origin:0% 0%; cursor:text; }
.dl-textlayer span::selection { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent); color:transparent; }
.dl-anno-layer { position:absolute; inset:0; z-index:1; pointer-events:none; }
.dl-anno-mark { position:absolute; border-radius:2px; background:color-mix(in srgb, #f5c542 30%, transparent); border-bottom:2px solid color-mix(in srgb, #f5c542 85%, transparent); }
.dl-anno-mark.stale { background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 22%, transparent); border-bottom-color:var(--dsw-alias-state-warn-primary); }
.dl-anno-mark.resolved { background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 15%, transparent); border-bottom-color:var(--dsw-alias-state-success-primary); }
.dl-selpop { position:fixed; z-index:80; width:282px; max-width:calc(100vw - 24px); display:flex; flex-direction:column; gap:7px; padding:9px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:9px; background:var(--dsw-alias-bg-overlay); box-shadow:0 6px 24px rgba(0,0,0,.32); font-size:12px; }
.dl-selpop-quote { max-height:64px; overflow:auto; padding:5px 7px; border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); font-size:11px; line-height:1.5; }
.dl-selpop-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
.dl-selpop textarea { width:100%; box-sizing:border-box; min-height:54px; max-height:140px; resize:vertical; padding:6px 7px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; line-height:1.5; }
.dl-selpop textarea:focus { outline:1px solid var(--dsw-alias-brand-primary); }
.dl-anno-panel { position:absolute; right:8px; top:42px; z-index:70; width:min(340px, calc(100% - 16px)); max-height:62%; display:flex; flex-direction:column; gap:6px; padding:9px; border:1px solid var(--dsw-alias-border-l1); border-radius:9px; background:var(--dsw-alias-bg-overlay); box-shadow:0 6px 24px rgba(0,0,0,.3); overflow:auto; }
.dl-audit-panel { width:min(430px, calc(100% - 16px)); max-height:72%; }
.dl-toc-panel { width:min(360px, calc(100% - 16px)); max-height:70%; }
.dl-toc-item { text-align:left; font:inherit; font-size:11.5px; line-height:1.5; color:var(--dsw-alias-label-primary); background:transparent; border:0; border-radius:4px; padding:3px 6px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.dl-toc-item:hover { background:var(--dsw-alias-bg-layer-1); }
.dl-searchbar { position:absolute; top:42px; left:8px; right:8px; z-index:75; display:flex; flex-wrap:wrap; gap:6px; align-items:center; padding:7px 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:9px; background:var(--dsw-alias-bg-overlay); box-shadow:0 6px 24px rgba(0,0,0,.3); }
.dl-searchbar input { flex:1 1 160px; min-width:120px; padding:5px 7px; border-radius:6px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font:inherit; font-size:12px; }
.dl-ocr-prompt { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:4px 0; font-size:11px; color:var(--dsw-alias-label-secondary); }
.dl-ocr-prompt .dl-btn { font-size:11px; }
.dl-ocr-prompt progress { width:90px; height:5px; }
.dl-search-hits { flex:1 0 100%; display:flex; flex-direction:column; gap:2px; max-height:170px; overflow:auto; }
.dl-search-hit { display:flex; gap:7px; align-items:baseline; text-align:left; font:inherit; font-size:11px; color:var(--dsw-alias-label-secondary); background:transparent; border:0; border-radius:4px; padding:3px 5px; cursor:pointer; }
.dl-search-hit:hover { background:var(--dsw-alias-bg-layer-1); }
.dl-search-page { flex:0 0 auto; color:var(--dsw-alias-brand-primary); }
.dl-dark .dl-page canvas { filter: invert(0.92) hue-rotate(180deg) contrast(0.92); }
.dl-dark .dl-anno-mark { mix-blend-mode: screen; }
.dl-toolchain { display:flex; align-items:center; gap:8px; flex-wrap:wrap; padding:6px 9px; border-bottom:1px solid var(--dsw-alias-border-l1); background:color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); font-size:11.5px; color:var(--dsw-alias-label-primary); }
.dl-toolchain .dl-flex1 { flex:1 1 auto; }
.dl-toolchain progress { width:120px; height:6px; }
.dl-anno-head { display:flex; align-items:center; gap:6px; font-weight:600; font-size:12px; }
.dl-anno-item { display:flex; flex-direction:column; gap:3px; padding:6px 7px; border-radius:6px; background:var(--dsw-alias-bg-layer-1); border:1px solid var(--dsw-alias-border-l1); }
.dl-anno-item-meta { display:flex; align-items:center; gap:5px; font-size:10.5px; color:var(--dsw-alias-label-secondary); }
.dl-anno-item-quote { font-size:11.5px; line-height:1.45; color:var(--dsw-alias-label-primary); }
.dl-anno-item-comment { font-size:11px; line-height:1.45; color:var(--dsw-alias-label-secondary); }
.dl-anno-badge { min-width:15px; height:15px; box-sizing:border-box; border-radius:999px; padding:0 4px; display:inline-flex; align-items:center; justify-content:center; background:var(--dsw-alias-brand-primary); color:#fff; font-size:9.5px; line-height:1; }
.dl-anno-hint { font-size:11px; line-height:1.5; color:var(--dsw-alias-label-secondary); }
.dl-iconbtn { position:relative; }
.dl-iconbtn .dl-anno-badge { position:absolute; top:-2px; right:-2px; }
.dl-iconbtn.active { background:color-mix(in srgb, var(--dsw-alias-brand-primary) 16%, transparent); color:var(--dsw-alias-brand-primary); }
.dl-cropping .dl-textlayer { pointer-events:none; }
.dl-crop-layer { position:absolute; inset:0; z-index:4; cursor:crosshair; }
.dl-crop-box { position:absolute; border:1.5px dashed var(--dsw-alias-brand-primary); background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent); pointer-events:none; }
.dl-selpop-image { width:100%; max-height:150px; object-fit:contain; border-radius:6px; border:1px solid var(--dsw-alias-border-l1); background:#fff; }
.dl-anno-thumb { width:100%; max-height:90px; object-fit:contain; border-radius:5px; border:1px solid var(--dsw-alias-border-l1); background:#fff; }
.dl-anno-item-actions { display:flex; gap:6px; justify-content:flex-end; margin-top:2px; }
.dl-anno-item-actions .dl-btn { padding:4px 7px; font-size:11px; }
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

    let codeMirrorPromise;
    function loadCodeMirror() {
      if (!codeMirrorPromise) {
        codeMirrorPromise = import('/latex/assets/codemirror.mjs')
          .catch((error) => {
            codeMirrorPromise = undefined;
            throw error;
          });
      }
      return codeMirrorPromise;
    }

    function draftKey(filePath) {
      return `dsh-latex-draft:${String(filePath ?? '')}`;
    }

    /** Section outline for the editor (part/chapter/section...). */
    function parseLatexOutline(text) {
      const outline = [];
      const lines = String(text ?? '').split('\n');
      const pattern = /^\s*\\(part|chapter|section|subsection|subsubsection)\*?\s*\{([^{}]*)\}/;
      const levels = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4 };
      for (let index = 0; index < lines.length; index += 1) {
        const match = pattern.exec(lines[index]);
        if (!match) continue;
        outline.push({
          level: levels[match[1]] ?? 2,
          title: match[2].trim().slice(0, 160),
          line: index + 1,
        });
      }
      return outline;
    }

    const VIEW_STORAGE_PREFIX = 'dsh-latex-view:';
    function savedView(projectId) {
      if (!projectId) return {};
      if (viewStates.has(projectId)) return viewStates.get(projectId);
      let value = {};
      try {
        const raw = window.localStorage.getItem(VIEW_STORAGE_PREFIX + projectId);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') value = parsed;
        }
      } catch {
        // Storage is optional.
      }
      viewStates.set(projectId, value);
      return value;
    }

    function persistView(projectId, patch) {
      if (!projectId) return;
      const next = { ...savedView(projectId), ...patch };
      viewStates.set(projectId, next);
      try {
        window.localStorage.setItem(VIEW_STORAGE_PREFIX + projectId, JSON.stringify(next));
      } catch {
        // Quota / private mode is not fatal.
      }
    }

    /* ------------------------------------------------------------------ */
    /* PDF text layer, selection and annotations                           */
    /* ------------------------------------------------------------------ */

    function clamp01(value) {
      if (!Number.isFinite(value)) return 0;
      return Math.max(0, Math.min(1, value));
    }

    /**
     * Build a selectable text layer over one rendered page.
     *
     * pdf.js renders the glyphs into a canvas; this layer carries transparent
     * spans at the same positions so the user (and the browser) can select the
     * text. It deliberately does not use pdf.js's viewer CSS: the plugin has no
     * viewer stylesheet, and the span placement is only a handful of lines.
     */
    async function renderTextLayer(pdfjs, pdfPage, viewport, pageElement, isCurrent) {
      let layer = pageElement.querySelector('.dl-textlayer');
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'dl-textlayer';
        pageElement.appendChild(layer);
      }
      layer.innerHTML = '';
      layer.style.width = `${viewport.width}px`;
      layer.style.height = `${viewport.height}px`;
      let content;
      try {
        content = await pdfPage.getTextContent();
      } catch {
        return;
      }
      if (!isCurrent()) return;
      const fragment = document.createDocumentFragment();
      for (const item of content.items ?? []) {
        if (typeof item.str !== 'string' || item.str === '') continue;
        const tx = pdfjs.Util.transform(viewport.transform, item.transform);
        const fontHeight = Math.hypot(tx[2], tx[3]);
        if (!Number.isFinite(fontHeight) || fontHeight <= 0) continue;
        const angle = Math.atan2(tx[1], tx[0]);
        const span = document.createElement('span');
        span.textContent = item.str;
        span.style.left = `${tx[4]}px`;
        span.style.top = `${tx[5] - fontHeight}px`;
        span.style.fontSize = `${fontHeight}px`;
        span.style.fontFamily = 'sans-serif';
        if (angle) span.style.transform = `rotate(${angle}rad)`;
        // A PDF text item that ends a line carries no trailing newline; tag it
        // so selection reconstruction can put the break back.
        if (item.hasEOL) span.dataset.eol = '1';
        fragment.appendChild(span);
      }
      if (!isCurrent()) return;
      layer.appendChild(fragment);
    }

    /** Rebuild readable text from a cloned selection fragment (keeps line breaks). */
    function selectionFragmentText(range) {
      let text = '';
      const walk = (node) => {
        if (node.nodeType === 3) {
          text += node.nodeValue ?? '';
          return;
        }
        if (node.nodeName === 'BR') {
          text += '\n';
          return;
        }
        for (const child of node.childNodes ?? []) walk(child);
        if (node.nodeName === 'SPAN' && node.dataset?.eol === '1') text += '\n';
      };
      walk(range.cloneContents());
      return text;
    }

    /**
     * Reconstruct readable text from the selected text-layer spans.
     *
     * `Selection.toString()` concatenates absolutely positioned spans without
     * whitespace, which turns "Hello from" into "Hellofrom" and destroys the
     * quote used for annotation re-anchoring. Geometry gives the separators:
     * a new line when the top changes, a space when there is a word-sized gap.
     */
    function selectionSpansText(range, layer) {
      const spans = [...layer.querySelectorAll('span')].filter((span) => {
        try {
          return range.intersectsNode(span);
        } catch {
          return false;
        }
      });
      if (spans.length === 0) return '';
      let text = '';
      let previous;
      for (const span of spans) {
        let piece;
        if (span.contains(range.startContainer) || span.contains(range.endContainer)) {
          const pieceRange = document.createRange();
          const startsHere = span.contains(range.startContainer);
          const endsHere = span.contains(range.endContainer);
          if (startsHere && endsHere) {
            pieceRange.setStart(range.startContainer, range.startOffset);
            pieceRange.setEnd(range.endContainer, range.endOffset);
          } else if (startsHere) {
            pieceRange.setStart(range.startContainer, range.startOffset);
            pieceRange.setEnd(span, span.childNodes.length);
          } else {
            pieceRange.setStart(span, 0);
            pieceRange.setEnd(range.endContainer, range.endOffset);
          }
          piece = pieceRange.toString();
        } else {
          piece = span.textContent ?? '';
        }
        const rect = span.getBoundingClientRect();
        if (previous && rect.width > 0) {
          const lineHeight = Math.max(1, Math.min(rect.height, previous.height) || rect.height);
          if (Math.abs(rect.top - previous.top) > lineHeight * 0.5) text += '\n';
          else if (rect.left - previous.right > Math.max(1, lineHeight * 0.12)) text += ' ';
        }
        text += piece;
        if (rect.width > 0) previous = rect;
      }
      return text;
    }

    /** Read the current DOM selection when it belongs to one rendered page. */
    function readPageSelection(pageElement, scale) {
      const selection = typeof window.getSelection === 'function' ? window.getSelection() : undefined;
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
      const range = selection.getRangeAt(0);
      if (!pageElement.contains(range.commonAncestorContainer)) return undefined;
      const layer = pageElement.querySelector('.dl-textlayer');
      const rawQuote =
        (layer ? selectionSpansText(range, layer) : '') ||
        selectionFragmentText(range) ||
        String(selection.toString() ?? '');
      const quote = rawQuote
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      if (quote.length < 2) return undefined;
      const pageRect = pageElement.getBoundingClientRect();
      if (pageRect.width < 1 || pageRect.height < 1) return undefined;
      const rects = [];
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        const x = (rect.left - pageRect.left) / pageRect.width;
        const y = (rect.top - pageRect.top) / pageRect.height;
        const w = rect.width / pageRect.width;
        const h = rect.height / pageRect.height;
        if (x < -0.02 || y < -0.02) continue;
        rects.push({ x: clamp01(x), y: clamp01(y), w: clamp01(w), h: clamp01(h) });
        if (rects.length >= 20) break;
      }
      if (rects.length === 0) return undefined;
      const last = range.getBoundingClientRect();
      const pointX = (last.left + last.width / 2 - pageRect.left) / scale;
      const pointY = (last.top + last.height / 2 - pageRect.top) / scale;
      return {
        quote: quote.slice(0, 4000),
        page: Number(pageElement.dataset.page) || 1,
        rects,
        point: { x: Math.max(0, pointX), y: Math.max(0, pointY) },
        x: Math.min(Math.max(8, last.left), Math.max(8, window.innerWidth - 300)),
        y: Math.min(Math.max(8, last.bottom + 8), Math.max(8, window.innerHeight - 220)),
        stage: 'menu',
        mode: 'ask',
      };
    }

    /** Paint annotation rectangles for one page (normalized page coordinates). */
    function paintAnnotationMarks(pageElement, pageNumber, items) {
      if (!pageElement) return;
      let layer = pageElement.querySelector('.dl-anno-layer');
      if (!layer) {
        layer = document.createElement('div');
        layer.className = 'dl-anno-layer';
        pageElement.insertBefore(layer, pageElement.querySelector('.dl-textlayer'));
      }
      layer.innerHTML = '';
      for (const item of items ?? []) {
        if (Number(item.page) !== pageNumber) continue;
        for (const rect of item.rects ?? []) {
          const mark = document.createElement('div');
          mark.className = `dl-anno-mark ${item.status === 'stale' ? 'stale' : item.status === 'resolved' ? 'resolved' : ''}`;
          mark.style.left = `${clamp01(rect.x) * 100}%`;
          mark.style.top = `${clamp01(rect.y) * 100}%`;
          mark.style.width = `${clamp01(rect.w) * 100}%`;
          mark.style.height = `${Math.max(0.004, clamp01(rect.h)) * 100}%`;
          mark.title = `${item.quote ?? ''}${item.comment ? ` — ${item.comment}` : ''}`;
          layer.appendChild(mark);
        }
      }
    }

    async function writeClipboard(text) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        // Fall through to the legacy path (clipboard API needs a secure context).
      }
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.setAttribute('readonly', '');
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        const ok = document.execCommand('copy');
        area.remove();
        return Boolean(ok);
      } catch {
        return false;
      }
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
      const [syncMark, setSyncMark] = useState(undefined);
      const [selection, setSelection] = useState(null);
      const [selectionText, setSelectionText] = useState('');
      const [annotations, setAnnotations] = useState({
        items: [],
        counts: { total: 0, open: 0, resolved: 0, stale: 0 },
        buildVersion: 0,
        reanchorAvailable: false,
      });
      const [annotationsOpen, setAnnotationsOpen] = useState(false);
      const [sending, setSending] = useState(false);
      const [cropMode, setCropMode] = useState(false);
      const [cropDrag, setCropDrag] = useState(null);
      const [auditOpen, setAuditOpen] = useState(false);
      const [auditHistory, setAuditHistory] = useState({ entries: [], currentVersion: 0 });
      const [auditAgainst, setAuditAgainst] = useState('auto');
      const [auditResult, setAuditResult] = useState(null);
      const [auditRunning, setAuditRunning] = useState(false);
      const [toc, setToc] = useState([]);
      const [tocOpen, setTocOpen] = useState(false);
      const [darkMode, setDarkMode] = useState(Boolean(savedView(projectId).dark));
      const [searchOpen, setSearchOpen] = useState(false);
      const [searchQuery, setSearchQuery] = useState('');
      const [searchHits, setSearchHits] = useState([]);
      const [searching, setSearching] = useState(false);
      const searchInputRef = useRef(null);
      const annotationsRef = useRef(annotations);
      annotationsRef.current = annotations;
      const selectionInputRef = useRef(null);
      const docRef = useRef(null);
      const loadingRef = useRef(null);
      const containerRef = useRef(null);
      const pagesRef = useRef({});
      const pageElsRef = useRef({});
      const observerRef = useRef(null);
      const pendingRestoreRef = useRef(params?.page ?? initialView.page ?? 1);
      const toastTimerRef = useRef(undefined);
      // Ctrl+单击用于反查后，紧随其后的 mouseup 不应该再触发选词浮层。
      const suppressSelectRef = useRef(false);
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
            // Annotation marks sit under the text layer; the text layer follows
            // the canvas asynchronously (it must ask pdf.js for the strings).
            paintAnnotationMarks(record.element, pageNumber, annotationsRef.current.items);
            loadPdfjs()
              .then((pdfjs) => {
                if (!pdfjs?.Util) return;
                const current = () =>
                  Boolean(record.element) && docRef.current === doc && record.generation === generation;
                renderTextLayer(pdfjs, pdfPage, viewport, record.element, current).catch(() => {});
              })
              .catch(() => {});
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
            persistView(projectId, { page: current, zoomMode, zoomPercent });
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
            persistView(projectId, { page: pageNumber, zoomMode, zoomPercent });
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
        if (!Number.isFinite(requested) || requested < 1) return;
        pendingRestoreRef.current = requested;
        goToPage(requested);
        const markX = Number(params?.x);
        const markY = Number(params?.y);
        // 正向定位会带上 PDF 坐标：跳页后在那一点画一个短时高亮环。
        if (Number.isFinite(markX) && Number.isFinite(markY)) {
          setSyncMark({ page: requested, x: markX, y: markY });
        }
      }, [params?.page, params?.x, params?.y, params?.syncToken, revision, docInfo.status, docInfo.numPages]);

      // 高亮环只存在一小会儿，不拦截鼠标事件。
      useEffect(() => {
        if (!syncMark) return undefined;
        const timer = setTimeout(() => setSyncMark(undefined), 2600);
        return () => clearTimeout(timer);
      }, [syncMark]);

      // Ctrl（macOS 上 Cmd）+ 单击页面：反查这一点对应的源码行并跳过去。
      const revealSourceAt = useCallback(
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
            // 会话 cwd 缺失时退到项目根目录：否则会把绝对路径拼进 session 地址。
            const address = sessionFileAddress(sessionId, cwd || project?.rootDir, result.file);
            const line = result.line ?? 1;
            // 只有真的打开了标签才算定位成功：面板服务不可用时 openResource 返回 false。
            const opened = openResource(address, { params: { line, syncToken: Date.now() } });
            if (!opened) throw new Error(t('preview.syncOpenFailed'));
            focusResourceTab(sessionId, address);
            if (typeof console !== 'undefined') {
              console.info('[dsh-latex] SyncTeX inverse ->', address, `:${line}`);
            }
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

      // PDF table of contents (pdf.js outline; nested entries flattened).
      useEffect(() => {
        if (docInfo.status !== 'ready') return undefined;
        const doc = docRef.current;
        if (!doc) return undefined;
        let cancelled = false;
        (async () => {
          try {
            const raw = await doc.getOutline();
            if (!raw || raw.length === 0) {
              if (!cancelled) setToc([]);
              return;
            }
            const items = [];
            const pageFor = async (dest) => {
              let target = dest;
              if (typeof target === 'string') target = await doc.getDestination(target);
              if (!Array.isArray(target) || target.length === 0) return undefined;
              try {
                return (await doc.getPageIndex(target[0])) + 1;
              } catch {
                return undefined;
              }
            };
            const walk = async (nodes, depth) => {
              for (const node of nodes) {
                const page = await pageFor(node.dest);
                if (node.title) items.push({ title: String(node.title), page, depth });
                if (Array.isArray(node.items) && node.items.length > 0) {
                  await walk(node.items, depth + 1);
                }
              }
            };
            await walk(raw, 0);
            if (!cancelled) setToc(items);
          } catch {
            if (!cancelled) setToc([]);
          }
        })();
        return () => {
          cancelled = true;
        };
      }, [docInfo.status, version, reloadToken]);

      const runSearch = useCallback(async () => {
        const query = searchQuery.trim();
        const doc = docRef.current;
        if (!query || !doc) return;
        setSearching(true);
        const hits = [];
        try {
          const needle = query.toLowerCase();
          for (let pageNumber = 1; pageNumber <= doc.numPages && hits.length < 50; pageNumber += 1) {
            const page = await doc.getPage(pageNumber);
            const content = await page.getTextContent();
            const text = content.items
              .map((item) => (typeof item.str === 'string' ? item.str : ''))
              .join(' ')
              .replace(/\s+/g, ' ');
            const lower = text.toLowerCase();
            let index = lower.indexOf(needle);
            while (index >= 0 && hits.length < 50) {
              hits.push({
                page: pageNumber,
                snippet: text.slice(Math.max(0, index - 36), index + query.length + 36).trim(),
              });
              index = lower.indexOf(needle, index + needle.length);
            }
          }
        } catch {
          // A broken page must not break the whole search.
        }
        setSearchHits(hits);
        setSearching(false);
      }, [searchQuery]);

      const downloadPdf = useCallback(async () => {
        if (!projectId) return;
        try {
          const response = await fetch(
            `/latex/pdf?project=${encodeURIComponent(projectId)}&v=${version}`,
            { cache: 'no-store' },
          );
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const blob = await response.blob();
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement('a');
          anchor.href = url;
          anchor.download = `${(project?.mainFile ?? 'document').split(/[\\/]/).pop() ?? 'document'}.pdf`;
          document.body.appendChild(anchor);
          anchor.click();
          anchor.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 5000);
        } catch (failure) {
          showToast(`${t('action.preview')}: ${String(failure?.message ?? failure)}`);
        }
      }, [projectId, version, project?.mainFile, showToast, t]);

      useEffect(() => {
        const handler = (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === 'f') {
            event.preventDefault();
            setSearchOpen(true);
            window.setTimeout(() => searchInputRef.current?.focus(), 0);
          } else if (event.key === 'Escape' && searchOpen) {
            setSearchOpen(false);
          }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
      }, [searchOpen]);

      const loadAnnotations = useCallback(async () => {
        if (!projectId) {
          setAnnotations({
            items: [],
            counts: { total: 0, open: 0, resolved: 0, stale: 0 },
            buildVersion: 0,
            reanchorAvailable: false,
          });
          return;
        }
        try {
          const response = await fetch(`/latex/annotations?project=${encodeURIComponent(projectId)}`, {
            cache: 'no-store',
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
          setAnnotations({
            items: Array.isArray(payload.items) ? payload.items : [],
            counts: payload.counts ?? { total: 0, open: 0, resolved: 0, stale: 0 },
            buildVersion: payload.buildVersion ?? 0,
            reanchorAvailable: payload.reanchorAvailable === true,
          });
        } catch {
          // Annotations are optional preview metadata; a failed load must not
          // take the PDF viewer down.
        }
      }, [projectId]);

      const loadAuditHistory = useCallback(async () => {
        if (!projectId) {
          setAuditHistory({ entries: [], currentVersion: 0 });
          return;
        }
        try {
          const response = await fetch(`/latex/history?project=${encodeURIComponent(projectId)}`, {
            cache: 'no-store',
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
          setAuditHistory({
            entries: Array.isArray(payload.entries) ? payload.entries : [],
            currentVersion: payload.currentVersion ?? 0,
          });
        } catch {
          setAuditHistory({ entries: [], currentVersion: 0 });
        }
      }, [projectId]);

      const runAudit = useCallback(async () => {
        if (!projectId || auditRunning) return;
        setAuditRunning(true);
        setAuditResult(null);
        try {
          const body = {
            project: projectId,
            maxImages: Number(snapshot?.config?.auditMaxImages) || 3,
          };
          if (auditAgainst !== 'auto') body.against = auditAgainst;
          const response = await fetch('/latex/audit', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
          setAuditResult(payload);
        } catch (failure) {
          showToast(`${t('preview.audit')}: ${String(failure?.message ?? failure)}`);
        } finally {
          setAuditRunning(false);
          loadAuditHistory();
        }
      }, [projectId, auditRunning, auditAgainst, snapshot?.config?.auditMaxImages, showToast, t, loadAuditHistory]);

      const installOcr = useCallback(async () => {
        try {
          const response = await fetch('/latex/ocr/install', { method: 'POST' });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            showToast(payload?.message || payload?.error || `HTTP ${response.status}`);
          }
        } catch (failure) {
          showToast(String(failure?.message ?? failure));
        }
      }, [showToast]);

      const cancelOcr = useCallback(async () => {
        await fetch('/latex/ocr/cancel', { method: 'POST' }).catch(() => {});
      }, []);

      const toggleAuditPanel = useCallback(() => {
        setAuditOpen((open) => {
          const next = !open;
          if (next) {
            setAnnotationsOpen(false);
            setAuditResult(null);
            loadAuditHistory();
          }
          return next;
        });
      }, [loadAuditHistory]);

      // Reload annotations whenever the published build changes: the host
      // re-anchors old items by their quote during that read.
      useEffect(() => {
        loadAnnotations();
      }, [loadAnnotations, version]);

      // Repaint marks on zoom/annotation changes; renderPage repaints new pages.
      useEffect(() => {
        for (const [pageNumber, record] of Object.entries(pagesRef.current)) {
          paintAnnotationMarks(record?.element, Number(pageNumber), annotations.items);
        }
      }, [annotations, scale, docInfo.status]);

      useEffect(() => {
        if (selection?.stage === 'input' && selectionInputRef.current) {
          try {
            selectionInputRef.current.focus();
          } catch {
            // Focus is a nicety.
          }
        }
      }, [selection?.stage, selection?.mode]);

      // A rebuild or project switch invalidates the selection context.
      useEffect(() => {
        setSelection(null);
        setSelectionText('');
      }, [projectId, version]);

      const handlePageSelection = useCallback(
        (pageElement) => {
          if (!pageElement || cropMode) return;
          const info = readPageSelection(pageElement, scale);
          if (!info) return;
          setSelection(info);
          setSelectionText('');
        },
        [scale, cropMode],
      );

      /** Finish a marquee drag: crop the already-rendered canvas into a PNG. */
      const completeCrop = useCallback(
        (pageNumber, box, overlay) => {
          const record = pagesRef.current[pageNumber];
          // The canvas can outlive the record bookkeeping when a tab is
          // remounted; fall back to the element's own canvas.
          const canvas = record?.canvas ?? record?.element?.querySelector('canvas');
          if (!record?.element || !canvas || box.w < 8 || box.h < 8) return;
          const pageRect = overlay.getBoundingClientRect();
          if (pageRect.width < 1 || pageRect.height < 1) return;
          const ratio = canvas.width / pageRect.width;
          const sx = Math.max(0, box.x * ratio);
          const sy = Math.max(0, box.y * ratio);
          const sw = Math.max(1, Math.min(canvas.width - sx, box.w * ratio));
          const sh = Math.max(1, Math.min(canvas.height - sy, box.h * ratio));
          const maxEdge = 1600;
          const scaleDown = Math.min(1, maxEdge / Math.max(sw, sh));
          const out = document.createElement('canvas');
          out.width = Math.max(1, Math.round(sw * scaleDown));
          out.height = Math.max(1, Math.round(sh * scaleDown));
          const context = out.getContext('2d');
          if (!context) return;
          context.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
          let imageDataUrl;
          try {
            imageDataUrl = out.toDataURL('image/png');
          } catch {
            showToast(t('preview.imageTooLarge'));
            return;
          }
          const maxBytes = Number(snapshot?.config?.askImageMaxBytes) || 8 * 1024 * 1024;
          if (imageDataUrl.length * 0.75 > maxBytes) {
            showToast(t('preview.imageTooLarge'));
            return;
          }
          const normalized = {
            x: clamp01(box.x / pageRect.width),
            y: clamp01(box.y / pageRect.height),
            w: clamp01(box.w / pageRect.width),
            h: clamp01(box.h / pageRect.height),
          };
          const pageW = baseSize.width || 595;
          const pageH = baseSize.height || 842;
          setSelection({
            kind: 'image',
            quote: '',
            page: pageNumber,
            rects: [normalized],
            point: {
              x: (normalized.x + normalized.w / 2) * pageW,
              y: (normalized.y + normalized.h / 2) * pageH,
            },
            imageDataUrl,
            x: Math.min(Math.max(8, pageRect.left + box.x + box.w), Math.max(8, window.innerWidth - 300)),
            y: Math.min(Math.max(8, pageRect.top + box.y + box.h + 8), Math.max(8, window.innerHeight - 240)),
            stage: 'input',
            mode: 'ask',
          });
          setSelectionText('');
          setCropMode(false);
          setCropDrag(null);
        },
        [baseSize.width, baseSize.height, snapshot?.config?.askImageMaxBytes, showToast, t],
      );

      const cropStart = useCallback(
        (event, pageNumber) => {
          if (!cropMode) return;
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          const x = event.clientX - rect.left;
          const y = event.clientY - rect.top;
          setCropDrag({ page: pageNumber, startX: x, startY: y, x, y });
        },
        [cropMode],
      );

      const cropMove = useCallback(
        (event, pageNumber) => {
          if (!cropDrag || cropDrag.page !== pageNumber) return;
          const rect = event.currentTarget.getBoundingClientRect();
          setCropDrag({
            ...cropDrag,
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
          });
        },
        [cropDrag],
      );

      const cropEnd = useCallback(
        (event, pageNumber) => {
          if (!cropDrag || cropDrag.page !== pageNumber) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
          const y = Math.max(0, Math.min(rect.height, event.clientY - rect.top));
          const box = {
            x: Math.min(cropDrag.startX, x),
            y: Math.min(cropDrag.startY, y),
            w: Math.abs(x - cropDrag.startX),
            h: Math.abs(y - cropDrag.startY),
          };
          setCropDrag(null);
          completeCrop(pageNumber, box, event.currentTarget);
        },
        [cropDrag, completeCrop],
      );

      const sendSelection = useCallback(async () => {
        const current = selection;
        if (!current || sending) return;
        setSending(true);
        try {
          if (current.imageDataUrl) {
            const response = await fetch('/latex/ask-image', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                sessionId,
                project: projectId,
                page: current.page,
                question: selectionText.trim(),
                image: current.imageDataUrl,
              }),
            });
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
            showToast(t('preview.screenshotSent'));
            setSelection(null);
            setSelectionText('');
            return;
          }
          let source;
          try {
            const response = await fetch('/latex/synctex-inverse', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                project: projectId,
                page: current.page,
                x: current.point.x,
                y: current.point.y,
              }),
            });
            const payload = await response.json().catch(() => ({}));
            if (response.ok && payload?.synctex?.ok) {
              source = { file: payload.synctex.file, line: payload.synctex.line };
            }
          } catch {
            // The source hint is optional; the quote still carries the context.
          }
          const response = await fetch('/latex/ask', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              sessionId,
              project: projectId,
              page: current.page,
              quote: current.quote,
              question: selectionText.trim(),
              source,
              point: current.point,
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
          showToast(t('preview.askSent'));
          setSelection(null);
          setSelectionText('');
        } catch (failure) {
          const text = `${current.quote || t('preview.imageAnnotation')}\n\n${t('preview.page')} ${
            current.page
          }${project?.mainFile ? ` · ${project.mainFile}` : ''}`;
          const copied = await writeClipboard(text);
          showToast(
            copied
              ? t('preview.askCopied')
              : `${t('preview.askFailed')}: ${String(failure?.message ?? failure)}`,
          );
        } finally {
          setSending(false);
        }
      }, [selection, sending, projectId, sessionId, selectionText, showToast, t, project?.mainFile]);

      const saveSelectionAnnotation = useCallback(async () => {
        const current = selection;
        if (!current || sending) return;
        setSending(true);
        try {
          const response = await fetch('/latex/annotations', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              project: projectId,
              page: current.page,
              quote: current.quote || '',
              comment: selectionText.trim(),
              rects: current.rects,
              ...(current.imageDataUrl ? { image: current.imageDataUrl } : {}),
            }),
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
          if (payload?.annotations) {
            setAnnotations({
              items: Array.isArray(payload.annotations.items) ? payload.annotations.items : [],
              counts: payload.annotations.counts ?? { total: 0, open: 0, resolved: 0, stale: 0 },
              buildVersion: payload.annotations.buildVersion ?? 0,
              reanchorAvailable: payload.annotations.reanchorAvailable === true,
            });
          }
          showToast(t('preview.annotationSaved'));
          setSelection(null);
          setSelectionText('');
        } catch (failure) {
          showToast(`${t('preview.annotationFailed')}: ${String(failure?.message ?? failure)}`);
        } finally {
          setSending(false);
        }
      }, [selection, sending, projectId, selectionText, showToast, t]);

      const clearResolvedAnnotations = useCallback(async () => {
        if (!projectId) return;
        try {
          await fetch(`/latex/annotations?project=${encodeURIComponent(projectId)}&all=0`, {
            method: 'DELETE',
          });
        } catch {
          // Reload below reflects whatever the host actually has.
        }
        await loadAnnotations();
      }, [projectId, loadAnnotations]);

      const deleteAnnotation = useCallback(
        async (id) => {
          if (!projectId) return;
          if (typeof window.confirm === 'function' && !window.confirm(t('preview.deleteConfirm'))) return;
          try {
            const response = await fetch(
              `/latex/annotations?project=${encodeURIComponent(projectId)}&id=${encodeURIComponent(id)}`,
              { method: 'DELETE' },
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
            if (payload?.annotations) {
              setAnnotations({
                items: Array.isArray(payload.annotations.items) ? payload.annotations.items : [],
                counts: payload.annotations.counts ?? { total: 0, open: 0, resolved: 0, stale: 0 },
                buildVersion: payload.annotations.buildVersion ?? 0,
                reanchorAvailable: payload.annotations.reanchorAvailable === true,
              });
            }
          } catch (failure) {
            showToast(`${t('preview.annotationFailed')}: ${String(failure?.message ?? failure)}`);
          }
        },
        [projectId, t, showToast],
      );

      // Preview keyboard shortcuts. Inputs keep their normal keys except Esc and
      // Ctrl/Cmd+Enter, which act on the pending selection.
      useEffect(() => {
        const handler = (event) => {
          const target = event.target;
          const editing = Boolean(
            target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable),
          );
          if (event.key === 'Escape') {
            if (selection) {
              if (selection.stage === 'input' && selection.kind !== 'image') {
                setSelection({ ...selection, stage: 'menu' });
                setSelectionText('');
              } else {
                setSelection(null);
                setSelectionText('');
              }
              return;
            }
            if (annotationsOpen) {
              setAnnotationsOpen(false);
              return;
            }
            if (cropMode) {
              setCropMode(false);
              setCropDrag(null);
            }
            return;
          }
          if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            if (selection?.stage === 'input' && !sending) {
              event.preventDefault();
              if (selection.kind === 'image' || selection.mode === 'ask') sendSelection();
              else saveSelectionAnnotation();
            }
            return;
          }
          if (event.altKey && !editing && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
            event.preventDefault();
            goToPage(page + (event.key === 'ArrowRight' ? 1 : -1));
          }
        };
        window.addEventListener('keydown', handler);
        return () => window.removeEventListener('keydown', handler);
      }, [
        selection,
        annotationsOpen,
        cropMode,
        sending,
        sendSelection,
        saveSelectionAnnotation,
        goToPage,
        page,
      ]);


      const selectionPopover = selection
        ? h(
            'div',
            {
              className: 'dl-selpop',
              style: { left: `${selection.x}px`, top: `${selection.y}px` },
              role: 'dialog',
              'aria-label': t('preview.selected'),
              onMouseDown: (event) => {
                // Keep the document selection alive while a toolbar button is
                // pressed; the textarea still needs a normal focusable click.
                if (event.target?.closest?.('button')) event.preventDefault();
              },
            },
            h(
              'div',
              { className: 'dl-selpop-quote' },
              selection.imageDataUrl
                ? h('img', { className: 'dl-selpop-image', src: selection.imageDataUrl, alt: '' })
                : selection.quote.length > 260
                  ? `${selection.quote.slice(0, 260)}…`
                  : selection.quote,
            ),
            selection.stage === 'menu'
              ? h(
                  'div',
                  { className: 'dl-selpop-row' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dl-btn primary',
                      onClick: () => setSelection({ ...selection, stage: 'input', mode: 'ask' }),
                    },
                    h(IconNote),
                    h('span', null, t('preview.ask')),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dl-btn',
                      onClick: () => setSelection({ ...selection, stage: 'input', mode: 'annotate' }),
                    },
                    h(IconNote),
                    h('span', null, t('preview.annotate')),
                  ),
                  h('div', { className: 'dl-flex1' }),
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dl-iconbtn',
                      title: t('preview.close'),
                      onClick: () => setSelection(null),
                    },
                    '×',
                  ),
                )
              : h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '7px' } },
                  h('textarea', {
                    ref: selectionInputRef,
                    value: selectionText,
                    placeholder:
                      selection.kind === 'image'
                        ? t('preview.imageQuestionPlaceholder')
                        : selection.mode === 'ask'
                          ? t('preview.askPlaceholder')
                          : t('preview.annotatePlaceholder'),
                    onChange: (event) => setSelectionText(event.target.value),
                  }),
                  selection.kind === 'image'
                    ? h(
                        'div',
                        { className: 'dl-ocr-prompt' },
                        snapshot.ocr?.install?.state === 'installing'
                          ? [
                              h(
                                'span',
                                { key: 'ocr-progress' },
                                t('preview.ocrInstalling').replace(
                                  '{percent}',
                                  String(snapshot.ocr.install.percent ?? 0),
                                ),
                              ),
                              h('progress', {
                                key: 'ocr-progress-bar',
                                max: 100,
                                value: Number(snapshot.ocr.install.percent) || 0,
                              }),
                              h(
                                'button',
                                {
                                  key: 'ocr-cancel',
                                  type: 'button',
                                  className: 'dl-btn ghost',
                                  onClick: cancelOcr,
                                },
                                t('preview.ocrCancel'),
                              ),
                            ]
                          : snapshot.ocr?.available
                            ? h('span', null, t('preview.ocrReady'))
                            : snapshot.ocr?.install?.state === 'failed'
                              ? [
                                  h(
                                    'span',
                                    { key: 'ocr-failed' },
                                    `${t('preview.ocrFailed')}: ${
                                      snapshot.ocr.install.error?.message ?? ''
                                    }`,
                                  ),
                                  h(
                                    'button',
                                    {
                                      key: 'ocr-retry',
                                      type: 'button',
                                      className: 'dl-btn',
                                      onClick: installOcr,
                                    },
                                    t('preview.ocrInstall'),
                                  ),
                                ]
                              : [
                                  h('span', { key: 'ocr-missing' }, t('preview.ocrMissing')),
                                  h(
                                    'button',
                                    {
                                      key: 'ocr-install',
                                      type: 'button',
                                      className: 'dl-btn',
                                      onClick: installOcr,
                                    },
                                    t('preview.ocrInstall'),
                                  ),
                                ],
                      )
                    : null,
                  h(
                    'div',
                    { className: 'dl-selpop-row' },
                    selection.kind === 'image'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dl-btn primary',
                            disabled: sending,
                            onClick: sendSelection,
                          },
                          sending ? t('preview.sending') : t('preview.sendImage'),
                        )
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'dl-btn primary',
                            disabled: sending,
                            onClick: selection.mode === 'ask' ? sendSelection : saveSelectionAnnotation,
                          },
                          sending
                            ? t('preview.sending')
                            : selection.mode === 'ask'
                              ? t('preview.sendToChat')
                              : t('preview.saveAnnotation'),
                        ),
                    selection.kind === 'image'
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dl-btn',
                            disabled: sending,
                            onClick: saveSelectionAnnotation,
                          },
                          t('preview.saveImageAnnotation'),
                        )
                      : null,
                    selection.kind === 'image'
                      ? null
                      : h(
                          'button',
                          {
                            type: 'button',
                            className: 'dl-iconbtn',
                            title: t('preview.close'),
                            onClick: () => setSelection({ ...selection, stage: 'menu' }),
                          },
                          '‹',
                        ),
                    h('div', { className: 'dl-flex1' }),
                    selection.quote
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dl-btn ghost',
                            onClick: async () => {
                              const copied = await writeClipboard(selection.quote);
                              showToast(copied ? t('preview.askCopied') : t('preview.askFailed'));
                            },
                          },
                          t('preview.copySelection'),
                        )
                      : null,
                    h(
                      'button',
                      {
                        type: 'button',
                        className: 'dl-iconbtn',
                        title: t('preview.close'),
                        onClick: () => setSelection(null),
                      },
                      '×',
                    ),
                  ),
                ),
          )
        : null;

      const annotationsPanel = annotationsOpen
        ? h(
            'div',
            { className: 'dl-anno-panel' },
            h(
              'div',
              { className: 'dl-anno-head' },
              h(IconNote),
              h('span', null, `${t('preview.annotations')} · ${annotations.counts.total}`),
              h('div', { className: 'dl-flex1' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-iconbtn',
                  title: t('preview.close'),
                  onClick: () => setAnnotationsOpen(false),
                },
                '×',
              ),
            ),
            h('div', { className: 'dl-anno-hint' }, t('preview.annoHint')),
            annotations.items.length === 0
              ? h('div', { className: 'dl-anno-hint' }, t('preview.annotationsEmpty'))
              : null,
            ...annotations.items.slice(0, 100).map((item) =>
              h(
                'div',
                { className: 'dl-anno-item', key: item.id },
                h(
                  'div',
                  { className: 'dl-anno-item-meta' },
                  h('span', null, `${t('preview.page')} ${item.page}`),
                  h(
                    'span',
                    {
                      className: `dl-pill ${
                        item.status === 'open' ? 'busy' : item.status === 'stale' ? 'bad' : 'ok'
                      }`,
                    },
                    item.status === 'open'
                      ? t('preview.annoOpen')
                      : item.status === 'stale'
                        ? t('preview.annoStale')
                        : t('preview.annoResolved'),
                  ),
                  item.comment ? h('span', null, item.comment) : null,
                  item.image ? h('span', null, t('preview.imageAnnotation')) : null,
                ),
                item.image
                  ? h('img', {
                      className: 'dl-anno-thumb',
                      src: `/latex/annotation-image?project=${encodeURIComponent(projectId)}&id=${encodeURIComponent(item.id)}`,
                      alt: '',
                    })
                  : null,
                item.quote ? h('div', { className: 'dl-anno-item-quote' }, item.quote) : null,
                item.ocrText
                  ? h(
                      'div',
                      { className: 'dl-anno-item-comment' },
                      `${t('preview.ocr')}: ${item.ocrText.slice(0, 200)}`,
                    )
                  : null,
                item.staleReason ? h('div', { className: 'dl-anno-item-comment' }, item.staleReason) : null,
                h(
                  'div',
                  { className: 'dl-anno-item-actions' },
                  h(
                    'button',
                    {
                      type: 'button',
                      className: 'dl-btn',
                      onClick: () => deleteAnnotation(item.id),
                    },
                    t('preview.delete'),
                  ),
                ),
              ),
            ),
            h(
              'div',
              { className: 'dl-selpop-row' },
              h(
                'button',
                { type: 'button', className: 'dl-btn', onClick: loadAnnotations },
                t('action.reload'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn',
                  disabled: annotations.counts.resolved === 0,
                  onClick: clearResolvedAnnotations,
                },
                t('preview.clearResolved'),
              ),
            ),
          )
        : null;


      const auditProgress = project?.auditProgress;
      const auditPanel = auditOpen
        ? h(
            'div',
            { className: 'dl-anno-panel dl-audit-panel' },
            h(
              'div',
              { className: 'dl-anno-head' },
              h(IconAlert),
              h('span', null, t('preview.audit')),
              h('div', { className: 'dl-flex1' }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-iconbtn',
                  title: t('preview.close'),
                  onClick: () => setAuditOpen(false),
                },
                '×',
              ),
            ),
            h('div', { className: 'dl-anno-hint' }, t('preview.auditHint')),
            h(
              'select',
              {
                className: 'dl-zoom-select',
                value: auditAgainst,
                onChange: (event) => setAuditAgainst(event.target.value),
              },
              h('option', { value: 'auto' }, t('preview.auditAuto')),
              h('option', { value: 'previous' }, t('preview.auditPrevious')),
              ...auditHistory.entries
                .filter((entry) => !entry.current)
                .map((entry) =>
                  h(
                    'option',
                    { key: String(entry.version), value: String(entry.version) },
                    `v${entry.version} · ${entry.reason ?? 'build'} · ${
                      entry.builtAt ? new Date(entry.builtAt).toLocaleTimeString() : ''
                    }`,
                  ),
                ),
            ),
            h(
              'div',
              { className: 'dl-selpop-row' },
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn primary',
                  disabled: auditRunning || !projectId,
                  onClick: runAudit,
                },
                auditRunning ? t('preview.auditRunning') : t('preview.auditRun'),
              ),
              h(
                'button',
                { type: 'button', className: 'dl-btn', onClick: loadAuditHistory },
                t('action.reload'),
              ),
            ),
            auditRunning || auditProgress?.running
              ? h(
                  'div',
                  { className: 'dl-anno-hint' },
                  `${t('preview.auditRunning')} · ${t('preview.auditProgress')
                    .replace('{page}', String(auditProgress?.page ?? '—'))
                    .replace('{to}', String(auditProgress?.to ?? '—'))}`,
                )
              : null,
            auditHistory.entries.filter((entry) => !entry.current).length === 0
              ? h('div', { className: 'dl-anno-hint' }, t('preview.auditEmpty'))
              : null,
            auditResult
              ? h(
                  'div',
                  { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
                  auditResult.ok === false
                    ? h(
                        'div',
                        { className: 'dl-error' },
                        `${auditResult.code ?? 'ERROR'}: ${auditResult.message ?? ''}`,
                      )
                    : null,
                  auditResult.ok === true
                    ? h(
                        'div',
                        { className: 'dl-anno-hint' },
                        `changed ${auditResult.changed?.length ?? 0} · added ${
                          auditResult.added?.length ?? 0
                        } · removed ${auditResult.removed?.length ?? 0} · failed ${
                          auditResult.failed?.length ?? 0
                        }${
                          auditResult.baseline
                            ? ` · baseline ${
                                auditResult.baseline.version
                                  ? `v${auditResult.baseline.version} (${auditResult.baseline.reason ?? 'build'})`
                                  : auditResult.baseline.reason ?? 'previous'
                              }`
                            : ''
                        }`,
                      )
                    : null,
                  auditResult.truncated
                    ? h('div', { className: 'dl-anno-hint' }, t('preview.auditTruncated'))
                    : null,
                  ...(auditResult.changed ?? []).map((entry) =>
                    h(
                      'div',
                      { className: 'dl-anno-item', key: `changed-${entry.page}` },
                      h(
                        'div',
                        { className: 'dl-anno-item-meta' },
                        h('span', null, `${t('preview.page')} ${entry.page}`),
                        h('span', { className: 'dl-pill busy' }, t('preview.auditChanged')),
                        Number.isFinite(entry.changed)
                          ? h('span', null, `${(entry.ratio * 100).toFixed(2)}%`)
                          : null,
                      ),
                      entry.source
                        ? h(
                            'div',
                            { className: 'dl-anno-item-comment' },
                            `${entry.source.file}${entry.source.line ? `:${entry.source.line}` : ''}${
                              entry.source.approximate ? ' (approximate)' : ''
                            }`,
                          )
                        : null,
                    ),
                  ),
                  ...(auditResult.added ?? []).map((entry) =>
                    h(
                      'div',
                      { className: 'dl-anno-item', key: `added-${entry.page}` },
                      h(
                        'div',
                        { className: 'dl-anno-item-meta' },
                        h('span', null, `${t('preview.page')} ${entry.page}`),
                        h('span', { className: 'dl-pill ok' }, t('preview.auditAdded')),
                      ),
                    ),
                  ),
                  ...(auditResult.removed ?? []).map((entry) =>
                    h(
                      'div',
                      { className: 'dl-anno-item', key: `removed-${entry.page}` },
                      h(
                        'div',
                        { className: 'dl-anno-item-meta' },
                        h('span', null, `${t('preview.page')} ${entry.page}`),
                        h('span', { className: 'dl-pill bad' }, t('preview.auditRemoved')),
                      ),
                    ),
                  ),
                  ...(auditResult.images ?? []).map((image) =>
                    h(
                      'div',
                      { className: 'dl-anno-item', key: `image-${image.page}` },
                      h(
                        'div',
                        { className: 'dl-anno-item-meta' },
                        h('span', null, `${t('preview.page')} ${image.page}`),
                        h('span', null, t('preview.auditImages')),
                      ),
                      h('img', { className: 'dl-anno-thumb', src: image.url, alt: '' }),
                    ),
                  ),
                )
              : null,
          )
        : null;

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
        {
          className: `dl-preview${cropMode ? ' dl-cropping' : ''}${darkMode ? ' dl-dark' : ''}`,
        },
        h(LatexToolchainBanner, { t, snapshot }),
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
                  persistView(projectId, {
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
              className: `dl-iconbtn${auditOpen ? ' active' : ''}`,
              title: t('preview.audit'),
              onClick: toggleAuditPanel,
            },
            h(IconAlert),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dl-iconbtn',
              title: t('preview.annotations'),
              onClick: () =>
                setAnnotationsOpen((open) => {
                  const next = !open;
                  if (next) setAuditOpen(false);
                  return next;
                }),
            },
            h(IconNote),
            annotations.counts.open + annotations.counts.stale > 0
              ? h(
                  'span',
                  { className: 'dl-anno-badge' },
                  String(annotations.counts.open + annotations.counts.stale),
                )
              : null,
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dl-iconbtn',
              title: t('action.openSource'),
              onClick: () => openResource(sessionFileAddress(sessionId, cwd || project.rootDir, project.mainFile)),
            },
            h(IconLatex),
          ),
          h(
            'button',
            {
              type: 'button',
              className: `dl-iconbtn${tocOpen ? ' active' : ''}`,
              title: t('preview.toc'),
              disabled: toc.length === 0,
              onClick: () => setTocOpen((open) => !open),
            },
            h(IconList),
          ),
          h(
            'button',
            {
              type: 'button',
              className: `dl-iconbtn${searchOpen ? ' active' : ''}`,
              title: t('preview.search'),
              onClick: () => {
                setSearchOpen((open) => !open);
                if (!searchOpen) window.setTimeout(() => searchInputRef.current?.focus(), 0);
              },
            },
            h(IconSearch),
          ),
          h(
            'button',
            {
              type: 'button',
              className: 'dl-iconbtn',
              title: t('preview.download'),
              disabled: !project.previewVersion,
              onClick: downloadPdf,
            },
            h(IconDownload),
          ),
          h(
            'button',
            {
              type: 'button',
              className: `dl-iconbtn${darkMode ? ' active' : ''}`,
              title: t('preview.dark'),
              onClick: () =>
                setDarkMode((dark) => {
                  const next = !dark;
                  persistView(projectId, { dark: next });
                  return next;
                }),
            },
            h(IconMoon),
          ),
          h(
            'button',
            {
              type: 'button',
              className: `dl-iconbtn${cropMode ? ' active' : ''}`,
              title: cropMode ? t('preview.cropCancel') : t('preview.crop'),
              onClick: () => {
                setCropMode((enabled) => !enabled);
                setCropDrag(null);
              },
            },
            h(IconCrop),
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
        annotations.counts.stale > 0
          ? h('div', { className: 'dl-banner warn' }, h(IconAlert), h('span', null, t('preview.annoStaleBanner')))
          : null,
        cropMode
          ? h('div', { className: 'dl-banner info' }, h(IconCrop), h('span', null, t('preview.cropHint')))
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
                  title: cropMode ? t('preview.cropHint') : t('preview.syncHint'),
                  onMouseDown: (event) => {
                    if (cropMode || event.button !== 0) return;
                    if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
                    suppressSelectRef.current = true;
                    revealSourceAt(event, pageNumber);
                  },
                  onMouseUp: (event) => {
                    if (suppressSelectRef.current) {
                      suppressSelectRef.current = false;
                      return;
                    }
                    handlePageSelection(event.currentTarget);
                  },
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
                },
                cropMode
                  ? h(
                      'div',
                      {
                        className: 'dl-crop-layer',
                        onMouseDown: (event) => cropStart(event, pageNumber),
                        onMouseMove: (event) => cropMove(event, pageNumber),
                        onMouseUp: (event) => cropEnd(event, pageNumber),
                        onMouseLeave: () => {
                          if (cropDrag?.page === pageNumber) setCropDrag(null);
                        },
                      },
                      cropDrag?.page === pageNumber
                        ? h('div', {
                            className: 'dl-crop-box',
                            style: {
                              left: `${Math.min(cropDrag.startX, cropDrag.x)}px`,
                              top: `${Math.min(cropDrag.startY, cropDrag.y)}px`,
                              width: `${Math.abs(cropDrag.x - cropDrag.startX)}px`,
                              height: `${Math.abs(cropDrag.y - cropDrag.startY)}px`,
                            },
                          })
                        : null,
                    )
                  : null,
                );
              }),
              syncMark
                ? h('div', {
                    className: 'dl-sync-mark',
                    style: {
                      left: `${(pageElsRef.current[syncMark.page]?.offsetLeft ?? 0) + syncMark.x * scale}px`,
                      top: `${(pageElsRef.current[syncMark.page]?.offsetTop ?? 0) + syncMark.y * scale}px`,
                    },
                    'aria-hidden': true,
                  })
                : null,
              toast ? h('div', { className: 'dl-toast' }, toast) : null,
            )
          : null,
        tocOpen && toc.length > 0
          ? h(
              'div',
              { className: 'dl-anno-panel dl-toc-panel' },
              h(
                'div',
                { className: 'dl-anno-head' },
                h(IconList),
                h('span', null, t('preview.toc')),
                h('div', { className: 'dl-flex1' }),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dl-iconbtn',
                    title: t('preview.close'),
                    onClick: () => setTocOpen(false),
                  },
                  '×',
                ),
              ),
              ...toc.map((item, index) =>
                h(
                  'button',
                  {
                    key: `${index}-${item.title}`,
                    type: 'button',
                    className: 'dl-toc-item',
                    style: { paddingLeft: `${6 + item.depth * 10}px` },
                    disabled: !item.page,
                    onClick: () => {
                      if (item.page) goToPage(item.page);
                    },
                  },
                  item.title,
                ),
              ),
            )
          : null,
        searchOpen
          ? h(
              'div',
              { className: 'dl-searchbar' },
              h('input', {
                ref: searchInputRef,
                type: 'search',
                value: searchQuery,
                placeholder: t('preview.searchPlaceholder'),
                onChange: (event) => setSearchQuery(event.target.value),
                onKeyDown: (event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    runSearch();
                  }
                },
              }),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn primary',
                  disabled: searching,
                  onClick: runSearch,
                },
                searching ? t('preview.searching') : t('preview.searchRun'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-iconbtn',
                  title: t('preview.close'),
                  onClick: () => setSearchOpen(false),
                },
                '×',
              ),
              searchHits.length > 0
                ? h(
                    'div',
                    { className: 'dl-search-hits' },
                    ...searchHits.map((hit, index) =>
                      h(
                        'button',
                        {
                          key: `${hit.page}-${index}`,
                          type: 'button',
                          className: 'dl-search-hit',
                          onClick: () => goToPage(hit.page),
                        },
                        h('span', { className: 'dl-search-page' }, `${t('preview.page')} ${hit.page}`),
                        h('span', null, hit.snippet),
                      ),
                    ),
                  )
                : searchQuery && !searching
                  ? h('div', { className: 'dl-anno-hint' }, t('preview.searchEmpty'))
                  : null,
            )
          : null,
        selectionPopover,
        annotationsPanel,
        auditPanel,
      );
    }

    /* ------------------------------------------------------------------ */
    /* Editable .tex tab                                                   */
    /* ------------------------------------------------------------------ */

    function LatexToolchainBanner(props) {
      const { t: seatT, snapshot } = props;
      const t = seatT ?? tr;
      const [status, setStatus] = useState(null);
      const [dismissed, setDismissed] = useState(false);
      const [starting, setStarting] = useState(false);
      const missing = Boolean(snapshot?.toolchain && snapshot.toolchain.ok === false);
      const active = Boolean(
        status && ['downloading', 'verifying', 'extracting'].includes(status.state),
      );

      useEffect(() => {
        if (!missing) return undefined;
        let cancelled = false;
        fetch('/latex/toolchain', { cache: 'no-store' })
          .then((response) => response.json())
          .then((payload) => {
            if (!cancelled) setStatus(payload);
          })
          .catch(() => {});
        return () => {
          cancelled = true;
        };
      }, [missing]);

      useEffect(() => {
        if (!active) return undefined;
        const timer = window.setInterval(() => {
          fetch('/latex/toolchain', { cache: 'no-store' })
            .then((response) => response.json())
            .then((payload) => {
              setStatus(payload);
              if (payload.state === 'done') window.location.reload();
            })
            .catch(() => {});
        }, 1200);
        return () => window.clearInterval(timer);
      }, [active]);

      if (!missing || dismissed) return null;
      const start = async () => {
        setStarting(true);
        try {
          const response = await fetch('/latex/toolchain/install', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          });
          const payload = await response.json().catch(() => ({}));
          if (payload.status) setStatus(payload.status);
        } finally {
          setStarting(false);
        }
      };
      const cancel = async () => {
        await fetch('/latex/toolchain/cancel', { method: 'POST' }).catch(() => {});
        setStatus((current) => (current ? { ...current, state: 'cancelled' } : current));
      };
      return h(
        'div',
        { className: 'dl-toolchain' },
        h(IconAlert),
        h('span', null, t('toolchain.missing')),
        active
          ? h(
              'span',
              null,
              `${t('toolchain.installing')} · ${status.percent ?? 0}%`,
            )
          : status?.state === 'failed'
            ? h('span', null, `${t('toolchain.failed')}: ${status.error?.message ?? ''}`)
            : null,
        active ? h('progress', { max: 100, value: Number(status.percent) || 0 }) : null,
        h('div', { className: 'dl-flex1' }),
        active
          ? h('button', { type: 'button', className: 'dl-btn ghost', onClick: cancel }, t('toolchain.cancel'))
          : h(
              'button',
              {
                type: 'button',
                className: 'dl-btn primary',
                disabled: starting || status?.canInstall === false,
                onClick: start,
              },
              starting ? t('toolchain.installing') : t('toolchain.install'),
            ),
        h(
          'button',
          { type: 'button', className: 'dl-iconbtn', title: t('toolchain.dismiss'), onClick: () => setDismissed(true) },
          '×',
        ),
      );
    }

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
      const snapshot = useSnapshot();
      const autoSave = snapshot?.config?.editorAutoSave !== false;
      const autoSaveDelayMs = Number(snapshot?.config?.editorAutoSaveDelayMs) || 900;

      const [content, setContent] = useState('');
      const [draft, setDraft] = useState('');
      const [revision, setRevision] = useState('');
      const [phase, setPhase] = useState('loading');
      const [error, setError] = useState('');
      const [conflict, setConflict] = useState(undefined);
      const [build, setBuild] = useState(undefined);
      const [previewProjectId, setPreviewProjectId] = useState('');
      const [cmReady, setCmReady] = useState(false);
      const [cmFailed, setCmFailed] = useState(false);
      const [outlineOpen, setOutlineOpen] = useState(false);
      const [externalChange, setExternalChange] = useState(false);
      const [draftRecovered, setDraftRecovered] = useState(false);
      const [syncStatus, setSyncStatus] = useState('');
      const textRef = useRef(null);
      const gutterRef = useRef(null);
      const cmHostRef = useRef(null);
      const cmViewRef = useRef(null);
      const saveRef = useRef(null);
      const busyRef = useRef(false);
      const bodyRef = useRef(null);
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
          let recovered;
          try {
            recovered = window.sessionStorage.getItem(draftKey(filePath));
          } catch {
            recovered = undefined;
          }
          setContent(file.content);
          setDraft(recovered !== undefined && recovered !== null ? recovered : file.content);
          setDraftRecovered(Boolean(recovered !== undefined && recovered !== null && recovered !== file.content));
          setExternalChange(false);
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

      // Persist the unsaved buffer per tab so closing/reopening the tab does
      // not lose work; a successful save removes it.
      useEffect(() => {
        if (!filePath || phase !== 'ready') return undefined;
        const key = draftKey(filePath);
        const timer = window.setTimeout(() => {
          try {
            if (draft === content) window.sessionStorage.removeItem(key);
            else window.sessionStorage.setItem(key, draft);
          } catch {
            // Private mode / quota is not fatal.
          }
        }, 400);
        return () => window.clearTimeout(timer);
      }, [draft, content, filePath, phase]);

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
            setDraftRecovered(false);
            try {
              window.sessionStorage.removeItem(draftKey(filePath));
            } catch {
              // Storage is optional.
            }
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
      saveRef.current = save;

      // Debounced auto-save: after the user stops typing, write and compile
      // without requiring Ctrl+S. The manual save path is unchanged and still
      // runs immediately. Conflicts/errors stop the loop until the user acts.
      useEffect(() => {
        if (!autoSave || !filePath || !dirty) return undefined;
        if (busy || phase === 'loading' || phase === 'conflict' || phase === 'error') return undefined;
        const timer = window.setTimeout(() => {
          save({ auto: true });
        }, autoSaveDelayMs);
        return () => window.clearTimeout(timer);
      }, [autoSave, autoSaveDelayMs, dirty, draft, phase, busy, filePath, save]);

      // Reset the CodeMirror instance when the tab switches files.
      useEffect(() => {
        try {
          cmViewRef.current?.destroy();
        } catch {
          // Already destroyed.
        }
        cmViewRef.current = null;
        setCmReady(false);
        setCmFailed(false);
      }, [filePath]);

      // The loading/error branch unmounts the editor body; destroy the view
      // so the next ready render creates a fresh one instead of pointing at a
      // detached DOM.
      useEffect(() => {
        if (phase !== 'loading' && phase !== 'error') return;
        try {
          cmViewRef.current?.destroy();
        } catch {
          // Already destroyed.
        }
        cmViewRef.current = null;
        setCmReady(false);
      }, [phase]);

      // Mount CodeMirror after the source is ready; a failed chunk load keeps
      // the textarea fallback usable.
      useEffect(() => {
        if (phase !== 'ready' || cmFailed || cmViewRef.current) return;
        let cancelled = false;
        loadCodeMirror()
          .then((cm) => {
            if (cancelled || !cmHostRef.current || cmViewRef.current) return;
            const view = new cm.EditorView({
              doc: draft,
              extensions: [
                cm.lineNumbers(),
                cm.highlightActiveLineGutter(),
                cm.highlightActiveLine(),
                cm.drawSelection(),
                cm.history(),
                cm.search({ top: true }),
                cm.highlightSelectionMatches(),
                cm.bracketMatching(),
                cm.foldGutter(),
                cm.indentOnInput(),
                cm.keymap.of([
                  ...cm.defaultKeymap,
                  ...cm.searchKeymap,
                  ...cm.historyKeymap,
                  cm.indentWithTab,
                  {
                    key: 'Mod-s',
                    run: () => {
                      saveRef.current?.();
                      return true;
                    },
                  },
                ]),
                cm.StreamLanguage.define(cm.stex),
                cm.syntaxHighlighting(cm.defaultHighlightStyle),
                cm.EditorView.updateListener.of((update) => {
                  if (update.docChanged) setDraft(update.state.doc.toString());
                }),
              ],
            });
            cmHostRef.current.innerHTML = '';
            cmHostRef.current.appendChild(view.dom);
            cmViewRef.current = view;
            setCmReady(true);
          })
          .catch(() => {
            if (!cancelled) {
              setCmFailed(true);
              setCmReady(false);
            }
          });
        return () => {
          cancelled = true;
        };
        // The initial draft is captured when the file becomes ready; later
        // draft changes are dispatched through the sync effect below.
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [phase, cmFailed, filePath]);

      useEffect(
        () => () => {
          try {
            cmViewRef.current?.destroy();
          } catch {
            // Already destroyed.
          }
          cmViewRef.current = null;
        },
        [],
      );

      // Keep an externally restored draft/banner in sync with the editor.
      useEffect(() => {
        const view = cmViewRef.current;
        if (!view) return;
        const current = view.state.doc.toString();
        if (current === draft) return;
        view.dispatch({ changes: { from: 0, to: current.length, insert: draft } });
      }, [draft, cmReady]);

      const checkExternalChange = useCallback(async () => {
        if (!filePath || busyRef.current) return;
        try {
          const query = new URLSearchParams({ path: filePath });
          const response = await fetch(`/latex/file?${query}`, { cache: 'no-store' });
          if (!response.ok) return;
          const payload = await response.json().catch(() => ({}));
          const file = payload?.file ?? payload;
          if (typeof file?.content !== 'string' || !file?.revision) return;
          if (!revision || file.revision === revision) return;
          if (!dirty) {
            setContent(file.content);
            setDraft(file.content);
            setRevision(file.revision);
            setDraftRecovered(false);
          } else {
            setExternalChange(true);
          }
        } catch {
          // An unreadable file is reported by the normal load path.
        }
      }, [filePath, revision, dirty]);

      useEffect(() => {
        const handler = () => {
          checkExternalChange();
        };
        window.addEventListener('focus', handler);
        return () => window.removeEventListener('focus', handler);
      }, [checkExternalChange]);

      const outline = useMemo(() => parseLatexOutline(draft), [draft]);

      const jumpToLine = useCallback((line) => {
        const target = Math.max(1, Number(line) || 1);
        const view = cmViewRef.current;
        if (view) {
          const docLine = view.state.doc.line(Math.min(target, view.state.doc.lines));
          view.dispatch({
            selection: { anchor: docLine.from, head: docLine.from },
            effects: view.constructor.scrollIntoView?.(docLine.from, { y: 'center' }),
          });
          view.focus();
          return;
        }
        const element = textRef.current;
        if (!element) return;
        const lines = draft.split('\n');
        const offset = lines.slice(0, target - 1).reduce((sum, value) => sum + value.length + 1, 0);
        try {
          element.focus();
          element.setSelectionRange(offset, offset + (lines[target - 1]?.length ?? 0));
          element.scrollTop = Math.max(0, (target - 1) * 18 - element.clientHeight / 2);
        } catch {
          // Detached textarea.
        }
      }, [draft]);

      const reload = useCallback(() => {
        if (dirty && typeof window !== 'undefined' && !window.confirm(tRef.current('editor.reloadConfirm'))) return;
        try {
          if (filePath) window.sessionStorage.removeItem(draftKey(filePath));
        } catch {
          // Storage is optional.
        }
        load();
      }, [dirty, load, filePath]);

      const forceSave = useCallback(() => {
        if (typeof window !== 'undefined' && !window.confirm(tRef.current('editor.forceConfirm'))) return;
        save({ force: true });
      }, [save]);

      // Scroll to the line a SyncTeX inverse jump asked for (once per load).
      useEffect(() => {
        const line = Number(params.line) || 0;
        if (!line || phase !== 'ready' || !content) return;
        jumpToLine(line);
      }, [phase, content, navigationRevision, params.line, cmReady, jumpToLine]);

      // Ctrl+单击编辑器里的某一行：问宿主这一行在 PDF 的哪一页哪一点，
      // 然后把预览标签切过去并画出高亮（forward SyncTeX）。
      const syncToPdf = useCallback(
        async (line) => {
          const project = projectForFile(snapshot, filePath, sessionId);
          if (!project) {
            setSyncStatus(t('editor.syncNoProject'));
            return;
          }
          const relative = relativeInside(project.rootDir, filePath);
          setSyncStatus(`${t('editor.syncing')} ${line}`);
          try {
            const query =
              `/latex/synctex?project=${encodeURIComponent(project.id)}` +
              `&file=${encodeURIComponent(relative)}&line=${line}`;
            const response = await fetch(query);
            const payload = await response.json().catch(() => ({}));
            const result = payload?.synctex;
            if (!response.ok || !result?.ok) {
              throw new Error(result?.message || `HTTP ${response.status}`);
            }
            const paneId = previewPaneId(sessionId);
            const opened = openTab(
              PREVIEW_KIND,
              {
                project: project.id,
                page: result.page,
                x: result.x,
                y: result.y,
                syncToken: Date.now(),
              },
              paneId ? { paneId } : {},
            );
            if (!opened) throw new Error(t('editor.syncNoPanel'));
            setSyncStatus(`${t('editor.synced')} · ${t('preview.page')} ${result.page}`);
          } catch (failure) {
            setSyncStatus(`${t('editor.syncFailed')}: ${String(failure?.message ?? failure)}`);
          }
        },
        [snapshot, filePath, sessionId, t],
      );

      // CodeMirror 用 posAtCoords 精确取行；纯 textarea 回退按行高估算。
      const lineAtPoint = useCallback((clientX, clientY) => {
        const view = cmViewRef.current;
        if (view) {
          const pos = view.posAtCoords({ x: clientX, y: clientY });
          if (pos === null || pos === undefined) return 0;
          return view.state.doc.lineAt(pos).number;
        }
        const element = textRef.current;
        if (!element) return 0;
        const rect = element.getBoundingClientRect();
        if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
          return 0;
        }
        const style = window.getComputedStyle(element);
        const lineHeight = Number.parseFloat(style.lineHeight) || 18;
        return Math.max(1, Math.floor((clientY - rect.top + element.scrollTop) / lineHeight) + 1);
      }, []);

      // 每次渲染后重新挂一次：编辑区是条件渲染的，首次挂载时 bodyRef 还是空的。
      useEffect(() => {
        const host = bodyRef.current;
        if (!host) return undefined;
        const onMouseDown = (event) => {
          if (event.button !== 0) return;
          if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return;
          if (event.target instanceof Element && event.target.closest('.dl-outline')) return;
          const line = lineAtPoint(event.clientX, event.clientY);
          if (!line) return;
          // 抢在 CodeMirror 把它解释成多光标选择之前吞掉这次按下。
          event.preventDefault();
          event.stopPropagation();
          void syncToPdf(line);
        };
        host.addEventListener('mousedown', onMouseDown, true);
        return () => host.removeEventListener('mousedown', onMouseDown, true);
      });

      // 定位结果只在提示行停留几秒。
      useEffect(() => {
        if (!syncStatus) return undefined;
        const timer = setTimeout(() => setSyncStatus(''), 4000);
        return () => clearTimeout(timer);
      }, [syncStatus]);

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
        h(LatexToolchainBanner, { t, snapshot }),
        h(
          'div',
          { className: 'dl-editor-bar' },
          h(IconLatex),
          h('span', { className: 'dl-editor-path', title: filePath || address }, displayName),
          dirty ? h('span', { className: 'dl-editor-dirty' }, t('editor.dirty')) : null,
          h('span', { className: 'dl-head-spacer' }),
          h('span', { className: `dl-editor-status ${statusTone}` }, statusText),
          h(
            'span',
            {
              className: 'dl-editor-auto',
              title: `${t('editor.autoHint')} · ${autoSaveDelayMs} ms`,
            },
            autoSave ? t('editor.autoOn') : t('editor.autoOff'),
          ),
          h(
            'button',
            {
              type: 'button',
              className: `dl-iconbtn${outlineOpen ? ' active' : ''}`,
              title: t('editor.outline'),
              'aria-label': t('editor.outline'),
              disabled: outline.length === 0,
              onClick: () => setOutlineOpen((open) => !open),
            },
            h(IconChevron),
          ),
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
        draftRecovered
          ? h(
              'div',
              { className: 'dl-editor-conflict' },
              h(IconAlert),
              h('span', null, t('editor.draftRecovered')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn ghost',
                  onClick: () => {
                    try {
                      window.sessionStorage.removeItem(draftKey(filePath));
                    } catch {
                      // Storage is optional.
                    }
                    setDraft(content);
                    setDraftRecovered(false);
                  },
                },
                t('editor.discardDraft'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn',
                  onClick: () => setDraftRecovered(false),
                },
                t('editor.keepMine'),
              ),
            )
          : null,
        externalChange
          ? h(
              'div',
              { className: 'dl-editor-conflict' },
              h(IconAlert),
              h('span', null, t('editor.externalChange')),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn ghost',
                  onClick: () => {
                    setExternalChange(false);
                    try {
                      window.sessionStorage.removeItem(draftKey(filePath));
                    } catch {
                      // Storage is optional.
                    }
                    load();
                  },
                },
                t('editor.loadDisk'),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dl-btn',
                  onClick: () => setExternalChange(false),
                },
                t('editor.keepMine'),
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
                { className: 'dl-editor-body', ref: bodyRef },
                outlineOpen && outline.length > 0
                  ? h(
                      'div',
                      { className: 'dl-outline' },
                      ...outline.map((item) =>
                        h(
                          'button',
                          {
                            key: `${item.line}-${item.title}`,
                            type: 'button',
                            style: { paddingLeft: `${5 + item.level * 8}px` },
                            onClick: () => jumpToLine(item.line),
                          },
                          item.title,
                        ),
                      ),
                    )
                  : null,
                !cmReady || cmFailed
                  ? h('pre', { ref: gutterRef, className: 'dl-editor-gutter', 'aria-hidden': true }, gutter)
                  : null,
                !cmReady || cmFailed
                  ? h('textarea', {
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
                    })
                  : null,
                h('div', {
                  ref: cmHostRef,
                  className: 'dl-cm',
                  style: { display: cmReady ? 'flex' : 'none' },
                }),
              ),
        h(
          'div',
          { className: 'dl-hint', style: { padding: '2px 9px 6px' } },
          syncStatus ? `${t('editor.hint')} · ${syncStatus}` : t('editor.hint'),
        ),
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
      latex_look: 'tool.look',
      latex_audit: 'tool.audit',
      latex_annotations: 'tool.annotations',
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
        staleProject?.previewVersion || (toolName === 'latex_compile' && typeof args.path === 'string')
          ? h(
              'div',
              { className: 'dl-tool-actions' },
              staleProject?.previewVersion
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dl-btn',
                      onClick: () => openTab(PREVIEW_KIND, { project: staleProject.id }),
                    },
                    h(IconEye),
                    h('span', null, t('action.openPreview')),
                  )
                : null,
              toolName === 'latex_compile' && typeof args.path === 'string'
                ? h(
                    'button',
                    {
                      type: 'button',
                      className: 'dl-btn',
                      onClick: () =>
                        openResource(sessionFileAddress(sessionId, resolvedCwd, args.path)),
                    },
                    h(IconLatex),
                    h('span', null, t('action.openSource')),
                  )
                : null,
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
