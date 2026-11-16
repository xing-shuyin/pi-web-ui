[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# mermaid 插件（renderer 插件）

把消息里的 ` ```mermaid ` 围栏渲染为 SVG 图表——**fenced-code 渲染插件机制**的第一个实现。

## 安装（插件不进 npm 包，随仓库分发）

```bash
# 从 GitHub 装（主仓库 plugins/mermaid 子目录，install 原生支持子路径）
pi-web-ui install xing-shuyin/pi-web-ui/plugins/mermaid

# 或本地已 clone 仓库时，把目录复制进数据目录
cp -r plugins/mermaid "<dataDir>/plugins/mermaid"
```

装完刷新页面即可；顶栏/设置面板的「界面插件」里能看到它。不需要时 `pi-web-ui uninstall mermaid` 或删除目录，` ```mermaid ` 回退普通代码块。

## 引擎（本地 vendor 优先，CDN 回退）

- `client/vendor/mermaid.bundle.mjs` 是打包好的自包含引擎（构建产物，见
  `scripts/build-mermaid-vendor.mjs`）——**随插件目录一起复制/安装后完全离线渲染**，
  不碰网络；（放在 client/ 子树是因为插件的静态服务只暴露 `/plugins/:id/client/*`）
- 如果目录里没有 vendor（比如只想省体积只拷 manifest + entry.mjs），插件自动
  回退 CDN（esm.sh）懒加载。**CDN 只是降级手段**：地址在 `client/entry.mjs`
  里钉死与 vendor 一致的精确版本（`mermaid@12.0.0`）——浮动大版本会拉到行为
  不同的新引擎，渲染/主题 API 可能漂移；生产与离线环境应始终带上 vendor；
- 离线环境需要 mermaid 时，把 `client/vendor/` 放进插件目录即可，无需改任何配置。

## 它是怎么工作的

- `manifest.json` 声明 `renderers: ["mermaid"]` + `view: false`（没有独立视图 tab）。
- `client/entry.mjs` 导出 `renderers.mermaid(code, ctx) → HTMLElement | null`。
- 主应用（`web/src/plugin-fence.ts`）维护「语言 → 插件」注册表；`Markdown.tsx` 遇到
  ` ```mermaid ` 围栏时**按需懒加载**本插件 bundle 并渲染——平常聊天从不下载任何东西。

## 关闭渲染

不想要图表渲染时 `pi-web-ui uninstall mermaid` 或删除插件目录即可：没有插件认领
` `` ```mermaid `` ` 围栏时，主应用总是按普通代码块显示，无需任何配置开关。

## 如何写自己的 renderer 插件

参照本目录结构：`manifest.json` 声明 `renderers:[...]`，`client/entry.mjs` 导出
`{ renderers: { "<lang>": (code, ctx) => HTMLElement|null } }`。详见
`docs/architecture-plugins.md` 的「fenced-code 渲染插件（renderer plugins）」一节。
