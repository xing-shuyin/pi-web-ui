import { LocalEngine } from "@pi-mobile/native-local-engine";
import type { MobileConnection } from "./connection";

/**
 * Brings the on-device engine to a running state and returns its connection.
 * Idempotent: install() no-ops when already installed, start() reuses a running instance.
 * Errors surface with actionable text; the connection screen offers "reset runtime" after
 * repeated crashes (the engine stops auto-restarting on its own).
 */
export async function ensureLocalEngineRunning(): Promise<MobileConnection> {
	const status = await LocalEngine.getStatus();
	if (status.phase === "notInstalled") await LocalEngine.install();
	const { endpoint } = await LocalEngine.start();
	return { serverUrl: endpoint.serverUrl, token: endpoint.token };
}

export async function resetLocalEngine(): Promise<void> {
	await LocalEngine.reset();
}
