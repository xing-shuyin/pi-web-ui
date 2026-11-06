import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bilingual } from "../i18n.js";
import { resolveProviderCredential } from "../model-resolver.js";

const require = createRequire(import.meta.url);

export class DshRpcError extends Error {
	readonly code?: number;
	readonly data?: unknown;
	constructor(message: string, code?: number, data?: unknown) {
		super(message);
		this.name = "DshRpcError";
		this.code = code;
		this.data = data;
	}
}

export class DshTransportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DshTransportError";
	}
}

export function loadDeepSeekKey(agentDir?: string): string | undefined {
	try {
		const auth = JSON.parse(
			readFileSync(join(agentDir ?? join(homedir(), ".pi", "agent"), "auth.json"), "utf8"),
		) as Record<string, unknown>;
		const ds = auth.deepseek as Record<string, unknown> | undefined;
		const key = ds?.key ?? auth.deepseek;
		return typeof key === "string" && key ? key : undefined;
	} catch {
		return undefined;
	}
}

export interface DshRuntimeOptions {
	beforeStart?: (cwd: string) => void;
	onStopping?: () => void;
	cwd: string;
	provider?: string;
	model?: string;
	modelProvider?: string;
	maxTokens?: number;
	sessionRoot?: string;
	dataDir?: string;
	agentDir?: string;
	launcher?: string;
	env?: Record<string, string | undefined>;
	jsonrpcEntry?: string;
}

interface PendingRequest {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
}

export interface DshAgentPreset {
	id: string;
	trust: "system" | "user";
	isDefault: boolean;
	name?: string;
	description?: string;
	order?: number;
	broken?: string;
}

export class DshRuntime {
	cwd: string;
	provider: string;
	model: string;
	modelProvider?: string;
	maxTokens?: number;
	private sessionRoot?: string;
	private dataDir?: string;
	private agentDir?: string;
	private launcher: string;
	env: Record<string, string | undefined>;
	private jsonrpcEntry: string;

	private proc: ReturnType<typeof spawn> | null = null;
	private readonly beforeStart?: (cwd: string) => void;
	private readonly onStopping?: () => void;
	private startPromise: Promise<void> | null = null;
	private buffer = "";
	private nextId = 1;
	private pending = new Map<number, PendingRequest>();
	private notificationHandler: ((method: string, params: unknown) => void) | null = null;
	private stderrTail = "";
	private closed = false;
	private disposed = false;
	private initialized = false;

	private readonly debugEnabled = process.env.PI_WEB_DSH_DEBUG === "1";
	private debug(...args: unknown[]): void {
		if (this.debugEnabled) console.error("[dsh:client]", ...args);
	}

	onExit: ((code: number | null, signal: string | null, intentional: boolean) => void) | null = null;

	onStarted: (() => void) | null = null;

	constructor(opts: DshRuntimeOptions) {
		this.beforeStart = opts.beforeStart;
		this.onStopping = opts.onStopping;
		this.cwd = resolve(opts.cwd);
		this.provider = opts.provider ?? "deepseek-official";
		this.model = opts.model ?? "deepseek-v4-flash";
		this.modelProvider =
			opts.modelProvider ??
			(opts.model && opts.model.includes("/") ? opts.model.slice(0, opts.model.indexOf("/")) : undefined);
		this.maxTokens = opts.maxTokens;
		this.sessionRoot = opts.sessionRoot;
		this.dataDir = opts.dataDir;
		this.agentDir = opts.agentDir;
		this.launcher = opts.launcher ?? join(dirname(fileURLToPath(import.meta.url)), "runtime", "launcher.mjs");
		this.jsonrpcEntry =
			opts.jsonrpcEntry ??
			(() => {
				try {
					return require.resolve("@deepseek-ai/dsh-sdk-jsonrpc-server");
				} catch {
					return join(
						resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."),
						"node_modules",
						"@deepseek-ai",
						"dsh-sdk-jsonrpc-server",
						"lib",
						"index.js",
					);
				}
			})();
		this.env = opts.env ?? {};
	}

	get alive(): boolean {
		return !!this.proc && this.proc.exitCode === null;
	}

	get running(): boolean {
		return this.alive;
	}

