import {
	normalizeServerUrl,
	notificationTarget,
	readServerStatus,
	type MobileConnection,
	type NotificationTarget,
} from "./connection";
import { loginHub } from "./hub";

export type ConnectionMode = "hub" | "direct";
export interface SavedConnection extends MobileConnection {
	mode: ConnectionMode;
}
export type ConnectionInput =
	| { mode: "hub"; serverUrl: string; username: string; password: string }
	| { mode: "direct"; serverUrl: string; token: string };

export function restoreConnection(saved: MobileConnection & { mode?: unknown }): SavedConnection {
	if (saved.mode !== undefined && saved.mode !== "hub" && saved.mode !== "direct") {
		throw new Error("保存的连接方式无法识别，请重新连接。");
	}
	const token = saved.token.trim();
	if (!token || token.length > 4096 || /\s/.test(token)) throw new Error("请输入有效的设备访问令牌。");
	return { mode: saved.mode ?? "hub", serverUrl: normalizeServerUrl(saved.serverUrl), token };
}

export async function authenticateConnection(input: ConnectionInput, installationId: string): Promise<SavedConnection> {
	if (input.mode === "hub") {
		return { ...(await loginHub(input.serverUrl, input.username, input.password)), mode: "hub" };
	}
	const connection = restoreConnection(input);
	await readServerStatus(connection, installationId);
	return connection;
}

export function notificationDestination(
	mode: ConnectionMode,
	target: NotificationTarget,
): "device" | "conversation" | "settings" {
	if (mode === "hub") return target.deviceId ? "device" : "settings";
	return target.deviceId ? "settings" : "conversation";
}

export function savePendingTarget(connection: SavedConnection, target: NotificationTarget): string {
	return JSON.stringify({ mode: connection.mode, serverUrl: connection.serverUrl, target });
}

/** Reload routing data must match both the saved connection and its current server instance. */
export function restorePendingTarget(
	value: string | null,
	connection: SavedConnection,
	instanceId: string,
): NotificationTarget | null {
	if (!value || !instanceId) return null;
	try {
		const saved = JSON.parse(value) as { mode?: unknown; serverUrl?: unknown; hubUrl?: unknown; target?: unknown };
		if ((saved.mode ?? "hub") !== connection.mode || (saved.serverUrl ?? saved.hubUrl) !== connection.serverUrl)
			return null;
		const target = notificationTarget(saved.target, instanceId);
		return target && notificationDestination(connection.mode, target) !== "settings" ? target : null;
	} catch {
		return null;
	}
}
