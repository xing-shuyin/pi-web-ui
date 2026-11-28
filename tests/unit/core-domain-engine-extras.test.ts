import { describe, expect, it } from "vitest";
import { ClientRuntime } from "../../packages/keel/src/app/client-runtime.js";
import { createDispatchHandlers } from "../../packages/keel/src/app/dispatch-handlers.js";
import { createEngineExtrasHandlersFor } from "../../packages/keel/src/app/engine-extras-handlers.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import type { DshPatchPort, EnginePermissionModePort } from "../../packages/keel/src/contracts/engine-extras.js";
import type { ClockPort } from "../../packages/keel/src/contracts/ports.js";
import { createEngineExtrasHandlers } from "../../packages/keel/src/domains/engine-extras/index.js";
import { createDispatchSurfaceAdapter } from "../../packages/keel/src/adapters/wire/index.js";
import { DISPATCH_SURFACE } from "../../packages/keel/src/adapters/wire/dispatch-surface.js";
import type { ServerMessage } from "../../server/protocol.js";

/** DSH 补丁面的假体：七个动作各记一笔（骨架，逐条用例只关心被转哪一次、带什么参数）。 */
function fakeDsh(): DshPatchPort & { calls: Array<{ member: string; args: unknown[] }> } {
	const calls: Array<{ member: string; args: unknown[] }> = [];
	const record = (member: string, args: unknown[]): Promise<void> => {
		calls.push({ member, args });
		return Promise.resolve();
	};
	return {
		calls,
		listPatches: () => record("listPatches", []),
		rescanPatches: () => record("rescanPatches", []),
		installPatch: (...args) => record("installPatch", args),
		togglePatch: (...args) => record("togglePatch", args),
		deletePatch: (...args) => record("deletePatch", args),
		fetchMarket: (...args) => record("fetchMarket", args),
	};
}

function fakePermission(): EnginePermissionModePort & { modes: string[] } {
	const modes: string[] = [];
	return {
		modes,
		setMode: (mode) => {
			modes.push(mode);
			return Promise.resolve();
		},
	};
}

const SEVEN = [
	"listDshPatches",
	"rescanDshPatches",
	"installDshPatch",
	"toggleDshPatch",
	"deleteDshPatch",
	"fetchDshMarket",
	"setClaudePermissionMode",
] as const;

