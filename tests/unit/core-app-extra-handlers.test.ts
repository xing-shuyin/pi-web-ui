import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	ClientRuntime,
	type ClientFrames,
	type ClientRuntimeOptions,
} from "../../packages/keel/src/app/client-runtime.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { ClockPort } from "../../packages/keel/src/contracts/ports.js";
import type { SandboxLocated, SandboxPort } from "../../packages/keel/src/contracts/sandbox.js";
import { sessionListLimitOf } from "../../packages/keel/src/domains/history/index.js";
import type { ServerMessage } from "../../packages/keel/src/protocol.js";
import { PI_AGENT_PRESETS, PI_PERMISSION_OPTIONS } from "../../packages/keel/src/tool-catalog.js";
import { createFakeSettingsStore } from "../helpers/fake-settings-store.js";

/** 只记「排了几次合并出帧」的时钟：`publisher.request()` 走 `after()`，不需要真跑定时器。 */
function fakeClock(): ClockPort & { scheduled: number[] } {
	const scheduled: number[] = [];
	return {
		scheduled,
		now: () => 1_000,
		after: (ms: number, _fn: () => void) => {
			scheduled.push(ms);
			return () => {};
		},
	};
}

function fakeFrames() {
	return {
		pushSettings: vi.fn(),
		refreshSessions: vi.fn(async () => {}),
		pushProjects: vi.fn(async () => {}),
		listModels: vi.fn(),
		pushDefaultModel: vi.fn(),
	} satisfies ClientFrames;
}

function makeRuntime(overrides: Partial<ClientRuntimeOptions> = {}) {
	const sent: ServerMessage[] = [];
	const clock = fakeClock();
	const frames = fakeFrames();
	const runtime = new ClientRuntime({
		clientId: "client-1",
		cwd: "/work",
		env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: false }),
		clock,
		transport: { send: (msg) => void sent.push(msg), isClosed: () => false },
		...overrides,
	});
	runtime.attachFrames(frames);
	return { runtime, sent, frames, clock };
}

function fakeSandbox(located?: SandboxLocated) {
	const destroyed: string[] = [];
	const port: SandboxPort = {
		locate: async () => located,
		create: async () => ({ path: "" }),
		reset: async () => {},
		persist: async () => {},
		promote: async () => ({ targetPath: "" }),
		diff: async () => {},
		applyToSource: async () => {},
		destroy: async (path: string) => void destroyed.push(path),
	};
	return { port, destroyed };
}

function transcript(opts: { id: string; cwd: string; text: string; at: number }): string {
	return (
		[
			JSON.stringify({ type: "session", id: opts.id, cwd: opts.cwd, timestamp: "2026-01-02T03:04:05.000Z" }),
			JSON.stringify({
				type: "message",
				id: "m1",
				parentId: null,
				timestamp: new Date(opts.at).toISOString(),
				message: { role: "user", content: opts.text, timestamp: opts.at },
			}),
		].join("\n") + "\n"
	);
}

