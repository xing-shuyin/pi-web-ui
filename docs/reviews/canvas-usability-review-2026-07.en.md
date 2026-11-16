**English** · [简体中文](./canvas-usability-review-2026-07.md) · [繁體中文](./canvas-usability-review-2026-07.zh-TW.md)

# Canvas collaboration usability review

## Conclusion and scope

The canvas already has project editing, node configuration, real engine execution, manual approval, logs, templates, custom cards and an AI tool entry point. But the current implementation suits simple serial trial runs with a human watching; conditional branches, review rework, multi-worktree code integration and multi-window co-editing are not yet solid enough to depend on as a stable automated collaboration pipeline.

This review is based on source inspection, reproductions in temporary isolated storage and the related unit tests. No paid model was called, no existing user canvas was touched, and no browser or real-device end-to-end testing was done. A separate parallel task is changing the deletion lifecycle; that item is neither re-fixed nor counted among the new defects below. Line numbers reflect the working tree at review time and may move with parallel changes.

## Existing capability and actual boundaries

| Capability                            | Implemented                                                                     | Actual boundary                                                                                                   |
| ------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Project management and graph building | List, create, rename, save, templates, cards, edges, import/export, undo/redo   | Save confirmation, switch protection and multi-window version conflicts are not closed out                        |
| Engine execution                      | Node integration, model selection and effort config for Pi/DSH/Claude/Durable   | The engine or model may fall back automatically; the configuration actually executed must be shown clearly        |
| Run control                           | Single-node/full-graph runs, stop, interjection, manual approve/reject protocol | Graph state and node state are poorly synchronized; rework and join semantics are flawed                          |
| Code isolation                        | Git worktree creation and a per-node cwd                                        | No integration workspace or artifact merge; path naming omits graph/run                                           |
| Output and evidence                   | Tool logs, node conversations, handoff summaries, timeline                      | An LLM handoff keeps only the last 300 characters of the body; run attempts and artifact versions are not modeled |
| AI graph building                     | DAG prompting, parsing, confirmation and canvas tool editing                    | The tool path can edit the graph; the UI's "smart" entry has its request and result channels disconnected         |
| Logic and data nodes                  | Roles such as condition, human, transform, join                                 | Some roles (cron/webhook/memory/loop) only pass a config summary through                                          |

## Problems to fix first

### P1: Saving and co-editing lose work

1. **Saving does not use the server's version protection and shows success as soon as it sends.** `web/src/components/canvas/CanvasStudio.tsx:757` passes no `baseRev/requestId`, ignores the send result and immediately clears the dirty flag. The server already has revision-conflict support in `server/canvas/canvas-dispatch.ts:57` and `canvas-store.ts:215`. With two tabs, or the AI and the user editing at the same time, an old topology can overwrite a new one; a disconnected send can also display as saved.
2. **Switching projects discards unsaved edits.** `CanvasStudio.tsx:1021` clears the dirty flag and then loads another graph, with no staging or save confirmation for changes made before the autosave.
3. **A broadcast from another project switches away the current one.** `CanvasStudio.tsx:196` accepts any `canvas_graph_state`; unsaved-edit protection only covers the same ID. `server/index.ts:2175` broadcasts AI graph edits to every connection, so editing A can have B's update replace A.
4. **Edit state and run state share one graph object.** The node events at `CanvasStudio.tsx:218/288` trigger whole-graph dirty detection and autosave; node events do not update graph-level status at the same time, so the run/stop buttons can show the wrong thing. A run-status change must not produce a user edit version.

### P1: Semantic breaks in flow execution and delivery

