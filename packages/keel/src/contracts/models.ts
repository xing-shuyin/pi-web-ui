/** 模型目录的窄面类型：域、适配器、宿主编排三方共用的形状（放 contracts 才不会让适配器反向依赖域）。 */

/** 目录里的一行模型（SDK 的模型对象在适配器里被压成这个形状）。 */
export interface CatalogModel {
	id: string;
	name: string;
	provider: string;
	reasoning: boolean;
	input?: readonly string[];
}

/** 运行时的窄面：只认「刷新目录」「取可用模型」「按 id 取模型对象」「解析启用范围」，本域不碰 SDK。 */
export interface ModelCatalogRuntime {
	refresh(options: { allowNetwork: boolean; signal: AbortSignal }): Promise<unknown>;
	getAvailable(): Promise<readonly CatalogModel[]>;
	/** 按 `provider` + `id` 取模型对象（SDK 的模型实体）：换模型时传给会话，不在内核里拼。 */
	getModel?(provider: string, id: string): unknown | undefined;
	/** 按账号设置（`getEnabledModels` 的模式串）解析「被启用的模型全 id」；不支持则 `undefined`。 */
	enabledScope?(patterns: readonly string[]): Promise<readonly string[] | undefined>;
}

export interface ModelRuntimePaths {
	authPath: string;
	modelsPath: string;
}

export type ModelRuntimeFactory = (paths: ModelRuntimePaths) => Promise<ModelCatalogRuntime>;
