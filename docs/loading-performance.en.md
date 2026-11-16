**English** · [简体中文](./loading-performance.md) · [繁體中文](./loading-performance.zh-TW.md)

# Resource and history conversation loading optimizations

## On-demand first-screen loading

`web/src/App.tsx` loads the terminal, Git panel, canvas, settings, model management, file preview, background jobs, global search and the TUI dialog through dynamic imports.

`DeferredMount` does not mount its children before the view is first activated, so it does not trigger the React lazy download. Once activated it stays mounted, reusing the outer hidden container and the view's active attribute, which preserves terminal, canvas and search state. CSS-hiding lazy components is not an option: a hidden mount still triggers the download.

During the code download the TUI buffers ANSI output in order through `tui-overlay-bridge.ts`, capped at 1,048,576 JavaScript characters. A new dialog or a close event clears the buffer; after mounting it asks the server to re-render the whole screen, compensating for output beyond the buffer budget. Live frames keep flowing through the bridge and do not enter React snapshots.

## Transcript repair

The cycle detection in `server/compaction-markers.ts` builds a set of completed paths. Once a later node reaches a completed path it can stop, so a healthy long chain no longer walks back to the root over and over, taking this step from O(N²) to O(N) with O(N) extra space. Other transcript parsing and SDK initialisation costs remain.

The test compares against the old algorithm over all 1,296 four-node parent graphs, verifying identical break positions and statistics; for long chains it bounds the number of Map lookups instead of relying on flaky machine-timing thresholds.

## Build verification

This round compared the original and the modified `App.tsx` in the same workspace under the same Vite config, building into separate directories without overwriting `web/dist`. It counts the entry JS, modulepreload JS and CSS referenced directly by the HTML; each file is gzipped individually and summed.

| Metric                                           |  Original | Optimized |           Change |
| ------------------------------------------------ | --------: | --------: | ---------------: |
| Raw size of HTML first-screen referenced assets  | 3,453 KiB | 2,468 KiB |           -28.5% |
| gzip size of HTML first-screen referenced assets |   950 KiB |   675 KiB |           -28.9% |
| Assets referenced directly by the HTML           |         8 |        11 |               +3 |
| First-screen xterm JS/CSS                        |       yes |        no | loaded on demand |

This is a build asset budget: it does not count plugin runtime requests, fonts and other assets, and it is not end-to-end load time. Splitting shared dependencies adds a few requests, and the terminal, canvas and settings must download their own code on first use. Base Markdown remains a first-screen dependency. The current build still warns about large chunks.

## Round 2: math assets and tool output

The KaTeX renderer and CSS load by content through a separate `math` chunk. Base Markdown and math syntax parsing stay available synchronously; content containing `$`, a backslash, the word `math`, or with rawHtml enabled conservatively triggers the request, and `disableMath` forbids loading and math typesetting. While loading, the base body and the formula source are shown; once loading finishes, a shared subscription notifies mounted messages to restore the formulas. Concurrent requests are merged, failures keep the base body, and there is no automatic retry loop.

Round 2 built with the same config into separate directories: raw first-screen JS/CSS went from 2,468 KiB to 2,185 KiB, gzip from 675 KiB to 593 KiB (about 12% less again); roughly 38% cumulative reduction against the original 950 KiB. The math chunk is not in the initial HTML's preload or stylesheet references. The browser still requests math assets when it meets candidate content, so the budget above represents the initial referenced size when math is not needed.

A standalone Chrome + Vite test entry verified that plain body text and disableMath request no math assets, that the first formula loads asynchronously and restores typesetting, and that scripts and event attributes in rawHtml are still sanitised. Verification used a temporary entry and a separate port and never touched the user's browser or a running service. This verifies behaviour and request timing, not production load seconds.

`server/serialize.ts` no longer joins all tool result text before truncating; it concatenates within a 100,000 UTF-16 code unit budget. Separator, empty-segment, truncation-marker and image-placeholder semantics are unchanged; images after the text limit are still processed. This reduces temporary string allocation for very large outputs and changes neither the full transcript nor the model context.

