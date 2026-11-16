**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Wallpaper Engine dynamic wallpaper plugin (v0.3.0)

Blends the **Wallpaper Engine** Workshop wallpapers on this machine seamlessly behind the `pi-web-ui` conversation interface, together with liquid frosted-glass blur, opacity tuning, WebGL2 scene rendering, audio-spectrum sync and auto-rotation.

Modeled on [dsh-wallpaper-engine](https://github.com/elysia395/dsh-wallpaper-engine) and purpose-built for `pi-web-ui`. **Registers no extra tools or prompts with the model and adds zero token overhead.**

---

## Highlights

- 🎮 **Deep scan across all Steam libraries**: reads the Windows registry and Steam's `libraryfolders.vdf` automatically, and probes all libraries on every drive and partition for Wallpaper Engine Workshop wallpapers (AppID `431960`) and default wallpapers.
- 🎬 **Every wallpaper format supported**:
  - **Video**: HTTP 206 Range chunked streaming, smooth looping and mute toggle for high-quality MP4 / WebM.
  - **Scene**: built-in WebGL2 real-time renderer (based on `webwallgl`), with `.pkg` bundle parsing, particle systems, skeletal animation and shader-driven dynamic lighting.
  - **Web**: mounted in an isolated sandboxed `<iframe>`, with the common Wallpaper Engine properties and events injected as a shim.
  - **Image**: full-screen, high-quality, centered, aspect-adaptive render for JPG / PNG / WebP.
- 🎵 **Music spectrum reactivity**: built-in acoustic spectrum waveform simulation and collector that injects audio rhythm in real time into audio-reactive Web and Scene wallpapers.
- ⭐ **Wallpaper favourites and auto-rotation**:
  - Click the **⭐** at the bottom right of a wallpaper card to add or remove it from favourites, with a dedicated “⭐ 收藏” (Favourites) category tab;
  - Set auto-rotation to **5 minutes / 15 minutes / 30 minutes / 1 hour**, or click **🎲 切下一张** (Next wallpaper) at the top of the drawer for an immediate random switch.
- 📤 **Appearance preset import and export**: export the active wallpaper, glass blur, opacity and favourites configuration as a standalone JSON snapshot in one click, or import a shared scheme from the clipboard.
- 🧊 **Liquid Glass**: CSS variables drive the frosted texture of every layer, with blur radius (0-32px) and interface base opacity (40%-100%) seamlessly adjustable in real time.
- 🕹️ **Interaction and click-through mode**: enable “allow interaction” so the mouse can interact live with the Web / Scene wallpaper behind the chat area.
- ⚡ **Smart power management**:
  - Set a frame-rate cap of **30 FPS / 60 FPS / unlimited** to balance smoothness against GPU power draw.
  - When the page is hidden in the background, video playback and the WebGL render loop are suspended, so they never compete for coding or model-generation compute.
- 🪟 **Immersive wallpaper drawer**: expand the drawer panel from the top bar with one click; supports live search by title/tag, multi-dimension category filters (all/favourites/video/scene/web/image), paged grid browsing (greatly cuts DOM and image concurrency for large libraries), 1:1 render of the cover's original aspect ratio (no cropping or squashing, with a frosted ambient glow) and instant switching.

---

## Supported wallpaper types

| Type            | Description                                       | Support            | Rendering mechanism                                                   |
| --------------- | ------------------------------------------------- | ------------------ | --------------------------------------------------------------------- |
| **Video**       | MP4 / WebM / M4V                                  | ✅ Fully supported | Native `<video>` hardware acceleration, HTTP 206 chunked streaming    |
| **Scene**       | 2D/3D dynamic scenes (`.pkg`)                     | ✅ Fully supported | `webwallgl` WebGL2 real-time rendering, smooth degradation on failure |
| **Web**         | HTML / JS / CSS page wallpapers                   | ✅ Fully supported | Sandboxed `<iframe>` + WE API shim                                    |
| **Image**       | JPG / PNG / WebP                                  | ✅ Fully supported | Full-screen adaptive rendering and thumbnails                         |
| **Application** | Program wallpapers that launch an external `.exe` | ❌ Not supported   | Filtered out automatically, never enter the candidate list            |

---

## Plugin layout

```text
plugins/wallpaper-engine/
├── manifest.json            # plugin manifest (declares permissions, settings and the top-bar button, v0.3.0)
├── index.mjs                # server: Steam path scan, metadata parsing, streamed video, Scene.pkg and Web sandbox routes
├── client/
│   ├── entry.mjs            # client: full renderer (Video/Scene/Web), audio response, timed rotation and drawer component
│   └── styles.mjs           # styles: frosted-glass CSS variable overrides, click-through, favourite state and drawer styles
└── README.md                # full technical documentation for the plugin
```

---

## Protocol and API routes

All HTTP endpoints mount under `/plugins-api/wallpaper-engine/api/*`:

| Route                       | Method | Description                                                                                          |
| --------------------------- | ------ | ---------------------------------------------------------------------------------------------------- |
| `/api/wallpapers`           | `GET`  | Get the list of every wallpaper scanned on this machine, the active state and the favourite set      |
| `/api/rescan`               | `GET`  | Clear the server cache and re-scan Steam libraries on every drive                                    |
| `/api/preview?id=:id`       | `GET`  | Read a wallpaper thumbnail (with 24-hour HTTP client caching)                                        |
| `/api/media?id=:id`         | `GET`  | Read the video or main file (HTTP 206 Partial Content chunks supported)                              |
| `/api/pkg?id=:id`           | `GET`  | Read a Scene wallpaper's binary `scene.pkg` bundle                                                   |
| `/api/project?id=:id`       | `GET`  | Read the wallpaper's original `project.json` manifest                                                |
| `/api/web?id=:id&file=:rel` | `GET`  | Serve web wallpaper static assets inside the safety sandbox (strict path validation against escapes) |
| `/api/favorite`             | `POST` | Toggle the favourite state of a wallpaper (add/remove)                                               |
| `/api/presets`              | `GET`  | Export the current wallpaper choice and glass appearance config as preset JSON                       |
| `/api/presets`              | `POST` | Import and apply an external appearance preset JSON                                                  |
| `/api/active`               | `GET`  | Get the wallpaper in use, rotation settings and glass parameters                                     |
| `/api/active`               | `POST` | Save wallpaper and parameter changes and broadcast them to other connected tabs                      |

---

## Usage

1. Make sure Steam is installed and Wallpaper Engine Workshop wallpapers are subscribed;
2. Start `pi-web-ui` and click the **🖼️ 壁纸** (Wallpapers) icon at the top right of the top navigation bar;
3. Browse the detected wallpapers in the expanded drawer (the category tabs switch between “全部” (All), “⭐ 收藏” (Favourites), “视频” (Video), “场景” (Scene), “网页” (Web) and “静态图” (Image));
4. Click **☆** on a card to favourite a wallpaper, and click the card body to apply it immediately;
5. Adjust at the top of the drawer to taste:
   - **Blur and opacity**: dial in the most comfortable translucent frosted feel;
   - **Auto-rotation**: pick a rotation interval (e.g. every 15 minutes), or click “切下一张” (Next wallpaper) to switch manually;
   - **Music spectrum**: once on, audio-reactive wallpapers follow the sound;
   - **Allow interaction**: once on, the mouse can interact with the background through gaps in the chat area;
   - **Export/import preset**: save or share the appearance scheme in one click;
   - **Turn wallpaper off**: restore the plain solid-colour interface at any time with one click.
