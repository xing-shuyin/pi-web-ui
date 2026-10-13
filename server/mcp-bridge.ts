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
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PluginAgentTool } from "./plugins.js";
import type { UiMcpToolInfo } from "./protocol.js";

/** 获取全局 MCP 配置文件路径 */
export function getGlobalMcpPath(agentDir?: string, dataDir?: string): string {
	if (agentDir) {
		const agentPath = join(agentDir, "mcp.json");
		if (existsSync(agentPath)) return agentPath;
		if (dataDir && existsSync(join(dataDir, "mcp.json"))) return join(dataDir, "mcp.json");
		return agentPath;
	}
	if (process.env.PI_CODING_AGENT_DIR) {
		const envPath = join(process.env.PI_CODING_AGENT_DIR, "mcp.json");
		if (existsSync(envPath)) return envPath;
	}
	if (dataDir) {
		const dataPath = join(dataDir, "mcp.json");
		if (existsSync(dataPath)) return dataPath;
		return dataPath;
	}
	const defaultAgentDir = join(homedir(), ".pi", "agent");
	return join(defaultAgentDir, "mcp.json");
}

/** 获取项目级 MCP 配置文件路径 */
export function getProjectMcpPath(cwd?: string): string {
	const activeCwd = cwd || process.cwd();
	return join(activeCwd, ".pi", "mcp.json");
}

/** JSON-RPC 2.0 over stdio 或 HTTP：配置规格。 */
export interface McpServerSpec {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	type?: "stdio" | "http" | "streamable-http";
	timeout?: number;
	// 预设的 MCP 协议版本（缺省用最新已知）。
	protocolVersion?: string;
	enabled?: boolean;
	description?: string;
}

interface RpcIncoming {
	id?: number | string;
	method?: string;
	params?: { [k: string]: unknown };
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
}

/** MCP 服务器返回的内容块（规范子集：text / image / resource / audio…）。 */
interface McpContentBlock {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { uri?: string; mimeType?: string; text?: string; blob?: string } | string;
}

/** 桥透传给会话的内容块：text 原样；image 字段与 SDK 的 ImageContent（type/data/mimeType）一致。 */
type McpToolResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const PROTOCOL_VERSION = "2025-03-26"; // 广泛支持的工具版本

/** 单行（一条 JSON-RPC 消息）的长度上限（1MB）：失控服务器一行永不换行会顶爆内存。 */
const MCP_MAX_LINE_CHARS = 1024 * 1024;
/** 未换行数据的总缓冲上限（4MB）：服务器只吐垃圾不吐换行时按协议错误杀进程。
 *  上限按 JS 字符串长度计（UTF-16 码元 ≤ UTF-8 字节），内存放大有界。 */
const MCP_MAX_BUFFER_CHARS = 4 * 1024 * 1024;

let rpcSeq = 0;