## Round 3: history list and streaming snapshots

`filterForkedParentSessions` uses reverse parent links and a queue starting from leaf nodes instead of the fixed-point algorithm's repeated whole-graph scans, at O(V+E) complexity. It preserves record order, path normalization, duplicate paths, self-references, pure cycles and array reference semantics. The test compares against the old algorithm over all 4,096 four-node relation graphs in two record orders, and verifies linear growth on long chains by operation counts.

The streaming assistant snapshot used to serialise the full message first and then convert the streaming content again. It now shares the assistant metadata assembly and performs the content conversion once; streaming incomplete-marker cleanup and stable message IDs are kept. A test that counts `toJSON` calls prevents tool arguments from regressing to double conversion.

Repeatable CPU benchmark: `node --import tsx scripts/benchmark-loading.mjs`. The script uses synthetic data only and neither reads user history nor starts a service. Median results from one run on local Node v25.9.0:

| Synthetic scenario                                     | Original algorithm | Optimized |
| ------------------------------------------------------ | -----------------: | --------: |
| 512-node fork chain                                    |           5.661 ms |  1.291 ms |
| 2,048-node fork chain                                  |          71.937 ms |  3.761 ms |
| 8,192-node fork chain                                  |       1,548.894 ms | 14.819 ms |
| 100 conversions of larger streaming assistant messages |          17.837 ms |  9.284 ms |

The fork benchmark's old algorithm reproduces the original fixed-point propagation on a pre-normalized single chain and does not include path normalization cost; the old streaming path converts identical marker-free content twice. The results illustrate algorithmic scaling trends, not full conversation load time; machine and concurrent load affect the numbers.

## Round 4: staged diagnostics for opening history, and branch resolution cache

With `PI_WEB_LOAD_TIMING=1` set and the service restarted, the server console prints `[load-timing]` JSON when a history conversation is opened. Off by default; while off, no clock is read and no stage array is built. It records outcome (loaded/reused/stopped/error), totalMs and stages, where each stage's ms is the delta since the previous mark:

- `resolve-and-ownership`: path resolution, ownership check and the scheduling wait before entering the read.
- `repair` / `sdk-open` / `branch-calibration`: transcript repair, SDK file open and branch calibration.
- `preview`: preview extraction, push and the scheduling wait after the preview. The existing load flow already provides the body preview.
- `runtime-init` / `bind-session`: runtime creation, conversation switch preparation and binding.
- `workspace-and-settings`: synchronous calls such as workspace following and settings.
- `snapshot-send`: server snapshot construction and the synchronous send call, excluding network delivery, client deserialization and painting.

The log contains no session path, ID or body, and persists no extra conversation data. Reuse, interception and failure paths also carry a total time; stages that were never reached do not appear. These are server-side observations and cannot be taken directly as the time from click to visible body text.

`findBranchCandidates` caches timestamp parsing per node object within a single call, so multiple leaves do not re-parse shared ancestors. In a test with a 600-level shared chain and 80 leaves, Date.parse calls for candidate generation and leaf selection each dropped from 48,160 to 680 (about -98.6%). The cache is not kept across calls, so a modified node is still read again on the next analysis. Path traversal, statistics and the output of all pathIds still grow with the sum of branch depths; the algorithm as a whole was not made linear.

Next, these logs should be combined with browser performance records to measure cold start, cache hits, opening a history conversation and switching between already-open conversations separately; no end-to-end second-level gain is claimed here, and the conversation preview protocol was not changed.

## Round 5: left panel rendering and session list scanning

