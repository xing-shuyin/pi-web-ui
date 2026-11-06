// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { LanguageProvider } from "../../web/src/i18n";
import { PluginManagerModal } from "../../web/src/components/PluginManagerModal";
import { PluginMenu } from "../../web/src/components/PluginMenu";
import { SettingsModal } from "../../web/src/components/SettingsModal";
import { setAppGlobals, setAppSend, resetAppGlobals } from "../../web/src/app-globals";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientStateStore } from "../../server/client-state";
import { SettingsService } from "../../server/settings-service";
import { SubagentTemplatesStore } from "../../server/subagent-templates";
import type { UiSettingsState } from "../../server/protocol";

let root: Root | undefined;
let container: HTMLDivElement | undefined;
const temporary: string[] = [];
const scrollDescriptors = new Map<string, PropertyDescriptor | undefined>();
beforeEach(() => {
	for (const method of ["scrollTo", "scrollIntoView"]) {
		scrollDescriptors.set(method, Object.getOwnPropertyDescriptor(HTMLElement.prototype, method));
		Object.defineProperty(HTMLElement.prototype, method, { configurable: true, value: vi.fn() });
	}
});
afterEach(() => {
	if (root) act(() => root!.unmount());
	container?.remove();
	root = undefined;
	for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.unstubAllGlobals();
	resetAppGlobals();
	for (const [method, descriptor] of scrollDescriptors) {
		if (descriptor) Object.defineProperty(HTMLElement.prototype, method, descriptor);
		else Reflect.deleteProperty(HTMLElement.prototype, method);
	}
});
const plugins = [
	{ id: "superagent", name: "Superagent", version: "0.1.2", hasClient: true, view: false },
	{ id: "github-workbench", name: "GitHub workbench", hasClient: true, view: true },
];
async function mount(component: ReturnType<typeof createElement>) {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(async () => root!.render(createElement(LanguageProvider, null, component)));
}

describe("built-in modules are absent from user plugin management", () => {
	it("removes the module from the settings installed list without mutating native channel metadata", async () => {
		const directory = mkdtempSync(join(tmpdir(), "builtin-settings-"));
		temporary.push(directory);
		const store = new ClientStateStore(join(directory, "client-state.json"));
		store.saveSettings("test", { disabledPlugins: ["superagent"] });
		let settings!: UiSettingsState;
		const service = new SettingsService(
			{
				clientId: "test",
				stateStore: store,
				emit: (message: any) => {
					if (message.type === "settings_state") settings = message.settings;
				},
				flushSnapshot() {},
				isDisposed: () => false,
				getSession: () => undefined,
				cwd: () => directory,
				agentDir: () => join(directory, "agent"),
				isStreaming: () => false,
				reloadSession: async () => {},
				applyRetryOverrides() {},
				applyCompactionOverrides() {},
				applyToolGating() {},
				promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
			} as any,
			new SubagentTemplatesStore(join(directory, "templates.json")),
		);
		service.push();
		setAppGlobals({ engine: "pi", cwd: directory, ready: true, status: "open", workspaceRoots: [] });
		setAppSend(() => true);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({ ok: true, json: async () => ({ engines: [] }) })),
		);
		const chat = {
			settings,
			plugins,
			pluginCatalog: plugins.map((plugin) => ({
				id: plugin.id,
				name: plugin.name,
				source: `owner/repo/${plugin.id}`,
				builtin: true,
			})),
			pluginUpdates: { superagent: { updatable: true, builtin: true } },
			pluginJobs: {},
			pluginGrants: [{ pluginId: "superagent", paths: ["/not-read"] }],
			pluginPermissions: [{ pluginId: "superagent", family: "net", grantedAt: 1 }],
			state: { cwd: directory },
			activeConversationId: "test",
			terminals: [],
			schedulerTasks: [],
			pluginsEpoch: 1,
		} as any;
		await mount(
			createElement(SettingsModal, {
				chat,
				initialSection: "plugins",
				terminal: { terminals: [], create() {}, close() {}, register: () => () => {}, restart() {}, select() {} },
				onSwitchToTerminal() {},
				onClose() {},
				sound: { enabled: false, volume: 0.5, kinds: {} },
				onSoundChange() {},
			} as any),
		);
		const installed = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find((button) =>
			/插件列表|Plugin list|Installed/i.test(button.textContent ?? ""),
		);
		expect(installed).toBeDefined();
		await act(async () => installed!.click());
		expect(document.body.textContent).not.toContain("Superagent");
		expect(document.querySelectorAll(".smart-installed-card")).toHaveLength(1);
		expect(document.querySelector(".smart-plugin-source")?.textContent).toBe("github-workbench");
		expect(chat.plugins).toHaveLength(2);
		expect(chat.pluginCatalog).toHaveLength(2);
	});
	it("hides the module and excludes it from counts and enable switches in the plugin manager", async () => {
		const toggle = vi.fn();
		await mount(
			createElement(PluginManagerModal, {
				plugins,
				disabledPlugins: ["superagent"],
				onClose: vi.fn(),
				onTogglePlugin: toggle,
			}),
		);
		expect(document.body.textContent).not.toContain("Superagent");
		expect(document.querySelectorAll(".plugin-mgr-card")).toHaveLength(1);
		expect(document.querySelector(".plugin-mgr-chip-count")?.textContent).toBe("1");
		const switches = document.querySelectorAll<HTMLButtonElement>('[role="switch"]');
		expect(switches).toHaveLength(1);
		await act(async () => switches[0].click());
		expect(toggle).toHaveBeenCalledWith(expect.objectContaining({ id: "github-workbench" }));
	});
	it("does not list or count the module in the top-bar plugin menu", async () => {
		await mount(
			createElement(PluginMenu, {
				anchorRect: { left: 0, top: 0, right: 100, bottom: 30 },
				plugins,
				pinnedIds: new Set(["superagent"]),
				onClose: vi.fn(),
				onManagePlugins: vi.fn(),
				onTogglePin: vi.fn(),
				onReorder: vi.fn(),
				onOpenView: vi.fn(),
			}),
		);
		expect(document.body.textContent).not.toContain("Superagent");
		expect(document.querySelectorAll(".pm-row")).toHaveLength(1);
		expect(document.querySelector(".pm-head-count")?.textContent).toBe("1");
	});
	it("shows the ordinary empty state when the host module is the only loaded module", async () => {
		await mount(
			createElement(PluginMenu, {
				anchorRect: { left: 0, top: 0, right: 100, bottom: 30 },
				plugins: [plugins[0]],
				pinnedIds: new Set<string>(),
				onClose: vi.fn(),
				onManagePlugins: vi.fn(),
				onTogglePin: vi.fn(),
				onReorder: vi.fn(),
				onOpenView: vi.fn(),
			}),
		);
		expect(document.querySelectorAll(".pm-row")).toHaveLength(0);
		expect(document.querySelector(".pm-empty")).not.toBeNull();
		expect(document.querySelector(".pm-head-count")?.textContent).toBe("0");
	});
});
