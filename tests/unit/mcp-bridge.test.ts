import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpBridge, McpClient, expandEnvVars, mcpServerSnapshot, parseMcpConfig } from "../../server/mcp-bridge.js";
import { createServer, type Server } from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE = resolve(__dirname, "../fixtures/mcp-echo-server.mjs");

const clients: McpClient[] = [];
function client() {
	const c = new McpClient("test-srv", { command: process.execPath, args: [FIXTURE] }, () => {});
	clients.push(c);
	return c;
}

afterEach(() => {
	for (const c of clients) {
		try {
			c.close();
		} catch {}
	}
	clients.length = 0;
});

describe("McpClient 握手与工具", () => {
	it("start 握手 + 列出 10 个工具", async () => {
		const c = client();
		await c.start();
		const names = c.getTools().map((t) => t.name);
		expect(names).toEqual(["echo", "add", "fail", "slow", "screenshot", "pdf", "textfile", "mixed", "crash", "pid"]);
	});

	it("echo 原样返回；add 求和", async () => {
		const c = client();
		await c.start();
		const echo = (await c.call("echo", { msg: "hi", n: 42 })) as { content: string };
		expect(JSON.parse(echo.content)).toEqual({ msg: "hi", n: 42 });
		const add = (await c.call("add", { a: 3, b: 5 })) as { content: string };
		expect(JSON.parse(add.content)).toBe(8);
	});

	it("fail 工具 → isError → 抛错", async () => {
		const c = client();
		await c.start();
		await expect(c.call("fail", {})).rejects.toThrow(/boom/);
	});

	it("未知工具 → isError 抛错", async () => {
		const c = client();
		await c.start();
		await expect(c.call("nope", {})).rejects.toThrow(/unknown tool/);
	});

	it("screenshot 的 image 块原样透传（type/data/mimeType 保真）", async () => {
		const c = client();
		await c.start();
		const res = (await c.call("screenshot", {})) as {
			content: Array<{ type: string; data?: string; mimeType?: string }>;
		};
		expect(res.content).toHaveLength(1);
		expect(res.content[0].type).toBe("image");
		expect(res.content[0].mimeType).toBe("image/png");
		expect(res.content[0].data).toBe(
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
		);
	});

	it("pdf 的 resource 块退化为文本提示（含 mimeType 与字节数）", async () => {
		const c = client();
		await c.start();
		const res = (await c.call("pdf", {})) as { content: Array<{ type: string; text?: string }> };
		expect(res.content).toHaveLength(1);
		expect(res.content[0].type).toBe("text");
		expect(res.content[0].text).toContain("application/pdf");
		expect(res.content[0].text).toContain("9 字节");
	});

	it("textfile 的文本型 resource 不丢正文（按文本形状返回）", async () => {
		const c = client();
		await c.start();
		await expect(c.call("textfile", {})).resolves.toEqual({ content: "文本资源正文", isError: false });
	});

	it("mixed 保序透传（文本块在前、图片块在后）", async () => {
		const c = client();
		await c.start();
		const res = (await c.call("mixed", {})) as { content: Array<{ type: string; text?: string }> };
		expect(res.content.map((b) => b.type)).toEqual(["text", "image"]);
		expect(res.content[0].text).toBe("文本在前");
	});
});

