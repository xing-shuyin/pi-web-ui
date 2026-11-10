import type { PluginListenerHandle } from "@capacitor/core";

export type LocalEnginePhase =
	"notInstalled" | "installing" | "installed" | "starting" | "running" | "stopping" | "error";

export interface LocalEngineStatus {
	phase: LocalEnginePhase;
	abi: string;
	/** Version bundled inside the current APK assets (from localengine runtime.json). */
	builtinVersion: string;
	/** Version currently extracted into app-private storage, null before first install. */
	installedVersion: string | null;
	/** Local base URL like http://127.0.0.1:PORT, only while running. */
	baseUrl: string | null;
	/** Session token of the running server, only while running. */
	token: string | null;
	error: string | null;
}

export interface LocalEngineLogEntry {
	seq: number;
	line: string;
	stream: "stdout" | "stderr" | "system";
}

export interface LocalEngineEndpoint {
	serverUrl: string;
	token: string;
}

export interface LocalEnginePlugin {
	getStatus(): Promise<LocalEngineStatus>;
	/** Extract the bundled rootfs into app-private storage. Progress flows through the "progress" event. */
	install(): Promise<void>;
	/** Start the foreground service and the engine process; resolves once the server is reachable. */
	start(): Promise<{ endpoint: LocalEngineEndpoint }>;
	stop(): Promise<void>;
	getLogSnapshot(options?: { lines?: number }): Promise<{ entries: LocalEngineLogEntry[]; throughSeq: number }>;
	/** Stop the engine (if any) and delete the extracted runtime; user data under /data is kept. */
	reset(): Promise<void>;
	addListener(
		eventName: "status",
		listener: (event: { status: LocalEngineStatus }) => void,
	): Promise<PluginListenerHandle>;
	addListener(
		eventName: "logs",
		listener: (event: { entries: LocalEngineLogEntry[] }) => void,
	): Promise<PluginListenerHandle>;
	addListener(
		eventName: "progress",
		listener: (event: { step: "extract" | "verify"; done: number; total: number }) => void,
	): Promise<PluginListenerHandle>;
	removeAllListeners(): Promise<void>;
}
