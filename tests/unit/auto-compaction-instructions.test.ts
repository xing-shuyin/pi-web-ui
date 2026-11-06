import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeAutoCompactionInstructions } from "../../server/soft-cap.js";
import { PRESET_FIELD_GROUPS, PRESET_FIELD_META } from "../../server/preset-fields.js";
import { handleSettingsMessage } from "../../server/dispatch-domain-handlers.js";
import { fakeClientSession } from "../helpers/fake-session.js";
import { ClientStateStore } from "../../server/client-state.js";
import { SettingsService, type SettingsHost } from "../../server/settings-service.js";
import type { DispatchSession } from "../../server/index.js";
import type { ClientMessage } from "../../server/protocol.js";
import type { SubagentTemplatesStore } from "../../server/subagent-templates.js";

describe("normalizeAutoCompactionInstructions", () => {
	it("非字符串输入归一化为空串（不传指令，保持 SDK 默认摘要）", () => {
		expect(normalizeAutoCompactionInstructions(undefined)).toBe("");
		expect(normalizeAutoCompactionInstructions(null)).toBe("");
		expect(normalizeAutoCompactionInstructions(123)).toBe("");
		expect(normalizeAutoCompactionInstructions({ a: 1 })).toBe("");
		expect(normalizeAutoCompactionInstructions(["x"])).toBe("");
	});

	it("字符串原样返回，并截断到 2000 字符上限", () => {
		expect(normalizeAutoCompactionInstructions("")).toBe("");
		expect(normalizeAutoCompactionInstructions("[[custom-compact:v3:local]]")).toBe("[[custom-compact:v3:local]]");
		const long = "x".repeat(5000);
		expect(normalizeAutoCompactionInstructions(long)).toHaveLength(2000);
	});
});

describe("自动压缩指令可随预设分享", () => {
	it("白名单（按字段白名单净化预设时不会被丢掉）", () => {
		const all = Object.values(PRESET_FIELD_GROUPS).flat() as string[];
		expect(all).toContain("autoCompactionInstructions");
	});

	it("字段元数据齐全（预设编辑/分享 UI 需要中英标签）", () => {
		const meta = (PRESET_FIELD_META as Record<string, { labelZh?: string; labelEn?: string }>)[
			"autoCompactionInstructions"
		];
		expect(meta?.labelZh).toBeTruthy();
		expect(meta?.labelEn).toBeTruthy();
	});
});

describe("dispatch -> SettingsService -> 持久化/读取回归", () => {
	let testDir: string;
	let stateFile: string;

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "pi-auto-compaction-test-"));
		stateFile = join(testDir, "client-state.json");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(testDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
	});

	function createFixture(clientId = "test-client") {
		const stateStore = new ClientStateStore(stateFile);
		const emitted: unknown[] = [];
		const host: SettingsHost = {
			clientId,
			stateStore,
			emit: (msg) => {
				emitted.push(msg);
			},
			flushSnapshot: () => {},
			isDisposed: () => false,
			getSession: () => {
				throw new Error("no session");
			},
			cwd: () => testDir,
			agentDir: () => testDir,
			isStreaming: () => false,
			reloadSession: async () => {},
			applyRetryOverrides: () => {},
			applyCompactionOverrides: () => {},
			applyToolGating: () => {},
			promptSnapshot: () => ({ full: "", texts: {}, toolsSchema: "" }),
		};
		const templates = { list: () => [] } as unknown as SubagentTemplatesStore;
		const settingsSvc = new SettingsService(host, templates);

		const cs = fakeClientSession({
			clientId,
			stateStore,
			settingsSvc,
			emit: (msg: unknown) => {
				emitted.push(msg);
			},
			flushSnapshot: () => {},
		});

		return { cs, settingsSvc, stateStore, host, emitted, clientId };
	}

	it("通过 dispatch set_settings 传递 autoCompactionInstructions，真实经由 fakeClientSession -> SettingsService 写入并持久化落盘，且可重新读回", async () => {
		const { cs, settingsSvc, stateStore, clientId, emitted } = createFixture();
		const setSpy = vi.spyOn(settingsSvc, "set");

		const customInstructions = "Keep focus on regression tests and architecture guidelines.";
		const msg: ClientMessage = {
			type: "set_settings",
			autoCompactionInstructions: customInstructions,
		};

		const handled = handleSettingsMessage(msg, cs as unknown as DispatchSession);
		expect(handled).toBe(true);

		expect(setSpy).toHaveBeenCalledTimes(1);
		expect(setSpy).toHaveBeenCalledWith(expect.objectContaining({ autoCompactionInstructions: customInstructions }));
		await setSpy.mock.results[0]?.value;

		expect(settingsSvc.current.autoCompactionInstructions).toBe(customInstructions);

		expect(stateStore.getSettings(clientId).autoCompactionInstructions).toBe(customInstructions);

		const reloadedStore = new ClientStateStore(stateFile);
		expect(reloadedStore.getSettings(clientId).autoCompactionInstructions).toBe(customInstructions);

		const lastState = emitted.filter((m) => (m as { type?: string }).type === "settings_state").pop() as
			{ settings: { autoCompactionInstructions?: string } } | undefined;
		expect(lastState?.settings.autoCompactionInstructions).toBe(customInstructions);
	});

	it("dispatch set_settings 未传 autoCompactionInstructions 时不覆盖已有指令（partial 合并语义）", async () => {
		const { cs, settingsSvc, stateStore, clientId } = createFixture();
		const setSpy = vi.spyOn(settingsSvc, "set");

		const initialMsg: ClientMessage = {
			type: "set_settings",
			autoCompactionInstructions: "Keep existing instructions",
		};
		handleSettingsMessage(initialMsg, cs as unknown as DispatchSession);
		await setSpy.mock.results[0]?.value;
		expect(settingsSvc.current.autoCompactionInstructions).toBe("Keep existing instructions");

		const partialMsg: ClientMessage = {
			type: "set_settings",
			thinkingWrap: true,
		};
		handleSettingsMessage(partialMsg, cs as unknown as DispatchSession);
		await setSpy.mock.results[1]?.value;

		expect(settingsSvc.current.autoCompactionInstructions).toBe("Keep existing instructions");
		const reloadedStore = new ClientStateStore(stateFile);
		expect(reloadedStore.getSettings(clientId).autoCompactionInstructions).toBe("Keep existing instructions");
	});

	it("通过 dispatch set_settings 传入空串可清空自定义指令", async () => {
		const { cs, settingsSvc, stateStore, clientId } = createFixture();
		const setSpy = vi.spyOn(settingsSvc, "set");

		handleSettingsMessage(
			{
				type: "set_settings",
				autoCompactionInstructions: "Custom text to be cleared",
			},
			cs as unknown as DispatchSession,
		);
		await setSpy.mock.results[0]?.value;
		expect(settingsSvc.current.autoCompactionInstructions).toBe("Custom text to be cleared");

		handleSettingsMessage(
			{
				type: "set_settings",
				autoCompactionInstructions: "",
			},
			cs as unknown as DispatchSession,
		);
		await setSpy.mock.results[1]?.value;
		expect(settingsSvc.current.autoCompactionInstructions).toBe("");
		const reloadedStore = new ClientStateStore(stateFile);
		expect(reloadedStore.getSettings(clientId).autoCompactionInstructions).toBe("");
	});
});
