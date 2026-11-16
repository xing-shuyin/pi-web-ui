**English** · [简体中文](./root-cause-review-2026-10-29.md) · [繁體中文](./root-cause-review-2026-10-29.zh-TW.md)

# Patch-style implementations and root-cause boundary review

Review target: the code in the current workspace (including uncommitted changes in progress in other conversations). The first review read source only; the user then authorized implementation, and remediation and verification status is recorded in the next section. I checked session lifecycle, goal mode, approval migration, plugins, task scheduling, canvas, config persistence, multi-engine and workspace boundaries in parallel, staying away from the MessageList / streaming Markdown that other conversations were fixing.

## Remediation and verification status

After user authorization, all 13 corresponding fixes below were implemented; architectural constraints are in `../root-cause-boundaries.md`. Follow-up passes also fixed strict reads of plugin storage, caching of failed candidates, async queue lock release, and re-import after history deletion on the old engine.

- Unified targeted regression: 29 non-canvas files, 474 tests all passing; covering worktrees, cancel/rebuild/approval, goal generations, plugin config/secret/storage/cron, MCP/atomic writes, multi-engine isolation, DNS binding and preset network paths.
- Targeted Prettier checks passed this round. Lint warnings for unused MCP imports were fixed.
- A full-project `npm run typecheck` was confirmed by a parallel preset conversation as passing for all five tsconfigs in the latest round; this conversation separately verified that the Web, tests, desktop and extension configs pass.
- When canvas item 3 was completed, 58 regression tests across 6 files passed. The user later authorized a broader canvas remediation in another conversation, and the new execution/isolation semantics made 4 of this round's `canvas-deletion-lifecycle.test.ts` tests time out; those were handed to that conversation, with the requirement to keep real late-completion coverage and not delete or skip it. That conversation took over subsequent canvas tests and the final global typecheck/lint; canvas is not counted as final acceptance here because it keeps changing.
- The remaining warnings in the current global lint come from unused imports/variables in CanvasStudio under parallel development and were handed to the canvas owner.

No Git commit, release or service restart was performed. The workspace holds many uncommitted changes from other conversations, all preserved. MCP cross-file migration recovery is triggered by repeating the same save request; the DSH init-failure test uses a mock runtime and does not start a real DSH subprocess; the original findings are kept as review evidence and do not mean the corresponding old implementations still exist.

This is a broad review along architectural boundaries, not a line-by-line exhaustive one. The findings below are grounded in actual call chains; apart from explicitly marked targeted reproductions they are static verification and still need fault injection and race regression during remediation. P1 means prioritized data safety, wrong execution or core feature failure; P2 means hanging or residue under specific conditions.

## 1. P1: worktree status read failure treated as no changes, feeding forced deletion

Location: `server/worktree-service.ts:130`, `:491`, `:515`.

`getUncommittedCount()` returns `{isDirty:false,count:0}` when Git status times out or errors. `finalizeSubagentWorktree()` uses this value to decide automatic cleanup; when HEAD equals base and uncommitted work exists, a single status query failure can lead into `removeWorktree(..., true)` and then delete the branch. A HEAD query exception likewise degrades to ahead=0.

Root cause: a "best effort" read result meant for display is reused as the authorization basis for destructive operations, collapsing unknown state into a safe state.

Root fix: make status tri-state clean / dirty / unknown; allow automatic deletion only when all checks explicitly succeed and there are no changes. On failure keep the worktree and report why; raising the timeout or adding retries is not a safety boundary.

## 2. P1: plugin cron re-queries a future time after expiry and skips this run

Location: `server/plugins.ts:4997`, `server/plugin-schedule.ts:141`.

`armCron()` captures next when setting the timer, but the callback calls `nextCronFire(parts, Date.now())` again. That function searches from the next minute, so on a normal expiry it gets the following run rather than this one, and `at <= now + 1000` does not hold. Chunked timers solved long-delay overflow but lost the identity of this run's dueAt.

Targeted reproduction: calling the current source's `parseCronSpec` / `nextCronFire` directly, a per-minute task scheduled for 10:01 gets 10:02 again when the callback runs at 10:01, `willFire=false`. This is a deterministic reproduction of the expiry predicate, without starting a real plugin or timer.

Root fix: store this run's dueAt and compare now against that dueAt when the chunk wakes; compute the next time only after the due run executes, folding catch-up runs and clock jumps into the same state transition.