describe("domains/engine-extras · 7 个引擎专属成员的转发", () => {
	it("listDshPatches 转到端口 listPatches（无参）", async () => {
		const dsh = fakeDsh();
		const handlers = createEngineExtrasHandlers({ dshPatches: () => dsh });
		await handlers.listDshPatches();
		expect(dsh.calls).toEqual([{ member: "listPatches", args: [] }]);
	});

	it("rescanDshPatches 转到端口 rescanPatches", async () => {
		const dsh = fakeDsh();
		await createEngineExtrasHandlers({ dshPatches: () => dsh }).rescanDshPatches();
		expect(dsh.calls).toEqual([{ member: "rescanPatches", args: [] }]);
	});

	it("installDshPatch 原样带 spec / id（含省略 id）", async () => {
		const dsh = fakeDsh();
		const handlers = createEngineExtrasHandlers({ dshPatches: () => dsh });
		await handlers.installDshPatch("dsh-plugin-x", "pid");
		await handlers.installDshPatch("dsh-plugin-y");
		expect(dsh.calls).toEqual([
			{ member: "installPatch", args: ["dsh-plugin-x", "pid"] },
			{ member: "installPatch", args: ["dsh-plugin-y", undefined] },
		]);
	});

	it("toggleDshPatch 原样带 name / enabled（false 不丢）", async () => {
		const dsh = fakeDsh();
		const handlers = createEngineExtrasHandlers({ dshPatches: () => dsh });
		await handlers.toggleDshPatch("a.yml", false);
		await handlers.toggleDshPatch("a.yml.disabled", true);
		expect(dsh.calls).toEqual([
			{ member: "togglePatch", args: ["a.yml", false] },
			{ member: "togglePatch", args: ["a.yml.disabled", true] },
		]);
	});

	it("deleteDshPatch 原样带 name", async () => {
		const dsh = fakeDsh();
		await createEngineExtrasHandlers({ dshPatches: () => dsh }).deleteDshPatch("a.yml");
		expect(dsh.calls).toEqual([{ member: "deletePatch", args: ["a.yml"] }]);
	});

	it("fetchDshMarket 原样带 force（undefined 不变成 false）", async () => {
		const dsh = fakeDsh();
		const handlers = createEngineExtrasHandlers({ dshPatches: () => dsh });
		await handlers.fetchDshMarket(true);
		await handlers.fetchDshMarket();
		expect(dsh.calls).toEqual([
			{ member: "fetchMarket", args: [true] },
			{ member: "fetchMarket", args: [undefined] },
		]);
	});

	it("setClaudePermissionMode 转到端口 setMode（只带模式名）", async () => {
		const permission = fakePermission();
		await createEngineExtrasHandlers({ permissionMode: () => permission }).setClaudePermissionMode("plan");
		expect(permission.modes).toEqual(["plan"]);
	});

	it("端口返回的那个 Promise 原样透出（内核不另包一层）", () => {
		const pending = Promise.resolve();
		const handlers = createEngineExtrasHandlers({ dshPatches: () => ({ ...fakeDsh(), listPatches: () => pending }) });
		expect(handlers.listDshPatches()).toBe(pending);
	});

	it("未注入端口：七个成员逐个同步抛 CoreEngineNotReadyError（不是 rejected promise）", () => {
		const handlers = createEngineExtrasHandlers({});
		for (const member of SEVEN) {
			const call = handlers[member] as (...args: unknown[]) => unknown;
			let thrown: unknown;
			try {
				call(member === "toggleDshPatch" ? ["a.yml", true] : "x");
			} catch (error) {
				thrown = error;
			}
			expect(thrown, member).toBeInstanceOf(CoreEngineNotReadyError);
			expect((thrown as Error).message, member).toContain(member);
		}
	});

	it("只有一条端口注入时，另一条仍然同步抛（不互相顶替）", () => {
		const handlers = createEngineExtrasHandlers({ dshPatches: () => fakeDsh() });
		expect(() => handlers.setClaudePermissionMode("plan")).toThrow(CoreEngineNotReadyError);
		const onlyPermission = createEngineExtrasHandlers({ permissionMode: () => fakePermission() });
		expect(() => onlyPermission.listDshPatches()).toThrow(CoreEngineNotReadyError);
	});

	it("装配后分发表里的这 7 个成员不再是兜底（不抛 dispatch.<成员>）", async () => {
		const dsh = fakeDsh();
		const surface = createDispatchSurfaceAdapter({
			cwd: "/w",
			workspaceRoots: ["/w"],
			...createEngineExtrasHandlersFor({
				options: { dshPatches: () => dsh, enginePermissionMode: () => fakePermission() },
			}),
		});
		await surface.listDshPatches?.();
		await surface.setClaudePermissionMode?.("acceptEdits");
		expect(dsh.calls).toEqual([{ member: "listPatches", args: [] }]);
	});

	it("ClientRuntime 把两条 thunk 交给这 7 个成员（连接上就是真转发，不是兜底）", async () => {
		const clock: ClockPort = { now: () => 1, after: () => () => {} };
		const sent: ServerMessage[] = [];
		const dsh = fakeDsh();
		const permission = fakePermission();
		const runtime = new ClientRuntime({
			clientId: "cl-1",
			cwd: "/w",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: false }),
			clock,
			transport: { send: (msg: ServerMessage) => void sent.push(msg), isClosed: () => false },
			dshPatches: () => dsh,
			enginePermissionMode: () => permission,
		});
		const cs = runtime.handlers();
		await cs.listDshPatches?.();
		await cs.fetchDshMarket?.(true);
		await cs.setClaudePermissionMode?.("plan");
		expect(dsh.calls).toEqual([
			{ member: "listPatches", args: [] },
			{ member: "fetchMarket", args: [true] },
		]);
		expect(permission.modes).toEqual(["plan"]);
	});

	it("185/185：分发表里没有任何成员落到适配器兜底（全是真 handler）", () => {
		const clock: ClockPort = { now: () => 1, after: () => () => {} };
		const runtime = new ClientRuntime({
			clientId: "cl-1",
			cwd: "/w",
			env: () => ({ settingsVersion: 1, piConfigured: true, piAgentInstalled: false }),
			clock,
			transport: { send: () => {}, isClosed: () => false },
		});
		// 适配器只在 `handlers[成员]` 为空时才填「调用即抛」的兜底，所以装配层逐项非空 = 无兜底。
		const { handlers } = createDispatchHandlers(runtime);
		const missing = DISPATCH_SURFACE.filter((member) => handlers[member] === undefined);
		expect(missing).toEqual([]);
		expect(DISPATCH_SURFACE.length).toBe(187);
	});
});
