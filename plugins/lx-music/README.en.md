**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# LX Music UI plugin

A full-featured, professional music player plugin embedded seamlessly in `pi-web-ui`.

## 🌟 Core features at a glance

- **Multi-platform aggregated search**: built-in search sources for NetEase Cloud Music, QQ Music, Kuwo, Kugou and Migu Music, switched seamlessly in one click.
- **Independent official charts per platform**: browse independent chart lists for the four platforms NetEase Cloud Music, QQ Music, Kuwo and Kugou! Covers every official authoritative chart on each platform — NetEase's Hot Songs / Soaring / New Songs / Original / Rap charts, QQ Music's Popularity Index / Hot Songs / New Songs / Soaring charts, Kugou's TOP500 / Soaring / Douyin Hot Songs charts and Kuwo's Hot Songs / Soaring / New Songs / DJ charts.
- **Curated playlists and import across platforms**: a new 「🎶 歌单」(Playlists) channel for browsing huge curated playlist libraries per platform (NetEase/QQ Music/Kugou/Kuwo) and per genre (All/Pop/Mandarin/Rock/Folk/Light Music/Soundtrack and more); click a card for full playlist details or play everything in one click; paste a playlist share link or playlist ID to parse and import it instantly!
- **Desktop picture-in-picture floating lyrics**: built on the modern browser picture-in-picture engine, an independent always-on-top mini window that follows the scrolling highlight in real time, so you can follow the lyrics while coding in an editor or another app.
- **Click or double-click to play**: in search, charts, favorites, history and the play queue, double-click a song row or click the play button on the right of the row to start playback immediately.
- **Line-by-line dynamic scrolling lyrics**: an LRC parsing engine centers, highlights and enlarges the current line, and clicking a lyric time line seeks playback straight to it.
- **Three play modes**: freely switch between 「🔁 列表循环」(Repeat all), 「🔀 随机播放」(Shuffle) and 「🔂 单曲循环」(Repeat one).
- **Automatic restore after refresh**: play queue, favorites, search results and keywords, chart list, current song and progress, volume, audio quality, play mode and selected platform are stored in browser local storage, isolated per deployment path; after a refresh, pressing play resumes from the last progress and re-fetches the stream URL. Progress is saved every 3 seconds and immediately on pause or page switch. A browser storage failure shows a notice.
- **Play history**: recorded automatically after successful playback, de-duplicated per platform and song, most recent first, keeping the latest 500 tracks; the 「播放记录」(History) page supports replaying and adding to the queue. Clearing browser site data clears these local records; favorites and custom sources are stored separately in a server data directory.
- **Play queue with drawer management**: view the current queue's track list at any time, append in one click, remove single tracks or clear it.
- **「我喜欢」(Liked) favorites**: click the heart button (❤️ / 🤍) on a song row to add it instantly; data persists in the data directory and survives upgrades.
- **One-click song download**: click 「⬇️ 下载」(Download) on a song row to save the file to the local device as `歌曲名 - 歌手.mp3`.
- **Audio quality switching**: choose 128k (Standard), 320k (High quality) or FLAC (Lossless).
- **Global keyboard shortcuts**:
  - `Space`: play / pause
  - `ArrowLeft` / `ArrowRight`: seek back 5 s / seek forward 5 s
  - `Ctrl + ArrowLeft` / `Ctrl + ArrowRight`: previous / next track
  - `ArrowUp` / `ArrowDown`: nudge the volume (+5% / -5%)
- **Runtime for custom source scripts such as Liuyin**: compatible with community third-party source scripts (User API) such as Liuyin, accepting pasted source or a URL to download from (fetched only from the exact URL you give, with no fallback through third-party mirrors such as ghproxy/ghfast). Scripts run in `node:vm` and get no host realm references injected (`Buffer`/`URL`/`fetch`/`TextEncoder` and other host built-ins are absent from the script global), but **`node:vm` is not a security boundary**: it exists only to host scripts you chose to import, so never import scripts of unknown origin; if you really need strong isolation, run the server in a restricted container.
- **Always-on background playback**: switching back to the AI conversation or opening the settings panel does not interrupt playback.
- **System media key integration**: supports `navigator.mediaSession`, so keyboard multimedia keys (play/pause/previous/next) and the system lock-screen controls work.
- **Song requests from the AI agent conversation**: registers the `music_control` agent tool, so telling the AI “播放一首周杰伦的晴天” (play Jay Chou's Sunny Day) in the main chat makes it search and broadcast to the player for immediate playback.
