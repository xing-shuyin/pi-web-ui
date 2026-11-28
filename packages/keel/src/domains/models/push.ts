import type { ModelInfo, ServerMessage } from "../../protocol.js";
import type { TransportPort } from "../../contracts/ports.js";
import { modelRuntimePaths, readModelCatalog, type ModelCatalogRuntime, type ModelRuntimeFactory } from "./catalog.js";

export interface ModelPusherOptions {
	transport: TransportPort;
	agentDir: string;
	runtimeFactory: ModelRuntimeFactory;
	/** 已开会话的运行时（含扩展注册的 provider，如 CLIProxyAPI，#1030）。 */
	sessionRuntime?: () => ModelCatalogRuntime | undefined;
	/** 缺省开网刷新（老实现固定 `allowNetwork: true`）。 */
	allowNetwork?: boolean;
	/**
	 * 账号启用范围（SDK 设置层的 `getEnabledModels()` 模式串）：
	 * 非空时给每行模型酷上 `enabled`，模型选择器据此把未启用项收到「显示全部」后面。
	 * 不提供（或拿不到）就不带该字段——纯映射函数不猜账号设置。
	 */
	enabledPatterns?: () => readonly string[] | undefined;
}

export interface ModelPusher {
	/** 读目录并下发一帧 `models`：读失败发空表且不抛（老实现同一口径）。 */
	push(): Promise<ModelInfo[]>;
	/** 丢掉缓存的运行时，下次 `push()` 重建（登录态/模型配置变了之后调用）。 */
	invalidate(): void;
	/** 按 `provider/id` 取模型对象（换模型时传给会话）；运行时建不出或目录不支持则 `undefined`。 */
	getModel(provider: string, id: string): Promise<unknown | undefined>;
}

/**
 * 叠加启用范围（老实现口径：拿不到范围就**不带** `enabled` 字段，而不是全标 true）。
 * 解析失败同样当作「没有范围」：模型选择器宁可全部展示，也不能把整个目录标记成禁用。
 */
async function withEnabledScope(
	runtime: ModelCatalogRuntime,
	models: readonly ModelInfo[],
	enabledPatterns?: () => readonly string[] | undefined,
): Promise<ModelInfo[]> {
	const patterns = enabledPatterns?.() ?? [];
	if (patterns.length === 0 || !runtime.enabledScope) return [...models];
	let enabled: ReadonlySet<string> | undefined;
	try {
		enabled = new Set((await runtime.enabledScope(patterns)) ?? []);
	} catch {
		return [...models];
	}
	return models.map((model) => ({ ...model, enabled: enabled?.has(model.id) ?? false }));
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
				const runtime = options.sessionRuntime?.() ?? (await runtimeOf());
				models = await readModelCatalog(runtime, allowNetwork);
				models = await withEnabledScope(runtime, models, options.enabledPatterns);
			} catch {
				models = [];
			}
			if (!options.transport.isClosed()) options.transport.send(buildModelsFrame(models));
			return models;
		},
		invalidate(): void {
			runtime = undefined;
		},
		async getModel(provider: string, id: string): Promise<unknown | undefined> {
			try {
				return (await runtimeOf()).getModel?.(provider, id);
			} catch {
				return undefined;
			}
		},
	};
}
