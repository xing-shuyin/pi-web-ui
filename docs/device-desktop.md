# 已授权设备的原生远程桌面

设备中心参考 [krd](https://github.com/zzjcool/krd) 的原生捕获与输入方式，复用设备访问票据和连接器，在浏览器 canvas 显示 JPEG。从本机设备中心打开时，与「打开设备」的完整对话界面共用[局域网优先访问](device-center.md#局域网优先访问)：优先使用经过 TLS PSK 验证的私网通道，不可达时尝试设备间 P2P，失败使用原 Hub WebSocket 中继。无需 VNC 服务、noVNC 或固定桌面端口。画面不进入聊天快照或模型上下文。

## 聊天页预览与放大操作

从设备通道进入远程聊天页后，右栏自动显示该页所属设备的桌面。当前设备身份取自已授权的 portal capability 路径，预览、实时画面与输入均复用该路径，不再由被控机向自己申请 LAN/P2P/Hub 票据。关闭预览后可点「显示此设备的桌面」恢复；选择设备列表中的当前设备也走同一入口。连接标记显示「复用当前连接」，不猜测底层是 LAN 还是 P2P。沙箱页面不提供无法打开的独立标签页按钮。

桌面工具栏按连接、查看选项和辅助面板分组，跟随聊天页的主题颜色。`desktop-theme.ts` 定义允许同步的颜色令牌，父页通过受来源窗口约束的消息转发到桌面沙箱，桌面仅接受颜色值，不加载任意样式或 URL；主题切换不会重建 iframe 或 WebSocket。独立页面默认跟随系统明暗，窄屏保留横向工具条与单独状态行，设置、文字输入、连接信息互斥展开，支持 Escape 和外部点击收起。Hub 中继的主题转发需要 Hub 更新到同一版本。

从本机设备中心或群成员打开远程桌面时，聊天页右栏上方显示一台选中设备的预览，文件与插件区域保留在下方。预览可收起、调整高度、切换设备或关闭。“选择设备”在按钮旁直接打开设备列表，显示当前设备和在线状态，点击在线设备即切换预览，不跳转设备中心；关闭列表会取消未完成的读取。点击“放大并操作”创建实时桌面窗口，窗口与全屏之间只改变布局，不重新创建 iframe 或申请票据。放大窗口的 × 和“返回预览”均保留选中设备、恢复右栏预览；右栏预览自身的 × 才关闭整个桌面。返回预览释放实时连接和按住的键鼠，再申请新的预览票据。切换聊天会话保留选中设备；切换设备、关闭桌面时清理旧页面。手机浏览器放大后默认全屏；原生手机 App 仍使用自身设备适配器。

`web/src/device-access.ts` 管理设备选择和 preview/live 状态，`use-desktop-target.ts` 在页面挂载时申请一次性票据；异步响应受 AbortSignal 和设备选择代次约束。`desktop-preview.tsx` 只在预览可见时通知沙箱页面启动请求。折叠、隐藏右栏或浏览器进入后台会取消请求和轮询。窗口沿用 `RemoteDesktopWindow.tsx`，使用统一浮层层号。两种模式均显示实际 LAN/P2P/Hub 路径，LAN 回退后更新标记。

`/desktop-preview` 提供独立只读页面，通过现有授权通道请求 `/api/device-desktop/preview`，收到画面后间隔 3 秒再请求，最多一个请求在途；图片长边目标 640 像素。采集端使用 preview 模式，Windows/macOS 每轮等待 3 秒，Linux X11 使用 1/3 FPS。仅降低浏览器显示频率不算轻量采集。

`desktop-preview.ts` 合并同设备并发请求，复用最近 2.5 秒内的帧，最多等待 8 个请求；没有请求后 6.5 秒关闭预览助手。实时桌面启动时停止专用预览助手，预览请求复用实时采集的最新帧（此时尺寸沿用实时画面）；实时桌面退出且仍有预览请求时恢复低频助手。预览始终只读，不请求 macOS 控制授权。停用桌面、退出服务、请求取消和迟到的采集回调均有独立清理。

设备端、本机服务和 Hub 都需要支持新的预览入口。旧设备不支持时显示预览不可用，可继续打开原有实时桌面；不自动用全速桌面流伪装轻量预览。直接访问云端 Hub 的浏览器不具备本机 pi 服务的 LAN 探测能力，这次改动不增加浏览器 P2P。

### 预览验证

`tests/device-current-desktop-test.mjs` 在 8996 端口用真实 Chromium 验证 Hub/LAN 路径下的嵌套沙箱、持续预览、直接控制、中文输入、返回与重新打开，确认没有「再次打开自己」的请求；检查 one-dark、white、nord 主题即时同步且不重连，以及手机宽度。使用模拟采集帧，不代表跨机器帧率。

`tests/unit/device-desktop-preview.test.ts` 验证缓存、并发复用、取消和实时采集切换；原生/Linux 用例检查低频参数和只读约束。`node --import tsx tests/device-desktop-window-test.mjs` 使用 8997 端口和真实 Chrome，验证嵌套沙箱中的连续预览、折叠暂停、右栏隐藏暂停、放大操作、全屏不重载、返回预览、手机宽度及关闭清理，截图位于 `artifacts/device-center/`。该界面测试使用模拟桌面，不代表跨机器性能实测。

### P2P 候选版

`0.120.1-p2p-preview.1` 延续预览布局，新增设备间 WebRTC 通道。安装、Hub 升级与跨网验证见[设备中心 P2P 访问](device-center.md#p2p-设备访问)。前一个 `desktop-preview.1` 包仍只有 LAN/Hub，不能通过刷新页面获得 P2P。三端都需升级新候选包并重启实际运行服务；旧版本可兼容回退中继。

### npm 跨机器测试包

`0.120.1-desktop-preview.1` 基于正式版 `0.120.0`，通过 [fork 的测试发布](https://github.com/xinzhihong-ship-it/pi-web-ui/releases/tag/desktop-preview-0.120.1-1) 分发；下载页提供已构建的 `.tgz` 和 SHA-256。这是供跨机器验收的候选包，不是官方 npm `latest`。无需在其它机器编译前端；需要 Node.js ≥22.19.0。

控制端、被控端及独立 Hub 都安装同一包：

```sh
npm install -g "https://github.com/xinzhihong-ship-it/pi-web-ui/releases/download/desktop-preview-0.120.1-1/pi-web-ui-0.120.1-desktop-preview.1.tgz"
npm list -g pi-web-ui --depth=0
```

原来用全局 npm 包安装的 Web 服务，安装完成后执行 `pi-web-ui server restart`；有自定义服务名时补 `--name <原服务名>`。前台运行的服务应结束原进程，再用原来的工作目录、端口和数据目录参数运行 `pi-web-ui`。刷新浏览器，检查运行中的版本是否为 `0.120.1-desktop-preview.1`；只检查 npm 安装版本不足以确认服务已更新。

通过全局包直接运行的 Hub 重启原进程；由 `hub install` 安装且仍指向全局包的服务执行 `pi-web-ui hub restart`。曾用 Hub 在线升级、旧 npx 缓存或源码路径启动的服务，入口可能仍指向旧包，必须核对并更新启动入口。Hub 的受管升级可通过 `PI_DEVICE_HUB_UPDATE_SOURCE` 指定上述下载 URL 后运行 `pi-web-ui hub update`，再用 `pi-web-ui hub status --json` 检查 `health.version`；如果服务配置已经固定了更新源，应先按原部署方式更新该配置，因为保存的源优先于临时环境变量。保留原数据目录、鉴权和设备绑定。

先用两台电脑检查右栏预览持续更新、点击放大、控制输入、返回预览和隐藏暂停，再分别验证同局域网 LAN 标记及跨网 Hub 标记。Windows 被控电脑需要活动图形会话，macOS 需屏幕录制权限；只安装 Web 包不会绕过系统桌面权限。发布说明列出实际通过的检查与尚待验证的平台。

## 平台与启用

Windows 采集依赖 pi-web-ui 所在的交互用户会话。关闭 Windows 自带远程桌面（RDP）可能使这个会话变为 Disconnected；此时 GDI 无法捕获画面，LAN/P2P/Hub 通道正常也不能解决。助手通过 WTS 会话状态和输入桌面检查区分 RDP 断开、服务会话、锁屏或安全桌面，避免只返回 “The handle is invalid”。已断开或暂不可访问时，页面显示原因，前台每 10 秒重试，恢复登录桌面后继续出图；手动断开、关闭窗口和后台页面停止重试。预览采集错误不会再误触发 LAN/P2P 回退。程序不会自动解锁、转移 Windows 会话或绕过 UAC；无活动会话的无人值守桌面仍需单独的系统级方案。

远程设备标签页显示「备注 · 计算机名 · pi-web-ui」，无备注时只显示计算机名，只有旧 Hub 未提供名称时才回退设备 ID。Hub 和本机 LAN/P2P 入口共用名称规则，图标从当前授权通道加载应用原有 favicon，不额外开放设备资源。更新后重新打开远程标签页生效。

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
| GET /desktop-preview                       | 只读低频预览页面                   |
| GET /api/device-desktop/preview            | 授权后的预览 JPEG，禁止缓存        |
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

输出为最大 4 MiB 的二进制 JPEG，文本帧报告 ready/error/stats。浏览器完成绘制后回复 `{type:"ack"}`，每连接仅有一帧等待确认；等待期间只保留最新一张候选帧，ACK 到达且上次发送完成后立即发出，避免旧帧排队。15 秒未确认会报告错误并关闭采集，用户可重新连接。传输队列上限 4 MiB，另有最多 4 MiB 的最新候选帧。输入为最大 16 KiB 的 JSON，校验 normalized pointer、wheel、物理 key code、text 和 release。

实时页的“连接信息”展示累计采集/发送/替换帧数、确认等待、发送队列，以及浏览器测得的显示 FPS 和解码绘制时间。确认等待包含网络、解码与浏览器调度，不等同于纯网络 RTT；此轮保留原实时采集频率，并未升级为 30 FPS 视频编码。

每设备最多四个桌面连接；启动超时 60 秒，30 秒 ping/pong，30 分钟无用户输入释放。断开、关闭、禁用或错误清理捕获并释放按住的键鼠。原生进程输入队列、帧大小和错误日志均有界，取消先请求退出再终止特定子进程。捕获器本身不监听额外 TCP 端口；设备连接器按需提供共享的加密局域网端口，桌面与完整设备网页共用该通道。浏览器仍只连接本机能力入口，不直接处理私网地址或共享密钥。不保存录像或剪贴板历史。

## 验证

相关测试在 `tests/unit/device-center-desktop*.test.ts`、`device-desktop-native.test.ts`、`device-desktop-linux.test.ts`、`device-desktop-relay.test.ts` 和 `device-lan*.test.ts`。LAN 测试使用真实 TLS PSK、HTTP/WS 和 Chrome 嵌套沙箱，验证聊天与画面直连、授权隔离、路径前缀及断线回退。覆盖权限、启用持久化、原生进程清理、输入边界、只读、帧确认以及真实 Hub/connector 中继。可用 Chrome 时验证代理前缀下的画布解码、控制模式鼠标移动与输入长度；浏览器模拟画面测试不等于各平台实机验证。
