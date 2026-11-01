import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	computeFileHash,
	formatNumberedLines,
	resolveBlockSpan,
	applyHashlinePatch,
	HashlineSnapshotStore,
} from "../../server/hashline-engine.js";
import { makePatchTool, PATCH_TOOL_NAME } from "../../server/patch-tool.js";

describe("Hashline Patch Engine & Tool", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "patch-tool-test-"));
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	it("computes deterministic 4-hex content hash", () => {
		const text1 = "const a = 1;\nconsole.log(a);\n";
		const text2 = "const a = 1;\r\nconsole.log(a);   \r\n";
		const hash1 = computeFileHash(text1);
		const hash2 = computeFileHash(text2);
		expect(hash1).toHaveLength(4);
		expect(hash1).toBe(hash2);
	});

	it("resolves block span by matching braces in C-like languages", () => {
		const lines = [
			"function test() {",
			"  const x = 10;",
			"  if (x > 5) {",
			"    console.log('nested');",
			"  }",
			"  return x;",
			"}",
			"const other = true;",
		];
		const span = resolveBlockSpan(lines, 1, "test.ts");
		expect(span.start).toBe(1);
		expect(span.end).toBe(7);
	});

	it("resolves block span by indentation in Python", () => {
		const lines = [
			"def compute(n):",
			"    total = 0",
			"    for i in range(n):",
			"        total += i",
			"    return total",
			"",
			"print('done')",
		];
		const span = resolveBlockSpan(lines, 1, "test.py");
		expect(span.start).toBe(1);
		expect(span.end).toBe(5);
	});

	it("applies PUT N.=M: line range replacement", () => {
		const initial = "line 1\nline 2\nline 3\nline 4\n";
		const filePath = "hello.txt";
		writeFileSync(join(tempDir, filePath), initial);
		const hash = computeFileHash(initial);

		const patch = `
[${filePath}#${hash}]
PUT 2.=3:
+line two (replaced)
+line three (replaced)
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);
		expect(res.results[0].op).toBe("updated");

		const updated = readFileSync(join(tempDir, filePath), "utf8");
		expect(updated).toBe("line 1\nline two (replaced)\nline three (replaced)\nline 4\n");
	});

	it("applies PUT N*: syntactic block replacement", () => {
		const initial = [
			"function greet() {",
			"  const msg = 'hello';",
			"  return msg;",
			"}",
			"console.log('after');",
		].join("\n");
		const filePath = "greet.ts";
		writeFileSync(join(tempDir, filePath), initial);
		const hash = computeFileHash(initial);

		const patch = `
[${filePath}#${hash}]
PUT 1*:
+function greet() {
+  return 'fast hello';
+}
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);

		const updated = readFileSync(join(tempDir, filePath), "utf8");
		expect(updated).toContain("fast hello");
		expect(updated).toContain("console.log('after');");
	});

	it("applies PUT <N: and PUT >N: gap insertions", () => {
		const initial = "line 1\nline 2\n";
		const filePath = "gap.txt";
		writeFileSync(join(tempDir, filePath), initial);
		const hash = computeFileHash(initial);

		const patch = `
[${filePath}#${hash}]
PUT <1:
+header line
PUT >2:
+footer line
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);

		const updated = readFileSync(join(tempDir, filePath), "utf8");
		expect(updated).toBe("header line\nline 1\nline 2\nfooter line\n");
	});

	it("supports CUT and register paste (PUT @reg)", () => {
		const initial = "line 1\nMOVE_ME_1\nMOVE_ME_2\nline 4\n";
		const filePath = "cut.txt";
		writeFileSync(join(tempDir, filePath), initial);
		const hash = computeFileHash(initial);

		const patch = `
[${filePath}#${hash}]
CUT 2.=3 @block
PUT >4 @block
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);

		const updated = readFileSync(join(tempDir, filePath), "utf8");
		expect(updated).toBe("line 1\nline 4\nMOVE_ME_1\nMOVE_ME_2\n");
	});

	it("supports file removal (REM) and file renaming (MV)", () => {
		const f1 = "to_delete.txt";
		const f2 = "to_move.txt";
		writeFileSync(join(tempDir, f1), "delete me");
		writeFileSync(join(tempDir, f2), "move me");

		const patch = `
[${f1}#${computeFileHash("delete me")}]
REM
[${f2}#${computeFileHash("move me")}]
PUT 1.=1:
+moved and edited
MV renamed.txt
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);
		expect(existsSync(join(tempDir, f1))).toBe(false);
		expect(existsSync(join(tempDir, f2))).toBe(false);
		expect(readFileSync(join(tempDir, "renamed.txt"), "utf8")).toBe("moved and edited");
	});

	it("recovers automatically via 3-way merge when anchor lines did not change", () => {
		const store = new HashlineSnapshotStore();
		const base = "header\nline A\nline B\nfooter\n";
		const filePath = "diverged.txt";
		const baseHash = store.record(filePath, base);

		// 模拟外部并发修改了 header 行（在行号 1 处插入了一行），导致当前文本与 base 不一致
		const currentOnDisk = "NEW_TOP_HEADER\nheader\nline A\nline B\nfooter\n";
		writeFileSync(join(tempDir, filePath), currentOnDisk);

		// 补丁是基于 baseHash 编写的，修改 line A/line B（原行 2~3）
		const patch = `
[${filePath}#${baseHash}]
PUT 2.=3:
+line A (updated)
+line B (updated)
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir, snapshotStore: store });
		expect(res.ok).toBe(true);
		expect(res.results[0].recovered).toBe(true);

		const updated = readFileSync(join(tempDir, filePath), "utf8");
		expect(updated).toContain("NEW_TOP_HEADER");
		expect(updated).toContain("line A (updated)");
	});

	it("fails safely and provides guidance when file hash mismatches without snapshot", () => {
		const filePath = "unknown.txt";
		writeFileSync(join(tempDir, filePath), "live content\n");
		const patch = `
[${filePath}#9999]
PUT 1.=1:
+hacked
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("文件内容与锚点不一致");
	});

	it("makePatchTool integrates properly as an Agent tool", async () => {
		const tool = makePatchTool({ cwd: tempDir, ownerId: "test-agent" });
		expect(tool.name).toBe(PATCH_TOOL_NAME);

		const initial = "const x = 1;\n";
		writeFileSync(join(tempDir, "agent.js"), initial);
		const hash = computeFileHash(initial);

		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;
		const execRes = await exec("call-1", {
			patch: `[agent.js#${hash}]\nPUT 1.=1:\n+const x = 42;\n`,
		});

		expect(execRes.details.ok).toBe(true);
		expect(execRes.content[0].text).toContain("修改 agent.js");
		expect(readFileSync(join(tempDir, "agent.js"), "utf8")).toBe("const x = 42;\n");
	});

	it("preserves CRLF line endings when present in original file", () => {
		const filePath = "crlf.txt";
		const crlfText = "line1\r\nline2\r\nline3\r\n";
		writeFileSync(join(tempDir, filePath), crlfText);
		const hash = computeFileHash(crlfText);

		const patch = `
[${filePath}#${hash}]
PUT 2.=2:
+modified line 2
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);
		const written = readFileSync(join(tempDir, filePath), "utf8");
		expect(written).toBe("line1\r\nmodified line 2\r\nline3\r\n");
	});

	it("rejects overlapping hunks in the same file", () => {
		const filePath = "overlap.txt";
		const text = "1\n2\n3\n4\n5\n";
		writeFileSync(join(tempDir, filePath), text);
		const hash = computeFileHash(text);

		const patch = `
[${filePath}#${hash}]
PUT 1.=3:
+new 1-3
PUT 2.=4:
+new 2-4
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("重叠");
	});

	it("rejects out-of-bounds line numbers", () => {
		const filePath = "bounds.txt";
		const text = "alpha\nbeta\n";
		writeFileSync(join(tempDir, filePath), text);
		const hash = computeFileHash(text);

		const patch = `
[${filePath}#${hash}]
PUT 10.=10:
+out of bounds
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("行号越界");
	});

	it("rejects path traversal outside workspace", () => {
		const patch = `
[../outside.txt]
PUT 1.=1:
+bad
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("路径越界");
	});

	it("rejects move_file target attempting traversal outside workspace", () => {
		const filePath = "move_victim.txt";
		writeFileSync(join(tempDir, filePath), "content\n");
		const hash = computeFileHash("content\n");

		const patch = `
[${filePath}#${hash}]
MV ../outside_dest.txt
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(false);
		expect(res.summary).toContain("路径越界");
		expect(existsSync(join(tempDir, filePath))).toBe(true);
	});

	it("applies multiple sections to the same file sequentially", () => {
		const filePath = "multi.txt";
		const text = "line1\nline2\nline3\nline4\n";
		writeFileSync(join(tempDir, filePath), text);
		const hash = computeFileHash(text);

		const patch = `
[${filePath}#${hash}]
PUT 1.=1:
+step1

[${filePath}]
PUT 4.=4:
+step2
`;
		const res = applyHashlinePatch(patch, { cwd: tempDir });
		expect(res.ok).toBe(true);
		expect(readFileSync(join(tempDir, filePath), "utf8")).toBe("step1\nline2\nline3\nstep2\n");
	});
});
