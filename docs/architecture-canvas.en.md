**English** · [简体中文](./architecture-canvas.md) · [繁體中文](./architecture-canvas.zh-TW.md)

# Canvas collaboration: edit revisions, runs, and artifacts

The canvas entry point is `web/src/components/canvas/CanvasStudio.tsx`, with a dedicated WebSocket in `canvas-client.ts`. The server protocol single source of truth is `server/protocol.ts`; `canvas-dispatch.ts` handles user requests, `canvas-agent-tool.ts` provides the AI edit and debugging entry points. Both share the same storage and orchestrator.

## Localization

Canvas UI and built-in template display strings live in `web/src/i18n/messages/canvas/`, backend system state and logs in `canvas-runtime/`; both modules maintain all 14 languages and share the global translation runtime. The backend broadcasts message keys and parameters, and each browser renders them in its own current language; user content and AI replies keep their original text. See [`i18n.md`](i18n.en.md) for dictionary maintenance, compatibility fields, and the sync workflow.

## Conversation invocation and references

The composer `@` candidates include saved canvas projects, searchable as `@画布`, `@canvas`, `@工作流` or by name. The list is requested over the current chat connection; lists are not cached across projects. Selecting one sends a `mode: "canvas"` attachment whose `path` stores the stable graphId. A reference does not start the workflow and is not read as a workspace file.

After validating the project exists, the server injects a slim `<canvas-ref>`; the model first reads the latest configuration through `canvas`'s `get`, then calls `run_all`, `stop` or `get_log` per the user's request. With lazy loading enabled, the pi session loads existing tools for the captured target session/conversation, preserving switches, presets, and permission gates; an unavailable tool shows a notice instead of silently loosening permissions.

## Editing and saving

`CanvasGraph.rev` only increases with topology saves; run progress does not advance the edit revision. Saves carry `baseRev` and `requestId`; only a successful server acknowledgement confirms the save. A conflict returns `canvas_error/rev_conflict` plus the authoritative graph; never overwrite with a stale graph or treat a conflict as success.

Topology saves preserve on-disk node and edge run fields and `graph.run`, so an old browser snapshot cannot wipe progress. Run-state saves merge only run fields with the same ID; they cannot roll back node configuration or resurrect a deleted graph. Canvas load responses bind to the request; broadcasts for other graphs must not switch the current project. Drafts and logs are isolated per graphId.

`canvas-validation.ts` validates nodes, edges, enums, uniqueness, endpoints, size, and forward acyclicity; restricted rework edges do not participate in the forward-cycle check. Imports and AI edits must pass validation too. Tool details stay under 64KB; large graphs can be retrieved through the text result.

Dynamic canvas tool copy returned by `pick()` must pass interpolation variables explicitly, with key names byte-identical to the `{表达式}` (expression) slots in the `serverStrings` language pack (such as `"card.title"`, `"nodes.length"`), so users never receive unsubstituted placeholders.

## Scheduled triggers

Built-in scheduled tasks support `target: "canvas"` and a stable `graphId`; the panel and the `schedule` tool share the same storage and cron/interval/one-shot rules. Legacy tasks without a target keep running the conversation. Saving a canvas task validates that the project exists and the graph structure is valid; on trigger the latest configuration is re-read, and the task prompt and cwd are passed as this round's input and run root, without changing each node's engine or model.

`canvas-scheduled-task.ts` reuses the same `CanvasOrchestrator.runAll`, waits for that round's result, and stores graphId/runId in the task history. Manual approval pause, blocking, errors, cancellation, deletion, or a replaced run must never be reported as complete; the orchestrator rejects re-entry for the running and pending-approval state of the same project. After the canvas is deleted, scheduled tasks fail instead of resurrecting the default project. One-shot task consumption is persisted by `SchedulerStore`; a failed record still advances the in-memory state, so no tick re-executes it.

## Each round's execution

`CanvasGraph.run` records the run ID, starting graph revision, start/end time, and scope. A node's runId, attempt, artifact, and actual engine/model are run state; edge activation, handoff, and rework counts must also be persisted.

Scheduling judges predecessor readiness from this round's activated edges. Unselected branches are marked skipped, so branch joins do not wait for nodes that will never execute. Approval and rejection have separate edges; rework is bounded, and reject/review/loop_back must not fire unconditionally as ordinary completion edges. Stop and delete revoke the run generation; cancellation and identity must be checked across awaits, and an old execution must not clear a new one or keep dispatching.

Service startup calls `markInterruptedCanvasRuns`, marking leftover on-disk running/queued runs as paused and recording the interruption reason; an on-disk run label cannot stand for a real engine that still exists. Recovery completes through an explicit rerun.

Roles with no deterministic executor yet, such as cron, webhook, memory, and loop, must not fake success. An unavailable engine or model must fail explicitly; never silently substitute one while the UI still shows the original configuration.

## Git isolation and artifacts

`canvas-workspace.ts` provides the three canvas boundaries prepare/capture/cleanup; the shared async Git, path and worktree identity validation, scratch index snapshots, and patch primitives live in `server/workspace-handle.ts`. Device code tasks adapt the same primitives through a separate `device-center/task-workspace.ts`, without borrowing graph/run/node identity; see [`device-collaboration.md`](device-collaboration.en.md#21-versioned-contracts-and-code-tasks) for protocol and evidence constraints. Canvas types, artifact-layer semantics, and the public API remain maintained by this adapter layer. Isolated directories live under dataDir/canvas/workspaces/graph/run/node-attempt, using a detached worktree and preserving the original cwd subdirectories. User branches are never reset, auto-committed, or merged into the main tree.

Isolation requires local Git and a clean source baseline; unsupported SSH/non-Git isolation, dirty baselines, path escapes, and creation failures all fail explicitly rather than falling back to a shared directory. dataDir must be outside the source repository.

Node artifacts use a temporary Git index to generate trees and binary patches, covering tracked, deleted, and non-ignored new files without modifying the user's index. Artifact layers include SHA-256, a unified baseline, and provenance, deduplicating common ancestors in order. When downstream has upstream isolated artifacts, upstream layers are applied in the integration worktree even with useWorktree=false; conflicts stop and keep the workspace. QA therefore verifies the combined artifact.

`CanvasArtifact` keeps the full delivery body and workspace evidence; the short summary is for reading only. Pending patches and workspaces are kept for user inspection and never auto-written back to the main branch. Cleanup is explicit and non-forced, removing only isolated directories that are clean and produced no extra commits, and never deleting artifacts.

## Verification

Relevant unit tests are named `canvas-*` and cover save acknowledgement/conflict, reconciliation after a dropped ACK on disconnect, run state not overwriting topology, late completion after deletion, branch joins, approval rework and artifact inheritance, templates and imports, pure interaction algorithms, and artifact integration against a temporary Git repository. Tests must not use the user's canvases, real models, or modify user repositories.

`node tests/canvas-browser-test.mjs` uses `tests/lib/ensure-build.mjs` and a Chrome probe to start an isolated server and verify first-screen project loading, save ACK and draft cleanup, Portal menus, zero-token conditional joins, background runs that do not switch graphs, and 390px narrow-screen layout. Screenshots go to `.artifacts/canvas/`. Real engines and physical touchscreen experience still need separate validation.
