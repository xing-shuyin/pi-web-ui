import type { ServerLang } from "../i18n.js";
import type { ServerMessage, UiModelConfigEntry, UiProviderConfig } from "../protocol.js";

/**
 * 项目/全局模型记忆（宿主设置存储的模型窄面）。
 * 落盘归 `client-state`（P2 会收成 `SettingsStorePort`），内核只管「什么时候读写哪一格」。
 */
export interface ModelMemoryPort {
	getProjectModel(clientId: string, cwd: string, engine: string): string | undefined;
	saveProjectModel(clientId: string, cwd: string, modelId: string, engine: string): void;
	getProjectProviderKey(clientId: string, cwd: string, provider: string): string | undefined;
	saveProjectProviderKey(clientId: string, cwd: string, provider: string, keyName: string): void;
	deleteProjectProviderKey(clientId: string, cwd: string, provider: string): void;
	getDefaultModel(engine: string): string | undefined;
	saveDefaultModel(modelId: string, engine: string): void;
	getDefaultProviderKey(provider: string): string | undefined;
	saveDefaultProviderKey(provider: string, keyName: string): void;
}

/**
 * 模型/供应商管理面（宿主能力）。
 *
 * 实现只在宿主：`server/model-admin.ts` 的 `ModelAdminService` 已经把这套行为收在一处
 * （凭据文件、models.json、OAuth 流程、目录探测与增强、出帧）。内核不重写它，只按这个窄面调用；
 * 宿主侧适配器是 `server/core-model-adapter.ts`（结构直通，不做参数搬运）。
 * 签名与原服务逐字对齐：任何参数搬运都会在适配器里长出第二套语义。
 */
export interface ModelAdminPort {
	listProviderKeys(): void;
	setProviderApiKey(provider: string, apiKey: string): Promise<void>;
	addProviderKey(provider: string, apiKey: string, name?: string): Promise<void>;
	activateProviderKey(provider: string, keyName: string, opts?: { silent?: boolean }): Promise<boolean>;
	removeProviderKey(provider: string, keyName: string): Promise<void>;
	clearProviderApiKey(provider: string): Promise<void>;
	getActiveKeyName(provider: string): string | null;
	hasProviderKey(provider: string, keyName: string): boolean;

	listProviders(): Promise<void>;
	listModelsConfig(): Promise<void>;
	reloadModelsConfig(): Promise<void>;
	saveModelConfig(providerId: string, config: UiProviderConfig): Promise<void>;
	deleteModelConfig(providerId: string): Promise<void>;
	cloneProvider(providerId: string, reqId: number): Promise<void>;

	fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		lang?: () => ServerLang,
		providerId?: string,
	): Promise<void>;
	testConnection(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		lang?: () => ServerLang,
		providerId?: string,
	): Promise<void>;
	refreshProviderModels(providerId: string, reqId: number, lang?: () => ServerLang): Promise<void>;
	refreshBuiltinModels(reqId: number): Promise<void>;
	appendBuiltinModel(providerId: string, model: UiModelConfigEntry, reqId: number): Promise<void>;
	enrichModels(
		reqId: number,
		ids: string[],
		hints: Record<string, string> | undefined,
		lang?: () => ServerLang,
	): Promise<void>;
	abortEnrichModels(reqId?: number): void;

	startProviderOAuth(provider: string): string | null;
	replyProviderOAuth(flowId: string, promptId: string, value: string): void;
	cancelProviderOAuth(flowId: string): void;
	listProviderOAuthFlows(): void;
	logoutProviderOAuth(provider: string): Promise<void>;
}

/**
 * 宿主实现 `ModelAdminPort` 时要用到的宿主能力：一帧发给谁、谁来回快照、引擎是否已退出。
 * 内核只声明形状，实现在组合根（`server/index.ts` → `server/core-model-adapter.ts`）。
 */
export interface ModelAdminSinks {
	emit(msg: ServerMessage): void;
	flushSnapshot(): void;
	isDisposed(): boolean;
	pushModels(): Promise<void>;
}
