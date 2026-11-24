import { createSessionEditor, type EditSessionHost } from "../adapters/sdk/session-edits.js";
import type { AttachmentsPort } from "../contracts/attachments.js";
import type { SlashCommandActions, SlashCommandsPort, SlashThinkingLevel } from "../contracts/commands.js";
import type { Conversation, ConversationRegistry } from "../kernel/conversation/index.js";
import type { TransportPort } from "../contracts/ports.js";
import type { WorkspacePort } from "../contracts/files.js";
import type { PromptAttachment } from "../protocol.js";
import type { ClientSettings } from "../settings-schema.js";
import type { SnapshotPublisher } from "../domains/snapshots/index.js";
import { appendAttachmentAsides } from "../domains/turns/index.js";
import { workspaceSwitchFailure } from "../domains/sessions/workspace.js";

/** 附件 asides 要真会话实体（图片/视觉桥接看当前模型）：只列用到的那两个方法。 */
export interface PromptEntrySessions {
	get(conversationId: string): { session: unknown } | undefined;
	ensure(conversation: Conversation): Promise<{ session: unknown }>;
}

/**
 * 提示词入口的装配面：**只列真正用到的成员**（与 `DispatchRuntime` 同一手法）。
 *
 * 为什么单独一个文件：`prompt` / `new_chat` / 编辑重问三条入口共用同一套语义
 * （斜杠命令优先、附件先落进会话、空白对话复用、出帧），把它们留在分发表里会
 * 让「装配」长出业务；这里只认这几件现成东西，域之间仍然互不认识。
 */
export interface PromptEntryDeps {
	clientId: string;
	registry: ConversationRegistry<Conversation>;
	/** 连接已经被换掉 / 卸掉：之后一律不再出帧、不再喂轮。 */
	isDisposed(): boolean;
	/** 会话实体；缺省 = 附件 asides 无处可落（fail-closed 地说一声）。 */
	sessions?: PromptEntrySessions;
	transport: TransportPort;
	publisher: SnapshotPublisher;
	/** 运行列表帧（新建对话后必须推：客户端据此换到新对话）。 */
	pushConversations(): void;
	/** 唯一喂轮出口。 */
	feedTurn(text: string, queue?: boolean): Promise<void>;
	/** 只注册并激活一条对话（`botId` → 会话级 Bot 身份）。 */
	createConversation(init?: Partial<{ kind: "bot"; ephemeral: boolean }>): Conversation;
	/** 换工作区（`/cwd` 走它：重绑 + 帧 + 宿主收尾都在里面）。 */
	workspace(): WorkspacePort;
	setModel(modelId: string): Promise<void>;
	setThinking(level: SlashThinkingLevel): void;
	setPlanMode(enabled: boolean): Promise<void>;
	/** 计划模式的当前值（与快照同一个投影源）。 */
	planModeOf(): boolean;
	refreshSessions(): Promise<void>;
	slash?: () => SlashCommandsPort | undefined;
	attachments?: () => AttachmentsPort | undefined;
	/** 客户端设置快照（附件 asides 的视觉桥接 / 上传上限读它；缺省 = 空设置）。 */
	clientSettings(): ClientSettings;
	getLang(): string;
}

export interface PromptEntry {
	/** `prompt` handler：先斜杠命令、再附件、最后喂轮。 */
	submit(text: string, attachments?: PromptAttachment[], queue?: boolean): Promise<void>;
	/**
	 * `new_chat`：空白对话复用，否则真建一条；两边都出帧。返回收尾后的活动对话。
	 * `allowReuse: false` = 临时对话（老实现 `ephemeral` 分支**不**复用空白对话：它要的是一条新记录）。
	 */
	startNewChat(botId?: string, allowReuse?: boolean): Conversation;
	/** 附件 asides（`prompt` 与编辑重问共用）：`conv` 缺省 = 当前对话。 */
	deliverAttachments(attachments?: readonly PromptAttachment[], conv?: Conversation): Promise<void>;
}

/**
 * 提示词入口的唯一实现。三条不变式，都是老实现的原样：
 *
 * 1. **斜杠命令命中就不进模型**（老 `parseSlash` → `slash.exec` → 回执 + flush）；
 * 2. **附件先落进会话**（`customType: "file"` 的旁注，`deliverAs: "nextTurn"`），再喂本轮提示词；
 * 3. **新建对话出两帧**（`conversations` + 快照）：客户端不等下一次 `get_state` 才知道换了对话。
 */
