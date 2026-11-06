import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientStateStore } from "../../server/client-state.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import { SubagentTemplatesStore } from "../../server/subagent-templates.js";
import type { ServerMessage } from "../../server/protocol.js";

let dir: string;
let agentDir: string;
let cwd: string;
let store: ClientStateStore;
let emitted: ServerMessage[];

function makeHost(session: unknown): SettingsHost {
	return {
		clientId: "test-client",
		stateStore: store,
		emit: (msg) => void emitted.push(msg),
		flushSnapshot: () => {},
		isDisposed: () => false,
		getSession: () => {
			if (session instanceof Error) throw session;
			return session as never;
		},
		cwd: () => cwd,
		agentDir: () => agentDir,
		isStreaming: () => false,
		reloadSession: async () => {},
		applyRetryOverrides: () => {},
		applyCompactionOverrides: () => {},
		applyToolGating: () => {},
		promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
	};
}

function makeSession(loadedExts: { sourceInfo?: { origin?: string; source?: string }; path: string }[]) {
	return {
		resourceLoader: {
			getSkills: () => ({ skills: [] }),
			getExtensions: () => ({ extensions: loadedExts }),
		},
	};
}

function lastSettingsState(): { extensions: { id: string; enabled: boolean }[] } | undefined {
	for (let i = emitted.length - 1; i >= 0; i--) {
		const m = emitted[i] as { type?: string; settings?: { extensions?: { id: string; enabled: boolean }[] } };
		if (m?.type === "settings_state") return { extensions: m.settings?.extensions ?? [] };
	}
	return undefined;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "settings-stale-ext-"));
	agentDir = join(dir, "agent");
	cwd = join(dir, "proj");
	mkdirSync(join(agentDir, "npm", "node_modules", "listed-pkg"), { recursive: true });
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:listed-pkg"] }));
	store = new ClientStateStore(join(dir, "client-state.json"));
	emitted = [];
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("disabledExtensions stale 剔除（issue #192）", () => {
	it("卸载的扩展移出禁用记录并持久化；现存/列名/路径/加载中的保留", () => {
		const realPath = join(dir, "real-ext");
		mkdirSync(realPath, { recursive: true });
		store.saveSettings("test-client", {
			disabledExtensions: ["npm:loaded-pkg", "npm:listed-pkg", "npm:gone-pkg", realPath, join(dir, "no-such-ext")],
		});
		const svc = new SettingsService(
			makeHost(makeSession([{ sourceInfo: { origin: "package", source: "npm:loaded-pkg" }, path: "/x" }])),
			new SubagentTemplatesStore(join(dir, "templates.json")),
		);
		svc.refreshResources();

		expect([...svc.current.disabledExtensions].sort()).toEqual(["npm:loaded-pkg", "npm:listed-pkg", realPath].sort());
		expect([...store.getSettings("test-client").disabledExtensions].sort()).toEqual(
			["npm:loaded-pkg", "npm:listed-pkg", realPath].sort(),
		);
		const ids = (lastSettingsState()?.extensions ?? []).map((e) => e.id);
		expect(ids).not.toContain("npm:gone-pkg");
		expect(ids).not.toContain(join(dir, "no-such-ext"));
		expect(ids).toEqual(expect.arrayContaining(["npm:loaded-pkg", "npm:listed-pkg", realPath]));
		const listed = (lastSettingsState()?.extensions ?? []).find((e) => e.id === "npm:listed-pkg");
		expect(listed?.enabled).toBe(false);
	});

	it("session 未就绪时保守跳过清理，且不复活幽灵", () => {
		store.saveSettings("test-client", { disabledExtensions: ["npm:ghost-pkg"] });
		const svc = new SettingsService(
			makeHost(new Error("not ready")),
			new SubagentTemplatesStore(join(dir, "templates.json")),
		);
		svc.refreshResources();
		expect(svc.current.disabledExtensions).toEqual(["npm:ghost-pkg"]);
		const ids = (lastSettingsState()?.extensions ?? []).map((e) => e.id);
		expect(ids).not.toContain("npm:ghost-pkg");
	});

	it("loader 中的 <inline:...> / hidden 内部扩展不进入设置面板，且残留的 inline 禁用记录被自动剔除", () => {
		const realPath = join(dir, "my-real-ext");
		mkdirSync(realPath, { recursive: true });
		store.saveSettings("test-client", {
			disabledExtensions: ["<inline:1>", "<inline:codemode>", "<inline:pi-webui-persona>", realPath],
		});
		const svc = new SettingsService(
			makeHost(
				makeSession([
					{ path: "<inline:1>" },
					{ path: "<inline:2>" },
					{ path: "<inline:pi-webui-persona>" },
					{ path: "/internal-hidden", hidden: true } as never,
					{ path: realPath },
				]),
			),
			new SubagentTemplatesStore(join(dir, "templates.json")),
		);
		svc.refreshResources();

		expect(svc.current.disabledExtensions).toEqual([realPath]);
		expect(store.getSettings("test-client").disabledExtensions).toEqual([realPath]);

		const panelExts = lastSettingsState()?.extensions ?? [];
		const ids = panelExts.map((e) => e.id);
		expect(ids).toEqual([realPath]);
		expect(ids).not.toContain("<inline:1>");
		expect(ids).not.toContain("<inline:2>");
		expect(ids).not.toContain("<inline:pi-webui-persona>");
	});
});
