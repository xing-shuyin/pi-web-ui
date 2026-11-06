# hongguo 插件

`plugins/hongguo/` 是 [frostming/dsh-hongguo](https://github.com/frostming/dsh-hongguo) 的 pi-web-ui 移植，使用 [openhongguo](https://github.com/beilunyang/openhongguo) `0.1.0` 访问匿名短剧接口。通过顶栏「hongguo」打开，支持剧名搜索、演员搜索与参演作品、选集、续播、观看记录、播放速度、自动下一集、下一集预加载和浏览器画中画。

## 安装与使用

开发环境从仓库根目录执行：

```bash
node scripts/link-plugins.mjs hongguo
```

在设置中重新加载插件，然后点击顶栏「hongguo」。发布到远端目录后，也可从插件市场安装。运行时首次访问会通过宿主 `ensureDeps` 安装插件独立的 `openhongguo@0.1.0`，根项目依赖不变。

播放器提供两种模式，点击顶部按钮即时切换：

- **悬浮**：拖动标题栏移动窗口；拖动四边或四角调整大小；播放中可切换精简视图，精简窗口的宽高独立记忆并且同样支持缩放。
- **分屏**：宽度至少 800px 时位于右侧，拖动左边缘调整宽度；窄屏自动改为上下分屏，拖动上边缘调整高度。

搜索框左侧可选择「剧名」或「演员」。演员搜索使用平台的用户搜索页，点击姓名后加载参演作品，再选择短剧和剧集；搜索结果可能含普通账号，没有公开剧作时显示空列表。演员作品和搜索结果均支持「加载更多」。

「预载下一集」默认开启，与「自动连播」独立。当前集开始播放后，只提前下载并转码紧接的一集，成功时显示「下一集已就绪」。切集复用已经完成的 H.264/AAC 缓存；若任务仍在进行，播放请求等待同一个任务，不重复解析、下载或转码。关闭、换集或取消预载会中止浏览器等待；服务端已经开始的处理可以完成并进入有限缓存，卸载插件会中止任务。

分屏通过稳定的 `dom.anchors().app` 挂载点和可恢复的内边距预留空间。窗口只使用插件自己的样式，不查询宿主内部类名。布局切换不移动或重新创建 `<video>`，切换对话也会继续播放。关闭窗口暂停视频、退出画中画并释放分屏空间；再次打开后点击原生播放按钮即可继续。

## FFmpeg 与播放限制

MP4 统一由服务端调用 FFmpeg 输出为 **H.264 Main / yuv420p + AAC-LC**，避免 HEVC / H.265 在部分浏览器或桌面内核中只有声音、进度正常却没有画面。CENC 加密剧集使用 openhongguo 返回的内容密钥，在同一次处理里解密并转码。视频保持纵横比，最长边最多 1280 像素；音频统一为 AAC-LC。CDN 的 HEIC 封面也通过 FFmpeg 转换成 JPEG。安装 FFmpeg 后保持其位于 PATH，或在设置 → 插件 → hongguo 中填写 **FFmpeg 路径**。路径作为独立可执行文件参数传给 `execFile`，不经过 shell。Windows 的 WinGet 链接目录以及常用 macOS / Linux 安装路径也会自动探测。

播放器打开时检测 FFmpeg，有缺失时显示提示。处理任务延迟到实际视频请求发生，首次播放需要等待下载和转码，完成后复用缓存。MP4 播放不再依赖客户端的 HEVC 解码能力。匿名服务的限流、地区可用性、内容下架和网络问题由上游决定。

原生 MP4 由浏览器播放，HLS 使用浏览器原生支持或随附 mpegts.js，DASH 使用随附 dash.js。DASH 的 BaseURL / SegmentBase 格式走同源代理；SegmentTemplate 格式会明确返回不支持，避免生成无效的地址。

## 数据与生命周期

- 浏览器 `pi-web-ui:hongguo:prefs:v1` 保存布局、位置、窗口尺寸、音量、倍速、自动连播和下一集预载偏好；`pi-web-ui:hongguo:history:v1` 保存最近 30 部剧的集数、时间点和标题。进度每约 4 秒及暂停 / 关闭时保存。已播完的集数再次打开从头播放。
- 服务端 `<dataDir>/hongguo/anonymous.json` 保存匿名设备档案，按用户私有文件权限原子写入。`media/` 最多保留最近 12 集已处理视频，兼容缓存使用 `<episodeId>.h264-aac-v1.mp4`；旧 `<episodeId>.mp4` 缓存自动转码，无需重新下载或获取密钥。播放 URL 带 `?format=h264-aac-v1`，防止浏览器复用旧 HEVC 响应。`covers/` 最多保留 300 张转换后的封面。视频只缓存到宿主数据目录，不写入源码 / 插件目录。
- 内容密钥只保留在服务端。客户端通过同源 `/plugins-api/hongguo/*` 地址播放，未加密流媒体的上游地址作为代理查询参数传递。播放接口和 HLS / DASH 清单中的代理地址使用相对路径，以支持应用子路径反向代理。
- 插件只申请 `ui`、`http`、`dom:anchor`。浏览器只访问同源 HTTP 路由；服务端限定 CDN 域名，每次重定向重新校验，拒绝凭据、非标准端口和可执行的上游内容。
- `client/entry.mjs` 将宿主重载纪元的查询参数传递给 `player.mjs`，后者继续传递给 `styles.mjs` / `state.mjs`，确保重新加载插件时不会复用旧手柄样式或尺寸逻辑。
- `client/entry.mjs` 默认导出 `dispose()`。宿主在禁用、移除、报错、epoch 重载和过期异步加载时清理常驻实例：暂停 / 释放媒体、取消请求、移除事件 / 观察器 / 浮层并恢复宿主样式。服务端卸载会中止媒体请求和 FFmpeg 子进程，路由由宿主自动注销。

## 接口与事实源

| 路由（相对 `/plugins-api/hongguo`） | 返回 / 行为                                              |
| ----------------------------------- | -------------------------------------------------------- |
| `GET /config`                       | `{ ffmpegAvailable }`                                    |
| `GET /list`                         | `{ items }`，推荐内容缓存 15 分钟                        |
| `GET /search?q=&type=actor&cursor=` | `{ items, cursor, hasMore }`                             |
| `GET /actors/works?id=&cursor=`     | `{ person, items, cursor, hasMore }`，演员资料与参演作品 |
| `POST /preload?episode=`            | 下载并转码下一集，返回 `{ episodeId, ready }`            |
| `GET /series?id=`                   | `{ series, episodes }`                                   |
| `GET /play?episode=`                | `{ episodeId, duration, streams }`；不返回内容密钥       |
| `GET /media/<episodeId>`            | 处理并缓存 MP4，支持 Range / 206 / 416 和拖动进度        |
| `GET /stream?u=`                    | 受限 CDN 代理；重写 HLS / DASH 清单                      |
| `GET /cover?u=`                     | 受限封面代理，必要时转换 HEIC                            |

服务端：`plugins/hongguo/index.mjs`、`lib/media.mjs`。客户端：`client/player.mjs`、`client/state.mjs`、`client/styles.mjs`。入口：`manifest.json`、`client/entry.mjs`。宿主常驻生命周期：`web/src/plugin-loader.ts`。

## 来源与验收

移植参考 dsh-hongguo v1.2.1，保留上游归属；原仓库没有提供根许可证，本移植没有为上游源码另行声明许可证。随附播放器库保留原文件及许可证：`client/vendor/LICENSE-mpegts.js.txt`、`LICENSE-dashjs.md`、`LICENSE-dashjs-third-party.txt`。openhongguo 为独立 npm 依赖，许可证随其包分发。内容版权归相应权利人。

```bash
npm run typecheck
npx vitest run tests/unit/hongguo-server.test.ts tests/unit/hongguo-client.test.ts tests/unit/plugin-preload-dispose.test.ts tests/unit/plugin-loader-scope.test.ts
```

测试覆盖 CDN / 重定向边界、播放密钥隔离、MP4 缓存与 Range、搜索与选集、布局切换保留视频、观看进度、自动下一集、销毁后的异步结果，以及禁用 / 重载常驻模块的清理。
