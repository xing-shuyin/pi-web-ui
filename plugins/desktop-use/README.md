[English](./README.en.md) · **简体中文** · [繁體中文](./README.zh-TW.md)

# 桌面控制（desktop-use）🖱️

让 AI 操作 **Windows / macOS 桌面**：通过系统原生无障碍接口定位控件，自绘界面通过窗口截图与离线 OCR 定位。Windows 输入走 nut-js（自动安装），PowerShell 兜底；macOS 使用本插件内置的 Swift 原生后端，不依赖外部插件或第三方输入库。

## macOS 准备与边界

- 需要 macOS 12+ 与 Apple Command Line Tools（`xcode-select --install`）。首次调用通过系统 `xcrun swiftc` 编译随插件提供的源码，缓存到当前用户临时目录；不下载可执行程序。
- 在「系统设置 → 隐私与安全性 → 辅助功能」允许启动服务的宿主（如 Terminal 或 Electron 桌面应用）；截图和 OCR 另需「屏幕录制」权限。授权后可能需要重启宿主。插件只检查权限，不主动弹出系统授权。
- 控件查询使用 Accessibility，截图使用 CoreGraphics，离线 OCR 使用 Vision；窗口截图按实际像素缩放后换算屏幕逻辑坐标，支持 Retina。
- `desktop_key` 支持 `cmd+c` / `command+c` / `meta+c`（映射 Command），`option` 映射 Alt；`ctrl` 保留 Control 语义。
- 中文和 emoji 通过原生 Unicode 键盘事件输入，不改剪贴板。点击、输入、快捷键、滚动和拖拽会影响当前鼠标/键盘与焦点，**不是隔离后台桌面**；不承诺操作非当前 Space 或最小化应用。
- 当前 Windows 开发环境只能验证 JS 路由和协议，Swift 编译、系统授权、多屏与目标应用交互需在 Mac 上验收。

## 装与卸

- **安装**：`pi-web-ui install <仓库>/plugins/desktop-use`（或把本目录拷到 `<dataDir>/plugins/desktop-use/`）。装完服务端热重扫自动激活。
- **Windows 依赖自动装**：输入库 `@nut-tree-fork/nut-js` 不在安装包里，激活后插件**后台自动 `npm install`**（目录锁防并发 + 10 分钟看门狗 + 顶栏通知进度，db-client 同款）。装好前点/输类工具报“安装中稍后”，**查元素不受影响**（纯 PowerShell，零依赖）。
- **卸载**：`pi-web-ui uninstall desktop-use` 即删整目录，`node_modules` 在里面，**依赖一起消失**，不留东西。手动装失败时按通知里的命令在插件目录手装一次即可。

## AI 工具（8 个，设置 → 插件工具里可逐个关）

| 工具                 | 干什么                                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `desktop_elements`   | 无截图查控件：`scope=foreground/desktop/window` + `query`过滤，返回 `dump` 快照 key + `id` 列表（90 秒有效）                               |
| `desktop_click`      | 点元素：① 按 `dump+id` 点 UIA 元素中心；② 截图流：传 `shot+x+y`（像素坐标）或 `shot+text`（直接按 OCR 识别文字点击）；左/右/中键、双击可选 |
| `desktop_type`       | 打字；中文/emoji 自动走剪贴板粘贴；支持 `shot+click_text`（按 OCR 文字先点聚焦）或 `shot+x+y` 或 `id` 先点再输                             |
| `desktop_key`        | 按键，如 `enter` / `ctrl+c` / `alt+F4` / `win+r`                                                                                           |
| `desktop_window`     | `list` 列顶层窗口 / `focus` 按标题子串顶到前台                                                                                             |
| `desktop_screenshot` | 按窗口截图：返回图 + 窗口左上角屏幕坐标与缩放比 + **图内文字 OCR 识别与确切坐标**（自绘界面交互入口）                                      |

| `desktop_scroll` | 在 `shot+x+y/text` 或 `dump+id` 位置滚动，支持四方向，`amount=1–100`（默认 3 格） |
| `desktop_drag` | 同一张新截图中从 `x+y` 拖到 `to_x+to_y`，`duration_ms=100–2000`（默认 500ms）；完成后重查 |

