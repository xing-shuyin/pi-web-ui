import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CanvasOrchestrator } from "../../server/canvas/canvas-orchestrator.js";
import { createDefaultCanvasGraph, loadCanvasGraph, saveCanvasGraph } from "../../server/canvas/canvas-store.js";
import { CanvasExecutionQueue, canvasReadiness, validateCanvasTopology } from "../../server/canvas/canvas-scheduler.js";
import type { CanvasEdge, CanvasGraph, CanvasNode, CanvasNodeRole } from "../../server/protocol.js";

const node = (id: string, role: CanvasNodeRole = "end"): CanvasNode => ({
	id,
	title: id,
	role,
	x: 0,
	y: 0,
	width: 300,
	cwd: ".",
	engine: "pi",
	model: "test/model",
	useWorktree: false,
	status: "idle",
});
const edge = (source: string, target: string, type: CanvasEdge["type"] = "handoff"): CanvasEdge => ({
	id: source + "-" + target,
	sourceNodeId: source,
	targetNodeId: target,
	type,
});

describe("Canvas queue capacity", () => {
	it("reserves released slots for FIFO waiters before new callers can acquire", async () => {
		const queue = new CanvasExecutionQueue(1),
			signal = new AbortController().signal;
		const first = await queue.acquire(signal),
			order: string[] = [];
		const second = queue.acquire(signal).then((release) => {
			order.push("second");
			return release;
		});
		first();
		const third = queue.acquire(signal).then((release) => {
			order.push("third");
			return release;
		});
		const releaseSecond = await second;
		expect(order).toEqual(["second"]);
		releaseSecond();
		(await third)();
		expect(order).toEqual(["second", "third"]);
	});
	it("removes aborted waiters and returns a reserved slot if cancellation races with wakeup", async () => {
		const queue = new CanvasExecutionQueue(1),
			first = await queue.acquire(new AbortController().signal);
		const cancelled = new AbortController();
		const pending = queue.acquire(cancelled.signal);
		cancelled.abort();
		await expect(pending).rejects.toBeDefined();
		const racing = new AbortController();
		const reserved = queue.acquire(racing.signal);
		first();
		racing.abort();
		await expect(reserved).rejects.toBeDefined();
		(await queue.acquire(new AbortController().signal))();
	});
});

