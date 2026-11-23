import type { WorktreePort } from "../packages/keel/src/contracts/worktree.js";
import { getWorktreeContext, normalizeWirePath, removeWorktree } from "./worktree-service.js";

/**
 * 宿主侧适配器：把 `worktree-service` 的三支纯函数按 `WorktreePort` 的窄面交给内核。
 *
 * 结构直通（签名逐字对齐）：porcelain 解析、脏检查、重试、平台路径归一都在 `worktree-service` 里，
 * 内核只编排「删当前工作树先回退 cwd → 删 → 刷新并发布」这条顺序。
 */
export function createCoreWorktree(): WorktreePort {
	return {
		getWorktreeContext: (cwd) => getWorktreeContext(cwd),
		removeWorktree: (cwd, targetPathInput, force, lang) => removeWorktree(cwd, targetPathInput, force, lang),
		normalizeWirePath: (p) => normalizeWirePath(p),
	};
}
