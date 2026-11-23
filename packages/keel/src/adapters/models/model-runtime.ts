import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export interface ModelRuntimePaths {
	authPath: string;
	modelsPath: string;
}

/**
 * 新树里唯一建 `ModelRuntime` 的地方：`auth.json` / `models.json` 由 SDK 自己读，
 * 本文件不解析、不缓存（缓存与失效在域里，见 `domains/models/push.ts`）。
 */
export function createModelRuntime(paths: ModelRuntimePaths): Promise<ModelRuntime> {
	return ModelRuntime.create({ authPath: paths.authPath, modelsPath: paths.modelsPath });
}

/** 与域里 `ModelRuntimeFactory` 结构一致：域不能 import 适配器，靠 app 层把两边接起来。 */
export function createModelRuntimeFactory(): (paths: ModelRuntimePaths) => Promise<ModelRuntime> {
	return (paths) => createModelRuntime(paths);
}
