import { join } from "node:path";
import type { ModelInfo } from "../../../../../server/protocol.js";

/**
 * 运行时给出的模型形状：本域只认这几个字段，与 SDK 的 `Model` 保持结构兼容
 * （多出来的字段不看，字段改名会在这里编译报错，不会静默发出空值）。
 */
export interface CatalogModel {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input?: readonly string[];
}

/** 运行时的窄面：只认「刷新目录」与「取可用模型」，本域不碰 SDK。 */
export interface ModelCatalogRuntime {
	refresh(options: { allowNetwork: boolean; signal: AbortSignal }): Promise<unknown>;
	getAvailable(): Promise<readonly CatalogModel[]>;
}

export interface ModelRuntimePaths {
	authPath: string;
	modelsPath: string;
}

export type ModelRuntimeFactory = (paths: ModelRuntimePaths) => Promise<ModelCatalogRuntime>;

export interface LoadModelCatalogOptions {
	agentDir: string;
	/** 是否允许联网刷新目录：老实现固定开，这里由调用方决定。 */
	allowNetwork: boolean;
	/** 建运行时的工厂：域不能碰 SDK，实体由适配器注入（见 `adapters/models/`）。 */
	runtimeFactory: ModelRuntimeFactory;
}

/** 刷新最长等 15 秒（老实现同一口径）。 */
const REFRESH_TIMEOUT_MS = 15_000;

/** `auth.json` / `models.json` 都落在 agentDir 下；这两个文件的内容由 SDK 自己解析。 */
export function modelRuntimePaths(agentDir: string): ModelRuntimePaths {
	return { authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") };
}

/**
 * SDK 模型 → 协议 `ModelInfo`：字段逐个显式映射。
 * `id` 用 `provider/id`（前端按这个 key 选模型），`name` 去掉目录里标注的 `(new)`，
 * `vision` 由输入模态推导（SDK 没有单独的 vision 字段）。
 */
export function toWireModel(model: CatalogModel): ModelInfo {
	return {
		id: `${model.provider}/${model.id}`,
		name: model.name.replace(/\s*\(new\)$/i, "").trim(),
		provider: model.provider,
		reasoning: model.reasoning,
		vision: model.input?.includes("image") ?? false,
	};
}

/** 刷新 + 取可用模型 + 映射。刷新失败按老实现吞掉：本地快照仍然可用，不该因此丢掉整张表。 */
export async function readModelCatalog(runtime: ModelCatalogRuntime, allowNetwork: boolean): Promise<ModelInfo[]> {
	await runtime.refresh({ allowNetwork, signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS) }).catch(() => {});
	const available = await runtime.getAvailable();
	return available.map(toWireModel);
}

/**
 * 按 `agentDir` 建运行时再读目录。models.json / auth.json 的解析全在 SDK 里（本域不读盘），
 * 所以空目录就是空表而不是异常；运行时建不起来或取模型失败才往外抛，由 pusher 收口成空帧。
 */
export async function loadModelCatalog(options: LoadModelCatalogOptions): Promise<ModelInfo[]> {
	const runtime = await options.runtimeFactory(modelRuntimePaths(options.agentDir));
	return readModelCatalog(runtime, options.allowNetwork);
}
