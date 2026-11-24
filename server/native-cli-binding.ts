import { randomUUID } from "node:crypto";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import type { RemoteSshService } from "./remote-ssh-service.js";
import { cleanupRemoteNativeCliFiles } from "./native-cli-remote-files.js";
import { remoteNativeCliCleanupQueue } from "./native-cli-remote-cleanup.js";
import { prepareNativeCliSessionLaunch } from "./native-cli-session.js";
import type { NativeCliSessionEvent, PreparedNativeCliSession } from "./native-cli-runtime.js";
import {
	acceptNativeCliEvent,
	createNativeCliBinding,
	isNativeCliStagingPath,
	readNativeCliBinding,
	type NativeCliBinding,
} from "./native-cli-state.js";
import type { NativeCliConfig, NativeCliStatus } from "./protocol.js";

/** 会话文件里那份绑定的读取口（`SessionManager` 的窄面；远端 CLI 起会话前可能还没有）。 */
export type NativeCliBindingSource = Pick<SessionManager, "getEntries">;

/**
 * 一条 CLI 对话的绑定：从会话文件读回（跨重启的 keep-alive），读不到就新建一份。
 *
 * 老实现长在 `AgentService#ensureNativeCliBinding` 上，抽出来是为了让老树与 core 适配器
 * （`server/core-native-cli-adapter.ts`）共用同一份读法：读不出来就抛、工作区对不上就抛，
 * 绝不因为「缓存里有一个」就跳过校验。
 */
export function resolveNativeCliBinding(input: {
	config: NativeCliConfig;
	cwd: string;
	session: NativeCliBindingSource | undefined;
}): NativeCliBinding {
	if (!input.session) throw new Error("CLI conversation session is not available");
	return (
		readNativeCliBinding(input.session, input.config, input.cwd) ?? createNativeCliBinding(input.config, input.cwd)
	);
}

/**
 * 起 CLI 的 hook 观察会话（`NativeCliRuntimeHooks.prepare` 的**唯一实现**）。
 *
 * 老实现内联在 `AgentService#configureNativeCliRuntime` 的 `prepare` 里，core 宿主
 * （`server/native-cli-host.ts`）要的是逐字同一段，所以整段抽到这里，两边只调这一个函数：
 * 绑定先落盘（观察器读到游标）→ 准备 hook/事件目录 → `nativeId` 有变化再落一次。
 * 「绑定写哪儿」是调用方的事（老树写 `conv.session.sessionManager`，core 写 CLI 自己的转录），
 * 所以落盘动作以 `persist` 传进来，而不是在这里判断谁持有会话。
 */
export async function prepareNativeCliRuntimeSession(input: {
	config: NativeCliConfig;
	binding: NativeCliBinding;
	cwd: string;
	dataDir: string;
	signal?: AbortSignal;
	observeOnly?: boolean;
	onEvent(event: NativeCliSessionEvent): void;
	/** 远端工作区才有的 SSH 服务（本地 CLI 传 `undefined`）。 */
	service?: RemoteSshService;
	/** 绑定落盘：谁持有会话文件谁写。 */
	persist(binding: NativeCliBinding): void;
}): Promise<PreparedNativeCliSession> {
	const { binding } = input;
	input.persist(binding);
	const prepared = await prepareNativeCliSessionLaunch(
		input.config,
		{ key: binding.key, nativeId: binding.nativeId },
		{
			cwd: input.cwd,
			dataDir: input.dataDir,
			...(input.service ? { service: input.service } : {}),
			...(input.signal ? { signal: input.signal } : {}),
			...(binding.lastEventId ? { lastEventId: binding.lastEventId } : {}),
			...(input.observeOnly ? { observeOnly: true } : {}),
			onEvent: input.onEvent,
		},
	);
	if (prepared.ref.nativeId) binding.nativeId = prepared.ref.nativeId;
	input.persist(binding);
	return prepared;
}