- **The left panel no longer re-renders with streaming tokens**: `LeftPanel` is a `memo` component, but App passed an inline `onOpenSandboxModal` arrow function, so every `message_delta` re-reconciled the whole project tree. Now a `useCallback`; `transition` passes only the stable subset `kind/target/progress`, so preview message and other field changes no longer reach the left panel.
- **Project tree data model memoized**: per-project running-conversation filtering, history conversation ownership and unread counts moved out of JSX IIFEs into `projectTreeModel` (`useMemo`). Running conversations are bucketed per project in one pass; "has subagents" uses a set of parent ids; "already persisted" uses a lazily built sessionId set instead of a nested `some` at O(conversations×sessions). `isSessionMatchingProject` caches regexes and normalized results per project instead of `new RegExp` per session.
- **Switching projects costs one whole-table request less**: clicking a project header sends only `set_cwd`, and the server's `refreshSessionsOnSwitch` pushes the list; the `list_sessions` issued when expanding a project moved out of the state updater (under StrictMode the updater runs twice).
- **Dangling tool-call repair gains a health fingerprint cache**: `healDanglingToolCallFile` synchronously read the whole file and `JSON.parse`-d it line by line on every history open, with no cache before; like `repairSessionFile` it now remembers healthy files by `mtimeMs:size` and skips the disk read when nothing changed.
- **List mode stops parsing early**: `loadSessionInfos(cwd, { listOnly: true })` parses newest→oldest by mtime and stops once it has 260 sessions for this project (the left panel shows 200, the headroom absorbs fork parent filtering); cache hits are included as usual. Cold list cost drops from "all transcript bytes in the project" to "the newest ~260 files". Cache entries carry a `complete` flag, so full-text search, lookup by id and other calls that need the full set never reuse an incomplete cache. The per-file metadata LRU went from 512 to 2048, so expanding several projects back and forth no longer evicts them from each other and triggers repeated full re-parsing.
- **Leaner list pushes**: `SessionSummary.firstMessage` / `displayName` are truncated to 300 characters (the first message is often a large paste, previously ×200 rows ×2 copies on every push). Full-text search goes through `search_sessions` and is unaffected.

Tests: `tests/unit/dangling-tools.test.ts` (health cache hits and re-checks after the file changes), `tests/unit/session-cache-bounds.test.ts` (list mode stops early, full-set requests do not reuse incomplete caches).

## Round 6: preprocessing when opening a history conversation, and running-conversation slots

### Preprocessing merged into a single async disk read

`prepareTranscriptForOpen` in `server/transcript-prepare.ts` replaces the old two-stage synchronous "chain repair + dangling call repair" flow:

- Both health fingerprints (`mtimeMs:size`) hit: no disk read.
- Otherwise `fs.promises.readFile` reads once and both checks share the text; after the repair both fingerprints are refreshed from the final file state (once the dangling repair has appended its synthesized result, the next open still hits).
- The dangling check became on-demand parsing (`healDanglingToolCallsInText`): first take only each line's id/parentId (long lines are scanned at the line start only, and only before the first nested `{`), walk back from the tail along parentId, and fully parse only the traversed lines and the lines after the tail assistant. `lastId` is confirmed by fully parsing from the tail line by line, so a half-written trailing line left by a crash is not misidentified.
- Semantics match the old flow: when chain repair rewrites the file, no dangling repair runs this time; on 400 random transcripts (branches, aborted/error, long lines, half-written trailing lines) results are identical to the old full algorithm field by field (`tests/unit/transcript-prepare.test.ts`).

Synthetic transcript benchmark (`node --import tsx scripts/benchmark-transcript-open.mjs <MB>`, local Node v26.13.0, median of 7 runs):

| Scenario                                           |   10 MB |    50 MB |
| -------------------------------------------------- | ------: | -------: |
| Dangling check: old, full per-line parse           | 24.7 ms | 218.2 ms |
| Dangling check: on-demand parse                    |  7.8 ms |  62.9 ms |
| Open preprocessing: old, two sync reads (uncached) | 71.2 ms | 514.5 ms |
| Open preprocessing: new, fingerprint miss          | 51.5 ms | 360.9 ms |
| Open preprocessing: new, fingerprint hit           | 0.28 ms |  0.27 ms |

In the upstream flow chain repair had a fingerprint cache but the dangling check did not, so "open the same unchanged large transcript again" still meant a synchronous full read + per-line parse (about 30 ms at 10 MB, about 250 ms at 50 MB, blocking every client meanwhile); it is now about 0.3 ms. The remaining cold-path cost is mostly the CPU work in `repairSessionTranscript`; SDK `SessionManager.open` still reads synchronously once more (to be evaluated whether parsed entries can be passed in).