describe("McpClient 自愈（子进程崩溃后自动重启）", () => {
	it("crash 令子进程退出：在途调用立即报「进程退出」，下一次调用自动重启并成功", async () => {
		const c = client();
		await c.start();
		expect(c.startCount).toBe(1);
		await expect(c.call("crash", {}, 1000)).rejects.toThrow(/进程退出/);
		expect(c.startCount).toBe(1);
		const echo = (await c.call("echo", { msg: "重启后" })) as { content: string };
		expect(JSON.parse(echo.content)).toEqual({ msg: "重启后" });
		expect(c.startCount).toBe(2);
		expect(c.getTools().map((t) => t.name)).toContain("crash");
	});

	it("启动即退出的服务器：每次调用都快速报「自动重启失败」的明确错误，不挂死", async () => {
		const c = new McpClient("gone", { command: process.execPath, args: ["-e", "process.exit(7)"] }, () => {});
		clients.push(c);
		await expect(c.call("echo", {}, 1000)).rejects.toThrow(/自动重启失败.*进程退出/);
		await expect(c.call("echo", {}, 1000)).rejects.toThrow(/自动重启失败/);
	});

	it("close 之后不再重启：调用报「客户端已关闭」", async () => {
		const c = client();
		await c.start();
		c.close();
		await expect(c.call("echo", {}, 1000)).rejects.toThrow(/客户端已关闭/);
	});

	it("崩溃后并发调用共享同一次重连：不抢在 initialize 应答前发 tools/call", async () => {
		const c = new McpClient("test-srv", { command: process.execPath, args: [FIXTURE, "250"] }, () => {});
		clients.push(c);
		await c.start();
		await expect(c.call("crash", {}, 1000)).rejects.toThrow(/进程退出/);
		const [a, b] = await Promise.all([c.call("echo", { msg: "A" }), c.call("echo", { msg: "B" })]);
		expect(JSON.parse((a as { content: string }).content)).toEqual({ msg: "A" });
		expect(JSON.parse((b as { content: string }).content)).toEqual({ msg: "B" });
		expect(c.startCount).toBe(2);
	});
});

describe("McpBridge 聚合适配", () => {
	it("load 启动并适配成 PluginAgentTool（execute 经 MCP 转发）", async () => {
		const bridge = new McpBridge("/nonexistent", () => {}, {
			specOverride: [{ name: "csrv", spec: { command: process.execPath, args: [FIXTURE] } }],
		});
		await bridge.load();
		const tools = bridge.getTools();
		expect(tools.length).toBe(10);
		const add = tools.find((t) => t.name === "add")!;
		expect(add.label).toContain("csrv");
		expect(typeof add.execute).toBe("function");
		const res = (await add.execute("id", { a: 10, b: 20 })) as { content: string };
		expect(JSON.parse(res.content)).toBe(30);
		bridge.dispose();
	});

	it("子进程崩溃后经适配工具（PluginAgentTool.execute）自动重启", async () => {
		const bridge = new McpBridge("/nonexistent", () => {}, {
			specOverride: [{ name: "csrv", spec: { command: process.execPath, args: [FIXTURE] } }],
		});
		await bridge.load();
		const tools = bridge.getTools();
		const crash = tools.find((t) => t.name === "crash")!;
		await expect(crash.execute("id", {})).rejects.toThrow(/进程退出/);
		const add = tools.find((t) => t.name === "add")!;
		const res = (await add.execute("id", { a: 10, b: 20 })) as { content: string };
		expect(JSON.parse(res.content)).toBe(30);
		bridge.dispose();
	});

	it("无配置/全部失败 → 无工具", async () => {
		const bridge = new McpBridge("/nonexistent", () => {}, {
			specOverride: [{ name: "bad", spec: { command: "definitely-not-a-real-cmd-xyz", args: [] } }],
		});
		await bridge.load();
		expect(bridge.getTools().length).toBe(0);
		bridge.dispose();
	});
});

describe("超时", () => {
	it("slow 超过注入的超时 → 抛超时错误", async () => {
		process.env.MCP_SLOW_MS = "300";
		const c = client();
		await c.start();
		await expect(c.call("slow", {}, 80)).rejects.toThrow(/超时/);
	});
});

function writeMcpConfig(dir: string, servers: Record<string, unknown>): void {
	writeFileSync(join(dir, "mcp.json"), JSON.stringify({ servers }, null, 2) + "\n");
}

async function callBridge(bridge: McpBridge, name: string, args: Record<string, unknown> = {}): Promise<string> {
	const tool = bridge.getTools().find((t) => t.name === name);
	if (!tool) throw new Error(`工具不存在：${name}`);
	const res = (await tool.execute("id", args)) as { content: string };
	return res.content;
}

async function waitUntil(cond: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (cond()) return;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("等待超时");
}

function isAlive(pid: string): boolean {
	try {
		process.kill(Number(pid), 0);
		return true;
	} catch {
		return false;
	}
}

