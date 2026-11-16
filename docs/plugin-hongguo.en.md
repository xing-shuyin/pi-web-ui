**English** · [简体中文](./plugin-hongguo.md) · [繁體中文](./plugin-hongguo.zh-TW.md)

# hongguo plugin

`plugins/hongguo/` is a pi-web-ui port of [frostming/dsh-hongguo](https://github.com/frostming/dsh-hongguo), using [openhongguo](https://github.com/beilunyang/openhongguo) `0.1.0` to reach the anonymous short-drama API. Open it from 「hongguo」 in the top bar; it supports title search, actor search with their works, episode selection, resume playback, watch history, playback speed, auto next episode, next-episode preloading and browser picture-in-picture.

## Install and usage

From the repository root in a development environment:

```bash
node scripts/link-plugins.mjs hongguo
```

Reload plugins in settings, then click 「hongguo」 in the top bar. Once published to a remote directory it can also be installed from the plugin marketplace. On the first runtime visit, the host's `ensureDeps` installs the plugin's own `openhongguo@0.1.0`; the root project's dependencies stay unchanged.

The player offers two modes, switched instantly by the top button:

- **Floating**: drag the title bar to move the window; drag any edge or corner to resize; a compact view can be toggled during playback, and the compact window remembers its own width and height and is equally resizable.
- **Split pane**: at least 800px wide it sits on the right, drag its left edge to change the width; on narrow screens it switches to a top/bottom split automatically, drag the top edge to change the height.

The left of the search box selects 「剧名」(Title) or 「演员」(Actor). Actor search uses the platform's user search page; clicking a name loads that person's works, then pick a series and an episode; results may include ordinary accounts, and an empty list is shown when nothing is public. Both actor works and search results support 「加载更多」(Load more).

「预载下一集」(Preload next episode) is on by default and independent of 「自动连播」(Autoplay next). Once the current episode starts playing, only the immediately following episode is downloaded and transcoded ahead of time, showing 「下一集已就绪」(Next episode ready) on success. Switching episodes reuses completed H.264/AAC caches; if a job is still in progress, the playback request waits on that same job and does not parse, download or transcode again. Closing, switching episodes or cancelling preload aborts the browser wait; processing the server already started may finish and enter the bounded cache, and uninstalling the plugin aborts the task.

Split pane reserves space through the stable `dom.anchors().app` mount point and restorable padding. The window uses only its own styles and never queries host-internal class names. A layout switch neither moves nor recreates the `<video>`, and switching conversations keeps playing. Closing the window pauses the video, exits picture-in-picture and releases the split space; reopening and pressing the native play button resumes.

## FFmpeg and playback constraints

The server always has FFmpeg output MP4 as **H.264 Main / yuv420p + AAC-LC**, avoiding the case where HEVC / H.265 plays with sound and normal progress but no picture in some browsers or desktop engines. CENC-encrypted episodes use the content key returned by openhongguo and are decrypted and transcoded in the same pass. Video keeps its aspect ratio with the long edge capped at 1280 pixels; audio is always AAC-LC. HEIC covers from the CDN are also converted to JPEG by FFmpeg. After installing FFmpeg, keep it on PATH, or fill in **FFmpeg path** under Settings → Plugins → hongguo. The path is passed to `execFile` as a standalone executable argument, never through a shell. Windows WinGet link directories and the usual macOS / Linux install paths are probed automatically.

FFmpeg is detected when the player opens, with a hint shown if it is missing. Processing waits until an actual video request arrives; the first play waits for the download and transcode, and later plays reuse the cache. MP4 playback no longer depends on the client's HEVC decoding capability. Rate limits, regional availability, takedowns and network problems of the anonymous service are up to the upstream.

Native MP4 plays in the browser, HLS uses native browser support or the bundled mpegts.js, and DASH uses the bundled dash.js. DASH in BaseURL / SegmentBase form goes through the same-origin proxy; SegmentTemplate form explicitly returns unsupported, avoiding invalid addresses.

## Data and lifecycle

- Browser `pi-web-ui:hongguo:prefs:v1` stores layout, position, window size, volume, playback speed, autoplay-next and next-episode preload preferences; `pi-web-ui:hongguo:history:v1` stores episode, timestamp and title for the 30 most recent series. Progress is saved about every 4 seconds and on pause / close. An episode already finished restarts from the beginning when opened again.
- Server-side `<dataDir>/hongguo/anonymous.json` holds the anonymous device profile, written atomically with user-private file permissions. `media/` keeps at most the 12 most recent processed episodes; the compatible cache uses `<episodeId>.h264-aac-v1.mp4`, and old `<episodeId>.mp4` caches are transcoded automatically without re-downloading or re-fetching keys. Playback URLs carry `?format=h264-aac-v1`, preventing the browser from reusing an old HEVC response. `covers/` keeps at most 300 converted covers. Videos are cached only in the host data directory, never in the source / plugin directory.
- Content keys stay on the server only. The client plays through same-origin `/plugins-api/hongguo/*` addresses, and the upstream URL of unencrypted streams is passed as a proxy query parameter. Playback endpoints and the proxy addresses inside HLS / DASH manifests use relative paths, to support app-subpath reverse proxies.
- The plugin requests only `ui`, `http`, `dom:anchor`. The browser reaches same-origin HTTP routes only; the server restricts CDN domains, revalidates on every redirect, and rejects credentials, non-standard ports and executable upstream content.
- `client/entry.mjs` forwards the host reload epoch query parameter to `player.mjs`, which passes it on to `styles.mjs` / `state.mjs`, ensuring a plugin reload never reuses old handle styles or sizing logic.
- `client/entry.mjs` default-exports `dispose()`. The host tears down the always-on instance on disable, removal, error, epoch reload and stale async load: pause / release media, cancel requests, remove events / observers / overlays and restore host styles. Server-side uninstall aborts media requests and FFmpeg child processes, and the host unregisters the routes automatically.

## Interfaces and sources of truth

| Route (relative to `/plugins-api/hongguo`) | Returns / behavior                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------- |
| `GET /config`                              | `{ ffmpegAvailable }`                                                     |
| `GET /list`                                | `{ items }`, recommendations cached for 15 minutes                        |
| `GET /search?q=&type=actor&cursor=`        | `{ items, cursor, hasMore }`                                              |
| `GET /actors/works?id=&cursor=`            | `{ person, items, cursor, hasMore }`, actor profile and their works       |
| `POST /preload?episode=`                   | downloads and transcodes the next episode, returns `{ episodeId, ready }` |
| `GET /series?id=`                          | `{ series, episodes }`                                                    |
| `GET /play?episode=`                       | `{ episodeId, duration, streams }`; never returns content keys            |
| `GET /media/<episodeId>`                   | processes and caches MP4, supports Range / 206 / 416 and seeking          |
| `GET /stream?u=`                           | restricted CDN proxy; rewrites HLS / DASH manifests                       |
| `GET /cover?u=`                            | restricted cover proxy, converts HEIC when necessary                      |

Server: `plugins/hongguo/index.mjs`, `lib/media.mjs`. Client: `client/player.mjs`, `client/state.mjs`, `client/styles.mjs`. Entry: `manifest.json`, `client/entry.mjs`. Host always-on lifecycle: `web/src/plugin-loader.ts`.

## Provenance and acceptance

The port references dsh-hongguo v1.2.1 and keeps upstream attribution; the original repository provides no root license, so this port declares no separate license for the upstream source. The bundled player libraries keep their original files and licenses: `client/vendor/LICENSE-mpegts.js.txt`, `LICENSE-dashjs.md`, `LICENSE-dashjs-third-party.txt`. openhongguo is an independent npm dependency whose license ships with its package. Content copyright belongs to the respective rights holders.

```bash
npm run typecheck
npx vitest run tests/unit/hongguo-server.test.ts tests/unit/hongguo-client.test.ts tests/unit/plugin-preload-dispose.test.ts tests/unit/plugin-loader-scope.test.ts
```

The tests cover CDN / redirect boundaries, playback key isolation, MP4 caching and Range, search and episode selection, layout switching preserving the video, watch progress, auto next episode, async results after disposal, and cleanup of the always-on module on disable / reload.