### Running-conversation slots: collapse view-only history conversations by LRU

- Conversations opened from history are marked `viewOnly`; sending a message in one (starting delivery / retrying) clears it.
- When opening a history conversation, the slot pre-check moved **before** building the agent runtime: previously hitting the limit built the full runtime (extensions, skills, MCP) and then disposed it, wasting time for nothing.
- On overflow, `viewOnly` conversations are collapsed oldest→newest by `lastActiveAt` (never the current conversation, pinned ones, streaming/compacting/delivering ones, ones with a terminal in use, live subagents, background runs/wake subscriptions/background jobs); only if that still frees nothing is the request refused. Collapsing names the specific conversation; the transcript is on disk and can be reopened from history. New conversations go through the same logic.
- When the current conversation is about to be switched away and released (`wouldDisplaceActive`, sharing the `isRetainedOnDisplace` decision with `displaceActive`) it counts as one slot; that decision is only evaluated when the limit is actually exceeded (it involves disk probing).

Tests: `tests/unit/open-conversation-lru.test.ts`.

## Round 7: preview→snapshot no longer remounts the message list

When a history session is opened the browser first receives 16 preview messages, then the first snapshot once the runtime is built. The two steps used different `MessageList` keys (`transition.target` → `conversationId`), so the whole column unmounted and remounted: scroll position, measured heights and windowing state were all lost, the tail Markdown rendered twice, and one flash was visible to the eye. And even with the same key, preview message ids (`seq = offset + i`) did not match the snapshot's (per-conversation counter), so React still remounted those nodes.

- **Server: previews use the same ids as snapshots.** `previewWithSnapshotIds` applies `withHistoricalCompactions` (shared with `messagesOf`) to `buildSessionContext().messages` (which is exactly what the SDK uses to initialise `agent.state.messages`), goes through the same `uiMessageKey` and serialises only the tail. User message seq is computed exactly over the whole sequence. After the conversation is built, `seedConversationIds` writes `msgIds/nextMsgId` and the serialized tail into the conversation, so the first snapshot hits the cache directly and the tail is no longer serialized again. `msgIds` maps by content key, so messages an extension appends at bind time do not change existing ids. When the manager does not support `buildSessionContext`, it falls back to the old preview and sends no seed.
- **Protocol:** `transition_progress` gains the optional `conversationId` / `sessionFile` (a pre-allocated conversation id, sent only when the id matches), `PROTOCOL_VERSION` 43 → 44.
- **Client:** the preview state uses the pre-allocated id as both key and `conversationId`, identical to the snapshot, so the same `MessageList` instance receives the snapshot in place. `MessageList` detects the handover with render-derived state (StrictMode-safe): it pre-seeds placeholders for earlier messages following the session's first-frame semantics and resets the pagination window (the tail already shown in the preview stays visible), and messages already mounted in the preview are not treated as placeholders during the handover — the following sweep decides by measured height. On an in-place reset the managed element table now "drops only ids that no longer exist" instead of clearing wholesale (stable ref callbacks would not re-register nodes kept in place).

Tests: `tests/unit/preview-snapshot-ids.test.ts` (preview ids match the snapshot, seeding changes no id, user messages with identical timestamps, historical compaction cards, system messages, fallback path); `tests/unit/message-list-preview-handoff.test.ts` (jsdom: the 16 tail messages unmount zero times across the handover, DOM nodes are the same instances, earlier messages are not fully mounted; the control group with a changed key remounts the whole column).

End-to-end verification on a large conversation in a real browser is still pending (scroll position and lagging heights for images and code highlighting) and needs manual confirmation.

## Round 8: left panel interaction polish

