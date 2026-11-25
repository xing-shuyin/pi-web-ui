import { CoreEngineNotReadyError } from "../../contracts/core-engine-errors.js";
import type { ModelAdminPort, ProjectKeyPins } from "../../contracts/model-admin.js";
import type { ServerLang } from "../../i18n.js";
import type { UiModelConfigEntry, UiProviderConfig } from "../../protocol.js";

export interface ProviderHandlersOptions {
	/** 缺省 = 未接：每个 handler 调到时同步抛 `CoreEngineNotReadyError`（与注册表口径一致）。 */
	modelAdmin?: ModelAdminPort;
	/** 项目级 key 记忆的写入口；缺省 = 只动凭据，不写项目 pin。 */
	projectKeys?: ProjectKeyPins;
	/** 当前语言（`fetchModelsList` / `testConnection` / `refreshProviderModels` / `enrichModels` 都要）。 */
	getLang(): ServerLang;
}

/**
 * 供应商/模型管理面的 24 个 handler：每个成员只是把参数按位交给 `ModelAdminPort`。
 * 凭据、`models.json`、OAuth、目录探测与出帧全部归宿主端口，这里不许插业务分支。
 */
export interface ProviderHandlers {
	setProviderApiKey(provider: string, apiKey: string): Promise<void>;
	clearProviderApiKey(provider: string): Promise<void>;
	startProviderOAuth(provider: string): void;
	replyProviderOAuth(flowId: string, promptId: string, value: string): void;
	cancelProviderOAuth(flowId: string): void;
	listProviderOAuthFlows(): void;
	logoutProviderOAuth(provider: string): Promise<void>;
	listModelsConfig(): Promise<void>;
	reloadModelsConfig(): Promise<void>;
	saveModelConfig(providerId: string, config: unknown): Promise<void>;
	deleteModelConfig(providerId: string): Promise<void>;
	listProviders(): Promise<void>;
	listProviderKeys(): void;
	addProviderKey(provider: string, apiKey: string, name?: string): Promise<void>;
	activateProviderKey(provider: string, keyName: string): Promise<void>;
	removeProviderKey(provider: string, keyName: string): Promise<void>;
	fetchModelsList(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void>;
	testModelConnection(
		reqId: number,
		baseUrl: string,
		apiKey?: string,
		authHeader?: boolean,
		api?: string,
		providerId?: string,
	): Promise<void>;
	refreshProviderModels(providerId: string, reqId: number): Promise<void>;
	refreshBuiltinModels(reqId: number): Promise<void>;
	appendBuiltinModel(providerId: string, model: unknown, reqId: number): Promise<void>;
	cloneProvider(provider: string, reqId: number): Promise<void>;
	enrichModels(reqId: number, ids: string[], hints?: Record<string, string>): Promise<void>;
	abortEnrichModels(reqId?: number): void;
}

/**
 * 端口的「取不到就同步抛」在工厂里一次解决：handler 一律写成返回端口的 promise，
 * 而不是 `async` 箭头——`async` 会把缺端口的同步抛变成 rejected promise，注册表口径就变了。
 */
export function createProviderHandlers(options: ProviderHandlersOptions): ProviderHandlers {
	const lang = (): ServerLang => options.getLang();
	const port = (what: string): ModelAdminPort => {
		const admin = options.modelAdmin;
		if (!admin) throw new CoreEngineNotReadyError(what);
		return admin;
	};
	/** 项目级 key 记忆：没接就是 `undefined`，handler 仍原样转发给端口。 */
	const pins = (): ProjectKeyPins | undefined => options.projectKeys;
	return {
		setProviderApiKey: (provider, apiKey) => port("setProviderApiKey").setProviderApiKey(provider, apiKey),
		clearProviderApiKey: (provider) => port("clearProviderApiKey").clearProviderApiKey(provider),
		// 端口给 flowId、协议是 void：回包只走端口内部的帧，不在这里拼。
		startProviderOAuth: (provider) => void port("startProviderOAuth").startProviderOAuth(provider),
		replyProviderOAuth: (flowId, promptId, value) =>
			port("replyProviderOAuth").replyProviderOAuth(flowId, promptId, value),
		cancelProviderOAuth: (flowId) => port("cancelProviderOAuth").cancelProviderOAuth(flowId),
		listProviderOAuthFlows: () => port("listProviderOAuthFlows").listProviderOAuthFlows(),
		logoutProviderOAuth: (provider) => port("logoutProviderOAuth").logoutProviderOAuth(provider),
		listModelsConfig: () => port("listModelsConfig").listModelsConfig(),
		reloadModelsConfig: () => port("reloadModelsConfig").reloadModelsConfig(),
		// 协议侧 `config` 是 unknown：窄强制转换是唯一允许的动作，校验/补默认值会在适配器里长出第二套语义。
		saveModelConfig: (providerId, config) =>
			port("saveModelConfig").saveModelConfig(providerId, config as UiProviderConfig),
		deleteModelConfig: (providerId) => port("deleteModelConfig").deleteModelConfig(providerId),
		listProviders: () => port("listProviders").listProviders(),
		listProviderKeys: () => port("listProviderKeys").listProviderKeys(),
		addProviderKey: (provider, apiKey, name) => port("addProviderKey").addProviderKey(provider, apiKey, name),
		// 端口返回 boolean（是否真的切换了）且内部已经 emit 过 notice：返回值与协议 void 对齐后丢弃，
		// 但**项目 pin 要立刻落盘**（老 `agent-service.ts:9538`）：切成功就记住这个项目的选择，
		// 失败（key 不存在）就把那条记忆删掉，否则下次进项目会去激活一个不存在的 key。
		activateProviderKey: (provider, keyName) => {
			const admin = port("activateProviderKey");
			const target = pins();
			return admin.activateProviderKey(provider, keyName).then((ok) => {
				if (!target) return;
				if (ok) target.remember(provider, keyName);
				else target.forget(provider);
			});
		},
		// 删掉 key 之后把指向它的项目/全局引用改指新的 active（老 `agent-service.ts:9543`）。
		removeProviderKey: (provider, keyName) => {
			const admin = port("removeProviderKey");
			const target = pins();
			return admin.removeProviderKey(provider, keyName).then(() => {
				target?.repointDeleted(provider, keyName, admin.getActiveKeyName(provider));
			});
		},
		// 端口的 `lang` 在倒数第二位（providerId 之后没有参数），逐个对位，别按协议顺序猜。
		fetchModelsList: (reqId, baseUrl, apiKey, authHeader, api, providerId) =>
			port("fetchModelsList").fetchModelsList(reqId, baseUrl, apiKey, authHeader, api, lang, providerId),
		testModelConnection: (reqId, baseUrl, apiKey, authHeader, api, providerId) =>
			port("testModelConnection").testConnection(reqId, baseUrl, apiKey, authHeader, api, lang, providerId),
		refreshProviderModels: (providerId, reqId) =>
			port("refreshProviderModels").refreshProviderModels(providerId, reqId, lang),
		refreshBuiltinModels: (reqId) => port("refreshBuiltinModels").refreshBuiltinModels(reqId),
		appendBuiltinModel: (providerId, model, reqId) =>
			port("appendBuiltinModel").appendBuiltinModel(providerId, model as UiModelConfigEntry, reqId),
		cloneProvider: (provider, reqId) => port("cloneProvider").cloneProvider(provider, reqId),
		enrichModels: (reqId, ids, hints) => port("enrichModels").enrichModels(reqId, ids, hints, lang),
		abortEnrichModels: (reqId) => port("abortEnrichModels").abortEnrichModels(reqId),
	};
}
