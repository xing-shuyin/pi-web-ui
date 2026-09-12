/**
 * MCP 工具桥单测（纯 node，毫秒级、零 token、零端口）：
 * 直接实例化 McpClient 连本地夹具服务器，跑真正的 JSON-RPC 握手与工具调用。
 *
 * 覆盖：
 *  - 握手（initialize → initialized → tools/list）
 *  - 工具调用 echo / add（正参 → 结果）
 *  - 错误工具 fail → isError → 抛错
 *  - 未知工具 / 最上层 McpBridge.load + getTools 适配
 *  - slow 超时（MCP_SLOW_MS 注入短延迟）
 *  - 非文本块映射：image（screenshot）、resource（pdf）、混合保序（mixed）
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { McpBridge, McpClient } from "../../server/mcp-bridge.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// 夹具服务器：转成 .mjs 直接给 node 跑
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
		} catch {
			/* 已关 */
		}
	}
	clients.length = 0;
});

describe("McpClient 握手与工具", () => {
	it("start 握手 + 列出 7 个工具", async () => {
		const c = client();
		await c.start();
		const names = c.getTools().map((t) => t.name);
		expect(names).toEqual(["echo", "add", "fail", "slow", "screenshot", "pdf", "mixed"]);
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
		// base64 必须逐字保留（改写/截断都会毁掉图片）
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
		// blob "JVBERi0xLjQK" = 12 个 base64 字符 ≈ 9 字节
		expect(res.content[0].text).toContain("9 字节");
	});

	it("mixed 保序透传（文本块在前、图片块在后）", async () => {
		const c = client();
		await c.start();
		const res = (await c.call("mixed", {})) as { content: Array<{ type: string; text?: string }> };
		expect(res.content.map((b) => b.type)).toEqual(["text", "image"]);
		expect(res.content[0].text).toBe("文本在前");
	});
});

describe("McpBridge 聚合适配", () => {
	it("load 启动并适配成 PluginAgentTool（execute 经 MCP 转发）", async () => {
		const bridge = new McpBridge("/nonexistent", () => {}, {
			specOverride: [{ name: "csrv", spec: { command: process.execPath, args: [FIXTURE] } }],
		});
		await bridge.load();
		const tools = bridge.getTools();
		expect(tools.length).toBe(7);
		const add = tools.find((t) => t.name === "add")!;
		expect(add.label).toContain("csrv");
		expect(typeof add.execute).toBe("function");
		// 直接调用 execute（不经 LLM）
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
		// call 用 ~80ms 小超时
		await expect(c.call("slow", {}, 80)).rejects.toThrow(/超时/);
	});
});