describe("McpBridge.reload（mcp.json 热替换）", () => {
	const dirs: string[] = [];
	const bridges: McpBridge[] = [];
	function tempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "piweb-mcp-reload-"));
		dirs.push(dir);
		return dir;
	}
	function bridge(dataDir: string): McpBridge {
		const b = new McpBridge(dataDir, () => {});
		bridges.push(b);
		return b;
	}
	afterEach(() => {
		for (const b of bridges) b.dispose();
		bridges.length = 0;
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		dirs.length = 0;
	});

	it("规格没变 → 沿用原实例：不重启、pid 不变、工具照旧", async () => {
		const dir = tempDir();
		writeMcpConfig(dir, { srv: { command: process.execPath, args: [FIXTURE] } });
		const b = bridge(dir);
		await b.load();
		const pid = await callBridge(b, "pid");

		const summary = await b.reload();
		expect(summary).toEqual({ kept: 1, started: 0, stopped: 0, failed: 0, servers: 1, tools: 10 });
		expect(await callBridge(b, "pid")).toBe(pid);
		expect(JSON.parse(await callBridge(b, "add", { a: 20, b: 22 }))).toBe(42);
	});

	it("规格变了 → 只换掉它自己：旧进程真的退出，新进程顶上", async () => {
		const dir = tempDir();
		writeMcpConfig(dir, { srv: { command: process.execPath, args: [FIXTURE] } });
		const b = bridge(dir);
		await b.load();
		const before = await callBridge(b, "pid");

		writeMcpConfig(dir, { srv: { command: process.execPath, args: [FIXTURE], env: { MCP_SLOW_MS: "0" } } });
		const summary = await b.reload();
		expect(summary).toEqual({ kept: 0, started: 1, stopped: 1, failed: 0, servers: 1, tools: 10 });
		expect(await callBridge(b, "pid")).not.toBe(before);
		await waitUntil(() => !isAlive(before));
	});

	it("新规格起不来 → 保留旧实例，工具不下线", async () => {
		const dir = tempDir();
		writeMcpConfig(dir, { srv: { command: process.execPath, args: [FIXTURE] } });
		const b = bridge(dir);
		await b.load();
		const before = await callBridge(b, "pid");

		writeMcpConfig(dir, { srv: { command: "definitely-not-a-real-cmd-xyz", args: [] } });
		const summary = await b.reload();
		expect(summary).toEqual({ kept: 1, started: 0, stopped: 0, failed: 1, servers: 1, tools: 10 });
		expect(await callBridge(b, "pid")).toBe(before);
		expect(b.getServerStatus("srv")).toMatchObject({
			status: "running",
			usingPreviousConfig: true,
			error: expect.any(String),
		});

		writeMcpConfig(dir, { srv: { command: process.execPath, args: [FIXTURE] } });
		await b.reload();
		expect(await callBridge(b, "pid")).toBe(before);
		expect(b.getServerStatus("srv").usingPreviousConfig).toBeUndefined();
		expect(b.getServerStatus("srv").error).toBeUndefined();
	});

	it("dispose during initial loading prevents late tools and subsequent reload revival", async () => {
		const dir = tempDir();
		writeMcpConfig(dir, { srv: { command: process.execPath, args: [FIXTURE] } });
		const b = bridge(dir);
		const loading = b.load();
		b.dispose();
		await loading;
		expect(b.getTools()).toEqual([]);
		expect(b.getServerStatus("srv")).toEqual({ status: "stopped", tools: [] });
		expect(await b.reload()).toEqual({ kept: 0, started: 0, stopped: 0, failed: 0, servers: 0, tools: 0 });
	});

	it("dispose during replacement prevents an in-flight reload from restoring clients", async () => {
		const dir = tempDir();
		writeMcpConfig(dir, { srv: { command: process.execPath, args: [FIXTURE] } });
		const b = bridge(dir);
		await b.load();
		writeMcpConfig(dir, { srv: { command: process.execPath, args: [FIXTURE], env: { MCP_SLOW_MS: "0" } } });
		const replacing = b.reload();
		await Promise.resolve();
		b.dispose();
		await replacing;
		expect(b.hasServers()).toBe(false);
		expect(b.getTools()).toEqual([]);
		expect(b.getServerStatus("srv").error).toBeUndefined();
	});

	it("配置里删掉服务器 → 关掉它并清空工具表", async () => {
		const dir = tempDir();
		writeMcpConfig(dir, { srv: { command: process.execPath, args: [FIXTURE] } });
		const b = bridge(dir);
		await b.load();
		const before = await callBridge(b, "pid");

		writeMcpConfig(dir, {});
		const summary = await b.reload();
		expect(summary).toEqual({ kept: 0, started: 0, stopped: 1, failed: 0, servers: 0, tools: 0 });
		expect(b.getTools()).toEqual([]);
		await waitUntil(() => !isAlive(before));
	});
});

