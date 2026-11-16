**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Voice and photo input plugin (voice-input)

Two buttons next to the composer: 🎤 tap once and talk — the overlay offers two ways to finish: 「填入输入框」(Insert into composer), which drops it into the draft so you can add a sentence before sending, and 「直接发送」(Send directly), which sends it to the current conversation with no editing needed;
📷 opens the camera, takes one shot, and the photo becomes an attachment in the composer (on mobile it can also launch the system camera directly).

It also gives the AI a `transcribe_audio` tool: meeting recordings and voice memos in the workspace can be turned into text for the AI to read.

## Three paths (pick one explicitly, automatic fallback by default)

1. **Browser-native recognition** (free, zero config): Chrome / Edge use the Web Speech API for live dictation, Chinese and English both. **Needs network access**.
2. **Local Whisper** (server-side, one-click install): 「一键安装本地 Whisper」(One-click install of local Whisper) in the overlay;
   the server installs the runtime and downloads the model (tiny ~150MB / base ~290MB / small ~500MB, the most accurate). After that, recordings never leave the machine and transcription needs no key.
   Recordings are 16k mono WAV encoded live in the browser (AudioWorklet), so the server needs no ffmpeg.
3. **Remote transcription** (server-side, endpoint required): for Firefox / Safari without the Web Speech API, or when recognition fails,
   the recording is POSTed to the server's `/plugins-api/voice-input/transcribe`,
   and the server forwards it to an OpenAI-compatible `/audio/transcriptions` endpoint (Whisper).

`auto` mode (default): 🎤 first tries browser recognition, then falls back in order to local Whisper → the remote endpoint on failure or when unsupported.

### Skip the wait for a network failure: name the path you want

After picking `local` or `remote` under 「转写引擎」(Transcription engine), 🎤 takes that path **directly**: with `local` and Whisper already installed it starts recording at once,
and without it, the one-click installer pops up right there (no sitting through several seconds of the browser speech service failing); with `remote` it records and posts to the remote endpoint,
and when no endpoint is configured it tells you exactly where to fill it in.

The recording overlay (during browser recognition and during recording alike) also carries a permanent **「切换识别方式」(Switch recognition method)** button that switches at any time between
browser online recognition / local Whisper / the remote endpoint, and writes the choice back to the plugin settings (the next 🎤 tap uses that setting).
Note: the switch does not refresh an already open settings page — the ⚙ panel shows the value as of the next time it is opened.

## Photo capture (📷)

📷 opens the viewfinder panel; press the shutter and the photo goes into the composer attachments (you can shoot several in a row), then add whatever you want to say and send.

- **Camera by default** (`getUserMedia`): the panel switches between front and rear cameras (no switch button when the device has only one camera).
- **If it cannot open, take another path**: in a non-secure context / no camera on the device / permission denied, the panel states the reason outright
  and offers a 「用系统相机 / 选图片」(Use system camera / Pick an image) button — on mobile it launches the system camera app, on desktop it degrades to picking an image. **This path needs no permissions at all**.
