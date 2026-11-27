import { emitPluginData } from "./plugin-loader";

// Host → plugin-view bridge for issue #1006 (open a file in vscode-editor).
// The plugin view mounts async (dynamic import), so a live-only data event
// can be missed on first open: the path is also stashed in sessionStorage,
// which the editor consumes once on mount. The live event covers the
// already-mounted case. Editor dedupes (open file = activate tab), so a
// double delivery is a harmless no-op.

export const PLUGIN_VIEW_OPEN_EVENT = "pi:open-plugin-view";
export const EDITOR_OPEN_STASH_KEY = "pi-web-ui:editor-open-file";
export const VSCODE_EDITOR_PLUGIN_ID = "vscode-editor";

export interface OpenPluginViewDetail {
	pluginId: string;
}

export interface OpenFilePayload {
	event: "open-file";
	path: string;
}

export function buildOpenPluginViewDetail(pluginId: string): OpenPluginViewDetail {
	return { pluginId };
}

export function buildOpenFilePayload(path: string): OpenFilePayload {
	return { event: "open-file", path };
}

type EventTargetLike = {
	dispatchEvent: (event: unknown) => boolean;
};

type StorageLike = {
	getItem: (key: string) => string | null;
	setItem: (key: string, value: string) => void;
	removeItem: (key: string) => void;
};

function globalTarget(): EventTargetLike | null {
	try {
		const w = (globalThis as { window?: EventTargetLike }).window;
		return w ?? null;
	} catch {
		return null;
	}
}

function sessionStore(): StorageLike | null {
	try {
		const s = (globalThis as { sessionStorage?: StorageLike }).sessionStorage;
		return s ?? null;
	} catch {
		return null;
	}
}

/** Ask the host to switch the center view to a plugin view. No-op without a DOM. */
export function dispatchOpenPluginView(pluginId: string, target?: EventTargetLike | null): boolean {
	const t = target ?? globalTarget();
	if (!t) return false;
	try {
		const Ctor = (globalThis as { CustomEvent?: new (type: string, init: { detail: unknown }) => unknown }).CustomEvent;
		const detail = buildOpenPluginViewDetail(pluginId);
		const event = Ctor ? new Ctor(PLUGIN_VIEW_OPEN_EVENT, { detail }) : { type: PLUGIN_VIEW_OPEN_EVENT, detail };
		return t.dispatchEvent(event);
	} catch {
		return false;
	}
}

/** Stash a pending editor-open for the plugin to consume on mount. */
export function stashEditorOpen(path: string, store?: StorageLike | null): boolean {
	const s = store ?? sessionStore();
	if (!s || !path) return false;
	try {
		s.setItem(EDITOR_OPEN_STASH_KEY, path);
		return true;
	} catch {
		return false;
	}
}

/** Read + clear the stashed editor-open (plugin side, once per mount). */
export function takeEditorOpen(store?: StorageLike | null): string | null {
	const s = store ?? sessionStore();
	if (!s) return null;
	try {
		const v = s.getItem(EDITOR_OPEN_STASH_KEY);
		if (v) s.removeItem(EDITOR_OPEN_STASH_KEY);
		return v || null;
	} catch {
		return null;
	}
}

export interface EditorPluginInfo {
	id: string;
	view?: unknown;
}

/** The editor entry is only offered when the vscode-editor plugin can show a view. */
export function hasEditorPlugin(plugins: readonly EditorPluginInfo[] | null | undefined): boolean {
	if (!plugins) return false;
	return plugins.some((p) => p && p.id === VSCODE_EDITOR_PLUGIN_ID && p.view !== false);
}

/** Only workspace-relative file paths can be handed to the editor (no roots/absolutes). */
export function canOpenInEditor(path: string): boolean {
	if (!path || typeof path !== "string") return false;
	const p = path.trim();
	if (!p || p === "@root" || p === "/" || p === "." || p === "..") return false;
	if (p.startsWith("/") || p.startsWith("\\")) return false;
	if (/^[A-Za-z]:($|[\\/])/.test(p)) return false;
	if (p.split("/").some((seg) => seg === "..")) return false;
	return true;
}

/**
 * Full flow: stash (first-mount case) + switch view + live event (mounted case).
 * Returns which steps succeeded; view/event need a DOM + loaded plugin view.
 */
export function openFileInEditor(
	path: string,
	options?: {
		pluginId?: string;
		target?: EventTargetLike | null;
		store?: StorageLike | null;
	},
): { stashed: boolean; viewDispatched: boolean; eventSent: boolean } {
	const pluginId = options?.pluginId ?? VSCODE_EDITOR_PLUGIN_ID;
	const stashed = stashEditorOpen(path, options?.store);
	const viewDispatched = dispatchOpenPluginView(pluginId, options?.target);
	let eventSent = false;
	try {
		emitPluginData(pluginId, buildOpenFilePayload(path));
		eventSent = true;
	} catch {
		eventSent = false;
	}
	return { stashed, viewDispatched, eventSent };
}