- **Project ordering**: every load (page refresh) sorts projects newest→oldest by last used (`lastUsed`); the order stays stable while the page is open (switching workspaces does not make it jump), and projects that appear during the session are appended at the end. Project headers can be dragged, or Alt+↑/↓ on a project header reorders within this session. The old `pi-web-ui:projects-order` persisted ordering is gone (leftover keys are cleaned up on load).
- **Project cap**: recent projects went from 30 to 100 (`RECENT_PROJECTS_MAX`, shared by recording, merged reads and pushes; the DSH engine follows).
- **Recent project discovery**: on cold start `pushProjects` first waits for the existing lightweight session-header discovery, then reads the persisted list, so workspaces that exist only in history conversations appear in the first push as well. The scan is single-flighted and reuses the discovery cache for 60 seconds; after it expires a background renewal runs while hot requests still read the current persisted list, keeping new projects and deletion tombstones. Regression: `tests/left-panel-delete-test.mjs`.
- **Migrating historical recent projects**: cleaning up old per-client records must not lose their projects. On first load `ClientStateStore.load()` first collects the tombstones of all clients, then deduplicates global and old per-client projects by `normalizePathKey`, keeps the latest `lastUsed`, filters every tombstone, truncates descending to `RECENT_PROJECTS_MAX`, and finally cleans up dead clients and saves everything together. Even if an old client is past its 30-day retention period or over the count cap, its projects survive restarts; `remember()` later writes the global list as well, periodic cleanup keeps the original deadline, and no disk history scan is needed each time. Regression: `tests/unit/client-state-cleanup.test.ts`, `tests/unit/client-state-recent-projects.test.ts` (expired-client migration and restart, tombstones do not come back, deduplication ordering and the cap).
- **Filter box**: at the top of the project area, filters project name / path / loaded conversation titles; project-name hits show as usual, otherwise only matching conversations are shown and expanded; Esc clears, ↓ enters the list. Projects whose session list is not loaded (not expanded and no cache) can only match by project name; full-text search still goes through global search.
- **Keyboard and accessibility**: `role="tree"` / `treeitem` + `aria-expanded` / `aria-current`; ↑/↓ moves between rows, Home/End, →/← expand/collapse, ← on a conversation row returns to the project header. While renaming, the row body renders as a div (the input is no longer nested inside a button); 「显示更多」(Show more) and 「已收起 N 条历史」(N history items collapsed) became buttons; row actions that were visible on hover only now also show on keyboard focus and have a `:focus-visible` outline.
- **Rename**: commits on blur (blur used to discard the input); the new name shows optimistically right after the commit and the override is dropped once the server list reflects it (10s fallback expiry); the blur triggered by unmounting after Enter does not commit twice, and Esc cancels without committing.
- **i18n**: hardcoded Chinese in the left panel (show more, collapsed, branch / schedule / WeChat / Feishu / DingTalk badges, the open-on-desktop hint) moved into the dictionary and filled in for all 12 language packs; the title-categorisation logic duplicated in three places merged into `categorizeTitle`.
- **Running list pushes**: `emitConversations` changed the per-conversation `existsSync + statSync` into one `statSync` cached per file for 2s (staying synchronous, so message ordering relative to snapshots is unchanged).

Tests: `tests/unit/left-panel-stage-d.test.ts` (ordering / drag / Alt+arrow keys, filtering, keyboard navigation, tree semantics, rename commit on blur and deduplication).

## Round 9: session list scanning (byte level + incremental) and the streaming filter

### List metadata: `server/session-list-scan.ts`

`scanSessionListInfo` replaces the list-mode implementation of `parseSessionInfoFast` (list mode now delegates to it directly; full-text mode is unchanged):

