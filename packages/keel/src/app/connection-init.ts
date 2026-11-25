import type { DispatchSession } from "../engine-service.js";
import type { ModelAdminPort } from "../contracts/model-admin.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { ServerMessage } from "../protocol.js";
import type { Conversation } from "../kernel/conversation/index.js";
import { DEFAULT_GOAL_PREFS, goalStatusOfPrefs } from "../domains/goals/handlers.js";
import type { ClientRuntime } from "./client-runtime.js";
import type { HostFaces } from "./host-faces.js";
import type { SessionRegistry } from "./session-registry.js";

/**
 * 一条连接建好之后要做的**三件事**（老实现 `AgentService.attach()` 尾部那一段的对应物）：
 *
 * - **A 首条空白对话**：`CoreEngine.attach()` 建完运行时立刻开一条活动会话；
 * - **K quiesce 门**：把「引擎在排空就拒新工作」挂到这一条连接的分发表上；
 * - **B 连接期初始态帧**：老 `ClientSession.attachSink()` 那一次「整包推」，重连时原样再推一遍。
 *
 * 三件事同源（都只在连接期做一次、都只对本连接生效），所以放一个模块里：拆成三份的话，
 * 「谁先谁后、谁在重连时还要跑」这条顺序知识会散在三个文件里。
 *
 * 入口只有一个：`initializeConnection()` —— 建首条对话 → 挂门 → 返回「重推初始态」的闭包
 * （重连时 `CoreEngine.attach()` 直接调它，不重建运行时）。
 */

/** 拒绝时那一条 notice（老实现 `quiesceBlocked()` 逐字同形：文案里必须留着 "quiesce" 这个词）。 */
const QUIESCE_NOTICE: ServerMessage = {
	type: "notice",
	level: "error",
	text: "服务器正在排空存量工作（quiesce），已拒绝新的对话/消息/编辑。存量运行会继续跑完；用 pi-web-ui server unquiesce 可恢复。",
	textEn:
		"Server is draining (quiesce) and rejected the new chat/message/edit. Existing runs continue; resume with pi-web-ui server unquiesce.",
};

export interface QuiesceGate {
	/** 引擎此刻是否在排空。必须是 thunk：判定发生在**调用时**，不在装配时快照。 */
	isQuiesced(): boolean;
	/** 一帧发给本连接（走 `senders` 现取，重连后仍是新 socket）。 */
	emit(msg: ServerMessage): void;
}

/**
 * quiesce 门：老实现 `ClientSession.quiesceBlocked()` 的对应物，挂在**这一条连接的分发表**上。
 *
 * 为什么不塞进每个 handler：判据只有一条（引擎在排空），挨个 handler 各写一遍就是十几份
 * 同义分支。拦的也只是「开新工作」那一组——`prompt` / `newChat` / `editMessage` / `retryLast`，
 * 正是老实现先判 `quiesceBlocked()` 的四处。存量运行（`abort` / 读文件 / 改设置 / 审批回包）
 * 一律不拦：排空期恰恰要让人能看见并停掉在跑的东西。
 *
 * 只该对**每个运行时**调一次：它就地包住分发表上的四个成员，重复调用会叠出多层包装
 * （每层都会发一条同样的 notice）。调用点因此只有 `initializeConnection()` 一处。
 */
function applyQuiesceGate(session: DispatchSession, gate: QuiesceGate): void {
	const reject = (): boolean => {
		if (!gate.isQuiesced()) return false;
		gate.emit(QUIESCE_NOTICE);
		// 老实现同一收尾：拒绝后立刻刷一帧快照，让前端看到「已拒」而不是干等一个永远不来的回合。
		session.flushSnapshot();
		return true;
	};

	const prompt = session.prompt.bind(session);
	session.prompt = async (text, attachments, queue) => {
		if (reject()) return;
		await prompt(text, attachments, queue);
	};

	const newChat = session.newChat.bind(session);
	session.newChat = async (...args) => (reject() ? false : newChat(...args));

	const editMessage = session.editMessage.bind(session);
	session.editMessage = async (messageId, text, attachments) => {
		if (reject()) return;
		await editMessage(messageId, text, attachments);
	};

	const retryLast = session.retryLast.bind(session);
	session.retryLast = async () => {
		if (reject()) return;
		await retryLast();
	};
}

