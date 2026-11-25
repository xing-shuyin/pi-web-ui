import { join } from "node:path";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "./protocol.js";

export interface GroupRouterModelDirectory {
	getGroupRouterModelRuntime(signal: AbortSignal): Promise<ModelRuntime>;
	listGroupRouterModels(signal: AbortSignal): Promise<ModelInfo[]>;
}

/**
 * 群组路由模型目录：按需初始化并缓存 `ModelRuntime`，供设备中心与群组路由查询可用模型。
 */
export function createGroupRouterModelDirectory(
	resolveAgentDir: () => string = () => process.env.PI_CODING_AGENT_DIR ?? getAgentDir(),
): GroupRouterModelDirectory {
	let cachedRuntime: Promise<ModelRuntime> | undefined;

	const getGroupRouterModelRuntime = async (signal: AbortSignal): Promise<ModelRuntime> => {
		signal.throwIfAborted();
		if (!cachedRuntime) {
			const agentDir = resolveAgentDir();
			cachedRuntime = ModelRuntime.create({
				authPath: join(agentDir, "auth.json"),
				modelsPath: join(agentDir, "models.json"),
			}).catch((error) => {
				cachedRuntime = undefined;
				throw error;
			});
		}
		const runtime = await cachedRuntime;
		signal.throwIfAborted();
		return runtime;
	};

	const listGroupRouterModels = async (signal: AbortSignal): Promise<ModelInfo[]> => {
		signal.throwIfAborted();
		const runtime = await getGroupRouterModelRuntime(signal);
		await runtime.refresh({ allowNetwork: false, signal });
		const models = await runtime.getAvailable(undefined, { signal });
		return models.map((model) => ({
			id: `${model.provider}/${model.id}`,
			name: model.name,
			provider: model.provider,
			reasoning: model.reasoning,
			vision: model.input?.includes("image") ?? false,
		}));
	};

	return {
		getGroupRouterModelRuntime,
		listGroupRouterModels,
	};
}
