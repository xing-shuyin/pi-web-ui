import type { DshPatchPort, EnginePermissionModePort } from "../contracts/engine-extras.js";
import { createEngineExtrasHandlers, type EngineExtrasHandlers } from "../domains/engine-extras/index.js";

export type { EngineExtrasHandlers };

/**
 * 运行时里与引擎专属面有关的那几件现成东西：只有两条端口 thunk。
 * 端口是 thunk 才会等到 `createHostFaces` 那一遍装配（宿主那份服务实例可能压根不存在）。
 */
export interface EngineExtrasRuntime {
	readonly options: {
		/** DSH 补丁面（`DshClientSession` 那六个方法）；缺省 = 未接。 */
		readonly dshPatches?: () => DshPatchPort | undefined;
		/** 引擎自带权限模式（claude driver）；缺省 = 未接。 */
		readonly enginePermissionMode?: () => EnginePermissionModePort | undefined;
	};
}

/**
 * 引擎专属面（DSH 补丁 6 + claude 权限模式 1）的装配：把两条端口 thunk 交给
 * `domains/engine-extras`，那边逐成员转发、未注入即同步抛 `CoreEngineNotReadyError`。
 */
export function createEngineExtrasHandlersFor(runtime: EngineExtrasRuntime): EngineExtrasHandlers {
	return createEngineExtrasHandlers({
		dshPatches: () => runtime.options.dshPatches?.(),
		permissionMode: () => runtime.options.enginePermissionMode?.(),
	});
}
