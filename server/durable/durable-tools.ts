import { loadDurableModule } from "./durable-loader.js";

export interface DurableToolsSetup {
	registry: any;
	installedToolNames: string[];
}

export async function setupDurableRegistry(
	cwd: string,
	_options?: {
		allowDangerous?: boolean;
		onToolOutput?: (toolName: string, delta: string) => void;
	},
): Promise<DurableToolsSetup> {
	const durableModule = await loadDurableModule().catch(() => null);

	if (!durableModule || typeof durableModule.createRegistry !== "function") {
		throw new Error("Pi Durable 依赖未安装。请运行 npm i -g @earendil-works/pi-durable 启用该引擎。");
	}

	const registry = durableModule.createRegistry();
	const installedToolNames: string[] = [];

	try {
		const toolsModule = await loadDurableModule("tools").catch(() => null);

		if (toolsModule && toolsModule.CodingTools) {
			registry.install(toolsModule.CodingTools);
			installedToolNames.push("read", "write", "edit", "bash");
		}
	} catch {}

	if (typeof durableModule.defineExtension === "function") {
		const WorkspaceEnv = durableModule.defineExtension({
			name: "workspace_env",
			environment: {
				cwd,
			},
		});
		registry.install(WorkspaceEnv);
	}

	return {
		registry,
		installedToolNames,
	};
}
