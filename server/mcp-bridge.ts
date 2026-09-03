/**
 * MCP 工具桥 —— 把外部 Model Context Protocol（stdio）服务器暴露的工具接入
 * pi 会话，让 AI 能调用真实的第三方工具（文件、数据库、GitHub…）。
 *
 * 约定（MCP 规范流式子集）：
 *  - stdio 传输 = stdin/stdout 上换行分隔的 JSON-RPC 2.0（NDJSON），不依赖任何
 *    第三方包；stderr 是自由日志通道。
 *  - 握手：initialize（带 protocolVersion）→ notifications/initialized →
 *    tools/list → tools/call。
 *  - 工具工具入会：本模块把每个远端工具适配成 PluginAgentTool，经
 *    pluginToolsProvider 走与插件工具完全相同的 customTools 管线。
 *
 * 配置：<PI_WEB_DATA_DIR>/mcp.json，形如
 *   { "servers": { "gitserv": { "command": "node", "args": ["mcp.js"], "cwd": "/x" } } }
 */

import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginAgentTool } from "./plugins.js";

/** JSON-RPC 2.0 over stdio：每行一条 JSON。 */
export interface McpServerSpec {
	command: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	// 预设的 MCP 协议版本（缺省用最新已知）。
	protocolVersion?: string;
}

interface RpcIncoming {
	id?: number | string;
	method?: string;
	params?: { [k: string]: unknown };
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

const PROTOCOL_VERSION = "2025-03-26"; // 广泛支持的工具版本

let rpcSeq = 0;

/**
 * 单个 MCP 服务器的客户端：管理子进程、请求/响应按 id 关联、握手与工具调用。
 * 线程模型：无需并发控制（MCP 允许乱序 + 我们按请求 id 匹配响应）。
 */
export class McpClient {
	private child: ChildProcess | null = null;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<
		string,
		{ resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
	>();
	private log: (...a: unknown[]) => void;
	readonly name: string;
	/** 已握手的工具列表（tools/list 结果缓存）。 */
	private tools: McpToolDefinition[] = [];
	private shuttingDown = false;

	constructor(
		name: string,
		private spec: McpServerSpec,
		log?: (...a: unknown[]) => void,
	) {
		this.name = name;
		this.log = log ?? (() => {});
	}

	/** 启动子进程 + 握手 + 拉取工具列表。 */
	async start(_timeoutMs = 8000): Promise<void> {
		if (this.child) return;
		const { command, args = [], cwd, env } = this.spec;
		this.log(`[mcp:${this.name}] starting: ${command} ${args.join(" ")}`);
		const child = spawn(command, args, {
			cwd: cwd ?? undefined,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
		child.stderr.on("data", (d) => this.log(`[mcp:${this.name}] stderr:`, d.toString().trimEnd()));
		child.on("error", (err) => this.rejectAll(new Error(`[mcp:${this.name}] spawn error: ${err.message}`)));
		child.on("exit", (code, sig) => {
			this.child = null;
			if (!this.shuttingDown) this.rejectAll(new Error(`[mcp:${this.name}] 进程退出 (${sig ?? code})`));
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onData(chunk));

		// 握手
		const handshake = await this.request("initialize", {
			protocolVersion: this.spec.protocolVersion ?? PROTOCOL_VERSION,
			capabilities: {},
			clientInfo: { name: "pi-web-ui", version: "0.41.0" },
		});
		const version =
			(handshake as { protocolVersion?: string })?.protocolVersion ?? this.spec.protocolVersion ?? PROTOCOL_VERSION;
		// 通知 initialized（无 id 的 notification）
		this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
		// 仍以协商协议版本调用 tools（多数服务器对新版本容忍，这里用协商结果）
		void version;
		const listed = ((await this.request("tools/list", {})) ?? {}) as {
			tools?: McpToolDefinition[];
		};
		this.tools = Array.isArray(listed.tools) ? listed.tools : [];
		this.log(`[mcp:${this.name}] ready, ${this.tools.length} tools`);
	}

	/** 已发现工具。 */
	getTools(): McpToolDefinition[] {
		return this.tools.map((t) => ({ ...t }));
	}

	/** 调用一个工具，返回结果文本（多 content 拼接为 JSON 字符串保真）。 */
	async call(name: string, args: Record<string, unknown>, timeoutMs = 60000): Promise<unknown> {
		const res = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as {
			content?: Array<{ type?: string; text?: string }>;
			isError?: boolean;
			structuredContent?: unknown;
		};
		if (res?.isError) {
			const msg =
				(res.content ?? [])
					.map((c) => c.text ?? "")
					.join("\n")
					.trim() || "MCP 工具错误";
			throw new Error(msg);
		}
		// 结构化结果优先，其次文本内容。
		if (res?.structuredContent !== undefined) return res.structuredContent;
		const text = (res.content ?? [])
			.map((c) => c.text ?? "")
			.filter((x) => x)
			.join("\n");
		return { content: text, isError: !!res.isError };
	}

	/** 关闭：kill 子进程，拒绝所有在途请求。 */
	close(): void {
		this.shuttingDown = true;
		this.rejectAll(new Error("[mcp] client closed"));
		if (this.child) {
			try {
				this.child.kill();
			} catch {
				/* 已退出 */
			}
			this.child = null;
		}
	}

	// -- 内部 -------------------------------------------------------------
	private send(msg: unknown): void {
		const stdin = this.child?.stdin;
		if (!stdin || !stdin.writable) return;
		stdin.write(JSON.stringify(msg) + "\n");
	}

	private request(method: string, params: Record<string, unknown>, timeoutMs = 8000): Promise<unknown> {
		const id = rpcSeq++;
		const outId = String(id);
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(outId);
				reject(new Error(`[mcp:${this.name}] ${method} 超时 (${timeoutMs}ms)`));
			}, timeoutMs);
			this.pending.set(outId, { resolve, reject, timer });
			this.send({ jsonrpc: "2.0", id: id, method, params });
		});
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
		let nl: number;
		while ((nl = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (!line) continue;
			let msg: RpcIncoming;
			try {
				msg = JSON.parse(line) as RpcIncoming;
			} catch {
				this.log(`[mcp:${this.name}] 非 JSON 行（忽略）：`, line.slice(0, 120));
				continue;
			}
			this.handleMessage(msg);
		}
	}

	private handleMessage(msg: RpcIncoming): void {
		if (msg.id !== undefined) {
			const pending = this.pending.get(String(msg.id));
			if (!pending) {
				this.log(`[mcp:${this.name}] 未知响应 id=${msg.id}`);
				return;
			}
			this.pending.delete(String(msg.id));
			clearTimeout(pending.timer);
			if (msg.error) pending.reject(new Error(`[mcp:${this.name}] ${msg.error.message ?? "MCP 错误"}`));
			else pending.resolve(msg.result);
			return;
		}
		// 服务端主动通知（log / cancelled 等）——仅记录。
		if (msg.method === "notifications/message") {
			const p = msg.params as { level?: string; message?: string } | undefined;
			if (p?.message) this.log(`[mcp:${this.name}] ${p.level ?? "message"}:`, p.message);
		}
	}

	private rejectAll(err: Error): void {
		for (const [, p] of this.pending) {
			clearTimeout(p.timer);
			p.reject(err);
		}
		this.pending.clear();
	}
}

export interface McpToolDefinition {
	name: string;
	description?: string;
	inputSchema?: Record<string, unknown>;
}

/** 读取 <dataDir>/mcp.json 里的服务器清单（尽力而为）。 */
export function readMcpConfig(dataDir: string): { servers: Record<string, McpServerSpec> } {
	try {
		const raw = JSON.parse(readFileSync(join(dataDir, "mcp.json"), "utf8")) as {
			servers?: Record<string, McpServerSpec>;
		};
		const servers: Record<string, McpServerSpec> = {};
		for (const [name, s] of Object.entries(raw.servers ?? {})) {
			if (!s || typeof s.command !== "string" || !s.command.trim()) continue;
			servers[name] = {
				command: s.command,
				args: Array.isArray(s.args) ? s.args.map(String) : [],
				cwd: typeof s.cwd === "string" ? s.cwd : undefined,
				env: s.env && typeof s.env === "object" ? (s.env as Record<string, string>) : undefined,
			};
		}
		return { servers };
	} catch {
		return { servers: {} };
	}
}

/**
 * 整个 MCP 管理器的工具适配：把每个 MCP 工具变成 PluginAgentTool。
 * getAllToolsTool(name, callFn) 生成 execute → 转发到对应 McpClient.call。
 */
function adaptMcpTool(serverName: string, mcpTool: McpToolDefinition, client: McpClient): PluginAgentTool {
	const name = sanitizeToolName(mcpTool.name);
	return {
		name,
		label: `${serverName} · ${mcpTool.name}`,
		description: mcpTool.description ?? `从 MCP 服务器「${serverName}」提供的工具 ${mcpTool.name}`,
		parameters: mcpTool.inputSchema ?? {},
		execute: async (_toolCallId: string, params: Record<string, unknown>, _signal?: AbortSignal) => {
			return client.call(mcpTool.name, params ?? {});
		},
	};
}

/** 工具名必须是 [A-Za-z0-9_-]+（与插件工具同规则），MCP 可能含冒号/斜杠 — 归一化。 */
function sanitizeToolName(name: string): string {
	const cleaned = (name || "").replace(/[^A-Za-z0-9_-]/g, "_");
	return cleaned || "mcp_tool";
}

/** MCP 服务器管理器：自管多服务器生命周期 + 聚合工具。 */
export class McpBridge {
	private clients: McpClient[] = [];
	private tools: PluginAgentTool[] = [];

