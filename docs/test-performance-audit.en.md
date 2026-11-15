**English** · [简体中文](./test-performance-audit.md) · [繁體中文](./test-performance-audit.zh-TW.md)

# Unit test performance audit: current state, what changed, what is open (for external review)

> Purpose: lay out once and for all why this suite is slow, where the time goes, what has been tried, and where it is still stuck — so outside reviewers can contribute ideas.
> Every number is measured on the local machine (not estimated); reproduction commands are at the end. Written during v0.119.0.

## 0. TL;DR

- Suite size: `tests/unit/` **1029 files / 12,480 test cases**, plain `node` environment + `pool: "forks"`.
- Full run before the change: **704 s wall clock**, 1955 s summed test time, 11 false reds (root cause: zero headroom in the timeout budgets).
- Now (all measured, all green):
  - **Default `npm test` (fast pool, 1023 files / 12.4k cases): 182 s** (was 704 s, **3.9×**).
  - **`npm run test:integration` (6 heavy files / 111 cases): 135.2 s wall clock, 443 s summed test time** (was 1064 s, **−58%**).
  - Both pools together ≈318 s (was 704 s).
- Two levers that actually delivered (neither is "run fewer cases"):
  1. **Partitioning**: fast pool 8 workers / heavy pool 4 workers, each with its own budget. Worker count has exactly opposite effects on the two pools (see §2.2, §2.3).
  2. **Two layers of caching in the product's `git()`**: filter probing (one extra subprocess per call) + repository identity queries (`--show-toplevel` and friends, 82 per pipeline),
     together cutting git subprocesses per pipeline from 462 → about 106 and taking 58% off the heavy pool across the two rounds (see §3.1, §3.1.1).
- Remaining hard costs (quantified, unchanged): ~2.7 s of PowerShell supervisor cold start per verification command; 44% of fast-pool time goes to ESM module graph evaluation (`isolate:false` eats 36% of it but introduces order dependence, see §3.2).
- Historical open question closed: the “3 calls in 16.7 s” is pinned down and down to **11.1 s**; mechanism in §3.1.

## 1. Environment and measurement method

| Item                          | Value                                                                                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| OS / CPU / RAM                | Windows, 12 physical / 24 logical cores, 32GB                                                                                                   |
| Node                          | v25.9.0 (`engines.node >= 22.19`)                                                                                                               |
| Test framework                | vitest 5.0.1 + vite 8 + tsx, `pool: "forks"`, `isolate` default (true)                                                                          |
| Timing source                 | `npx vitest run --reporter=json --outputFile=<tmp>/x.json`, aggregated from `testResults[].startTime/endTime` and `assertionResults[].duration` |
| Wall clock / summed test time | Wall clock = earliest startTime to latest endTime; summed test time = sum of per-file durations                                                 |
| “Parallelism factor”          | Summed test time ÷ wall clock. Upper bound 4.0 with 4 workers; clearly below the worker count means time goes to forks / idle spinning          |

Per-case timing observer: `tests/lib/test-timing-reporter.mjs` (added in this change, see §3), printing “end timestamp + duration” for every case.

## 2. Current numbers

### 2.1 Full run (before and after)

|                                                                 | Files | Cases  | Wall clock                       | Summed test time | Parallelism factor | Failures     |
| --------------------------------------------------------------- | ----- | ------ | -------------------------------- | ---------------- | ------------------ | ------------ |
| Before the change, 4 workers                                    | 1028  | 12,479 | **704s**                         | 1955s            | 2.78               | 11 (5 files) |
| After fixing timeout budgets / cleanup races, 4 workers         | 1028  | 12,487 | **559s**                         | 1512s            | 2.70               | 0            |
| After partitioning: fast pool, 8 workers                        | 1023  | 12,383 | **172–186s**                     | 502–530s         | 2.70–3.08          | 0            |
| After partitioning: heavy pool, 4 workers (before optimisation) | 6     | 111    | ≈320s (estimated from 1064s/3.3) | 1064s            | 3.32               | 0            |
| **After adding the git probe cache: heavy pool**                | 6     | 111    | **167.6s**                       | 557s             | 3.32               | 0            |
| **After adding the git probe cache: fast pool**                 | 1023  | 12,384 | **182.4s**                       | 484s             | 2.65               | 0            |

