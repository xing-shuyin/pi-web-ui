import type { ClientState } from "../projects-schema.js";
import type { ClientSettings, SharedSettingsChange } from "../settings-schema.js";

/**
 * 一条「中断时还在跑」的记录（`client-state.json` 里 `interrupted` 的元素）。
 * 形状与宿主 `ClientStateStore.saveInterrupted` 的入参逐字一致：`sessionFile` 在续跑时用来精确认领
 * （`dropInterrupted` 按它剔除），`at` 决定是不是「刚断的」（超过 TTL 只提示、不自动重跑）。
 */
export interface InterruptedRunRecord {
	title: string;
	cwd: string;
	at: number;
	sessionFile?: string;
}

/**
 * 设置存储（宿主 `ClientStateStore` 的窄面）。
 *
 * 实现只在宿主：`server/client-state.ts` 是 `client-state.json` 的唯一写入者（归一化、版本号递增、
 * 订阅回调、墓碑规则全在那边）。内核不重写它，只按这个窄面读写；宿主侧适配器是
 * `server/core-state-adapter.ts`（结构直通，不做参数搬运）。
 *
 * 签名与 `ClientStateStore` 逐字对齐：任何参数搬运都会在适配器里长出第二套语义。
 */
export interface SettingsStorePort {
	/** `client-state.json` 所在目录（模板 / 审批规则库等按它定位）。 */
	readonly dataDir: string;

	/** 生效设置的深拷贝（每次调用都返回新对象）。 */
	getSettings(clientId: string): ClientSettings;
	/** 冻结的生效设置（同一份单例，只读用）。 */
	getSettingsSnapshot(clientId: string): ClientSettings;
	getSettingsVersion(): number;
	saveSettings(clientId: string, settings: Partial<ClientSettings>): ClientSettings;
	/** 设置变更订阅：返回退订函数。 */
	subscribeSettings(listener: (change: SharedSettingsChange) => void | Promise<void>): () => void;

	/** 客户端状态的只读投影（`projects` 缺省是空数组）。 */
	get(clientId: string): ClientState;
	saveLocale(clientId: string, locale: string): void;
	/** 目标审查偏好：目标运行在宿主，偏好本身是客户端状态，唯一写者仍是 `client-state.json`。 */
	getGoalPrefs(clientId: string): ClientState["goalPrefs"];
	saveGoalPrefs(clientId: string, prefs: ClientState["goalPrefs"]): void;

	/** 项目最近列表的写回（扫盘发现的项目灌进 store，墓碑与排序规则在 store 里）。 */
	mergeDiscoveredProjects(projects: { path: string; lastUsed: number }[]): void;
	getRecentProjects(clientId: string): Promise<{ path: string; lastUsed: number }[]>;
	/** 用户明确移除过的路径（墓碑）。 */
	getRemovedProjects(clientId: string): string[];
	removeProject(clientId: string, cwd: string): void;

	getProjectModel(clientId: string, cwd: string, engine?: string): string | undefined;
	saveProjectModel(clientId: string, cwd: string, modelId: string, engine?: string): void;
	getProjectProviderKey(clientId: string, cwd: string, provider: string): string | undefined;
	saveProjectProviderKey(clientId: string, cwd: string, provider: string, keyName: string): void;
	deleteProjectProviderKey(clientId: string, cwd: string, provider: string): void;
	/** 额外工作区根的持久化（`client-state` 按「客户端 + cwd」记账）：换工作区要读回它。 */
	getWorkspaceRoots(clientId: string, cwd: string): string[];
	saveWorkspaceRoots(clientId: string, cwd: string, roots: string[]): void;

	/** 会话钉住（历史行 📌）：按会话自己 header 的 cwd 记账，跨项目不串台。 */
	setSessionPinned(cwd: string, sessionPath: string, pinned: boolean): void;
	isSessionPinned(cwd: string, sessionPath: string): boolean;
	/**
	 * 会话文件没了之后清掉它的钉子（按文件路径清，不需要知道它归属哪个项目）：
	 * 可选——没实现就不清，代价只是磁盘里留一条指向不存在文件的钉住。
	 */
	clearPinnedSession?(sessionPath: string): void;

	/**
	 * 中断记账（重启续跑列表的源）：一轮正在跑时进程被停，`recordInterruptedRuns()` 把当时还在跑的会话
	 * 写进来，重启后由续跑链路读回。签名与宿主 `ClientStateStore.saveInterrupted` 逐字一致。
	 *
	 * 可选的理由：这是「尽力而为」的旁路记账（老实现整段 try/catch 兜住），不是能力依赖；
	 * 宿主没实现 = 不记账，别为了它把 `SettingsStorePort` 变成硬依赖。
	 */
	saveInterrupted?(clientId: string, list: InterruptedRunRecord[]): void;

	getDefaultModel(engine?: string): string | undefined;
	saveDefaultModel(modelId: string, engine?: string): void;
	getDefaultProviderKey(provider: string): string | undefined;
	saveDefaultProviderKey(provider: string, keyName: string): void;
}
