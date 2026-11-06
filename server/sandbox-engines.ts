import type { SandboxManager } from "./sandbox-service.js";

export function assertEngineWorkspaceSupported(manager: SandboxManager, cwd: string, engine: string): void {
	manager.assertAvailable(cwd);
	if (manager.getExecutionIdentity(cwd)) {
		throw new Error(
			`Engine "${engine}" does not support managed sandbox execution: native tools cannot be restricted before execution. Use the pi engine.`,
		);
	}
}