describe("parseMcpConfig：mcp.json 里的 protocolVersion", () => {
	it("string 型 protocolVersion 被保留进规格，快照能区分版本差异", () => {
		const parsed = parseMcpConfig(
			JSON.stringify({ servers: { srv: { command: "node", args: ["mcp.js"], protocolVersion: "2025-06-18" } } }),
		);
		expect(parsed?.servers.srv.protocolVersion).toBe("2025-06-18");
		expect(mcpServerSnapshot({ command: "node", args: ["mcp.js"], protocolVersion: "2025-06-18" })).not.toEqual(
			mcpServerSnapshot({ command: "node", args: ["mcp.js"] }),
		);
	});

	it("非 string 的 protocolVersion 按缺省丢弃（与 cwd 同策略）", () => {
		const parsed = parseMcpConfig(JSON.stringify({ servers: { srv: { command: "node", protocolVersion: 42 } } }));
		expect(parsed?.servers.srv.protocolVersion).toBeUndefined();
	});
});

describe("expandEnvVars 环境变量占位符替换", () => {
	it("替换 ${VAR} 为对应环境变量，不存在时回退为空串", () => {
		process.env.TEST_MCP_KEY = "secret_123";
		expect(expandEnvVars("Bearer ${TEST_MCP_KEY}")).toBe("Bearer secret_123");
		expect(expandEnvVars("${TEST_MCP_KEY}:${NON_EXISTENT_VAR_ABC}")).toBe("secret_123:");
		delete process.env.TEST_MCP_KEY;
	});
});