### 2.2 Fast-pool worker sweep (same code, same 1023 files)

| maxWorkers | Wall clock | Summed test time | Parallelism factor | Result                                                                                                                |
| ---------- | ---------- | ---------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 4          | 280s       | 409s             | 1.46               | green                                                                                                                 |
| 8          | **186s**   | 502s             | 2.70               | green (current default)                                                                                               |
| 12         | 172s       | 777s             | 4.51               | 1 false red: `vi.waitFor({timeout:15_000})` inside `canvas-scheduler` is dragged past its budget by 12-way contention |

Note that summed test time rises with the worker count (409 → 502 → 777 s): real contention inflation, showing the machine is near saturation past 8.

Other “reuse” variants tried on the same batch of files (detailed analysis in §3.2):

| Variant                                                        | Wall clock                                                        | Result                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------ |
| `--isolate=false` (reuse the module graph)                     | 117.3s (40 failures) / >340s spinning after isolating the 7 files | rejected (see §3.2)            |
| `experimental.fsModuleCache` (reuse compiled output), cold/hot | 187.5s / 189.9s                                                   | no gain (transform is only 3%) |

### 2.3 Heavy pool (6 files, 4 workers steady state)

| File                                          | Cases | Time | Slowest single case |
| --------------------------------------------- | ----- | ---- | ------------------- |
| `device-hub-artifact-integration.test.ts`     | 30    | 304s | 34.2s               |
| `device-local-integration.test.ts`            | 22    | 280s | 32.6s               |
| `device-hub-integration.test.ts`              | 18    | 218s | 35.3s               |
| `task-workspace.test.ts`                      | 13    | 122s | ≈40s                |
| `canvas-workspace.test.ts`                    | 11    | 77s  | 21.2s               |
| `device-center-runtime-code-artifact.test.ts` | 17    | 63s  | 15.2s               |

Heavy-pool worker sweep: **4 is the ceiling**. Raising it to 8 workers inflates one and the same case from 30 s to **83 s**, and another 4 cases blow through their 60s/90s budgets as timeouts (not functional breakage).

## 3. What changed (scope of this commit)