- Photos are compressed to JPEG at a 1568 px longest edge and kept at ≤2MB (matching the server's hard limit for pasted images),
  so they take exactly the **pasted-image path** and never push the original image into the context.
- The camera is only held while the panel is open; closing the panel / deactivating the plugin stops the stream (the indicator light goes out).

## Install

Settings panel → UI plugins → Plugin marketplace → find 「语音输入」(Voice input) and click install; or:

```bash
pi-web-ui install xing-shuyin/pi-web-ui/plugins/voice-input
```

`view: false`: no dedicated view tab; it only adds the 🎤 and 📷 buttons to the composer action area
(hideable and orderable under Settings → UI layout).

`fs:read` in `permissions` is the minimum read permission `transcribe_audio` needs to read audio files in the workspace
(workspace files only; anything outside is rejected). Updating to 0.2.0 makes the host show a one-time 「能力清单变了」(capability list changed) prompt — a normal security prompt.

## Configuration (Settings panel → UI plugins → Voice input)

| Item                          | Description                                                                                                                                                                                                                                          |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Recognition language          | Defaults to `zh-CN`; shared by browser recognition and the Whisper `language`                                                                                                                                                                        |
| Server transcription fallback | On by default; **only governs the `auto` setting's last resort** — it does not block you once `local`/`remote` is chosen explicitly (see above)                                                                                                      |
| Transcription engine          | Defaults to `auto` (browser recognition first, then local → remote fallback); `local` sends 🎤 straight to the local engine (installs it first if missing); `remote` uses the remote endpoint only                                                   |
| Model download source         | Empty = the official `huggingface.co`; use `https://hf-mirror.com` when direct access times out from mainland China. The `HF_ENDPOINT` env var is also honored                                                                                       |
| Local model                   | Defaults to `base` (more accurate for Chinese, ~290MB); `tiny` is smaller and faster (~150MB); `small` is the most accurate (~500MB, 3–4× slower CPU transcription). Uses ~1GB of resident memory while transcribing                                 |
| Transcription endpoint base   | OpenAI-compatible base such as `https://api.openai.com/v1`; empty = no remote transcription configured                                                                                                                                               |
| Transcription endpoint key    | Stored in `<dataDir>/plugin-data/voice-input/storage.json`, **never sent to the browser**                                                                                                                                                            |
| Transcription model           | Defaults to `whisper-1`                                                                                                                                                                                                                              |
| Transcription tool for the AI | On by default; registers `transcribe_audio` for the AI. Turning it off delists it from the AI's tool table; it can also be disabled separately under the 「注册的 AI 工具」(Registered AI tools) group on the host's Settings → 「工具」(Tools) page |

Local model files live in `<dataDir>/plugins/voice-input/whisper-cache/` (deleted when the plugin is uninstalled);
the settings panel has no button for it yet — **install and uninstall live in the 🎤 overlay** (which prompts when nothing is installed).
Uninstalling the model deletes only the weights (`DELETE /plugins-api/voice-input/local`); the runtime (node_modules) stays, so reinstalling takes seconds.

Any third-party compatible endpoint (a local Whisper service, a proxy, and so on) works as long as it exposes
`POST {base}/audio/transcriptions` (multipart `file`/`model`/`language`).

## Transcription tool for the AI (transcribe_audio)

The AI cannot listen to audio itself, so this plugin gives it a tool: turn an audio file **inside the workspace** into text.

```js
transcribe_audio({ path: "notes/standup.m4a", lang: "zh-CN" });
```

- **WAV**: local Whisper decodes it directly (no ffmpeg needed).
- **mp3 / m4a / ogg / webm / flac**: the local engine **cannot** decode them (WAV decoder only),
  so configure 「转写接口基址 / 密钥」(transcription endpoint base / key) in settings and use the remote path; when unconfigured, the tool tells the AI both options explicitly instead of throwing a 415.
- Local limit is about 8 minutes / 15MB per call (split longer audio); remote limit is 25MB.
- Only workspace files can be read; anything outside the workspace is rejected (add that directory as a workspace root first).

## Troubleshooting Edge speech recognition failures

If 🎤 does nothing / errors out immediately, match your case below (the overlay now tells you which one it is):

1. **The page was opened at `http://<LAN-IP>:8787`** (most common): a non-secure context, so Edge disables speech recognition and the microphone outright.
   Open it at `http://localhost:8787` or `http://127.0.0.1:8787` instead.
2. **network error**: Edge speech recognition needs network access; a proxy / VPN / corporate gateway may block the speech service.
   The plugin switches to server-side recording automatically; use server-side recording until the network is fixed.
3. **not-allowed**: microphone permission was denied. Click the 🔒 icon at the left of the address bar → Microphone → Allow → reload the page.
4. **Browser recognition keeps cutting off silently**: the overlay has a 「改用服务端录音」(Switch to server-side recording) button that bypasses it in one click.

If none of that works (Firefox / iOS Safari, for instance, have no speech recognition at all):
「一键安装本地 Whisper」(One-click install of local Whisper) in the overlay is the least-effort path — no key to buy, no endpoint to configure.

## Privacy

- Browser recognition: audio stays between this machine and the browser's speech service (Chrome uses Google's service); it never passes through the pi-web-ui server.
- Local Whisper: audio never leaves this machine, the model runs on the server's CPU, nothing is written to disk (in-memory transcription).
- Remote transcription: the recording is forwarded only to your own configured endpoint, nothing is written to disk (in-memory forwarding; a failure leaves no files).
- Photo capture: frames are grabbed and compressed to JPEG only in your browser, **never processed by the server**;
  the plugin stores no photo files at all — photos live in the composer attachments, and whether and which one to send is up to you.
- Transcribed files: when the AI calls `transcribe_audio` it reads that audio file in the workspace (read-only, no copy, no disk write);
  local transcription happens in memory, and only remote transcription sends the bytes to your own configured endpoint.

## Compatibility

- Requires the host's `window.__piWebUiHost.compose / onUiAction` (plugin host API v2+;
  manifest `apiVersion: 2` blocks older pi-web-ui versions up front).
- Mobile: works in mobile Chrome; iOS Safari uses the server-side fallback (needs a configured transcription endpoint + microphone permission).
- Photo capture needs a secure context (`localhost` / `127.0.0.1` / https); in a non-secure context the panel falls back automatically to
  the 「用系统相机 / 选图片」(Use system camera / Pick an image) path that needs no permissions.
