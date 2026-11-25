import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeFileHash } from "../../packages/keel/src/hashline-engine.js";
import { makePatchTool, type PatchToolOptions } from "../../packages/keel/src/adapters/tools/patch.js";

/**
 * `patch` 的 LSP 桥：宿主把 `getLiveLspDiagnostics` 注入成 `PatchToolOptions.liveDiagnostics`
 * （引擎里就是 `LspPort.liveDiagnostics`）。内核只转发这一支查询——语言客户端 / 语言服务器
 * 子进程全在宿主叶子 `server/lsp-tool.ts`，所以这里全部用假体，不起任何子进程。
 *
 * 三条断言对齐老实现的语义（`server/patch-tool.ts` 同一段 `try {} catch {}`）：接了就有诊断、
 * 没接就没有、抛错也照常成功（尽力而为项绝不能反过来弄失败补丁）。
 */

type PatchExecResult = {
	content: Array<{ type: string; text: string }>;
	details: { ok: boolean; summary: string };
};

type PatchTool = { execute: (...args: unknown[]) => Promise<PatchExecResult> };

let tempDir = "";
const FILE = "greet.ts";
const INITIAL = ["function greet() {", "  const msg = 'hello';", "  return msg;", "}"].join("\n");

function patchText(): string {
	return `
[${FILE}#${computeFileHash(INITIAL)}]
PUT 2.=2:
+  const msg = 'hi';
`;
}

function runPatch(options: Omit<PatchToolOptions, "cwd"> = {}): Promise<PatchExecResult> {
	const tool = makePatchTool({ cwd: tempDir, lang: () => "zh", ...options }) as unknown as PatchTool;
	return tool.execute("call-1", { patch: patchText() });
}

beforeEach(() => {
	tempDir = mkdtempSync(join(tmpdir(), "keel-lsp-bridge-"));
	writeFileSync(join(tempDir, FILE), INITIAL);
});

afterEach(() => {
	rmSync(tempDir, { recursive: true, force: true });
});

describe("adapters/tools · patch 的 LSP 诊断桥", () => {
	it("给了 liveDiagnostics：成功输出里带诊断段与诊断内容（绝对路径 + cwd 原样传给宿主）", async () => {
		const liveDiagnostics = vi.fn(async () => "greet.ts:2:9 error TS1005: ';' expected.");

		const res = await runPatch({ liveDiagnostics });

		expect(res.details.ok).toBe(true);
		const text = res.content.map((part) => part.text).join("");
		expect(text).toContain(`${FILE} 的实时 LSP 诊断：`);
		expect(text).toContain("error TS1005: ';' expected.");
		expect(liveDiagnostics).toHaveBeenCalledTimes(1);
		expect(liveDiagnostics).toHaveBeenCalledWith(resolve(tempDir, FILE), tempDir);
		// 诊断是追加项，锚点那一行照旧在（顺序：摘要 → 锚点 → 诊断）。
		expect(text.indexOf("下一处编辑锚点")).toBeLessThan(text.indexOf("实时 LSP 诊断"));
	});

	it("没给 liveDiagnostics：输出里没有诊断段，补丁照旧成功（缺省 = 能力未接）", async () => {
		const res = await runPatch();

		expect(res.details.ok).toBe(true);
		const text = res.content.map((part) => part.text).join("");
		expect(text).not.toContain("LSP 诊断");
		expect(text).not.toContain("Live LSP diagnostics");
		expect(text).toContain("下一处编辑锚点");
		expect(readFileSync(join(tempDir, FILE), "utf8")).toContain("const msg = 'hi';");
	});

	it("liveDiagnostics 抛错：补丁仍然成功，输出无诊断段（尽力而为，老口径同一个 catch）", async () => {
		const liveDiagnostics = vi.fn(async () => {
			throw new Error("language server exploded");
		});

		const res = await runPatch({ liveDiagnostics });

		expect(liveDiagnostics).toHaveBeenCalledTimes(1);
		expect(res.details.ok).toBe(true);
		const text = res.content.map((part) => part.text).join("");
		expect(text).not.toContain("LSP 诊断");
		expect(text).not.toContain("language server exploded");
		expect(text).toContain("下一处编辑锚点");
		expect(readFileSync(join(tempDir, FILE), "utf8")).toContain("const msg = 'hi';");
	});
});