- Reads by bytes and splits lines on newline bytes; once the id and the first user message are known, long lines (> 512 bytes, not containing `"session_info"`) are not decoded into strings — only the line start is inspected to decide it is a message and `Buffer.indexOf` finds the first numeric `"timestamp"`, with the same rules as the old implementation.
- Lines that need full parsing and exceed 64K characters have the embedded `"data":"…"` (base64 images) stripped before `JSON.parse`.
- **Incremental**: the state records the byte offset after the last complete line, plus fingerprints at the first 128 bytes of the file and the 64 bytes before the offset. `loadSessionInfos` stores the state in the per-file metadata cache; when the file's mtime/size change it resumes scanning with the state, and parses only the added bytes if both fingerprints are unchanged, otherwise it rescans the whole file (chain repair rewriting, truncation, etc.). A trailing half-written line counts toward this result but does not advance the offset.
- Equivalence: on 300 random transcripts (long lines, base64 images, renames, bad lines, CRLF, trailing half-lines) results are identical to the old implementation field by field (`tests/unit/session-list-scan.test.ts`, including incremental / rewrite / truncation / half-line cases).

Synthetic transcript benchmark (`node --import tsx scripts/benchmark-session-list.mjs <MB>`, local Node v26.13.0, median of 5 runs):

| Scenario                                                 |    10 MB |      50 MB |
| -------------------------------------------------------- | -------: | ---------: |
| Old implementation (per-character filter + string lines) | 259.6 ms | 1,328.8 ms |
| Byte-level full scan                                     |  44.0 ms |   208.7 ms |
| Incremental resume after appending one turn              |  1.58 ms |    1.88 ms |

An active session makes the list refresh rescan it after every turn; that step used to grow linearly with transcript size and is now independent of existing length.

### Streaming filter: `BinaryStringFilter`

The base64-stripping filter inside `sessionLines` (full-text search and others still go through it) was a per-character state machine (one array push per character, one regex per character outside strings). It now jumps with regexes: inside a string it jumps to the next quote / escape / newline, outside a string to the next non-whitespace character, and plain characters are sliced out as a run; state transitions are unchanged. On 2,000 random JSONL texts with random chunking (including splits inside escape sequences, quotes and surrogate pairs) the output is byte-identical to the old implementation (`tests/unit/session-scan-filter.test.ts`). Filtering 10 MB of text: 391.0 ms → 95.2 ms.

## Round 10: opening a conversation no longer blocks the event loop; server-side session list paging

### Async time-sliced open (`server/session-open.ts`)

`SessionManager.open` inside `switchSession` (synchronous readSync of the whole transcript + synchronous per-line JSON.parse) became `openSessionManagerAsync`: `fs.promises.readFile` reads asynchronously, the per-line parse yields to the event loop about every 8 ms, and the parsed entries are then handed to the SDK constructor. The SDK itself also takes this `preloadedFileEntries` construction path when the header is very large.

- Semantics aligned with SDK `loadEntriesFromFile`: blank and bad lines are skipped and only truthy entries are kept; the first entry must be a session header with a string id, otherwise it hands back to the SDK's original path (empty-file initialisation, non-pi session error); when the file lacks a trailing newline, `"\n"` is appended before construction.
- The SDK constructor is private by type: it is called by its runtime signature, and after construction the session file, session id and entry count are verified; any mismatch or throw falls back to `SessionManager.open`. `PI_WEB_ASYNC_SESSION_OPEN=0` forces the original path. Verified that the bundled SDK 1.1.0 and the local global 1.5.0 have the same signature, both taking the pre-parse path (0 fallbacks), with results identical to `SessionManager.open` (entries, leaves, branches, file side effects).
- Synthetic 50 MB transcript (`node --import tsx scripts/benchmark-session-open.mjs 50`, median of 3 runs):

|                           | Total time | Longest event loop stall |
| ------------------------- | ---------: | -----------------------: |
| `SessionManager.open`     |     192 ms |                   192 ms |
| `openSessionManagerAsync` |     239 ms |                    21 ms |

Total CPU rises slightly, but while a large conversation is opening, other clients' streaming output, heartbeats and operations are no longer blocked.

### Session list paging (B5)

