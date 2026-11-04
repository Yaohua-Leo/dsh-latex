# DSH 原生插件 API 速查表（dsh-latex 专用）

> 目标：给出 `dsh-latex`（Host 半侧：工具 + 构建服务 + 本地 HTTP 路由；Web Client 半侧：右侧栏面板）可以直接抄的 API 形状。
> 每条结论后面都标了证据：`文件:行号` 或 live 运行时查询。凡是**没有在代码里亲眼看到**的，标 **UNCERTAIN** 并写清验证方法。

## 0. 本机环境事实（先记住这几条）

| 事实 | 值 | 证据 |
|---|---|---|
| DSH 运行时版本 | **0.2.1-rc.5** | `resources/app.asar` → `dsh/node_modules/@deepseek-ai/dsh/package.json`；`@deepseek-ai/dsh-app-boot` 同版本 |
| 当前 profile | `desktop`，目录 `C:\Users\86132\.dsh\profiles\desktop`（realpath `E:\AppData\DeepSeekHarness\Home\profiles\desktop`） | 目录 + `package.json` |
| Web GUI | `http://127.0.0.1:50802` | 运行时上下文 |
| Host 是否启用 HMR | **是**（服务目录里有 `hmr`） | `cordis_inspect_query(host/Service.listService)` 目录 |
| profile 级共享依赖 | `C:\Users\86132\.dsh\profiles\node_modules` 是指向宿主 node_modules 的**符号链接层**（199 个 `@deepseek-ai/*`） | `lstatSync`：`.../schemastery` → `D:\DevTools\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\schemastery` |
| **已安装副本**里的 `import '@deepseek-ai/schemastery'` | **能解析**（ESM/CJS 均可），拿到 **3.18.1**，没有 `.volatile()` | 在 `profiles/desktop/node_modules/dsh-swarm-orchestrator` 下实测成功；`grep volatile lib/index.mjs` = 0 命中 |
| **workspace `link:` 插件**（本插件）里的 `import '@deepseek-ai/*'` | **不能解析**：`MODULE_NOT_FOUND` / `ERR_MODULE_NOT_FOUND`（三个包全失败） | 在 `D:/deepseekharness/latex-plugin` 下实测 `dsh-tools`/`schemastery`/`cordis` 全部解析失败 |
| 宿主自带的 schemastery | **3.18.5**，**有** `.volatile()` | `resources/app.asar` → `dsh/node_modules/@deepseek-ai/schemastery/package.json`；其 `lib/index.mjs` 含 `volatile = function volatile()` |
| Web 前端 React | `^18.2.0`（React 18） | `@deepseek-ai/dsh-web-frontend/package.json` devDependencies |

> 证据等级：**代码**（读源码）> **live**（cordis_inspect_query）> **UNCERTAIN**。
> 本环境的 **Client 侧 Inspect Provider 全部超时**（`Service.listService` / `Slots.listSubTree` / `Theme.listTokens` / `Builtin.listBuiltins` 均 10s timeout，提示 “Open or reconnect the Harness page”）。本文所有 client 结论都来自**随包发布的 client bundle 源码**（`resources/app.asar` 内），比猜测可靠，但仍属“读代码”而不是“读活对象”。

### 0.1 最重要的一条：`link:` 安装的插件 **不能** `import` Harness 包

Node 的模块解析基于**真实路径**。本插件以 `link:` 安装（`profiles/desktop/package.json:14`：`"dsh-latex": "link:D:/deepseekharness/latex-plugin"`，`node_modules/dsh-latex` 是指向工作区的符号链接，realpath = `D:\deepseekharness\latex-plugin`），解析链是：

```
D:\deepseekharness\latex-plugin\node_modules
D:\deepseekharness\node_modules
D:\node_modules            ← 都没有 @deepseek-ai
```

实测（2026-11-03）：

```
@deepseek-ai/dsh-tools   FAIL MODULE_NOT_FOUND
@deepseek-ai/schemastery FAIL MODULE_NOT_FOUND
@deepseek-ai/cordis      FAIL MODULE_NOT_FOUND
```

**结论（已由本仓库实现验证）**：workspace 开发的插件有两种写法——

1. **不 import 任何 Harness 包**，把需要的一点点逻辑 vendor 进来。本插件就是这么做的：`src/tool.js:1-11` 的注释写明“a profile-installed bundle resolves its package imports from the DSH installation, but a bundle linked from a workspace directory resolves imports from its own path. To keep the same source installable either way, this plugin carries no runtime import of a Harness package”，并实现了 200 行的 `defineTool` 等价物（`src/tool.js:157-201`）。
2. 在插件目录里 `pnpm add @deepseek-ai/dsh-tools @deepseek-ai/schemastery`（或用 `peerDependencies` + 本地 node_modules），让它自己解析得到。缺点：版本与宿主可能不一致。

> 反过来说：**从 registry/tarball 复制进 profile 的插件**（真实目录在 `profiles/desktop/node_modules/<pkg>`）可以解析 `@deepseek-ai/*`，因为祖先 `profiles/node_modules` 存在（swarm 就是这种形态）。本文 B.2 / C.1 的“官方写法”适用于这种形态；本插件的 `link:` 形态请照 0.1 的结论处理。HMR 重载时 Node 仍按真实路径解析，不会因为“装进了 profile”而改变。

---

## A. Bundle 包：package.json、patch、安装

### A.1 目录结构（最小可用）

```
latex-plugin/
├─ package.json
├─ cordis.patch.yml        ← dsh.bundle.patch 指向它
├─ index.js                ← Host 半侧入口（exports "."）
├─ client.js               ← Client 半侧 bundle（exports "./client"）
├─ icon.svg                ← exports "./icon"（当前脚手架缺失，必须补）
├─ locale/
│  ├─ en.json              ← 插件显示元信息（不是运行时词典）
│  └─ zh.json
├─ src/…                   ← Host 内部模块（build 服务、routes）
└─ assets/…
```

### A.2 package.json（在现有脚手架上补齐这几项）

```json
{
  "name": "dsh-latex",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg",
    "./package.json": "./package.json"
  },
  "files": [
    "index.js", "client.js", "src", "assets",
    "locale/*.json", "icon.svg", "cordis.patch.yml", "README.md", "LICENSE"
  ],
  "engines": { "dsh": ">=0.2.1-rc.5" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": [
        "@deepseek-ai/dsh-client-ui-sidebar-right",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-theme"
      ]
    }
  }
}
```

- `dsh.bundle.patch`：**string 或 string[]**。`bundlePatchFiles()` 明确接受两种（`app-boot/lib/index.js:517-521`）。
- `dsh.client` 允许的字段只有 4 个：`platform`、`inject`、`external`、`immediately`。解析器会**拒绝**其它形状（`client-modules/lib/index.js:64-76`）：
  - `platform`：必须 string（web 下为 `"web"`）。
  - `inject`：string[]，声明“我的 client bundle 依赖哪些其它插件包先到位”，组合器按它排序。
  - `external`：string[]，`require()` 基座表之外的额外模块（**本插件用不到**，见 G.2）。
  - `immediately`：boolean。语义是**启动时预取**（`prefetchImmediateTier()` 在挂载外壳前 `prefetch` 带此标记的包，见 `dsh-web-frontend/dist/assets/index-BXV-oxvX.js` 反编译片段）。它不改变激活顺序：所有 entry 最终都会 `entries.start()` 全量导入（同文件 `jZ()`）。右栏面板希望“一打开就在”，加 `true` 可少一次按需下载。
- `exports["./icon"]` 与 `exports["./locale/*.json"]` **不是可选项**：元信息读取器就是通过这两个 specifier 解析的（见 A.6）。

> **关于依赖声明**（结合 0.1 的实测）：
> - `link:` 开发形态：不要指望 Harness 包能解析，也别把它们写进 `dependencies`（pnpm 会尝试装一份副本，版本可能和宿主冲突）。本插件实际做法 = 零运行时依赖 + vendor 小工具（`src/tool.js`）。
> - registry/install 形态：可以解析 `@deepseek-ai/*`（祖先 `profiles/node_modules`），此时只写 `peerDependencies` 声明意图最干净。
> - `engines.dsh` / `peerDependencies` 会触发**安装期兼容性检查**（`app-boot/lib/index.js:276-282`，`includePrerelease: true`），range 必须能匹配 `0.2.1-rc.5`。本插件当前**没有**声明 engines/peerDependencies，所以安装不会被这条拦；纯属可选加固。
> - 本插件实际 `package.json` 也没有 `immediately`（可选优化，不是必需），装好后工具与 UI 都正常（本会话已能调用 `latex_compile`）。

### A.3 cordis.patch.yml：insert 语法

```yaml
# dsh-latex bundle patch
- insert:
    - id: latex                      # ← Loader entry id，也是 Settings 里的 Config namespace
      name: dsh-latex                # ← profile 里可解析的包名
      config:
        texBinDir: 'D:\latex\texlive2023\texlive\2023\bin\windows'
        latexmkPath: ''
        engine: xelatex
        buildDir: build
        autoBuild: true
        debounceMs: 800
        timeoutMs: 180000
        preserveLastGood: true
        autoOpenPreview: true
        previewSurface: native
        allowedRoots: []
        extraLatexmkArgs: []
        maxConcurrentBuilds: 2
```

要点：

1. 顶层是 YAML 数组，每项要么是 `- insert: [...]`（新行），要么是 `- id: <已有行>` + `config:`（覆盖，profile 的 `cordis.patch.yml` 就是这么用的，见 `profiles/desktop/cordis.patch.yml` 前 20 行）。
2. `id` 决定 **Config namespace**：`settings.describe()` 的 `ns` 就是 entry id（`dsh-settings/lib/index.js:432,443`），客户端写配置时也用它。
3. `!!js` 表达式**不能加引号**。swarm 的 patch 里专门写了这个坑：

```yaml
      config:
        storageDir: !!js dshHomePath("storages/swarm")
```
`dshHomePath` 是 Host 提供的服务（`app-boot/lib/index.js:4526: ctx.provide("dshHomePath", dshHomePath)`），`!!js` 在 Loader 的求值作用域里可用。加引号会退化成字符串字面量（`dsh-swarm-orchestrator/cordis.patch.yml:10-11` 的注释原文）。
4. 缩进敏感；`config` 下的键必须与 `export const Config` 的字段名一致，否则被 schema 校验拒绝（见 B.2）。

### A.4 安装：plugin_manager.install_bundle

```
plugin_manager({
  action: "install_bundle",
  target: "D:\\deepseekharness\\latex-plugin",   // 绝对目录 = 一种安装 spec
  approvedBuilds: []                              // 本包无安装脚本，留空
})
```

工具语义（`@deepseek-ai/dsh-plugin-manager` live 契约 + README）：