/**
 * 连接期那条「空白对话」（老实现 `ClientSession.create` 里建好的第一条）。
 *
 * 没有它就没有活动会话：快照 `conversationId` 恒空，`set_model` / `get_tool_info` / `set_goal`
 * 这些「先要一条会话」的能力第一步就落空，客户端也会把输入框判成不可发。语义照老实现三条：
 *
 * - **空白**：对话不带 `sessionFile` ⇒ `SessionRegistry.ensure()` 走 `SessionManager.create()`
 *   （新建一份转录），不做 `continueRecent`（不续工作区里最近那份别人的会话）。与老实现一样，
 *   SDK 在开会话时就把「将来要写的那个路径」定下来，但文件要等第一条 user/assistant 消息才落盘
 *   ——所以空对话既不在历史列表、也不产生任何磁盘文件。
 * - **cwd = 引擎 cwd**：`ClientRuntime.createConversation()` 缺省就取运行时的工作区根。
 * - **不进「运行的对话」**：入选由 `domains/history/frame.ts` 的 `inRunningList()` 裁定
 *   （当前对话 + 有内容 / 在跑 / 钉住才算），空白对话天然不入列，这里不用额外标记。
 *
 * 开会话失败**不**把整条连接废掉（老实现会抛，连接直接失败）：这里发一条 error notice 并留住
 * 空对话——设置 / 文件 / 插件这些能力照常可用，第一轮喂轮时带着真实错误回来。
 *
 * 老实现还有 `blankTitle` / `idleHeld` 两支（「最近那份会话在另一处开着 → 落在空白对话并解释」）。
 * 那两支要扫会话目录 + 判跨客户端归属（宿主 `agent-service-daemon.ts` 的 `findSessionOwner()`
 * 才有这份账），内核这一层没有对应事实源，所以不编造提示文案。
 */
async function openLeadingConversation(runtime: ClientRuntime, sessions: SessionRegistry): Promise<void> {
	// 幂等：已经建过（重连 / 二次调用）就认它，不另开一条。
	if (runtime.registry.activeConv() || runtime.isDisposed()) return;
	const conv: Conversation = runtime.createConversation();
	try {
		await sessions.ensure(conv);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!runtime.isDisposed() && !runtime.options.transport.isClosed()) {
			runtime.options.transport.send({
				type: "notice",
				level: "error",
				text: `打开会话失败：${message}`,
				textEn: `Failed to open the session: ${message}`,
			});
		}
	}
}

export interface ConnectFrameInput {
	runtime: ClientRuntime;
	faces: HostFaces;
	/** 进程级模型管理面（供应商 key / OAuth 流程）：没装配 = 这两帧未接。 */
	modelAdmin: ModelAdminPort | undefined;
	stateStore: SettingsStorePort;
	clientId: string;
	/** 一帧发给本连接（走 `senders` 现取：重连换过 socket 之后旧 socket 不会再收到帧）。 */
	emit(msg: ServerMessage): void;
}

