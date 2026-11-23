import { describe, expect, it, vi } from "vitest";
import type { ApprovalWaiter } from "../../packages/keel/src/domains/interactions/wire.js";
import type { SettingsFramePort } from "../../packages/keel/src/contracts/settings.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import { ClientRuntime } from "../../packages/keel/src/app/client-runtime.js";
import { createSettingsHandlers } from "../../packages/keel/src/domains/settings/handlers.js";

function fakeTransport(): { sent: ServerMessage[]; port: { send(m: ServerMessage): void; isClosed(): boolean } } {
	const sent: ServerMessage[] = [];
	return { sent, port: { send: (msg) => void sent.push(msg), isClosed: () => false } };
}

function fakeSettingsPort(overrides: Partial<SettingsFramePort> = {}): {
	port: SettingsFramePort;
	calls: [string, ...unknown[]][];
} {
	const calls: [string, ...unknown[]][] = [];
	const record =
		(name: string) =>
		(...args: unknown[]) => {
			calls.push([name, ...args]);
			return Promise.resolve();
		};
	const port: SettingsFramePort = {
		push: () => void calls.push(["push"]),
		refreshResources: () => void calls.push(["refreshResources"]),
		set: record("set") as SettingsFramePort["set"],
		savePreset: record("savePreset") as SettingsFramePort["savePreset"],
		applyPreset: record("applyPreset") as SettingsFramePort["applyPreset"],
		deletePreset: record("deletePreset") as SettingsFramePort["deletePreset"],
		exportPreset: record("exportPreset") as SettingsFramePort["exportPreset"],
		importPreset: record("importPreset") as SettingsFramePort["importPreset"],
		importPresetFromUrl: record("importPresetFromUrl") as SettingsFramePort["importPresetFromUrl"],
		pushPresetCatalog: record("pushPresetCatalog") as SettingsFramePort["pushPresetCatalog"],
		sharePreset: record("sharePreset") as SettingsFramePort["sharePreset"],
		saveApprovalRule: record("saveApprovalRule") as SettingsFramePort["saveApprovalRule"],
		saveApprovalRules: record("saveApprovalRules") as SettingsFramePort["saveApprovalRules"],
		deleteApprovalRule: record("deleteApprovalRule") as SettingsFramePort["deleteApprovalRule"],
		resetBuiltinApprovalRule: record("resetBuiltinApprovalRule") as SettingsFramePort["resetBuiltinApprovalRule"],
		saveTemplate: record("saveTemplate") as SettingsFramePort["saveTemplate"],
		deleteTemplate: record("deleteTemplate") as SettingsFramePort["deleteTemplate"],
		...overrides,
	};
	return { port, calls };
}

const exportMsg = { type: "preset_export", name: "p1" } as const;
const importMsg = { type: "preset_import", data: {} } as unknown as Parameters<SettingsFramePort["importPreset"]>[0];
const catalogMsg = { type: "preset_catalog" } as unknown as Parameters<SettingsFramePort["pushPresetCatalog"]>[0];