/**
 * 远端暂存目录账（keep-alive 引用的上传文件）：校验单源 + 去重 + 上限。
 * 非法路径 / 超上限一律抛（不静默丢路径），调用方负责落盘。
 */
export function retainNativeCliStagingPaths(binding: NativeCliBinding, paths: readonly string[]): void {
	if (paths.some((path) => !isNativeCliStagingPath(path))) throw new Error("Invalid remote CLI staging directory");
	const all = [...new Set([...(binding.stagingPaths ?? []), ...paths])];
	if (all.length > 2048) throw new Error("Too many remote CLI staging directories");
	binding.stagingPaths = all;
}

/**
 * 进程身份账：新进程起来（`created`）或还没有 id 时发一个新的。返回 `true` = 绑定变了，调用方落盘。
 */
export function assignNativeCliProcessId(binding: NativeCliBinding, created: boolean): boolean {
	if (!created && binding.processId) return false;
	binding.processId = randomUUID();
	return true;
}

/**
 * 远端暂存目录的清理账：删掉的从绑定里摘掉，删不掉进重试队列（下一次打开时再试）。
 * 只对远端工作区 + keep-alive 有意义；本地 CLI 直接返回 `[]`。
 */
export async function cleanupNativeCliStagingFiles(input: {
	binding: NativeCliBinding;
	cwd: string;
	service: RemoteSshService | null;
}): Promise<string[]> {
	const paths = [...(input.binding.stagingPaths ?? [])];
	if (!input.service || !paths.length) return [];
	const removed: string[] = [];
	for (let index = 0; index < paths.length; index += 32) {
		const batch = paths.slice(index, index + 32);
		try {
			await cleanupRemoteNativeCliFiles(input.service, input.cwd, batch);
			removed.push(...batch);
		} catch {
			remoteNativeCliCleanupQueue.enqueue(input.service, input.cwd, batch);
		}
	}
	input.binding.stagingPaths = input.binding.stagingPaths?.filter((path) => !removed.includes(path));
	return removed;
}

/**
 * 状态补丁合并：`phase` 缺省继承 `starting`，`updatedAt` 每次刷新，
 * 错误串先净化控制字符再截断（出帧不夹带控制序列）。
 */
export function mergeNativeCliStatus(
	current: NativeCliStatus | undefined,
	patch: Partial<NativeCliStatus>,
	now = Date.now(),
): NativeCliStatus {
	const status = { phase: "starting", updatedAt: now, ...current, ...patch } as NativeCliStatus;
	if (status.error) status.error = status.error.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 512);
	return status;
}

/**
 * `event_observer` 错误：观察失败不等于 CLI 挂了——终端还活着就算 `running`，
 * 否则保留当前相位（没相位就 `disconnected`），并且不再声称「有事件观察」。
 */
export function observerErrorStatus(
	current: NativeCliStatus | undefined,
	input: { message: string; terminalAlive: boolean },
): Partial<NativeCliStatus> {
	return {
		nativeEvents: false,
		error: input.message,
		activity: void 0,
		phase: input.terminalAlive ? "running" : (current?.phase ?? "disconnected"),
	};
}

/** 一条 CLI 事件要宿主做的动作（副作用全在宿主，这里只判定）。 */
export interface NativeCliEventPlan {
	/** 状态补丁；缺省 = 这条事件不动状态。 */
	status?: Partial<NativeCliStatus>;
	/** 绑定变了（`nativeId` / 事件游标 / 去重集）：写回会话文件。 */
	persist: boolean;
	/** 标题可能还是自动名：按终端原始输出试一次回填（用户改过名就不再动）。 */
	refreshTitle: boolean;
	/** 刚提交了一轮提示：要发 `native_cli_prompt_submitted`。 */
	submitted: boolean;
	/** 要广播给客户端 / 手机的四种事件类型（其余只在状态里体现）。 */
	kind?: "approval" | "done" | "error" | "question";
}