- `target` 是“一个包 spec：registry 名、**绝对路径**、git 地址或 tarball”（live `installBundle(spec, options)` 参数说明）。所以给绝对目录是官方支持路径。**本插件实际用的是 `link:D:/deepseekharness/latex-plugin`**（`profiles/desktop/package.json:14`），同样成功，并得到 `application: applied`；两种写法等价，`link:` 的好处是改 `index.js`/`client.js` 立刻反映到 profile。
- 安装成功后：profile `package.json` 的依赖里出现该包，`dsh.profile.bundles` 追加包名（默认 `enabled: true`），profile `node_modules` 出现 `dsh-latex`。
- 包**必须**声明 `dsh.bundle` 且 patch 至少有一行，否则整次安装回滚（`package.json`/`pnpm-lock.yaml` 恢复）并报 `not-bundle`（plugin-manager README 第 52 行）。
- 需要 `danger-full-access` 或单次批准（README 第 31 行）。

**`application` 字段含义（关键）** —— 源码 `plugin-manager/lib/index.js:2373-2400`：

```js
const result = {
  ...request,
  changed: false,
  ...(this.ownerContext.get("hmr") !== undefined
        ? { application: "applied" }
        : { application: "restart-required", restartReason: "no-hmr" }),
}
```

| 值 | 含义 | 本机是否会发生 |
|---|---|---|
| `applied` | HMR 服务存在，Loader 已重新组合并**在本进程内导入并启动了新 entry** | ✅ 本机有 `hmr` 服务 → 正常安装会得到 `applied` |
| `restart-required` | 没有 HMR，或 `package-moved` / `host-module` / `unmanaged-plugin` / `module-comparison` 之一 | 本机除非 HMR 被关掉，否则不会 |
| `failed` | pnpm 失败 / 导入失败 / 发布失败，带 `error` + `packageResult.logPath` | 包写错时 |
| `cancelled` | 被 `cancelInstall(requestId)` 中止 | 手动取消 |

`restartReason` 枚举：`'no-hmr' | 'package-moved' | 'host-module' | 'unmanaged-plugin' | 'module-comparison'`（live `RestartReason`）。

**“fresh JS module generation” 要重启吗？**

- Host 半侧：`applied` 时 HMR 会 `reconcileProfile()` 导入新 entry，**新包也能直接挂载，不需要重启**（`plugin-manager/lib/index.js:2360-2372` 走 `hmr.reconcileProfile`）。只有无 HMR 时才 `restart-required`。
- 但有个硬边界：**已经在跑的 Host 模块代码不会热替换成“另一个目录里的同名包”**；`package-moved` 一律 `restart-required`。开发期反复 `pnpm add` 换目录时注意。
- Client 半侧：`applied` 之后浏览器通过 HMR 的图更新拿到新的 `/plugins/dsh-latex/client.js`；**如果页面是在插件安装前打开的，最稳的做法是刷新一次页面**（`client-modules` README：只有刷新才会换 Host release；同 release 内图更新可热加载）。第一次联调建议：装完 → 刷新页面 → 看 `__DSH_BOOT__`。
- **改 Host 侧代码后**：`index.js` 已加载的模块需要 HMR 的 module reload（保存文件即触发）或重启；新增**文件**（例如新的 `src/routes.js`）在 HMR 下也能被导入，但首次联调最省心的是重启一次桌面应用。

### A.5 Config 持久化在哪里 / schema 在哪

| 层 | 位置 | 谁写 |
|---|---|---|
| 包内默认值 | `latex-plugin/cordis.patch.yml` 的 `config:` | 你（随包发布） |
| profile 覆盖 | `%DSH_HOME%/profiles/<profile>/cordis.patch.yml` 里 `- id: latex` + `config:` | 用户 / Settings 服务 |
| schema 定义 | `index.js` 里 `export const Config` | 你 |

- Cordis 在创建 entry 时做校验：`resolveConfig(runtime, config)` → 没有 `runtime.Config` 就**原样透传**；有就 `runtime.Config["~standard"].validate(config)`（`@deepseek-ai/cordis/lib/index.js:950-958`）。所以 `Config` 不是必需的，但**要校验、要 Settings 表单就必须有**。
- Settings 读的是 `entry.fiber.runtime.Config`，并要求它有 `toJSON`（`dsh-settings/lib/index.js:538-541`）→ 用 schemastery 生成的 Schema 正好满足。
- Profile 覆盖层写回由 `configEditor.edit(entry, change)` 完成（live `configEditor` 契约：`entries()` / `configuration()` / `edit(entry, change)`），`settings` 服务只是它的上层。

### A.6 locale meta 与 icon 的硬规则

`readPluginMeta()`（`app-boot/lib/index.js:2216-2247`）是唯一读取 `locale/*.json` 和 icon 的地方：

```js
const englishPath = optionalResourcePath(`${specifier}/locale/en.json`, parentURL);
const dictionaries = englishPath === undefined ? new Map() : dictionariesOf(englishPath, specifier, parentURL);
const manifestPath = packageName === specifier ? optionalResourcePath(`${specifier}/package.json`, parentURL) : undefined;
const title = localizedText("title", dictionaries, manifest?.name, specifier);
const description = localizedText("description", dictionaries, manifest?.description, "");
icon = iconOf(specifier, packageName, parentURL, manifestPath, manifest?.icon);
```

- **`locale/en.json` 是锚点**：先解析它，再扫描**同目录**的其它 `locale/*.json`（`dictionariesOf`），所以 `zh.json` 自动生效。
- 结构固定：`{ "meta": { "title": "...", "description": "..." } }`（现有 `locale/en.json`、`locale/zh.json` 已符合）。
- 缺字段的兜底：title → `package.json.name`；description → `package.json.description`；两者都空才会“无元信息”。
- **icon 规则**（`iconOf`，`app-boot/lib/index.js:2085-2112`）：
  - 来源优先级：`package.json` 的 `"icon"` 字段（相对路径，必须留在 manifest 目录内）> `exports["./icon"]` 解析出的文件。
  - 格式：**SVG / PNG / JPEG / WebP**。
  - 大小：**≤ 256 KiB**（`MAX_ICON_BYTES`），超了抛错。
  - 返回：`data:<mime>;base64,...` 字符串，写进 `meta.icon`。
  - 失败不会中断管理操作，只把错误塞进 `meta.error`（`readPluginMeta` 的 catch）。
- **本插件已补上 `icon.svg`**（`latex-plugin/icon.svg`，约 1.4 KiB，远小于 256 KiB 上限；`exports["./icon"]` 与 `files` 都已包含）。如果删掉它：插件仍能安装运行，只是列表里没有图标，且不会报错。

---

## B. Host 插件：apply / Config / inject / 生命周期

### B.1 入口骨架（index.js）

```js
// latex-plugin/index.js
import Schema from '@deepseek-ai/schemastery'
import { LatexService } from './src/service.js'
import { registerLatexTools } from './src/tools.js'
import { registerLatexRoutes } from './src/routes.js'

export const name = 'dsh-latex'

// 硬依赖：缺任何一个，这个 entry 会停在 pending，不会激活
export const inject = ['webServer', 'tools', 'fs', 'subprocess']

export const Config = Schema.object({
  texBinDir: Schema.string().default(''),
  latexmkPath: Schema.string().default(''),
  engine: Schema.union(['xelatex', 'pdflatex', 'lualatex']).default('xelatex'),
  buildDir: Schema.string().default('build'),
  autoBuild: Schema.boolean().default(true),
  debounceMs: Schema.natural().default(800),
  timeoutMs: Schema.natural().default(180000),
  preserveLastGood: Schema.boolean().default(true),
  autoOpenPreview: Schema.boolean().default(true),
  previewSurface: Schema.union(['native', 'document']).default('native'),
  allowedRoots: Schema.array(Schema.string()).default([]),
  extraLatexmkArgs: Schema.array(Schema.string()).default([]),
  maxConcurrentBuilds: Schema.natural().default(2),
})

export function apply(ctx, config) {
  const log = ctx.logger('latex')
  let service
  try {
    service = new LatexService(ctx, config)     // 自己 new，构造函数里不要 throw 出 apply
  } catch (err) {
    log.error('latex service failed to start (plugin disabled): %s', String(err))
    return
  }

  ctx.effect(() => wireWhenAvailable(ctx, 'tools', () => registerLatexTools(ctx, service)), 'latex: tools')
  ctx.effect(() => wireWhenAvailable(ctx, 'webServer', () => registerLatexRoutes(ctx, service)), 'latex: http')
}
```

`name` / `Config` / `inject` / `apply(ctx, config)` 这四个导出就是 Loader 认的全部契约（`dsh-swarm-orchestrator/lib/index.js:1-7,51-88`；`dsh-thoughtdag/lib/index.js` 用 `export const inject = ['webServer', ...]` + `export async function apply`）。

### B.2 schemastery 真的是“官方配置库”

- swarm：`import Schema from '@deepseek-ai/schemastery'`（`dsh-swarm-orchestrator/lib/config.js:1`），`Schema.object({ storageDir: Schema.string().default(...).description(...), ... })`（同文件 `:14-37`）。这是已部署第三方插件在跑的真实写法。
- 从 **profile 已安装副本**（真实目录在 `profiles/desktop/node_modules/<pkg>`）里 import 它**可以解析**：本机实测 ESM `import('@deepseek-ai/schemastery')` → `D:\DevTools\npm-cache\_npx\<hash>\node_modules\@deepseek-ai\schemastery\lib\index.mjs`，CJS `require()` 也返回 `{ ValidationError, extend, natural, percent, date, ... }`。
- **但本插件（`link:` 到工作区）解析不到它**（0.1 实测），所以本插件**没有** `export const Config`，而是在 `src/config.js` 用 `normalizeConfig(rawConfig)` 自己归一化（`index.js:13,73`）。这是有意为之：少了 schema 校验和 Settings 表单，但 Host 半侧在两种安装形态下都能加载。
- 若将来要加 Settings 表单：先把 schemastery 变成可解析依赖（0.1 的方案 2），再加 `export const Config`；否则 `Config` 里 `import Schema` 会让整个插件 import 失败。
- 默认导出是**函数**（`typeof S === 'function'`），`import Schema from` 拿到的就是它；`Schema.object/string/boolean/natural/union/array` 都在。
- 版本注意：解析到的是 **3.18.1**，**没有 `.volatile()`**（见 0. 表格）。宿主的 3.18.5 才有。
- 备选：完全可以不导出 `Config`（`dshmarket/lib/index.js` 就没有），此时 config 不校验、Settings 不出表单。

### B.3 `inject` vs `ctx.get`：两套服务发现

**硬依赖（推荐用于 webServer/tools/fs/subprocess）**：`export const inject = [...]`，cordis 保证激活时它们存在；`ctx.webServer` 这样的属性访问才合法。

**可选/迟到的服务**：用 `ctx.get(name)`（不带 inject 时**属性访问会抛** “cannot get property ... without inject”，swarm 在 `tools/index.js:44-50` 的注释里专门写了这点）。swarm 的通用解如下，直接抄（`dsh-swarm-orchestrator/lib/index.js:16-50`）：

