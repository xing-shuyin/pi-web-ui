import { resolve } from "node:path";
import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { ConversationId } from "../../contracts/ids.js";
import type { Conversation, ConversationRegistry } from "../../kernel/conversation/index.js";
import { restoreWorkspaceUriFromSessionDir } from "../../remote-workspace.js";
import { readCwdFromSessionHeader } from "../../session-search.js";
import type { RebindFrames, RebindRequest, RebindResult } from "./rebind.js";

export interface SessionEntityOptions {
	registry: ConversationRegistry<Conversation>;
	/** 重绑原语（`rebindSession` 绑定上下文后的调用口）；缺省 = 该能力未接。 */
	rebind?: (request: RebindRequest) => Promise<RebindResult>;
	/**
	 * 切到**已经开着**的对话时的腾位口（老 `switchConversation` → `displaceActive`）：
	 * 装配层接 `displacePrevious(rebindCtx, conversation)`。缺省 = 不腾位（旧对话原封不动留着）。
	 */
	displace?(conversation: Conversation): void;
	/**
	 * 记进运行列表（老 `switchSession` 里打开会话时的 `conv.listed = true`）：
	 * 不记的话，从历史打开的对话一旦切走就从运行列表消失（它没有标题/内容撑着 `inRunningList`）。
	 */
	markListed?(conversationId: ConversationId): void;
	/**
	 * 标记「用户真的用过它」（老 `switchSession` 里的 `conv.promptedSinceActive = true`）：
	 * 保留判据（`listed && promptedSinceActive`）靠它，否则切回已打开的对话时窗口要从盘上重开。
	 */
	markPrompted?(conversationId: ConversationId): void;
	frames: RebindFrames;
	/** 当前工作区：转录 header 里读不出 cwd 时用它兜底。 */
	cwd(): string;
	/** 允许打开哪些转录（缺省 fail-closed：一律拒绝）。装配层按 `agentDir/sessions` 注入。 */
	isAllowedPath?(path: string): boolean;
	/** 已开会话的 `sessionId`（客户端可以只给 id 不给路径）。 */
	openSessionIdOf?(conversationId: string): string | undefined;
	/** 打开成功后把「历史根 = 这份转录所在目录」交给出帧层。 */
	noteSessionFile?(file: string | undefined): void;
	notice(level: "info" | "warning" | "error", text: string, textEn: string): void;
	/** 跨客户端会话占用查询：避免双写或误判 */
	/** 占用者身份 + 状态：`clientId` / `conversationId` 是用来发起自动过户的（issue #567）。 */
	findSessionOwner?: (
		sessionFile: string,
	) => { title: string; isStreaming: boolean; clientId: string; conversationId: string } | undefined;
	/**
	 * 「这条对话在另一处开着（且没在跑）」→ 把它过户到本页再继续打开（老实现 `switchSession` 的
	 * `takeOverConversationElsewhere`）。缺省 = 不做过户，只提示「已同时打开」（两份写者会互相覆盖）。
	 */
	takeOverElsewhere?(owner: { clientId: string; conversationId: string }): Promise<void>;
	/** 进度帧（客户端据此收起切换蒙层）：`done` 才落定，`error` 明确失败。 */
	progress?(kind: "cwd" | "session", target: string, phase: "done" | "error", text: string, textEn: string): void;
}

export interface SessionEntityHandlers {
	switchSession(path: string, sessionId?: string, independent?: boolean): Promise<void>;
	/**
	 * 换活动对话前的腾位（老 `displaceActive`）：保留（记进运行列表）/ 否则退役并释放。
	 * `switchSession` 的复用路径已经在内部走它；`switchConversation` / `new_chat` 也要走同一份。
	 */
	displace(conversation: Conversation): void;
}

/** 会话 header 里的真实 cwd（远程工作区 URI 会先还原）；读不出来就用当前工作区兜底。 */
async function ownerCwdOf(sessionFile: string, fallback: string): Promise<string> {
	try {
		const headerCwd = restoreWorkspaceUriFromSessionDir((await readCwdFromSessionHeader(resolve(sessionFile))) ?? "");
		return headerCwd || fallback;
	} catch {
		return fallback;
	}
}

/**
 * 会话实体入口：`switchSession`（打开一份转录并把工作区切过去）。
 *
 * 它与 `setCwd` / 换工作树 / 沙盒共用同一个重绑原语，区别只在「目标从哪来」：
 * 换目录看路径，切会话看转录 header 里的 cwd。`independent` 是客户端的「常驻行」提示，
 * 内核没有对应状态（左栏归属由 `conversation-rows` 的单源裁定），这里明确不参与。
 */
