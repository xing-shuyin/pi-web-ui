import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SettingsStorePort } from "../../packages/keel/src/contracts/settings-store.js";
import type { ClientState } from "../../packages/keel/src/projects-schema.js";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "../../packages/keel/src/settings-schema.js";

/**
 * `SettingsStorePort` 的测试假体：只在内存里记事，**不重算任何归一化与墓碑规则**
 * （那些是宿主 `ClientStateStore` 的语义，用真 store 的用例请直接 `new ClientStateStore(file)`）。
 *
 * 用途仅限「内核接线」类用例：例如 `CoreEngine` 装配时需要一份设置存储端口。
 */
export interface FakeSettingsStore extends SettingsStorePort {
	/** 最近一次 `removeProject` 与 `mergeDiscoveredProjects` 的调用记录（断言接线用）。 */
	readonly calls: { mergeDiscovered: { path: string; lastUsed: number }[][]; removed: [string, string][] };
}

export function createFakeSettingsStore(): FakeSettingsStore {
	const settings = new Map<string, ClientSettings>();
	const states = new Map<string, ClientState>();
	const projectModels = new Map<string, string>();
	const projectProviderKeys = new Map<string, string>();
	const defaults = new Map<string, string>();
	const defaultProviderKeys = new Map<string, string>();
	const calls: FakeSettingsStore["calls"] = { mergeDiscovered: [], removed: [] };
	let version = 0;

	const stateOf = (clientId: string): ClientState => {
		let state = states.get(clientId);
		if (!state) {
			state = { projects: [] };
			states.set(clientId, state);
		}
		return state;
	};
	const settingsOf = (clientId: string): ClientSettings => {
		let current = settings.get(clientId);
		if (!current) {
			current = structuredClone(DEFAULT_CLIENT_SETTINGS);
			settings.set(clientId, current);
		}
		return current;
	};

	return {
		calls,
		dataDir: mkdtempSync(join(tmpdir(), "fake-settings-store-")),
		getSettings: (clientId) => structuredClone(settingsOf(clientId)),
		getSettingsSnapshot: (clientId) => settingsOf(clientId),
		getSettingsVersion: () => version,
		saveSettings(clientId, patch) {
			settings.set(clientId, { ...settingsOf(clientId), ...patch });
			version += 1;
			return settingsOf(clientId);
		},
		subscribeSettings: () => () => {},
		get: (clientId) => stateOf(clientId),
		saveLocale(clientId, locale) {
			stateOf(clientId).locale = locale;
		},
		mergeDiscoveredProjects(projects) {
			calls.mergeDiscovered.push(projects);
		},
		getRecentProjects: async (clientId) => stateOf(clientId).projects,
		getRemovedProjects: (clientId) => stateOf(clientId).removedProjects ?? [],
		removeProject(clientId, cwd) {
			calls.removed.push([clientId, cwd]);
			stateOf(clientId).removedProjects = [...(stateOf(clientId).removedProjects ?? []), cwd];
		},
		getProjectModel: (clientId, cwd, engine) => projectModels.get(`${clientId}|${cwd}|${engine ?? ""}`),
		saveProjectModel: (clientId, cwd, modelId, engine) =>
			void projectModels.set(`${clientId}|${cwd}|${engine ?? ""}`, modelId),
		getProjectProviderKey: (clientId, cwd, provider) => projectProviderKeys.get(`${clientId}|${cwd}|${provider}`),
		saveProjectProviderKey: (clientId, cwd, provider, keyName) =>
			void projectProviderKeys.set(`${clientId}|${cwd}|${provider}`, keyName),
		deleteProjectProviderKey: (clientId, cwd, provider) =>
			void projectProviderKeys.delete(`${clientId}|${cwd}|${provider}`),
		getDefaultModel: (engine) => defaults.get(engine ?? ""),
		saveDefaultModel: (modelId, engine) => void defaults.set(engine ?? "", modelId),
		getDefaultProviderKey: (provider) => defaultProviderKeys.get(provider),
		saveDefaultProviderKey: (provider, keyName) => void defaultProviderKeys.set(provider, keyName),
	};
}
