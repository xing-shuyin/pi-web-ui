import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getMcpAccessToken, refreshMcpAccessToken } from "./mcp-oauth.js";
import type { PluginAgentTool } from "./plugins.js";
import type { UiMcpToolInfo } from "./protocol.js";

export function expandEnvVars(val: string): string {
	return val.replace(/\$\{([^}]+)\}/g, (_, k) => process.env[k] ?? "");
}

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

export function getProjectMcpPath(cwd?: string): string {
	const activeCwd = cwd || process.cwd();
	return join(activeCwd, ".pi", "mcp.json");
}

export interface McpServerSpec {
	command?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
	type?: "stdio" | "http" | "streamable-http";
	timeout?: number;
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

interface McpContentBlock {
	type?: string;
	text?: string;
	data?: string;
	mimeType?: string;
	resource?: { uri?: string; mimeType?: string; text?: string; blob?: string } | string;
}

type McpToolResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

const PROTOCOL_VERSION = "2025-03-26";

const MCP_MAX_LINE_CHARS = 1024 * 1024;
const MCP_MAX_BUFFER_CHARS = 4 * 1024 * 1024;

let rpcSeq = 0;

interface PendingRequest {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	timer: NodeJS.Timeout;
	timeoutMs: number;
	method: string;
	progressToken?: string;
	abortController?: AbortController;
}

export class McpClient {
	private child: ChildProcess | null = null;
	private buffer = "";
	private pending = new Map<string, PendingRequest>();
	private log: (...a: unknown[]) => void;
	readonly name: string;
	private tools: McpToolDefinition[] = [];
	private shuttingDown = false;
	private starting: Promise<void> | null = null;
	private startedCount = 0;
	private sessionId: string | null = null;
	private initialized = false;
	onToolsChanged?: () => void;
	private notificationControllers = new Set<AbortController>();

	constructor(
		name: string,
		readonly spec: McpServerSpec,
		log?: (...a: unknown[]) => void,
		private readonly clientOpts: McpClientOptions = {},
	) {
		this.name = name;
		this.log = log ?? (() => {});
	}

	get isHttp(): boolean {
		return !this.spec.command && !!this.spec.url;
	}

	private hasStaticAuthorization(): boolean {
		const headers = this.spec.headers ?? {};
		return Object.keys(headers).some((k) => k.toLowerCase() === "authorization");
	}

	private async resolveAuthHeader(isRetry: boolean, signal?: AbortSignal, staleToken?: string): Promise<string | null> {
		if (!this.isHttp || !this.spec.url || this.hasStaticAuthorization()) return null;
		const options = { agentDir: this.clientOpts.agentDir, name: this.name, serverUrl: this.spec.url, signal };
		try {
			const token = isRetry
				? await refreshMcpAccessToken({ ...options, staleToken })
				: await getMcpAccessToken(options);
			if (!token) return null;
			return `Bearer ${token}`;
		} catch (err) {
			signal?.throwIfAborted();
			this.log(`[mcp:${this.name}] oauth:`, err instanceof Error ? err.message : err);
			return null;
		}
	}

	private signInRequiredError(detail: string): Error {
		return new Error(
			`MCP_OAUTH_SIGN_IN_REQUIRED: HTTP 401: ${detail || "unauthorized"} — OAuth sign-in is missing or has expired; run \`pi mcp login ${this.name}\` and try again`,
		);
	}

	async start(timeoutMs = 8000): Promise<void> {
		if (this.isHttp) {
			if (this.initialized) return;
			await this.startHttp(timeoutMs);
			return;
		}
		if (this.child) return;
		await this.startStdio(timeoutMs);
	}

