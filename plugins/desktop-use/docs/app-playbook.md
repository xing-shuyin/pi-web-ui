# 常见桌面软件操作手册与最佳实践（Desktop App Playbook）

> 本文档记录 `desktop-use` 插件在操作 Windows 常见软件（尤其是微信、QQ 等自绘界面与复杂多窗口应用）时的操作范式、避坑指南与跨回合稳定性规范。

---

## 1. 核心稳定性铁律（必读）

### 铁律 1：跨回合/用户确认后「必先重新 Focus」
- **现象**：当 AI 调用 `ask_user_question` 弹出问卷弹窗让用户确认，或者用户在浏览器聊天界面进行了点击后，**系统的当前前台窗口（Foreground Window）必然变成了浏览器**。
- **后果**：如果此时直接调用 `desktop_key(keys="enter")`，按键事件会被派发到浏览器（或被当前焦点的网页元素吃掉），目标软件根本收不到！
- **正确做法**：**在任何需要向目标软件发送按键、输入或点击的操作之前，无条件先调用一次 `desktop_window(action="focus", title="...")`**。

### 铁律 2：自绘界面「能用粘贴就别盲点坐标」
- **现象**：微信、QQ 等采用 Qt / 自绘引擎的应用，输入框在窗口获得焦点时通常**默认处于激活状态（光标闪烁）**。
- **风险**：如果盲目传入猜想或缩放有偏差的坐标（`shot+x+y`）去「先点再输」，一旦坐标偏移点在输入框外，反而会把原本已经聚焦的输入框打成失焦！
- **正确做法**：
  1. 先 `desktop_window(action="focus", title="...")` 激活窗口；
  2. 直接调用 `desktop_type(text="...")`（不传 x/y，内部自动通过剪贴板粘贴 + Ctrl+V）；
  3. 截图复查，如果发现确实未聚焦，再通过 `desktop_screenshot` 观察实际光标或输入框位置后精确点击。

### 铁律 3：多显示器与 DPI 缩放防护
- 多显示器环境下可能存在负坐标（如副屏在主屏左侧时 X < 0）。
- 插件的 `input.ps1` 与 `screenshot.ps1` 均已开启 `SetProcessDpiAwareness(2)` 并采用 `MOUSEEVENTF_VIRTUALDESK` 虚拟屏幕坐标归一化，严禁在外部自行做错误的整数取整或忽略 DPI 缩放。

---

## 2. 软件专章：微信 (WeChat / Weixin)

### 软件特征
| 属性 | 说明 |
| :--- | :--- |
| **进程名** | `Weixin.exe` |
| **窗口类名** | `Qt51514QWindowIcon` |
| **窗口标题** | 动态变化，通常是**当前登录用户的微信昵称**（如「邢书印」） |
| **UI 架构** | Qt 自绘界面；`desktop_elements` (UI Automation) 只能枚举到外层容器，**内部控件无 UIA 节点** |
| **交互通道** | 截图流（`desktop_screenshot`）+ 剪贴板粘贴（`desktop_type`）+ 顶层按键（`desktop_key`） |

### 标准操作流程（发消息范式）

```
[1. 激活微信窗口]
  desktop_window(action="focus", title="<用户昵称或Weixin>")

[2. 截图确认当前会话]
  desktop_screenshot(process="Weixin")
  - 查看左侧聊天列表或上方会话标题是否为目标对象（如「文件传输助手」）
  - 若不是：在搜索框或聊天列表对应位置点击切换

[3. 输入消息内容]
  desktop_type(text="要发送的内容")
  - 注意：微信输入框默认是激活的，直接 type 会通过剪贴板粘贴，无需传 x/y

[4. 截图复查输入框]
  desktop_screenshot(process="Weixin")
  - 确认文字已在输入框内，右下角「发送」按钮变为绿色

[5. 涉及不可逆操作：向用户确认]
  ask_user_question(...) 提示用户即将发送的内容与目标对象

[6. 用户确认后的发送步骤（核心！）]
  a. desktop_window(action="focus", title="<用户昵称>")  <-- ★ 必须重新聚焦！
  b. desktop_key(keys="enter")                           <-- 发送消息
  c. desktop_screenshot(process="Weixin")                <-- 截图验证气泡上屏
```

### 常见问题与排查
1. **Q: 为什么按了 Enter 没有发送？**
   - **A**: 检查前一步是否有弹窗或浏览器交互。若有，必须在 `enter` 前执行 `desktop_window(action="focus")`。另外检查微信设置中「发送快捷键」是否为 Enter（默认 Enter 发送，Ctrl+Enter 换行）。
2. **Q: 为什么输入的文字漏掉了或乱码？**
   - **A**: `desktop_type` 会自动识别中文并使用系统剪贴板粘贴；确保执行时微信处于前台且输入光标处于闪烁态。

---

## 3. 软件专章：QQ / 钉钉 / 飞书

- **QQ (QQ.exe)**：NT 架构（Electron 自绘）。输入框同样在窗口聚焦时保持激活，操作逻辑与微信基本一致。
- **钉钉 (DingTalk.exe)** / **飞书 (Feishu.exe)**：Electron 架构。若 UIA 能枚举到部分输入框可优先用 `dump+id`，若枚举为空壳则完全遵循微信的截图+粘贴流程。

---

## 4. 软件专章：浏览器 (Chrome / Edge)

- **UI 架构**：支持 UI Automation（需开启无障碍/具有辅助功能支持）。
- **地址栏/标签页**：
  - 切换标签页：`desktop_key(keys="ctrl+tab")` 或 `ctrl+1`..`ctrl+9`。
  - 打开新标签：`desktop_key(keys="ctrl+t")`。
  - 聚焦地址栏：`desktop_key(keys="ctrl+l")` 或 `desktop_key(keys="alt+d")`。
  - 网页内查找：`desktop_key(keys="ctrl+f")`。

---

## 5. 软件专章：Windows 终端 / 命令提示符

- **Windows Terminal (wt.exe)** / **cmd.exe** / **powershell.exe**：
  - 聚焦后可直接通过键盘发送按键，但需注意如果处于选择模式（光标变为白块/暂停输出），需按 `esc` 或 `enter` 解除。
  - 粘贴到终端建议使用 `desktop_key(keys="ctrl+shift+v")` 或 `desktop_type`。