```js
function wireWhenAvailable(ctx, serviceName, fn, timeoutMs = 60000) {
  const logger = ctx.logger('swarm')
  const guarded = () => {
    try { return fn() }
    catch (err) {
      logger.error('wiring %s failed (degraded until next reload): %s', serviceName, String(err))
      return undefined
    }
  }
  let inner, settled = false
  if (ctx.get(serviceName) !== undefined) { inner = guarded(); settled = true; return () => { if (inner !== undefined) inner() } }
  const timer = setInterval(() => {
    if (ctx.get(serviceName) !== undefined) {
      clearInterval(timer); clearTimeout(to)
      inner = guarded(); settled = true
    }
  }, 500)
  const to = setTimeout(() => clearInterval(timer), timeoutMs)
  return () => {
    clearInterval(timer); clearTimeout(to)
    if (settled && inner !== undefined) inner()
  }
}
```

三个设计点值得保留：500ms 轮询兜住注入顺序；**wiring 里的异常只记日志不抛出**（否则一个定时器回调就能掀翻整个 host）；`fn` 返回的 disposer 被外层 disposer 链起来。

另一种写法是 `ctx.inject([...], (scope) => { ... })`：只在依赖齐了以后跑一次回调（`dshmarket/lib/index.js:166` 用它等 `webServer` + `loader`；`dsh-thoughtdag/lib/index.js:1685` 用它等可选 `permissionPresets`）。

### B.4 effect / on / logger / provide

```js
// 清理：返回 disposer，插件卸载（含 HMR 替换）时调用
ctx.effect(() => {
  const disposer = doSomething()
  return () => disposer()
}, 'latex: 一句话说明这个 effect 拥有什么')

// 事件：ctx.on 返回 disposer，通常用 effect 包住
ctx.effect(() => ctx.on('fs/observed', (target, observation, actor) => { ... }), 'latex: fs 观察')

// 日志：命名 logger，printf 风格
const log = ctx.logger('latex')
log.info('built %s in %dms', projectRoot, ms)
log.warn('latexmk missing; expected at %s', config.latexmkPath)
log.error('build failed: %s', err.message)
// 也有不用命名 logger 的写法：ctx.logger.info('...')（dsh-thoughtdag/lib/index.js:1683）

// 对外提供服务（可选）：cordis 原生
ctx.provide('latex', service)         // 之后别人可以 ctx.get('latex') / inject:['latex']
```

`ctx.effect(fn, label?)` 的返回值就是 dispose 函数；label 会出现在 HMR/诊断里。**effect 回调里不要 async throw**——swarm 的做法是所有可能失败的工作都包 try/catch。

### B.5 构建服务放在哪

`LatexService` 不需要注册成 cordis 服务：`apply` 里 `new` 出来，工具和路由通过闭包拿它（swarm 的 `SwarmService` 就是这样，`lib/index.js:57`）。只有**别人也要用**时才 `ctx.provide('latex', service)`。

---

## C. Tools：`ctx.tools.register(defineTool({...}))`

### C.1 最小真实样例（swarm 的写法）

`dsh-swarm-orchestrator/lib/tools/index.js:1` 引入 `defineTool`，`:50` 起逐个 `tools.register(defineTool({...}))`，`:44-50` 的注释说明了为什么用 `ctx.get('tools')`：

> **本仓库的实际做法（已验证可跑）**：因为是 `link:` 安装，`@deepseek-ai/dsh-tools` 解析不到（0.1），所以 `src/tool.js` vendor 了一个 **200 行的等价 `defineTool`**：编译同一套参数 DSL → 原始 JSON Schema、`required: true` 收集、枚举/类型校验、`evidence` 一样的 `ToolArgsError`。它只实现本插件用到的子集（**没有 `presentationMeta`**），其余字段照旧透传给 `ctx.tools.register`。所以下面的“官方 `defineTool`”样例是**契约参考**；在本插件里把 `import { defineTool } from '@deepseek-ai/dsh-tools'` 换成 `import { defineTool } from './tool.js'` 即可，参数写法完全一致。

```js
import { defineTool } from '@deepseek-ai/dsh-tools'

export function registerLatexTools(ctx, service) {
  const tools = ctx.get('tools')
  if (tools === undefined) return () => {}
  const disposers = []
  disposers.push(tools.register(defineTool({ /* ... */ })))
  return () => disposers.forEach((dispose) => dispose())
}
```

### C.2 工具定义形状（live `ToolDefinition` 契约）

```ts
interface ToolDefinition extends ToolSchema {          // ToolSchema: { name, description, parameters, deferLoading? }
  output: { schema: JsonSchemaNode; render(args, value): ContentBlock[]; presentationMeta?(args, value): JsonValue }
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  projectContent?(exec, result): ContentBlock[] | undefined
  finalizeContent?(exec, result): ContentBlock[] | undefined
  timeoutMs?: number                                    // 只作声明，注册表不强制
  isConcurrencySafe?(args: unknown): boolean
  presentCall?(args): ToolCallView | undefined          // Host 本地展示，Web Client 不消费
  presentResult?(args, result): ToolResultView | undefined
}
interface ToolRunContext extends ToolExecution { deferContext(context: UserMessage): void; concludeTurn(): void }
interface ToolExecution { callId; rootCallId; name; schema?; arguments; agent?; parent?; signal: AbortSignal; token }
```

所以 `execute(args, exec)` 里可用的是：`exec.agent`（`{ id: SessionId }`）、`exec.signal`（**必须**观测）、`exec.callId`、`exec.deferContext()`、`exec.concludeTurn()`。

### C.3 `parameters` 是 **DSL**，不是 JSON Schema

`defineTool` 内部把它编译成 JSON Schema（`dsh-tools/lib/index.js:802-810`），编译器在 `dsh-tools/lib/types/schema.js`。规则（逐条来自源码）：

| 位置 | 允许的键 | 说明 |
|---|---|---|
| 每个参数的顶层 | `type` / `required` / `description` / `title` / `default` / `examples` | `required` **只能是 `true`**；写 `false` 直接报错（`schema.js:89-93`） |
| `type: 'object'` | `properties` / `additionalProperties` | **官方 `defineTool` 要求 `additionalProperties` 显式写 `true`/`false`**，否则报错（`schema.js:155-158`）；本插件 vendored 的 `src/tool.js` 不强制，但写上是好习惯，换回官方实现时必需 |
| `type: 'array'` | `items` | items 是单个 value schema |
| 标量类型 | `enum` / `const` | `enum` 必须是非空数组 |
| `oneOf` | `oneOf`（≥2 个分支） | 不能和 `type` 同时出现 |
| 无类型标记 | `type: 'json'` | 作者专用，编译成“任意 JSON”的注解 schema |

合法 `type` 只有：`string | number | integer | boolean | null | array | object | json`。写别的会得到
`schema.type must be string/number/integer/boolean/null/array/object/json, or use oneOf`。

### C.4 两个可直接用的工具

```js
tools.register(defineTool({
  name: 'latex_build',
  description:
    'Compile a local LaTeX project with latexmk (TeX Live) and return structured diagnostics. ' +
    'Use projectRoot (the directory holding the main .tex) or pass mainFile explicitly. ' +
    'Long builds stream progress on the LaTeX sidebar; this call returns when latexmk exits.',
  parameters: {
    projectRoot: { type: 'string', required: true, description: 'Absolute path of the project directory (contains main .tex).' },
    mainFile: { type: 'string', description: 'Entry .tex relative to projectRoot; defaults to the only top-level .tex or main.tex.' },
    engine: { type: 'string', enum: ['xelatex', 'pdflatex', 'lualatex'], description: 'Override the configured engine for this build.' },
    clean: { type: 'boolean', description: 'Remove buildDir before compiling (aurora/clean). Defaults to false.' },
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,          // ← object 节点必须显式写
      properties: {
        ok: { type: 'boolean' },
        exitCode: { type: 'number' },
        pdfPath: { type: 'string' },
        durationMs: { type: 'number' },
        errors: { type: 'array', items: { type: 'string' } },
        warnings: { type: 'array', items: { type: 'string' } },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: value.ok
        ? `latexmk OK (${value.durationMs} ms) -> ${value.pdfPath}`
        : `latexmk failed (exit ${value.exitCode})\n${value.errors.join('\n')}`,
    }],
    // ← 这段 JSON 会变成 Session 里的 result meta，客户端 toolview 从 block.meta 读它
    presentationMeta: (_args, value) => ({
      ok: value.ok, pdfPath: value.pdfPath, errors: value.errors, warnings: value.warnings,
    }),
  },
  isConcurrencySafe: () => false,           // 同一项目的两次构建不能并行
  execute: async (args, exec) => service.build({
    projectRoot: args.projectRoot,
    mainFile: args.mainFile,
    engine: args.engine,
    clean: args.clean === true,
    signal: exec.signal,                    // ← 取消必须传下去
  }),
}))

tools.register(defineTool({
  name: 'latex_status',
  description: 'Report the LaTeX workspace state for one project: last build result, last-good PDF, watch state.',
  parameters: {
    projectRoot: { type: 'string', required: true, description: 'Absolute path of the project directory.' },
  },
  output: {
    schema: { type: 'object', additionalProperties: true },
    render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
  },
  isConcurrencySafe: () => true,
  execute: async (args) => service.status(args.projectRoot),
}))
```

### C.5 返回值、错误、超时、取消

- `execute` 的返回值是**规范 JSON 值**，必须能过 `output.schema`（`defineTool` 会 `validateJsonSchemaValue` 参数，输出侧的 strict 校验由调用方/policy 决定；`render(args, value)` 负责把它变成模型可见内容）。swarm 全部用 `output.schema: { type: 'string' }` + `render: (_a, v) => [{type:'text', text: v}]`（`lib/tools/index.js:78-92` 等），是**最省事**的写法。
- 抛异常 = 工具失败，模型看到 `Error: <message>`，transcript 记结构化失败；不要用返回值表达失败。
- **超时**：`timeoutMs` 在定义里**只是声明，注册表从不强制**（README 中文版第 235 行原文：“定义中的 `timeoutMs` 仅作声明之用：注册表绝不会强制执行截止时间；要强制执行，必须使用 `@deepseek-ai/dsh-tool-call-timeout-policy` 包装层”）。所以 `latex_build` 的 180s 上限要**自己在 service 里用 `AbortSignal.timeout` 或 `Promise.race` 实现**。
- **取消**：协作式。每个工具体都拿到调用方拥有的 `exec.signal` 且**必须观测**；调用前取消 → `ABORTED_BEFORE_DISPATCH`，调用后取消只能把成功结果替换为 `ABORTED`（README 第 126 行）。
- **进度**：**没有**“工具进度”API（事件目录里没有 `tool/progress`；`ToolRunContext` 只有 `deferContext` / `concludeTurn`）。模型侧只能看到流式的参数（例如 `description` 逐字到达）和最终结果。构建进度请走**插件自己的 SSE 路由**推给浏览器（见 D.4）。

### C.6 客户端 toolview 怎么拿到结果数据

链路只有一条：

```
execute 返回 value
  → output.render(args, value)        给模型看
  → output.presentationMeta(args, value)   → ToolExecutionResult.meta（冻结 JSON）
  → Session 持久化 → 客户端 result block 的 block.meta
  → tool.call.toolview 组件从 props.block.meta 读
```

证据：`dsh-tools/lib/index.js:843-865` 把 `presentationMeta` 装进 `output`；`:3650-3657` 在结果物化时调用它并 `snapshotProjection` 成 `meta`。客户端侧 `dsh-client-ui-tool/lib/client.js:71`、`:314`、`:394-458` 都是读 `block.meta` 做卡片。