/**
 * 连接期的初始态帧 —— 老实现 `ClientSession.attachSink()` 那一次「整包推」的对应物。
 *
 * 为什么必须在**连接期**推、而不是等客户端来要：前端首屏（设置面板 / 审批规则 / 目标偏好 /
 * 后台面板）都假设「连上就有这些帧」，靠 `get_settings` 之类去要等于让每个页面自己补一遍
 * 握手语义；重连也一样（新 socket 手上没有任何基线）。
 *
 * 老实现那 12 类帧在这里逐条对上（`★` = 本函数推，`组合根` = 已由 `server/index.ts` 的 hello
 * 收尾推过，**不能**在这里重复：插件命令必须在插件加载完之后算）：
 *
 * | # | 老实现 | 本树 |
 * | - | --- | --- |
 * | 1 | `pendingNotices` 回放 | 无对应物：内核没有挂起通知队列，各域即时 emit |
 * | 2 | `widgets` | 无生产者（协议里有形状，内核不产生） |
 * | 3 | `statuses` | 无生产者（同上） |
 * | 4 | `emitConversations()` | ★ `runtime.pushConversations()` |
 * | 5 | `pushSlashCommands()` | 组合根（`applyPluginCommandCatalog()`，要等插件加载完） |
 * | 6 | `goalSvc.emitGoalStatus()` | ★ `goal_status`（只有偏好、没有目标在跑时那一支） |
 * | 7 | `pushSettings()` | ★ `dispatch.pushSettings()` |
 * | 8 | `bg.push()` | ★ `faces.background.refreshBgTasks()`（只重投影，不重扫端口） |
 * | 9 | `listProviderKeys()` | ★ `dispatch.listProviderKeys()` |
 * | 10 | `listProviderOAuthFlows()` | ★ `dispatch.listProviderOAuthFlows()` |
 * | 11 | `pushDefaultModel()` | ★ `runtime.optionalFrames().pushDefaultModel()`（★ 键星标 +「设为全局默认」按钮态）｜
 * | 12 | `refreshAgentPresets()` + `refreshPermission()` | ★ `dispatch.refreshAgentPresets()`；权限预设帧没有只读/重推的 handler（只有 `setDefaultPermissionPreset` 会发），不编一条 |
 * | 13 | `pushTerminals()` | 无对应帧（内核没有 `terminal_list` 生产者；终端按请求出帧） |
 *
 * 帧顺序照老实现（会话 → 目标 → 设置 → 后台 → 供应商 → 预设）：设置帧里会读当前审批策略
 * 与会话，落在会话之后推才对得上。
 */
function pushConnectFrames(input: ConnectFrameInput, dispatch: DispatchSession): void {
	const { runtime, faces, modelAdmin, stateStore, clientId, emit } = input;
	// 4 运行列表：空白对话不入列（`inRunningList` 裁定），所以新连接这里通常是「零行 + activeId」。
	runtime.pushConversations();
	// 6 目标状态：真值是 `client-state.json` 里的偏好，没有目标在跑时就是这一支（老 `makeGoalStatus()`）。
	emit({ type: "goal_status", status: goalStatusOfPrefs(stateStore.getGoalPrefs(clientId) ?? DEFAULT_GOAL_PREFS) });
	// 7 设置帧：宿主 `SettingsService.push()` 自己兜住「会话还没打开」（资源目录读不到就给空表）。
	dispatch.pushSettings();
	// 8 后台面板：`bg_servers` 由宿主出帧。
	faces.background?.refreshBgTasks();
	// 9 / 10 供应商：只读帧，端口没装配就跳过（两个 handler 会同步抛 `CoreEngineNotReadyError`）。
	if (modelAdmin) {
		dispatch.listProviderKeys();
		dispatch.listProviderOAuthFlows();
	}
	// 11 全局默认模型（模型选择器的 ★ 标记 + 「设为全局默认」按钮态）。
	runtime.optionalFrames()?.pushDefaultModel();
	// 12 智能体预设目录（`dsh_presets`）：缺省预设是客户端徽标的源。
	void dispatch.refreshAgentPresets?.();
	// 13 历史会话列表（sessions 帧）：连接期推一次，让历史面板首屏有内容。
	void runtime.optionalFrames()?.refreshSessions();
	// 14 待答问卷队列（question_queue）：连接期推一次，恢复待处理问卷。
	runtime.pushQuestionQueue();
}

export interface ConnectionInitInput extends ConnectFrameInput {
	sessions: SessionRegistry;
	/** 引擎此刻是否在排空（`CoreEngine.isQuiesced()`）。 */
	isQuiesced(): boolean;
}

/**
 * 连接期的唯一入口（`CoreEngine.attach()` 建好运行时之后调一次）。
 * 返回「重推连接期初始态」的闭包：重连复用同一个运行时时，`attach()` 直接调它。
 */
export async function initializeConnection(input: ConnectionInitInput): Promise<() => void> {
	const dispatch = input.runtime.handlers();
	await openLeadingConversation(input.runtime, input.sessions);
	applyQuiesceGate(dispatch, { isQuiesced: input.isQuiesced, emit: input.emit });
	const pushInitial = (): void => pushConnectFrames(input, dispatch);
	pushInitial();
	return pushInitial;
}
