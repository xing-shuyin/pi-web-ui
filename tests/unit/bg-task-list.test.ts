import { describe, expect, it } from "vitest";
import { countBgRunning, parseBgTaskList } from "../../web/src/bg-task-list.js";

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
});
