import type { CoreEngineExtrasSinks } from "../packages/keel/src/app/core-engine.js";
import type { DshPatchPort, EnginePermissionModePort } from "../packages/keel/src/contracts/engine-extras.js";

/**
 * 宿主侧「引擎专属面」适配器：**结构直通，不重写一行逻辑**。
 *
 * 这 7 个分发面成员本来就不属于 pi 引擎（内核 keel 也不认识它们）：
 * - DSH 补丁 6 个 = `DshClientSession` 的六个公开方法（`DshAgentService.get(clientId)`），实现与帧（`dsh_patches` / `dsh_market_data` /
 *   notice）全在 `server/dsh/dsh-agent-service.ts`；
 * - `setClaudePermissionMode` = `UniversalSession.setClaudePermissionMode`
 *   （`server/universal/universal-session.ts:1151`），它写的模块级单例在
 *   `server/universal/drivers/claude-code.ts:58`。
 *
 * 所以这里只做一件事：**把调用按原签名转过去**，外加一道「这条连接跑的不是那个引擎」的可读闸
 * （用用户的 `engine === "dsh"` / `engine === "claude"` 门控之外的漏网之鱼不该看到静默假成功）。
 * 补丁目录、yaml 格式、市场缓存、driver 单例、设置落盘与全部出帧都留在宿主那一份实现里。
 */

/** 宿主那份 DSH 服务里内核用得到的六个公开方法（`DshClientSession` 逐字实现，一行不改）。 */
export interface DshPatchTarget {
	listDshPatches(): Promise<void>;
	rescanDshPatches(): Promise<void>;
	installDshPatch(spec: string, id?: string): Promise<void>;
	toggleDshPatch(name: string, enabled: boolean): Promise<void>;
	deleteDshPatch(name: string): Promise<void>;
	fetchDshMarket(force?: boolean): Promise<void>;
}

/** 宿主那份 universal 会话里内核用得到的一个公开方法（claude / codex / durable 共用同一个类）。 */
export interface EnginePermissionModeTarget {
	setClaudePermissionMode(mode: string): Promise<void>;
}

/**
 * 形状判定（与 `asCoreNativeCliTerminals` 同一手法）：**六个方法齐了才是那个形状**。
 * 那两处实现都是「每客户端一个会话对象」，所以「有没有这口能力」就是「这个对象上有没有这几个方法」。
 */
function shapeOf<T extends object>(target: unknown, members: readonly (keyof T)[]): T | undefined {
	const candidate = target as Partial<Record<keyof T, unknown>> | undefined;
	if (!candidate) return undefined;
	const ok = members.every((member) => typeof candidate[member] === "function");
	return ok ? (candidate as T) : undefined;
}

const DSH_PATCH_MEMBERS = [
	"listDshPatches",
	"rescanDshPatches",
	"installDshPatch",
	"toggleDshPatch",
	"deleteDshPatch",
	"fetchDshMarket",
] as const satisfies readonly (keyof DshPatchTarget)[];

const PERMISSION_MODE_MEMBERS = [
	"setClaudePermissionMode",
] as const satisfies readonly (keyof EnginePermissionModeTarget)[];

/** DSH 补丁面要拼的两件事：这条连接的引擎名 + 那个会话对象（没连过就是 undefined）。 */
export interface CoreDshPatchSinks extends CoreEngineExtrasSinks {
	/** 这条连接当前的引擎（宿主 `resolveClientEngine`，调用时现取）。 */
	engine(): string;
	/** 这条连接在 DSH 引擎上的会话（`DshAgentService.get(clientId)`）；没连过 = undefined。 */
	session(): unknown;
}

/** 权限模式面要拼的两件事：同上的引擎名 + 那个会话对象。 */
export interface CoreEnginePermissionSinks extends CoreEngineExtrasSinks {
	engine(): string;
	/** 这条连接在 universal 引擎（claude）上的会话（`UniversalAgentService.get(clientId)`）。 */
	session(): unknown;
}

const DSH_ENGINE = "dsh";
const CLAUDE_ENGINE = "claude";

/** 引擎不对时的可读错：说清「这口能力属于哪个引擎」「现在这条连接是哪个引擎」。 */
function engineMismatch(what: string, expected: string, actual: string): Error {
	return new Error(`${what} is only available on the ${expected} engine: this connection runs the "${actual}" engine`);
}

/** 服务实例不在时的可读错：不是「成功但没反应」，而是明说进程里没有那一份实现。 */
function noSession(what: string, expected: string): Error {
	return new Error(`${what} is unavailable: this process has no live ${expected} session for this client`);
}

/**
 * DSH 补丁管理面：六个方法逐一转给 `DshClientSession` 的同名方法。
 *
 * 六个方法都由宿主自己出帧（`dsh_patches` / `dsh_market_data` / notice），端口不再回包。
 * 引擎不对或服务不在时**同步抛**可读错（`void cs.listDshPatches?.()` 那条派发路径会兜成一条 notice）。
 */
export function createCoreDshPatches(sinks: CoreDshPatchSinks): DshPatchPort {
	const target = (member: string): DshPatchTarget => {
		const engine = sinks.engine();
		if (engine !== DSH_ENGINE) throw engineMismatch(`dsh patch management (${member})`, DSH_ENGINE, engine);
		const session = shapeOf<DshPatchTarget>(sinks.session(), DSH_PATCH_MEMBERS);
		if (!session) throw noSession(`dsh patch management (${member})`, DSH_ENGINE);
		return session;
	};

	return {
		// 同步方法体：闸门在**调用时**判定（不进 Promise，派发层照常拿得到一条 notice）。
		listPatches(): Promise<void> {
			return target("listDshPatches").listDshPatches();
		},
		rescanPatches(): Promise<void> {
			return target("rescanDshPatches").rescanDshPatches();
		},
		installPatch(spec: string, id?: string): Promise<void> {
			return target("installDshPatch").installDshPatch(spec, id);
		},
		togglePatch(name: string, enabled: boolean): Promise<void> {
			return target("toggleDshPatch").toggleDshPatch(name, enabled);
		},
		deletePatch(name: string): Promise<void> {
			return target("deleteDshPatch").deleteDshPatch(name);
		},
		fetchMarket(force?: boolean): Promise<void> {
			return target("fetchDshMarket").fetchDshMarket(force);
		},
	};
}

/**
 * 引擎自带权限模式：一个方法直接转给 `UniversalSession.setClaudePermissionMode`。
 *
 * 未知模式只发 warning notice、设置未改 —— 那是宿主那份实现的口径，这里不改写。
 * 非 claude 引擎（codex / durable 也共用 `UniversalSession`，但 driver 没有 `permissionModeOptions`）
 * 一律回可读错：静默成功会让人以为权限档位真改了。
 */
export function createCoreEnginePermissionMode(sinks: CoreEnginePermissionSinks): EnginePermissionModePort {
	const target = (): EnginePermissionModeTarget => {
		const engine = sinks.engine();
		if (engine !== CLAUDE_ENGINE) throw engineMismatch("setClaudePermissionMode", CLAUDE_ENGINE, engine);
		const session = shapeOf<EnginePermissionModeTarget>(sinks.session(), PERMISSION_MODE_MEMBERS);
		if (!session) throw noSession("setClaudePermissionMode", CLAUDE_ENGINE);
		return session;
	};

	return {
		setMode(mode: string): Promise<void> {
			return target().setClaudePermissionMode(mode);
		},
	};
}
