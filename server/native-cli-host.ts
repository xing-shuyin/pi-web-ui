import { rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { NativeCliLaunch, NativeCliLaunched, NativeCliTarget } from "../packages/keel/src/contracts/native-cli.js";
import { isDefaultNativeCliTitle, persistNativeCliConfig } from "./native-cli.js";
import {
	assignNativeCliProcessId,
	cleanupNativeCliStagingFiles,
	mergeNativeCliStatus,
	observerErrorStatus,
	planNativeCliEvent,
	prepareNativeCliRuntimeSession,
	resolveNativeCliBinding,
	retainNativeCliStagingPaths,
	type NativeCliTerminalsHandle,
} from "./native-cli-binding.js";
import type { NativeCliSessionEvent } from "./native-cli-runtime.js";
import type { NativeCliRuntimeHooks } from "./native-cli-runtime.js";
import { persistNativeCliBinding, type NativeCliBinding } from "./native-cli-state.js";
import { nativeCliTitleFromTerminalOutput } from "./native-cli-title.js";
import {
	formatRemoteWorkspaceUri,
	isRemoteWorkspaceUri,
	parseRemoteWorkspaceUri,
	resolveWorkspaceSessionDir,
	type RemoteSshService,
} from "./remote-ssh-service.js";
import type { NativeCliConfig, NativeCliStatus, ServerMessage, TerminalInfo } from "./protocol.js";

/**
 * 宿主侧 CLI 运行时（core 引擎的那一份）。
 *
 * 老实现长在 `AgentService#newCliChat` / `startNativeCliTerminal` / `configureNativeCliRuntime` /
 * `handleNativeCliEvent` 上，那几段**深绑**会话所有权（`conv.terminals`、会话槽位、`displaceActive`、
 * `bindSession`、`pendingNativeCliConversations`）。这里保留的只有内核不产生的那一层：
 *
 * - 每对话一条 CLI 账（配置 / 终端 id / 工作目录 / 标题 / 绑定 / 状态）；
 * - CLI 转录（`SessionManager`）：配置与绑定落盘、标题写回（历史列表的事实源）；
 * - `NativeCliRuntimeHooks`（PTY 叶子 `TerminalManager` 回调这里）：判定/合并/标题回填全部复用
 *   `server/native-cli-binding.ts` 与 `server/native-cli-title.ts` 的单源，这里不另写状态机。
 *
 * 与老树唯一的结构性差别：**没有 `AgentSession`**。core 的 CLI 对话 = 内核的对话实体 + 宿主的 PTY，
 * 不为它开 SDK 会话；于是 `applyTitle` 只写会话文件（`appendSessionInfo`），老实现那句
 * `session.setSessionName()` 的副作用（`session_info_changed` 事件）在这里没有听众。
 */
export interface NativeCliHostTerminals extends NativeCliTerminalsHandle {
	/** PTY 叶子建 CLI（远端 attach / 本地 spawn 都由它决定）。 */
	createNativeCli(
		id: string,
		cwd: string,
		cols: number,
		rows: number,
		fallbackCwd: string,
		title: string,
		opts: { nativeCli: NativeCliConfig },
	): Promise<TerminalInfo | null>;
	/** 判断观察器这条终端是不是还活着（`event_observer` 失败时用）。 */
	getNativeCliTerminal(id: string): TerminalInfo | undefined;
	/** 终端回卷缓冲（标题回填的输入）。 */
	getRawOutput?(id: string): string | undefined;
	/** 观察回调的挂载点（`TerminalManager` 上就是这一个字段）。 */
	nativeCliRuntime?: NativeCliRuntimeHooks;
}

export interface NativeCliHostOptions {
	/** CLI 转录与 hook 暂存目录的根（宿主 `PI_WEB_DATA_DIR`）。 */
	dataDir: string;
	/** 该对话的 PTY 管理器（内核按对话递出来的那一支；`cwd` 只用于懒建时定根）。 */
	terminalsOf(conversationId: string, cwd?: string): NativeCliHostTerminals | undefined;
	/** 出帧（宿主事件驱动的帧：`native_cli_event` / `native_cli_prompt_submitted`）。 */
	emit(msg: ServerMessage): void;
	/** 状态/归属变了：内核刷快照 + 推 `conversations` 帧（老实现 `scheduleSnapshot` + `emitConversations`）。 */
	publish(): void;
	/** 历史列表重扫（标题写回 / 新转录落盘之后）。 */
	refreshSessions(): void;
	/** 全局 SSH 服务（远端工作区 / keep-alive 才用得到）。 */
	remoteService(): RemoteSshService | null;
	/** 「继承当前对话模型」开关的宿主判定：模型选择不归内核。 */
	inheritModel?(preset: NativeCliConfig["preset"]): NativeCliConfig["model"] | undefined;
	/** 手机通知（可广播的四种 CLI 事件）。 */
	notify?(input: {
		kind: "approval" | "done" | "error" | "question";
		eventId: string;
		sessionId: string;
		conversationId: string;
		occurredAt: number;
	}): void;
	now?(): number;
}

interface CliEntry {
	conversationId: string;
	config: NativeCliConfig;
	cwd: string;
	title: string;
	terminalId: string;
	/** CLI 自己的转录：配置 / 绑定 / 标题都写在这里（历史列表读它）。 */
	manager: SessionManager;
	binding: NativeCliBinding;
	status?: NativeCliStatus;
}

const CONTROL_CHARACTERS = /[\x00-\x1f\x7f-\x9f]/;

/**
 * 目录解析与校验：本地 stat、SSH URI 规范化、keep-alive 只许远端（老实现同一套判定与文案）。
 * `undefined` = 客户端没给（用当前工作区，由调用方传进来）。
 */
async function resolveLaunchCwd(
	requested: string | undefined,
	service: RemoteSshService | null,
): Promise<{ cwd: string; remote: boolean }> {
	if (requested !== undefined) {
		if (typeof requested !== "string" || !requested || requested.length > 4096 || CONTROL_CHARACTERS.test(requested))
			throw new Error("Invalid CLI working directory");
	}
	const raw = requested ?? "";
	if (!isRemoteWorkspaceUri(raw)) {
		const cwd = resolve(raw || ".");
		let isDirectory = false;
		try {
			isDirectory = statSync(cwd).isDirectory();
		} catch {
			isDirectory = false;
		}
		if (!isDirectory) throw new Error("CLI working directory is not a directory");
		return { cwd, remote: false };
	}
	const parsed = parseRemoteWorkspaceUri(raw);
	if (!parsed || parsed.port < 1 || parsed.port > 65535) throw new Error("Invalid SSH workspace URI");
	const cwd = formatRemoteWorkspaceUri(parsed.username, parsed.host, parsed.port, parsed.remotePath);
	if (!service) throw new Error("SSH service is unavailable");
	if (!(await service.sftpStat(cwd, parsed.remotePath)).isDirectory)
		throw new Error("CLI working directory is not a remote directory");
	return { cwd, remote: true };
}

export class NativeCliHost {
	private readonly byConversation = new Map<string, CliEntry>();
	private readonly options: NativeCliHostOptions;

	constructor(options: NativeCliHostOptions) {
		this.options = options;
	}

	private now(): number {
		return this.options.now?.() ?? Date.now();
	}

	/** 远端 keep-alive 持久实例的绑定键（老实现 `ensureNativeCliBinding(conv).key`）。 */
	bindingKeyOf(conversationId: string): string | undefined {
		return this.byConversation.get(conversationId)?.binding.key;
	}

	/** 该对话 CLI 的实时状态：没有这条 CLI 账就是 `undefined`（内核如实转给前端，不编相位）。 */
	statusOf(conversationId: string): NativeCliStatus | undefined {
		return this.byConversation.get(conversationId)?.status;
	}

	/**
	 * 起一个 CLI：解析目录 → 建转录与绑定 → 装 hook 账 → 建 PTY。
	 * 失败**原样 reject**（内核据此发 error notice 并回 `false`），已建出来的半套在这里回滚。
	 */
	async launch(input: NativeCliLaunch): Promise<NativeCliLaunched> {
		const service = this.options.remoteService();
		const config = this.resolveConfig(input.config);
		const { cwd, remote } = await resolveLaunchCwd(input.cwd, service);
		if (config.keepAlive && !remote) throw new Error("CLI keep-alive requires an SSH workspace");
		const terminals = this.terminalsFor(input.conversationId, cwd);
		const terminalId = `cli-${input.conversationId}`;
		// 转录先建：配置与绑定都要落在这份会话文件里（历史列表与重启后的重连都读它）。
		const manager = SessionManager.create(resolveWorkspaceSessionDir(this.options.dataDir, cwd));
		const binding = resolveNativeCliBinding({ config, cwd, session: manager });
		const entry: CliEntry = {
			conversationId: input.conversationId,
			config,
			cwd,
			title: input.title,
			terminalId,
			manager,
			binding,
		};
		this.byConversation.set(entry.conversationId, entry);
		try {
			// keep-alive 的配置先落盘：PTY 起失败时转录也要能认出「这是一条 CLI 对话」（远端实例可能已经起来了）。
			if (config.keepAlive) persistNativeCliConfig(manager, config, entry.title);
			persistNativeCliBinding(manager, binding);
			this.installHooks(entry, terminals);
			const terminal = await terminals.createNativeCli(terminalId, cwd, 100, 30, cwd, entry.title, {
				nativeCli: config,
			});
			if (!terminal) throw new Error("Native CLI process could not be created");
			if (!config.keepAlive) persistNativeCliConfig(manager, config, entry.title);
			persistNativeCliBinding(manager, binding);
			const sessionFile = manager.getSessionFile();
			return { terminalId, cwd, ...(sessionFile ? { sessionFile } : {}) };
		} catch (error) {
			this.byConversation.delete(entry.conversationId);
			// keep-alive 的转录留着（远端持久实例可能已经起来了）；其余不收尸：绝不留幽灵历史行。
			if (!config.keepAlive) this.discardTranscript(manager);
			throw error;
		}
	}

	/** 重连：同一个对话 / 终端 id 再起一次（远端 attach 持久实例、本地重起进程都由 PTY 叶子决定）。 */
	async reconnect(target: NativeCliTarget): Promise<void> {
		const entry = this.byConversation.get(target.conversationId);
		if (!entry) throw new Error("CLI conversation is not owned by this client");
		const terminals = this.terminalsFor(entry.conversationId, entry.cwd);
		this.installHooks(entry, terminals);
		// 标题以内核那份为准（用户可能刚改过名）：重连后的终端标签跟着它；配置用本对话已解析的那份。
		entry.title = target.title || entry.title;
		const terminal = await terminals.createNativeCli(entry.terminalId, entry.cwd, 100, 30, entry.cwd, entry.title, {
			nativeCli: entry.config,
		});
		if (!terminal) throw new Error("Native CLI process could not be created");
	}

	/** 标题写回：会话文件的 `session_info` 是历史列表的事实源（没有 AgentSession，也就没有第二处要写）。 */
	applyTitle(target: NativeCliTarget): void {
		const entry = this.byConversation.get(target.conversationId);
		if (!entry) return;
		entry.title = target.title;
		try {
			entry.manager.appendSessionInfo(target.title);
		} catch {
			// 老实现同样尽力而为：写不进标题不影响用户继续往 PTY 里输入。
		}
		this.options.refreshSessions();
	}

	private resolveConfig(input: NativeCliConfig): NativeCliConfig {
		// 客户端塞的 model 一律不信任（老口径）：先丢掉，再按设置与当前对话决定是否继承。
		const config: NativeCliConfig = { ...input };
		delete config.model;
		if (config.preset === "custom") return config;
		const inherited = this.options.inheritModel?.(config.preset);
		if (inherited) config.model = inherited;
		return config;
	}

	private terminalsFor(conversationId: string, cwd: string): NativeCliHostTerminals {
		const terminals = this.options.terminalsOf(conversationId, cwd);
		if (!terminals) throw new Error("CLI terminal manager is not available for this conversation");
		if (typeof terminals.createNativeCli !== "function")
			throw new Error("This terminal manager cannot start a native CLI");
		return terminals;
	}

	/** 一条 CLI 账 → PTY 叶子要的观察回调（`reference` / `prepare` / 事件 / 状态 / 暂存 / 进程）。 */
	private installHooks(entry: CliEntry, terminals: NativeCliHostTerminals): void {
		const owned = (): boolean => this.byConversation.get(entry.conversationId) === entry;
		const persist = (binding: NativeCliBinding): void => persistNativeCliBinding(entry.manager, binding);
		const hooks: NativeCliRuntimeHooks = {
			reference: () => ({ key: entry.binding.key, nativeId: entry.binding.nativeId }),
			prepare: async (_id, config, cwd, signal, onEvent, observeOnly) => {
				if (!owned()) throw new Error("CLI conversation is no longer owned by this client");
				return prepareNativeCliRuntimeSession({
					config,
					binding: entry.binding,
					cwd,
					dataDir: this.options.dataDir,
					signal,
					...(observeOnly ? { observeOnly: true } : {}),
					onEvent,
					...(isRemoteWorkspaceUri(cwd) ? { service: this.options.remoteService() ?? undefined } : {}),
					persist,
				});
			},
			onEvent: (terminalId, event) => {
				if (entry.terminalId === terminalId) this.handleEvent(entry, event);
			},
			onStatus: (terminalId, status) => {
				if (entry.terminalId !== terminalId) return;
				this.setStatus(entry, status);
			},
			onRetainFiles: (terminalId, paths) => {
				if (entry.terminalId !== terminalId || !entry.config.keepAlive) return;
				retainNativeCliStagingPaths(entry.binding, paths);
				persist(entry.binding);
			},
			onProcess: (terminalId, created) => {
				if (entry.terminalId !== terminalId) return void 0;
				if (assignNativeCliProcessId(entry.binding, created)) {
					persist(entry.binding);
					// 新进程起来 = 上一代暂存的上传文件已经没人引用：顺手清掉（远端才有的那份账）。
					if (created) void this.cleanupStaging(entry);
				}
				return entry.binding.processId;
			},
		};
		terminals.nativeCliRuntime = hooks;
	}

	/** 状态账：合并/净化单源在叶子，这里只换账 + 催帧（宿主事件驱动，内核不知道这些时刻）。 */
	private setStatus(entry: CliEntry, patch: Partial<NativeCliStatus>): void {
		entry.status = mergeNativeCliStatus(entry.status, patch, this.now());
		if (this.byConversation.get(entry.conversationId) !== entry) return;
		this.options.publish();
		if (patch.phase === "exited") void this.cleanupStaging(entry);
	}

	private handleEvent(entry: CliEntry, event: NativeCliSessionEvent): void {
		if (this.byConversation.get(entry.conversationId) !== entry) return;
		if (event.type === "error" && event.code === "event_observer") {
			const alive = Boolean(
				this.options.terminalsOf(entry.conversationId, entry.cwd)?.getNativeCliTerminal?.(entry.terminalId),
			);
			this.setStatus(entry, observerErrorStatus(entry.status, { message: event.message, terminalAlive: alive }));
			return;
		}
		// 判定（去重/游标/状态补丁/标题回填/四种可广播事件）单源在叶子；副作用在这条 CLI 账上。
		const plan = planNativeCliEvent({
			event,
			binding: entry.binding,
			current: entry.status,
			titleIsDefault: isDefaultNativeCliTitle(entry.title, entry.config.preset, entry.config.executable),
			now: this.now(),
		});
		if (!plan) return;
		if (plan.persist) persistNativeCliBinding(entry.manager, entry.binding);
		if (plan.status) this.setStatus(entry, plan.status);
		if (plan.refreshTitle) this.refreshTitleFromTerminal(entry);
		const sessionId = entry.manager.getSessionId();
		if (plan.submitted) {
			this.options.emit({
				type: "native_cli_prompt_submitted",
				eventId: event.eventId,
				conversationId: entry.conversationId,
				sessionId,
				occurredAt: this.now(),
			});
			return;
		}
		if (!plan.kind) return;
		this.options.notify?.({
			kind: plan.kind,
			eventId: `${entry.binding.key}:${event.eventId}`,
			sessionId,
			conversationId: entry.conversationId,
			occurredAt: this.now(),
		});
		this.options.emit({
			type: "native_cli_event",
			eventId: `${sessionId}:${entry.binding.key}:${event.eventId}`,
			kind: plan.kind,
			conversationId: entry.conversationId,
			sessionId,
			occurredAt: this.now(),
		});
	}

	/** 标题回填：判定单源在 `server/native-cli-title.ts`（老树同一份）。 */
	private refreshTitleFromTerminal(entry: CliEntry): void {
		const raw = this.options.terminalsOf(entry.conversationId, entry.cwd)?.getRawOutput?.(entry.terminalId);
		if (!raw) return;
		const title = nativeCliTitleFromTerminalOutput(raw, {
			title: entry.title,
			preset: entry.config.preset,
			executable: entry.config.executable,
		});
		if (!title) return;
		this.applyTitle({
			conversationId: entry.conversationId,
			terminalId: entry.terminalId,
			config: entry.config,
			cwd: entry.cwd,
			title,
		});
	}

	private async cleanupStaging(entry: CliEntry): Promise<void> {
		if (!isRemoteWorkspaceUri(entry.cwd) || !entry.binding.stagingPaths?.length) return;
		const removed = await cleanupNativeCliStagingFiles({
			binding: entry.binding,
			cwd: entry.cwd,
			service: this.options.remoteService(),
		});
		if (removed.length && this.byConversation.get(entry.conversationId) === entry)
			persistNativeCliBinding(entry.manager, entry.binding);
	}

	/** 起了一半的 CLI：连转录一起收掉（老实现 `rmSync(file, { force: true })` 同一口径）。 */
	private discardTranscript(manager: SessionManager): void {
		const file = manager.getSessionFile();
		if (!file) return;
		try {
			rmSync(file, { force: true });
		} catch {}
	}
}
