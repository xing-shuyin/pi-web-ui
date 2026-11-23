import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TransportPort } from "../../packages/keel/src/contracts/ports.js";
import { createTerminalHost } from "../../packages/keel/src/domains/terminals/index.js";
import type { ServerLang } from "../../server/i18n.js";
import type { ServerMessage, TerminalInfo } from "../../server/protocol.js";

/** 本机跑真 PTY（node-pty + ConPTY）不稳，叶子整体换成可数的假体，只验证宿主的接线。 */
const fixture = vi.hoisted(() => {
	const info = (id: string, running: boolean): TerminalInfo => ({
		id,
		title: id,
		cwd: "/work",
		cols: 80,
		rows: 24,
		running,
		exitCode: running ? null : 0,
	});

	class MockTerminalManager {
		static readonly created: MockTerminalManager[] = [];
		readonly live: string[] = [];
		readonly dead: string[] = [];
		readonly killCalls: string[] = [];
		listCalls = 0;
		killThrowsFor: string | null = null;

		constructor(
			readonly emit: (msg: ServerMessage) => void,
			readonly rootSource: string | (() => string),
			readonly lang?: () => ServerLang,
		) {
			MockTerminalManager.created.push(this);
		}

		add(id: string, running = true): void {
			(running ? this.live : this.dead).push(id);
		}

		list(): TerminalInfo[] {
			this.listCalls += 1;
			return [...this.live.map((id) => info(id, true)), ...this.dead.map((id) => info(id, false))];
		}

		kill(id: string): void {
			this.killCalls.push(id);
			if (this.killThrowsFor === id) throw new Error("pty already gone");
			for (const bucket of [this.live, this.dead]) {
				const at = bucket.indexOf(id);
				if (at >= 0) bucket.splice(at, 1);
			}
		}
	}

	return { MockTerminalManager };
});

function hostFor(over: { cwdOf?: (conversationId: string) => string; lang?: () => ServerLang } = {}) {
	const sent: ServerMessage[] = [];
	let closed = false;
	const transport: TransportPort = {
		send: (msg) => {
			sent.push(msg);
		},
		isClosed: () => closed,
	};
	const host = createTerminalHost({
		transport,
		cwdOf: over.cwdOf ?? ((conversationId: string) => `/work/${conversationId}`),
		lang: over.lang ?? (() => "zh" as ServerLang),
		// 叶子（真 PTY）由宿主注入：这里给假体，只实现用例用到的那几个方法。
		createManager: ({ emit, cwd, lang }) => new fixture.MockTerminalManager(emit, cwd, lang) as never,
	});
	return {
		host,
		sent,
		close(): void {
			closed = true;
		},
	};
}

function managerAt(index: number) {
	return fixture.MockTerminalManager.created[index];
}

function rootOf(index: number): string {
	const source = managerAt(index).rootSource;
	expect(typeof source).toBe("function");
	return (source as () => string)();
}

beforeEach(() => {
	fixture.MockTerminalManager.created.length = 0;
});

