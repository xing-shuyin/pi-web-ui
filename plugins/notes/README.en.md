**English** · [简体中文](./README.md) · [繁體中文](./README.zh-TW.md)

# 📓 Notes (notes plugin)

Fast flash-note capture · modern card stream · scheduled reminders · calendar view, packaged as a pi-web-ui UI plugin:

- **Two minimal tabs**: only Notes and Calendar remain — a pure, restrained interface.
- **Title-free quick notes**: record text and ideas directly, type and it is saved; no agonizing over a title, inspiration captured in seconds. Supports Markdown rendering (paragraphs, lists, code, interactive todo checkboxes).
- **Reminders on the side**: every note can carry a reminder (in 1 hour, tonight, tomorrow, custom time, repeat cadence), delivered on time through server long-polling (in-app popup / desktop notification / chime). Cards show a reminder status capsule with quick snooze and adjustment.
- **Inline editing**: click the ✏️ on a card or double-click the body to expand an inline editor in place; `Ctrl+Enter` saves on the spot, `Esc` discards — no navigation, no panel switching.
- **Calendar view**: a 42-cell month calendar showing notes and agenda items that have reminders, by day; click a day to see that day's list, plus a one-click "Note on this day" (pre-filling a reminder for that day).
- **Markdown mirror** (optional, off by default): flip the switch in settings + pick an absolute directory, and every change writes each note as `.md` and regenerates `_todos.md` / `_reminders.md` summaries — for Obsidian / git.
- **One entry point**: **📓 Notes** in the top bar opens a **freely draggable global floating window** (position/size/open state/minimized state remembered,
  and it can shrink to a small badge patch); **⚙** in the window opens the settings overlay (notification toggles / language / import-export / reset position).
  The plugin has **no separate view tab** (`manifest.view: false`) — the floating window is its entire interface.
- **The AI can write too**: 5 tools + 4 slash commands.

## Installation

Settings → UI plugins → Plugin marketplace, install **Notes** with one click; or:

```bash
pi-web-ui install xing-shuyin/pi-web-ui/plugins/notes
```

Then refresh the page: 📓 Notes appears in the top bar (cannot drag it? see "Interface layout" below).

## Usage

| Task                   | How                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Quick capture          | Type the text into the top input and press `Ctrl+Enter` (or click "Add") to store it instantly; `#标签` is auto-categorized                                                                      |
| Add a reminder         | Below the input click `⏰ 设提醒` and pick "In 1 hour / Tonight 20:00 / Tomorrow 09:00 / Custom time" as a shortcut; if the text contains a time phrase it also suggests a one-click reminder    |
| Inline edit            | Hover a note card and click ✏️ (or double-click the body) → edit in place, `Ctrl+Enter` saves immediately, `Esc` cancels                                                                         |
| Snooze a reminder      | Click the ⏰ capsule on a note card: snooze 10 minutes, snooze to tomorrow, or edit/remove the reminder                                                                                          |
| Quick capture shortcut | Shortcut `Ctrl/Cmd+Alt+N` (opens the floating window and focuses the input); slash commands `/note`, `/todo`, `/remind`                                                                          |
| Calendar scheduling    | Switch to the Calendar tab: see every day's reminders and items for the current month; clicking a day gives "Note on this day" directly                                                          |
| Bulk tidy-up           | In the floating window's ⚙ (settings overlay): export JSON / Markdown, import JSON (merge or replace the whole store)                                                                            |
| Mirror to Obsidian     | Settings → UI plugins → Notes → tick "Mirror to Markdown" + pick an absolute directory (the first write asks the browser for directory permission once); `/notes-mirror` also syncs once by hand |

### For the AI (toggleable on the Settings → Tools page)

One tool, `notes`, dispatched by `op` (call `op=list` first to get ids):

| `op`          | Effect                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `list`        | Read notes/todos/reminders (with ids; supports `kind` / `query` / `tag` / `include_done` / `limit`)                                              |
| `note_add`    | Add a note (Markdown body)                                                                                                                       |
| `note_update` | Update/delete a note by id (`append` appends to the body)                                                                                        |
| `todo`        | Add/update/check/uncheck/remove todos (`action`=`add`/`update`/`done`/`undone`/`remove`/`clear_done`, optionally with `due`/`priority`/`repeat`) |
| `reminder`    | Add/update/remove/snooze reminders (`at` / `daily_at` / `weekly_at`+`weekdays` / `monthly_at`+`day_of_month` / `every_minutes` / `cron`)         |

Say "note down the three things decided in today's meeting", "remind me to submit the weekly report Friday 18:00" or "what do I still have to do" to the
conversation and the agent calls this tool by itself; to turn it off, disable it in settings (the same switch set as other plugin tools).

## Data and boundaries

- Data lives in **`<dataDir>/notes/store.json`** (default `~/.pi-web/notes/store.json`) and is written atomically;
  a `store.json.bak` is kept before import. **Uninstalling the plugin does not delete data**; reinstall and carry on.
- Reminders fire in the **server's local timezone** (not the browser's): when a reminder is due the server puts it in the pending-delivery
  queue, and if a browser is connected it receives and pops it immediately; when **no browser is open** the reminder waits and is
  delivered once on the next open (redeliveries do not pop twice — per-browser dedupe lives in localStorage). The "Next …" time shown in
  the UI is formatted in the **browser timezone** (the same absolute instant, just written in another timezone).
