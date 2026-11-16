**English** · [简体中文](./development.md) · [繁體中文](./development.zh-TW.md)

# Development workflow

## Official providers

Regular installs and the portable build share the model management quick-config entry for official APIs. For protocols, endpoints, regions and maintenance boundaries, see [Official provider integration](official-providers.en.md).

## Prompt template commands

The template editor can set an optional command (for example `/pr`), with `{{input}}` in the body marking where arguments are inserted. Sending `/pr 798` makes the input box replace every placeholder with `798` before sending; with no placeholder, the arguments are appended to the end of the body. Multi-line arguments are supported and not expanded recursively; existing system, extension, skill and plugin commands take priority, and a template command of the same name does not take them over.

Custom templates, built-in overrides and removal markers are stored server-side in `<dataDir>/prompt-templates.json`, read and modified entry by entry over the authenticated `/api/prompt-templates`, and the UI updates only after the atomic commit succeeds. The list refreshes when the browser window regains focus. Old `localStorage` templates migrate automatically, server entries with the same ID win, and the old browser data is deleted after a successful migration; on failure it is kept and the error shown.

## Context usage breakdown

The context badges in the top bar, bottom bar and sidebar all expand a breakdown on click, showing the used ratio, per-category usage bars and remaining space. Click again, click outside or press Esc to close; scrolling only updates the position, while switching conversation or engine closes the panel. The panel is positioned by `useFloatingPanel` and portaled to `body`, and adapts to light, dark and narrow screens.

The pi engine provides category estimates in `stats.contextUsage.categories`: system prompt, memory files, tools, skills, tool calls and results, messages, other. Base overhead follows the settings panel's actual templates, overrides, disabled items and tool schema; messages are estimated against the current model context and do not read the browser's paginated transcript. Categories update with the 250ms stats cache and are allocated integer tokens against the authoritative total usage, with the difference going into "other", without changing the existing total or the compaction decision. The categories are a session-content estimate, not the actual request categories returned by the provider; exact deduplication, evidence externalization and extension transformation in the request view can shift the proportions, and calibrating against the total cannot turn the categories into precise billing data. The message cache only reuses the stable prefix before the last message; the last one must be re-estimated after the SDK asynchronously replaces the extension. Engines that only expose a total show used and remaining space. With a soft cap configured, the panel and the badge use the same denominator and additionally list the soft cap and model capacity.

## Common commands

```bash
npm run dev          # parallel: node --watch --import tsx backend (:8788, dev:server script, cross-env pins PI_WEB_PORT=8788,
#                      avoiding the global pi-web-ui default :8787) + vite frontend (:5173, proxies /ws to :8788).
#                      note: do not start the backend with `tsx watch` — on Windows with piped stdio (concurrently's spawn style)
#                      it hangs silently (upstream tsx bug); use Node's native --watch instead.
npm run dev:totp     # local TOTP test site (http://127.0.0.1:8791, exercises scan / auto-match / code fill for the built-in browser "TOTP authenticator", see "TOTP test site" below)
npm run typecheck    # tsc --noEmit on both sides (mandatory before commit)
npm run check:protocol  # guards the protocol single-source shim mechanism (CI runs it)
npm run ci:local     # replicates the CI gates locally step by step per ci.yml (see "Reproduce CI locally" below; --profile static takes seconds)
npm run hooks:install # installs the pre-push hook (runs the static ci:local profile by default)
npm run format       # prettier across the repo (.prettierrc.json: tabs + width 120; mandatory before commit)
npm run format:check # check only, no writes (what CI runs)
npm run build        # build:web (vite) + build:server (tsc) + build:dsh-runtime + build:mermaid-vendor + build:runtrace-vendor
npm start            # runs the compiled output dist/server/index.js (production)
npm test             # Vitest fast pool (pool split see "Two pools" below, ≈180s)
npm run test:changed # dev loop: only files affected by Git changes (seconds to tens of seconds for leaf modules)
npm run test:integration # heavy integration pool: real git / real child processes / real Hub (≈170s)
npm run test:all     # both pools (the full pre-commit/CI gate)
npm run test:smoke   # zero-token protocol smoke aggregator (tests/run-smoke.mjs, 82 self-contained tests; --core runs only the PR fast subset; --no-build skips the build before the suites)
npm run test:freeze  # freeze/reconnect regression tests (Playwright, needs local headless chromium)
```

Electron-related dependencies (the `electron` / `electron-builder` binaries) go through npmmirror: the packaging commands (`desktop:dist`, `desktop:portable*`) already have `ELECTRON_MIRROR` / `ELECTRON_BUILDER_BINARIES_MIRROR` injected by `scripts/run-electron-builder.mjs` (defaults in `scripts/lib/electron-mirror.mjs`). These mirrors are **forbidden** in `.npmrc` — npm 11 warns about custom keys and npm 12 stops passing them through. The first `npm install` downloads the Electron binary; on networks in China, bring your own `ELECTRON_MIRROR` environment variable first.

