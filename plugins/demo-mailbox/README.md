[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# 📬 demo-mailbox —— 插件开发示例

pi-web-ui 可选界面组件的**最小可运行示例**：演示「服务端入口 index.mjs +
客户端视图 client/entry.mjs + 双向消息」的完整链路。兼作
`tests/plugin-test.mjs` 的协议测试夹具。

## 它做什么

- 内存里预置两封示例邮件 + 一个回声表单
- 客户端视图渲染邮件列表和发送表单；发送的消息经 WebSocket 到服务端，
  服务端广播回所有打开的页面（多标签页实时同见）
- 演示 `host.onMessage` / `host.broadcast` / `host.notify` 三个宿主 API 的用法

## 目录结构

```
demo-mailbox/
├── manifest.json      # 插件清单（id/icon/name/version/description）
├── index.mjs          # 服务端入口：export default { activate(host) → deactivate? }
└── client/entry.mjs   # 视图入口：export default { mount(el, ctx) → cleanup? }
```

## 本地试用

```bash
# ── 安装 ──
pi-web-ui install https://github.com/xing-shuyin/pi-web-ui/tree/main/plugins/demo-mailbox
pi-web-ui install plugins/demo-mailbox   # 或本地目录

# ── 查看 / 卸载 ──
pi-web-ui plugins                            # 列出已装插件与 id
pi-web-ui uninstall demo-mailbox             # 或 rm -rf ~/.pi-web/plugins/demo-mailbox

# ── 更新 ──
pi-web-ui install ...同上... --force          # 覆盖重装
cp -r plugins/demo-mailbox ~/.pi-web/plugins/
```

刷新页面，顶栏出现 📬 标签即成功。删掉该目录再刷新即卸载——插件
「不装即不存在」，无需任何注册步骤。

## 给插件开发者的提示

- 服务端可以访问 Node 全部能力（真实插件如 webmail 在这里接 IMAP/SMTP）；
  凭据只存 `<pluginDir>/`，不要写进代码库
- 客户端与主应用只有两条窄通道：`ctx.send()` 上行、`ctx.onData()` 下行，
  不共享 React 实例
- 带请求语义的上行必须自带 `reqId`，响应靠它匹配并发；无 reqId 的响应会被
  客户端静默丢弃
- 协议约定详见 pi-web-ui 主 README「插件」章节与 AGENTS.md
