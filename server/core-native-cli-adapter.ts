import type {
	NativeCliLaunch,
	NativeCliLaunched,
	NativeCliPort,
	NativeCliTarget,
} from "../packages/keel/src/contracts/native-cli.js";
import type { ServerMessage } from "./protocol.js";
import { detachNativeCliTerminal, stopNativeCliTerminal } from "./native-cli-binding.js";
import { NativeCliHost, type NativeCliHostTerminals } from "./native-cli-host.js";
import type { NativeCliConfig } from "./protocol.js";
import { terminatePersistentRemoteNativeCli } from "./remote-cli-persistence.js";
import type { RemoteSshService } from "./remote-ssh-service.js";

/** `TerminalManager` 上内核真正需要的那些方法（PTY 归叶子，内核不认识它）。 */
export type CoreNativeCliTerminals = NativeCliHostTerminals;

/**
 * 宿主的 `TerminalManager` 有 CLI 那一套；不是那个形状就当没有（不猜、也不伪造一支管理器）。
 * 内核侧只按对话把管理器递出来（`unknown`），形状判定留在宿主这一层。
 *
 * `createNativeCli` 是 `launch` / `reconnect` 的必要条件：拿不到它的时候
 * `NativeCliHost` 会抛「这支管理器起不了 CLI」，而不是把对话建成一个空壳。
 */
export function asCoreNativeCliTerminals(manager: unknown): CoreNativeCliTerminals | undefined {
	const candidate = manager as Partial<CoreNativeCliTerminals> | undefined;
	return candidate &&
		typeof candidate.detachNativeCli === "function" &&
		typeof candidate.stopNativeCli === "function" &&
		typeof candidate.hasPersistentNativeCli === "function"
		? (candidate as CoreNativeCliTerminals)
		: undefined;
}

/**
 * 宿主侧 `NativeCliPort` 的适配器：**结构直通**，不重写任何一件 CLI 逻辑。
 *
 * 两个动作落在叶子上（`TerminalManager.detachNativeCli` / `stopNativeCli` +
 * `remote-cli-persistence.terminatePersistentRemoteNativeCli`，实现与老树共用
 * `server/native-cli-binding.ts` 的 `detachNativeCliTerminal` / `stopNativeCliTerminal`）；
 * 其余四个成员交给 `server/native-cli-host.ts` —— 那是 core 引擎自己的 CLI 运行时
 * （转录 + 绑定 + hook 观察 + 状态账 + 标题写回），判定/合并全部复用老树抽出来的单源叶子。
 */
export interface CoreNativeCliSinks {
	/** CLI 转录与 hook 暂存目录的根（宿主 `PI_WEB_DATA_DIR`）。 */
	dataDir: string;
	/** 该对话懒建的终端管理器（没有 = 还没起过终端）；`cwd` 只用于懒建时定工作区根。 */
	terminalOf(conversationId: string, cwd?: string): CoreNativeCliTerminals | undefined;
	/** 出帧（`native_cli_event` / `native_cli_prompt_submitted`）。 */
	emit?(msg: ServerMessage): void;
	/** 状态/归属变了：内核刷快照 + 推 `conversations` 帧。 */
	publish?(): void;
	/** 历史列表重扫（标题写回 / 新转录落盘之后）。 */
	refreshSessions?(): void;
	/** 宿主回填标题时同步改内核对话实体标题。 */
	renameConversation?(conversationId: string, title: string): void;
	/** 「继承当前对话模型」开关（宿主设置 + 当前对话模型）；缺省 = 不继承。 */
	inheritModel?(preset: NativeCliConfig["preset"]): NativeCliConfig["model"] | undefined;
	/** 手机通知（可广播的四种 CLI 事件）；缺省 = 不推手机。 */
	notify?(input: {
		kind: "approval" | "done" | "error" | "question";
		eventId: string;
		sessionId: string;
		conversationId: string;
		occurredAt: number;
	}): void;
	/** 全局 SSH 服务；远端 keep-alive 的 stop 与远端 CLI 的启动都要它。 */
	remoteService?(): RemoteSshService | null;
}

/**
 * 缺哪个宿主口就明说缺哪个：CLI 的进程/hook/会话文件全在宿主，内核不替它假装。
 * 四个成员今天都真接上了（`NativeCliHost`）；这条通道留给以后新增的宿主口：
 * 没有实现就别让它静默成功。
 */
const notWired = (member: string, needs: string): never => {
	throw new Error(`native CLI ${member} is not wired into this engine yet: it needs ${needs}`);
};

void notWired;

export function createCoreNativeCli(sinks: CoreNativeCliSinks): NativeCliPort {
	const remoteStop = (target: NativeCliTarget) => async () => {
		const service = sinks.remoteService?.() ?? null;
		const key = host.bindingKeyOf(target.conversationId);
		if (!service || !key) throw new Error("SSH service is unavailable; remote stop could not be confirmed");
		await terminatePersistentRemoteNativeCli(service, target.cwd, key);
	};

	/** 每条连接一份 CLI 账：`launch` 建、其余三个成员按对话读它。 */
	const host = new NativeCliHost({
		dataDir: sinks.dataDir,
		terminalsOf: (conversationId, cwd) => sinks.terminalOf(conversationId, cwd),
		// 帧出口缺省 = 这条连接没有出帧能力（不静默假装发过）：只在真给了 emit 时才发。
		emit: (msg) => sinks.emit?.(msg),
		publish: () => sinks.publish?.(),
		refreshSessions: () => sinks.refreshSessions?.(),
		...(sinks.renameConversation ? { renameConversation: sinks.renameConversation } : {}),
		remoteService: () => sinks.remoteService?.() ?? null,
		...(sinks.inheritModel ? { inheritModel: sinks.inheritModel } : {}),
		...(sinks.notify ? { notify: sinks.notify } : {}),
	});

	return {
		launch: (input: NativeCliLaunch): Promise<NativeCliLaunched> => host.launch(input),
		statusOf: (target: NativeCliTarget) => host.statusOf(target.conversationId),
		reconnect: (target: NativeCliTarget): Promise<void> => host.reconnect(target),
		applyTitle: (target: NativeCliTarget): void => host.applyTitle(target),

		// 远端 keep-alive：PTY 已断开时先确认 tmux 实例真的终止，否则「停掉了」只是本地假象。
		async stop(target: NativeCliTarget): Promise<void> {
			await stopNativeCliTerminal(sinks.terminalOf(target.conversationId), {
				terminalId: target.terminalId,
				keepAlive: Boolean(target.config.keepAlive),
				confirmRemote: remoteStop(target),
			});
		},

		detach(target: NativeCliTarget): void {
			detachNativeCliTerminal(sinks.terminalOf(target.conversationId), target.terminalId);
		},
	};
}
