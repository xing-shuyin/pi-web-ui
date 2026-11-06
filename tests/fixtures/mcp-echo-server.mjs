#!/usr/bin/env node
import { createInterface } from "node:readline";

const RESP_DELAY = Number(process.argv[2] ?? 0);
let handshaken = false;

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
	{ name: "pid", description: "返回服务进程的 pid（校验子进程有没有被重启）", inputSchema: { type: "object" } },
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
	if (msg.id === undefined) return;

	if (msg.method === "initialize") {
		return finish(
			msg.id,
			{
				protocolVersion: "2025-03-26",
				capabilities: { tools: {} },
				serverInfo: { name: "mcp-echo", version: "1.0.0" },
			},
			() => {
				handshaken = true;
			},
		);
	}
	if (msg.method === "tools/list") {
		return finish(msg.id, { tools: TOOLS });
	}
	if (msg.method === "tools/call") {
		if (!handshaken) return replyError(msg.id, -32002, "Server not initialized");
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
			return process.exit(2);
		}
		if (name === "pid") {
			return finish(msg.id, { content: [{ type: "text", text: String(process.pid) }] });
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

function finish(id, result, onSent) {
	if (RESP_DELAY)
		setTimeout(() => {
			onSent?.();
			reply({ jsonrpc: "2.0", id, result });
		}, RESP_DELAY);
	else {
		onSent?.();
		reply({ jsonrpc: "2.0", id, result });
	}
}

function replyError(id, code, message) {
	reply({ jsonrpc: "2.0", id, error: { code, message } });
}

process.stdin.resume();