	resolveRuntimeConfig(): {
		env: NodeJS.ProcessEnv;
		activeProvider: string;
		bareModelId: string;
	} {
		let activeProvider = this.modelProvider;
		let bareModelId = this.model;
		if (this.model.includes("/")) {
			const slashIdx = this.model.indexOf("/");
			if (!activeProvider) {
				activeProvider = this.model.slice(0, slashIdx);
			}
			bareModelId = this.model.slice(slashIdx + 1);
		}
		if (!activeProvider) {
			activeProvider = "deepseek";
		}

		const cred = resolveProviderCredential(this.agentDir, activeProvider);
		const deepseekKey = loadDeepSeekKey(this.agentDir);
		const resolvedKey = cred.apiKey || (activeProvider === "deepseek" ? deepseekKey : undefined);
		const resolvedBaseUrl = cred.baseUrl;

		const env: NodeJS.ProcessEnv = {
			...process.env,
			DSH_CWD: this.cwd,
			...this.env,
		};
		if (this.sessionRoot) env.DSH_SESSION_ROOT = this.sessionRoot;
		if (this.dataDir) env.PI_WEB_DSH_DATA_DIR = this.dataDir;
		if (resolvedKey && !this.env.DEEPSEEK_API_KEY && !env.DEEPSEEK_API_KEY) {
			env.DEEPSEEK_API_KEY = resolvedKey;
		}
		if (resolvedBaseUrl && !this.env.DEEPSEEK_BASE_URL && !env.DEEPSEEK_BASE_URL) {
			env.DEEPSEEK_BASE_URL = resolvedBaseUrl;
		}
		env.PI_WEB_DSH_JSONRPC_ENTRY = this.jsonrpcEntry;

		return { env, activeProvider, bareModelId };
	}

	getStderrTail(): string {
		return this.stderrTail;
	}

	start(): Promise<void> {
		this.beforeStart?.(this.cwd);
		if (this.disposed) {
			return Promise.reject(new DshTransportError(bilingual("client has been disposed", "客户端已销毁")));
		}
		if (this.alive && this.initialized) return Promise.resolve();
		if (!this.startPromise) {
			this.startPromise = this.doStart().finally(() => {
				this.startPromise = null;
			});
		}
		return this.startPromise;
	}

	private async doStart(): Promise<void> {
		if (!existsSync(this.launcher)) {
			throw new DshTransportError(bilingual(`launcher missing: ${this.launcher}`, `launcher 不存在: ${this.launcher}`));
		}
		if (!existsSync(this.jsonrpcEntry)) {
			throw new DshTransportError(
				bilingual(
					`dsh-sdk-jsonrpc-server is not installed (missing ${this.jsonrpcEntry}). Run npm i (see docs/dsh-engine.md for the pinned version family) first`,
					`dsh-sdk-jsonrpc-server 未安装（缺 ${this.jsonrpcEntry}）。请先 npm i（版本族见 docs/dsh-engine.md）`,
				),
			);
		}
		const { env, bareModelId } = this.resolveRuntimeConfig();

		this.closed = false;
		this.buffer = "";
		this.pending.clear();
		this.stderrTail = "";

		this.proc = spawn(process.execPath, [this.launcher], {
			env,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
			...(process.platform !== "win32" ? { detached: true } : {}),
		});
		const spawned = this.proc;

		spawned.stdout!.setEncoding("utf8");
		spawned.stdout!.on("data", (chunk: string) => this._onData(chunk));
		spawned.stderr!.setEncoding("utf8");
		spawned.stderr!.on("data", (chunk: string) => {
			this.stderrTail = (this.stderrTail + chunk).slice(-4000);
		});
		spawned.on("error", (err) => {
			this.failPending(
				new DshTransportError(bilingual(`runtime failed to start: ${err.message}`, `runtime 启动失败: ${err.message}`)),
			);
		});
		spawned.on("exit", (code, signal) => {
			if (this.proc !== spawned) return;
			const intentional = this.closed;
			this.debug("exit", { code, signal, intentional });
			const stderrSnippet = this.stderrTail.trim().slice(-2000);
			const err = new DshTransportError(
				bilingual(
					`DSH runtime exited (code=${code} signal=${signal}) stderr: ${stderrSnippet}`,
					`DSH runtime 已退出 (code=${code} signal=${signal}) stderr: ${stderrSnippet}`,
				),
			);
			this.failPending(err);
			this.initialized = false;
			this.onExit?.(code, signal, intentional);
		});

		try {
			await this._request("initialize", {
				cwd: this.cwd,
				provider: this.provider,
				model: bareModelId,
				...(this.maxTokens ? { maxTokens: this.maxTokens } : {}),
			});
		} catch (err) {
			console.error(
				`[dsh] initialize 失败 (model=${bareModelId} cwd=${this.cwd}): ${(err as Error).message}` +
					(this.stderrTail ? `\n  launcher stderr: ${this.stderrTail.slice(-600)}` : ""),
			);
			void this.kill();
			throw err;
		}
		this.initialized = true;
		this.onStarted?.();
	}

