import type { ServerMessage } from "../server/protocol.js";

export type BrowserPageRequest = Omit<Extract<ServerMessage, { type: "page_request" }>, "type" | "id">;
export type BrowserPageResult = { ok: true; result?: unknown } | { ok: false; error: string };
export type BrowserMode = "browser" | "agent" | "split";

export interface BrowserTab {
	id: string;
	url: string;
	title: string;
	loading: boolean;
	canGoBack: boolean;
	canGoForward: boolean;
	internal: boolean;
}

export interface BrowserState {
	mode: BrowserMode;
	splitRatio: number;
	activeTabId: string | null;
	tabs: BrowserTab[];
	agentUrl: string;
	agentReady: boolean;
	agentError?: string;
}

export interface BrowserHostBridge {
	version: 1;
	pageCall(request: BrowserPageRequest): Promise<BrowserPageResult>;
}

export type BrowserShellAction =
	| "state"
	| "overlay"
	| "downloads.list"
	| "extensions.list"
	| "extensions.load"
	| "tabs.create"
	| "tabs.activate"
	| "tabs.close"
	| "navigate"
	| "back"
	| "forward"
	| "reload"
	| "mode"
	| "splitRatio"
	| "agent.connect"
	| "bookmarks.list"
	| "bookmarks.save"
	| "history.list"
	| "settings.get"
	| "settings.save"
	| "files.open"
	| "files.read"
	| "files.save"
	| "files.external"
	| "passwords.list"
	| "passwords.save"
	| "passwords.available"
	| "passwords.fill"
	| "data.import"
	| "download.open";
