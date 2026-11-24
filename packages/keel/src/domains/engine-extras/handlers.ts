import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { DshPatchPort, EnginePermissionModePort } from "../../contracts/engine-extras.js";

export interface EngineExtrasOptions {
	/** DSH 补丁面（宿主 `core-engine-extras-adapter`）；缺省 = 未接，六个 handler 调到时同步抛。 */
	dshPatches?: () => DshPatchPort | undefined;
	/** 引擎自带权限模式（宿主 `core-engine-extras-adapter`）；缺省 = 未接，`setClaudePermissionMode` 同步抛。 */
	permissionMode?: () => EnginePermissionModePort | undefined;
}

/** 引擎专属面的 7 个 handler：签名与 `DispatchSession` 的同名成员逐字一致。 */
export interface EngineExtrasHandlers {
	listDshPatches(): Promise<void>;
	rescanDshPatches(): Promise<void>;
	installDshPatch(spec: string, id?: string): Promise<void>;
	toggleDshPatch(name: string, enabled: boolean): Promise<void>;
	deleteDshPatch(name: string): Promise<void>;
	fetchDshMarket(force?: boolean): Promise<void>;
	setClaudePermissionMode(mode: string): Promise<void>;
}

/** 端口解析在**调用时**发生：未注入就是同步抛（与 `forkSession` 同一口径，不变成 rejected promise）。 */
function required<T>(port: T | undefined, member: string): T {
	if (!port) throw new CoreEngineNotReadyError(member);
	return port;
}

/**
 * 引擎专属面的 7 个 handler：**只有转发**。
 *
 * 这 7 个成员本来就不是本引擎的语义（DSH 补丁 / claude driver），所以内核里没有一行补丁或 driver 逻辑：
 * 目录扫描、yaml 写入、运行时重启、市场拉取、模式校验、设置落盘与全部出帧都在宿主端口后面
 * （`server/dsh/dsh-agent-service.ts` 与 `server/universal/universal-session.ts`，由
 * `server/core-engine-extras-adapter.ts` 按结构直通包出来）。
 *
 * 事件形状（`dsh_patches` / `dsh_market_data` / `claude_permission` / notice）由宿主那两份实现自己发：
 * 它们是同一份实现的帧，内核再拼一份就是第二套。端口的 `Promise<void>` 就是回执，内核不另行回包。
 */
export function createEngineExtrasHandlers(options: EngineExtrasOptions): EngineExtrasHandlers {
	const dsh = (member: string): DshPatchPort => required(options.dshPatches?.(), member);
	const permission = (): EnginePermissionModePort => required(options.permissionMode?.(), "setClaudePermissionMode");

	return {
		// 同步方法体：端口解析在**调用时**发生（未注入 → 同步抛，不变 rejected promise）。
		listDshPatches(): Promise<void> {
			return dsh("listDshPatches").listPatches();
		},
		rescanDshPatches(): Promise<void> {
			return dsh("rescanDshPatches").rescanPatches();
		},
		installDshPatch(spec: string, id?: string): Promise<void> {
			return dsh("installDshPatch").installPatch(spec, id);
		},
		toggleDshPatch(name: string, enabled: boolean): Promise<void> {
			return dsh("toggleDshPatch").togglePatch(name, enabled);
		},
		deleteDshPatch(name: string): Promise<void> {
			return dsh("deleteDshPatch").deletePatch(name);
		},
		fetchDshMarket(force?: boolean): Promise<void> {
			return dsh("fetchDshMarket").fetchMarket(force);
		},
		setClaudePermissionMode(mode: string): Promise<void> {
			return permission().setMode(mode);
		},
	};
}
