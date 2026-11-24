import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ServerMessage } from "../../server/protocol.js";
import { createGuardedBuiltinTools } from "../../packages/keel/src/adapters/tools/guarded.js";
import { CoreEngineNotReadyError } from "../../packages/keel/src/contracts/core-engine-errors.js";
import { ABORT_BASH_NOTE } from "../../packages/keel/src/domains/background/abort-bash.js";
import { BashKills } from "../../packages/keel/src/domains/background/bash-kills.js";
import { createBackgroundHandlers } from "../../packages/keel/src/domains/background/handlers.js";

/**
 * `abortBash` 的内核实现：句柄表（`BashKills`）+ 工具层登记（`withBashAbortHandle`）+ 两条回执。
 *
 * 这里不造假体代替 bash：真跑 SDK 的 `bash` 工具（`createGuardedBuiltinTools` 就是生产里挂上去的那一份），
 * 于是「登记 → abort → 进程树真被拉死 → finally 注销」整条链都在测试里跑一遍。
 */

const bashToolOf = (convId: string, cwd: string, kills: BashKills): ToolDefinition =>
	createGuardedBuiltinTools({
		cwd,
		getLang: () => "zh",
		askApproval: async () => ({ decision: "approve" as const }),
		conversationId: () => convId,
		bashKills: kills,
	}).find((tool) => tool.name === "bash") as ToolDefinition;

/** 生产里 pause 到被中止为止的脚本：起来先把 pid 写到 ready 文件，然后一直不退出。 */
const workerScript =
	'require("node:fs").writeFileSync(process.argv[2], JSON.stringify({pid:process.pid})); setInterval(() => {}, 1000);';

/** 与老实现同口径的引号处理（Windows 上就是 `/` 归一 + 单引号包壳）。 */
const quote = (value: string) => "'" + value.replaceAll("\\", "/").replaceAll("'", "'\\''") + "'";

interface Harness {
	kills: BashKills;
	frames: ServerMessage[];
	flushes(): number;
	notes: { conversationId: string; text: string }[];
	handlers: ReturnType<typeof createBackgroundHandlers>;
}

function harness(
	overrides: {
		activeConversationId?: () => string | undefined;
		deliverNote?: (id: string, text: string) => Promise<void>;
	} = {},
): Harness {
	const kills = new BashKills();
	const frames: ServerMessage[] = [];
	let flushes = 0;
	const notes: { conversationId: string; text: string }[] = [];
	const handlers = createBackgroundHandlers({
		bashKills: kills,
		emit: (msg) => frames.push(msg),
		flushSnapshot: () => {
			flushes++;
		},
		activeConversationId: overrides.activeConversationId ?? (() => "A"),
		deliverNote:
			overrides.deliverNote ??
			(async (conversationId, text) => {
				notes.push({ conversationId, text });
			}),
	});
	return { kills, frames, flushes: () => flushes, notes, handlers };
}

const noticesOf = (frames: ServerMessage[]) =>
	frames.flatMap((msg) => (msg.type === "notice" ? [[msg.level, msg.text]] : []));

/** 起一条不会自己结束的 bash，拿到它的真实 pid。 */
async function startWorker(
	tool: ToolDefinition,
	directory: string,
	tag: string,
): Promise<{ pid: number; settled: Promise<unknown> }> {
	const ready = join(directory, `${tag}.json`);
	const command = [process.execPath, `${directory}/worker.cjs`, ready].map(quote).join(" ");
	const running = Promise.resolve(
		tool.execute(
			"call-1",
			{ command, timeout: 30 },
			undefined,
			undefined,
			// SDK 的 bash 用 `ctx.sessionManager` 拼 PI_* 环境变量（生产里由会话注入）。
			{ sessionManager: { getSessionId: () => "bash-abort-test", getSessionFile: () => undefined } } as never,
		) as unknown,
	).then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
	await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 15000 });
	return { pid: JSON.parse(readFileSync(ready, "utf8")).pid as number, settled: running };
}