## 3. P1: deleting a running canvas does not stop execution; async finalization resurrects the project

Location: `server/canvas/canvas-dispatch.ts:79`, `canvas-agent-tool.ts:384`, `canvas-store.ts:239`, `canvas-orchestrator.ts:537`.

Both delete entry points only delete the graph file. Node completion still calls the runtime-state save, and the save function writes the complete old graph back when it finds the file missing; downstream edges are still processed afterwards. The project therefore reappears, and model calls or downstream operations can still start after deletion.

Root cause: deleting the durable file did not invalidate the run identity; runtime-state updates doubled as creation.

Root fix: on delete, first revoke the graph run generation and cancel execution, then delete the file; all completion callbacks, disk writes and downstream dispatches validate the generation. Runtime-state saves may only update an existing project. Adding stopAll alone cannot block old callbacks returning across awaits.

## 4. P1: plugin settings persist failure still publishes runtime state and reports success

Location: `server/plugins.ts:1757`, `:1783`, `:1985`, `server/dispatch-plugin-handlers.ts:74`.

A failed regular settings write only logs and still returns clean. The caller triggers settingsHandlers and goes through the success acknowledgement, splitting the in-memory new config from the on-disk old config. Secrets are also written during per-field validation, so a later field validation failure can leave a partial commit.

Root fix: make full validation, staging, durable commit and runtime publication explicit boundaries; return failures upward. Secrets and regular config need a joint commit or a recoverable transaction, and the validation loop must not produce durable side effects.

## 5. P1: MCP rename or scope migration deletes before writing, losing config on failure

Location: `server/mcp-manager.ts:85`, `:189`, `:223`.

Renaming or migrating deletes the old record and writes back, then writes the new record. If the second step fails or the process exits, the old config is already lost. Same-file rename also splits into two writes; overwriting the real file directly and degrading read errors into an empty config widen the risk further.

Root fix: same-file rename does one in-memory transform then an atomic commit; cross-file migration durably guarantees the target exists before removing the source, with recoverable migration state. Reads clearly distinguish missing, corrupt and unreadable, and the latter two must never be overwritten.

## 6. P1: DSH project switch changes only the host cwd; a restarted engine stays in the old directory

Location: `server/dsh/dsh-agent-service.ts:5807`, `server/dsh/dsh-client.ts:150`, `:314`, `:792`.

Switching A to B updates the service cwd and then calls restart on the original runtime. restart only updates model/provider, and initialization still uses the A cwd captured at construction. The UI and file tree show B, while model operations on relative paths can still land in A.

Root fix: workspace changes create and initialize a new runtime with the target cwd and commit the switch on success; restarting the process is no substitute for migrating the runtime identity.

## 7. P1: Universal falls back to active when an old turn cannot find its owner, writing into the new project

Location: `server/universal/universal-session.ts:948`, `:1013`, `:1786`.

Turn completion finds ownership via turnConvId and falls back to activeConv on failure. Switching projects clears conversations directly without waiting for old turns to terminate. The old turn then cannot find its original session and appends the reply, tool results and stats to the new project's current session, saving with the current cwd.

Root cause: ID anchoring was added, but the mutable global active/cwd was still allowed to backstop async ownership.

Root fix: each turn captures the stable session object, cwd, driver and run generation, threading them through all callbacks and saves; an invalidated owner must not fall back to active. Switching projects should cancel and await completion, or let the old runtime finish independently.

## 8. P1: Claude and Durable share the history directory; underlying session IDs restore across engines

Location: `server/index.ts:1814`, `:1828`, `server/universal/session-store.ts:19`, `universal-session.ts:820`, `drivers/claude-code.ts:280`.

Both services use the same dataDir, and the history store distinguishes only by cwd and conversation ID. After switching engines, the other engine's record can be loaded directly and its driverSessionId passed to the current driver for resume. A Durable ID can serve as a Claude resume parameter; the reverse restore may go through target lookup failure / root fallback, and the two can even overwrite the same history file.

Root fix: add engine to the storage key and record and validate driverKind; cross-engine import may only convert messages and create a new underlying session, never reusing driverSessionId; existing data needs migration or isolation.

## 9. P1: subagent creation does not thread parent tool cancellation; it can still start after stop

Location: `server/subagents.ts:553`, `server/agent-service.ts:1296`, `:1461`.

