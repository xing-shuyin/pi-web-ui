import { describe, expect, it } from "vitest";
import { countBgRunning, parseBgTaskList, parseBgTaskSnapshot } from "../../web/src/bg-task-list.js";
import { resolveToolHeadline } from "../../web/src/tool-args.js";

const SAMPLE = [
	"▶ a1b2c3 running 12s — build web",
	"    output: /home/u/proj/.pi/tasks/s1-a1b2c3.output",
	"✓ d4e5f6 completed 1m5s exit=0 — run tests",
	"    output: /home/u/proj/.pi/tasks/s1-d4e5f6.output",
	"✗ g7h8i9 failed 3s exit=1 — bad cmd error=boom",
	"    output: /home/u/proj/.pi/tasks/s1-g7h8i9.output",
	"■ j0k1l2 killed 20s — stopped job",
	"    output: /home/u/proj/.pi/tasks/s1-j0k1l2.output",
].join("\n");

describe("parseBgTaskList", () => {
	it("parses 4 statuses with ids, names, outputs", () => {
		const items = parseBgTaskList(SAMPLE);
		expect(items.map((t) => t.status)).toEqual(["running", "completed", "failed", "killed"]);
		expect(items[0].id).toBe("a1b2c3");
		expect(items[0].name).toBe("build web");
		expect(items[0].outputPath).toContain("a1b2c3.output");
		expect(items[1].exitCode).toBe(0);
		expect(items[2].exitCode).toBe(1);
		expect(countBgRunning(items)).toBe(1);
	});

	it("empty message → []", () => {
		expect(parseBgTaskList("No background tasks in this Pi extension runtime.")).toEqual([]);
	});

	it("log content → [] (no cluster, raw pre stays)", () => {
		expect(parseBgTaskList("line one\nline two\noutput snippet")).toEqual([]);
	});

	it("strips ANSI", () => {
		const items = parseBgTaskList("\x1b[32m✓\x1b[0m abc running 5s — x\n    output: /tmp/o");
		expect(items.length).toBe(1);
		expect(items[0].status).toBe("running");
	});

	it("dirty input never throws", () => {
		for (const v of ["", "▶", "▶ broken", "[[\ntodo:x", "\x00\x1b[", "output:"]) {
			expect(() => parseBgTaskList(v)).not.toThrow();
		}
	});

	it("parses -- and - separators without leading dash", () => {
		const text = ["a1 running 5s -- vite --port 5173", "b2 completed 9s - run unit tests"].join("\n");
		const items = parseBgTaskList(text);
		expect(items.map((t) => t.name)).toEqual(["vite --port 5173", "run unit tests"]);
	});

	it("parses status aliases (done/error/stopped) without leading icons", () => {
		const text = ["t1 done 2s — ok", "t2 error 4s exit=2 — crash error=oom", "t3 stopped 8s — aborted"].join("\n");
		const items = parseBgTaskList(text);
		expect(items.map((t) => t.status)).toEqual(["completed", "failed", "killed"]);
		expect(items[1].exitCode).toBe(2);
	});

	it("does not treat age/exitCode as name when separator is missing", () => {
		const text = "t1 completed 12s exit=0\n    output: /tmp/t1.out";
		const items = parseBgTaskList(text);
		expect(items.length).toBe(1);
		expect(items[0].age).toBe("12s");
		expect(items[0].name).toBe("");
		expect(items[0].outputPath).toBe("/tmp/t1.out");
	});

	it("caps displayed items at 50 while preserving total and runningCount", () => {
		const lines = Array.from(
			{ length: 65 },
			(_, i) => `t${i} ${i < 10 ? "running" : "completed"} ${i}s — task-${i}`,
		).join("\n");
		const snap = parseBgTaskSnapshot(lines);
		expect(snap.items.length).toBe(50);
		expect(snap.total).toBe(65);
		expect(snap.runningCount).toBe(10);
		expect(snap.truncated).toBe(true);
	});
});

describe("resolveToolHeadline for bg_*", () => {
	it("shows name or falls back to command for bg_run", () => {
		expect(
			resolveToolHeadline({ name: "bg_run", argumentsText: '{"name":"build","command":"npm run build"}' })?.text,
		).toBe("build");
		expect(resolveToolHeadline({ name: "bg_run", argumentsText: '{"command":"npm test"}' })?.text).toBe("npm test");
	});

	it("shows taskId or falls back to name for bg_status/logs/result/kill", () => {
		for (const name of ["bg_status", "bg_logs", "bg_result", "bg_kill"]) {
			expect(resolveToolHeadline({ name, argumentsText: '{"taskId":"abc123"}' })?.text).toBe("abc123");
			expect(resolveToolHeadline({ name, argumentsText: '{"name":"worker"}' })?.text).toBe("worker");
		}
		expect(resolveToolHeadline({ name: "bg_status", argumentsText: "not-json" })).toBeNull();
	});
});
