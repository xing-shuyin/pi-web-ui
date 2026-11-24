import { describe, expect, it } from "vitest";
import {
	createCoreDshPatches,
	createCoreEnginePermissionMode,
	type DshPatchTarget,
	type EnginePermissionModeTarget,
} from "../../server/core-engine-extras-adapter.js";

/** 宿主那份 DSH 会话的假体：六个方法各记一笔（真实现是 `DshClientSession`，这里只看转没转对）。 */
function fakeDshSession(): DshPatchTarget & { calls: Array<{ member: string; args: unknown[] }> } {
	const calls: Array<{ member: string; args: unknown[] }> = [];
	const record = (member: string, args: unknown[]): Promise<void> => {
		calls.push({ member, args });
		return Promise.resolve();
	};
	return {
		calls,
		listDshPatches: () => record("listDshPatches", []),
		rescanDshPatches: () => record("rescanDshPatches", []),
		installDshPatch: (...args) => record("installDshPatch", args),
		toggleDshPatch: (...args) => record("toggleDshPatch", args),
		deleteDshPatch: (...args) => record("deleteDshPatch", args),
		fetchDshMarket: (...args) => record("fetchDshMarket", args),
	};
}

/** 宿主那份 claude 会话的假体：一个方法（真实现是 `server/universal/universal-session.ts:1151`）。 */
function fakeClaudeSession(): EnginePermissionModeTarget & { modes: string[] } {
	const modes: string[] = [];
	return {
		modes,
		setClaudePermissionMode: (mode) => {
			modes.push(mode);
			return Promise.resolve();
		},
	};
}

describe("server · core-engine-extras-adapter · 包现有实现", () => {
	it("六个 DSH 方法按原签名逐个转给 DshClientSession 的同名方法", async () => {
		const session = fakeDshSession();
		const port = createCoreDshPatches({ clientId: "cl-1", engine: () => "dsh", session: () => session });
		await port.listPatches();
		await port.rescanPatches();
		await port.installPatch("dsh-plugin-a", "pid");
		await port.togglePatch("a.yml", false);
		await port.deletePatch("a.yml");
		await port.fetchMarket(true);
		expect(session.calls).toEqual([
			{ member: "listDshPatches", args: [] },
			{ member: "rescanDshPatches", args: [] },
			{ member: "installDshPatch", args: ["dsh-plugin-a", "pid"] },
			{ member: "toggleDshPatch", args: ["a.yml", false] },
			{ member: "deleteDshPatch", args: ["a.yml"] },
			{ member: "fetchDshMarket", args: [true] },
		]);
	});

	it("setClaudePermissionMode 直接转给 universal 会话的同名方法", async () => {
		const session = fakeClaudeSession();
		const port = createCoreEnginePermissionMode({ clientId: "cl-1", engine: () => "claude", session: () => session });
		await port.setMode("acceptEdits");
		expect(session.modes).toEqual(["acceptEdits"]);
	});

	it("非对应引擎：六个 DSH 成员回可读错，且绝不碰到会话（不静默假成功）", () => {
		const session = fakeDshSession();
		const port = createCoreDshPatches({ clientId: "cl-1", engine: () => "pi", session: () => session });
		expect(() => port.listPatches()).toThrow(
			/dsh patch management \(listDshPatches\) is only available on the dsh engine/,
		);
		expect(() => port.fetchMarket()).toThrow(/this connection runs the "pi" engine/);
		expect(session.calls).toEqual([]);
	});

	it("非 claude 引擎：setClaudePermissionMode 回可读错（codex / durable 共用同一个类，但 driver 没这个模式）", () => {
		const session = fakeClaudeSession();
		const port = createCoreEnginePermissionMode({ clientId: "cl-1", engine: () => "codex", session: () => session });
		expect(() => port.setMode("plan")).toThrow(/only available on the claude engine/);
		expect(session.modes).toEqual([]);
	});

	it("引擎对但这会话不在：说清「没有活着的会话」，不是假装成功", () => {
		const dsh = createCoreDshPatches({ clientId: "cl-1", engine: () => "dsh", session: () => undefined });
		expect(() => dsh.rescanPatches()).toThrow(/no live dsh session for this client/);
		const claude = createCoreEnginePermissionMode({
			clientId: "cl-1",
			engine: () => "claude",
			session: () => undefined,
		});
		expect(() => claude.setMode("plan")).toThrow(/no live claude session for this client/);
	});

	it("会话形状不对（不是 DSH / universal 会话）也回可读错，不去调不存在的成员", () => {
		const dsh = createCoreDshPatches({ clientId: "cl-1", engine: () => "dsh", session: () => ({}) });
		expect(() => dsh.listPatches()).toThrow(/unavailable/);
		// 只有一半成员的形状同样不算：六个齐了才认。
		const partial = { listDshPatches: () => Promise.resolve() };
		const half = createCoreDshPatches({ clientId: "cl-1", engine: () => "dsh", session: () => partial });
		expect(() => half.togglePatch("a.yml", true)).toThrow(/unavailable/);
	});

	it("引擎名在调用时现取（同一条连接切了引擎立刻换结论）", () => {
		let engine = "dsh";
		const session = fakeDshSession();
		const port = createCoreDshPatches({ clientId: "cl-1", engine: () => engine, session: () => session });
		engine = "claude";
		expect(() => port.listPatches()).toThrow(/only available on the dsh engine/);
	});
});
