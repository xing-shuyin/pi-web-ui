export type PluginLogLevel = "debug" | "info" | "warn" | "error";

export interface PluginLogEntry {
	ts: number;
	level: PluginLogLevel;
	text: string;
}

export const PLUGIN_LOG_LEVELS: readonly PluginLogLevel[] = ["debug", "info", "warn", "error"];

export function pluginLogsFetch(pluginId: string): {
	type: "plugin_message";
	pluginId: string;
	payload: { __host: "logs"; op: "get" };
} {
	return { type: "plugin_message", pluginId, payload: { __host: "logs", op: "get" } };
}

export function pluginLogsClearRequest(pluginId: string): {
	type: "plugin_message";
	pluginId: string;
	payload: { __host: "logs"; op: "clear" };
} {
	return { type: "plugin_message", pluginId, payload: { __host: "logs", op: "clear" } };
}

export function isPluginLogsResponse(payload: unknown): payload is {
	__host: "logs";
	logs: PluginLogEntry[];
	cleared?: boolean;
} {
	if (!payload || typeof payload !== "object") return false;
	const o = payload as Record<string, unknown>;
	if (o.__host !== "logs" || !Array.isArray(o.logs)) return false;
	return o.logs.every(
		(e) =>
			!!e &&
			typeof e === "object" &&
			typeof (e as { ts?: unknown }).ts === "number" &&
			typeof (e as { text?: unknown }).text === "string" &&
			(PLUGIN_LOG_LEVELS as readonly string[]).includes(String((e as { level?: unknown }).level)),
	);
}

const logsByPlugin = new Map<string, PluginLogEntry[]>();
const listeners = new Set<() => void>();

function notify(): void {
	// eslint-disable-next-line unicorn/no-useless-spread -- snapshot: 订阅者可能在回调里退订
	for (const l of [...listeners]) {
		try {
			l();
		} catch {}
	}
}

export function subscribePluginLogs(cb: () => void): () => void {
	listeners.add(cb);
	return () => listeners.delete(cb);
}

export function getPluginLogs(pluginId: string): PluginLogEntry[] {
	return (logsByPlugin.get(pluginId) ?? []).map((e) => ({ ...e }));
}

export function ingestPluginLogsData(pluginId: string, payload: unknown): boolean {
	if (!isPluginLogsResponse(payload)) return false;
	logsByPlugin.set(
		pluginId,
		payload.logs.map((e) => ({ ts: e.ts, level: e.level, text: e.text })),
	);
	notify();
	return true;
}
