# DSH Find Bar · Ctrl+F 页内查找

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web GUI 提供浏览器式的
`Ctrl+F` 页内查找：输入即高亮、逐个跳转、跟随明暗主题。

DeepSeek Harness 本身没有页内查找，而 Desktop 版运行在 Electron 窗口里、不提供浏览器原生查找栏，
所以这个功能只能以客户端插件的形式提供。本仓库就是一个完整的、可安装的 Harness 插件。

English: [Quick start](#english-quick-start)

---

## 特性

- `Ctrl+F`（macOS `Cmd+F`）开关查找条，`Esc` 关闭。
- 输入即搜索：全部命中黄色高亮，当前命中橙色高亮并自动滚动到视野中央。
- `Enter` / `Shift+Enter` 或点击 ↑ ↓ 逐个跳转，环形循环；计数器显示 `当前/总数`，无命中显示「无结果」。
- 点击 ↑ ↓ 不会抢走输入框焦点，翻页后仍可直接继续输入或按 `Enter`。
- 快捷键通过 Harness 官方 `ctx.shortcuts` 注册（命令 id `find.inPage`），可在
  **设置 → 快捷键** 里改键。
- 界面文案走 `ctx.locale`（中 / 英），配色只用 `--dsw-*` 主题变量，自动适配明暗主题。
- 不修改宿主 DOM：高亮是独立的覆盖层，插件卸载 / 关闭即完全移除。

## 快速开始

### 1. 放入 profile

```powershell
# 本仓库所在位置
$repo       = "C:\src\dsh-find-bar"
# 目标 profile（桌面版默认是 desktop；自定义 profile 换成对应目录）
$profileDir = Join-Path $env:USERPROFILE ".dsh\profiles\desktop"

New-Item -ItemType Directory -Force -Path "$profileDir\local-bundles" | Out-Null
Copy-Item -LiteralPath $repo -Destination "$profileDir\local-bundles\dsh-find-bar" -Recurse -Force

# 在 profile 的 node_modules 里按包名建立链接（Windows 用 Junction，不需要管理员权限）
New-Item -ItemType Directory -Force -Path "$profileDir\node_modules\@local" | Out-Null
New-Item -ItemType Junction `
  -Path   "$profileDir\node_modules\@local\dsh-find-bar" `
  -Target "$profileDir\local-bundles\dsh-find-bar"
```

### 2. 接线

在 **profile 的 `package.json`** 里加依赖与 bundle 选择（已有的内容保留）：

```json
{
  "name": "dsh-profile-desktop",
  "private": true,
  "dependencies": {
    "@local/dsh-find-bar": "file:./local-bundles/dsh-find-bar"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@local/dsh-find-bar"
      ]
    }
  }
}
```

在 **profile 的 `cordis.patch.yml`** 末尾加一行（这是 Host 侧的插件行）：

```yaml
- id: ui-find-bar
  name: "@local/dsh-find-bar"
```

### 3. 加载

重启 Harness 应用，或刷新页面（`Ctrl+R`）。

> 安装版没有 `pnpm run dev:web` 的重建监听，所以改完 profile / 插件文件后必须重启或刷新页面，
> 运行中的页面不会自己长出这个功能。

装好后按 `Ctrl+F`，查找条出现在页面右上角、窗口标题栏下方。

## 使用

| 操作 | 效果 |
|---|---|
| `Ctrl+F` / `Cmd+F` | 打开 / 关闭查找条 |
| 输入 | 实时搜索，高亮全部命中 |
| `Enter` / ↓ | 下一个命中 |
| `Shift+Enter` / ↑ | 上一个命中 |
| `Esc` / × | 关闭并清除高亮 |

## 配置

- **改键**：设置 → 快捷键，搜索 “在页面中查找”（id `find.inPage`）。默认只声明了
  `desktop:macos` / `desktop:windows` / `desktop:linux` 三个默认绑定；在浏览器里运行 Harness
  时默认不绑定（避免抢占浏览器原生 `Ctrl+F`），需要的话手动绑一次即可。
- **位置**：查找条停靠在右上角，坐标写死在 `client.js` 的 `box` 样式里：

  ```js
  position: 'fixed',
  top: '96px',    // 窗口标题栏 + 会话标题行下方
  right: '20px',
  ```

  想贴边就调小 `top`，想换角落就改 `left/right`。

## 工作原理

插件是标准的 Harness bundle，分两半：

| 文件 | 作用 |
|---|---|
| `package.json` | 声明 `dsh.bundle.patch`（Host 行）与 `dsh.client`（浏览器模块），无需任何 npm 依赖 |
| `cordis.patch.yml` | 插入 Host 行 `ui-find-bar`（本身不做任何事，只让包进入组合树，从而让 Host 扫描到它的浏览器半侧） |
| `index.js` | Host 半侧空实现 `export function apply() {}` |
| `client.js` | 浏览器半侧：注册 `shell.overlay` 槽位 + `find.inPage` 快捷键 + 查找逻辑 |

查找逻辑：

1. 用 `TreeWalker` 遍历页面文本节点，跳过脚本 / 样式 / 隐藏元素 / 输入框 / 终端 / 浮层（侧边栏、查找条自身）
   以及标了 `data-find-bar-ignore` 的子树。
2. 对每个命中用 `Range` 标记，再用 `range.getClientRects()` 在独立覆盖层里画矩形——
   **不包裹、不修改任何宿主元素**，因此不会破坏 React 的渲染。
3. 滚动 / 缩放 / 内容增长时重算矩形位置（`requestAnimationFrame` 节流，打开后 12 秒内每秒重锚定一次）。
4. 搜索结果是命令式状态，`subscribe()` 在 `search()` / `step()` 之后通知 React 重渲染，
   保证计数器与箭头可用状态永远与当前结果一致。

## 目录结构

```
dsh-find-bar/
├── package.json        # 包清单 + dsh.bundle / dsh.client 声明
├── cordis.patch.yml    # Host 行
├── index.js            # Host 半侧（空）
├── client.js           # 浏览器半侧（全部逻辑）
├── test/
│   └── search-harness.cjs   # 最小 DOM shim + 搜索核心回归测试
├── LICENSE
└── README.md
```

## 开发

```bash
npm run check   # node --check 语法检查
npm test        # 搜索核心回归测试（可见性过滤、大小写、环形跳转、通知、高亮层生命周期）
```

`test/search-harness.cjs` 用一个手写的最小 DOM shim 直接加载真实的 `client.js`，
所以不需要浏览器、不需要安装依赖。

页面里还暴露了一个调试入口，可在 DevTools 控制台使用：

```js
__dshFindBar.open()          // 打开查找条
__dshFindBar.search('关键词') // 直接搜索
__dshFindBar.next()          // 下一个
__dshFindBar.finder.status() // '1/22' | 'empty' | ''
```

## 已知限制

- 只搜索**已渲染**的 DOM：虚拟列表里还没渲染出来的历史消息搜不到。
- `iframe` 内容（如内嵌网页、部分文档预览）不参与搜索。
- 单次最多 1500 个命中（防止极端页面卡顿）。
- 查找条是页面级浮层，停靠在右上角；右侧栏打开时可能与其重叠。
- 主要在 **Windows 桌面版**（Harness 44.7.0）上验证；macOS / Linux 未实测。
- 只声明了桌面默认键位，浏览器运行时需要手动绑定一次。

## 卸载

1. 从 profile 的 `cordis.patch.yml` 删除 `ui-find-bar` 行；
2. 从 profile 的 `package.json` 删除 `dsh.profile.bundles` 与 `dependencies` 里的 `@local/dsh-find-bar`；
3. 删除 `node_modules\@local\dsh-find-bar`（先解除链接再删目录）与 `local-bundles\dsh-find-bar`；
4. 重启或刷新页面。

## 想改包名？

如果你 fork 后要用自己的作用域（例如 `@you/dsh-find-bar`），需要同时改三处：

1. `package.json` 的 `name`；
2. `client.js` 顶部的模块注册 id —— 必须与包名一致：
   ```js
   window.__ModuleLoader__.load({ id: '@you/dsh-find-bar', factory(require) { ... } });
   ```
3. profile 的 `package.json`（依赖 + bundles）与 `cordis.patch.yml` 里的包名。

行 id `ui-find-bar` 与包名无关，可以保留，也可以改成别的唯一值。

## English quick start

A Cordis bundle that adds a browser-like `Ctrl+F` find bar to the DeepSeek Harness Web UI.

1. Copy this directory to `<profile>/local-bundles/dsh-find-bar` and link it into
   `<profile>/node_modules/@local/dsh-find-bar`.
2. Add `"@local/dsh-find-bar": "file:./local-bundles/dsh-find-bar"` to the profile's
   `dependencies`, append `@local/dsh-find-bar` to `dsh.profile.bundles`, and add a row
   `- id: ui-find-bar` / `name: "@local/dsh-find-bar"` to the profile's `cordis.patch.yml`.
3. Restart Harness (or reload the page) and press `Ctrl+F`.

Shortcut id `find.inPage` can be rebound in Settings → Keyboard shortcuts.
Run `npm run check` and `npm test` for the local checks.

## License

MIT
