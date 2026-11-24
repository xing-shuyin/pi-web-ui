import type {
	NativeCliLaunch,
	NativeCliLaunched,
	NativeCliPort,
	NativeCliTarget,
} from "../packages/keel/src/contracts/native-cli.js";
import type { NativeCliStatus } from "./protocol.js";
import { detachNativeCliTerminal, stopNativeCliTerminal, type NativeCliTerminalsHandle } from "./native-cli-binding.js";
import { terminatePersistentRemoteNativeCli } from "./remote-cli-persistence.js";
import type { RemoteSshService } from "./remote-ssh-service.js";

/** `TerminalManager` 上内核真正需要的那几个方法（PTY 归叶子，内核不认识它）。 */
export type CoreNativeCliTerminals = NativeCliTerminalsHandle;

/**
 * 宿主的 `TerminalManager` 有 CLI 三件套；不是那个形状就当没有（不猜、也不伪造一支管理器）。
 * 内核侧只按对话把管理器递出来（`unknown`），形状判定留在宿主这一层。
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
 * 其余成员是宿主自己的 native-cli 运行时（进程、PTY、hook 观察、事件/状态机、会话文件落盘、标题写回）。
 *
 * **还没接上的宿主口**（都写成可选：调用即抛并把缺什么说清，绝不空实现让它静默成功）：
 * - `start`：把「PTY + `prepareNativeCliSessionLaunch` + 事件/状态接线 + binding 落盘 + 历史帧」
 *   按内核给的 `conversationId` 起起来——今天这套逻辑长在 `AgentService#newCliChat` 上（深绑会话
 *   所有权：会话 runtime、槽位、`displaceActive`、`bindSession`），core 引擎还没有对应运行时；
 * - `reconnect`：老实现 `startNativeCliTerminal(conv)`（远端 attach 持久实例 / 本地重起进程）；
 * - `statusOf`：老实现 `conv.nativeCli.status`，状态账的持有者就是上面那套运行时；
 * - `applyTitle`：老实现 `appendSessionInfo` + SDK `setSessionName` + 失效历史缓存 + 重扫会话列表，
 *   要的是 CLI 那条会话的 `SessionManager`（core 的 `OpenedSession` 不交出它，另写一份 = 第二套写回）。
 */
export interface CoreNativeCliSinks {
	/** 起 CLI 运行时并绑到内核对话 id 上；返回终端 id 与宿主解析后的真实目录。 */
	start?(input: NativeCliLaunch): Promise<NativeCliLaunched>;
	/** 重连：同一条对话再起一次 CLI（远端 attach / 本地重起都由宿主决定）。 */
	reconnect?(target: NativeCliTarget): Promise<void>;
	/** 该对话 CLI 的实时状态（`NativeCliStatus`）。 */
	statusOf?(conversationId: string): NativeCliStatus | undefined;
	/** 标题写回会话文件 + SDK 会话名 + 重扫会话列表（老实现这一段是尽力而为）。 */
	applyTitle?(target: NativeCliTarget): void;
	/** 这条对话懒建的终端管理器（没有 = 还没起过终端）。 */
	terminalOf(conversationId: string): CoreNativeCliTerminals | undefined;
	/** 远端 keep-alive 持久实例的绑定键（`NativeCliBinding.key`，宿主从会话文件里读出来）。 */
	bindingKeyOf?(conversationId: string): string | undefined;
	/** 全局 SSH 服务；只有远端 keep-alive 的 stop 才用得到。 */
	remoteService?(): RemoteSshService | null;
}

/** 缺哪个宿主口就明说缺哪个：CLI 的进程/hook/会话文件全在宿主，内核不替它假装。 */
const notWired = (member: string, needs: string): never => {
	throw new Error(`native CLI ${member} is not wired into this engine yet: it needs ${needs}`);
};

export function createCoreNativeCli(sinks: CoreNativeCliSinks): NativeCliPort {
	const remoteStop = (target: NativeCliTarget) => async () => {
		const service = sinks.remoteService?.() ?? null;
		const key = sinks.bindingKeyOf?.(target.conversationId);
		if (!service || !key) throw new Error("SSH service is unavailable; remote stop could not be confirmed");
		await terminatePersistentRemoteNativeCli(service, target.cwd, key);
	};

	return {
		launch: (input: NativeCliLaunch) =>
			sinks.start ? sinks.start(input) : notWired("launch", "the host PTY/hook runtime behind AgentService#newCliChat"),
		statusOf: (target: NativeCliTarget) =>
			sinks.statusOf
				? sinks.statusOf(target.conversationId)
				: notWired("statusOf", "the CLI status book held by the host runtime"),
		reconnect: (target: NativeCliTarget) =>
			sinks.reconnect
				? sinks.reconnect(target)
				: notWired("reconnect", "the host PTY re-attach path (AgentService#startNativeCliTerminal)"),
		applyTitle: (target: NativeCliTarget) =>
			sinks.applyTitle
				? sinks.applyTitle(target)
				: notWired("applyTitle", "the CLI session manager (appendSessionInfo + setSessionName)"),

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