describe("abortBash · 真中止 / 隔离 / 注销", () => {
	it("只杀目标对话的 bash：进程级可见、另一条对话不受影响，执行结束后句柄从表里注销", async () => {
		const directory = mkdtempSync(join(tmpdir(), "core-abort-bash-"));
		writeFileSync(join(directory, "worker.cjs"), workerScript);
		const pidAlive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		const { kills, handlers, notes, flushes, frames } = harness();
		// 两条对话各一份工具（生产里 `customToolsFor` 就是每对话一份），共用同一张中止表。
		const toolA = bashToolOf("A", directory, kills);
		const toolB = bashToolOf("B", directory, kills);
		let pidA = 0;
		let pidB = 0;
		let settledA: Promise<unknown> | undefined;
		let settledB: Promise<unknown> | undefined;
		try {
			const a = await startWorker(toolA, directory, "a");
			const b = await startWorker(toolB, directory, "b");
			pidA = a.pid;
			pidB = b.pid;
			settledA = a.settled;
			settledB = b.settled;
			expect(kills.running("A")).toBe(1);
			expect(kills.running("B")).toBe(1);

			await expect(handlers.abortBash("A")).resolves.toBeUndefined();

			// 真中止：A 的 shell 进程树被拉死（SDK 在 signal abort 时 killProcessTree）。
			await vi.waitFor(() => expect(pidAlive(pidA)).toBe(false), { timeout: 15000 });
			await settledA;
			// 互不误杀：B 还活着，句柄也还在。
			expect(pidAlive(pidB)).toBe(true);
			expect(kills.running("B")).toBe(1);
			// 注销干净：被中止的那条执行 finally 里已经摘掉了。
			await vi.waitFor(() => expect(kills.running("A")).toBe(0), { timeout: 15000 });

			// 回执与系统说明（老实现逐字）：只有「已停止」那一条 notice，说明只投给目标对话。
			expect(noticesOf(frames)).toEqual([["info", "已停止 bash 命令（对话继续）"]]);
			expect(notes).toHaveLength(1);
			expect(notes[0]).toEqual({ conversationId: "A", text: ABORT_BASH_NOTE });
			expect(flushes()).toBe(1);
		} finally {
			kills.abortAll();
			await Promise.all([settledA, settledB]);
			for (const pid of [pidA, pidB]) {
				if (!pid) continue;
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// 已经死了
				}
			}
			rmSync(directory, { recursive: true, force: true });
		}
	}, 60000);

	it("中止后回两条 info notice 的那一条：说「已停止」而不是「没有在跑」", async () => {
		const kills = new BashKills();
		const frames: ServerMessage[] = [];
		const handlers = createBackgroundHandlers({
			bashKills: kills,
			emit: (msg) => frames.push(msg),
			flushSnapshot: () => {},
			activeConversationId: () => "A",
			deliverNote: async () => {},
		});
		const handle = kills.register("A");
		expect(handle).toBeDefined();
		await handlers.abortBash("A");
		expect(handle?.signal.aborted).toBe(true);
		expect(noticesOf(frames)).toEqual([["info", "已停止 bash 命令（对话继续）"]]);
		// 句柄要在工具那一侧注销：这里手动 release 后表就该空。
		handle?.release();
		expect(kills.running("A")).toBe(0);
	});
});

describe("abortBash · 没有在跑的命令 / 目标解析 / 未接线", () => {
	it("没有在跑的命令：info notice「当前没有正在运行的 bash 命令」+ 刷快照，不抛、不投系统说明", async () => {
		const { handlers, frames, flushes, notes } = harness();
		await expect(handlers.abortBash("A")).resolves.toBeUndefined();
		expect(noticesOf(frames)).toEqual([["info", "当前没有正在运行的 bash 命令"]]);
		expect(flushes()).toBe(1);
		expect(notes).toEqual([]);
	});

	it("不给 conversationId 就打当前活跃对话；给了不存在的 id 就不碰别人的命令", async () => {
		const active: { id: string | undefined } = { id: "A" };
		const { kills, handlers, notes } = harness({ activeConversationId: () => active.id });
		const handle = kills.register("A");
		await handlers.abortBash();
		expect(handle?.signal.aborted).toBe(true);
		expect(notes).toEqual([{ conversationId: "A", text: ABORT_BASH_NOTE }]);

		// 换了活跃对话之后，另一个 id 不会误伤 B 的命令。
		const other = kills.register("B");
		await handlers.abortBash("missing");
		expect(other?.signal.aborted).toBe(false);
		expect(notes).toHaveLength(1);
	});

	it("投递系统说明失败不打断停止流程（老实现唯一被吞掉的那一段）", async () => {
		const { kills, handlers, frames, flushes } = harness({
			deliverNote: async () => {
				throw new Error("conversation retired");
			},
		});
		const handle = kills.register("A");
		await expect(handlers.abortBash("A")).resolves.toBeUndefined();
		expect(handle?.signal.aborted).toBe(true);
		expect(noticesOf(frames)).toEqual([["info", "已停止 bash 命令（对话继续）"]]);
		expect(flushes()).toBe(1);
	});

	it("中止表没接时同步抛 CoreEngineNotReadyError（不是 rejected promise，也不假装没在跑）", () => {
		const handlers = createBackgroundHandlers({});
		expect(() => handlers.abortBash("A")).toThrow(CoreEngineNotReadyError);
	});
});

describe("BashKills · 表本身的洁癖", () => {
	it("没有对话身份就不登记；登记 / 注销成对，release 可重复调", () => {
		const kills = new BashKills();
		expect(kills.register(undefined)).toBeUndefined();
		expect(kills.register("  ")).toBeUndefined();
		const handle = kills.register("A");
		expect(kills.running("A")).toBe(1);
		handle?.release();
		handle?.release();
		expect(kills.running("A")).toBe(0);
		expect(kills.abort("A")).toBe(0);
	});

	it("同一条对话多条命令一起中止，abortAll 连所有对话一起收口", () => {
		const kills = new BashKills();
		const a1 = kills.register("A");
		const a2 = kills.register("A");
		const b1 = kills.register("B");
		expect(kills.abort("A")).toBe(2);
		expect([a1?.signal.aborted, a2?.signal.aborted]).toEqual([true, true]);
		expect(b1?.signal.aborted).toBe(false);
		// `abort()` 只拉 signal，摘表归各句柄的 `release()`：这里 A1/A2/B1 三条都还没注销。
		expect(kills.abortAll()).toBe(3);
		expect(b1?.signal.aborted).toBe(true);
		expect(kills.running("B")).toBe(0);
	});
});
