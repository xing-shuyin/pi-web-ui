#!/usr/bin/env node
/**
 * MCP 测试夹具服务器 —— 极简 NDJSON JSON-RPC 实现，用作 mcp-bridge 的对手端。
 * 工具：echo（原样回传 parameters）、add（a+b）、fail（isError 工具）、
 * slow（延迟后返回，用于校验超时）、screenshot（image 块）、pdf（资源 blob 块）、
 * textfile（资源 text 块）、mixed（文本 + 图片混合块，校验保序透传）、
 * crash（收到调用即 process.exit 自杀，模拟 MCP 服务器崩溃，校验桥的自愈重启）。
 * 用法：node mcp-echo-server.mjs [delay-resp-ms]
 */
import { createInterface } from "node:readline";

const RESP_DELAY = Number(process.argv[2] ?? 0);

const TOOLS = [
	{
		name: "echo",
		description: "原样返回传入的 parameters 对象",
		inputSchema: { type: "object", properties: { msg: { type: "string" } } },
	},
	{
		name: "add",
		description: "两个数相加",
		inputSchema: {
			type: "object",
			properties: { a: { type: "number" }, b: { type: "number" } },
			required: ["a", "b"],
		},
	},
	{ name: "fail", description: "总是失败（isError）", inputSchema: { type: "object" } },
	{ name: "slow", description: "睡眠 resp-delay 后返回", inputSchema: { type: "object" } },
	{ name: "screenshot", description: "返回一张 PNG 图片（image 块）", inputSchema: { type: "object" } },
	{ name: "pdf", description: "返回一个 PDF 资源（resource 块，blob）", inputSchema: { type: "object" } },
	{ name: "textfile", description: "返回一个文本资源（resource 块，text）", inputSchema: { type: "object" } },
	{ name: "mixed", description: "文本 + 图片混合结果", inputSchema: { type: "object" } },
	{ name: "crash", description: "调用即自杀（模拟 MCP 服务器崩溃）", inputSchema: { type: "object" } },
];

function reply(msg) {
	process.stdout.write(JSON.stringify(msg) + "\n");
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
	const raw = line.trim();
	if (!raw) return;
	let msg;
	try {
		msg = JSON.parse(raw);
	} catch {
		return;
	}
	// notification（无 id）
	if (msg.id === undefined) return;

	if (msg.method === "initialize") {
		return finish(msg.id, {
			protocolVersion: "2025-03-26",
			capabilities: { tools: {} },
			serverInfo: { name: "mcp-echo", version: "1.0.0" },
		});
	}
	if (msg.method === "tools/list") {
		return finish(msg.id, { tools: TOOLS });
	}
	if (msg.method === "tools/call") {
		const { name, arguments: args } = msg.params ?? {};
		if (name === "echo") return finish(msg.id, { content: [{ type: "text", text: JSON.stringify(args ?? {}) }] });
		if (name === "add") {
			const s = (args?.a ?? 0) + (args?.b ?? 0);
			return finish(msg.id, { content: [{ type: "text", text: String(s) }] });
		}
		if (name === "fail") {
			return finish(msg.id, {
				content: [{ type: "text", text: "boom: 已知的失败" }],
				isError: true,
			});
		}
		if (name === "slow") {
			// 用进程参数里的延迟；默认 5000ms（测试里会注入更小的波长 → 超时）
			const d = Number(process.env.MCP_SLOW_MS ?? 5000);
			return setTimeout(() => finish(msg.id, { content: [{ type: "text", text: "slow done" }] }), d);
		}
		if (name === "screenshot") {
			return finish(msg.id, {
				content: [
					{
						type: "image",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
						mimeType: "image/png",
					},
				],
			});
		}
		if (name === "pdf") {
			return finish(msg.id, {
				content: [
					{
						type: "resource",
						resource: {
							uri: "obscura://capture/current-page.pdf",
							mimeType: "application/pdf",
							blob: "JVBERi0xLjQK",
						},
					},
				],
			});
		}
		if (name === "textfile") {
			return finish(msg.id, {
				content: [
					{
						type: "resource",
						resource: {
							uri: "file:///tmp/notes.txt",
							mimeType: "text/plain",
							text: "文本资源正文",
						},
					},
				],
			});
		}
		if (name === "mixed") {
			return finish(msg.id, {
				content: [
					{ type: "text", text: "文本在前" },
					{
						type: "image",
						data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
						mimeType: "image/png",
					},
				],
			});
		}
		if (name === "crash") {
			// 模拟崩溃：不等应答直接退出（非零退出码），观察桥端是否自愈重启。
			return process.exit(2);
		}
		return finish(msg.id, {
			content: [{ type: "text", text: `unknown tool: ${name}` }],
			isError: true,
		});
	}
	if (msg.method === "shutdown") {
		return finish(msg.id, null);
	}
	return finish(msg.id, null);
});

function finish(id, result) {
	if (RESP_DELAY) setTimeout(() => reply({ jsonrpc: "2.0", id, result }), RESP_DELAY);
	else reply({ jsonrpc: "2.0", id, result });
}

process.stdin.resume();
