import type { ModelInfo, ServerMessage } from "../../protocol.js";
import type { TransportPort } from "../../contracts/ports.js";
import { modelRuntimePaths, readModelCatalog, type ModelCatalogRuntime, type ModelRuntimeFactory } from "./catalog.js";

export interface ModelPusherOptions {
	transport: TransportPort;
	agentDir: string;
	runtimeFactory: ModelRuntimeFactory;
	/** 缺省开网刷新（老实现固定 `allowNetwork: true`）。 */
	allowNetwork?: boolean;
}

export interface ModelPusher {
	/** 读目录并下发一帧 `models`：读失败发空表且不抛（老实现同一口径）。 */
	push(): Promise<ModelInfo[]>;
	/** 丢掉缓存的运行时，下次 `push()` 重建（登录态/模型配置变了之后调用）。 */
	invalidate(): void;
}

export function buildModelsFrame(models: readonly ModelInfo[]): ServerMessage {
	return { type: "models", models: [...models] };
}

/**
 * 缓存的是建好的运行时（`create` 要恢复凭据快照，很贵），不是这一帧的表：表每次 push 都重算。
 * 建失败就把缓存清掉，下次 push 重试；`invalidate()` 只断开指针，在飞的那次 push 用自己的引用跑完。
 */
export function createModelPusher(options: ModelPusherOptions): ModelPusher {
	const allowNetwork = options.allowNetwork ?? true;
	let runtime: Promise<ModelCatalogRuntime> | undefined;
	const runtimeOf = (): Promise<ModelCatalogRuntime> => {
		runtime ??= options.runtimeFactory(modelRuntimePaths(options.agentDir)).catch((err: unknown) => {
			runtime = undefined;
			throw err;
		});
		return runtime;
	};
	return {
		async push(): Promise<ModelInfo[]> {
			let models: ModelInfo[];
			try {
				models = await readModelCatalog(await runtimeOf(), allowNetwork);
			} catch {
				models = [];
			}
			if (!options.transport.isClosed()) options.transport.send(buildModelsFrame(models));
			return models;
		},
		invalidate(): void {
			runtime = undefined;
		},
	};
}