	constructor(
		private dataDir: string,
		private log: (...a: unknown[]) => void = () => {},
		private opts: { specOverride?: { name: string; spec: McpServerSpec }[] } = {},
	) {}

	/** 读取配置并启动全部服务器（顺序 fail-fast：单个失败记日志不拖垮其它）。 */
	async load(): Promise<void> {
		const cfg = optsOverrideOrRead(this.opts.specOverride, this.dataDir);
		await Promise.all(
			Object.entries(cfg.servers).map(async ([name, spec]) => {
				try {
					const client = new McpClient(name, spec, this.log);
					await client.start();
					this.clients.push(client);
					for (const t of client.getTools()) this.tools.push(adaptMcpTool(name, t, client));
				} catch (err) {
					this.log(`[mcp] 服务器「${name}」启动失败：`, err instanceof Error ? err.message : err);
				}
			}),
		);
	}

	getTools(): PluginAgentTool[] {
		return this.tools;
	}

	hasServers(): boolean {
		return this.clients.length > 0;
	}

	dispose(): void {
		for (const c of this.clients) c.close();
		this.clients = [];
		this.tools = [];
	}
}

function optsOverrideOrRead(
	specOverride: { name: string; spec: McpServerSpec }[] | undefined,
	dataDir: string,
): {
	servers: Record<string, McpServerSpec>;
} {
	if (specOverride && specOverride.length > 0) {
		const servers: Record<string, McpServerSpec> = {};
		for (const o of specOverride) servers[o.name] = o.spec;
		return { servers };
	}
	return readMcpConfig(dataDir);
}
