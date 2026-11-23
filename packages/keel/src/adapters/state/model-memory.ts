import type { ModelMemoryPort } from "../../contracts/model-admin.js";
import type { SettingsStorePort } from "../../contracts/settings-store.js";

/**
 * 项目/全局模型记忆的落盘适配器：只把 `ModelMemoryPort` 的九格转给 `SettingsStorePort`。
 *
 * 这里不做任何归一/缓存：宿主设置存储才是唯一写入者（`server/core-state-adapter.ts` 注入端口实例）。
 */
export function createModelMemory(store: SettingsStorePort): ModelMemoryPort {
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
