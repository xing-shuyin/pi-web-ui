import { CoreEngineNotReadyError } from "../contracts/core-engine-errors.js";
import type { ClientId } from "../contracts/ids.js";
import type { TransportPort } from "../contracts/ports.js";
import type { SandboxPort } from "../contracts/sandbox.js";
import type { SettingsStorePort } from "../contracts/settings-store.js";
import type { ServerMessage, SessionSearchResult } from "../protocol.js";
import type { SessionListScanState } from "../session-list-scan.js";
import { searchSessions } from "../session-search.js";
import { PI_AGENT_PRESETS, PI_PERMISSION_OPTIONS } from "../tool-catalog.js";
import {
	applySessionListLimit,
	scanHistory,
	sessionSummaryOf,
	type HistoryEntry,
	type SessionListLimits,
} from "../domains/history/index.js";

/** 一次全局检索最多回多少条（老实现 `searchSessions` 的 `.slice(0, 50)` 同口径）。 */
const MAX_SEARCH_RESULTS = 50;

/**
 * 运行时里这几个成员用到的那几件现成东西：不认 `ClientRuntime`，只认这张窄面
 * （同 `NativeCliRuntime` / `BotChatRuntime` 的做法，省掉一次 app 内的类型回环）。
 */
export interface ExtraHandlerRuntime {
	readonly clientId: ClientId;
	/** 宿主能力全是 thunk：装配期端口还没建好。 */
	readonly options: {
		readonly transport: TransportPort;
		readonly stateStore?: () => SettingsStorePort | undefined;
		readonly sandbox?: () => SandboxPort | undefined;
	};
	/** 工作区根（`list_sessions` 的缺省 cwd、检索结果的项目归属都看它）。 */
	readonly cwd: string;
	/** 本项目的会话目录（没开过会话就是 `undefined`：这时没有历史可检索）。 */
	historyRoot(): string | undefined;
	/** 续扫状态：与 `sessions` 帧共读一份（`ClientRuntime.historyState()`）。 */
	historyState(): ReadonlyMap<string, SessionListScanState>;
	/** 每项目会话列表条数表：`sessions` 帧出口读同一份（`ClientRuntime.sessionLimits`）。 */
	readonly sessionLimits: SessionListLimits;
	/** 刷一帧快照（`publisher.request()`）。 */
	readonly publisher: { request(): void };
}

/** 帧出口里这几个成员用到的那两条（`ClientFrames` 的子集，够用就不搬整张面）。 */
export interface ExtraFrames {
	pushProjects(): Promise<void>;
	pushSettings(): void;
}

/** 端口已齐、只差一条 handler 的 6 个成员（第 7 个 `scmQuery` 在 `domains/files`）。 */
export interface ExtraHandlers {
	setSessionListLimit(cwd: string, limit?: number): number;
	removeProject(path: string): Promise<void>;
	searchSessions(query: string, reqId: number): Promise<void>;
	refreshAgentPresets(): Promise<void>;
	setDefaultAgentPreset(preset: string): Promise<void>;
	setDefaultPermissionPreset(preset: string): Promise<void>;
}

/**
 * `HistoryEntry` → 检索器（`session-search.ts`）要的 `SessionInfo` 形状。
 *
 * 检索只读 `path` / `name` / `firstMessage` / `modified` / `messageCount`：
 * - 标题已经在 `HistoryEntry.title` 里合过（名字优先、否则首条消息），所以不再写 `name`（写了两处会打架）；
 * - `created` / `allMessagesText` 检索不读，历史条目也没有这两个值：给一个不编造的占位（同 `session-list-scan` 的 `allMessagesText: ""`）。
 */
function searchableOf(entry: HistoryEntry): {
	path: string;
	id: string;
	cwd: string;
	created: Date;
	modified: Date;
	messageCount: number;
	firstMessage: string;
	allMessagesText: string;
} {
	const modified = new Date(entry.updatedAt);
	return {
		path: entry.sessionFile,
		id: entry.id,
		cwd: entry.cwd,
		created: modified,
		modified,
		messageCount: entry.messageCount,
		firstMessage: entry.title,
		allMessagesText: "",
	};
}

/**
 * 六个「端口/域/帧都齐、只差 handler」的成员：这里只做编排，能力本身都在既有域与端口后面
 * （分页状态在 `domains/history/limit.ts`、检索在 `session-search.ts`、预设目录在 `tool-catalog.ts`、
 * 项目墓碑与沙盒销毁在 `SettingsStorePort` / `SandboxPort`）。
 *
 * 失败口径与全库一致：**端口没注入就同步抛** `CoreEngineNotReadyError`（所以成员本身不写成 `async`，
 * 否则同步抛会变成 rejected promise）。真正要 await 的部分在下面几个 `async` 内部函数里。
 *
 * `frames` 单独传：帧出口是 `handlers()` 里的本地闭包（运行时字段是私有的），成员函数只需要那两条。
 */