export function createSessionEntityHandlers(options: SessionEntityOptions): SessionEntityHandlers {
	const rebindOf = (what: string): ((request: RebindRequest) => Promise<RebindResult>) => {
		const rebind = options.rebind;
		if (!rebind) throw new CoreEngineNotReadyError(what);
		return rebind;
	};
	const progress = options.progress;

	/** 已经开着的对话直接用（老口径：同一份转录不重复建，避免两个写者）。 */
	const reuse = (conversation: Conversation, target: string): void => {
		// 老口径：切到已经开着的对话也要先腾位（`switchConversation` → `displaceActive`），
		// 否则正在跑的那条既未被保留也未被退役——它这一轮跑完就再也不会出现在运行列表里。
		const active = options.registry.activeConv();
		if (active && active.id !== conversation.id) options.displace?.(active);
		options.registry.activate(conversation.id);
		// 老 `switchSession` 打开历史会话时记的 `conv.listed = true`：用户是明确回来看它的。
		options.markListed?.(conversation.id);
		options.markPrompted?.(conversation.id);
		options.noteSessionFile?.(target);
		options.frames.flush(true);
		void options.frames.pushSessions?.();
		options.frames.pushConversations?.();
		progress?.("session", target, "done", "会话加载完成", "Session loaded");
	};

	/** 真正去打开（检查路径 → 复用已开的 → 重绑）：过户之后也走这里。 */
	const openTarget = (target: string, rebind: (request: RebindRequest) => Promise<RebindResult>): Promise<void> => {
		const isAllowedPath = options.isAllowedPath;
		if (isAllowedPath && !isAllowedPath(target)) {
			options.notice(
				"error",
				"只能打开会话目录中的对话记录",
				"Only transcripts inside the session directory can be opened",
			);
			options.frames.flush(false);
			return Promise.resolve();
		}
		const holder = options.registry.bySessionFile(target);
		if (holder) {
			reuse(holder, target);
			return Promise.resolve();
		}
		const fallback = options.cwd();
		return ownerCwdOf(target, fallback).then(async (cwd) => {
			try {
				const result = await rebind({ cwd, sessionFile: target });
				// 先从历史打开的对话也要先进运行列表（老 `switchSession` 的 `conv.listed = true`）：
				// 它此刻是活动对话、标题还是默认值，`inRunningList` 不会自己收它。
				options.markListed?.(result.conversation.id);
				// 老 `switchSession` 同一处的 `conv.promptedSinceActive = true`：从历史里明确打开过 = 用户用过它，
				// 换对话时要保留（否则切回来只能从盘上重开，已展开的历史窗口丢了）。
				options.markPrompted?.(result.conversation.id);
				options.noteSessionFile?.(target);
				// 重绑末尾那一帧是「已列出」之前的，再推一次运行列表，客户端手上的那一行才不会凭空消失。
				options.frames.pushConversations?.();
				progress?.("session", target, "done", "会话加载完成", "Session loaded");
			} catch (error) {
				const message = (error as Error).message;
				progress?.("session", target, "error", `会话加载失败：${message}`, `Failed to load session: ${message}`);
				options.notice("error", `打开会话失败：${message}`, `Failed to open session: ${message}`);
			}
		});
	};
	return {
		// 先腾位再换指针（`reuse` 与两个换对话入口共用这一份，不另写判据）。
		displace: (conversation: Conversation) => options.displace?.(conversation),
		// 不用 `async` 包：端口缺失的抛错必须是**同步**的（wire 层这里是 `void` 调用，不能变成 unhandled）。
		switchSession(path: string, sessionId?: string, _independent?: boolean): Promise<void> {
			const rebind = rebindOf("switchSession");
			const wanted = (sessionId ?? "").trim();
			const trimmed = (path ?? "").trim();
			if (!trimmed) {
				// 只给 id：本进程里开着的会话可以直接切过去，没开着的需要路径（按 id 找盘上的转录是宿主知识）。
				const opened = wanted
					? options.registry.list().find((conv) => options.openSessionIdOf?.(conv.id) === wanted)
					: undefined;
				if (opened) {
					reuse(opened, opened.meta.sessionFile ?? wanted);
					return Promise.resolve();
				}
				options.notice(
					"warning",
					wanted ? `未找到会话：${wanted}` : "缺少会话路径",
					wanted ? `Session not found: ${wanted}` : "Session path is missing",
				);
				options.frames.flush(false);
				return Promise.resolve();
			}

			const target = resolve(trimmed);
			const owner = options.findSessionOwner?.(target);
			if (owner?.isStreaming) {
				options.notice(
					"warning",
					`该对话正在另一处运行中（「${owner.title}」），为避免两个 agent 同时写同一份记录，已停止打开。请等它结束后再试，或回到原窗口继续。`,
					`This conversation is running in another window ("${owner.title}"). Opening it here would create a second writer for the same transcript, so it was blocked. Wait for it to finish, or continue in the original window.`,
				);
				options.frames.flush(false);
				return Promise.resolve();
			}
			if (owner && !owner.isStreaming && options.takeOverElsewhere) {
				// 别处开着、没在跑：先过户（跨客户端单一写者），过完这条对话已经在本页的注册表里了。
				// 不用 `async` 包：端口缺失的抛错必须是同步的（见函数头注释）。
				const takeOver = options.takeOverElsewhere;
				return takeOver({ clientId: owner.clientId, conversationId: owner.conversationId }).then(() => {
					const moved = options.registry.bySessionFile(target);
					if (moved) {
						reuse(moved, target);
						return;
					}
					// 过户没把对话带过来（失败/对方已关）：落回正常打开，别让动作静默消失。
					return openTarget(target, rebind);
				});
			}
			if (owner && !owner.isStreaming) {
				options.notice(
					"info",
					`该对话在另一处也开着（「${owner.title}」），这里已同时打开。若两边同时发送，两个 agent 会分别写记录，请避免并发操作。`,
					`This conversation is also open in another window ("${owner.title}"). Opened here as well; avoid sending from both sides concurrently to prevent conflicting transcript writes.`,
				);
			}
			return openTarget(target, rebind);
		},
	};
}
