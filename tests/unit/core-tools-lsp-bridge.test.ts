import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeFileHash } from "../../packages/keel/src/hashline-engine.js";
import { makePatchTool, type PatchToolOptions } from "../../packages/keel/src/adapters/tools/patch.js";
import type { LspPort } from "../../packages/keel/src/contracts/lsp.js";
import { clearResolveBinaryCache, getLiveLspDiagnostics, globalLspPool, makeLspTool } from "../../server/lsp-tool.js";

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
	try {
		rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	} catch {}
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

describe("宿主 LspPort · 真实 stdio 语言服务器子进程端到端", () => {
	afterAll(async () => {
		await globalLspPool.shutdownAll();
		clearResolveBinaryCache();
	});

	it("LspPort.tool + LspPort.liveDiagnostics 经由真实 stdio JSON-RPC 子进程完成 hover 与 patch 实时诊断", async () => {
		const serverScript = join(tempDir, "e2e-lsp-server.mjs");
		writeFileSync(
			serverScript,
			`
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
	buffer = Buffer.concat([buffer, chunk]);
	while (true) {
		const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
		if (headerEnd === -1) break;
		const header = buffer.slice(0, headerEnd).toString("utf8");
		const lenMatch = header.match(/Content-Length:\\s*(\\d+)/i);
		if (!lenMatch) {
			buffer = buffer.slice(headerEnd + 4);
			continue;
		}
		const len = parseInt(lenMatch[1], 10);
		if (buffer.length < headerEnd + 4 + len) break;
		const body = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8"));
		buffer = buffer.slice(headerEnd + 4 + len);
		handle(body);
	}
});

function send(msg) {
	const payload = JSON.stringify(msg);
	process.stdout.write(\`Content-Length: \${Buffer.byteLength(payload, "utf8")}\\r\\n\\r\\n\${payload}\`);
}

function handle(msg) {
	if (msg.method === "initialize") {
		send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: { hoverProvider: true } } });
	} else if (msg.method === "textDocument/hover") {
		send({
			jsonrpc: "2.0",
			id: msg.id,
			result: { contents: { kind: "markdown", value: "function greet(): string" } },
		});
	} else if (msg.method === "textDocument/didOpen" || msg.method === "textDocument/didChange") {
		const text = msg.params?.textDocument?.text ?? msg.params?.contentChanges?.[0]?.text ?? "";
		const diagnostics = text.includes("const msg = 'hi'")
			? [{
					range: { start: { line: 1, character: 2 }, end: { line: 1, character: 19 } },
					severity: 1,
					code: "TS9001",
					message: "E2E diagnostic: msg reassigned",
				}]
			: [];
		send({
			jsonrpc: "2.0",
			method: "textDocument/publishDiagnostics",
			params: { uri: msg.params.textDocument.uri, diagnostics },
		});
	} else if (msg.method === "shutdown") {
		send({ jsonrpc: "2.0", id: msg.id, result: null });
	}
}
`,
		);

		const binDir = join(tempDir, "node_modules", ".bin");
		mkdirSync(binDir, { recursive: true });
		if (process.platform === "win32") {
			writeFileSync(join(binDir, "vtsls.cmd"), `@echo off\r\n"${process.execPath}" "${serverScript}" %*\r\n`);
		} else {
			const binPath = join(binDir, "vtsls");
			writeFileSync(binPath, `#!/bin/sh\nexec "${process.execPath}" "${serverScript}" "$@"\n`);
			chmodSync(binPath, 0o755);
		}
		clearResolveBinaryCache();

		const lspPort: LspPort = {
			liveDiagnostics: (absPath, cwd) => getLiveLspDiagnostics(absPath, cwd),
			tool: ({ cwd, lang }) => makeLspTool({ cwd, lang }),
		};

		const lspTool = lspPort.tool!({ cwd: tempDir, lang: () => "zh" }) as {
			execute: (
				id: string,
				params: Record<string, unknown>,
			) => Promise<{ content: Array<{ type: string; text: string }>; details: { ok: boolean } }>;
		};

		// 1. 先通过 LspPort.tool 拉起真实 stdio 语言服务器并执行 hover
		const hoverRes = await lspTool.execute("call-hover", {
			action: "hover",
			path: FILE,
			line: 1,
			character: 10,
		});
		expect(hoverRes.details.ok).toBe(true);
		expect(hoverRes.content.map((c) => c.text).join("")).toContain("function greet(): string");

		// 2. 再通过 LspPort.liveDiagnostics 走 patch，验证真实子进程推送的 publishDiagnostics 进补丁输出
		const patchRes = await runPatch({ liveDiagnostics: lspPort.liveDiagnostics });
		expect(patchRes.details.ok).toBe(true);
		const patchTextOut = patchRes.content.map((c) => c.text).join("");
		expect(patchTextOut).toContain(`${FILE} 的实时 LSP 诊断：`);
		expect(patchTextOut).toContain("E2E diagnostic: msg reassigned (TS9001)");
	});
});