约定：**先查后点**，id 不猜、不复用过期快照；关闭/删除/提交/付款先向用户确认。

## 自绘界面交互（截图流 + OCR 文字识别，微信已验证）

`desktop_elements` 看不到的界面（微信/QQ/游戏）走这条：

1. `desktop_screenshot`（`process=Weixin` 或 `dump+id`）→ 拿到图 + `shot` key + 窗口左上角 + **图内文字 OCR 识别清单（含精确矩形与中心坐标）** + **当前鼠标指针位置**（图里画出真实指针并附带坐标，可确认上次落点）
2. **定位方式（双通道）**：
   - **方式 A（文字直接点，最推荐）**：`desktop_click` 直接传 `shot="s1"` + `text="发送"`，插件自动在 OCR 结果中匹配文字中心并换算点击，无需手算坐标。同名匹配会报出候选坐标，需传 `occurrence=1/2/…`（按 OCR 清单顺序）明确选择；`desktop_type` 的 `click_text` 也支持此参数。OCR 可能误识别，点击前应核对截图。
   - **方式 B（像素坐标点）**：看 OCR 返回的文字列表中的 `中心 (cx, cy)`，或看图自选像素 `{x, y}`，传 `desktop_click(shot="s1", x=cx, y=cy)`。
3. **输入文字**：直接调 `desktop_type` 传 `shot="s1"` + `click_text="搜索"`（或 `x+y`）+ `text="张三"` → 插件自动**一步完成**：先点击目标文字中心聚焦，等待 250ms 后立即输入（中文走剪贴板粘贴、英文走键盘），**避免分两步调用因跨回合切回浏览器导致窗口失焦、文字漏输**。

截图 90 秒内有效（窗口挪走就重截）。实现细节：

- 系统原生支持 Windows 10/11 内置的 `Windows.Media.Ocr`（WinRT API），完全离线、零外部依赖、耗时仅 ~150ms。
- PrintWindow `flags=2` 才能截出 Qt 内容（`flags=0` 是黑图）；空白检测只看中央 80%（边框会抬高整图方差）；被遮挡也能截，截出空白才需要先 `focus` 到前台。

## 找窗口：认进程，不认标题

很多应用的窗口标题是会变的（微信主窗口标题就是你的昵称），`desktop_window list` 和
`desktop_elements scope=window` 因此都支持按**进程名**找：

- 微信：`process=Weixin`（老版 `WeChat`），窗口类 `Qt51514QWindowIcon`
- 浏览器：`process=msedge` / `chrome` / `firefox`

## 局限

- 仅 Windows（`process.platform !== win32` 时工具直接报错）。
- 微信这类 Qt/自绘应用：窗口可定位，内部元素可能在 UIA 树里不可见。内置 WinRT OCR 可辅助定位可见文字，识别质量受字体、缩放和对比度影响；无文字按钮仍需看图定位。
- 纯图标按钮（没有文字且 UIA 为空的极少数情况）：走截图流图内像素 `{x, y}` 点击，并可参考图内画出的鼠标指针位置进行校准。
- 自绘界面（游戏、Canvas、部分 Electron 自绘区）在 UIA 树里是空的——这类目标现在也可以直接通过 OCR 文字定位交互。
- 中文输入依赖剪贴板：输入期间不要切走焦点；传定位参数时会先点目标，未传则输入当前焦点。粘贴后等待目标读取再恢复原文本剪贴板；图片等非文本内容暂不能恢复。
- 截图坐标必须位于图内；窗口移动、遮挡或内容变化后应重新定位，90 秒有效期不代表界面期间保持不变。
- 拖拽一旦按下鼠标，会在最多约 2.2 秒内完成并释放，再响应取消，避免强杀辅助进程留下按住状态。

## 实现参考

0.4.0 参考 [Windows-MCP](https://github.com/cursortouch/windows-mcp) 的输入工具设计，独立实现四方向滚动和有时长边界的拖拽；未引入 Python/MCP 依赖，也未复制上游源码。修复快捷键未释放、OCR 重名默认点击第一处与截图越界坐标问题。
