import type { NativeCliConfig, NativeCliStatus } from "./protocol.js";

export interface NativeCliSessionRef {
	key: string;
	nativeId?: string;
	storeDir?: string;
}
export type NativeCliSessionEvent =
	| { type: "session"; nativeId: string; eventId: string; cursor?: string }
	| { type: "working" | "submitted" | "question" | "approval"; eventId: string }
	| { type: "done"; eventId: string; aborted?: boolean }
	| { type: "error"; eventId: string; code: string; message: string };

export interface PreparedNativeCliSession {
	config: NativeCliConfig;
	env?: NodeJS.ProcessEnv;
	ref: NativeCliSessionRef;
	capabilities: { resume: "exact" | "explicit-only" | "none"; events: "hooks" | "process" };
	start(): () => void;
	flush?(): Promise<void>;
	dispose(): Promise<void>;
}

export interface NativeCliRuntimeHooks {
	prepare(
		id: string,
		config: NativeCliConfig,
		cwd: string,
		signal: AbortSignal,
		onEvent: (event: NativeCliSessionEvent) => void,
		observeOnly?: boolean,
	): Promise<PreparedNativeCliSession>;
	reference?(id: string): NativeCliSessionRef | undefined;
	onEvent(id: string, event: NativeCliSessionEvent): void;
	onStatus(id: string, status: Partial<NativeCliStatus>): void;
	onRetainFiles?(id: string, paths: readonly string[]): void;
	onProcess?(id: string, created: boolean): string | undefined;
}
