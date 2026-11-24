import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ConversationId } from "../../contracts/ids.js";
import type { WorkspacePort } from "../../contracts/files.js";
import type { WorkspaceHostPort, WorkspaceTarget } from "../../contracts/workspace.js";
import type { Conversation, ConversationRegistry } from "../../kernel/conversation/index.js";
import { isRemoteWorkspaceUri } from "../../remote-workspace.js";
import { rebindSession, type RebindFrames, type RebindSessions } from "./rebind.js";

/** 额外根的读写口（宿主设置存储的窄面）；缺省 = 只活在内存里。 */
export interface WorkspaceRootsStore {
	getRoots(cwd: string): readonly string[];
	saveRoots(cwd: string, roots?: readonly string[]): readonly string[];
}

export interface WorkspaceSwitcherOptions {
	registry: ConversationRegistry<Conversation>;
	sessions: RebindSessions;
	frames: RebindFrames;
	createConversation(init: { cwd: string }): Conversation;
	onActivated?(conversationId: ConversationId): void;
	/** 当前工作区（换完就变）。 */
	cwd(): string;
	/** 当前额外根（换完就变）。 */
	roots(): readonly string[];
	setWorkspace(cwd: string, roots: readonly string[]): void;
	store?: WorkspaceRootsStore;
	/** 宿主的目标解析与收尾；缺省 = 只认本地绝对/相对路径。 */
	host?: WorkspaceHostPort;
	notice(level: "info" | "warning" | "error", text: string, textEn: string): void;
}

function sameRoots(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * 缺省解析（没有宿主适配器时）：只做 `~` 展开与相对路径归一，然后 stat 一次确认是目录。
 * 远程工作区 URI 不在这里猜——会话目录跟 cwd 分离是宿主知识，缺宿主就明确拒绝。
 */
async function defaultResolveTarget(input: string, from: string): Promise<WorkspaceTarget> {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("路径为空");
	if (isRemoteWorkspaceUri(trimmed)) throw new Error("远程工作区需要宿主适配器解析会话目录");
	const home = homedir();
	const base = isRemoteWorkspaceUri(from) ? home : from;
	const expanded =
		trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? join(home, trimmed.slice(1)) : trimmed;
	const abs = resolve(base, expanded);
	const info = await stat(abs);
	if (!info.isDirectory()) throw new Error("路径不是目录");
	return { cwd: abs };
}

/**
 * `WorkspacePort` 的内核实现：换工作区 = 一次会话实体重绑（`rebindSession`），外加额外根的持久化。
 *
 * 老树把整条链写在 `ClientSession.setCwd` 里（约 150 行），沙盒 / 工作树 / 建目录都要调它。
 * 现在只有这一份实现，三个域的 `workspace.setCwd(path)` 直接落到这里。
 */
export function createWorkspaceSwitcher(options: WorkspaceSwitcherOptions): WorkspacePort {
	const rebindCtx = {
		registry: options.registry,
		sessions: options.sessions,
		frames: options.frames,
		createConversation: (init: { cwd: string }) => options.createConversation(init),
		...(options.onActivated ? { onActivated: options.onActivated } : {}),
		notice: options.notice,
	};

	/** 换完工作区的共同收尾：更新运行时状态 → 宿主收尾（失败只警告，不撤已生效的切换）。 */
	const commit = async (target: WorkspaceTarget): Promise<void> => {
		const roots = options.store?.getRoots(target.cwd) ?? [];
		options.setWorkspace(target.cwd, roots);
		try {
			await options.host?.onChanged?.(target.cwd, roots);
		} catch (error) {
			options.notice(
				"warning",
				`工作目录已切换，但宿主收尾失败：${(error as Error).message}`,
				`Workspace switched, but host post-processing failed: ${(error as Error).message}`,
			);
		}
	};

	return {
		// 不用 `async` 包：端口缺失的抛错必须是**同步**的，异步体从解析目标之后才开始。
		setCwd(path: string): Promise<void> {
			const from = options.cwd();
			const resolveTarget = options.host?.resolveTarget ?? defaultResolveTarget;
			return resolveTarget(path, from).then(async (target) => {
				if (target.cwd === from) {
					options.notice("info", `已在工作目录：${target.cwd}`, `Already in directory: ${target.cwd}`);
					options.frames.flush(false);
					return;
				}
				await rebindSession(rebindCtx, {
					cwd: target.cwd,
					...(target.sessionCwd ? { sessionCwd: target.sessionCwd } : {}),
				});
				await commit(target);
			});
		},

		async setWorkspaceRoots(roots?: string[]): Promise<void> {
			const cwd = options.cwd();
			const before = options.store?.getRoots(cwd) ?? [...options.roots()];
			const saved = options.store
				? (options.store.saveRoots(cwd, roots ?? []), options.store.getRoots(cwd))
				: [...(roots ?? [])];
			// 归一后没变就不动（老口径：设置页反复保存同值不刷新帧）。
			if (sameRoots(before, saved)) return;
			options.setWorkspace(cwd, saved);
			try {
				await options.host?.onChanged?.(cwd, saved);
			} catch (error) {
				options.notice(
					"warning",
					`额外工作区根已保存，但宿主收尾失败：${(error as Error).message}`,
					`Workspace roots saved, but host post-processing failed: ${(error as Error).message}`,
				);
			}
			options.frames.flush(false);
		},
	};
}
