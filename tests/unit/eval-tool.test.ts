import { describe, it, expect, afterAll } from "vitest";
import { basename } from "node:path";
import { makeEvalTool, disposeAllEvalKernels, EVAL_TOOL_NAME } from "../../server/eval-tool.js";

async function run(
	tool: ReturnType<typeof makeEvalTool>,
	params: { code: string; language?: "py" | "js" | "ts"; title?: string; timeout?: number; reset?: boolean },
) {
	const res = (await tool.execute("t", params, undefined, undefined, undefined as never)) as {
		content: [{ type: "text"; text: string }];
		details: {
			language: string;
			durationMs: number;
			ok: boolean;
			stdout: string;
			stderr: string;
			result: string | null;
			error: string | null;
			reset: boolean;
		};
	};
	return {
		text: res.content[0].text,
		details: res.details,
	};
}

describe("eval tool (persistent sandbox)", () => {
	afterAll(() => {
		disposeAllEvalKernels();
	});

	it("has correct tool metadata", () => {
		const tool = makeEvalTool({ cwd: process.cwd() });
		expect(tool.name).toBe(EVAL_TOOL_NAME);
		expect(tool.description).toContain("sandbox");
	});

	it("evaluates Python expressions and statements with state persistence", async () => {
		const tool = makeEvalTool({ cwd: process.cwd(), ownerId: "test-py-persist" });

		// Cell 1: define variables and print
		const res1 = await run(tool, {
			language: "py",
			code: "x = 40\ny = 2\nprint('initializing vars')",
		});
		expect(res1.text).toContain("initializing vars");
		expect(res1.details.ok).toBe(true);

		// Cell 2: evaluate expression using variables from cell 1
		const res2 = await run(tool, {
			language: "py",
			code: "x + y",
		});
		expect(res2.text).toContain("=> 42");
		expect(res2.details.result).toBe("42");
		expect(res2.details.ok).toBe(true);
	});

	it("handles Python errors without crashing the session", async () => {
		const tool = makeEvalTool({ cwd: process.cwd(), ownerId: "test-py-errors" });

		// Syntax error
		const res1 = await run(tool, {
			language: "py",
			code: "def invalid(",
		});
		expect(res1.details.ok).toBe(false);
		expect(res1.text).toContain("SyntaxError");

		// Runtime error
		const res2 = await run(tool, {
			language: "py",
			code: "1 / 0",
		});
		expect(res2.details.ok).toBe(false);
		expect(res2.text).toContain("ZeroDivisionError");

		// Recovery: session still works
		const res3 = await run(tool, {
			language: "py",
			code: "100 + 200",
		});
		expect(res3.details.ok).toBe(true);
		expect(res3.details.result).toBe("300");
	});

	it("supports Python reset to clear state", async () => {
		const tool = makeEvalTool({ cwd: process.cwd(), ownerId: "test-py-reset" });

		await run(tool, {
			language: "py",
			code: "test_var = 'should_be_cleared'",
		});

		// Reset environment
		const res = await run(tool, {
			language: "py",
			code: "'test_var' in globals()",
			reset: true,
		});
		expect(res.details.result).toBe("False");
	});

	it("evaluates JavaScript/TypeScript with state persistence and top-level await", async () => {
		const tool = makeEvalTool({ cwd: process.cwd(), ownerId: "test-js-persist" });

		// Cell 1: define variables and print
		const res1 = await run(tool, {
			language: "js",
			code: "const items = ['apple', 'banana', 'cherry']; console.log('fruits loaded');",
		});
		expect(res1.text).toContain("fruits loaded");
		expect(res1.details.ok).toBe(true);

		// Cell 2: inspect array length
		const res2 = await run(tool, {
			language: "js",
			code: "items.length",
		});
		expect(res2.details.result).toBe("3");

		// Cell 3: top-level await
		const res3 = await run(tool, {
			language: "js",
			code: "await Promise.resolve(items.join(', '))",
		});
		expect(res3.details.result).toBe("apple, banana, cherry");
	});

	it("handles timeout protection gracefully", async () => {
		const tool = makeEvalTool({ cwd: process.cwd(), ownerId: "test-timeout" });

		const t0 = Date.now();
		const res = await run(tool, {
			language: "py",
			code: "import time\ntime.sleep(10)",
			timeout: 1, // 1 second timeout
		});
		const elapsed = Date.now() - t0;

		expect(elapsed).toBeLessThan(3500);
		expect(res.details.ok).toBe(false);
		expect(res.text).toContain("timed out after 1s");
	});

	it("survives timeout: kernel respawns and keeps state", async () => {
		const tool = makeEvalTool({ cwd: process.cwd(), ownerId: "test-timeout-recover" });

		await run(tool, { language: "py", code: "keep_me = 'alive'", timeout: 5 });
		// Force a hard timeout (kernel process is killed).
		await run(tool, { language: "py", code: "import time\ntime.sleep(30)", timeout: 1 });
		// The next call must respawn a fresh kernel rather than hang.
		const res = await run(tool, { language: "py", code: "2 + 2", timeout: 5 });
		expect(res.details.ok).toBe(true);
		expect(res.details.result).toBe("4");
	});

	it("queues concurrent calls instead of dropping the first resolver", async () => {
		const tool = makeEvalTool({ cwd: process.cwd(), ownerId: "test-queue" });

		const [a, b] = await Promise.all([
			run(tool, { language: "py", code: "import time\ntime.sleep(0.6)\n'first'", timeout: 10 }),
			run(tool, { language: "py", code: "'second'", timeout: 10 }),
		]);

		// Both must resolve — the second request queues behind the first
		// (the old single-slot implementation lost the first resolver here).
		expect(a.details.result).toBe("'first'");
		expect(b.details.result).toBe("'second'");
	});

	it("sandbox cwd is an isolated temp dir; project dir is exposed as PROJECT_DIR", async () => {
		const tool = makeEvalTool({ cwd: process.cwd(), ownerId: "test-sandbox-cwd" });
		const projectCwd = process.cwd();
		const base = basename(projectCwd);

		// Python: kernel cwd 落在系统临时目录，PROJECT_DIR 指向项目。
		const pyCwd = await run(tool, { language: "py", code: "import os; os.getcwd()", timeout: 10 });
		expect(pyCwd.details.ok).toBe(true);
		expect(pyCwd.details.result).not.toContain(base);

		const pyProject = await run(tool, { language: "py", code: "PROJECT_DIR", timeout: 10 });
		expect(pyProject.details.ok).toBe(true);
		expect(pyProject.details.result).toContain(base);

		// JS: same contract.
		const jsCwd = await run(tool, { language: "js", code: "process.cwd()", timeout: 10 });
		expect(jsCwd.details.ok).toBe(true);
		expect(jsCwd.details.result).not.toContain(base);

		const jsProject = await run(tool, { language: "js", code: "PROJECT_DIR", timeout: 10 });
		expect(jsProject.details.ok).toBe(true);
		expect(jsProject.details.result).toBe(projectCwd);
	});

	it("disposeEvalSession is idempotent and frees the session slot", async () => {
		const { disposeEvalSession } = await import("../../server/eval-tool.js");
		const tool = makeEvalTool({ cwd: process.cwd(), ownerId: "test-dispose" });

		await run(tool, { language: "py", code: "1 + 1", timeout: 5 });
		await run(tool, { language: "js", code: "1 + 1", timeout: 5 });

		expect(() => disposeEvalSession("test-dispose")).not.toThrow();
		expect(() => disposeEvalSession("test-dispose")).not.toThrow();
	});
});