	private failPending(err: Error): void {
		for (const p of this.pending.values()) p.reject(err);
		this.pending.clear();
	}

	private _onData(chunk: string): void {
		this.buffer += chunk;
		let idx: number;
		while ((idx = this.buffer.indexOf("\n")) !== -1) {
			const line = this.buffer.slice(0, idx).trim();
			this.buffer = this.buffer.slice(idx + 1);
			if (!line) continue;
			let msg: {
				id?: unknown;
				method?: string;
				params?: unknown;
				result?: unknown;
				error?: { message?: string; code?: number; data?: unknown };
			};
			try {
				msg = JSON.parse(line);
			} catch {
				continue;
			}
			if (msg.id !== undefined && msg.id !== null) {
				const p = this.pending.get(msg.id as number);
				if (!p) continue;
				this.pending.delete(msg.id as number);
				if (msg.error) {
					p.reject(new DshRpcError(msg.error.message ?? "rpc error", msg.error.code, msg.error.data));
				} else {
					p.resolve(msg.result ?? {});
				}
				continue;
			}
			if (msg.method && this.notificationHandler) {
				this.debug("<-", msg.method);
				this.notificationHandler(msg.method, msg.params ?? {});
			}
		}
	}

	private _request(method: string, params: unknown, timeoutMs = 120_000): Promise<unknown> {
		const id = this.nextId++;
		this.debug("->", method, JSON.stringify(params)?.slice(0, 200));
		return new Promise((resolve2, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new DshTransportError(bilingual(`Request ${method} timed out`, `请求 ${method} 超时`)));
			}, timeoutMs);
			this.pending.set(id, {
				resolve: (v) => {
					clearTimeout(timer);
					resolve2(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			this._write({ jsonrpc: "2.0", id, method, params });
		});
	}

	private _write(msg: unknown): void {
		const proc = this.proc;
		if (!proc || !proc.stdin || proc.stdin.destroyed) {
			throw new DshTransportError(bilingual("runtime not started", "runtime 未启动"));
		}
		const ok = proc.stdin.write(JSON.stringify(msg) + "\n");
		if (!ok) {
			this.debug("stdin buffer full, backpressure triggered");
		}
	}

	async prompt(sessionId: string, contentBlocks: unknown[]): Promise<string> {
		await this.start();
		const res = (await this._request("session/prompt", {
			sessionId,
			contentBlocks,
		})) as { messageId?: unknown };
		if (typeof res.messageId !== "string") {
			throw new DshTransportError(
				bilingual("session/prompt did not return a messageId", "session/prompt 未返回 messageId"),
			);
		}
		return res.messageId;
	}

	onNotification(handler: (method: string, params: unknown) => void): void {
		this.notificationHandler = handler;
	}

	async goalSet(sessionId: string, objective: string, maxGoalRounds?: number): Promise<unknown> {
		await this.start();
		return this._request("goal/set", {
			sessionId,
			objective,
			...(maxGoalRounds && maxGoalRounds > 0 ? { maxGoalRounds } : {}),
		});
	}

	async goalGet(sessionId: string): Promise<unknown> {
		await this.start();
		return this._request("goal/get", { sessionId });
	}

	async goalClear(sessionId: string): Promise<unknown> {
		await this.start();
		return this._request("goal/clear", { sessionId });
	}

	async goalResume(sessionId: string): Promise<unknown> {
		await this.start();
		return this._request("goal/resume", { sessionId });
	}

	async listModels(
		provider = "deepseek-official",
	): Promise<{ models: { id: string; name?: string; inputModalities?: string[] }[]; error?: string }> {
		await this.start();
		return this._request("model/list", { provider }) as Promise<{
			models: { id: string; name?: string; inputModalities?: string[] }[];
			error?: string;
		}>;
	}

	async attachmentSave(
		mediaType: string,
		data: string,
		name?: string,
	): Promise<{ ref?: { attachmentId: string; mediaType: string } }> {
		await this.start();
		return this._request("attachment/save", {
			mediaType,
			data,
			...(name ? { name } : {}),
		}) as Promise<{ ref?: { attachmentId: string; mediaType: string } }>;
	}

	async attachmentRead(ref: { attachmentId: string; mediaType: string }): Promise<{ mediaType: string; data: string }> {
		await this.start();
		return this._request("attachment/read", { ref }) as Promise<{ mediaType: string; data: string }>;
	}

	async answerQuestion(
		id: string,
		answers: { id: string; selected: string[]; custom?: string }[],
		cancelled?: boolean,
	): Promise<unknown> {
		await this.start();
		return this._request("question/answer", { id, answers, ...(cancelled ? { cancelled: true } : {}) });
	}

	async syncTools(
		tools: { name: string; description: string; parameters?: Record<string, unknown> }[],
	): Promise<{ registered: string[]; count: number }> {
		await this.start();
		return this._request("tools/sync", { tools }) as Promise<{ registered: string[]; count: number }>;
	}

	async listTools(): Promise<{ tools: { name: string; description: string; parameters?: unknown }[] }> {
		await this.start();
		return this._request("tools/list", {}) as Promise<{
			tools: { name: string; description: string; parameters?: unknown }[];
		}>;
	}

	async inspectPrompt(sessionId?: string): Promise<{
		prompt: string;
		sections: { name: string; text: string; chars: number }[];
		contexts: { name: string; text: string; chars: number }[];
		tools: { name: string; description?: string; parameters?: unknown }[];
		error?: string;
	}> {
		await this.start();
		return this._request("prompt/inspect", sessionId ? { sessionId } : {}) as Promise<{
			prompt: string;
			sections: { name: string; text: string; chars: number }[];
			contexts: { name: string; text: string; chars: number }[];
			tools: { name: string; description?: string; parameters?: unknown }[];
			error?: string;
		}>;
	}

	async toolsCallResult(id: string, result: string, isError?: boolean): Promise<unknown> {
		await this.start();
		return this._request("tools/call-result", { id, result, ...(isError ? { isError: true } : {}) });
	}

	async invokeTool(
		name: string,
		args?: Record<string, unknown>,
	): Promise<{ ok: boolean; value?: unknown; error?: string }> {
		await this.start();
		return this._request("tools/invoke", { name, args }) as Promise<{ ok: boolean; value?: unknown; error?: string }>;
	}

	async listSkills(): Promise<{
		skills: { name: string; description: string; invocation?: string }[];
		error?: string;
	}> {
		await this.start();
		return this._request("skills/list", {}) as Promise<{
			skills: { name: string; description: string; invocation?: string }[];
			error?: string;
		}>;
	}

	async setDisabledSkills(skills: string[]): Promise<{ disabled: string[] }> {
		await this.start();
		return this._request("skills/set-disabled", { skills }) as Promise<{ disabled: string[] }>;
	}

	async listPresets(): Promise<{
		presets: DshAgentPreset[];
		defaultPreset: string;
		authorable: boolean;
		unavailable?: boolean;
		error?: string;
	}> {
		await this.start();
		return this._request("preset/list", {}) as Promise<{
			presets: DshAgentPreset[];
			defaultPreset: string;
			authorable: boolean;
			unavailable?: boolean;
			error?: string;
		}>;
	}

	async assignPreset(sessionId: string, preset: string): Promise<{ ok: boolean }> {
		await this.start();
		return this._request("preset/assign", { sessionId, preset }) as Promise<{ ok: boolean }>;
	}

	async selectPreset(
		sessionId: string,
		preset: string,
	): Promise<{ ok: boolean; preset?: string; code?: string; message?: string }> {
		await this.start();
		return this._request("preset/select", { sessionId, preset }) as Promise<{
			ok: boolean;
			preset?: string;
			code?: string;
			message?: string;
		}>;
	}

	async getPermission(sessionId: string): Promise<{
		options: { value: string; name: string; description?: string }[];
		currentValue: string;
	}> {
		await this.start();
		return this._request("permission/get", { sessionId }) as Promise<{
			options: { value: string; name: string; description?: string }[];
			currentValue: string;
		}>;
	}

	async setPermission(
		sessionId: string,
		preset: string,
	): Promise<{
		ok: boolean;
		preset?: string;
		code?: string;
		message?: string;
		options?: { value: string; name: string; description?: string }[];
		currentValue?: string;
	}> {
		await this.start();
		return this._request("permission/set", { sessionId, preset }) as Promise<{
			ok: boolean;
			preset?: string;
			code?: string;
			message?: string;
			options?: { value: string; name: string; description?: string }[];
			currentValue?: string;
		}>;
	}

	async close(): Promise<void> {
		this.onStopping?.();
		if (this.disposed) return;
		this.disposed = true;
		this.closed = true;
		const proc = this.proc;
		if (!proc || proc.exitCode !== null) {
			this.proc = null;
			return;
		}
		try {
			await this._request("shutdown", {}, 2000);
		} catch {}
		try {
			proc.stdin!.end();
		} catch {}
		await new Promise<void>((r) => {
			const t = setTimeout(r, 1500);
			proc.once("exit", () => {
				clearTimeout(t);
				r();
			});
		});
		if (proc.exitCode === null) {
			try {
				proc.kill("SIGTERM");
			} catch {}
			await this._waitExit(proc, 1500);
		}
		if (proc.exitCode === null) {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}
		this.proc = null;
	}

	private _waitExit(proc: ReturnType<typeof spawn>, ms: number): Promise<void> {
		return new Promise((r) => {
			const t = setTimeout(r, ms);
			proc.once("exit", () => {
				clearTimeout(t);
				r();
			});
		});
	}

	async kill(): Promise<void> {
		this.onStopping?.();
		const proc = this.proc;
		this.debug("kill", { pid: proc?.pid });
		this.closed = true;
		if (!proc || proc.exitCode !== null) {
			this.proc = null;
			return;
		}
		const pid = proc.pid;
		if (pid === undefined) {
			this.proc = null;
			return;
		}
		this.proc = null;
		this.failPending(new DshTransportError(bilingual("runtime killed (interrupt)", "运行时已被终止（中断）")));
		try {
			if (process.platform === "win32") {
				await new Promise<void>((resolve) => {
					let settled = false;
					const done = () => {
						if (!settled) {
							settled = true;
							clearTimeout(timer);
							resolve();
						}
					};
					const timer = setTimeout(done, 1500);
					try {
						const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
							stdio: "ignore",
							windowsHide: true,
						});
						killer.on("close", (code) => {
							if (code !== 0) {
								try {
									proc.kill("SIGKILL");
								} catch {}
							}
							done();
						});
						killer.on("error", () => {
							try {
								proc.kill("SIGKILL");
							} catch {}
							done();
						});
					} catch {
						try {
							proc.kill("SIGKILL");
						} catch {}
						done();
					}
				});
			} else {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					try {
						proc.kill("SIGKILL");
					} catch {}
				}
			}
		} catch {
			try {
				proc.kill("SIGKILL");
			} catch {}
		}
	}

	async restart(newModel?: string, newProvider?: string, cwd?: string): Promise<void> {
		this.beforeStart?.(cwd ? resolve(cwd) : this.cwd);
		const wasAlive = this.alive;
		this.debug("restart", { newModel, newProvider, wasAlive });
		if (wasAlive) {
			await this.kill();
			await new Promise((r) => setTimeout(r, 150));
		}
		if (newModel) {
			this.model = newModel;
			if (newModel.includes("/")) {
				this.modelProvider = newModel.slice(0, newModel.indexOf("/"));
			}
		}
		if (cwd) this.cwd = resolve(cwd);
		if (newProvider) {
			if (newProvider === "deepseek-official") {
				this.provider = newProvider;
			} else {
				this.modelProvider = newProvider;
			}
		}
		this.initialized = false;
		if (wasAlive || cwd) await this.start();
	}

	get stderr(): string {
		return this.stderrTail;
	}
}