describe("Canvas scheduler run semantics", () => {
	let dir: string, orch: CanvasOrchestrator;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "canvas-scheduler-"));
		orch = new CanvasOrchestrator(dir, dir);
	});
	afterEach(() => {
		vi.restoreAllMocks();
		rmSync(dir, { recursive: true, force: true });
	});
	const graph = (nodes: CanvasNode[], edges: CanvasEdge[]): CanvasGraph => ({
		...createDefaultCanvasGraph("scheduler"),
		nodes,
		edges,
		executionMode: "real",
	});
	const admit = (g: CanvasGraph) => {
		saveCanvasGraph(dir, g);
		return g;
	};

	it("resolves an unselected branch before convergence and executes the join exactly once", async () => {
		const trigger = node("start", "trigger");
		trigger.config = { payload: "pass" };
		const condition = node("condition", "condition");
		condition.config = { condition: "pass" };
		const g = admit(
			graph(
				[trigger, condition, node("yes"), node("no"), node("join", "merge")],
				[
					edge("start", "condition"),
					edge("condition", "yes", "condition_true"),
					edge("condition", "no", "condition_false"),
					edge("yes", "join"),
					edge("no", "join"),
				],
			),
		);
		const states: CanvasGraph[] = [];
		orch.setBroadcaster((message) => {
			if (message.type === "canvas_graph_state") states.push(message.graph);
		});
		await orch.runAll(g);
		expect(states.at(-1)?.status).toBe("completed");
		expect(states.at(-1)?.nodes.find((n) => n.id === "no")?.status).toBe("skipped");
		expect(g.nodes.map((n) => n.status)).toEqual(["done", "done", "done", "skipped", "done"]);
		expect(g.nodes[4].attempt).toBe(1);
		expect(g.status).toBe("completed");
		expect(g.edges.find((e) => e.sourceNodeId === "no")?.active).toBe(false);
		const firstRun = g.run!.id;
		await orch.runAll(g);
		expect(g.run!.id).not.toBe(firstRun);
		expect(g.nodes[4].attempt).toBe(1);
	});

	it("broadcasts settled runtime from the latest persisted topology", async () => {
		const g = admit(graph([node("start", "trigger"), node("end")], [edge("start", "end")]));
		const states: CanvasGraph[] = [];
		let edited = false;
		orch.setBroadcaster((message) => {
			if (message.type === "canvas_node_event" && message.event === "started" && !edited) {
				edited = true;
				const latest = loadCanvasGraph(dir, g.id);
				latest.name = "Edited during execution";
				saveCanvasGraph(dir, latest);
			}
			if (message.type === "canvas_graph_state") states.push(message.graph);
		});
		await orch.runAll(g);
		expect(states.at(-1)?.status).toBe("completed");
		expect(states.at(-1)?.name).toBe("Edited during execution");
		expect(states.at(-1)?.nodes.every((n) => n.status === "done")).toBe(true);
	});

	it("preserves isolated code through rejection after resetting coder, QA and human artifacts", async () => {
		const repo = join(dir, "repo");
		mkdirSync(repo);
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", windowsHide: true });
		git("init");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Canvas Test");
		writeFileSync(join(repo, "baseline.txt"), "baseline");
		git("add", ".");
		git("commit", "-m", "baseline");
		const local = new CanvasOrchestrator(repo, join(dir, "data"));
		const g = graph(
			[{ ...node("work", "coder"), useWorktree: true }, node("qa"), node("human", "human")],
			[edge("work", "qa"), edge("qa", "human"), edge("human", "work", "reject")],
		);
		saveCanvasGraph(join(dir, "data"), g);
		const observed: string[] = [];
		vi.spyOn(local as any, "executeRealEngineNode").mockImplementation(async (...args: unknown[]) => {
			const cwd = args[2] as string;
			if (observed.length) expect(readFileSync(join(cwd, "implementation.txt"), "utf8")).toBe("first implementation");
			else writeFileSync(join(cwd, "implementation.txt"), "first implementation");
			observed.push(cwd);
			return "Implemented";
		});
		await local.runAll(g);
		expect(g.status).toBe("waiting_approval");
		expect(g.nodes.every((n) => n.artifact?.workspace)).toBe(true);
		local.reviewNode(g.id, "human", "reject", "Keep implementation; add tests");
		await vi.waitFor(
			() => {
				expect(g.nodes[2].status).toBe("waiting_approval");
				expect(g.nodes[2].artifact?.workspace).toBeDefined();
			},
			// 内部等待预算写 15s 太紧：满载时这步排队能被拖到 >50s（12 worker 实测），与外面 90s 的用例预算不匹配。
			{ timeout: 30_000 },
		);
		expect(observed).toHaveLength(2);
		expect(g.nodes[0].attempt).toBe(2);
		expect(readFileSync(join(g.nodes[2].artifact!.cwd!, "implementation.txt"), "utf8")).toBe("first implementation");
		local.stopAll(g.id);
		// 这条在队列/审批上真等实时时钟：单跑 17s，4 worker 满载实测 30s+ 撞墙。
	}, 90_000);

	it("an explicit false AI verdict requests rework while an ordinary completion does not", async () => {
		const g = admit(
			graph(
				[node("work", "coder"), node("judge", "ai_judge")],
				[edge("work", "judge"), { ...edge("judge", "work", "reject"), maxLoopRetries: 1 }],
			),
		);
		let calls = 0;
		vi.spyOn(orch as any, "executeRealEngineNode").mockImplementation(async (...args: unknown[]) => {
			const current = args[1] as CanvasNode;
			calls++;
			return current.role === "ai_judge" ? "结论：不通过" : "implementation";
		});
		await orch.runAll(g);
		expect(calls).toBe(4);
		expect(g.nodes[0].attempt).toBe(2);
		expect(g.edges[1].currentLoopCount).toBe(1);
		expect(g.status).toBe("waiting_approval");
		orch.stopAll(g.id);
	});

	it("serializes a shared absolute cwd across different run bases", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let entered = 0;
		const secondDir = join(dir, "other");
		mkdirSync(secondDir);
		const other = new CanvasOrchestrator(secondDir, secondDir);
		const g = admit(graph([{ ...node("one", "coder"), cwd: dir }], []));
		const h = { ...graph([{ ...node("two", "coder"), cwd: dir }], []), id: "other" };
		saveCanvasGraph(secondDir, h);
		const execute = async () => {
			entered++;
			if (entered === 1) await gate;
			return "done";
		};
		vi.spyOn(orch as any, "executeRealEngineNode").mockImplementation(execute);
		vi.spyOn(other as any, "executeRealEngineNode").mockImplementation(execute);
		const first = orch.runAll(g);
		await vi.waitFor(() => expect(entered).toBe(1));
		const second = other.runAll(h);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(entered).toBe(1);
		release();
		await Promise.all([first, second]);
		expect(entered).toBe(2);
	});

	it("waits for every selected parent before joining", async () => {
		const g = graph([node("a"), node("b"), node("join")], [{ ...edge("a", "join"), active: true }, edge("b", "join")]);
		expect(canvasReadiness(g, g.nodes[2])).toBe("wait");
		g.edges[1].active = false;
		expect(canvasReadiness(g, g.nodes[2])).toBe("ready");
	});

	it("ignores feedback in roots and joins and only reworks after human rejection, carrying comments", async () => {
		const g = admit(
			graph(
				[node("work", "trigger"), node("review", "human"), node("delivery")],
				[edge("work", "review"), edge("review", "work", "reject"), edge("review", "delivery", "approve")],
			),
		);
		await orch.runAll(g);
		expect(g.status).toBe("waiting_approval");
		expect(g.nodes[0].attempt).toBe(1);
		await expect(orch.runAll(g)).rejects.toThrow("already running");
		expect(orch.reviewNode(g.id, "review", "reject", "Add missing regression tests")).not.toBeNull();
		await vi.waitFor(() => expect(g.nodes[1].status).toBe("waiting_approval"));
		expect(g.nodes[0].attempt).toBe(2);
		expect(g.nodes[0].lastOutputSummary).toContain("Add missing regression tests");
		orch.reviewNode(g.id, "review", "approve", "verified");
		await vi.waitFor(() => expect(g.status).toBe("completed"));
		expect(g.nodes[2].status).toBe("done");
		expect(g.edges[1].currentLoopCount).toBe(1);
	});

	it("reports unsupported executors and blocks downstream without invoking an engine", async () => {
		for (const role of ["cron", "webhook", "memory", "loop"] as const) {
			const g = admit(graph([node("unsupported", role), node("after")], [edge("unsupported", "after")]));
			await orch.runAll(g);
			expect(g.nodes[0].error).toContain("Unsupported canvas executor");
			expect(g.status).toBe("error");
			expect(g.nodes[1].status).toBe("idle");
		}
	});

	it("rejects forward cycles without choosing an arbitrary starting node", async () => {
		const g = admit(graph([node("a"), node("b")], [edge("a", "b"), edge("b", "a")]));
		expect(() => validateCanvasTopology(g)).toThrow("forward cycle");
		await expect(orch.runAll(g)).rejects.toThrow("forward cycle");
		expect(g.nodes.every((n) => n.status === "idle")).toBe(true);
	});

	it("does not silently substitute a missing engine or an unavailable model", async () => {
		const getter = vi.fn(() => undefined);
		const local = new CanvasOrchestrator(dir, dir, getter);
		const g = admit(graph([{ ...node("task", "coder"), engine: "claude" }], []));
		await local.runAll(g);
		expect(g.status).toBe("error");
		expect(getter).toHaveBeenCalledExactlyOnceWith("claude");
		const fallback = vi.fn();
		const session = {
			cwd: dir,
			switchModelOrThrow: async () => {
				throw new Error("model unavailable");
			},
			switchModel: fallback,
			abort: async () => {},
		};
		const real = new CanvasOrchestrator(dir, dir, () => ({ attach: async () => session, detach: () => {} }));
		await real.runAll(g);
		expect(g.nodes[0].error).toContain("model unavailable");
		expect(fallback).not.toHaveBeenCalled();
	});

	it("rejects concurrent runs and cancellation prevents late execution from publishing or scheduling", async () => {
		let release!: () => void;
		const attached = new Promise<void>((resolve) => {
			release = resolve;
		});
		const session = {
			cwd: dir,
			switchModelOrThrow: async () => {},
			prompt: async () => {},
			abort: vi.fn(async () => {}),
		};
		const real = new CanvasOrchestrator(dir, dir, () => ({
			attach: async () => {
				await attached;
				return session;
			},
			detach: () => {},
		}));
		const g = admit(graph([node("task", "coder"), node("after")], [edge("task", "after")]));
		const pending = real.runAll(g);
		await expect(real.runAll(g)).rejects.toThrow("already running");
		await expect(real.runNode(g, "task")).rejects.toThrow("already running");
		real.stopAll(g.id);
		release();
		await pending;
		expect(g.status).toBe("paused");
		expect(g.nodes.map((n) => n.status)).toEqual(["cancelled", "cancelled"]);
		expect(g.nodes[1].attempt).toBe(0);
	});

	it("expires an approval-paused run at the graph deadline", async () => {
		const g = admit(graph([node("human", "human")], []));
		vi.useFakeTimers();
		try {
			await orch.runAll(g);
			expect(g.status).toBe("waiting_approval");
			await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
			expect(g.status).toBe("error");
			expect(g.run?.error).toContain("deadline");
			expect(g.nodes[0].status).toBe("cancelled");
		} finally {
			vi.useRealTimers();
		}
	});

	it("settles a direct run against reachable nodes and resets stale descendant output", async () => {
		const g = admit(
			graph(
				[node("start", "trigger"), node("join", "merge"), node("unrelated")],
				[edge("start", "join"), edge("unrelated", "join")],
			),
		);
		g.nodes[1].status = "done";
		g.nodes[1].lastOutputSummary = "stale";
		await orch.runNode(g, "start", "fresh");
		expect(g.status).toBe("completed");
		expect(g.nodes[2].status).toBe("idle");
		expect(g.nodes[1].lastOutputSummary).toContain("fresh");
		expect(g.nodes[1].lastOutputSummary).not.toContain("stale");
		expect(g.nodes[0].artifact?.cwd).toBe(dir);
		const created = g.nodes[0].artifact!.createdAt;
		expect(g.nodes[0].artifact!.createdAt).toBe(created);
		await orch.runNode(g, "start", "second");
		expect(g.nodes[1].lastOutputSummary).toContain("second");
		expect(g.nodes[1].lastOutputSummary).not.toContain("fresh");
	});

	it("passes the entire handoff text and persists the text artifact", async () => {
		const start = node("start", "trigger");
		const payload = "BEGIN-CONTRACT\n" + "important details ".repeat(1000) + "END-CONTRACT";
		start.config = { payload };
		const g = admit(graph([start, node("after")], [edge("start", "after")]));
		await orch.runAll(g);
		expect(g.nodes[0].artifact?.text).toContain(payload);
		expect(g.nodes[1].artifact?.text).toContain(payload);
		expect(g.edges[0].lastHandoffSummary).toContain(payload);
	});
});