describe("domains/terminals · 终端宿主", () => {
	it("managerFor 是懒建：没取过就没有管理器", () => {
		const { host } = hostFor();
		expect(fixture.MockTerminalManager.created).toHaveLength(0);
		const manager = host.managerFor("c1", "/work/c1");
		expect(fixture.MockTerminalManager.created).toHaveLength(1);
		expect(manager).toBe(managerAt(0));
	});

	it("同一对话复用同一份管理器（cwd 变了也不重建）", () => {
		const { host } = hostFor();
		const first = host.managerFor("c1", "/work/c1");
		const second = host.managerFor("c1", "/work/elsewhere");
		expect(second).toBe(first);
		expect(fixture.MockTerminalManager.created).toHaveLength(1);
	});

	it("不同对话各自一份管理器", () => {
		const { host } = hostFor();
		const first = host.managerFor("c1", "/work/c1");
		const second = host.managerFor("c2", "/work/c2");
		expect(second).not.toBe(first);
		expect(fixture.MockTerminalManager.created).toHaveLength(2);
		expect(rootOf(0)).toBe("/work/c1");
		expect(rootOf(1)).toBe("/work/c2");
	});

	it("managers() 只列已建过管理器的对话", () => {
		const { host } = hostFor();
		expect(host.managers()).toEqual([]);
		host.managerFor("c1", "/work/c1");
		host.managerFor("c2", "/work/c2");
		expect(host.managers()).toEqual(["c1", "c2"]);
	});

	it("rootSource 取自注入的 cwdOf，而且每次现取", () => {
		let cwd = "/work/first";
		const { host } = hostFor({ cwdOf: () => cwd });
		host.managerFor("c1", "/fallback");
		expect(rootOf(0)).toBe("/work/first");
		cwd = "/work/second";
		expect(rootOf(0)).toBe("/work/second");
	});

	it("cwdOf 说不出目录时回落到 managerFor 的 cwd 入参", () => {
		const { host } = hostFor({ cwdOf: () => "" });
		host.managerFor("c1", "/fallback");
		expect(rootOf(0)).toBe("/fallback");
	});

	it("lang 用注入的那把函数（叶子提示语跟着宿主语言）", () => {
		const lang = vi.fn(() => "en" as ServerLang);
		const { host } = hostFor({ lang });
		host.managerFor("c1", "/work/c1");
		const captured = managerAt(0).lang;
		expect(captured).toBe(lang);
		expect(captured?.()).toBe("en");
	});

	it("叶子 emit 的帧只经注入的 transport.send 出去", () => {
		const { host, sent } = hostFor();
		host.managerFor("c1", "/work/c1");
		managerAt(0).emit({ type: "terminal_output", terminalId: "t1", data: "hi" });
		managerAt(0).emit({ type: "terminal_exit", terminalId: "t1", exitCode: 0 });
		expect(sent).toEqual([
			{ type: "terminal_output", terminalId: "t1", data: "hi" },
			{ type: "terminal_exit", terminalId: "t1", exitCode: 0 },
		]);
	});

	it("通道已关时丢帧且不抛", () => {
		const { host, sent, close } = hostFor();
		host.managerFor("c1", "/work/c1");
		close();
		const emit = managerAt(0).emit;
		expect(() => emit({ type: "terminal_list", terminals: [] })).not.toThrow();
		expect(sent).toEqual([]);
	});

	it("disposeConversation 从叶子的清单里收掉活终端，已退出的不动", () => {
		const { host } = hostFor();
		host.managerFor("c1", "/work/c1");
		const manager = managerAt(0);
		manager.add("t-live");
		manager.add("t-dead", false);
		host.disposeConversation("c1");
		expect(manager.listCalls).toBeGreaterThan(0);
		expect(manager.killCalls).toEqual(["t-live"]);
		expect(manager.live).toEqual([]);
		expect(host.managers()).toEqual([]);
	});

	it("重复 disposeConversation 不会再碰叶子", () => {
		const { host } = hostFor();
		host.managerFor("c1", "/work/c1");
		const manager = managerAt(0);
		manager.add("t-live");
		host.disposeConversation("c1");
		host.disposeConversation("c1");
		expect(manager.killCalls).toEqual(["t-live"]);
	});

	it("没建过管理器的对话 dispose 是空操作", () => {
		const { host } = hostFor();
		expect(() => host.disposeConversation("nope")).not.toThrow();
		expect(fixture.MockTerminalManager.created).toHaveLength(0);
		expect(host.managers()).toEqual([]);
	});

	it("dispose 之后再取会建一份新的管理器", () => {
		const { host } = hostFor();
		const first = host.managerFor("c1", "/work/c1");
		host.disposeConversation("c1");
		const second = host.managerFor("c1", "/work/c1");
		expect(second).not.toBe(first);
		expect(fixture.MockTerminalManager.created).toHaveLength(2);
	});

	it("disposeAll 收掉所有对话的活终端并清空登记", () => {
		const { host } = hostFor();
		host.managerFor("c1", "/work/c1");
		host.managerFor("c2", "/work/c2");
		const [first, second] = fixture.MockTerminalManager.created;
		first.add("a1");
		second.add("b1");
		second.add("b-dead", false);
		host.disposeAll();
		expect(first.killCalls).toEqual(["a1"]);
		expect(second.killCalls).toEqual(["b1"]);
		expect(host.managers()).toEqual([]);
	});

	it("单个终端收不掉不挡其余终端的清理", () => {
		const { host } = hostFor();
		host.managerFor("c1", "/work/c1");
		const manager = managerAt(0);
		manager.killThrowsFor = "t-bad";
		manager.add("t-bad");
		manager.add("t-good");
		expect(() => host.disposeConversation("c1")).not.toThrow();
		expect(manager.killCalls).toEqual(["t-bad", "t-good"]);
	});

	it("disposeAll 之后 disposeConversation 仍是空操作", () => {
		const { host } = hostFor();
		host.managerFor("c1", "/work/c1");
		const manager = managerAt(0);
		manager.add("t-live");
		host.disposeAll();
		expect(() => host.disposeConversation("c1")).not.toThrow();
		expect(manager.killCalls).toEqual(["t-live"]);
	});
});
