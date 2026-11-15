**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# hongguo

Ports [frostming/dsh-hongguo](https://github.com/frostming/dsh-hongguo) v1.2.1 into a native pi-web-ui plugin, built on [openhongguo](https://github.com/beilunyang/openhongguo) for title / actor search, actor filmography, episode lists, resume progress, autoplay and next-episode preloading.

Click **hongguo** in the top bar to open the player, then choose **Floating** or **Split pane**. Drag the floating window by its title bar to move it, and resize from any edge or corner; compact mode also scales and remembers its own size; split pane lays out side by side on desktop and stacked on narrow screens. Switching modes during playback keeps the same video instance. Selecting “Actor” (「演员」) on the left of the search box looks up an actor's filmography by name; “Preload next episode” (「预载下一集」) is on by default and downloads and transcodes one episode ahead for reuse when switching. A compact playback view and browser picture-in-picture are also supported.

Install for development:

```bash
node scripts/link-plugins.mjs hongguo
```

Then reload plugins in settings. First access installs the plugin's standalone dependencies automatically. MP4 files are uniformly transcoded to the compatible H.264 + AAC format and old caches migrate automatically, avoiding audio with a black screen on some clients. Video processing and HEIC covers need FFmpeg; enter the executable path in the plugin settings.

Full installation, API, cache, permissions, third-party sources and acceptance notes: [hongguo plugin docs](../../docs/plugin-hongguo.en.md).
