import { ModelRuntime, resolveModelScopeWithDiagnostics } from "@earendil-works/pi-coding-agent";
import type { ModelCatalogRuntime, ModelRuntimePaths } from "../../contracts/models.js";

export type { ModelRuntimePaths };

/**
 * 新树里唯一建 `ModelRuntime` 的地方：`auth.json` / `models.json` 由 SDK 自己读，
 * 本文件不解析、不缓存（缓存与失效在域里，见 `domains/models/push.ts`）。
 *
 * 返回的是窄面包装（不是 SDK 实例本身）：`enabledScope` 要按账号设置解析「哪些模型被启用」，
 * 而 `resolveModelScopeWithDiagnostics` 只认真实例 —— 这层翻译留在适配器里，域只认窄面。
 */
export async function createModelRuntime(paths: ModelRuntimePaths): Promise<ModelCatalogRuntime> {
	const runtime = await ModelRuntime.create({ authPath: paths.authPath, modelsPath: paths.modelsPath });
	return {
		refresh: (options) => runtime.refresh(options),
		getAvailable: () => runtime.getAvailable(),
		getModel: (provider, id) => runtime.getModel(provider, id),
		enabledScope: async (patterns) => {
			if (patterns.length === 0) return undefined;
			const { scopedModels } = await resolveModelScopeWithDiagnostics([...patterns], runtime);
			return scopedModels.map((scoped) => `${scoped.model.provider}/${scoped.model.id}`);
		},
	};
}

/** 与域里 `ModelRuntimeFactory` 结构一致：域不能 import 适配器，靠 app 层把两边接起来。 */
export function createModelRuntimeFactory(): (paths: ModelRuntimePaths) => Promise<ModelCatalogRuntime> {
	return (paths) => createModelRuntime(paths);
}