## Updating the local desktop app (macOS)

After changing browser/server code, to make `/Applications/pi-web-ui-desktop.app` use the new build:

```bash
npm run build && npm run build:desktop
node scripts/run-electron-builder.mjs -c desktop/electron-builder.yml --dir   # only emits release/mac-arm64/*.app
node scripts/update-local-app.mjs --dry-run   # health check: artifact present, installed copy identical
node scripts/update-local-app.mjs            # quit app → back up → replace → reopen
```

- `--dir` is enough for the install bundle; no need for `desktop:dist` (that additionally builds dmg + zip and starts at several minutes).
- The script is idempotent: if the installed bundle matches the artifact fingerprint it exits immediately; it also exits when there is a lock or another instance running.
- Only one backup is kept (`/tmp/pi-web-ui-desktop.app.bak`), and a failed replacement rolls back automatically; logs append to `/tmp/pi-app-update.log`.
- **Do not** attach it to `launchctl`/a daemon: launchd restarts it after the script exits, producing an infinite "quit app → replace → reopen" loop (hit for real). To defer, use `--delay 30` or `nohup … &`, and do not truncate the log with `>`.
- The session server runs inside the app (the `:8790` child process), so replacing interrupts the running conversation; history is already on disk and continues after reopening.

## Command execution hang protection

Two entry points with non-overlapping responsibilities:

| Scenario                                                    | Which one                                             | Why                                                                                                                                                                                                                                                 |
| ----------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Long-lived services inside the product (any user project)   | `bash({ background: true })` (`server/job-runner.ts`) | The process lives inside the server; the prompt returns a job id + log path immediately, and the top bar「后台任务」(Background tasks) panel lets you watch and stop it; no dependency on `scripts/`, so npm / desktop installs work out of the box |
| One-off commands in the source repo / CI / a human terminal | `scripts/safe-exec.mjs`                               | The caller is not long-lived; the `--detach` daemon plus the three jobfile pieces (`.pid`/`.state.json`/`.cursor`) take over                                                                                                                        |

The timeout semantics of `background: true` are **deliberately different** from the foreground (`server/bash-timeout.ts` normalizes two paths): foreground defaults to 120s with a 3600s ceiling; background defaults to / passes 0 = **unlimited**, and only an explicit positive number starts the clock (7-day ceiling, only to catch slips). So starting a service like FastAPI won't be killed by the "default 120s". Logs go to `<dataDir>/jobs/<id>-<slug>.log`; when the task ends (normal exit / timeout / idle / stopped / failed to start) a notification fires, plus a system message when it has a conversation owner.

`scripts/safe-exec.mjs` is a cross-platform (Windows / macOS / Linux) command executor shared by AI, CI and human terminals. It fixes five classes of hang: child **stdin wired to the null device** (interactive confirmations, pagers, REPLs all read EOF), **hard timeout + idle timeout** (N consecutive seconds with no output means a silent hang), **killing the whole process tree** (`killPidTree` in `server/process-utils.ts` as the single source of truth: `taskkill /T /F` on Win, `kill(-pgid)` on Posix), **raw output written to disk first with only the tail echoed**, **cross-platform polling** (`--wait` times inside Node, no stringing together `sleep` / `&&` / `$?`).

```bash
node scripts/safe-exec.mjs --timeout 60 -- npx vitest run tests/unit/foo.test.ts   # short tasks: unit tests/lint/typecheck
node scripts/safe-exec.mjs --timeout 600 --log .safe-exec/build.log -- npm run build # long builds: always with --log
node scripts/safe-exec.mjs --detach --timeout 1800 --idle-timeout 300 -- npm run build # >3 minutes: supervised, returns immediately
node scripts/safe-exec.mjs --wait .safe-exec/20260101T000000-npm-run-build.pid --wait-sec 10 --json  # poll
node scripts/safe-exec.mjs --status .safe-exec/20260101T000000-npm-run-build.pid --json              # check immediately
node scripts/safe-exec.mjs --kill .safe-exec/20260101T000000-npm-run-build.pid                      # terminate
```

`--detach` starts a **detached daemon** (internal mode `--supervise`): it checks idle duration and total duration every second and kills hard, **without relying on the AI to poll** — if the AI crashes or the terminal closes, it still cleans up on time. The parent process writes the job spec and exits, **never holding the log handle** (on Windows that step is exactly what caused `EBUSY` and a hung exit). The three job pieces: `.pid` (spec, written once), `.state.json` (state/terminal state), `.cursor` (incremental cursor, so `--wait` returns only new output).