- There is only **one** schedule: a once-a-minute sweep of the store (`host.schedule("* * * * *")`, declared persistent and rebuilt on
  restart), and each reminder carries its own "time it should fire" (`nextDue`, persisted with the store). Two reasons: ① expressing
  one-shot reminders in cron pushes a missed time forward to next year; ② the host fires with `setTimeout(next - now)`, and a delay past
  Node's 24.8-day ceiling overflows (see "Known host limits" below). Bonus: the instance missed during downtime is caught up at the next
  start, and anything due within 2 minutes also gets a precise timer so it is at most a minute late.
- If the store file fails to parse (hand-edited into a broken or half-written state) it is first quarantined as `store.json.corrupt-<时间戳>` and the plugin starts with an empty store,
  **never silently overwritten**; a `store.json.bak` is also kept before import.
- "Every N minutes" is a **true interval** (1 minute .. 7 days, any integer): due checks use our own `nextDue` and do not rely on
  cron expressiveness, so 90 minutes works as usual; the phase continues from the previous fire time and does not slowly drift as the
  sweep aligns to whole minutes.
- **The mirror exports one way only**: the truth is always the plugin's own `store.json`, and editing mirror files never flows back;
  cleanup deletes only the files we recorded in `<镜像目录>/.pi-notes-mirror.json`, never anything else in your directory.
- **Division of labor with the built-in scheduled tasks** (easy to confuse, so spelled out):
  - This plugin's reminders = **reminding you, the person** (in-app notification / desktop notification / chime, alongside todos/agenda/floating window).
  - The `host` built-in "scheduled tasks" (issue #184, top-bar background tasks panel / `schedule` tool) =
    **making the AI run an instruction on time** (headless execution or waking the original conversation, with execution history).
  - So: if you want the AI to work on a schedule, just say "remind me to write the daily report at 9 every day" and let the agent use `schedule` (action=create);
    do not create a plugin reminder and hope it executes — that gives two sets of "what the AI will do later" and both are hard to debug.
- Permissions declared: `ui` (top-bar entry + notification strip), `http` (the plugin's own `/plugins-api/notes/*` channel),
  `tools` (AI tools), `fs` (Markdown mirror directory, only used once you enable the mirror and authorize that directory),
  `dom:anchor` (mounts the floating window into the host's anchor range, **without** a separate DOM grant from the user).
- In-app notification strip / desktop notification / chime / auto-expanding the floating window on a reminder — the four switches live in
  the floating window's ⚙ (stored in browser localStorage); these are "this browser on this device" preferences and deliberately do not follow the store.

## Known host limits (and how they relate to this plugin)

`host.schedule`'s cron fires with `setTimeout(next - now)`, and a Node setTimeout delay above 2^31-1 ms (≈24.8 days) **overflows to
1ms**; the host's `nextCronFire` also returns a sentinel 366 days out when it finds nothing "within a year". The two together give the
infinite loop of "fire 1ms later → schedule the next one" (reproduced on this machine: `TimeoutOverflowWarning` + thousands of fires per
second + a synchronous disk write each time).

That is why this plugin **does not hand far-future cron to the host**: it runs only a once-a-minute sweep (always inside the safe
window) and lets far-future reminders be decided by its own `nextDue`. Other plugins using `host.schedule` hit this pit as soon as they
pass an expression whose next fire is more than 24.8 days out; the fix belongs on the host side (`armCron` in `server/plugins.ts` should
shard overlong delays, and `nextCronFire` should return null instead of a sentinel).

## Troubleshooting

- **No 📓 Notes in the top bar**: the plugin is not installed or activation failed → Settings → UI plugins, check whether it reports an
  error; hidden → restore it in Settings → Interface layout (top-bar entries follow the same rules as other entries).
- **No reminders arrive**: ① is that entry marked "Disabled" in the reminder list; ② is the server up (the small dot at the bottom of
  the floating window: green = online, red = offline); ③ desktop notifications need browser permission by default — if you denied it, change it back in the address-bar permissions.
- **Reminder time is off**: it uses the server's local timezone, not the browser's (`date` to check the server timezone).
- **Dragged the floating window out of sight**: floating window ⚙ → "Reset window position".
- **Want to see logs**: Settings → UI plugins → that plugin's "Logs" (`host.log`'s in-memory ring buffer).

## Development and regression

```bash
npm run build:server && node tests/notes-test.mjs      # protocol E2E: manifest/HTTP/long polling/persistence
npm run build && node tests/notes-ui-test.mjs          # browser E2E: floating window/drag/quick capture/reminder firing
npx vitest run tests/unit/notes-plugin.test.ts         # pure functions + fake host (29 cases: scheduling/interval/mirror/import…)
```

Directory layout:

```
plugins/notes/
├── manifest.json          # capability declarations + top-bar entry (notes:toggle)
├── index.mjs              # server: persistence / persistent scheduling / HTTP routes / AI tools / slash commands
└── client/                # only this subtree is served to the browser (see the static mapping in server/index.ts)
    ├── entry.mjs          # client entry (view:false + preload:true: top-level code builds the floating window, no mount)
    ├── store.mjs          # data model and all pure logic (the server imports this same file)
    ├── cron.mjs           # 5-field cron parsing and "next fire" computation (shared by both sides)
    ├── data.mjs           # HTTP + long-polling data client (shared by the view and the floating window)
    ├── app.mjs            # the UI itself (compact floating-window layout)
    ├── panel.mjs          # draggable floating-window shell (position/size/minimize)
    ├── settings-form.mjs  # settings form (notification toggles/language/import-export, used by the overlay)
    ├── dom.mjs            # minimal DOM builder (el, shared by four modules)
    ├── prefs.mjs          # browser-local preferences (notifications/chime/language)
    ├── i18n.mjs           # Chinese and English strings
    └── styles.mjs         # styles (use host theme variables, following light/dark themes automatically)
```