| File                                            | Change                                                                                                                                    | Rationale                                                                                                                                                                                                  |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tests/lib/test-timing-reporter.mjs` (new)      | Prints “end timestamp + duration” per case and a slowest-file/slowest-case Top at the end; `PI_TEST_TIMING=all/slow/off`                  | `silent: true` + `onConsoleLog: () => false` in `vitest.config.ts` swallowed every per-file line of the default reporter, so a full 12-minute run produced zero output and the slow spots were unlocatable |
| `vitest.config.ts`                              | Wires up the reporter; excludes heavy files per `suite-partition.mjs`; `PI_TEST_ALL=1` runs everything in one go                          | fast/slow partitioning                                                                                                                                                                                     |
| `vitest.integration.config.ts` (new)            | Dedicated heavy-pool config: `include: HEAVY_SUITE`, 4 workers, 90s budget                                                                | Heavy files slow each other down when they share one pool                                                                                                                                                  |
| `tests/lib/suite-partition.mjs` (new)           | Heavy-file list + worker/budget constants for both pools (single source of truth)                                                         | Keeps config and guard test from each writing their own copy                                                                                                                                               |
| `tests/unit/test-suite-partition.test.ts` (new) | Guard test: the heavy list exists and has no duplicates, **the union of both pools == the whole `tests/unit/**` set**, CI runs both pools | Prevents a file from being excluded and then never run again                                                                                                                                               |
| `package.json`                                  | `test:integration`, `test:all`                                                                                                            | entry points                                                                                                                                                                                               |
| `.github/workflows/ci.yml`                      | Runs `npm run test:integration` after `Unit tests`                                                                                        | CI does not lose coverage                                                                                                                                                                                  |
| The 6 heavy test files                          | Timeout budgets 20–30s → 90s (rationale written in the file comments); `EBUSY` cleanup gets `maxRetries/retryDelay`                       | Old budgets had zero headroom → guaranteed false reds at full load, and each false red burned 30 s for nothing (11 cases burned 367 s = 18.8% of the total at the time)                                    |
| `tests/unit/canvas-scheduler.test.ts`           | Internal `vi.waitFor` 15s → 30s                                                                                                           | Did not match the 90s per-case budget                                                                                                                                                                      |
| `docs/development.md`                           | Two new sections: “test timing observation” and “the two pools”                                                                           | Rules land in the docs                                                                                                                                                                                     |

False-red root cause (verified): these 6 files peak at 19.2 s alone / 31 s+ under full load, hitting the 30 s wall; `device-hub-integration` takes 127 s alone with every test green, 290 s in parallel with 3 timeouts — **purely load-sensitive, not a functional regression**.

### 3.1 Product-side architecture fix: filter-probe cache in `git()` (biggest win this round)

Layered timing with `performance.now()` + child_process interception (pipeline split into prepare/verify/confirm):

```
[probe] prepare 953ms   verify 6199ms   confirm 7051ms
[probe] spawns=463  spawnMs=14486  (git ×462 = 11.8s, powershell.exe ×1 = 2.7s)
[probe] git exec(16 runs by the tests themselves)=505ms   store.transact ×7=25ms
```

Conclusion: a 3-call pipeline runs **462 git subprocesses**; the root cause is that `git()` in `server/workspace-handle.ts`
**runs a `git config --get-regexp ^filter\..*` probe before every logical call** (to neutralize malicious clean/smudge filters),
i.e. “one logical call = two subprocesses”.

Fix: cache the `-c` arguments to pass through, keyed by a **repository config file fingerprint** (`config` / `config.worktree` path+mtime+size,
including `commondir` resolution for linked worktrees). Anything uncertain is **not cached and falls back to probing every time**: no `.git` found,
`include`/`includeIf` in the config (external file fingerprints are unreliable), stat/read failure, more than 64 cache entries.
Regression test for “a filter added mid-session”: “refreshes the filter-override cache when repo config changes mid-session” in `tests/unit/workspace-handle.test.ts`.

Effect (same machine, same config, 4 workers, all green):

| File                                  | Before    | After             | Change |
| ------------------------------------- | --------- | ----------------- | ------ |
| `device-hub-artifact-integration`     | 304s      | **167s**          | −45%   |
| `device-local-integration`            | 280s      | **154s**          | −45%   |
| `device-hub-integration`              | 218s      | **108s**          | −50%   |
| `task-workspace`                      | 122s      | **60s**           | −51%   |
| `canvas-workspace`                    | 77s       | **37s**           | −52%   |
| `device-center-runtime-code-artifact` | 63s       | **31s**           | −51%   |
| Total / heavy-pool wall clock         | 1064s / — | **557s / 167.6s** | −48%   |

The most expensive single case (`completes full pipeline`) went from **16.7s → 11.1s** run alone.

#### 3.1.1 Second round: repository identity query cache (82 of 188 calls per pipeline are the same three queries)

With the filter probe cached, `workspace-handle.git()` is still called 188 times per pipeline, of which:

```
41x  rev-parse --path-format=absolute --git-common-dir
25x  rev-parse --show-toplevel
16x  rev-parse --absolute-git-dir        ← these three total 82 calls, all constant queries for a given directory
16x  branch --show-current     16x  rev-parse HEAD     16x  status --porcelain --untracked-files=all
```

So those queries are cached with the same fingerprint mechanism (hits **77/82**). All three pitfalls went into code comments:

1. The pattern table must count the `rev-parse` prefix in argv — the first version missed it, the cache never hit once, and it was misjudged as “no gain”;
2. The key must carry **cwd** — the main repo and its worktrees share config (identical fingerprint) but have different `--show-toplevel`, so omitting cwd leaks values across them;
3. The fingerprint must contain **the `.git` pointer text + the commondir text** — the “worktree pointer replacement” case in `task-workspace` swaps `.git` for a pointer to the main repo,
   and omitting the pointer contents hits the stale cache and bypasses the identity check (a real regression caught by a heavy case).

Effect (same machine, 4 workers, all green): heavy pool **167.6s → 135.2s** (summed test time 557s → 443s).

| File                                  | After filter cache | + identity query cache |
| ------------------------------------- | ------------------ | ---------------------- |
| `device-hub-artifact-integration`     | 167s               | **135s**               |
| `device-local-integration`            | 154s               | **122s**               |
| `device-hub-integration`              | 108s               | **96s**                |
| `task-workspace`                      | 60s                | **42s**                |
| `canvas-workspace`                    | 37s                | **26s**                |
| `device-center-runtime-code-artifact` | 31s                | **22s**                |

### 3.2 “Reuse” optimizations: four directions measured one by one

Where the fast pool's 182 s actually goes is itemized by vitest itself: `tests 44% / import 44% / environment 8% / transform 3%`.
That drove an experiment with all four “reuse a resource” ideas:

| Resource to reuse                    | Approach                                                              | Measurement                                                                                                                                                    | Verdict                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compiled output (transform)          | `experimental.fsModuleCache: true`, two runs compared                 | cold 187.5s / hot **189.9s**                                                                                                                                   | **No effect**. transform is only 3%; caching it saves nothing                                                                                                                                                                                                                                                                                       |
| Module graph (ESM evaluation)        | `--isolate=false` (reuse the module graph inside a worker)            | first run **117.3s** (−36%) but **40 failures**; after excluding those 7 files: **>340s never finished, one worker burned 315s of CPU (spinning, apparently)** | **Rejected**. mocks/env/singletons from `mcp-manager`/`engine-cli`/`shared-state-persistence`/`file-integrity`/`file-transfer-routes`/`native-cli-lifecycle`/`plugin-removal` leaked into other files; even isolated they still spin. isolate:false turns the whole run into “depends on file order”, a step backwards for determinism, not adopted |
| Subprocesses (git)                   | Cache the `git config` filter probe (**already merged**)              | heavy pool 1064s → **557s**                                                                                                                                    | ✅ Best value (see §3.1)                                                                                                                                                                                                                                                                                                                            |
| Subprocesses (PowerShell supervisor) | Unchanged: one PowerShell supervisor process per verification command | cold start **2.7s** each, ≈18% of the end-to-end integration pipeline                                                                                          | The largest remaining fixed cost. Reusing it means switching to a warm supervisor (always-on named pipe), a separate project                                                                                                                                                                                                                        |

Two more “reuse” ideas were estimated **not worth doing**:

- **Shared template repo** (built once in beforeAll, `fs.cp` per case): measured `fs.cp` 5 times = 143 ms, `git init+commit` 6 times = 186 ms,
  → only ≈0.15 s saved per case, ≈17 s across 111 cases (3% of the heavy pool), not worth the refactor risk.
- **Merge small test files** (fewer forks): merging all 53 files at `≤40 lines` saves only ≈43 forks ≈ 4 s of wall clock.

So the only way for the fast pool to win that further 36% is to go back to `isolate:false`; and that requires splitting the 7 “stateful” files above
into a separate isolation pool — equivalent to maintaining a “state blacklist”. Whether that fragility is acceptable is your call.

### 3.3 The fast pool's next real lever: 78 files each spend ~2s loading agent-service

Quantified with two probe files (same environment, timed inside vitest):

| Probe                                                     | Duration                               | Notes                                                      |
| --------------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| Only `import { ClientSession } from server/agent-service` | **3.00s** (import 52% + transform 47%) | Loading `agent-service.ts` → the whole pi SDK module graph |
| Empty test case                                           | **123ms**                              | baseline                                                   |

- **78 files** under `tests/unit/` import `server/agent-service.js` at runtime (only 1 of them as `import type`);
- 63 of them come in through `tests/helpers/fake-session.ts`, and that helper only uses `ClientSession.prototype` for `Object.create` and accessor checks — **paying for a whole SDK graph to get one prototype object**;
- Magnitude: 78 × ≈2s ≈ **150s of CPU** (the fast pool's summed test time is only ~484s).

**Proposed approach (not executed, needs coordination)**: extract `ClientSession` into a light module `server/client-session.ts` and have `agent-service.ts` re-export it;
point `fake-session.ts` at the light module for the prototype. Zero semantic change, estimated **fast pool −25–30%**.
Why it was left alone: `server/agent-service.ts` is being modified by a parallel session, and edits to the same file collide.

### 3.4 Three more ideas tried and rejected (so nobody walks them again)

| Idea                                                                                                               | Measurement                                                                                                                | Verdict                                                                              |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Extract `server/client-session.ts` so `fake-session.ts` no longer imports agent-service                            | Of the 63 fake-session consumers, **52 also import agent-service themselves**, leaving only **11** that benefit (≈22s CPU) | dropped: the gain does not justify a cross-module refactor                           |
| Precompile the supervisor's C# into a DLL (`Add-Type -Path`) to dodge on-the-spot compilation                      | `powershell -NoProfile -Command 1` = **1.18s** (process start); `Add-Type -TypeDefinition` only **73ms**                   | dropped: that 2.7s is PowerShell cold start plus the command itself, not compilation |
| Cache repository identity queries by fingerprint (`--show-toplevel` / `--git-common-dir` / `--show-object-format`) | median of three unit-test runs 11.1s → **11.7s** (within noise)                                                            | dropped: no proven gain, complexity not merged                                       |

Along the way, the remaining git calls in the pipeline were attributed (one `prepare→verify→confirm`, **188 calls** total through `workspace-handle.git()`):

```
82x rev-parse(pure flags)   16x rev-parse HEAD   16x branch   16x status   12x ls-files
 8x config                6x cat-file          6x read-tree 6x hash-object
 6x update-index          6x write-tree        2x rev-list  … (plus PowerShell 1x = 2.7s)
```

In other words: with the filter probe cached, what remains is **the pipeline itself repeatedly asking for repository state** (rev-parse/branch/status/ls-files, 126 calls).
Cutting further means merging those queries at the call sites (e.g. one `rev-parse` fetching toplevel/format at once) — a product-side refactor, estimated 10–15% gain.

### 3.5 Remaining costs located but not changed

- Every command in the verification stage runs through a **PowerShell supervisor process** (`server/device-center/local-verification.ts`
  with named pipe + `-EncodedCommand`) — measured **2.7s per command** on a Windows cold start. That is the foundation of cancel/stop semantics;
  speeding it up means replacing the supervisor mechanism first, a separate project.
- `snapshotProcessTree` / `lookupProcessCommandLine` in `server/process-utils.ts` use `Get-CimInstance`
  (WMI) to read the process table, also seconds per call; they sit only on `bg-servers` and troubleshooting paths today, not on the integration pipeline's main path.

## 4. Hypotheses ruled out (do not try these again)

| Hypothesis                                                         | Measurement                                                                           | Verdict                                |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------- | -------------------------------------- |
| Scaffolding repo creation is too slow (git init/config/commit/add) | 6 git subprocesses total **186ms**; ≈30ms per git call                                | no                                     |
| Fixture reuse would speed things up a lot                          | A case that needs only 0.3s (full beforeEach + Hub startup) = **504ms**               | gain ~0.3s per case, does not solve it |
| The tests are full of `sleep`/fixed waits                          | Only 2–3 `setTimeout`-level waits in the 6 heavy files (10s cancellation-style cases) | no                                     |
| Fake timers are misused                                            | 78 files repo-wide use `vi.useFakeTimers`, but the 6 heavy files barely do            | no                                     |
| Just raise the worker count                                        | Fast pool 4→8 works (280→186s); heavy pool 4→8 **gets slower and false-red**          | partitioning is required               |
| `silent` is only an output problem                                 | Besides being an output problem, it also hid the fact that every case takes 15–35s    | fixed                                  |

## 5. Conclusions and what is still open

### Closed (answered this round)

| Original question                                  | Answer                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1: why 16.7s for 3 calls                          | Not `store.transact` (7 calls, **25ms** total), and not the tests' own git (16 calls, 505ms). It is **the product's `git()` running one extra `git config` filter probe per call**: 462 git subprocesses per pipeline (11.8s) + 1 PowerShell supervisor (2.7s). Fixed product-side with a config-fingerprint cache → the same case went **16.7s → 11.1s**, heavy pool −48% |
| Q2: how to eliminate the fast pool's fork overhead | The measured split is `tests 44% / import 44% / environment 8% / transform 3%`. So `fsModuleCache` (caching transform) is **useless**; `isolate:false` (reuse the module graph) **works, −36%, but introduces order dependence**; going from 4 to 8 workers is the current best compromise                                                                                 |
| Would cutting cases speed things up                | Yes, but worth only ≈60s (§5). The heavy pool's 557s is real work; deleting cases is a last resort                                                                                                                                                                                                                                                                         |

### Still open (needs a decision / a separate project)

1. ~~Extract `client-session.ts`~~ — measured and rejected: only 11 files benefit (see §3.4).
2. **Make the PowerShell supervisor resident**: 2.7s of cold start per verification command ≈ 18% of the end-to-end integration pipeline. Switching to a warm supervisor
   (process reuse + always-on named pipe) recovers most of it, but that is a separate project on cancel/stop semantics; the risk is product-side, not test-side.
3. **True parallelism for the heavy files**: the measured concurrency ceiling is 4–5 (8 breaks the budgets). Going faster means splitting the 218–304s serial chains into more files,
   but splitting does not reduce total work; the gain depends on load balancing and is **estimated at ≤10%**. Lower priority than the two above.

## 6. Reproduction commands

```bash
# Per-case timing (default all; slow = only ≥1s; off = summary only)
npm test
PI_TEST_TIMING=slow npm test

# Fast pool / heavy pool / everything
npx vitest run                       # fast pool (8 workers, heavy files excluded per suite-partition)
npm run test:integration             # heavy pool (4 workers, 90s budget)
npm run test:all                     # run both
PI_TEST_ALL=1 npx vitest run         # everything in one go (no partitioning)

# Worker sweep
npx vitest run --maxWorkers=4|8|12

# Machine-readable per-case timing
npx vitest run --reporter=json --outputFile=<tmp>/timing.json

# Single-case probe (the most expensive case among the heavy files)
npx vitest run tests/unit/device-hub-integration.test.ts -t "completes full pipeline"
```

## 7. Key source locations

| Location                                                          | Role                                                                                      |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `vitest.config.ts` / `vitest.integration.config.ts`               | Configuration for both pools (worker count, timeouts, reporter, exclude/include)          |
| `tests/lib/suite-partition.mjs`                                   | Heavy-file list and both pools' constants (single source of truth)                        |
| `tests/lib/test-timing-reporter.mjs`                              | Per-case timing reporter                                                                  |
| `tests/unit/test-suite-partition.test.ts`                         | Partitioning guard test (union of both pools == the whole set)                            |
| `server/device-center/store.ts`                                   | `transact()` / `persist()`: full `structuredClone` + WAL + index rewrite (the Q1 suspect) |
| `server/device-center/hub-transaction-log.ts`                     | WAL append (on every `open`)                                                              |
| `server/device-center/device-integration.ts` (1159 lines)         | The executor for real git materialization / real command verification                     |
| `docs/development.md` §“test timing observation”, “the two pools” | The current timing-observation and partitioning rules                                     |
