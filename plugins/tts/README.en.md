**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Multi-source universal text-to-speech plugin (TTS)

Registers **ByteDance Doubao large-model speech** and **DeepSeek speech** with the system's unified TTS center. Web announcements, QQ automatic voice replies and other tools share the engine and voice catalog; a bundled Chrome companion extension syncs credentials for both platforms.

> 🛡️ **Important: the DeepSeek anti-risk-control disguise and account safety**:
>
> 1. **Mechanism and risk**: DeepSeek does not officially offer a standalone text-only TTS synthesis API. The old plugin created a temporary session and deleted it seconds later on every call, and sent script-signature headers, which official anti-cheat risk control easily flags and bans.
> 2. **v1.4.0 anti-risk-control overhaul**:
>    - **Full disguise of real Chrome Headers**: every third-party script signature removed, aligned with the latest Chrome 133 standard headers and `sec-ch-ua` fingerprint;
>    - **Dedicated long-lived session reuse**: no more create-and-delete; one dedicated voice-bridge session is created and reused long-term, fully matching normal multi-turn user behaviour;
>    - **Naturally varied prompts**: a rotating set of human-like question templates avoids single-text clustering;
>    - **Human-like debounce and queue lock**: call intervals are throttled to prevent high-frequency bursts.
> 3. **Recommendations**:
>    - For production and long-form streaming read-along, strongly prefer **Doubao speech** (supports the Volcano Engine API Key commercial channel — legitimate, stable and effectively ban-free) or **server system speech**;
>    - The DeepSeek voices are far safer after the overhaul, but since they come from a reverse-engineered endpoint, pair them with a throwaway test account.

---

## Unified TTS center

Engines register on the plugin server through `host.tts.registerEngine()`; no plugin page needs to be open. The web 「设置 → 声音与语音」 (Settings → Sound and speech), this plugin's audition panel and the QQ voice settings all read engines and voices from the center. The `builtin` system engine comes from the host; the plugin registers `doubao-tts` and `deepseek-tts`.

The AI `tts` tool supports `action: "list"` to query every engine, and `engine` to query that engine's voices; synthesis can choose the system engine or one registered by another plugin. The old `doubao` / `deepseek` arguments keep working. Uninstalling the plugin revokes its engine registration and cancels in-flight requests. See [`docs/architecture-tts.md`](../../docs/architecture-tts.en.md) for the interface and migration notes.

## Highlights

1. **Two top-tier voice platforms in one place**:
   - **Doubao large-model speech**: 阳光阿辰/阳光青年, 磁性俊宇, 清爽男大, 温柔桃子, 阳光甜妹 and other quality character voices (web Cookie and Volcano Engine API Key both supported);
   - **DeepSeek official voices**: 白浪 Echo (bright male voice), 暗潮 Tide (deep, low male voice), 贝壳 Mira (lively female voice), 海星 Stella (sweet female voice).
2. **Two-way companion-extension sync**:
   - The companion extension supports both `doubao.com` and `chat.deepseek.com`; open the extension icon on either site and sync the current login state locally in one click.
3. **Seamless switching to built-in system speech**:
   - In the **设置 -> 声音与语音 -> 语音引擎** (Settings → Sound and speech → Speech engine) dropdown, switch freely between 「系统语音」 (System speech), 「豆包语音」 (Doubao speech), 「DeepSeek 语音」 (DeepSeek speech) and any other registered engine;
   - The speaker icon at the bottom right of message cards, background notification sounds and streaming read-while-typing all work natively.
4. **Streaming sentence-by-sentence playback queue**:
   - The web page plays generated audio sentence by sentence; the center queues per engine uniformly, and stopping read-aloud cancels generation and releases audio resources.
5. **AI tool support**:
   - Provides the `tts` tool so the AI can query the center's engines, pick a voice and generate an audio file, with the extension taken from the format the engine returns.

---

## Quick install and setup

### 1. Load the companion extension (done in 30 seconds)

1. In Chrome / Edge open `chrome://extensions` and enable 「开发者模式」 (Developer mode) at the top right;
2. In the pi-web-ui left menu open the 「语音合成 (TTS)」 (Text-to-speech) panel and click **【📂 在电脑中定位扩展目录】** (Locate the extension directory on this machine);
3. Drag the `extension` folder that opens straight into the browser's extensions page.

### 2. Sync credentials

- Open [doubao.com](https://www.doubao.com) or [chat.deepseek.com](https://chat.deepseek.com) in the browser and sign in;
- Click the 🔊 icon in the extension toolbar at the top right and click **【🚀 一键提取全部】** (Extract everything in one click) to sync.

---

## Supported voices

### 1. Doubao large-model voices (Doubao)

- 阳光青年 / 阳光阿辰 (`yangguang`, the classic energetic male voice)
- 磁性俊宇 (`junyu`, warm magnetic male voice)
- 清爽男大 (`nanda`, lively young male voice)
- 温柔桃子 (`taozi`, warm conversational female voice)
- 阳光甜妹 (`tianmei`, fresh sweet female voice)
- 知性小棠 (`xiaotang`, poised and steady female voice)
- 北京大妞 (`shuangkuai`, forthright and generous female voice)
- 冷酷霸总 (`bazong`, specialty character voice)
- 病娇少爷 (`bingjiao`, specialty character voice)

### 2. DeepSeek official voices (DeepSeek) ⚠️ account-ban risk

> ⚠️ **Warning**: frequent calls to the DeepSeek engine easily get the web account banned by the official side — use a throwaway test account, or only audition occasionally!

- 白浪 Echo (`echo`, bright and firm male voice)
- 暗潮 Tide (`tide`, low and rich male voice)
- 贝壳 Mira (`mira`, versatile lively female voice, can sing)
- 海星 Stella (`stella`, playful sweet female voice)

---

## Local HTTP endpoints

- `POST /plugins-api/tts/sync-credentials`: receive and persist the Doubao Cookie and the DeepSeek token.
- `POST /plugins-api/tts/speak`: compatibility entry point that synthesizes through the unified center and returns base64 audio; `engine` accepts a registered ID and also `doubao` / `deepseek`. The unified web entry points are `/api/tts/engines`, `/api/tts/voices` and `/api/tts/synthesize`.
- `POST /plugins-api/tts/open-folder`: locate the directory the extension lives in.
- `GET /plugins-api/tts/download-extension`: download the extension ZIP archive.
