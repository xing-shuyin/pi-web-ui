# hongguo

将 [frostming/dsh-hongguo](https://github.com/frostming/dsh-hongguo) v1.2.1 移植为 pi-web-ui 原生插件，基于 [openhongguo](https://github.com/beilunyang/openhongguo) 提供剧名 / 演员搜索、参演作品、选集、进度续播、自动连播和下一集预加载。

点击顶栏 **hongguo** 打开播放器，选择 **悬浮** 或 **分屏**。悬浮窗可拖动标题栏移动，四边四角均可调整尺寸，精简模式也可缩放并单独记忆大小；分屏在桌面端左右排布，窄屏上下排布。播放中切换模式会保留同一个视频实例。搜索框左侧选择「演员」可按姓名查询参演作品；「预载下一集」默认开启，会提前下载并转码一集供切集复用。另支持精简播放视图与浏览器画中画。

开发环境安装：

```bash
node scripts/link-plugins.mjs hongguo
```

随后在设置里重新加载插件。首次访问自动安装插件独立依赖。MP4 统一转为 H.264 + AAC 兼容格式，旧缓存自动迁移，避免部分客户端出现有声音但黑屏。视频处理及 HEIC 封面需要 FFmpeg，可在插件设置中填写可执行文件路径。

完整安装、接口、缓存、权限、第三方来源和验收说明见 [hongguo 插件文档](../../docs/plugin-hongguo.md)。
