import { describe, expect, it } from "vitest";
import {
	EDITOR_OPEN_STASH_KEY,
	buildOpenFilePayload,
	buildOpenPluginViewDetail,
	canOpenInEditor,
	dispatchOpenPluginView,
	hasEditorPlugin,
	openFileInEditor,
	stashEditorOpen,
	takeEditorOpen,
} from "../../web/src/plugin-view-open.js";

function memStore() {
	const m = new Map<string, string>();
	return {
		getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
		setItem: (k: string, v: string) => void m.set(k, v),
		removeItem: (k: string) => void m.delete(k),
	};
}

describe("open in editor bridge (issue #1006)", () => {
	it("builds the view + payload shapes the plugin expects", () => {
		expect(buildOpenPluginViewDetail("vscode-editor")).toEqual({ pluginId: "vscode-editor" });
		expect(buildOpenFilePayload("src/a.ts")).toEqual({ event: "open-file", path: "src/a.ts" });
	});

	it("stash is once-only (mount consumes, second mount sees nothing)", () => {
		const s = memStore();
		expect(stashEditorOpen("src/a.ts", s)).toBe(true);
		expect(takeEditorOpen(s)).toBe("src/a.ts");
		expect(takeEditorOpen(s)).toBeNull();
	});

	it("stash key is stable for the plugin client", () => {
		expect(EDITOR_OPEN_STASH_KEY).toBe("pi-web-ui:editor-open-file");
	});

	it("dispatches the view event to the given target", () => {
		const seen: unknown[] = [];
		const ok = dispatchOpenPluginView("vscode-editor", {
			dispatchEvent: (e: unknown) => (seen.push(e), true),
		});
		expect(ok).toBe(true);
		expect(seen.length).toBe(1);
	});

	it("no DOM → false, never throws", () => {
		expect(dispatchOpenPluginView("vscode-editor", null)).toBe(false);
		expect(stashEditorOpen("x", null)).toBe(false);
		expect(takeEditorOpen(null)).toBeNull();
	});

	it("editor offered only when the plugin can show a view", () => {
		expect(hasEditorPlugin(null)).toBe(false);
		expect(hasEditorPlugin([])).toBe(false);
		expect(hasEditorPlugin([{ id: "vscode-editor", view: false }])).toBe(false);
		expect(hasEditorPlugin([{ id: "vscode-editor" }])).toBe(true);
		expect(hasEditorPlugin([{ id: "other" }, { id: "vscode-editor", view: true }])).toBe(true);
	});

	it("rejects roots, absolutes and escapes", () => {
		for (const bad of ["", " ", "@root", "/", ".", "..", "/etc/passwd", "C:\\a", "C:/a", "a/../../b", "../x"]) {
			expect(canOpenInEditor(bad), bad).toBe(false);
		}
		for (const good of ["a.ts", "src/a.ts", "dir with space/b.ts", "a.b/c.d.ts"]) {
			expect(canOpenInEditor(good), good).toBe(true);
		}
	});

	it("full flow wires stash + view + live event", () => {
		const s = memStore();
		const seen: unknown[] = [];
		const r = openFileInEditor("src/a.ts", {
			target: { dispatchEvent: (e: unknown) => (seen.push(e), true) },
			store: s,
		});
		expect(r.stashed).toBe(true);
		expect(r.viewDispatched).toBe(true);
		expect(s.getItem(EDITOR_OPEN_STASH_KEY)).toBe("src/a.ts");
		expect(seen.length).toBe(1);
	});
});