describe("HTTP / streamable-http MCP 服务器支持 (Issue #641)", () => {
	let server: Server;
	let serverUrl: string;
	let receivedHeaders: Record<string, string | string[] | undefined> = {};
	let sessionDeleteCalled = false;
	let forceSessionExpiredOnce = false;
	let toolsListCount = 0;
	let dynamicToolAdded = false;

	beforeEach(async () => {
		sessionDeleteCalled = false;
		forceSessionExpiredOnce = false;
		toolsListCount = 0;
		dynamicToolAdded = false;
		receivedHeaders = {};

		server = createServer(async (req, res) => {
			receivedHeaders = { ...req.headers };
			if (req.method === "DELETE") {
				sessionDeleteCalled = true;
				res.writeHead(200);
				res.end();
				return;
			}

			let body = "";
			for await (const chunk of req) {
				body += chunk;
			}
			const json = body ? (JSON.parse(body) as { id?: number | string; method?: string; params?: any }) : {};

			if (json.method === "initialize") {
				res.setHeader("Content-Type", "application/json");
				res.setHeader("Mcp-Session-Id", "sess-test-456");
				res.writeHead(200);
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: json.id,
						result: {
							protocolVersion: "2025-03-26",
							capabilities: {},
							serverInfo: { name: "mock-http-mcp", version: "1.0.0" },
						},
					}),
				);
				return;
			}

			if (json.method === "notifications/initialized") {
				res.writeHead(202);
				res.end();
				return;
			}

			if (json.method === "tools/list") {
				toolsListCount++;
				const baseTools = [
					{
						name: "http_echo",
						description: "Echo via HTTP",
						inputSchema: { type: "object", properties: { val: { type: "string" } } },
					},
					{
						name: "http_sse",
						description: "Tool using SSE stream response",
						inputSchema: { type: "object" },
					},
					{
						name: "http_slow_with_progress",
						description: "Tool with progress notification",
						inputSchema: { type: "object" },
					},
				];
				if (dynamicToolAdded) {
					baseTools.push({
						name: "dynamic_tool_v2",
						description: "Dynamically added tool",
						inputSchema: { type: "object" },
					});
				}
				res.setHeader("Content-Type", "application/json");
				res.writeHead(200);
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: json.id,
						result: { tools: baseTools },
					}),
				);
				return;
			}

			if (json.method === "tools/call") {
				const toolName = json.params?.name;

				if (forceSessionExpiredOnce) {
					forceSessionExpiredOnce = false;
					res.setHeader("Content-Type", "application/json");
					res.writeHead(404);
					res.end(JSON.stringify({ error: "Session expired" }));
					return;
				}

				if (toolName === "http_echo") {
					res.setHeader("Content-Type", "application/json");
					res.writeHead(200);
					res.end(
						JSON.stringify({
							jsonrpc: "2.0",
							id: json.id,
							result: {
								content: [{ type: "text", text: `echo:${json.params?.arguments?.val}` }],
							},
						}),
					);
					return;
				}

				if (toolName === "http_sse") {
					res.setHeader("Content-Type", "text/event-stream");
					res.writeHead(200);
					res.write(
						`event: message\ndata: ${JSON.stringify({
							jsonrpc: "2.0",
							id: json.id,
							result: { content: [{ type: "text", text: "sse-stream-result" }] },
						})}\n\n`,
					);
					res.end();
					return;
				}

				if (toolName === "trigger_refresh") {
					dynamicToolAdded = true;
					res.setHeader("Content-Type", "text/event-stream");
					res.writeHead(200);
					res.write(
						`event: message\ndata: ${JSON.stringify({
							jsonrpc: "2.0",
							method: "notifications/tools/list_changed",
						})}\n\n`,
					);
					setTimeout(() => {
						res.write(
							`event: message\ndata: ${JSON.stringify({
								jsonrpc: "2.0",
								id: json.id,
								result: { content: [{ type: "text", text: "refresh-done" }] },
							})}\n\n`,
						);
						res.end();
					}, 20);
					return;
				}

				if (toolName === "http_slow_abortable") {
					setTimeout(() => {
						try {
							res.writeHead(200);
							res.end(JSON.stringify({ jsonrpc: "2.0", id: json.id, result: { content: [] } }));
						} catch {}
					}, 600);
					return;
				}

				if (toolName === "http_slow_with_progress") {
					res.setHeader("Content-Type", "text/event-stream");
					res.writeHead(200);
					const progressToken = json.params?._meta?.progressToken;
					setTimeout(() => {
						res.write(
							`event: message\ndata: ${JSON.stringify({
								jsonrpc: "2.0",
								method: "notifications/progress",
								params: { progressToken, progress: 50, total: 100 },
							})}\n\n`,
						);
					}, 50);
					setTimeout(() => {
						res.write(
							`event: message\ndata: ${JSON.stringify({
								jsonrpc: "2.0",
								id: json.id,
								result: { content: [{ type: "text", text: "progress-done" }] },
							})}\n\n`,
						);
						res.end();
					}, 100);
					return;
				}
			}

			res.writeHead(404);
			res.end();
		});

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => {
				const addr = server.address() as { port: number };
				serverUrl = `http://127.0.0.1:${addr.port}`;
				resolve();
			});
		});
	});

	afterEach(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	it("成功连接 HTTP MCP 服务器并完成握手与工具枚举", async () => {
		process.env.TEST_AUTH_TOKEN = "bearer_token_xyz";
		const client = new McpClient(
			"http-test",
			{
				url: serverUrl,
				headers: { Authorization: "Bearer ${TEST_AUTH_TOKEN}" },
			},
			() => {},
		);
		clients.push(client);

		await client.start();
		expect(client.isHttp).toBe(true);
		expect(client.getTools().map((t) => t.name)).toEqual(["http_echo", "http_sse", "http_slow_with_progress"]);
		expect(receivedHeaders["authorization"]).toBe("Bearer bearer_token_xyz");
		expect(receivedHeaders["mcp-session-id"]).toBe("sess-test-456");
		delete process.env.TEST_AUTH_TOKEN;
	});

	it("调用常规 JSON 工具与 SSE 流式工具", async () => {
		const client = new McpClient("http-test", { url: serverUrl }, () => {});
		clients.push(client);
		await client.start();

		const echo = (await client.call("http_echo", { val: "hello" })) as { content: string };
		expect(echo.content).toBe("echo:hello");

		const sse = (await client.call("http_sse", {})) as { content: string };
		expect(sse.content).toBe("sse-stream-result");
	});

	it("配置 timeout 生效：超时后正常抛出超时错误", async () => {
		const client = new McpClient(
			"http-timeout-test",
			{
				url: serverUrl,
				timeout: 0.05,
			},
			() => {},
		);
		clients.push(client);
		await client.start();

		await expect(client.call("http_slow_with_progress", {}, 30)).rejects.toThrow(/超时/);
	});

	it("收到 progress 通知时重置超时计时器，长耗时调用成功返回", async () => {
		const client = new McpClient(
			"http-progress-test",
			{
				url: serverUrl,
				timeout: 0.08,
			},
			() => {},
		);
		clients.push(client);
		await client.start();

		const res = (await client.call("http_slow_with_progress", {})) as { content: string };
		expect(res.content).toBe("progress-done");
	});

	it("HTTP 会话失效时自动重新握手自愈", async () => {
		const client = new McpClient("http-retry-test", { url: serverUrl }, () => {});
		clients.push(client);
		await client.start();

		forceSessionExpiredOnce = true;
		const res = (await client.call("http_echo", { val: "after_expired" })) as { content: string };
		expect(res.content).toBe("echo:after_expired");
		expect(client.startCount).toBe(2);
	});

	it("关闭 HTTP 客户端时尝试向服务端发送 DELETE 注销", async () => {
		const client = new McpClient("http-close-test", { url: serverUrl }, () => {});
		clients.push(client);
		await client.start();
		expect(sessionDeleteCalled).toBe(false);

		client.close();
		await new Promise((r) => setTimeout(r, 50));
		expect(sessionDeleteCalled).toBe(true);
	});

	it("McpBridge 可以聚合 HTTP MCP 工具并执行调用", async () => {
		const bridge = new McpBridge("/nonexistent", () => {}, {
			specOverride: [{ name: "remote_srv", spec: { url: serverUrl, timeout: 5 } }],
		});
		await bridge.load();
		const tools = bridge.getTools();
		expect(tools.length).toBe(3);
		const echoTool = tools.find((t) => t.name === "http_echo")!;
		expect(echoTool.label).toContain("remote_srv");

		const res = (await echoTool.execute("id", { val: "bridge_ok" })) as { content: string };
		expect(res.content).toBe("echo:bridge_ok");
		bridge.dispose();
	});

	it("notifications/tools/list_changed 通知自动重新拉取工具列表", async () => {
		let toolsChangedCount = 0;
		const bridge = new McpBridge("/nonexistent", () => {}, {
			specOverride: [{ name: "remote_srv", spec: { url: serverUrl, timeout: 5 } }],
			onToolsChanged: () => {
				toolsChangedCount++;
			},
		});
		await bridge.load();
		expect(bridge.getTools().length).toBe(3);

		const client = (bridge as any).clients[0] as McpClient;
		await client.call("trigger_refresh", {});

		await waitUntil(() => bridge.getTools().length === 4, 2000);
		expect(bridge.getTools().map((t) => t.name)).toContain("dynamic_tool_v2");
		expect(toolsChangedCount).toBeGreaterThanOrEqual(1);
		bridge.dispose();
	});

	it("传入 AbortSignal 时可主动取消在途工具调用", async () => {
		const client = new McpClient("http-abort-test", { url: serverUrl }, () => {});
		clients.push(client);
		await client.start();

		const ac = new AbortController();
		setTimeout(() => ac.abort(), 40);

		await expect(client.call("http_slow_abortable", {}, 2000, ac.signal)).rejects.toThrow(/aborted/i);
	});
});