所以：**要传给右栏/工具卡的结构化字段，全部放进 `presentationMeta`**，不要塞进 `render` 的文本里再解析。

---

## D. Host HTTP 路由：`ctx.webServer.register`

### D.1 精确形状（live 契约）

```ts
type WebRouteKind = 'exact' | 'prefix'
interface WebRoute {
  kind: WebRouteKind
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}
register(route: WebRoute): () => void
```

- 匹配顺序：**精确表 → 最长前缀 → fallback**；同表重复 `(kind, path)` 直接抛（`dsh-host-webserver` README 第 12、61 行）。
- **没有 `methods` / `authorizer` 选项**。方法分发、鉴权、body 解析都得自己在 handler 里做。
- handler 抛错 → 该请求 400（响应头已发则销毁 socket），只记 warning，不退出进程（README 第 71 行）。

### D.2 路由骨架 + 鉴权（照抄 swarm）

**为什么必须自己鉴权**：webServer 是“不带任何 harness 概念的普通路由注册表”，**不提供服务器级认证或来源策略**（host-webserver README 第 130 行）。浏览器访问 `/api` 走的是 connection 的信任栅栏，自定义路由不在里面。swarm 的注释写得很直白：`All /swarm requests use the SAME Host/Origin/auth boundary as Connection`（`lib/routes.js:318`）。

```js
function registerLatexRoutes(ctx, service) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return undefined

  const unregister = webServer.register({
    kind: 'prefix',
    path: '/latex',
    async handler(req, res) {
      // 1) 先认证，再解析 URL / body
      let connection
      try {
        connection = ctx.get('connection')
        if (connection === undefined || typeof connection.admit !== 'function') {
          return sendJson(res, 503, { error: 'connection service unavailable' })
        }
        const admission = connection.admit({ headers: req.headers })
        if ('rejection' in admission) {
          return sendJson(res, admission.rejection === 401 ? 401 : 403, { error: 'request refused' })
        }
      } catch {
        return sendJson(res, 503, { error: 'connection admission unavailable' })
      }

      // 2) 自己按字面 pathname 分方法（不要用前缀别名、不要 OPTIONS 放行）
      const url = req.url ?? ''
      const pathname = url.split('?', 1)[0]
      try {
        if (pathname === '/latex/health' && req.method === 'GET') {
          return sendJson(res, 200, { ok: true, service: 'dsh-latex', version: service.version })
        }
        if (pathname === '/latex/status' && req.method === 'GET') {
          const project = new URL(url, 'http://localhost').searchParams.get('project') ?? ''
          return sendJson(res, 200, service.status(project))
        }
        if (pathname === '/latex/build' && req.method === 'POST') {
          requireJson(req)
          const body = await readJsonBody(req)            // 自己实现：字节上限 + 总超时
          return sendJson(res, 200, await service.buildFromUi(body))
        }
        if (pathname === '/latex/events' && req.method === 'GET') {
          return openEventStream(req, res, service)       // SSE，见 D.4
        }
        return sendJson(res, 404, { error: 'not found' })
      } catch (error) {
        sendJson(res, error.status ?? 400, { error: String(error.message ?? error).slice(0, 2048) })
      }
    },
  })

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    unregister()
    service.closeAllStreams()      // 自己的 SSE 连接要在这里统一收掉
  }
}
```

`connection.admit({ headers })` 返回 `{ peer }` 或 `{ rejection: 401 | 403 }`，逐字来自 `lib/routes.js:330-346`。swarm 甚至不用 peer，只做准入；要用 peer（例如按 principal 区分）也可以。

> 另一条（更“原生”但本文未在插件里见到的）路：`ctx.connection.fetch.register({ path, methods, requestBody, fetch })`（live `HostConnectionFetch` / `ConnectionFetchRoute`）。它由 Connection 统一做认证与 body 模式（`'buffered' | 'streaming'`），`fetch(request)` 拿 `Request` 返回 `Response`。**UNCERTAIN**：`path` 是否相对 `/api` 的精确路径、与 `/api` 通用桥的优先级如何——要验证就读 `dsh-client-connection` 的 host 半侧源码或写个 5 行插件试。当前建议：**用 webServer + admit 的已验证路径**。

### D.3 浏览器侧怎么访问（不需要 token）

- 客户端用**相对 URL**：`fetch('/latex/status?project=...')`、`new EventSource('/latex/events')`。swarm 就是这么写的（`lib/client.js:70,147,204,2193`）。
- 不需要显式 header/credentials：同源请求默认带 cookie；页面加载时 `authorizeIndex` 已经种下 **host-only / HttpOnly / SameSite=Strict** 的签名 cookie（30 天，绑定 hostname+port，`dsh-client-connection` README 第 41-47 行）。`admit()` 校验的就是它。
- 因此：**不要**在客户端存 token，也**不要**给自定义路由加 `/api` 前缀去蹭栅栏——精确/前缀注册在 `/api` 之前就可能命中。
- POST 记得 `content-type: application/json`（swarm 的 `requireJson` 会 415 拒绝其它类型）；swarm 的客户端写法：

```js
const res = await fetch('/latex/build', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(payload),
  signal,
})
const json = await res.json()
if (!res.ok || json.ok !== true) throw new Error(json.error ?? `HTTP ${res.status}`)
```

（形状取自 `lib/client.js:145-161`。）

### D.4 SSE（swarm 的完整做法）

服务端（`lib/routes.js:137-226` 的简化版，保留所有关键动作）：

```js
function openEventStream(req, res, service) {
  let closed = false
  const cleanup = () => {
    if (closed) return
    closed = true
    clearInterval(heartbeat)
    unsubscribe()
    service.streams.delete(cleanup)
    res.destroy()
  }
  req.on('aborted', cleanup)
  req.on('error', cleanup)
  res.on('close', cleanup)        // ← 注意：IncomingMessage 的 close 是“请求读完”，不是断开
  res.on('error', cleanup)
  service.streams.add(cleanup)

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-content-type-options': 'nosniff',
    connection: 'keep-alive',
  })
  res.write(`data: ${JSON.stringify({ seq: service.seq })}\n\n`)
  const unsubscribe = service.events.subscribe((event) => {
    if (closed) return
    // 慢客户端只保留“最新一帧”，别排无界队列
    if (res.writableLength > 256 * 1024) { cleanup(); return }
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  })
  const heartbeat = setInterval(() => { if (!closed) res.write(': heartbeat\n\n') }, 15000)
  heartbeat.unref?.()
}
```

要点（都是 swarm 踩过的）：`res.on('close')` 才是断开；15s 心跳；写缓冲超过 256KiB 直接踢；`unref()` 让热重载不被定时器挂住；dispose 时遍历所有 stream 统一 close（`lib/routes.js:400-412`）。

客户端：

```js
const source = new EventSource('/latex/events')
source.onmessage = (e) => { const frame = JSON.parse(e.data); /* 更新 UI */ }
source.onerror = () => { /* EventSource 自己会重连；必要时降级成轮询 */ }
```

（`lib/client.js:66-90` 是带 `stream` 状态机的版本，值得一读。）

### D.5 localhost-only 的安全含义

- 默认绑定 `127.0.0.1`，`:50802`；**非 loopback 监听 = 把未受保护的静态资源与自定义路由暴露到该网络**（host-webserver README 第 130 行）。不要为了“手机也能看”改 bind。
- 路由必须自己做 Host/Origin 校验（`connection.admit` 已包含：Host 必须是 loopback / 绑定 IP / `trustedHosts`；带 `Origin` 时必须同 authority；`sec-fetch-site: cross-site` 拒绝，`dsh-client-connection` README 第 47 行）。
- 上传/写文件类接口要**自己做字节上限和超时**（swarm：`bodyBytes 1MiB`、`bodyReadMs 10s`，`lib/routes.js:3-11`）。
- 输出一律 `cache-control: no-store`，`content-type` 明确带 charset，加 `x-content-type-options: nosniff`。

---

## E. 子进程：`ctx.subprocess.spawn`

### E.1 精确 spec（live 契约，逐字）

```ts
interface SubprocessSpawnSpec {
  argv: readonly string[]
  cwd: string
  stdio: SubprocessStdio
  graceMs: number
  signal?: AbortSignal
  env?: NodeJS.ProcessEnv
}
interface SubprocessStdio {
  stdin: 'ignore' | 'pipe' | { readonly data: string }
  stdout: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } }
  stderr: 'pipe' | 'inherit' | { maxBytes: number; spill?: { maxBytes: number } }
  control?: 'pipe'
}
interface SubprocessHandle {
  readonly stdin: Writable | undefined
  readonly stdout: Readable | undefined
  readonly stderr: Readable | undefined
  readonly control: Duplex | undefined
  readonly collected: { stdout?: SubprocessOutputReader; stderr?: SubprocessOutputReader }
  readonly done: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>
  terminate(): void
  waitForExit(signal?: AbortSignal): Promise<boolean>
}
interface SubprocessOutputReader {
  readFrom(fromByte: number): { text: string; nextOffset: number; lossy: boolean; spillPath?: string }
}
```

注意**没有** `executable` 字段：第一个元素就是可执行文件，`argv[0]`。`resolveExecutable(command, env?, signal?)` 单独用来解析路径（绝对路径校验 / 裸名查 PATH；**含分隔符的相对路径直接拒绝**，`dsh-subprocess-local` README 第 41 行）。

### E.2 latexmk 的完整用法

```js
async function runLatexmk({ argv, cwd, env, signal, timeoutMs }) {
  const handle = ctx.subprocess.spawn({
    argv,
    cwd,
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: 4 * 1024 * 1024 },
      stderr: { maxBytes: 4 * 1024 * 1024 },
    },
    graceMs: 3000,
    signal,                       // ← 外部取消 == 终止进程
    env,
  })

  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; handle.terminate() }, timeoutMs)
  try {
    const outcome = await handle.done            // { exitCode, signal }
    const out = handle.collected.stdout?.readFrom(0)
    const err = handle.collected.stderr?.readFrom(0)
    return { ...outcome, timedOut, stdout: out?.text ?? '', stderr: err?.text ?? '' }
  } finally {
    clearTimeout(timer)
    await handle.waitForExit().catch(() => {})   // 确保完全停稳再返回
  }
}
```

调用：

> ✅ **本仓库实现与此形状逐字一致**（`latex-plugin/src/build.js:230-246`）：`stdin: 'ignore'`、`stdout: { maxBytes: 1_048_576, spill: { maxBytes: 32MiB } }`、`stderr: { maxBytes: 512KiB, spill: { 8MiB } }`、`graceMs: 5_000`、`signal`、`env: buildEnv(config)`；随后 `await handle.done`、`handle.collected.stdout?.readFrom(0).text`。说明这套 spec 是实测可跑的，不是纸上推演。

