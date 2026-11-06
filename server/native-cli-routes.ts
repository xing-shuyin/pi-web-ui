import type { Request, Response } from "express";
import { resolve } from "node:path";
import type { NativeCliDiscoveryResult } from "./protocol.js";
import { ENGINE_CATALOG } from "./engine-catalog.js";
import { resolveEngineCliLaunch } from "./engine-cli.js";
import { discoverRemoteNativeClis } from "./remote-native-cli.js";
import { probeRemoteCliPersistence } from "./remote-cli-persistence.js";
import { getGlobalRemoteSshService, isRemoteWorkspaceUri, parseRemoteWorkspaceUri } from "./remote-ssh-service.js";

export function nativeCliDiscoveryHandler(terminalEnabled: () => boolean) {
	return async (req: Request, res: Response): Promise<void> => {
		if (!terminalEnabled()) {
			res.status(403).json({ error: "The terminal feature is not enabled on this instance" });
			return;
		}
		const cwd = req.query.cwd;
		if (typeof cwd !== "string" || !cwd.trim() || cwd.length > 4096 || /[\x00-\x1f\x7f-\x9f]/.test(cwd)) {
			res.status(400).json({ error: "Invalid CLI working directory" });
			return;
		}
		const remote = isRemoteWorkspaceUri(cwd);
		const parsed = remote ? parseRemoteWorkspaceUri(cwd) : null;
		if (remote && (!parsed || parsed.port < 1 || parsed.port > 65535)) {
			res.status(400).json({ error: "Invalid SSH workspace URI" });
			return;
		}
		const controller = new AbortController();
		const cancel = () => {
			if (!res.writableEnded) controller.abort();
		};
		res.once("close", cancel);
		try {
			let result: NativeCliDiscoveryResult;
			if (remote) {
				const service = getGlobalRemoteSshService();
				if (!service) throw new Error("SSH service is unavailable");
				const clis = await discoverRemoteNativeClis(service, cwd, controller.signal);
				const persistence = await probeRemoteCliPersistence(service, cwd, controller.signal);
				result = { target: "ssh", cwd, clis, persistence };
			} else {
				result = {
					target: "local",
					cwd,
					clis: Object.values(ENGINE_CATALOG)
						.filter((engine) => engine.cliCommand)
						.map((engine) => {
							try {
								const launch = resolveEngineCliLaunch(engine.id, { cwd: resolve(cwd) });
								return { preset: engine.id, available: true, executable: launch.file };
							} catch (err) {
								return { preset: engine.id, available: false, error: (err as Error).message };
							}
						}),
				};
			}
			if (!controller.signal.aborted) res.json(result);
		} catch (err) {
			if (!controller.signal.aborted) res.status(502).json({ error: (err as Error).message });
		} finally {
			res.off("close", cancel);
		}
	};
}
