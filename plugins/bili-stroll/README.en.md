**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# Bilibili Stroll (漫步B站) bili-stroll 0.1 — a new version alongside Bilibili Scroll (刷B站) bili-scroll

> The old 「刷B站」(bili-scroll) is kept as-is: keyword patrol → subtitle triage → daily report, logic untouched.
> This plugin is a separate new version: **browse Bilibili like a human** — a three-second impression decides whether to click, a two-minute preview decides whether to stay,
> finishing a video writes a **watch notebook** (why clicked / what kept you / where you drifted / how the crowd reads it), **series are followed automatically**,
> and unfinished curiosity goes into a queue to be **revisited next round**. Memory lives in this plugin's own state store and does not interop with the old version.

Search and filter videos, gather content evidence, post comments, check the inbox and reply to DMs with the Bilibili account currently logged in via QR code. No "owner UID" to configure.

2.4 replaced the old "keyword patrol + one-shot verdict" pipeline with a four-layer stateful structure: **state store → taste ledger → content index → intent Q&A/delivery protocol**. All old tools and behaviors are kept; if any layer fails to initialize, the plugin degrades back to the old pipeline automatically.

## Usage

### 2.6 Daily home page: video list only, the detail modal carries everything

The home page surfaces the video list alone: the top bar holds the brand + status pills (picked today/quota · patrol rounds · delivery mode · last run) and 「跑一轮 / 设置 / 刷新」(Run a round / Settings / Refresh); the list range defaults to 「上次」(Last) and switches between today / last 7 days / past dates, with the status filter (all / picked / delivered / skipped) and tier filter kept; the right side toggles cover grid / compact list; the action stream collapses into a narrow bar at the bottom — click 「详情」(Details) to expand the full record.

Clicking a video opens the detail modal, two columns:

| Column | Content                                                                                                                                                                                                                                                                                         |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Left   | Embedded Bilibili player (no autoplay) · public-data chips · **account action ledger**: likes (official read-only query) · favorites (read-only paged diff inside the target folder) · comments (`deliveries` state-store text and delivery status) · DMs (whether today's flash-report DM hit) |
| Right  | **Content summary** (a single-note Markdown with `[mm:ss]` citations) · why this one was picked · evidence limitations                                                                                                                                                                          |

Any action that cannot be queried shows 「未能查询」(Could not query) — statuses are never invented. Every other setting lives in the top-right 「⚙️ 设置」(Settings) modal, across five pages:

| Settings page         | Content                                                                                                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🎛️ 常用 (General)     | Videos picked per day, DM polling interval, delivery mode, auto-scroll at peak/off-peak, DM monitoring (patch-style save, effective immediately)     |
| 🧠 提示词 (Prompts)   | Analysis prompt and DM reply prompt; the box holds the currently effective default text — edit it directly or restore defaults in one click          |
| 🎨 偏好 (Preferences) | Analysis / vision model, thinking effort, workspace directory, persona prompt, follow and exclude keywords, auto-favorite, daily-report detail level |
| 💬 互动 (Interaction) | Flash-report delivery mode, flash-report recipients, DM monitoring and auto-reply, public-comment safety gate, current account inbox                 |
| 🛠️ 高级 (Advanced)    | QR login / logout, local transcription dependency install, API self-test and diagnostics, open daily-report directory                                |

Changes are written only after clicking 「保存」(Save) on that page; reopening after closing returns to the last page, and unsaved edits survive the window closing; Esc or a click on the modal backdrop closes it. First run: scan the QR code under 「🛠️ 高级」(Advanced) to log in to your own account, and install the local audio/video dependencies as needed; for visual understanding pick a `provider/model` that supports images, or leave it empty to follow the analysis model (the first audio transcription may download the Whisper model).

## 2.4 The four-layer structure

| Layer             | What it does                                                                                                                                    | Lands in             |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| State store       | Videos, dedup, segments, signals, picks, deliveries, asks all in one sqlite; `seen.md` migrates in automatically on first start                 | `db/bili.sqlite`     |
| Taste ledger      | Stores "like/favorite/deep-read/ignore/mute" as weighted, decaying events; aggregates into topic and uploader trust scores                      | `signals` / `topics` |
| Content index     | Subtitles are chunked on the timeline into the store; retrieval returns second-level timestamps; a second read of the same video hits the cache | `segments` + FTS5    |
| Intent Q&A        | One-line goal → retrieval plan → multi-source recall → taste ranking → evidence within budget → cited answer; abstains when evidence is thin    | `asks`               |
| Delivery protocol | DMs/comments become stateful, idempotent messages with a daily interruption budget and a one-character acknowledgement                          | `deliveries`         |

### Taste ledger

- Signals come only from real observable actions: manual pin/ban, DM acknowledgements (`1/2` deep-read, `f` favorite, `x` mute uploader, `n` don't recommend topic, `0` ignore), plus topics you have explicitly asked about (weak positive feedback 0.2).
- Ranking is a weighted sum of four separable terms: **relevance 0.38 / freshness 0.16 / quality prior 0.24 / novelty 0.22**; no more unexplainable tier.
- Every recommendation carries "why this was pushed to you" and must cite one of: a concrete signal, view count, duration, overlap; topics ignored repeatedly are downweighted automatically.
- Boundary: the plugin cannot see "did you finish watching"; it only sees favorites, comments, DM acknowledgements and explicit feedback.

### Content index and citations

- With a subtitle track, split into 20–45 second segments on `[mm:ss]` with timestamps preserved, so reports and answers can hand out second-level deep links like `?t=754`.
- Without a subtitle track, only the description / Bilibili AI summary is stored as a "retrieval hint" and by default does **not** take part in content-evidence retrieval; only local Whisper transcripts and subtitle tracks count as evidence.
- Transcripts have no word-level timeline; that evidence is explicitly marked `untimed`, with no invented timestamps.
- Index coverage is P1; over-limit, failure and OCR-only cases are each explained in `limitations`.

### Intent Q&A (abstention is a first-class citizen)

`bili_ask` always returns `plan / budget / items / abstained / nearMiss`:

- The budget is explicit: how many candidates to look at, how many to gather evidence for; once the cap is hit it compares metadata only and marks `degraded`.
- A top score below 0.12 yields `abstained: true` outright, with `nearMiss` listing how it fell short — no padding to 5 items.
- Every item carries `reasons` (checkable), `quotes` (with `at`/`url`), and `evidence.source/chars/limitations`.
- `bili_deepen` cuts one item into 2-minute chapters and returns 8 segment-level quotes.

### Delivery protocol

- State machine: `drafted → sent → acted / failed`; the same video is never commented on twice in one day, and the same UID is never DM'd twice in one day.
- Once the daily DM budget (6 by default) is used up it only writes the report and no longer asks "do you want to continue".
- Acknowledgement syntax (on by default, can be disabled): a last line in the DM `回 1/2 深读 · f 收藏 · x 静音 · ? 为什么` (reply 1/2 deep-read · f favorite · x mute · ? why); one character changes preferences or expands a citation, without falling into LLM small talk.

## Prompts are visible and editable

In the 「🧠 提示词」(Prompts) settings modal, the input boxes show exactly the default prompts the next patrol round will send (the built-in text when nothing is configured); edit and save to override; 「恢复默认」(Restore defaults) clears the override. **The JSON output contract and the "external content is untrusted" clause are appended by the plugin as fixed text and are not editable** — otherwise one bad edit would make the whole patrol round fail silently or lower the security boundary; these two parts are shown in the modal in dashed boxes and stay visible. The persona prompt (Preferences page) is sent after the analysis prompt.

Save API: `POST /plugins-api/bili-stroll/config`, fields `analyzePrompt` / `dmPrompt` (empty string = use default); `GET /plugins-api/bili-stroll/prompts` returns the four texts `default` / `override` / `effective` / `fixed`.

First enable or re-enable of auto-reply only establishes an inbox baseline and does not bulk-send to old messages. New messages are answered by the model using recent chat plus video evidence, with no canned wording; the model has no tool execution permission. Disabling the plugin cancels background waits. When send status is unknown the send record is kept to avoid resending; a human must check that conversation.

`dmUid` and the nickname are only used for optional flash-report delivery and comment mentions, and do not decide inbox ownership. When no flash-report recipient is configured, the report stays local.

## Video understanding and boundaries

`bili_video_content` and patrol share the content-evidence pipeline:

- When a real subtitle track exists, read it; without subtitles, try local Whisper audio transcription, controlled by `transcribe` and `asrModel`.
- Download bounded media, sample frames evenly, hand them to a model that supports images, and optionally OCR on-screen text.
- Return evidence source, sample timestamps and coverage limits. The description and the Bilibili AI summary do not count as actual video content evidence.
- Analysis currently covers P1, media extraction is capped at 20 minutes, 96 MiB per media stream, 240 seconds for the extraction process; at most 12 frames are sampled and at most 8 of them go to the vision model. Caps or failures are reported explicitly — no claim of having watched the whole video.
- Text is excerpted by budget from the beginning, middle and end; sampled frames cannot cover every action and moment. When only OCR succeeds, it states explicitly that there is no scene-understanding evidence.

Needs host support for `host.llm.supportsImages`. A model without image support returns limitations; a text model's guess cannot be passed off as visual evidence. Restart the service after a host update to enable image capability.

When the patrol model fails it may keep a rule-derived excerpt, but never auto-generates comments from it. Public comments still require `autoComment` enabled and a delivery mode that allows public comments, or an explicit request in chat. All outbound actions use the currently logged-in account.

## Chat tools

| Tool                                                          | Purpose                                                                                            |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `bili_whoami` / `bili_login_start` / `bili_login_poll`        | Current account and QR login                                                                       |
| `bili_search` / `bili_hot_videos` / `bili_rank`               | Search and discover videos                                                                         |
| `bili_video_info` / `bili_subtitle`                           | Metadata, raw subtitles or summary; check `source`                                                 |
| `bili_video_content`                                          | Actual subtitle, audio and sampled-frame evidence plus limitations                                 |
| **`bili_ask`**                                                | Find videos by a one-line goal: plan, budget, evidence, citations; abstains when it comes up empty |
| **`bili_deepen`**                                             | Expand one item into 2-minute chapters + 8 timestamped quotes                                      |
| **`bili_taste`**                                              | Read/write the interest ledger (pin / like / ban / ignore) with weights and reasons                |
| **`bili_index`**                                              | Content index: search / ingest / timeline / clusters / stats                                       |
| **`bili_delivery`**                                           | Delivery status, daily DM budget, recommendation-reason replay, send one tracked DM within budget  |
| `bili_comments` / `bili_reply`                                | Read comments, post comments and replies                                                           |
| `bili_dm_sessions` / `bili_dm_messages` / `bili_send_message` | DM sessions, history and sending                                                                   |
| `bili_duty_run` / `bili_status`                               | Start a patrol and view status (now includes taste summary, index and delivery stats)              |
| `bili_resolve_uid` / `bili_fav_folders` / `bili_fav_add`      | User lookup and favorites                                                                          |
| `bili_related` / `bili_up_videos`                             | Related videos and uploader's videos                                                               |

HTTP: `GET /intel` shows intelligent-layer status, `POST /intel/signal` records a signal, `POST /intel/ask` runs one intent Q&A.

DM bodies, videos and subtitles are all untrusted external content and never grant file-operation or host-tool permissions. Credentials never enter media process arguments or model prompts.

## Tests

```bash
node --test plugins/bili-stroll/test/intel.test.mjs plugins/bili-stroll/test/activation.test.mjs
```