/**
 * 单个 MCP 服务器的客户端：管理子进程、请求/响应按 id 关联、握手与工具调用。
 * 线程模型：无需并发控制（MCP 允许乱序 + 我们按请求 id 匹配响应）。
 * 自愈：子进程意外退出（崩溃/被杀）后不永久失效 —— 下一次工具调用会惰性重启并
 * 重新握手、重新拉取工具列表；显式 close() 之后才永久停用。
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
	/** 进行中的启动/重启（并发调用共享同一次重连）。 */
	private starting: Promise<void> | null = null;
	/** 已启动次数（含自愈重启；诊断/测试用）。 */
	private startedCount = 0;

	constructor(
		name: string,
		/** 启动规格；热加载按它判断「这个服务器要不要重启」（见 McpBridge.reload）。 */
		readonly spec: McpServerSpec,
		log?: (...a: unknown[]) => void,
	) {
		this.name = name;
		this.log = log ?? (() => {});
	}

	/** 启动子进程 + 握手 + 拉取工具列表。可安全重入：子进程退出后再次调用即全新启动。 */
	async start(timeoutMs = 8000): Promise<void> {
		if (this.child) return;
		const { command, args = [], cwd, env } = this.spec;
		if (!command) {
			if (this.spec.url) {
				throw new Error(`远程 HTTP MCP 服务器（${this.spec.url}）暂不支持 stdio 直接直连`);
			}
			throw new Error("MCP 服务器规格未声明 command 启动命令");
		}
		this.log(`[mcp:${this.name}] starting: ${command} ${args.join(" ")}`);
		this.buffer = "";
		const child = spawn(command, args, {
			cwd: cwd ?? undefined,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
		// 进程退出后向 stdin 写请求会触发 EPIPE —— 静默忽略（send 也会判 child 存活）。
		child.stdin?.on("error", () => {});
		child.stderr.on("data", (d) => this.log(`[mcp:${this.name}] stderr:`, d.toString().trimEnd()));
		child.on("error", (err) => this.rejectAll(new Error(`[mcp:${this.name}] spawn error: ${err.message}`)));
		child.on("exit", (code, sig) => {
			this.child = null;
			this.buffer = "";
			if (!this.shuttingDown) {
				this.log(`[mcp:${this.name}] 进程退出 (${sig ?? code})，下次调用将自动重启`);
				this.rejectAll(new Error(`[mcp:${this.name}] 进程退出 (${sig ?? code})`));
			}
		});
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onData(chunk));
		this.startedCount++;

		try {
			// 握手
			const handshake = await this.request(
				"initialize",
				{
					protocolVersion: this.spec.protocolVersion ?? PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "pi-web-ui", version: "0.41.0" },
				},
				timeoutMs,
			);
			const version =
				(handshake as { protocolVersion?: string })?.protocolVersion ?? this.spec.protocolVersion ?? PROTOCOL_VERSION;
			// 通知 initialized（无 id 的 notification）
			this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
			// 仍以协商协议版本调用 tools（多数服务器对新版本容忍，这里用协商结果）
			void version;
			const listed = ((await this.request("tools/list", {}, timeoutMs)) ?? {}) as {
				tools?: McpToolDefinition[];
			};
			this.tools = Array.isArray(listed.tools) ? listed.tools : [];
			this.log(`[mcp:${this.name}] ready, ${this.tools.length} tools`);
			// 若重启过程中被显式 close()，趁机回收刚启动的子进程，不留孤儿。
			if (this.shuttingDown) {
				try {
					child.kill();
				} catch {
					/* 已退出 */
				}
				if (this.child === child) this.child = null;
			}
		} catch (err) {
			// 启动/握手失败：回收本次子进程，避免泄漏；调用方可安全重试（自愈会再试）。
			try {
				child.kill();
			} catch {
				/* 已退出 */
			}
			if (this.child === child) this.child = null;
			throw err;
		}
	}

	/** 已启动次数（含自愈重启；诊断/测试用）。 */
	get startCount(): number {
		return this.startedCount;
	}

	/**
	 * 保活：子进程还活着就直接返回；已意外退出则惰性重启（并发调用共享同一次重连）。
	 * 显式 close() 后抛错，绝不复活。
	 */
	private async ensureStarted(timeoutMs: number): Promise<void> {
		if (this.shuttingDown) throw new Error(`[mcp:${this.name}] 客户端已关闭，不会重启`);
		// 先认「进行中的重连」再认 child：start() 是同步把 child 落位的，握手却还没完 ——
		// 此时若按 child 判存活就直接返回，并发的第二个调用会抢在 initialize 应答前发出
		// tools/call（严格实现会回「未初始化」）。共享同一个 promise 才能真正串行化。
		if (this.starting) return this.starting;
		if (this.child) return;
		this.starting = this.start(timeoutMs).finally(() => {
			this.starting = null;
		});
		await this.starting;
	}

	/** 已发现工具。 */
	getTools(): McpToolDefinition[] {
		return this.tools.map((t) => ({ ...t }));
	}

	/**
	 * 调用一个工具，返回其结果。
	 * 纯文本块拼接成字符串（老形状，向后兼容）；出现非文本块（image/resource/audio 等）时按序透传或退化提示，不再静默丢弃。
	 */
	async call(name: string, args: Record<string, unknown>, timeoutMs = 60000): Promise<unknown> {
		if (this.shuttingDown) throw new Error(`[mcp:${this.name}] 客户端已关闭，不会重启`);
		try {
			// 自愈：子进程已退出（非主动关闭）→ 先惰性重启再发；重启失败给出明确错误而不是挂 60s 超时。
			await this.ensureStarted(8000);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`[mcp:${this.name}] 服务器进程已退出且自动重启失败：${detail}`);
		}
		const res = (await this.request("tools/call", { name, arguments: args }, timeoutMs)) as {
			content?: McpContentBlock[];
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
		// 结构化结果优先，其次内容块。
		if (res?.structuredContent !== undefined) return res.structuredContent;
		const blocks: McpToolResultBlock[] = [];
		let hasNonText = false;
		for (const c of res.content ?? []) {
			if (c.type === "image" && typeof c.data === "string" && c.data) {
				// MCP image 块字段（type/data/mimeType）与 SDK 的 ImageContent 完全一致，原样透传；
				// 超大图由 SDK 的 normalizeToolResultImages 统一缩放（afterToolCall 钩子，默认 autoResize）。
				blocks.push({ type: "image", data: c.data, mimeType: c.mimeType?.trim() || "image/png" });
				hasNonText = true;
				continue;
			}
			if (c.type && c.type !== "text") {
				const r = typeof c.resource === "object" && c.resource !== null ? c.resource : {};
				// MCP 的 EmbeddedResource 有两种承载：TextResourceContents（resource.text）与
				// BlobResourceContents（resource.blob）。文本型带真实正文（filesystem 类 MCP 的
				// read_text_file 就走这条），当文本透传 —— 退化成「已跳过」等于把文件内容吞掉。
				if (typeof r.text === "string" && r.text) {
					blocks.push({ type: "text", text: r.text });
					continue;
				}
				// resource(blob)/audio 等块在 SDK 内容联合里没有载体（只有 text|image|thinking|toolCall），
				// 退化为文本提示，让模型至少知道工具返回了什么，而不是看到一个空串。
				const mime = (c.mimeType ?? r.mimeType ?? "").trim();
				const blob = typeof r.blob === "string" && r.blob ? r.blob : c.data;
				const size =
					typeof blob === "string" && blob ? `，约 ${Math.max(1, Math.round((blob.length * 3) / 4))} 字节` : "";
				blocks.push({
					type: "text",
					text: `[MCP 工具返回了非文本内容块（${mime || c.type || "未知类型"}${size}），当前会话无法内联，已跳过。]`,
				});
				hasNonText = true;
				continue;
			}
			const text = c.text ?? "";
			if (text) blocks.push({ type: "text", text });
		}
		if (!hasNonText) {
			// 纯文本结果保持旧形状（拼接字符串），不破坏既有调用方。
			return { content: blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n"), isError: !!res.isError };
		}
		return { content: blocks, isError: !!res.isError };
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
		// 总缓冲上限：服务器一直输出却不换行（或极慢地换行）时，缓冲会无限涨，
		// 宿主内存被一个失控子进程吃光。超限按协议错误处理：杀进程 + 拒绝在途请求。
		if (this.buffer.length > MCP_MAX_BUFFER_CHARS) {
			this.killForProtocolError(
				new Error(
					`[mcp:${this.name}] stdout 缓冲超过 ${Math.round(MCP_MAX_BUFFER_CHARS / 1024 / 1024)}MB 上限，按协议错误关闭`,
				),
			);
			return;
		}
		let nl: number;
		while ((nl = this.buffer.indexOf("\n")) >= 0) {
			const line = this.buffer.slice(0, nl).trim();
			this.buffer = this.buffer.slice(nl + 1);
			if (!line) continue;
			if (line.length > MCP_MAX_LINE_CHARS) {
				this.killForProtocolError(
					new Error(
						`[mcp:${this.name}] 单行超过 ${Math.round(MCP_MAX_LINE_CHARS / 1024 / 1024)}MB 上限，按协议错误关闭`,
					),
				);
				return;
			}
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

	/** 协议错误（stdout 缓冲超限）：杀掉子进程、拒绝全部在途请求、清空缓冲。
	 *  与进程自然退出共用自愈语义 —— 下一次工具调用会重新拉起并重新握手
	 *  （失控服务器重启后再次超限就再次杀，不会永久占用宿主内存）。 */
	private killForProtocolError(err: Error): void {
		this.log(err.message);
		this.buffer = "";
		const child = this.child;
		this.child = null;
		this.rejectAll(err);
		if (child) {
			try {
				child.kill();
			} catch {
				/* 已退出 */
			}
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

/**
 * 解析 <dataDir>/mcp.json 的文本 → 规范化服务器清单。
 * `null` = 不是合法 JSON 对象（**与「没有服务器」区分开**：热加载遇到坏配置要保留在跑的
 * 服务器，而 `{ "servers": {} }` 或删掉文件是「确实没有服务器」的明确意图）。
 */
export function parseMcpConfig(text: string): { servers: Record<string, McpServerSpec> } | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
	const servers: Record<string, McpServerSpec> = {};
	const raw =
		(parsed as { mcpServers?: Record<string, unknown>; servers?: Record<string, unknown> }).mcpServers ??
		(parsed as { servers?: Record<string, unknown> }).servers ??
		{};
	for (const [name, s] of Object.entries(raw)) {
		if (!s || typeof s !== "object") continue;
		const entry = s as Record<string, unknown>;
		const cmd = typeof entry.command === "string" && entry.command.trim() ? entry.command.trim() : undefined;
		const url = typeof entry.url === "string" && entry.url.trim() ? entry.url.trim() : undefined;
		if (!cmd && !url && entry.enabled === undefined) continue;
		servers[name] = {
			command: cmd,
			args: Array.isArray(entry.args) ? entry.args.map(String) : [],
			cwd: typeof entry.cwd === "string" ? entry.cwd : undefined,
			env: entry.env && typeof entry.env === "object" ? (entry.env as Record<string, string>) : undefined,
			url,
			headers:
				entry.headers && typeof entry.headers === "object" ? (entry.headers as Record<string, string>) : undefined,
			type: typeof entry.type === "string" ? (entry.type as McpServerSpec["type"]) : undefined,
			timeout: typeof entry.timeout === "number" ? entry.timeout : undefined,
			enabled: typeof entry.enabled === "boolean" ? entry.enabled : true,
			description: typeof entry.description === "string" ? entry.description : undefined,
			protocolVersion: typeof entry.protocolVersion === "string" ? entry.protocolVersion : undefined,
		};
	}
	return { servers };
}

/** 读取 <dataDir>/mcp.json 里的服务器清单（尽力而为）。 */
export function readMcpConfig(dataDir: string): { servers: Record<string, McpServerSpec> } {
	try {
		return parseMcpConfig(readFileSync(join(dataDir, "mcp.json"), "utf8")) ?? { servers: {} };
	} catch {
		return { servers: {} };
	}
}

/**
 * 服务器的规范化快照：只保留影响行为的字段，env 键序无关。
 * 热加载的「配置变了吗」与「这个服务器要不要重启」都按它比较 —— 改缩进、重排键名、加尾随
 * 换行都不算变更，不该重启任何子进程。
 */
export function mcpServerSnapshot(spec: McpServerSpec): Record<string, unknown> {
	const env: Record<string, string> = {};
	for (const k of Object.keys(spec.env ?? {}).sort()) env[k] = (spec.env as Record<string, string>)[k];
	const headers: Record<string, string> = {};
	for (const k of Object.keys(spec.headers ?? {}).sort()) headers[k] = (spec.headers as Record<string, string>)[k];
	return {
		command: spec.command ?? null,
		args: spec.args ?? [],
		cwd: spec.cwd ?? null,
		env,
		url: spec.url ?? null,
		headers,
		type: spec.type ?? null,
		timeout: spec.timeout ?? null,
		enabled: spec.enabled !== false,
		description: spec.description ?? null,
		protocolVersion: spec.protocolVersion ?? null,
	};
}

/** 两个规格是否等价（等价 = 该服务器的子进程不必重启）。 */
function sameMcpSpec(a: McpServerSpec, b: McpServerSpec): boolean {
	return JSON.stringify(mcpServerSnapshot(a)) === JSON.stringify(mcpServerSnapshot(b));
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
		description: mcpTool.description ?? `Tool ${mcpTool.name} provided by MCP server "${serverName}"`,
		// 无 snippet 的工具不会进系统提示词的「Available tools」清单（SDK 只列有
		// snippet 的工具），MCP 工具会变成 schema-only：模型读清单以为自己没有
		// 这个能力（#403）。这里从 description 提取首句做极简 snippet。
		promptSnippet: firstSentenceSnippet(mcpTool.description) ?? `MCP tool ${mcpTool.name} (server: ${serverName})`,
		parameters: mcpTool.inputSchema ?? {},
		execute: async (_toolCallId: string, params: Record<string, unknown>, _signal?: AbortSignal) => {
			return client.call(mcpTool.name, params ?? {});
		},
	};
}

/** 从 MCP 工具 description 提取首句做 promptSnippet（≤100 字符）；空描述返回 undefined。 */
function firstSentenceSnippet(description: string | undefined): string | undefined {
	const text = (description ?? "").replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	const cut = text.search(/[.。!?！?]/);
	const head = cut > 0 ? text.slice(0, cut + 1) : text;
	return head.length > 100 ? `${head.slice(0, 99)}…` : head;
}

/** 工具名必须是 [A-Za-z0-9_-]+（与插件工具同规则），MCP 可能含冒号/斜杠 — 归一化。 */
function sanitizeToolName(name: string): string {
	const cleaned = (name || "").replace(/[^A-Za-z0-9_-]/g, "_");
	return cleaned || "mcp_tool";
}

/** 一次热替换的结果：给日志/提示用，也是热加载回归测试的断言面。 */
export interface McpReloadSummary {
	/** 沿用原实例的服务器数（规格没变，或新规格启动失败后回退）—— 这部分没有重启进程。 */
	kept: number;
	/** 本次新启动成功的服务器数。 */
	started: number;
	/** 被关掉的旧实例数（配置里移除，或被新实例替换）。 */
	stopped: number;
	/** 新规格启动失败的服务器数。 */
	failed: number;
	/** 换入后的服务器数与工具总数。 */
	servers: number;
	tools: number;
}

export interface McpBridgeOptions {
	agentDir?: string;
	cwd?: string;
	specOverride?: { name: string; spec: McpServerSpec }[];
}

/** MCP 服务器管理器：自管多服务器生命周期 + 聚合工具。 */
export class McpBridge {
	private clients: McpClient[] = [];
	private tools: PluginAgentTool[] = [];
	private serverErrors = new Map<string, string>();
	/** reload 串行化链：重入的 reload 排在前一个之后，杜绝交叠留下的孤儿进程。 */
	private reloadChain: Promise<unknown> = Promise.resolve();
	private agentDir?: string;
	private cwd?: string;

	constructor(
		private dataDir: string,
		private log: (...a: unknown[]) => void = () => {},
		private opts: McpBridgeOptions = {},
	) {
		this.agentDir = opts.agentDir;
		this.cwd = opts.cwd;
	}

	setCwd(newCwd: string): void {
		this.cwd = newCwd;
		this.opts.cwd = newCwd;
	}

	getCwd(): string | undefined {
		return this.cwd;
	}

	getAgentDir(): string | undefined {
		return this.agentDir;
	}

	getServerStatus(name: string): {
		status: "running" | "stopped" | "error";
		error?: string;
		tools: UiMcpToolInfo[];
	} {
		const client = this.clients.find((c) => c.name === name);
		if (client) {
			return {
				status: "running",
				tools: client.getTools().map((t) => ({ name: t.name, description: t.description })),
			};
		}
		if (this.serverErrors.has(name)) {
			return {
				status: "error",
				error: this.serverErrors.get(name),
				tools: [],
			};
		}
		return { status: "stopped", tools: [] };
	}

	/** 读取配置并启动全部服务器（顺序 fail-fast：单个失败记日志不拖垮其它）。 */
	async load(): Promise<void> {
		this.serverErrors.clear();
		const cfg = optsOverrideOrRead(this.opts, this.dataDir);
		await Promise.all(
			Object.entries(cfg.servers).map(async ([name, spec]) => {
				if (spec.enabled === false) return;
				const client = await this.startOne(name, spec);
				if (!client) return;
				this.clients.push(client);
				for (const t of client.getTools()) this.tools.push(adaptMcpTool(name, t, client));
			}),
		);
	}

	/** 启动单个服务器：失败只记日志并返回 null（load / reload 共用）。 */
	private async startOne(name: string, spec: McpServerSpec): Promise<McpClient | null> {
		try {
			const client = new McpClient(name, spec, this.log);
			await client.start();
			this.serverErrors.delete(name);
			return client;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.serverErrors.set(name, msg);
			this.log(`[mcp] 服务器「${name}」启动失败：`, msg);
			return null;
		}
	}

	/**
	 * 按磁盘上的最新配置**整体换入**服务器集合（`mcp.json` 热加载用），可重复调用。
	 */
	async reload(): Promise<McpReloadSummary> {
		const run = this.reloadChain.then(
			() => this.reloadOnce(),
			() => this.reloadOnce(), // 前一个失败也放行下一个（失败不堵队列）
		);
		this.reloadChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async reloadOnce(): Promise<McpReloadSummary> {
		const cfg = optsOverrideOrRead(this.opts, this.dataDir);
		const next = new Map<string, McpClient>();
		let kept = 0;
		for (const client of this.clients) {
			const spec = cfg.servers[client.name];
			if (!spec || spec.enabled === false || !sameMcpSpec(spec, client.spec)) continue;
			next.set(client.name, client);
			kept++;
		}
		let started = 0;
		let failed = 0;
		await Promise.all(
			Object.entries(cfg.servers)
				.filter(([name, s]) => s.enabled !== false && !next.has(name))
				.map(async ([name, spec]) => {
					const previous = this.clients.find((c) => c.name === name);
					const fresh = await this.startOne(name, spec);
					if (fresh) {
						next.set(name, fresh);
						started++;
						return;
					}
					failed++;
					// 新规格没起来：留住旧实例，别把还能用的服务器一起下线。
					if (previous) {
						next.set(name, previous);
						kept++;
					}
				}),
		);
		const stale = this.clients.filter((c) => next.get(c.name) !== c);
		this.clients = [...next.values()];
		this.tools = [];
		for (const c of this.clients) for (const t of c.getTools()) this.tools.push(adaptMcpTool(c.name, t, c));
		for (const c of stale) c.close();
		return {
			kept,
			started,
			stopped: stale.length,
			failed,
			servers: this.clients.length,
			tools: this.tools.length,
		};
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
		this.serverErrors.clear();
	}
}

function optsOverrideOrRead(
	opts: McpBridgeOptions | undefined,
	dataDir: string,
): {
	servers: Record<string, McpServerSpec>;
} {
	if (opts?.specOverride && opts.specOverride.length > 0) {
		const servers: Record<string, McpServerSpec> = {};
		for (const o of opts.specOverride) servers[o.name] = o.spec;
		return { servers };
	}

	// 1. 全局配置：agentDir 或 dataDir 兜底
	const globalPath = getGlobalMcpPath(opts?.agentDir, dataDir);
	let globalCfg = readMcpConfigByPath(globalPath);
	if (Object.keys(globalCfg.servers).length === 0 && dataDir) {
		const dataDirCfg = readMcpConfig(dataDir);
		if (Object.keys(dataDirCfg.servers).length > 0) {
			globalCfg = dataDirCfg;
		}
	}

	// 2. 项目级配置：cwd/.pi/mcp.json
	let projectCfg: { servers: Record<string, McpServerSpec> } = { servers: {} };
	if (opts?.cwd) {
		const projectPath = getProjectMcpPath(opts.cwd);
		projectCfg = readMcpConfigByPath(projectPath);
	}

	// 3. 项目级覆盖全局
	const merged: Record<string, McpServerSpec> = { ...globalCfg.servers };
	for (const [name, projSpec] of Object.entries(projectCfg.servers)) {
		if (!projSpec.command && !projSpec.url && projSpec.enabled !== undefined && merged[name]) {
			merged[name] = { ...merged[name], enabled: projSpec.enabled };
		} else {
			merged[name] = projSpec;
		}
	}

	return { servers: merged };
}

function readMcpConfigByPath(filePath: string): { servers: Record<string, McpServerSpec> } {
	if (!existsSync(filePath)) return { servers: {} };
	try {
		return parseMcpConfig(readFileSync(filePath, "utf8")) ?? { servers: {} };
	} catch {
		return { servers: {} };
	}
}