export function createPromptEntry(deps: PromptEntryDeps): PromptEntry {
	const notice = (level: "info" | "warning" | "error", text: string, textEn: string): void => {
		if (deps.transport.isClosed()) return;
		deps.transport.send({ type: "notice", level, text, textEn });
	};

	/** 空白对话判定（老实现 `isBlank`）：转录里一条消息都没有（没开过会话也算空白）。 */
	const isBlank = (conv: Conversation): boolean => {
		const opened = deps.sessions?.get(conv.id)?.session;
		if (opened) return ((opened as { messages?: readonly unknown[] }).messages?.length ?? 0) === 0;
		// 还没开会话：只有从历史打开的（带会话文件）不算空白。
		return !conv.meta.sessionFile;
	};

	/** 新建/复用对话后的共同收尾：运行列表帧 + 快照（换了对话一定是全量，内容没变就一帧不发）。 */
	const publishNewChat = (): void => {
		if (deps.isDisposed()) return;
		deps.pushConversations();
		deps.publisher.flush({ forceFull: false });
	};

	const startNewChat = (botId?: string, allowReuse = true): Conversation => {
		const active = deps.registry.activeConv();
		if (allowReuse && !botId && active && active.meta.kind === "user" && isBlank(active)) {
			publishNewChat();
			return active;
		}
		// 临时对话（`allowReuse: false`）：会话开在内存里，不写 `.jsonl`（`persist_conversation` 才转正）。
		const conv = deps.createConversation({
			...(botId ? { kind: "bot" as const } : {}),
			...(allowReuse ? {} : { ephemeral: true }),
		});
		publishNewChat();
		return conv;
	};

	const deliverAttachments = async (
		attachments?: readonly PromptAttachment[],
		conv: Conversation | undefined = deps.registry.activeConv(),
	): Promise<void> => {
		if (!attachments || attachments.length === 0 || deps.isDisposed()) return;
		const target = conv ?? deps.createConversation();
		const opened = deps.sessions ? await deps.sessions.ensure(target) : undefined;
		await appendAttachmentAsides({
			...(deps.attachments ? { port: deps.attachments() } : {}),
			...(opened ? { editor: createSessionEditor(opened.session as unknown as EditSessionHost) } : {}),
			ctx: {
				clientId: deps.clientId,
				cwd: target.meta.cwd,
				emit: (msg) => {
					if (!deps.transport.isClosed()) deps.transport.send(msg);
				},
				settings: deps.clientSettings(),
				getLang: () => deps.getLang(),
				...(opened ? { session: opened.session } : {}),
			},
			attachments,
			notice,
		});
	};

	// 两个入口互引（`/new <提示>` 的首条提示要再走一遍斜杠解析）：用函数声明把顺序交给提升。
	async function submit(text: string, attachments?: PromptAttachment[], queue?: boolean): Promise<void> {
		if (await execSlash(text)) return;
		// 附件先落进会话（老实现同序：asides → `sendCustomMessage(nextTurn)` → 喂轮）。
		await deliverAttachments(attachments);
		await deps.feedTurn(text, queue);
	}

	async function execSlash(text: string): Promise<boolean> {
		const slash = deps.slash?.();
		if (!slash?.exec) return false;
		const actions: SlashCommandActions = {
			clientId: deps.clientId,
			newChat: async () => {
				if (deps.isDisposed()) return false;
				startNewChat();
				return true;
			},
			prompt: (next) => submit(next),
			setCwd: async (path) => {
				// 失败就地报（与 `set_cwd` 那条入口同一个文案源），不把拒绝抛给 `prompt` 的兜底。
				try {
					await deps.workspace().setCwd(path);
				} catch (error) {
					const { text, textEn } = workspaceSwitchFailure(error);
					notice("error", text, textEn);
				}
			},
			setModel: (modelId) => deps.setModel(modelId),
			setThinking: (level) => deps.setThinking(level),
			// `/reload` 重载的是**已开的那个会话**；新对话还没开会话时先开一份再重载。
			reload: async () => {
				const conv = deps.registry.activeConv() ?? deps.createConversation();
				const opened = deps.sessions ? await deps.sessions.ensure(conv) : undefined;
				if (opened) await createSessionEditor(opened.session as unknown as EditSessionHost).reload();
			},
			refreshSessions: () => deps.refreshSessions(),
			setPlanMode: (enabled) => deps.setPlanMode(enabled),
			getPlanMode: () => deps.planModeOf(),
		};
		const handled = await slash.exec(text, actions);
		// 命令的回执/帧照发：内容没变时 publisher 自己会跳过（issue #965）。
		if (handled && !deps.isDisposed()) deps.publisher.flush({ forceFull: false });
		return handled;
	}

	return { submit, startNewChat, deliverAttachments };
}
