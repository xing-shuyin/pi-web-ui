import type { ModelMemoryPort } from "../../contracts/model-admin.js";
import type { SettingsStorePort } from "../../contracts/settings-store.js";

/**
 * 宿主设置存储里「老 `client-state`」那一侧的可选维护口：
 * 单个项目 pin 的读写是 `SettingsStorePort` 的正式成员，而「枚举一个项目的全部 key」与
 * 「删 key 之后改指」是尽力而为的旁路记账（老 `ClientStateStore` 早就有，窄面还没收进来）。
 */
type MaintenanceStore = SettingsStorePort & {
	getProjectProviderKeys?(clientId: string, cwd: string): Record<string, string> | undefined;
	repointDeletedKeyEverywhere?(provider: string, deletedKeyName: string, newActive: string | null): number;
	repointDeletedKeyInDefault?(provider: string, deletedKeyName: string, newActive: string | null): void;
};

/**
 * 项目/全局模型记忆的落盘适配器：只把 `ModelMemoryPort` 的每一格转给 `SettingsStorePort`。
 *
 * 这里不做任何归一/缓存：宿主设置存储才是唯一写入者（`server/core-state-adapter.ts` 注入端口实例）。
 */
export function createModelMemory(store: SettingsStorePort): ModelMemoryPort {
	const host: MaintenanceStore = store;
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
		// 三个可选口只做直通：宿主没实现就返回 undefined / 什么也不做（不在这里另写一套记忆）。
		getProjectProviderKeys: (clientId, cwd) => host.getProjectProviderKeys?.(clientId, cwd),
		repointDeletedKeyEverywhere: (provider, deletedKeyName, newActive) => {
			host.repointDeletedKeyEverywhere?.(provider, deletedKeyName, newActive);
		},
		repointDeletedKeyInDefault: (provider, deletedKeyName, newActive) => {
			host.repointDeletedKeyInDefault?.(provider, deletedKeyName, newActive);
		},
	};
}