```js
const argv = [
  latexmkPath,                       // 绝对路径，或先 await ctx.subprocess.resolveExecutable('latexmk', env)
  '-interaction=nonstopmode',
  '-file-line-error',
  '-synctex=1',
  '-pdf',
  `-outdir=${buildDir}`,
  ...(engine === 'xelatex' ? ['-xelatex'] : engine === 'lualatex' ? ['-lualatex'] : ['-pdf']),
  ...config.extraLatexmkArgs,
  mainFile,
]
const result = await runLatexmk({
  argv,
  cwd: projectRoot,
  env: { ...process.env, PATH: `${config.texBinDir};${process.env.PATH ?? ''}` },
  signal: exec.signal,
  timeoutMs: config.timeoutMs,
})
```

- **env 是“清理后的环境”**：provider 从 scrubbed env 起步（`dsh-subprocess-local` README 第 12 行），需要 PATH / 字体 / `TEXMFVAR` 就显式传。
- **输出读取是 offset 化的、非消耗式**：多个读者互不吃掉对方（live 服务描述）；`lossy: true` 表示内存缓冲截断，此时用 `spillPath` 读完整日志。
- `stdio` 用 `'pipe'` 时读到的是**原始流**，不经过缓冲；`collected` 只在 `{maxBytes}` 模式下有。
- **Windows 取消语义**：普通子进程跑在 helper 持有的 **Job object** 里，`terminate()` 关 Job → 杀掉整棵进程树；`waitForExit()` 等“选定范围”真正变空（README 第 43、86、148-152 行）。`graceMs` 是终止前的宽限（内部先温和后强制）。**不要自己再 `taskkill`**，会重复。
- 直接 `execFile`/`spawn` 是禁止的替代方案：本插件的取消/超时/清理全部依赖这个受管范围。

### E.3 何时用 `spawnTerminal`

不需要：latexmk 是纯命令行，`spawn` 就够。`spawnTerminal` 是给交互式 shell 用的（PTY、前景进程组、SIGINT 写入），语义完全不同（`SubprocessTerminalSpawnSpec` / `SubprocessTerminalHandle`）。

---

## F. 文件监听与读取：`ctx.fs`

### F.1 精确契约（live）

```ts
resolve(path: string, opts?: { cwd?: string; signal?: AbortSignal }): Promise<FsTarget>
processPath(target: FsTarget): string                 // 给子进程用的绝对路径
fileUrl(target: FsTarget): string
contains(parent: FsTarget, child: FsTarget): boolean  // 规范包含判断，别自己拼字符串
stat(target, signal?): Promise<{ version; type: 'file'|'directory'|'other'; size? } | undefined>
listDir(target, signal?): Promise<FsDirEntry[]>       // { name, type, target, version?, size? }
readText(target, signal?): Promise<string>
readBytes(target, signal, maxBytes): Promise<Uint8Array>
readByteRange(target, { offset, length }, signal?): Promise<Uint8Array>
watch(target, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>
```

`FsTarget = { targetKey, displayPath }`；`targetKey` 是**不透明身份**，不要解析、不要跨 provider 混用（`fs` 服务描述）。`watch` 的返回值是**异步 close**函数：

```js
const close = await ctx.fs.watch(target, (error) => { if (!error) schedule() }, abort.signal)
// 停止：
await close()
```

`signal` 只取消**初始化**；已经建立的 watcher 由调用方 `close()` 关闭（live 描述原文）。

### F.2 监听项目 + 防抖 + 越界检查

```js
async function watchProject(projectRoot, config, onChange, signal) {
  const root = await ctx.fs.resolve(projectRoot, { signal })

  // 1) 路径围栏：allowedRoots 非空时，项目必须落在其中一个根之内
  for (const allowed of config.allowedRoots) {
    const allowedTarget = await ctx.fs.resolve(allowed, { signal })
    if (ctx.fs.contains(allowedTarget, root)) { /* ok */ }
  }

  // 2) 防抖：ctx.timer 自带（live 服务：timeout / interval / throttle / debounce）
  const trigger = ctx.timer.debounce(onChange, config.debounceMs)

  // 3) 监听目录（直接子项变化）——包括还不存在的目标，用于等文件创建
  const closeDir = await ctx.fs.watch(root, (error) => { if (!error) trigger() }, signal)

  // 4) 只关心 .tex/.bib：回调里自己过滤
  return async () => { trigger.dispose?.(); await closeDir() }
}
```

- **`ctx.fs.watch` 只观察“一个文件或目录的直接子项”**（live 描述：“Observe one file or a directory's direct entries”）。递归监听要自己遍历/按需多开 watcher；对 LaTeX 项目，直接 watch 项目根 + `buildDir` 就够（改的是根下的 `.tex`/`.bib`）。
- 防抖不是 `fs.watch` 自带的：`debounce` 来自 `ctx.timer`（可选服务，`ctx.get('timer')`），也可以自己 `setTimeout`。
- **路径安全**：用户给的路径先 `ctx.fs.resolve(path, { cwd: sessionCwd })`，再用 `ctx.fs.contains(allowedRoot, target)` 判断；不要 `path.resolve` 后比字符串（大小写、UNC、符号链接都会翻车）。
- `ctx.fs.processPath(target)` 才是给子进程 `cwd` / `argv` 用的路径；`targetKey` 不能给 OS。

### F.3 读文件 / 列目录

```js
const stat = await ctx.fs.stat(mainTexTarget, signal)      // undefined = 不存在
if (stat?.type !== 'file') throw new Error('main .tex is not a regular file')

const source = await ctx.fs.readText(mainTexTarget, signal) // 整文件 UTF-8
const entries = await ctx.fs.listDir(dirTarget, signal)     // 稳定按名排序，不含内容
const pdf = await ctx.fs.readBytes(pdfTarget, signal, 32 * 1024 * 1024)
```

- `readText` 是**整个文件**、带二进制拒绝；大文件用 `streamText` 或 `readByteRange`。
- `readBytes` 的 `maxBytes` 是**硬上限**，超了抛 `FS_TOO_LARGE`，不会截断（live 描述）。
- **`ctx.workspaceFiles.changes(...)` 不是 Host API**：那是给浏览器用的 Remote 流（`@Remote({mode:'stream'}) changes(scope, path, signal)`，见 live `workspaceFiles`）。Host 侧监听一律 `ctx.fs.watch`。

---

## G. Client 模块：`window.__ModuleLoader__.load`

### G.1 精确格式

```js
// latex-plugin/client.js —— 必须是一个“注册 factory”的脚本，由宿主以 /plugins/dsh-latex/client.js 提供
window.__ModuleLoader__.load({
  id: 'dsh-latex',                       // ← 必须等于 package.json 的 name
  factory(require) {
    const React = require('react')       // ← 只能 require 基座表里的模块（见 G.2）
    const h = React.createElement

    // 组件（普通 React 组件；不要自己订阅 Host，用下面注册时注入的回调）
    function LatexTabBody(props) { /* ... */ }

    function apply(ctx) {
      // 所有注册都挂在 ctx.effect 上，随插件卸载/HMR 一起走
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({
          name: 'sidebar.right.pane.tab',
          key: 'dsh-latex',              // ← 等于 tab 类型的 id
          locale: 'latex',
          inject: () => ({ /* 额外 props */ }),
        }, LatexTabBody),
      ), 'latex: sidebar tab body')
    }

    return { inject: ['slots'], apply }  // ← factory 的返回值就是模块导出
  },
})
```

- **factory 返回 `{ apply, inject?, name? }`**：swarm 返回 `{ apply, inject, name }`（`lib/client.js:3581-3583`），模板返回 `{ inject: ['slots'], apply }`（`D:\dsh-tmp\templates\decoration\client.js`）。`inject` 是**数组字面量**（cordis 的 client 插件注入）。
- `id` 必须与包名一致：client-modules 用包名做浏览器模块身份，`/plugins/<id>/client.js` 的路由键也是它（`client-modules/lib/index.js:446` 与 README“解析出的 manifest 包名作为浏览器模块身份”）。
- 执行顺序：脚本只**注册 factory**；factory 在模块首次物化时运行，`apply` 由 Loader 建 entry 后调用（client-modules README“惰性 CJS 模型”）。所以 factory 顶层别做重活，副作用放进 `apply` 或 `ctx.effect`。
- 构建：**宿主不打包你的 client**（`client-modules` README“构建要求”：宿主提供的是已构建的 `lib/client.js`）。本插件可以手写纯 JS（模板就是手写 `React.createElement`），也可以用自己的打包器，但产物必须是上面这个 CJS-factory 形状、只能 `require()` 基座表模块。

### G.2 `require()` 能解析什么（精确列表）

来自 web 外壳的静态模块表（`dsh-web-frontend/dist/assets/index-BXV-oxvX.js` 中 `staticModules` 工厂）：

```js
{
  "react", "react/jsx-runtime", "react-dom", "react-dom/client",
  "@deepseek-ai/cordis", "zod",
  "@tanstack/react-virtual",
  "@deepseek-ai/dsh-client-store",
  "@deepseek-ai/dsh-client-ui-slots",
  "@deepseek-ai/dsh-client-ui-primitives",
  "@deepseek-ai/dsh-client-ui-dockkit"
}
```

其余一律抛错（`client-modules/lib/client.js:884-887`）。要更多模块只有两条路：声明 `dsh.client.external` + 由另一个动态插件行提供，或自己内联代码。**本插件只需要 `react`**（图标/下拉都不需要基座组件也可以自己做）。

### G.3 `ctx.slots`：注册与注入

观察到的调用形状（全部来自随包 client bundle）：

```js
ctx.slots.inject(name, () => ctx.slots.register(entry, Component))     // 单个
ctx.slots.inject(name, function* () { yield ...; yield ... })          // 多个（sidebar-right 用）
ctx.slots.register({ name, key?, id?, order?, label?, locale?, children?, store?, inject?, hooks? }, Component)
ctx.slots.entriesOfSlot(name)          // 数量
ctx.slots.subscribe(name, listener)    // 变更通知
ctx.slots.installLocale(...)           // 内部（locale 服务用）
```

- `key`（keyed slot）与 `id`（list/单例 slot）是互斥的定位方式：`sidebar.right.pane.tab` 用 `key`，`settings.section` / `conversation.view` 用 `id`。
- `inject` 可以是**函数**：`inject: (sessionId) => ({ ... })`，给组件额外 props（`dsh-client-ui-tool/lib/client.js:2422-2430`）；也可以是对象 `{ hooks: {...} }`（sidebar-right 的 `inject: { hooks: { tabInfo } }`）。
- `locale: 'latex'` 会给组件注入绑定该命名空间的 `t` prop（`tool-client.js:2418-2430` + `BashRow({ t })`）。
- 组件 props = **标准 scope props**（例如 `sessionId`）+ 你 `inject` 的 + `locale` 的 `t`；`tool.call.toolview` 还有 owner props（见 I.1）。
- **UNCERTAIN**：`slots.register` 的完整类型（`children`/`store` 的确切语义）没有拿到公开 d.ts；上表是从 `sidebar-right`、`tool`、`conversation` 三个真实 bundle 归纳的。验证方法：client inspect 恢复后 `Slots.listSubTree(root='sidebar.right.pane.tab')`，或读 `@deepseek-ai/dsh-client-ui-slots` 的 src（本机 app.asar **没有**这个包，只有 web 前端里编译进去的版本）。