The spawn tool receives a signal but does not pass it into the creation chain. If the parent conversation is stopped/closed while awaiting the runtime, extension binding or model recovery, creation can still register and deliver the prompt after resuming. Descendants not yet registered at close time cannot be cleaned up by descendant enumeration.

Root fix: thread the cancellation signal and the stable parent runtime identity through creation; validate before registration and the first delivery, and uniformly reclaim uncommitted resources on failure.

## 10. P1: the same conversation can be force-rebuilt concurrently, a later result overwriting the earlier

Location: `server/agent-service.ts:10822`, `:10879`, `:10930`, `:10941`.

Repeated stops produce independent timers and local forced flags, and two forced-rebuild chains can create runtimes at the same time. Commit only checks that the conversation still exists, then overwrites conv.runtime/session in turn, possibly leaving an overwritten runtime behind or replacing an instance that already accepted new messages.

Root fix: a single interrupt/reset promise per conversation; commit binds the original runtime generation, and candidate instances that lose commit eligibility must be destroyed.

## 11. P2: after approval takeover renumbering, the original AbortSignal callback no longer works

Location: `server/agent-service.ts:6302`, `:11682`, `:11817`.

The cancel callback captures the old approval id. After takeover reassigns ids and migrates entries, cancel still deletes the old id, fails, returns immediately, never settles the Promise and never cleans up the target approval; if the old id collides with another entry there is also a risk of deleting the wrong one.

Root fix: use a stable request object as the settlement identity, so the display id and the holder can migrate; cancel, answer and destroy share a one-shot settle that deletes the current holder's current entry.

## 12. P1: goal setting borrows a new generation after waiting for cleanup, so old requests cannot be reliably voided

Location: `server/goal-service.ts:691`, `:696`, `:749`, `:1383`; concurrent entry `server/dispatch-domain-handlers.ts:502`.

Setting goal A increments the generation and then waits for stopDelegated; meanwhile clearing the goal or setting B increments the generation again. A's resumption does not validate the original generation and keeps writing state, re-reading the latest generation at start, so the old request borrows the new generation to pass the guard.

Root fix: the entry captures the operation generation and verifies it after the wait and before every state write, preemption or dispatch; setting, clearing and closing share the goal transition boundary, and only the latest valid operation may commit.

## 13. P1: DNS validation is not bound to the actual connection and cannot guarantee DNS rebinding protection

Location: `server/net-guard.ts:216`, `:262`, `:285`; repeated paths `server/preset-share.ts:686`, `:707`; marketplace calls `server/market-service.ts:189`.

resolveAndValidateUrl returns validated IPs, but the actual fetch still opens the connection with the original domain and never uses those IPs. A controlled domain returns a public IP to the pre-check and an internal IP when the real connection resolves, so the internal network remains reachable. Per-hop URL/DNS validation does not close the window between check and use. This item was verified from the transport call chain without running a DNS attack reproduction.

Root fix: unify controlled HTTP transport to use a validated and pinned address for every connection while keeping the original Host/TLS servername; re-validate on each redirect hop and bind the connection; presets and the marketplace reuse the same facility.

## Remediation order and acceptance

1. First handle accidental worktree deletion, wrong workspace execution and cross-project writes, plus execution continuing after stop/delete.
2. Then fix schedule expiry semantics, config commit and engine history isolation.
3. Then close out approval identity, concurrent rebuild and the HTTP connection boundary.

Remediate around four verifiable invariants: async tasks hold stable ownership; only valid generations may commit or dispatch; publish success only after durable success; unknown state must never authorize destructive operations. Extract shared mechanisms only where a common lifecycle really exists, avoiding one oversized generic framework.

The corresponding regression should cover Git query failure, timers on time and chunked, late completion after deletion, persist failure, migration step-two failure, switching projects during generation, engine-switch restore, cancel during spawn, repeated stop, approval takeover cancel, interleaved goal set/clear, and DNS check vs. connection resolution mismatch. Do not test only the happy path.

The review also verified one suspicion that was ruled out: creating a sandbox with a 65MB file in an isolated temp directory and then applying it back to the source as-is produced skippedFiles=1, deletedFiles=0, and the source large file still existed. "Import skipping large files causes direct accidental deletion" was therefore not listed as a finding. The temp directory has been cleaned up.
