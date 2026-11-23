import { resolve } from "node:path";
import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { WorkspacePort } from "../../contracts/files.js";
import type { TransportPort } from "../../contracts/ports.js";
import type { WorktreePort } from "../../contracts/worktree.js";
import type { ServerLang } from "../../i18n.js";
import type { WorktreeInfo } from "../../protocol.js";

export interface WorktreeHandlersOptions {
	/** 缺省 = 未接：每个 handler 调到时同步抛 `CoreEngineNotReadyError`（thunk 是防循环装配）。 */
	worktree?: () => WorktreePort | undefined;
	/** 切工作树 = 换工作区（老实现 `switchWorktree` 逐字就是 `setCwd`）；缺省 = 该能力未接。 */
	workspace?: () => WorkspacePort | undefined;
	/** 当前工作目录（解析目标相对路径 + 传给 git）。给 thunk 就每次现取：cwd 会随对话切。 */
	cwd: string | (() => string);
	/** 当前工作树信息（老实现读 `this.worktreeInfo`）；缺省 = 内核不知道，按「不是当前工作树」处理。 */
	currentInfo?(): WorktreeInfo | null | undefined;
	/** 发布新工作树信息（老实现 `this.worktreeInfo = info; this.flushSnapshot()`）。缺省不发。 */
	publish?(info: WorktreeInfo | null): void;
	/** 这条连接的上行通道：`notice` 帧只从这里出去。 */
	transport: TransportPort;
	/** 语言（端口 `removeWorktree` 的 `lang` 透传）。缺省 zh，与运行时其它域同口径。 */
	getLang?(): ServerLang;
}

/** 工作树面的 3 个 handler：签名与 `DispatchSession` 逐字一致。 */
export interface WorktreeHandlers {
	refreshWorktreeInfo(): Promise<void>;
	switchWorktree(path: string): Promise<void>;
	removeWorktree(path: string, force?: boolean): Promise<void>;
}

/**
 * `git worktree` 的千行细节（porcelain 解析、脏检查、重试、平台路径归一）全在宿主 `WorktreePort` 里，
 * 内核只补三件宿主不知道的事：结果要不要扔（cwd 中途变了）、删当前工作树要先回退 cwd、删完要刷新并发布。
 */
export function createWorktreeHandlers(options: WorktreeHandlersOptions): WorktreeHandlers {
	const cwd = (): string => (typeof options.cwd === "function" ? options.cwd() : options.cwd);
	const lang = (): ServerLang => options.getLang?.() ?? "zh";
	const notice = (level: "info" | "warning" | "error", text: string, textEn: string): void => {
		if (options.transport.isClosed()) return;
		options.transport.send({ type: "notice", level, text, textEn });
	};
	const port = (what: string): WorktreePort => {
		const worktree = options.worktree?.();
		if (!worktree) throw new CoreEngineNotReadyError(what);
		return worktree;
	};
	const workspace = (what: string): WorkspacePort => {
		const target = options.workspace?.();
		if (!target) throw new CoreEngineNotReadyError(what);
		return target;
	};

	/** 重读 + 发布。老实现同口径：取结果期间 cwd 变了就丢掉（否则旧目录的工作树会盖到新目录上）。 */
	const refreshWith = (worktree: WorktreePort): Promise<void> => {
		const at = cwd();
		return worktree.getWorktreeContext(at).then((info) => {
			if (cwd() !== at) return;
			options.publish?.(info);
		});
	};

	return {
		// 不用 `async` 包：端口缺失的抛错必须是**同步**的（与注册表口径一致，不能变成 rejected promise）。
		refreshWorktreeInfo(): Promise<void> {
			return refreshWith(port("refreshWorktreeInfo"));
		},

		// 解析/校验/释放旧会话/起新会话/推帧整条链归宿主 `setCwd`，它末尾自己会刷新工作树信息（老实现同序）。
		switchWorktree: (path) => workspace("switchWorktree").setCwd(path),

		removeWorktree(targetPath: string, force?: boolean): Promise<void> {
			const worktree = port("removeWorktree");
			const at = cwd();
			// 归一与「删的是不是当前工作树」的判断都是同步的：放在 async 体外面才保得住端口缺失的同步抛。
			const target = worktree.normalizeWirePath(resolve(at, targetPath));
			const info = options.currentInfo?.();
			const isCurrent = info?.currentPath === target;
			const fallback = info?.mainPath || at;
			return (async () => {
				try {
					// 删的是当前工作树就先退回仓库主目录：不能把 git 的 cwd 一边删掉一边继续用。
					// 工作区端口只在这一步需要，所以懒取——缺了不该连「删别的工作树」也挡掉。
					if (isCurrent && fallback !== target) await workspace("removeWorktree.setCwd").setCwd(fallback);
					await worktree.removeWorktree(at, target, force, lang);
					await refreshWith(worktree);
					notice("info", `🗑️ 已移除 Git 工作树：${target}`, `🗑️ Removed Git worktree: ${target}`);
				} catch (err) {
					// 删工作树不可逆。老实现只发一帧 notice 就吞掉；DoD#2 要失败不静默，
					// 所以这里两件事都做：先发 error 帧让用户看见，再把错原样抛给上层。
					const reason = (err as Error).message;
					notice("error", `移除工作树失败：${reason}`, `Failed to remove worktree: ${reason}`);
					throw err;
				}
			})();
		},
	};
}
