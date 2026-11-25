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
	/** 切换进度（`transition_progress` 的 `kind: "cwd"` 一支）：开始/完成/失败都要告诉客户端。 */
	progress?(kind: "cwd" | "session", target: string, phase: "done" | "error", text: string, textEn: string): void;
	/** 换完后的文件树重列（文件域的宿主端口自己出 `files` 帧）；缺省 = 骨架不动。 */
	refreshFiles?(): void | Promise<void>;
	/** 换掉旧对话之前的保留判定（老 `displaceActive`）：见 `domains/sessions/retain.ts`。 */
	shouldRetainPrevious?(conversation: Conversation): boolean;
	/** 保留的旧对话要记进运行列表（老 `conv.listed = true`）；缺省 = 只保留、不列入。 */
	markListed?(conversationId: ConversationId): void;
	/** 设置项 `openRecentSessionOnProjectSwitch`（老 `setCwd` 的 `openRecent`）；缺省 `false` = 不恢复。 */
	openRecentSession?(): boolean;
	/** 目标工作区最近一份转录（宿主扫盘：内核不拼 SDK 目录布局）；拿不到就返回 `undefined`。 */
	mostRecentSession?(cwd: string): Promise<string | undefined>;
	/** 转录占用查询（老 `findSessionOwner`）：别的页面正开着 / 正在跑时不恢复，避免两个写者。 */
	sessionOwner?(file: string): { connected?: boolean; isStreaming?: boolean } | undefined;
}

/** 换工作区失败时的用户可见文案：`set_cwd` / `/cwd` / 上传进度三条入口共用一份，不各写一句。 */
export function workspaceSwitchFailure(error: unknown): { text: string; textEn: string } {
	const reason = (error as Error)?.message ?? String(error);
	return { text: `切换工作目录失败：${reason}`, textEn: `Failed to switch workspace: ${reason}` };
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
		...(options.shouldRetainPrevious ? { shouldRetainPrevious: options.shouldRetainPrevious } : {}),
		...(options.markListed ? { markListed: options.markListed } : {}),
		notice: options.notice,
	};

	/**
	 * 老 `setCwd` 的 `openRecent`：切项目时恢复该项目的最近会话（而不是新建空白会话）。
	 *
	 * 三道闸，顺序与老实现一致：设置项 → 扫得最近文件 → 占用检查。
	 * 占用检查（老 `resumeSkipped`：`owner.connected || owner.isStreaming`）必须留：同一份转录两个写者会互相覆盖。
	 * 扫盘失败 / 拿不到文件 = 不恢复（老实现在这里会回退到 `continueRecent`；内核没有那个原语，不自拼目录布局）。
	 */
	const resumeTarget = async (target: WorkspaceTarget): Promise<string | undefined> => {
		if (options.openRecentSession?.() !== true) return undefined;
		const recent = await options.mostRecentSession?.(target.cwd);
		if (!recent) return undefined;
		const owner = options.sessionOwner?.(recent);
		if (owner?.connected === true || owner?.isStreaming === true) return undefined;
		return recent;
	};

	/**
	 * 换工作区的唯一提交点：**先把运行时状态切过去**，再重绑会话，最后宿主收尾。
	 *
	 * 重绑目标本身由 `resumeTarget` 裁定（老口径：恢复该项目最近会话或新建空白会话）。
	 *
	 * 顺序不能再反：重绑末尾那一帧是客户端看到新工作区的唯一机会（`setWorkspace` 到它之前生效），
	 * 先切状态才会出「新对话 + 新目录」的一帧，而不是「新对话 + 旧目录」然后再等下一次 flush
	 * （那个 flush 还会被合并闸当成 too-soon 吞掉）。
	 * 重绑失败 → 状态回滚 + 补一帧，旧工作区与旧会话仍然可用。
	 */
	const switchWorkspace = async (target: WorkspaceTarget): Promise<void> => {
		const previousCwd = options.cwd();
		const previousRoots = [...options.roots()];
		const roots = options.store?.getRoots(target.cwd) ?? [];
		options.setWorkspace(target.cwd, roots);
		try {
			// 扫盘是宿主的活，抛错就当「不知道最近的哪一份」：宁肯新建，也不拿半熟路径去重绑。
			const recent = await resumeTarget(target).catch(() => undefined);
			await rebindSession(rebindCtx, {
				cwd: target.cwd,
				...(target.sessionCwd ? { sessionCwd: target.sessionCwd } : {}),
				...(recent ? { sessionFile: recent } : {}),
			});
		} catch (error) {
			options.setWorkspace(previousCwd, previousRoots);
			// 重绑自己发过一帧（带的是新 cwd）：回滚状态之后要再把客户端拨回旧工作区。
			options.frames.flush(true);
			throw error;
		}
		try {
			await options.host?.onChanged?.(target.cwd, roots);
		} catch (error) {
			options.notice(
				"warning",
				`工作目录已切换，但宿主收尾失败：${(error as Error).message}`,
				`Workspace switched, but host post-processing failed: ${(error as Error).message}`,
			);
		}
		options.progress?.(
			"cwd",
			target.cwd,
			"done",
			`已切换到工作目录：${target.cwd}`,
			`Switched to directory: ${target.cwd}`,
		);
		// 文件树跟着工作区走：不重列的话客户端还画着上一个目录的文件（老实现 setCwd 末尾同样刷新）。
		void options.refreshFiles?.();
	};

	return {
		// 不用 `async` 包：端口缺失的抛错必须是**同步**的，异步体从解析目标之后才开始。
		setCwd(path: string): Promise<void> {
			const from = options.cwd();
			const resolveTarget = options.host?.resolveTarget ?? defaultResolveTarget;
			return resolveTarget(path, from)
				.then(async (target) => {
					if (target.cwd === from) {
						options.notice("info", `已在工作目录：${target.cwd}`, `Already in directory: ${target.cwd}`);
						options.frames.flush(false);
						return;
					}
					await switchWorkspace(target);
				})
				.catch((error: unknown) => {
					// 失败也要出帧（老实现同口径：progress 的 error 支 + 上层自己发 notice），错误原样上抛。
					const { text, textEn } = workspaceSwitchFailure(error);
					options.progress?.("cwd", path.trim(), "error", text, textEn);
					throw error;
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