describe("app · extra-handlers（端口/域已齐、只差 handler 的 7 个成员）", () => {
	it("setSessionListLimit：按项目记住条数，夹在 [20, 5000]，帧出口读同一份", () => {
		const { runtime } = makeRuntime();
		const cs = runtime.handlers();

		expect(cs.setSessionListLimit?.("/work/a", 1)).toBe(20);
		expect(cs.setSessionListLimit?.("/work/b", 10_000)).toBe(5_000);
		expect(cs.setSessionListLimit?.("/work/a", 42)).toBe(42);
		// 不传数 = 只读当前值（老实现同口径：不会把表清掉）。
		expect(cs.setSessionListLimit?.("/work/a")).toBe(42);
		expect(cs.setSessionListLimit?.("/work/never-set")).toBe(200);
		expect(sessionListLimitOf(runtime.sessionLimits, "/work/a")).toBe(42);
	});

	it("removeProject：不是沙盒就只清墓碑 + 推 projects 帧", async () => {
		const store = createFakeSettingsStore();
		const sandbox = fakeSandbox();
		const { runtime, frames, clock } = makeRuntime({
			stateStore: () => store,
			sandbox: () => sandbox.port,
		});

		await runtime.handlers().removeProject("/work/plain");

		expect(store.calls.removed).toEqual([["client-1", "/work/plain"]]);
		expect(sandbox.destroyed).toEqual([]);
		expect(frames.pushProjects).toHaveBeenCalledTimes(1);
		expect(clock.scheduled).toEqual([]); // 非沙盒分支不刷快照
	});

	it("removeProject：项目是沙盒就先销毁，墓碑记沙盒目录，并刷一次快照", async () => {
		const store = createFakeSettingsStore();
		const sandbox = fakeSandbox({ id: "sbx-1", path: "/work/sbx", name: "隔离区" });
		const { runtime, frames, clock } = makeRuntime({
			stateStore: () => store,
			sandbox: () => sandbox.port,
		});

		await runtime.handlers().removeProject("/work/sbx/sub");

		expect(sandbox.destroyed).toEqual(["/work/sbx"]);
		expect(store.calls.removed).toEqual([["client-1", "/work/sbx"]]);
		expect(frames.pushProjects).toHaveBeenCalledTimes(1);
		expect(clock.scheduled).toHaveLength(1);
	});

	it("searchSessions：HistoryEntry 适配成检索入参，回 session_search_results 帧", async () => {
		const dir = mkdtempSync(join(tmpdir(), "extra-search-"));
		const file = join(dir, "s.jsonl");
		writeFileSync(
			file,
			transcript({ id: "sess-1", cwd: dir, text: "这里有一个 needle 命中", at: 1_700_000_000_000 }),
			"utf8",
		);
		const store = createFakeSettingsStore();
		const { runtime, sent } = makeRuntime({ cwd: dir, stateStore: () => store });
		runtime.noteSessionFile(file);

		await runtime.handlers().searchSessions("needle", 7);

		expect(sent).toEqual([
			{
				type: "session_search_results",
				reqId: 7,
				query: "needle",
				ok: true,
				results: [
					{
						path: file,
						name: "这里有一个 needle 命中",
						displayName: "这里有一个 needle 命中",
						firstMessage: "这里有一个 needle 命中",
						messageCount: 1,
						modified: 1_700_000_000_000,
						cwd: dir,
						anchors: [{ role: "user", timestamp: 1_700_000_000_000 }],
					},
				],
			},
		]);
	});

	it("searchSessions：空查询 / 没有会话目录都回 ok:true 的空结果（不是 ok:false）", async () => {
		const store = createFakeSettingsStore();
		const { runtime, sent } = makeRuntime({ stateStore: () => store });
		const cs = runtime.handlers();

		await cs.searchSessions("   ", 1);
		await cs.searchSessions("needle", 2); // 还没开过会话 = 没有会话目录

		expect(sent).toEqual([
			{ type: "session_search_results", reqId: 1, query: "   ", ok: true, results: [] },
			{ type: "session_search_results", reqId: 2, query: "needle", ok: true, results: [] },
		]);
	});

	it("refreshAgentPresets：目录来自内核，默认值来自设置", async () => {
		const store = createFakeSettingsStore();
		store.saveSettings("client-1", { defaultAgentPreset: "minimal" });
		const { runtime, sent } = makeRuntime({ stateStore: () => store });

		await runtime.handlers().refreshAgentPresets?.();

		expect(sent).toEqual([{ type: "dsh_presets", presets: PI_AGENT_PRESETS, defaultPreset: "minimal" }]);
	});

	it("setDefaultAgentPreset：校验 id → 落盘 → 设置帧 + 预设帧 + 快照", async () => {
		const store = createFakeSettingsStore();
		const { runtime, sent, frames, clock } = makeRuntime({ stateStore: () => store });

		await runtime.handlers().setDefaultAgentPreset?.("code");

		expect(store.getSettings("client-1").defaultAgentPreset).toBe("code");
		expect(frames.pushSettings).toHaveBeenCalledTimes(1);
		expect(sent).toEqual([{ type: "dsh_presets", presets: PI_AGENT_PRESETS, defaultPreset: "code" }]);
		expect(clock.scheduled).toHaveLength(1);
	});

	it("setDefaultAgentPreset：未知 id 只发警告，不落盘", async () => {
		const store = createFakeSettingsStore();
		const { runtime, sent, frames } = makeRuntime({ stateStore: () => store });

		await runtime.handlers().setDefaultAgentPreset?.("nope");

		expect(store.getSettings("client-1").defaultAgentPreset).toBe("standard");
		expect(frames.pushSettings).not.toHaveBeenCalled();
		expect(sent).toEqual([
			{
				type: "notice",
				level: "warning",
				text: "未知预设「nope」，默认预设未改",
				textEn: 'Unknown preset "nope"; default preset unchanged',
			},
		]);
	});

	it("setDefaultPermissionPreset：校验 value → 落盘 → 权限帧 + 快照；未知值只发警告", async () => {
		const store = createFakeSettingsStore();
		const { runtime, sent, clock } = makeRuntime({ stateStore: () => store });
		const cs = runtime.handlers();

		await cs.setDefaultPermissionPreset?.("read-only");
		await cs.setDefaultPermissionPreset?.("nope");

		expect(store.getSettings("client-1").defaultPermissionPreset).toBe("read-only");
		expect(clock.scheduled).toHaveLength(1);
		expect(sent).toEqual([
			{ type: "dsh_permission", options: PI_PERMISSION_OPTIONS, defaultPreset: "read-only" },
			{
				type: "notice",
				level: "warning",
				text: "未知权限预设「nope」，默认未改",
				textEn: 'Unknown permission preset "nope"; default unchanged',
			},
		]);
	});

	it("端口没注入时同步抛 CoreEngineNotReadyError（不是 rejected promise）", () => {
		const { runtime } = makeRuntime();
		const cs = runtime.handlers();
		const silent: string[] = [];
		const cases: [string, () => unknown][] = [
			["removeProject", () => cs.removeProject("/work/x")],
			["searchSessions", () => cs.searchSessions("q", 1)],
			["refreshAgentPresets", () => cs.refreshAgentPresets?.()],
			["setDefaultAgentPreset", () => cs.setDefaultAgentPreset?.("standard")],
			["setDefaultPermissionPreset", () => cs.setDefaultPermissionPreset?.("read-only")],
		];
		for (const [member, invoke] of cases) {
			try {
				const out = invoke();
				if (out instanceof Promise) out.catch(() => {});
				silent.push(`${member}（没抛）`);
			} catch (err) {
				if (!(err instanceof CoreEngineNotReadyError)) silent.push(`${member}（抛错类型不对）`);
			}
		}
		expect(silent).toEqual([]);
	});

	it("只注入设置存储、没有沙盒面时，removeProject 也同步抛（不敢动墓碑）", () => {
		const store = createFakeSettingsStore();
		const { runtime } = makeRuntime({ stateStore: () => store });
		expect(() => runtime.handlers().removeProject("/work/x")).toThrow(CoreEngineNotReadyError);
		expect(store.calls.removed).toEqual([]);
	});
});
