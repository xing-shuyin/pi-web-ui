import type { ServerLang } from "../i18n.js";
import type { WorktreeInfo } from "../protocol.js";

/**
 * Git 工作树面（宿主能力）。
 *
 * 方法集就是宿主 `server/worktree-service.ts` 里这 3 个 handler 用到的那三支公有导出
 * （`getWorktreeContext` / `removeWorktree` / `normalizeWirePath`），签名逐字对齐、不加抽象：
 * `git worktree` 的 porcelain 解析、脏检查、重试、平台路径归一全归宿主，内核只编排
 * 「删当前工作树先回退 cwd → 删 → 刷新并发布」这条顺序。宿主侧适配器：`server/core-worktree-adapter.ts`。
 */
export interface WorktreePort {
	/** 读 `cwd` 所在仓库的工作树全貌；不在 git 仓库里或读失败返回 null（宿主同口径，不抛）。 */
	getWorktreeContext(cwd: string): Promise<WorktreeInfo | null>;
	/**
	 * `git worktree remove`：脏检查（`force` 才跳过）与三次重试都在实现里。
	 * `cwd` 是跑 git 的仓库目录，`targetPathInput` 可以是工作区相对路径。
	 */
	removeWorktree(cwd: string, targetPathInput: string, force?: boolean, lang?: () => ServerLang): Promise<void>;
	/**
	 * 线径归一（反斜杠 → 正斜杠、Windows 盘符大写）。
	 * 内核需要它只为一件事：把端口给的 `currentPath` 与用户传的目标路径摆到同一个坐标系里比。
	 * 自己拼一遍就是第二套归一，Windows 上必然对不上。
	 */
	normalizeWirePath(p: string): string;
}
