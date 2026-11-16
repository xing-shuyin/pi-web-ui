**English** · [简体中文](./daily-ai-maintainer-setup.md) · [繁體中文](./daily-ai-maintainer-setup.zh-TW.md)

# Daily GitHub maintenance canvas

Saved the project and enabled the daily task without running it immediately.

- Project name: daily GitHub Issue and PR maintenance.
- Project ID: `graph_1793377347784_-GitHub-Issue-PR-`.
- Scheduled task ID: `task-pdjues`, cron `0 9 * * *`, enabled.
- Verified the local timezone is `Asia/Shanghai`, i.e. 09:00 Beijing time every day; next run 2026-10-31 09:00.
- 8 nodes and 7 dependency edges in total. The old project and the old task were deleted.

Node order: startup verification → full GitHub collection → triage and prioritization → PR static review and implementation → independent line-by-line re-check → hands-on validation of the combined artifact → single merged publish and reply → status archive.

Scope is limited to GitHub issues, PRs, reviews and comments plus the related npm/GitHub Release publishing. No connections or permissions for other community platforms are needed.

The node directory is `E:/pi-web-ui`, the engine is pi, and the model is left empty to follow the default configuration. The implementation, re-check and validation nodes enable an isolated worktree, and the source baseline must be clean. Running third-party code still requires a container or VM; worktree isolation is not a substitute for an execution sandbox.

The first run verifies GitHub permissions, a private state directory outside the repository, a reliable lock and an isolated execution environment; a missing capability is reported as a blocker and must not be faked as a passing validation. Outbound write operations are concentrated in the publish node, and a completed edge does not mean review and protection rules can be skipped.

The backup project is `daily-ai-maintainer.canvas.json` and can be restored by importing the JSON into the canvas; importing generates a new ID, so the scheduled task must be re-bound on restore to avoid enabling it twice. The full spec is in `../daily-ai-maintainer-workflow.md` and is already embedded in the node instructions.