State machine: `RUNNING` / `SUCCESS` / `FAILED` / `TIMEOUT` / `IDLE_TIMEOUT` / `KILLED` / `ENOENT` / `ABORTED` (the daemon was killed externally, or the child is still alive after the watchdog's 8s grace → the terminal state can also be `ABORTED`; `--kill` first, then rerun) / `UNKNOWN`. `--json` outputs `status` / `exitCode` / `reason` / `elapsedSec` / `idleSec` / `childAlive` / `terminal` / `orphanAlive` / `pipesForced` / `newOutput` / `next` (`next` is the next command you should run).

`--status` is a **read-only observer** (computes deltas only, does not advance `.cursor`), while `--wait` is the consumer (advances the cursor): the former can be called repeatedly at will and won't steal output from the main loop. When the child has exited but a grandchild still holds the output pipe, `--wait` first waits 1.5s to drain, then forcibly tears down the pipe and settles on its own, marking `pipesForced: true` (the old implementation waited until the hard timeout).

Exit code contract: `0` success, `124` hard timeout or idle timeout (**do not retry as-is**; read the log to find the sticking point, then adjust the tier), `127` command not found, `2` usage error, everything else passes through the real exit code. Logs default to `.safe-exec/` (gitignored) and `--log` overrides; `--stream` echoes output live to the terminal (for humans), while the default only writes to disk + the last 40 lines. `--idle-timeout` is off by default: builds/type checks can legitimately stay quiet for a long time, so enable it only for tasks where "normal operation must produce heartbeat output".

`--kill` first kills the child process tree (Posix `-pid` only works on a process group leader), then reaps the daemon; only when the child PID hasn't been published yet does it degrade to killing the daemon alone with an explicit warning. Tasks in `ABORTED` whose child is still alive are not treated as "finished" and skipped; `--kill` continues the cleanup and rewrites the terminal state to `KILLED`.

On Windows `npx` / `npm` / `pnpm` / `yarn` are `.cmd` shims, and a direct `spawn` yields ENOENT: the executor resolves via `PATHEXT` and only reroutes through cmd.exe when it hits `.cmd` / `.bat` (relative paths are automatically restored to backslash absolute paths); all other commands stay on a direct spawn without a shell.

Time tiers: unit tests/lint/typecheck 60 seconds, full builds 600 seconds, anything expected to exceed 3 minutes always goes through `--detach`. A single AI bash call additionally has the pi tool-layer `timeout` parameter and the session watchdog as backstops; the three don't overlap and don't replace each other.

**Stop hand-writing `timeout 60s` / `nohup ... &` / `ps -p` / `sleep 5` prefixes**: on Windows `timeout` is `timeout.exe` ("wait N seconds for a keypress" — the opposite semantics), and `nohup`, `ps -p`, `sleep` have different syntax in cmd / PowerShell / bash; the null device isn't one name either (`/dev/null` vs `NUL`), and `$?` ternary syntax is equally non-portable. Cross-platform behavior can only be unified by the Node wrapper: wait with `--wait`, check state with `--status --json`, terminate with `--kill`.

`--shell` is only for commands that must be handed to a shell as a whole line (`--shell "<whole command line>"`, plus `--shell-bin` when needed). `--shell-bin auto` prefers a real Git Bash on Windows (`C:\Program Files\Git\bin\bash.exe`) and `bash -c` on Unix-likes, so POSIX paths like `cd /e/pi-web-ui && ...` aren't read as the wrong drive by `cmd.exe`; the interpreter can also be `powershell` / `pwsh` (via `-NoProfile -NonInteractive -Command`).

## CI

GitHub Actions ubuntu-latest (`.github/workflows/ci.yml`, triggered by push/PR → main) is split into four parallel jobs:

| job           | Content                                                                                                                              | Notes                                                                                                                                                                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checks`      | `format:check → lint → check:protocol → i18n:check → typecheck → build → plugin bundle unchanged → build:extension → pack:extension` | All second-scale steps, combined into one job to avoid reinstalling dependencies repeatedly                                                                                                                       |
| `unit`        | `vitest run --shard=i/8` (i=1..8)                                                                                                    | 1047 unit test files / 12000+ cases; 6.5 minutes on one machine, the bottleneck of the whole pipeline, and sharding takes wall clock to about 1/8; `fail-fast: false`, one red shard doesn't take the others down |
| `integration` | `npm run test:integration`                                                                                                           | The heavy pool (real git / real child processes / real Hub) is simply more stable run serially                                                                                                                    |
| `smoke`       | `node tests/run-smoke.mjs`                                                                                                           | PRs run `--core`, pushes to main run the full set; logic unchanged                                                                                                                                                |

`unit` and `integration` each run `npm run build:server` (the byte-for-byte comparison in `tests/unit/atomic-file-generated.test.ts` needs dist present). `unit` also installs mobile dependencies (`npm --prefix mobile ci`): the `mobile-connections` / `mobile-push-controller` / `mobile-app` cases import `mobile/src/*`, and without `@capacitor/core` and `@pi-mobile/native-local-engine` they fail outright with `Cannot find package`. The fork count is no longer hard-coded to 8: `FAST_MAX_WORKERS` in `tests/lib/suite-partition.mjs` clamps to the actual core count (`min(8, cores)`) — GitHub runners only have 4 vCPUs, and 8 forks fighting over 4 cores yield a parallelism factor of only 1.66×. The shard count is 8 rather than 4: each job has ~50s of fixed overhead (dependency install + `build:server`), and with 4 shards the unit test wall clock is ~110s plus ~50s overhead; 8 shards push unit tests to ~55s, and beyond that you only amortize the fixed overhead. Browser test budgets all go through `BROWSER_TEST_TIMEOUT_MS` in `tests/lib/chrome.mjs` (60s, aligned with `testTimeout` in `vitest.config.ts`): on a 4-vCPU runner four forks cold-start Chrome at once, so a hard-coded 20s produces false red.

A new push to the same branch cancels the previous run's checks (`concurrency` + `cancel-in-progress`, only effective on PRs), so consecutive pushes no longer queue stale commits.

The smoke list (ALL in tests/run-smoke.mjs, 82 entries) only accepts **self-contained, zero-token, cross-platform** tests; attach-type scripts (needing an external server), scripts needing a real model and platform-specific scripts stay out of CI and are run locally by hand (classification is in the header comment of run-smoke.mjs).

Smoke tiers (CI speedup): PRs run the `--core` fast subset (CORE, representatives of protocol/security/plugin wiring, 2–4 minutes); push to main plus the daily nightly (Beijing time midnight) run the full set; `--retry-once` reruns first-round failures once (marked FLAKY, and only a repeat failure counts as a real failure). New tests go into ALL by default; only fast (<20s) and stable ones get promoted to CORE (there is an ALL↔CORE sync guard).

`dist/` is built **once, serially** by the runner before the run starts (CI has already built it in the Build step, so `--no-build` skips it). Test cases always go through `tests/lib/ensure-build.mjs`; **do not** call `execSync("npm run build")` yourself: under the default 4 parallel workers, one case rewriting `dist/` while another is `spawn`ing `dist/server/index.js` produces false red like "the test plugin was not activated" that has nothing to do with the logic under test.

### Reproduce CI locally (`npm run ci:local`)

Local green ≠ remote green, and most of the time it isn't environment voodoo but **the local run simply not running what CI runs** (of the 6 main reds in 2026-11, 4 hung on `Protocol smoke tests (full)` — not run on PRs, not run locally, only discoverable on main). `npm run ci:local` replicates the steps and order of `.github/workflows/ci.yml` one by one, each step through `scripts/safe-exec.mjs` (hard timeout + process tree kill), with logs in `.safe-exec/`:

| Profile                               | Coverage                                                                                               | Scale   |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------- |
| `--profile static` (pre-push default) | format:check → lint → check:protocol → i18n:check → typecheck (incl. mobile)                           | 1–3 min |
| `--profile pr`                        | static + build + plugin bundle rebuild diff + extension packaging + both vitest pools + smoke `--core` | ≈10 min |
| `--profile full` (default profile)    | all of the above + full smoke (the step only push to main runs)                                        | ≈16 min |

`--only <id>` / `--from <id>` resume from a breakpoint, `--list` shows steps and ids, `--install` runs `npm ci` first (reinstalls node_modules, slow).

Before starting it prints the "known local ≠ CI deviations": Node major version (CI uses 22), non-Linux platform (case-sensitive imports / permissions / PTY), dirty workspace (CI only sees committed content), changed `web/src/i18n/messages/` without generating the 12 locale packs. `ci:local` can't fix these; only a container or CI can — don't treat local green as foolproof.

Hooks: `npm run hooks:install` installs `pre-push` (runs the static profile by default; `CI_LOCAL_PROFILE=pr|full git push` tightens it, `SKIP_CI_LOCAL=1 git push` skips it), and `npm run hooks:install -- --uninstall|--list` manages it. Hook sources live in `scripts/git-hooks/`; `core.hooksPath` is not used (to avoid silently overriding hooks others have installed).

## Frontend build updates and old pages

`web/vite.config.ts` does not wipe the whole output directory; `web/build-assets.ts` keeps the current and previous round's assets after a successful build and cleans up older files, so an already-open page doesn't request deleted lazy-loaded modules when it first opens the file preview, settings and other panels. `.build-assets.json` records the current round's assets; on first migration the existing assets are kept as the previous round. Fully replacing the install directory can still lose old assets.

`web/src/chunk-recovery.ts` handles Vite preload errors and module load failures in the root error boundary uniformly, tracking recovery attempts in sessionStorage: at most one automatic reload per build, and at least one minute apart across builds; on a persistent error or unavailable storage it keeps the manual retry UI to avoid a reload loop. Ordinary application exceptions do not trigger an automatic reload.

## TOTP test site (built-in browser "TOTP authenticator")

`npm run dev:totp` (`dev/totp-demo.mjs`, loopback only, no third-party dependencies) starts a local 2FA site to exercise the browser's full chain: **scan to bind → auto-match by origin → one-click code fill → server-side verification**.

- `/setup/demo`: QR page (`totp.scan` screenshots the current tab to find the code, so the code must be in the viewport); only same-origin login pages can auto-match.
- `/login/demo`: standard login page, code field with `autocomplete="one-time-code"` (the first priority for `fillTotpCode`).
- `/login-cells/demo`: six `maxlength=1` cells (the cell-by-cell fill path).
- `/login-plain/demo`: a single field with no otp/code hints (must click the field before filling; exercises the fallback path).
- `/api/code/:key`, `/api/account/:key`: current code / secret + otpauth URI, handy for checking answers with curl or importing by hand.
- The three accounts cover `SHA1/6位/30s`, `SHA256` and `8位/60s` respectively to confirm otpauth parameter parsing; the secret is random per start (`PI_TOTP_SECRET` pins the demo accounts).

## Coding conventions

- **Indent with tabs**; frontend component files use lowercase names (`copy-button.tsx` is the exception); code comments mix Chinese and English, and UI copy defaults to Chinese.
- **Server-side locale packs**: `{name}` in `serverStrings` must correspond to the key name in the `vars` fifth argument of `pick()` (e.g. `{ count: rows.length }` corresponds to `{count}`); don't copy the English template expression verbatim. Translations must keep the operational guidance, command literals and line breaks at concatenation boundaries; after changes, verify interpolation against the real locale pack — the key alignment check does not cover these problems.
- **i18n**: every user-visible string goes through `useT()`; changing `i18n.tsx` requires adding a key to both built-in locales `zh`/`en` at once (`en` is typed `Record<keyof typeof zh, string>`, so a missing key is a compile error — that's a feature, not a bug). The 12 downloadable packs in `locales/*.json` (de/es/fr/it/ja/ko/pt/ru/tr/zh-Hant/zh-HK/zh-TW) must also get the key in sync and in the same order as `zh` — `tests/unit/locales.test.ts` locks that alignment. Do not hand-edit the Traditional Chinese packs: run `node --import tsx scripts/zh-tw-locale/build-all.mjs .` (see `scripts/zh-tw-locale/README.md`) to regenerate them wholesale from Simplified Chinese.
- **Notification copy**: server notices write a Chinese `text` + English `textEn` (the client picks one by locale; bilingual fields, following the `description`/`descriptionEn` precedent in `ChatInput`). Prompts sent to the model stay in Chinese.
- **Styling**: everything lives in `styles.css`, sectioned by `/* ---- component name ---- */`; colors use CSS variables (`--bg-elev*`, `--border*`, `--text*`, `--accent*`, `--amber`, `--green`, `--red`). Before writing/renaming a variable, confirm it **is actually defined**: per spec, referencing an undefined custom property is guaranteed-invalid, and the whole declaration fails at computed-value time (`background` without a fallback has no background, `box-shadow` loses the shadow along with it; with a fallback it silently uses the hard-coded value → a dark block in the light theme). `tests/unit/css-tokens.test.ts` statically scans every `var()` reference in the repo; run it after adding a variable.
- The file-list `IGNORED_ENTRIES` (node_modules/.git/dist etc.) is maintained at the top of `files-service.ts` (two platform-specific sets).
- **lint (oxlint)**: `npm run lint` must be zero warnings; `lint:fix` only fixes mechanical items. The three rules disabled in `.oxlintrc.json` are intentional: `no-control-regex` (the filename sanitizing regex), `unicorn/no-new-array` and `typescript/no-this-alias` (oxlint ignores inline disable comments, and rewriting hurts readability). The `[...set]` copy in the broadcast loop is intentional (a handler may unsubscribe mid-emit); there's an inline comment — don't "optimize" it away.
- **Tool prompts (the tool definitions sent to the model) keep three strictly separated responsibilities**: `description` = what it does + side effects/boundaries; `promptSnippet` = trigger conditions (goes into the system prompt's `Available tools` list rendered as `- name: snippet`, so no tool-name prefix, ≤80c); `promptGuidelines` = when to use / order / prohibitions / cross-tool routing. **Say each piece of information once**: the snippet doesn't restate the description, the guideline doesn't restate the description, parameter docs don't restate the main description; a schema block shared by multiple tools (e.g. SSH credentials, connection/database params) is extracted into a shared constant (all tool schemas sit in the context at once, so duplication is pure waste). For operation-syntax reference tools (`patch-tool`) the op table is the single documentation spot — don't split it. Guard test `tests/unit/tool-prompt-hygiene.test.ts` (CI runs it): English-only + length caps + snippet prefix/restatement detection + same-file synonym duplication detection.
- **Two implementations sharing one set of prompts must be single-source**: when a tool has multiple execution paths (e.g. bash native/terminal/routing), the model-facing definition should come from exactly one module (`server/tool-prompts.ts`), and the router only overrides `execute`. The overridden copy still gets maintained unconsciously — it's never sent, it only drifts.
- New protocol message → change only server/protocol.ts (see "protocol single source" in `docs/architecture-core.md`), then add a branch to the dispatch/onmessage switch on both sides.
- **Host-provided packages may only be declared in `peerDependencies` (`"*"`)**: the pi extension loader (`collectExtensionPackageWarnings` in `resource-loader.js`) only scans `dependencies` — hitting `@earendil-works/pi-coding-agent` / `typebox` warns that "the nested copies you install bypass the extension loader and create duplicate runtime modules". This package is both a "pi extension" and a "standalone server/CLI", the server child process really needs those two packages (20+ typebox references under `server/`, the SDK all over the repo), and `PI_WEB_SDK=bundled` needs its own copy too → so they live in `optionalDependencies` (npm installs them by default; the loader doesn't look at this field; see `package.json`). Guard: `tests/unit/extension-host-packages.test.ts` (goes red if anyone moves them back into `dependencies`).

## Documentation convention: AGENTS.md is index-only

`AGENTS.md` is the "key feature → source-of-truth file → doc" mapping table and **carries no detailed rules** (details go into the matching `docs/`); `docs/README.md` is the doc index (each doc's topic, weight ★★★/★★/★/○ and the "reading paths by scenario"). To add something:

1. Write the detail into `docs/agent-rules.md` (protocol/tool prompt/UI style/runtime hard rules) or the matching topic doc;
2. Add a row to the matching weight group in `docs/README.md`, and a row to the mapping table in `AGENTS.md` (feature / source-of-truth file / doc link), plus a row in the §3 hard-rule table + the guard test name when needed;
3. Run `npx vitest run tests/unit/agents-md.test.ts tests/unit/docs-index.test.ts`: the first guards `AGENTS.md` size (≤150 lines / ≤20KB), the survival of `docs/` links and anchors, key docs still being indexed, the guard test files named in §3 existing, and the source files named in the mapping existing; the second guards that `docs/README.md` covers every `docs/*.md`, that links and anchors survive, and that every doc is registered in a weighted group.

Historically it ballooned to 51KB / 281 lines because device center/groups, canvas, the full env var table and UI hard rules were copied into the body; every session paid for the details and they gradually drifted from `docs/`, so it became index-shaped (full backup at `AGENTS.md.bak`).

## Slash command catalog

Server-side `pushSlashCommands()` collects the active session's extension commands (`session.extensionRunner.getRegisteredCommands()`) + templates (`promptTemplates`) + skills (`resourceLoader.getSkills()` → `skill:<name>`) plus 11 built-in commands (NATIVE_COMMANDS: /new /name /model /compact /cwd /thinking /resume /reload /help /copy /pi-web-ui:quit), pushed via a `slash_commands` message (refreshed on attach / set_cwd / new_chat / switch_conversation / switch_session / get_commands); built-in commands are intercepted in `prompt()` (`execNativeCommand`, including /model fuzzy matching, /thinking Chinese/English aliases, and `/reload` calling `session.reload()` to rediscover extensions/skills/templates and re-push the catalog), everything else passes through to the SDK (which expands extension/skill/template commands).

Note that the SDK's `getSkills()` returns an in-memory snapshot from session creation — after deleting/adding a skill file you must `/reload` (or /new, or switch the project to rebuild the runtime) for it to take effect. Keep `NATIVE_COMMANDS` and `execNativeCommand()` in sync when changing things. Regression: `slash-commands-test.mjs`.

## Verification checklist

1. `npm run typecheck` zero errors
2. UI involved → `npm run dev` and walk the interactions manually
3. ws protocol involved → there are ready-made scripts under `tests/` to copy from: run `npm run test:smoke` first (the full self-contained protocol suite), single ones with `node tests/xxx-test.mjs` (needs `npm run build` first; browser E2E needs local Chrome, whose path is probed per platform by `tests/lib/chrome.mjs` and overridable with `PI_WEB_CHROME`)

## Test conventions

### Test value and slimming

- **Behavior tests hit production code**: call the real exports, render the real components or execute production closures; copying the algorithm into the test and validating the copy does not count as covering production behavior. Type declarations, parameter destructuring and local variable names don't get a case of their own.
- **Source guards keep a well-defined job**: architecture, security, resource contracts and known regressions that temporarily lack behavioral verification may be checked statically; concentrate one constraint in one guard instead of checking the same source across files.
- **Verify the replacement relationship before deleting duplicates**: production paths, input ranges and constraint strength must be covered by the tests that remain; parsers must keep an assertion on the number of valid samples so they can't pass falsely by skipping everything. Different boundaries still need independent coverage — don't merge cases just to reduce the count.
- **Reuse read-only inputs, isolate mutable state**: scan source once per suite; expensive base fixtures can be copied into a per-case directory; mutable resources like Git's `.git`, the index and browser contexts are not shared across cases. Keep Vitest's default module isolation.

`tests/unit/` is a historical directory name; it also contains repo scans, real Git/CLI and Chromium tests, so not everything there can be costed as a "millisecond pure function". Optimize by cutting repeated scans, process starts and oversized import chains first, then compare timings with targeted reports; the full CI gate keeps its coverage.

### Global vs local

Users may be running conversations/work on a **globally installed** `pi-web-ui` (the `pi-web-ui` under `npm root -g`, default port `8787`) day to day. The development target is always the **local repo** (the cloned pi-web-ui directory). Users shut down the global dev instance and switch to the local one manually when they test.

**Never kill the global process / occupy 8787**: `pkill -f "dist/server/index.js"` is forbidden — it hits the global server (port 8787) and interrupts the session the user is using. Cleanup targets only **test servers you started yourself**.

### Unit test concurrency and browser waits

`vitest.config.ts` caps workers at 4 to keep Chrome, file scans and child processes in a full run from contending for runner resources. Browser startup budgets should be independent of business assertions; messages, URL or DOM updates across frames must wait for the corresponding observable state, not substitute another async event completing for the target state having updated.

### Isolated ports

Every `*-test.mjs` uses its own port (≥8900, avoiding 8787/5173/3300) and runs `lsof -ti :PORT -sTCP:LISTEN` to confirm it's free before starting the server; if occupied, change the port rather than kill hard.

### Clean up only the processes you started

Record `server.pid` after spawn, and in test teardown (including the exception catch path) use `process.kill(pid, 'SIGTERM')` to kill only what you started. With several servers running, kill each by its own PID; don't use broad pattern matching.

### data-dir isolation

The test server sets `PI_WEB_DATA_DIR` to `mkdtempSync(tmpdir…)` and `PI_WEB_CWD` to the local repo — avoiding pollution of the real user data / client-state / session.

### Self-contained vs external dependency

Tests that qualify for the `tests/run-smoke.mjs` list must **start their own server + clean up after themselves**; those that don't fall into two buckets (reasons are in the header comment of run-smoke.mjs):

- ① attach-type needing an already-running external server — ws-session-test / file-upload-test / image-paste-test / commands-test(8791) / edit-reask-test / projects-test
- ② needing a real model — goal-abort-test / goal-autostart-test / goal-wizard-test / goal-wizard-cancel-test / tool-status-test (title-jsonl-test is fixed and runs locally; on win32 terminal-smoke / restart-handoff skip automatically)

### Requiring a real model / review research (goal-*, wizard)

These really call the LLM, burn tokens and depend on the local model (opencode-go can be slow/stuck) — when writing tests, separate "protocol smoke (no tokens, e.g. the set/clear round order in goal-test/goal-prefs)" from "live (real calls)" so nobody mistakes it for a broken feature.

### Verification items

For local iteration run the change-related `npx vitest run <test file>` first; when the protocol is involved run `npm run check:protocol` and the matching `tests/*-test.mjs`; when real UI interaction is involved run the relevant browser tests too. Test servers use isolated ports and an independent data-dir; Chromium is probed per platform by `tests/lib/chrome.mjs` and overridable with `PI_WEB_CHROME`. Before committing, follow `AGENTS.md` to format the changed files, run `npm run typecheck` and the relevant unit tests; the full `npm test` and the tiered `test:smoke` continue to run in CI — for shared-infrastructure changes, run the matching full suites locally as well.

### Test timing observability (where the time goes)

`silent: true` in `vitest.config.ts` swallows the default reporter's per-file lines, so a full run takes a dozen minutes and shows no timings at all. Hence `tests/lib/test-timing-reporter.mjs`: one line per case ("end time + duration"), then a closing "Top10 slowest files / Top20 slowest cases".

```bash
npm test                              # PI_TEST_TIMING=all by default, prints every case
PI_TEST_TIMING=slow npm test          # only cases ≥1s (PI_TEST_SLOW_MS changes the threshold)
PI_TEST_TIMING=off npm test           # closing summary only
npx vitest run --reporter=json --outputFile=<tmp>/timing.json   # per-case data for later reuse
```

Local measured baseline (Windows 12C/24T, 1028 files / ≈12.5k cases): wall clock ≈705s, accumulated case time ≈1955s, parallelism factor 2.78×. **About 75% of the time sits in 6 real integration files** (`device-hub-artifact-integration` / `device-local-integration` / `device-hub-integration` / `task-workspace` / `canvas-workspace` / `device-center-runtime-code-artifact`), which really run git child processes and Hub HTTP; their slowest cases take 17–52s alone, and with 4 workers saturated they stretch by about 2.3×.

Two rules follow: ① **write the timeout budget for heavy integration cases as 90s** (aligned with `task-workspace`), not 20–30s — that's zero headroom, producing steady-state false reds at saturation, each burning 30s for nothing; ② cases within one file are serial, so splitting hundreds of seconds of heavy work across files beats tuning the worker count.

### Two pools: default fast pool + heavy integration pool

Tuning that single number (`maxWorkers`) can't save this suite: raising the **heavy pool** from 4 to 8 blows one case from 30s to 83s while the rest hit the 60s/90s budgets, so more concurrency is actually slower with false reds; the **fast pool** is the opposite — it's bound by 1023 forks, so more workers are faster. Hence the cost-based split, with the list single-sourced in [`tests/lib/suite-partition.mjs`](../tests/lib/suite-partition.mjs) (criterion: measured ≥60s):

| Pool                | Entry point                | Content                                                           | Budget                           |
| ------------------- | -------------------------- | ----------------------------------------------------------------- | -------------------------------- |
| Fast pool (default) | `npm test`                 | all unit tests outside the table below (1023 files / 12.4k cases) | 8 workers · 60s (measured ≈186s) |
| Heavy integration   | `npm run test:integration` | 6 real git / real child process / real Hub files (111 cases)      | 4 workers · 90s (measured ≈470s) |
| Full                | `npm run test:all`         | runs both                                                         | —                                |

`PI_TEST_ALL=1 npx vitest run` also runs everything in one go; CI's `Unit tests` and `Integration tests` steps run the two pools separately (`tests/unit/test-suite-partition.test.ts` guards that "the two sides together must equal the full `tests/unit/**` set", preventing a file from being excluded and then never run). When adding a heavy file, add one row to the list.

### Test family quick reference

| Test group               | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **goal family**          | `goal-test`=protocol smoke; `goal-prefs-test`=preference persistence; `goal-pill-test`=GoalBar UI; `goal-rounds-test`=max rounds input; `goal-autostart-test`=auto-trigger generation; `goal-abort-test`=Stop clears goal; `goal-wizard-test`=questionnaire convergence; `goal-wizard-cancel-test`=research cancel/timeout; `goal-review-loop-test`=locked + unlimited-round review loop (needs a real model)                                                                                                   |
| **settings family**      | `settings-test.mjs` (port 8931): settings panel protocol smoke — settings_state push / get_settings / set_settings / save_preset / apply_preset / delete_preset / reconnect persistence                                                                                                                                                                                                                                                                                                                         |
| **global-search family** | `global-search-test.mjs` (port 8962) = search_files protocol smoke; `global-search-ui-test.mjs` (port 8963) = real Chrome headless UI test                                                                                                                                                                                                                                                                                                                                                                      |
| **scm family**           | `scm-features-test.mjs`=SCM v2 feature protocol test (lazy-loaded history / remote branches / git-dir watcher); `scm-test.mjs`=SCM panel E2E (real Chrome headless)                                                                                                                                                                                                                                                                                                                                             |
| **other**                | `lazy-window-test.mjs`=message list lazy windowing E2E; `terminal-bash-test.mjs`=terminal takeover bash regression; `quiesce-test.mjs` (port 8911)=security hardening smoke; `fetch-models-test.mjs` (port 8955)=model list auto-fetch; `clone-provider-test.mjs` (port 8965)=built-in provider cloning; `model-config-ui-test.mjs`=model management UI (real Chrome); `vision-bridge-test.mjs` (port 8945)=vision bridge end-to-end; `vision-bridge-ui-test.mjs`=vision bridge settings panel UI (real Chrome) |

**Playwright scripts**: Chrome paths are no longer hard-coded — `tests/lib/chrome.mjs` probes per platform (`PI_WEB_CHROME` overrides). Two cross-platform hard rules: ① take the repo root in scripts with `fileURLToPath(new URL("..", import.meta.url))`; `URL.pathname` is `/E:/...` on Windows, and both spawn cwd and script arguments then ENOENT; ② clean up server processes on win32 with `freePort(port)` from `tests/lib/port-utils.mjs` (Windows has no process groups with negative PIDs, so a silently failing `process.kill(-pid)` leaves a listening process behind).

**Do not call `process.exit` directly inside a try block in test scripts**: `process.exit` skips `finally`, the spawned server is never killed → every run leaks a process, and the next run on the same port reports "port busy — abort" (hit in steer-queue-smoke, fixed: set an ok flag + kill the process in `finally` and wait for the port to be released before exiting).
