import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	makeLspTool,
	LSP_TOOL_NAME,
	globalLspPool,
	LspClient,
	resolveBinary,
	clearResolveBinaryCache,
} from "../../server/lsp-tool.js";

describe("Native LSP Tool", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "lsp-tool-test-"));
	});

	afterEach(() => {
		try {
			rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	afterAll(async () => {
		await globalLspPool.shutdownAll();
	});

	it("exports proper tool definition", () => {
		const tool = makeLspTool({ cwd: tempDir, ownerId: "test-owner" });
		expect(tool.name).toBe(LSP_TOOL_NAME);
		const actionProps = tool.parameters.properties.action as any;
		const actions = actionProps.enum || actionProps.anyOf?.map((x: any) => x.const);
		expect(actions).toContain("definition");
		expect(actions).toContain("references");
		expect(actions).toContain("hover");
		expect(actions).toContain("diagnostics");
		expect(actions).toContain("documentSymbol");
		expect(actions).toContain("read_symbol");
		expect(actions).toContain("workspaceSymbol");
		expect(actions).toContain("cascade");
	});

	it("returns error cleanly for non-existent file", async () => {
		const tool = makeLspTool({ cwd: tempDir });
		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;
		const res = await exec("call-1", {
			action: "definition",
			path: "does_not_exist.ts",
			line: 1,
			character: 1,
		});

		expect(res.details.ok).toBe(false);
		expect(res.content[0].text).toContain("File not found");
	});

	it("returns informative error when file type has no LSP mapping", async () => {
		const tool = makeLspTool({ cwd: tempDir });
		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;
		const filePath = "data.xyz";
		writeFileSync(join(tempDir, filePath), "some data");

		const res = await exec("call-2", {
			action: "definition",
			path: filePath,
			line: 1,
		});

		expect(res.details.ok).toBe(false);
		expect(res.content[0].text).toContain("No language server mapping");
	});

	it("speaks JSON-RPC 2.0 with a mock language server process", async () => {
		// 编写一个极简的标准 mock LSP 进程脚本，测试完整的协议与传输编解码
		const mockServerScript = join(tempDir, "mock-lsp-server.mjs");
		const mockCode = `
import { createInterface } from "readline";

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

    handleMessage(body);
  }
});

function send(msg) {
  const payload = JSON.stringify(msg);
  const wire = \`Content-Length: \${Buffer.byteLength(payload, "utf8")}\\r\\n\\r\\n\${payload}\`;
  process.stdout.write(wire);
}

function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === "textDocument/definition") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [{
        uri: msg.params.textDocument.uri,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } }
      }]
    });
  } else if (msg.method === "textDocument/hover") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        contents: { kind: "markdown", value: "*(mock)* **function greet(name: string): void**" }
      }
    });
  } else if (msg.method === "textDocument/references") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        { uri: msg.params.textDocument.uri, range: { start: { line: 5, character: 2 }, end: { line: 5, character: 7 } } }
      ]
    });
  } else if (msg.method === "textDocument/documentSymbol") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          name: "Calculator",
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 16 } },
          children: [
            {
              name: "add",
              kind: 6,
              detail: "(a: number, b: number) => number",
              range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
              selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
            }
          ]
        },
        {
          name: "multiply",
          kind: 12,
          range: { start: { line: 5, character: 0 }, end: { line: 7, character: 1 } },
          selectionRange: { start: { line: 5, character: 9 }, end: { line: 5, character: 17 } }
        }
      ]
    });
  } else if (msg.method === "workspace/symbol") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          name: "Calculator",
          kind: 5,
          location: {
            uri: msg.params.query ? "file:///mock/test.ts" : "",
            range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } }
          }
        }
      ]
    });
  } else if (msg.method === "textDocument/didOpen") {
    // 模拟推送诊断
    send({
      jsonrpc: "2.0",
      method: "textDocument/publishDiagnostics",
      params: {
        uri: msg.params.textDocument.uri,
        diagnostics: [
          {
            range: { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } },
            severity: 1,
            message: "Mock type error: Cannot find name 'foo'",
            code: 2304
          }
        ]
      }
    });
  }
}
`;
		writeFileSync(mockServerScript, mockCode);

		const client = new LspClient(tempDir, "mock", process.execPath, [mockServerScript], "typescript", () => {});
		await client.start();

		const testFile = join(tempDir, "test.ts");
		writeFileSync(testFile, "const x = 1;\nfoo();\n");
		const uri = await client.syncDocument(testFile);

		// 1. Definition
		const defRes = await client.request("textDocument/definition", {
			textDocument: { uri },
			position: { line: 0, character: 6 },
		});
		expect(Array.isArray(defRes)).toBe(true);
		expect(defRes[0].range.start.line).toBe(0);

		// 2. Hover
		const hoverRes = await client.request("textDocument/hover", {
			textDocument: { uri },
			position: { line: 0, character: 6 },
		});
		expect(hoverRes.contents.value).toContain("function greet");

		// 3. References
		const refRes = await client.request("textDocument/references", {
			textDocument: { uri },
			position: { line: 0, character: 6 },
			context: { includeDeclaration: true },
		});
		expect(refRes.length).toBe(1);
		expect(refRes[0].range.start.line).toBe(5);

		// 4. Diagnostics (via publishDiagnostics notification)
		await new Promise((r) => setTimeout(r, 80));
		const diags = client.getDiagnostics(uri);
		expect(diags.length).toBe(1);
		expect(diags[0].message).toContain("Mock type error");
		expect(diags[0].code).toBe(2304);

		// 5. Document Symbols (Outline)
		const symRes = await client.request("textDocument/documentSymbol", {
			textDocument: { uri },
		});
		expect(Array.isArray(symRes)).toBe(true);
		expect(symRes.length).toBe(2);
		expect(symRes[0].name).toBe("Calculator");
		expect(symRes[0].children[0].name).toBe("add");

		// 6. Workspace Symbol
		const wsRes = await client.request("workspace/symbol", {
			query: "Calc",
		});
		expect(Array.isArray(wsRes)).toBe(true);
		expect(wsRes[0].name).toBe("Calculator");

		await client.shutdown();
	});

	it("resolves binary with local node_modules/.bin priority and proper executable extensions", () => {
		const binDir = join(tempDir, "node_modules", ".bin");
		mkdirSync(binDir, { recursive: true });
		const isWin = process.platform === "win32";
		const testBin = join(binDir, isWin ? "custom-lsp.cmd" : "custom-lsp");
		writeFileSync(testBin, "#!/bin/sh\necho ok\n");

		const found = resolveBinary("custom-lsp", tempDir);
		expect(found).toBeTruthy();
		expect(found).toBe(testBin);
	});

	it("does not auto-install without explicit allowInstall (user consent gate)", async () => {
		const savedPath = process.env.PATH;
		process.env.PATH = "";
		try {
			clearResolveBinaryCache();
			const res = await globalLspPool.getClient(tempDir, join(tempDir, "sample.ts"));
			if ("error" in res) {
				// 未授权时不得联网安装：返回安装指引 + allowInstall 重试提示
				expect(res.error).toMatch(/allowInstall|Failed to start/);
			} else {
				// 该机器生态目录里已有语言服务：门禁未触发，直接释放
				await res.client.shutdown();
			}
		} finally {
			if (savedPath === undefined) delete process.env.PATH;
			else process.env.PATH = savedPath;
			clearResolveBinaryCache();
		}
	});

	it("returns error cleanly when path attempts traversal outside workspace", async () => {
		const tool = makeLspTool({ cwd: tempDir });
		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;

		const res = await exec("call-traversal", {
			action: "definition",
			path: "../outside.ts",
			line: 1,
		});

		expect(res.details.ok).toBe(false);
		expect(res.content[0].text).toContain("Path traversal denied");
	});

	it("returns error cleanly for read_symbol without symbol parameter", async () => {
		const tool = makeLspTool({ cwd: tempDir });
		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;
		const filePath = "sample.ts";
		writeFileSync(join(tempDir, filePath), "function hello() {}\n");

		const res = await exec("call-read-sym-err", {
			action: "read_symbol",
			path: filePath,
		});

		expect(res.details.ok).toBe(false);
		expect(res.content[0].text).toContain("'symbol' parameter is required");
	});

	it("executes documentSymbol, read_symbol, and workspaceSymbol through makeLspTool.execute", async () => {
		const mockServerScript = join(tempDir, "mock-lsp-server.mjs");
		const mockCode = `
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const lenMatch = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!lenMatch) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(lenMatch[1], 10);
    if (buffer.length < headerEnd + 4 + len) break;
    const body = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8"));
    buffer = buffer.slice(headerEnd + 4 + len);

    handleMessage(body);
  }
});

function send(msg) {
  const payload = JSON.stringify(msg);
  const wire = \`Content-Length: \${Buffer.byteLength(payload, "utf8")}\\r\\n\\r\\n\${payload}\`;
  process.stdout.write(wire);
}

function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === "textDocument/documentSymbol") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          name: "Calculator",
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 16 } },
          children: [
            {
              name: "add",
              kind: 6,
              detail: "(a: number, b: number) => number",
              range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
              selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }
            }
          ]
        },
        {
          name: "multiply",
          kind: 12,
          range: { start: { line: 5, character: 0 }, end: { line: 7, character: 1 } },
          selectionRange: { start: { line: 5, character: 9 }, end: { line: 5, character: 17 } }
        },
        {
          name: "Count",
          kind: 13,
          range: { start: { line: 8, character: 0 }, end: { line: 8, character: 17 } }
        },
        {
          name: "count",
          kind: 12,
          range: { start: { line: 9, character: 0 }, end: { line: 11, character: 1 } }
        }
      ]
    });
  } else if (msg.method === "workspace/symbol") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          name: "Calculator",
          kind: 5,
          location: {
            uri: msg.params.query ? "file:///mock/test.ts" : "",
            range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } }
          }
        },
        {
          name: "calculateTotal",
          kind: 12,
          containerName: "OrderService",
          location: {
            uri: "file:///mock/orders.ts",
            range: { start: { line: 10, character: 0 }, end: { line: 15, character: 1 } }
          }
        }
      ]
    });
  }
}
`;
		writeFileSync(mockServerScript, mockCode);

		const binDir = join(tempDir, "node_modules", ".bin");
		mkdirSync(binDir, { recursive: true });
		if (process.platform === "win32") {
			writeFileSync(join(binDir, "vtsls.cmd"), `@"${process.execPath}" "${mockServerScript.replace(/\\/g, "/")}" %*\n`);
		} else {
			const shFile = join(binDir, "vtsls");
			writeFileSync(shFile, `#!/bin/sh\nexec "${process.execPath}" "${mockServerScript}" "$@"\n`);
			try {
				chmodSync(shFile, 0o755);
			} catch {}
		}
		clearResolveBinaryCache();

		const testCode = [
			"class Calculator {",
			"  add(a: number, b: number) {",
			"    return a + b;",
			"  }",
			"}",
			"function multiply(a: number, b: number) {",
			"  return a * b;",
			"}",
			"const Count = 42;",
			"function count() {",
			"  return 1;",
			"}",
		].join("\n");
		const testFile = join(tempDir, "test.ts");
		writeFileSync(testFile, testCode);

		const tool = makeLspTool({ cwd: tempDir });
		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;

		// 1. documentSymbol: 格式化大纲包含类与子级缩进与行跨度
		const docRes = await exec("call-doc", {
			action: "documentSymbol",
			path: "test.ts",
		});
		expect(docRes.details.ok).toBe(true);
		expect(docRes.details.truncated).toBe(false);
		expect(docRes.details.symbols.length).toBe(4);
		expect(docRes.content[0].text).toContain("• [Class] Calculator");
		expect(docRes.content[0].text).toContain("  • [Method] add ((a: number, b: number) => number) (lines 2-4)");
		expect(docRes.content[0].text).toContain("lines 1-5");

		// 2. read_symbol 单符号
		const readRes = await exec("call-read-single", {
			action: "read_symbol",
			path: "test.ts",
			symbol: "multiply",
		});
		expect(readRes.details.ok).toBe(true);
		expect(readRes.details.startLine).toBe(6);
		expect(readRes.details.endLine).toBe(8);
		expect(readRes.content[0].text).toContain("Symbol: multiply [Function]");
		expect(readRes.content[0].text).toContain("return a * b;");

		// 3. read_symbol 点分符号
		const readDotted = await exec("call-read-dotted", {
			action: "read_symbol",
			path: "test.ts",
			symbol: "Calculator.add",
		});
		expect(readDotted.details.ok).toBe(true);
		expect(readDotted.details.fullName).toBe("Calculator.add");
		expect(readDotted.details.startLine).toBe(2);
		expect(readDotted.details.endLine).toBe(4);
		expect(readDotted.content[0].text).toContain("return a + b;");

		// 4. read_symbol not-found 回退自愈提示
		const readNotFound = await exec("call-read-nf", {
			action: "read_symbol",
			path: "test.ts",
			symbol: "unknownFunc",
		});
		expect(readNotFound.details.ok).toBe(false);
		expect(readNotFound.content[0].text).toContain("Symbol 'unknownFunc' not found");
		expect(readNotFound.content[0].text).toContain("Available symbols in test.ts:");
		expect(readNotFound.content[0].text).toContain("Calculator [Class]");

		// 5. 两遍扫描测试：精确 count 优先于 Count，不被大小写遮蔽
		const readExact = await exec("call-read-exact", {
			action: "read_symbol",
			path: "test.ts",
			symbol: "count",
		});
		expect(readExact.details.ok).toBe(true);
		expect(readExact.details.symbol.name).toBe("count");
		expect(readExact.details.symbol.kind).toBe(12);

		// 6. workspaceSymbol 正常搜索与 container 格式
		const wsRes = await exec("call-ws", {
			action: "workspaceSymbol",
			path: "test.ts",
			query: "Calc",
		});
		expect(wsRes.details.ok).toBe(true);
		expect(wsRes.content[0].text).toContain("• [Class] Calculator");
		expect(wsRes.content[0].text).toContain("• [Function] calculateTotal in OrderService");
		expect(wsRes.details.symbols.length).toBe(2);

		// 7. workspaceSymbol 空 query 防御校验
		const wsEmpty = await exec("call-ws-empty", {
			action: "workspaceSymbol",
			path: "test.ts",
			query: "   ",
		});
		expect(wsEmpty.details.ok).toBe(false);
		expect(wsEmpty.content[0].text).toContain("cannot be empty");
	});

	it("executes cascade action through makeLspTool.execute (impact check on referencing files)", async () => {
		const mockServerScript = join(tempDir, "mock-lsp-server.mjs");
		const mockCode = `
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const lenMatch = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!lenMatch) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(lenMatch[1], 10);
    if (buffer.length < headerEnd + 4 + len) break;
    const body = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8"));
    buffer = buffer.slice(headerEnd + 4 + len);

    handleMessage(body);
  }
});

function send(msg) {
  const payload = JSON.stringify(msg);
  const wire = \`Content-Length: \${Buffer.byteLength(payload, "utf8")}\\r\\n\\r\\n\${payload}\`;
  process.stdout.write(wire);
}

function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === "textDocument/documentSymbol") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        { name: "calc", kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }, selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } } },
        { name: "helper", kind: 12, range: { start: { line: 4, character: 0 }, end: { line: 5, character: 1 } }, selectionRange: { start: { line: 4, character: 6 }, end: { line: 4, character: 12 } } }
      ]
    });
  } else if (msg.method === "textDocument/references") {
    const uri = String(msg.params.textDocument.uri);
    let result = [{ uri, range: { start: { line: 5, character: 2 }, end: { line: 5, character: 7 } } }];
    if (uri.includes("lonely")) {
      result = [];
    } else if (msg.params.context && msg.params.context.includeDeclaration === false) {
      result = [{ uri: uri.replace(/[^/]+$/, "importer.ts"), range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } } }];
    }
    send({ jsonrpc: "2.0", id: msg.id, result });
  } else if (msg.method === "textDocument/didOpen") {
    const uri = String(msg.params.textDocument.uri);
    const diagnostics = uri.includes("importer")
      ? [{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, severity: 1, message: "Mock cascade error: signature mismatch", code: 2339 }]
      : [];
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
  }
}
`;
		writeFileSync(mockServerScript, mockCode);

		const binDir = join(tempDir, "node_modules", ".bin");
		mkdirSync(binDir, { recursive: true });
		if (process.platform === "win32") {
			writeFileSync(join(binDir, "vtsls.cmd"), `@"${process.execPath}" "${mockServerScript.replace(/\\/g, "/")}" %*\n`);
		} else {
			const shFile = join(binDir, "vtsls");
			writeFileSync(shFile, `#!/bin/sh\nexec "${process.execPath}" "${mockServerScript}" "$@"\n`);
			try {
				chmodSync(shFile, 0o755);
			} catch {}
		}
		clearResolveBinaryCache();

		writeFileSync(join(tempDir, "test.ts"), "function calc() {\n  return 1;\n}\n\nfunction helper() {}\n");
		writeFileSync(join(tempDir, "importer.ts"), 'import { calc } from "./test";\nconsole.log(calc());\n');
		writeFileSync(join(tempDir, "lonely.ts"), "function lonely() {}\n");

		const tool = makeLspTool({ cwd: tempDir });
		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;

		// 1. 全文件级联：顶层符号 → references → importer.ts 的诊断回流
		const res = await exec("call-cascade", {
			action: "cascade",
			path: "test.ts",
		});
		expect(res.details.ok).toBe(true);
		expect(res.content[0].text).toContain("Impact cascade for test.ts");
		expect(res.content[0].text).toContain("1 referencing file(s)");
		expect(res.content[0].text).toContain("importer.ts — 1 error(s), 0 warning(s)");
		expect(res.content[0].text).toContain("[ERROR] line 1:10");
		expect(res.content[0].text).toContain("Mock cascade error");
		expect(res.details.impacted.length).toBe(1);
		expect(res.details.impacted[0].path).toBe("importer.ts");
		expect(res.details.clean.length).toBe(0);

		// 2. 指定 line/character：单符号种子同样命中 importer
		const resSeed = await exec("call-cascade-seed", {
			action: "cascade",
			path: "test.ts",
			line: 1,
			character: 7,
		});
		expect(resSeed.details.ok).toBe(true);
		expect(resSeed.details.impacted.length).toBe(1);
		expect(resSeed.details.impacted[0].path).toBe("importer.ts");

		// 3. 无引用文件：不级联
		const resLonely = await exec("call-cascade-lonely", {
			action: "cascade",
			path: "lonely.ts",
		});
		expect(resLonely.details.ok).toBe(true);
		expect(resLonely.content[0].text).toContain("No referencing files found");
		expect(resLonely.details.referencedFiles.length).toBe(0);
	});

	it("cascade reports real totals with truncation tails when referencing files exceed the cap", async () => {
		const mockServerScript = join(tempDir, "mock-lsp-server.mjs");
		const mockCode = `
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const lenMatch = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!lenMatch) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(lenMatch[1], 10);
    if (buffer.length < headerEnd + 4 + len) break;
    const body = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8"));
    buffer = buffer.slice(headerEnd + 4 + len);

    handleMessage(body);
  }
});

function send(msg) {
  const payload = JSON.stringify(msg);
  const wire = \`Content-Length: \${Buffer.byteLength(payload, "utf8")}\\r\\n\\r\\n\${payload}\`;
  process.stdout.write(wire);
}

function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === "textDocument/documentSymbol") {
    // 25 个顶层符号：种子只取前 20 个，输出尾部应标明还有 5 个未分析
    const symbols = Array.from({ length: 25 }, (_, i) => ({
      name: "sym" + i,
      kind: 12,
      range: { start: { line: i * 2, character: 0 }, end: { line: i * 2 + 1, character: 1 } },
      selectionRange: { start: { line: i * 2, character: 6 }, end: { line: i * 2, character: 12 } }
    }));
    send({ jsonrpc: "2.0", id: msg.id, result: symbols });
  } else if (msg.method === "textDocument/references") {
    // 30 个引用方文件：只分析排序后的前 25 个，尾部应标明还有 5 个未分析
    const uri = String(msg.params.textDocument.uri);
    const refs = Array.from({ length: 30 }, (_, i) => ({
      uri: uri.replace(/[^/]+$/, "importer" + String(i + 1).padStart(2, "0") + ".ts"),
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } }
    }));
    send({ jsonrpc: "2.0", id: msg.id, result: refs });
  } else if (msg.method === "textDocument/didOpen") {
    const uri = String(msg.params.textDocument.uri);
    const diagnostics = uri.includes("importer01")
      ? [{ range: { start: { line: 0, character: 9 }, end: { line: 0, character: 12 } }, severity: 1, message: "Mock cascade error: signature mismatch", code: 2339 }]
      : [];
    send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
  }
}
`;
		writeFileSync(mockServerScript, mockCode);

		const binDir = join(tempDir, "node_modules", ".bin");
		mkdirSync(binDir, { recursive: true });
		if (process.platform === "win32") {
			writeFileSync(join(binDir, "vtsls.cmd"), `@"${process.execPath}" "${mockServerScript.replace(/\\/g, "/")}" %*\n`);
		} else {
			const shFile = join(binDir, "vtsls");
			writeFileSync(shFile, `#!/bin/sh\nexec "${process.execPath}" "${mockServerScript}" "$@"\n`);
			try {
				chmodSync(shFile, 0o755);
			} catch {}
		}
		clearResolveBinaryCache();

		writeFileSync(join(tempDir, "test.ts"), "function calc() {\n  return 1;\n}\n");
		for (let i = 1; i <= 30; i++) {
			writeFileSync(join(tempDir, `importer${String(i).padStart(2, "0")}.ts`), 'import { calc } from "./test";\n');
		}

		const tool = makeLspTool({ cwd: tempDir });
		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;

		const res = await exec("call-cascade-trunc", {
			action: "cascade",
			path: "test.ts",
		});
		expect(res.details.ok).toBe(true);
		// 头部计数是截断前的真实总数（30），而不是被分析的前 25 个
		expect(res.content[0].text).toContain("Impact cascade for test.ts");
		expect(res.content[0].text).toContain("30 referencing file(s)");
		// 截断尾注：30 - 25 = 5 个引用方未分析
		expect(res.content[0].text).toContain("... and 5 more not analyzed");
		// 种子截断尾注：25 个顶层符号只用前 20 个做种子
		expect(res.content[0].text).toContain("... and 5 more top-level symbols not analyzed");
		// details 带真实总数；referencedFiles 仍是实际分析的那 25 个
		expect(res.details.referencedFilesTotal).toBe(30);
		expect(res.details.referencedFiles.length).toBe(25);
		expect(res.details.referencedFiles[0]).toBe("importer01.ts");
		expect(res.details.impacted.length).toBe(1);
		expect(res.details.impacted[0].path).toBe("importer01.ts");
		expect(res.details.clean.length).toBe(24);
	});

	it("documentSymbol caps details.symbols by flattened count within the 64KB details budget", async () => {
		const mockServerScript = join(tempDir, "mock-lsp-server.mjs");
		const mockCode = `
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd === -1) break;
    const header = buffer.slice(0, headerEnd).toString("utf8");
    const lenMatch = header.match(/Content-Length:\\s*(\\d+)/i);
    if (!lenMatch) { buffer = buffer.slice(headerEnd + 4); continue; }
    const len = parseInt(lenMatch[1], 10);
    if (buffer.length < headerEnd + 4 + len) break;
    const body = JSON.parse(buffer.slice(headerEnd + 4, headerEnd + 4 + len).toString("utf8"));
    buffer = buffer.slice(headerEnd + 4 + len);

    handleMessage(body);
  }
});

function send(msg) {
  const payload = JSON.stringify(msg);
  const wire = \`Content-Length: \${Buffer.byteLength(payload, "utf8")}\\r\\n\\r\\n\${payload}\`;
  process.stdout.write(wire);
}

function handleMessage(msg) {
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
  } else if (msg.method === "textDocument/documentSymbol") {
    // 模拟生成的 .d.ts：1 个顶层符号带 400 个长名子符号（展平 401 个）
    const children = Array.from({ length: 400 }, (_, i) => ({
      name: "generatedMember" + i + "_" + "x".repeat(500),
      kind: 6,
      detail: "(a: number, b: number) => number",
      range: { start: { line: i * 2, character: 2 }, end: { line: i * 2 + 1, character: 3 } },
      selectionRange: { start: { line: i * 2, character: 2 }, end: { line: i * 2, character: 12 } }
    }));
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: [
        {
          name: "GeneratedBundle",
          kind: 5,
          range: { start: { line: 0, character: 0 }, end: { line: 800, character: 1 } },
          selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 20 } },
          children
        }
      ]
    });
  }
}
`;
		writeFileSync(mockServerScript, mockCode);

		const binDir = join(tempDir, "node_modules", ".bin");
		mkdirSync(binDir, { recursive: true });
		if (process.platform === "win32") {
			writeFileSync(join(binDir, "vtsls.cmd"), `@"${process.execPath}" "${mockServerScript.replace(/\\/g, "/")}" %*\n`);
		} else {
			const shFile = join(binDir, "vtsls");
			writeFileSync(shFile, `#!/bin/sh\nexec "${process.execPath}" "${mockServerScript}" "$@"\n`);
			try {
				chmodSync(shFile, 0o755);
			} catch {}
		}
		clearResolveBinaryCache();

		writeFileSync(join(tempDir, "big.d.ts"), "declare class GeneratedBundle {}\n");

		const tool = makeLspTool({ cwd: tempDir });
		const exec = tool.execute as unknown as (
			_id: string,
			p: any,
		) => Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: any;
		}>;

		const docRes = await exec("call-doc-deep", {
			action: "documentSymbol",
			path: "big.d.ts",
		});
		expect(docRes.details.ok).toBe(true);

		const flattenCount = (list: any[]): number =>
			list.reduce((n: number, s: any) => n + 1 + (Array.isArray(s.children) ? flattenCount(s.children) : 0), 0);

		// details.symbols 按展平计数截断，不超过 300（与文本大纲同口径）
		const flat = flattenCount(docRes.details.symbols);
		expect(flat).toBeLessThanOrEqual(300);
		expect(flat).toBeGreaterThan(0);

		// 结构正确：父被保留，其 children 与裁剪边界一致，未混入别的层级
		expect(docRes.details.symbols.length).toBe(1);
		expect(docRes.details.symbols[0].name).toBe("GeneratedBundle");
		expect(docRes.details.symbols[0].children.length).toBe(flat - 1);
		for (const child of docRes.details.symbols[0].children) {
			expect(child.name.startsWith("generatedMember")).toBe(true);
			expect(Array.isArray(child.children)).toBe(false);
		}

		// 截断标记与文本大纲截断提示
		expect(docRes.details.truncated).toBe(true);
		expect(docRes.content[0].text).toContain("[Truncated: outline exceeds 300 symbols]");

		// 64KB 预算：details 整体可序列化体积必须低于 TOOL_DETAILS_CAP（64,000）
		expect(JSON.stringify(docRes.details).length).toBeLessThan(64_000);
	});

	it("handles shutdown cleanly and rejects requests when pool is shutting down", async () => {
		await globalLspPool.shutdownAll();
		const res = await globalLspPool.getClient(tempDir, "test.ts");
		expect("error" in res).toBe(true);
		if ("error" in res) {
			expect(res.error).toContain("shutting down");
		}
	});
});
