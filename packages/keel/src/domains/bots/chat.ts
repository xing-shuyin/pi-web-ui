import type { BotChatPort, BotChatTarget } from "../../contracts/bots.js";
import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { Conversation, ConversationRegistry } from "../../kernel/conversation/index.js";
import { pickBotChatConversation, sameWorkspace, type BotChatConversationRef } from "./refs.js";

/**
 * 老 `ClientSession` 的那几个口（`DispatchSession` 的结构子集）：
 * 建会话 / 切会话 / 切工作区 / 出帧都已经有单源的编排，这里只转调，**不另写一条建会话的路**。
 */
export interface BotChatDispatch {
	emitNotice(level: "info" | "warning" | "error", text: string, textEn?: string): void;
	/** 换工作区（`set_cwd` 的既有编排：重绑会话 + 宿主收尾）。 */
	setCwd(path: string): Promise<void>;
	switchConversation(id: string): Promise<void>;
	/** 打开一份转录（会话实体重绑链）。 */
	switchSession(path: string): Promise<void>;
	newChat(
		preset?: string,
		ephemeral?: boolean,
		onReady?: (id: string) => void,
		independent?: boolean,
		botId?: string,
	): Promise<boolean | void>;
	flushSnapshot(forceFull?: boolean): void;
	pushSettings?(): void;
	pushConversations?(): void;
}

export interface BotChatDeps {
	/** 本客户端的对话注册表：会话身份 / 工作目录 / 活跃指针的唯一来源。 */
	registry: ConversationRegistry<Conversation>;
	dispatch(): BotChatDispatch;
	/** Bot 私聊的宿主面；缺省 = 未接：`openBotChat` 同步抛 `CoreEngineNotReadyError`。 */
	bots?: () => BotChatPort | undefined;
	/** 当前工作区（切目录前后的判据）。 */
	cwd(): string;
	/** 收口期（断开 / 关闭中）：老实现 `quiesceBlocked()` 时直接 `false`。 */
	isBlocked?(): boolean;
}

export interface BotChatHandlers {
	openBotChat(botId: string, opts?: { fresh?: boolean }): Promise<boolean>;
	/**
	 * 这条对话属于哪个 Bot（本客户端内 `openBotChat` 认领过的）。
	 *
	 * 内核的会话聚合根还没有 `botId` 字段（只有 `kind: "bot"`），所以认领结果先记在这里：
	 * 进程内足以保证「点两次回到同一条私聊」，重启后由转录锚点（路径 2）重新认领。
	 * 会话身份补上 `botId` 之后，这张表退化成它的缓存。
	 */
	botIdOf(conversationId: string): string | undefined;
}

const UNAVAILABLE_TEXT = "这个智能体已不可用（被删除或停用），请到设备中心确认后再试。";
const UNAVAILABLE_TEXT_EN = "This agent is unavailable (deleted or disabled). Check the device center and retry.";

/**
 * Bot 私聊的入口编排（老实现 `ClientSession.openBotChat`，逐条同语义）。
 *
 * 默认是「回到**同一个**私聊」，依次尝试：
 * 1. 内存里已经开着的它的私聊 → 切过去（当前就在这条上就只重发设置/快照帧）；
 * 2. 它最近一份私聊转录（宿主 `latestTranscript`）→ 重新打开，Bot 身份按返回的对话 id 重新认领；
 * 3. 都没有 → 建一条新的（`newChat(botId)` 那条路）。
 *
 * `fresh: true` 才是「开一条新的」：跳过 1、2 直接新建；旧转录留在磁盘上，不删。
 * 失败一律走「可读 notice + `false`」，不静默、也不返回成功。
 */