### G.4 右侧栏 tab：两阶段注册

**阶段 1：注册“类型”**（`ctx.sidebarRightTabs.register`，源码 `dsh-client-ui-sidebar-right/lib/client.js:4580-4611`）：

```js
ctx.sidebarRightTabs.register({
  id: 'dsh-latex',            // 必填，全局唯一；也是正文/标题注册的 key
  kind: 'latex-preview',      // 必填，打开的 kind
  patterns: [],               // 可选：作用在 dsh-resource:// 地址上的 glob（可省略 = 页类型）
  priority: 'extension',      // 'extension'(默认) | 'builtin' | 'fallback'，同名 kind 的优先级带
  canOpen: (address) => true, // 可选：否决一次 pattern 命中
  title: () => 'LaTeX',       // 必填（或 (address) => string）：chip 文字，打开时捕获
  guide: [],                  // 可选：引导页入口 [{ id, order, title: () => string, description?: () => string }]（本插件 client.js:1786-1808 用的是函数形式）
  keepMounted: true,          // 可选：切 tab/收起不销毁正文
  multiple: false,            // 可选：允许同 kind 多实例（每实例独立内容地址）
})
```

- 返回 disposer；**同一 `id` 注册第二次会 throw**；同 kind 的 `extension` 与 `builtin` 可以共存（extension 生效），两个同带或任何 `fallback` 撞名都 throw（`:4583-4588`）。
- `guide` 条目 id 在**一个类型内**唯一（`:4583`）。

**阶段 2：注册“正文”**（key = 类型 id）：

```js
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register({
    name: 'sidebar.right.pane.tab',
    key: 'dsh-latex',          // ← 类型 id，不是 kind
    locale: 'latex',
  }, LatexTabBody),
)
```

正文里用框架注入的 `useTabInfo()` 读运行时信息（源码 `tabInfoFactory`，`:4856-4893`）：

```js
const info = useTabInfo()
// info = {
//   sidebar: { expanded: boolean, fullscreen: boolean },
//   panel:   { id: paneId },
//   tab: {
//     id, kind, contentId, title,          // 记录字段（打开时固化）
//     visible,                             // 前台可见（含飘窗判断）
//     navigation: { params, revision },    // 本次导航参数
//     signal: AbortSignal,                 // occurrence 卸载时 abort
//     actions: { openTab, openResource, openResourceIn, close, bindCommands, ... },
//     refreshShortcut,
//   },
// }
```

- `useTabInfo()` 必须在**正文/标题组件里**调用；`navigation.params` 就是 `openTab(kind, { params })` 传进来的值。
- 可选标题 slot：`sidebar.right.pane.tab.title`，同样 `key: 'dsh-latex'`。
- 收起/切会话**不会 abort** `tab.signal`；只有记录消失或插件卸载才 abort（README“Tab 域”）。

### G.5 打开 tab / 打开资源

```js
// 1) 打开本插件自己的页（kind 已在 G.4 注册）
const nav = ctx.get('sidebarRight')       // 或 inject: ['sidebarRight'] 后 ctx.sidebarRight
nav.openTab('latex-preview', {
  params: { projectRoot, mainFile },      // → 正文里 useTabInfo().tab.navigation.params
  // 可选放置控制：
  // paneId, replaceTab, preferNewPane, revealIfOpened
})

// 2) 打开一个已有文件（PDF / 日志 / .tex 行号跳转）
nav.openResource('dsh-resource://file/session/<sessionId>/<相对或绝对路径>', {
  params: { line: 42 },
})
```

- `openResource(address, options)` **只接受 `dsh-resource://` 开头**的地址，且必须有类型认领，否则 throw（`dsh-client-ui-sidebar-right/lib/client.js:2293-2296`、`:4702-4719`）。
- `options` 字段：`kind?`（强制某个类型打开）、`params?`（导航参数）、`paneId?`、`replaceTab?`、`preferNewPane?`、`revealIfOpened?`（`:2309-2326`）。
- 文档预览的认领规则：`patterns: ["dsh-resource://file/[\\s\\S]+"]`，`priority: 'fallback'`，`canOpen` 只接受 **session 作用域**（`dsh-client-ui-sidebar-documentpreview/lib/client.js:1079-1088`）。所以 `.pdf` 地址会被它接走并渲染（PDF.js 在包里）。
- **PDF 地址的正确拼法**（同包 `:35-57`，`sessionFileAddress`）：

```js
const FILE_PREFIX = 'dsh-resource://file/'
const enc = (s) => encodeURIComponent(s).replace(/%3A/gi, ':')     // 保留盘符的冒号
const pdfAddress = `${FILE_PREFIX}session/${enc(sessionId)}/${relativePath
  .replace(/\\/g, '/')
  .replace(/^(?:\.\/)+/, '')
  .split('/').map(enc).join('/')}`
```

  路径可以是相对工作区或绝对路径；`.`/`..` 段由 Host 解析，不要在客户端规范化掉。**同一路径在不同 session 下是两个 tab**，内容身份就是整个地址。

- `openTab` 作用于**屏幕上的会话**（`mounted`）；没有会话/没 adopted store 时会 throw 或 no-op（`:2234-2246`、README“`ctx.sidebarRight`”）。所以从 toolview 打开是安全的（toolview 本身在会话里），而从全局角标打开要判断 `ctx.sidebarRight.mounted`。

### G.6 locale

```js
const inject = ['slots', 'locale']

function apply(ctx) {
  ctx.effect(() => ctx.locale.register('latex', {
    zh: { 'tab.title': 'LaTeX', 'build.ok': '编译成功' },
    en: { 'tab.title': 'LaTeX', 'build.ok': 'Build OK' },
  }), 'latex: dictionaries')

  const t = ctx.locale.bind('latex')
}
```

- `register(ns, { zh, en })`：**zh 与 en 必须都给**（`dsh-client-locale` README 第 38 行）；键是扁平字符串，`t(key, params)` 支持 `{name}` 插值（swarm 用 `t('board.refreshError', { error })`）。
- `ctx.locale.resolveText(LocalizedText)` 可解析插件元信息里的 `{en, zh}` 映射。
- 通过 slot 注册时的 `locale: 'latex'`，组件直接拿 `t` prop（框架注入）。
- **`locale/*.json` 与运行时词典是两回事**：前者只给插件列表/设置页显示 title/description/icon（A.6），后者必须 `ctx.locale.register`。

### G.7 ctx.remote / ctx.connection / fetch

```js
// 生成的 Remote 命名空间（Host 侧 @Remote 方法）
const settings = ctx.remote.settings          // settingsController: describe/update/replace/mutate/openSettingsDocument
const files    = ctx.remote.workspaceFiles    // read/readBytes/stat/list/changes

// 老式 connection face（swarm 的兼容写法，两路都试）
let api
try { api = ctx.get('connection')?.api } catch { api = undefined }
```

- `ctx.remote.<ns>.<method>(...)` 的返回/异常是生成的 Remote 代理（`dsh-client-connection` README 第 32-34 行）。**对本插件来说不必用 Remote**：自定义 HTTP 路由更简单、可控。
- `fetch` 用相对路径即可（D.3）。

### G.8 主题 token（`--dsw-alias-*`）

用 CSS 变量，不要硬编码颜色：

```css
.latex-panel { color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-layer-1); }
.latex-error { color: var(--dsw-alias-state-error-primary); }
.latex-ok    { color: var(--dsw-alias-state-success-primary); }
.latex-muted { color: var(--dsw-alias-label-tertiary); }
.latex-border{ border: 1px solid var(--dsw-alias-border-l1); }
```

本机主题包里实际声明的 107 个 `--dsw-alias-*`（扫描 `dsh-client-ui-theme/lib/client.js` 得到；`Theme.listTokens` 在本环境超时，**UNCERTAIN** 是否另有运行时别名，验证方法见 J）：

```
bg-base bg-document-preview bg-document-selection bg-layer-1 bg-layer-2 bg-layer-3
bg-mask-1 bg-mask-2 bg-mask-3 bg-mask-drop bg-mask-photo bg-module-platform
bg-multi-select bg-overlay bg-skeleton
border-inverted border-inverted2 border-l1 border-l2 border-l2-darkmode-thin border-l3 border-l4
brand-primary brand-primary-invert brand-primary-new-colorprimary-new-color brand-text
button-contrast-fill button-elevated-fill button-floating-fill button-floating-hover
button-ghost-active-border button-ghost-active-fill button-ghost-active-hover
button-info-fill button-info-hover button-primary-dimmed button-primary-fill button-primary-hover
button-tool-bar-fill button-tool-bar-fill-invisible button-tool-bar-hover
code-diff-added code-diff-deleted
file-diff-added-bg file-diff-added-gutter file-diff-added-marker
file-diff-deleted-bg file-diff-deleted-gutter file-diff-deleted-marker
interactive-bg-active interactive-bg-hover interactive-bg-hover-accent
interactive-bg-hover-danger interactive-bg-hover-solid
label-caption label-deep-diving label-deep-diving-shimmer label-dimmed label-document-preview
label-primary label-primary-bluish label-primary-dimmed label-primary-foreground
label-primary-inverted label-secondary label-shimmer label-tertiary link
markdown-citation markdown-code-block markdown-code-block-banner
markdown-code-segment-selected markdown-code-segment-unselected markdown-inline-code
markdown-placeholder markdown-tag
menu-group-header-fill menu-icon
onboarding-accent onboarding-card-fill onboarding-checkbox-border onboarding-secondary-fill
scrollbar-bg-l1 scrollbar-bg-l2 scrollbar-hover-l1 scrollbar-hover-l2
settings-card-fill settings-card-stroke
state-business-primary state-business-tertiary
state-error-primary state-error-secondary
state-idle-primary
state-success-primary state-success-secondary state-success-tertiary
state-warn-label state-warn-primary state-warn-secondary state-warn-tertiary
switch-thumb toast-bg toast-label tooltip-bg tooltip-key-bg
turn-trigger-bg turn-trigger-bg-hover
```

其余可用的非 alias token：`--dsh-content-font-size`、`--dsh-content-font-delta`、`--dsh-content-font-size-secondary`、`--dsh-code-font-size`、`--dsw-radius-*`、`--dsw-shadow-lv*`、`--dsw-font-markdown-code-block`（theme README 第 82-86 行）。

### G.9 一个能跑的最简 client.js

