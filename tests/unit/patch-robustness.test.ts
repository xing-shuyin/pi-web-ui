import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyHashlinePatch, computeFileHash, HashlineSnapshotStore } from "../../server/hashline-engine.js";

/** 大小写折叠行为仅 Windows 有意义（foldKey 按 platform 分支） */
const itWin32 = process.platform === "win32" ? it : it.skip;

describe("Hashline patch robustness", () => {
	let cwd: string;
	let store: HashlineSnapshotStore;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "patch-robust-"));
		store = new HashlineSnapshotStore();
	});

	afterEach(() => {
		try {
			rmSync(cwd, { recursive: true, force: true });
		} catch {}
	});

	const apply = (patch: string) => applyHashlinePatch(patch, { cwd, snapshotStore: store });

	describe("new file creation", () => {
		it("creates a new file via bare [path] header + PUT <1:", () => {
			const r = apply("[new_dir/new.py]\nPUT <1:\n+def hello():\n+    return 1\n");
			expect(r.ok).toBe(true);
			expect(readFileSync(join(cwd, "new_dir", "new.py"), "utf8")).toBe("def hello():\n    return 1\n");
			expect(r.results[0]?.created).toBe(true);
		});

		it("creates via PUT >$ tail anchor", () => {
			const r = apply("[n3.txt]\nPUT >$:\n+tail-line\n");
			expect(r.ok).toBe(true);
			expect(readFileSync(join(cwd, "n3.txt"), "utf8")).toBe("tail-line\n");
		});

		it("mixed sections edit existing and create new in one patch", () => {
			writeFileSync(join(cwd, "exist.txt"), "line1\nline2\nline3\n");
			const r = apply("[exist.txt]\nPUT 2.=2:\n+LINE2\n[new_dir/new2.md]\nPUT <1:\n+# Title\n");
			expect(r.ok).toBe(true);
			expect(readFileSync(join(cwd, "exist.txt"), "utf8")).toBe("line1\nLINE2\nline3\n");
			expect(readFileSync(join(cwd, "new_dir", "new2.md"), "utf8")).toBe("# Title\n");
		});

		it("rejects REM/MV on a nonexistent file", () => {
			const r = apply("[nope2.txt]\nREM\n");
			expect(r.ok).toBe(false);
			expect(r.summary).toContain("REM");
		});

		it("rejects tagged header on nonexistent file without candidates", () => {
			const r = apply("[nope.txt#ABCD]\nPUT <1:\n+x\n");
			expect(r.ok).toBe(false);
			expect(r.summary).toContain("不能带 #TAG");
		});

		it("empty section on nonexistent path creates an empty file", () => {
			const r = apply("[empty.txt]\n");
			expect(r.ok).toBe(true);
			expect(r.results[0]?.created).toBe(true);
			expect(readFileSync(join(cwd, "empty.txt"), "utf8")).toBe("");
		});
	});

	describe("path normalization", () => {
		it("unifies [a] and [./a] within one patch (no last-write-wins clobber)", () => {
			const r = apply("[pn.txt]\nPUT <1:\n+A\n[./pn.txt]\nPUT >$:\n+B\n");
			expect(r.ok).toBe(true);
			expect(readFileSync(join(cwd, "pn.txt"), "utf8")).toBe("A\nB\n");
		});

		it("accepts absolute-path section headers", () => {
			const r = apply(`[${join(cwd, "abs.txt")}]\nPUT <1:\n+abs\n`);
			expect(r.ok).toBe(true);
			expect(readFileSync(join(cwd, "abs.txt"), "utf8")).toBe("abs\n");
		});

		itWin32("folds case variants so [EXIST.TXT] lands on exist.txt", () => {
			writeFileSync(join(cwd, "exist.txt"), "base\n");
			const hash = computeFileHash("base\n");
			const r = apply(`[exist.txt#${hash}]\nPUT 1.=1:\n+EDITED\n\n[EXIST.TXT]\nPUT >$:\n+APPENDED\n`);
			expect(r.ok).toBe(true);
			expect(readFileSync(join(cwd, "exist.txt"), "utf8")).toBe("EDITED\nAPPENDED\n");
		});
	});

	describe("fuzzy same-basename resolution", () => {
		it("resolves a mistyped directory to the unique same-basename file", () => {
			mkdirSync(join(cwd, "sub"), { recursive: true });
			writeFileSync(join(cwd, "sub", "unique.txt"), "hello\n");
			const hash = computeFileHash("hello\n");
			const r = apply(`[wrongdir/unique.txt#${hash}]\nPUT 1.=1:\n+WORLD\n`);
			expect(r.ok).toBe(true);
			expect(r.results[0]?.note).toContain("已解析");
			expect(r.results[0]?.note).toContain("sub");
			expect(readFileSync(join(cwd, "sub", "unique.txt"), "utf8")).toBe("WORLD\n");
		});

		it("reports ambiguous candidates instead of guessing", () => {
			mkdirSync(join(cwd, "d1"), { recursive: true });
			mkdirSync(join(cwd, "d2"), { recursive: true });
			writeFileSync(join(cwd, "d1", "dup.txt"), "1\n");
			writeFileSync(join(cwd, "d2", "dup.txt"), "2\n");
			const r = apply("[wrongdir/dup.txt#ABCD]\nPUT 1.=1:\n+y\n");
			expect(r.ok).toBe(false);
			expect(r.summary).toContain("相近文件");
			expect(r.summary).toContain("d1");
			expect(r.summary).toContain("d2");
			expect(r.summary).toContain("勿新建同名文件");
		});

		it("never resolves into node_modules", () => {
			mkdirSync(join(cwd, "node_modules"), { recursive: true });
			writeFileSync(join(cwd, "node_modules", "dup2.txt"), "x\n");
			const r = apply("[wrongdir/dup2.txt#ABCD]\nPUT 1.=1:\n+y\n");
			expect(r.ok).toBe(false);
			expect(r.summary).not.toContain("node_modules");
			expect(readFileSync(join(cwd, "node_modules", "dup2.txt"), "utf8")).toBe("x\n");
		});

		it("never resolves dotfiles (.env etc.)", () => {
			writeFileSync(join(cwd, ".env"), "SECRET=1\n");
			const r = apply("[wrongdir/.env#ABCD]\nPUT 1.=1:\n+y\n");
			expect(r.ok).toBe(false);
			expect(r.summary).not.toContain("已解析");
			expect(readFileSync(join(cwd, ".env"), "utf8")).toBe("SECRET=1\n");
		});

		it("does not hijack creation intent (bare header stays a create)", () => {
			mkdirSync(join(cwd, "elsewhere"), { recursive: true });
			writeFileSync(join(cwd, "elsewhere", "createme.txt"), "keep\n");
			const r = apply("[createme.txt]\nPUT <1:\n+fresh\n");
			expect(r.ok).toBe(true);
			expect(r.results[0]?.note).toBeUndefined();
			expect(readFileSync(join(cwd, "createme.txt"), "utf8")).toBe("fresh\n");
			expect(readFileSync(join(cwd, "elsewhere", "createme.txt"), "utf8")).toBe("keep\n");
		});
	});

	describe("soft rejection diagnostics", () => {
		it("hash mismatch error carries live anchor and content excerpt without phantom lines", () => {
			writeFileSync(join(cwd, "f2.txt"), "a\nb\nc\n");
			const r = apply("[f2.txt#ABCD]\nPUT 1.=1:\n+x\n");
			expect(r.ok).toBe(false);
			expect(r.summary).toContain("当前共 3 行");
			expect(r.summary).toContain("最新锚点：[f2.txt#");
			expect(r.summary).not.toContain("4:");
		});

		it("line-out-of-bounds error carries tail excerpt", () => {
			writeFileSync(join(cwd, "small.txt"), "a\nb\nc\n");
			const r = apply("[small.txt]\nPUT 99.=99:\n+z\n");
			expect(r.ok).toBe(false);
			expect(r.summary).toContain("最新锚点");
			expect(r.summary).toContain("3: c");
		});

		it("recovery-failure error carries the conflicting content", () => {
			writeFileSync(join(cwd, "tgt.txt"), "A\nB\nC\nD\nE\n");
			const first = apply("[tgt.txt]\nPUT 1.=1:\n+A2\n");
			const hash = first.results[0]?.newHash;
			// 覆盖为不同行数（delta ≠ 0），锚点上下文彻底消失
			writeFileSync(join(cwd, "tgt.txt"), "X1\nX2\nX3\nX4\nX5\nX6\n");
			const r = apply(`[tgt.txt#${hash}]\nPUT 1.=1:\n+A3\n`);
			expect(r.ok).toBe(false);
			expect(r.summary).toContain("三方合流失败");
			expect(r.summary).toContain("X1");
		});
	});

	describe("cascade re-anchoring", () => {
		it("recovers when lines were inserted before the anchor (delta shift)", () => {
			writeFileSync(join(cwd, "cs.txt"), "one\ntwo\nthree\nfour\nfive\n");
			const first = apply("[cs.txt]\nPUT 4.=5:\n+FOUR\n+FIVE\n");
			const hash = first.results[0]?.newHash;
			writeFileSync(join(cwd, "cs.txt"), "INS1\nINS2\none\ntwo\nthree\nFOUR\nFIVE\n");
			const r = apply(`[cs.txt#${hash}]\nPUT 4.=5:\n+FOUR2\n+FIVE2\n`);
			expect(r.ok).toBe(true);
			expect(r.results[0]?.recovered).toBe(true);
			expect(readFileSync(join(cwd, "cs.txt"), "utf8")).toBe("INS1\nINS2\none\ntwo\nthree\nFOUR2\nFIVE2\n");
		});

		it("recovers via window search when insertion lands between context and anchor", () => {
			writeFileSync(join(cwd, "cw.txt"), "one\ntwo\nthree\nFOUR\nFIVE\n");
			const first = apply("[cw.txt]\nPUT 1.=1:\n+ONE\n");
			const hash = first.results[0]?.newHash;
			writeFileSync(join(cwd, "cw.txt"), "one\ntwo\nX1\nX2\nthree\nFOUR\nFIVE\n");
			const r = apply(`[cw.txt#${hash}]\nPUT 4.=5:\n+FOUR2\n+FIVE2\n`);
			expect(r.ok).toBe(true);
			expect(r.results[0]?.recovered).toBe(true);
			const after = readFileSync(join(cwd, "cw.txt"), "utf8");
			expect(after).toContain("X1");
			expect(after).toContain("FOUR2");
		});

		it("still fails cleanly on a genuine conflict", () => {
			writeFileSync(join(cwd, "g.txt"), "A\nB\nC\n");
			const first = apply("[g.txt]\nPUT 1.=1:\n+A2\n");
			const hash = first.results[0]?.newHash;
			// 不同行数 + 上下文消失
			writeFileSync(join(cwd, "g.txt"), "totally\ndifferent\nstuff\nmore\n");
			const r = apply(`[g.txt#${hash}]\nPUT 2.=2:\n+B2\n`);
			expect(r.ok).toBe(false);
			expect(r.summary).toContain("三方合流失败");
			expect(r.summary).toContain("totally");
		});

		it("keeps all-or-nothing semantics across hunks", () => {
			writeFileSync(join(cwd, "ao.txt"), "A\nB\nC\nD\nE\n");
			const first = apply("[ao.txt]\nPUT 1.=1:\n+A2\n");
			const hash = first.results[0]?.newHash;
			// 多一行（delta=+1）：hunk1 在差异点之前可原样保留，hunk2 上下文消失须整体失败
			writeFileSync(join(cwd, "ao.txt"), "A2\nB\nKEEPME\nD\nE\nEXTRA\n");
			const r = apply(`[ao.txt#${hash}]\nPUT 1.=1:\n+TOP\nPUT 3.=3:\n+CHANGED\n`);
			expect(r.ok).toBe(false);
			expect(readFileSync(join(cwd, "ao.txt"), "utf8")).toBe("A2\nB\nKEEPME\nD\nE\nEXTRA\n");
		});
	});

	describe("regression: anchors, registers, CRLF", () => {
		it("keeps the anchor chain usable across successive patches", () => {
			writeFileSync(join(cwd, "chain.txt"), "l1\nl2\nl3\n");
			const r1 = apply("[chain.txt]\nPUT 1.=1:\n+L1\n");
			const h = r1.results[0]?.newHash ?? "";
			expect(h).not.toBe("");
			const r2 = apply(`[chain.txt#${h}]\nPUT 3.=3:\n+L3\n`);
			expect(r2.ok).toBe(true);
			expect(readFileSync(join(cwd, "chain.txt"), "utf8")).toBe("L1\nl2\nL3\n");
		});

		it("preserves CRLF line endings on existing files", () => {
			writeFileSync(join(cwd, "crlf.txt"), "a\r\nb\r\n");
			const r = apply("[crlf.txt]\nPUT 1.=1:\n+A\n");
			expect(r.ok).toBe(true);
			expect(readFileSync(join(cwd, "crlf.txt"), "utf8")).toContain("A\r\nb");
		});

		it("REjects path traversal outside the workspace", () => {
			const r = apply("[sub/../../evil.txt]\nPUT <1:\n+x\n");
			expect(r.ok).toBe(false);
			expect(r.summary).toContain("越界");
		});
	});
});