describe("设置 handler（B2）· setSettings 的三件内核事", () => {
	it("补丁原样交给宿主 set()，不自己补帧（出帧归 SettingsService）", async () => {
		const { port, calls } = fakeSettingsPort();
		const { port: tp, sent } = fakeTransport();
		await createSettingsHandlers({ settings: () => port, transport: tp }).setSettings({ thinkingWrap: true });
		expect(calls).toEqual([["set", { thinkingWrap: true }]]);
		expect(sent).toEqual([]);
	});

	it("toolApprovalEnabled=false → 放行全部待审批（老实现 autoApprovePendingApprovals）", async () => {
		const { port } = fakeSettingsPort();
		const release = vi.fn((_reason: string) => 2);
		const { port: tp } = fakeTransport();
		await createSettingsHandlers({
			settings: () => port,
			transport: tp,
			releasePendingApprovals: release,
		}).setSettings({ toolApprovalEnabled: false });
		expect(release).toHaveBeenCalledTimes(1);
		expect(release.mock.calls[0]?.[0]).toContain("审批已全局关闭");
	});

	it("disabledMarkers 走自己的通道：有 MarkerService 就写，并额外出一次 settings 帧 + 快照", async () => {
		const { port, calls } = fakeSettingsPort({ setDisabledMarkers: vi.fn() });
		const flush = vi.fn();
		const { port: tp } = fakeTransport();
		await createSettingsHandlers({ settings: () => port, transport: tp, flushSnapshot: flush }).setSettings({
			disabledMarkers: ["action"],
			thinkingWrap: false,
		});
		expect(port.setDisabledMarkers).toHaveBeenCalledWith(["action"]);
		// 标记不进 set()：它是另一条通道，混进去会被宿主当归一化未知键丢掉。
		expect(calls).toEqual([["set", { thinkingWrap: false }], ["push"]]);
		expect(flush).toHaveBeenCalledTimes(1);
	});

	it("disabledMarkers 没有通道时不静默丢：发一次 warning，其余键照常保存", async () => {
		const { port, calls } = fakeSettingsPort();
		const { port: tp, sent } = fakeTransport();
		const handlers = createSettingsHandlers({ settings: () => port, transport: tp });
		await handlers.setSettings({ disabledMarkers: ["action"], thinkingWrap: true });
		await handlers.setSettings({ disabledMarkers: ["rename"] });
		expect(calls.filter((c) => c[0] === "set")).toHaveLength(2);
		const warnings = sent.filter((m) => m.type === "notice");
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ level: "warning" });
	});

	it("端口抛错不吞（失败路径不静默）", async () => {
		const { port } = fakeSettingsPort({
			set: (() => Promise.reject(new Error("落盘失败"))) as SettingsFramePort["set"],
		});
		const { port: tp } = fakeTransport();
		await expect(createSettingsHandlers({ settings: () => port, transport: tp }).setSettings({})).rejects.toThrow(
			"落盘失败",
		);
	});
});

describe("设置 handler（B2）· 预设 / 审批规则 / 模板逐位转发", () => {
	const cases: [
		keyof ReturnType<typeof createSettingsHandlers>,
		(h: ReturnType<typeof createSettingsHandlers>) => unknown,
		string,
	][] = [
		["refreshSettings", (h) => h.refreshSettings(), "refreshResources"],
		["savePreset", (h) => h.savePreset("p1", ["approval"]), "savePreset"],
		["applyPreset", (h) => h.applyPreset("p1"), "applyPreset"],
		["deletePreset", (h) => h.deletePreset("p1"), "deletePreset"],
		["exportPreset", (h) => h.exportPreset(exportMsg), "exportPreset"],
		["importPreset", (h) => h.importPreset(importMsg), "importPreset"],
		["pushPresetCatalog", (h) => h.pushPresetCatalog(catalogMsg), "pushPresetCatalog"],
		["saveApprovalRule", (h) => h.saveApprovalRule({ id: "r1" } as never), "saveApprovalRule"],
		["saveApprovalRules", (h) => h.saveApprovalRules([]), "saveApprovalRules"],
		["deleteApprovalRule", (h) => h.deleteApprovalRule("r1"), "deleteApprovalRule"],
		["resetBuiltinApprovalRule", (h) => h.resetBuiltinApprovalRule("r1"), "resetBuiltinApprovalRule"],
		["saveSubagentTemplate", (h) => h.saveSubagentTemplate({ name: "t1" } as never), "saveTemplate"],
		["deleteSubagentTemplate", (h) => h.deleteSubagentTemplate("t1"), "deleteTemplate"],
	];

	for (const [member, invoke, portMethod] of cases) {
		it(`${member} → ${portMethod}`, async () => {
			const { port, calls } = fakeSettingsPort();
			const { port: tp } = fakeTransport();
			await invoke(createSettingsHandlers({ settings: () => port, transport: tp }));
			expect(calls.map((c) => c[0])).toEqual([portMethod]);
		});
	}

	it("每个成员在端口缺省时都同步抛 CoreEngineNotReadyError", () => {
		const { port: tp } = fakeTransport();
		const handlers = createSettingsHandlers({ transport: tp });
		const silent: string[] = [];
		for (const [member, invoke] of cases) {
			try {
				invoke(handlers);
				silent.push(`${member}（没抛）`);
			} catch (err) {
				if (!(err instanceof CoreEngineNotReadyError)) silent.push(`${member}（抛错类型不对：${String(err)}）`);
			}
		}
		try {
			handlers.setSettings({});
			silent.push("setSettings（没抛）");
		} catch (err) {
			if (!(err instanceof CoreEngineNotReadyError)) silent.push(`setSettings（抛错类型不对：${String(err)}）`);
		}
		expect(silent).toEqual([]);
	});
});