- Protocol (all optional and backward compatible; this batch bumped to v44): `list_sessions` gains `limit` (the total number of rows wanted), `sessions` gains `hasMore`.
- The server remembers `limit` per project (`setSessionListLimit`, clamped to [`SESSION_LIST_MIN = 20`, `SESSION_LIST_MAX = 5000`]), and the automatic refresh after each turn follows it, so an expanded list never shrinks back. `loadSessionInfos` list mode stops parsing early at `SESSION_LIST_PARSE_LIMIT + (limit - SESSION_LIST_DEFAULT)`: the default basis is still 260 files, while a first screen of only 20 rows needs just 80 scanned. The cache records how many rows this list was parsed for (`parsedFor`) and is not reused when the requirement is larger. `hasMore` = more summaries than limit, or parsing stopped early (older files left unparsed).
- Client: the reducer records `projectSessionsHasMore` per project. When the local headroom is used up and the server has more, 「显示更多」 requests the next page's limit and the button shows a loading state. Each project renders only `SESSION_ROWS_DEFAULT = 5` history conversations by default, and every click on 「显示更多」adds `SESSION_ROWS_STEP = 10`; the expanded count lives only in this page's memory (the old `pi-web-ui:lp-visible-counts` persistence is gone and cleared on load), so refreshing the page always returns to 5 rows and never restores the dozens or hundreds expanded last time.
- The first-screen request is `SESSION_LIST_FIRST_PAGE = 20` (= the server minimum), asking for more than the 5 rows rendered as local headroom: the next 「显示更多」 does not need another network + disk scan round. When a project expanded to many rows remounts, the request follows the current expanded count (`visible + 10`), so the list never shrinks.

Tests: `tests/unit/session-open-async.test.ts` (item-by-item identical to `SessionManager.open`, the pre-parse path does not fall back, further appends still work, invalid / empty files fall back, the switch, yielding to the event loop during parsing); `tests/unit/session-list-paging.test.ts` (paging, hasMore, limit remembering and clamping (including the minimum), reducer); `tests/unit/left-panel-stage-d.test.ts` gained B5 cases (paging against the server and the loading state, local headroom sends no request, refresh does not inherit the old row count).

### Session list disk index (`server/session-list-index.ts`)

The list needs the "newest N" per project, and the old implementation could only scan the newest 260 `.jsonl` files in full. Measured on the local pi-web-ui project (1,883 session files / 1.5 GB, newest 260 at 275 MB): cold start readdir + stat 29 ms, scan 463 ms, while only the first few screens are ever displayed.

- The index persists "file mtime + size + scan state" to `<dataDir>/cache/session-list-index/<sha1(project dir)>.json`, and a hit skips the whole file scan. Validity uses the same ruler as the in-memory cache: **accepted only when both mtime and size are unchanged** (rename / compaction / rewrite all change the two).
- Pure cache: deleting it, corrupting it or failing to write it only means a rescan next time and never affects conversation data; without `dataDir` (no state storage) the whole thing switches itself off.
- What it stores is `SessionListScanState`, so it doubles as the incremental resume offset: after a restart a large conversation that grew continues from the previous offset (`previousScan`), and when the signature does not match `scanSessionListInfo` falls back to a full scan on its own.
- Per-project cap of 3000 rows / 4 MiB (above that only the newest 1000 are kept), disk writes debounced by 500 ms and atomically replaced; after a full enumeration entries are pruned against the files that actually exist (an incomplete enumeration only skips pruning rather than deleting by mistake); index files for projects not opened for over 30 days are cleared once at startup (at most 20 each time).
- List summaries build only `limit + 1` rows (`infos` may be project-wide after an index hit), instead of building all thousands and then slicing.

Measured (same directory, first request of 20 rows / 80 files parsed):

| Scenario                            | readdir + stat |   Scan |  Total |
| ----------------------------------- | -------------: | -----: | -----: |
| Old basis (parse newest 260)        |          25 ms | 463 ms | 488 ms |
| First screen of 20 rows (80 parsed) |          29 ms | 161 ms | 190 ms |
| Disk index hit after restart        |          20 ms |   4 ms |  24 ms |

Tests: `tests/unit/session-list-index.test.ts` (no parsing after a restart from disk: content swapped but mtime + size unchanged still yields the original metadata; only a changed file triggers a rescan; incremental resume fills in the row count; deleted files disappear from entries; nothing is written without a dataDir).
