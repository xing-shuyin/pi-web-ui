/// <reference lib="dom" />

import { useSyncExternalStore } from "react";
import type { ClientMessage, ConnStatus, UiServiceInfo, AgentEngineCapabilities, EngineStatus } from "./types";

export const DEFAULT_ENGINE_CAPABILITIES: AgentEngineCapabilities = {
	remoteSsh: true,
	sandboxes: true,
	workspaceRoots: true,
	conversationRef: true,
	pageRef: true,
	presentFiles: true,
	planMode: true,
	delegateMode: true,
	subagents: true,
	toolPromptOverride: true,
	lazyTools: true,
	softCap: true,
	treeFork: true,
	messageEdit: true,
	steer: true,
	ephemeralChat: true,
};

export interface AppGlobals {
	engine: string;
	managed: boolean;
	tabs?: string[];
	service?: UiServiceInfo;
	appVersion?: string;
	serverVersion?: string;
	status: ConnStatus;
	ready: boolean;
	cwd: string;
	workspaceRoots: string[];
	homeDir: string;
	desktopDir: string;
	chatUploadMaxMb: number;
	workspaceUploadMaxMb: number;
	folderUploadMaxMb: number;
	engineCapabilities: AgentEngineCapabilities;
	engines?: EngineStatus[];
}

export const DEFAULT_APP_GLOBALS: AppGlobals = {
	engine: "pi",
	managed: false,
	status: "connecting",
	ready: false,
	cwd: "",
	workspaceRoots: [],
	homeDir: "",
	desktopDir: "",
	chatUploadMaxMb: 20,
	workspaceUploadMaxMb: 100,
	folderUploadMaxMb: 32,
	engineCapabilities: DEFAULT_ENGINE_CAPABILITIES,
};

let cached: AppGlobals = DEFAULT_APP_GLOBALS;
const listeners = new Set<() => void>();

function sameArray(a?: string[], b?: string[]): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((v, i) => v === b[i]);
}

function sameShallow<T extends object>(a: T | undefined, b: T | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		if (!Object.is((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key])) return false;
	}
	return true;
}

function sameEngines(a?: EngineStatus[], b?: EngineStatus[]): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	return a.every((v, i) => sameShallow(v, b[i]));
}

function same(a: AppGlobals, b: AppGlobals): boolean {
	return (
		a.engine === b.engine &&
		a.managed === b.managed &&
		a.appVersion === b.appVersion &&
		a.serverVersion === b.serverVersion &&
		a.status === b.status &&
		a.ready === b.ready &&
		a.cwd === b.cwd &&
		sameArray(a.workspaceRoots, b.workspaceRoots) &&
		a.homeDir === b.homeDir &&
		a.desktopDir === b.desktopDir &&
		a.chatUploadMaxMb === b.chatUploadMaxMb &&
		a.workspaceUploadMaxMb === b.workspaceUploadMaxMb &&
		a.folderUploadMaxMb === b.folderUploadMaxMb &&
		sameArray(a.tabs, b.tabs) &&
		sameShallow(a.engineCapabilities, b.engineCapabilities) &&
		sameEngines(a.engines, b.engines) &&
		sameShallow(a.service, b.service)
	);
}

export function setAppGlobals(patch: Partial<AppGlobals>): void {
	const next: AppGlobals = { ...cached, ...patch };
	if (same(cached, next)) return;
	cached = next;
	for (const l of listeners) l();
}

export function getAppGlobals(): AppGlobals {
	return cached;
}

export function resetAppGlobals(): void {
	cached = DEFAULT_APP_GLOBALS;
}

function subscribe(onStoreChange: () => void): () => void {
	listeners.add(onStoreChange);
	return () => {
		listeners.delete(onStoreChange);
	};
}

export function subscribeAppGlobals(cb: () => void): () => void {
	return subscribe(cb);
}

function getSnapshot(): AppGlobals {
	return cached;
}

export function useAppGlobals(): AppGlobals {
	return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function useAppField<K extends keyof AppGlobals>(key: K): AppGlobals[K] {
	return useSyncExternalStore(
		subscribe,
		() => cached[key],
		() => cached[key],
	);
}

export function useIsDsh(): boolean {
	return useAppField("engine") === "dsh";
}

export function useEngineStatuses(): EngineStatus[] {
	return useAppField("engines") ?? [];
}

export function useIsManaged(): boolean {
	return useAppField("managed");
}

export function useServiceInfo(): UiServiceInfo | undefined {
	return useAppField("service");
}

export function useEngineCapabilities(): AgentEngineCapabilities {
	return useAppField("engineCapabilities");
}

export interface AppSendContext {
	userInitiated?: boolean;
}

export type AppSend = (msg: ClientMessage, context?: AppSendContext) => boolean;

let sendImpl: AppSend | null = null;

export function setAppSend(fn: AppSend | null): void {
	sendImpl = fn;
}

export const appSend: AppSend = (msg, context) => {
	if (!sendImpl) return false;
	if (msg.type === "prompt") return sendImpl(msg, context ?? { userInitiated: true });
	return context ? sendImpl(msg, context) : sendImpl(msg);
};