describe("设置 handler 接到 ClientRuntime（注册表里不再抛）", () => {
	it("handlers().setSettings 走得到宿主端口", async () => {
		const { port, calls } = fakeSettingsPort();
		const { port: tp } = fakeTransport();
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: { settingsVersion: 1, piConfigured: true, piAgentInstalled: true },
			clock: { now: () => 1, after: () => () => {} },
			transport: tp,
			settingsFrame: () => port,
		});
		await runtime.handlers().setSettings({ thinkingWrap: true });
		expect(calls).toEqual([["set", { thinkingWrap: true }]]);
	});

	it("setApprovalPolicy 写进对话聚合根，并推设置帧（老实现 settingsSvc.push() + flush）", () => {
		const { port } = fakeSettingsPort();
		const { port: tp } = fakeTransport();
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: { settingsVersion: 1, piConfigured: true, piAgentInstalled: true },
			clock: { now: () => 1, after: () => () => {} },
			transport: tp,
			settingsFrame: () => port,
		});
		const framePushes: string[] = [];
		runtime.attachFrames({
			pushSettings: () => void framePushes.push("settings"),
			refreshSessions: async () => {},
			pushProjects: async () => {},
			listModels: () => {},
			pushDefaultModel: () => {},
		});
		const conv = runtime.createConversation({ kind: "user" });
		// `categories` 是「裁剪」不是「新建」：类别详情只由审批结果回填（老口径）。
		conv.approvalPolicy = {
			allowAll: false,
			categories: new Map([["shell", { id: "shell", label: "命令行", labelEn: "Shell" }]]),
		};
		runtime.handlers().setApprovalPolicy?.({ allowAll: true, categories: ["shell"] });
		expect(conv.approvalPolicy?.allowAll).toBe(true);
		expect([...(conv.approvalPolicy?.categories.keys() ?? [])]).toEqual(["shell"]);
		runtime.handlers().setApprovalPolicy?.({ categories: [] });
		expect([...(conv.approvalPolicy?.categories.keys() ?? [])]).toEqual([]);
		expect(framePushes).toEqual(["settings", "settings"]);
	});

	it("setApprovalPolicy 对子代理对话不生效（老口径：子代理没有自己的策略）", () => {
		const { port, calls } = fakeSettingsPort();
		const { port: tp } = fakeTransport();
		const runtime = new ClientRuntime({
			clientId: "c1",
			cwd: "/work",
			env: { settingsVersion: 1, piConfigured: true, piAgentInstalled: true },
			clock: { now: () => 1, after: () => () => {} },
			transport: tp,
			settingsFrame: () => port,
		});
		const conv = runtime.createConversation({ kind: "subagent" });
		runtime.handlers().setApprovalPolicy?.({ allowAll: true });
		expect(conv.approvalPolicy).toBeUndefined();
		expect(calls).toEqual([]);
	});

	it("releasePendingApprovals 接到 ApprovalWaiter.settleAll 上（全局关审批时真的放行）", () => {
		const waiter = {
			request: vi.fn(),
			resolve: vi.fn(),
			pendingForSnapshot: vi.fn(() => []),
			cancelConversation: vi.fn(() => 0),
			settleAll: vi.fn(() => 3),
		} as unknown as ApprovalWaiter;
		expect(waiter.settleAll("approve", "x")).toBe(3);
		expect(waiter.settleAll).toHaveBeenCalledWith("approve", "x");
	});
});