5. **Conditional branches cannot join or finish reliably.** `handleDownstreamEdges` in `server/canvas/canvas-orchestrator.ts` decides to start from whether all source nodes of incoming edges are done; an unselected branch has no skipped state. Whole-graph completion also requires every node done. Reproduced: with the true branch done and the false branch idle, the join never starts and the graph stays running.
6. **Rework edges are not bound to review decisions.** A normal completion walks reject/review/loop_back, bumps the retry count and dispatches; `reviewNode(reject)` only switches to waiting_approval and dispatches no rework. Reproduced separately: "plain completion triggers reject" and "manual rejection starts no rework". Back edges also count toward forward in-degree and join computation, and cyclic graphs have no explicit start policy.
7. **Code isolation has no integration loop.** `resolveNodeCwd` uses `.worktrees/canvas-${node.id}` and `canvas/${node.id}` with no graph/run namespace; once worktrees are enabled it returns the repository root instead of the original web/server subdirectory. The default template puts FE/BE in worktrees and QA in the main tree, and the scheduler has no step that gathers both sets of changes before verifying. A failed worktree creation also falls back to the original directory silently. Artifact commit, baseline, conflict handling, integration test directory and final adoption flow must be explicit.
8. **Node handoff loses most of the body.** `executeRealEngineNode` returns `replyText.slice(-300)` plus a diff stat. Architecture contracts, interfaces, file lists and verification evidence may be cut off, passing only the closing boilerplate. Handoff also relies on the edge's lastHandoffSummary, but `saveCanvasRuntimeState` persists only node fields and graph status, not edge summaries or loop counts; evidence and retry budgets are incomplete after a refresh/restart.

### P1/P2: UI promises that do not match real capability

9. **The "smart" graph builder never receives its result.** `App.tsx:2826` passes no lastMessage to CanvasStudio; `CanvasStudio.tsx:493` sends the prompt over an independent WS, but DAG parsing relies only on propLastMessage and the independent channel has no matching snapshot parsing. The pending state has no timeout or cancel. It should bind an explicit conversation and requestId and return a structured graph proposal.
10. **Some roles have a shape but no executor.** CANVAS_PASSTHROUGH_ROLES in `canvas-orchestrator.ts` includes cron/webhook/memory/loop. At runtime they generate a config summary and finish; that is no basis for claiming scheduled registration, webhook ingestion, persistent memory or a controllable loop. Add an executor plus acceptance per item, or label them explicitly as documentation nodes.
11. **The AI DAG schema cannot express the branching capability that already exists.** Edges at `web/src/components/canvas/canvas-dag.ts:12/88/126` carry only from/to and all become handoff after conversion, missing condition_true/false, approve/reject and node config; a generated conditional graph may execute both sides.

## Interaction and recovery problems

| Priority | Problem and impact                                                                                                                                 | Evidence                                                                                      |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| P1       | Narrow-screen toolbar has no collapse/scroll, so its internal absolute menus can be clipped; the template menu has no height cap                   | styles.css:27669/27680/27779; CanvasToolbar.tsx:389; needs browser verification of dimensions |
| P2       | Dragging does not track the pointer at 50%/200% zoom; the screen delta is not divided by zoom                                                      | CanvasNodeCard.tsx:313                                                                        |
| P2       | Touch edge dragging depends on pointerup at the target end, which the origin may implicitly capture; no hit testing or cancel cleanup              | CanvasNodeCard.tsx:288; CanvasStudio.tsx:394; needs real-device verification                  |
| P2       | A hidden canvas still responds to global Ctrl+Z/Ctrl+D/Ctrl+S/Delete                                                                               | CanvasStudio.tsx:938; App.tsx:2824                                                            |
| P2       | The log cache is keyed only by nodeId, so templates reusing node IDs bleed logs across graphs; the timeline does not load history on its own       | CanvasStudio.tsx:81/244/922; CanvasTimeline.tsx:19                                            |
| P2       | JSON import validates only the array and dangling edges, with no required-field, type or uniqueness checks on nodes, which can cause render errors | CanvasStudio.tsx:657; CanvasNodeCard.tsx:94                                                   |
| P2       | The minimap approximates with %800 mapping and a click only selects; locating does not move the viewport, and the layout ignores real card heights | CanvasStudio.tsx:823/1221/1240; canvas-p0.ts:6                                                |
| P2       | Several strings are not wired to app i18n; save/disconnect/import failures lack unified visible feedback                                           | CanvasToolbar.tsx, CanvasAiBar.tsx, CanvasNodeDrawer.tsx, canvas-client.ts                    |