	private async startStdio(timeoutMs = 8000): Promise<void> {
		const { command, args = [], cwd, env } = this.spec;
		if (!command) {
			throw new Error("MCP 服务器规格未声明 command 启动命令");
		}
		this.log(`[mcp:${this.name}] starting: ${command} ${args.join(" ")}`);
		this.buffer = "";
		const spawnedEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
		if (env) {
			for (const [k, v] of Object.entries(env)) {
				spawnedEnv[k] = expandEnvVars(v);
			}
		}
		const child = spawn(command, args, {
			cwd: cwd ?? undefined,
			env: spawnedEnv,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.child = child;
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
			this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
			void version;
			const listed = ((await this.request("tools/list", {}, timeoutMs)) ?? {}) as {
				tools?: McpToolDefinition[];
			};
			this.tools = Array.isArray(listed.tools) ? listed.tools : [];
			this.log(`[mcp:${this.name}] ready, ${this.tools.length} tools`);
			if (this.shuttingDown) {
				try {
					child.kill();
				} catch {}
				if (this.child === child) this.child = null;
			}
		} catch (err) {
			try {
				child.kill();
			} catch {}
			if (this.child === child) this.child = null;
			throw err;
		}
	}

	private async startHttp(timeoutMs = 8000): Promise<void> {
		const url = this.spec.url;
		if (!url) throw new Error("MCP HTTP 服务器规格未声明 url");
		this.log(`[mcp:${this.name}] connecting (HTTP): ${url}`);
		this.sessionId = null;
		this.initialized = false;
		this.startedCount++;

		try {
			const handshake = await this.requestHttp(
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
			void version;

			await this.sendHttpNotification("notifications/initialized", {});

			const listed = ((await this.requestHttp("tools/list", {}, timeoutMs)) ?? {}) as {
				tools?: McpToolDefinition[];
			};
			this.tools = Array.isArray(listed?.tools) ? listed.tools : [];
			this.initialized = true;
			this.log(`[mcp:${this.name}] ready (HTTP), ${this.tools.length} tools`);
		} catch (err) {
			this.initialized = false;
			this.sessionId = null;
			throw err;
		}
	}

	get startCount(): number {
		return this.startedCount;
	}

	private async ensureStarted(timeoutMs: number): Promise<void> {
		if (this.shuttingDown) throw new Error(`[mcp:${this.name}] 客户端已关闭，不会重启`);
		if (this.starting) return this.starting;
		if (this.isHttp) {
			if (this.initialized) return;
		} else {
			if (this.child) return;
		}
		this.starting = this.start(timeoutMs).finally(() => {
			this.starting = null;
		});
		await this.starting;
	}

	getTools(): McpToolDefinition[] {
		return this.tools.map((t) => ({ ...t }));
	}

	async refreshTools(timeoutMs = 8000): Promise<McpToolDefinition[]> {
		const listed = ((await this.request("tools/list", {}, timeoutMs)) ?? {}) as {
			tools?: McpToolDefinition[];
		};
		this.tools = Array.isArray(listed.tools) ? listed.tools : [];
		this.log(`[mcp:${this.name}] tools refreshed, ${this.tools.length} tools`);
		this.onToolsChanged?.();
		return this.tools;
	}

	async call(name: string, args: Record<string, unknown>, timeoutMs?: number, signal?: AbortSignal): Promise<unknown> {
		if (this.shuttingDown) throw new Error(`[mcp:${this.name}] 客户端已关闭，不会重启`);
		const effectiveTimeoutMs =
			timeoutMs ?? (this.spec.timeout && this.spec.timeout > 0 ? this.spec.timeout * 1000 : 60000);

		try {
			await this.ensureStarted(8000);
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			throw new Error(`[mcp:${this.name}] 服务器进程已退出且自动重启失败：${detail}`);
		}

		try {
			return await this.executeCall(name, args, effectiveTimeoutMs, signal);
		} catch (err) {
			if (this.isHttp && err instanceof Error && err.message.includes("MCP_SESSION_EXPIRED")) {
				this.log(`[mcp:${this.name}] 会话已失效，重新握手重试调用...`);
				this.sessionId = null;
				this.initialized = false;
				await this.ensureStarted(8000);
				return await this.executeCall(name, args, effectiveTimeoutMs, signal);
			}
			throw err;
		}
	}

	private async executeCall(
		name: string,
		args: Record<string, unknown>,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<unknown> {
		const res = (await this.request(
			"tools/call",
			{ name, arguments: args, _meta: { progressToken: String(rpcSeq) } },
			timeoutMs,
			signal,
		)) as {
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
		if (res?.structuredContent !== undefined) return res.structuredContent;
		const blocks: McpToolResultBlock[] = [];
		let hasNonText = false;
		for (const c of res.content ?? []) {
			if (c.type === "image" && typeof c.data === "string" && c.data) {
				blocks.push({ type: "image", data: c.data, mimeType: c.mimeType?.trim() || "image/png" });
				hasNonText = true;
				continue;
			}
			if (c.type && c.type !== "text") {
				const r = typeof c.resource === "object" && c.resource !== null ? c.resource : {};
				if (typeof r.text === "string" && r.text) {
					blocks.push({ type: "text", text: r.text });
					continue;
				}
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
			return { content: blocks.map((b) => (b.type === "text" ? b.text : "")).join("\n"), isError: !!res.isError };
		}
		return { content: blocks, isError: !!res.isError };
	}

	close(): void {
		this.shuttingDown = true;
		this.initialized = false;
		this.rejectAll(new Error("[mcp] client closed"));
		for (const controller of this.notificationControllers) controller.abort();
		if (this.child) {
			try {
				this.child.kill();
			} catch {}
			this.child = null;
		}
		if (this.isHttp && this.sessionId && this.spec.url) {
			const url = this.spec.url;
			const sid = this.sessionId;
			this.sessionId = null;
			void fetch(url, {
				method: "DELETE",
				headers: { "Mcp-Session-Id": sid },
			}).catch(() => {});
		}
	}

	private send(msg: unknown): void {
		const stdin = this.child?.stdin;
		if (!stdin || !stdin.writable) return;
		stdin.write(JSON.stringify(msg) + "\n");
	}

	private request(
		method: string,
		params: Record<string, unknown>,
		timeoutMs = 8000,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (this.isHttp) {
			return this.requestHttp(method, params, timeoutMs, signal);
		}
		return this.requestStdio(method, params, timeoutMs, signal);
	}

	private requestStdio(
		method: string,
		params: Record<string, unknown>,
		timeoutMs = 8000,
		signal?: AbortSignal,
	): Promise<unknown> {
		const id = rpcSeq++;
		const outId = String(id);
		return new Promise<unknown>((resolve, reject) => {
			if (signal?.aborted) {
				reject(new Error("Request aborted"));
				return;
			}
			const onAbort = () => {
				this.pending.delete(outId);
				clearTimeout(timer);
				this.send({
					jsonrpc: "2.0",
					method: "notifications/cancelled",
					params: { requestId: id, reason: "Cancelled by user" },
				});
				reject(new Error("Request aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			const timer = setTimeout(() => {
				this.pending.delete(outId);
				signal?.removeEventListener("abort", onAbort);
				reject(new Error(`[mcp:${this.name}] ${method} 超时 (${timeoutMs}ms)`));
			}, timeoutMs);

			this.pending.set(outId, {
				resolve: (v) => {
					signal?.removeEventListener("abort", onAbort);
					resolve(v);
				},
				reject: (e) => {
					signal?.removeEventListener("abort", onAbort);
					reject(e);
				},
				timer,
				timeoutMs,
				method,
				progressToken: outId,
			});
			this.send({ jsonrpc: "2.0", id: id, method, params });
		});
	}

	private async requestHttp(
		method: string,
		params: Record<string, unknown>,
		timeoutMs = 8000,
		signal?: AbortSignal,
	): Promise<unknown> {
		const url = this.spec.url;
		if (!url) throw new Error("MCP HTTP 服务器未声明 url");

		const id = rpcSeq++;
		const outId = String(id);
		const abortController = new AbortController();

		if (signal?.aborted) {
			throw new Error("Request aborted");
		}
		if (this.shuttingDown) throw new Error("[mcp] client closed");

		const onAbort = () => {
			this.pending.get(outId)?.reject(new Error("Request aborted"));
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (this.sessionId) {
			headers["Mcp-Session-Id"] = this.sessionId;
		}
		if (this.spec.headers) {
			for (const [k, v] of Object.entries(this.spec.headers)) {
				headers[k] = expandEnvVars(v);
			}
		}
		let reqResolve!: (v: unknown) => void;
		let reqReject!: (e: Error) => void;
		const reqPromise = new Promise<unknown>((res, rej) => {
			reqResolve = res;
			reqReject = rej;
		});

		const timer = setTimeout(() => {
			this.pending.get(outId)?.reject(new Error(`[mcp:${this.name}] ${method} 超时 (${timeoutMs}ms)`));
		}, timeoutMs);

		this.pending.set(outId, {
			resolve: (v) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(outId);
				reqResolve(v);
			},
			reject: (e) => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
				this.pending.delete(outId);
				abortController.abort();
				reqReject(e);
			},
			timer,
			timeoutMs,
			method,
			progressToken: outId,
			abortController,
		});

		void (async () => {
			try {
				const authHeader = await this.resolveAuthHeader(false, abortController.signal);
				abortController.signal.throwIfAborted();
				if (authHeader) headers.Authorization = authHeader;
				const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
				let res = await fetch(url, {
					method: "POST",
					headers,
					body,
					signal: abortController.signal,
				});

				abortController.signal.throwIfAborted();

				if (res.status === 401 && !this.hasStaticAuthorization()) {
					const retriedHeader = await this.resolveAuthHeader(
						true,
						abortController.signal,
						authHeader?.slice("Bearer ".length),
					);
					abortController.signal.throwIfAborted();
					if (retriedHeader && retriedHeader !== authHeader) {
						headers.Authorization = retriedHeader;
						res = await fetch(url, {
							method: "POST",
							headers,
							body,
							signal: abortController.signal,
						});
					}
					abortController.signal.throwIfAborted();
					if (res.status === 401) {
						const detail = await res.text().catch(() => "");
						throw this.signInRequiredError(detail);
					}
				}

				const newSid = res.headers.get("mcp-session-id");
				if (newSid) this.sessionId = newSid;

				if (res.status === 202) {
					const pending = this.pending.get(outId);
					pending?.resolve(null);
					return;
				}

				if (res.status === 404 || res.status === 400) {
					const errText = await res.text().catch(() => "");
					abortController.signal.throwIfAborted();
					if (res.status === 404 || /session/i.test(errText)) {
						this.sessionId = null;
						this.initialized = false;
						const pending = this.pending.get(outId);
						pending?.reject(new Error(`MCP_SESSION_EXPIRED: ${errText || "Session expired or not found"}`));
						return;
					}
					throw new Error(`HTTP ${res.status}: ${errText}`);
				}

				if (!res.ok) {
					const errText = await res.text().catch(() => "");
					throw new Error(`HTTP ${res.status}: ${errText}`);
				}

				const contentType = res.headers.get("content-type") || "";
				if (contentType.includes("text/event-stream") && res.body) {
					void this.readSseStream(res.body, outId, abortController.signal);
				} else {
					const text = await res.text();
					abortController.signal.throwIfAborted();
					let parsed: RpcIncoming;
					try {
						parsed = JSON.parse(text) as RpcIncoming;
					} catch {
						let matched: RpcIncoming | undefined;
						if (text.includes("data:")) {
							for (const l of text.split("\n")) {
								const trimmed = l.trim();
								if (trimmed.startsWith("data:")) {
									try {
										const item = JSON.parse(trimmed.slice(5).trim()) as RpcIncoming;
										if (item.id !== undefined && String(item.id) === outId) {
											matched = item;
											break;
										}
									} catch {}
								}
							}
						}
						if (matched) {
							parsed = matched;
						} else {
							throw new Error(`Invalid JSON response: ${text.slice(0, 200)}`);
						}
					}
					const pending = this.pending.get(outId);
					if (pending) {
						if (parsed.error) {
							pending.reject(new Error(`[mcp:${this.name}] ${parsed.error.message ?? "MCP 错误"}`));
						} else {
							pending.resolve(parsed.result);
						}
					}
				}
			} catch (err) {
				this.pending.get(outId)?.reject(err instanceof Error ? err : new Error(String(err)));
			}
		})();
		return reqPromise;
	}

	private async sendHttpNotification(method: string, params: Record<string, unknown>): Promise<void> {
		const url = this.spec.url;
		if (!url) return;
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Accept: "application/json, text/event-stream",
		};
		if (this.sessionId) {
			headers["Mcp-Session-Id"] = this.sessionId;
		}
		if (this.spec.headers) {
			for (const [k, v] of Object.entries(this.spec.headers)) {
				headers[k] = expandEnvVars(v);
			}
		}
		if (this.shuttingDown) return;
		const controller = new AbortController();
		this.notificationControllers.add(controller);
		const timer = setTimeout(() => controller.abort(), 8000);
		try {
			const authHeader = await this.resolveAuthHeader(false, controller.signal);
			controller.signal.throwIfAborted();
			if (authHeader) headers.Authorization = authHeader;
			const res = await fetch(url, {
				signal: controller.signal,
				method: "POST",
				headers,
				body: JSON.stringify({ jsonrpc: "2.0", method, params }),
			});
			controller.signal.throwIfAborted();
			const newSid = res.headers.get("mcp-session-id");
			if (newSid) this.sessionId = newSid;
		} catch (err) {
			this.log(`[mcp:${this.name}] HTTP notification ${method} failed:`, err);
		} finally {
			clearTimeout(timer);
			this.notificationControllers.delete(controller);
		}
	}

	private async readSseStream(body: ReadableStream<Uint8Array>, targetId: string, signal?: AbortSignal): Promise<void> {
		const reader = body.getReader();
		const decoder = new TextDecoder("utf-8");
		let buffer = "";

		const onAbort = () => {
			void reader.cancel().catch(() => {});
		};
		signal?.addEventListener("abort", onAbort, { once: true });

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nl: number;
				while ((nl = buffer.indexOf("\n")) >= 0) {
					const rawLine = buffer.slice(0, nl);
					buffer = buffer.slice(nl + 1);
					const line = rawLine.replace(/\r$/, "").trim();
					if (!line || !line.startsWith("data:")) continue;
					const dataStr = line.slice(5).trim();
					if (!dataStr) continue;
					let msg: RpcIncoming;
					try {
						msg = JSON.parse(dataStr) as RpcIncoming;
					} catch {
						continue;
					}
					this.handleMessage(msg);
				}
			}
		} catch (err) {
			if (!signal?.aborted) {
				const pending = this.pending.get(targetId);
				if (pending) {
					clearTimeout(pending.timer);
					this.pending.delete(targetId);
					pending.reject(err instanceof Error ? err : new Error(String(err)));
				}
			}
		} finally {
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
			reader.releaseLock();
		}
	}

	private onData(chunk: string): void {
		this.buffer += chunk;
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

	private killForProtocolError(err: Error): void {
		this.log(err.message);
		this.buffer = "";
		const child = this.child;
		this.child = null;
		this.rejectAll(err);
		if (child) {
			try {
				child.kill();
			} catch {}
		}
	}

	private handleProgress(params: { progressToken?: number | string; progress?: number; total?: number }): void {
		const token = params?.progressToken !== undefined ? String(params.progressToken) : undefined;
		let target: PendingRequest | undefined;
		if (token && this.pending.has(token)) {
			target = this.pending.get(token);
		} else if (this.pending.size === 1) {
			target = this.pending.values().next().value;
		}
		if (target) {
			clearTimeout(target.timer);
			target.timer = setTimeout(() => {
				this.pending.delete(token ?? "");
				target!.reject(new Error(`[mcp:${this.name}] ${target!.method} 超时 (${target!.timeoutMs}ms)`));
			}, target.timeoutMs);
			this.log(
				`[mcp:${this.name}] progress received (${params.progress ?? "?"}/${params.total ?? "?"}), timeout reset (${target.timeoutMs}ms)`,
			);
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
		if (msg.method === "notifications/progress") {
			this.handleProgress(msg.params as { progressToken?: number | string; progress?: number; total?: number });
			return;
		}
		if (msg.method === "notifications/tools/list_changed") {
			this.log(`[mcp:${this.name}] tools/list_changed notification received, refreshing tools...`);
			void this.refreshTools().catch((err) => {
				this.log(`[mcp:${this.name}] tools refresh failed:`, err);
			});
			return;
		}
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

export function readMcpConfig(dataDir: string): { servers: Record<string, McpServerSpec> } {
	try {
		return parseMcpConfig(readFileSync(join(dataDir, "mcp.json"), "utf8")) ?? { servers: {} };
	} catch {
		return { servers: {} };
	}
}

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

function sameMcpSpec(a: McpServerSpec, b: McpServerSpec): boolean {
	return JSON.stringify(mcpServerSnapshot(a)) === JSON.stringify(mcpServerSnapshot(b));
}

const mcpToolServers = new WeakMap<object, string>();
export function getMcpToolServer(tool: object): string | undefined {
	return mcpToolServers.get(tool);
}

function adaptMcpTool(serverName: string, mcpTool: McpToolDefinition, client: McpClient): PluginAgentTool {
	const name = sanitizeToolName(mcpTool.name);
	const adapted: PluginAgentTool = {
		name,
		label: `${serverName} · ${mcpTool.name}`,
		description: mcpTool.description ?? `Tool ${mcpTool.name} provided by MCP server "${serverName}"`,
		promptSnippet: firstSentenceSnippet(mcpTool.description) ?? `MCP tool ${mcpTool.name} (server: ${serverName})`,
		parameters: mcpTool.inputSchema ?? {},
		execute: async (_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => {
			return client.call(mcpTool.name, params ?? {}, undefined, signal);
		},
	};
	mcpToolServers.set(adapted, serverName);
	return adapted;
}

function firstSentenceSnippet(description: string | undefined): string | undefined {
	const text = (description ?? "").replace(/\s+/g, " ").trim();
	if (!text) return undefined;
	const cut = text.search(/[.。!?！?]/);
	const head = cut > 0 ? text.slice(0, cut + 1) : text;
	return head.length > 100 ? `${head.slice(0, 99)}…` : head;
}

function sanitizeToolName(name: string): string {
	const cleaned = (name || "").replace(/[^A-Za-z0-9_-]/g, "_");
	return cleaned || "mcp_tool";
}

export interface McpReloadSummary {
	kept: number;
	started: number;
	stopped: number;
	failed: number;
	servers: number;
	tools: number;
}

export interface McpClientOptions {
	agentDir?: string;
}

export interface McpBridgeOptions {
	agentDir?: string;
	cwd?: string;
	allowedServers?: readonly string[];
	specOverride?: { name: string; spec: McpServerSpec }[];
	onToolsChanged?: () => void;
}

export class McpBridge {
	private clients: McpClient[] = [];
	private pendingClients = new Set<McpClient>();
	private disposed = false;
	private tools: PluginAgentTool[] = [];
	private serverErrors = new Map<string, string>();
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
		usingPreviousConfig?: boolean;
	} {
		const client = this.clients.find((c) => c.name === name);
		if (client) {
			return {
				status: "running",
				...(this.serverErrors.has(name) ? { error: this.serverErrors.get(name), usingPreviousConfig: true } : {}),
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

	async load(): Promise<void> {
		if (this.disposed) return;
		this.serverErrors.clear();
		const cfg = this.executionConfig();
		await Promise.all(
			Object.entries(cfg.servers).map(async ([name, spec]) => {
				if (spec.enabled === false) return;
				const client = await this.startOne(name, spec);
				if (!client) return;
				if (this.disposed) {
					client.close();
					return;
				}
				this.clients.push(client);
				for (const t of client.getTools()) this.tools.push(adaptMcpTool(name, t, client));
			}),
		);
	}

	private async startOne(name: string, spec: McpServerSpec): Promise<McpClient | null> {
		if (this.disposed) return null;
		const client = new McpClient(name, spec, this.log, { agentDir: this.agentDir });
		this.pendingClients.add(client);
		try {
			client.onToolsChanged = () => this.reaggregateTools();
			await client.start();
			if (this.disposed) {
				client.close();
				return null;
			}
			this.serverErrors.delete(name);
			return client;
		} catch (err) {
			client.close();
			if (!this.disposed) {
				const msg = err instanceof Error ? err.message : String(err);
				this.serverErrors.set(name, msg);
				this.log(`[mcp] 服务器「${name}」启动失败：`, msg);
			}
			return null;
		} finally {
			this.pendingClients.delete(client);
		}
	}

	private reaggregateTools(): void {
		if (this.disposed) return;
		this.tools = [];
		for (const c of this.clients) {
			for (const t of c.getTools()) {
				this.tools.push(adaptMcpTool(c.name, t, c));
			}
		}
		this.opts.onToolsChanged?.();
	}

	async reload(): Promise<McpReloadSummary> {
		const run = this.reloadChain.then(
			() => this.reloadOnce(),
			() => this.reloadOnce(),
		);
		this.reloadChain = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async reloadOnce(): Promise<McpReloadSummary> {
		if (this.disposed) return { kept: 0, started: 0, stopped: 0, failed: 0, servers: 0, tools: 0 };
		const cfg = this.executionConfig();
		const next = new Map<string, McpClient>();
		let kept = 0;
		for (const client of this.clients) {
			const spec = cfg.servers[client.name];
			if (!spec || spec.enabled === false || !sameMcpSpec(spec, client.spec)) continue;
			next.set(client.name, client);
			this.serverErrors.delete(client.name);
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
					if (previous) {
						next.set(name, previous);
						kept++;
					}
				}),
		);
		if (this.disposed) {
			for (const client of next.values()) client.close();
			return { kept: 0, started: 0, stopped: 0, failed: 0, servers: 0, tools: 0 };
		}
		for (const name of this.serverErrors.keys()) {
			if (!cfg.servers[name] || cfg.servers[name].enabled === false) this.serverErrors.delete(name);
		}
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

	private executionConfig() {
		const cfg = optsOverrideOrRead(this.opts, this.dataDir);
		if (this.opts.allowedServers)
			cfg.servers = Object.fromEntries(
				Object.entries(cfg.servers).filter(([name]) => this.opts.allowedServers!.includes(name)),
			);
		return cfg;
	}

	getTools(): PluginAgentTool[] {
		return this.tools;
	}

	hasServers(): boolean {
		return this.clients.length > 0;
	}

	dispose(): void {
		this.disposed = true;
		for (const c of this.pendingClients) c.close();
		this.pendingClients.clear();
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

	const globalPath = getGlobalMcpPath(opts?.agentDir, dataDir);
	let globalCfg = readMcpConfigByPath(globalPath);
	if (Object.keys(globalCfg.servers).length === 0 && dataDir) {
		const dataDirCfg = readMcpConfig(dataDir);
		if (Object.keys(dataDirCfg.servers).length > 0) {
			globalCfg = dataDirCfg;
		}
	}

	let projectCfg: { servers: Record<string, McpServerSpec> } = { servers: {} };
	if (opts?.cwd) {
		const projectPath = getProjectMcpPath(opts.cwd);
		projectCfg = readMcpConfigByPath(projectPath);
	}

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