/**
 * 一条 CLI 事件的判定（单源）：去重与游标、绑定变更、状态补丁、标题回填、四种可广播事件。
 *
 * 返回 `undefined` = 丢掉（重复事件 / 非 `working` 事件的游标没推进）。语义与老实现逐条一致：
 * `working` 是纯活动信号（不写会话文件、不去重），`session` 只记 `nativeId`，`error.process_exit`
 * 是合成事件（不推进游标），`done.aborted` 只改状态不广播。`event_observer` 走 `observerErrorStatus`。
 */
export function planNativeCliEvent(input: {
	event: NativeCliSessionEvent;
	binding: NativeCliBinding;
	current: NativeCliStatus | undefined;
	titleIsDefault: boolean;
	now?: number;
}): NativeCliEventPlan | undefined {
	const { event, binding } = input;
	const synthetic = event.type === "error" && event.code === "process_exit";
	if (
		event.type !== "working" &&
		!acceptNativeCliEvent(
			binding,
			event.eventId,
			!synthetic && (event.type !== "session" || Boolean(event.cursor)),
			event.type === "session" ? event.cursor : event.eventId,
		)
	)
		return undefined;
	const persist = event.type !== "working";
	if (event.type === "session") {
		binding.nativeId = event.nativeId;
		return { status: { sessionId: event.nativeId, resumable: true }, persist, refreshTitle: false, submitted: false };
	}
	const activity =
		event.type === "working" || event.type === "submitted"
			? "working"
			: event.type === "question"
				? "waiting_input"
				: event.type === "approval"
					? "waiting_approval"
					: "idle";
	const phase = input.current?.phase;
	const disconnected = phase === "disconnected" || phase === "exited";
	const now = input.now ?? Date.now();
	const refreshTitle = input.titleIsDefault && (event.type === "submitted" || event.type === "working");
	const kind =
		event.type === "approval" || event.type === "question" || event.type === "error"
			? event.type
			: event.type === "done" && !event.aborted
				? "done"
				: undefined;
	return {
		status: {
			phase: disconnected ? phase : activity === "idle" ? "running" : activity,
			activity,
			lastActivityAt: now,
			updatedAt: now,
			...(synthetic ? {} : { nativeEvents: true }),
			error: event.type === "error" ? event.message : void 0,
		},
		persist,
		refreshTitle,
		submitted: event.type === "submitted",
		...(kind ? { kind } : {}),
	};
}

/** 宿主侧终端管理器上 CLI 真正用到的那三个方法（`server/terminals.ts` 的 `TerminalManager` 有）。 */
export interface NativeCliTerminalsHandle {
	detachNativeCli(id: string): void;
	stopNativeCli(id: string): Promise<void>;
	hasPersistentNativeCli(id: string): boolean;
}

/** 只断开观察（远端 keep-alive 的 PTY 保持存活）。终端不在这条对话手里就明说，不静默成功。 */
export function detachNativeCliTerminal(terminals: NativeCliTerminalsHandle | undefined, terminalId: string): void {
	if (!terminals) throw new Error("CLI terminal manager is not available for this conversation");
	terminals.detachNativeCli(terminalId);
}

/**
 * 真停：`keepAlive` 且 PTY 已断开时先确认远端持久实例（tmux）确实终止，再停终端。
 * 「确认不了」一律抛——停不掉必须让用户看见。
 */
export async function stopNativeCliTerminal(
	terminals: NativeCliTerminalsHandle | undefined,
	input: { terminalId: string; keepAlive: boolean; confirmRemote?: () => Promise<void> },
): Promise<void> {
	if (!terminals) throw new Error("CLI terminal manager is not available for this conversation");
	if (input.keepAlive && !terminals.hasPersistentNativeCli(input.terminalId)) {
		if (!input.confirmRemote) throw new Error("SSH service is unavailable; remote stop could not be confirmed");
		await input.confirmRemote();
	}
	await terminals.stopNativeCli(input.terminalId);
}