export function createExtraHandlers(runtime: ExtraHandlerRuntime, frames: () => ExtraFrames): ExtraHandlers {
	const store = (what: string): SettingsStorePort => {
		const port = runtime.options.stateStore?.();
		if (!port) throw new CoreEngineNotReadyError(what);
		return port;
	};
	const sandbox = (): SandboxPort => {
		const port = runtime.options.sandbox?.();
		// 判「这个项目是不是沙盒」只能问沙盒面：缺了它就不敢动墓碑（会留下一个删不掉的沙盒）。
		if (!port) throw new CoreEngineNotReadyError("removeProject");
		return port;
	};
	const send = (msg: ServerMessage): void => {
		if (runtime.options.transport.isClosed()) return;
		runtime.options.transport.send(msg);
	};
	const notice = (text: string, textEn: string): void => send({ type: "notice", level: "warning", text, textEn });
	const presetsFrame = (defaultPreset: string): ServerMessage => ({
		type: "dsh_presets",
		presets: PI_AGENT_PRESETS,
		defaultPreset,
	});
	const permissionFrame = (defaultPreset: string): ServerMessage => ({
		type: "dsh_permission",
		options: PI_PERMISSION_OPTIONS,
		defaultPreset,
	});

	/** 老实现 `removeProject`：沙盒先销毁（销毁里连墓碑与 projects 帧一起走），否则只清墓碑 + 推 projects。 */
	const removeProject = async (
		ports: { store: SettingsStorePort; sandbox: SandboxPort },
		path: string,
	): Promise<void> => {
		const located = await ports.sandbox.locate(path);
		if (located) await ports.sandbox.destroy(located.path);
		ports.store.removeProject(runtime.clientId, located ? located.path : path);
		await frames().pushProjects();
		// 沙盒销毁会换掉工作区周边的东西：老实现在这条分支上刷一次快照，非沙盒分支不刷（逐字同口径）。
		if (located) runtime.publisher.request();
	};

	/** 上一轮检索：新的一次到达时先中止它（老实现 `sessionSearchController` 同口径）。 */
	let searching: AbortController | undefined;
	const search = async (ports: SettingsStorePort, query: string, reqId: number): Promise<void> => {
		searching?.abort();
		const controller = new AbortController();
		searching = controller;
		const cwd = runtime.cwd;
		const q = query.trim().toLowerCase();
		const reply = (ok: boolean, results: SessionSearchResult[]): void => {
			// 用户切走了项目 / 这次被下一次检索顶掉：回包已经没有意义，别把别的项目的结果塞给当前项目。
			if (controller.signal.aborted || runtime.cwd !== cwd) return;
			send({ type: "session_search_results", reqId, query, ok, results });
		};
		try {
			const root = runtime.historyRoot();
			if (!q || !root) {
				reply(true, []);
				return;
			}
			const scanned = await scanHistory({ root, state: runtime.historyState() });
			controller.signal.throwIfAborted();
			const matched = await searchSessions(scanned.entries.map(searchableOf), q, { signal: controller.signal });
			const byFile = new Map(scanned.entries.map((entry) => [entry.sessionFile, entry]));
			const results: SessionSearchResult[] = [];
			for (const { session, anchors } of matched) {
				const entry = byFile.get(session.path);
				// 帧里的摘要与 `sessions` 帧同一份（`sessionSummaryOf`）：检索结果不多一套形状。
				if (entry)
					results.push({ ...sessionSummaryOf(entry, (owner, file) => ports.isSessionPinned(owner, file)), anchors });
			}
			results.sort((a, b) => b.modified - a.modified);
			reply(true, results.slice(0, MAX_SEARCH_RESULTS));
		} catch {
			reply(false, []);
		} finally {
			if (searching === controller) searching = undefined;
		}
	};

	const refreshAgentPresets = async (ports: SettingsStorePort): Promise<void> => {
		send(presetsFrame(ports.getSettings(runtime.clientId).defaultAgentPreset ?? "standard"));
	};

	const setDefaultAgentPreset = async (ports: SettingsStorePort, preset: string): Promise<void> => {
		const hit = PI_AGENT_PRESETS.find((p) => p.id === preset);
		if (!hit) {
			notice(`未知预设「${preset}」，默认预设未改`, `Unknown preset "${preset}"; default preset unchanged`);
			return;
		}
		const saved = ports.saveSettings(runtime.clientId, { defaultAgentPreset: hit.id });
		frames().pushSettings();
		send(presetsFrame(saved.defaultAgentPreset ?? hit.id));
		runtime.publisher.request();
	};

	const setDefaultPermissionPreset = async (ports: SettingsStorePort, preset: string): Promise<void> => {
		const hit = PI_PERMISSION_OPTIONS.find((p) => p.value === preset);
		if (!hit) {
			notice(`未知权限预设「${preset}」，默认未改`, `Unknown permission preset "${preset}"; default unchanged`);
			return;
		}
		const saved = ports.saveSettings(runtime.clientId, { defaultPermissionPreset: hit.value });
		send(permissionFrame(saved.defaultPermissionPreset ?? hit.value));
		runtime.publisher.request();
	};

	return {
		// 纯内存态：这次要多少条记在每项目一张表里，帧出口下一次扫盘就按它截断（`hasMore` 由它判）。
		setSessionListLimit: (cwd, limit) => applySessionListLimit(runtime.sessionLimits, cwd, limit),
		removeProject: (path) => removeProject({ store: store("removeProject"), sandbox: sandbox() }, path),
		searchSessions: (query, reqId) => search(store("searchSessions"), query, reqId),
		refreshAgentPresets: () => refreshAgentPresets(store("refreshAgentPresets")),
		setDefaultAgentPreset: (preset) => setDefaultAgentPreset(store("setDefaultAgentPreset"), preset),
		setDefaultPermissionPreset: (preset) => setDefaultPermissionPreset(store("setDefaultPermissionPreset"), preset),
	};
}