## Root optimization directions

### Phase 1: Establish a trustworthy editing and run boundary

- GraphDefinition stores topology, config and positions separately with revision optimistic concurrency; RunState stores runId, graph version, per-node attempt, status and execution config.
- A save counts only on the server's success acknowledgement; a failure keeps the draft. Switching graphs saves successfully first or stores a local draft. Load responses carry a requestId; background broadcasts must not switch graphs implicitly.
- A run pins one graph version; editing produces the next version, and an old execution object must not overwrite new config.
- Wire up conversation and request ownership, timeout, cancel, error and confirmation for the smart graph builder.

Acceptance: two tabs racing a save get an explicit conflict; an offline save does not show success; A/B project updates never switch each other; run-status updates do not trigger edit saves; one smart generation runs through to confirmation and lands on the canvas.

### Phase 2: Rebuild convergent scheduling semantics

- Status distinguishes at least pending/running/succeeded/failed/skipped/cancelled/waiting_review, and every status has an explicit executable action.
- Edges activate per this round's token/decision; a join distinguishes "all activated predecessors" from "any predecessor". An unselected path is explicitly skipped.
- Loops are modeled with attempt/iteration; approval follows the main line, while a rejection returns to the named node with comments; define attempt count, timeout, cost ceiling and manual takeover.
- Graph status is derived by the scheduler from all tasks in this round, not guessed by the UI; when an error appears or no node can run, the failure/blocked reason is explicit.
- A service restart marks leftover running entries as interrupted and explicitly supports resuming, rerunning or manual confirmation; restoring only a running label is not enough.

Acceptance: a conditional diamond graph can finish; rework after rejection plus re-approval can finish; an unselected branch does not block; after a stop no successors are dispatched; a rerun does not reuse old output or retry counts.

### Phase 3: Upgrade collaboration from text handoff to artifact handoff

- The artifact envelope holds a summary, a reference to the full body, files/commit/patch, test results, baseline and originating attempt; summaries are for reading, execution takes evidence by reference.
- Worktrees are named by graphId/runId/nodeId and keep the subdirectory; a failure either reports explicitly or lets the user choose shared-directory mode.
- A dedicated integration workspace collects and merges node artifacts, resolves conflicts, and runs QA against the same integrated artifact; the final output is the diff awaiting adoption.
- Preflight engine, model, directory, Git baseline, required config and node execution capability before a run; show the fallback config actually in use.
- Scheduling has concurrency queues and budgets; write tasks in the same directory need file claims or mutual exclusion; retries must retain historical attempts.

Acceptance: changes from two isolated nodes land in the same test artifact; every file's origin is traceable; model fallback is visible; retries and recovery never mix another round's artifacts.

### Phase 4: Lower the barrier to use

First ship a few reliable templates — serial implementation, dev—test—human acceptance, isolated dev—integration; each has zero-token contract tests plus optional real-engine end-to-end checks. Then add the responsive toolbar, portal menus, drag zoom, touch edges, a real minimap and keyboard focus boundaries. Nodes without finished capability must be labeled explicitly so names alone do not create automation expectations.

## Verification this round

The temporary script uses an independent mkdtemp directory and a scheduling-entry stand-in, starting no model and creating no worktree. Output:

```json
{"probe":"branch_join","scheduled":[],"joinStatus":"idle","graphStatus":"running"}
{"probe":"unconditional_reject_edge","scheduled":["coder"],"loopCount":1}
{"probe":"human_reject","scheduled":[],"nodeStatus":"waiting_approval"}
```

Running the five Vitest groups canvas-orchestrator, canvas-history, canvas-cards, canvas-picker-isolation and canvas-pstack-skills: 49 of 50 pass, 1 fails. The failure is the review-loop test expecting 2 and getting 1, related to the run-graph identity check the parallel lifecycle fix added; it has been handed to the fixing side to check the fixture, and the current working tree must not be called fully green. Passing tests also do not mean browser interaction, touch and real multi-model pipelines have been verified.

This report only adds a review document; no business implementation was changed.