export function createBotChatHandlers(deps: BotChatDeps): BotChatHandlers {
	/** conversationId → botId：内核侧唯一一份「这条私聊是谁的」（见 `botIdOf`）。 */
	const bindings = new Map<string, string>();

	const notice = (level: "info" | "warning" | "error", text: string, textEn: string): void => {
		deps.dispatch().emitNotice(level, text, textEn);
	};

	const activeId = (): string | undefined => deps.registry.activeId() || undefined;

	/** 注册表里的对话 → 判定输入（kind / 相位翻译成「能不能当私聊」）。 */
	const refs = (): BotChatConversationRef[] =>
		deps.registry.list().map((conv) => ({
			id: conv.id,
			cwd: conv.meta.cwd,
			botId: bindings.get(conv.id),
			isSubagent: conv.meta.kind === "subagent",
			nativeCli: conv.meta.kind === "cli" ? true : undefined,
			transferring: !conv.acceptsTurns,
			lastActiveAt: conv.meta.lastActiveAt,
		}));

	/** 私聊属于 Bot 自己的工作目录：先把工作区切过去，切不动就明说（否则建会话撞 `cwd mismatch`）。 */
	const ensureWorkspace = async (target: BotChatTarget): Promise<boolean> => {
		if (sameWorkspace(deps.cwd(), target.cwd)) return true;
		try {
			await deps.dispatch().setCwd(target.cwd);
		} catch (error) {
			// 换工作区失败（目录没了 / 引擎还没接上这条链）：下面统一按「切不过去」给可操作提示。
			notice(
				"error",
				`无法切换到智能体的工作目录：${target.cwd}（${(error as Error).message}）。请确认目录存在，或到设备中心修改 Bot 的工作目录。`,
				`Could not switch to the agent workspace: ${target.cwd} (${(error as Error).message}). Check that it exists, or edit the Bot workspace in the device center.`,
			);
			return false;
		}
		if (sameWorkspace(deps.cwd(), target.cwd)) return true;
		notice(
			"error",
			`无法切换到智能体的工作目录：${target.cwd}。请确认目录存在，或到设备中心修改 Bot 的工作目录。`,
			`Could not switch to the agent workspace: ${target.cwd}. Check that it exists, or edit the Bot workspace in the device center.`,
		);
		return false;
	};

	/** 回到同一个私聊：内存里开着的 → 磁盘上最近一份转录 → 都没有返回 undefined。 */
	const reopen = async (port: BotChatPort, target: BotChatTarget): Promise<boolean | undefined> => {
		const open = pickBotChatConversation(
			refs().filter((conv) => sameWorkspace(conv.cwd, target.cwd)),
			target.id,
			activeId(),
		);
		if (open) {
			if (open.id !== activeId()) await deps.dispatch().switchConversation(open.id);
			else {
				// 已经在这条私聊上：老实现也只重发设置帧 + 快照（不重建会话）。
				deps.dispatch().pushSettings?.();
				deps.dispatch().flushSnapshot();
			}
			// 编辑过 Bot 之后，已开的私聊按新配置重绑（工具/提示词/模型/记忆）。
			const conv = deps.registry.get(open.id);
			if (conv && target.name) conv.setBot(target.id, target.name);
			await port.rebindIfStale?.(open.id, target.id, target);
			return true;
		}
		const latest = port.latestTranscript(target.id, target.cwd);
		if (!latest) return undefined;
		await deps.dispatch().switchSession(latest);
		const opened = activeId() ?? deps.registry.bySessionFile(latest)?.id;
		if (!opened) return false;
		bindings.set(opened, target.id);
		const conv = deps.registry.get(opened);
		if (conv && target.name) conv.setBot(target.id, target.name);
		await port.rebindIfStale?.(opened, target.id, target);
		deps.dispatch().flushSnapshot(true);
		deps.dispatch().pushConversations?.();
		return true;
	};

	const run = async (port: BotChatPort, botId: string, fresh: boolean): Promise<boolean> => {
		if (deps.isBlocked?.()) return false;
		let target: BotChatTarget | undefined;
		try {
			target = botId ? await port.resolve(botId) : undefined;
		} catch (error) {
			notice(
				"error",
				`无法打开私聊：读不到智能体配置（${(error as Error).message}）`,
				`Could not open the private chat: the agent configuration is unavailable (${(error as Error).message})`,
			);
			return false;
		}
		if (!target) {
			// 注册表里没有 / 已停用：这条提示必须说清是「Bot 不可用」，不是「新建对话失败」。
			notice("error", UNAVAILABLE_TEXT, UNAVAILABLE_TEXT_EN);
			return false;
		}
		if (!(await ensureWorkspace(target))) return false;
		if (!fresh) {
			const reopened = await reopen(port, target);
			if (reopened !== undefined) return reopened;
		}
		try {
			const created = await deps.dispatch().newChat(undefined, false, undefined, true, target.id);
			if (created === false) return false;
			const opened = activeId();
			if (opened) {
				bindings.set(opened, target.id);
				const createdConv = deps.registry.get(opened);
				if (createdConv && target.name) createdConv.setBot(target.id, target.name);
			}
			return true;
		} catch (error) {
			notice(
				"error",
				`无法打开私聊：${(error as Error).message}`,
				`Could not open the private chat: ${(error as Error).message}`,
			);
			return false;
		}
	};

	return {
		// 不写成 async：端口缺失时抛错必须是**同步**的（wire 层这里是 `void` 调用，不能变成 unhandled）。
		openBotChat(botId: string, opts?: { fresh?: boolean }): Promise<boolean> {
			const port = deps.bots?.();
			if (!port) throw new CoreEngineNotReadyError("openBotChat");
			return run(port, (botId ?? "").trim(), opts?.fresh === true);
		},
		botIdOf: (conversationId: string) => bindings.get(conversationId),
	};
}