```js
window.__ModuleLoader__.load({
  id: 'dsh-latex',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useRef, useState } = React

    function LatexTabBody({ t, sessionId, useTabInfo }) {
      const [state, setState] = useState({ phase: 'idle', lines: [] })
      const info = useTabInfo()          // ← prop 注入（已由本仓库 client.js:1056-1060 验证）
      const params = info.tab.navigation.params ?? {}

      useEffect(() => {
        let closed = false
        const es = new EventSource(`/latex/events?project=${encodeURIComponent(params.projectRoot ?? '')}`)
        es.onmessage = (e) => {
          if (closed) return
          const frame = JSON.parse(e.data)
          setState((prev) => ({ phase: frame.phase ?? prev.phase, lines: [...prev.lines.slice(-400), ...(frame.lines ?? [])] }))
        }
        return () => { closed = true; es.close() }
      }, [params.projectRoot])

      return h('div', { style: { padding: '8px 12px', color: 'var(--dsw-alias-label-primary)' } },
        h('div', { style: { color: 'var(--dsw-alias-label-tertiary)', marginBottom: 6 } }, t('tab.status'), ' · ', state.phase),
        h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12 } }, state.lines.join('\n')),
      )
    }

    function apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({
        id: 'dsh-latex', kind: 'latex-preview', title: () => 'LaTeX', keepMounted: true,
      }), 'latex: tab type')

      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'dsh-latex', locale: 'latex' }, LatexTabBody),
      ), 'latex: tab body')
    }

    return { inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'locale'], apply }
  },
})
```

> ✅ **已由本仓库实现验证（不再是 UNCERTAIN）**：`useTabInfo` / `useSessions` / `t` 都是**框架按 slot 注入的 props**，不是需要 import 的 hook。证据 `latex-plugin/client.js:1056-1060`：
> ```js
> function LatexPreview(props) {
>   const { sessionId, useSessions, useTabInfo, t: seatT } = props;
> ```
> 也就是说：正文组件的第一个参数是 `{ sessionId, useSessions, useTabInfo, t, ...你 inject 的 }`。`useTabInfo()` 返回 `{ sidebar, panel, tab }`（G.4）。注册时不写 `inject` 也能拿到这些标准 props；写了 `inject` 只是**追加**你自己的。

---

## H. 设置：`settings.section` 与配置读写

### H.1 注册一个设置分区（swarm 写法，源码行号精确）

```js
ctx.slots.inject('settings.section', () =>
  ctx.slots.register({
    name: 'settings.section',
    id: 'latex',            // 唯一 id
    order: 40,              // 排序（swarm 用 30）
    label: 'LaTeX',         // 分区标题（字符串；要本地化就自己在组件里用 t）
  }, LatexSettingsSection),
)
```

`dsh-swarm-orchestrator/lib/client.js:3646-3651` 原文即 `{ name: 'settings.section', id: 'swarm', order: 30, label: 'AI Swarm' }`。组件本身**没有必需 props**：swarm 的 `SwarmSettingsSection()` 不接收参数，自己用 `useT()` + 自己的 store（`:2776-2790`）。

### H.2 客户端读写插件配置：两条路

**路 A（推荐先做）：只读展示 + YAML 配置。** 设置分区里显示 `texBinDir`、引擎、当前构建状态；改配置让用户编辑 `profile/cordis.patch.yml`（或后续再做表单）。

**路 B：schema 表单（能做，但有坑）。**

1. 只有 **`.volatile()` 子树里的字段**会出现在表单里，也只有它们可写：
   - `describe()` 过滤：`if (form === void 0) return []`，而 `volatileForm(schema)` 只保留 volatile 节点（`dsh-settings/lib/index.js:413-419`）；
   - 写入校验：`Config field "..." is not volatile` 直接抛（`:505-507`、`:520`）。
2. **当前可解析的 schemastery 是 3.18.1，没有 `.volatile()`**（见 0. 表格）。`.volatile()` 的实现等价于 `.extra('volatile', true)`（宿主 3.18.5 源码：`Schema.prototype.volatile = function () { return this.extra("volatile", true) }`）。所以在 3.18.1 下要写：

```js
export const Config = Schema.object({
  texBinDir: Schema.string().default('').extra('volatile', true),
  engine: Schema.union(['xelatex', 'pdflatex', 'lualatex']).default('xelatex').extra('volatile', true),
  autoBuild: Schema.boolean().default(true).extra('volatile', true),
  // 注意：volatile 字段不能嵌在另一个 volatile 里，也不能在数组/字典里（validateVolatileSchema）
  extraLatexmkArgs: Schema.array(Schema.string()).default([]),   // ← 数组元素不可 volatile
})
```

3. 客户端写入用 `settingsController` 的 Remote（live 契约）：

```js
// ns = profile entry id = 'latex'
await ctx.remote.settings.update('latex', { engine: 'lualatex' }, revision)   // 合并
await ctx.remote.settings.replace('latex', { /* 完整表单值 */ }, revision)     // 重置后整段替换
await ctx.remote.settings.mutate('latex', [{ op: 'set', path: ['engine'], value: 'xelatex' }], revision)
const view = await ctx.remote.settings.describe()   // { writable, hasDocument, namespaces: [{ ns, value, schema, revision, ... }] }
```

   `revision` 用 `describe()` 返回的当前值做乐观锁；`update/replace/mutate` 都返回更新后的 namespace view。
4. **UNCERTAIN**：`.extra('volatile', true)` 在 3.18.1 的 `Schema.toJSON()` 里是否保留 `meta.volatile`（读源码：`meta` 是普通对象、`toJSON` 会序列化 `meta`，所以应当保留）。**验证方法**：`cordis_inspect_query(Config.listConfigs, {entry:'latex'})` 看投影出来的 JSON Schema 里有没有 `"volatile": true`，然后 `ctx.remote.settings.describe()` 看该 entry 是否出现。

### H.3 Host 侧改配置

`configEditor.edit(entry, change)`（live 契约）：

```js
const editor = ctx.get('configEditor')
const entry = editor.entries().find((e) => e.options.id === 'latex')
await editor.edit(entry, (current, inherited) => ({ ...current, engine: 'lualatex' }))
```

它“持久化完整原始配置并通过正常 Loader 路径应用”，是 settings 服务的底座。**没有**对客户端的 Remote 暴露；客户端只能走 `remote.settings.*`。

### H.4 客户端只读状态页的取数

优先用**自定义路由**（D.2）：`fetch('/latex/status?project=...')`。这样不依赖 settings/Remote 的生成管线，和构建事件共用一套数据源。

---

## I. Tool view：`tool.call.toolview`

### I.1 注册与 owner props（源码精确）

```js
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register(
    { name: 'tool.call.toolview', key: 'latex_build', locale: 'latex' },
    LatexBuildRow,
  ),
)
```

`key` 是**工具的 wire name**（`dsh-client-ui-tool` README 第 39-43 行；swarm 用 `key: 'swarm_dispatch'`，`lib/client.js:3639-3645`）。

组件拿到的 props（`dsh-client-ui-tool/lib/client.js:1935-1958` + README 第 46 行）：

```ts
{
  callId: string
  toolName: string
  phase: 'preparing' | 'start' | 'result'
  block: {                    // 随 phase 不同
    callId, name, args?, argsRaw?, call?, meta?, content?, ...
  }
  cwd?: string
  home?: string
  openFile?: (event?) => void   // 打开文件（chat 把它路由到右侧栏文本预览）
  loadImage?: (...) => ...      // 结果含图片时用
  inspect?: () => void          // 打开轨迹视图
  useDisclosure: () => { expanded, toggle }
  sessionId: string             // ← 标准 scope prop（BashRow 就是这么拿的，:2486-2488）
  t?: (key, params?) => string  // 注册时写了 locale 才有
}
```

- `phase === 'preparing'` 时没有 `meta`/结果，只有增长中的 args；`'result'` 时读 `block.meta` 拿 `presentationMeta`（C.6）。
- 组件里**不要**自己 fetch 工具结果：结果已经在 props 里；需要额外数据再打路由。

### I.2 从 toolview 自动打开右侧栏

组件本身没有 `ctx`。两种做法：

1. **注册时闭包注入**（推荐）：

```js
ctx.slots.inject('tool.call.toolview', () =>
  ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'latex_build',
    inject: () => ({
      openPreview: (params) => ctx.get('sidebarRight')?.openTab('latex-preview', { params }),
      openPdf: (sessionId, relPath) => ctx.get('sidebarRight')
        ?.openResource(toFileAddress(sessionId, relPath), {}),
    }),
  }, LatexBuildRow),
)
```

2. 组件里 `useEffect` 在成功后调用：

```js
function LatexBuildRow({ block, phase, openPreview, t }) {
  const meta = block?.meta ?? {}
  useEffect(() => {
    if (phase !== 'result' || !meta.ok || !meta.autoOpen) return
    openPreview({ projectRoot: meta.projectRoot, pdfPath: meta.pdfPath })
  }, [phase, meta.ok, meta.pdfPath])
  /* ...渲染行... */
}
```

- `autoOpen` 这类开关从哪来？工具结果里带（`presentationMeta`）最省事；或在 `apply` 时 `fetch('/latex/health')` 读配置并放进模块级变量。
- 右栏是**每会话**的：`openTab` 作用于当前屏幕会话，正好是点击 toolview 的会话，不会串台。
- 想“直接打开现成 PDF 而不是自己的 tab”：用 `openResource(dsh-resource://file/session/<sessionId>/<rel>)`，documentpreview 会接管并渲染 PDF（G.5）。

---

## J. 验证：装完之后怎么确认它活着

### J.1 Host 侧（可靠，当前环境可用）

> ✅ **已实测（2026-11-03）**：`dsh-latex` 装入 `desktop` profile 后，本会话的工具列表里直接出现 `latex_compile`、`latex_get_diagnostics`、`latex_preview`、`latex_clean`、`latex_cancel`、`latex_get_status`、`latex_synctex` 七个工具 —— 这是“patch 行被接纳 + 包解析成功 + `ctx.tools.register` 跑到”的最直接证据。注意本插件没导出 `Config`，所以下面第 1 条查询会显示**无 schema**，属正常。

```
# 1) 配置 entry 是否被 Loader 接纳（证明 patch 行 + 包解析 + Config schema 都在）
cordis_inspect_query(platform="host", provider="Config", method="listConfigs",
                     input={ "name": "dsh-latex" })
# 期望：目录里出现 entry id "latex"，schema status 正常
# 再看精确 schema：
cordis_inspect_query(platform="host", provider="Config", method="listConfigs",
                     input={ "entry": "latex" })
# 期望：texBinDir / engine / ... 的 JSON Schema；若加了 .extra('volatile', true) 可在这里确认

# 2) 工具是否注册（证明 ctx.tools.register 跑到了）
cordis_inspect_query(platform="host", provider="Tool", method="listTools")
# 期望：latex_build / latex_status 出现，parameters 是编译后的 JSON Schema

# 3) 若 ctx.provide('latex', service)
cordis_inspect_query(platform="host", provider="Service", method="listService",
                     input={ "service": "latex" })
```

### J.2 Client 侧

```
cordis_inspect_query(platform="client", provider="Slots", method="listSubTree",
                     input={ "root": "sidebar.right.pane.tab" })
# 期望：occupants 里有 key "dsh-latex"
cordis_inspect_query(platform="client", provider="Slots", method="listSubTree",
                     input={ "root": "tool.call.toolview" })
# 期望：occupants 里有 key "latex_build"
cordis_inspect_query(platform="client", provider="Slots", method="listSubTree",
                     input={ "root": "settings.section" })
# 期望：id "latex"
```

