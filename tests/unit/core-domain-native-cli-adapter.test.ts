import { describe, expect, it } from "vitest";
import {
	createCoreNativeCli,
	type CoreNativeCliSinks,
	type CoreNativeCliTerminals,
} from "../../server/core-native-cli-adapter.js";
import type { NativeCliTarget } from "../../packages/keel/src/contracts/native-cli.js";

type Call = [name: string, ...args: unknown[]];

const target = (overrides: Partial<NativeCliTarget> = {}): NativeCliTarget => ({
	conversationId: "c-1",
	terminalId: "cli-c-1",
	config: { preset: "claude" },
	cwd: "/work",
	title: "claude CLI",
	...overrides,
});

function fakeSinks(manager?: CoreNativeCliTerminals): { sinks: CoreNativeCliSinks; calls: Call[] } {
	const calls: Call[] = [];
	const sinks: CoreNativeCliSinks = {
		start: async (input) => {
			calls.push(["start", input]);
			return { terminalId: `cli-${input.conversationId}`, cwd: input.cwd };
		},
		reconnect: async (t) => {
			calls.push(["reconnect", t.conversationId]);
		},
		statusOf: (conversationId) => {
			calls.push(["statusOf", conversationId]);
			return { phase: "running", updatedAt: 1 };
		},
		applyTitle: (t) => {
			calls.push(["applyTitle", t.conversationId, t.title]);
		},
		terminalOf: () => manager,
		bindingKeyOf: () => "0b7c2c26-8f3e-4f4a-9d1a-1f7f2b0c9d55",
		remoteService: () => null,
	};
	return { sinks, calls };
}

function fakeTerminals(calls: Call[], persistent = false): CoreNativeCliTerminals {
	return {
		detachNativeCli: (id) => void calls.push(["detachNativeCli", id]),
		stopNativeCli: async (id) => void calls.push(["stopNativeCli", id]),
		hasPersistentNativeCli: () => persistent,
	};
}

describe("宿主侧 native-cli 适配器 · 结构直通", () => {
	it("launch / statusOf / reconnect / applyTitle 逐字交给宿主 sinks", async () => {
		const { sinks, calls } = fakeSinks(fakeTerminals([]));
		const port = createCoreNativeCli(sinks);
		await expect(
			port.launch({ conversationId: "c-1", config: { preset: "claude" }, cwd: "/work", title: "claude CLI" }),
		).resolves.toEqual({ terminalId: "cli-c-1", cwd: "/work" });
		expect(port.statusOf(target())).toEqual({ phase: "running", updatedAt: 1 });
		await port.reconnect(target());
		port.applyTitle(target({ title: "排障会话" }));
		expect(calls).toEqual([
			["start", { conversationId: "c-1", config: { preset: "claude" }, cwd: "/work", title: "claude CLI" }],
			["statusOf", "c-1"],
			["reconnect", "c-1"],
			["applyTitle", "c-1", "排障会话"],
		]);
	});

	it("detach：落到 `TerminalManager.detachNativeCli`", () => {
		const calls: Call[] = [];
		const port = createCoreNativeCli(fakeSinks(fakeTerminals(calls)).sinks);
		port.detach(target());
		expect(calls).toEqual([["detachNativeCli", "cli-c-1"]]);
	});

	it("stop（本地）：只停终端，不碰远端持久实例", async () => {
		const calls: Call[] = [];
		const port = createCoreNativeCli(fakeSinks(fakeTerminals(calls)).sinks);
		await port.stop(target());
		expect(calls).toEqual([["stopNativeCli", "cli-c-1"]]);
	});

	it("stop（远端 keep-alive 但 SSH 服务不可用）：不假装停掉了", async () => {
		const calls: Call[] = [];
		const port = createCoreNativeCli(fakeSinks(fakeTerminals(calls, false)).sinks);
		await expect(port.stop(target({ config: { preset: "claude", keepAlive: true } }))).rejects.toThrow(
			"SSH service is unavailable; remote stop could not be confirmed",
		);
		expect(calls).toEqual([]);
	});

	it("终端管理器不存在：明说哪个对话拿不到，而不是静默成功", async () => {
		const port = createCoreNativeCli(fakeSinks(undefined).sinks);
		expect(() => port.detach(target())).toThrow("CLI terminal manager is not available for this conversation");
		await expect(port.stop(target())).rejects.toThrow("CLI terminal manager is not available for this conversation");
	});
});
