import type { ClientStateStore } from "../../../../../server/client-state.js";
import type { ModelMemoryPort } from "../../contracts/model-admin.js";

/**
 * 项目/全局模型记忆的落盘适配器：只把 `ModelMemoryPort` 的九格转给 `ClientStateStore`。
 *
 * 这里不做任何归一/缓存：`client-state` 才是唯一写入者（P2 之后它会被收进 `SettingsStorePort`，
 * 届时只换这一处实现，域层不用动）。
 */
export function createModelMemory(store: ClientStateStore): ModelMemoryPort {
	return {
		getProjectModel: (clientId, cwd, engine) => store.getProjectModel(clientId, cwd, engine),
		saveProjectModel: (clientId, cwd, modelId, engine) => store.saveProjectModel(clientId, cwd, modelId, engine),
		getProjectProviderKey: (clientId, cwd, provider) => store.getProjectProviderKey(clientId, cwd, provider),
		saveProjectProviderKey: (clientId, cwd, provider, keyName) =>
			store.saveProjectProviderKey(clientId, cwd, provider, keyName),
		deleteProjectProviderKey: (clientId, cwd, provider) => store.deleteProjectProviderKey(clientId, cwd, provider),
		getDefaultModel: (engine) => store.getDefaultModel(engine),
		saveDefaultModel: (modelId, engine) => store.saveDefaultModel(modelId, engine),
		getDefaultProviderKey: (provider) => store.getDefaultProviderKey(provider),
		saveDefaultProviderKey: (provider, keyName) => store.saveDefaultProviderKey(provider, keyName),
	};
}