> **本环境实测**：上面三条 client 查询**全部 10s 超时**（`Open or reconnect the Harness page, then retry`）。原因不在查询本身：client inspect 需要页面侧应答，而当前没有可应答的页面。**恢复办法**：在 `http://127.0.0.1:50802` 打开/刷新一次 GUI，再重试；仍是超时就把页面 DevTools 打开看 `/plugins/events` 是否 200。
> 页面内替代验证（DevTools Console）：
> ```js
> __DSH_BOOT__.plugins.map(p => p.id).filter(id => id.includes('latex'))
> await fetch('/plugins/dsh-latex/client.js').then(r => r.status)   // 200
> await fetch('/latex/health').then(r => r.json())                  // { ok:true }
> ```

### J.3 日志

- Host 的 `ctx.logger('latex').info(...)` 输出到 **dsh host 进程的 stdout/stderr**。桌面版只在崩溃时写文件：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-{main,host,renderer,web-boot}.log`（本机确认存在 `crash-2026-10-29T22-05-11-767Z-main.log` 等）。**没有**常驻的 `dsh.log`；要看常规日志，用命令行起 `dsh web --profile desktop` 观察终端，或临时把关键信息写进插件自己的 `/latex/health`/`/latex/log` 路由（用 `fetch` 从页面取）。
- Client 的 `console.*` 直接进页面 DevTools。
- 插件加载失败时，`plugin_manager` 的安装结果/`listBundles` 会带 `error.diagnostic`；Web「设置 → 插件」也会显示同步失败。

### J.4 端到端最小验收顺序

1. `plugin_manager install_bundle target=D:\deepseekharness\latex-plugin` → `application: applied`。
2. 刷新 `http://127.0.0.1:50802`。
3. J.1 三条 host 查询。
4. `fetch('/latex/health')` 200；`fetch('/plugins/dsh-latex/client.js')` 200。
5. 对话里调用 `latex_build`（模型工具），看 toolview 是否渲染自定义行。
6. 点该行 → 右栏 `latex-preview` tab 出现，SSE 有构建输出，构建完自动打开 PDF。
7. J.2 的 slot 查询（页面刷新后可恢复）。

---

## 附录 1：已确认“不存在 / 与预期不符”的 API

| 期望 | 实际 | 证据 |
|---|---|---|
| `ctx.webServer.register({ methods, path, handler, authorizer })` | 只有 `{ kind: 'exact'\|'prefix', path, handler }`；无 methods/authorizer | live `WebRoute`；host-webserver README 第 61 行 |
| 工具进度回调（`ctx.tools.progress` / `tool/progress` 事件） | 不存在；只有参数流 + 最终结果 | host Event 目录无 tool/progress；`ToolRunContext` 仅 `deferContext`/`concludeTurn` |
| `timeoutMs` 自动杀工具 | 仅声明，不强制；要装 `@deepseek-ai/dsh-tool-call-timeout-policy` | dsh-tools README.zh 第 235 行 |
| `parameters` 直接用 JSON Schema（`type:'object', required:[...]`） | 是自定义 DSL：`required` 写在**属性里**且只能 `true`；object 必须显式 `additionalProperties` | `dsh-tools/lib/types/schema.js:89-99,152-170` |
| `locale/*.json` 是运行时词典 | 只用于插件元信息（标题/描述/图标） | `app-boot/lib/index.js:2216-2247` |
| 插件 Config 所有字段都能在设置里改 | 只有 `.volatile()` 子树可编辑；其余不出现 | `dsh-settings/lib/index.js:413-419,505-507` |
| `schemastery` 一定带 `.volatile()` | 3.18.1 没有；宿主 3.18.5 才有；用 `.extra('volatile', true)` 等价替代 | 两版本 grep 对比 |
| `dsh.client` 支持 icon 字段 | manifest 只认 platform/inject/external/immediately；icon 走 `exports["./icon"]` 或 package.json `"icon"` | `client-modules/lib/index.js:64-76`；`app-boot/lib/index.js:2085-2112` |
| Client inspect 可以随时查 | 当前环境全部超时（页面无应答） | 实测 4 次 |

## 附录 2：本仓库实际实现 ↔ 本文结论对照（2026-11-03 已装并在跑）

`dsh-latex` 已通过 `plugin_manager.install_bundle` 以 `link:D:/deepseekharness/latex-plugin` 装入 `desktop` profile（`profiles/desktop/package.json:14,43`），本会话的工具列表里已出现 `latex_compile` / `latex_preview` / `latex_synctex` 等 7 个工具，说明 **Host 半侧已激活**。

| 主题 | 实际实现 | 与本文的关系 |
|---|---|---|
| 安装形态 | `link:D:/deepseekharness/latex-plugin`，`dsh.profile.bundles` 含 `dsh-latex` | ✅ `application: applied`（有 HMR）；无需重启 |
| Host 入口 | `index.js:19-20` `export const name` / `version`；**无 `inject`**，用 `wireWhenAvailable(ctx,'tools'/'webServer'/'systemPrompt',...)`（`index.js:28-64`） | ✅ 与 B.3 的“可选服务”模式一致 |
| Config | **不导出 Config**；`src/config.js` 的 `normalizeConfig`（`index.js:13,73`） | ⚠️ 无 Settings 表单；见 0.1 / B.2 |
| 工具 | `src/tools.js` 用 **vendored** `defineTool`（`src/tool.js`）注册 7 个工具；参数 DSL 与官方一致（`required: true` 等） | ✅ 与 C.3 一致；⚠️ 无 `presentationMeta`（`src/tool.js` 只实现 schema+render） |
| HTTP 路由 | `src/routes.js:226-228` `webServer.register({ kind:'prefix', path:'/latex' })`；除 `/latex/health` 外全部 `admit()`（`src/routes.js:116-135,250`） | ✅ 与 D.1/D.2 完全一致 |
| SSE | `GET /latex/events`；`HEARTBEAT_MS=15_000`、`STREAM_LIMIT=24`（`src/routes.js:29-31`） | ✅ 与 D.4 参数一致 |
| 子进程 | `src/build.js` 走 `ctx.subprocess`（超时/取消/进程树清理） | ✅ 与 E 一致 |
| 右栏 tab | 两个类型：`id: 'dsh-latex/panel'` kind `latex-panel`；`id: 'dsh-latex/preview'` kind `latex-preview`；正文 `key` = 类型 id（`client.js:1789-1830`） | ✅ 正是 G.4 的两阶段写法 |
| 组件 props | `{ sessionId, useSessions, useTabInfo, t }`（`client.js:1056-1060`） | ✅ 修正了 G.9 的 UNCERTAIN |
| locale | `ctx.locale.register('latex', DICT)` + `ctx.locale.bind('latex')`（`client.js:1745-1755`），`DICT = { zh, en }` | ✅ 与 G.6 一致 |
| 服务获取 | `ctx.get('sidebarRightTabs')`，try/catch 包住（`client.js:217-223,1772`） | ✅ 与 G.5“可选获取”一致 |
| toolview | 对每个工具名 `key` 注册同一个 `LatexToolCard`（`client.js:1836-1841`） | ✅ 与 I.1 一致 |
| 右栏入口 | 会话 header 动作 `id:'latex' order:60`（`client.js:1846-1853`）+ `guide` 入口（`client.js:1786-1808`） | ✅ guide/header 两种入口都用了 |
| 依赖 | `package.json` 无 `engines` / `peerDependencies` / `immediately`；`client.js` 只 `require('react')` | ⚠️ 本文 A.2 的 engines/immediately 是可选加固，不是必需 |

**本轮未做、后续可加**：`export const Config` + Settings 表单（需先解决 0.1 的依赖解析）；`output.presentationMeta`（当前工具卡从 `/latex/state` + SSE 读状态，而不是结果 meta，做法见附录 3 第 4 条）；`previewSurface: 'document'` 之外的自定义 PDF 渲染已自带（`assets/pdf.min.mjs`，`GET /latex/assets/*`）。

## 附录 3：给后续改动的落地清单

1. `icon.svg`（已存在，≤256KiB）——保持 `exports["./icon"]` 与 `files` 同步。
2. 若加 `Config`：先让 schemastery 可解析（0.1 方案 2），再 `export const Config`；字段名与 `cordis.patch.yml` 完全一致；要在设置页可编辑的字段加 `.volatile()`（3.18.5）或 `.extra('volatile', true)`（3.18.1）。
3. `src/service.js`：`LatexService`（detect latexmk、spawn、解析 `.log`、保留 last-good PDF、并发闸门、SSE 事件源）——已实现。
4. 工具：`src/tools.js` 的 7 个工具已注册；要接 toolview 的结构化数据，优先走 `presentationMeta`（需把 vendored `defineTool` 补上该字段，或换回官方 `defineTool`）。
5. 路由：`/latex/health`、`/latex/state`、`/latex/events`、`/latex/pdf`、`/latex/log`、`/latex/assets/*`、`/latex/action`、`/latex/synctex-inverse`——已实现，鉴权模式见 D.2。
6. `client.js`：两个 tab 类型 + 两个正文 + 7 个 toolview + header 动作 + CSS——已实现。
7. 每次改动后的验证：J.1 三条 host 查询 + 刷新页面 + `fetch('/latex/health')`。

---

### 证据索引（本文引用的源码位置）

| 主题 | 文件 |
|---|---|
| Host 入口 / wireWhenAvailable | `C:\Users\86132\.dsh\profiles\desktop\node_modules\dsh-swarm-orchestrator\lib\index.js:1-88` |
| Config (schemastery) | 同包 `lib\config.js:1-37` |
| 路由 / 鉴权 / SSE | 同包 `lib\routes.js:3-11,137-226,314-413` |
| 工具注册 | 同包 `lib\tools\index.js:1-...` |
| 客户端槽位 / EventSource | 同包 `lib\client.js:66-161,3581-3659` |
| 右侧栏类型注册 / 导航 | `resources\app.asar` → `dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js:2178-2339,4504-4739,4849-4893,4902-5137` |
| 文档地址语法 / PDF 认领 | `.../dsh-client-ui-sidebar-documentpreview/lib/client.js:35-95,1075-1088` |
| toolview props | `.../dsh-client-ui-tool/lib/client.js:1930-1975,2418-2431,2486-2518` |
| Client 模块 manifest | `.../dsh-client-modules/lib/index.js:40-76,445-500,893-935` |
| 静态模块表 | `.../dsh-web-frontend/dist/assets/index-BXV-oxvX.js`（`staticModules` 工厂） |
| settings 投影 | `.../dsh-settings/lib/index.js:400-460,500-541` |
| 插件元信息 / icon | `.../dsh-app-boot/lib/index.js:2085-2247` |
| 安装结果 application | `.../dsh-plugin-manager/lib/index.js:2346-2400` |
| bundle patch 解析 | `.../dsh-app-boot/lib/index.js:517-531` |
| Cordis Config 校验 | `@deepseek-ai/cordis/lib/index.js:950-958` |
| 工具 schema 编译 | `.../dsh-tools/lib/types/schema.js`；`lib/index.js:792-870,3650-3657` |
| 子进程 / fs / webServer 类型 | `cordis_inspect_query(host/Service.listService, service=…)`，service 取 `subprocess`、`fs`、`webServer`、`connection`、`tools`、`pluginManager`、`settingsController` |
