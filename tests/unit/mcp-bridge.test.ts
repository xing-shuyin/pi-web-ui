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
 *  - 非文本块映射：image（screenshot）、resource（pdf/textfile）、混合保序（mixed）
 *  - 自愈：子进程崩溃（crash 工具）/ 启动即退出 → 在途请求立即报错而非挂超时、下一次调用自动重启
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
	it("start 握手 + 列出 9 个工具", async () => {
		const c = client();
		await c.start();
		const names = c.getTools().map((t) => t.name);
		expect(names).toEqual(["echo", "add", "fail", "slow", "screenshot", "pdf", "textfile", "mixed", "crash"]);
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

	it("textfile 的文本型 resource 不丢正文（按文本形状返回）", async () => {
		const c = client();
		await c.start();
		// TextResourceContents（resource.text）是真实正文，不是「无法内联的二进制」：
		// 与普通 text 工具同形返回（纯文本结果仍是拼接字符串）。
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
		// 首次调用 crash：子进程自杀 → 在途请求被立刻拒绝（不是挂 60s 超时）
		await expect(c.call("crash", {}, 1000)).rejects.toThrow(/进程退出/);
		expect(c.startCount).toBe(1);
		// 下一次调用：惰性重启 + 重新握手拉取工具列表，服务恢复
		const echo = (await c.call("echo", { msg: "重启后" })) as { content: string };
		expect(JSON.parse(echo.content)).toEqual({ msg: "重启后" });
		expect(c.startCount).toBe(2);
		expect(c.getTools().map((t) => t.name)).toContain("crash");
	});

	it("启动即退出的服务器：每次调用都快速报「自动重启失败」的明确错误，不挂死", async () => {
		const c = new McpClient("gone", { command: process.execPath, args: ["-e", "process.exit(7)"] }, () => {});
		clients.push(c);
		// 进程一启动就 exit(7)，握手请求被立刻拒绝 → 错误信息里带根因，而不是等到 60s 超时
		await expect(c.call("echo", {}, 1000)).rejects.toThrow(/自动重启失败.*进程退出/);
		// 下次调用同样快速失败（每次都尝试重启，不累积成永久坏状态）
		await expect(c.call("echo", {}, 1000)).rejects.toThrow(/自动重启失败/);
	});

	it("close 之后不再重启：调用报「客户端已关闭」", async () => {
		const c = client();
		await c.start();
		c.close();
		await expect(c.call("echo", {}, 1000)).rejects.toThrow(/客户端已关闭/);
	});
});

describe("McpBridge 聚合适配", () => {
	it("load 启动并适配成 PluginAgentTool（execute 经 MCP 转发）", async () => {
		const bridge = new McpBridge("/nonexistent", () => {}, {
			specOverride: [{ name: "csrv", spec: { command: process.execPath, args: [FIXTURE] } }],
		});
		await bridge.load();
		const tools = bridge.getTools();
		expect(tools.length).toBe(9);
		const add = tools.find((t) => t.name === "add")!;
		expect(add.label).toContain("csrv");
		expect(typeof add.execute).toBe("function");
		// 直接调用 execute（不经 LLM）
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
		// 崩溃调用：在途请求被立刻拒绝
		await expect(crash.execute("id", {})).rejects.toThrow(/进程退出/);
		// 随后的普通工具调用 = 用户视角的「自动恢复」
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
		// call 用 ~80ms 小超时
		await expect(c.call("slow", {}, 80)).rejects.toThrow(/超时/);
	});
});
