# 已授权设备的原生远程桌面

设备中心参考 [krd](https://github.com/zzjcool/krd) 的原生捕获与输入方式，复用设备访问票据和连接器，在浏览器 canvas 显示 JPEG。从本机设备中心打开时，与「打开设备」的完整对话界面共用[局域网优先访问](device-center.md#局域网优先访问)：优先使用经过 TLS PSK 验证的私网通道，不可达时使用原 Hub WebSocket 中继。无需 VNC 服务、noVNC 或固定桌面端口。画面不进入聊天快照或模型上下文。

## 平台与启用

默认关闭，在桌面页面点击启用；偏好原子保存至 `<dataDir>/desktop-settings.json`。`PI_DEVICE_DESKTOP=1` 强制启用，页面不能覆盖环境变量。运行时支持不代表已经获得系统授权，捕获启动失败会在页面显示原因。

| 平台          | 实现                                                                      | 条件                                                                       |
| ------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Windows       | 持久 PowerShell/C# 助手，GDI 捕获与 SendInput                             | 活动图形会话；UAC 安全桌面和高权限应用受系统限制                           |
| macOS 14+     | Swift 助手，ScreenCaptureKit SCScreenshotManager 捕获与 CoreGraphics 输入 | Xcode 或 Command Line Tools 提供 Swift；屏幕录制权限；控制还需辅助功能权限 |
| Linux X11     | ffmpeg x11grab 采集，xdotool 输入                                         | DISPLAY/XAUTHORITY，ffmpeg，xdpyinfo 或 xrandr；仅查看可不安装 xdotool     |
| Linux Wayland | 暂不支持                                                                  | 后续需接入 Portal/PipeWire，不能把 XWayland 当完整桌面                     |

旧 `PI_DEVICE_VNC_*` 配置不再读取。macOS 权限申请由被控 Mac 本机的「设备中心 → 本机远程桌面」发起：点击“授予屏幕录制权限”或“授予远程控制权限”，再在 macOS 弹窗或设置中确认。仅查看需要屏幕录制，控制还需辅助功能。远端连接仅检查权限，不请求授权或打开系统设置。本机申请会尝试打开未获授权的对应设置页；系统可能不重复弹窗，授权对象以 macOS 识别的实际宿主为准。请勿在“＋”文件选择器中猜选程序。系统要求重启时，重启实际服务再连接。当前 Windows 已实机验证，macOS/Linux 尚需目标机器实机验证。

## 宿主接入和权限

`server/device-center/desktop.ts` 导出 `createDeviceDesktop({app,dataDir,authorize})`。在 SPA fallback 前注册路由，在已有 HTTP upgrade 分发中先调用 `desktop.handleUpgrade(req,socket,head)`；未知路径返回 false。服务关闭时调用 `desktop.close()`。

HTTP/WS 独立检查物理回环来源、回环 Host、本机鉴权与存在时的精确 Origin。设置写入另要求 Origin；连接器重写固定的本机 Host/Origin 并注入本机凭据，Hub 校验账号和设备归属。公网建议使用 HTTPS/WSS。

| 路径                                       | 用途                               |
| ------------------------------------------ | ---------------------------------- |
| GET /desktop                               | 自包含浏览器页面                   |
| GET /api/device-desktop/status             | 平台支持、启用状态和诊断原因       |
| GET /api/device-desktop/setup/status       | 兼容状态入口                       |
| GET /api/device-desktop/local/status       | 仅设备本机设置页的状态             |
| POST /api/device-desktop/local/permissions | 仅本机请求 screen/control 系统权限 |
| POST /api/device-desktop/local/enable      | 仅本机启用或关闭远程桌面           |
| POST /api/device-desktop/setup/enable      | 持久设置 `{enabled:boolean}`       |
| POST /api/device-desktop/setup/install     | 兼容入口，报告无需安装组件         |
| WS /desktop-ws?viewOnly=1                  | 默认只读；显式 viewOnly=0 开启控制 |

只读由服务端和原生助手按连接强制；有设备访问权限的用户可显式创建控制连接，因此它不是账号级只读授权。切换只读会重新连接。状态 `available` 只表示已启用且运行时可用；系统权限和图形会话仍需捕获启动验证。

页面 URL 全部相对 document.baseURI 构造，支持 `/device/<id>/` 和其他反代前缀。页面错误使用 textContent。旧 noVNC 资源路由不再提供。

## 传输与清理

输出为最大 4 MiB 的二进制 JPEG，文本帧报告 ready/error。浏览器完成绘制后回复 `{type:"ack"}`，每连接仅有一帧等待确认，期间丢弃新帧，防止跨设备慢连接积压。输入为最大 16 KiB 的 JSON，校验 normalized pointer、wheel、物理 key code、text 和 release。

每设备最多四个桌面连接；启动超时 60 秒，30 秒 ping/pong，30 分钟无用户输入释放。断开、关闭、禁用或错误清理捕获并释放按住的键鼠。原生进程输入队列、帧大小和错误日志均有界，取消先请求退出再终止特定子进程。捕获器本身不监听额外 TCP 端口；设备连接器按需提供共享的加密局域网端口，桌面与完整设备网页共用该通道。浏览器仍只连接本机能力入口，不直接处理私网地址或共享密钥。不保存录像或剪贴板历史。

## 验证

相关测试在 `tests/unit/device-center-desktop*.test.ts`、`device-desktop-native.test.ts`、`device-desktop-linux.test.ts`、`device-desktop-relay.test.ts` 和 `device-lan*.test.ts`。LAN 测试使用真实 TLS PSK、HTTP/WS 和 Chrome 嵌套沙箱，验证聊天与画面直连、授权隔离、路径前缀及断线回退。覆盖权限、启用持久化、原生进程清理、输入边界、只读、帧确认以及真实 Hub/connector 中继。可用 Chrome 时验证代理前缀下的画布解码、控制模式鼠标移动与输入长度；浏览器模拟画面测试不等于各平台实机验证。
