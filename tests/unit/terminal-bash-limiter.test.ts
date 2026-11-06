import { describe, expect, it } from "vitest";
import { makeTerminalBashTool, type TerminalManager } from "../../server/terminals.js";

function makeStub(): { mgr: TerminalManager; sent: string[] } {
	const sent: string[] = [];
	const mgr = {
		create: () => "ai-bash-1",
		suspendIdleWatch: () => {},
		endCursor: () => 0,
		setSentinelPending: () => {},
		inputChecked: (_id: string, data: string): string | null => {
			sent.push(data);
			return "stub: input halted";
		},
	} as unknown as TerminalManager;
	return { mgr, sent };
}

async function run(command: string): Promise<{ err: unknown; sent: string[] }> {
	const { mgr, sent } = makeStub();
	const tool = makeTerminalBashTool(mgr, {
		cwd: process.cwd(),
		defaultPersist: () => false,
		idleMs: () => 0,
		kills: new Set(),
		notifyBackgroundDone: () => {},
	});
	let err: unknown = null;
	try {
		await tool.execute("t1", { command }, undefined, undefined, undefined as never);
	} catch (e) {
		err = e;
	}
	return { err, sent };
}

describe("bash 工具：无尾部限输出管道时不崩（issue #121）", () => {
	it("裸命令（limiter=null）照常下发，不再抛 null 解引用", async () => {
		const { err, sent } = await run("date");
		expect((err as Error)?.message).toBe("stub: input halted");
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("date");
	});

	it("管道非限输出命令（| head）同样按原命令下发", async () => {
		const { err, sent } = await run("ls | head -5");
		expect((err as Error)?.message).toBe("stub: input halted");
		expect(sent[0]).toContain("ls | head -5");
	});

	it("尾部限输出管道（| tail -3）仍被拆掉：只跑底层命令", async () => {
		const { err, sent } = await run("seq 1 30 | tail -3");
		expect((err as Error)?.message).toBe("stub: input halted");
		expect(sent[0]).toContain("seq 1 30");
		expect(sent[0]).not.toContain("| tail");
	});
});
