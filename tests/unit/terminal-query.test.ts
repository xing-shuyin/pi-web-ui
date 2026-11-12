import { describe, expect, it } from "vitest";
import { CONPTY_DA1_REPLY, splitConptyDa1, stripTerminalQueryRequests } from "../../server/terminal-query.js";
import { TerminalManager } from "../../server/terminals.js";
import type { ServerMessage } from "../../server/protocol.js";

describe("stripTerminalQueryRequests（回放不含查询请求）", () => {
	it("摘掉 DA1/DA2/DA3", () => {
		expect(stripTerminalQueryRequests("a\x1b[cb")).toBe("ab");
		expect(stripTerminalQueryRequests("\x1b[0c")).toBe("");
		expect(stripTerminalQueryRequests("\x1b[>c")).toBe("");
		expect(stripTerminalQueryRequests("\x1b[>0c")).toBe("");
		expect(stripTerminalQueryRequests("\x1b[=c")).toBe("");
	});

	it("摘掉 DSR / DECRQM / 尺寸报告 / XTVERSION / OSC 颜色查询", () => {
		expect(stripTerminalQueryRequests("x\x1b[6ny")).toBe("xy");
		expect(stripTerminalQueryRequests("\x1b[?6n")).toBe("");
		expect(stripTerminalQueryRequests("\x1b[5n")).toBe("");
		expect(stripTerminalQueryRequests("\x1b[?2026$p")).toBe("");
		expect(stripTerminalQueryRequests("\x1b[18t")).toBe("");
		expect(stripTerminalQueryRequests("\x1b[>q")).toBe("");
		expect(stripTerminalQueryRequests("\x1b]11;?\x07")).toBe("");
		expect(stripTerminalQueryRequests("\x1b]4;1;?\x1b\\")).toBe("");
	});

	it("普通输出、SGR、终端回话都不动", () => {
		const plain = "MINGW64 /e/pi-web-ui (main)\r\n$ ls\r\n";
		expect(stripTerminalQueryRequests(plain)).toBe(plain);
		const sgr = "\x1b[1;31mred\x1b[0m";
		expect(stripTerminalQueryRequests(sgr)).toBe(sgr);
		for (const response of ["\x1b[?1;2c", "\x1b[12;40R", "\x1b[>0;276;0c"]) {
			expect(stripTerminalQueryRequests(response)).toBe(response);
		}
	});

	it("ConPTY 启动序列只剩渲染/模式部分", () => {
		expect(stripTerminalQueryRequests("\x1b[1t\x1b[c\x1b[?1004h\x1b[?9001h")).toBe("\x1b[1t\x1b[?1004h\x1b[?9001h");
	});
});

describe("splitConptyDa1（服务端只回一次）", () => {
	it("同一个 chunk 里见到 DA1：回话一次，其余原样放过", () => {
		const step = splitConptyDa1("", "\x1b[1t\x1b[c\x1b[?1004h");
		expect(step).toEqual({ reply: CONPTY_DA1_REPLY, pass: "\x1b[1t\x1b[?1004h", pending: "" });
	});

	it("查询被切在两个 chunk 中间：先扣住前缀，下一段再回", () => {
		const first = splitConptyDa1("", "\x1b[1t\x1b[");
		expect(first).toEqual({ reply: null, pass: "\x1b[1t", pending: "\x1b[" });
		const second = splitConptyDa1(first.pending, "c\x1b[?1004h");
		expect(second).toEqual({ reply: CONPTY_DA1_REPLY, pass: "\x1b[?1004h", pending: "" });
	});

	it("没有 DA1 时不回话", () => {
		expect(splitConptyDa1("", "\x1b[?2004h$ ")).toEqual({ reply: null, pass: "\x1b[?2004h$ ", pending: "" });
	});
});

function makeManager(): { mgr: TerminalManager; sent: ServerMessage[] } {
	const sent: ServerMessage[] = [];
	const mgr = new TerminalManager((msg) => sent.push(msg), "/tmp");
	return { mgr, sent };
}

function putTerminal(mgr: TerminalManager, id: string, output: string): void {
	const entry = {
		id,
		pty: { resize() {}, write() {} },
		title: id,
		cwd: "/tmp",
		cols: 80,
		rows: 24,
		exited: false,
		exitCode: null,
		output,
		outputOffset: 0,
		waiters: new Set<() => void>(),
		pendingOut: "",
		flushTimer: null,
		agentTouched: false,
		lastActivityAt: 0,
		idleTimer: null,
		watches: [],
		agentBash: false,
		used: true,
		agentPendingLine: "",
	};
	(mgr as unknown as { terms: Map<string, unknown> }).terms.set(id, entry);
}

describe("历史回放不再让终端回话", () => {
	it("replay() 给出的是去掉查询请求的历史", () => {
		const { mgr } = makeManager();
		putTerminal(mgr, "t1", "\x1b[1t\x1b[cbanner\r\n\x1b[6n$ ");
		expect(mgr.replay()).toEqual([{ terminalId: "t1", data: "\x1b[1tbanner\r\n$ " }]);
	});

	it("attach() 的 reset 帧同样干净（否则 ConPTY 多收一条回话就落到提示符上）", () => {
		const { mgr, sent } = makeManager();
		putTerminal(mgr, "t1", "\x1b[cbanner\r\n");
		expect(mgr.attach("t1", 100, 30)).toBe(true);
		expect(sent).toContainEqual({
			type: "terminal_output",
			terminalId: "t1",
			data: "banner\r\n",
			reset: true,
			ownerKind: "conversation",
		});
	});
});
